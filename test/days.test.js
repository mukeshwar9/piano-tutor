"use strict";
// Day streak and daily goal from the play history: local days, any play keeps the streak, ten minutes
// of all playing meet the goal, a play counts for at most half an hour. Run: node test/days.test.js
const assert = require("assert");
const P = require("../public/piano-core.js");

const MIN = 60000;
// Local times, so the tests hold in any time zone. Months are 0-based: this is Sunday 8 Nov 2026.
const at = (day, hour = 12) => new Date(2026, 10, day, hour, 0, 0).getTime();
const play = (day, minutes, hour) => ({ at: at(day, hour), durationMs: minutes * MIN, loop: null });
const now = at(8, 15);

// No plays at all.
let d = P.dayStats([], now);
assert.strictEqual(d.goalMin, 10);
assert.strictEqual(d.minutesToday, 0);
assert.strictEqual(d.goal, 0);
assert.strictEqual(d.goalMet, false);
assert.strictEqual(d.playedToday, false);
assert.strictEqual(d.streak, 0);
assert.strictEqual(d.longest, 0);
assert.strictEqual(d.calendar.length, 4);
assert(d.calendar.every((row) => row.length === 7));
assert.strictEqual(d.week, d.calendar[3]);

// Minutes add up across plays today, loops included; the goal is ten minutes.
d = P.dayStats([play(8, 3.5, 9), { ...play(8, 2, 10), loop: { from: 1, to: 2 } }], now);
assert.strictEqual(d.minutesToday, 5.5);
assert(Math.abs(d.goal - 0.55) < 1e-9);
assert.strictEqual(d.goalMet, false);
assert.strictEqual(d.playedToday, true);
d = P.dayStats([play(8, 6, 9), play(8, 4, 10)], now);
assert.strictEqual(d.goalMet, true, "exactly ten minutes meets the goal");
assert.strictEqual(d.goal, 1);
d = P.dayStats([play(8, 25, 9)], now);
assert.strictEqual(d.goal, 1, "the bar stops at full");
assert.strictEqual(d.minutesToday, 25);

// One play counts for at most half an hour.
d = P.dayStats([play(8, 600, 9)], now);
assert.strictEqual(d.minutesToday, 30);

// Any play keeps the streak, however short; a gap ends it.
d = P.dayStats([play(6, 0.5), play(7, 1), play(8, 0.1)], now);
assert.strictEqual(d.streak, 3);
d = P.dayStats([play(4, 5), play(6, 5), play(7, 5), play(8, 5)], now);
assert.strictEqual(d.streak, 3, "the day without a play breaks it");
assert.strictEqual(d.longest, 3);

// Today without a play yet does not end the streak: it counts up to yesterday.
d = P.dayStats([play(6, 5), play(7, 5)], now);
assert.strictEqual(d.streak, 2);
assert.strictEqual(d.playedToday, false);
// ...but two empty days do.
d = P.dayStats([play(5, 5), play(6, 5)], now);
assert.strictEqual(d.streak, 0);
assert.strictEqual(d.longest, 2, "the longest run is kept");

// The longest run across the whole history.
d = P.dayStats([play(1, 1), play(2, 1), play(3, 1), play(4, 1), play(6, 1), play(7, 1)], now);
assert.strictEqual(d.longest, 4);
assert.strictEqual(d.streak, 2);

// Plays across a month end and a clock change are still consecutive days.
const oct = (day) => ({ at: new Date(2026, 9, day, 23, 30).getTime(), durationMs: MIN });
const longRun = [oct(30), oct(31), { at: new Date(2026, 10, 1, 0, 10).getTime(), durationMs: MIN }, play(2, 1), play(3, 1)];
assert.strictEqual(P.dayStats(longRun, at(3, 20)).streak, 5);

// Minutes this week: the last seven days, today included.
d = P.dayStats([play(1, 20), play(2, 5), play(4, 3), play(8, 2)], now);
assert.strictEqual(d.minutesWeek, 5 + 3 + 2, "7 days back from the 8th starts on the 2nd");

// The calendar: four rows, Monday first, today's row last; solid for goal days, outline for played days.
d = P.dayStats([play(2, 12), play(3, 4), play(8, 10), play(9, 5)], now);
const flat = d.calendar.reduce((a, r) => a.concat(r), []);
assert.strictEqual(flat.length, 28);
assert.strictEqual(d.calendar[3][0].key, "2026-11-02", "Monday of today's week");
assert.strictEqual(d.calendar[3][6].key, "2026-11-08", "Sunday 8 Nov is the last cell");
assert.strictEqual(d.calendar[0][0].key, "2026-10-12");
assert.deepStrictEqual(d.calendar[3].map((c) => c.status), ["goal", "played", "none", "none", "none", "none", "goal"]);
assert.deepStrictEqual(flat.filter((c) => c.today).map((c) => c.key), ["2026-11-08"]);
// The future shows as future (Wednesday 4 Nov: the rest of the week is ahead).
d = P.dayStats([], at(4, 10));
assert.deepStrictEqual(d.calendar[3].map((c) => c.status), ["none", "none", "none", "future", "future", "future", "future"]);

// Plays without a time, or after now, are ignored.
d = P.dayStats([{ at: 0, durationMs: 60 * MIN }, play(9, 5)], now);
assert.strictEqual(d.minutesToday, 0);

// Day helpers.
assert.strictEqual(P.dayKey(new Date(2026, 0, 5)), "2026-01-05");
assert.strictEqual(P.dayKey(P.shiftDay(new Date(2026, 2, 1), -1)), "2026-02-28");
assert.strictEqual(P.dayKey(P.shiftDay(new Date(2026, 10, 30, 23, 59), 1)), "2026-12-01");

console.log("days tests passed");
