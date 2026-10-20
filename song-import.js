"use strict";
// Song import: Standard MIDI files (.mid) and MusicXML (.musicxml, and .mxl, which is MusicXML in a
// zip) turned into the song format of songs/*.json. Small parsers, no dependencies: the zip is read
// here and inflated with Node's zlib.
const zlib = require("zlib");

const EXTENSIONS = { ".mid": "midi", ".midi": "midi", ".mxl": "mxl", ".musicxml": "musicxml" };
// Middle C: in a file whose hands cannot be told apart, notes from here up are the right hand.
const DEFAULT_SPLIT = 60;
const MAX_NOTES = 20000;
// MIDI timing is snapped to the nearest sixteenth or eighth-note triplet, and notes shorter than a
// 64th note (before snapping) are dropped as ghost notes. Snapped notes last at least a sixteenth.
const GHOST_BEATS = 1 / 16;
const MIN_BEATS = 1 / 4;
const CHORD_BEATS = 0.09;

function formatOf(name) {
  const m = /\.[^.]+$/.exec(String(name).toLowerCase());
  return (m && EXTENSIONS[m[0]]) || "";
}

// settings: { split: MIDI note number, hands: "auto" | "split" } from the link page.
function cleanSettings(s) {
  s = s && typeof s === "object" ? s : {};
  const split = Number(s.split);
  return {
    split: Number.isInteger(split) && split >= 24 && split <= 108 ? split : DEFAULT_SPLIT,
    hands: s.hands === "split" ? "split" : "auto",
  };
}

// Turns a file's bytes into a raw song for core.normalizeSong, or throws with a reason.
// Returns { song, info } where info says how the hands were found and what was cleaned up.
function importSong(buf, fileName, settings) {
  const format = formatOf(fileName);
  const opts = cleanSettings(settings);
  if (format === "midi") return fromMidi(parseMidi(buf), fileName, opts);
  if (format === "mxl") return fromScore(parseMusicXml(xmlText(mxlScore(buf))), fileName, opts, "mxl");
  if (format === "musicxml") return fromScore(parseMusicXml(xmlText(buf)), fileName, opts, "musicxml");
  throw new Error("not a .mid, .mxl or .musicxml file");
}

function titleFromFile(fileName) {
  return String(fileName).replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim() || "Untitled";
}

const round = (x) => Math.round(x * 1e6) / 1e6;

// ---------- hands ----------

// groups: [{ notes: [...], prefer: "right" | "left" | "" }], one per MIDI track / channel or per
// MusicXML staff. Two or more groups: a group's own preference wins (MusicXML staff 1 and 2 of a
// piano part), else the highest-sounding group is the right hand, the lowest the left and any in
// between go by their average against the split. One group, or hands: "split": every note by
// itself against the split.
function assignHands(groups, opts) {
  groups = groups.filter((g) => g.notes.length);
  const all = [].concat(...groups.map((g) => g.notes));
  if (groups.length < 2 || opts.hands === "split") {
    for (const n of all) n.hand = n.note >= opts.split ? "right" : "left";
    return "split";
  }
  const avg = (g) => g.notes.reduce((a, n) => a + n.note, 0) / g.notes.length;
  const order = groups.slice().sort((a, b) => avg(b) - avg(a));
  for (const g of groups) {
    const hand = g.prefer || (g === order[0] ? "right" : g === order[order.length - 1] ? "left" : avg(g) >= opts.split ? "right" : "left");
    for (const n of g.notes) n.hand = hand;
  }
  return "parts";
}

// ---------- MIDI ----------

