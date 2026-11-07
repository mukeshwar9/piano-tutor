"use strict";
// The song picker: level and show filters, and the song suggested next. Run: node test/picker.test.js
const assert = require("assert");
const P = require("../public/piano-core.js");

const songs = [
  { id: "a", title: "A", level: 1 }, { id: "b", title: "B", level: 2 }, { id: "c", title: "C", level: 2 },
  { id: "d", title: "D", level: 3 }, { id: "bad", error: "invalid JSON" }, { id: "e", title: "E" },
];
const scores = {
  a: { plays: 3, bestStars: 3, mastered: true },
  b: { plays: 1, bestStars: 1, mastered: false },
  c: { plays: 2, bestStars: 3, mastered: false },
};
const ids = (f) => P.filterSongs(songs, scores, f).map((s) => s.id).join("");

// No filter, or all, keeps every song that loads, in order.
assert.strictEqual(ids({}), "abcde");
assert.strictEqual(ids({ show: "all", levels: {} }), "abcde");
// A song with no level reads as level 2.
assert.strictEqual(ids({ levels: { 2: true } }), "bce");
// Several levels are any of them; off chips do not count.
assert.strictEqual(ids({ levels: { 1: true, 3: true } }), "ad");
assert.strictEqual(ids({ levels: { 1: false, 2: false } }), "abcde");
assert.strictEqual(ids({ levels: { 5: true } }), "");
// Show.
assert.strictEqual(ids({ show: "new" }), "de", "never played: d and the song with no level");
assert.strictEqual(ids({ show: "not3" }), "bde", "fewer than three stars, unplayed included");
assert.strictEqual(ids({ show: "mastered" }), "a");
// Level and show together.
assert.strictEqual(ids({ levels: { 2: true }, show: "not3" }), "be");
assert.strictEqual(ids({ levels: { 3: true }, show: "mastered" }), "");
// Without scores everything is new.
assert.strictEqual(P.filterSongs(songs, null, { show: "new" }).length, 5);
assert.deepStrictEqual(P.SHOW_FILTERS, ["all", "new", "not3", "mastered"]);
assert.strictEqual(P.SHOW_NAMES.not3, "Not 3★");

// The suggestion: the easiest song never played, the first among equals.
assert.strictEqual(P.suggestSong(songs, scores).id, "e", "d (level 3) and e (level 2) are new: e is easier");
assert.strictEqual(P.suggestSong(songs.filter((s) => s.id !== "e"), scores).id, "d");
assert.strictEqual(P.suggestSong([{ id: "x", level: 3 }, { id: "y", level: 1 }, { id: "z", level: 1 }], {}).id, "y");
// Everything played: the fewest stars, then the easiest, then the first.
const all = { a: { plays: 1, bestStars: 3 }, b: { plays: 1, bestStars: 1 }, c: { plays: 1, bestStars: 1 }, d: { plays: 1, bestStars: 2 } };
assert.strictEqual(P.suggestSong(songs.slice(0, 4), all).id, "b");
assert.strictEqual(P.suggestSong([{ id: "x", level: 3 }, { id: "y", level: 2 }], { x: { plays: 1, bestStars: 0 }, y: { plays: 1, bestStars: 0 } }).id, "y");
assert.strictEqual(P.suggestSong([], {}), null);
assert.strictEqual(P.suggestSong([{ id: "bad", error: "x" }], {}), null);

console.log("picker tests passed");
