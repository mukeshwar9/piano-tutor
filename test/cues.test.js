"use strict";
// Room light reward cues: the gold, warm and green envelopes, their order of rank, the 125 ms steps and the
// switch. No network and no clock of its own. Run: node test/cues.test.js
const assert = require("assert");
const L = require("../light.js");
const { createBulb } = require("../bulb.js");

const TICK = L.DEFAULTS.tickMs;
assert.strictEqual(TICK, 125, "the light keeps its 125 ms tick");
const close = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg || ""} ${a} vs ${b}`);

// Envelopes: gold ramps in four ticks, holds for two seconds and eases back over two and a half.
const gold = L.CUES.best;
assert.strictEqual(L.cueWeight(gold, 0, TICK), 0);
close(L.cueWeight(gold, 2 * TICK, TICK), 0.5, 1e-9, "half way up after two ticks");
assert.strictEqual(L.cueWeight(gold, 4 * TICK, TICK), 1);
assert.strictEqual(L.cueWeight(gold, 4 * TICK + 2000, TICK), 1, "held");
assert.strictEqual(L.cueWeight(gold, 4 * TICK + 2000 + 2500, TICK), 0, "gone after the fall");
close(L.cueWeight(gold, 4 * TICK + 2000 + 1250, TICK), 0.5, 1e-9, "half way back");
assert.strictEqual(L.cueLength(gold, TICK), 500 + 2000 + 2500);
// Warm: one tick up, then a three second fade.
const warm = L.CUES.goal;
assert.strictEqual(L.cueWeight(warm, TICK, TICK), 1);
assert.strictEqual(L.cueWeight(warm, TICK + 3000, TICK), 0);
assert.strictEqual(L.cueLength(warm, TICK), TICK + 3000);
// Green: two pulses (three on the third clean pass), each up and down in half a second, with a gap.
const pulseAt = (c, t) => L.cueWeight(c, t, TICK);
assert.strictEqual(pulseAt(L.CUES.clean, 250), 1);
assert.strictEqual(pulseAt(L.CUES.clean, 500 + 100), 0, "between pulses");
assert.strictEqual(pulseAt(L.CUES.clean, 750 + 250), 1, "second pulse peaks");
assert.strictEqual(pulseAt(L.CUES.clean, 1500), 0, "no third pulse");
assert.strictEqual(pulseAt(L.CUES.clean3, 1500 + 250), 1, "the third pulse");
assert.strictEqual(L.cueLength(L.CUES.clean, TICK), 1250);
assert.strictEqual(L.cueLength(L.CUES.clean3, TICK), 2000);
assert.deepStrictEqual(L.CUE_NAMES.slice().sort(), ["best", "clean", "clean3", "goal"]);

// Run a light and read the colour every tick.
function run(light, from, ms, onTick) {
  const out = [];
  for (let t = from; t <= from + ms; t += TICK) { if (onTick) onTick(t); out.push({ t, c: light.step(t) }); }
  return out;
}
const hueNear = (h, target) => Math.abs(L.hueDelta(h, target));

// A cue makes the light move towards its colour and then back to what it was doing.
{
  const l = L.createLight();
  run(l, 0, 5000);
  const idle = l.step(5125);
  assert.strictEqual(idle.cue, "");
  assert(l.cue("best", 5250));
  const steps = run(l, 5250, 5500);
  assert.strictEqual(steps[0].c.cue, "", "no weight yet on the first instant");
  const peak = steps.find((x) => x.t === 5250 + 4 * TICK).c;
  assert.strictEqual(peak.cue, "best");
  close(peak.h, 45, 1e-6, "gold hue");
  close(peak.b, 90, 1e-6, "gold brightness");
  // The ramp is in whole ticks: never more than a quarter of the way in a tick (plus rounding).
  const bs = steps.slice(0, 5).map((x) => x.c.b);
  for (let i = 1; i < bs.length; i++) assert(bs[i] - bs[i - 1] <= (90 - idle.b) / 4 + 1e-6, "ramp step " + i);
  const end = steps[steps.length - 1].c;
  assert.strictEqual(end.cue, "", "over after five seconds");
  close(end.b, idle.b, 1.5, "back to the idle glow");
}

// Rank: gold over warm over green. A lower cue during a higher one is dropped; a higher replaces a lower.
{
  const l = L.createLight();
  assert.strictEqual(l.cue("nonsense", 0), false);
  assert(l.cue("clean", 0));
  assert(l.cue("goal", 100), "warm replaces green");
  assert.strictEqual(l.cue("clean", 200), false, "green is dropped during warm");
  assert(l.cue("best", 300), "gold replaces warm");
  assert.strictEqual(l.cue("goal", 400), false, "warm is dropped during gold");
  assert.strictEqual(l.cue("clean3", 500), false);
  assert.strictEqual(l.cue("goal", 300 + 5000), true, "the gold wash is over");
  assert(l.cue("clean", 300 + 5000 + 3125), "and so is the warm fade");
  assert(l.cue("clean3", 300 + 5000 + 3125 + 10), "the same rank starts again");
}

// Green pulses: two bright moments, with the light back at the base colour between them.
{
  const l = L.createLight();
  run(l, 0, 6000);
  l.cue("clean", 6250);
  const s = run(l, 6250, 1500);
  const at = (ms) => s.find((x) => x.t === 6250 + ms).c;
  assert.strictEqual(at(250).cue, "clean");
  assert(hueNear(at(250).h, 135) < 1e-6);
  assert.strictEqual(at(625).cue, "", "between the pulses");
  assert(at(1000).cue === "clean");
  assert.strictEqual(at(1500).cue, "");
}

// Through the bulb: a cue takes it over, goes out at most once per 125 ms tick, and the switch turns cues off.
function rig(opts = {}) {
  const sent = [];
  let t = 1000, handler = () => {};
  const pilot = { state: true, r: 255, g: 255, b: 255, dimming: 20 };
  const transport = {
    send(msg) { sent.push({ t, msg }); handler(msg.method === "getPilot" ? { method: "getPilot", result: pilot } : { method: "setPilot", result: { success: true } }); },
    onMessage(fn) { handler = fn; }, close() {},
  };
  const bulb = createBulb({ host: "192.0.2.10", transport, now: () => t, schedule: () => {}, ...opts });
  return { bulb, sent, at: () => t, advance(ms) { for (let i = 0; i < ms / TICK; i++) { t += TICK; bulb.tick(t); } }, sets: () => sent.filter((x) => x.msg.method === "setPilot") };
}
{
  const r = rig();
  r.bulb.tick(r.at());
  assert.strictEqual(r.bulb.info().cues, true, "cues are on by default");
  assert.strictEqual(r.bulb.cue("best"), true);
  r.advance(6000);
  const sets = r.sets();
  assert(sets.length >= 8, "the wash was sent as colour steps");
  assert(sets.some((x) => x.msg.params.dimming >= 85), "up to the gold brightness");
  assert(sets.some((x) => Math.abs(x.msg.params.r - 255) < 40 && x.msg.params.g > 150 && x.msg.params.b < 80), "gold: red and green high, blue low");
  const times = sets.map((x) => x.t);
  for (let i = 1; i < times.length; i++) assert(times[i] - times[i - 1] >= TICK, "never faster than the tick");
}
// Switched off: a cue is refused and the bulb never goes bright or gold.
{
  const r = rig({ cues: false });
  r.bulb.tick(r.at());
  assert.strictEqual(r.bulb.info().cues, false);
  assert.strictEqual(r.bulb.cue("best"), false);
  r.advance(6000);
  assert(r.sets().every((x) => x.msg.params.dimming < 40), "no gold wash");
  assert.strictEqual(r.bulb.setCues(true).cues, true);
  assert.strictEqual(r.bulb.cue("best"), true);
  r.advance(1000);
  assert(r.sets().some((x) => x.msg.params.dimming >= 85), "on again: the wash shows");
  assert.strictEqual(r.bulb.setCues(false).cues, false);
  assert.strictEqual(r.bulb.cue("goal"), false, "refused again once off");
}
// A bulb that is off, or not configured, shows no cue.
{
  const r = rig({ enabled: false });
  assert.strictEqual(r.bulb.cue("best"), false);
  assert.strictEqual(createBulb({ host: "", now: () => 0 }).cue("best"), false);
}
// A cue that arrives while a rarer one is still showing is not queued behind it.
{
  const r = rig();
  r.bulb.tick(r.at());
  assert.strictEqual(r.bulb.cue("best"), true);
  r.advance(500);
  assert.strictEqual(r.bulb.cue("clean"), false);
}

console.log("cues tests passed");