// Standard MIDI file, format 0 or 1 (format 2 is read as if it were 1). Returns
// { ppq, tempo (microseconds per quarter), timeSig: [num, den], name, tracks: [{ name, notes: [{ note, channel, tick, ticks, velocity }] }] }.
function parseMidi(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 14 || buf.toString("latin1", 0, 4) !== "MThd") throw new Error("not a MIDI file (no MThd header)");
  const hlen = buf.readUInt32BE(4), ntrks = buf.readUInt16BE(10), division = buf.readUInt16BE(12);
  if (division & 0x8000) throw new Error("SMPTE-timed MIDI files are not supported");
  if (!division) throw new Error("bad MIDI header: zero ticks per quarter note");
  const out = { ppq: division, tempo: 0, timeSig: null, name: "", tracks: [] };
  let pos = 8 + hlen;
  for (let t = 0; t < ntrks && pos + 8 <= buf.length; t++) {
    const id = buf.toString("latin1", pos, pos + 4), len = buf.readUInt32BE(pos + 4);
    const start = pos + 8, end = Math.min(buf.length, start + len);
    pos = start + len;
    if (id !== "MTrk") { t--; continue; }
    out.tracks.push(parseTrack(buf, start, end, out, t));
  }
  if (!out.tracks.length) throw new Error("MIDI file has no tracks");
  return out;
}

function parseTrack(buf, pos, end, song, index) {
  const track = { name: "", notes: [] };
  const open = new Map();
  let tick = 0, status = 0;
  function varLen() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      if (pos >= end) throw new Error("MIDI track ends inside a number");
      const b = buf[pos++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error("bad MIDI variable-length number");
  }
  function noteOff(ch, note) {
    const k = ch * 128 + note, q = open.get(k);
    if (!q || !q.length) return;
    const n = q.shift();
    n.ticks = tick - n.tick;
    track.notes.push(n);
  }
  while (pos < end) {
    tick += varLen();
    if (pos >= end) break;
    let b = buf[pos];
    if (b & 0x80) { pos++; if (b < 0xf0) status = b; } else if (status) b = status;
    else throw new Error("MIDI data without a status byte");
    if (b === 0xff) {
      const type = buf[pos++], len = varLen(), data = buf.subarray(pos, Math.min(end, pos + len));
      pos += len;
      if (type === 0x2f) break;
      if (type === 0x03 && !track.name) track.name = data.toString("latin1").trim();
      if (type === 0x51 && data.length === 3 && !song.tempo) song.tempo = data.readUIntBE(0, 3);
      if (type === 0x58 && data.length >= 2 && !song.timeSig) song.timeSig = [data[0], Math.pow(2, data[1])];
      continue;
    }
    if (b === 0xf0 || b === 0xf7) { pos += varLen(); continue; }
    if (b >= 0xf0) continue;
    const type = b & 0xf0, ch = b & 0x0f;
    const d1 = buf[pos++], d2 = type === 0xc0 || type === 0xd0 ? 0 : buf[pos++];
    if (type === 0x90 && d2 > 0) {
      const k = ch * 128 + d1;
      if (!open.has(k)) open.set(k, []);
      open.get(k).push({ note: d1, channel: ch, tick, ticks: 0, velocity: d2 });
    } else if (type === 0x80 || type === 0x90) noteOff(ch, d1);
  }
  // Notes never released end with the track.
  for (const q of open.values()) for (const n of q) { n.ticks = tick - n.tick; track.notes.push(n); }
  if (index === 0 && track.name) song.name = track.name;
  return track;
}

// Nearest point on the sixteenth grid, or on the triplet-eighth grid when that is clearly closer
// (a played sixteenth that is a little late should not turn into a triplet).
function snap(beat) {
  const a = Math.round(beat * 4) / 4, b = Math.round(beat * 3) / 3;
  return Math.abs(b - beat) < Math.abs(a - beat) / 2 ? b : a;
}

