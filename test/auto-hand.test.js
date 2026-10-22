// The other hand played for the player: when it is allowed, what is scheduled in wait mode, tempo mode and a
// practice loop, and what the pages do with it. Run: node test/auto-hand.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const P = require("../public/piano-core.js");

// Four bars of 4/4 at 120 bpm (500 ms a beat): the right hand plays a note a beat, the left a whole-bar note
// in bars 1, 2 and 4 and nothing in bar 3.
const song = P.normalizeSong({
  title: "t", bpm: 120, beatsPerBar: 4, hands: ["right", "left"],
  notes: [
    ["C4", 0, 1, "right"], ["D4", 1, 1, "right"], ["E4", 2, 1, "right"], ["F4", 3, 1, "right"],
    ["G4", 4, 1, "right"], ["A4", 5, 1, "right"], ["B4", 6, 1, "right"], ["C5", 7, 1, "right"],
    ["C5", 8, 1, "right"], ["B4", 9, 1, "right"], ["A4", 10, 1, "right"], ["G4", 11, 1, "right"],
    ["C3", 0, 4, "left"], ["G2", 4, 4, "left"], ["C3", 12, 4, "left"],
    ["C4", 12, 4, "right"],
  ],
}).song;
const BEAT = 500;

// Runs a player the way the TV does: one call per 16 ms frame with the clock moving at tempo, up to a wait.
function run(player, opts) {
  const sent = [];
  let clock = opts.from, t = 0;
  for (let i = 0; i < opts.frames; i++, t += 16) {
    const wait = opts.waitAt ? opts.waitAt(t, clock) : null;
    const r = player.next(clock, BEAT, wait);
    if (r.restart) sent.push({ t, restart: true });
    r.events.forEach((e) => sent.push({ t, ...e, due: t + e.at }));
    const next = clock + 16 / BEAT;
    clock = wait != null && next > wait ? wait : next;
  }
  return sent;
}

// Which hand is auto-played: the one not practised. Both hands, or a song with one hand, play nothing.
assert.strictEqual(P.autoHandPlayer(song, { hand: "right" }).hand, "left");
assert.strictEqual(P.autoHandPlayer(song, { hand: "left" }).hand, "right");
assert.strictEqual(P.autoHandPlayer(song, { hand: "both" }), null, "Both hands: nothing is auto-played");
const oneHand = P.normalizeSong({ title: "t", bpm: 120, beatsPerBar: 4, notes: [["C4", 0, 1], ["D4", 1, 1]] }).song;
assert.strictEqual(P.autoHandPlayer(oneHand, { hand: "right" }), null, "a one-hand song always plays that hand");
assert.strictEqual(P.autoHandPlayer(oneHand, { hand: "left" }), null);
assert.strictEqual(P.autoHandPlayer(song, { hand: "left", loop: { from: 3, to: 3 } }).notes, 4, "the right hand has a note a beat in bar 3");
assert.strictEqual(P.autoHandPlayer(song, { hand: "right", loop: { from: 3, to: 3 } }), null, "no left-hand note in bar 3: nothing to play");
assert.strictEqual(P.autoHandPlayer(null, { hand: "right" }), null);

// No MIDI output, a microphone or no link page: not allowed, and the page keeps the dimmed falling notes.
assert.strictEqual(P.autoHandBlocker({ output: "USB MIDI", input: "midi", link: 1 }), "");
assert.notStrictEqual(P.autoHandBlocker({ output: "", input: "midi", link: 1 }), "", "no MIDI output");
assert.notStrictEqual(P.autoHandBlocker({ output: "USB MIDI", input: "mic", link: 1 }), "", "mic input");
assert.notStrictEqual(P.autoHandBlocker({ output: "USB MIDI", input: "midi", link: 0 }), "", "no link page");
assert.notStrictEqual(P.autoHandBlocker({}), "");
assert.notStrictEqual(P.autoHandBlocker(null), "", "no presence yet is not an error");
assert.notStrictEqual(P.autoHandBlocker(undefined), "");

