// Song import: MIDI and MusicXML files read into songs, the songs folder, settings and uploads.
// Run: node test/song-import.test.js (fixtures come from test/fixtures/make-fixtures.js)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../public/piano-core.js");
const I = require("../song-import.js");
const piano = require("../piano.js");

const FIX = path.join(__dirname, "fixtures");
const read = (name) => fs.readFileSync(path.join(FIX, name));
const rows = (song) => song.notes.map((n) => [P.noteName(n.note), n.start, n.length, n.hand[0].toUpperCase(), n.finger || 0].join(" "));

// Two-track MIDI: tempo, 3/4 and the track name from the tempo track, hands from the tracks
// (the higher track is the right hand), a chord, running status and velocity-0 note-offs.
let r = I.importSong(read("two-track.mid"), "two-track.mid");
assert.strictEqual(r.song.title, "Two Hands");
assert.strictEqual(r.song.bpm, 100);
assert.strictEqual(r.song.beatsPerBar, 3);
assert.strictEqual(r.info.handsFrom, "parts");
assert.deepStrictEqual(rows(r.song), ["C3 0 3 L 0", "E4 0 1 R 0", "D4 1 1 R 0", "C4 2 1 R 0", "G2 3 3 L 0", "C4 3 3 R 0", "E4 3 3 R 0"]);
// Forcing the split puts every note by itself against the split note.
r = I.importSong(read("two-track.mid"), "two-track.mid", { hands: "split", split: 62 });
assert.strictEqual(r.info.handsFrom, "split");
assert.deepStrictEqual(r.song.notes.filter((n) => n.hand === "left").map((n) => P.noteName(n.note)), ["C3", "C4", "G2", "C4"]);

// One-track MIDI: split around middle C, played timing snapped to the grid, the 20-tick ghost note
// and the drum hit dropped, default 4/4, title from the file name.
r = I.importSong(read("one-track.mid"), "one-track.mid");
assert.strictEqual(r.song.title, "one-track");
assert.strictEqual(r.song.bpm, 120);
assert.strictEqual(r.song.beatsPerBar, 4);
assert.strictEqual(r.info.handsFrom, "split");
assert.strictEqual(r.info.dropped, 1);
assert.deepStrictEqual(rows(r.song), ["C3 0 2 L 0", "C5 0 1 R 0", "D5 1 1 R 0", "G3 2 2 L 0", "E5 2 1 R 0", "B3 3.25 0.75 L 0", "C4 3.25 0.75 R 0"]);
// A different split note moves notes between the hands.
r = I.importSong(read("one-track.mid"), "one-track.mid", { split: 55 });
assert.deepStrictEqual(r.song.notes.filter((n) => n.hand === "left").map((n) => P.noteName(n.note)), ["C3"]);
// Snapping: sixteenths win unless a triplet is clearly closer.
assert.strictEqual(I.snap(0.98), 1);
assert.strictEqual(I.snap(1.3), 1.25);
assert.strictEqual(Math.round(I.snap(1.34) * 3), 4);

// MusicXML on two staves: staff 1 right, staff 2 left, fingering, a chord, a tie across the bar
// line joined into one note, the grace note and rests left out, tempo from <sound>, and the pickup
// bar shifted so bar 2 starts on a bar line.
r = I.importSong(read("two-staves.musicxml"), "two-staves.musicxml");
assert.strictEqual(r.song.title, "Two Staves & Fingers");
assert.strictEqual(r.song.composer, "Test Composer");
assert.strictEqual(r.song.bpm, 72);
assert.strictEqual(r.song.beatsPerBar, 4);
assert.strictEqual(r.info.handsFrom, "staves");
assert.strictEqual(r.info.fingers, 8);
assert.deepStrictEqual(rows(r.song), ["G4 3 1 R 5", "C3 4 4 L 5", "C5 4 1 R 1", "A#4 5 0.5 R 3", "C4 6 1 R 1", "E4 6 1 R 3", "G4 6 1 R 5", "F#4 7 3 R 4", "C1 8 4 L 0"]);
// The compressed .mxl holds the same score.
const mxl = I.importSong(read("two-staves.mxl"), "two-staves.mxl");
assert.strictEqual(mxl.info.format, "mxl");
assert.deepStrictEqual(mxl.song.notes, r.song.notes);

