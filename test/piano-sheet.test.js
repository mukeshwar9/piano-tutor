// Sheet music view: key signatures, spelling, quantizing, bars, ties, rests and accidentals. Run: node test/piano-sheet.test.js
const assert = require("assert");
const path = require("path");
const P = require("../public/piano-core.js");
const S = require("../public/piano-sheet.js");
const piano = require("../piano.js");

const song = (notes, extra) => P.normalizeSong(Object.assign({ title: "t", notes }, extra)).song;
const sum = (evs) => evs.reduce((a, e) => a + e.beats, 0);
const durs = (evs) => evs.map((e) => e.duration + ".".repeat(e.dots) + (e.rest ? "r" : ""));

// Key names.
assert.strictEqual(S.parseKey("C"), 0);
assert.strictEqual(S.parseKey("G"), 1);
assert.strictEqual(S.parseKey("Bb"), -2);
assert.strictEqual(S.parseKey("F#"), 6);
assert.strictEqual(S.parseKey("Gb"), -6);
assert.strictEqual(S.parseKey("Am"), 0, "A minor shares C major's signature");
assert.strictEqual(S.parseKey("E minor"), 1);
assert(Number.isNaN(S.parseKey("H")));
assert(Number.isNaN(S.parseKey("")));

// Key guessing: the major scale that fits the notes, then the tonic of the last bass note.
const n = (names) => names.map((x, i) => ({ note: P.parseNote(x), start: i, length: 1 }));
assert.strictEqual(S.guessKey(n(["C4", "D4", "E4", "F4", "G4"])), 0);
assert.strictEqual(S.guessKey(n(["G4", "A4", "B4", "C5", "D5", "F#5", "G5"])), 1, "F# means G major");
assert.strictEqual(S.guessKey(n(["F4", "G4", "A4", "Bb4", "C5", "F4"])), -1, "Bb means F major");
assert.strictEqual(S.guessKey(n(["Eb4", "Bb3", "Eb4"])), -3, "a tie between keys goes to the last bass note");
assert.strictEqual(S.guessKey([]), 0);

// Spelling: scale notes by their letter, others as sharps in sharp keys and flats in flat keys.
assert.strictEqual(S.spell(60, 0).key, "c/4");
assert.strictEqual(S.spell(61, 0).key, "c#/4");
assert.strictEqual(S.spell(70, -1).key, "bb/4");
assert.strictEqual(S.spell(66, 1).key, "f#/4");
assert.strictEqual(S.spell(63, -2).key, "eb/4");
assert.strictEqual(S.spell(65, 6).key, "e#/4", "F# major spells F as E#");
assert.strictEqual(S.spell(71, -6).key, "cb/5", "Gb major spells B as Cb, an octave up");
assert.strictEqual(S.spell(43, 0).key, "g/2");
assert.deepStrictEqual(S.keyAlters(1), { g: 0, a: 0, b: 0, c: 0, d: 0, e: 0, f: 1 });

// Note values.
assert.deepStrictEqual(S.splitValues(4).map((v) => v[1]), ["w"]);
assert.deepStrictEqual(S.splitValues(3).map((v) => v[1] + v[2]), ["h1"]);
assert.deepStrictEqual(S.splitValues(2.5).map((v) => v[1]), ["h", "8"]);
assert.deepStrictEqual(S.splitValues(1.75).map((v) => v[1] + v[2]), ["q1", "160"]);
assert.strictEqual(S.timeSignature(4), "4/4");
assert.strictEqual(S.timeSignature(3), "3/4");
assert.strictEqual(S.timeSignature(2.5), "5/8");

// Ode to Joy: C major, 4/4, right hand only, so the bass staff is a whole rest every bar.
const songs = piano.loadSongs(path.join(__dirname, "..", "songs"));
const ode = songs.find((s) => s.id === "ode-to-joy");
const os = S.buildSheet(ode);
assert.strictEqual(os.key, "C");
assert.strictEqual(os.time, "4/4");
assert.strictEqual(os.bars.length, P.barCount(ode), "same bars as the practice loop");
assert.deepStrictEqual(durs(os.bars[0].treble), ["q", "q", "q", "q"]);
assert.deepStrictEqual(os.bars[0].treble.map((e) => e.keys[0]), ["e/4", "e/4", "f/4", "g/4"]);
assert.deepStrictEqual(os.bars[0].treble.map((e) => e.fingers[0]), [3, 3, 4, 5]);
assert.deepStrictEqual(durs(os.bars[3].treble), ["q.", "8", "h"], "bar 4: dotted quarter, eighth, half");
assert.strictEqual(os.bars[3].treble[1].src, 13.5);
for (const s of songs) {
  const sh = S.buildSheet(s);
  sh.bars.forEach((b) => {
    assert.strictEqual(sum(b.treble), sh.beatsPerBar, `${s.id} bar ${b.number} treble adds up`);
    assert.strictEqual(sum(b.bass), sh.beatsPerBar, `${s.id} bar ${b.number} bass adds up`);
  });
}

// Twinkle: the left hand's whole-note C3 in bar 1 sits on the bass staff with its finger.
const tw = S.buildSheet(songs.find((s) => s.id === "twinkle-twinkle-little-star"));
assert.deepStrictEqual(durs(tw.bars[0].bass), ["w"]);
assert.deepStrictEqual(tw.bars[0].bass[0].keys, ["c/3"]);
assert.deepStrictEqual(tw.bars[0].bass[0].fingers, [1]);
assert.deepStrictEqual(durs(tw.bars[1].bass), ["h", "h"]);

