// Piano mode: calibration math, song loading, wait-mode and tempo-mode logic and Hear it first. Run: node test/piano-core.test.js
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
// Both songs carry a finger (1-5) on every note: Ode to Joy's right hand stays in C position
// (C4 thumb to G4 little finger) apart from the low G3 thumb, left-hand roots are C3 thumb, G2 / F2 below.
for (const s of [ode, twinkle]) for (const n of s.notes) assert(P.isFinger(n.finger), `${s.id} ${P.noteName(n.note)} at ${n.start} has finger ${n.finger}`);
for (const n of ode.notes.filter((x) => x.hand === "right" && x.note >= 60)) assert.strictEqual(n.finger, [1, 0, 2, 0, 3, 4, 0, 5][n.note - 60], `ode ${P.noteName(n.note)} at ${n.start}`);
assert.deepStrictEqual(ode.notes.filter((n) => n.note === 55).map((n) => n.finger), [1]);
assert.deepStrictEqual([...new Set(ode.notes.filter((n) => n.hand === "left").map((n) => P.noteName(n.note) + ":" + n.finger))].sort(), ["C3:1", "G2:5"]);
assert.deepStrictEqual(twinkle.notes.filter((n) => n.hand === "right").slice(0, 21).map((n) => n.finger), [1, 1, 4, 4, 5, 5, 4, 4, 4, 3, 3, 2, 2, 1, 5, 5, 4, 4, 3, 3, 2]);
assert.deepStrictEqual([...new Set(twinkle.notes.filter((n) => n.hand === "left").map((n) => P.noteName(n.note) + ":" + n.finger))].sort(), ["C3:1", "F2:5", "G2:4"]);

// Finger format: optional fifth field, or a number in the hand's place; old notes stay valid.
const fing = P.normalizeSong({ title: "f", notes: [["C4", 0, 1], ["D4", 1, 1, 2], ["C3", 0, 1, "L", 5], { note: "E4", start: 2, length: 1, finger: 3 }, ["F4", 3, 1, "R"]] }).song;
assert.deepStrictEqual(fing.notes.map((n) => [P.noteName(n.note), n.hand, n.finger]), [["C3", "left", 5], ["C4", "right", 0], ["D4", "right", 2], ["E4", "right", 3], ["F4", "right", 0]]);
const lf = P.normalizeSong({ title: "lf", hand: "left", notes: [["C3", 0, 1, 1]] }).song;
assert.deepStrictEqual([lf.notes[0].hand, lf.notes[0].finger], ["left", 1], "a bare finger takes the song's hand");
for (const bad of [["C4", 0, 1, "R", 6], ["C4", 0, 1, "R", 0], ["C4", 0, 1, 2.5], ["C4", 0, 1, "R", "3"], ["C4", 0, 1, -1]]) {
  assert(P.normalizeSong({ title: "x", notes: [bad] }).error, `finger refused: ${JSON.stringify(bad)}`);
}
assert.strictEqual(P.fitSong(fing, 36, 96).notes[2].finger, 2, "fitting keeps the finger");
assert.strictEqual(P.fitSong({ notes: [{ note: 60, start: 0, length: 1 }] }, 36, 96).notes[0].finger, 0);

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
assert.deepStrictEqual(steps, [{ start: 0, notes: [60, 64], hands: { 60: "right", 64: "right" }, fingers: {} }, { start: 1, notes: [67], hands: { 67: "right" }, fingers: {} }]);
assert.deepStrictEqual(P.buildSteps([{ note: 60, start: 0, finger: 1 }, { note: 48, start: 0, hand: "left", finger: 5 }])[0].fingers, { 60: 1, 48: 5 });

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

