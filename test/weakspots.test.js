"use strict";
// Where it slipped: per-bar slip counts in both kinds of session, the worst pair of bars, records that
// carry them, and the weak spot to practise next (cleared by a finished loop). Run: node test/weakspots.test.js
const assert = require("assert");
const P = require("../public/piano-core.js");

// Eight bars of four quarter notes in 4/4: bar b holds the notes on beats 4(b-1) .. 4(b-1)+3, all C4 then D4.
const raw = { title: "Eight", bpm: 100, beatsPerBar: 4, hand: "right", notes: Array.from({ length: 32 }, (_, i) => [i % 2 ? "D4" : "C4", i, 1]) };
const song = P.fitSong(P.normalizeSong(raw, "eight").song, 36, 96);
const C = 60, D = 62, WRONG = 61;

// Wait mode: a wrong key counts against the bar of the step it was struck at.
{
  const s = P.createSession(song, { hand: "right" });
  for (let i = 0; i < 8; i++) s.press(i % 2 ? D : C);        // bars 1 and 2 clean
  s.press(WRONG); s.press(WRONG);                              // two wrong keys at the start of bar 3
  assert.deepStrictEqual(s.bars, { 3: { wrong: 2, late: 0 } });
  for (let i = 8; i < 14; i++) s.press(i % 2 ? D : C);
  s.press(WRONG);                                              // bar 4 (step 14)
  assert.deepStrictEqual(s.bars[4], { wrong: 1, late: 0 });
  assert.deepStrictEqual(s.passBars, s.bars, "without a loop the pass is the whole play");
  s.restart();
  assert.deepStrictEqual(s.bars, {});
}

// A loop: slips count per pass, and the pass that just ended is kept (the last one is the clean one).
{
  const s = P.createSession(song, { hand: "right", loop: { from: 3, to: 4 } });
  s.press(WRONG);
  for (let i = 0; i < 8; i++) s.press(i % 2 ? D : C);          // the first pass, with one wrong key at its start
  assert.strictEqual(s.passes, 1);
  assert.deepStrictEqual(s.lastPass, { 3: { wrong: 1, late: 0 } });
  assert.deepStrictEqual(s.passBars, {});
  for (let i = 0; i < 24; i++) s.press(i % 2 ? D : C);          // three clean passes
  assert(s.done);
  assert.deepStrictEqual(s.lastPass, {}, "the final pass had no slips");
  assert.deepStrictEqual(s.bars, { 3: { wrong: 1, late: 0 } }, "the total keeps the first pass");
}

// Tempo mode: wrong keys, missed notes (wrong) and early or late hits (late), each in its note's bar.
{
  const s = P.createTempoSession(song, { hand: "right", speed: 100, countIn: 0 });
  const beatMs = s.beatMs;
  s.press(C, 0);                                   // beat 0, bar 1, on time
  s.press(D, 1 + 200 / beatMs);                    // beat 1, bar 1, 200 ms late
  s.press(WRONG, 2);                               // a wrong key while the note at beat 2 is due
  s.tick(2 + s.window + 0.05);                     // beat 2 is missed (bar 1)
  s.press(D, 5 - 150 / beatMs);                    // beat 5 (bar 2), early
  assert.deepStrictEqual(s.bars, { 1: { wrong: 2, late: 1 }, 2: { wrong: 0, late: 1 } });
}

// Worst pair: the two neighbouring bars with the most slips.
const slips = (o) => Object.fromEntries(Object.entries(o).map(([b, [w, l]]) => [b, { wrong: w, late: l }]));
assert.strictEqual(P.worstPair({}, 8), null);
assert.deepStrictEqual(P.worstPair(slips({ 5: [3, 1], 6: [1, 0], 2: [2, 0] }), 8), { from: 5, to: 6, wrong: 4, late: 1, total: 5 });
assert.deepStrictEqual(P.worstPair(slips({ 2: [2, 0], 7: [2, 0] }), 8), { from: 1, to: 2, wrong: 2, late: 0, total: 2 }, "the earlier pair wins a tie");
assert.deepStrictEqual(P.worstPair(slips({ 8: [3, 0] }), 8), { from: 7, to: 8, wrong: 3, late: 0, total: 3 }, "the last bar pairs with the one before it");
assert.deepStrictEqual(P.worstPair(slips({ 1: [1, 1] }), 1), { from: 1, to: 1, wrong: 1, late: 1, total: 2 }, "a one-bar song");
assert.deepStrictEqual(P.worstPair({ 3: [2, 1], 4: [0, 2] }, 8), { from: 3, to: 4, wrong: 2, late: 3, total: 5 }, "record form works too");
assert.deepStrictEqual(P.worstPair({ 3: { wrong: 1, late: 0 } }), { from: 2, to: 3, wrong: 1, late: 0, total: 1 }, "without a count the song ends at its last slipped bar");

