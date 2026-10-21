"use strict";
// Colour for the room light: turns the stream of played notes into one slowly moving colour. Pure
// logic, no network and no clock of its own (every call is given `now` in ms), so it is easy to test.
//
// The look: recently played notes are remembered per pitch class and fade out over a few seconds, so
// chords blend instead of flipping. Pitch classes sit around the hue circle in fifths (C, G, D, ...),
// so harmonically close notes get close hues. The colour that is shown never jumps to the target: it
// eases towards it along the shortest way round the hue circle, and a hard cap limits how far hue,
// saturation and brightness may move in one tick. A few seconds of silence fade it to a calm warm
// glow. Every constant below can be overridden with createLight({ ... }).

const DEFAULTS = {
  tickMs: 125,            // intended step length; the caps below are per tick and scale with the real step
  energyTauMs: 2500,      // a played note's weight decays with this time constant
  noteWeight: 1,          // weight one note adds to its pitch class
  energyCap: 3,           // most weight one pitch class can hold (a held-down run cannot saturate it)
  activityScale: 1.5,     // total weight at which the colour is about two thirds of the way to "busy"
  hueOffset: 20,          // hue of C in degrees (the circle of fifths is laid out from here)
  satMin: 50, satMax: 70, // saturation percent: moderate, never a harsh pure colour
  briMin: 18, briMax: 65, // brightness percent while playing; velocity moves it by a few points only
  velBri: 12,             // brightness points the (low-passed) velocity may add
  velTauMs: 1800,         // low-pass time constant for velocity
  smoothTauMs: 900,       // easing time constant towards the target while playing
  idleAfterMs: 4000,      // silence before the fade to the idle glow begins
  idleTauMs: 2500,        // easing time constant of the fade to idle
  idle: { h: 28, s: 60, b: 12 }, // calm warm amber at low brightness
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

// Position of a pitch class on the circle of fifths (C = 0, G = 1, D = 2, ...), 12 steps round.
const fifthsPosition = (pc) => (((pc % 12) + 12) * 7) % 12;
// Hue in degrees for a MIDI note: neighbours on the circle of fifths are 30 degrees apart.
function pitchHue(note, hueOffset = DEFAULTS.hueOffset) {
  return wrap(hueOffset + fifthsPosition(note) * 30);
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
  const o = { ...DEFAULTS, ...overrides, idle: { ...DEFAULTS.idle, ...(overrides && overrides.idle) } };
  const energy = new Array(12).fill(0);
  const cur = { h: o.idle.h, s: o.idle.s, b: o.idle.b };
  let lastStep = null, lastNoteAt = -Infinity, vel = 0, velTarget = 0;

  function noteOn(note, velocity, now) {
    const pc = ((note % 12) + 12) % 12;
    energy[pc] = Math.min(o.energyCap, energy[pc] + o.noteWeight);
    velTarget = clamp((Number(velocity) || 0) / 127, 0, 1);
    lastNoteAt = now;
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
    vel += (velTarget - vel) * (1 - Math.exp(-dt * 1000 / o.velTauMs));

    const total = energy.reduce((a, b) => a + b, 0);
    const activity = 1 - Math.exp(-total / o.activityScale);
    const silent = now - lastNoteAt > o.idleAfterMs;

    let target;
    if (silent || total < 0.02) {
      target = { ...o.idle };
    } else {
      // Weighted circular mean of the remembered pitch classes' hues.
      let x = 0, y = 0;
      for (let pc = 0; pc < 12; pc++) {
        const a = pitchHue(pc, o.hueOffset) * Math.PI / 180;
        x += energy[pc] * Math.cos(a); y += energy[pc] * Math.sin(a);
      }
      // Notes spread evenly round the circle cancel out; the hue then simply stays where it is.
      const h = Math.hypot(x, y) < 1e-3 * total ? cur.h : wrap(Math.atan2(y, x) * 180 / Math.PI);
      target = {
        h,
        s: o.satMin + (o.satMax - o.satMin) * activity,
        b: clamp(o.briMin + (o.briMax - o.briMin - o.velBri) * activity + o.velBri * vel, o.briMin, o.briMax),
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

  return { noteOn, seed, step, get lastNoteAt() { return lastNoteAt; }, options: o };
}

// Whether the bulb needs a new command: first one, or a colour or brightness step that matters.
function changedEnough(last, next) {
  if (!last) return true;
  const d = Math.max(Math.abs(last.rgb[0] - next.rgb[0]), Math.abs(last.rgb[1] - next.rgb[1]), Math.abs(last.rgb[2] - next.rgb[2]));
  return d >= 3 || Math.abs(last.dimming - next.dimming) >= 1;
}

module.exports = { DEFAULTS, createLight, pitchHue, fifthsPosition, hsvToRgb, rgbToHsv, hueDelta, changedEnough };
