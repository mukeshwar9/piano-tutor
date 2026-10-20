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

  // Wait-mode session: the song only advances when every note of the current step has been
  // struck since that step came up. Repeated notes must be struck again.
  // opts.hand: "right" | "left" | "both" (default): in one-hand mode the other hand's notes are not
  // required, and striking one of them while it is due is ignored instead of counted wrong.
  // opts.loop: { from, to } bars: only those bars are played, over and over; a pass with no wrong
  // key is clean, and LOOP_CLEAN clean passes in a row finish the loop.
  function createSession(song, opts) {
    opts = opts || {};
    var hand = song.beatsPerBar ? playHand(song, opts.hand) : "both";
    var loop = song.beatsPerBar ? clampLoop(song, opts.loop) : null;
    var lo = loop ? (loop.from - 1) * song.beatsPerBar : -Infinity, hi = loop ? loop.to * song.beatsPerBar : Infinity;
    var mine = [], other = [];
    for (var i = 0; i < song.notes.length; i++) {
      var n = song.notes[i];
      if (hand === "both" || (n.hand || "right") === hand) { if (n.start >= lo - 1e-6 && n.start < hi - 1e-6) mine.push(n); }
      else other.push(n);
    }
    var steps = buildSteps(mine);
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
    };
    s.current = function () { return s.done ? null : steps[s.index]; };
    s.waitingFor = function () {
      var st = s.current();
      return st ? st.notes.filter(function (n) { return !s.hit[n]; }) : [];
    };
    s.accuracy = function () {
      var total = s.correct + s.wrong;
      return total ? s.correct / total : 1;
    };
    // The other hand's note sounding at the current step (it may be played along without penalty).
    function otherDue(note, st) {
      for (var i = 0; i < other.length; i++) {
        var o = other[i];
        if (o.note === note && o.start <= st.start + 1e-6 && o.start + o.length > st.start + 1e-6) return true;
      }
      return false;
    }
    // Returns { result: "correct" | "advance" | "pass" | "wrong" | "done" | "ignored", hint?, step?, clean? }.
    // "pass" ends one time through a loop and starts the next; clean says whether it had no wrong key.
    s.press = function (note) {
      if (s.done) return { result: "ignored" };
      var st = steps[s.index];
      if (st.notes.indexOf(note) >= 0) {
        if (s.hit[note]) return { result: "ignored" };
        s.hit[note] = true;
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

  // ---------- hear it first ----------

  // Each note is released a little early when the song is played back, so a repeated note is struck
  // again instead of blurring into one long note: 10% of its length, at most this many ms.
  var LISTEN_GAP_MS = 60;
  // The link page starts playing this long after the request reaches it and the TV starts lighting
  // keys this long after its request returns, so sound and lights start together.
  var LISTEN_LEAD_MS = 150;

  // What "hear it first" plays: bars from..to of song at its tempo, for one hand or both.
  // Returns { from, to, startBeat, endBeat, beatMs, ms, events: [{ note, hand, finger, at, dur }] },
  // with at and dur in milliseconds from the start of bar from. Notes are clipped at the end of the
  // range; notes that start before it are left out.
  function listenPlan(song, opts) {
    var hand = playHand(song, opts.hand);
    var range = clampLoop(song, { from: opts.from, to: opts.to }) || { from: 1, to: 1 };
    var bpb = song.beatsPerBar, lo = (range.from - 1) * bpb, hi = range.to * bpb, beatMs = 60000 / song.bpm;
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

  // ---------- score history ----------

  // A full-song play in Both hands at this accuracy (percent) or better counts a song as mastered.
  var MASTER_ACCURACY = 95;
  var PLAY_MODES = ["wait", "tempo"];

  // The history entry for a finished session: song is the fitted song, extra carries what the page
  // knows (mode, speed, durationMs). Accuracy is a percent with one decimal, wrongKeys maps a wrong
  // key's name to how often it was struck.
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
      at: Number(r.at) > 0 ? Math.floor(Number(r.at)) : 0,
    };
  }

  // Mastered play: the whole song (no loop) in Both hands (the effective hand: a one-hand song
  // counts), at full speed, with at least MASTER_ACCURACY percent.
  function isMasteredPlay(r) {
    return !r.loop && r.hand === "both" && (r.speed || 1) >= 1 && r.accuracy >= MASTER_ACCURACY;
  }

  // Best scores per song id from the plays. Only whole-song plays count: a loop of one bar is not
  // a score. bestAccuracy / bestStreak are over every hand mode; mastered needs a Both hands play.
  function summarizeHistory(plays) {
    var out = {};
    (plays || []).forEach(function (r) {
      var e = out[r.song] || (out[r.song] = { plays: 0, fullPlays: 0, bestAccuracy: null, bestStreak: 0, bestBothAccuracy: null, mastered: false, lastAt: 0 });
      e.plays++;
      e.lastAt = Math.max(e.lastAt, r.at || 0);
      if (r.loop) return;
      e.fullPlays++;
      if (e.bestAccuracy == null || r.accuracy > e.bestAccuracy) e.bestAccuracy = r.accuracy;
      if (r.bestStreak > e.bestStreak) e.bestStreak = r.bestStreak;
      if (r.hand === "both" && (e.bestBothAccuracy == null || r.accuracy > e.bestBothAccuracy)) e.bestBothAccuracy = r.accuracy;
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
    summarizeHistory: summarizeHistory, durationText: durationText, percentText: percentText,
    DEFAULT_LOW: DEFAULT_LOW, DEFAULT_HIGH: DEFAULT_HIGH, SCREEN_MM: SCREEN_MM,
    isBlack: isBlack, noteName: noteName, parseNote: parseNote, keyUnits: keyUnits, whiteCount: whiteCount,
    keyLayout: keyLayout, keyAt: keyAt, rulerEdges: rulerEdges, seatScale: seatScale,
    scaleCalibration: scaleCalibration, defaultCalibration: defaultCalibration, validCalibration: validCalibration,
    handName: handName, isFinger: isFinger, normalizeSong: normalizeSong, fitSong: fitSong, buildSteps: buildSteps,
    barCount: barCount, barOf: barOf, playHand: playHand, clampLoop: clampLoop, nextHand: nextHand, LOOP_CLEAN: LOOP_CLEAN,
    advanceClock: advanceClock, hint: hint, createSession: createSession,
    listenPlan: listenPlan, sounding: sounding, midiMessages: midiMessages, echoFilter: echoFilter, LISTEN_GAP_MS: LISTEN_GAP_MS, LISTEN_LEAD_MS: LISTEN_LEAD_MS,
  };
});
