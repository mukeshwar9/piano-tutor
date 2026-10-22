#!/usr/bin/env node
"use strict";
// Piano tutor server: plain Node, zero runtime deps.
// Routes: /piano (TV), /piano/link (MIDI or microphone input page), /api/piano/* (songs, calibration,
// score history, tutorial lessons and progress, the room light's switch and the note relay: POST from the link page, Server-Sent Events to the TV),
// POST /api/switch (TV page switch), /api/config, /api/debug (viewport beacon, logged).
// Songs are JSON, MIDI or MusicXML files in songs/, watched for changes; the link page uploads new ones.
const http = require("http");
const fs = require("fs");
const path = require("path");
const piano = require("./piano.js");
const tvSwitch = require("./public/switch.js");
const bulbLight = require("./bulb.js");
const lightColor = require("./light.js");
const lessonStore = require("./lessons.js");
const telemetry = require("./telemetry.js");

const ROOT = __dirname;

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(process.env.PIANO_CONFIG || path.join(ROOT, "config.json"), "utf8")); } catch {}
  const calibration = process.env.PIANO_CAL || path.join(ROOT, "piano-calibration.json");
  return {
    port: Number(process.env.PIANO_PORT || file.port || 4420),
    // The wall page Fast-Forward goes back to ("{host}" is the TV page's own host); empty: no wall.
    wallUrl: String(process.env.PIANO_WALL_URL != null ? process.env.PIANO_WALL_URL : file.wallUrl || ""),
    songsDir: process.env.PIANO_SONGS_DIR || path.join(ROOT, "songs"),
    pianoCalibration: calibration,
    pianoHistory: process.env.PIANO_HISTORY || path.join(path.dirname(calibration), "piano-history.json"),
    pianoLight: process.env.PIANO_LIGHT || path.join(path.dirname(calibration), "piano-light.json"),
    lessonsDir: process.env.PIANO_LESSONS_DIR || path.join(ROOT, "lessons"),
    pianoProgress: process.env.PIANO_PROGRESS || path.join(path.dirname(calibration), "piano-progress.json"),
    // The room light's bulb: { host, port?, enabled? } from config.json only; no host, no light.
    bulb: file.bulb && typeof file.bulb === "object" ? file.bulb : {},
  };
}
const config = loadConfig();

// ---------- room light ----------

// The switch and the palette are saved next to the calibration; until they have been used,
// config.json's bulb.enabled (default on) and bulb.palette (default spectrum) decide.
function readLight() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(config.pianoLight, "utf8")) || {}; } catch {}
  const palette = [saved.palette, config.bulb.palette].find((p) => typeof p === "string" && lightColor.PALETTES[p]) || lightColor.DEFAULT_PALETTE;
  return { enabled: typeof saved.enabled === "boolean" ? saved.enabled : config.bulb.enabled !== false, palette };
}
const lightSaved = readLight();
const bulb = bulbLight.createBulb({
  host: typeof config.bulb.host === "string" ? config.bulb.host.trim() : "",
  port: Number(config.bulb.port) || undefined,
  transportKind: config.bulb.transport === "udp" || config.bulb.transport === "nc" ? config.bulb.transport : undefined,
  enabled: lightSaved.enabled,
  palette: lightSaved.palette,
  onChange: (info) => broadcast("light", info),
});

// ---------- piano relay ----------

// Server-Sent Events clients by role: "tv" pages draw, "link" pages read the keyboard, "wall" pages
// (the wall display on another server, connected across origins) only listen for switch requests.
const pianoClients = new Set();
const presence = { device: "", output: "", input: "", deviceAt: 0, lastInputAt: 0, tvState: null };
const telemetryStore = telemetry.createStore();  // the TV's speed numbers, in memory only

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data, role) {
  for (const c of pianoClients) if (!role || c.role === role) sse(c.res, event, data);
}
function presenceInfo() {
  let tv = 0, link = 0, wall = 0;
  for (const c of pianoClients) c.role === "tv" ? tv++ : c.role === "wall" ? wall++ : link++;
  return { tv, link, wall, device: presence.device, output: presence.output, input: presence.input, deviceAt: presence.deviceAt, lastInputAt: presence.lastInputAt, now: Date.now() };
}

