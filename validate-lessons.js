#!/usr/bin/env node
"use strict";
// Checks every lesson in lessons/ (or the folder given as the first argument): well-formed steps, notes
// on the 61-key keyboard, texts short enough for the TV, library songs that exist. Exits 1 and says
// what is wrong when any lesson is malformed. `npm test` runs it first.
const path = require("path");
const lessons = require("./lessons.js");

function check(dir, songsDir) {
  const list = lessons.loadLessons(dir, songsDir);
  const problems = [];
  if (!list.length) problems.push(`${dir}: no lessons found`);
  list.forEach((l) => { if (l.error) problems.push(`${l.file}: ${l.error.split("; ").join(`\n  ${l.file}: `)}`); });
  return { list, problems };
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, "lessons"));
  const songs = path.resolve(process.argv[3] || process.env.PIANO_SONGS_DIR || path.join(__dirname, "songs"));
  const { list, problems } = check(dir, songs);
  if (problems.length) {
    console.error(`lesson validation failed:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`${list.length} lessons ok`);
}

module.exports = { check };
