"use strict";
// Colour for the room light: turns the stream of played notes into one slowly moving colour. Pure
// logic, no network and no clock of its own (every call is given `now` in ms), so it is easy to test.
//
// The look: recently played notes are remembered per pitch class and fade out over a couple of
// seconds, so chords blend instead of flipping. Each pitch class has a place on its palette (a full
// colour wheel or an arc of it); notes a fifth apart sit visibly apart, but the colour that is shown
// never jumps to the target: it eases along the shortest way round the hue circle, and a hard cap
// limits how far hue, saturation and brightness may move in one tick. The register (low to high on the
// keyboard) shifts hue and brightness a little and, with how many notes sound together, drives
// saturation. A few seconds of silence fade it to the palette's calm idle glow. Every constant below
// can be overridden with createLight({ ... }).

// Palettes: `wheel` spreads the 12 pitch classes over the whole hue circle; otherwise they spread
// over the arc from hue a to hue b (b may be below a: the arc then runs backwards, through red).
// `sat` is the saturation range in percent, `idle` the colour it fades to in silence.
const PALETTES = {
  spectrum: { label: "Spectrum", wheel: true, arc: [0, 330], sat: [55, 100], idle: { h: 28, s: 55, b: 12 } },
  aurora: { label: "Aurora", arc: [125, 285], sat: [55, 100], idle: { h: 165, s: 60, b: 12 } },
  sunset: { label: "Sunset", arc: [45, -60], sat: [55, 100], idle: { h: 12, s: 70, b: 12 } },
  ocean: { label: "Ocean", arc: [160, 245], sat: [55, 100], idle: { h: 205, s: 60, b: 12 } },
  warm: { label: "Warm", arc: [10, 60], sat: [50, 75], idle: { h: 28, s: 60, b: 12 } },
};
const DEFAULT_PALETTE = "spectrum";

const DEFAULTS = {
  palette: DEFAULT_PALETTE,
  tickMs: 125,            // intended step length; the caps below are per tick and scale with the real step
  energyTauMs: 1500,      // a played note's weight decays with this time constant
  noteWeight: 1,          // weight one note adds to its pitch class
  energyCap: 3,           // most weight one pitch class can hold (a held-down run cannot saturate it)
  mixPower: 2,            // the mix weighs each pitch class by its weight to this power: the newest notes lead
  activityScale: 1.5,     // total weight at which the colour is about two thirds of the way to "busy"
  polyNotes: 4,           // pitch classes sounding together at which the chord term of saturation is full
  satTauMs: 1500,         // low-pass time constant for the saturation target
  regLow: 36, regHigh: 96,// the register range (MIDI notes) mapped to 0..1
  regHue: 60,             // degrees the register may shift hue (halved on an arc palette)
  regBri: 8,              // brightness points the register may shift (high notes brighter)
  briMin: 18, briMax: 65, // brightness percent while playing; velocity moves it by a few points only
  velBri: 10,             // brightness points the (low-passed) velocity may add
  velTauMs: 1800,         // low-pass time constant for velocity
  smoothTauMs: 600,       // easing time constant towards the target while playing
  idleAfterMs: 4000,      // silence before the fade to the idle glow begins
  idleTauMs: 2500,        // easing time constant of the fade to idle
  capHue: 6,              // degrees per tick, at most
  capSat: 3,              // saturation points per tick, at most
  capBri: 2.5,            // brightness points per tick, at most (20 per second)
  idleCapHue: 2, idleCapSat: 1, idleCapBri: 1, // slower caps while fading to idle
  minDimming: 10,         // the bulb's lowest brightness
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap = (h) => ((h % 360) + 360) % 360;
// Shortest signed way from a to b round the hue circle, in (-180, 180].
function hueDelta(a, b) {
  let d = wrap(b - a);
  if (d > 180) d -= 360;
  return d;
}

// Where a pitch class sits on its palette, 0..1: in pitch order (C lowest, B highest), so a scale or a
// melody moving by steps walks along the palette in one direction, and a fifth is a visibly different
// colour (7 of 11 steps away). The twelve are all distinct.
const paletteT = (note) => (((note % 12) + 12) % 12) / 11;
const paletteOf = (name) => PALETTES[name] || PALETTES[DEFAULT_PALETTE];
const hueAt = (pal, t) => wrap(pal.arc[0] + (pal.arc[1] - pal.arc[0]) * t);
// Hue in degrees for a MIDI note in a palette (the register shift is left out).
function pitchHue(note, palette = DEFAULT_PALETTE) {
  return hueAt(paletteOf(palette), paletteT(note));
}

// h in degrees, s and v in 0..1 -> [r, g, b] in 0..255.
function hsvToRgb(h, s, v) {
  const hh = wrap(h) / 60, i = Math.floor(hh), f = hh - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
// [r, g, b] in 0..255 -> { h degrees, s 0..1, v 0..1 }.
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: wrap(h * 60), s: max ? d / max : 0, v: max };
}

// Moves a value towards a target by an eased fraction of the way, but never by more than cap.
function ease(cur, target, rate, cap) {
  return cur + clamp((target - cur) * rate, -cap, cap);
}