// Identifies the code the pages are served: the server's start and the pages' files. Pages open for
// longer than that, such as the TV's, load themselves again when it changes, so a deploy reaches them.
const startedAt = Date.now();
function buildId() {
  const parts = [startedAt];
  for (const f of ["piano.html", "piano-link.html", "piano-core.js", "piano-fx.js", "piano-telemetry.js", "piano-sheet.js", "switch.js", "pitch.js"]) {
    try { const st = fs.statSync(path.join(ROOT, "public", f)); parts.push(Math.round(st.mtimeMs), st.size); } catch {}
  }
  return parts.join("-");
}

function pianoEvents(req, res, query) {
  const r = query.get("role");
  const role = r === "tv" || r === "wall" ? r : "link";
  // The wall page lives on another server, so the stream is open to other origins (it carries no secrets).
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", "Access-Control-Allow-Origin": "*" });
  res.write("retry: 2000\n\n");
  const client = { role, res };
  pianoClients.add(client);
  if (role !== "wall") sse(res, "build", { id: buildId() });
  sse(res, "calibration", piano.readCalibration(config.pianoCalibration));
  sse(res, "light", bulb.info());
  if (role === "link" && presence.tvState) sse(res, "tv-state", presence.tvState);
  broadcast("presence", presenceInfo());
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    pianoClients.delete(client);
    broadcast("presence", presenceInfo());
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > limit) { reject(new Error("body too large")); return req.resume(); }
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit = 64 * 1024) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString("utf8") || "{}"); } catch { throw new Error("invalid JSON"); }
}

const CONTROL_CMDS = ["calibrate", "nudge", "ok", "back", "restart", "pause", "song", "hand", "loop", "listen", "fingers", "progress", "view", "tempo", "speed", "metronome", "metronomeVolume", "countin", "ramp", "rampTarget", "listenAll", "learn", "fx", "fxIntensity", "telemetry"];

