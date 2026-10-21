"use strict";
// The room light's bulb with a fake UDP sender: taking control, rate, on/off and restore, unreachable bulb.
// No network is used. Run: node test/bulb.test.js
const assert = require("assert");
const { createBulb, restoreParams } = require("../bulb.js");

// Restore parameters for each way a bulb can be set.
assert.deepStrictEqual(restoreParams({ state: false, r: 5, g: 5, b: 5, dimming: 30 }), { state: false });
assert.deepStrictEqual(restoreParams({ state: true, r: 10, g: 20, b: 30, c: 0, w: 0, dimming: 55 }), { state: true, r: 10, g: 20, b: 30, c: 0, w: 0, dimming: 55 });
assert.deepStrictEqual(restoreParams({ state: true, temp: 2700, dimming: 80 }), { state: true, temp: 2700, dimming: 80 });
assert.deepStrictEqual(restoreParams({ state: true, sceneId: 12, dimming: 70 }), { state: true, sceneId: 12, dimming: 70 });
assert.deepStrictEqual(restoreParams(null), { state: false });

// A fake bulb on a fake clock.
function rig(opts = {}) {
  const sent = [], later = [];
  let t = 1000, handler = () => {}, online = true;
  const pilot = opts.pilot || { state: true, r: 255, g: 255, b: 255, dimming: 100 };
  const changes = [];
  const transport = {
    send(msg) {
      sent.push({ t, msg });
      if (!online) return;
      if (msg.method === "getPilot") handler({ method: "getPilot", result: pilot });
      else handler({ method: "setPilot", result: { success: true } });
    },
    onMessage(fn) { handler = fn; },
    close() {},
  };
  const bulb = createBulb({ host: "192.0.2.10", transport, now: () => t, schedule: (fn, ms) => later.push({ fn, ms }), onChange: (i) => changes.push(i.status), ...opts });
  return {
    bulb, sent, later, changes,
    at: () => t,
    setOnline: (v) => { online = v; },
    advance(ms) { for (let i = 0; i < ms / 125; i++) { t += 125; bulb.tick(t); } },
    setPilots: () => sent.filter((s) => s.msg.method === "setPilot"),
    getPilots: () => sent.filter((s) => s.msg.method === "getPilot"),
  };
}

// No host: the feature does nothing and says so.
{
  const b = createBulb({ host: "", now: () => 0 });
  b.noteOn(60, 90); b.tick(0); b.start(); b.stop();
  assert.deepStrictEqual(b.info(), { enabled: true, configured: false, status: "no-bulb" });
}

// Before a note nothing is changed on the bulb: it is only asked for its state, rarely.
{
  const r = rig();
  r.bulb.tick(r.at());
  assert.strictEqual(r.getPilots().length, 1);
  assert.strictEqual(r.bulb.info().status, "ready");
  r.advance(10000);
  assert.strictEqual(r.setPilots().length, 0);
  assert.strictEqual(r.getPilots().length, 1, "probe at a low rate");
}

// First note: state is read, then colour is sent, starting near the bulb's own colour, in small steps, at most 8 a second.
{
  const r = rig();
  r.bulb.tick(r.at());
  r.bulb.noteOn(60, 90);
  r.advance(125);
  assert.strictEqual(r.bulb.info().status, "active");
  r.advance(6000);
  const sets = r.setPilots();
  assert(sets.length > 5, "colour is being sent");
  const first = sets[0].msg.params;
  assert.strictEqual(first.state, true);
  assert(first.dimming >= 90, "starts near the bulb's own brightness, no jump: " + first.dimming);
  for (let i = 1; i < sets.length; i++) {
    assert(sets[i].t - sets[i - 1].t >= 125, "rate");
    assert(Math.abs(sets[i].msg.params.dimming - sets[i - 1].msg.params.dimming) <= 3, "brightness steps");
  }
  assert(sets.length <= 6125 / 125 + 1);
  const p = sets[sets.length - 1].msg.params;
  assert(p.dimming >= 10 && p.dimming <= 100 && [p.r, p.g, p.b].every((x) => x >= 0 && x <= 255));
}

// Silence: nothing is sent once the glow has settled, and the colour has faded to warm and dim.
{
  const r = rig({ releaseAfterMs: 0 });
  r.bulb.tick(r.at());
  r.bulb.noteOn(60, 90);
  r.advance(3000);
  r.advance(120000);
  const last = r.setPilots().pop().msg.params;
  assert(last.dimming <= 12 && last.r > last.b, "warm and low: " + JSON.stringify(last));
  const n = r.setPilots().length;
  r.advance(10000);
  assert.strictEqual(r.setPilots().length, n, "settled: no more sends");
}

