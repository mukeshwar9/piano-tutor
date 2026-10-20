// Writes the small song files the import tests read. They are committed; run this again only to
// change them: node test/fixtures/make-fixtures.js
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DIR = __dirname;
const PPQ = 480;

// ---------- MIDI ----------

function varLen(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

// events: [tick, bytes] in any order; written as one MTrk with delta times.
function track(events) {
  events = events.slice().sort((a, b) => a[0] - b[0]);
  const data = [];
  let t = 0;
  for (const [tick, bytes] of events) { data.push(...varLen(tick - t), ...bytes); t = tick; }
  data.push(0, 0xff, 0x2f, 0);
  const head = Buffer.alloc(8);
  head.write("MTrk", 0, "latin1"); head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, Buffer.from(data)]);
}

function midiFile(format, tracks) {
  const head = Buffer.alloc(14);
  head.write("MThd", 0, "latin1"); head.writeUInt32BE(6, 4);
  head.writeUInt16BE(format, 8); head.writeUInt16BE(tracks.length, 10); head.writeUInt16BE(PPQ, 12);
  return Buffer.concat([head, ...tracks]);
}

const meta = (type, bytes) => [0xff, type, ...varLen(bytes.length), ...bytes];
const text = (s) => [...Buffer.from(s, "latin1")];
// A note as on / off events; beats in quarter notes.
const note = (ch, n, start, len, vel = 80) => [[Math.round(start * PPQ), [0x90 | ch, n, vel]], [Math.round((start + len) * PPQ), [0x80 | ch, n, 0]]];

// Two tracks plus a tempo track: 100 bpm (600000 us per quarter), 3/4. The right hand plays
// E4 D4 C4 and a C4+E4 chord; the left hand plays C3 and G2. Track 2 uses running status and
// note-on with velocity 0 as note-off.
function twoTrack() {
  const tempo = track([[0, meta(0x03, text("Two Hands"))], [0, meta(0x51, [0x09, 0x27, 0xc0])], [0, meta(0x58, [3, 2, 24, 8])]]);
  const right = track([[0, meta(0x03, text("Right"))], ...note(0, 64, 0, 1), ...note(0, 62, 1, 1), ...note(0, 60, 2, 1), ...note(0, 60, 3, 3), ...note(0, 64, 3, 3)]);
  const leftData = [];
  // Running status: one 0x90 status byte, then pairs; velocity 0 ends a note.
  const ev = [[0, 48, 70], [3 * PPQ, 48, 0], [3 * PPQ, 43, 70], [6 * PPQ, 43, 0]];
  let t = 0;
  leftData.push(...varLen(0), ...meta(0x03, text("Left")));
  ev.forEach(([tick, n, v], i) => { leftData.push(...varLen(tick - t), ...(i ? [] : [0x91]), n, v); t = tick; });
  leftData.push(0, 0xff, 0x2f, 0);
  const lh = Buffer.alloc(8);
  lh.write("MTrk", 0, "latin1"); lh.writeUInt32BE(leftData.length, 4);
  return midiFile(1, [tempo, right, Buffer.concat([lh, Buffer.from(leftData)])]);
}

// One track (format 0), played by hand: timing a little off the grid, a 20-tick ghost note, a
// drum hit on channel 10, and notes above and below middle C for the hand split.
function oneTrack() {
  return midiFile(0, [track([
    [0, meta(0x51, [0x07, 0xa1, 0x20])], // 120 bpm
    ...note(0, 72, 0.02, 0.95), ...note(0, 48, 0, 1.9),
    ...note(0, 74, 0.98, 1.04), ...note(0, 76, 2.03, 0.97), ...note(0, 55, 1.97, 2),
    [Math.round(1.5 * PPQ), [0x90, 61, 40]], [Math.round(1.5 * PPQ) + 20, [0x80, 61, 0]],
    ...note(9, 36, 0, 0.5),
    ...note(0, 60, 3.27, 0.7), ...note(0, 59, 3.3, 0.68),
  ])]);
}

// ---------- MusicXML ----------

// A piano part on two staves, 4/4 at 72 bpm, with a one-beat pickup: right-hand fingering, a C-E-G
// chord, a tie across the bar line, a rest, a grace note (left out) and a left hand written after
// a backup. Notes outside the 61 keys (C1) are kept for the page to shift.
const SCORE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>Two Staves &amp; Fingers</work-title></work>
  <identification><creator type="composer">Test Composer</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>72</per-minute></metronome></direction-type><sound tempo="72"/></direction>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff>
        <notations><technical><fingering>5</fingering></technical></notations></note>
      <backup><duration>2</duration></backup>
      <forward><duration>2</duration><staff>2</staff></forward>
    </measure>
    <measure number="1">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff>
        <notations><technical><fingering>1</fingering></technical></notations></note>
      <note><grace/><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type><staff>1</staff></note>
      <note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><staff>1</staff>
        <notations><technical><fingering>3</fingering></technical></notations></note>
      <note><rest/><duration>1</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff>
        <notations><technical><fingering>1</fingering></technical></notations></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff>
        <notations><technical><fingering>3</fingering></technical></notations></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff>
        <notations><technical><fingering>5</fingering></technical></notations></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><tie type="start"/><voice>1</voice><type>quarter</type><staff>1</staff>
        <notations><tied type="start"/><technical><fingering>4</fingering></technical></notations></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><voice>5</voice><type>whole</type><staff>2</staff>
        <notations><technical><fingering>5</fingering></technical></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><tie type="stop"/><voice>1</voice><type>half</type><staff>1</staff>
        <notations><tied type="stop"/></notations></note>
      <note><rest/><duration>4</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>C</step><octave>1</octave></pitch><duration>8</duration><voice>5</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>
`;

// ---------- zip ----------

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

// files: [[name, Buffer, deflate?]]
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data, deflate] of files) {
    const body = deflate ? zlib.deflateRawSync(data) : data, n = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, body); centrals.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container><rootfiles><rootfile full-path="score/two-staves.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>
`;

fs.writeFileSync(path.join(DIR, "two-track.mid"), twoTrack());
fs.writeFileSync(path.join(DIR, "one-track.mid"), oneTrack());
fs.writeFileSync(path.join(DIR, "two-staves.musicxml"), SCORE);
fs.writeFileSync(path.join(DIR, "two-staves.mxl"), zip([
  ["mimetype", Buffer.from("application/vnd.recordare.musicxml"), false],
  ["META-INF/container.xml", Buffer.from(CONTAINER), false],
  ["score/two-staves.musicxml", Buffer.from(SCORE), true],
]));
console.log("wrote fixtures to " + DIR);