// Hear it first: bar 4 of Ode to Joy (E. D D) at 80 bpm, 750 ms a beat, right hand only.
const plan4 = P.listenPlan(odeSong, { hand: "right", from: 4, to: 4 });
assert.deepStrictEqual([plan4.from, plan4.to, plan4.startBeat, plan4.endBeat, plan4.ms, plan4.hand], [4, 4, 12, 16, 3000, "right"]);
near(plan4.beatMs, 750, "beat length");
assert.deepStrictEqual(plan4.events.map((e) => [P.noteName(e.note), e.at, e.dur, e.finger]), [["E4", 0, 1065, 3], ["D4", 1125, 338, 2], ["D4", 1500, 1440, 2]]);
// The repeated D is released before it is struck again; long notes lose at most 60 ms.
assert(plan4.events[1].at + plan4.events[1].dur < plan4.events[2].at);
// Both hands add the left-hand C3 and G2 of bar 4; left hand alone plays only them.
const plan4both = P.listenPlan(odeSong, { hand: "both", from: 4, to: 4 });
assert.deepStrictEqual(plan4both.events.map((e) => [P.noteName(e.note), e.at, e.hand]), [["C3", 0, "left"], ["E4", 0, "right"], ["D4", 1125, "right"], ["G2", 1500, "left"], ["D4", 1500, "right"]]);
assert.deepStrictEqual(P.listenPlan(odeSong, { hand: "left", from: 4, to: 4 }).events.map((e) => [P.noteName(e.note), e.at, e.dur]), [["C3", 0, 1440], ["G2", 1500, 1440]]);
// A loop range plays all its bars back to back; out-of-range bars are clamped to the song.
const plan34 = P.listenPlan(odeSong, { hand: "right", from: 3, to: 4 });
assert.deepStrictEqual(plan34.events.map((e) => e.at), [0, 750, 1500, 2250, 3000, 4125, 4500]);
assert.strictEqual(plan34.ms, 6000);
assert.deepStrictEqual([P.listenPlan(odeSong, { hand: "right", from: 16, to: 99 }).from, P.listenPlan(odeSong, { hand: "right", from: 16, to: 99 }).to], [16, 16]);
// A song with one hand plays it whatever hand is asked for; tempo follows the song.
const fast = P.listenPlan({ ...P.normalizeSong({ title: "t", bpm: 120, beatsPerBar: 3, notes: [["C4", 0, 1], ["E4", 1, 2], ["G4", 3, 1]] }).song }, { hand: "left", from: 1, to: 1 });
assert.deepStrictEqual(fast.events.map((e) => [e.note, e.at, e.dur]), [[60, 0, 450], [64, 500, 940]]);
assert.strictEqual(fast.ms, 1500);
// A note that runs past the end of the range is cut at the bar line.
const tie = P.listenPlan(P.normalizeSong({ title: "t", notes: [["C4", 2, 4], ["D4", 4, 1]] }).song, { hand: "both", from: 1, to: 1 });
assert.deepStrictEqual(tie.events.map((e) => [e.note, e.at, e.dur]), [[60, 1500, 1440]]);
// What sounds when: the TV lights these keys as the keyboard plays them.
assert.deepStrictEqual(Object.keys(P.sounding(plan4both, 0)).map(Number), [48, 64]);
assert.deepStrictEqual(Object.keys(P.sounding(plan4both, 1200)).map(Number), [48, 62]);
assert.deepStrictEqual(Object.keys(P.sounding(plan4both, 1470)).map(Number), [], "gap before the repeated D");
assert.deepStrictEqual(Object.keys(P.sounding(plan4both, 2950)).map(Number), [], "everything released before the bar ends");

