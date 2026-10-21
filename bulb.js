"use strict";
// The room light's bulb (a WiZ colour bulb, controlled locally with JSON over UDP port 38899): takes
// the notes the piano relay receives, drives light.js and sends its colour, and keeps the on/off
// switch. The bulb is never allowed to get in the piano's way: nothing here blocks or throws, an
// unreachable bulb is probed quietly at a low rate, and switching off puts the bulb back as it was.
const dgram = require("dgram");
const fs = require("fs");
const { spawn } = require("child_process");
const light = require("./light.js");

const WIZ_PORT = 38899;
const DEFAULTS = {
  tickMs: 125,             // about 8 colour updates a second at most (the bulb copes with 8 to 10)
  probeMs: 15000,          // how often an unreachable or idle bulb is asked for its state
  takeProbeMs: 800,        // how often the first state read is repeated while taking control
  replyTimeoutMs: 4000,    // no answer for this long: the bulb counts as not found
  releaseAfterMs: 600000,  // this long after the last note the bulb is given back as it was (0: never)
  restoreRepeatMs: [400, 1200], // UDP can drop a packet: the restore is repeated after these delays
};

// The setPilot parameters that put a bulb back to the state a getPilot result describes.
function restoreParams(pilot) {
  const p = pilot || {};
  if (!p.state) return { state: false };
  const out = { state: true };
  if (p.sceneId) out.sceneId = p.sceneId;
  else if (p.temp && p.r == null) out.temp = p.temp;
  else if (p.r != null) {
    out.r = p.r; out.g = p.g; out.b = p.b;
    if (p.c != null) out.c = p.c;
    if (p.w != null) out.w = p.w;
  }
  if (p.dimming != null) out.dimming = p.dimming;
  return out;
}

// UDP transport to one bulb. send() never throws; messages from the bulb go to the handler.
function udpTransport(host, port = WIZ_PORT) {
  const socket = dgram.createSocket("udp4");
  let handler = () => {};
  socket.on("error", () => {});
  socket.on("message", (buf, rinfo) => {
    if (rinfo.address !== host) return;
    try { handler(JSON.parse(buf.toString("utf8"))); } catch {}
  });
  socket.unref();
  return {
    send(msg) { try { socket.send(JSON.stringify(msg), port, host, () => {}); } catch {} },
    onMessage(fn) { handler = fn; },
    close() { try { socket.close(); } catch {} },
  };
}

// Splits a stream of JSON objects (the bulb's replies can arrive joined, split or without newlines)
// by brace depth, ignoring braces inside strings. push(text) returns the complete objects so far.
function jsonSplitter() {
  let buf = "", depth = 0, inStr = false, esc = false, start = -1;
  return {
    push(text) {
      const out = [];
      for (const ch of String(text)) {
        buf += ch;
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') { if (depth > 0) inStr = true; }
        else if (ch === "{") { if (depth++ === 0) start = buf.length - 1; }
        else if (ch === "}" && depth > 0 && --depth === 0) {
          const raw = buf.slice(start); buf = ""; start = -1;
          try { out.push(JSON.parse(raw)); } catch {}
        }
        else if (depth === 0) buf = "";
      }
      if (buf.length > 65536) { buf = ""; depth = 0; inStr = false; esc = false; }
      return out;
    },
  };
}

// The same transport through one long-lived `nc -u <host> <port>` child. macOS blocks Local Network
// access for a node process started by launchd (dgram sends fail with EHOSTUNREACH) but allows
// /usr/bin/nc. JSON goes to its stdin, one object a line; replies come back on stdout. The child is
// respawned with a growing delay when it exits. Nothing here throws or blocks.
function ncTransport(host, port = WIZ_PORT, opts = {}) {
  const spawnFn = opts.spawn || spawn, bin = opts.bin || "/usr/bin/nc";
  const setTimer = opts.setTimeout || setTimeout, clearTimer = opts.clearTimeout || clearTimeout;
  const minMs = opts.backoffMinMs || 1000, maxMs = opts.backoffMaxMs || 30000;
  let handler = () => {}, child = null, timer = null, closed = false, delay = minMs, split = jsonSplitter();

  function launch() {
    timer = null;
    if (closed) return;
    let c;
    try { c = spawnFn(bin, ["-u", host, String(port)], { stdio: ["pipe", "pipe", "ignore"] }); } catch { return again(); }
    child = c; split = jsonSplitter();
    const gone = () => { if (child === c) { child = null; again(); } };
    c.on("error", gone); c.on("exit", gone);
    if (c.stdin) c.stdin.on("error", () => {});
    if (c.stdout) {
      c.stdout.on("error", () => {});
      c.stdout.on("data", (d) => {
        delay = minMs;
        for (const m of split.push(d.toString("utf8"))) { try { handler(m); } catch {} }
      });
    }
  }
  function again() {
    if (closed || timer) return;
    timer = setTimer(launch, delay);
    if (timer && timer.unref) timer.unref();
    delay = Math.min(maxMs, delay * 2);
  }
  launch();
  return {
    send(msg) { try { if (child && child.stdin && child.stdin.writable) child.stdin.write(JSON.stringify(msg) + "\n"); } catch {} },
    onMessage(fn) { handler = fn; },
    close() {
      closed = true;
      if (timer) clearTimer(timer);
      timer = null;
      const c = child; child = null;
      if (c) { try { c.kill(); } catch {} }
    },
  };
}