// Records carry the bars with slips; bad ones are cleaned or dropped.
assert.deepStrictEqual(P.compactBars({ 3: { wrong: 2, late: 0 }, 4: { wrong: 0, late: 0 }, 5: { wrong: 0, late: 1 } }), { 3: [2, 0], 5: [0, 1] });
const good = { song: "eight", title: "Eight", hand: "both", mode: "wait", speed: 1, loop: null, accuracy: 90, bestStreak: 5, correct: 25, wrong: 3, wrongKeys: {}, durationMs: 1000 };
assert.deepStrictEqual(P.validPlay({ ...good, bars: { 3: [2, 0], 5: [0, 1.9], 0: [1, 1], 7: [-1, 0], 8: "x", 9: [0, 0], x: [1, 1] } }).bars, { 3: [2, 0], 5: [0, 1] });
assert.deepStrictEqual(P.validPlay(good).bars, {}, "old records have none");
assert.deepStrictEqual(P.validPlay({ ...good, bars: "nope" }).bars, {});
const rs = P.createSession(song, { hand: "right" });
rs.press(WRONG); for (let i = 0; i < 32; i++) rs.press(i % 2 ? D : C);
assert.deepStrictEqual(P.playRecord(song, rs, {}).bars, { 1: [1, 0] });

// The weak spot of a song comes from its latest whole-song play, minus bars practised since.
const full = (song_, bars, at) => ({ ...good, song: song_, bars, at });
const loopPlay = (song_, from, to, at) => ({ ...good, song: song_, loop: { from, to }, bars: {}, at });
assert.strictEqual(P.weakSpot([], "eight", 8), null);
assert.strictEqual(P.weakSpot([loopPlay("eight", 1, 2, 1)], "eight", 8), null, "a loop alone is not a whole play");
const plays = [full("eight", { 2: [1, 0] }, 1), full("eight", { 5: [3, 1], 6: [1, 0], 2: [2, 0] }, 2)];
assert.deepStrictEqual(P.weakSpot(plays, "eight", 8), { song: "eight", from: 5, to: 6, wrong: 4, late: 1, total: 5, at: 2 });
assert.strictEqual(P.weakSpot(plays.concat(full("eight", {}, 3)), "eight", 8), null, "the latest full play was clean");
// Bars 5-6 practised: the next worst is left.
const after = plays.concat(loopPlay("eight", 5, 6, 3));
assert.deepStrictEqual(P.weakSpot(after, "eight", 8), { song: "eight", from: 1, to: 2, wrong: 2, late: 0, total: 2, at: 2 });
// A loop on one bar clears only that bar; a loop of another song or before the full play changes nothing.
const two = [full("eight", { 5: [3, 1], 6: [1, 0] }, 2), loopPlay("eight", 5, 5, 3)];
assert.deepStrictEqual(P.weakSpot(two, "eight", 8), { song: "eight", from: 5, to: 6, wrong: 1, late: 0, total: 1, at: 2 }, "bar 6 still slipped");
assert.strictEqual(P.weakSpot(plays.concat(loopPlay("other", 5, 6, 3)), "eight", 8).from, 5);
assert.strictEqual(P.weakSpot([loopPlay("eight", 5, 6, 0)].concat(plays), "eight", 8).from, 5);
// A newer whole play replaces everything before it.
assert.strictEqual(P.weakSpot(after.concat(full("eight", { 7: [1, 0] }, 4)), "eight", 8).from, 6, "bar 7 pairs with bar 6 (the earlier pair wins the tie)");

// The latest weak spot across songs: the song played through most recently that has one.
const mixed = [full("a", { 3: [1, 0] }, 1), full("b", { 4: [2, 0] }, 2), full("a", {}, 3)];
assert.strictEqual(P.latestWeakSpot(mixed, { a: 8, b: 8 }).song, "b", "a was played clean last, so b");
assert.strictEqual(P.latestWeakSpot(mixed.concat(loopPlay("b", 3, 4, 4)), { a: 8, b: 8 }), null, "and practising it clears it");
assert.strictEqual(P.latestWeakSpot(mixed, { a: 8 }), null, "a song that is gone is left out");
assert.strictEqual(P.latestWeakSpot([], { a: 8 }), null);

console.log("weakspots tests passed");
