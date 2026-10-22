// Light effects: settings, the frame-rate governor, the particle pool, chord sharing. Run: node test/piano-fx.test.js
const assert = require("assert");
const F = require("../public/piano-fx.js");

// Settings: Lite is the default, presets and layer lists parse, anything unreadable is Lite.
assert.strictEqual(F.parseSetting(null).preset, "lite");
assert.strictEqual(F.parseSetting("").preset, "lite");
assert.strictEqual(F.parseSetting("garbage").preset, "lite", "an unreadable setting is the default");
assert.strictEqual(F.parseSetting("off").on, false);
assert.strictEqual(F.parseSetting("OFF").value, "off");
const lite = F.parseSetting("lite");
assert(lite.lite && lite.on && lite.layers.neon && lite.layers.sparks && lite.layers.keys && !lite.layers.aurora, "Lite: neon on the sounding bar, sparks, key light, no Aurora");
const all = F.parseSetting("neon,sparks,aurora,keys");
assert.strictEqual(all.preset, "all");
assert(!all.lite && all.layers.aurora);
assert.strictEqual(F.parseSetting("all").value, "neon,sparks,aurora,keys", "preset ids are accepted");
assert.strictEqual(F.parseSetting("neon").value, "neon,sparks,keys");
const custom = F.parseSetting("sparks, aurora ,bogus");
assert.strictEqual(custom.value, "sparks,aurora", "unknown layers drop out, the rest keep their canonical order");
assert.strictEqual(custom.preset, "custom");
assert.strictEqual(F.parseSetting("aurora,sparks").value, "sparks,aurora");
assert.strictEqual(F.parseSetting("bogus,more").preset, "lite", "a list with no layer in it is the default");
assert(F.isSetting("off") && F.isSetting("lite") && F.isSetting("neon") && F.isSetting("sparks,aurora"));
assert(!F.isSetting("") && !F.isSetting("nope") && !F.isSetting("sparks,nope"));
F.PRESETS.forEach((p) => assert.strictEqual(F.parseSetting(p.value).preset, p.id, p.id + " round trips"));
// The cycle: Off, Lite, Neon + Sparks, All, round again; a custom list goes to Lite.
assert.deepStrictEqual([F.nextSetting("off"), F.nextSetting("lite"), F.nextSetting("neon"), F.nextSetting("all")], ["lite", "neon,sparks,keys", "neon,sparks,aurora,keys", "off"]);
assert.strictEqual(F.nextSetting("sparks"), "lite");
assert.strictEqual(F.presetName("neon"), "Neon + Sparks");
assert.strictEqual(F.presetName("sparks"), "Custom");

// Intensity 0-100.
assert.strictEqual(F.parseIntensity(null), F.DEFAULT_INTENSITY);
assert.strictEqual(F.parseIntensity("abc"), F.DEFAULT_INTENSITY);
assert.strictEqual(F.parseIntensity(""), F.DEFAULT_INTENSITY);
assert.strictEqual(F.parseIntensity("40"), 40);
assert.strictEqual(F.parseIntensity("0"), 0);
assert.strictEqual(F.parseIntensity(150), 100);
assert.strictEqual(F.parseIntensity(-5), 0);
assert.strictEqual(F.parseIntensity(33.6), 34);

// Velocity: MIDI 1-127 to 0-1; the microphone (and a missing velocity) is 0.7.
assert.strictEqual(F.velocity01(127), 1);
assert.strictEqual(F.velocity01(64, false), 64 / 127);
assert.strictEqual(F.velocity01(100, true), 0.7, "mic mode ignores the number");
assert.strictEqual(F.velocity01(undefined, false), 0.7);
assert.strictEqual(F.velocity01(0), 0.7);
assert(F.velocity01(1) >= 0.05);

// Chords share one budget: 1/sqrt(n).
assert.strictEqual(F.chordShare(1), 1);
assert.strictEqual(F.chordShare(0), 1);
assert.strictEqual(F.chordShare(undefined), 1);
assert(Math.abs(F.chordShare(4) - 0.5) < 1e-9);
assert(Math.abs(F.chordShare(9) - 1 / 3) < 1e-9);
for (let n = 1; n < 10; n++) assert(n * F.chordShare(n) <= Math.sqrt(10) * Math.sqrt(n) + 1e-9 && F.chordShare(n + 1) < F.chordShare(n), "a bigger chord has less per note, more in total");
assert(4 * F.chordShare(4) > 1 * F.chordShare(1), "four notes still shine brighter than one");

