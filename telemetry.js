"use strict";
// What the TV page reports about its own speed (fps, frame times, effects level, note-to-light latency),
// kept in memory only so it can be read from another machine: the latest sample, a rolling summary of
// the recent ones and how old the latest is. Nothing is written to disk and nothing identifies a person:
// only numbers, the effects preset, and the browser's major version and screen size are accepted.

const KEEP = 150;          // samples kept: 5 minutes at one every 2 s
const SUMMARY_SAMPLES = 30; // the rolling summary covers the newest 30 (about a minute)
const LIVE_MS = 6000;       // a sample older than this means the TV stopped reporting

const num = (v, lo, hi, digits = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(Math.min(hi, Math.max(lo, n)) * f) / f;
};
const text = (v, max) => String(v == null ? "" : v).replace(/[^\w .+\-×]/g, "").slice(0, max).trim();

// A posted sample reduced to the fields we keep, each clamped; null when it has no frame rate at all.
function sanitize(body) {
  if (!body || typeof body !== "object") return null;
  const fps = num(body.fps, 0, 1000), fps5 = num(body.fps5, 0, 1000);
  if (fps === null && fps5 === null) return null;
  const s = {
    fps: fps === null ? fps5 : fps,
    fps5: fps5 === null ? fps : fps5,
    worst: num(body.worst, 0, 60000) || 0,
    long: Math.round(num(body.long, 0, 100000, 0) || 0),
    level: typeof body.level === "number" ? Math.round(num(body.level, 0, 99, 0) || 0) : text(body.level, 8),
    preset: text(body.preset, 24),
    latency: null,
    mem: num(body.mem, 0, 100000, 0),
    chrome: text(body.chrome, 8),
    dpr: num(body.dpr, 0, 16, 2) || 0,
    w: Math.round(num(body.w, 0, 20000, 0) || 0),
    h: Math.round(num(body.h, 0, 20000, 0) || 0),
  };
  const l = body.latency;
  if (l && typeof l === "object" && num(l.avg, 0, 1e6) !== null) {
    s.latency = { last: num(l.last, 0, 1e6) || 0, avg: num(l.avg, 0, 1e6), max: num(l.max, 0, 1e6) || 0, n: Math.round(num(l.n, 0, 1e6, 0) || 0) };
  }
  if (body.sparks != null) s.sparks = Math.round(num(body.sparks, 0, 100000, 0) || 0);
  if (body.draw != null) s.draw = num(body.draw, 0, 60000);
  return s;
}

function createStore(now = Date.now) {
  const samples = [];
  const store = {
    // Adds a sample; returns it as stored, or null when it was not a telemetry sample.
    add(body) {
      const s = sanitize(body);
      if (!s) return null;
      s.at = now();
      samples.push(s);
      if (samples.length > KEEP) samples.shift();
      return s;
    },
    // The newest `SUMMARY_SAMPLES` boiled down: mean fps, the lowest fps and average, the worst frame,
    // the long frames of the newest sample's window and the note-to-light latency across them.
    summary() {
      const recent = samples.slice(-SUMMARY_SAMPLES);
      if (!recent.length) return null;
      const mean = (f) => recent.reduce((a, s) => a + f(s), 0) / recent.length;
      const r1 = (v) => Math.round(v * 10) / 10;
      const lat = recent.filter((s) => s.latency);
      const out = {
        samples: recent.length,
        spanMs: recent[recent.length - 1].at - recent[0].at,
        fpsMean: r1(mean((s) => s.fps5)),
        fpsMin: r1(Math.min(...recent.map((s) => s.fps))),
        worstMs: r1(Math.max(...recent.map((s) => s.worst))),
        longFrames: Math.max(...recent.map((s) => s.long)),
        latency: null,
      };
      if (lat.length) {
        out.latency = {
          avgMs: r1(lat.reduce((a, s) => a + s.latency.avg, 0) / lat.length),
          maxMs: r1(Math.max(...lat.map((s) => s.latency.max))),
          notes: lat.length,
        };
      }
      return out;
    },
    // { live, ageMs, latest, summary, now }: live is false when nothing came in the last few seconds (or ever).
    get() {
      const t = now(), latest = samples.length ? samples[samples.length - 1] : null;
      const ageMs = latest ? t - latest.at : null;
      return { live: latest !== null && ageMs <= LIVE_MS, ageMs, latest, summary: store.summary(), now: t };
    },
    get size() { return samples.length; },
  };
  return store;
}

module.exports = { createStore, sanitize, KEEP, SUMMARY_SAMPLES, LIVE_MS };
