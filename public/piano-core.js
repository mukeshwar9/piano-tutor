// Piano mode core: keyboard geometry, calibration math, song fitting and wait-mode logic.
// Plain ES5 so it runs unchanged in TV browsers, on the phone and in Node (server and tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PianoCore = factory();
})(this, function () {
  "use strict";

  var NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
  // Real piano black-key offsets: C-E is split into 5 equal slices and F-B into 7, so black keys
  // sit off-centre like on the instrument. Values are [left, right] in white-key widths from C.
  var EXTENT = [
    [0, 1], [0.6, 1.2], [1, 2], [1.8, 2.4], [2, 3],
    [3, 4], [3 + 4 / 7, 3 + 8 / 7], [4, 5], [3 + 12 / 7, 3 + 16 / 7], [5, 6], [3 + 20 / 7, 3 + 24 / 7], [6, 7],
  ];

  // Casiotone 61-key range, C2-C7, and the physical span of full-size keys (36 white keys).
  var DEFAULT_LOW = 36, DEFAULT_HIGH = 96;
  var WHITE_MM = 846 / 36;
  // 65-inch 16:9 panel width.
  var SCREEN_MM = 1439;

  function isBlack(n) { return BLACK[((n % 12) + 12) % 12]; }

  function noteName(n) { return NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); }

  // "C4" / "F#3" / "Bb2" to a MIDI number (C4 = 60). Returns NaN for anything else.
  function parseNote(s) {
    var m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(s).trim());
    if (!m) return NaN;
    var n = NAMES.indexOf(m[1].toUpperCase()) + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
    return n + (Number(m[3]) + 1) * 12;
  }

  // Key extent in white-key units on an absolute axis (C-1 = 0).
  function keyUnits(n) {
    var e = EXTENT[((n % 12) + 12) % 12], o = Math.floor(n / 12) * 7;
    return [o + e[0], o + e[1]];
  }

  function whiteCount(low, high) {
    var c = 0;
    for (var n = low; n <= high; n++) if (!isBlack(n)) c++;
    return c;
  }

  // Map every key in a calibration to screen pixels. cal: { low, high, left, right } where left
  // and right are the outer edges of the lowest and highest keys in device pixels. Because the
  // keyboard is straight and parallel to the screen, the mapping is linear between the two edges.
  function keyLayout(cal) {
    var u0 = keyUnits(cal.low)[0], u1 = keyUnits(cal.high)[1];
    var scale = (cal.right - cal.left) / (u1 - u0);
    var keys = {};
    for (var n = cal.low; n <= cal.high; n++) {
      var u = keyUnits(n);
      keys[n] = { note: n, black: isBlack(n), x0: cal.left + (u[0] - u0) * scale, x1: cal.left + (u[1] - u0) * scale };
    }
    return { keys: keys, whiteWidth: scale, low: cal.low, high: cal.high };
  }

  // Which key sits under screen x (black keys win where they overlap), or -1.
  function keyAt(layout, x, blackZone) {
    var hit = -1;
    for (var n = layout.low; n <= layout.high; n++) {
      var k = layout.keys[n];
      if (x >= k.x0 && x < k.x1) {
        if (k.black && blackZone) return n;
        if (!k.black) hit = n;
      }
    }
    return hit;
  }

  // "Ruler" starting point: draw the keyboard at its physical width, centred on the screen.
  // spanMm defaults to full-size keys for the range; screenMm to a 65-inch panel.
  function rulerEdges(opts) {
    var low = opts.low != null ? opts.low : DEFAULT_LOW, high = opts.high != null ? opts.high : DEFAULT_HIGH;
    var span = opts.spanMm || (keyUnits(high)[1] - keyUnits(low)[0]) * WHITE_MM;
    var pxPerMm = opts.screenPx / (opts.screenMm || SCREEN_MM);
    var width = span * pxPerMm, mid = opts.screenPx / 2;
    return { left: Math.round(mid - width / 2), right: Math.round(mid + width / 2) };
  }

  // "From seat": the screen is farther from the eyes than the keys, so the strip has to be wider
  // by the ratio of the two distances to look aligned from the stool.
  function seatScale(eyeToStripMm, eyeToKeysMm) {
    return eyeToKeysMm > 0 ? eyeToStripMm / eyeToKeysMm : 1;
  }

  // Calibrations are stored in the device pixels of the screen they were made on; a screen with a
  // different width scales them proportionally.
  function scaleCalibration(cal, screenPx) {
    var f = cal.screenPx ? screenPx / cal.screenPx : 1;
    return { low: cal.low, high: cal.high, left: cal.left * f, right: cal.right * f, screenPx: screenPx };
  }

  function defaultCalibration(screenPx) {
    var e = rulerEdges({ screenPx: screenPx });
    return { low: DEFAULT_LOW, high: DEFAULT_HIGH, left: e.left, right: e.right, screenPx: screenPx, mode: "ruler", savedAt: 0 };
  }

  // Returns a clean calibration object or null when anything is out of range.
  function validCalibration(c) {
    if (!c || typeof c !== "object") return null;
    var low = Number(c.low), high = Number(c.high), left = Number(c.left), right = Number(c.right), screenPx = Number(c.screenPx);
    var ints = [low, high].every(function (v) { return Math.floor(v) === v && v >= 0 && v <= 127; });
    if (!ints || high - low < 12 || high - low > 87) return null;
    if (![left, right, screenPx].every(isFinite) || screenPx < 100 || screenPx > 16384) return null;
    if (left < -screenPx || right > 2 * screenPx || right - left < 50) return null;
    return {
      low: low, high: high, left: left, right: right, screenPx: screenPx,
      mode: c.mode === "ruler" ? "ruler" : "seat",
      savedAt: Number(c.savedAt) || 0,
    };
  }

  // ---------- songs ----------

  // A finger number: 1 (thumb) to 5 (little finger).
  function isFinger(f) {
    return typeof f === "number" && Math.floor(f) === f && f >= 1 && f <= 5;
  }

  // "right" / "left" from a song or note hand field ("R", "L", "rh", "left hand", ...), or "" when unknown.
  function handName(h) {
    var c = String(h == null ? "" : h).trim().toLowerCase().charAt(0);
    return c === "r" ? "right" : c === "l" ? "left" : "";
  }

  // Song file: { title, hand, notes: [[name, startBeat, lengthBeats, hand?, finger?], ...], bpm, beatsPerBar, key?, ... }.
  // A note without its own hand ("R" / "L") belongs to the song's hand, which defaults to right.
  // finger is 1 (thumb) to 5 (little finger); a number in the hand's place is a finger with the
  // song's hand, so ["E4", 0, 1, 3] and ["E4", 0, 1, "R", 3] are the same note.
  // Returns { song } or { error }. Notes are sorted and given MIDI numbers.
  function normalizeSong(raw, id) {
    if (!raw || typeof raw !== "object") return { error: "not an object" };
    if (!raw.title) return { error: "missing title" };
    if (!Array.isArray(raw.notes) || !raw.notes.length) return { error: "no notes" };
    var songHand = raw.hand == null || raw.hand === "" ? "right" : handName(raw.hand);
    if (!songHand) return { error: "bad hand: " + JSON.stringify(raw.hand) };
    var notes = [], present = {};
    for (var i = 0; i < raw.notes.length; i++) {
      var r = raw.notes[i], n = Array.isArray(r) ? r : [r && r.note, r && r.start, r && r.length, r && r.hand, r && r.finger];
      if (typeof n[3] === "number") n = [n[0], n[1], n[2], null, n[3]];
      var midi = typeof n[0] === "number" ? n[0] : parseNote(n[0]);
      var start = Number(n[1]), len = Number(n[2]);
      var hand = n[3] == null || n[3] === "" ? songHand : handName(n[3]);
      var finger = n[4] == null ? 0 : n[4];
      if (!(midi >= 0 && midi <= 127) || !isFinite(start) || start < 0 || !(len > 0) || !hand || !(n[4] == null || isFinger(finger))) return { error: "bad note #" + (i + 1) + ": " + JSON.stringify(r) };
      notes.push({ note: midi, start: start, length: len, hand: hand, finger: finger });
      present[hand] = true;
    }
    notes.sort(function (a, b) { return a.start - b.start || a.note - b.note; });
    return {
      song: {
        id: id || raw.id || "",
        title: String(raw.title),
        composer: String(raw.composer || ""),
        source: String(raw.source || ""),
        license: String(raw.license || ""),
        hand: songHand,
        hands: ["right", "left"].filter(function (h) { return present[h]; }),
        bpm: Number(raw.bpm) > 0 ? Number(raw.bpm) : 80,
        beatsPerBar: Number(raw.beatsPerBar) > 0 ? Number(raw.beatsPerBar) : 4,
        // Key signature for the sheet music ("G", "Bb", "Em"); guessed from the notes when empty.
        key: String(raw.key || ""),
        notes: notes,
      },
    };
  }

  // Shift notes outside [low, high] by whole octaves until they fit; shifted notes are flagged.
  function fitSong(song, low, high) {
    var shifted = 0;
    var notes = song.notes.map(function (x) {
      var n = x.note;
      while (n < low) n += 12;
      while (n > high) n -= 12;
      if (n !== x.note) shifted++;
      return { note: n, start: x.start, length: x.length, hand: x.hand || "right", finger: x.finger || 0, shifted: n !== x.note };
    });
    var out = {};
    for (var k in song) out[k] = song[k];
    out.notes = notes;
    out.shifted = shifted;
    return out;
  }

  // Group notes that start together into steps: wait mode waits for each step in turn. Each step
  // records which hand plays each of its notes, and the finger when the song gives one.
  function buildSteps(notes) {
    var steps = [];
    for (var i = 0; i < notes.length; i++) {
      var last = steps[steps.length - 1], n = notes[i];
      if (!last || Math.abs(last.start - n.start) >= 1e-6) steps.push(last = { start: n.start, notes: [], hands: {}, fingers: {} });
      if (last.notes.indexOf(n.note) < 0) {
        last.notes.push(n.note); last.hands[n.note] = n.hand || "right";
        if (n.finger) last.fingers[n.note] = n.finger;
      }
    }
    return steps;
  }

  // Bars in a song (a bar is beatsPerBar beats, bar 1 starts on beat 0).
  function barCount(song) {
    var end = 0;
    for (var i = 0; i < song.notes.length; i++) end = Math.max(end, song.notes[i].start + song.notes[i].length);
    return Math.max(1, Math.ceil(end / song.beatsPerBar - 1e-6));
  }

  function barOf(song, beat) { return Math.floor(Math.max(0, beat) / song.beatsPerBar + 1e-6) + 1; }

  // The hand mode that actually applies to a song: asking for a hand the song does not have
  // (left hand on a right-hand-only song) plays the whole song instead.
  function playHand(song, hand) {
    var hands = song.hands || ["right"];
    return (hand === "right" || hand === "left") && hands.indexOf(hand) >= 0 && hands.length > 1 ? hand : "both";
  }

  // A practice loop clamped to the song: { from, to } in bars, or null for no loop.
  function clampLoop(song, loop) {
    if (!loop) return null;
    var bars = barCount(song), from = Math.floor(Number(loop.from)), to = Math.floor(Number(loop.to != null ? loop.to : loop.from));
    if (!(from >= 1)) return null;
    from = Math.min(from, bars); to = Math.max(from, Math.min(to >= 1 ? to : from, bars));
    return { from: from, to: to };
  }

  // ---------- wait mode ----------

  // Song clock in beats: it runs at tempo but never passes the step still waiting for keys.
  function advanceClock(clock, dtMs, bpm, waitAt) {
    var next = clock + (dtMs / 60000) * bpm;
    return waitAt != null && next > waitAt ? waitAt : next;
  }

  // Plain-words hint from the key that was pressed to the key that was wanted.
  function hint(pressed, target) {
    var head = noteName(pressed) + " → try " + noteName(target);
    if (pressed === target) return head;
    var dir = target > pressed ? "right" : "left", diff = Math.abs(target - pressed);
    if (diff % 12 === 0) {
      var oct = diff / 12;
      return head + ", " + (oct === 1 ? "one octave" : oct + " octaves") + " " + (target > pressed ? "up" : "down");
    }
    if (isBlack(target)) {
      return head + ", the black key " + (diff === 1 ? "just " + dir : diff + " keys to the " + dir);
    }
    var lo = Math.min(pressed, target), hi = Math.max(pressed, target), whites = 0;
    for (var n = lo + 1; n <= hi; n++) if (!isBlack(n)) whites++;
    if (isBlack(pressed) && target < pressed) whites++;
    var words = ["", "one", "two", "three", "four", "five", "six"];
    return head + ", " + (words[whites] || whites) + " white key" + (whites === 1 ? "" : "s") + " to the " + dir;
  }

  // Clean passes in a row that finish a practice loop.
  var LOOP_CLEAN = 3;

  // The notes a session asks for and the hand mode and loop that apply: mine are the chosen hand's
  // notes inside the loop (idx holds their indexes in song.notes), other the other hand's notes.
  function partNotes(song, opts) {
    var hand = song.beatsPerBar ? playHand(song, opts.hand) : "both";
    var loop = song.beatsPerBar ? clampLoop(song, opts.loop) : null;
    var lo = loop ? (loop.from - 1) * song.beatsPerBar : -Infinity, hi = loop ? loop.to * song.beatsPerBar : Infinity;
    var mine = [], idx = [], other = [];
    for (var i = 0; i < song.notes.length; i++) {
      var n = song.notes[i];
      if (hand === "both" || (n.hand || "right") === hand) { if (n.start >= lo - 1e-6 && n.start < hi - 1e-6) { mine.push(n); idx.push(i); } }
      else other.push(n);
    }
    return { hand: hand, loop: loop, lo: lo, hi: hi, mine: mine, idx: idx, other: other };
  }

  // True when note is one of the other hand's notes sounding at beat, or starting up to early beats
  // after it: it may be played along without penalty. same compares two notes.
  function otherSounding(other, note, beat, early, same) {
    for (var i = 0; i < other.length; i++) {
      var o = other[i];
      if (same(o.note, note) && o.start <= beat + early + 1e-6 && o.start + o.length > beat + 1e-6) return true;
    }
    return false;
  }

  // Wait-mode session: the song only advances when every note of the current step has been
  // struck since that step came up. Repeated notes must be struck again.
  // opts.hand: "right" | "left" | "both" (default): in one-hand mode the other hand's notes are not
  // required, and striking one of them while it is due is ignored instead of counted wrong.
  // opts.loop: { from, to } bars: only those bars are played, over and over; a pass with no wrong
  // key is clean, and LOOP_CLEAN clean passes in a row finish the loop.
  // opts.tolerant (or s.setTolerant()): mic mode, where a microphone hears one note at a time and
  // may hear it an octave off. Only the top note of each step is waited for (and lit), and the right
  // note name within an octave of it counts. A microphone hearing a chord mostly hears its bass or
  // the chord's common root an octave or two lower, so any of the chord's note names, in any octave,
  // also completes a chord step. The other hand's due notes and the last step's top note ringing on
  // are ignored instead of counted wrong.
  function createSession(song, opts) {
    opts = opts || {};
    var part = partNotes(song, opts), hand = part.hand, loop = part.loop, hi = part.hi, other = part.other;
    var steps = buildSteps(part.mine);
    var s = {
      steps: steps,
      hand: hand,
      loop: loop,
      // Beats the session covers, so the page can start its clock just before the first step.
      range: { start: steps.length ? steps[0].start : 0, end: loop ? hi : Infinity },
      index: 0,
      hit: {},
      correct: 0,
      wrong: 0,
      streak: 0,
      bestStreak: 0,
      lastWrong: null,
      wrongKeys: {},
      passes: 0,
      passWrong: 0,
      cleanPasses: 0,
      cleanNeeded: LOOP_CLEAN,
      done: steps.length === 0,
      tolerant: !!opts.tolerant,
    };
    s.setTolerant = function (on) { s.tolerant = !!on; };
    s.current = function () { return s.done ? null : steps[s.index]; };
    // The notes a step needs: all of them, or in mic mode only the top one.
    function needed(st) { return s.tolerant ? [Math.max.apply(null, st.notes)] : st.notes; }
    s.needed = function () { var st = s.current(); return st ? needed(st) : []; };
    s.waitingFor = function () {
      var st = s.current();
      return st ? needed(st).filter(function (n) { return !s.hit[n]; }) : [];
    };
    s.accuracy = function () {
      var total = s.correct + s.wrong;
      return total ? s.correct / total : 1;
    };
    // In mic mode a note matches a wanted one with the same name up to an octave away.
    function same(a, b) { return a === b || (s.tolerant && Math.abs(a - b) <= 12 && (a - b) % 12 === 0); }
    function matchIn(note, list) {
      for (var i = 0; i < list.length; i++) if (list[i] === note) return list[i];
      for (i = 0; i < list.length; i++) if (same(note, list[i])) return list[i];
      return -1;
    }
    function chordName(note, st) {
      for (var i = 0; i < st.notes.length; i++) if ((((st.notes[i] - note) % 12) + 12) % 12 === 0) return true;
      return false;
    }
    // The other hand's note sounding at the current step (it may be played along without penalty).
    function otherDue(note, st) {
      for (var i = 0; i < other.length; i++) {
        var o = other[i];
        if (same(o.note, note) && o.start <= st.start + 1e-6 && o.start + o.length > st.start + 1e-6) return true;
      }
      return false;
    }
    // Returns { result: "correct" | "advance" | "pass" | "wrong" | "done" | "ignored", hint?, step?, clean? }.
    // "pass" ends one time through a loop and starts the next; clean says whether it had no wrong key.
    s.press = function (note) {
      if (s.done) return { result: "ignored" };
      var st = steps[s.index], top = needed(st), want = matchIn(note, top);
      if (want < 0 && s.tolerant && st.notes.length > 1 && chordName(note, st)) want = top[0];
      if (want >= 0) {
        if (s.hit[want]) return { result: "ignored" };
        s.hit[want] = true;
        s.correct++; s.streak++;
        if (s.streak > s.bestStreak) s.bestStreak = s.streak;
        s.lastWrong = null;
        if (s.waitingFor().length) return { result: "correct" };
        s.index++; s.hit = {};
        if (s.index < steps.length) return { result: "advance", step: s.index };
        if (!loop) { s.done = true; return { result: "done" }; }
        var clean = s.passWrong === 0;
        s.passes++; s.passWrong = 0; s.index = 0;
        s.cleanPasses = clean ? s.cleanPasses + 1 : 0;
        if (s.cleanPasses >= LOOP_CLEAN) { s.done = true; return { result: "done", clean: true }; }
        return { result: "pass", clean: clean };
      }
      if (otherDue(note, st)) return { result: "ignored", other: true };
      if (s.tolerant) {
        // The note just played still ringing as the next is struck.
        var prev = s.index > 0 ? steps[s.index - 1] : null;
        if (prev && same(note, needed(prev)[0])) return { result: "ignored", ringing: true };
      }
      s.wrong++; s.passWrong++; s.streak = 0;
      s.wrongKeys[note] = (s.wrongKeys[note] || 0) + 1;
      var want = s.waitingFor(), target = want[0];
      for (var i = 1; i < want.length; i++) if (Math.abs(want[i] - note) < Math.abs(target - note)) target = want[i];
      s.lastWrong = { note: note, target: target, hint: hint(note, target) };
      return { result: "wrong", hint: s.lastWrong.hint, target: target };
    };
    s.restart = function () {
      s.index = 0; s.hit = {}; s.correct = 0; s.wrong = 0; s.streak = 0; s.bestStreak = 0; s.lastWrong = null; s.wrongKeys = {};
      s.passes = 0; s.passWrong = 0; s.cleanPasses = 0;
      s.done = steps.length === 0;
    };
    return s;
  }

  // ---------- tempo mode ----------

  // Tempo mode plays the song at a set share of its tempo and does not wait. Each note is judged by
  // when it is struck: within TEMPO_ON_MS of its time it is on time, within TEMPO_WINDOW_MS early or
  // late, and a note not struck by the end of its window is missed.
  var TEMPO_WINDOW_MS = 300, TEMPO_ON_MS = 110;
  var SPEED_MIN = 50, SPEED_MAX = 100, SPEED_STEP = 5;

  // A tempo-mode speed in percent of the song's tempo: SPEED_MIN-SPEED_MAX in SPEED_STEP steps.
  function clampSpeed(pct) {
    var v = Math.round(Number(pct) / SPEED_STEP) * SPEED_STEP;
    return isFinite(v) ? Math.max(SPEED_MIN, Math.min(SPEED_MAX, v)) : SPEED_MAX;
  }

  // The count-in shown before start: 1 to beats while clock is in the bar before start, else 0.
  function countIn(clock, start, beats) {
    if (!(clock >= start - beats - 1e-6) || clock >= start) return 0;
    return Math.min(beats, Math.floor(clock - (start - beats) + 1e-6) + 1);
  }

  // Tempo-mode session. opts.hand and opts.loop work as in wait mode; opts.speed is the percent of
  // the song's tempo. The page runs the clock (in beats) and calls press(note, beat) for each key and
  // tick(beat) every frame. range.start is the bar line the song (or loop) starts on, range.countIn
  // the beats of count-in before it and noteCount the notes in a pass. judged maps an index in
  // song.notes to "on time", "early", "late" or "miss". A loop pass with no miss and no wrong key is
  // clean; LOOP_CLEAN in a row finish it. opts.tolerant (or s.setTolerant()) is mic mode as in wait
  // mode: only the top note of each chord is played and judged, the right note name an octave up or
  // down counts, and the chord's other notes are ignored instead of counted wrong. opts.countIn sets the
  // count-in beats (default one bar; 0 for none). offsetMsSum is the sum of the signed hit offsets in
  // ms (negative early), for the mean timing.
  function createTempoSession(song, opts) {
    opts = opts || {};
    var part = partNotes(song, opts), loop = part.loop, other = part.other;
    var speed = clampSpeed(opts.speed), bpb = song.beatsPerBar || 4;
    var beatMs = 60000 / (song.bpm * speed / 100), win = TEMPO_WINDOW_MS / beatMs, onTime = TEMPO_ON_MS / beatMs;
    var notes = part.mine, idx = part.idx, last = 0, end = 0;
    for (var i = 0; i < notes.length; i++) { last = Math.max(last, notes[i].start); end = Math.max(end, notes[i].start + notes[i].length); }
    // The top note of the chord each note belongs to, for mic mode.
    var top = [];
    for (var t = 0; t < notes.length; t++) {
      var hiNote = notes[t].note;
      for (var u = 0; u < notes.length; u++) if (Math.abs(notes[u].start - notes[t].start) < 1e-6) hiNote = Math.max(hiNote, notes[u].note);
      top.push(hiNote);
    }
    var first = notes.length ? notes[0].start : 0;
    if (loop) end = part.hi;
    // The pass (or the song) is over once the last note's window has closed and its bars have played.
    var finish = Math.max(end, last + win);
    var s = {
      tempo: true,
      hand: part.hand,
      loop: loop,
      speed: speed,
      beatMs: beatMs,
      window: win,
      noteCount: notes.length,
      range: { start: loop ? part.lo : Math.floor(first / bpb + 1e-6) * bpb, end: end, countIn: opts.countIn == null ? bpb : Math.max(0, Math.floor(opts.countIn)) },
      judged: {},
      lastTiming: null,
      cleanNeeded: LOOP_CLEAN,
      tolerant: !!opts.tolerant,
    };
    s.setTolerant = function (on) { s.tolerant = !!on; };
    // The speed ramp raises the speed between loop passes: the clock and the timing windows follow it.
    s.setSpeed = function (pct) {
      speed = clampSpeed(pct);
      beatMs = 60000 / (song.bpm * speed / 100); win = TEMPO_WINDOW_MS / beatMs; onTime = TEMPO_ON_MS / beatMs;
      finish = Math.max(end, last + win);
      s.speed = speed; s.beatMs = beatMs; s.window = win;
    };
    function same(a, b) { return a === b || (s.tolerant && Math.abs(a - b) <= 12 && (a - b) % 12 === 0); }
    // In mic mode only a chord's top note is played.
    function counts(j) { return !s.tolerant || notes[j].note === top[j]; }
    function pending(j) { return counts(j) && !s.judged[idx[j]]; }
    // The earliest chord still to be played, shaped like a wait-mode step.
    s.current = function () {
      if (s.done) return null;
      var st = null;
      for (var j = 0; j < notes.length; j++) {
        if (!pending(j)) continue;
        var n = notes[j];
        if (!st) st = { start: n.start, notes: [], hands: {}, fingers: {} };
        else if (n.start > st.start + 1e-6) break;
        if (st.notes.indexOf(n.note) < 0) {
          st.notes.push(n.note); st.hands[n.note] = n.hand || "right";
          if (n.finger) st.fingers[n.note] = n.finger;
        }
      }
      return st;
    };
    s.waitingFor = function () { var st = s.current(); return st ? st.notes : []; };
    s.needed = s.waitingFor;
    s.accuracy = function () {
      var total = s.correct + s.wrong + s.missed;
      return total ? s.correct / total : 1;
    };
    // Returns { result: "hit", timing, ms } (ms early < 0 < late), { result: "wrong", hint, target }
    // or { result: "ignored" }. Keys before the count-in ends are ignored, as are the other hand's
    // notes while they sound and a note struck again while it still sounds after a hit.
    s.press = function (note, beat) {
      if (s.done || beat < s.range.start - win) return { result: "ignored" };
      var best = -1;
      for (var j = 0; j < notes.length; j++) {
        if (!same(notes[j].note, note) || !pending(j) || Math.abs(notes[j].start - beat) > win + 1e-9) continue;
        // The exact key wins over the same name an octave away, then the nearest in time.
        var better = best < 0 || (notes[j].note === note) > (notes[best].note === note) ||
          ((notes[j].note === note) === (notes[best].note === note) && Math.abs(notes[j].start - beat) < Math.abs(notes[best].start - beat));
        if (better) best = j;
      }
      if (best >= 0) {
        var d = beat - notes[best].start, timing = Math.abs(d) <= onTime ? "on time" : d < 0 ? "early" : "late";
        s.judged[idx[best]] = timing;
        s.correct++; s.streak++;
        if (s.streak > s.bestStreak) s.bestStreak = s.streak;
        if (timing === "on time") s.onTime++; else if (timing === "early") s.early++; else s.late++;
        s.lastTiming = { timing: timing, ms: Math.round(d * beatMs) };
        s.offsetMsSum += s.lastTiming.ms;
        s.lastWrong = null;
        return { result: "hit", timing: timing, ms: s.lastTiming.ms };
      }
      for (var k = 0; k < notes.length; k++) {
        var h = notes[k];
        var sounding = h.start - win <= beat && beat < h.start + h.length;
        if (same(h.note, note) && counts(k) && s.judged[idx[k]] && s.judged[idx[k]] !== "miss" && sounding) return { result: "ignored" };
        if (s.tolerant && !counts(k) && same(h.note, note) && sounding) return { result: "ignored" };
      }
      if (otherSounding(other, note, beat, win, same)) return { result: "ignored", other: true };
      s.wrong++; s.passWrong++; s.streak = 0;
      s.wrongKeys[note] = (s.wrongKeys[note] || 0) + 1;
      var want = s.waitingFor(), target = want.length ? want[0] : note;
      for (var w = 1; w < want.length; w++) if (Math.abs(want[w] - note) < Math.abs(target - note)) target = want[w];
      s.lastWrong = { note: note, target: target, hint: hint(note, target) };
      return { result: "wrong", hint: s.lastWrong.hint, target: target };
    };
    // Called as the clock moves: returns { misses: [note, ...], result?: "pass" | "done", clean? }.
    // On "pass" the loop starts over: the page runs the count-in again before range.start.
    s.tick = function (beat) {
      var misses = [];
      if (s.done) return { misses: misses };
      for (var j = 0; j < notes.length; j++) {
        if (pending(j) && notes[j].start + win < beat) {
          s.judged[idx[j]] = "miss";
          s.missed++; s.passMissed++; s.streak = 0;
          misses.push(notes[j].note);
        }
      }
      if (!(beat > finish)) return { misses: misses };
      if (!loop) { s.done = true; return { misses: misses, result: "done" }; }
      var clean = s.passWrong === 0 && s.passMissed === 0;
      s.passes++; s.passWrong = 0; s.passMissed = 0; s.judged = {};
      s.cleanPasses = clean ? s.cleanPasses + 1 : 0;
      if (s.cleanPasses >= LOOP_CLEAN) { s.done = true; return { misses: misses, result: "done", clean: true }; }
      return { misses: misses, result: "pass", clean: clean };
    };
    // Play again from beat (after Hear it first): notes from there on are to be played again. Going
    // back to the start of a loop starts its pass over.
    s.seek = function (beat) {
      for (var j = 0; j < notes.length; j++) if (notes[j].start >= beat - 1e-6) delete s.judged[idx[j]];
      if (loop && beat <= s.range.start + 1e-6) { s.passWrong = 0; s.passMissed = 0; }
    };
    s.restart = function () {
      s.judged = {}; s.correct = 0; s.wrong = 0; s.missed = 0; s.onTime = 0; s.early = 0; s.late = 0;
      s.streak = 0; s.bestStreak = 0; s.lastWrong = null; s.lastTiming = null; s.wrongKeys = {}; s.offsetMsSum = 0;
      s.passes = 0; s.passWrong = 0; s.passMissed = 0; s.cleanPasses = 0;
      s.done = notes.length === 0;
    };
    s.restart();
    return s;
  }

  // ---------- speed ramp, metronome and count-in ----------

  var RAMP_STEP = 5, RAMP_TARGET = 100;

  // The tempo-mode speed after a loop pass with the speed ramp on: a clean pass steps up toward the
  // target, a miss or wrong key holds the speed, and it never goes down.
  function rampSpeed(speed, clean, target, step) {
    speed = clampSpeed(speed);
    target = target == null ? RAMP_TARGET : clampSpeed(target);
    step = step > 0 ? step : RAMP_STEP;
    if (!clean || speed >= target) return speed;
    return Math.min(target, speed + step);
  }

  // Milliseconds per beat at speed percent of the song's bpm.
  function beatLengthMs(bpm, speed) {
    return 60000 / (bpm * clampSpeed(speed) / 100);
  }

  // The metronome clicks from..to (in beats, from exclusive): each whole beat, accented on a bar line.
  // The page calls it each frame with the previous and current clock (or with a short look-ahead) to
  // know which clicks to schedule. Beats are negative during a count-in.
  function metronomeBeats(from, to, beatsPerBar) {
    if (!isFinite(from) || !isFinite(to) || !(to > from)) return [];
    var bpb = beatsPerBar || 4, out = [];
    for (var b = Math.floor(from + 1e-6) + 1; b <= to + 1e-6 && out.length < 64; b++) {
      out.push({ beat: b, accent: ((b % bpb) + bpb) % bpb === 0 });
    }
    return out;
  }

  // The count-in length in beats, one bar when on.
  function countInBeats(on, beatsPerBar) {
    return on ? (beatsPerBar || 4) : 0;
  }

  // ---------- hear it first ----------

  // Each note is released a little early when the song is played back, so a repeated note is struck
  // again instead of blurring into one long note: 10% of its length, at most this many ms.
  var LISTEN_GAP_MS = 60;
  // The link page starts playing this long after the request reaches it and the TV starts lighting
  // keys this long after its request returns, so sound and lights start together.
  var LISTEN_LEAD_MS = 150;

  // What "hear it first" plays: bars from..to of song at its tempo (or opts.speed percent of it), for one hand or both.
  // Returns { from, to, startBeat, endBeat, beatMs, ms, events: [{ note, hand, finger, at, dur }] },
  // with at and dur in milliseconds from the start of bar from. Notes are clipped at the end of the
  // range; notes that start before it are left out.
  function listenPlan(song, opts) {
    var hand = playHand(song, opts.hand);
    var range = clampLoop(song, { from: opts.from, to: opts.to }) || { from: 1, to: 1 };
    var bpb = song.beatsPerBar, lo = (range.from - 1) * bpb, hi = range.to * bpb;
    var beatMs = 60000 / (song.bpm * (opts.speed ? clampSpeed(opts.speed) : 100) / 100);
    var events = [];
    for (var i = 0; i < song.notes.length; i++) {
      var n = song.notes[i];
      if (hand !== "both" && (n.hand || "right") !== hand) continue;
      if (n.start < lo - 1e-6 || n.start >= hi - 1e-6) continue;
      var ms = Math.min(n.length, hi - n.start) * beatMs;
      events.push({ note: n.note, hand: n.hand || "right", finger: n.finger || 0, at: Math.round((n.start - lo) * beatMs), dur: Math.round(ms - Math.min(ms * 0.1, LISTEN_GAP_MS)) });
    }
    return { from: range.from, to: range.to, hand: hand, startBeat: lo, endBeat: hi, beatMs: beatMs, ms: Math.round((hi - lo) * beatMs), events: events };
  }

  // Notes of a plan sounding elapsed ms after it started: note -> event.
  function sounding(plan, elapsed) {
    var out = {};
    for (var i = 0; i < plan.events.length; i++) {
      var e = plan.events[i];
      if (elapsed >= e.at && elapsed < e.at + e.dur) out[e.note] = e;
    }
    return out;
  }

  // Raw MIDI messages for a plan's events, starting at t0 (a performance.now() time): note on and
  // note off on channel 1, in time order with offs before ons at the same moment so a repeated key
  // is released before it is struck again.
  function midiMessages(events, t0, velocity) {
    var v = velocity || 80, out = [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!(e.note >= 0 && e.note <= 127)) continue;
      out.push({ time: t0 + e.at, data: [0x90, e.note, v] });
      out.push({ time: t0 + e.at + Math.max(1, e.dur), data: [0x80, e.note, 0] });
    }
    out.sort(function (a, b) { return a.time - b.time || a.data[0] - b.data[0]; });
    return out;
  }

  // ---------- the other hand plays itself ----------

  // While one hand is practised the keyboard plays the other, a little at a time: the notes about to
  // fall due within AUTO_AHEAD_MS go to the link page, which queues them on the MIDI output.
  var AUTO_AHEAD_MS = 250;
  // A note found more than this late (a stalled frame) is skipped instead of played in a burst.
  var AUTO_STALE_MS = 100;

  // Why the other hand cannot be played on the keyboard now ("" when it can): st is { output, input,
  // link }, the link page's MIDI output name, its input kind ("mic" or "midi") and the open link pages.
  // The notes then stay as they are, dimmed and not waited for.
  function autoHandBlocker(st) {
    if (!st || !st.link) return "no link page is open";
    if (st.input === "mic") return "the microphone is the input";
    if (!st.output) return "the link page has no MIDI output";
    return "";
  }

  // The player for the hand not being practised, or null when there is nothing for it to play: both
  // hands practised, a song with one hand only, or no notes of the other hand inside the loop.
  // opts.hand is the hand mode, opts.loop the practice loop in bars. next(clock, beatMs, waitAt) is
  // called every frame with the song clock in beats, the length of a beat in ms (the song's tempo,
  // scaled by the speed in tempo mode) and, in wait mode, the beat of the step the player's hand is
  // waited for at (null in tempo mode). It returns { restart, events: [{ note, at, dur }] } with at and
  // dur in ms from now: the notes starting before the clock reaches AUTO_AHEAD_MS ahead and before
  // waitAt, each once. A clock that went back (a new loop pass) is a restart: whatever still sounds
  // should be released first. In wait mode the clock stops at waitAt, so the notes stop being sent;
  // they go on when the player's hand moves the song on, and the loop's own range bounds them.
  function autoHandPlayer(song, opts) {
    if (!song || !song.beatsPerBar) return null;
    var mine = playHand(song, opts && opts.hand);
    if (mine === "both") return null;
    var hand = mine === "right" ? "left" : "right";
    var loop = clampLoop(song, opts.loop);
    var lo = loop ? (loop.from - 1) * song.beatsPerBar : -Infinity, hi = loop ? loop.to * song.beatsPerBar : Infinity;
    var notes = [];
    for (var i = 0; i < song.notes.length; i++) {
      var n = song.notes[i];
      if ((n.hand || "right") === hand && n.start >= lo - 1e-6 && n.start < hi - 1e-6) notes.push(n);
    }
    if (!notes.length) return null;
    notes.sort(function (a, b) { return a.start - b.start || a.note - b.note; });
    var cursor = null, last = 0;
    return {
      hand: hand,
      notes: notes.length,
      next: function (clock, beatMs, waitAt) {
        var restart = false;
        if (cursor == null) cursor = clock;
        else if (clock < last - 1e-6) { restart = true; cursor = clock; }
        last = clock;
        var from = Math.max(cursor, clock - AUTO_STALE_MS / beatMs), limit = clock + AUTO_AHEAD_MS / beatMs;
        if (waitAt != null) limit = Math.min(limit, waitAt - 1e-6);
        var events = [];
        if (limit > cursor) {
          for (var j = 0; j < notes.length; j++) {
            var m = notes[j];
            if (m.start < from - 1e-6 || m.start >= limit) continue;
            var ms = Math.min(m.length, hi - m.start) * beatMs;
            events.push({ note: m.note, at: Math.max(0, Math.round((m.start - clock) * beatMs)), dur: Math.max(1, Math.round(ms - Math.min(ms * 0.1, LISTEN_GAP_MS))) });
          }
          cursor = limit;
        }
        return { restart: restart, events: events };
      },
    };
  }

  // ---------- hear the whole song ----------

  // The whole song reaches the link page in chunks: each covers WHOLE_CHUNK_MS of the song and is sent
  // WHOLE_AHEAD_MS before it is due, so the keyboard's MIDI output never holds more than a few seconds
  // of notes and a long song costs nothing more than a short one.
  var WHOLE_CHUNK_MS = 4000, WHOLE_AHEAD_MS = 3000;

  // The plan for the entire song, first bar to last, for one hand or both, at opts.speed percent.
  function wholeSongPlan(song, opts) {
    return listenPlan(song, { hand: opts.hand, from: 1, to: barCount(song), speed: opts.speed });
  }

  // A plan's events cut into chunks of chunkMs, in time order. Each chunk is
  // { index, base, span, last, events: [{ note, at, dur }] } with at relative to base (ms from the
  // start of the song); a note belongs to the chunk it starts in and its dur may run past the end.
  // Chunks with no notes are kept: they are the link page's sign that the sender is still there.
  function songChunks(plan, chunkMs) {
    var size = chunkMs || WHOLE_CHUNK_MS, count = Math.max(1, Math.ceil(plan.ms / size)), chunks = [];
    var sorted = plan.events.slice().sort(function (a, b) { return a.at - b.at || a.note - b.note; });
    for (var i = 0; i < count; i++) chunks.push({ index: i, base: i * size, span: size, last: i === count - 1, events: [] });
    for (var j = 0; j < sorted.length; j++) {
      var e = sorted[j], c = chunks[Math.min(count - 1, Math.floor(e.at / size))];
      c.events.push({ note: e.note, at: e.at - c.base, dur: e.dur });
    }
    return chunks;
  }

  // Sends a plan chunk by chunk, each one WHOLE_AHEAD_MS before it is due. opts: send(chunk, done) posts
  // one chunk and calls done(err); sendStop() tells the keyboard to stop; now() and setTimer(fn, ms) /
  // clearTimer(id) are the clock; onSent() hears the last chunk go out; onEnd(reason) hears "lost" (a
  // send failed) or "stopped", once; stop() tells the keyboard (stop(false) does not) even after
  // everything was sent, as the song is still sounding. Chunks go one at a time in order. start(t0)
  // fixes the moment the song begins (a now() time); the first chunk is sent at once.
  function songPlayer(plan, opts) {
    var chunks = songChunks(plan, opts.chunkMs), ahead = opts.aheadMs == null ? WHOLE_AHEAD_MS : opts.aheadMs;
    var next = 0, t0 = 0, timer = null, busy = false, ended = "", sentAll = false, stopTell = false;
    // The clock functions are called on their own, not as methods of opts: the browser's own setTimeout,
    // clearTimeout and Date.now throw "Illegal invocation" when called with another object as this.
    var now = opts.now, setTimer = opts.setTimer, clearTimer = opts.clearTimer;
    function end(reason, tell) {
      if (ended) return;
      ended = reason;
      if (timer != null) clearTimer(timer);
      timer = null;
      stopTell = reason === "stopped" && tell !== false;
      if (stopTell) opts.sendStop();
      if (opts.onEnd) opts.onEnd(reason);
    }
    function pump() {
      timer = null;
      if (ended || busy) return;
      if (next >= chunks.length) { if (!sentAll) { sentAll = true; if (opts.onSent) opts.onSent(); } return; }
      var due = t0 + chunks[next].base - ahead - now();
      if (due > 0) { timer = setTimer(pump, due); return; }
      var chunk = chunks[next++];
      busy = true;
      opts.send({ index: chunk.index, base: chunk.base, span: chunk.span, first: chunk.index === 0, last: chunk.last, events: chunk.events }, function (err) {
        busy = false;
        // A stop sent while this chunk was on its way may have reached the keyboard first: say it again.
        if (ended) { if (stopTell) opts.sendStop(); return; }
        if (err) return end("lost");
        pump();
      });
    }
    return {
      start: function (t) { t0 = t; pump(); },
      stop: function (tell) { end("stopped", tell); },
      sent: function () { return next; },
      count: function () { return chunks.length; },
      ended: function () { return ended; },
    };
  }

  // Why the whole song cannot start now ("" when it can): the page's mode and whether a song is open.
  function wholeBlocker(mode, hasSong) {
    if (mode !== "play") return "Finish the calibration first, then play the whole song";
    if (!hasSong) return "No song is open yet";
    return "";
  }

  // A request to the server for Hear it first (made at req.at) still counts as on its way for maxMs;
  // after that the next press starts afresh instead of acting as a stop.
  function listenPending(req, now, maxMs) {
    return !!req && now - (req.at || 0) < maxMs;
  }

  // What a press of the hear key (remote Rewind, P) does, given st = { playing, tapAt }: playing is true
  // while anything plays or is on its way; tapAt is when the last press started a bar (0: none). A second
  // press within doubleMs of that one plays the whole song, the way for a remote whose held keys do not
  // repeat. Otherwise it stops what plays, or starts the bar. Returns "whole", "stop" or "bar".
  function hearKeyAction(st, now, doubleMs) {
    if (st.tapAt && now - st.tapAt < doubleMs) return "whole";
    return st.playing ? "stop" : "bar";
  }

  // True when the hear key, down since downAt (0: not held), has been held for holdMs (keys that repeat).
  function hearHeld(downAt, now, holdMs) {
    return !!downAt && now - downAt >= holdMs;
  }

  // Notes the keyboard sends back while it plays what it was sent (local echo, MIDI thru) must not
  // count as the player's. expect() records each message sent; match() is true, once, for an
  // incoming message of the same kind and key within windowMs of when it was due.
  function echoFilter(windowMs) {
    var w = windowMs || 150, pending = [];
    return {
      expect: function (on, note, time) { pending.push({ on: on, note: note, time: time }); },
      match: function (on, note, time) {
        var keep = [], hit = false;
        for (var i = 0; i < pending.length; i++) {
          var p = pending[i];
          if (!hit && p.on === on && p.note === note && Math.abs(p.time - time) <= w) { hit = true; continue; }
          if (p.time > time - w) keep.push(p);
        }
        pending = keep;
        return hit;
      },
      clear: function () { pending = []; },
      size: function () { return pending.length; },
    };
  }

  // ---------- timing ----------

  // Timing is only measured where the song keeps the clock (tempo mode, any speed); wait mode waits
  // for the player so it has none. On time is within TEMPO_ON_MS, the same green "on time" the TV
  // shows. Missed notes count against note accuracy, not timing. meanMs is negative when early on
  // average.
  function timingSummary(session) {
    if (!session || !session.tempo) return null;
    var hits = session.onTime + session.early + session.late;
    if (!hits) return null;
    return {
      accuracy: Math.round(session.onTime / hits * 1000) / 10,
      onTime: session.onTime, early: session.early, late: session.late,
      meanMs: Math.round(session.offsetMsSum / hits),
    };
  }

  // A clean timing object from untrusted input, or null.
  function validTiming(t) {
    if (!t || typeof t !== "object") return null;
    var onTime = Math.floor(Number(t.onTime)), early = Math.floor(Number(t.early)), late = Math.floor(Number(t.late));
    var accuracy = Number(t.accuracy), meanMs = Number(t.meanMs);
    if (!(onTime >= 0) || !(early >= 0) || !(late >= 0) || !(onTime + early + late > 0)) return null;
    if (!(accuracy >= 0 && accuracy <= 100) || !isFinite(meanMs)) return null;
    return {
      accuracy: Math.round(accuracy * 10) / 10, onTime: onTime, early: early, late: late,
      meanMs: Math.round(Math.max(-TEMPO_WINDOW_MS, Math.min(TEMPO_WINDOW_MS, meanMs))),
    };
  }

  // A mean offset smaller than this (ms) reads as "on the beat" rather than early or late.
  var TENDENCY_MS = 15;
  function tendencyText(meanMs) {
    if (meanMs == null) return "-";
    if (Math.abs(meanMs) < TENDENCY_MS) return "on the beat";
    return Math.round(Math.abs(meanMs)) + " ms " + (meanMs < 0 ? "early" : "late");
  }

  function timingText(t) {
    if (!t) return "n/a";
    return percentText(t.accuracy) + " on time \u00b7 " + tendencyText(t.meanMs);
  }

  // ---------- score history ----------

  // A full-song play in Both hands at this accuracy (percent) or better counts a song as mastered.
  var MASTER_ACCURACY = 95;
  var PLAY_MODES = ["wait", "tempo"];

  // The history entry for a finished session: song is the fitted song, extra carries what the page
  // knows (mode, speed, durationMs). Accuracy is a percent with one decimal, wrongKeys maps a wrong
  // key's name to how often it was struck. timing is null outside tempo mode.
  function playRecord(song, session, extra) {
    extra = extra || {};
    var wrongKeys = {};
    for (var k in session.wrongKeys) wrongKeys[noteName(Number(k))] = session.wrongKeys[k];
    return {
      song: song.id, title: song.title,
      hand: session.hand, mode: extra.mode || "wait", speed: extra.speed || 1,
      loop: session.loop ? { from: session.loop.from, to: session.loop.to } : null,
      accuracy: Math.round(session.accuracy() * 1000) / 10, bestStreak: session.bestStreak,
      correct: session.correct, wrong: session.wrong, wrongKeys: wrongKeys,
      durationMs: Math.max(0, Math.round(extra.durationMs || 0)),
      timing: timingSummary(session),
    };
  }

  // A clean history entry from untrusted input, or null. The server adds `at` when it stores one.
  function validPlay(r) {
    if (!r || typeof r !== "object") return null;
    var song = String(r.song || "").slice(0, 120);
    var hand = r.hand === "right" || r.hand === "left" || r.hand === "both" ? r.hand : "";
    var accuracy = Number(r.accuracy), streak = Number(r.bestStreak), correct = Number(r.correct), wrong = Number(r.wrong);
    if (!song || !hand || !(accuracy >= 0 && accuracy <= 100) || !(streak >= 0) || !(correct >= 0) || !(wrong >= 0)) return null;
    var loop = null;
    if (r.loop) {
      var from = Math.floor(Number(r.loop.from)), to = Math.floor(Number(r.loop.to));
      if (!(from >= 1 && to >= from)) return null;
      loop = { from: from, to: to };
    }
    var wrongKeys = {};
    if (r.wrongKeys && typeof r.wrongKeys === "object") {
      Object.keys(r.wrongKeys).slice(0, 128).forEach(function (n) {
        var c = Math.floor(Number(r.wrongKeys[n]));
        if (/^[A-G]#?-?\d$/.test(n) && c > 0) wrongKeys[n] = c;
      });
    }
    return {
      song: song, title: String(r.title || "").slice(0, 200),
      hand: hand, mode: PLAY_MODES.indexOf(r.mode) >= 0 ? r.mode : "wait",
      speed: Number(r.speed) > 0 && Number(r.speed) <= 4 ? Math.round(Number(r.speed) * 100) / 100 : 1,
      loop: loop, accuracy: Math.round(accuracy * 10) / 10, bestStreak: Math.floor(streak),
      correct: Math.floor(correct), wrong: Math.floor(wrong), wrongKeys: wrongKeys,
      durationMs: Math.min(86400000, Math.max(0, Math.round(Number(r.durationMs) || 0))),
      timing: r.mode === "tempo" ? validTiming(r.timing) : null,
      at: Number(r.at) > 0 ? Math.floor(Number(r.at)) : 0,
    };
  }

  // Mastered play: the whole song (no loop) in Both hands (the effective hand: a one-hand song
  // counts), at full speed, with at least MASTER_ACCURACY percent.
  function isMasteredPlay(r) {
    return !r.loop && r.hand === "both" && (r.speed || 1) >= 1 && r.accuracy >= MASTER_ACCURACY;
  }

  // Best scores per song id from the plays. Only whole-song plays count: a loop of one bar is not
  // a score. bestAccuracy / bestStreak / bestTiming (best percent on time, tempo plays only) are over
  // every hand mode; mastered needs a Both hands play.
  function summarizeHistory(plays) {
    var out = {};
    (plays || []).forEach(function (r) {
      var e = out[r.song] || (out[r.song] = { plays: 0, fullPlays: 0, bestAccuracy: null, bestStreak: 0, bestBothAccuracy: null, bestTiming: null, mastered: false, lastAt: 0 });
      e.plays++;
      e.lastAt = Math.max(e.lastAt, r.at || 0);
      if (r.loop) return;
      e.fullPlays++;
      if (e.bestAccuracy == null || r.accuracy > e.bestAccuracy) e.bestAccuracy = r.accuracy;
      if (r.bestStreak > e.bestStreak) e.bestStreak = r.bestStreak;
      if (r.hand === "both" && (e.bestBothAccuracy == null || r.accuracy > e.bestBothAccuracy)) e.bestBothAccuracy = r.accuracy;
      if (r.timing && (e.bestTiming == null || r.timing.accuracy > e.bestTiming)) e.bestTiming = r.timing.accuracy;
      if (isMasteredPlay(r)) e.mastered = true;
    });
    return out;
  }

  // "1 min 05 s" / "42 s" for the results card.
  function durationText(ms) {
    var s = Math.round(ms / 1000), m = Math.floor(s / 60);
    return m ? m + " min " + (s % 60 < 10 ? "0" : "") + (s % 60) + " s" : s + " s";
  }

  // "98%" / "97.5%": whole numbers lose the decimal.
  function percentText(p) { return p == null ? "-" : (Math.round(p) === p ? String(p) : p.toFixed(1)) + "%"; }

  // Next hand mode when the remote cycles through them.
  var HANDS = ["right", "left", "both"];
  function nextHand(hand) { return HANDS[(HANDS.indexOf(hand) + 1) % HANDS.length]; }

  // The song to pick when the remote steps dir (+1 / -1) from current: songs with errors are skipped
  // and the list wraps. Returns "" when nothing is playable.
  function stepSong(songs, currentId, dir) {
    var ok = songs.filter(function (s) { return !s.error; });
    if (!ok.length) return "";
    var i = -1;
    for (var k = 0; k < ok.length; k++) if (ok[k].id === currentId) i = k;
    if (i < 0) return ok[0].id;
    return ok[((i + (dir < 0 ? -1 : 1)) % ok.length + ok.length) % ok.length].id;
  }

  return {
    stepSong: stepSong,
    MASTER_ACCURACY: MASTER_ACCURACY, playRecord: playRecord, validPlay: validPlay, isMasteredPlay: isMasteredPlay,
    timingSummary: timingSummary, validTiming: validTiming, timingText: timingText, tendencyText: tendencyText, TENDENCY_MS: TENDENCY_MS,
    summarizeHistory: summarizeHistory, durationText: durationText, percentText: percentText,
    DEFAULT_LOW: DEFAULT_LOW, DEFAULT_HIGH: DEFAULT_HIGH, SCREEN_MM: SCREEN_MM,
    isBlack: isBlack, noteName: noteName, parseNote: parseNote, keyUnits: keyUnits, whiteCount: whiteCount,
    keyLayout: keyLayout, keyAt: keyAt, rulerEdges: rulerEdges, seatScale: seatScale,
    scaleCalibration: scaleCalibration, defaultCalibration: defaultCalibration, validCalibration: validCalibration,
    handName: handName, isFinger: isFinger, normalizeSong: normalizeSong, fitSong: fitSong, buildSteps: buildSteps,
    barCount: barCount, barOf: barOf, playHand: playHand, clampLoop: clampLoop, nextHand: nextHand, LOOP_CLEAN: LOOP_CLEAN,
    advanceClock: advanceClock, hint: hint, createSession: createSession,
    createTempoSession: createTempoSession, clampSpeed: clampSpeed, countIn: countIn,
    TEMPO_WINDOW_MS: TEMPO_WINDOW_MS, TEMPO_ON_MS: TEMPO_ON_MS, SPEED_MIN: SPEED_MIN, SPEED_MAX: SPEED_MAX, SPEED_STEP: SPEED_STEP,
    autoHandBlocker: autoHandBlocker, autoHandPlayer: autoHandPlayer, AUTO_AHEAD_MS: AUTO_AHEAD_MS, AUTO_STALE_MS: AUTO_STALE_MS,
    wholeBlocker: wholeBlocker, listenPending: listenPending, hearKeyAction: hearKeyAction, hearHeld: hearHeld, wholeSongPlan: wholeSongPlan, songChunks: songChunks, songPlayer: songPlayer, WHOLE_CHUNK_MS: WHOLE_CHUNK_MS, WHOLE_AHEAD_MS: WHOLE_AHEAD_MS,
    listenPlan: listenPlan, sounding: sounding, midiMessages: midiMessages, echoFilter: echoFilter, LISTEN_GAP_MS: LISTEN_GAP_MS, LISTEN_LEAD_MS: LISTEN_LEAD_MS,
    RAMP_STEP: RAMP_STEP, RAMP_TARGET: RAMP_TARGET, rampSpeed: rampSpeed, beatLengthMs: beatLengthMs, metronomeBeats: metronomeBeats, countInBeats: countInBeats,
  };
});