// Imported songs work with the rest of piano mode: chords become one step with their fingers,
// both hands are there, and the C1 below the 61 keys is moved up an octave and flagged.
const song = P.normalizeSong(r.song, "x").song;
assert.deepStrictEqual(song.hands, ["right", "left"]);
const step = P.buildSteps(song.notes).find((s) => s.start === 6);
assert.deepStrictEqual(step.notes, [60, 64, 67]);
assert.deepStrictEqual(step.fingers, { 60: 1, 64: 3, 67: 5 });
const fit = P.fitSong(song, P.DEFAULT_LOW, P.DEFAULT_HIGH);
assert.strictEqual(fit.shifted, 1);
assert.strictEqual(P.noteName(fit.notes.find((n) => n.shifted).note), "C2");
assert.strictEqual(P.barCount(song), 3);
assert.strictEqual(P.createSession(song, { hand: "left" }).steps.length, 2);

// Bad files say why.
assert.throws(() => I.importSong(Buffer.from("hello"), "x.mid"), /not a MIDI file/);
assert.throws(() => I.importSong(Buffer.from("hello"), "x.mxl"), /not a zip file/);
assert.throws(() => I.importSong(Buffer.from("<score-partwise><part>"), "x.musicxml"), /never closed/);
assert.throws(() => I.importSong(Buffer.from("<html></html>"), "x.musicxml"), /not a MusicXML score/);
assert.throws(() => I.importSong(read("two-track.mid"), "x.wav"), /not a \.mid/);

// The songs folder: JSON and imported songs side by side, an imported file whose id is taken keeps
// its extension, a broken file is listed with its error, and the sidecar settings apply.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piano-import-"));
fs.copyFileSync(path.join(__dirname, "..", "songs", "ode-to-joy.json"), path.join(dir, "ode-to-joy.json"));
fs.copyFileSync(path.join(FIX, "one-track.mid"), path.join(dir, "ode-to-joy.mid"));
fs.copyFileSync(path.join(FIX, "two-staves.mxl"), path.join(dir, "two-staves.mxl"));
fs.writeFileSync(path.join(dir, "broken.mid"), "MThd");
let list = piano.loadSongs(dir).map(piano.songSummary);
assert.deepStrictEqual(list.map((s) => s.id), ["ode-to-joy", "broken", "ode-to-joy-mid", "two-staves"]);
assert.match(list[1].error, /not a MIDI file/);
assert.strictEqual(list[2].format, "midi");
assert.strictEqual(list[3].noteCount, 9);
assert.strictEqual(list[3].fits61, false);
const v1 = list[2].version;
piano.writeImportSettings(dir, "ode-to-joy.mid", { split: 55, hands: "nonsense" });
assert.deepStrictEqual(piano.readImportSettings(dir, "ode-to-joy.mid"), { split: 55, hands: "auto" });
list = piano.loadSongs(dir).map(piano.songSummary);
assert.notStrictEqual(list[2].version, v1, "settings change the version");
assert.strictEqual(list[2].import.split, 55);
assert.strictEqual(piano.loadSongs(dir).find((s) => s.id === "ode-to-joy-mid").notes.filter((n) => n.hand === "left").length, 1);
assert(!list.some((s) => /import/.test(s.id)), "settings files are not songs");

// Uploads: safe names, only song files that import, never over an existing file.
assert.strictEqual(piano.safeFileName("../../etc/Night King (GoT)?.mxl"), "Night King (GoT).mxl");
assert.strictEqual(piano.safeFileName(".hidden.MID"), "hidden.mid");
assert.strictEqual(piano.safeFileName("song.json"), "");
assert.strictEqual(piano.safeFileName(".mid"), "");
assert.strictEqual(piano.saveUpload(dir, "two-staves.mxl", read("two-staves.mxl")).name, "two-staves 2.mxl");
assert.strictEqual(piano.saveUpload(dir, "Two Hands.mid", read("two-track.mid")).name, "Two Hands.mid");
assert.throws(() => piano.saveUpload(dir, "junk.mid", Buffer.from("nope")), /not a MIDI file/);
assert.throws(() => piano.saveUpload(dir, "notes.txt", read("two-track.mid")), /only \.mid/);
assert(!fs.existsSync(path.join(dir, "junk.mid")));
const sig = piano.folderSignature(dir);
assert(sig.includes("Two Hands.mid:"));
fs.rmSync(dir, { recursive: true });

console.log("song-import tests passed");