function fromMidi(midi, fileName, opts) {
  const groups = new Map();
  let ghosts = 0;
  for (let t = 0; t < midi.tracks.length; t++) {
    for (const n of midi.tracks[t].notes) {
      if (n.channel === 9) continue; // General MIDI drums
      const start = n.tick / midi.ppq, length = n.ticks / midi.ppq;
      if (length < GHOST_BEATS) { ghosts++; continue; }
      const key = t * 16 + n.channel;
      if (!groups.has(key)) groups.set(key, { notes: [], prefer: "" });
      groups.get(key).notes.push({ note: n.note, rawStart: start, rawEnd: start + length });
    }
  }
  const list = [...groups.values()];
  const handsFrom = assignHands(list, opts);
  // Notes struck together (within CHORD_BEATS of the first) are snapped as one, so a played chord
  // stays a chord.
  const raw = [].concat(...list.map((g) => g.notes)).sort((a, b) => a.rawStart - b.rawStart);
  let notes = [];
  for (let i = 0; i < raw.length;) {
    let j = i;
    while (j < raw.length && raw[j].rawStart - raw[i].rawStart <= CHORD_BEATS) j++;
    const group = raw.slice(i, j);
    const start = Math.max(0, snap(group.reduce((a, n) => a + n.rawStart, 0) / group.length));
    for (const n of group) {
      const end = Math.max(start + MIN_BEATS, snap(n.rawEnd));
      notes.push({ note: n.note, start, length: end - start, hand: n.hand });
    }
    i = j;
  }
  const before = notes.length;
  notes = tidy(notes);
  if (!notes.length) throw new Error("no notes in the MIDI file");
  const [num, den] = midi.timeSig || [4, 4];
  return {
    song: {
      title: midi.name && !/^(untitled|track ?\d*|piano)$/i.test(midi.name) ? midi.name : titleFromFile(fileName),
      source: "Imported from " + String(fileName).replace(/^.*[\\/]/, ""),
      bpm: midi.tempo ? Math.round(60e6 / midi.tempo) : 120,
      beatsPerBar: round(num * 4 / den) || 4,
      notes: notes.slice(0, MAX_NOTES).map(outNote),
    },
    info: { format: "midi", handsFrom, split: opts.split, hands: opts.hands, parts: list.filter((g) => g.notes.length).length, dropped: ghosts, merged: before - notes.length, snapped: true },
  };
}

// After snapping: one note per key, hand and start (the longest), and a note that is still
// sounding when the same key comes again is cut short there.
function tidy(notes) {
  notes.sort((a, b) => a.start - b.start || a.note - b.note || b.length - a.length);
  const out = [], last = new Map();
  for (const n of notes) {
    const k = n.hand + n.note, p = last.get(k);
    if (p && Math.abs(p.start - n.start) < 1e-6) continue;
    if (p && p.start + p.length > n.start + 1e-6) p.length = n.start - p.start;
    out.push(n); last.set(k, n);
  }
  return out;
}

function outNote(n) {
  const o = { note: n.note, start: round(n.start), length: round(n.length), hand: n.hand };
  if (n.finger) o.finger = n.finger;
  return o;
}

// ---------- zip (.mxl) ----------

// Entries of a zip archive: name -> { method, size, csize, offset }, from the central directory.
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (.mxl is a compressed MusicXML zip)");
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("broken zip directory");
    const nameLen = buf.readUInt16LE(pos + 28), extraLen = buf.readUInt16LE(pos + 30), commentLen = buf.readUInt16LE(pos + 32);
    entries.set(buf.toString("utf8", pos + 46, pos + 46 + nameLen), {
      method: buf.readUInt16LE(pos + 10), csize: buf.readUInt32LE(pos + 20), size: buf.readUInt32LE(pos + 24), offset: buf.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const MAX_UNZIPPED = 32 * 1024 * 1024;

function unzipEntry(buf, e) {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error("broken zip entry");
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED });
  throw new Error("unsupported zip compression method " + e.method);
}

// The score inside an .mxl: the root file named by META-INF/container.xml, else the first
// MusicXML file outside META-INF.
function mxlScore(buf) {
  const entries = zipEntries(buf);
  let name = "";
  const container = entries.get("META-INF/container.xml");
  if (container) {
    const root = findAll(parseXml(xmlText(unzipEntry(buf, container))), "rootfile")[0];
    name = root ? root.attrs["full-path"] || "" : "";
  }
  if (!entries.has(name)) name = [...entries.keys()].find((n) => !n.startsWith("META-INF/") && /\.(xml|musicxml)$/i.test(n)) || "";
  if (!name) throw new Error("no MusicXML score inside the .mxl file");
  return unzipEntry(buf, entries.get(name));
}

// ---------- XML ----------

