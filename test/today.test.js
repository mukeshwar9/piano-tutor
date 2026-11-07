"use strict";
// The Today screen's plan: which tiles it offers and where the remote starts. Run: node test/today.test.js
const assert = require("assert");
const P = require("../public/piano-core.js");

const songs = [{ id: "a", title: "Song A", level: 1 }, { id: "b", title: "Song B", level: 2 }, { id: "bad", error: "x" }];
const scores = { a: { plays: 2, bestStars: 2 } };
const lesson = { title: "Hands on the keys", number: 4, status: "in-progress", step: 2, steps: 7 };
const weak = { song: "a", from: 5, to: 6, wrong: 4, late: 1 };

assert.strictEqual(P.barsLabel(5, 5), "bar 5");
assert.strictEqual(P.barsLabel(5, 6), "bars 5–6");
assert.strictEqual(P.slipsLabel(4, 1), "4 wrong keys, 1 off the beat");
assert.strictEqual(P.slipsLabel(1, 0), "1 wrong key");
assert.strictEqual(P.slipsLabel(0, 3), "3 off the beat");

// Everything on offer: lesson, weak spot and a song, starting on the weak spot.
let plan = P.todayPlan({ weak, songs, scores, lesson });
assert.deepStrictEqual(plan.tiles.map((t) => t.id), ["lesson", "weak", "song"]);
assert.strictEqual(plan.focus, "weak");
assert(plan.tiles.every((t) => !t.skip));
assert.strictEqual(plan.tiles[0].kicker, "Continue lesson");
assert.strictEqual(plan.tiles[0].title, "Lesson 4");
assert.strictEqual(plan.tiles[0].detail, "Hands on the keys · step 3 of 7");
assert.strictEqual(plan.tiles[1].title, "Bars 5–6");
assert.strictEqual(plan.tiles[1].detail, "Song A · 4 wrong keys, 1 off the beat");
assert.strictEqual(plan.tiles[2].title, "Song B", "the one never played");
assert.strictEqual(plan.tiles[2].detail, "Level 2 · new");
assert.strictEqual(plan.tiles[2].songId, "b");

// No weak spot: the tile says why and is passed over; focus starts on the lesson.
plan = P.todayPlan({ weak: null, songs, scores, lesson });
assert.strictEqual(plan.tiles[1].skip, true);
assert.strictEqual(plan.tiles[1].title, "No weak spots");
assert.strictEqual(plan.focus, "lesson");
// A lesson not started.
assert.strictEqual(P.todayPlan({ weak: null, songs, scores, lesson: { ...lesson, status: "not-started" } }).tiles[0].detail, "Hands on the keys · start here");
// All lessons passed: replay.
assert.strictEqual(P.todayPlan({ weak: null, songs, scores, lesson: { done: true } }).tiles[0].title, "All lessons passed");
// Lessons not loaded, no weak spot: the song tile gets the focus.
plan = P.todayPlan({ weak: null, songs, scores, lesson: null });
assert.strictEqual(plan.tiles[0].skip, true);
assert.strictEqual(plan.focus, "song");
assert.strictEqual(plan.tiles[0].detail, "The lessons could not be loaded");
assert.strictEqual(P.todayPlan({ weak: null, songs, scores, lesson: null, lessonLoading: true }).tiles[0].detail, "Loading\u2026");
// Every song played: the one with the fewest stars; a played song shows its stars.
plan = P.todayPlan({ weak: null, songs, scores: { a: { plays: 1, bestStars: 3 }, b: { plays: 1, bestStars: 1 } }, lesson });
assert.strictEqual(plan.tiles[2].title, "Song B");
assert.strictEqual(plan.tiles[2].detail, "Level 2 · ★☆☆");
// No songs at all.
plan = P.todayPlan({ weak: null, songs: [], scores: {}, lesson });
assert.strictEqual(plan.tiles[2].skip, true);
// A weak spot of a song that is gone still shows by its id.
assert.strictEqual(P.todayPlan({ weak: { ...weak, song: "gone" }, songs, scores, lesson }).tiles[1].detail, "gone · 4 wrong keys, 1 off the beat");

console.log("today tests passed");
