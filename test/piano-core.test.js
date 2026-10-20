// Piano mode: calibration math, song loading and wait-mode logic. Run: node test/piano-core.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../public/piano-core.js");
const piano = require("../piano.js");

const near = (a, b, msg) => assert(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// Notes and names.
assert.strictEqual(P.parseNote("C4"), 60);
assert.strictEqual(P.parseNote("F#3"), 54);
assert.strictEqual(P.parseNote("Bb2"), 46);
assert(Number.isNaN(P.parseNote("H2")));
assert.strictEqual(P.noteName(36), "C2");
assert.strictEqual(P.noteName(96), "C7");
assert.strictEqual(P.whiteCount(36, 96), 36);

// Layout: 61 keys C2-C7 spread linearly between the two calibrated edges.
const cal = { low: 36, high: 96, left: 400, right: 1480 };
const L = P.keyLayout(cal);
near(L.whiteWidth, 1080 / 36, "white width");
near(L.keys[36].x0, 400, "lowest key left edge");
near(L.keys[96].x1, 1480, "highest key right edge");
near(L.keys[60].x0, 400 + 14 * 30, "C4 sits 14 white keys in");
// Every white key has the same width and they tile the strip with no gaps.
let x = 400;
for (let n = 36; n <= 96; n++) if (!P.isBlack(n)) { near(L.keys[n].x0, x, `white ${n}`); x = L.keys[n].x1; }
near(x, 1480, "whites tile the strip");
// Black keys sit at real piano offsets, not centred: C# leans left, D# right, G# in the middle.
const c4 = L.keys[60].x0, w = L.whiteWidth;
near(L.keys[61].x0, c4 + 0.6 * w, "C#4");
near(L.keys[63].x1, c4 + 2.4 * w, "D#4");
near((L.keys[68].x0 + L.keys[68].x1) / 2, c4 + 5 * w, "G#4 centred on the G/A line");
// Black keys win where they overlap white keys.
assert.strictEqual(P.keyAt(L, c4 + 0.9 * w, true), 61);
assert.strictEqual(P.keyAt(L, c4 + 0.9 * w, false), 60);
assert.strictEqual(P.keyAt(L, 10, false), -1);

// Ruler starting point: 846 mm of keys on a 1439 mm, 1920 px panel is ~1129 px, centred.
const r = P.rulerEdges({ screenPx: 1920 });
assert(Math.abs(r.right - r.left - 1129) <= 1, `ruler width ${r.right - r.left}`);
assert(Math.abs((r.left + r.right) / 2 - 960) <= 1, "ruler centred");
// Wider strip from the seat: 69 cm to the strip and 60 cm to the keys is 1.15x.
near(P.seatScale(690, 600), 1.15, "seat scale");
// A calibration made at 1920 px scales to a 3840 px canvas.
const s2 = P.scaleCalibration({ ...cal, screenPx: 1920 }, 3840);
near(s2.left, 800, "scaled left"); near(s2.right, 2960, "scaled right");

// Calibration validation.
assert(P.validCalibration({ ...cal, screenPx: 1920 }));
assert.strictEqual(P.validCalibration({ ...cal, screenPx: 1920, high: 40 }), null, "range under an octave");
assert.strictEqual(P.validCalibration({ ...cal, screenPx: 1920, left: "x" }), null, "non-numeric edge");
assert.strictEqual(P.validCalibration({ ...cal, screenPx: 1920, right: 420 }), null, "strip too narrow");
assert.strictEqual(P.validCalibration(null), null);

// Song fitting moves out-of-range notes by octaves and flags them.
const fitted = P.fitSong({ notes: [{ note: 30, start: 0, length: 1 }, { note: 60, start: 1, length: 1 }, { note: 100, start: 2, length: 1 }] }, 36, 96);
assert.deepStrictEqual(fitted.notes.map((n) => n.note), [42, 60, 88]);
assert.strictEqual(fitted.shifted, 2);

// Song file loader: the shipped song loads, fits 61 keys and is in C major around middle C.
const songs = piano.loadSongs(path.join(__dirname, "..", "songs"));
assert.deepStrictEqual(songs.map((x) => x.id), ["ode-to-joy", "twinkle-twinkle-little-star"]);
const ode = songs[0];
assert(!ode.error, ode.error);
assert(ode.fits61);
assert.strictEqual(ode.notes.length, 83);
assert.strictEqual(ode.notes.filter((n) => n.hand === "right").length, 62, "62-note melody");
assert.strictEqual(ode.notes.filter((n) => n.hand === "left").length, 21, "root-note left hand");
assert.deepStrictEqual(ode.hands, ["right", "left"]);
assert.strictEqual(ode.beats, 64, "16 bars of 4/4");
assert.strictEqual(P.noteName(ode.lowest), "G2");
assert.strictEqual(P.noteName(ode.highest), "G4");
// Twinkle Twinkle: 12 bars of 4/4, six 7-note phrases, right hand C4-A4, left hand F2-C3.
const twinkle = songs[1];
assert(!twinkle.error, twinkle.error);
assert(twinkle.fits61);
assert.strictEqual(twinkle.notes.length, 64);
assert.strictEqual(twinkle.notes.filter((n) => n.hand === "right").length, 42);
assert.strictEqual(twinkle.beats, 48);
assert.strictEqual(twinkle.hand, "right");
assert.strictEqual(P.noteName(twinkle.lowest), "F2");
assert.strictEqual(P.noteName(twinkle.highest), "A4");
assert.deepStrictEqual(twinkle.notes.filter((n) => n.hand === "right").slice(0, 7).map((n) => P.noteName(n.note)), ["C4", "C4", "G4", "G4", "A4", "A4", "G4"]);
// Every left-hand note lands on the downbeat or the middle of a bar, together with a melody note.
for (const s of [ode, twinkle]) {
  for (const n of s.notes.filter((x) => x.hand === "left")) {
    assert(n.start % 2 === 0, `${s.id} left hand on beat ${n.start}`);
    assert(s.notes.some((m) => m.hand === "right" && m.start === n.start), `${s.id} left hand at ${n.start} has a melody note`);
  }
}
// Picking a song with the remote: next / previous wrap, broken songs are skipped.
const list = [{ id: "a" }, { id: "broken", error: "x" }, { id: "b" }, { id: "c" }];
assert.strictEqual(P.stepSong(list, "a", 1), "b");
assert.strictEqual(P.stepSong(list, "c", 1), "a", "wraps forward");
assert.strictEqual(P.stepSong(list, "a", -1), "c", "wraps back");
assert.strictEqual(P.stepSong(list, "unknown", 1), "a", "unknown current starts at the first song");
assert.strictEqual(P.stepSong([{ id: "only" }], "only", 1), "only");
assert.strictEqual(P.stepSong([{ id: "x", error: "e" }], "x", 1), "");
// Bad song files are reported, not dropped.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piano-test-"));
fs.writeFileSync(path.join(tmp, "broken.json"), "{");
fs.writeFileSync(path.join(tmp, "bad-note.json"), JSON.stringify({ title: "x", notes: [["Q9", 0, 1]] }));
fs.writeFileSync(path.join(tmp, "bad-hand.json"), JSON.stringify({ title: "x", notes: [["C4", 0, 1, "middle"]] }));
fs.writeFileSync(path.join(tmp, "bad-song-hand.json"), JSON.stringify({ title: "x", hand: "both", notes: [["C4", 0, 1]] }));
const bad = piano.loadSongs(tmp);
assert(bad.every((s) => s.error), "bad songs carry errors");

// Calibration storage round trip; invalid input is refused and the file left alone.
const calFile = path.join(tmp, "piano-calibration.json");
assert.strictEqual(piano.readCalibration(calFile), null);
const savedCal = piano.writeCalibration(calFile, { ...cal, screenPx: 1920, mode: "seat" });
assert(savedCal.savedAt > 0);
assert.deepStrictEqual(piano.readCalibration(calFile), savedCal);
assert.throws(() => piano.writeCalibration(calFile, { low: 1 }));
assert.deepStrictEqual(piano.readCalibration(calFile), savedCal);
fs.rmSync(tmp, { recursive: true });

// Steps: notes starting together form one chord step.
const steps = P.buildSteps([{ note: 60, start: 0 }, { note: 64, start: 0 }, { note: 67, start: 1 }]);
assert.deepStrictEqual(steps, [{ start: 0, notes: [60, 64], hands: { 60: "right", 64: "right" } }, { start: 1, notes: [67], hands: { 67: "right" } }]);

// Clock runs at tempo and stops at the step still waiting.
near(P.advanceClock(0, 750, 80, 10), 1, "80 bpm, 750 ms is one beat");
near(P.advanceClock(3.5, 1000, 120, 4), 4, "clock holds at the waiting step");
near(P.advanceClock(0, 1000, 60, null), 1, "no waiting step");

// Hints in plain words.
assert.strictEqual(P.hint(71, 72), "B4 → try C5, one white key to the right");
assert.strictEqual(P.hint(64, 60), "E4 → try C4, two white keys to the left");
assert.strictEqual(P.hint(60, 72), "C4 → try C5, one octave up");
assert.strictEqual(P.hint(62, 61), "D4 → try C#4, the black key just left");
assert.strictEqual(P.hint(61, 64), "C#4 → try E4, two white keys to the right");
assert.strictEqual(P.hint(63, 60), "D#4 → try C4, two white keys to the left");

// Wait mode: Ode to Joy's opening E E F G (right hand) needs the repeated E struck twice.
const sess = P.createSession(P.normalizeSong(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "songs", "ode-to-joy.json"), "utf8"))).song, { hand: "right" });
assert.deepStrictEqual(sess.waitingFor(), [64]);
assert.strictEqual(sess.press(64).result, "advance");
assert.deepStrictEqual(sess.waitingFor(), [64], "second E still wanted");
const wrong = sess.press(65);
assert.strictEqual(wrong.result, "wrong");
assert.strictEqual(wrong.hint, "F4 → try E4, one white key to the left");
assert.strictEqual(sess.index, 1, "a wrong key does not advance");
assert.strictEqual(sess.streak, 0);
assert.strictEqual(sess.press(64).result, "advance");
assert.strictEqual(sess.correct, 2); assert.strictEqual(sess.wrong, 1);
near(sess.accuracy(), 2 / 3, "accuracy");
// Playing every remaining step finishes the song.
let last;
while (!sess.done) last = sess.press(sess.waitingFor()[0]).result;
assert.strictEqual(last, "done");
assert.strictEqual(sess.press(60).result, "ignored");
sess.restart();
assert.strictEqual(sess.index, 0); assert.strictEqual(sess.correct, 0);

