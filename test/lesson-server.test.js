// Tutorial endpoints on the real server: the lesson list, one lesson, progress saved to its file,
// unlock order enforced, bad lesson files listed with their error, and the page serving the lessons script.
// Run: node test/lesson-server.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piano-lesson-server-"));
const lessonsDir = path.join(dir, "lessons"), songsDir = path.join(dir, "songs");
fs.mkdirSync(lessonsDir); fs.mkdirSync(songsDir);
fs.copyFileSync(path.join(ROOT, "songs", "twinkle-twinkle-little-star.json"), path.join(songsDir, "twinkle-twinkle-little-star.json"));
const lesson = (id, title) => ({ id, title, goal: "A goal.", steps: [{ type: "explain", text: "Hello." }, { type: "find", prompt: "Play any C", target: "C" }, { type: "check", notes: [["C4", 0, 1]], bpm: 60 }] });
fs.writeFileSync(path.join(lessonsDir, "01-one.json"), JSON.stringify(lesson("one", "One")));
fs.writeFileSync(path.join(lessonsDir, "02-two.json"), JSON.stringify(lesson("two", "Two")));
const broken = lesson("three", "Three"); broken.steps[2].notes = [["C9", 0, 1]];
fs.writeFileSync(path.join(lessonsDir, "03-three.json"), JSON.stringify(broken));
fs.writeFileSync(path.join(lessonsDir, "04-with-song.json"), JSON.stringify({ ...lesson("four", "Four"), steps: [{ type: "explain", text: "Hi." }, { type: "check", song: { id: "twinkle-twinkle-little-star", from: 1, to: 2 }, hand: "both" }] }));
const port = 20000 + Math.floor(Math.random() * 20000);
const progressFile = path.join(dir, "piano-progress.json");

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PIANO_PORT: String(port), PIANO_SONGS_DIR: songsDir, PIANO_LESSONS_DIR: lessonsDir, PIANO_CAL: path.join(dir, "cal.json"), PIANO_CONFIG: path.join(dir, "none.json") },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) { try { await request("GET", "/api/config"); break; } catch { await wait(100); } }

    let r = await request("GET", "/piano-lessons.js");
    assert.strictEqual(r.status, 200);
    assert(/javascript/.test(r.headers["content-type"]));
    assert(/\/piano-lessons\.js/.test((await request("GET", "/piano")).text), "the TV page loads the lessons script");

    // The list: summaries only, a broken lesson with its error, empty progress.
    r = await request("GET", "/api/piano/lessons");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.lessons.map((l) => l.id), ["one", "two", "three", "four"]);
    assert.deepStrictEqual(r.data.lessons[0], { id: "one", title: "One", goal: "A goal.", steps: 3 });
    assert(/outside the keyboard/.test(r.data.lessons[2].error));
    assert(!("steps" in r.data.lessons[2]));
    assert.deepStrictEqual(r.data.progress, { version: 1, lessons: {} });

    // One lesson: every step; library steps arrive as notes.
    r = await request("GET", "/api/piano/lessons/one");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.steps.length, 3);
    assert.strictEqual(r.data.steps[2].type, "check");
    r = await request("GET", "/api/piano/lessons/four");
    assert.strictEqual(r.status, 200);
    assert(r.data.steps[1].notes.length > 8 && r.data.steps[1].songRef.id === "twinkle-twinkle-little-star");
    assert.strictEqual((await request("GET", "/api/piano/lessons/three")).status, 422, "a broken lesson is not served");
    assert.strictEqual((await request("GET", "/api/piano/lessons/nope")).status, 404);

    // Progress: saved next to the calibration, in order.
    r = await request("GET", "/api/piano/progress");
    assert.deepStrictEqual(r.data.progress.lessons, {});
    r = await request("POST", "/api/piano/progress", { lesson: "two", action: "step", step: 0 });
    assert.strictEqual(r.status, 400, "lesson 2 is locked");
    assert(/locked/.test(r.data.error));
    r = await request("POST", "/api/piano/progress", { lesson: "one", action: "step", step: 2 });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.data.progress.lessons.one.status, "in-progress");
    assert.strictEqual(r.data.progress.lessons.one.step, 2);
    assert(fs.existsSync(progressFile), "piano-progress.json sits next to the calibration");
    assert.strictEqual((await request("POST", "/api/piano/progress", { lesson: "one", action: "step", step: 9 })).status, 400);
    assert.strictEqual((await request("POST", "/api/piano/progress", { lesson: "one", action: "pass", score: 3 })).status, 400);
    assert.strictEqual((await request("POST", "/api/piano/progress", { lesson: "nope", action: "step", step: 0 })).status, 400);
    assert.strictEqual((await request("POST", "/api/piano/progress", { lesson: "one", action: "attempt", score: 0.5 })).status, 200);
    r = await request("POST", "/api/piano/progress", { lesson: "one", action: "pass", score: 0.9 });
    assert.strictEqual(r.data.progress.lessons.one.status, "passed");
    assert.strictEqual(r.data.progress.lessons.one.best, 0.9);
    assert.strictEqual((await request("POST", "/api/piano/progress", { lesson: "two", action: "step", step: 1 })).status, 200, "passing one opens two");
    r = await request("GET", "/api/piano/lessons");
    assert.strictEqual(r.data.progress.lessons.one.status, "passed");
    assert.strictEqual(r.data.progress.lessons.two.step, 1, "resume point is kept");
    // It survives a restart: the file is the source of truth, and a damaged file means a fresh start.
    assert.strictEqual(JSON.parse(fs.readFileSync(progressFile, "utf8")).lessons.one.status, "passed");
    fs.writeFileSync(progressFile, "{ damaged");
    r = await request("GET", "/api/piano/progress");
    assert.deepStrictEqual(r.data.progress, { version: 1, lessons: {} });
    assert.strictEqual((await request("POST", "/api/piano/progress", { lesson: "one", action: "step", step: 0 })).status, 200, "and progress can be saved again");

    // The link page can open the lessons on the TV.
    r = await request("POST", "/api/piano/control", { cmd: "learn", id: "on" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await request("POST", "/api/piano/control", { cmd: "teleport" })).status, 400);

    console.log("lesson server tests passed");
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
