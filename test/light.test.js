"use strict";
// Room light colour: pitch to hue, recency weighting, easing and per-tick caps, idle fade. Run: node test/light.test.js
const assert = require("assert");
const L = require("../light.js");

const TICK = 125;
const close = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg || ""} ${a} vs ${b}`);

// Pitch to hue: octaves agree, neighbours on the circle of fifths are 30 degrees apart, twelve notes are all distinct.
assert.strictEqual(L.pitchHue(60), L.pitchHue(72));
close(Math.abs(L.hueDelta(L.pitchHue(60), L.pitchHue(67))), 30, 1e-9, "C to G");
close(Math.abs(L.hueDelta(L.pitchHue(60), L.pitchHue(65))), 30, 1e-9, "C to F");
assert(Math.abs(L.hueDelta(L.pitchHue(60), L.pitchHue(61))) >= 150, "C and C# are far apart");
assert.strictEqual(new Set(Array.from({ length: 12 }, (_, i) => L.pitchHue(60 + i))).size, 12);
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
  const l = L.createLight({ idleAfterMs: 60000 }); // no idle fade, to look at the target alone
  l.noteOn(60, 80, 0);
  const a = l.step(0);
  assert(a.h !== undefined);
  // Many ticks later the hue has settled on C.
  const afterC = run(l, 8000, [], 125).pop();
  close(Math.abs(L.hueDelta(afterC.h, L.pitchHue(60))), 0, 3, "settles on C");
  // Now G: first the colour moves towards G, a chord C+G blends in between.
  const l2 = L.createLight({ idleAfterMs: 60000 });
  l2.noteOn(60, 80, 0); l2.noteOn(67, 80, 0);
  const blend = run(l2, 8000, [], 0).pop();
  const mid = L.pitchHue(60) + 15;
  close(Math.abs(L.hueDelta(blend.h, mid)), 0, 3, "chord blends C and G");
  // Older notes weigh less: C long ago, G just now: nearer G.
  const l3 = L.createLight({ idleAfterMs: 60000, smoothTauMs: 1, capHue: 360 });
  l3.noteOn(60, 80, 0);
  run(l3, 4000, [], 0);
  l3.noteOn(67, 80, 4000);
  const last = l3.step(4125);
  assert(Math.abs(L.hueDelta(last.h, L.pitchHue(67))) < Math.abs(L.hueDelta(last.h, L.pitchHue(60))), "nearer the newer note");
}

// Brightness stays in its band while playing, velocity nudges it only a little.
{
  const soft = L.createLight({ idleAfterMs: 60000 }), hard = L.createLight({ idleAfterMs: 60000 });
  const notes = (v) => Array.from({ length: 60 }, (_, i) => ({ at: i * 100, note: 48 + (i * 5) % 30, vel: v }));
  const s = run(soft, 8000, notes(10)), h = run(hard, 8000, notes(127));
  for (const x of [...s, ...h]) assert(x.b >= 10 && x.b <= 65.001, "brightness " + x.b);
  const sb = Math.max(...s.slice(30).map((x) => x.b)), hb = Math.max(...h.slice(30).map((x) => x.b));
  assert(hb > sb && hb - sb <= 14, `velocity nudge small: ${sb} vs ${hb}`);
  for (const x of h.slice(40)) { assert(x.s >= 50 - 1e-9 && x.s <= 70 + 1e-9, "saturation " + x.s); }
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
  close(end.b, L.DEFAULTS.idle.b, 0.5, "dim again");
  close(end.s, L.DEFAULTS.idle.s, 0.5);
  close(Math.abs(L.hueDelta(end.h, L.DEFAULTS.idle.h)), 0, 0.5, "warm again");
  // No quick fade: one second after the idle time has begun it is still far from idle.
  const t0 = quiet.findIndex((x) => x.silent);
  assert(quiet[t0 + 8].b > L.DEFAULTS.idle.b + 5, "slow fade");
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
  assert(steps[0].b <= L.DEFAULTS.idle.b + L.DEFAULTS.capBri + 1e-9, "starts from idle");
  assert(Math.abs(L.hueDelta(steps[0].h, L.DEFAULTS.idle.h)) <= L.DEFAULTS.capHue + 1e-9);
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
