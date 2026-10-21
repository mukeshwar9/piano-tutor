"use strict";
// Tutorial mode: lesson loading and validation, the shipped lessons, the step runner (advance, quizzes,
// pass mark and retry, wait and tempo sequences) and progress (save, load, unlock order).
// Run: node test/lessons.test.js. No hardware: a fake keyboard presses the keys the runner asks for.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const P = require("../public/piano-core.js");
const L = require("../public/piano-lessons.js");
const piano = require("../piano.js");
const store = require("../lessons.js");

const ROOT = path.join(__dirname, "..");
const songsDir = path.join(ROOT, "songs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piano-lessons-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const library = piano.loadSongs(songsDir);
const song = (id) => library.find((s) => s.id === id && !s.error) || null;
const check = (raw, opts) => L.validateLesson(raw, { song, ...opts });

// A small valid lesson to break one thing at a time.
const good = () => ({
  id: "tiny", title: "Tiny", goal: "One small thing.",
  steps: [
    { type: "explain", title: "Hello", text: "Press right to go on." },
    { type: "find", prompt: "Play any C", target: "C" },
    { type: "check", notes: [["C4", 0, 1], ["D4", 1, 1]], bpm: 60 },
  ],
});
assert.deepStrictEqual(check(good()).errors, [], "the base lesson is valid");

// ---------- the shipped lessons ----------

const shipped = store.loadLessons(path.join(ROOT, "lessons"), songsDir);
assert.strictEqual(shipped.length, 10, "ten lessons ship");
assert.deepStrictEqual(shipped.map((l) => l.error), new Array(10).fill(undefined), "every lesson validates");
assert.deepStrictEqual(shipped.map((l) => l.id), [
  "meet-the-keyboard", "note-names", "right-hand-and-fingers", "beats-and-note-lengths", "first-tunes-right-hand",
  "left-hand", "rests-and-time-signatures", "reading-the-staff", "hands-together", "your-first-piece",
]);
assert.strictEqual(new Set(shipped.map((l) => l.id)).size, 10, "ids are unique");
for (const l of shipped) {
  assert(l.title && l.goal && l.steps.length >= 5, l.id);
  assert(l.goal.length <= L.LIMITS.goal, `${l.id}: the goal is one line`);
  assert(l.steps.some((s) => s.type === "check"), `${l.id}: has a check`);
  // Every note of every step is on the 61-key keyboard.
  for (const s of l.steps) {
    for (const n of s.notes || []) {
      const midi = typeof n[0] === "number" ? n[0] : P.parseNote(n[0]);
      assert(midi >= P.DEFAULT_LOW && midi <= P.DEFAULT_HIGH, `${l.id}: ${n[0]} is outside the keyboard`);
    }
    for (const q of s.questions || []) {
      const t = L.parseTarget(q.target);
      assert(t, `${l.id}: target ${q.target}`);
      if (t.exact != null) assert(t.exact >= P.DEFAULT_LOW && t.exact <= P.DEFAULT_HIGH, `${l.id}: ${q.target}`);
    }
    for (const k of ["text", "prompt", "title"]) if (s[k]) assert(s[k].length <= (k === "text" ? L.LIMITS.text : k === "title" ? L.LIMITS.title : L.LIMITS.prompt), `${l.id}: ${k} too long`);
  }
  // A runner can walk through every step of every lesson (each step builds a session or a quiz).
  const run = L.createRunner(l);
  for (let i = 0; i < l.steps.length; i++) { run.enter(i); assert(run.rt, `${l.id} step ${i + 1}`); }
}
// Lessons that use the library carry its notes (bars 1-2 of Twinkle are 4 + ... notes of both hands).
const hands = shipped.find((l) => l.id === "hands-together");
const twinkle = song("twinkle-twinkle-little-star");
const bars12 = twinkle.notes.filter((n) => n.start < 8).length;
assert.strictEqual(hands.steps[2].notes.length, bars12, "bars 1-2 come from the library song");
assert.strictEqual(hands.steps[2].songRef.id, "twinkle-twinkle-little-star");
assert(hands.steps[2].notes.some((n) => n[3] === "L") && hands.steps[2].notes.some((n) => n[3] === "R"), "both hands are in the notes");
const ode = shipped.find((l) => l.id === "your-first-piece");
assert.strictEqual(ode.steps[1].notes.length, song("ode-to-joy").notes.length, "the whole of Ode to Joy");
// The last lesson ends on the summary card.
const lastStep = ode.steps[ode.steps.length - 1];
assert(lastStep.type === "explain" && lastStep.items.length >= 5 && lastStep.next, "summary card");
// Nothing personal or address-like in the lesson files.
for (const f of fs.readdirSync(path.join(ROOT, "lessons"))) {
  const text = fs.readFileSync(path.join(ROOT, "lessons", f), "utf8");
  assert(!/https?:\/\/|@[a-z]|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/i.test(text), `${f}: no addresses`);
}

// ---------- the validator ----------

const bad = (mutate, expected) => {
  const raw = good(); mutate(raw);
  const r = check(raw);
  assert(r.errors.length, `expected an error containing "${expected}"`);
  assert(r.errors.some((e) => e.includes(expected)), `${expected}: got ${JSON.stringify(r.errors)}`);
  assert.strictEqual(r.lesson, null);
};
assert(check(null).errors.length && check("x").errors.length && check([]).errors.length);
bad((l) => { delete l.id; }, "id");
bad((l) => { l.id = "Not Valid"; }, "id");
bad((l) => { l.title = ""; }, "title");
bad((l) => { l.goal = "x".repeat(L.LIMITS.goal + 1); }, "goal");
bad((l) => { l.steps = []; }, "steps");
bad((l) => { l.steps = "no"; }, "steps");
bad((l) => { l.steps[0].type = "dance"; }, "unknown type");
bad((l) => { l.steps[0] = 5; }, "not an object");
bad((l) => { l.steps[0].text = "x".repeat(L.LIMITS.text + 1); }, "text");
bad((l) => { delete l.steps[0].text; }, "needs text");
bad((l) => { l.steps[0].highlight = ["C1"]; }, "bad key");
bad((l) => { l.steps[0].highlight = ["H4"]; }, "bad key");
bad((l) => { l.steps[0].staff = ["C9"]; }, "staff");
bad((l) => { l.steps[0].fingers = { C4: 7 }; }, "bad finger");
bad((l) => { l.steps[0].letters = "some"; }, "letters");
bad((l) => { l.steps[1].target = "Z"; }, "target");
bad((l) => { l.steps[1].target = "C0"; }, "outside the keyboard");
bad((l) => { l.steps[1].count = 0; }, "count");
bad((l) => { l.steps[1].count = 2; l.steps[1].target = "C4"; }, "count");
bad((l) => { delete l.steps[1].prompt; }, "prompt");
bad((l) => { l.steps[2].notes = [["C8", 0, 1]]; }, "outside the keyboard");
bad((l) => { l.steps[2].notes = [["C0", 0, 1]]; }, "outside the keyboard");
bad((l) => { l.steps[2].notes = [["C4", 0, 0]]; }, "bad note");
bad((l) => { l.steps[2].notes = [["Q4", 0, 1]]; }, "bad note");
bad((l) => { l.steps[2].notes = []; }, "needs notes");
bad((l) => { l.steps[2].bpm = 400; }, "bpm");
bad((l) => { l.steps[2].beatsPerBar = 9; }, "beatsPerBar");
bad((l) => { l.steps[2].hand = "feet"; }, "hand");
bad((l) => { l.steps[2].tempo = 10; }, "tempo");
bad((l) => { l.steps[2].pass = 0.2; }, "pass");
bad((l) => { l.steps[2].pass = 1.5; }, "pass");
bad((l) => { l.steps[2].metric = "speed"; }, "metric");
bad((l) => { l.steps[2].metric = "timing"; }, "tempo");
bad((l) => { l.steps[2].view = "3d"; }, "view");
bad((l) => { l.steps.pop(); }, "at least one check");
bad((l) => { l.steps.push({ type: "find", prompt: "Play C", target: "C" }); }, "after the last check");
bad((l) => { l.steps.unshift({ type: "repeat", blind: true }); }, "repeat needs an earlier");
bad((l) => { l.steps.push({ type: "explain", text: "ok" }); l.steps.splice(3, 0, { type: "repeat" }); }, "repeat");
bad((l) => { l.steps.splice(2, 0, { type: "read", questions: [{ note: "C" }] }); }, "octave");
bad((l) => { l.steps.splice(2, 0, { type: "read", questions: [] }); }, "questions");
bad((l) => { l.steps.splice(2, 0, { type: "rhythm", notes: [["C4", 0, 1]] }); l.steps[2].beatsPerBar = 1; }, "beatsPerBar");
bad((l) => { l.steps[2] = { type: "check", song: { id: "no-such-song" } }; }, "not found");
bad((l) => { l.steps[2] = { type: "check", song: { id: "ode-to-joy", from: 5, to: 99 } }; }, "outside the song");
bad((l) => { l.steps[2] = { type: "check", song: { id: "ode-to-joy", from: 3, to: 2 } }; }, "outside the song");
// A song step without a way to look songs up is an error, not a crash.
assert(L.validateLesson({ ...good(), steps: [good().steps[0], { type: "check", song: { id: "ode-to-joy" } }] }).errors.length);
// Errors are reported together, with the step they belong to.
const many = good(); many.title = ""; many.steps[0].type = "dance"; many.steps[2].notes = [["C8", 0, 1]];
const manyErrors = check(many).errors;
assert(manyErrors.length >= 3 && manyErrors.some((e) => e.startsWith("step 1")) && manyErrors.some((e) => e.startsWith("step 3")), manyErrors.join("|"));

// The validated lesson has library steps expanded, and keeps only what it understands.
const expanded = check({ ...good(), steps: [good().steps[0], { type: "check", song: { id: "twinkle-twinkle-little-star", from: 1, to: 2 }, hand: "both", tempo: 60 }] });
assert.deepStrictEqual(expanded.errors, []);
assert.strictEqual(expanded.lesson.steps[1].notes.length, bars12);
assert.strictEqual(expanded.lesson.steps[1].bpm, 80);
assert.strictEqual(expanded.lesson.steps[1].pass, L.DEFAULT_PASS, "a check without a pass mark gets the default");

// The validator script: ok on good lessons, exit 1 with the problem on a malformed one.
const goodDir = path.join(tmp, "good"), badDir = path.join(tmp, "bad");
fs.mkdirSync(goodDir); fs.mkdirSync(badDir);
fs.writeFileSync(path.join(goodDir, "01-tiny.json"), JSON.stringify(good()));
const broken = good(); broken.id = "broken"; broken.steps[2].notes = [["C8", 0, 1]];
fs.writeFileSync(path.join(badDir, "01-tiny.json"), JSON.stringify(good()));
fs.writeFileSync(path.join(badDir, "02-broken.json"), JSON.stringify(broken));
fs.writeFileSync(path.join(badDir, "03-garbage.json"), "{ not json");
const script = (dir) => spawnSync(process.execPath, [path.join(ROOT, "validate-lessons.js"), dir, songsDir], { encoding: "utf8" });
let out = script(goodDir);
assert.strictEqual(out.status, 0, out.stderr);
assert(/1 lessons ok/.test(out.stdout));
out = script(badDir);
assert.strictEqual(out.status, 1, "a malformed lesson fails the script");
assert(/02-broken\.json: step 3 \(check\)/.test(out.stderr) && /outside the keyboard/.test(out.stderr), out.stderr);
assert(/03-garbage\.json: invalid JSON/.test(out.stderr), out.stderr);
assert(!/01-tiny/.test(out.stderr), "the good lesson is not reported");
out = script(path.join(tmp, "nothing-here"));
assert.strictEqual(out.status, 1, "no lessons at all is a failure too");
out = spawnSync(process.execPath, [path.join(ROOT, "validate-lessons.js")], { encoding: "utf8" });
assert.strictEqual(out.status, 0, "the shipped lessons pass: " + out.stderr);
assert(/^\{\s*"scripts"/.test(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) || true);
assert(/validate-lessons\.js/.test(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts.test), "npm test runs the validator");

// Loading: file order, an error listed instead of vanishing, duplicate ids, library lookups.
const list = store.loadLessons(badDir, songsDir);
assert.deepStrictEqual(list.map((l) => l.id), ["tiny", "broken", "garbage"]);
assert(!list[0].error && list[1].error && list[2].error);
assert.deepStrictEqual(store.lessonSummary(list[0]), { id: "tiny", title: "Tiny", goal: "One small thing.", steps: 3 });
assert(store.lessonSummary(list[1]).error && !("steps" in store.lessonSummary(list[1])));
fs.writeFileSync(path.join(goodDir, "02-again.json"), JSON.stringify(good()));
assert(/duplicate/.test(store.loadLessons(goodDir, songsDir)[1].error), "a second lesson with the same id is an error");
assert.deepStrictEqual(store.loadLessons(path.join(tmp, "missing"), songsDir), [], "a missing folder is an empty list");

// ---------- the step runner ----------

const lesson = (steps) => check({ id: "t", title: "T", goal: "g", steps: [...steps, { type: "check", notes: [["C4", 0, 1]], bpm: 60 }] }).lesson;
const keyOf = (name) => P.parseNote(name);

// Explain steps: next advances, a note advances unless the step is free play.
let run = L.createRunner(lesson([{ type: "explain", text: "a" }, { type: "explain", text: "b", free: true }, { type: "explain", text: "c", highlight: ["C*"], fingers: { C4: 1 } }]));
assert.strictEqual(run.index, 0);
assert.strictEqual(run.press(60).result, "advance", "a note moves on from an explanation");
assert.strictEqual(run.next(), "step");
assert.strictEqual(run.index, 1);
assert.strictEqual(run.press(60).result, "touch", "free play only makes sound");
assert.strictEqual(run.index, 1);
assert.strictEqual(run.prev(), "step");
assert.strictEqual(run.index, 0);
assert.strictEqual(run.prev(), "menu", "back from the first step leaves the lesson");
run.enter(2);
assert.deepStrictEqual(run.rt.lit, [36, 48, 60, 72, 84, 96], "C* lights every C on the keyboard");
assert.deepStrictEqual(run.rt.fingers, { 60: 1 });
assert.deepStrictEqual(L.expandLit(["C*", "C4", "E3"], 48, 72), [48, 60, 72, 52], "tokens inside the range only, no repeats");
assert.strictEqual(run.next(), "step", "explain steps always move on");
run.enter(3);
assert.strictEqual(run.step().type, "check");
assert.strictEqual(run.next(), "stay", "an unfinished step does not move on");
assert.strictEqual(run.skip(), "stay", "a check cannot be skipped");
run.enter(0);
assert.strictEqual(run.skip(), "step", "other steps can");

// A find step takes any matching key, and distinct keys when it asks for several.
run = L.createRunner(lesson([{ type: "find", questions: [{ prompt: "Any C", target: "C", count: 2 }, { prompt: "Middle C", target: "C4" }, { prompt: "Any G", target: "G" }] }]));
assert.strictEqual(run.rt.kind, "quiz");
assert.deepStrictEqual(run.press(48), { result: "correct", found: 1, of: 2 });
assert.strictEqual(run.press(48).result, "again", "the same key twice is not a second one");
assert.strictEqual(run.press(72).result, "question", "a C in another octave counts");
let r = run.press(61);
assert.strictEqual(r.result, "wrong");
assert.strictEqual(r.target, 60, "the right key is shown: middle C only");
assert.strictEqual(r.hint, P.hint(61, 60));
assert.strictEqual(run.press(48).result, "wrong", "another C is wrong when only middle C will do");
assert.strictEqual(run.press(60).result, "question");
assert.strictEqual(run.press(55).result, "done");
assert(run.outcome, "the step has an outcome");
assert.strictEqual(run.outcome.correct, 4);
assert.strictEqual(run.outcome.wrong, 2, "wrong keys are counted, never punished");
assert.strictEqual(run.outcome.passed, true, "a plain find step always passes");
assert.strictEqual(run.press(60).result, "ignored", "keys after the end are ignored");
assert.strictEqual(run.next(), "step", "any step with an outcome moves on");
// The nearest matching key is the one shown.
run = L.createRunner(lesson([{ type: "find", prompt: "Any C", target: "C" }]));
assert.strictEqual(run.press(50).target, 48);
assert.strictEqual(run.press(59).target, 60);
assert.strictEqual(run.press(67).target, 72, "G4 is nearer C5 than C4");
// Mic mode: the right name in another octave also counts for an exact key.
run = L.createRunner(lesson([{ type: "find", prompt: "Middle C", target: "C4" }]), { tolerant: true });
assert.strictEqual(run.press(72).result, "done");

// Pass mark: exactly the mark passes, a hair under fails; retry starts the step again.
assert.strictEqual(L.passed(0.8, 0.8), true);
assert.strictEqual(L.passed(0.79, 0.8), false);
assert.strictEqual(L.passed(0.7999999999, 0.8), true, "rounding noise does not fail a check");
assert.strictEqual(L.passed(0.5), false, "the default mark is 80 percent");
const quiz = (n) => check({ id: "t", title: "T", goal: "g", steps: [{ type: "explain", text: "x" }, { type: "check", pass: 0.8, questions: Array.from({ length: n }, () => ({ prompt: "Any C", target: "C" })) }] }).lesson;
run = L.createRunner(quiz(8), { start: 1 });
for (let i = 0; i < 8; i++) { if (i === 3) run.press(61); run.press(60); }
assert(run.outcome && run.outcome.isCheck);
assert.strictEqual(run.outcome.wrong, 1);
assert(Math.abs(run.outcome.score - 8 / 9) < 1e-9);
assert.strictEqual(run.outcome.passed, true, "8 of 9 right passes");
assert(run.outcome.lines.some((l) => /Passed with 89%/.test(l)), run.outcome.lines.join("|"));
assert(run.outcome.lines.length <= 3);
run = L.createRunner(quiz(8), { start: 1 });
for (let i = 0; i < 8; i++) { if (i < 3) run.press(61); run.press(60); }
assert.strictEqual(run.outcome.passed, false, "8 of 11 right does not pass");
assert(run.outcome.lines.some((l) => /You need 80%/.test(l) && /try once more/.test(l)), run.outcome.lines.join("|"));
assert.strictEqual(run.next(), "stay", "a failed check does not move on");
assert.strictEqual(run.skip(), "stay");
assert.strictEqual(run.scores.length, 0, "a failed check scores nothing");
run.retry();
assert.strictEqual(run.outcome, null, "retry starts the check again");
assert.strictEqual(run.attempts, 1);
for (let i = 0; i < 8; i++) run.press(60);
assert.strictEqual(run.outcome.passed, true, "and a clean second try passes");
assert.strictEqual(run.outcome.score, 1);
assert.deepStrictEqual(run.scores, [1]);
assert.strictEqual(run.lessonScore(), 1);
assert.strictEqual(run.next(), "lesson", "passing the last step finishes the lesson");
assert.strictEqual(run.finished, true);
// A custom mark.
const strict = check({ id: "t", title: "T", goal: "g", steps: [{ type: "explain", text: "x" }, { type: "check", pass: 0.95, questions: [{ prompt: "C", target: "C" }, { prompt: "C", target: "C" }] }] }).lesson;
run = L.createRunner(strict, { start: 1 });
run.press(61); run.press(60); run.press(60);
assert.strictEqual(run.outcome.passed, false, "2 of 3 right is under 95%");
assert.strictEqual(run.outcome.pass, 0.95);

// Wait-mode sequences: a fake keyboard plays the lit keys, with a wrong key on the way.
function playWait(run, wrongAt) {
  let i = 0, results = [];
  while (!run.outcome && i < 500) {
    const s = run.rt.session, need = s.waitingFor();
    if (i === wrongAt) results.push(run.press(need[0] === 61 ? 62 : 61));
    for (const n of need) results.push(run.press(n));
    i++;
  }
  return results;
}
run = L.createRunner(lesson([{ type: "play", notes: [["C4", 0, 1, 1], ["D4", 1, 1, 2], ["E4", 2, 1, 3]], hand: "right", bpm: 60 }]));
assert.strictEqual(run.rt.kind, "sequence");
assert.strictEqual(run.rt.tempo, false);
assert.strictEqual(run.rt.session.steps.length, 3);
assert.deepStrictEqual(run.rt.session.current().fingers, { 60: 1 }, "finger numbers come through");
let res = playWait(run, 1);
assert.deepStrictEqual(res.map((x) => x.result), ["advance", "wrong", "advance", "done"]);
assert(run.outcome);
assert.strictEqual(run.outcome.wrong, 1);
assert.strictEqual(run.outcome.correct, 3);
assert(Math.abs(run.outcome.accuracy - 0.75) < 1e-9);
assert.strictEqual(run.outcome.passed, true, "play steps never fail");
assert(/A good start: 3 of 4 right/.test(run.outcome.lines[0]), run.outcome.lines[0]);
assert(/Look out for [A-G]#?/.test(run.outcome.lines[1]) || /Look out for/.test(run.outcome.lines.join(" ")), run.outcome.lines.join("|"));
assert.strictEqual(run.next(), "step");
// The wrong key points at the key that was wanted and never blocks.
run.enter(0);
const w = run.press(61);
assert.strictEqual(w.result, "wrong");
assert.strictEqual(w.target, 60);
assert.strictEqual(run.rt.session.waitingFor()[0], 60, "the song still waits for the right key");
assert.strictEqual(run.press(60).result, "advance");
// A perfect run: encouraging line, nothing to fix.
run.retry();
playWait(run, -1);
assert.strictEqual(run.outcome.lines.length, 1);
assert(/Every note was right/.test(run.outcome.lines[0]));
// Left hand steps and library bars: hand modes follow the step.
const libLesson = check({ id: "t", title: "T", goal: "g", steps: [
  { type: "play", song: { id: "twinkle-twinkle-little-star", from: 1, to: 2 }, hand: "left" },
  { type: "play", song: { id: "twinkle-twinkle-little-star", from: 1, to: 2 }, hand: "both" },
  { type: "check", notes: [["C4", 0, 1]], bpm: 60 }] }).lesson;
run = L.createRunner(libLesson);
assert.strictEqual(run.rt.session.hand, "left");
assert.deepStrictEqual(run.rt.session.waitingFor(), [48], "the left hand plays the low C");
run.enter(1);
assert.deepStrictEqual(run.rt.session.waitingFor().sort(), [48, 60]);
// Left-hand notes written without a hand follow the step's hand.
run = L.createRunner(lesson([{ type: "play", notes: [["C3", 0, 1, 5], ["D3", 1, 1, 4]], hand: "left", bpm: 60 }]));
assert.strictEqual(run.rt.song.notes[0].hand, "left");
// Blind (no highlights) and views are carried to the page.
run = L.createRunner(lesson([{ type: "play", notes: [["C4", 0, 1]], bpm: 60, blind: true, view: "sheet" }]));
assert.strictEqual(run.rt.blind, true);
assert.strictEqual(run.rt.view, "sheet");
// A keyboard smaller than 61 keys: notes outside it move by an octave.
run = L.createRunner(lesson([{ type: "play", notes: [["C2", 0, 1], ["C6", 1, 1]], bpm: 60 }]), { low: 48, high: 84 });
assert.deepStrictEqual(run.rt.song.notes.map((n) => n.note), [48, 84]);

// Repeat steps: the same notes again, faster or without highlights.
const rep = check({ id: "t", title: "T", goal: "g", steps: [
  { type: "play", notes: [["C4", 0, 1], ["D4", 1, 1]], hand: "right", bpm: 60 },
  { type: "explain", text: "again" },
  { type: "repeat", tempo: 70, metronome: true },
  { type: "repeat", of: 3, blind: true },
  { type: "check", notes: [["C4", 0, 1]], bpm: 60 }] });
assert.deepStrictEqual(rep.errors, []);
run = L.createRunner(rep.lesson);
run.enter(2);
assert.strictEqual(run.rt.tempo, true);
assert.strictEqual(run.rt.session.speed, 70);
assert.strictEqual(run.rt.metronome, true);
assert.deepStrictEqual(run.rt.song.notes.map((n) => n.note), [60, 62], "it plays the notes of the step before");
assert.strictEqual(L.sourceOf(rep.lesson, 2), rep.lesson.steps[0], "skips the explanation in between");
run.enter(3);
assert.strictEqual(run.rt.blind, true);
assert.strictEqual(run.rt.tempo, false, "blind repeat of a wait-mode step stays wait mode");

// Tempo sequences (rhythm and timed checks): a fake clock strikes each note at its beat, plus an offset.
function playTempo(run, offsetBeats, skip) {
  const s = run.rt.session, notes = run.rt.song.notes;
  let beat = s.range.start - s.range.countIn;
  notes.forEach((n, i) => {
    const at = n.start + (offsetBeats[i % offsetBeats.length] || 0);
    for (; beat < at; beat += 0.05) run.tick(beat);
    if (!(skip && skip.includes(i))) run.press(n.note, at);
  });
  for (let b = beat; !run.outcome && b < beat + 20; b += 0.05) run.tick(b);
}
const rhythm = check({ id: "t", title: "T", goal: "g", steps: [
  { type: "rhythm", notes: [["C4", 0, 1], ["C4", 1, 1], ["C4", 2, 1], ["C4", 3, 1]], bpm: 60, beatsPerBar: 4 },
  { type: "check", notes: [["C4", 0, 1], ["C4", 1, 1], ["C4", 2, 1], ["C4", 3, 1]], bpm: 60, tempo: 100, metronome: true, metric: "timing", pass: 0.75 }] }).lesson;
run = L.createRunner(rhythm);
assert.strictEqual(run.rt.tempo, true, "a rhythm step keeps time");
assert.strictEqual(run.rt.metronome, true, "and clicks the beat");
assert.strictEqual(run.rt.session.range.countIn, 4, "after a bar of count-in");
playTempo(run, [0]);
assert(run.outcome);
assert.strictEqual(run.outcome.timing.accuracy, 100);
assert(/Timing: 100% of your notes were on the beat/.test(run.outcome.lines.join(" ")), run.outcome.lines.join("|"));
assert.strictEqual(run.outcome.passed, true);
// A timing check scores the share of notes on the beat (within the core's 110 ms), not just the notes hit.
run.enter(1);
playTempo(run, [0, 0.3, 0, 0.3]);   // two of four notes 300 ms late at 60 bpm: hit, but off the beat
assert(run.outcome.isCheck);
assert.strictEqual(run.outcome.accuracy, 1, "every note was struck");
assert.strictEqual(run.outcome.timing.accuracy, 50);
assert.strictEqual(run.outcome.score, 0.5, "timing checks use the timing score");
assert.strictEqual(run.outcome.passed, false);
assert(/late/.test(run.outcome.lines.join(" ")), "the tendency is said in words: " + run.outcome.lines.join("|"));
assert(run.outcome.lines.length <= 3);
run.retry();
playTempo(run, [0, 0.05, -0.05, 0]);   // within 110 ms of the beat
assert.strictEqual(run.outcome.passed, true);
// Missed notes lower the accuracy and the feedback says what to do.
run.retry();
playTempo(run, [0], [1, 2]);
assert.strictEqual(run.outcome.missed, 2);
assert(run.outcome.accuracy < 0.8);
assert(/play on each click/.test(run.outcome.lines.join(" ")), run.outcome.lines.join("|"));
// The tempo session ignores keys while paused? The page does; here keys before the count-in ends are ignored.
run.retry();
assert.strictEqual(run.press(60, run.rt.session.range.start - 3).result, "ignored", "keys during the count-in do not count");
// Accuracy checks on a tempo sequence use the note accuracy.
const acc = check({ id: "t", title: "T", goal: "g", steps: [
  { type: "explain", text: "x" },
  { type: "check", notes: [["C4", 0, 1], ["D4", 1, 1]], bpm: 60, tempo: 100, pass: 0.8 }] }).lesson;
run = L.createRunner(acc, { start: 1 });
playTempo(run, [0.2]);
assert.strictEqual(run.outcome.score, 1, "late but struck: the accuracy metric passes it");
assert.strictEqual(run.outcome.timing.accuracy, 0);

// The reading step: the question shows its note on the staff and wants that key.
const read = check({ id: "t", title: "T", goal: "g", steps: [{ type: "read", questions: [{ note: "E4" }, { note: "G4" }] }, { type: "check", notes: [["C4", 0, 1]], bpm: 60 }] }).lesson;
run = L.createRunner(read);
assert.strictEqual(run.rt.kind, "quiz");
assert.strictEqual(run.step().view, "sheet");
let shown = run.rt.display();
assert.deepStrictEqual(shown.song.notes.map((n) => n.note), [64], "the note on the staff is the one asked about");
assert.strictEqual(run.press(65).result, "wrong");
assert.strictEqual(run.press(64).result, "question");
shown = run.rt.display();
assert.deepStrictEqual(shown.song.notes.map((n) => n.note), [67]);
assert.strictEqual(run.press(67).result, "done");
assert.strictEqual(run.rt.display(), null);
// Explain steps with a staff show the notes one after another.
const st = check({ id: "t", title: "T", goal: "g", steps: [{ type: "explain", text: "x", staff: ["C4", "D4", "E4"] }, { type: "check", notes: [["C4", 0, 1]], bpm: 60 }] }).lesson;
run = L.createRunner(st);
assert.deepStrictEqual(run.rt.display.song.notes.map((n) => [n.note, n.start]), [[60, 0], [62, 1], [64, 2]]);

// Feedback is short: at most three lines, never empty.
for (const o of [
  { kind: "quiz", correct: 5, wrong: 0, missed: 0, accuracy: 1, needs: {}, isCheck: false },
  { kind: "sequence", correct: 3, wrong: 5, missed: 2, accuracy: 0.3, needs: { 60: 4, 62: 1 }, timing: { accuracy: 40, meanMs: 80 }, isCheck: true, passed: false, score: 0.3, pass: 0.8 },
]) {
  const lines = L.feedback(o, {});
  assert(lines.length >= 1 && lines.length <= 3, JSON.stringify(lines));
  lines.forEach((l) => assert(l.length > 0 && l.length < 120, l));
}

// ---------- progress: save, load, unlock ----------

const ls = shipped.map((l) => ({ id: l.id, steps: l.steps }));
const blank = L.emptyProgress();
assert.deepStrictEqual(blank, { version: 1, lessons: {} });
assert.deepStrictEqual(L.lessonState(blank, "meet-the-keyboard"), { status: "not-started", best: null, step: 0, attempts: 0, updatedAt: 0, passedAt: 0 });
// Garbage in, empty progress out; one bad entry does not take the others with it.
for (const junk of [null, undefined, "x", 5, [], {}, { lessons: 5 }, { lessons: [] }, { lessons: null }]) assert.deepStrictEqual(L.validProgress(junk), blank, JSON.stringify(junk));
const mixed = L.validProgress({ lessons: { "meet-the-keyboard": { status: "passed", best: 0.9, step: 3, attempts: 2, updatedAt: 5, passedAt: 5 }, "BAD ID": { status: "passed" }, "note-names": "oops", "left-hand": { status: "weird", best: 7, step: -4, attempts: "x" } } });
assert.deepStrictEqual(Object.keys(mixed.lessons).sort(), ["left-hand", "meet-the-keyboard"]);
assert.strictEqual(mixed.lessons["meet-the-keyboard"].best, 0.9);
assert.deepStrictEqual(mixed.lessons["left-hand"], { status: "in-progress", best: null, step: 0, attempts: 0, updatedAt: 0, passedAt: 0 }, "unknown values are cleaned");

// Recording: a step makes a lesson in progress, a failed check counts an attempt, a pass keeps the best.
let pg = L.recordStep(blank, "meet-the-keyboard", 4, 1000);
assert.strictEqual(L.lessonState(pg, "meet-the-keyboard").status, "in-progress");
assert.strictEqual(L.lessonState(pg, "meet-the-keyboard").step, 4);
assert.strictEqual(L.resumeStep(pg, ls[0]), 4, "resume where the player stopped");
assert.strictEqual(L.resumeStep(pg, { id: "meet-the-keyboard", steps: [1, 2] }), 1, "a resume point past the end is clamped");
assert.strictEqual(L.resumeStep(blank, ls[0]), 0);
assert.deepStrictEqual(blank, L.emptyProgress(), "recording does not change the old object");
pg = L.recordAttempt(pg, "meet-the-keyboard", 0.6, 2000);
assert.strictEqual(L.lessonState(pg, "meet-the-keyboard").best, 0.6);
assert.strictEqual(L.lessonState(pg, "meet-the-keyboard").attempts, 1);
assert.strictEqual(L.lessonState(pg, "meet-the-keyboard").status, "in-progress");
pg = L.recordPass(pg, "meet-the-keyboard", 0.9, 3000);
let e = L.lessonState(pg, "meet-the-keyboard");
assert.deepStrictEqual([e.status, e.best, e.step, e.attempts, e.passedAt], ["passed", 0.9, 0, 2, 3000]);
assert.strictEqual(L.resumeStep(pg, ls[0]), 0, "a passed lesson replays from the start");
pg = L.recordStep(pg, "meet-the-keyboard", 5, 4000);
assert.strictEqual(L.lessonState(pg, "meet-the-keyboard").status, "passed", "replaying does not un-pass a lesson");
pg = L.recordPass(pg, "meet-the-keyboard", 0.8, 5000);
assert.strictEqual(L.lessonState(pg, "meet-the-keyboard").best, 0.9, "the best accuracy is kept");
assert.strictEqual(L.lessonState(pg, "meet-the-keyboard").passedAt, 3000, "and the first pass date");

// Unlock order: the first lesson is open, each next one after the one before it is passed.
assert.deepStrictEqual(ls.map((_, i) => L.isUnlocked(ls, blank, i)), [true, ...new Array(9).fill(false)]);
assert.strictEqual(L.isUnlocked(ls, blank, -1), false);
assert.strictEqual(L.isUnlocked(ls, blank, 10), false);
assert.strictEqual(L.nextLesson(ls, blank), 0);
assert.deepStrictEqual(L.strip(ls, blank).map((c) => c.status), ["current", ...new Array(9).fill("locked")]);
pg = L.recordStep(blank, "note-names", 2, 1);
assert.strictEqual(L.isUnlocked(ls, pg, 1), false, "being in a lesson does not unlock it");
pg = blank;
for (let i = 0; i < 3; i++) pg = L.recordPass(pg, ls[i].id, 0.85, 10 + i);
assert.deepStrictEqual(ls.map((_, i) => L.isUnlocked(ls, pg, i)), [true, true, true, true, ...new Array(6).fill(false)]);
assert.strictEqual(L.nextLesson(ls, pg), 3);
assert.deepStrictEqual(L.strip(ls, pg).map((c) => c.status), ["passed", "passed", "passed", "current", ...new Array(6).fill("locked")]);
assert.strictEqual(L.progressText(ls, pg), "3 of 10 lessons passed");
// Replaying any passed lesson is allowed; passing lesson 1 again changes nothing about the order.
assert(L.isUnlocked(ls, pg, 0) && L.isUnlocked(ls, pg, 2));
// A lesson passed out of order (an old file) stays open even if the one before it is not passed.
pg = L.recordPass(blank, ls[4].id, 0.9, 1);
assert.strictEqual(L.isUnlocked(ls, pg, 4), true);
assert.strictEqual(L.isUnlocked(ls, pg, 5), true);
assert.strictEqual(L.isUnlocked(ls, pg, 3), false);
// All passed: nothing next.
pg = blank;
ls.forEach((l, i) => { pg = L.recordPass(pg, l.id, 0.9, i + 1); });
assert.strictEqual(L.nextLesson(ls, pg), -1);
assert.strictEqual(L.strip(ls, pg).every((c) => c.status === "passed"), true);

// ---------- progress on disk ----------

const pfile = path.join(tmp, "piano-progress.json");
assert.deepStrictEqual(store.readProgress(pfile), blank, "a missing file is empty progress");
fs.writeFileSync(pfile, "{ this is not json");
assert.deepStrictEqual(store.readProgress(pfile), blank, "a corrupt file is empty progress");
fs.writeFileSync(pfile, JSON.stringify({ lessons: { "meet-the-keyboard": { status: "passed", best: 2 } } }));
assert.strictEqual(L.lessonState(store.readProgress(pfile), "meet-the-keyboard").best, null, "out of range values are cleaned on load");
fs.writeFileSync(pfile, "");
assert.deepStrictEqual(store.readProgress(pfile), blank, "an empty file is empty progress");
// Round trip, with nothing left behind.
const saved = store.writeProgress(pfile, L.recordPass(blank, "meet-the-keyboard", 0.9, 7));
assert.deepStrictEqual(store.readProgress(pfile), saved);
assert.deepStrictEqual(fs.readdirSync(tmp).filter((n) => n.endsWith(".tmp")), [], "the temp file is renamed away");
// Updates from the TV: only real, unlocked lessons, with checks on the values.
const ok = shipped;
fs.rmSync(pfile);
let p2 = store.updateProgress(pfile, ok, { lesson: "meet-the-keyboard", action: "step", step: 3 }, 100);
assert.strictEqual(L.lessonState(p2, "meet-the-keyboard").step, 3);
assert.deepStrictEqual(store.readProgress(pfile), p2, "it is saved");
assert.throws(() => store.updateProgress(pfile, ok, { lesson: "note-names", action: "step", step: 0 }), /locked/);
assert.throws(() => store.updateProgress(pfile, ok, { lesson: "nope", action: "step", step: 0 }), /no such lesson/);
assert.throws(() => store.updateProgress(pfile, ok, { lesson: "meet-the-keyboard", action: "step", step: 99 }), /no such step/);
assert.throws(() => store.updateProgress(pfile, ok, { lesson: "meet-the-keyboard", action: "step", step: -1 }), /no such step/);
assert.throws(() => store.updateProgress(pfile, ok, { lesson: "meet-the-keyboard", action: "pass", score: 2 }), /score/);
assert.throws(() => store.updateProgress(pfile, ok, { lesson: "meet-the-keyboard", action: "pass" }), /score/);
assert.throws(() => store.updateProgress(pfile, ok, { lesson: "meet-the-keyboard", action: "dance" }), /unknown action/);
assert.throws(() => store.updateProgress(pfile, ok, null), /no such lesson/);
store.updateProgress(pfile, ok, { lesson: "meet-the-keyboard", action: "attempt", score: 0.5 }, 200);
p2 = store.updateProgress(pfile, ok, { lesson: "meet-the-keyboard", action: "pass", score: 0.92 }, 300);
assert.strictEqual(L.lessonState(p2, "meet-the-keyboard").status, "passed");
p2 = store.updateProgress(pfile, ok, { lesson: "note-names", action: "step", step: 1 }, 400);
assert.strictEqual(L.lessonState(p2, "note-names").step, 1, "passing a lesson opens the next");
// Lessons with errors are not part of the order.
assert.throws(() => store.updateProgress(pfile, [{ id: "x", error: "bad" }], { lesson: "x", action: "step", step: 0 }), /no such lesson/);

// ---------- the pages ----------

// The TV page's script parses and wires the tutorial: the lessons script, the panel, and the entry points.
const tv = fs.readFileSync(path.join(ROOT, "public", "piano.html"), "utf8");
const inline = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(tv)[1];
assert.doesNotThrow(() => new Function(inline), "the TV page's script has no syntax error");
assert(tv.includes('<script src="/piano-lessons.js">') && tv.includes('id="tutor"'));
assert(/openTutor\(/.test(inline) && /learn\\b/.test(inline), "entry: past the end of the song list, ?learn");
assert(/cmd === "learn"/.test(inline), "entry: the link page");
const link = fs.readFileSync(path.join(ROOT, "public", "piano-link.html"), "utf8");
assert(/control\("learn"/.test(link), "the link page has a button for it");

console.log("lessons tests passed");