async function pianoPost(url, req, res) {
  let body;
  try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }); }
  if (url === "/api/piano/input") {
    // { events: [{ on: true, note: 60, velocity: 90 }, ...], device: "CASIO USB-MIDI" }
    const events = (Array.isArray(body.events) ? body.events : []).slice(0, 64)
      .filter((e) => e && Number.isInteger(e.note) && e.note >= 0 && e.note <= 127)
      .map((e) => ({ on: !!e.on, note: e.note, velocity: Number(e.velocity) || 0 }));
    if (!events.length) return json(res, 400, { error: "no valid events" });
    presence.lastInputAt = Date.now();
    for (const e of events) if (e.on && e.velocity > 0) bulb.noteOn(e.note, e.velocity);
    broadcast("midi", { events, at: presence.lastInputAt }, "tv");
    return json(res, 200, { ok: true, tv: presenceInfo().tv });
  }
  if (url === "/api/piano/control") {
    if (!CONTROL_CMDS.includes(body.cmd)) return json(res, 400, { error: "unknown command" });
    // hand: id is right | left | both. loop: from / to are bars, from 0 stops the loop. listen: the TV
    // plays the current bar (or the loop) first; listenAll: it plays the whole song, or stops it. fingers and tempo: id is on | off, empty toggles. fx: id is off | lite | neon | all
    // (or a list of layers), empty goes to the next; fxIntensity: id is 0-100. view: id is
    // notes | both | sheet (falling notes, both, sheet music), empty cycles. speed: id is
    // the tempo-mode speed in percent (50-100).
    broadcast("control", {
      cmd: body.cmd, px: Number(body.px) || 0, id: String(body.id || "").slice(0, 120),
      from: Math.max(0, Math.floor(Number(body.from)) || 0), to: Math.max(0, Math.floor(Number(body.to)) || 0),
    }, "tv");
    return json(res, 200, { ok: true, tv: presenceInfo().tv });
  }
  if (url === "/api/piano/listen") {
    // Hear it first: the TV sends what to play, link pages play it on the keyboard's MIDI output.
    // { events: [{ note, at, dur }] } in ms from now, or { stop: true }. The whole song comes as
    // chunks: { whole: true, first, last, base, span, events } where base is the chunk's start in ms
    // from the start of the song, at is from base, and a chunk may have no notes (the sender is alive).
    // The other hand played for the player: { auto: true, events, restart? } is a few notes due soon (restart
    // releases the ones still sounding first), { auto: true, stop: true } releases only those.
    if (body.auto === true) {
      if (body.stop) { broadcast("listen", { auto: true, stop: true }, "link"); return json(res, 200, { ok: true }); }
      const notes = (Array.isArray(body.events) ? body.events : []).slice(0, 200)
        .filter((e) => e && Number.isInteger(e.note) && e.note >= 0 && e.note <= 127 && Number(e.at) >= 0 && Number(e.at) <= 5000 && Number(e.dur) > 0)
        .map((e) => ({ note: e.note, at: Math.round(Number(e.at)), dur: Math.min(60000, Math.round(Number(e.dur))) }));
      const restart = body.restart === true;
      if (!notes.length && !restart) return json(res, 400, { error: "no valid events" });
      broadcast("listen", { auto: true, restart, events: notes }, "link");
      const info = presenceInfo();
      return json(res, 200, { ok: true, link: info.link, output: info.output });
    }
    if (body.stop) { broadcast("listen", { stop: true }, "link"); return json(res, 200, { ok: true }); }
    const whole = body.whole === true;
    const events = (Array.isArray(body.events) ? body.events : []).slice(0, 2000)
      .filter((e) => e && Number.isInteger(e.note) && e.note >= 0 && e.note <= 127 && Number(e.at) >= 0 && Number(e.at) <= 600000 && Number(e.dur) > 0)
      .map((e) => ({ note: e.note, at: Math.round(Number(e.at)), dur: Math.min(60000, Math.round(Number(e.dur))) }));
    if (!events.length && !whole) return json(res, 400, { error: "no valid events" });
    const msg = { events };
    if (whole) {
      const base = Number(body.base), span = Number(body.span);
      if (!(base >= 0 && base <= 4 * 3600000)) return json(res, 400, { error: "invalid base" });
      Object.assign(msg, { whole: true, first: body.first === true, last: body.last === true, base: Math.round(base), span: span > 0 ? Math.min(60000, Math.round(span)) : 4000 });
    }
    broadcast("listen", msg, "link");
    const info = presenceInfo();
    return json(res, 200, { ok: true, link: info.link, output: info.output });
  }
  if (url === "/api/piano/device") {
    // The link page reports which MIDI input and output it has open ("" when none), and whether
    // notes come from the keyboard's MIDI or a microphone (input "mic": the TV is forgiving then).
    presence.device = String(body.device || "").slice(0, 120);
    presence.output = String(body.output || "").slice(0, 120);
    presence.input = body.input === "mic" ? "mic" : "midi";
    presence.deviceAt = Date.now();
    broadcast("presence", presenceInfo());
    return json(res, 200, { ok: true });
  }
  if (url === "/api/piano/state") {
    // The TV's play state, mirrored to link pages so the person at the computer can see it.
    presence.tvState = { ...body, at: Date.now() };
    broadcast("tv-state", presence.tvState, "link");
    return json(res, 200, { ok: true });
  }
  if (url === "/api/piano/telemetry") {
    // The TV's speed numbers (every couple of seconds while its telemetry is on), kept in memory only.
    const sample = telemetryStore.add(body);
    if (!sample) return json(res, 400, { error: "fps is required" });
    broadcast("telemetry", telemetryStore.get(), "link");
    return json(res, 200, { ok: true });
  }
  if (url === "/api/piano/import") {
    // Import settings and re-import for one MIDI / MusicXML song: { id, split?, hands? }. Settings are
    // saved next to the file; either way the file is read again.
    const song = piano.loadSongs(config.songsDir).find((x) => x.id === body.id);
    if (!song) return json(res, 404, { error: "no such song" });
    if (song.format === "json") return json(res, 400, { error: "JSON songs are not imported" });
    if (body.split != null || body.hands != null) {
      const cur = piano.readImportSettings(config.songsDir, song.file);
      piano.writeImportSettings(config.songsDir, song.file, { split: body.split != null ? body.split : cur.split, hands: body.hands != null ? body.hands : cur.hands });
    }
    piano.forgetImport(config.songsDir, song.file);
    const fresh = piano.loadSongs(config.songsDir).find((x) => x.file === song.file);
    songsChanged([song.id]);
    return json(res, fresh && fresh.error ? 422 : 200, fresh ? piano.songSummary(fresh) : { error: "song vanished" });
  }
  if (url === "/api/piano/history") {
    // A finished play from the TV: { song, hand, mode, speed, loop, accuracy, bestStreak, ... }.
    // The reply carries the song's best scores before and after, so the TV can say "new best".
    let play;
    const before = piano.historySummary(config.pianoHistory)[String(body && body.song)] || null;
    try { play = piano.addPlay(config.pianoHistory, body); } catch (e) { return json(res, 400, { error: e.message }); }
    const score = piano.historySummary(config.pianoHistory)[play.song];
    broadcast("history", { play, score });
    return json(res, 200, { ok: true, play, score, previous: before });
  }
  if (url === "/api/piano/light") {
    // { enabled?: true | false, palette?: "spectrum" | ... }: the room light's switch and palette.
    // Saved, so they survive a restart.
    const hasEnabled = body.enabled !== undefined, hasPalette = body.palette !== undefined;
    if (!hasEnabled && !hasPalette) return json(res, 400, { error: "enabled or palette is required" });
    if (hasEnabled && typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled must be true or false" });
    if (hasPalette && !lightColor.PALETTES[body.palette]) return json(res, 400, { error: "unknown palette" });
    if (hasPalette) bulb.setPalette(body.palette);
    const info = hasEnabled ? bulb.setEnabled(body.enabled) : bulb.info();
    try { fs.writeFileSync(config.pianoLight, JSON.stringify({ enabled: info.enabled, palette: info.palette }) + "\n"); } catch {}
    return json(res, 200, info);
  }
  if (url === "/api/piano/progress") {
    // Tutorial progress from the TV: { lesson, action: "step" | "attempt" | "pass", step?, score? }.
    let progress;
    try { progress = lessonStore.updateProgress(config.pianoProgress, lessonStore.loadLessons(config.lessonsDir, config.songsDir), body); } catch (e) { return json(res, 400, { error: e.message }); }
    return json(res, 200, { ok: true, progress });
  }
  if (url === "/api/piano/calibration") {
    let cal;
    try { cal = piano.writeCalibration(config.pianoCalibration, body); } catch (e) { return json(res, 400, { error: e.message }); }
    broadcast("calibration", cal);
    return json(res, 200, cal);
  }
  json(res, 404, { error: "not found" });
}