// Tempo mode: speeds are 50-100% in steps of 5.
assert.deepStrictEqual([P.clampSpeed(75), P.clampSpeed(30), P.clampSpeed(120), P.clampSpeed(73), P.clampSpeed("x")], [75, 50, 100, 75, 100]);
// Count-in: the bar before the start counts 1-4, then nothing.
assert.deepStrictEqual([-4, -3.5, -3, -0.01, 0, -4.5].map((c) => P.countIn(c, 0, 4)), [1, 1, 2, 4, 0, 0]);
// One bar at 60 bpm (1000 ms a beat at 100%): right hand C D E F, left hand C3 held for the bar.
const tSong = P.normalizeSong({ title: "t", bpm: 60, beatsPerBar: 4, notes: [["C4", 0, 1], ["D4", 1, 1], ["E4", 2, 1], ["F4", 3, 1], ["C3", 0, 4, "L"]] }).song;
const t1 = P.createTempoSession(tSong, { hand: "right", speed: 100 });
assert.deepStrictEqual([t1.hand, t1.speed, t1.beatMs, t1.range.start, t1.range.countIn], ["right", 100, 1000, 0, 4]);
near(t1.window, 0.3, "300 ms window in beats");
assert.deepStrictEqual(t1.waitingFor(), [60]);
// Keys during the count-in are not judged; the song does not wait.
assert.deepStrictEqual(t1.press(60, -2), { result: "ignored" });
assert.deepStrictEqual(t1.tick(-1).misses, []);
// On time within 110 ms, early or late within 300 ms.
assert.deepStrictEqual(t1.press(60, 0.05), { result: "hit", timing: "on time", ms: 50 });
assert.deepStrictEqual(t1.press(62, 0.8), { result: "hit", timing: "early", ms: -200 });
assert.deepStrictEqual(t1.waitingFor(), [64]);
// Striking a hit note again while it sounds, or the left hand's C3, is ignored.
assert.strictEqual(t1.press(62, 1.2).result, "ignored");
assert.deepStrictEqual(t1.press(48, 1.5), { result: "ignored", other: true });
// The song moves on: E4 is missed once its window closes, a key far off its time is wrong.
assert.deepStrictEqual(t1.tick(2.29).misses, []);
assert.deepStrictEqual(t1.tick(2.31).misses, [64]);
assert.strictEqual(t1.press(65, 2.5).result, "wrong", "F4 500 ms early is outside the window");
assert.strictEqual(t1.streak, 0);
assert.deepStrictEqual(t1.press(65, 3.25), { result: "hit", timing: "late", ms: 250 });
assert.deepStrictEqual([t1.correct, t1.wrong, t1.missed, t1.onTime, t1.early, t1.late], [3, 1, 1, 1, 1, 1]);
assert.deepStrictEqual(t1.judged, { 1: "on time", 2: "early", 3: "miss", 4: "late" }, "judged by index in song.notes (C3 sorts first)");
near(t1.accuracy(), 3 / 5, "hits over hits, wrong keys and misses");
// The song finishes when the last bar has played.
assert.strictEqual(t1.tick(3.9).result, undefined);
assert.strictEqual(t1.tick(4.01).result, "done");
assert(t1.done);
assert.strictEqual(t1.press(60, 4.1).result, "ignored");
t1.restart();
assert.deepStrictEqual([t1.done, t1.correct, t1.missed, Object.keys(t1.judged).length], [false, 0, 0, 0]);
// Half speed: 2000 ms a beat, so the same 300 ms window is 0.15 beats.
const tHalf = P.createTempoSession(tSong, { hand: "right", speed: 50 });
near(tHalf.window, 0.15, "window at 50%");
assert.deepStrictEqual(tHalf.press(60, -0.05), { result: "hit", timing: "on time", ms: -100 });
assert.strictEqual(tHalf.press(62, 0.8).result, "wrong");
// Both hands: the left-hand C3 is wanted with C4, and the chord is the next step until both are hit.
const tBoth = P.createTempoSession(tSong, { hand: "both" });
assert.deepStrictEqual(tBoth.waitingFor(), [48, 60]);
assert.deepStrictEqual(tBoth.current().hands, { 48: "left", 60: "right" });
tBoth.press(48, 0);
assert.deepStrictEqual(tBoth.waitingFor(), [60]);
// A repeated note matches the nearest one still to be played.
const rep = P.createTempoSession(P.normalizeSong({ title: "r", bpm: 60, notes: [["C4", 0, 0.5], ["C4", 0.5, 0.5]] }).song, {});
assert.strictEqual(rep.press(60, 0.2).timing, "late", "200 ms after the first C4, 300 ms before the second");
assert.deepStrictEqual(rep.judged, { 0: "late" });
assert.strictEqual(rep.press(60, 0.35).timing, "early");
assert.deepStrictEqual(rep.judged, { 0: "late", 1: "early" });
assert.strictEqual(rep.press(60, 0.6).result, "ignored", "struck again while the second C4 sounds");
// Practice loop at tempo: bar 1 of the test song, a pass is clean with no miss and no wrong key.
const tLoop = P.createTempoSession(tSong, { hand: "right", loop: { from: 1, to: 1 } });
assert.deepStrictEqual([tLoop.range.start, tLoop.range.end], [0, 4]);
function playBar(s, skip) { [60, 62, 64, 65].forEach((n, i) => { if (i !== skip) s.press(n, i); s.tick(i + 0.5); }); return s.tick(4.01); }
assert.deepStrictEqual(playBar(tLoop), { misses: [], result: "pass", clean: true });
assert.deepStrictEqual(tLoop.judged, {}, "a new pass starts with nothing judged");
assert.deepStrictEqual(playBar(tLoop, 2), { misses: [], result: "pass", clean: false }, "a missed E4 spoils the pass");
assert.strictEqual(tLoop.cleanPasses, 0);
playBar(tLoop); playBar(tLoop);
assert.deepStrictEqual(playBar(tLoop), { misses: [], result: "done", clean: true });
assert.deepStrictEqual([tLoop.passes, tLoop.cleanPasses, tLoop.missed], [5, 3, 1]);
// A wrong key spoils a pass too.
const tLoop2 = P.createTempoSession(tSong, { hand: "right", loop: { from: 1, to: 1 } });
tLoop2.press(70, 1.5);
assert.strictEqual(playBar(tLoop2).clean, false);
// Loops on later bars start on their bar line; Ode to Joy bar 4 in tempo mode at 75%.
const tOde = P.createTempoSession(odeSong, { hand: "right", loop: { from: 4, to: 4 }, speed: 75 });
assert.deepStrictEqual([tOde.range.start, tOde.range.end, tOde.waitingFor()], [12, 16, [64]]);
near(tOde.beatMs, 1000, "80 bpm at 75%");
// Seeking back (after Hear it first) reopens the notes from there on.
const tSeek = P.createTempoSession(tSong, { hand: "right" });
tSeek.press(60, 0); tSeek.press(62, 1); tSeek.tick(3);
assert.deepStrictEqual(tSeek.judged, { 1: "on time", 2: "on time", 3: "miss" });
tSeek.seek(1);
assert.deepStrictEqual(tSeek.judged, { 1: "on time" });
assert.deepStrictEqual(tSeek.waitingFor(), [62]);
// A finished tempo-mode play goes to the score history as mode "tempo" with its speed as a share.
const tRec = P.createTempoSession(tSong, { hand: "right", speed: 75 });
tRec.press(61, 0); tRec.press(61, 0.05); tRec.tick(9);
assert(tRec.done);
assert.deepStrictEqual(tRec.wrongKeys, { 61: 2 });
const rec = P.validPlay(P.playRecord({ id: "t", title: "t" }, tRec, { mode: "tempo", speed: tRec.speed / 100 }));
assert.deepStrictEqual([rec.mode, rec.speed, rec.correct, rec.wrong, rec.accuracy, rec.wrongKeys], ["tempo", 0.75, 0, 2, 0, { "C#4": 2 }]);
tRec.restart();
assert.deepStrictEqual(tRec.wrongKeys, {});
// Mic mode in tempo mode: only a chord's top note is judged, the right name an octave away counts,
// and the chord's lower notes are ignored instead of counted wrong.
const chordSong = P.normalizeSong({ title: "c", bpm: 60, notes: [["C4", 0, 1], ["E4", 0, 1], ["G4", 0, 1], ["D4", 1, 1]] }).song;
const tMic = P.createTempoSession(chordSong, { tolerant: true });
assert.deepStrictEqual(tMic.waitingFor(), [67]);
assert.deepStrictEqual(tMic.needed(), [67]);
assert.strictEqual(tMic.press(60, 0).result, "ignored", "a lower chord note");
assert.strictEqual(tMic.press(55, 0.05).timing, "on time", "G3 for G4");
assert.strictEqual(tMic.press(74, 1.1).timing, "on time", "D5 for D4");
tMic.tick(3);
assert.deepStrictEqual([tMic.done, tMic.missed, tMic.wrong], [true, 0, 0]);
// The same keys without mic mode: G3 is wrong and the C4 and E4 of the chord are missed.
const tKeys = P.createTempoSession(chordSong, {});
assert.strictEqual(tKeys.press(55, 0.05).result, "wrong");
tKeys.press(74, 1.1); tKeys.tick(3);
assert.deepStrictEqual([tKeys.missed, tKeys.wrong], [4, 2]);
// Hear it first at the practice speed: bar 4 of Ode to Joy at 50% takes twice as long.
const plan4half = P.listenPlan(odeSong, { hand: "right", from: 4, to: 4, speed: 50 });
assert.deepStrictEqual([plan4half.ms, plan4half.beatMs], [6000, 1500]);
assert.deepStrictEqual(plan4half.events.map((e) => e.at), [0, 2250, 3000]);