// nc on macOS, dgram elsewhere; opts.kind ("nc" or "udp") forces one.
function defaultTransport(host, port, kind) {
  const nc = kind === "nc" || (kind !== "udp" && process.platform === "darwin" && fs.existsSync("/usr/bin/nc"));
  return nc ? ncTransport(host, port) : udpTransport(host, port);
}

// opts: { host, transport, enabled, now, schedule, onChange(info), ...DEFAULTS, light: {...} }
function createBulb(opts) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now || Date.now;
  const schedule = o.schedule || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref && t.unref(); });
  const color = light.createLight(o.light);
  const host = o.host || "";
  const transport = host ? (o.transport || defaultTransport(host, o.port, o.transportKind)) : null;

  let enabled = o.enabled !== false;
  let wantControl = false;     // notes were played and the bulb should follow them
  let controlling = false;     // the original state is saved and the colour is being sent
  let original = null;         // getPilot result from just before control was taken
  let reachable = false, failed = false; // failed: a command went unanswered
  let pendingSince = null;     // when the oldest unanswered command went out
  let lastGet = -Infinity, lastSent = null, lastNoteAt = -Infinity;
  let timer = null, reported = "";

  const status = () => !host ? "no-bulb" : !enabled ? "off"
    : reachable ? (controlling ? "active" : "ready")
    : failed ? "not-found" : "searching";
  const info = () => ({ enabled, configured: !!host, status: status() });
  function report() {
    const s = JSON.stringify(info());
    if (s !== reported) { reported = s; if (o.onChange) { try { o.onChange(info()); } catch {} } }
  }

  function send(msg, t) {
    if (!transport) return;
    if (pendingSince == null) pendingSince = t;
    transport.send(msg);
  }
  function getPilot(t) { lastGet = t; send({ method: "getPilot", params: {} }, t); }

  function takeControl(pilot) {
    // A bulb that came back after a power cut keeps the state saved before it went away.
    if (!original) original = pilot;
    controlling = true;
    lastSent = null;
    const p = pilot || {};
    if (p.state && p.r != null) {
      const hsv = light.rgbToHsv(p.r, p.g, p.b);
      color.seed(hsv.h, hsv.s * 100, p.dimming != null ? p.dimming : 50);
    } else if (p.state) {
      color.seed(o.light && o.light.idle ? o.light.idle.h : light.DEFAULTS.idle.h, light.DEFAULTS.idle.s, p.dimming != null ? p.dimming : 50);
    } else {
      color.seed(light.DEFAULTS.idle.h, light.DEFAULTS.idle.s, light.DEFAULTS.minDimming);
    }
  }

  function release() {
    if (controlling && original && transport) {
      const params = restoreParams(original);
      const msg = { method: "setPilot", params };
      const t = now();
      send(msg, t);
      for (const ms of o.restoreRepeatMs) schedule(() => transport.send(msg), ms);
    }
    controlling = false; wantControl = false; original = null; lastSent = null;
  }

  function handle(msg) {
    const t = now();
    pendingSince = null;
    reachable = true; failed = false;
    if (msg && msg.method === "getPilot" && msg.result && enabled && wantControl && !controlling) takeControl(msg.result);
    report();
  }
  if (transport) transport.onMessage(handle);

  // A note played on the keyboard. Cheap and safe to call for every event.
  function noteOn(note, velocity) {
    if (!host || !enabled) return;
    const t = now();
    color.noteOn(note, velocity, t);
    lastNoteAt = t;
    if (!wantControl) lastGet = -Infinity; // read the bulb's state now, so the first colour starts from it
    wantControl = true;
  }

  function tick(t = now()) {
    if (!host || !enabled) return;
    if (pendingSince != null && t - pendingSince > o.replyTimeoutMs) {
      // No answer: stop streaming, keep the original state for when the bulb returns.
      reachable = false; failed = true; pendingSince = null; lastSent = null;
      if (controlling) { controlling = false; wantControl = true; }
    }
    if (!controlling) {
      // Not following yet: ask for the state, quickly when notes wait for it, otherwise rarely.
      const every = wantControl && reachable ? o.takeProbeMs : o.probeMs;
      if (t - lastGet >= every) getPilot(t);
    } else {
      const c = color.step(t);
      if (c.silent && t - lastNoteAt > color.options.idleAfterMs + o.releaseAfterMs && o.releaseAfterMs > 0) release();
      else if (light.changedEnough(lastSent, c)) {
        lastSent = { rgb: c.rgb, dimming: c.dimming };
        send({ method: "setPilot", params: { state: true, r: c.rgb[0], g: c.rgb[1], b: c.rgb[2], dimming: c.dimming } }, t);
      }
    }
    report();
  }

  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return info();
    if (!on) { release(); enabled = false; pendingSince = null; }
    else { enabled = true; lastGet = -Infinity; failed = false; reachable = false; }
    report();
    return info();
  }

  function start() {
    if (!transport || timer) return;
    timer = setInterval(() => { try { tick(); } catch {} }, o.tickMs);
    timer.unref && timer.unref();
    tick();
  }
  // Gives the bulb back (when under control) and stops. Used when the server shuts down.
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    release();
    if (transport && transport.close) schedule(() => transport.close(), Math.max(0, ...o.restoreRepeatMs) + 100);
  }

  return { noteOn, tick, setEnabled, start, stop, info, get enabled() { return enabled; } };
}

module.exports = { createBulb, restoreParams, udpTransport, ncTransport, jsonSplitter, DEFAULTS, WIZ_PORT };
