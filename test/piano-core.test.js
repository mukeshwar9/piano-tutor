// Piano mode: calibration math, song loading and wait-mode logic. Run: node test/piano-core.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../public/piano-core.js");
const piano = require("../piano.js");

const near = (a, b, msg) => assert(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// Notes and names.
assert.strictEqual(P.parseNote("C4"), 60);
assert.strictEqual(P.parseNote("F#3"), 54);
assert.strictEqual(P.parseNote("Bb2"), 46);
assert(Number.isNaN(P.parseNote("H2")));
assert.strictEqual(P.noteName(36), "C2");
assert.strictEqual(P.noteName(96), "C7");
assert.strictEqual(P.whiteCount(36, 96), 36);

// Layout: 61 keys C2-C7 spread linearly between the two calibrated edges.
const cal = { low: 36, high: 96, left: 400, right: 1480 };
const L = P.keyLayout(cal);
near(L.whiteWidth, 1080 / 36, "white width");
near(L.keys[36].x0, 400, "lowest key left edge");
near(L.keys[96].x1, 1480, "highest key right edge");
near(L.keys[60].x0, 400 + 14 * 30, "C4 sits 14 white keys in");
// Every white key has the same width and they tile the strip with no gaps.
let x = 400;
for (let n = 36; n <= 96; n++) if (!P.isBlack(n)) { near(L.keys[n].x0, x, `white ${n}`); x = L.keys[n].x1; }
near(x, 1480, "whites tile the strip");
// Black keys sit at real piano offsets, not centred: C# leans left, D# right, G# in the middle.
const c4 = L.keys[60].x0, w = L.whiteWidth;
near(L.keys[61].x0, c4 + 0.6 * w, "C#4");
near(L.keys[63].x1, c4 + 2.4 * w, "D#4");
near((L.keys[68].x0 + L.keys[68].x1) / 2, c4 + 5 * w, "G#4 centred on the G/A line");
// Black keys win where they overlap white keys.
assert.strictEqual(P.keyAt(L, c4 + 0.9 * w, true), 61);
assert.strictEqual(P.keyAt(L, c4 + 0.9 * w, false), 60);
assert.strictEqual(P.keyAt(L, 10, false), -1);

// Ruler starting point: 846 mm of keys on a 1439 mm, 1920 px panel is ~1129 px, centred.
const r = P.rulerEdges({ screenPx: 1920 });
assert(Math.abs(r.right - r.left - 1129) <= 1, `ruler width ${r.right - r.left}`);
assert(Math.abs((r.left + r.right) / 2 - 960) <= 1, "ruler centred");
// Wider strip from the seat: 69 cm to the strip and 60 cm to the keys is 1.15x.
near(P.seatScale(690, 600), 1.15, "seat scale");
// A calibration made at 1920 px scales to a 3840 px canvas.
const s2 = P.scaleCalibration({ ...cal, screenPx: 1920 }, 3840);
near(s2.left, 800, "scaled left"); near(s2.right, 2960, "scaled right");

// Calibration validation.
assert(P.validCalibration({ ...cal, screenPx: 1920 }));
assert.strictEqual(P.validCalibration({ ...cal, screenPx: 1920, high: 40 }), null, "range under an octave");
assert.strictEqual(P.validCalibration({ ...cal, screenPx: 1920, left: "x" }), null, "non-numeric edge");
assert.strictEqual(P.validCalibration({ ...cal, screenPx: 1920, right: 420 }), null, "strip too narrow");
assert.strictEqual(P.validCalibration(null), null);

// Song fitting moves out-of-range notes by octaves and flags them.
const fitted = P.fitSong({ notes: [{ note: 30, start: 0, length: 1 }, { note: 60, start: 1, length: 1 }, { note: 100, start: 2, length: 1 }] }, 36, 96);
assert.deepStrictEqual(fitted.notes.map((n) => n.note), [42, 60, 88]);
assert.strictEqual(fitted.shifted, 2);

// Song file loader: the shipped song loads, fits 61 keys and is in C major around middle C.
const songs = piano.loadSongs(path.join(__dirname, "..", "songs"));
assert.strictEqual(songs.length, 1, "MVP ships one song");
const ode = songs[0];
assert(!ode.error, ode.error);
assert.strictEqual(ode.id, "ode-to-joy");
assert(ode.fits61);
assert.strictEqual(ode.notes.length, 62);
assert.strictEqual(ode.beats, 64, "16 bars of 4/4");
assert.strictEqual(P.noteName(ode.lowest), "G3");
assert.strictEqual(P.noteName(ode.highest), "G4");
// Bad song files are reported, not dropped.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piano-test-"));
fs.writeFileSync(path.join(tmp, "broken.json"), "{");
fs.writeFileSync(path.join(tmp, "bad-note.json"), JSON.stringify({ title: "x", notes: [["Q9", 0, 1]] }));
const bad = piano.loadSongs(tmp);
assert(bad.every((s) => s.error), "bad songs carry errors");

// Calibration storage round trip; invalid input is refused and the file left alone.
const calFile = path.join(tmp, "piano-calibration.json");
assert.strictEqual(piano.readCalibration(calFile), null);
const savedCal = piano.writeCalibration(calFile, { ...cal, screenPx: 1920, mode: "seat" });
assert(savedCal.savedAt > 0);
assert.deepStrictEqual(piano.readCalibration(calFile), savedCal);
assert.throws(() => piano.writeCalibration(calFile, { low: 1 }));
assert.deepStrictEqual(piano.readCalibration(calFile), savedCal);
fs.rmSync(tmp, { recursive: true });

// Steps: notes starting together form one chord step.
const steps = P.buildSteps([{ note: 60, start: 0 }, { note: 64, start: 0 }, { note: 67, start: 1 }]);
assert.deepStrictEqual(steps, [{ start: 0, notes: [60, 64] }, { start: 1, notes: [67] }]);

// Clock runs at tempo and stops at the step still waiting.
near(P.advanceClock(0, 750, 80, 10), 1, "80 bpm, 750 ms is one beat");
near(P.advanceClock(3.5, 1000, 120, 4), 4, "clock holds at the waiting step");
near(P.advanceClock(0, 1000, 60, null), 1, "no waiting step");

// Hints in plain words.
assert.strictEqual(P.hint(71, 72), "B4 → try C5, one white key to the right");
assert.strictEqual(P.hint(64, 60), "E4 → try C4, two white keys to the left");
assert.strictEqual(P.hint(60, 72), "C4 → try C5, one octave up");
assert.strictEqual(P.hint(62, 61), "D4 → try C#4, the black key just left");
assert.strictEqual(P.hint(61, 64), "C#4 → try E4, two white keys to the right");
assert.strictEqual(P.hint(63, 60), "D#4 → try C4, two white keys to the left");

// Wait mode: Ode to Joy's opening E E F G needs the repeated E struck twice.
const sess = P.createSession(P.normalizeSong(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "songs", "ode-to-joy.json"), "utf8"))).song);
assert.deepStrictEqual(sess.waitingFor(), [64]);
assert.strictEqual(sess.press(64).result, "advance");
assert.deepStrictEqual(sess.waitingFor(), [64], "second E still wanted");
const wrong = sess.press(65);
assert.strictEqual(wrong.result, "wrong");
assert.strictEqual(wrong.hint, "F4 → try E4, one white key to the left");
assert.strictEqual(sess.index, 1, "a wrong key does not advance");
assert.strictEqual(sess.streak, 0);
assert.strictEqual(sess.press(64).result, "advance");
assert.strictEqual(sess.correct, 2); assert.strictEqual(sess.wrong, 1);
near(sess.accuracy(), 2 / 3, "accuracy");
// Playing every remaining step finishes the song.
let last;
while (!sess.done) last = sess.press(sess.waitingFor()[0]).result;
assert.strictEqual(last, "done");
assert.strictEqual(sess.press(60).result, "ignored");
sess.restart();
assert.strictEqual(sess.index, 0); assert.strictEqual(sess.correct, 0);

// Chords: both keys must be struck; a repeat of the first does not count twice.
const chord = P.createSession({ notes: [{ note: 60, start: 0, length: 1 }, { note: 64, start: 0, length: 1 }, { note: 67, start: 1, length: 1 }] });
assert.strictEqual(chord.press(60).result, "correct");
assert.strictEqual(chord.press(60).result, "ignored");
assert.deepStrictEqual(chord.waitingFor(), [64]);
const cw = chord.press(66);
assert.strictEqual(cw.target, 64, "hint points at the nearest missing chord note");
assert.strictEqual(chord.press(64).result, "advance");
assert.strictEqual(chord.press(67).result, "done");

console.log("ok");
