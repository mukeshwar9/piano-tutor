// Telemetry for the TV page: is the Fire TV keeping up? Frame times, the effects governor's level and the
// delay from a played note reaching the page to the frame that draws it, in a small corner readout that
// can be switched on at the TV and is also reported to the server. Plain ES5 so it runs unchanged in TV
// browsers and in Node; everything here is pure (the page owns the DOM and the timers), which is what the
// tests cover: the frame window and its statistics, long-frame counting, the latency calculation, the
// remote's key sequence, the URL flag, and the readout text.
//
// It is cheap on purpose: a frame costs one write into a fixed ring and nothing is allocated; the
// statistics are worked out only when a sample is taken (twice a second) and walk at most a few hundred
// numbers.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PianoTelemetry = factory();
})(this, function () {
  "use strict";

  var LONG_MS = 50;              // a frame longer than this is a long frame (a visible stutter)
  var FPS_NOW_MS = 1000;         // "current" fps looks at the last second
  var FPS_AVG_MS = 5000;         // the average fps and the worst frame look at the last 5 s
  var LONG_SPAN_MS = 10000;      // long frames are counted over the last 10 s
  var LATENCY_SPAN_MS = 10000;   // the latency summary covers the last 10 s
  var MAX_GAP_MS = 10000;        // a longer gap is a hidden tab or a sleeping page, not a slow frame: left out
  var RING = 2048;               // 10 s of frames at up to 200 fps
  var PENDING_CAP = 64;          // notes waiting for their frame; more than this and the oldest are dropped

  // The last `cap` frames: when each began and how long it was since the one before (the frame time).
  function createFrameWindow(cap) {
    cap = cap || RING;
    var times = new Array(cap), gaps = new Array(cap), head = 0, count = 0, last = -1;
    var w = {
      // t is the frame's start time (the rAF timestamp, in ms); the first frame has no frame time yet.
      push: function (t) {
        var gap = last < 0 ? -1 : t - last;
        last = t;
        if (gap < 0 || gap > MAX_GAP_MS) return;
        times[head] = t; gaps[head] = gap;
        head = (head + 1) % cap;
        if (count < cap) count++;
      },
      // Frames per second over the last `spanMs` before `now`: frames divided by the time they took.
      fps: function (now, spanMs) {
        var n = 0, sum = 0, i, idx;
        for (i = 0; i < count; i++) {
          idx = (head - 1 - i + cap) % cap;
          if (times[idx] <= now - spanMs) break;
          n++; sum += gaps[idx];
        }
        return n && sum > 0 ? n * 1000 / sum : 0;
      },
      // The longest frame time (ms) in the last `spanMs`, 0 when there was no frame.
      worst: function (now, spanMs) {
        var m = 0, i, idx;
        for (i = 0; i < count; i++) {
          idx = (head - 1 - i + cap) % cap;
          if (times[idx] <= now - spanMs) break;
          if (gaps[idx] > m) m = gaps[idx];
        }
        return m;
      },
      // How many frames in the last `spanMs` took longer than `limitMs`.
      longer: function (now, spanMs, limitMs) {
        var n = 0, i, idx;
        for (i = 0; i < count; i++) {
          idx = (head - 1 - i + cap) % cap;
          if (times[idx] <= now - spanMs) break;
          if (gaps[idx] > limitMs) n++;
        }
        return n;
      },
      get size() { return count; },
    };
    return w;
  }

  // Note-to-light latency: `arrive` when a played note reaches the page, `drawn` when a frame has been
  // drawn; every note waiting then gets its delay from arrival to that moment.
  function createLatency() {
    var pending = [], at = [], ms = [], keep = 64;
    return {
      arrive: function (t) {
        pending.push(t);
        if (pending.length > PENDING_CAP) pending.shift();
      },
      drawn: function (t) {
        for (var i = 0; i < pending.length; i++) {
          at.push(t); ms.push(Math.max(0, t - pending[i]));
        }
        pending.length = 0;
        if (at.length > keep) { at.splice(0, at.length - keep); ms.splice(0, ms.length - keep); }
      },
      // { last, avg, max, n } of the delays measured in the last `spanMs`, or null when none were.
      stats: function (now, spanMs) {
        var n = 0, sum = 0, max = 0, last = 0, i;
        for (i = 0; i < at.length; i++) {
          if (at[i] <= now - spanMs) continue;
          n++; sum += ms[i]; last = ms[i];
          if (ms[i] > max) max = ms[i];
        }
        return n ? { last: last, avg: sum / n, max: max, n: n } : null;
      },
      get waiting() { return pending.length; },
    };
  }

  // The frame window and the latency together, with the one question the page asks twice a second.
  function create() {
    var frames = createFrameWindow(), latency = createLatency();
    return {
      frame: function (t) { frames.push(t); },
      noteArrived: function (t) { latency.arrive(t); },
      noteDrawn: function (t) { if (latency.waiting) latency.drawn(t); },
      sample: function (now) {
        return {
          fps: frames.fps(now, FPS_NOW_MS),
          fps5: frames.fps(now, FPS_AVG_MS),
          worst: frames.worst(now, FPS_AVG_MS),
          long: frames.longer(now, LONG_SPAN_MS, LONG_MS),
          latency: latency.stats(now, LATENCY_SPAN_MS),
        };
      },
      frames: frames, latency: latency,
    };
  }

  // The Chrome (WebView) major version from a user agent string, "" when it has none. Only this number is
  // kept: the user agent as a whole is not reported anywhere.
  function chromeVersion(ua) {
    var m = /\bChrome\/(\d+)/.exec(String(ua || ""));
    return m ? m[1] : "";
  }

  // ?telemetry=1 (or on, true) switches it on, ?telemetry=0 (off, false) off; no flag: null, leave it as remembered.
  function parseFlag(search) {
    var m = /[?&]telemetry(?:=([^&#]*))?(?:[&#]|$)/.exec(String(search || ""));
    if (!m) return null;
    var v = (m[1] === undefined ? "1" : m[1]).toLowerCase();
    if (v === "0" || v === "off" || v === "false" || v === "no") return false;
    return true;
  }

  // A remote has no spare button, so the switch is a short sequence: the same key pressed `count` times,
  // each within `windowMs` of the one before. `press(now)` is true on the press that completes it.
  function createSequence(count, windowMs) {
    var n = 0, at = 0;
    return {
      press: function (now) {
        n = n > 0 && now - at <= windowMs ? n + 1 : 1;
        at = now;
        if (n >= count) { n = 0; return true; }
        return false;
      },
      reset: function () { n = 0; },
    };
  }

  function round(v, digits) {
    var f = Math.pow(10, digits || 0);
    return Math.round(v * f) / f;
  }

  // The numbers sent to the server, rounded so a sample stays a few hundred bytes: the frame statistics,
  // the effects (preset and governor level), the latency summary, memory where the browser has it, and
  // the environment (sent with every sample, it is a few bytes).
  function report(s, extra, env) {
    var lat = s.latency;
    var r = {
      fps: round(s.fps, 1), fps5: round(s.fps5, 1), worst: round(s.worst, 1), long: s.long,
      level: extra && extra.level != null ? extra.level : "", preset: extra && extra.preset || "",
      latency: lat ? { last: round(lat.last, 1), avg: round(lat.avg, 1), max: round(lat.max, 1), n: lat.n } : null,
      mem: extra && typeof extra.mem === "number" ? round(extra.mem, 0) : null,
      chrome: env && env.chrome || "", dpr: env && env.dpr || 0,
      w: env && env.w || 0, h: env && env.h || 0,
    };
    if (extra && typeof extra.sparks === "number") r.sparks = extra.sparks;
    if (extra && typeof extra.draw === "number") r.draw = round(extra.draw, 1);
    return r;
  }

  // The corner readout, one short line per number.
  function readoutText(r) {
    var lat = r.latency;
    var lines = [
      "fps " + Math.round(r.fps) + " · avg " + Math.round(r.fps5),
      "worst " + Math.round(r.worst) + " ms · long " + r.long,
      "fx " + (r.preset || "off") + " · gov " + (r.level === "" ? "-" : r.level),
      "note→light " + (lat ? Math.round(lat.last) + " ms (avg " + Math.round(lat.avg) + ", max " + Math.round(lat.max) + ")" : "no notes yet"),
    ];
    if (typeof r.sparks === "number") lines.push("sparks " + r.sparks + " · draw " + (typeof r.draw === "number" ? r.draw.toFixed(1) : "-") + " ms");
    if (typeof r.mem === "number") lines.push("mem " + r.mem + " MB");
    lines.push("chrome " + (r.chrome || "?") + " · dpr " + (r.dpr ? round(r.dpr, 2) : "?") + (r.w ? " · " + r.w + "×" + r.h : ""));
    return lines.join("\n");
  }

  // The class the readout takes so a glance says how it is going: ok, slow (under 45 fps average) or bad (under 30).
  function health(r) {
    if (r.fps5 > 0 && r.fps5 < 30) return "bad";
    if (r.fps5 > 0 && r.fps5 < 45) return "slow";
    return "ok";
  }

  return {
    LONG_MS: LONG_MS, FPS_NOW_MS: FPS_NOW_MS, FPS_AVG_MS: FPS_AVG_MS, LONG_SPAN_MS: LONG_SPAN_MS, LATENCY_SPAN_MS: LATENCY_SPAN_MS,
    MAX_GAP_MS: MAX_GAP_MS,
    createFrameWindow: createFrameWindow, createLatency: createLatency, create: create, chromeVersion: chromeVersion,
    parseFlag: parseFlag, createSequence: createSequence, report: report, readoutText: readoutText, health: health,
  };
});