function createLight(overrides) {
  const o = { ...DEFAULTS, ...overrides };
  let pal = paletteOf(o.palette), palName = PALETTES[o.palette] ? o.palette : DEFAULT_PALETTE;
  const idleOf = () => ({ ...pal.idle, ...(overrides && overrides.idle) });
  const energy = new Array(12).fill(0);
  const cur = { h: idleOf().h, s: idleOf().s, b: idleOf().b };
  let lastStep = null, lastNoteAt = -Infinity, vel = 0, velTarget = 0, satLP = pal.sat[0];
  let noteMass = 0, noteSum = 0; // decaying weight and weight x note: the mean register

  function noteOn(note, velocity, now) {
    const pc = ((note % 12) + 12) % 12;
    energy[pc] = Math.min(o.energyCap, energy[pc] + o.noteWeight);
    noteMass += o.noteWeight; noteSum += o.noteWeight * note;
    velTarget = clamp((Number(velocity) || 0) / 127, 0, 1);
    lastNoteAt = now;
  }

  // Switch palette: the shown colour eases over to the new one like any other change.
  function setPalette(name) {
    if (!PALETTES[name]) return false;
    palName = name; pal = PALETTES[name];
    return true;
  }

  // Start the shown colour from where the bulb already is, so taking control does not jump.
  function seed(h, s, b) {
    cur.h = wrap(h); cur.s = clamp(s, 0, 100); cur.b = clamp(b, o.minDimming, 100);
    lastStep = null;
  }

  // Advance to time `now` and return the colour to show: { h, s, b } (degrees, percent, percent),
  // plus rgb at full value and dimming for the bulb, and whether the idle fade is under way.
  function step(now) {
    const dt = lastStep == null ? o.tickMs / 1000 : clamp((now - lastStep) / 1000, 0, 0.5);
    lastStep = now;
    const scale = dt / (o.tickMs / 1000);

    const decay = Math.exp(-dt * 1000 / o.energyTauMs);
    for (let i = 0; i < 12; i++) energy[i] *= decay;
    noteMass *= decay; noteSum *= decay;
    vel += (velTarget - vel) * (1 - Math.exp(-dt * 1000 / o.velTauMs));

    const total = energy.reduce((a, b) => a + b, 0);
    const activity = 1 - Math.exp(-total / o.activityScale);
    const silent = now - lastNoteAt > o.idleAfterMs;
    const idle = idleOf();

    let target;
    if (silent || total < 0.02) {
      target = { ...idle };
      satLP = idle.s;
    } else {
      // Weighted mean of the remembered pitch classes' places on the palette: a circular mean on the
      // wheel, a plain one along an arc. Notes spread evenly round the wheel cancel out; the hue then
      // simply stays where it is.
      const mixTotal = energy.reduce((a, e) => a + Math.pow(e, o.mixPower), 0);
      let base;
      if (pal.wheel) {
        let x = 0, y = 0;
        for (let pc = 0; pc < 12; pc++) {
          const a = hueAt(pal, paletteT(pc)) * Math.PI / 180;
          const w = Math.pow(energy[pc], o.mixPower);
          x += w * Math.cos(a); y += w * Math.sin(a);
        }
        base = Math.hypot(x, y) < 1e-3 * mixTotal ? cur.h : wrap(Math.atan2(y, x) * 180 / Math.PI);
      } else {
        let t = 0;
        for (let pc = 0; pc < 12; pc++) t += Math.pow(energy[pc], o.mixPower) * paletteT(pc);
        base = hueAt(pal, t / mixTotal);
      }
      // The register: low notes lean one way, high notes the other, a little, in hue and brightness,
      // and extremes of the keyboard and fuller chords are more saturated.
      const reg = noteMass > 1e-6 ? clamp((noteSum / noteMass - o.regLow) / (o.regHigh - o.regLow), 0, 1) : 0.5;
      const poly = clamp((energy.filter((e) => e > 0.3).length - 1) / (o.polyNotes - 1), 0, 1);
      const satGoal = pal.sat[0] + (pal.sat[1] - pal.sat[0]) * clamp(0.35 + 0.35 * Math.abs(reg - 0.5) * 2 + 0.3 * poly + 0.2 * activity, 0, 1);
      satLP += (satGoal - satLP) * (1 - Math.exp(-dt * 1000 / o.satTauMs));
      target = {
        h: wrap(base + (reg - 0.5) * o.regHue * (pal.wheel ? 1 : 0.5)),
        s: clamp(satLP, pal.sat[0], pal.sat[1]),
        b: clamp(o.briMin + (o.briMax - o.briMin - o.velBri - o.regBri) * activity + o.velBri * vel + o.regBri * reg, o.briMin, o.briMax),
      };
    }

    const rate = 1 - Math.exp(-dt * 1000 / (silent ? o.idleTauMs : o.smoothTauMs));
    const capH = (silent ? o.idleCapHue : o.capHue) * scale;
    const capS = (silent ? o.idleCapSat : o.capSat) * scale;
    const capB = (silent ? o.idleCapBri : o.capBri) * scale;
    cur.h = wrap(cur.h + clamp(hueDelta(cur.h, target.h) * rate, -capH, capH));
    cur.s = ease(cur.s, target.s, rate, capS);
    cur.b = ease(cur.b, target.b, rate, capB);

    const dimming = Math.round(clamp(cur.b, o.minDimming, 100));
    return { h: cur.h, s: cur.s, b: cur.b, rgb: hsvToRgb(cur.h, cur.s / 100, 1), dimming, silent };
  }

  return {
    noteOn, seed, step, setPalette, idle: idleOf,
    get palette() { return palName; },
    get lastNoteAt() { return lastNoteAt; },
    options: o,
  };
}

// Whether the bulb needs a new command: first one, or a colour or brightness step that matters.
function changedEnough(last, next) {
  if (!last) return true;
  const d = Math.max(Math.abs(last.rgb[0] - next.rgb[0]), Math.abs(last.rgb[1] - next.rgb[1]), Math.abs(last.rgb[2] - next.rgb[2]));
  return d >= 3 || Math.abs(last.dimming - next.dimming) >= 1;
}

module.exports = { DEFAULTS, PALETTES, DEFAULT_PALETTE, createLight, pitchHue, paletteT, hsvToRgb, rgbToHsv, hueDelta, changedEnough };
