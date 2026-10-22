// The server's in-memory store of the TV's telemetry. Run: node test/telemetry-store.test.js
const assert = require("assert");
const fs = require("fs");
const S = require("../telemetry.js");

let clock = 1000000;
const store = S.createStore(() => clock);

// Nothing yet: not live, no age, no summary.
let g = store.get();
assert.deepStrictEqual({ live: g.live, ageMs: g.ageMs, latest: g.latest, summary: g.summary }, { live: false, ageMs: null, latest: null, summary: null });

// Not a sample: refused and not stored.
for (const bad of [null, undefined, "x", 5, {}, { fps: "fast" }, { worst: 10 }]) assert.strictEqual(store.add(bad), null, JSON.stringify(bad));
assert.strictEqual(store.size, 0);

// A sample is kept as numbers, rounded and clamped; text is cut down to its safe part.
const a = store.add({
  fps: 55.123, fps5: 48.96, worst: 70, long: 3, level: 1, preset: "lite", mem: 41.4, chrome: "114", dpr: 1.5, w: 1280, h: 720,
  latency: { last: 30, avg: 25.55, max: 60, n: 4 }, sparks: 9, draw: 2.25,
  user: "someone", ua: "Mozilla/5.0 secret", extra: { a: 1 },
});
assert.strictEqual(a.at, clock);
assert.deepStrictEqual(Object.keys(a).sort(), ["at", "chrome", "dpr", "draw", "fps", "fps5", "h", "latency", "level", "long", "mem", "preset", "sparks", "w", "worst"], "only the known fields are kept");
assert.strictEqual(a.fps, 55.1);
assert.strictEqual(a.fps5, 49);
assert.strictEqual(a.latency.avg, 25.6);
assert.strictEqual(a.mem, 41);
const wild = S.sanitize({ fps: 99999, fps5: -5, worst: 1e9, long: 1e9, level: "<b>off</b>", preset: "a".repeat(100) + "<script>", chrome: "114.0.1; DROP", dpr: 99, w: -3, h: 1e9, latency: { avg: "x" } });
assert.strictEqual(wild.fps, 1000);
assert.strictEqual(wild.fps5, 0);
assert.strictEqual(wild.worst, 60000);
assert.strictEqual(wild.long, 100000);
assert.strictEqual(wild.level, "boffb", "tag punctuation is stripped and the text cut at 8");
assert(wild.preset.length <= 24 && !/[<>]/.test(wild.preset));
assert.strictEqual(wild.chrome, "114.0.1", "cut at 8 characters, no punctuation but dots");
assert.strictEqual(wild.dpr, 16);
assert.strictEqual(wild.w, 0);
assert.strictEqual(wild.h, 20000);
assert.strictEqual(wild.latency, null, "a latency without numbers is dropped");
assert.strictEqual(S.sanitize({ fps: 30 }).fps5, 30, "a missing 5 s average falls back to the current fps");
assert.strictEqual(S.sanitize({ fps5: 30 }).fps, 30);
assert.strictEqual(S.sanitize({ fps: 30, level: "off" }).level, "off");
assert.strictEqual(S.sanitize({ fps: 30 }).latency, null);
assert.strictEqual(S.sanitize({ fps: 30 }).mem, null);

// The latest sample, its age and live flag.
store.add({ fps: 50, fps5: 52, worst: 90, long: 2, level: 2, preset: "neon + sparks", latency: { last: 35, avg: 30, max: 80, n: 2 } });
clock += 2000;
g = store.get();
assert.strictEqual(g.live, true);
assert.strictEqual(g.ageMs, 2000);
assert.strictEqual(g.latest.fps, 50);
assert.strictEqual(g.now, clock);
clock += S.LIVE_MS;
g = store.get();
assert.strictEqual(g.live, false, "no report for a few seconds: not live");
assert.strictEqual(g.ageMs, 2000 + S.LIVE_MS);
assert.strictEqual(g.latest.fps, 50, "the last sample stays readable");

// Rolling summary over the newest samples.
let sm = store.summary();
assert.strictEqual(sm.samples, 2);
assert.strictEqual(sm.fpsMin, 50);
assert.strictEqual(sm.fpsMean, 50.5);
assert.strictEqual(sm.worstMs, 90);
assert.strictEqual(sm.longFrames, 3);
assert.deepStrictEqual(sm.latency, { avgMs: 27.8, maxMs: 80, notes: 2 });

// It keeps only so many samples, and the summary covers only the newest.
const big = S.createStore(() => clock);
for (let i = 0; i < S.KEEP + 40; i++) { clock += 2000; big.add({ fps: i < S.KEEP + 15 ? 10 : 60, fps5: i < S.KEEP + 15 ? 10 : 60, worst: i === 5 ? 999 : 20 }); }
assert.strictEqual(big.size, S.KEEP, "bounded");
sm = big.summary();
assert.strictEqual(sm.samples, S.SUMMARY_SAMPLES);
assert.strictEqual(sm.worstMs, 20, "old samples are out of the summary");
assert.strictEqual(sm.fpsMin, 10);
assert.strictEqual(sm.latency, null, "no latency without notes");
assert.strictEqual(sm.spanMs, (S.SUMMARY_SAMPLES - 1) * 2000);

// Memory only: the module never touches the disk.
assert(!/\b(fs|writeFile|appendFile|createWriteStream)\b/.test(fs.readFileSync(require.resolve("../telemetry.js"), "utf8").replace(/\/\/.*$/gm, "")), "no file access in the store");

console.log("telemetry-store tests passed");