// POST /api/piano/upload?name=<file name>, body: the file's bytes. Only .mid, .mxl and .musicxml
// files that import cleanly are saved, under a safe name and never over another file.
const UPLOAD_LIMIT = 8 * 1024 * 1024;
async function uploadPost(req, res, query) {
  let buf;
  try { buf = await readBody(req, UPLOAD_LIMIT); } catch (e) { return json(res, 413, { error: `${e.message} (8 MB at most)` }); }
  let saved;
  try { saved = piano.saveUpload(config.songsDir, query.get("name"), buf); } catch (e) { return json(res, 422, { error: e.message }); }
  songsChanged();
  const song = piano.loadSongs(config.songsDir).find((x) => x.file === saved.name);
  json(res, 200, song ? piano.songSummary(song) : { file: saved.name });
}

// The songs folder is watched (and checked every few seconds, as file watching can miss changes),
// so a song dropped into it reaches the TV and the link page without a restart. Pages get the new
// list and the ids of songs whose file or import settings changed.
let songVersions = null, songSignature = "";
// Song summaries with each song's best scores (score history) when it has any.
function songList() {
  const scores = piano.historySummary(config.pianoHistory);
  return piano.loadSongs(config.songsDir).map(piano.songSummary).map((x) => scores[x.id] ? { ...x, score: scores[x.id] } : x);
}
function songsChanged(changed) {
  const list = songList();
  const versions = new Map(list.map((x) => [x.id, x.version]));
  const ids = new Set(changed || []);
  if (songVersions) for (const [id, v] of versions) if (songVersions.has(id) && songVersions.get(id) !== v) ids.add(id);
  songVersions = versions;
  songSignature = piano.folderSignature(config.songsDir);
  broadcast("songs", { songs: list, changed: [...ids] });
}
function watchSongs() {
  songSignature = piano.folderSignature(config.songsDir);
  songVersions = new Map(piano.loadSongs(config.songsDir).map((x) => [x.id, x.version]));
  let timer = null;
  const check = () => { if (piano.folderSignature(config.songsDir) !== songSignature) songsChanged(); };
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 400); };
  try { fs.watch(config.songsDir, soon).on("error", () => {}); } catch {}
  setInterval(check, 5000);
}

// POST /api/switch { to: "wall" | "piano" }: every open TV page (the piano page here, or a wall page
// listening on this relay) that is not already showing the target navigates there. The link page
// uses this as its switch buttons.
async function switchPost(req, res) {
  let body;
  try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }); }
  if (!tvSwitch.isTarget(body.to)) return json(res, 400, { error: "unknown target" });
  broadcast("switch", { to: body.to });
  json(res, 200, { ok: true, ...presenceInfo() });
}

