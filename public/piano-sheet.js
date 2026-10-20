// Sheet music view: turns a song (notes with startBeat, lengthBeats, hand, finger) into bars of
// grand-staff notation, right hand on the treble staff and left hand on the bass staff.
// Plain ES5 like piano-core.js so the logic runs in TV browsers and in Node tests; the VexFlow
// drawing lives in piano.html and only reads what buildSheet returns.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PianoSheet = factory();
})(this, function () {
  "use strict";

  var LETTERS = ["c", "d", "e", "f", "g", "a", "b"];
  var NATURAL = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  var MAJOR = [0, 2, 4, 5, 7, 9, 11];
  // Major key names by key signature: negative is flats, positive sharps.
  var KEY_NAMES = { "-6": "Gb", "-5": "Db", "-4": "Ab", "-3": "Eb", "-2": "Bb", "-1": "F", 0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#" };
  // Sixteenth-note grid: played (MIDI) timing is snapped to it so durations come out readable.
  var GRID = 0.25;
  // Note values from longest to shortest, in beats (a beat is a quarter note): [beats, VexFlow duration, dots].
  var VALUES = [[4, "w", 0], [3, "h", 1], [2, "h", 0], [1.5, "q", 1], [1, "q", 0], [0.75, "8", 1], [0.5, "8", 0], [0.25, "16", 0]];
  var EPS = 1e-6;

  function mod(a, n) { return ((a % n) + n) % n; }

  function tonicPc(fifths) { return mod(fifths * 7, 12); }

  // Letter and alteration (-1, 0, 1) of each scale degree of a major key, starting on the tonic.
  function scaleSpelling(fifths) {
    var name = KEY_NAMES[fifths], li = LETTERS.indexOf(name.charAt(0).toLowerCase()), tonic = tonicPc(fifths);
    var out = {};
    for (var i = 0; i < 7; i++) {
      var letter = LETTERS[(li + i) % 7], pc = mod(tonic + MAJOR[i], 12);
      var alter = mod(pc - NATURAL[letter] + 6, 12) - 6;
      out[pc] = { letter: letter, alter: alter };
    }
    return out;
  }

  // Alteration the key signature gives each letter.
  function keyAlters(fifths) {
    var sp = scaleSpelling(fifths), out = {};
    for (var pc in sp) out[sp[pc].letter] = sp[pc].alter;
    return out;
  }

  // "G", "Bb", "F#", "Am", "C minor" to a key signature, or NaN.
  function parseKey(s) {
    var m = /^\s*([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major)?\s*$/.exec(String(s == null ? "" : s));
    if (!m) return NaN;
    var pc = NATURAL[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
    if (m[3] && m[3].charAt(0) === "m" && m[3] !== "maj" && m[3] !== "major") pc += 3;
    pc = mod(pc, 12);
    for (var k = -5; k <= 5; k++) if (tonicPc(k) === pc) return k;
    return m[2] === "b" ? -6 : 6;
  }

  // Key signature for notes that do not say: the major key that leaves the fewest beats of notes
  // outside its scale; ties go to the key whose tonic is the song's last bass note, then to fewer
  // sharps or flats.
  function guessKey(notes) {
    if (!notes.length) return 0;
    var last = notes[0];
    for (var i = 1; i < notes.length; i++) {
      var n = notes[i];
      if (n.start > last.start + EPS || (Math.abs(n.start - last.start) < EPS && n.note < last.note)) last = n;
    }
    var best = 0, bestScore = Infinity;
    for (var k = -6; k <= 6; k++) {
      var tonic = tonicPc(k), out = 0;
      for (var j = 0; j < notes.length; j++) if (MAJOR.indexOf(mod(notes[j].note - tonic, 12)) < 0) out += notes[j].length;
      var score = out * 100 + (mod(last.note, 12) === tonic ? 0 : 10) + Math.abs(k) + (k < 0 ? 0.5 : 0);
      if (score < bestScore - EPS) { bestScore = score; best = k; }
    }
    return best;
  }

  // Spelling of a MIDI note in a key: scale notes by their scale letter, others as sharps in sharp
  // keys (and C) and as flats in flat keys. Returns { letter, alter, octave, key: "c#/4" }.
  function spell(midi, fifths) {
    var pc = mod(midi, 12), s = scaleSpelling(fifths)[pc];
    if (!s) {
      var sharp = fifths >= 0, letter = sharp ? LETTERS[[0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][pc]] : LETTERS[[0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6][pc]];
      s = { letter: letter, alter: mod(pc - NATURAL[letter] + 6, 12) - 6 };
    }
    var octave = Math.round((midi - s.alter - NATURAL[s.letter]) / 12) - 1;
    return { letter: s.letter, alter: s.alter, octave: octave, key: s.letter + (s.alter > 0 ? "#" : s.alter < 0 ? "b" : "") + "/" + octave };
  }

  function snap(x) { return Math.round(x / GRID) * GRID; }

  // Splits a length in beats into note values, longest first. Rests (pos given: beats into the bar)
  // only take values that start on a multiple of themselves and no dots, so they show the beats.
  function splitValues(length, pos) {
    var out = [], left = length, rest = pos != null;
    while (left > EPS) {
      for (var i = 0; i < VALUES.length; i++) {
        var v = VALUES[i];
        if (v[0] > left + EPS) continue;
        if (!rest || (!v[2] && Math.abs(pos / v[0] - Math.round(pos / v[0])) < EPS)) break;
      }
      if (i === VALUES.length) break;
      out.push(VALUES[i]);
      left -= VALUES[i][0];
      if (rest) pos += VALUES[i][0];
    }
    return out;
  }

  // One hand's notes as chords on the grid: notes starting together form a chord, and a chord
  // ends where the next one starts (one voice per staff keeps the notation readable).
  function chords(notes) {
    var list = [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i], s = snap(n.start), e = Math.max(s + GRID, snap(n.start + n.length));
      var c = list.length && Math.abs(list[list.length - 1].start - s) < EPS ? list[list.length - 1] : null;
      if (!c) list.push(c = { start: s, end: e, src: n.start, notes: [] });
      c.end = Math.max(c.end, e);
      var dup = false;
      for (var j = 0; j < c.notes.length; j++) if (c.notes[j].note === n.note) dup = true;
      if (!dup) c.notes.push({ note: n.note, finger: n.finger || 0 });
    }
    for (var k = 0; k < list.length; k++) {
      list[k].notes.sort(function (a, b) { return a.note - b.note; });
      if (k + 1 < list.length) list[k].end = Math.min(list[k].end, list[k + 1].start);
    }
    return list;
  }

  // Time signature text for beatsPerBar quarter-note beats: whole beats over 4, otherwise eighths.
  function timeSignature(beatsPerBar) {
    if (Math.abs(beatsPerBar - Math.round(beatsPerBar)) < EPS) return Math.round(beatsPerBar) + "/4";
    return Math.round(beatsPerBar * 2) + "/8";
  }

  // The notation for a song: { key, fifths, time, beatsPerBar, bars: [{ number, start, end,
  // treble: [event], bass: [event] }] }. An event is a note, chord or rest of one note value:
  // { start, beats, duration, dots, rest, notes: [midi], keys: ["e/4"], accidentals: ["#" | "b" | "n" | ""],
  // fingers: [1-5 or 0], tieFrom, tieTo, onset, src }. A chord longer than one value (or crossing a
  // bar line) becomes tied events; onset is the quantized start of the chord an event belongs to,
  // src the song beat it started on (what wait mode steps by). opts.key / song.key name a key
  // ("G", "Bb", "Em"); without one it is guessed.
  function buildSheet(song, opts) {
    opts = opts || {};
    var bpb = Number(song.beatsPerBar) > 0 ? Number(song.beatsPerBar) : 4;
    var fifths = parseKey(opts.key != null ? opts.key : song.key);
    if (!(fifths >= -6 && fifths <= 6)) fifths = guessKey(song.notes);
    var alters = keyAlters(fifths);
    var staves = { treble: [], bass: [] }, end = 0;
    for (var i = 0; i < song.notes.length; i++) {
      var n = song.notes[i];
      staves[(n.hand || "right") === "left" ? "bass" : "treble"].push(n);
      end = Math.max(end, snap(n.start + n.length), snap(n.start) + GRID);
    }
    var barCount = Math.max(1, Math.ceil(end / bpb - EPS));
    var bars = [];
    for (var b = 0; b < barCount; b++) bars.push({ number: b + 1, start: b * bpb, end: (b + 1) * bpb, treble: [], bass: [] });

    ["treble", "bass"].forEach(function (staff) {
      var list = chords(staves[staff]), at = 0;
      // Rests fill every gap, so each bar of each staff adds up to a full bar.
      var timeline = [];
      for (var c = 0; c < list.length; c++) {
        if (list[c].start > at + EPS) timeline.push({ start: at, end: list[c].start, rest: true });
        timeline.push(list[c]);
        at = list[c].end;
      }
      if (barCount * bpb > at + EPS) timeline.push({ start: at, end: barCount * bpb, rest: true });
      for (var t = 0; t < timeline.length; t++) {
        var item = timeline[t], pos = item.start, first = true, pieces = [];
        while (pos < item.end - EPS) {
          var bar = bars[Math.min(barCount - 1, Math.floor(pos / bpb + EPS))];
          var stop = Math.min(item.end, bar.end);
          // A rest filling a whole bar is one value even when dotted (3/4: a dotted half).
          var whole = item.rest && Math.abs(pos - bar.start) < EPS && Math.abs(stop - bar.end) < EPS;
          var values = splitValues(stop - pos, item.rest && !whole ? pos - bar.start : null);
          for (var v = 0; v < values.length; v++) {
            var ev = { start: pos, beats: values[v][0], duration: values[v][1], dots: values[v][2], rest: !!item.rest, notes: [], keys: [], accidentals: [], fingers: [], tieFrom: !first && !item.rest, tieTo: false, onset: item.start, src: item.rest ? null : item.src };
            if (!item.rest) for (var k = 0; k < item.notes.length; k++) {
              ev.notes.push(item.notes[k].note);
              ev.keys.push(spell(item.notes[k].note, fifths).key);
              ev.fingers.push(first ? item.notes[k].finger : 0);
            }
            bar[staff].push(ev);
            pieces.push(ev);
            pos += values[v][0];
            first = false;
          }
          if (!values.length) break;
        }
        // Every piece but the last ties on to the next one.
        if (!item.rest) for (var pi = 0; pi + 1 < pieces.length; pi++) pieces[pi].tieTo = true;
      }
      // Accidentals: shown when a note differs from the key signature or from an earlier note on
      // the same line in the same bar; a tied-over note keeps the one it started with.
      for (var bi = 0; bi < bars.length; bi++) {
        var state = {}, evs2 = bars[bi][staff];
        for (var x = 0; x < evs2.length; x++) {
          var ev2 = evs2[x];
          for (var y = 0; y < ev2.notes.length; y++) {
            var sp = spell(ev2.notes[y], fifths), line = sp.letter + sp.octave;
            var cur = state[line] != null ? state[line] : alters[sp.letter];
            var acc = "";
            if (sp.alter !== cur && !ev2.tieFrom) acc = sp.alter > 0 ? "#" : sp.alter < 0 ? "b" : "n";
            state[line] = sp.alter;
            ev2.accidentals.push(acc);
          }
        }
      }
    });
    return { key: KEY_NAMES[fifths], fifths: fifths, time: timeSignature(bpb), beatsPerBar: bpb, bars: bars };
  }

  // How many bars fit across width units of notation: 2 to 4, each at least minBar wide.
  function barsPerView(width, minBar) {
    return Math.max(2, Math.min(4, Math.floor(width / (minBar || 230))));
  }

  // First bar of the view showing bar: the view moves on a bar at a time, keeping the bar before
  // the current one in sight when 3 or more bars fit.
  function viewStart(bar, per, total) {
    var start = bar - (per >= 3 ? 1 : 0);
    return Math.max(1, Math.min(start, total - per + 1));
  }

  // x for a beat from rendered anchors [{ beat, x }] sorted by beat: linear in between, clamped
  // at the ends.
  function beatX(anchors, beat) {
    if (!anchors.length) return NaN;
    if (beat <= anchors[0].beat) return anchors[0].x;
    for (var i = 1; i < anchors.length; i++) {
      var a = anchors[i - 1], b = anchors[i];
      if (beat <= b.beat) return b.beat - a.beat < EPS ? b.x : a.x + (b.x - a.x) * (beat - a.beat) / (b.beat - a.beat);
    }
    return anchors[anchors.length - 1].x;
  }

  // Next view mode when cycled: falling notes only, both, sheet music only.
  var VIEWS = ["notes", "both", "sheet"];
  function nextView(view) { return VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]; }

  return {
    GRID: GRID, VIEWS: VIEWS, KEY_NAMES: KEY_NAMES,
    parseKey: parseKey, guessKey: guessKey, keyAlters: keyAlters, spell: spell, splitValues: splitValues,
    timeSignature: timeSignature, buildSheet: buildSheet, barsPerView: barsPerView, viewStart: viewStart, beatX: beatX, nextView: nextView,
  };
});
