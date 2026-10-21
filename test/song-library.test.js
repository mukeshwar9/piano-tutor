"use strict";
// Song library: every shipped song loads, fits the keyboard and passes the structural checks.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../public/piano-core.js");
const piano = require("../piano.js");

const songsDir = path.join(__dirname, "..", "songs");
const expected = [
  "mary-had-a-little-lamb", "frere-jacques", "london-bridge", "au-clair-de-la-lune",
  "twinkle-twinkle-little-star", "ode-to-joy", "when-the-saints-go-marching-in", "jingle-bells",
  "amazing-grace", "minuet-in-g", "greensleeves", "canon-in-d", "fur-elise",
];

// Finger of a raw note: the number in the hand's place, or the fifth field.
function rawFinger(r) {
  if (!Array.isArray(r)) return r && r.finger;
  return typeof r[3] === "number" ? r[3] : r[4];
}

// Every problem with the songs in dir, as "<id>: <what>" strings. [] when all pass.
function problems(dir) {
  const out = [];
  for (const s of piano.loadSongs(dir)) {
    const id = s.id;
    if (s.error) { out.push(`${id}: ${s.error}`); continue; }
    if (!s.fits61) out.push(`${id}: does not fit 61 keys`);
    if (!String(s.title).trim()) out.push(`${id}: empty title`);
    if (!String(s.composer).trim()) out.push(`${id}: empty composer`);

    const raw = JSON.parse(fs.readFileSync(path.join(dir, s.file), "utf8"));
    if (raw.license !== "Public domain") out.push(`${id}: license is ${JSON.stringify(raw.license)}`);
    if (typeof raw.source !== "string" || !raw.source.trim()) out.push(`${id}: empty source`);
    if (!Number.isInteger(raw.difficulty) || raw.difficulty < 1 || raw.difficulty > 5) out.push(`${id}: difficulty ${JSON.stringify(raw.difficulty)} is not 1-5`);

    const bars = s.beats / s.beatsPerBar;
    if (Math.abs(bars - Math.round(bars)) >= 1e-6) out.push(`${id}: ${s.beats} beats is not a whole number of bars`);

    for (const r of raw.notes) {
      if (!P.isFinger(rawFinger(r))) out.push(`${id}: note ${JSON.stringify(r)} has no finger`);
    }

    // Same hand, same key: a note must end before the next one on that key starts.
    const last = {};
    for (const n of s.notes) {
      const k = n.hand + ":" + n.note;
      const prev = last[k];
      if (prev && n.start < prev.start + prev.length - 1e-6) out.push(`${id}: ${n.hand} hand overlaps on ${P.noteName(n.note)} at beat ${n.start}`);
      last[k] = n;
    }
  }
  return out;
}

// The real folder: all songs present and clean.
const songs = piano.loadSongs(songsDir);
const ids = songs.map((x) => x.id);
assert(songs.length >= 13, `only ${songs.length} songs`);
for (const id of expected) assert(ids.includes(id), `missing song ${id}`);
const found = problems(songsDir);
assert.deepStrictEqual(found, [], found.join("\n"));

// Negative check: a malformed song in a temp folder is reported; the good copy is not.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piano-lib-"));
try {
  fs.copyFileSync(path.join(songsDir, "ode-to-joy.json"), path.join(tmp, "ode-to-joy.json"));
  fs.writeFileSync(path.join(tmp, "broken.json"), JSON.stringify({
    title: "Broken", composer: "Nobody", source: "test", license: "Public domain", difficulty: 1,
    notes: [["H9", 0, 1]],
  }));
  const bad = problems(tmp);
  assert(bad.length > 0, "a broken song must be reported");
  assert(bad.every((m) => m.startsWith("broken:")), bad.join("\n"));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("song-library tests passed");
