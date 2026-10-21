// Speed ramp, metronome and count-in: ramp steps and caps, beat lengths, metronome clicks, count-in length and setSpeed. Run: node test/ramp-metronome.test.js
const assert = require("assert");
const P = require("../public/piano-core.js");

const near = (a, b, msg) => assert(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// Speed ramp: a clean loop pass steps the speed up by 5, capped at the target (100 by default).
assert.strictEqual(P.RAMP_STEP, 5);
assert.strictEqual(P.RAMP_TARGET, 100);
assert.strictEqual(P.rampSpeed(75, true), 80);
let ramp = 50;
for (let i = 0; i < 9; i++) ramp = P.rampSpeed(ramp, true);
assert.strictEqual(ramp, 95, "nine clean passes from 50");
ramp = P.rampSpeed(ramp, true);
assert.strictEqual(ramp, 100, "tenth clean pass reaches 100");
for (let i = 0; i < 3; i++) ramp = P.rampSpeed(ramp, true);
assert.strictEqual(ramp, 100, "stays at 100");
// Cap: a step past the target stops at the target.
assert.strictEqual(P.rampSpeed(95, true, 100), 100);
assert.strictEqual(P.rampSpeed(100, true, 100), 100);
assert.strictEqual(P.rampSpeed(85, true, 90), 90);
assert.strictEqual(P.rampSpeed(90, true, 90), 90);
// Speed already above a lower target is held, never lowered.
assert.strictEqual(P.rampSpeed(100, true, 80), 100);
// Custom step and default step/target when omitted.
assert.strictEqual(P.rampSpeed(60, true, undefined, 10), 70, "custom step 10");
assert.strictEqual(P.rampSpeed(75, true, undefined, undefined), 80, "undefined target and step use defaults");
assert.strictEqual(P.rampSpeed(75, true, 100, 0), 80, "non-positive step uses default");
assert.strictEqual(P.rampSpeed(75, true, null), 80, "null target means default 100");

// Hold on a miss: a miss or wrong key keeps the speed where it is.
assert.strictEqual(P.rampSpeed(80, false), 80);
let held = 70;
held = P.rampSpeed(held, true);
assert.strictEqual(held, 75, "clean from 70");
held = P.rampSpeed(held, false);
assert.strictEqual(held, 75, "miss holds at 75");
held = P.rampSpeed(held, true);
assert.strictEqual(held, 80, "clean after miss goes to 80");

// Beat length: 60000 / (bpm * speed / 100) ms.
near(P.beatLengthMs(120, 100), 500, "120 bpm at 100%");
near(P.beatLengthMs(120, 50), 1000, "120 bpm at 50%");
near(P.beatLengthMs(60, 75), 1333.333333, "60 bpm at 75%");
near(P.beatLengthMs(90, 100), 666.666667, "90 bpm at 100%");
for (let s = 50; s <= 100; s += 5) {
  near(P.beatLengthMs(100, s), 60000 / (100 * s / 100), `100 bpm at ${s}%`);
}
// Speed is clamped to 100 first.
near(P.beatLengthMs(120, 200), 500, "speed 200 clamps to 100");

// Metronome: each whole beat in (from, to], accented on a bar line. Beats are negative in the count-in.
const beatsOf = (list) => list.map((b) => b.beat);
const accentsOf = (list) => list.filter((b) => b.accent).map((b) => b.beat);
const negative = P.metronomeBeats(-4.5, 0.2, 4);
assert.deepStrictEqual(beatsOf(negative), [-4, -3, -2, -1, 0]);
assert.deepStrictEqual(accentsOf(negative), [-4, 0]);
const plain = P.metronomeBeats(0, 4, 3);
assert.deepStrictEqual(beatsOf(plain), [1, 2, 3, 4]);
assert.deepStrictEqual(accentsOf(plain), [3]);
// From is exclusive, to is inclusive.
assert.deepStrictEqual(beatsOf(P.metronomeBeats(1, 2, 4)), [2]);
// Empty ranges.
assert.deepStrictEqual(P.metronomeBeats(2, 2, 4), []);
assert.deepStrictEqual(P.metronomeBeats(3, 1, 4), []);
assert.deepStrictEqual(P.metronomeBeats(NaN, 4, 4), []);
assert.deepStrictEqual(P.metronomeBeats(0.1, 0.12, 4), [], "within one frame, no beat");
// Default beats per bar is 4 when 0 or undefined.
assert.deepStrictEqual(accentsOf(P.metronomeBeats(0, 4, 0)), [4], "bpb 0 uses 4");
assert.deepStrictEqual(accentsOf(P.metronomeBeats(0, 4, undefined)), [4], "bpb undefined uses 4");
// Cap at 64 beats per call.
assert.strictEqual(P.metronomeBeats(0, 1000, 4).length, 64);

// Count-in length: one bar when on, zero when off.
assert.strictEqual(P.countInBeats(true, 4), 4);
assert.strictEqual(P.countInBeats(true, 3), 3);
assert.strictEqual(P.countInBeats(false, 4), 0);
assert.strictEqual(P.countInBeats(true, undefined), 4);

// Tempo session: the count-in is one bar by default, set with opts.countIn.
const cSong = P.normalizeSong({ title: "t", bpm: 60, beatsPerBar: 4, notes: [["C4", 0, 1], ["D4", 1, 1], ["E4", 2, 1], ["F4", 3, 1]] }).song;
const cDefault = P.createTempoSession(cSong, { hand: "right", speed: 100 });
assert.strictEqual(cDefault.range.countIn, 4, "default count-in is one bar");
const cNone = P.createTempoSession(cSong, { hand: "right", speed: 100, countIn: 0 });
assert.strictEqual(cNone.range.countIn, 0);
assert.strictEqual(P.countIn(cNone.range.start - 1, cNone.range.start, 0), 0, "no count-in one beat before start");
assert.strictEqual(P.countIn(cNone.range.start, cNone.range.start, 0), 0, "no count-in at start");
const cThree = P.createTempoSession(cSong, { hand: "right", speed: 100, countIn: 3 });
assert.strictEqual(cThree.range.countIn, 3);

// setSpeed: the session's clock and timing windows follow the speed.
const sSong = P.normalizeSong({ title: "t", bpm: 60, beatsPerBar: 4, notes: [["C4", 0, 1], ["D4", 1, 1], ["E4", 2, 1], ["F4", 3, 1]] }).song;
const sess = P.createTempoSession(sSong, { hand: "right", speed: 50 });
assert.strictEqual(sess.speed, 50);
near(sess.beatMs, 2000, "60 bpm at 50%");
near(sess.window, 0.15, "300 ms window at 2000 ms a beat");
sess.setSpeed(100);
assert.strictEqual(sess.speed, 100);
near(sess.beatMs, 1000, "60 bpm at 100%");
near(sess.window, 0.3, "300 ms window at 1000 ms a beat");
sess.setSpeed(130);
assert.strictEqual(sess.speed, 100, "setSpeed(130) clamps to 100");
near(sess.beatMs, 1000, "beat length at clamped 100%");

console.log("ok");