// Off: sending stops and the bulb is restored to what it was before control; repeated for lost packets.
{
  const pilot = { state: true, r: 12, g: 34, b: 56, c: 0, w: 0, dimming: 77 };
  const r = rig({ pilot });
  r.bulb.tick(r.at());
  r.bulb.noteOn(64, 100);
  r.advance(2000);
  const before = r.sent.length;
  r.bulb.setEnabled(false);
  const restore = r.sent[before];
  assert.deepStrictEqual(restore.msg, { method: "setPilot", params: { state: true, r: 12, g: 34, b: 56, c: 0, w: 0, dimming: 77 } });
  assert.strictEqual(r.later.length, 2, "restore is repeated");
  r.later.forEach((x) => x.fn());
  assert.strictEqual(r.sent.slice(before).filter((s) => s.msg.method === "setPilot").length, 3);
  const n = r.sent.length;
  r.bulb.noteOn(64, 100);
  r.advance(5000);
  assert.strictEqual(r.sent.length, n, "off: nothing is sent at all");
  assert.strictEqual(r.bulb.info().status, "off");
  assert.strictEqual(r.bulb.info().enabled, false);
}

// Off while the bulb was off before: restored to off. On again: resumes, reading the state afresh.
{
  const r = rig({ pilot: { state: false, dimming: 40 } });
  r.bulb.tick(r.at());
  r.bulb.noteOn(60, 90);
  r.advance(1000);
  assert.strictEqual(r.setPilots()[0].msg.params.state, true);
  const before = r.sent.length;
  r.bulb.setEnabled(false);
  assert.deepStrictEqual(r.sent[before].msg, { method: "setPilot", params: { state: false } });
  r.bulb.setEnabled(true);
  assert.strictEqual(r.bulb.info().status, "searching");
  r.advance(250);
  r.bulb.noteOn(62, 90);
  r.advance(1000);
  assert.strictEqual(r.bulb.info().status, "active");
  assert(r.setPilots().length > 2);
}

// Off before any control: nothing to restore and nothing sent.
{
  const r = rig();
  r.bulb.setEnabled(false);
  assert.strictEqual(r.sent.length, 0);
  assert.strictEqual(r.later.length, 0);
}

// Released after a long silence: the bulb is given back as it was.
{
  const r = rig({ pilot: { state: true, temp: 2700, dimming: 60 }, releaseAfterMs: 20000 });
  r.bulb.tick(r.at());
  r.bulb.noteOn(60, 90);
  r.advance(2000);
  r.advance(40000);
  const sets = r.setPilots();
  assert.deepStrictEqual(sets[sets.length - 1].msg.params, { state: true, temp: 2700, dimming: 60 });
  assert.strictEqual(r.bulb.info().status, "ready");
  const n = r.sent.length;
  r.advance(5000);
  assert.strictEqual(r.setPilots().length, sets.length, "no more colour after release");
}

// Unreachable bulb: never throws, status says not found, retries only at the low rate; comes back by itself.
{
  const r = rig();
  r.setOnline(false);
  assert.doesNotThrow(() => { r.bulb.tick(r.at()); r.bulb.noteOn(60, 90); });
  assert.strictEqual(r.bulb.info().status, "searching");
  r.advance(5000);
  assert.strictEqual(r.bulb.info().status, "not-found");
  const sentSoFar = r.sent.length;
  r.advance(60000);
  assert.strictEqual(r.setPilots().length, 0, "no colour sent to a bulb that is not there");
  assert(r.sent.length - sentSoFar <= 5, "probes are rare: " + (r.sent.length - sentSoFar));
  r.setOnline(true);
  r.advance(20000);
  assert.strictEqual(r.bulb.info().status, "active", "found again and following");
  assert(r.setPilots().length > 0);
}

// A bulb that disappears mid-song stops the stream, then resumes and still restores the first state.
{
  const pilot = { state: true, r: 1, g: 2, b: 3, dimming: 44 };
  const r = rig({ pilot });
  r.bulb.tick(r.at());
  r.bulb.noteOn(60, 90);
  r.advance(2000);
  r.setOnline(false);
  r.advance(6000);
  assert.strictEqual(r.bulb.info().status, "not-found");
  const n = r.setPilots().length;
  r.advance(5000);
  assert(r.setPilots().length - n <= 1);
  r.setOnline(true);
  r.bulb.noteOn(62, 90);
  r.advance(20000);
  assert.strictEqual(r.bulb.info().status, "active");
  const before = r.sent.length;
  r.bulb.setEnabled(false);
  assert.deepStrictEqual(r.sent[before].msg.params, { state: true, r: 1, g: 2, b: 3, dimming: 44 });
}