// MIDI messages: channel 1 note on / note off at t0 + at, offs before ons at the same time.
const msgs = P.midiMessages([{ note: 62, at: 0, dur: 100 }, { note: 62, at: 100, dur: 50 }, { note: 300, at: 0, dur: 10 }], 1000, 70);
assert.deepStrictEqual(msgs, [
  { time: 1000, data: [0x90, 62, 70] },
  { time: 1100, data: [0x80, 62, 0] },
  { time: 1100, data: [0x90, 62, 70] },
  { time: 1150, data: [0x80, 62, 0] },
]);
assert.strictEqual(P.midiMessages(plan4.events, 0).length, 6);
assert.deepStrictEqual(P.midiMessages(plan4.events, 0)[0].data, [0x90, 64, 80], "default velocity 80");

// Echo filter: the keyboard sending back what it was told to play is dropped once; the player's own keys are not.
const echo = P.echoFilter(150);
for (const m of P.midiMessages(plan4.events, 1000)) echo.expect(m.data[0] === 0x90, m.data[1], m.time);
assert(echo.match(true, 64, 1004), "echoed E4 on");
assert(!echo.match(true, 64, 1010), "only once");
assert(!echo.match(true, 65, 1004), "another key is the player's");
assert(!echo.match(true, 62, 1700), "D4 played early by the player is not the echo");
assert(echo.match(false, 64, 2010), "echoed note off");
assert(echo.match(true, 62, 2130));
echo.clear(); assert.strictEqual(echo.size(), 0);

