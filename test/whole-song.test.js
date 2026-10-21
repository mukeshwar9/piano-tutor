// Hear the whole song: the plan for the entire song, its chunks and the chunked sender, against a fake
// sender and a fake clock. Run: node test/whole-song.test.js
const assert = require("assert");
const P = require("../public/piano-core.js");

// Four bars of 4/4 at 120 bpm (500 ms a beat, 2000 ms a bar): the right hand plays a note a beat, the left a
// whole-bar note, and the last bar starts 6 s in.
const song = P.normalizeSong({
  title: "t", bpm: 120, beatsPerBar: 4, hands: ["right", "left"],
  notes: [
    ["C4", 0, 1, "right"], ["D4", 1, 1, "right"], ["E4", 2, 1, "right"], ["F4", 3, 1, "right"],
    ["G4", 4, 1, "right"], ["A4", 5, 1, "right"], ["B4", 6, 1, "right"], ["C5", 7, 1, "right"],
    ["C3", 0, 4, "left"], ["G2", 4, 4, "left"],
    ["C4", 12, 4, "right"], ["C3", 12, 4, "left"],
  ],
}).song;
assert.strictEqual(P.barCount(song), 4);

// The whole-song plan runs from the first bar to the last, for both hands or one.
const both = P.wholeSongPlan(song, { hand: "both" });
assert.deepStrictEqual([both.from, both.to, both.startBeat, both.endBeat, both.ms, both.events.length], [1, 4, 0, 16, 8000, 12]);
assert.deepStrictEqual(both.events.map((e) => [e.note, e.at]).sort((a, b) => a[1] - b[1] || a[0] - b[0]),
  [[48, 0], [60, 0], [62, 500], [64, 1000], [65, 1500], [43, 2000], [67, 2000], [69, 2500], [71, 3000], [72, 3500], [48, 6000], [60, 6000]]);
const rightOnly = P.wholeSongPlan(song, { hand: "right" });
assert.deepStrictEqual(rightOnly.events.map((e) => e.note), [60, 62, 64, 65, 67, 69, 71, 72, 60]);
assert(rightOnly.events.every((e) => e.hand === "right"));
const leftOnly = P.wholeSongPlan(song, { hand: "left" });
assert.deepStrictEqual(leftOnly.events.map((e) => e.note), [48, 43, 48]);
assert.deepStrictEqual(leftOnly.events.map((e) => e.at), [0, 2000, 6000]);

// Tempo and speed: the song's own tempo at 100%, scaled by the speed setting.
assert.strictEqual(both.beatMs, 500);
const half = P.wholeSongPlan(song, { hand: "right", speed: 50 });
assert.deepStrictEqual([half.beatMs, half.ms], [1000, 16000]);
assert.deepStrictEqual(half.events.map((e) => e.at), [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 12000]);
assert.strictEqual(half.events[0].dur, 940, "a beat at 50%: the release gap is capped at 60 ms");
const quick = P.wholeSongPlan(song, { hand: "right", speed: 9999 });
assert.strictEqual(quick.beatMs, 500, "speed is clamped to the allowed range");

