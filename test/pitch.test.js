// Mic mode: pitch detection and note tracking on synthesized piano-like notes. Run: node test/pitch.test.js
const assert = require("assert");
const Pitch = require("../public/pitch.js");

// A seeded random source, so a failure can be reproduced.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Piano-like note: 12 slightly stretched partials (string inharmonicity), higher ones quieter and
// decaying faster, a 4 ms attack with a short hammer-noise burst, and an exponential decay.
// Low notes get a weaker fundamental than their second partial, as on a real piano.
function addNote(out, sr, midi, startS, lenS, opts) {
  opts = opts || {};
  const f0 = Pitch.midiToFreq(midi), gain = opts.gain || 0.3, B = 0.0004, rand = rng(midi * 7 + 1);
  const n0 = Math.round(startS * sr), n = Math.round(lenS * sr), parts = [];
  for (let k = 1; k <= 12; k++) {
    const f = k * f0 * Math.sqrt(1 + B * k * k);
    if (f > sr / 2 - 500) break;
    let a = 1 / k;
    if (k === 1 && midi < 48) a = 0.35;
    parts.push({ w: 2 * Math.PI * f / sr, a, decay: (opts.decay || 1.2) + 0.6 * k, ph: rand() * 2 * Math.PI });
  }
  for (let i = 0; i < n && n0 + i < out.length; i++) {
    const t = i / sr, env = Math.min(1, t / 0.004);
    let v = 0;
    for (const p of parts) v += p.a * Math.exp(-p.decay * t) * Math.sin(p.w * i + p.ph);
    if (t < 0.012) v += (rand() * 2 - 1) * 0.4 * (1 - t / 0.012);
    // Damper: the last 60 ms fade out, like a key being let go.
    const rel = Math.min(1, (lenS - t) / 0.06);
    out[n0 + i] += gain * env * rel * v;
  }
}

function signal(sr, seconds, noiseDb, seed) {
  const out = new Float32Array(Math.round(sr * seconds)), rand = rng(seed || 3), amp = Math.pow(10, (noiseDb == null ? -65 : noiseDb) / 20);
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * amp * 1.7;
  return out;
}

// Feeds a signal through a tracker in browser-sized blocks; returns every event.
function track(sig, sr, blocks, opts) {
  const tr = Pitch.createTracker(Object.assign({ sampleRate: sr }, opts));
  const out = [];
  for (let i = 0; i < sig.length; i += blocks) out.push(...tr.push(sig.subarray(i, i + blocks)));
  out.push(...tr.flush());
  return out;
}

const ons = (ev) => ev.filter((e) => e.on);

// YIN alone: a pure partial set at several notes, both sample rates.
for (const sr of [44100, 48000]) {
  for (const midi of [36, 45, 57, 60, 69, 76, 84, 96]) {
    const sig = signal(sr, 0.3, -90);
    addNote(sig, sr, midi, 0, 0.3);
    const p = Pitch.yin(sig, Math.round(0.1 * sr), Math.round(0.043 * sr), sr);
    assert(p.freq > 0, `yin finds a pitch for ${midi} at ${sr}`);
    const got = Pitch.freqToMidi(p.freq);
    assert(Math.abs(got - midi) < 0.35, `yin ${midi} at ${sr}: got ${got.toFixed(2)}`);
    assert(p.clarity > 0.8, `yin clarity ${midi}: ${p.clarity}`);
  }
}
// Noise has no pitch.
{
  const sig = signal(48000, 0.2, -20, 9);
  assert.strictEqual(Pitch.yin(sig, 0, 2064, 48000).freq, 0, "white noise has no pitch");
}

// One note at a time across the 61-key range: exactly one note on with the right note, then a note off.
for (const sr of [44100, 48000]) {
  for (const midi of [36, 40, 48, 55, 60, 64, 67, 72, 79, 84, 91, 96]) {
    const sig = signal(sr, 1.6);
    addNote(sig, sr, midi, 0.3, 1.0);
    const ev = track(sig, sr, 128);
    const on = ons(ev);
    assert.strictEqual(on.length, 1, `${midi} at ${sr}: one note on, got ${JSON.stringify(on.map((e) => e.note))}`);
    assert.strictEqual(on[0].note, midi, `${midi} at ${sr}: right note`);
    assert(Math.abs(on[0].cents) <= 30, `${midi}: in tune within 30 cents, got ${on[0].cents}`);
    assert(on[0].time - 300 < 90, `${midi}: detected within 90 ms of the onset, took ${on[0].time - 300}`);
    const off = ev.filter((e) => !e.on);
    assert.strictEqual(off.length, 1, `${midi}: one note off`);
    assert(off[0].time > on[0].time && off[0].time < 1450, `${midi}: off after the note ends (${off[0].time})`);
  }
}