// Rests fill the gaps; a note over the bar line is split into tied notes and keeps its finger on the first.
const tied = S.buildSheet(song([["C4", 1, 1, 1], ["D4", 3, 2, 2]]));
assert.deepStrictEqual(durs(tied.bars[0].treble), ["qr", "q", "qr", "q"]);
assert.deepStrictEqual(durs(tied.bars[1].treble), ["q", "qr", "hr"]);
const a = tied.bars[0].treble[3], b = tied.bars[1].treble[0];
assert(a.tieTo && !a.tieFrom && b.tieFrom && !b.tieTo, "tie across the bar line");
assert.deepStrictEqual([a.fingers[0], b.fingers[0]], [2, 0]);
assert.strictEqual(b.src, 3, "the tied-over half still belongs to the step on beat 3");
assert.deepStrictEqual(durs(tied.bars[0].bass), ["wr"]);

// A long note inside a bar that no single value covers: half tied to eighth.
const long = S.buildSheet(song([["E4", 0, 2.5], ["F4", 2.5, 1.5]]));
assert.deepStrictEqual(durs(long.bars[0].treble), ["h", "8", "q."]);
assert(long.bars[0].treble[0].tieTo && long.bars[0].treble[1].tieFrom);

// Played (MIDI-like) timing is snapped to sixteenths; overlapping notes in one hand are cut at the next onset.
const loose = S.buildSheet(song([["C4", 0.02, 0.96], ["E4", 0.98, 1.1], ["G4", 2.03, 1.9]]));
assert.deepStrictEqual(durs(loose.bars[0].treble), ["q", "q", "h"]);
assert.strictEqual(loose.bars[0].treble[1].src, 0.98);

// Chords: notes starting together are one event, lowest first, with each note's finger.
const ch = S.buildSheet(song([["G4", 0, 4, 5], ["C4", 0, 4, 1], ["E4", 0, 4, 3]]));
assert.deepStrictEqual(ch.bars[0].treble[0].keys, ["c/4", "e/4", "g/4"]);
assert.deepStrictEqual(ch.bars[0].treble[0].fingers, [1, 3, 5]);

// Accidentals: once per line per bar, a natural to cancel, nothing on a tied-over note, again in the next bar.
const acc = S.buildSheet(song([["F#4", 0, 1], ["F#4", 1, 1], ["F4", 2, 1], ["C#5", 3, 2], ["F#4", 5, 1]]), { key: "C" });
assert.deepStrictEqual(acc.bars[0].treble.map((e) => e.accidentals[0]), ["#", "", "n", "#"]);
assert.deepStrictEqual(acc.bars[1].treble.filter((e) => !e.rest).map((e) => e.accidentals[0]), ["", "#"]);
// In G major F# needs no sign and F natural does.
const inG = S.buildSheet(song([["F#4", 0, 1], ["F4", 1, 1], ["G4", 2, 2]], { key: "G" }));
assert.strictEqual(inG.key, "G");
assert.deepStrictEqual(inG.bars[0].treble.map((e) => e.accidentals[0]), ["", "n", ""]);

// 3/4 bars.
const waltz = S.buildSheet(song([["C4", 0, 3], ["D4", 3, 1], ["E4", 4, 2]], { beatsPerBar: 3 }));
assert.strictEqual(waltz.time, "3/4");
assert.deepStrictEqual(durs(waltz.bars[0].treble), ["h."]);
assert.deepStrictEqual(durs(waltz.bars[1].treble), ["q", "h"]);
assert.deepStrictEqual(durs(waltz.bars[0].bass), ["h.r"]);

// View: 2 to 4 bars, moving a bar at a time with the previous bar kept in sight.
assert.strictEqual(S.barsPerView(400), 2);
assert.strictEqual(S.barsPerView(800), 3);
assert.strictEqual(S.barsPerView(2000), 4);
assert.strictEqual(S.viewStart(1, 4, 16), 1);
assert.strictEqual(S.viewStart(2, 4, 16), 1);
assert.strictEqual(S.viewStart(5, 4, 16), 4);
assert.strictEqual(S.viewStart(16, 4, 16), 13, "the last view ends on the last bar");
assert.strictEqual(S.viewStart(5, 2, 16), 5);
assert.strictEqual(S.viewStart(3, 4, 2), 1, "a short song starts at bar 1");

// Playhead x between anchors.
const anchors = [{ beat: 0, x: 100 }, { beat: 1, x: 140 }, { beat: 4, x: 400 }];
assert.strictEqual(S.beatX(anchors, -1), 100);
assert.strictEqual(S.beatX(anchors, 0.5), 120);
assert.strictEqual(S.beatX(anchors, 2.5), 270);
assert.strictEqual(S.beatX(anchors, 9), 400);
assert(Number.isNaN(S.beatX([], 1)));

assert.strictEqual(S.nextView("notes"), "both");
assert.strictEqual(S.nextView("both"), "sheet");
assert.strictEqual(S.nextView("sheet"), "notes");
assert.strictEqual(S.nextView("x"), "notes");

console.log("ok");