// Tempo mode: the right hand is practised, so the left plays with the clock. Each note goes out once, within
// AUTO_AHEAD_MS of its time, and at its own offset from the moment it is sent.
{
  const player = P.autoHandPlayer(song, { hand: "right" });
  const sent = run(player, { from: -4, frames: 800 });
  assert.deepStrictEqual(sent.filter((e) => !e.restart).map((e) => e.note), [48, 43, 48], "each left-hand note once, in order");
  // The clock starts 4 beats (2 s) before bar 1: the left hand's notes (beats 0, 4, 12) are due 2 s, 4 s and 8 s in.
  sent.forEach((e, i) => {
    assert(Math.abs(e.due - [2000, 4000, 8000][i]) <= 16, `note ${e.note} sounds when its beat does (${e.due})`);
    assert(e.at >= 0 && e.at <= P.AUTO_AHEAD_MS, "queued no further ahead than the lookahead");
  });
  assert.strictEqual(sent[0].dur, 1940, "a bar-long note is released 60 ms early so the next one is struck again");
  assert(sent.every((e) => !e.restart), "the clock never went back");
}

// Speed: a beat of 1000 ms (50%) moves every time out with it.
{
  const player = P.autoHandPlayer(song, { hand: "right" });
  const r = player.next(0, 1000, null);
  assert.deepStrictEqual(r.events, [{ note: 48, at: 0, dur: 3940 }], "4 beats at 1000 ms");
  assert.deepStrictEqual(player.next(0.1, 1000, null).events, [], "sent once");
}

// Wait mode: the clock stops at the step the player waits for and the other hand stops with it.
{
  const player = P.autoHandPlayer(song, { hand: "right" });
  // The player does not play for 3 s once the clock reaches beat 2: the right hand's step at beat 2 is waited for.
  const sent = run(player, { from: -1, frames: 400, waitAt: (t) => (t >= 0 ? 2 : null) });
  assert.deepStrictEqual(sent.map((e) => e.note), [48], "the left hand's bar-2 note (beat 4) is beyond the waited-for step: not sent");
  // The same clock but the step at beat 4 is waited for from the start: the bar-2 note is at the step, so not before the hit.
  const p2 = P.autoHandPlayer(song, { hand: "right" });
  const held = run(p2, { from: 3, frames: 300, waitAt: () => 4 });
  assert.deepStrictEqual(held, [], "a note at the waited-for step itself is held until the player's hand gets there");
  // The hit moves the wait on: the held note now goes out at once (at 0).
  const after = p2.next(4, BEAT, 8);
  assert.deepStrictEqual(after.events.map((e) => [e.note, e.at]), [[43, 0]]);
  assert(!after.restart);
  // Waiting does not use up notes: a long wait at beat 3 and then a hit sends everything between in time.
  const p3 = P.autoHandPlayer(song, { hand: "right" });
  let clock = 3, out = [];
  for (let i = 0; i < 100; i++) out = out.concat(p3.next(clock, BEAT, 3).events);
  assert.deepStrictEqual(out, [], "stalled before the next left-hand note: nothing");
  for (let i = 0; i < 100; i++) { const r = p3.next(clock, BEAT, 5); out = out.concat(r.events); clock = Math.min(5, clock + 16 / BEAT); }
  assert.deepStrictEqual(out.map((e) => e.note), [43], "the note at beat 4 sounds once the wait moved past it");
}

// Playing slowly in wait mode keeps the tempo of the other hand's notes themselves, not the player's.
{
  const player = P.autoHandPlayer(P.normalizeSong({
    title: "t", bpm: 120, beatsPerBar: 4, hands: ["right", "left"],
    notes: [["C4", 0, 1, "right"], ["C3", 0, 0.5, "left"], ["D3", 0.5, 0.5, "left"], ["E3", 1, 1, "left"], ["D4", 2, 1, "right"]],
  }).song, { hand: "right" });
  const sent = run(player, { from: 0, frames: 200, waitAt: (t, c) => 2 });
  assert.deepStrictEqual(sent.map((e) => [e.note, e.due]).map(([n, d]) => [n, Math.round(d / 16) * 16]), [[48, 0], [50, 256], [52, 496]].map(([n, d]) => [n, Math.round(d / 16) * 16]));
}

