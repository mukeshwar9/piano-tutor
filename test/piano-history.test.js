"use strict";
// Score history: play records, validation, best scores, mastered rule and the JSON store.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../public/piano-core.js");
const piano = require("../piano.js");

const raw = { title: "Two bars", bpm: 100, beatsPerBar: 2, hand: "right", notes: [["C4", 0, 1], ["D4", 1, 1], ["E4", 2, 1], ["F4", 3, 1, "L"]] };
const song = P.fitSong(P.normalizeSong(raw, "two-bars").song, 36, 96);

// A session that records wrong keys by name and resets them on restart.
const s = P.createSession(song, { hand: "both" });
s.press(60); s.press(61); s.press(61); s.press(62); s.press(64); s.press(65);
assert.deepStrictEqual(s.wrongKeys, { 61: 2 });
assert(s.done);
const rec = P.playRecord(song, s, { mode: "wait", speed: 1, durationMs: 65400 });
assert.strictEqual(rec.song, "two-bars");
assert.strictEqual(rec.hand, "both");
assert.strictEqual(rec.mode, "wait");
assert.strictEqual(rec.loop, null);
assert.deepStrictEqual(rec.wrongKeys, { "C#4": 2 });
assert.strictEqual(rec.wrong, 2);
assert.strictEqual(rec.accuracy, Math.round((s.correct / (s.correct + s.wrong)) * 1000) / 10);
assert.strictEqual(rec.bestStreak, s.bestStreak);
s.restart();
assert.deepStrictEqual(s.wrongKeys, {});

// The loop range is recorded.
const ls = P.createSession(song, { hand: "both", loop: { from: 1, to: 2 } });
assert.deepStrictEqual(P.playRecord(song, ls, {}).loop, { from: 1, to: 2 });

// Validation: clean values, bad input rejected.
const good = { song: "a", title: "A", hand: "both", mode: "tempo", speed: 0.75, loop: null, accuracy: 96.44, bestStreak: 20, correct: 30, wrong: 1, wrongKeys: { C4: 1, bogus: 3, D4: 0 }, durationMs: 1234.6 };
const v = P.validPlay(good);
assert.deepStrictEqual(v, { song: "a", title: "A", hand: "both", mode: "tempo", speed: 0.75, loop: null, accuracy: 96.4, bestStreak: 20, correct: 30, wrong: 1, wrongKeys: { C4: 1 }, durationMs: 1235, at: 0 });
assert.strictEqual(P.validPlay({ ...good, mode: "weird" }).mode, "wait", "unknown mode falls back to wait");
assert.strictEqual(P.validPlay({ ...good, speed: 0 }).speed, 1);
for (const bad of [null, "x", { ...good, song: "" }, { ...good, hand: "feet" }, { ...good, accuracy: 101 }, { ...good, accuracy: "x" }, { ...good, loop: { from: 0, to: 1 } }, { ...good, wrong: -1 }]) {
  assert.strictEqual(P.validPlay(bad), null, JSON.stringify(bad));
}

// Mastered: whole song, both hands, full speed, 95%+.
const play = (o) => P.validPlay({ ...good, mode: "wait", speed: 1, ...o });
assert(P.isMasteredPlay(play({ accuracy: 95 })));
assert(!P.isMasteredPlay(play({ accuracy: 94.9 })));
assert(!P.isMasteredPlay(play({ hand: "right" })));
assert(!P.isMasteredPlay(play({ loop: { from: 1, to: 1 } })));
assert(!P.isMasteredPlay(play({ mode: "tempo", speed: 0.5 })), "slow tempo does not master");
assert(P.isMasteredPlay(play({ mode: "tempo", speed: 1 })), "tempo at full speed does");

// Summary: best accuracy and streak over whole-song plays only; loops count as plays but not as scores.
const sum = P.summarizeHistory([
  play({ song: "a", hand: "right", accuracy: 99, bestStreak: 40, at: 1 }),
  play({ song: "a", hand: "both", accuracy: 90, bestStreak: 12, at: 2 }),
  play({ song: "a", hand: "both", accuracy: 100, bestStreak: 3, loop: { from: 1, to: 1 }, at: 3 }),
  play({ song: "b", hand: "both", accuracy: 96, bestStreak: 50, at: 4 }),
]);
assert.deepStrictEqual(sum.a, { plays: 3, fullPlays: 2, bestAccuracy: 99, bestStreak: 40, bestBothAccuracy: 90, mastered: false, lastAt: 3 });
assert.strictEqual(sum.b.mastered, true);
assert.strictEqual(sum.b.bestBothAccuracy, 96);
assert.deepStrictEqual(P.summarizeHistory([]), {});

assert.strictEqual(P.percentText(98), "98%");
assert.strictEqual(P.percentText(97.5), "97.5%");
assert.strictEqual(P.percentText(null), "-");
assert.strictEqual(P.durationText(42000), "42 s");
assert.strictEqual(P.durationText(65400), "1 min 05 s");

// The store: stamped, validated, kept across reads, capped, survives garbage.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piano-history-"));
const file = path.join(dir, "piano-history.json");
assert.deepStrictEqual(piano.readHistory(file), [], "no file is an empty history");
const stored = piano.addPlay(file, { ...good, at: 5 }, 1700000000000);
assert.strictEqual(stored.at, 1700000000000, "the server stamps the date, not the client");
assert.throws(() => piano.addPlay(file, { song: "a" }), /invalid play/);
piano.addPlay(file, { ...good, accuracy: 100, hand: "right" }, 1700000001000);
assert.strictEqual(piano.readHistory(file).length, 2);
assert.strictEqual(piano.historySummary(file).a.bestAccuracy, 100);
assert.deepStrictEqual(fs.readdirSync(dir), ["piano-history.json"], "no temp file left behind");
fs.writeFileSync(file, JSON.stringify({ plays: [{ nonsense: true }, stored, 7] }));
assert.deepStrictEqual(piano.readHistory(file), [stored], "invalid entries are dropped");
fs.writeFileSync(file, "{not json");
assert.deepStrictEqual(piano.readHistory(file), []);
fs.writeFileSync(file, JSON.stringify({ plays: Array.from({ length: piano.MAX_PLAYS }, (_, i) => ({ ...stored, at: i + 1 })) }));
piano.addPlay(file, good, 9e12);
const capped = piano.readHistory(file);
assert.strictEqual(capped.length, piano.MAX_PLAYS);
assert.strictEqual(capped[0].at, 2, "the oldest play is dropped");
assert.strictEqual(capped[capped.length - 1].at, 9e12);
fs.rmSync(dir, { recursive: true });

console.log("ok");