// Chords: both keys must be struck; a repeat of the first does not count twice.
const chord = P.createSession({ notes: [{ note: 60, start: 0, length: 1 }, { note: 64, start: 0, length: 1 }, { note: 67, start: 1, length: 1 }] });
assert.strictEqual(chord.press(60).result, "correct");
assert.strictEqual(chord.press(60).result, "ignored");
assert.deepStrictEqual(chord.waitingFor(), [64]);
const cw = chord.press(66);
assert.strictEqual(cw.target, 64, "hint points at the nearest missing chord note");
assert.strictEqual(chord.press(64).result, "advance");
assert.strictEqual(chord.press(67).result, "done");

// Hands in the song format: a note's own hand ("L" / "R", object form too) beats the song's hand,
// and songs without any hand fields stay right hand.
const mixed = P.normalizeSong({ title: "m", notes: [["C4", 0, 1], ["C3", 0, 2, "L"], { note: "E4", start: 1, length: 1, hand: "right" }, ["G2", 2, 1, "left"]] }).song;
assert.deepStrictEqual(mixed.notes.map((n) => n.hand), ["left", "right", "right", "left"]);
assert.deepStrictEqual(mixed.hands, ["right", "left"]);
const leftSong = P.normalizeSong({ title: "l", hand: "left", notes: [["C3", 0, 1], ["E4", 1, 1, "R"]] }).song;
assert.deepStrictEqual(leftSong.notes.map((n) => n.hand), ["left", "right"]);
const plain = P.normalizeSong({ title: "p", notes: [["C4", 0, 1]] }).song;
assert.strictEqual(plain.hand, "right"); assert.deepStrictEqual(plain.hands, ["right"]);
assert(P.normalizeSong({ title: "x", notes: [["C4", 0, 1, "middle"]] }).error, "unknown note hand");
assert.strictEqual(P.fitSong(mixed, 36, 96).notes[0].hand, "left", "fitting keeps the hand");
// A hand the song does not have plays the whole song.
assert.strictEqual(P.playHand(mixed, "left"), "left");
assert.strictEqual(P.playHand(plain, "left"), "both");
assert.strictEqual(P.playHand(plain, "right"), "both");
assert.strictEqual(P.playHand(mixed, "bogus"), "both");
assert.deepStrictEqual(["right", "left", "both"].map(P.nextHand), ["left", "both", "right"]);