function pianoGet(url, qs, res) {
  if (url === "/api/piano/songs") return json(res, 200, { songs: songList() });
  if (url === "/api/piano/history") {
    // Newest plays first (default 50, at most 200) plus the best scores of every song.
    const n = Math.min(200, Math.max(1, Math.floor(Number(new URLSearchParams(qs).get("limit"))) || 50));
    const plays = piano.readHistory(config.pianoHistory);
    return json(res, 200, { plays: plays.slice(-n).reverse(), scores: piano.core.summarizeHistory(plays), masterAccuracy: piano.core.MASTER_ACCURACY });
  }
  if (url.startsWith("/api/piano/songs/")) {
    const id = decodeURIComponent(url.slice("/api/piano/songs/".length));
    const song = piano.loadSongs(config.songsDir).find((s) => s.id === id);
    return song ? json(res, song.error ? 422 : 200, song) : json(res, 404, { error: "no such song" });
  }
  if (url === "/api/piano/lessons") {
    return json(res, 200, { lessons: lessonStore.loadLessons(config.lessonsDir, config.songsDir).map(lessonStore.lessonSummary), progress: lessonStore.readProgress(config.pianoProgress) });
  }
  if (url.startsWith("/api/piano/lessons/")) {
    const id = decodeURIComponent(url.slice("/api/piano/lessons/".length));
    const lesson = lessonStore.loadLessons(config.lessonsDir, config.songsDir).find((l) => l.id === id);
    return lesson ? json(res, lesson.error ? 422 : 200, lesson) : json(res, 404, { error: "no such lesson" });
  }
  if (url === "/api/piano/progress") return json(res, 200, { progress: lessonStore.readProgress(config.pianoProgress) });
  if (url === "/api/piano/calibration") return json(res, 200, { calibration: piano.readCalibration(config.pianoCalibration) });
  if (url === "/api/piano/light") return json(res, 200, bulb.info());
  if (url === "/api/piano/telemetry") return json(res, 200, telemetryStore.get());
  if (url === "/api/piano/presence") return json(res, 200, presenceInfo());
  json(res, 404, { error: "not found" });
}

// ---------- http ----------

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function sendCached(res, type, body) {
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" });
  res.end(body);
}
const VEXFLOW = "/vendor/vexflow-4.2.5-bravura.js";
const SCRIPTS = ["/piano-core.js", "/piano-fx.js", "/piano-telemetry.js", "/piano-sheet.js", "/piano-lessons.js", "/pitch.js", "/pitch-worklet.js", "/switch.js"];
const json = (res, code, obj) => send(res, code, "application/json; charset=utf-8", JSON.stringify(obj));

const server = http.createServer(async (req, res) => {
  const [url, qs = ""] = (req.url || "/").split("?");
  try {
    if (url === "/") { res.writeHead(302, { Location: "/piano", "Cache-Control": "no-store" }); return res.end(); }
    if (url === "/piano") return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(ROOT, "public", "piano.html")));
    if (url === "/piano/link") return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(ROOT, "public", "piano-link.html")));
    if (SCRIPTS.includes(url)) return send(res, 200, "application/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, "public", url)));
    // Vendored VexFlow: the version is in the file name, so the TV may cache it.
    if (url === VEXFLOW) return sendCached(res, "application/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, "public", VEXFLOW)));
    if (url === "/api/switch" && req.method === "POST") return await switchPost(req, res);
    if (url === "/api/piano/events") return pianoEvents(req, res, new URLSearchParams(qs));
    if (url === "/api/piano/upload" && req.method === "POST") return await uploadPost(req, res, new URLSearchParams(qs));
    if (url.startsWith("/api/piano/")) return req.method === "POST" ? await pianoPost(url, req, res) : pianoGet(url, qs, res);
    if (url === "/api/config") return json(res, 200, { wallUrl: config.wallUrl });
    if (url === "/api/debug") {
      console.log(`[viewport] ${new Date().toISOString()} ${req.socket.remoteAddress} ${(req.url.split("?")[1] || "").replace(/&t=\d+$/, "")}`);
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 502, { error: String(e.message || e) });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`piano-tutor listening on 0.0.0.0:${config.port}`);
  watchSongs();
  bulb.start();
});
// Give the bulb back as it was when the server stops.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { bulb.stop(); setTimeout(() => process.exit(0), 1500); });
