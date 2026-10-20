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

  // Song file: { title, notes: [[name, startBeat, lengthBeats], ...], bpm, beatsPerBar, ... }.
  // Returns { song } or { error }. Notes are sorted and given MIDI numbers.
  function normalizeSong(raw, id) {
    if (!raw || typeof raw !== "object") return { error: "not an object" };
    if (!raw.title) return { error: "missing title" };
    if (!Array.isArray(raw.notes) || !raw.notes.length) return { error: "no notes" };
    var notes = [];
    for (var i = 0; i < raw.notes.length; i++) {
      var r = raw.notes[i], n = Array.isArray(r) ? r : [r && r.note, r && r.start, r && r.length];
      var midi = typeof n[0] === "number" ? n[0] : parseNote(n[0]);
      var start = Number(n[1]), len = Number(n[2]);
      if (!(midi >= 0 && midi <= 127) || !isFinite(start) || start < 0 || !(len > 0)) return { error: "bad note #" + (i + 1) + ": " + JSON.stringify(r) };
      notes.push({ note: midi, start: start, length: len });
    }
    notes.sort(function (a, b) { return a.start - b.start || a.note - b.note; });
    return {
      song: {
        id: id || raw.id || "",
        title: String(raw.title),
        composer: String(raw.composer || ""),
        source: String(raw.source || ""),
        license: String(raw.license || ""),
        hand: String(raw.hand || "right"),
        bpm: Number(raw.bpm) > 0 ? Number(raw.bpm) : 80,
        beatsPerBar: Number(raw.beatsPerBar) > 0 ? Number(raw.beatsPerBar) : 4,
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
      return { note: n, start: x.start, length: x.length, shifted: n !== x.note };
    });
    var out = {};
    for (var k in song) out[k] = song[k];
    out.notes = notes;
    out.shifted = shifted;
    return out;
  }

  // Group notes that start together into steps: wait mode waits for each step in turn.
  function buildSteps(notes) {
    var steps = [];
    for (var i = 0; i < notes.length; i++) {
      var last = steps[steps.length - 1];
      if (last && Math.abs(last.start - notes[i].start) < 1e-6) {
        if (last.notes.indexOf(notes[i].note) < 0) last.notes.push(notes[i].note);
      } else steps.push({ start: notes[i].start, notes: [notes[i].note] });
    }
    return steps;
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

  // Wait-mode session: the song only advances when every note of the current step has been
  // struck since that step came up. Repeated notes must be struck again.
  function createSession(song) {
    var steps = buildSteps(song.notes);
    var s = {
      steps: steps,
      index: 0,
      hit: {},
      correct: 0,
      wrong: 0,
      streak: 0,
      bestStreak: 0,
      lastWrong: null,
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
    // Returns { result: "correct" | "advance" | "wrong" | "done" | "ignored", hint?, step? }.
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
        if (s.index >= steps.length) { s.done = true; return { result: "done" }; }
        return { result: "advance", step: s.index };
      }
      s.wrong++; s.streak = 0;
      var want = s.waitingFor(), target = want[0];
      for (var i = 1; i < want.length; i++) if (Math.abs(want[i] - note) < Math.abs(target - note)) target = want[i];
      s.lastWrong = { note: note, target: target, hint: hint(note, target) };
      return { result: "wrong", hint: s.lastWrong.hint, target: target };
    };
    s.restart = function () {
      s.index = 0; s.hit = {}; s.correct = 0; s.wrong = 0; s.streak = 0; s.bestStreak = 0; s.lastWrong = null;
      s.done = steps.length === 0;
    };
    return s;
  }

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
    DEFAULT_LOW: DEFAULT_LOW, DEFAULT_HIGH: DEFAULT_HIGH, SCREEN_MM: SCREEN_MM,
    isBlack: isBlack, noteName: noteName, parseNote: parseNote, keyUnits: keyUnits, whiteCount: whiteCount,
    keyLayout: keyLayout, keyAt: keyAt, rulerEdges: rulerEdges, seatScale: seatScale,
    scaleCalibration: scaleCalibration, defaultCalibration: defaultCalibration, validCalibration: validCalibration,
    normalizeSong: normalizeSong, fitSong: fitSong, buildSteps: buildSteps,
    advanceClock: advanceClock, hint: hint, createSession: createSession,
  };
});