// A melody, notes played legato: Ode to Joy's first phrase at 100 bpm, every note found in order.
{
  const sr = 48000, melody = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62], beat = 0.6;
  const sig = signal(sr, melody.length * beat + 1);
  melody.forEach((m, i) => addNote(sig, sr, m, 0.2 + i * beat, beat * 0.95));
  const got = ons(track(sig, sr, 512)).map((e) => e.note);
  assert.deepStrictEqual(got, melody, "melody notes in order");
}

// With the sustain pedal down each note keeps ringing under the next one: a rising arpeggio still
// gives one note on per note (until the ringing notes become a chord: that is where mic mode stops
// and the tutor's octave tolerance takes over). Played legato (each key let go just after the next is struck), a
// falling line does too.
{
  const sr = 44100, melody = [60, 64, 67, 72], beat = 0.35;
  const sig = signal(sr, melody.length * beat + 2.5);
  melody.forEach((m, i) => addNote(sig, sr, m, 0.2 + i * beat, 2, { decay: 1.5 }));
  assert.deepStrictEqual(ons(track(sig, sr, 128)).map((e) => e.note), melody, "pedalled arpeggio");
}
{
  const sr = 48000, melody = [79, 76, 72, 67, 64, 60, 55, 48], beat = 0.3;
  const sig = signal(sr, melody.length * beat + 1);
  melody.forEach((m, i) => addNote(sig, sr, m, 0.2 + i * beat, beat + 0.1));
  assert.deepStrictEqual(ons(track(sig, sr, 128)).map((e) => e.note), melody, "legato falling line");
}

// Repeated notes struck again while the first still rings register twice.
{
  const sr = 48000, sig = signal(sr, 2);
  addNote(sig, sr, 60, 0.2, 1.6, { decay: 0.8 });
  addNote(sig, sr, 60, 0.7, 1.0, { decay: 0.8 });
  const got = ons(track(sig, sr, 128));
  assert.strictEqual(got.length, 2, `re-struck C4 registers twice, got ${got.length}`);
  assert(got.every((e) => e.note === 60));
}

// A softer note after a loud one is still a new note; velocity follows the level.
{
  const sr = 44100, sig = signal(sr, 2);
  addNote(sig, sr, 67, 0.2, 0.6, { gain: 0.5 });
  addNote(sig, sr, 64, 0.9, 0.6, { gain: 0.08 });
  const got = ons(track(sig, sr, 256));
  assert.deepStrictEqual(got.map((e) => e.note), [67, 64]);
  assert(got[0].velocity > got[1].velocity, "loud note has the higher velocity");
}

// Room noise and silence give no notes; a steady hum under the gate gives none either.
{
  const sr = 48000;
  assert.strictEqual(track(signal(sr, 3, -50, 5), sr, 128).length, 0, "noise only: no notes");
  const hum = signal(sr, 3, -70, 6);
  for (let i = 0; i < hum.length; i++) hum[i] += 0.002 * Math.sin(2 * Math.PI * 100 * i / sr);
  assert.strictEqual(track(hum, sr, 128).length, 0, "quiet hum: no notes");
}

// Notes in a noisy room (noise 30 dB under the note) are still found.
{
  const sr = 48000, sig = signal(sr, 2.5, -45, 11), melody = [60, 62, 64, 65, 67];
  melody.forEach((m, i) => addNote(sig, sr, m, 0.5 + i * 0.4, 0.38));
  assert.deepStrictEqual(ons(track(sig, sr, 128)).map((e) => e.note), melody, "notes over room noise");
}

// A short click (a knock on the stand) is not a note.
{
  const sr = 48000, sig = signal(sr, 1), rand = rng(4);
  for (let i = 0; i < 200; i++) sig[24000 + i] += (rand() * 2 - 1) * 0.5;
  assert.strictEqual(ons(track(sig, sr, 128)).length, 0, "click is not a note");
}

// A minute of playing: every note found. The time is printed, not checked, because it depends on
// the machine (a phone's browser JIT runs this many times faster than real time).
{
  const sr = 48000, sig = signal(sr, 60, -50, 12);
  for (let i = 0; i < 100; i++) addNote(sig, sr, 48 + (i * 7) % 36, 0.3 + i * 0.58, 0.55);
  const t0 = Date.now(), got = ons(track(sig, sr, 128)), ms = Date.now() - t0;
  assert.deepStrictEqual(got.map((e) => e.note), Array.from({ length: 100 }, (_, i) => 48 + (i * 7) % 36), "a minute of notes");
  console.log(`a minute of audio tracked in ${ms} ms`);
}

console.log("pitch tests passed");