// Wait mode with hands on Ode to Joy: both hands start on C3 + E4, one hand only waits for its own notes.
const odeSong = P.fitSong(ode, 36, 96);
const both = P.createSession(odeSong, { hand: "both" });
assert.deepStrictEqual(both.waitingFor(), [48, 64], "bar 1 opens with C3 and E4 together");
assert.deepStrictEqual(both.current().hands, { 48: "left", 64: "right" });
assert.strictEqual(both.press(64).result, "correct", "the melody note alone does not advance");
assert.strictEqual(both.press(48).result, "advance");
assert.strictEqual(both.steps.length, 62, "left-hand notes all start with a melody note");
const right = P.createSession(odeSong, { hand: "right" });
assert.strictEqual(right.hand, "right");
assert.deepStrictEqual(right.waitingFor(), [64], "right hand does not wait for the left");
// The left hand's C3 is still sounding: playing it along is not a mistake.
assert.deepStrictEqual(right.press(48), { result: "ignored", other: true });
assert.strictEqual(right.wrong, 0);
assert.strictEqual(right.press(50).result, "wrong", "a key neither hand plays is wrong");
assert.strictEqual(right.press(64).result, "advance");
const left = P.createSession(odeSong, { hand: "left" });
assert.deepStrictEqual(left.waitingFor(), [48]);
assert.strictEqual(left.steps.length, 21);
assert.strictEqual(left.press(64).result, "ignored", "the melody may be played along in left-hand mode");
assert.strictEqual(left.press(48).result, "advance");
assert.deepStrictEqual(left.waitingFor(), [43], "then G2 in bar 2");
// Asking for the left hand on a right-hand-only song plays the melody.
const onlyRight = P.createSession({ ...plain, notes: plain.notes }, { hand: "left" });
assert.strictEqual(onlyRight.hand, "both");
assert.deepStrictEqual(onlyRight.waitingFor(), [60]);