// Chunks: a note belongs to the chunk it starts in, at is relative to the chunk, order is kept, none lost.
const chunks = P.songChunks(both, 4000);
assert.strictEqual(chunks.length, 2);
assert.deepStrictEqual(chunks.map((c) => [c.index, c.base, c.span, c.last]), [[0, 0, 4000, false], [1, 4000, 4000, true]]);
assert.strictEqual(chunks[0].events.length + chunks[1].events.length, both.events.length);
assert.deepStrictEqual(chunks[0].events.map((e) => [e.note, e.at]), [[48, 0], [60, 0], [62, 500], [64, 1000], [65, 1500], [43, 2000], [67, 2000], [69, 2500], [71, 3000], [72, 3500]]);
assert.deepStrictEqual(chunks[1].events.map((e) => [e.note, e.at]), [[48, 2000], [60, 2000]], "bar 4 starts 6 s in: 2 s into the second chunk");
for (const c of chunks) {
  assert(c.events.every((e) => e.at >= 0 && e.at < c.span), "at is inside the chunk");
  assert.deepStrictEqual(c.events.map((e) => e.at), c.events.map((e) => e.at).slice().sort((a, b) => a - b), "in time order");
}
// Put back together the chunks give exactly the plan, with the long left-hand note's dur running past its chunk.
const rebuilt = chunks.flatMap((c) => c.events.map((e) => ({ note: e.note, at: c.base + e.at, dur: e.dur })));
assert.deepStrictEqual(rebuilt, both.events.slice().sort((a, b) => a.at - b.at || a.note - b.note).map((e) => ({ note: e.note, at: e.at, dur: e.dur })));
// Quiet stretches keep their (empty) chunks so the link page hears from the sender all the time.
const sparse = P.normalizeSong({ title: "t", bpm: 120, beatsPerBar: 4, notes: [["C4", 0, 1], ["C4", 60, 1]] }).song;
const sparseChunks = P.songChunks(P.wholeSongPlan(sparse, { hand: "right" }), 4000);
assert.strictEqual(sparseChunks.length, Math.ceil(P.wholeSongPlan(sparse, { hand: "right" }).ms / 4000));
assert(sparseChunks.slice(1, -1).every((c) => c.events.length === 0), "the rests in between are empty chunks");
assert.deepStrictEqual(sparseChunks.map((c) => c.base), sparseChunks.map((_, i) => i * 4000));
assert.strictEqual(sparseChunks[sparseChunks.length - 1].events.length, 1);

// A long song (seven minutes, a note every 100 ms at 120 bpm) is never sent in one burst.
const longNotes = [];
for (let i = 0; i < 4200; i++) longNotes.push([["C4", "E4", "G4"][i % 3], i * 0.2, 0.2, "right"]);
const long = P.normalizeSong({ title: "long", bpm: 120, beatsPerBar: 4, notes: longNotes }).song;
const longPlan = P.wholeSongPlan(long, { hand: "right" });
assert.strictEqual(longPlan.ms, 420000);
const longChunks = P.songChunks(longPlan, P.WHOLE_CHUNK_MS);
assert.strictEqual(longChunks.length, 105);
assert(longChunks.every((c) => c.events.length <= 41), "a few dozen notes per chunk at most");
assert.strictEqual(longChunks.reduce((n, c) => n + c.events.length, 0), 4200);

// The sender: a fake clock and a fake sender that records what is sent and when.
function rig(plan, opts = {}) {
  let now = 1000, seq = 0;
  const timers = new Map(), sent = [], stops = [], ends = [], pending = [];
  let sentAll = 0;
  const player = P.songPlayer(plan, {
    chunkMs: opts.chunkMs, aheadMs: opts.aheadMs,
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    send: (chunk, done) => { sent.push({ at: now, chunk }); if (opts.manual) pending.push(done); else done(opts.fail && opts.fail(chunk) ? "network" : null); },
    sendStop: () => stops.push(now),
    onSent: () => sentAll++,
    onEnd: (reason) => ends.push(reason),
  });
  // Moves the clock forward, firing timers in order.
  function advance(ms) {
    const until = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      timers.delete(next.id); now = Math.max(now, next.t.at); next.t.fn();
    }
    now = until;
  }
  return { player, sent, stops, ends, advance, timers, pending, sentAll: () => sentAll, time: () => now };
}

// Chunks go out aheadMs before they are due, in order, counted from the song's start t0.
let r = rig(both, { chunkMs: 4000, aheadMs: 3000 });
r.player.start(1000);
assert.deepStrictEqual(r.sent.map((s) => [s.chunk.index, s.at]), [[0, 1000]], "the first chunk goes at once");
assert(r.sent[0].chunk.first && !r.sent[0].chunk.last);
r.advance(900);
assert.strictEqual(r.sent.length, 1, "the second is not due until 1 s in");
r.advance(100);
assert.deepStrictEqual(r.sent.map((s) => [s.chunk.index, s.at]), [[0, 1000], [1, 2000]]);
assert(r.sent[1].chunk.last && !r.sent[1].chunk.first);
assert.strictEqual(r.sentAll(), 1);
assert.deepStrictEqual([r.player.sent(), r.player.count(), r.player.ended()], [2, 2, ""]);
assert.strictEqual(r.timers.size, 0, "nothing left scheduled once everything is sent");
// Stopping after everything was sent still tells the keyboard, once; later stops do nothing.
r.advance(3000);
r.player.stop(); r.player.stop();
assert.deepStrictEqual([r.stops.length, r.ends], [1, ["stopped"]]);