// Status changes are reported once each; a throwing listener cannot hurt.
{
  const r = rig({ onChange: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => { r.bulb.tick(r.at()); r.bulb.noteOn(60, 90); r.advance(1000); r.bulb.setEnabled(false); });
}
{
  const r = rig();
  r.bulb.tick(r.at());
  r.bulb.noteOn(60, 90);
  r.advance(1000);
  assert.deepStrictEqual(r.changes, ["ready", "active"]);
}

console.log("bulb tests passed");

// ---- nc transport with a fake spawn ----
{
  const { jsonSplitter, ncTransport } = require("../bulb.js");
  const { EventEmitter } = require("events");

  // Replies split anywhere, joined together, with braces in strings.
  const sp = jsonSplitter();
  assert.deepStrictEqual(sp.push('{"a":1}{"b":{"c":2}}'), [{ a: 1 }, { b: { c: 2 } }]);
  assert.deepStrictEqual(sp.push('{"method":"getPi'), []);
  assert.deepStrictEqual(sp.push('lot","result":{"x":"}{\\"}"}}\n{"z"'), [{ method: "getPilot", result: { x: '}{"}' } }]);
  assert.deepStrictEqual(sp.push(':3}'), [{ z: 3 }]);
  assert.deepStrictEqual(sp.push("junk {bad json} {\"ok\":true}"), [{ ok: true }], "garbage is skipped");

  const children = [], timers = [];
  const fakeSpawn = (bin, args) => {
    const c = new EventEmitter();
    c.bin = bin; c.args = args; c.written = []; c.killed = false;
    c.stdin = Object.assign(new EventEmitter(), { writable: true, write: (d) => c.written.push(d) });
    c.stdout = new EventEmitter();
    c.kill = () => { c.killed = true; };
    children.push(c);
    return c;
  };
  const t = ncTransport("192.0.2.10", 38899, { spawn: fakeSpawn, setTimeout: (fn, ms) => { const x = { fn, ms }; timers.push(x); return x; }, clearTimeout: (x) => { x.cleared = true; } });
  const got = [];
  t.onMessage((m) => got.push(m));
  assert.strictEqual(children.length, 1);
  assert.strictEqual(children[0].bin, "/usr/bin/nc");
  assert.deepStrictEqual(children[0].args, ["-u", "192.0.2.10", "38899"]);

  t.send({ method: "getPilot", params: {} });
  assert.deepStrictEqual(children[0].written, ['{"method":"getPilot","params":{}}\n']);

  children[0].stdout.emit("data", Buffer.from('{"method":"getPilot","res'));
  children[0].stdout.emit("data", Buffer.from('ult":{"state":true}}{"method":"setPilot","result":{"success":true}}'));
  assert.deepStrictEqual(got, [{ method: "getPilot", result: { state: true } }, { method: "setPilot", result: { success: true } }]);

  // Exit: respawn after a delay that grows, and sends in between are dropped quietly.
  children[0].emit("exit", 1);
  assert.doesNotThrow(() => t.send({ method: "getPilot", params: {} }));
  assert.strictEqual(timers.length, 1);
  const first = timers[0].ms;
  timers[0].fn();
  assert.strictEqual(children.length, 2, "respawned");
  children[1].emit("exit", 1);
  assert(timers[1].ms > first, "backoff grows");
  timers[1].fn();
  assert.strictEqual(children.length, 3);
  // A reply shows the child works: the delay starts over.
  children[2].stdout.emit("data", Buffer.from('{"a":1}'));
  children[2].emit("error", new Error("gone"));
  assert.strictEqual(timers[2].ms, first);
  // A failed spawn is retried too.
  const bad = ncTransport("192.0.2.10", 38899, { spawn: () => { throw new Error("no nc"); }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers[timers.length - 1]; }, clearTimeout() {} });
  assert.doesNotThrow(() => bad.send({}));
  bad.close();

  // Stop: the child is killed, nothing respawns.
  const n = children.length;
  timers[2].fn();
  assert.strictEqual(children.length, n + 1);
  t.close();
  assert(children[n].killed);
  children[n].emit("exit", 0);
  assert(timers.every((x) => x.fn !== undefined));
  const timersBefore = timers.length;
  children[n].emit("exit", 0);
  assert.strictEqual(timers.length, timersBefore, "no respawn after close");
  assert.strictEqual(children.length, n + 1);
  assert.doesNotThrow(() => t.send({}));

  // The bulb works over it end to end.
  console.log("nc transport tests passed");
}