// Governor: slow frames for 1.5 s step down one level, fast frames for 8 s step back up.
{
  const g = F.createGovernor();
  assert.strictEqual(g.level, 0);
  for (let t = 0; t < 1400; t += 16.7) g.step(16.7);
  assert.strictEqual(g.level, 0, "smooth frames never step down");
  let slow = 0;
  while (g.level === 0 && slow < 20000) { g.step(45); slow += 45; }
  assert.strictEqual(g.level, 1);
  assert(slow > F.SLOW_HOLD_MS && slow < F.SLOW_HOLD_MS + 1500, "steps down after 1.5 s of slow frames (plus the average catching up), not at once: " + slow);
  while (g.level < F.MAX_LEVEL) g.step(45);
  for (let i = 0; i < 400; i++) g.step(45);
  assert.strictEqual(g.level, F.MAX_LEVEL, "it never goes past the last level");
  // Back up: 16 ms frames. The average falls under 24 ms quickly, then 8 s must pass.
  let fast = 0;
  while (g.level === F.MAX_LEVEL && fast < 60000) { g.step(16); fast += 16; }
  assert.strictEqual(g.level, F.MAX_LEVEL - 1);
  assert(fast >= F.FAST_HOLD_MS && fast < F.FAST_HOLD_MS + 1000, "steps up after 8 s of fast frames: " + fast);
  for (let i = 0; i < 5000; i++) g.step(16);
  assert.strictEqual(g.level, 0, "and keeps stepping up while it stays fast");
  // A spell in between (24-34 ms) holds the level and restarts both clocks.
  g.reset();
  while (g.level === 0) g.step(45);
  for (let i = 0; i < 100; i++) g.step(29);
  assert.strictEqual(g.level, 1, "in between holds the level");
  g.reset();
  assert.strictEqual(g.level, 0);
}
// One slow frame does not move the governor (a GC pause or a tab switch).
{
  const g = F.createGovernor();
  for (let i = 0; i < 100; i++) g.step(16.7);
  g.step(300); for (let i = 0; i < 50; i++) g.step(16.7);
  assert.strictEqual(g.level, 0);
}

// Particle pool: never past its cap, never past the governor's limit, slots come back when particles die.
{
  const pool = F.createPool(100);
  let taken = 0;
  for (let i = 0; i < 500; i++) if (pool.emit(10, 10, 0, -50, 1, 5, 0)) taken++;
  assert.strictEqual(taken, 100, "the pool holds at most its cap");
  assert.strictEqual(pool.live, 100);
  pool.step(0.5, 1);
  assert.strictEqual(pool.live, 100, "half way through their life");
  pool.step(0.6, 1);
  assert.strictEqual(pool.live, 0, "all dead after their life");
  for (let i = 0; i < 100; i++) assert(pool.emit(0, 0, 0, 0, 1, 1, 1), "dead slots are reused");
  pool.clear();
  assert.strictEqual(pool.live, 0);
  // The governor's level 2 lowers the limit to 35%.
  pool.setLimit(0.35);
  assert.strictEqual(pool.limit, 35);
  taken = 0;
  for (let i = 0; i < 100; i++) if (pool.emit(0, 0, 0, 0, 1, 1, 0)) taken++;
  assert.strictEqual(taken, 35);
  pool.setLimit(1);
  assert(pool.emit(0, 0, 0, 0, 1, 1, 0), "the limit comes back up");
  // Particles rise (negative y velocity plus buoyancy) and keep inside the pool arrays.
  const p2 = F.createPool(4);
  p2.emit(50, 100, 0, -100, 2, 5, 0);
  p2.step(0.1, 1);
  assert(p2.p[1] < 100, "a spark moves up");
  // The default pool size is the report's 600.
  assert.strictEqual(F.createPool().cap, 600);
  // Heavy use never overruns: emit and step for a long time.
  const p3 = F.createPool(F.POOL_CAP);
  for (let f = 0; f < 600; f++) { for (let i = 0; i < 20; i++) p3.emit(5, 5, 10, -100, 0.6 + Math.random(), 4, i & 1); p3.step(1 / 60, 1); assert(p3.live <= p3.cap); }
}