// Bytes to text: UTF-8, or UTF-16 with a byte order mark.
function xmlText(buf) {
  if (typeof buf === "string") return buf;
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le", 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString("utf16le"); }
  return buf.toString("utf8").replace(/^﻿/, "");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] || m);
}

// Minimal XML to { name, attrs, children, text } elements; enough for MusicXML (no namespaces,
// no DTD processing). Returns the root element.
function parseXml(text) {
  const root = { name: "", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^<>[]|\[[\s\S]*?\])*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m, pos = 0;
  while ((m = re.exec(text))) {
    if (m.index !== pos) throw new Error("XML: cannot read " + JSON.stringify(text.slice(pos, pos + 40)));
    pos = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[6] != null) top.text += decode(m[6]);
    else if (m[1] != null) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1 && top.name === m[2]) stack.pop();
      else throw new Error("XML: unexpected </" + m[2] + ">");
    } else if (m[3]) {
      const el = { name: m[3], attrs: {}, children: [], text: "" };
      const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4]))) el.attrs[a[1]] = decode(a[2] != null ? a[2] : a[3]);
      top.children.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  if (pos !== text.length) throw new Error("XML: cannot read " + JSON.stringify(text.slice(pos, pos + 40)));
  if (stack.length > 1) throw new Error("XML: <" + stack[stack.length - 1].name + "> is never closed");
  const el = root.children[0];
  if (!el) throw new Error("XML: no root element");
  return el;
}

const child = (el, name) => el && el.children.find((c) => c.name === name);
const childText = (el, name) => { const c = child(el, name); return c ? c.text.trim() : ""; };
function findAll(el, name, out) {
  out = out || [];
  for (const c of el.children) { if (c.name === name) out.push(c); findAll(c, name, out); }
  return out;
}

// ---------- MusicXML ----------

