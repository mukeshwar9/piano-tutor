"use strict";
// Piano mode storage: songs from songs/ (JSON, MIDI and MusicXML) and the calibration in piano-calibration.json.
// The geometry and wait-mode logic live in public/piano-core.js, shared with the pages.
const fs = require("fs");
const path = require("path");
const core = require("./public/piano-core.js");
const songImport = require("./song-import.js");

// Every *.json file in dir is a song, and so is every .mid, .mxl and .musicxml file (imported by
// song-import.js and cached until the file or its settings change). A song's id is its file name
// without the extension; an imported file whose id is already taken keeps its extension in the id
// ("intro-mid"). Files that do not load are listed with their error so a bad song shows up instead
// of vanishing.
const SETTINGS_SUFFIX = ".import.json";

function songFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch {}
  const json = names.filter((n) => n.endsWith(".json") && !n.endsWith(SETTINGS_SUFFIX));
  const imports = names.filter((n) => songImport.formatOf(n));
  const taken = new Set(json.map((n) => n.slice(0, -5)));
  const files = json.map((name) => ({ name, id: name.slice(0, -5), format: "json" }));
  for (const name of imports) {
    let id = name.replace(/\.[^.]+$/, "");
    if (taken.has(id)) id = name.replace(/\.([^.]+)$/, "-$1");
    taken.add(id);
    files.push({ name, id, format: songImport.formatOf(name) });
  }
  return files;
}

const songCache = new Map();

function loadSongs(dir) {
  return songFiles(dir).map((f) => {
    const file = path.join(dir, f.name);
    let st;
    try { st = fs.statSync(file); } catch (e) { return { id: f.id, file: f.name, error: e.message }; }
    const settings = f.format === "json" ? null : readImportSettings(dir, f.name);
    const version = `${Math.round(st.mtimeMs)}-${st.size}` + (settings ? `-${settings.hands}-${settings.split}` : "");
    const hit = songCache.get(file);
    if (hit && hit.version === version) return hit.song;
    const song = loadSong(file, f, settings, version);
    songCache.set(file, { version, song });
    return song;
  });
}

function loadSong(file, f, settings, version) {
  const base = { id: f.id, file: f.name, format: f.format, version };
  let raw, info = null;
  try {
    const buf = fs.readFileSync(file);
    if (f.format === "json") raw = JSON.parse(buf.toString("utf8"));
    else ({ song: raw, info } = songImport.importSong(buf, f.name, settings));
  } catch (e) {
    return { ...base, error: f.format === "json" ? `invalid JSON: ${e.message}` : e.message };
  }
  const r = core.normalizeSong(raw, f.id);
  if (r.error) return { ...base, error: r.error };
  const notes = r.song.notes;
  const lowest = Math.min(...notes.map((n) => n.note)), highest = Math.max(...notes.map((n) => n.note));
  const beats = Math.max(...notes.map((n) => n.start + n.length));
  return {
    ...r.song,
    ...base,
    ...(info ? { import: info } : {}),
    lowest, highest, beats,
    fits61: lowest >= core.DEFAULT_LOW && highest <= core.DEFAULT_HIGH,
  };
}

// Drops the cached import of one file (or all), so the next load reads it again.
function forgetImport(dir, name) {
  if (name) songCache.delete(path.join(dir, name));
  else songCache.clear();
}

// Import settings for one file live next to it in <file>.import.json.
function readImportSettings(dir, name) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, name + SETTINGS_SUFFIX), "utf8")); } catch {}
  return songImport.cleanSettings(raw);
}

function writeImportSettings(dir, name, input) {
  const settings = songImport.cleanSettings(input);
  writeAtomic(path.join(dir, name + SETTINGS_SUFFIX), JSON.stringify(settings, null, 2) + "\n");
  return settings;
}

// A file name that is safe to save in the songs folder: letters, digits, spaces, brackets, dots,
// dashes and underscores only, no leading dot, a song extension kept. Returns "" when nothing usable is left.
function safeFileName(name) {
  const base = String(name || "").replace(/^.*[\\/]/, "");
  const ext = (/\.[^.]+$/.exec(base) || [""])[0].toLowerCase();
  if (!songImport.formatOf(ext)) return "";
  const stem = base.slice(0, base.length - ext.length).normalize("NFKD").replace(/[^\w .()-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[\s.-]+|[\s.-]+$/g, "").slice(0, 80);
  return stem ? stem + ext : "";
}

// Saves an uploaded song file after checking it imports. Never replaces a file: a name already in
// use gets " 2", " 3", ... Returns { name } or throws with the import error.
function saveUpload(dir, name, buf) {
  const safe = safeFileName(name);
  if (!safe) throw new Error("only .mid, .mxl and .musicxml files can be added");
  const r = songImport.importSong(buf, safe, null);
  const check = core.normalizeSong(r.song, "upload");
  if (check.error) throw new Error(check.error);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(safe), stem = safe.slice(0, -ext.length);
  let out = safe;
  for (let i = 2; fs.existsSync(path.join(dir, out)); i++) out = `${stem} ${i}${ext}`;
  writeAtomic(path.join(dir, out), buf);
  return { name: out };
}

// A fingerprint of the songs folder (names, sizes, times, settings), to notice changes.
function folderSignature(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch {}
  return names.filter((n) => n.endsWith(".json") || songImport.formatOf(n)).map((n) => {
    try { const st = fs.statSync(path.join(dir, n)); return `${n}:${st.size}:${Math.round(st.mtimeMs)}`; } catch { return n; }
  }).join("|");
}

function songSummary(s) {
  if (s.error) return { id: s.id, error: s.error };
  const { notes, ...rest } = s;
  return { ...rest, noteCount: notes.length };
}

function readCalibration(file) {
  try { return core.validCalibration(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return null; }
}

// Written to a temp file and renamed so a crash never leaves half a file behind.
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function writeCalibration(file, input) {
  const cal = core.validCalibration(input);
  if (!cal) throw new Error("invalid calibration");
  cal.savedAt = Date.now();
  writeAtomic(file, JSON.stringify(cal, null, 2) + "\n");
  return cal;
}

module.exports = { loadSongs, songSummary, forgetImport, readImportSettings, writeImportSettings, safeFileName, saveUpload, folderSignature, readCalibration, writeCalibration };