// Envelope: fast attack, settles to 60% while held, a short fade after release.
{
  const s = { on: true, t0: 1000, tOff: 0 };
  assert.strictEqual(F.envelope(null, 0), 0);
  assert.strictEqual(F.envelope(s, 1000), 0);
  assert(Math.abs(F.envelope(s, 1040) - 1) < 1e-9, "full after 40 ms");
  assert(F.envelope(s, 5000) > 0.6 && F.envelope(s, 5000) < 0.61, "settles to 60%");
  s.on = false; s.tOff = 5000;
  assert(F.envelope(s, 5130) < F.envelope(s, 5000) * 0.4, "about a third gone after 130 ms");
  assert.strictEqual(F.envelope(s, 5500), 0);
}

// Palettes follow the room light's: an unknown name is Spectrum, and the arcs differ.
assert.deepStrictEqual(F.paletteRgb("nope", 3), F.paletteRgb("spectrum", 3));
assert.notDeepStrictEqual(F.paletteRgb("ocean", 0), F.paletteRgb("sunset", 0));
for (const name of Object.keys(F.PALETTES)) for (let pc = 0; pc < 12; pc++) F.paletteRgb(name, pc).forEach((v) => assert(v >= 0 && v <= 255 && Number.isInteger(v)));

// Key press depth: follows velocity, monotonic, always visible, the microphone's mid depth is fixed.
{
  let prev = -1;
  for (let v = 7; v <= 127; v++) { const d = F.pressDepth(F.velocity01(v, false)); assert(d > prev, "deeper for a harder key"); prev = d; assert(d >= 0.12 && d <= 1); }
  assert(F.pressDepth(F.velocity01(1, false)) >= 0.12, "the softest touch still dips");
  assert(F.pressDepth(1) <= 1 && Math.abs(F.pressDepth(1) - 1) < 1e-9, "full velocity is full depth");
  assert(F.pressDepth(F.velocity01(110)) > 1.7 * F.pressDepth(F.velocity01(25)), "soft and hard are clearly different");
  assert.strictEqual(F.pressDepth(F.velocity01(100, true)), F.pressDepth(F.MIC_VELOCITY), "the microphone is a fixed mid depth");
  assert.strictEqual(F.pressDepth(undefined), F.pressDepth(F.MIC_VELOCITY));
  assert.strictEqual(F.pressDepth(5), F.pressDepth(1), "above 1 is clamped");
  // Going down and springing back.
  const on = { on: true, t0: 1000, tOff: 0 };
  assert.strictEqual(F.sinkAmount(null, 0), 0);
  assert.strictEqual(F.sinkAmount(on, 1000), 0);
  assert(F.sinkAmount(on, 1020) > 0.5 && F.sinkAmount(on, 1020) < 1, "on its way down");
  assert.strictEqual(F.sinkAmount(on, 1045), 1);
  assert.strictEqual(F.sinkAmount(on, 9000), 1, "stays down while held");
  const off = { on: false, t0: 1000, tOff: 2000 };
  assert.strictEqual(F.sinkAmount(off, 2000), 1);
  assert(F.sinkAmount(off, 2060) < 0.7 && F.sinkAmount(off, 2060) > 0.3, "springs back");
  assert.strictEqual(F.sinkAmount(off, 2401), 0);
  const quick = { on: false, t0: 1000, tOff: 1010 };
  assert(F.sinkAmount(quick, 1010) < 0.5, "a tap released early only went part way down");
}