// Bars and loops.
assert.strictEqual(P.barCount(odeSong), 16);
assert.strictEqual(P.barOf(odeSong, 0), 1);
assert.strictEqual(P.barOf(odeSong, 3.9), 1);
assert.strictEqual(P.barOf(odeSong, 4), 2);
assert.strictEqual(P.barOf(odeSong, -2), 1, "lead-in counts as bar 1");
assert.deepStrictEqual(P.clampLoop(odeSong, { from: 3, to: 4 }), { from: 3, to: 4 });
assert.deepStrictEqual(P.clampLoop(odeSong, { from: 15, to: 40 }), { from: 15, to: 16 });
assert.deepStrictEqual(P.clampLoop(odeSong, { from: 5, to: 2 }), { from: 5, to: 5 }, "an end before the start is the start bar");
assert.deepStrictEqual(P.clampLoop(odeSong, { from: 30 }), { from: 16, to: 16 });
assert.strictEqual(P.clampLoop(odeSong, { from: 0 }), null);
assert.strictEqual(P.clampLoop(odeSong, null), null);

// Practice loop: bar 4 of Ode to Joy (E. D D) in right-hand mode, three clean passes in a row.
function playPass(sess, mistakes) {
  let r;
  for (let i = 0; i < sess.steps.length; i++) {
    if (i === 0 && mistakes) for (let m = 0; m < mistakes; m++) assert.strictEqual(sess.press(sess.waitingFor()[0] + 1).result, "wrong");
    for (const n of sess.waitingFor()) r = sess.press(n);
  }
  return r;
}
const loop = P.createSession(odeSong, { hand: "right", loop: { from: 4, to: 4 } });
assert.deepStrictEqual(loop.loop, { from: 4, to: 4 });
assert.deepStrictEqual(loop.steps.map((x) => x.start), [12, 13.5, 14], "only bar 4's steps");
assert.deepStrictEqual(loop.range, { start: 12, end: 16 });
assert.strictEqual(loop.cleanNeeded, 3);
assert.deepStrictEqual(playPass(loop), { result: "pass", clean: true });
assert.strictEqual(loop.cleanPasses, 1);
assert.strictEqual(loop.index, 0, "a pass starts the bar again");
assert.deepStrictEqual(playPass(loop, 1), { result: "pass", clean: false }, "a wrong key spoils the pass");
assert.strictEqual(loop.cleanPasses, 0, "and the run of clean passes starts over");
assert.deepStrictEqual(playPass(loop), { result: "pass", clean: true });
assert.deepStrictEqual(playPass(loop), { result: "pass", clean: true });
assert.strictEqual(loop.cleanPasses, 2);
assert.deepStrictEqual(playPass(loop), { result: "done", clean: true }, "third clean pass in a row finishes");
assert(loop.done);
assert.strictEqual(loop.passes, 5);
assert.strictEqual(loop.wrong, 1);
assert.strictEqual(loop.press(64).result, "ignored");
loop.restart();
assert.strictEqual(loop.cleanPasses, 0); assert.strictEqual(loop.passes, 0); assert(!loop.done);
// Playing along with the other hand during a loop pass keeps it clean.
const loopLeftAlong = P.createSession(odeSong, { hand: "right", loop: { from: 1, to: 1 } });
loopLeftAlong.press(48);
assert.deepStrictEqual(playPass(loopLeftAlong), { result: "pass", clean: true });
// Both hands over a range of bars: bars 3-4 hold 7 steps (every left-hand note joins a melody step).
const loopBoth = P.createSession(odeSong, { hand: "both", loop: { from: 3, to: 4 } });
assert.deepStrictEqual(loopBoth.steps.map((x) => x.start), [8, 9, 10, 11, 12, 13.5, 14]);
assert.deepStrictEqual(loopBoth.steps[6].notes, [43, 62], "beat 14: left G2 with right D4");
assert.strictEqual(playPass(loopBoth).result, "pass");
// Left hand only over bar 1: one whole note per pass.
const loopLeft = P.createSession(odeSong, { hand: "left", loop: { from: 1, to: 1 } });
assert.deepStrictEqual(loopLeft.steps.map((x) => x.notes), [[48]]);
assert.strictEqual(loopLeft.press(48).result, "pass");
assert.strictEqual(loopLeft.press(48).result, "pass");
assert.deepStrictEqual(loopLeft.press(48), { result: "done", clean: true });
// A loop on bars where the chosen hand has no notes has nothing to play.
const emptyLoop = P.createSession(P.normalizeSong({ title: "e", beatsPerBar: 4, notes: [["C4", 0, 1], ["C3", 4, 1, "L"]] }).song, { hand: "left", loop: { from: 1, to: 1 } });
assert(emptyLoop.done);

console.log("ok");
