"use strict";
// Tutorial mode storage: lessons from lessons/ (one JSON file per lesson) and the player's progress
// in piano-progress.json next to the score history. The step logic, validation and unlock rules live
// in public/piano-lessons.js, shared with the TV page.
const fs = require("fs");
const path = require("path");
const piano = require("./piano.js");
const L = require("./public/piano-lessons.js");

// Every *.json file in dir is a lesson, in file name order (01-..., 02-...). A lesson that does not
// validate is listed with its errors so a bad file shows up instead of vanishing. Steps that play a
// song from the library (`song: { id, from, to }`) are expanded to its notes here.
function loadLessons(dir, songsDir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch {}
  let library = null;
  const song = (id) => {
    if (!library) library = piano.loadSongs(songsDir);
    const s = library.find((x) => x.id === id);
    return s && !s.error ? s : null;
  };
  const seen = new Set();
  return names.map((name) => {
    const fallback = name.replace(/\.json$/, "").replace(/^\d+-/, "");
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch (e) { return { id: fallback, file: name, error: `invalid JSON: ${e.message}` }; }
    const r = L.validateLesson(raw, { song });
    const id = raw && typeof raw.id === "string" && raw.id ? raw.id : fallback;
    if (r.errors.length) return { id, file: name, title: raw && typeof raw.title === "string" ? raw.title : "", error: r.errors.join("; ") };
    if (seen.has(id)) return { id, file: name, title: r.lesson.title, error: `duplicate lesson id ${id}` };
    seen.add(id);
    return { ...r.lesson, file: name };
  });
}

// What the lesson list shows: no steps, just how many.
function lessonSummary(l) {
  if (l.error) return { id: l.id, title: l.title || "", error: l.error };
  return { id: l.id, title: l.title, goal: l.goal, steps: l.steps.length };
}

// Written to a temp file and renamed like the calibration, so a crash never leaves half a file.
function readProgress(file) {
  try { return L.validProgress(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return L.emptyProgress(); }
}

function writeProgress(file, progress) {
  const clean = L.validProgress(progress);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 1) + "\n");
  fs.renameSync(tmp, file);
  return clean;
}

// One progress update from the TV: { lesson, action: "step" | "attempt" | "pass", step?, score? }.
// Only lessons that exist and are unlocked can be recorded. Returns the saved progress or throws.
function updateProgress(file, lessons, body, now = Date.now()) {
  body = body || {};
  const ok = lessons.filter((l) => !l.error);
  const index = ok.findIndex((l) => l.id === body.lesson);
  if (index < 0) throw new Error("no such lesson");
  const progress = readProgress(file);
  if (!L.isUnlocked(ok, progress, index)) throw new Error("lesson is locked");
  const score = Number(body.score);
  let next;
  if (body.action === "step") {
    const step = Math.floor(Number(body.step));
    if (!(step >= 0 && step < ok[index].steps.length)) throw new Error("no such step");
    next = L.recordStep(progress, body.lesson, step, now);
  } else if (body.action === "attempt") {
    if (!(score >= 0 && score <= 1)) throw new Error("score must be 0 to 1");
    next = L.recordAttempt(progress, body.lesson, score, now);
  } else if (body.action === "pass") {
    if (!(score >= 0 && score <= 1)) throw new Error("score must be 0 to 1");
    next = L.recordPass(progress, body.lesson, score, now);
  } else throw new Error("unknown action");
  return writeProgress(file, next);
}

module.exports = { L, loadLessons, lessonSummary, readProgress, writeProgress, updateProgress };
