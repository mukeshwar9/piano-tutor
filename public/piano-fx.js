// Piano light effects for the TV page: neon glow on the falling notes, sparks, a lit keyboard and an
// Aurora layer behind the canvas. Plain ES5 so it runs unchanged in TV browsers and in Node (the pure
// parts, which are what the tests cover: settings, the frame-rate governor, the particle pool).
//
// Everything is drawn from sprites rendered once, added together with "lighter": no canvas filters, no
// shadowBlur and no gradients created per frame. Aurora is not drawn into the canvas at all: it is a few
// CSS elements behind it that the GPU compositor moves. A governor steps the effects down when frames
// run slow. All the looks are original; the design only borrows the general idea of notes as light.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PianoFx = factory();
})(this, function () {
  "use strict";

  var LAYERS = ["neon", "sparks", "aurora", "keys"];
  // What the X key and the link page cycle through. A setting string is a preset's value or any comma
  // separated list of layers.
  var PRESETS = [
    { id: "off", name: "Off", value: "off" },
    { id: "lite", name: "Lite", value: "lite" },
    { id: "neon", name: "Neon + Sparks", value: "neon,sparks,keys" },
    { id: "all", name: "All", value: "neon,sparks,aurora,keys" },
  ];
  var DEFAULT_SETTING = "lite", DEFAULT_INTENSITY = 65;
  var MIC_VELOCITY = 0.7;       // the microphone hears no key velocity
  var POOL_CAP = 600;

  // Governor: frames slower than SLOW_MS (smoothed) for SLOW_HOLD_MS step one level down, faster than
  // FAST_MS for FAST_HOLD_MS step one level back up.
  var SLOW_MS = 34, SLOW_HOLD_MS = 1500, FAST_MS = 24, FAST_HOLD_MS = 8000, MAX_LEVEL = 3;

  var HAND = {
    right: { white: "#4da3ff", want: "#8cc6ff" },
    left: { white: "#e26ad0", want: "#ff9ff0" },
  };
  var RED = [255, 82, 82], GREEN = [61, 220, 132];
  var BLACK_BASE = [16, 20, 28], WHITE_BASE = [233, 237, 243];
  // The room light's palettes (light.js): hue arc over the 12 pitch classes, `wheel` spreads them round the circle.
  var PALETTES = {
    spectrum: { arc: [0, 330], wheel: true },
    aurora: { arc: [125, 285] },
    sunset: { arc: [45, -60] },
    ocean: { arc: [160, 245] },
    warm: { arc: [10, 60] },
  };

  // ---------- settings ----------

  function emptyLayers() { return { neon: false, sparks: false, aurora: false, keys: false }; }

  // A stored setting to { value, preset, lite, layers, on }. Anything unreadable is the default (Lite).
  function parseSetting(s) {
    var v = String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");
    var out = { value: "", preset: "", lite: false, layers: emptyLayers(), on: false }, i;
    for (i = 0; i < PRESETS.length; i++) if (v === PRESETS[i].id || v === PRESETS[i].value) v = PRESETS[i].value;
    if (v === "off") { out.value = "off"; out.preset = "off"; return out; }
    if (v === "lite" || !v) { v = DEFAULT_SETTING; }
    if (v === "lite") {
      out.lite = true; out.preset = "lite"; out.value = "lite";
      out.layers.neon = out.layers.sparks = out.layers.keys = true; out.on = true;
      return out;
    }
    var any = false, parts = v.split(",");
    for (i = 0; i < parts.length; i++) if (LAYERS.indexOf(parts[i]) >= 0) { out.layers[parts[i]] = true; any = true; }
    if (!any) return parseSetting(DEFAULT_SETTING);
    out.value = LAYERS.filter(function (l) { return out.layers[l]; }).join(",");
    out.on = true;
    out.preset = "custom";
    for (i = 0; i < PRESETS.length; i++) if (PRESETS[i].value === out.value) out.preset = PRESETS[i].id;
    return out;
  }

  // True when s is a preset's id or value or a comma separated list of layers (what the link page may send).
  function isSetting(s) {
    var v = String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");
    if (!v) return false;
    for (var i = 0; i < PRESETS.length; i++) if (v === PRESETS[i].id || v === PRESETS[i].value) return true;
    return v.split(",").every(function (p) { return LAYERS.indexOf(p) >= 0; });
  }

  function presetName(setting) {
    var p = parseSetting(setting).preset;
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === p) return PRESETS[i].name;
    return "Custom";
  }

  // The next preset: Off, Lite, Neon + Sparks, All, and round again. A custom list goes to Lite.
  function nextSetting(setting) {
    var p = parseSetting(setting).preset;
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === p) return PRESETS[(i + 1) % PRESETS.length].value;
    return "lite";
  }

  // Intensity 0-100 from a stored string or a slider value; anything else is the default.
  function parseIntensity(v) {
    var n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v));
    if (!(n === n) || v === null || v === "") return DEFAULT_INTENSITY;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  // MIDI velocity (1-127) to 0-1. A note without one (the microphone) is 0.7.
  function velocity01(v, mic) {
    if (mic || typeof v !== "number" || !(v > 0)) return MIC_VELOCITY;
    return Math.max(0.05, Math.min(1, v / 127));
  }

  // How deep a played key sinks, 0-1, from its velocity 0-1. A floor keeps the softest touch visible and the curve is a
  // little concave, so a soft and a hard key differ clearly across the whole range (0.3 about 0.44, 0.87 about 0.90).
  function pressDepth(v) {
    v = typeof v === "number" && v > 0 ? Math.min(1, v) : MIC_VELOCITY;
    return 0.12 + 0.88 * Math.pow(v, 0.85);
  }

  // How far of its depth key state s is down at time now, 0-1: about 45 ms to go down, about 120 ms to spring back.
  function sinkAmount(s, now) {
    if (!s) return 0;
    if (s.on) { var t = now - s.t0; return t >= 45 ? 1 : t <= 0 ? 0 : 1 - Math.pow(1 - t / 45, 2); }
    var held = s.tOff - s.t0, lv = held >= 45 ? 1 : held <= 0 ? 0 : 1 - Math.pow(1 - held / 45, 2), r = now - s.tOff;
    return r > 400 ? 0 : lv * Math.exp(-r / 120);
  }

  // A chord of n notes shares one flash and spark budget, so a big chord brightens the screen instead of whiting it out.
  function chordShare(n) { return 1 / Math.sqrt(Math.max(1, n || 1)); }

  // ---------- governor ----------

  function createGovernor() {
    var g = { level: 0, ema: 16.7, slowFor: 0, fastFor: 0 };
    g.step = function (dtMs) {
      g.ema += (dtMs - g.ema) * 0.1;
      if (g.ema > SLOW_MS) {
        g.slowFor += dtMs; g.fastFor = 0;
        if (g.slowFor > SLOW_HOLD_MS && g.level < MAX_LEVEL) { g.level++; g.slowFor = 0; }
      } else if (g.ema < FAST_MS) {
        g.fastFor += dtMs; g.slowFor = 0;
        if (g.fastFor > FAST_HOLD_MS && g.level > 0) { g.level--; g.fastFor = 0; }
      } else { g.slowFor = 0; g.fastFor = 0; }
      return g.level;
    };
    g.reset = function () { g.level = 0; g.ema = 16.7; g.slowFor = 0; g.fastFor = 0; };
    return g;
  }

  // ---------- particles ----------

  // One Float32Array of cap particles, 8 floats each: x, y, vx, vy, age, life (seconds), size, hand (0 right, 1 left).
  // `limit` (a share of cap) is what the governor lowers; emit() refuses past it.
  function createPool(cap) {
    cap = cap || POOL_CAP;
    var p = new Float32Array(cap * 8), head = 0, pool = { cap: cap, p: p, live: 0, limit: cap };
    pool.setLimit = function (share) { pool.limit = Math.max(0, Math.min(cap, Math.round(cap * share))); };
    pool.emit = function (x, y, vx, vy, life, size, hand) {
      if (pool.live >= pool.limit) return false;
      for (var tries = 0; tries < cap; tries++) {
        var o = head * 8; head = (head + 1) % cap;
        if (p[o + 4] >= p[o + 5]) {   // a dead slot (age reached life; a fresh array is all zeros)
          p[o] = x; p[o + 1] = y; p[o + 2] = vx; p[o + 3] = vy; p[o + 4] = 0; p[o + 5] = life; p[o + 6] = size; p[o + 7] = hand;
          pool.live++;
          return true;
        }
      }
      return false;
    };
    // Drift upwards (buoyancy), drag and a slight sway. u scales pixel speeds to the screen height.
    pool.step = function (dt, u) {
      var live = 0;
      for (var i = 0; i < cap; i++) {
        var o = i * 8;
        if (p[o + 4] >= p[o + 5]) continue;
        p[o + 4] += dt;
        if (p[o + 4] >= p[o + 5]) continue;
        live++;
        p[o + 2] *= 0.985; p[o + 3] = p[o + 3] * 0.975 - 30 * u * dt;
        p[o] += p[o + 2] * dt + Math.sin((p[o + 4] + i) * 6) * 12 * u * dt; p[o + 1] += p[o + 3] * dt;
      }
      pool.live = live;
      return live;
    };
    pool.clear = function () { for (var i = 0; i < cap; i++) { p[i * 8 + 4] = 0; p[i * 8 + 5] = 0; } pool.live = 0; };
    pool.clear();
    return pool;
  }

  // ---------- colour ----------

  function rgba(c, a) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function css(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }
  function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function mix(a, b, t) { return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]; }
  function hsl2rgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    function f(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [Math.round(f(p, q, h + 1 / 3) * 255), Math.round(f(p, q, h) * 255), Math.round(f(p, q, h - 1 / 3) * 255)];
  }
  // The colour of a pitch class (0-11) in a room-light palette; an unknown palette is Spectrum.
  function paletteRgb(name, pc) {
    var pal = PALETTES[name] || PALETTES.spectrum, t = pc / (pal.wheel ? 12 : 11);
    return hsl2rgb(pal.arc[0] + (pal.arc[1] - pal.arc[0]) * t, 0.85, 0.55);
  }

  // Key glow: fast attack, settles to 60% while held, fades over about 130 ms after the key is released.
  function envelope(s, now) {
    if (!s) return 0;
    if (s.on) { var t = now - s.t0; return t < 40 ? t / 40 : 0.6 + 0.4 * Math.exp(-(t - 40) / 450); }
    var r = now - s.tOff;
    if (r > 420) return 0;
    var held = s.tOff - s.t0, lv = held < 40 ? held / 40 : 0.6 + 0.4 * Math.exp(-(held - 40) / 450);
    return lv * Math.exp(-r / 130);
  }

  // ---------- sprites, rendered once ----------

  function canvasOf(w, h) { var c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  function radial(size, c, core) {
    var cv = canvasOf(size, size), g = cv.getContext("2d"), r = size / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, core ? "rgba(255,255,255,1)" : rgba(c, 1));
    gr.addColorStop(core ? 0.18 : 0.25, rgba(c, core ? 0.85 : 0.45));
    gr.addColorStop(0.6, rgba(c, 0.12));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
    return cv;
  }
  function hstrip(c, peak) {
    var cv = canvasOf(64, 4), g = cv.getContext("2d"), gr = g.createLinearGradient(0, 0, 64, 0);
    gr.addColorStop(0, rgba(c, 0)); gr.addColorStop(0.5, rgba(c, peak)); gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 64, 4);
    return cv;
  }
  function vfade(c) {
    var cv = canvasOf(4, 128), g = cv.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, rgba(c, 0)); gr.addColorStop(0.7, rgba(c, 0.55)); gr.addColorStop(1, rgba(c, 1));
    g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
    return cv;
  }
  var TONES = { right: hex(HAND.right.white), left: hex(HAND.left.white), ok: GREEN };
  var spriteCache = null;
  function sprites() {
    if (spriteCache) return spriteCache;
    var s = { tone: {}, red: radial(64, RED), keyShade: canvasOf(4, 64) };
    Object.keys(TONES).forEach(function (t) {
      var c = TONES[t], lite = t === "ok" ? [140, 240, 180] : hex(HAND[t].want);
      s.tone[t] = { glow: radial(64, c), core: radial(64, lite, true), spark: radial(16, lite, true), halo: hstrip(c, 0.9), coreStrip: hstrip([255, 255, 255], 0.9), fade: vfade(c), fadeLite: vfade(lite) };
    });
    var kg = s.keyShade.getContext("2d"), gr = kg.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, "rgba(0,0,0,.55)"); gr.addColorStop(1, "rgba(0,0,0,0)");
    kg.fillStyle = gr; kg.fillRect(0, 0, 4, 64);
    spriteCache = s;
    return s;
  }

  // ---------- the effects ----------

  // ctx: the page's canvas context. The page calls layout() on resize and each frame (the strip moves with
  // the sheet view), noteOn/noteOff on input, step() once a frame, then the draw hooks in the order of draw().
  function create(ctx) {
    var cfg = parseSetting(DEFAULT_SETTING), intensity = DEFAULT_INTENSITY / 100, palette = "spectrum";
    var gov = createGovernor(), pool = createPool(POOL_CAP);
    var S = null;                       // sprites, built when the first effect turns on
    var W = 1, H = 1, U = 1, lay = null, keyTop = 0, hitY = 0, areaTop = 0, blackH = 0, left = 0, right = 0;
    var keyState = {};                  // note -> { on, t0, tOff, vel, hand, kind }
    var flares = [], flashes = [];      // short-lived key-top ripples and hit-line flashes
    var energy = 0, lastPc = 0, lastNow = 0, suspended = false, govOn = true;
    var curt = [], aur = null, aurNext = 0, aurRect = null;
    var stats = { draw: 0 };
    var look = { fill: "", sink: 0, depth: 0, rim: null, rimAlpha: 0 };
    var fx = { gov: gov, pool: pool, stats: stats, get cfg() { return cfg; }, get active() { return cfg.on && !suspended; }, get governed() { return govOn; } };
    for (var ci = 0; ci < 5; ci++) curt.push({ x: 0.2 + ci * 0.15, tx: 0.5, pc: ci * 2, a: 0, phase: ci * 1.7 });

    function lvl(n) { return gov.level >= n; }
    function lite() { return cfg.lite || lvl(3); }
    function handIdx(h) { return h === "left" ? 1 : 0; }
    function toneOf(h) { return S.tone[h === "left" ? "left" : "right"]; }

    fx.setSetting = function (s) {
      var next = parseSetting(s), changed = next.value !== cfg.value;
      cfg = next;
      if (cfg.on && !S) S = sprites();
      if (changed) { gov.reset(); pool.setLimit(1); }
      if (!cfg.on) fx.reset();
      return cfg;
    };
    fx.setIntensity = function (n) { intensity = parseIntensity(n) / 100; return intensity * 100; };
    fx.setPalette = function (name) { palette = PALETTES[name] ? name : "spectrum"; };
    // The page suspends the effects where they must not show (calibration): drawn as if Off, and cleared.
    // The governor can be switched off (the page does it for ?nogov) to measure a level without it stepping down.
    fx.setGovernor = function (on) { govOn = !!on; if (!govOn) { gov.reset(); pool.setLimit(1); } };
    fx.suspend = function (yes) {
      yes = !!yes;
      if (yes === suspended) return;
      suspended = yes;
      if (yes) fx.reset();
    };
    fx.reset = function () { keyState = {}; flares.length = 0; flashes.length = 0; pool.clear(); energy = 0; hideAurora(); };

    // The strip the falling notes use and the keyboard under it, in device pixels. layout is PianoCore.keyLayout().
    fx.layout = function (layout, top, hit, areaT, blackHeight, w, h) {
      lay = layout; keyTop = top; hitY = hit; areaTop = areaT; blackH = blackHeight; W = w; H = h; U = h / 1080;
      left = layout.keys[layout.low].x0; right = layout.keys[layout.high].x1;
    };

    // A key goes down: kind is "player", "music" (Hear it first) or "wrong". simul is how many keys went down together.
    fx.noteOn = function (note, vel, hand, kind, simul, now) {
      if (!fx.active || !lay) return;
      var kk = lay.keys[note]; if (!kk) return;
      now = now || lastNow || Date.now();
      vel = Math.max(0.05, Math.min(1, vel || MIC_VELOCITY));
      var music = kind === "music", wrong = kind === "wrong", share = chordShare(simul) * (music ? 0.6 : 1);
      keyState[note] = { on: true, t0: now, tOff: 0, vel: vel, hand: hand === "left" ? "left" : "right", kind: wrong ? "wrong" : music ? "music" : "player" };
      var cx = (kk.x0 + kk.x1) / 2, w = kk.x1 - kk.x0;
      if (cfg.layers.keys) push(flares, { x: cx, y: keyTop, w: w, t0: now, vel: vel * chordShare(simul), hand: hand, kind: keyState[note].kind, k: music ? 0.6 : 1 });
      if (wrong) return;   // a wrong key gets red light and nothing else: no flash, no sparks, no Aurora
      if (cfg.layers.neon) push(flashes, { x: cx, y: hitY, w: w, t0: now, vel: vel * chordShare(simul), hand: hand, k: music ? 0.6 : 1 });
      if (cfg.layers.sparks) {
        var n = Math.round((4 + 16 * vel) * intensity * chordShare(simul) * (music ? 0.5 : 1) * (lvl(2) ? 0.35 : 1));
        emit(cx, keyTop, w, n, hand, vel);
      }
      energy = Math.min(3, energy + vel * 0.6 * share);
      lastPc = note % 12;
      var c = curt[(note * 7) % curt.length]; c.tx = cx / W; c.pc = note % 12; c.a = Math.min(1, c.a + vel * 0.5);
    };

    fx.noteOff = function (note, now) {
      var s = keyState[note];
      if (s && s.on) { s.on = false; s.tOff = now || lastNow || Date.now(); }
    };

    function push(list, o) { list.push(o); if (list.length > 48) list.shift(); }

    function emit(x, y, w, n, hand, vel) {
      for (var i = 0; i < n; i++) {
        var a = -Math.PI / 2 + (Math.random() - 0.5) * 1.3, sp = (160 + 420 * vel * Math.random()) * U;
        if (!pool.emit(x + (Math.random() - 0.5) * w * 0.8, y, Math.cos(a) * sp * 0.6, Math.sin(a) * sp, 0.6 + Math.random() * 0.9 * (0.6 + vel),
          (5 + Math.random() * 9 * vel) * U * (0.7 + intensity * 0.6), handIdx(hand))) return;
      }
    }

    // Once a frame, whatever is on screen: the governor, particles, energy and Aurora.
    fx.step = function (dtMs, now) {
      lastNow = now;
      if (!fx.active) return;
      if (govOn) gov.step(dtMs);
      pool.setLimit(lvl(2) ? 0.35 : 1);
      var dt = Math.min(100, dtMs) / 1000;
      energy *= Math.exp(-dt / 1.5);
      pool.step(dt, U);
      if (cfg.layers.sparks && !lvl(2)) {
        for (var n in keyState) {   // a held key trickles a spark now and then
          var s = keyState[n], kk = lay && lay.keys[n];
          if (s.on && s.kind === "player" && kk && Math.random() < 0.18 * intensity) emit((kk.x0 + kk.x1) / 2, keyTop, kk.x1 - kk.x0, 1, s.hand, 0.3);
        }
      }
      for (var c = 0; c < curt.length; c++) { var cu = curt[c]; cu.x += (cu.tx - cu.x) * (1 - Math.exp(-dt / 1.2)); cu.a *= Math.exp(-dt / 2.5); }
      if (now >= aurNext) { aurNext = now + 100; updateAurora(now); }
    };

    // ----- Aurora: CSS elements behind the canvas -----
    // The curtains and the floor glow get a transition, so a 10 Hz update still moves smoothly on the compositor.

    fx.attachAurora = function (el) {
      el.style.cssText = "position:absolute;display:none;overflow:hidden;background:#121a28;pointer-events:none";
      var curtains = [];
      for (var i = 0; i < curt.length; i++) {
        var d = document.createElement("div");
        d.style.cssText = "position:absolute;left:0;top:0;bottom:0;opacity:0;will-change:transform,opacity;transition:transform 1.2s linear,opacity .6s linear";
        el.appendChild(d); curtains.push({ el: d, rgb: "" });
      }
      var floor = document.createElement("div");
      floor.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:28%;opacity:0;will-change:opacity;transition:opacity .4s linear";
      el.appendChild(floor);
      aur = { root: el, curtains: curtains, floor: floor, floorRgb: "", shown: false, w: 0, h: 0 };
    };

    // Where the strip is, in CSS pixels, or null when there is none (sheet music only, calibration).
    fx.setAuroraRect = function (r) { aurRect = r; };

    fx.auroraShown = function () { return !!(aur && aur.shown); };

    function hideAurora() { if (aur && aur.shown) { aur.root.style.display = "none"; aur.shown = false; } }

    function updateAurora(now) {
      if (!aur) return;
      if (!cfg.layers.aurora || lvl(1) || !aurRect) return hideAurora();
      var rs = aur.root.style;
      if (!aur.shown) { rs.display = "block"; aur.shown = true; }
      if (aur.l !== aurRect.x || aur.t !== aurRect.y || aur.w !== aurRect.w || aur.h !== aurRect.h) {
        aur.l = aurRect.x; aur.t = aurRect.y; aur.w = aurRect.w; aur.h = aurRect.h;
        rs.left = aurRect.x + "px"; rs.top = aurRect.y + "px"; rs.width = aurRect.w + "px"; rs.height = aurRect.h + "px";
      }
      var tt = now / 1000;
      for (var c = 0; c < curt.length; c++) {
        var cu = curt[c], el = aur.curtains[c], col = paletteRgb(palette, cu.pc), key = col.join(",");
        var bw = Math.round(aurRect.w * (0.12 + 0.07 * Math.sin(tt * 0.2 + cu.phase * 2) + 0.05 * cu.a));
        var sway = Math.sin(tt * 0.35 + cu.phase) * 0.05;
        var a = Math.min(1, (0.18 + 0.5 * cu.a + 0.15 * Math.min(1, energy)) * intensity);
        if (el.rgb !== key) {
          el.rgb = key;
          el.el.style.background = "radial-gradient(ellipse 50% 90% at 50% 100%," + rgba(col, 0.9) + "," + rgba(col, 0.35) + " 45%," + rgba(col, 0) + " 100%)";
        }
        el.el.style.width = bw + "px";
        el.el.style.transform = "translateX(" + Math.round((cu.x + sway) * aurRect.w - bw / 2) + "px)";
        el.el.style.opacity = a < 0.02 ? "0" : String(a.toFixed(2));
      }
      var fc = paletteRgb(palette, lastPc), fk = fc.join(",");
      if (aur.floorRgb !== fk) { aur.floorRgb = fk; aur.floor.style.background = "linear-gradient(to top," + rgba(fc, 0.55) + "," + rgba(fc, 0) + ")"; }
      aur.floor.style.opacity = Math.min(1, (0.15 + 0.35 * Math.min(1, energy)) * intensity).toFixed(2);
    }

    // ----- drawing hooks, in the order draw() calls them -----

    // After the lanes: the hit line's glow swells with the playing.
    fx.drawBehind = function () {
      if (!fx.active || !cfg.layers.neon || lvl(3)) return;
      ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = (0.15 + 0.25 * Math.min(1, energy)) * intensity * 1.5;
      ctx.drawImage(S.tone.right.halo, left, hitY - 14 * U, right - left, 30 * U);
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    };

    // In the falling-notes loop before a bar is filled. tone: "right", "left", "ok" (a played note, green) or "miss" (none:
    // judged colours win). playing: the bar is sounding now. The caller skips dimmed notes (not the player's).
    fx.barHalo = function (key, top, bottom, tone, playing) {
      if (!fx.active || !cfg.layers.neon || tone === "miss") return;
      var gap = Math.max(2, Math.round(2 * U)), sp = S.tone[tone] || S.tone.right, cx = (key.x0 + key.x1) / 2, bw = key.x1 - key.x0 - 2 * gap, h = bottom - top - 2 * gap;
      if (h <= 0) return;
      ctx.globalCompositeOperation = "lighter";
      if (!lite()) {
        // Trailing light above the bar (it falls, so the trail is behind it) and a halo on every bar.
        var tr = Math.min(h * 0.8, 160 * U);
        ctx.globalAlpha = 0.28 * intensity; ctx.drawImage(sp.fade, key.x0 + gap, top - tr, bw, tr);
        ctx.globalAlpha = (playing ? 0.85 : 0.5) * intensity;
        ctx.drawImage(sp.halo, cx - bw * 1.4, top, bw * 2.8, h + 2 * gap);
      } else if (playing) {
        // Lite: only the sounding bar glows, and only its last stretch above the hit line.
        var gh = Math.min(h, 140 * U);
        ctx.globalAlpha = 0.85 * intensity;
        ctx.drawImage(sp.halo, cx - bw * 1.2, Math.max(top, hitY - gh), bw * 2.4, gh);
      }
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    };

    // After a bar is filled: a white core strip down its middle.
    fx.barCore = function (key, top, bottom, tone, playing) {
      if (!fx.active || !cfg.layers.neon || tone === "miss" || (lite() && !playing)) return;
      var gap = Math.max(2, Math.round(2 * U)), cx = (key.x0 + key.x1) / 2, bw = key.x1 - key.x0 - 2 * gap, h = bottom - top - 2 * gap;
      if (h - gap * 2 <= 0) return;
      ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = (playing ? 0.7 : 0.35) * intensity;
      ctx.drawImage((S.tone[tone] || S.tone.right).coreStrip, cx - bw * 0.35, top + gap * 2, bw * 0.7, h - gap * 2);
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    };

    // The look of key m this frame, or null when it is untouched. baseFill is the page's own fill and judged says that
    // fill carries a judgement (green, amber, red), which then wins. Returns { fill, sink, rim, rimAlpha } (reused).
    fx.keyLook = function (m, kk, baseFill, judged, now) {
      if (!fx.active || !cfg.layers.keys) return null;
      var s = keyState[m]; if (!s) return null;
      var e = envelope(s, now); if (!(s.on || e > 0.01)) return null;
      var base = kk.black ? BLACK_BASE : WHITE_BASE, hcol = s.kind === "wrong" ? RED : hex(HAND[s.hand].want);
      look.fill = baseFill; look.sink = 0; look.depth = 0; look.rim = null; look.rimAlpha = 0;
      if (s.kind === "music") {
        // Hear it first: a tint and a bright rim, and the key does not sink.
        look.fill = css(mix(base, hcol, 0.45 * Math.min(1, e + 0.2)));
        look.rim = HAND[s.hand].white; look.rimAlpha = Math.min(1, e + 0.3);
      } else {
        // The dip follows how hard the key was played (the microphone has no velocity: mid depth); the colour is a touch
        // stronger for a harder key.
        look.depth = sinkAmount(s, now);
        look.sink = Math.round((kk.black ? 10 : 14) * U * pressDepth(s.vel) * look.depth);
        if (!judged) look.fill = css(mix(base, hcol, Math.min(1, 0.25 + 0.2 * s.vel + e * 0.6)));
      }
      return look;
    };

    // The shade under a sunk key and the rim of a Hear it first key.
    fx.keyDecor = function (lk, x0, x1, kh) {
      if (lk.sink > 0) { ctx.globalAlpha = 0.35 + 0.4 * Math.min(1, lk.sink / (12 * U)); ctx.drawImage(S.keyShade, x0 + 1, keyTop + lk.sink, x1 - x0 - 2, Math.round(kh * 0.25)); ctx.globalAlpha = 1; }
      if (lk.rim) {
        var rim = Math.max(2, Math.round(3 * U));
        ctx.fillStyle = lk.rim; ctx.globalAlpha = lk.rimAlpha;
        ctx.fillRect(x0 + 1, keyTop, rim, kh); ctx.fillRect(x1 - rim - 1, keyTop, rim, kh); ctx.fillRect(x0 + 1, keyTop + kh - rim, x1 - x0 - 2, rim);
        ctx.globalAlpha = 1;
      }
    };

    // After the keys, before the sheet music: key light, flashes and sparks. Nothing reaches above the strip's top.
    fx.drawFront = function (now) {
      if (!fx.active) return;
      var t0 = typeof performance !== "undefined" ? performance.now() : 0, I = intensity;
      ctx.save(); ctx.beginPath(); ctx.rect(0, areaTop, W, H - areaTop); ctx.clip();
      ctx.globalCompositeOperation = "lighter";
      if (cfg.layers.keys) {
        for (var q = lay.low; q <= lay.high; q++) {
          var st = keyState[q]; if (!st) continue;
          var ev = envelope(st, now);
          if (ev < 0.01) { if (!st.on) delete keyState[q]; continue; }
          var kq = lay.keys[q], w = kq.x1 - kq.x0, cx = (kq.x0 + kq.x1) / 2, sp = toneOf(st.hand), wrong = st.kind === "wrong", player = st.kind === "player";
          var gl = wrong ? S.red : sp.glow, amp = ev * (0.55 + 0.45 * st.vel) * (0.4 + 0.6 * I);
          ctx.globalAlpha = Math.min(1, amp * (player || wrong ? 1 : 0.6));
          ctx.drawImage(gl, cx - w * 1.6, keyTop - w * 1.1, w * 3.2, w * 2.2);
          if (player) { ctx.globalAlpha = Math.min(1, amp * 0.45); ctx.drawImage(gl, kq.x0, keyTop, w, (kq.black ? blackH : H - keyTop) * 0.8); }
          var bh = (keyTop - areaTop) * 0.22 * (0.5 + 0.5 * st.vel) * (0.5 + 0.5 * I);
          if (player) { ctx.globalAlpha = Math.min(1, amp * 0.8); ctx.drawImage(sp.fade, cx - w * 0.42, keyTop - bh, w * 0.84, bh); }
          else if (!wrong) {
            // Hear it first: a hollow beam with a pulse travelling up it.
            var lw = Math.max(2, 2 * U);
            ctx.globalAlpha = Math.min(1, amp * 0.9);
            ctx.drawImage(sp.fadeLite, cx - w * 0.4, keyTop - bh, lw, bh); ctx.drawImage(sp.fadeLite, cx + w * 0.4 - lw, keyTop - bh, lw, bh);
            var ph = ((now - st.t0) % 600) / 600;
            ctx.globalAlpha = Math.min(1, amp * (1 - ph));
            ctx.drawImage(sp.core, cx - w * 0.5, keyTop - bh * ph - w * 0.5, w, w);
          }
        }
        // A flat ellipse at the key's top edge that widens and fades in 260 ms.
        for (var f = flares.length - 1; f >= 0; f--) {
          var fl = flares[f], age = now - fl.t0;
          if (age > 260) { flares.splice(f, 1); continue; }
          var k2 = age / 260, fw = fl.w * (1 + 3.5 * k2) * (0.6 + 0.6 * fl.vel), fh = fl.w * (0.5 + 0.4 * k2);
          ctx.globalAlpha = (1 - k2) * (1 - k2) * (0.5 + 0.5 * I) * fl.k;
          ctx.drawImage(fl.kind === "wrong" ? S.red : toneOf(fl.hand).core, fl.x - fw / 2, fl.y - fh / 2, fw, fh);
        }
      }
      if (cfg.layers.neon) {
        for (var fi = flashes.length - 1; fi >= 0; fi--) {
          var fx2 = flashes[fi], ag = now - fx2.t0;
          if (ag > 220) { flashes.splice(fi, 1); continue; }
          var kf = ag / 220, sz = fx2.w * (2 + 4 * fx2.vel) * (0.7 + 0.5 * kf);
          ctx.globalAlpha = (1 - kf) * (0.5 + 0.5 * I) * fx2.k;
          ctx.drawImage(toneOf(fx2.hand).core, fx2.x - sz / 2, fx2.y - sz / 2, sz, sz);
        }
      }
      if (cfg.layers.sparks) {
        var p = pool.p, sr = S.tone.right.spark, sl = S.tone.left.spark;
        for (var i = 0; i < pool.cap; i++) {
          var o = i * 8; if (p[o + 4] >= p[o + 5]) continue;
          var lf = 1 - p[o + 4] / p[o + 5], sz2 = p[o + 6] * (0.4 + 0.6 * lf);
          ctx.globalAlpha = lf * lf * (0.6 + 0.4 * I);
          ctx.drawImage(p[o + 7] ? sl : sr, p[o] - sz2, p[o + 1] - sz2, sz2 * 2, sz2 * 2);
        }
      }
      ctx.restore();
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
      if (t0) stats.draw += (performance.now() - t0 - stats.draw) * 0.1;
    };

    return fx;
  }

  return {
    LAYERS: LAYERS, PRESETS: PRESETS, DEFAULT_SETTING: DEFAULT_SETTING, DEFAULT_INTENSITY: DEFAULT_INTENSITY, MIC_VELOCITY: MIC_VELOCITY, POOL_CAP: POOL_CAP,
    SLOW_MS: SLOW_MS, SLOW_HOLD_MS: SLOW_HOLD_MS, FAST_MS: FAST_MS, FAST_HOLD_MS: FAST_HOLD_MS, MAX_LEVEL: MAX_LEVEL,
    parseSetting: parseSetting, isSetting: isSetting, presetName: presetName, nextSetting: nextSetting, parseIntensity: parseIntensity, velocity01: velocity01, pressDepth: pressDepth, sinkAmount: sinkAmount, chordShare: chordShare,
    createGovernor: createGovernor, createPool: createPool, envelope: envelope, paletteRgb: paletteRgb, PALETTES: PALETTES, create: create,
  };
});
