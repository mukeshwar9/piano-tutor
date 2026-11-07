"use strict";
// Remote focus: one focused control, moved with arrows on a grid, no wrap-around. Run: node test/focus.test.js
const assert = require("assert");
const P = require("../public/piano-core.js");

// A menu: one column.
const menu = ["resume", "practise", "hear", "hand", "restart"].map((id, row) => ({ id, col: 0, row }));
assert.deepStrictEqual(P.focusMove(menu, "resume", "down"), { id: "practise", edge: false });
assert.deepStrictEqual(P.focusMove(menu, "hand", "up"), { id: "hear", edge: false });
assert.deepStrictEqual(P.focusMove(menu, "resume", "up"), { id: "resume", edge: true }, "no wrap at the top");
assert.deepStrictEqual(P.focusMove(menu, "restart", "down"), { id: "restart", edge: true }, "no wrap at the bottom");
assert.deepStrictEqual(P.focusMove(menu, "hear", "left"), { id: "hear", edge: true }, "nothing beside a column");

// Skipped items (locked, hidden) are passed over.
const gap = menu.map((x) => (x.id === "practise" ? { ...x, skip: true } : x));
assert.strictEqual(P.focusMove(gap, "resume", "down").id, "hear");
assert.strictEqual(P.focusMove(gap, "hear", "up").id, "resume");
// ...and when everything below is skipped the focus stays.
assert.deepStrictEqual(P.focusMove(gap.map((x) => (x.row > 1 ? { ...x, skip: true } : x)), "resume", "down"), { id: "resume", edge: true });

// A rail of filters beside a list of rows (the song picker).
const picker = [
  { id: "lvl1", col: 0, row: 0 }, { id: "lvl2", col: 0, row: 1 }, { id: "lvl3", col: 0, row: 2 }, { id: "showAll", col: 0, row: 3 },
  { id: "song0", col: 1, row: 0 }, { id: "song1", col: 1, row: 1 }, { id: "song2", col: 1, row: 2 }, { id: "song3", col: 1, row: 3 },
];
assert.strictEqual(P.focusMove(picker, "song2", "left").id, "lvl3", "into the filter on the same row");
assert.strictEqual(P.focusMove(picker, "lvl2", "right").id, "song1", "and back to the row beside it");
assert.strictEqual(P.focusMove(picker, "song0", "right").edge, true);
assert.strictEqual(P.focusMove(picker, "song3", "down").edge, true);

// A grid of tiles with a row of buttons under them: moving down from the right tile reaches the nearest button.
const home = [
  { id: "a", col: 0, row: 0 }, { id: "b", col: 1, row: 0 }, { id: "c", col: 2, row: 0 },
  { id: "x", col: 0, row: 1 }, { id: "y", col: 1, row: 1 },
];
assert.strictEqual(P.focusMove(home, "c", "down").id, "y", "the nearest column when there is none right below");
assert.strictEqual(P.focusMove(home, "y", "up").id, "b");
assert.strictEqual(P.focusMove(home, "x", "right").id, "y");
assert.strictEqual(P.focusMove(home, "a", "right").id, "b");
assert.strictEqual(P.focusMove(home, "b", "right").id, "c");

// An unknown current item goes to the first item that can be focused; an unknown direction stays put.
assert.deepStrictEqual(P.focusMove(menu, "nope", "down"), { id: "resume", edge: false });
assert.deepStrictEqual(P.focusMove(gap.map((x) => ({ ...x, skip: true })), "nope", "down"), { id: "nope", edge: true });
assert.deepStrictEqual(P.focusMove(menu, "hear", "sideways"), { id: "hear", edge: true });
assert.deepStrictEqual(P.focusMove([], "x", "down"), { id: "x", edge: true });

// Key names.
assert.deepStrictEqual(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "x"].map(P.focusDir), ["up", "down", "left", "right", "", ""]);

console.log("focus tests passed");