// A long song is sent one chunk per 4 s, never ahead of the 3 s window.
r = rig(longPlan);
r.player.start(1000);
r.advance(60000);
// Chunk k (base 4000k) is due at t0 + base - 3 s; after 60 s the chunks up to base 62 s have gone out.
assert.deepStrictEqual(r.sent.map((s) => s.chunk.index), Array.from({ length: 16 }, (_, i) => i), "a minute in: the next few seconds are out, not the song");
assert(r.sent.slice(1).every((s) => s.at === 1000 + s.chunk.base - 3000), "each chunk goes out at its time minus the window");
r.advance(420000);
assert.strictEqual(r.sent.length, 105);
assert.deepStrictEqual(r.sent.map((s) => s.chunk.index), Array.from({ length: 105 }, (_, i) => i), "in order, none skipped");
assert(r.sent.every((s) => s.chunk.events.length <= 41), "no burst");

// Stop at once: nothing more is sent, the keyboard is told, the end is reported once.
r = rig(longPlan);
r.player.start(1000);
r.advance(10000);
const before = r.sent.length;
r.player.stop();
r.advance(100000);
assert.strictEqual(r.sent.length, before, "no chunk after stop");
assert.deepStrictEqual([r.stops.length, r.ends, r.player.ended(), r.timers.size], [1, ["stopped"], "stopped", 0]);
r.player.stop(); assert.strictEqual(r.stops.length, 1);
// stop(false) (the song reached its end on the TV) does not send a stop.
r = rig(both); r.player.start(1000); r.player.stop(false);
assert.deepStrictEqual([r.stops.length, r.ends], [0, ["stopped"]]);

// A stop while the first chunk is still on its way is said again when it lands, so it cannot be overtaken.
r = rig(both, { manual: true });
r.player.start(1000);
r.player.stop();
assert.strictEqual(r.stops.length, 1);
r.pending[0](null);
assert.strictEqual(r.stops.length, 2, "stop repeated after the chunk in flight arrived");
assert.strictEqual(r.sent.length, 1, "and nothing else was sent");

// Chunks go one at a time: the next waits for the one before to be acknowledged.
r = rig(both, { manual: true });
r.player.start(1000);
r.advance(5000);
assert.strictEqual(r.sent.length, 1, "chunk 1 is due but chunk 0 is not acknowledged");
r.pending[0](null);
assert.strictEqual(r.sent.length, 2);

// A lost connection (a send fails) ends playback cleanly: no more chunks, and no stop (the server cannot be reached).
r = rig(longPlan, { fail: (chunk) => chunk.index === 3 });
r.player.start(1000);
r.advance(60000);
assert.deepStrictEqual(r.sent.map((s) => s.chunk.index), [0, 1, 2, 3], "nothing after the failed chunk");
assert.deepStrictEqual(r.ends, ["lost"]);
assert.strictEqual(r.stops.length, 0);
assert.strictEqual(r.timers.size, 0);
r.player.stop();
assert.deepStrictEqual([r.ends, r.stops.length], [["lost"], 0], "stopping a lost song changes nothing");
// The very first chunk failing is also a lost connection.
r = rig(both, { fail: () => true });
r.player.start(1000);
assert.deepStrictEqual([r.sent.length, r.ends], [1, ["lost"]]);

// What the link page does with a chunk: messages at t0 + base + at, offs before ons at the same moment.
const link0 = 5000;
const msgs = chunks[1].events.length ? P.midiMessages(chunks[1].events, link0 + chunks[1].base) : [];
assert(msgs.every((m) => m.time >= link0 + 4000), "the second chunk sounds from 4 s into the song");
assert.deepStrictEqual(msgs[0].data[0], 0x90);