// A practice loop: only its bars, clipped at its end, and each new pass (the clock goes back) is a restart.
{
  const player = P.autoHandPlayer(song, { hand: "right", loop: { from: 2, to: 2 } });
  assert.strictEqual(player.notes, 1, "bar 2 holds one left-hand note");
  const first = run(player, { from: 0, frames: 400 });
  assert.deepStrictEqual(first.map((e) => [e.note, e.restart || false]), [[43, false]], "the other bars' notes are left out");
  // The loop's pass ends and the clock goes back to just before the loop: a restart, then the note again.
  const again = player.next(2, BEAT, null);
  assert.strictEqual(again.restart, true, "the clock went back");
  const sent2 = [];
  let c = 2;
  for (let i = 0; i < 400; i++, c += 16 / BEAT) { const r = player.next(c, BEAT, null); r.events.forEach((e) => sent2.push(e.note)); }
  assert.deepStrictEqual(sent2, [43], "it plays again in the next pass");
  // A note running past the loop is clipped at its end.
  const clipped = P.autoHandPlayer(P.normalizeSong({ title: "t", bpm: 120, beatsPerBar: 4, hands: ["right", "left"], notes: [["C4", 0, 1, "right"], ["C3", 3, 4, "left"]] }).song, { hand: "right", loop: { from: 1, to: 1 } });
  assert.deepStrictEqual(clipped.next(3, BEAT, null).events, [{ note: 48, at: 0, dur: 450 }], "one beat left in the loop, released 10% early");
}

// Frames that stall do not play late notes in a burst, and the first call after a pause sends from the clock on.
{
  const player = P.autoHandPlayer(song, { hand: "right" });
  player.next(-1, BEAT, null);
  const late = player.next(1, BEAT, null);  // 1.5 s passed in one go: the note due at beat 0 is long gone
  assert.deepStrictEqual(late.events, [], "stale notes are skipped");
  const resumed = P.autoHandPlayer(song, { hand: "right" });
  assert.deepStrictEqual(resumed.next(0, BEAT, null).events.map((e) => e.note), [48], "a note due right now is sent");
}

// The pages use it: the TV drives it from its frame, releases it, and the relay and link page carry it.
{
  const tv = fs.readFileSync(path.join(__dirname, "..", "public", "piano.html"), "utf8");
  const link = fs.readFileSync(path.join(__dirname, "..", "public", "piano-link.html"), "utf8");
  assert(/autoTick\(now\);\s*countShow\(\)/.test(tv), "every frame offers the clock to the other hand");
  assert(/P\.autoHandBlocker\(\{ output: link\.output, input: link\.input, link: link\.link \}\)/.test(tv), "the TV asks the presence whether the keyboard can play");
  assert(/function cancelListen\(\) \{\s*autoStop\(true\);/.test(tv), "a new session, song, hand or calibration releases it");
  assert(/if \(tutor \|\| mode !== "play" \|\| !session \|\| !song \|\| paused \|\| progressOn \|\| listen \|\| listenReq\) return autoStop\(true\)/.test(tv), "pause, the progress screen, Hear it first and the tutorial release it");
  assert(/autoUntil > Date\.now\(\)\)\) return;\s*try \{ navigator\.sendBeacon/.test(tv), "closing the page stops it");
  assert(/function stopAuto\(\)/.test(link) && /if \(d\.auto\) playAuto\(d\)/.test(link), "the link page plays and releases it");
  assert(/if \(!p\.tv\) stopAuto\(\)/.test(link), "the link page releases it when the TV page is gone");
  assert(/function stopPlaying\(\) \{\s*stopAuto\(\);/.test(link), "Hear it first and stop-all release it too");
  assert(/echo\.expect\(m\.data\[0\] === 0x90, m\.data\[1\], m\.time\)/.test(link.slice(link.indexOf("function playAuto"), link.indexOf("function stopAuto"))), "what it plays is not echoed back as the player's input");
}

console.log("auto-hand tests passed");
