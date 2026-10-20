"use strict";
// Piano mode storage: songs from songs/*.json and the calibration in piano-calibration.json.
// The geometry and wait-mode logic live in public/piano-core.js, shared with the pages.
const fs = require("fs");
const path = require("path");
const core = require("./public/piano-core.js");

// Every *.json file in dir is a song; its id is the file name without the extension. Files that
// do not parse are listed with their error so a bad song shows up instead of vanishing.
function loadSongs(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch {}
  return names.map((name) => {
    const id = name.slice(0, -5);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch (e) { return { id, error: `invalid JSON: ${e.message}` }; }
    const r = core.normalizeSong(raw, id);
    if (r.error) return { id, error: r.error };
    const notes = r.song.notes;
    const lowest = Math.min(...notes.map((n) => n.note)), highest = Math.max(...notes.map((n) => n.note));
    const beats = Math.max(...notes.map((n) => n.start + n.length));
    return {
      ...r.song,
      lowest, highest, beats,
      fits61: lowest >= core.DEFAULT_LOW && highest <= core.DEFAULT_HIGH,
    };
  });
}

function songSummary(s) {
  if (s.error) return { id: s.id, error: s.error };
  const { notes, ...rest } = s;
  return { ...rest, noteCount: notes.length };
}

function readCalibration(file) {
  try { return core.validCalibration(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return null; }
}

// Written to a temp file and renamed so a crash never leaves half a calibration behind.
function writeCalibration(file, input) {
  const cal = core.validCalibration(input);
  if (!cal) throw new Error("invalid calibration");
  cal.savedAt = Date.now();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cal, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return cal;
}

module.exports = { loadSongs, songSummary, readCalibration, writeCalibration };
