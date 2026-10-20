// Mic mode: monophonic pitch detection for a piano heard through a microphone, turned into the same
// note on / off events the Web MIDI path sends. YIN pitch (de Cheveigné and Kawahara, 2002) on a
// down-sampled signal, an energy envelope for onsets (so a repeated note is struck again), note off
// when the sound decays, and a noise gate that follows the room's noise floor.
// Plain ES5 so it runs unchanged on phones and in Node (tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PitchCore = factory();
})(this, function () {
  "use strict";

  // Piano range the detector looks for: a little below C2 to a little above C7.
  var MIN_HZ = 60, MAX_HZ = 2200;
  var YIN_THRESHOLD = 0.15;
  // How long after an onset the note that was already sounding can be confirmed as struck again.
  var SAME_NOTE_MS = 45;

  function freqToMidi(f) { return 69 + 12 * Math.log(f / 440) / Math.LN2; }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // YIN on buf[start .. start + w + tauMax): returns { freq, clarity } (clarity 0..1, 1 is a perfect
  // period) or { freq: 0, clarity } when nothing periodic is found. The search stops at the first
  // dip under the threshold, so high notes cost little.
  function yin(buf, start, w, sampleRate, opts) {
    opts = opts || {};
    var tauMin = Math.max(2, Math.floor(sampleRate / (opts.maxHz || MAX_HZ)));
    var tauMax = Math.ceil(sampleRate / (opts.minHz || MIN_HZ));
    var thr = opts.threshold || YIN_THRESHOLD;
    var d = new Float64Array(tauMax + 2), raw = new Float64Array(tauMax + 2), sum = 0, best = -1, bestVal = Infinity;
    d[0] = 1;
    for (var tau = 1; tau <= tauMax + 1; tau++) {
      var s = 0;
      for (var j = 0; j < w; j++) { var x = buf[start + j] - buf[start + j + tau]; s += x * x; }
      sum += s; raw[tau] = s;
      d[tau] = sum > 0 ? s * tau / sum : 1;
      if (tau - 1 < tauMin || tau - 1 > tauMax) continue;
      // d[tau - 1] is a local minimum once d[tau] rises again.
      var prev = d[tau - 1];
      if (prev < d[tau] && prev <= d[tau - 2]) {
        if (prev < thr) { best = tau - 1; bestVal = prev; break; }
        if (prev < bestVal) { best = tau - 1; bestVal = prev; }
      }
    }
    // Without a dip under the threshold the deepest one only counts when it is fairly clear.
    if (best < 0 || bestVal > (opts.maxDip || 0.35)) return { freq: 0, clarity: best < 0 ? 0 : 1 - bestVal };
    // Parabolic interpolation on the raw difference, which is less biased than the normalized one
    // at the short periods of the top notes.
    var a = raw[best - 1], b = raw[best], c = raw[best + 1], den = a - 2 * b + c;
    var t = den > 0 ? best + 0.5 * (a - c) / den : best;
    return { freq: sampleRate / t, clarity: Math.max(0, Math.min(1, 1 - bestVal)) };
  }

  function db(rms) { return rms > 1e-9 ? 20 * Math.log(rms) / Math.LN10 : -180; }

  // Note tracker: push() raw microphone samples (any block size) and get back note events
  // [{ on, note, velocity, time, cents?, latency? }], time in ms of stream time. opts:
  //   sampleRate (required), sensitivity -1..1 (lower or raise the gate by up to 12 dB),
  //   gateDb: how far above the noise floor a note has to be (default 12).
  // tracker.level is the latest level in dBFS, tracker.floor the noise floor, tracker.gate the gate,
  // tracker.pitch the latest { freq, clarity, midi } and tracker.note the sounding note (or -1).
  function createTracker(opts) {
    var rate = opts.sampleRate;
    // Work at about 12 kHz (44.1 and 48 kHz down by 4): the piano's fundamentals end near 2.1 kHz,
    // and YIN costs grow with the square of the rate.
    var dec = Math.max(1, Math.round(rate / 12000)), sr = rate / dec;
    var W = Math.round(sr * 0.043), tauMax = Math.ceil(sr / MIN_HZ), N = W + tauMax + 2;
    var hop = Math.round(sr * 0.0107), hopMs = hop / sr * 1000;
    // Samples go into a ring; each hop copies them out in order. YIN reads the last N; the comb
    // filter below needs up to tauMax more before them.
    var M = N + tauMax, ring = new Float32Array(M), buf = new Float32Array(M), comb = new Float32Array(N), pos = 0, filled = 0;
    var sinceHop = 0, hopSq = 0, acc = 0, phase = 0, frames = 0;
    var samples = 0;  // decimated samples seen
    var hops = [];    // energy of the last few hops
    var hist = [];    // recent frame levels in dB, newest last
    var rests = [];   // recent combRest() values while a note sounds
    var t = {
      sampleRate: rate, hopMs: hopMs,
      level: -180, floor: -70, gate: -58, pitch: { freq: 0, clarity: 0, midi: 0 }, note: -1,
      sensitivity: opts.sensitivity || 0,
    };
    var gateDb = opts.gateDb || 12;
    var pending = null;   // onset waiting for a steady pitch: { at, peak, frames: [midi] }
    var sounding = null;  // { note, freq, peak, at, quiet }
    var lastOnsetAt = -1e9;

    t.reset = function () { pending = null; if (sounding) sounding = null; t.note = -1; hist = []; };

    t.push = function (input) {
      var out = [];
      for (var i = 0; i < input.length; i++) {
        var x = input[i];
        if (dec > 1) {
          // Average each run of dec samples (a gentle low-pass) and keep one.
          acc += x;
          if (++phase < dec) continue;
          x = acc / dec; acc = 0; phase = 0;
        }
        ring[pos] = x; pos = (pos + 1) % M;
        if (filled < M) filled++;
        samples++;
        hopSq += x * x;
        if (++sinceHop >= hop) {
          // The level is taken over the last three hops (32 ms), longer than one period of the
          // lowest note, so a low note's beating partials do not read as new onsets.
          hops.push(hopSq); if (hops.length > 3) hops.shift();
          var e = 0;
          for (var h = 0; h < hops.length; h++) e += hops[h];
          frame(Math.sqrt(e / (hops.length * hop)), samples / sr * 1000, out);
          sinceHop = 0; hopSq = 0;
        }
      }
      return out;
    };

    function frame(rms, now, out) {
      var level = db(rms);
      t.level = level;
      // The floor drops at once to a quieter level and creeps up slowly, so a held note is not
      // mistaken for room noise but a noisier room raises it within a few seconds.
      if (!sounding && !pending) t.floor = level < t.floor ? level : t.floor + 0.05;
      else if (level < t.floor) t.floor = level;
      t.floor = Math.max(-90, Math.min(-25, t.floor));
      t.gate = Math.max(-72, t.floor + gateDb - 12 * t.sensitivity);
      var recentMin = Infinity;
      for (var k = Math.max(0, hist.length - 6); k < hist.length; k++) if (hist[k] < recentMin) recentMin = hist[k];
      hist.push(level); if (hist.length > 12) hist.shift();

      var p = { freq: 0, clarity: 0 }, rest = -1;
      // A pitch is needed while an onset waits for one. Otherwise it is only shown (every fourth
      // frame while a note sounds) and quiet frames skip it; the comb filter runs while a note sounds.
      frames++;
      if (filled >= M && (sounding || pending || level > t.gate - 10)) {
        buf.set(ring.subarray(pos), 0); buf.set(ring.subarray(0, pos), M - pos);
        if (pending || !sounding || frames % 4 === 0) p = yin(buf, tauMax, W, sr);
        else p = t.pitch;
        if (sounding) { rest = combRest(); if (pending) p = newPitch(p, rest); }
      }
      p.midi = p.freq ? freqToMidi(p.freq) : 0;
      t.pitch = p;

      // An onset is a quick rise in level above the gate: a struck key, also one struck again. A key
      // struck legato, as the one before is let go, may not raise the level much; then the sound
      // the sounding note does not explain (what the comb filter leaves) grows instead.
      var restMin = Infinity;
      for (k = 0; k < rests.length; k++) if (rests[k] < restMin) restMin = rests[k];
      if (rest >= 0) { rests.push(rest); if (rests.length > 6) rests.shift(); }
      var loud = level - recentMin > 6, legato = !pending && rest >= 0 && rest - restMin > 0.25;
      if (level > t.gate && (loud || legato) && now - lastOnsetAt > 70) {
        lastOnsetAt = now;
        pending = { at: now, peak: level, frames: [], legato: !loud };
      }

      if (pending) {
        pending.peak = Math.max(pending.peak, level);
        if (p.freq && p.clarity > 0.8) pending.frames.push(p.midi);
        else pending.frames.length = 0;
        var f = pending.frames, n = f.length;
        var m = n >= 2 ? (f[n - 1] + f[n - 2]) / 2 : 0, note = Math.round(m);
        // Right after an onset the analysis window still holds the note before it, so the same
        // pitch again only counts once the window is mostly new sound; a new pitch counts at once.
        // A legato onset is a different note by definition.
        var same = sounding && note === sounding.note && (pending.legato || now - pending.at < SAME_NOTE_MS);
        var steady = n >= 2 && Math.abs(f[n - 1] - f[n - 2]) < 0.5 && !same;
        if (steady) {
          if (sounding) out.push({ on: false, note: sounding.note, velocity: 0, time: now });
          sounding = { note: note, freq: midiToFreq(m), peak: pending.peak, at: now, quiet: 0 };
          rests = [];
          t.note = note;
          out.push({ on: true, note: note, velocity: velocity(pending.peak), time: now, cents: Math.round((m - note) * 100), latency: Math.round(now - pending.at + hopMs) });
          pending = null;
        } else if (now - pending.at > 160 || level < t.gate) pending = null;
        return;
      }

      if (!sounding) return;
      sounding.peak = Math.max(sounding.peak, level);
      // The note ends when it decays into the gate, or 35 dB under its peak.
      sounding.quiet = level < t.gate || level < sounding.peak - 35 ? sounding.quiet + 1 : 0;
      if (sounding.quiet >= 2) end(now, out);
    }

    // While a new note starts the one before it often still rings (legato, pedal, a resonant room),
    // and the two together look periodic at their common period, an octave or more too low. A comb
    // filter tuned to the old note's period cancels it and its harmonics; when enough sound is
    // left, that is the new note. A note struck again cancels itself and the plain pitch stands.
    // combRest() fills comb[] and returns the share of the sound left (0 when the sounding note
    // explains all of it); newPitch() then looks for the new note in what is left.
    function combRest() {
      var P = sr / sounding.freq, ip = Math.floor(P), fr = P - ip, ex = 0, ey = 0;
      for (var i = 0; i < N; i++) {
        var j = tauMax + i, back = j - ip;
        comb[i] = buf[j] - (buf[back] * (1 - fr) + buf[back - 1] * fr);
        ex += buf[j] * buf[j]; ey += comb[i] * comb[i];
      }
      return ex > 0 ? ey / ex : 0;
    }

    function newPitch(plain, rest) {
      if (rest < 0.1) return plain;
      var c = yin(comb, 0, W, sr);
      return c.freq && c.clarity > 0.8 && Math.abs(freqToMidi(c.freq) - sounding.note) > 0.6 ? c : plain;
    }

    function end(now, out) {
      out.push({ on: false, note: sounding.note, velocity: 0, time: now });
      sounding = null; t.note = -1;
    }

    // Peak level to a MIDI velocity: the gate is soft, 40 dB above it is loud.
    function velocity(peak) {
      return Math.max(1, Math.min(127, Math.round(20 + (peak - t.gate) / 40 * 107)));
    }

    // Releases the sounding note (the mic was stopped or muted).
    t.flush = function () {
      var out = [];
      if (sounding) end(samples / sr * 1000, out);
      pending = null;
      return out;
    };

    return t;
  }

  return { yin: yin, createTracker: createTracker, freqToMidi: freqToMidi, midiToFreq: midiToFreq, MIN_HZ: MIN_HZ, MAX_HZ: MAX_HZ };
});