// Mic mode (tolerant): only a chord's top note is waited for, the right note name within an octave
// counts, any of a chord's names completes it, the other hand and the last note ringing on are not
// mistakes.
const mic = P.createSession(odeSong, { hand: "both", tolerant: true });
assert.deepStrictEqual(mic.waitingFor(), [64], "C3 + E4 waits for the top note only");
assert.strictEqual(mic.press(76).result, "advance", "E5 is E4 an octave up");
assert.strictEqual(mic.press(52).result, "advance", "E3 is E4 an octave down (the repeated E)");
assert.strictEqual(mic.press(64).result, "ignored", "the E still ringing while F is due is not a mistake");
assert.strictEqual(mic.press(40).result, "wrong", "two octaves off is wrong");
assert.strictEqual(mic.press(66).result, "wrong", "a wrong note is still wrong");
assert.strictEqual(mic.wrong, 2);
assert.strictEqual(mic.lastWrong.target, 65, "the hint points at the wanted note");
assert.strictEqual(mic.press(65).result, "advance");
// Switching tolerance off mid-song: the full step is wanted again.
const micChord = P.createSession({ notes: [{ note: 60, start: 0, length: 1 }, { note: 64, start: 0, length: 1 }, { note: 67, start: 0, length: 1 }, { note: 72, start: 1, length: 1 }] }, { tolerant: true });
assert.deepStrictEqual(micChord.waitingFor(), [67]);
assert.deepStrictEqual(micChord.needed(), [67], "only the top key lights");
micChord.setTolerant(false);
assert.deepStrictEqual(micChord.waitingFor(), [60, 64, 67], "strict again: every chord note");
micChord.setTolerant(true);
assert.strictEqual(micChord.press(36).result, "advance", "the chord heard as its root two octaves down");
assert.strictEqual(micChord.press(60).result, "done", "C4 counts for C5");
const micTriad = P.createSession({ notes: [{ note: 60, start: 0, length: 1 }, { note: 64, start: 0, length: 1 }, { note: 67, start: 0, length: 1 }] }, { tolerant: true });
assert.strictEqual(micTriad.press(62).result, "wrong", "a name not in the chord is wrong");
assert.strictEqual(micTriad.press(76).result, "done", "E5 for the chord's E");
// One hand in mic mode: the other hand's due note is ignored, also an octave off.
const micRight = P.createSession(odeSong, { hand: "right", tolerant: true });
assert.strictEqual(micRight.press(36).result, "ignored", "C2 for the left hand's C3");
assert.strictEqual(micRight.press(64).result, "advance");
// Strict sessions are unchanged: an octave off is wrong.
const strict = P.createSession(odeSong, { hand: "right" });
assert.strictEqual(strict.press(76).result, "wrong");

console.log("ok");
