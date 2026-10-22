// TV telemetry: frame-time window statistics, long frames, note-to-light latency, the remote's key
// sequence, the URL flag and the readout text. Run: node test/piano-telemetry.test.js
const assert = require("assert");
const T = require("../public/piano-telemetry.js");

const near = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg || ""} expected ${b}, got ${a}`);

// A steady 60 fps (16 ms frames) for 12 s.
const w = T.createFrameWindow();
let t = 1000;
for (let i = 0; i < 750; i++) { w.push(t); t += 16; }
const now = t - 16;
near(w.fps(now, 1000), 62.5, 1, "current fps");
near(w.fps(now, 5000), 62.5, 1, "5 s average fps");
assert.strictEqual(w.worst(now, 5000), 16);
assert.strictEqual(w.longer(now, 10000, T.LONG_MS), 0, "no long frames at a steady rate");
assert(w.size <= 750);

// One 120 ms stall: the worst frame, one long frame, and the 1 s fps dips while it is in the window.
const w2 = T.createFrameWindow();
t = 0;
for (let i = 0; i < 100; i++) { w2.push(t); t += 16; }
t += 104; w2.push(t);                          // a 120 ms frame
for (let i = 0; i < 50; i++) { t += 16; w2.push(t); }
assert.strictEqual(w2.worst(t, 5000), 120);
assert.strictEqual(w2.longer(t, 10000, 50), 1);
assert(w2.fps(t, 1000) < 60 && w2.fps(t, 1000) > 50, "the stall is inside the last second and pulls the current fps down");
// The window forgets: the stall leaves the 5 s worst after 5 s and the 10 s count after 10 s.
let later = t;
for (let i = 0; i < 6 * 62; i++) { later += 16; w2.push(later); }
assert.strictEqual(w2.worst(later, 5000), 16, "worst frame covers only the last 5 s");
assert.strictEqual(w2.longer(later, 10000, 50), 1, "the long frame still counts within 10 s");
for (let i = 0; i < 6 * 62; i++) { later += 16; w2.push(later); }
assert.strictEqual(w2.longer(later, 10000, 50), 0, "and is gone after 10 s");

// Frames of 50 ms exactly are not long, 51 is; several long frames are counted.
const w3 = T.createFrameWindow();
t = 0; w3.push(t);
[50, 51, 80, 16, 200].forEach((d) => { t += d; w3.push(t); });
assert.strictEqual(w3.longer(t, 10000, 50), 3);
assert.strictEqual(w3.worst(t, 10000), 200);
near(w3.fps(t, 10000), 5 * 1000 / 397, 0.01);

// A slow rate reads as a slow rate: 20 fps.
const w4 = T.createFrameWindow();
for (let i = 0; i < 200; i++) w4.push(i * 50);
near(w4.fps(199 * 50, 5000), 20, 0.5);

// No frames: zeros, not NaN. The first frame has no frame time. A hidden tab's gap is not a frame.
const e = T.createFrameWindow();
assert.strictEqual(e.fps(1000, 1000), 0);
assert.strictEqual(e.worst(1000, 1000), 0);
e.push(100);
assert.strictEqual(e.size, 0, "the first frame has no frame time yet");
e.push(116); e.push(116 + T.MAX_GAP_MS + 5000); e.push(116 + T.MAX_GAP_MS + 5016);
assert.strictEqual(e.size, 2, "a gap over 10 s (hidden tab) is left out");
assert.strictEqual(e.worst(116 + T.MAX_GAP_MS + 5016, 60000), 16);

// The ring keeps the newest frames when it is smaller than the span.
const r = T.createFrameWindow(10);
for (let i = 0; i < 100; i++) r.push(i * 10);
assert.strictEqual(r.size, 10);
near(r.fps(990, 100000), 100, 0.01);

// Latency: each waiting note takes its delay at the next drawn frame.
const L = T.createLatency();
assert.strictEqual(L.stats(1000, 10000), null, "no notes: no latency");
L.arrive(100); L.arrive(110);
assert.strictEqual(L.waiting, 2);
L.drawn(130);
assert.strictEqual(L.waiting, 0);
let s = L.stats(200, 10000);
assert.deepStrictEqual({ n: s.n, last: s.last, max: s.max, avg: s.avg }, { n: 2, last: 20, max: 30, avg: 25 });
L.drawn(160);                                  // nothing waiting: nothing measured
assert.strictEqual(L.stats(200, 10000).n, 2);
L.arrive(500); L.drawn(540);
s = L.stats(600, 10000);
assert.deepStrictEqual({ n: s.n, last: s.last, max: s.max }, { n: 3, last: 40, max: 40 });
assert.strictEqual(L.stats(11000, 10000), null, "old measurements fall out of the 10 s summary");
assert.strictEqual(L.stats(10200, 10000).n, 1, "only the newest stays");
for (let i = 0; i < 200; i++) L.arrive(i);
assert.strictEqual(L.waiting, 64, "waiting notes are capped");
L.drawn(1000);
assert(L.stats(1000, 10000).n <= 64);
const L2 = T.createLatency(); L2.arrive(500); L2.drawn(400);
assert.strictEqual(L2.stats(600, 10000).last, 0, "a clock hiccup never gives a negative latency");

// The combined sampler.
const tel = T.create();
for (let i = 0; i < 400; i++) tel.frame(i * 25);
tel.noteArrived(9900); tel.noteDrawn(9930);
const smp = tel.sample(9975);
near(smp.fps, 40, 0.5); near(smp.fps5, 40, 0.5);
assert.strictEqual(smp.worst, 25);
assert.strictEqual(smp.long, 0);
assert.strictEqual(smp.latency.last, 30);
tel.noteDrawn(10000);                          // nothing waiting: a no-op
assert.strictEqual(tel.sample(9975).latency.n, 1);

// Chrome version and the flag.
assert.strictEqual(T.chromeVersion("Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.131 Mobile Safari/537.36"), "114");
assert.strictEqual(T.chromeVersion("curl/8"), "");
assert.strictEqual(T.chromeVersion(null), "");
assert.strictEqual(T.parseFlag(""), null);
assert.strictEqual(T.parseFlag("?learn=1"), null);
assert.strictEqual(T.parseFlag("?telemetry=1"), true);
assert.strictEqual(T.parseFlag("?telemetry"), true);
assert.strictEqual(T.parseFlag("?song=x&telemetry=on&nogov"), true);
assert.strictEqual(T.parseFlag("?telemetry=0"), false);
assert.strictEqual(T.parseFlag("?telemetry=OFF"), false);
assert.strictEqual(T.parseFlag("?telemetry=false&x=1"), false);
assert.strictEqual(T.parseFlag("?telemetryx=1"), null, "only the exact flag");

// The remote sequence: three presses, each within the window of the one before.
const seq = T.createSequence(3, 1200);
assert.deepStrictEqual([seq.press(0), seq.press(500), seq.press(1000)], [false, false, true]);
assert.deepStrictEqual([seq.press(1100), seq.press(1200)], [false, false], "starts over after it fired");
assert.strictEqual(seq.press(1300), true);
assert.deepStrictEqual([seq.press(5000), seq.press(7000), seq.press(7500)], [false, false, false], "a pause of more than the window starts over");
assert.strictEqual(seq.press(8000), true);
seq.press(9000); seq.reset();
assert.deepStrictEqual([seq.press(9100), seq.press(9200)], [false, false]);

// The report is rounded and carries the environment; the readout says each number.
const env = { chrome: "114", dpr: 1.5, w: 1280, h: 720 };
const rep = T.report({ fps: 59.84, fps5: 41.26, worst: 83.33, long: 4, latency: { last: 31.46, avg: 28.04, max: 52.5, n: 3 } }, { level: 2, preset: "neon + sparks", mem: 37.6, sparks: 12, draw: 3.456 }, env);
assert.deepStrictEqual(rep, { fps: 59.8, fps5: 41.3, worst: 83.3, long: 4, level: 2, preset: "neon + sparks", latency: { last: 31.5, avg: 28, max: 52.5, n: 3 }, mem: 38, chrome: "114", dpr: 1.5, w: 1280, h: 720, sparks: 12, draw: 3.5 });
const txt = T.readoutText(rep);
assert(/fps 60 · avg 41/.test(txt) && /worst 83 ms · long 4/.test(txt) && /gov 2/.test(txt) && /fx neon \+ sparks/.test(txt));
assert(/note→light 32 ms \(avg 28, max 53\)/.test(txt) && /mem 38 MB/.test(txt) && /chrome 114 · dpr 1.5 · 1280×720/.test(txt));
const bare = T.report({ fps: 30, fps5: 30, worst: 40, long: 0, latency: null }, { level: "", preset: "off" }, null);
assert.strictEqual(bare.mem, null);
const bareTxt = T.readoutText(bare);
assert(/no notes yet/.test(bareTxt) && !/mem/.test(bareTxt) && /gov -/.test(bareTxt) && /chrome \? · dpr \?/.test(bareTxt), bareTxt);
assert.strictEqual(T.health({ fps5: 58 }), "ok");
assert.strictEqual(T.health({ fps5: 40 }), "slow");
assert.strictEqual(T.health({ fps5: 20 }), "bad");
assert.strictEqual(T.health({ fps5: 0 }), "ok", "no frames yet is not a bad reading");

console.log("piano-telemetry tests passed");