// The effects object with a fake canvas context: Off draws nothing, a wrong key gets red light and no sparks,
// suspending (calibration) draws nothing, and Lite stays inside the pool cap.
{
  global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(v) {} }) }) };
  let draws = 0;
  const ctx = { drawImage() { draws++; }, fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, set globalAlpha(v) {}, set globalCompositeOperation(v) {}, set fillStyle(v) {} };
  const P = require("../public/piano-core.js");
  const layout = P.keyLayout(P.defaultCalibration(1920));
  const fx = F.create(ctx);
  fx.setSetting("off");
  fx.layout(layout, 900, 894, 0, 100, 1920, 1080);
  assert(!fx.active);
  fx.noteOn(60, 0.8, "right", "player", 1, 1000); fx.step(16, 1000); fx.drawFront(1000);
  assert.strictEqual(draws, 0, "Off draws nothing");
  assert.strictEqual(fx.pool.live, 0);
  assert.strictEqual(fx.keyLook(60, layout.keys[60], "#fff", false, 1000), null);
  fx.setSetting("lite");
  assert(fx.active);
  fx.noteOn(60, 0.8, "right", "player", 1, 1000);
  assert(fx.pool.live > 0, "a played key throws sparks");
  const sparks = fx.pool.live;
  fx.noteOn(62, 0.8, "right", "wrong", 1, 1000);
  assert.strictEqual(fx.pool.live, sparks, "a wrong key throws none");
  const lk = fx.keyLook(62, layout.keys[62], "#e9edf3", false, 1020);
  assert(lk && lk.sink > 0, "a pressed key sinks");
  // The dip follows the velocity: a hard key sinks deeper than a soft one, the microphone sits between, a tutor-lit key does not sink.
  fx.reset();
  fx.noteOn(60, F.velocity01(20), "right", "player", 1, 1000); fx.noteOn(62, F.velocity01(120), "right", "player", 1, 1000); fx.noteOn(64, F.velocity01(0, true), "right", "player", 1, 1000);
  const soft = fx.keyLook(60, layout.keys[60], "#e9edf3", false, 1100).sink, hard = fx.keyLook(62, layout.keys[62], "#e9edf3", false, 1100).sink, mic = fx.keyLook(64, layout.keys[64], "#e9edf3", false, 1100).sink;
  assert(soft > 0 && soft < mic && mic < hard, "soft < microphone < hard");
  fx.noteOff && fx.noteOff(62, 1200);
  assert(fx.keyLook(62, layout.keys[62], "#e9edf3", false, 1300) === null || fx.keyLook(62, layout.keys[62], "#e9edf3", false, 1300).sink < hard, "it springs back after release");
  assert.strictEqual(fx.keyLook(61, layout.keys[61], "#e9edf3", false, 1100), null, "a key nobody played is untouched (a tutor-lit key is the page's own fill)");
  fx.reset(); fx.noteOn(62, 0.8, "right", "wrong", 1, 1000); fx.noteOn(60, 0.8, "right", "player", 1, 1000);
  const music = (fx.noteOn(64, 0.7, "left", "music", 1, 1000), fx.keyLook(64, layout.keys[64], "#fff", false, 1050));
  assert(music && music.sink === 0 && music.rim, "a Hear it first key has a rim and does not sink");
  assert.strictEqual(fx.keyLook(62, layout.keys[62], "#3ddc84", true, 1020).fill, "#3ddc84", "a judgement colour wins over the hand colour");
  fx.drawFront(1020);
  assert(draws > 0, "Lite draws");
  // Chord sharing: nine keys together throw fewer sparks per key than one key alone.
  fx.reset();
  fx.noteOn(60, 1, "right", "player", 1, 2000); const one = fx.pool.live;
  fx.reset();
  for (let i = 0; i < 9; i++) fx.noteOn(60 + i, 1, "right", "player", 9, 2000);
  assert(fx.pool.live / 9 < one, "a chord shares one spark budget");
  assert(fx.pool.live > one, "but still shows more than one note");
  // Hear it first throws half the sparks.
  fx.reset(); fx.noteOn(60, 1, "right", "music", 1, 2000); const heard = fx.pool.live;
  assert(heard < one && heard > 0, "Hear it first: fewer sparks");
  // The pool cap holds under a flood of notes.
  for (let i = 0; i < 400; i++) fx.noteOn(36 + (i % 61), 1, "right", "player", 1, 3000);
  assert(fx.pool.live <= F.POOL_CAP);
  // With the governor off (?nogov) slow frames never step the effects down.
  fx.setGovernor(false);
  for (let i = 0; i < 300; i++) fx.step(60, 5000 + i * 60);
  assert.strictEqual(fx.gov.level, 0, "no stepping down without the governor");
  assert(!fx.governed);
  fx.setGovernor(true);
  for (let i = 0; i < 300; i++) fx.step(60, 30000 + i * 60);
  assert(fx.gov.level > 0, "and with it, slow frames step down");
  fx.setSetting("lite");   // a changed setting starts again from the full level
  fx.setSetting("off"); fx.setSetting("lite");
  assert.strictEqual(fx.gov.level, 0);
  // Calibration suspends the effects and clears what is on screen.
  fx.suspend(true);
  assert(!fx.active && fx.pool.live === 0);
  draws = 0; fx.drawFront(3000);
  assert.strictEqual(draws, 0);
  fx.suspend(false);
  assert(fx.active);
  // Intensity 0 still works (no sparks, since the count scales with it).
  fx.setIntensity(0); fx.reset(); fx.noteOn(60, 1, "right", "player", 1, 4000);
  assert.strictEqual(fx.pool.live, 0, "intensity 0 throws no sparks");
}

console.log("piano-fx.test.js passed");
