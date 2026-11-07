"use strict";
// Score and stars: combo multiplier, timing precision, per-note points, session scores, stars from
// accuracy, the score in play records and the best score and stars per song. Run: node test/score.test.js
const assert = require("assert");
const P = require("../public/piano-core.js");

// Combo multiplier: 1 until 10 in a row, then 2, 3 and 4.
assert.deepStrictEqual([0, 1, 9, 10, 24, 25, 49, 50, 500].map(P.comboMultiplier), [1, 1, 1, 2, 2, 3, 3, 4, 4]);

// Timing precision: full inside the on-time window, half at the edge of the timing window, never below.
assert.strictEqual(P.timingPrecision(null), 1);
assert.strictEqual(P.timingPrecision(0), 1);
assert.strictEqual(P.timingPrecision(-P.TEMPO_ON_MS), 1);
assert.strictEqual(P.timingPrecision(P.TEMPO_WINDOW_MS), 0.5);
assert.strictEqual(P.timingPrecision(-P.TEMPO_WINDOW_MS), 0.5);
assert.strictEqual(P.timingPrecision(5000), 0.5);
const mid = P.timingPrecision((P.TEMPO_ON_MS + P.TEMPO_WINDOW_MS) / 2);
assert(Math.abs(mid - 0.75) < 1e-9, "halfway through the late window is 75%");

// Points for one note.
assert.strictEqual(P.notePoints(1), 100);
assert.strictEqual(P.notePoints(10), 200);
assert.strictEqual(P.notePoints(50, 0), 400);
assert.strictEqual(P.notePoints(50, P.TEMPO_WINDOW_MS), 200);
assert.strictEqual(P.notePoints(1, 200), Math.round(100 * P.timingPrecision(200)));

// Stars: accuracy 70, 85 and 95 percent.
assert.deepStrictEqual([0, 69.9, 70, 84.9, 85, 94.9, 95, 100].map(P.starsFor), [0, 0, 1, 1, 2, 2, 3, 3]);
assert.strictEqual(P.STAR_ACCURACY[2], P.MASTER_ACCURACY, "three stars are the Mastered line");

// Score text: thousands separated, never negative.
assert.deepStrictEqual([0, 5, 999, 1000, 12400, 1234567, -4, "x"].map(P.scoreText), ["0", "5", "999", "1,000", "12,400", "1,234,567", "0", "0"]);

// Level from difficulty: 1 to 5, 2 when missing.
assert.deepStrictEqual([1, 2, 4, 5, 9, 0, undefined, "3", "x"].map(P.levelOf), [1, 2, 4, 5, 5, 2, 2, 3, 2]);
assert.strictEqual(P.normalizeSong({ title: "T", difficulty: 3, notes: [["C4", 0, 1]] }, "t").song.level, 3);
assert.strictEqual(P.normalizeSong({ title: "T", notes: [["C4", 0, 1]] }, "t").song.level, 2);

// A wait-mode session scores each right note with the combo, and a wrong key resets the combo only.
const raw = { title: "Run", bpm: 100, beatsPerBar: 4, hand: "right", notes: Array.from({ length: 12 }, (_, i) => ["C4", i, 1]) };
const song = P.fitSong(P.normalizeSong(raw, "run").song, 36, 96);
const s = P.createSession(song, { hand: "right" });
assert.strictEqual(s.score, 0);
for (let i = 0; i < 9; i++) s.press(60);
assert.strictEqual(s.score, 900, "nine notes at x1");
s.press(60); // the tenth note: combo 10, x2
assert.strictEqual(s.score, 1100);
const before = s.score;
s.press(61); // wrong key
assert.strictEqual(s.score, before, "a wrong key takes no points away");
assert.strictEqual(s.streak, 0);
s.press(60);
assert.strictEqual(s.score, before + 100, "the combo starts again at x1");
s.press(60);
assert(s.done);
const rec = P.playRecord(song, s, { mode: "wait", speed: 1, durationMs: 1000 });
assert.strictEqual(rec.score, s.score);
s.restart();
assert.strictEqual(s.score, 0);

// A tempo session scores by timing: on time is full, off the beat is less, and a missed note breaks the combo.
const t = P.createTempoSession(song, { hand: "right", speed: 100, countIn: 0 });
const beatMs = t.beatMs;
t.press(60, 0);
assert.strictEqual(t.score, 100, "on time");
t.press(60, 1 + 250 / beatMs);
assert.strictEqual(t.score, 100 + Math.round(100 * 1 * P.timingPrecision(250)) , "late by 250 ms");
const afterTwo = t.score;
t.tick(2 + t.window + 0.01); // note at beat 2 is missed
assert.strictEqual(t.streak, 0);
assert.strictEqual(t.score, afterTwo);
t.restart();
assert.strictEqual(t.score, 0);

// Records keep the score (a whole number, never negative); old records without one read 0.
const good = { song: "a", title: "A", hand: "both", mode: "wait", speed: 1, loop: null, accuracy: 96, bestStreak: 20, correct: 30, wrong: 1, wrongKeys: {}, durationMs: 1000 };
assert.strictEqual(P.validPlay({ ...good, score: 12400.7 }).score, 12400);
assert.strictEqual(P.validPlay({ ...good, score: -5 }).score, 0);
assert.strictEqual(P.validPlay(good).score, 0);

// Best score and best stars per song come from whole-song plays only.
const sum = P.summarizeHistory([
  { ...good, accuracy: 72, score: 3000 },
  { ...good, accuracy: 90, score: 2500 },
  { ...good, accuracy: 99, score: 100, loop: { from: 1, to: 1 } },
]).a;
assert.strictEqual(sum.bestScore, 3000);
assert.strictEqual(sum.bestStars, 2);
assert.strictEqual(P.summarizeHistory([{ ...good, accuracy: 50 }]).a.bestStars, 0);

console.log("score tests passed");
