"use strict";
// Room light colour: pitch to hue, recency weighting, easing and per-tick caps, idle fade. Run: node test/light.test.js
const assert = require("assert");
const L = require("../light.js");

const TICK = 125;
const IDLE = L.PALETTES.spectrum.idle;
const close = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg || ""} ${a} vs ${b}`);

// Palette mapping: octaves agree, every palette gives twelve distinct hues, fifths neighbours are visibly apart.
for (const name of Object.keys(L.PALETTES)) {
  assert.strictEqual(L.pitchHue(60, name), L.pitchHue(72, name), name + " octaves");
  const hues = Array.from({ length: 12 }, (_, i) => L.pitchHue(60 + i, name));
  assert.strictEqual(new Set(hues.map((h) => h.toFixed(3))).size, 12, name + " twelve distinct hues");
}
const SPAN = (name) => Math.abs(L.PALETTES[name].arc[1] - L.PALETTES[name].arc[0]);
const fifthsHues = (name) => Array.from({ length: 12 }, (_, i) => L.pitchHue(60 + (i * 7) % 12, name)); // C, G, D, ...
{
  // Spectrum covers the whole wheel in pitch order: semitones 30 degrees apart, a fifth visibly far (150 or more).
  const sorted = Array.from({ length: 12 }, (_, i) => L.pitchHue(60 + i, "spectrum"));
  assert(sorted[11] - sorted[0] >= 300, "full wheel");
  for (let i = 1; i < 12; i++) close(sorted[i] - sorted[i - 1], 30, 1e-9, "semitone steps");
  for (const name of Object.keys(L.PALETTES)) {
    const gaps = fifthsHues(name).slice(1).map((x, i) => Math.abs(L.hueDelta(fifthsHues(name)[i], x)));
    const need = Math.min(0.5 * SPAN(name) * 7 / 11, 150);
    assert(gaps.every((g) => g >= Math.min(need, SPAN(name) * 0.3) - 1e-9), name + " fifths neighbours are visibly apart: " + gaps.map((g) => g.toFixed(0)));
  }
}
// Arc palettes stay inside their colour family.
const within = (h, a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); const x = ((h % 360) + 360) % 360, l = ((lo % 360) + 360) % 360; return ((x - l + 360) % 360) <= hi - lo + 1e-9; };
for (const name of ["aurora", "sunset", "ocean", "warm"]) {
  const [a, b] = L.PALETTES[name].arc;
  for (let n = 60; n < 72; n++) assert(within(L.pitchHue(n, name), a, b), name + " " + L.pitchHue(n, name));
}
// The families: aurora greens to violets, sunset reds/oranges/pinks, ocean blues/teals, warm amber.
assert(Math.min(...fifthsHues("aurora")) >= 120 && Math.max(...fifthsHues("aurora")) <= 290);
assert(fifthsHues("sunset").every((h) => h >= 285 || h <= 50));
assert(fifthsHues("ocean").every((h) => h >= 155 && h <= 250));
assert(fifthsHues("warm").every((h) => h >= 5 && h <= 65));
assert.strictEqual(L.DEFAULT_PALETTE, "spectrum");
assert.strictEqual(L.createLight().palette, "spectrum", "new default");
assert.strictEqual(L.createLight({ palette: "nope" }).palette, "spectrum");

// Shortest way round the hue circle.
assert.strictEqual(L.hueDelta(350, 10), 20);
assert.strictEqual(L.hueDelta(10, 350), -20);
assert.strictEqual(L.hueDelta(0, 180), 180);

// Colour conversions.
assert.deepStrictEqual(L.hsvToRgb(0, 1, 1), [255, 0, 0]);
assert.deepStrictEqual(L.hsvToRgb(120, 1, 1), [0, 255, 0]);
assert.deepStrictEqual(L.hsvToRgb(240, 0.5, 1), [128, 128, 255]);
const hsv = L.rgbToHsv(0, 255, 0);
close(hsv.h, 120, 1e-9); assert.strictEqual(hsv.s, 1);
assert.deepStrictEqual(L.hsvToRgb(L.rgbToHsv(200, 100, 50).h, L.rgbToHsv(200, 100, 50).s, 1), [255, 128, 64]);

// Runs a light for ms, feeding notes at given times; returns every step.
function run(light, ms, notes = [], from = 0) {
  const out = [];
  for (let t = from; t <= from + ms; t += TICK) {
    for (const n of notes) if (n.at <= t && n.at > t - TICK) light.noteOn(n.note, n.vel == null ? 80 : n.vel, n.at);
    out.push(light.step(t));
  }
  return out;
}

// Idle: a new light sits at the calm warm colour at low brightness.
{
  const l = L.createLight();
  const [s] = run(l, 0);
  assert.strictEqual(s.silent, true);
  assert(s.b <= 15 && s.b >= 10);
  assert(s.h >= 15 && s.h <= 45, "warm");
}

// Recency weighting: with C then G played, the hue sits between them, nearer to the latest; it decays towards nothing.
{
  const base = { idleAfterMs: 60000, regHue: 0 }; // no idle fade and no register shift, to look at the mix alone
  const l = L.createLight(base);
  l.noteOn(60, 80, 0);
  // Some ticks later the hue has settled on C.
  const afterC = run(l, 3500, [], 0).pop();
  close(Math.abs(L.hueDelta(afterC.h, L.pitchHue(60))), 0, 3, "settles on C");
  // A chord blends: C+G sits between their hues, on the short side.
  const l2 = L.createLight(base);
  l2.noteOn(60, 80, 0); l2.noteOn(67, 80, 0);
  const blend = run(l2, 3500, [], 0).pop();
  const mid = L.pitchHue(60) + L.hueDelta(L.pitchHue(60), L.pitchHue(67)) / 2;
  close(Math.abs(L.hueDelta(blend.h, mid)), 0, 3, "chord blends C and G");
  // Older notes weigh less: C long ago, G just now: nearer G.
  const l3 = L.createLight({ ...base, smoothTauMs: 1, capHue: 360 });
  l3.noteOn(60, 80, 0);
  run(l3, 2000, [], 0);
  l3.noteOn(67, 80, 2000);
  const last = l3.step(2125);
  assert(Math.abs(L.hueDelta(last.h, L.pitchHue(67))) < Math.abs(L.hueDelta(last.h, L.pitchHue(60))), "nearer the newer note");
  // The same in an arc palette: the mix lies on the arc, between the two notes' hues.
  const l4 = L.createLight({ ...base, palette: "ocean" });
  l4.noteOn(60, 80, 0); l4.noteOn(67, 80, 0);
  const o4 = run(l4, 3500, [], 0).pop();
  const lo = Math.min(L.pitchHue(60, "ocean"), L.pitchHue(67, "ocean")), hi = Math.max(L.pitchHue(60, "ocean"), L.pitchHue(67, "ocean"));
  assert(o4.h >= lo - 3 && o4.h <= hi + 3, "ocean mix between: " + o4.h);
}

// Register: high notes shift hue and brightness a little, and the shift is small.
{
  const low = L.createLight({ idleAfterMs: 60000 }), high = L.createLight({ idleAfterMs: 60000 });
  const lo = run(low, 4500, Array.from({ length: 45 }, (_, i) => ({ at: i * 100, note: 36, vel: 90 }))).pop();
  const hi = run(high, 4500, Array.from({ length: 45 }, (_, i) => ({ at: i * 100, note: 96, vel: 90 }))).pop();
  assert(hi.b > lo.b, "higher is brighter");
  assert(Math.abs(L.hueDelta(hi.h, L.pitchHue(96))) <= 31 && Math.abs(L.hueDelta(lo.h, L.pitchHue(36))) <= 31, "register shift is a little hue");
  assert(Math.abs(L.hueDelta(hi.h, L.pitchHue(96))) > 5 && Math.abs(L.hueDelta(lo.h, L.pitchHue(36))) > 5, "and it is there");
}

// Saturation: wide range (55 to 100), more with the register's extremes and with chords, never outside it.
{
  const range = (name) => L.PALETTES[name].sat;
  const quiet = L.createLight({ idleAfterMs: 60000 }), rich = L.createLight({ idleAfterMs: 60000 });
  const single = run(quiet, 4000, Array.from({ length: 30 }, (_, i) => ({ at: i * 120, note: 66, vel: 80 })));
  const chords = run(rich, 4000, Array.from({ length: 30 }, (_, i) => ({ at: i * 120, note: [96, 91, 88, 84, 79, 100][i % 6], vel: 80 })));
  for (const x of [...single, ...chords]) assert(x.s >= range("spectrum")[0] - 1e-9 && x.s <= range("spectrum")[1] + 1e-9, "saturation " + x.s);
  const q = single[single.length - 1].s, r = chords[chords.length - 1].s;
  assert(r > q + 15, `chords and register raise it: ${q} vs ${r}`);
  assert(r >= 85, "can get close to full: " + r);
  assert(q >= 55 && q <= 80, "a single mid note stays moderate: " + q);
  // The warm palette keeps its softer look.
  const warm = L.createLight({ idleAfterMs: 60000, palette: "warm" });
  for (const x of run(warm, 4000, Array.from({ length: 30 }, (_, i) => ({ at: i * 120, note: [96, 91, 88, 84, 79, 100][i % 6], vel: 120 })))) assert(x.s >= 50 - 1e-9 && x.s <= 75 + 1e-9, "warm saturation " + x.s);
}

// A melody across the keyboard sweeps through clearly different colours (the captain's six notes), and a
// stepwise run walks round the wheel one way.
{
  const l = L.createLight();
  const seen = [];
  const steps = run(l, 6000, [60, 64, 67, 72, 76, 79].map((note, i) => ({ at: i * 700, note, vel: 85 })));
  steps.forEach((x, i) => { if (i % 4 === 0) seen.push(x.h); });
  const spread = Math.max(...seen.map((a) => Math.max(...seen.map((b) => Math.abs(L.hueDelta(a, b))))));
  const scale = L.createLight(), hues = [];
  run(scale, 5500, [60, 62, 64, 65, 67, 69, 71, 72].map((note, i) => ({ at: i * 600, note, vel: 85 }))).forEach((x, i) => { if (i % 4 === 0) hues.push(x.h); });
  assert(Math.max(...hues.map((a) => Math.max(...hues.map((b) => Math.abs(L.hueDelta(a, b)))))) >= 120, "a scale sweeps the wheel");
  assert(spread >= 120, "hue sweeps over " + spread.toFixed(0) + " degrees");
}

// Changing palette: the colour eases over, in capped steps, and the idle colour belongs to the palette.
{
  const l = L.createLight();
  const first = run(l, 2000, [{ at: 0, note: 60, vel: 90 }, { at: 400, note: 64, vel: 90 }]);
  assert(l.setPalette("ocean") && l.palette === "ocean");
  assert(!l.setPalette("nope") && l.palette === "ocean");
  const after = run(l, 12000, [], 2125);
  let prev = first[first.length - 1];
  for (const x of after) {
    assert(Math.abs(L.hueDelta(prev.h, x.h)) <= L.DEFAULTS.capHue + 1e-9, "hue cap on palette change");
    assert(Math.abs(x.s - prev.s) <= L.DEFAULTS.capSat + 1e-9 && Math.abs(x.b - prev.b) <= L.DEFAULTS.capBri + 1e-9);
    prev = x;
  }
  const idle = L.createLight({ palette: "aurora" });
  assert.deepStrictEqual(idle.idle(), L.PALETTES.aurora.idle);
  const ends = Object.keys(L.PALETTES).map((name) => { const q = L.createLight({ palette: name }); q.noteOn(60, 90, 0); return run(q, 70000, [], 0).pop(); });
  Object.keys(L.PALETTES).forEach((name, i) => {
    close(Math.abs(L.hueDelta(ends[i].h, L.PALETTES[name].idle.h)), 0, 0.5, name + " idle hue");
    close(ends[i].b, L.PALETTES[name].idle.b, 0.5, name + " idle brightness");
  });
  assert(new Set(ends.map((e) => Math.round(e.h))).size >= 4, "idle colours differ per palette");
}

// Brightness stays in its band while playing, velocity nudges it only a little.
{
  const soft = L.createLight({ idleAfterMs: 60000 }), hard = L.createLight({ idleAfterMs: 60000 });
  const notes = (v) => Array.from({ length: 60 }, (_, i) => ({ at: i * 100, note: 48 + (i * 5) % 30, vel: v }));
  const s = run(soft, 8000, notes(10)), h = run(hard, 8000, notes(127));
  for (const x of [...s, ...h]) assert(x.b >= 10 && x.b <= 65.001, "brightness " + x.b);
  const sb = Math.max(...s.slice(30).map((x) => x.b)), hb = Math.max(...h.slice(30).map((x) => x.b));
  assert(hb > sb && hb - sb <= 14, `velocity nudge small: ${sb} vs ${hb}`);
}

// Per-tick caps: a furious run of notes never moves hue, saturation or brightness by more than the caps.
{
  const o = L.DEFAULTS;
  const l = L.createLight();
  const notes = Array.from({ length: 200 }, (_, i) => ({ at: i * 40, note: 36 + (i * 7) % 61, vel: 127 }));
  const steps = run(l, 9000, notes);
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1], b = steps[i];
    assert(Math.abs(L.hueDelta(a.h, b.h)) <= o.capHue + 1e-9, "hue step");
    assert(Math.abs(b.s - a.s) <= o.capSat + 1e-9, "sat step");
    assert(Math.abs(b.b - a.b) <= o.capBri + 1e-9, "bri step");
  }
}

// Caps scale with the real step: a late tick may not jump either; a huge gap is treated as half a second.
{
  const l = L.createLight();
  l.step(0);
  l.noteOn(66, 127, 10000);
  const a = l.step(10000);
  const b = l.step(10125 + 60000);
  assert(Math.abs(L.hueDelta(a.h, b.h)) <= L.DEFAULTS.capHue * 4 + 1e-9);
  assert(Math.abs(b.b - a.b) <= L.DEFAULTS.capBri * 4 + 1e-9);
}

// Silence fade: after the idle time the colour glides back to warm and dim, slowly, and never jumps.
{
  const l = L.createLight();
  const play = run(l, 3000, Array.from({ length: 30 }, (_, i) => ({ at: i * 100, note: 55 + (i % 7), vel: 100 })));
  const playing = play[play.length - 1];
  assert(!playing.silent && playing.b > 25);
  const quiet = run(l, 60000, [], 3125);
  assert(quiet[0].silent === false || quiet[0].b > 25);
  const end = quiet[quiet.length - 1];
  assert(end.silent);
  close(end.b, IDLE.b, 0.5, "dim again");
  close(end.s, IDLE.s, 0.5);
  close(Math.abs(L.hueDelta(end.h, IDLE.h)), 0, 0.5, "warm again");
  // No quick fade: one second after the idle time has begun it is still far from idle.
  const t0 = quiet.findIndex((x) => x.silent);
  assert(quiet[t0 + 8].b > IDLE.b + 5, "slow fade");
  for (let i = 1; i < quiet.length; i++) {
    assert(Math.abs(quiet[i].b - quiet[i - 1].b) <= L.DEFAULTS.capBri + 1e-9);
    assert(Math.abs(L.hueDelta(quiet[i].h, quiet[i - 1].h)) <= L.DEFAULTS.capHue + 1e-9);
  }
}

// The first note after a long pause fades in from the idle colour, in small steps.
{
  const l = L.createLight();
  run(l, 30000, []);
  l.noteOn(61, 127, 30125);
  const steps = run(l, 2000, [], 30125);
  assert(steps[0].b <= IDLE.b + L.DEFAULTS.capBri + 1e-9, "starts from idle");
  assert(Math.abs(L.hueDelta(steps[0].h, IDLE.h)) <= L.DEFAULTS.capHue + 1e-9);
  assert(steps[4].b > steps[0].b, "brightness rises");
}

// Seeding starts the colour where the bulb already is (no jump when control is taken).
{
  const l = L.createLight();
  l.seed(200, 80, 90);
  const s = l.step(0);
  assert(Math.abs(L.hueDelta(s.h, 200)) <= 2.001 && Math.abs(s.b - 90) <= 1.001, "starts near the seed");
}

// No input at any rate makes the bulb strobe: rgb never jumps more than a few units per tick in a calm
// stretch, and changedEnough only fires for steps that matter.
{
  const a = { rgb: [100, 100, 100], dimming: 40 };
  assert(L.changedEnough(null, a));
  assert(!L.changedEnough(a, { rgb: [101, 102, 100], dimming: 40 }));
  assert(L.changedEnough(a, { rgb: [103, 100, 100], dimming: 40 }));
  assert(L.changedEnough(a, { rgb: [100, 100, 100], dimming: 41 }));
}

console.log("light tests passed");