// The browser's setTimeout, clearTimeout and Date.now throw "Illegal invocation" when called as methods of
// another object, which is how a page passes them in: the player must call them on their own. (A stop that
// threw here left the song playing on the TV, the keyboard and the link page's button.)
function illegalWhenMethod(name, fn) {
  return function (...a) { if (this !== undefined && this !== globalThis) throw new TypeError(`Illegal invocation: ${name}`); return fn(...a); };
}
{
  let tnow = 1000, seq = 0;
  const live = new Set(), stops = [];
  const pl = P.songPlayer(longPlan, {
    now: illegalWhenMethod("now", () => tnow),
    setTimer: illegalWhenMethod("setTimeout", () => { live.add(++seq); return seq; }),
    clearTimer: illegalWhenMethod("clearTimeout", (id) => live.delete(id)),
    send: (chunk, done) => done(null),
    sendStop: () => stops.push(1),
  });
  pl.start(1000);
  assert.strictEqual(live.size, 1, "a chunk timer is pending, as it is for most of a song");
  pl.stop();
  assert.deepStrictEqual([live.size, stops.length, pl.ended()], [0, 1, "stopped"], "stopping cleared the timer and told the keyboard");
}

// Why it cannot start: a calibration in progress or no song open says so instead of doing nothing.
assert.strictEqual(P.wholeBlocker("play", true), "");
assert(/calibration/.test(P.wholeBlocker("cal2", true)));
assert(/No song/.test(P.wholeBlocker("play", false)));

// A request on its way counts for a few seconds only, so a lost reply cannot turn the next press into a stop.
assert(P.listenPending({ at: 1000 }, 3000, 5000));
assert(!P.listenPending({ at: 1000 }, 6000, 5000), "stale after 5 s");
assert(!P.listenPending(null, 1000, 5000));

// The hear key: once starts the bar, again while it plays stops it, twice quickly plays the whole song, and a
// press after the song started stops it. This is the remote path that needs no key repeat.
assert.strictEqual(P.hearKeyAction({ playing: false, tapAt: 0 }, 10000, 500), "bar");
assert.strictEqual(P.hearKeyAction({ playing: true, tapAt: 10000 }, 10300, 500), "whole", "a second press within 500 ms");
assert.strictEqual(P.hearKeyAction({ playing: true, tapAt: 10000 }, 10499, 500), "whole");
assert.strictEqual(P.hearKeyAction({ playing: true, tapAt: 10000 }, 10500, 500), "stop", "later it is a stop");
assert.strictEqual(P.hearKeyAction({ playing: true, tapAt: 0 }, 10300, 500), "stop", "pressing while the whole song plays stops it");
assert.strictEqual(P.hearKeyAction({ playing: false, tapAt: 0 }, 10300, 500), "bar");
// Held keys that do repeat: 600 ms of holding is a long press; no hold, no long press.
assert(!P.hearHeld(0, 99999, 600));
assert(!P.hearHeld(1000, 1599, 600));
assert(P.hearHeld(1000, 1600, 600));

// The TV page and the link page really use all of it (the page scripts are inline, so this reads their source):
// a refactor of the key handler once dropped the W key without any other test noticing.
{
  const fs = require("fs"), path = require("path");
  const tv = fs.readFileSync(path.join(__dirname, "..", "public", "piano.html"), "utf8");
  const link = fs.readFileSync(path.join(__dirname, "..", "public", "piano-link.html"), "utf8");
  assert(/k === "w" \|\| k === "W"\) && mode === "play"\) \{ if \(!e\.repeat\) toggleWhole\(\)/.test(tv), "W toggles the whole song");
  assert(/P\.hearKeyAction\(/.test(tv) && /isListenKey\(e\)/.test(tv), "the hear key decides with hearKeyAction");
  assert(/c\.cmd === "listenAll"\) toggleWhole\(\)/.test(tv), "the link page's command reaches toggleWhole");
  assert(/P\.hearHeld\(/.test(tv), "holding the hear key still starts the whole song");
  assert(/clearTimer: function \(id\) \{ clearTimeout\(id\); \}/.test(tv), "the TV passes clearTimeout wrapped");
  assert(/cmd: "listenAll"/.test(link), "the link page button sends listenAll");
  assert(/⏪⏪ \(W\) whole song/.test(tv), "the hint line names the keys");
}

console.log("whole-song tests passed");