const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// score-partwise MusicXML to { title, composer, bpm, beatsPerBar, pickup, groups }, with beats
// counted in quarter notes and one group per part and staff.
function parseMusicXml(text) {
  const score = parseXml(text);
  if (score.name === "score-timewise") throw new Error("timewise MusicXML is not supported (export it partwise)");
  if (score.name !== "score-partwise") throw new Error("not a MusicXML score (root is <" + score.name + ">)");
  const title = childText(child(score, "work"), "work-title") || childText(score, "movement-title");
  const ident = child(score, "identification");
  const composerEl = ident && ident.children.find((c) => c.name === "creator" && c.attrs.type === "composer");
  const partNames = {};
  for (const p of findAll(child(score, "part-list") || { children: [] }, "score-part")) partNames[p.attrs.id] = childText(p, "part-name");
  let bpm = 0, metronome = 0, beatsPerBar = 0, pickup = 0;
  const groups = new Map();
  const parts = score.children.filter((c) => c.name === "part");
  parts.forEach((part, pi) => {
    let divisions = 1, measureStart = 0, staves = 1;
    const ties = new Map();
    const firstPart = pi === 0;
    part.children.filter((c) => c.name === "measure").forEach((measure, mi) => {
      let cursor = 0, reach = 0, lastStart = 0;
      for (const el of measure.children) {
        if (el.name === "attributes") {
          const d = Number(childText(el, "divisions"));
          if (d > 0) divisions = d;
          const s = Number(childText(el, "staves"));
          if (s > 0) staves = s;
          const time = child(el, "time");
          if (time && !beatsPerBar && firstPart) {
            const beats = childText(time, "beats").split("+").reduce((a, x) => a + Number(x), 0), type = Number(childText(time, "beat-type"));
            if (beats > 0 && type > 0) beatsPerBar = beats * 4 / type;
          }
        } else if (el.name === "backup") cursor -= Number(childText(el, "duration")) || 0;
        else if (el.name === "forward") { cursor += Number(childText(el, "duration")) || 0; reach = Math.max(reach, cursor); }
        else if (el.name === "direction" || el.name === "sound") {
          const sound = el.name === "sound" ? el : child(el, "sound");
          if (sound && Number(sound.attrs.tempo) > 0 && !bpm) bpm = Number(sound.attrs.tempo);
          const met = findAll(el, "metronome")[0];
          if (met && !metronome) {
            const per = Number(childText(met, "per-minute")), unit = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25 }[childText(met, "beat-unit")] || 0;
            if (per > 0 && unit) metronome = per * unit * (child(met, "beat-unit-dot") ? 1.5 : 1);
          }
        } else if (el.name === "note") {
          const dur = Number(childText(el, "duration")) || 0;
          if (child(el, "grace") || child(el, "cue")) continue;
          const isChord = !!child(el, "chord");
          const start = isChord ? lastStart : cursor;
          if (!isChord) { lastStart = cursor; cursor += dur; }
          reach = Math.max(reach, cursor, start + dur);
          const pitch = child(el, "pitch");
          if (!pitch || child(el, "rest")) continue;
          const step = STEPS[childText(pitch, "step").toUpperCase()];
          const midi = step == null ? NaN : (Number(childText(pitch, "octave")) + 1) * 12 + step + Math.round(Number(childText(pitch, "alter")) || 0);
          if (!(midi >= 0 && midi <= 127) || dur <= 0) continue;
          const staff = Math.max(1, Number(childText(el, "staff")) || 1);
          const beat = measureStart + start / divisions, length = dur / divisions;
          const tieTypes = el.children.filter((c) => c.name === "tie").map((c) => c.attrs.type);
          const key = staff * 128 + midi, open = ties.get(key);
          if (tieTypes.includes("stop") && open && Math.abs(open.start + open.length - beat) < 1e-3) {
            open.length = beat + length - open.start;
            if (!tieTypes.includes("start")) ties.delete(key);
            continue;
          }
          const fing = findAll(el, "fingering").map((f) => Number((/[1-5]/.exec(f.text) || [])[0])).find((f) => f >= 1 && f <= 5);
          const gk = pi * 64 + staff;
          if (!groups.has(gk)) groups.set(gk, { notes: [], part: pi, staff, staves: 1, name: partNames[part.attrs.id] || "" });
          const g = groups.get(gk);
          g.staves = Math.max(g.staves, staves);
          const n = { note: midi, start: beat, length, finger: fing || 0 };
          g.notes.push(n);
          if (tieTypes.includes("start")) ties.set(key, n); else ties.delete(key);
        }
      }
      if (mi === 0 && firstPart && (measure.attrs.implicit === "yes" || measure.attrs.number === "0")) pickup = reach / divisions;
      measureStart += reach / divisions;
    });
  });
  if (!groups.size) throw new Error("no notes in the MusicXML score");
  return { title, composer: composerEl ? composerEl.text.trim() : "", bpm: bpm || metronome, beatsPerBar, pickup, groups: [...groups.values()] };
}

function fromScore(score, fileName, opts, format) {
  // Staff 1 of a two-staff part is the right hand and staff 2 the left; other parts and staves go
  // by pitch.
  for (const g of score.groups) g.prefer = g.staves === 2 && g.staff <= 2 ? (g.staff === 1 ? "right" : "left") : "";
  const handsFrom = assignHands(score.groups, opts);
  const bar = score.beatsPerBar || 4;
  // A pickup bar is shifted so the first full bar starts on a bar line.
  const shift = score.pickup > 0 && score.pickup < bar - 1e-6 ? bar - score.pickup : 0;
  const notes = tidy([].concat(...score.groups.map((g) => g.notes.map((n) => ({ ...n, start: n.start + shift })))));
  return {
    song: {
      title: score.title || titleFromFile(fileName),
      composer: score.composer,
      source: "Imported from " + String(fileName).replace(/^.*[\\/]/, ""),
      bpm: Math.round(score.bpm) || 80,
      beatsPerBar: round(bar),
      notes: notes.slice(0, MAX_NOTES).map(outNote),
    },
    info: { format, handsFrom: handsFrom === "parts" ? "staves" : "split", split: opts.split, hands: opts.hands, parts: score.groups.length, fingers: notes.filter((n) => n.finger).length, pickup: score.pickup || 0 },
  };
}

module.exports = { EXTENSIONS, DEFAULT_SPLIT, formatOf, cleanSettings, importSong, parseMidi, parseMusicXml, parseXml, zipEntries, mxlScore, snap };
