// Tutorial mode logic: lesson validation, the step runner (explain, find, play, repeat, rhythm,
// read and check steps), pass marks, feedback text and the progress model with its unlock order.
// Lessons are plain data (lessons/*.json); this file never touches the page or the disk, so it runs
// unchanged in the TV browser and in Node (server, validator and tests). The wait-mode and tempo-mode
// sessions that judge a played sequence are the ones from piano-core.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./piano-core.js"));
  else root.PianoLessons = factory(root.PianoCore);
})(this, function (core) {
  "use strict";

  var STEP_TYPES = ["explain", "find", "play", "repeat", "rhythm", "read", "check"];
  // The text a step may carry. The TV shows it at 32 px or more, so a few lines is all that fits.
  var LIMITS = { title: 60, goal: 110, text: 190, prompt: 90, item: 70, items: 10, steps: 30, questions: 24 };
  var DEFAULT_PASS = 0.8;
  var NAME_RE = /^[A-G]#?-?\d$/, PC_RE = /^[A-G]#?$/, ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var VIEWS = ["notes", "both", "sheet"];
  var LETTERS = ["all", "lit"];

  function isObj(x) { return x && typeof x === "object" && !Array.isArray(x); }
  function isStr(x, max) { return typeof x === "string" && x.trim().length > 0 && x.length <= max; }
  function pcOf(n) { return ((n % 12) + 12) % 12; }

  // ---------- targets ----------

  // "C" (any C on the keyboard) or "C4" (that key only): { pc, exact } or null.
  function parseTarget(s) {
    if (typeof s !== "string") return null;
    if (PC_RE.test(s)) return { pc: pcOf(core.parseNote(s + "4")), exact: null };
    if (NAME_RE.test(s)) { var m = core.parseNote(s); return m === m ? { pc: pcOf(m), exact: m } : null; }
    return null;
  }

  function inRange(n, low, high) { return n >= low && n <= high; }

  // Highlight tokens ("C4" one key, "C*" every C) as MIDI numbers inside [low, high].
  function expandLit(tokens, low, high) {
    var out = [];
    (tokens || []).forEach(function (t) {
      if (/^[A-G]#?\*$/.test(t)) {
        var pc = pcOf(core.parseNote(t.slice(0, -1) + "4"));
        for (var n = low; n <= high; n++) if (pcOf(n) === pc && out.indexOf(n) < 0) out.push(n);
      } else {
        var m = core.parseNote(t);
        if (m === m && inRange(m, low, high) && out.indexOf(m) < 0) out.push(m);
      }
    });
    return out;
  }

  // ---------- validation ----------

  // Checks one lesson (raw JSON) and returns { lesson, errors }. errors is empty when the lesson is
  // well formed: every note on the 61-key keyboard, every text short enough for the TV, every step
  // of a known type with what it needs. opts.song(id) resolves a library song for steps that use one
  // (`song: { id, from, to }`); without it such steps are errors. The returned lesson has those steps
  // expanded to plain notes.
  function validateLesson(raw, opts) {
    opts = opts || {};
    var low = core.DEFAULT_LOW, high = core.DEFAULT_HIGH, errors = [];
    function err(where, msg) { errors.push(where + ": " + msg); }
    if (!isObj(raw)) return { lesson: null, errors: ["lesson is not an object"] };
    if (!isStr(raw.id, 60) || !ID_RE.test(raw.id)) err("id", "needs lower-case words joined by dashes");
    if (!isStr(raw.title, LIMITS.title)) err("title", "missing or longer than " + LIMITS.title + " characters");
    if (!isStr(raw.goal, LIMITS.goal)) err("goal", "missing or longer than " + LIMITS.goal + " characters");
    if (!Array.isArray(raw.steps) || raw.steps.length < 2 || raw.steps.length > LIMITS.steps) {
      err("steps", "needs 2 to " + LIMITS.steps + " steps");
      return { lesson: null, errors: errors };
    }
    var steps = [], checks = 0, lastSeq = -1;

    function noteList(list, where) {
      if (!Array.isArray(list) || !list.length) { err(where, "needs a list of notes"); return false; }
      var okAll = true;
      list.forEach(function (t) {
        if (typeof t !== "string" || !(NAME_RE.test(t) || /^[A-G]#?\*$/.test(t)) || (NAME_RE.test(t) && !inRange(core.parseNote(t), low, high))) {
          err(where, "bad key " + JSON.stringify(t)); okAll = false;
        }
      });
      return okAll;
    }

    function checkText(s, where) {
      if (s.title != null && !isStr(s.title, LIMITS.title)) err(where + " title", "empty or longer than " + LIMITS.title);
      if (s.text != null && !isStr(s.text, LIMITS.text)) err(where + " text", "empty or longer than " + LIMITS.text + " characters (a few lines at most)");
      if (s.prompt != null && !isStr(s.prompt, LIMITS.prompt)) err(where + " prompt", "empty or longer than " + LIMITS.prompt);
    }

    // Notes of a sequence step as an array of note records the core accepts.
    function sequence(s, where, out) {
      var notes = s.notes, bpm = s.bpm, bpb = s.beatsPerBar;
      if (isObj(s.song)) {
        var ref = s.song, song = opts.song ? opts.song(ref.id) : null;
        if (!song) { err(where, "library song " + JSON.stringify(ref.id) + " not found"); return; }
        var bars = core.barCount(song), from = Math.floor(Number(ref.from) || 1), to = Math.floor(Number(ref.to) || bars);
        if (!(from >= 1 && to >= from && to <= bars)) { err(where, "bars " + from + "-" + to + " are outside the song (" + bars + " bars)"); return; }
        var lo = (from - 1) * song.beatsPerBar, hi = to * song.beatsPerBar;
        notes = song.notes.filter(function (n) { return n.start >= lo - 1e-6 && n.start < hi - 1e-6; }).map(function (n) {
          return [n.note, n.start - lo, Math.min(n.length, hi - n.start), n.hand === "left" ? "L" : "R", n.finger || null];
        });
        bpm = bpm || song.bpm; bpb = bpb || song.beatsPerBar;
        out.songRef = { id: ref.id, from: from, to: to };
      }
      if (!Array.isArray(notes) || !notes.length) { err(where, "needs notes"); return; }
      var norm = core.normalizeSong({ title: "x", hand: s.hand === "left" ? "left" : "right", notes: notes, bpm: bpm, beatsPerBar: bpb }, "x");
      if (norm.error) { err(where, norm.error); return; }
      norm.song.notes.forEach(function (n) {
        if (!inRange(n.note, low, high)) err(where, "note " + core.noteName(n.note) + " is outside the keyboard (" + core.noteName(low) + "-" + core.noteName(high) + ")");
      });
      if (s.hand != null && ["right", "left", "both"].indexOf(s.hand) < 0) err(where, "hand must be right, left or both");
      if (bpm != null && !(Number(bpm) >= 40 && Number(bpm) <= 160)) err(where, "bpm must be 40-160");
      if (bpb != null && !(Number(bpb) >= 2 && Number(bpb) <= 6 && Math.floor(Number(bpb)) === Number(bpb))) err(where, "beatsPerBar must be 2-6");
      out.notes = notes; out.bpm = Number(bpm) || 60; out.beatsPerBar = Number(bpb) || 4;
    }

    function tempoOf(s, where) {
      if (s.tempo != null && !(Number(s.tempo) >= core.SPEED_MIN && Number(s.tempo) <= core.SPEED_MAX)) err(where, "tempo must be " + core.SPEED_MIN + "-" + core.SPEED_MAX + " (percent)");
    }

    function questionList(list, where, kind) {
      var out = [];
      if (!Array.isArray(list) || !list.length || list.length > LIMITS.questions) { err(where, "needs 1 to " + LIMITS.questions + " questions"); return out; }
      list.forEach(function (q, i) {
        var w = where + " question " + (i + 1);
        if (!isObj(q)) return err(w, "not an object");
        var read = kind === "read" || q.note != null;
        var targetName = read ? q.note : q.target;
        var t = parseTarget(targetName);
        if (!t) return err(w, (read ? "note" : "target") + " must be like C or C4");
        if (read && t.exact == null) return err(w, "a note to read needs its octave, like C4");
        if (t.exact != null && !inRange(t.exact, low, high)) return err(w, "key " + targetName + " is outside the keyboard");
        if (read && !isStr(q.prompt || "Which key is this note?", LIMITS.prompt)) err(w, "prompt too long");
        if (!read && !isStr(q.prompt, LIMITS.prompt)) err(w, "needs a prompt of at most " + LIMITS.prompt + " characters");
        var count = q.count == null ? 1 : q.count;
        if (!(Math.floor(count) === count && count >= 1 && count <= 12) || (t.exact != null && count !== 1)) err(w, "count must be a whole number from 1 to 12 (1 for one exact key)");
        out.push({ prompt: q.prompt || (read ? "Which key is this note?" : ""), target: targetName, note: read ? targetName : null, count: count });
      });
      return out;
    }

    raw.steps.forEach(function (s0, i) {
      var where = "step " + (i + 1), s = isObj(s0) ? s0 : null;
      if (!s) return err(where, "not an object");
      if (STEP_TYPES.indexOf(s.type) < 0) return err(where, "unknown type " + JSON.stringify(s.type));
      where += " (" + s.type + ")";
      checkText(s, where);
      var out = { type: s.type };
      ["title", "text", "prompt"].forEach(function (k) { if (s[k] != null) out[k] = s[k]; });
      if (s.type === "explain") {
        if (!isStr(s.text, LIMITS.text) && !(Array.isArray(s.items) && s.items.length)) err(where, "needs text");
        if (s.highlight != null && noteList(s.highlight, where + " highlight")) out.highlight = s.highlight;
        if (s.hear != null && noteList(s.hear, where + " hear")) out.hear = s.hear;
        if (s.staff != null) {
          if (Array.isArray(s.staff) && s.staff.length && s.staff.length <= 8 && s.staff.every(function (t) { return NAME_RE.test(t) && inRange(core.parseNote(t), low, high); })) out.staff = s.staff;
          else err(where, "staff needs 1 to 8 notes like C4");
        }
        if (s.fingers != null) {
          var fo = {};
          if (!isObj(s.fingers)) err(where, "fingers must map keys to finger numbers");
          else Object.keys(s.fingers).forEach(function (k) {
            if (NAME_RE.test(k) && core.isFinger(s.fingers[k])) fo[k] = s.fingers[k]; else err(where, "bad finger " + k);
          });
          out.fingers = fo;
        }
        if (s.items != null) {
          if (Array.isArray(s.items) && s.items.length <= LIMITS.items && s.items.every(function (t) { return isStr(t, LIMITS.item); })) out.items = s.items;
          else err(where, "items must be at most " + LIMITS.items + " short lines");
        }
        if (s.letters != null) { if (LETTERS.indexOf(s.letters) >= 0) out.letters = s.letters; else err(where, "letters must be all or lit"); }
        if (s.groups) out.groups = true;
        if (s.free) out.free = true;
        if (s.next != null) { if (isStr(s.next, LIMITS.item)) out.next = s.next; else err(where, "next is too long"); }
      } else if (s.type === "find") {
        out.questions = questionList(s.questions || [{ prompt: s.prompt, target: s.target, count: s.count }], where, "find");
        if (!s.questions && !isStr(s.prompt, LIMITS.prompt)) err(where, "needs a prompt");
      } else if (s.type === "read") {
        out.questions = questionList(s.questions, where, "read");
        out.view = "sheet";
      } else if (s.type === "play" || s.type === "rhythm" || (s.type === "check" && !s.questions)) {
        sequence(s, where, out);
        tempoOf(s, where);
        if (s.tempo != null) out.tempo = Number(s.tempo);
        if (s.hand != null) out.hand = s.hand;
        if (s.metronome != null) out.metronome = !!s.metronome;
        if (s.blind) out.blind = true;
        if (s.view != null) { if (VIEWS.indexOf(s.view) >= 0) out.view = s.view; else err(where, "view must be notes, both or sheet"); }
        if (s.type === "rhythm" && !(out.beatsPerBar >= 2)) err(where, "needs a time signature");
        lastSeq = i;
      } else if (s.type === "repeat") {
        if (lastSeq < 0) err(where, "repeat needs an earlier play, rhythm or check step to repeat");
        if (s.of != null && !(Math.floor(s.of) === s.of && s.of >= 1 && i - s.of >= 0 && isSeqStep(raw.steps[i - s.of]))) err(where, "of must point back at a play, rhythm or check step");
        tempoOf(s, where);
        ["of", "tempo", "metronome", "blind", "view"].forEach(function (k) { if (s[k] != null) out[k] = s[k]; });
        if (s.view != null && VIEWS.indexOf(s.view) < 0) err(where, "view must be notes, both or sheet");
        if (s.tempo == null && !s.blind && s.metronome == null) err(where, "a repeat needs a tempo, metronome or blind change, or it is the same step again");
      }
      if (s.type === "check") {
        checks++;
        if (s.questions) out.questions = questionList(s.questions, where, "find");
        if (s.pass != null && !(Number(s.pass) >= 0.5 && Number(s.pass) <= 1)) err(where, "pass must be between 0.5 and 1");
        out.pass = s.pass != null ? Number(s.pass) : DEFAULT_PASS;
        if (s.metric != null && ["accuracy", "timing"].indexOf(s.metric) < 0) err(where, "metric must be accuracy or timing");
        out.metric = s.metric || "accuracy";
        if (out.metric === "timing" && !(Number(s.tempo) > 0)) err(where, "a timing check needs a tempo");
      }
      steps.push(out);
    });
    if (!checks) err("steps", "a lesson needs at least one check step");
    var lastCheck = -1;
    steps.forEach(function (s, i) { if (s.type === "check") lastCheck = i; });
    if (lastCheck >= 0 && steps.slice(lastCheck + 1).some(function (s) { return s.type !== "explain"; })) err("steps", "only explain steps may come after the last check");
    if (errors.length) return { lesson: null, errors: errors };
    return { lesson: { id: raw.id, title: raw.title, goal: raw.goal, steps: steps }, errors: [] };
  }

  function isSeqStep(s) {
    return isObj(s) && (s.type === "play" || s.type === "rhythm" || (s.type === "check" && !s.questions));
  }

  // ---------- the step runner ----------

  var HAND_LABEL = { right: "right hand", left: "left hand", both: "both hands" };

  // The song a sequence step plays, as the core's song object before fitting to the keyboard.
  function stepSong(lesson, step) {
    // Notes without a hand of their own follow the step's: left for a left-hand step, else right.
    var raw = { title: lesson.title, hand: step.hand === "left" ? "left" : "right", bpm: step.bpm || 60, beatsPerBar: step.beatsPerBar || 4, key: "C", notes: step.notes };
    return core.normalizeSong(raw, lesson.id).song;
  }

  // A song with the notes one after the other, for showing them on the staff.
  function staffSong(names, whole) {
    var raw = { title: "Staff", hand: "right", bpm: 60, beatsPerBar: 4, key: "C", notes: names.map(function (n, i) { return [n, whole ? 0 : i, whole ? 4 : 1]; }) };
    return core.normalizeSong(raw, "staff").song;
  }

  // The step a `repeat` step repeats: the one `of` steps back, else the nearest earlier sequence step.
  function sourceOf(lesson, index) {
    var s = lesson.steps[index];
    if (s.type !== "repeat") return s;
    var j = s.of != null ? index - s.of : index - 1;
    while (j >= 0 && !isSeqStep(lesson.steps[j])) j--;
    return j >= 0 ? lesson.steps[j] : null;
  }

  // What a lesson step is made of at run time. low and high are the keyboard's range.
  function createRunner(lesson, opts) {
    opts = opts || {};
    var low = opts.low != null ? opts.low : core.DEFAULT_LOW, high = opts.high != null ? opts.high : core.DEFAULT_HIGH;
    var r = { lesson: lesson, index: 0, total: lesson.steps.length, rt: null, outcome: null, tolerant: !!opts.tolerant, finished: false, scores: [], attempts: 0 };

    r.step = function () { return lesson.steps[r.index]; };
    r.setTolerant = function (on) { r.tolerant = !!on; if (r.rt && r.rt.session && r.rt.session.setTolerant) r.rt.session.setTolerant(on); };

    r.enter = function (i) {
      r.index = Math.max(0, Math.min(r.total - 1, Math.floor(i) || 0));
      r.outcome = null;
      r.rt = build(lesson.steps[r.index], r.index);
      return r.rt;
    };

    function build(step, index) {
      if (step.type === "explain") {
        var lit = expandLit(step.highlight, low, high), fingers = {};
        Object.keys(step.fingers || {}).forEach(function (k) { fingers[core.parseNote(k)] = step.fingers[k]; });
        var hearNames = (step.hear || step.highlight || []).filter(function (t) { return t.indexOf("*") < 0; });
        var rt = { kind: "explain", lit: lit, fingers: fingers, free: !!step.free, groups: !!step.groups, letters: step.letters || "", hear: hearNames.map(core.parseNote),
          display: step.staff ? { song: staffSong(step.staff), view: "sheet" } : null };
        return rt;
      }
      if (step.type === "find" || step.type === "read" || (step.type === "check" && step.questions)) return buildQuiz(step);
      return buildSequence(step, index);
    }

    function buildQuiz(step) {
      var qs = step.questions.map(function (q) {
        var t = parseTarget(q.target);
        return { prompt: q.prompt, target: t, name: q.target, count: q.count || 1, staff: q.note || null };
      });
      var rt = { kind: "quiz", questions: qs, qi: 0, found: {}, foundCount: 0, correct: 0, wrong: 0, streak: 0, bestStreak: 0, needs: {}, wrongKeys: {}, done: false };
      rt.question = function () { return rt.done ? null : qs[rt.qi]; };
      rt.display = function () { var q = rt.question(); return q && q.staff ? { song: staffSong([q.staff], true), view: "sheet" } : null; };
      return rt;
    }

    // Keys that satisfy a question: the exact key, or every key with its name (any octave).
    function matches(q, note) {
      if (q.target.exact != null && !r.tolerant) return note === q.target.exact;
      return pcOf(note) === q.target.pc;
    }

    function nearestTarget(q, note, found) {
      var best = -1;
      for (var n = low; n <= high; n++) {
        if (!matches(q, n) || found[n]) continue;
        if (q.target.exact != null && n !== q.target.exact && !r.tolerant) continue;
        if (best < 0 || Math.abs(n - note) < Math.abs(best - note)) best = n;
      }
      return best;
    }

    function buildSequence(step, index) {
      var src = sourceOf(lesson, index), isRepeat = step.type === "repeat";
      var merged = { notes: src.notes, bpm: src.bpm, beatsPerBar: src.beatsPerBar, hand: src.hand, view: src.view };
      var tempo = isRepeat ? (step.tempo != null ? step.tempo : src.tempo) : step.tempo;
      var metronome = isRepeat ? (step.metronome != null ? step.metronome : src.metronome) : step.metronome;
      var blind = isRepeat ? !!step.blind : !!step.blind;
      var view = (isRepeat && step.view) || step.view || merged.view || "notes";
      if (step.type === "rhythm") { tempo = tempo || 100; if (metronome == null) metronome = true; }
      if (src.type === "rhythm" && isRepeat) { tempo = tempo || 100; if (metronome == null) metronome = true; }
      var raw = stepSong(lesson, merged);
      var song = core.fitSong(raw, low, high);
      var hand = merged.hand || "both";
      var session = tempo
        ? core.createTempoSession(song, { hand: hand, speed: tempo, tolerant: r.tolerant, countIn: song.beatsPerBar })
        : core.createSession(song, { hand: hand, tolerant: r.tolerant });
      return { kind: "sequence", song: song, session: session, tempo: !!tempo, metronome: !!metronome, blind: blind, view: view, hand: hand, bars: core.barCount(song), needs: {}, shown: step.type };
    }

    // A key was pressed (beat is the song clock in tempo mode). Returns { result, ... }: explain steps
    // answer "touch" (free play) or "advance"; a quiz answers "correct", "again", "wrong", "question"
    // or "done"; a played sequence answers what the core session does.
    r.press = function (note, beat) {
      var rt = r.rt;
      if (!rt || r.outcome) return { result: "ignored" };
      if (rt.kind === "explain") return { result: rt.free ? "touch" : "advance" };
      if (rt.kind === "quiz") return quizPress(rt, note);
      var s = rt.session, res = rt.tempo ? s.press(note, beat) : s.press(note);
      if (res.result === "wrong" && res.target != null) rt.needs[res.target] = (rt.needs[res.target] || 0) + 1;
      if (!rt.tempo && s.done) finish();
      return res;
    };

    function quizPress(rt, note) {
      var q = rt.question();
      if (matches(q, note)) {
        if (rt.found[note]) return { result: "again" };
        rt.found[note] = true; rt.foundCount++; rt.correct++; rt.streak++;
        if (rt.streak > rt.bestStreak) rt.bestStreak = rt.streak;
        if (rt.foundCount < q.count) return { result: "correct", found: rt.foundCount, of: q.count };
        rt.qi++; rt.found = {}; rt.foundCount = 0;
        if (rt.qi >= rt.questions.length) { rt.done = true; finish(); return { result: "done" }; }
        return { result: "question", index: rt.qi };
      }
      rt.wrong++; rt.streak = 0;
      rt.wrongKeys[note] = (rt.wrongKeys[note] || 0) + 1;
      var target = nearestTarget(q, note, rt.found);
      var tn = target >= 0 ? target : note;
      rt.needs[tn] = (rt.needs[tn] || 0) + 1;
      return { result: "wrong", target: tn, hint: core.hint(note, tn) };
    }

    // Tempo mode: called as the clock moves. Returns what the session returns.
    r.tick = function (beat) {
      var rt = r.rt;
      if (!rt || rt.kind !== "sequence" || !rt.tempo || r.outcome) return { misses: [] };
      var res = rt.session.tick(beat);
      if (res.result === "done") finish();
      return res;
    };

    // Play the step again from the start (a failed check, or the player asking).
    r.retry = function () { r.attempts++; return r.enter(r.index); };

    // The step is over: a score, a pass or fail, and a few short lines of feedback.
    function finish() {
      var rt = r.rt, step = lesson.steps[r.index];
      var o = { stepIndex: r.index, type: step.type, kind: rt.kind, isCheck: step.type === "check" };
      if (rt.kind === "quiz") {
        o.correct = rt.correct; o.wrong = rt.wrong; o.missed = 0; o.bestStreak = rt.bestStreak; o.timing = null;
        o.accuracy = rt.correct + rt.wrong ? rt.correct / (rt.correct + rt.wrong) : 1;
        o.needs = rt.needs;
      } else {
        var s = rt.session;
        o.correct = s.correct; o.wrong = s.wrong; o.missed = s.missed || 0; o.bestStreak = s.bestStreak;
        o.accuracy = s.accuracy(); o.timing = core.timingSummary(s); o.needs = rt.needs;
      }
      // A timing check scores the notes that were on the beat out of all the notes asked for, so a
      // missed note counts against it just like a late one.
      o.score = step.metric === "timing" ? (o.timing ? o.timing.onTime / Math.max(1, o.correct + o.missed) : 0) : o.accuracy;
      o.pass = o.isCheck ? step.pass || DEFAULT_PASS : null;
      o.passed = o.isCheck ? passed(o.score, o.pass) : true;
      o.metric = step.metric || "accuracy";
      o.lines = feedback(o, step);
      r.outcome = o;
      if (o.isCheck && o.passed) r.scores.push(o.score);
    }

    // Moves on. Returns "step" (the next step is ready), "lesson" (that was the last one) or "stay"
    // (a check not yet passed, or a step still being played).
    function move() {
      if (r.index + 1 >= r.total) { r.finished = true; return "lesson"; }
      r.enter(r.index + 1);
      return "step";
    }
    r.next = function () {
      var step = r.step(), done = r.outcome || step.type === "explain";
      if (!done) return "stay";
      if (r.outcome && r.outcome.isCheck && !r.outcome.passed) return "stay";
      return move();
    };

    // Moves on without finishing the step: any step but a check that has not been passed. A player
    // who is stuck is never locked out of the next explanation.
    r.skip = function () {
      var step = r.step();
      if (step.type === "check" && !(r.outcome && r.outcome.passed)) return "stay";
      return move();
    };

    r.prev = function () {
      if (r.index === 0) return "menu";
      r.enter(r.index - 1);
      return "step";
    };

    // Accuracy the lesson is recorded with: the mean of its passed checks.
    r.lessonScore = function () {
      if (!r.scores.length) return 0;
      var sum = 0;
      r.scores.forEach(function (x) { sum += x; });
      return sum / r.scores.length;
    };

    r.enter(Math.min(Math.max(0, Math.floor(opts.start) || 0), r.total - 1));
    return r;
  }

  // ---------- pass mark and feedback ----------

  // A score (0-1) passes a check when it reaches the mark; a hair of tolerance for rounding.
  function passed(score, mark) { return score + 1e-9 >= (mark == null ? DEFAULT_PASS : mark); }

  function pct(x) { return Math.round(x * 100) + "%"; }

  // Names of the keys the player most often missed (the ones they were meant to play), top two.
  function mostNeeded(needs) {
    return Object.keys(needs || {}).sort(function (a, b) { return needs[b] - needs[a] || a - b; }).slice(0, 2).map(function (n) { return core.noteName(Number(n)).replace(/-?\d$/, ""); });
  }

  // Short, plain, encouraging lines: what went right, what to fix, and for a check whether it passed.
  // At most three, so they fit big on the TV; the line about what to fix gives way to the pass line.
  function feedback(o, step) {
    var good, timing = "", fix = "", mark = "", total = o.correct + o.wrong + o.missed;
    if (o.wrong === 0 && o.missed === 0) good = o.kind === "quiz" ? "Every answer was right first time." : "Every note was right, first time.";
    else if (o.accuracy >= 0.8) good = "Nice work: " + o.correct + " of " + total + " right.";
    else good = "A good start: " + o.correct + " of " + total + " right.";
    if (o.timing) {
      var tend = core.tendencyText(o.timing.meanMs);
      timing = "Timing: " + pct(o.timing.accuracy / 100) + " of your notes were on the beat" + (tend === "on the beat" ? "." : ", " + tend + ".");
    }
    if (o.wrong || o.missed) {
      var names = mostNeeded(o.needs);
      fix = (names.length ? "Look out for " + names.join(" and ") + ". " : "") + (o.timing && o.missed ? "Count out loud and play on each click." : "Go a little slower and watch the lit key.");
    }
    if (o.isCheck) mark = o.passed ? "Passed with " + pct(o.score) + "." : "You scored " + pct(o.score) + ". You need " + pct(o.pass) + ": try once more, you are close.";
    // Three lines at most: what went right and the pass line always, then what to fix, then the timing.
    var room = 3 - 1 - (mark ? 1 : 0), useFix = !!fix && room > 0;
    if (useFix) room--;
    var useTiming = !!timing && room > 0;
    var lines = [good];
    if (useTiming) lines.push(timing);
    if (useFix) lines.push(fix);
    if (mark) lines.push(mark);
    return lines;
  }

  // ---------- progress ----------

  var STATUSES = ["not-started", "in-progress", "passed"];

  function emptyProgress() { return { version: 1, lessons: {} }; }

  function cleanEntry(e) {
    if (!isObj(e)) return null;
    var status = STATUSES.indexOf(e.status) >= 0 ? e.status : "in-progress";
    var best = Number(e.best), step = Math.floor(Number(e.step)), attempts = Math.floor(Number(e.attempts));
    return {
      status: status,
      best: best >= 0 && best <= 1 ? Math.round(best * 1000) / 1000 : null,
      step: step >= 0 && step < 1000 ? step : 0,
      attempts: attempts >= 0 && attempts < 100000 ? attempts : 0,
      updatedAt: Number(e.updatedAt) > 0 ? Math.floor(Number(e.updatedAt)) : 0,
      passedAt: Number(e.passedAt) > 0 ? Math.floor(Number(e.passedAt)) : 0,
    };
  }

  // A clean progress object from whatever was read (a missing or corrupt file gives an empty one).
  function validProgress(raw) {
    var out = emptyProgress();
    if (!isObj(raw) || !isObj(raw.lessons)) return out;
    Object.keys(raw.lessons).slice(0, 200).forEach(function (id) {
      if (!ID_RE.test(id)) return;
      var e = cleanEntry(raw.lessons[id]);
      if (e && e.status !== "not-started") out.lessons[id] = e;
    });
    return out;
  }

  function lessonState(progress, id) {
    var e = progress && progress.lessons && progress.lessons[id];
    return e ? e : { status: "not-started", best: null, step: 0, attempts: 0, updatedAt: 0, passedAt: 0 };
  }

  function clone(p) { return validProgress(JSON.parse(JSON.stringify(p || emptyProgress()))); }

  // The player is on step `step` of the lesson: resume point. A passed lesson stays passed.
  function recordStep(progress, id, step, now) {
    var p = clone(progress), e = lessonState(p, id);
    p.lessons[id] = cleanEntry({ status: e.status === "passed" ? "passed" : "in-progress", best: e.best, step: e.status === "passed" ? 0 : step, attempts: e.attempts, updatedAt: now, passedAt: e.passedAt });
    return p;
  }

  // A check was tried and not passed: counted, best kept.
  function recordAttempt(progress, id, score, now) {
    var p = clone(progress), e = lessonState(p, id);
    p.lessons[id] = cleanEntry({ status: e.status === "passed" ? "passed" : "in-progress", best: Math.max(e.best || 0, score || 0), step: e.step, attempts: e.attempts + 1, updatedAt: now, passedAt: e.passedAt });
    return p;
  }

  function recordPass(progress, id, score, now) {
    var p = clone(progress), e = lessonState(p, id);
    p.lessons[id] = cleanEntry({ status: "passed", best: Math.max(e.best || 0, score || 0), step: 0, attempts: e.attempts + 1, updatedAt: now, passedAt: e.passedAt || now });
    return p;
  }

  // Lessons unlock in order: the first always, each other once the one before it is passed. A passed
  // lesson stays open for replay.
  function isUnlocked(lessons, progress, index) {
    if (index < 0 || index >= lessons.length) return false;
    if (index === 0) return true;
    return lessonState(progress, lessons[index - 1].id).status === "passed" || lessonState(progress, lessons[index].id).status === "passed";
  }

  // Index of the lesson to do next: the first one not yet passed (-1 when all are passed).
  function nextLesson(lessons, progress) {
    for (var i = 0; i < lessons.length; i++) if (lessonState(progress, lessons[i].id).status !== "passed") return i;
    return -1;
  }

  // The menu's progress strip: one cell per lesson, "passed", "current" (next to do, or in progress),
  // "open" (unlocked, not the next) or "locked".
  function strip(lessons, progress) {
    var next = nextLesson(lessons, progress);
    return lessons.map(function (l, i) {
      var st = lessonState(progress, l.id).status;
      return { id: l.id, status: st === "passed" ? "passed" : i === next ? "current" : isUnlocked(lessons, progress, i) ? "open" : "locked" };
    });
  }

  // The step to resume at: where the player stopped in a lesson in progress, else the first.
  function resumeStep(progress, lesson) {
    var e = lessonState(progress, lesson.id);
    return e.status === "in-progress" ? Math.max(0, Math.min(lesson.steps.length - 1, e.step)) : 0;
  }

  // "3 of 10 lessons passed" for the menu.
  function progressText(lessons, progress) {
    var n = lessons.filter(function (l) { return lessonState(progress, l.id).status === "passed"; }).length;
    return n + " of " + lessons.length + " lessons passed";
  }

  return {
    STEP_TYPES: STEP_TYPES, LIMITS: LIMITS, DEFAULT_PASS: DEFAULT_PASS, HAND_LABEL: HAND_LABEL,
    parseTarget: parseTarget, expandLit: expandLit, validateLesson: validateLesson, createRunner: createRunner,
    staffSong: staffSong, stepSong: stepSong, sourceOf: sourceOf, passed: passed, feedback: feedback,
    emptyProgress: emptyProgress, validProgress: validProgress, lessonState: lessonState,
    recordStep: recordStep, recordAttempt: recordAttempt, recordPass: recordPass,
    isUnlocked: isUnlocked, nextLesson: nextLesson, strip: strip, resumeStep: resumeStep, progressText: progressText,
  };
});
