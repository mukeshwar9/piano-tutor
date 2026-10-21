// The standalone server: pages, config, songs, calibration, the relay and the switch. Run: node test/server.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dgram = require("dgram");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piano-server-"));
fs.copyFileSync(path.join(ROOT, "songs", "ode-to-joy.json"), path.join(dir, "ode-to-joy.json"));
const port = 20000 + Math.floor(Math.random() * 20000);

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

// Opens the relay as a role and collects events until stop().
function listen(role) {
  const events = [];
  let res = null;
  const req = http.get({ host: "127.0.0.1", port, path: `/api/piano/events?role=${role}` }, (r) => {
    res = r;
    let buf = "";
    r.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
        if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
    });
  });
  req.on("error", () => {});
  return { events, headers: () => res && res.headers, stop: () => req.destroy() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { await request("GET", "/api/config"); return; } catch { await wait(100); }
  }
  throw new Error("server did not start");
}

(async () => {
  // A stand-in for the WiZ bulb on localhost: answers getPilot and setPilot, remembers what it got.
  const bulbGot = [];
  const fakeBulb = dgram.createSocket("udp4");
  fakeBulb.on("message", (buf, rinfo) => {
    const msg = JSON.parse(buf.toString("utf8"));
    bulbGot.push(msg);
    const reply = msg.method === "getPilot" ? { method: "getPilot", result: { state: true, r: 9, g: 8, b: 7, dimming: 66 } } : { method: "setPilot", result: { success: true } };
    fakeBulb.send(JSON.stringify(reply), rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => fakeBulb.bind(0, "127.0.0.1", resolve));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "piano-config-"));
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ bulb: { host: "127.0.0.1", port: fakeBulb.address().port } }));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PIANO_PORT: String(port), PIANO_SONGS_DIR: dir, PIANO_CAL: path.join(dir, "cal.json"), PIANO_CONFIG: path.join(cfgDir, "config.json"), PIANO_WALL_URL: "http://{host}:4410/" },
    stdio: "ignore",
  });
  try {
    await waitForServer();

    let r = await request("GET", "/");
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, "/piano");
    for (const url of ["/piano", "/piano/link"]) {
      r = await request("GET", url);
      assert.strictEqual(r.status, 200, url);
      assert(/<html/i.test(r.text), url);
    }
    for (const url of ["/piano-core.js", "/piano-fx.js", "/piano-sheet.js", "/piano-lessons.js", "/pitch.js", "/pitch-worklet.js", "/switch.js", "/vendor/vexflow-4.2.5-bravura.js"]) {
      r = await request("GET", url);
      assert.strictEqual(r.status, 200, url);
      assert(/javascript/.test(r.headers["content-type"]), url);
    }
    assert.strictEqual((await request("GET", "/server.js")).status, 404, "only the pages and scripts are served");

    r = await request("GET", "/api/config");
    assert.deepStrictEqual(r.data, { wallUrl: "http://{host}:4410/" });

    r = await request("GET", "/api/piano/songs");
    assert.deepStrictEqual(r.data.songs.map((s) => s.id), ["ode-to-joy"]);
    r = await request("GET", "/api/piano/songs/ode-to-joy");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.title, "Ode to Joy");

    // Calibration and score history are written to the configured files.
    r = await request("GET", "/api/piano/calibration");
    assert.strictEqual(r.data.calibration, null);
    r = await request("POST", "/api/piano/calibration", { low: 36, high: 96, left: 100, right: 1800, screenPx: 1920 });
    assert.strictEqual(r.status, 200, r.text);
    assert(fs.existsSync(path.join(dir, "cal.json")));
    r = await request("POST", "/api/piano/history", { song: "ode-to-joy", hand: "both", accuracy: 0.9, bestStreak: 12, correct: 30, wrong: 3, durationMs: 60000 });
    assert.strictEqual(r.status, 200, r.text);
    assert(fs.existsSync(path.join(dir, "piano-history.json")), "history sits next to the calibration");

    // The relay: link page notes reach the TV; the wall, on another origin, hears switch requests.
    const tv = listen("tv"), wall = listen("wall");
    await wait(200);
    assert.strictEqual(wall.headers()["access-control-allow-origin"], "*");
    r = await request("GET", "/api/piano/presence");
    assert.strictEqual(r.data.tv, 1);
    assert.strictEqual(r.data.wall, 1);
    r = await request("POST", "/api/piano/input", { events: [{ on: true, note: 60, velocity: 90 }] });
    assert.strictEqual(r.data.tv, 1);
    r = await request("POST", "/api/switch", { to: "piano" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await request("POST", "/api/switch", { to: "toString" })).status, 400);
    await wait(200);
    assert(tv.events.some((e) => e.event === "midi" && e.data.events[0].note === 60));
    assert(!wall.events.some((e) => e.event === "midi"), "notes only go to TV pages");
    assert(wall.events.some((e) => e.event === "switch" && e.data.to === "piano"));
    tv.stop(); wall.stop();

    // The room light: on by default, the first note takes the bulb over, off puts it back and is saved.
    r = await request("GET", "/api/piano/light");
    assert.strictEqual(r.data.enabled, true);
    assert.strictEqual(r.data.configured, true);
    assert.strictEqual(r.data.palette, "spectrum", "spectrum is the default palette");
    assert.deepStrictEqual(r.data.palettes, ["spectrum", "aurora", "sunset", "ocean", "warm"]);
    assert.strictEqual((await request("POST", "/api/piano/light", { enabled: "yes" })).status, 400);
    assert.strictEqual((await request("POST", "/api/piano/light", { palette: "neon" })).status, 400);
    assert.strictEqual((await request("POST", "/api/piano/light", {})).status, 400);
    const link = listen("link");
    await wait(300);
    assert(link.events.some((e) => e.event === "light" && e.data.enabled === true), "state is sent on connect");
    await request("POST", "/api/piano/input", { events: [{ on: true, note: 62, velocity: 90 }] });
    await wait(1500);
    assert(bulbGot.some((m) => m.method === "setPilot" && m.params.state === true && m.params.dimming >= 60), "colour reaches the bulb, starting near its own");
    assert.strictEqual((await request("GET", "/api/piano/light")).data.status, "active");
    r = await request("POST", "/api/piano/light", { palette: "ocean" });
    assert.strictEqual(r.data.palette, "ocean");
    assert.strictEqual(r.data.enabled, true, "choosing a palette leaves the switch alone");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "piano-light.json"), "utf8")), { enabled: true, palette: "ocean" });
    assert.strictEqual((await request("GET", "/api/piano/light")).data.palette, "ocean");
    assert(link.events.some((e) => e.event === "light" && e.data.palette === "ocean"), "palette is broadcast");
    r = await request("POST", "/api/piano/light", { enabled: false });
    assert.strictEqual(r.data.enabled, false);
    assert.strictEqual(r.data.palette, "ocean", "switching off keeps the palette");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "piano-light.json"), "utf8")), { enabled: false, palette: "ocean" });
    await wait(200);
    const restored = bulbGot[bulbGot.length - 1];
    assert.deepStrictEqual(restored, { method: "setPilot", params: { state: true, r: 9, g: 8, b: 7, dimming: 66 } });
    await wait(1500);
    const quiet = bulbGot.length;
    await request("POST", "/api/piano/input", { events: [{ on: true, note: 64, velocity: 90 }] });
    await wait(700);
    assert.strictEqual(bulbGot.length, quiet, "off: nothing is sent");
    assert(link.events.some((e) => e.event === "light" && e.data.enabled === false), "switch is broadcast");
    link.stop();

    // Hear it first: a bar is relayed as it comes; the whole song arrives as chunks that keep their place in it.
    const hear = listen("link");
    await wait(300);
    const ev = (note, at) => ({ note, at, dur: 400 });
    assert.strictEqual((await request("POST", "/api/piano/listen", { events: [] })).status, 400, "a bar needs notes");
    assert.strictEqual((await request("POST", "/api/piano/listen", { events: [ev(60, 0), ev(300, 0)] })).status, 200);
    assert.strictEqual((await request("POST", "/api/piano/listen", { whole: true, first: true, base: 0, span: 4000, events: [ev(60, 0), ev(62, 500), ev(64, 700000)] })).status, 200);
    assert.strictEqual((await request("POST", "/api/piano/listen", { whole: true, base: 4000, span: 4000, events: [] })).status, 200, "a chunk of rests is a heartbeat");
    assert.strictEqual((await request("POST", "/api/piano/listen", { whole: true, last: true, base: 3 * 3600000, span: 4000, events: [ev(65, 100)] })).status, 200, "a seven-minute song is fine, so are hours");
    assert.strictEqual((await request("POST", "/api/piano/listen", { whole: true, base: -1, events: [ev(60, 0)] })).status, 400);
    assert.strictEqual((await request("POST", "/api/piano/listen", { whole: true, base: 5 * 3600000, events: [ev(60, 0)] })).status, 400);
    assert.strictEqual((await request("POST", "/api/piano/listen", { stop: true })).status, 200);
    await wait(300);
    const heard = hear.events.filter((e) => e.event === "listen").map((e) => e.data);
    assert.deepStrictEqual(heard, [
      { events: [{ note: 60, at: 0, dur: 400 }] },
      { events: [{ note: 60, at: 0, dur: 400 }, { note: 62, at: 500, dur: 400 }], whole: true, first: true, last: false, base: 0, span: 4000 },
      { events: [], whole: true, first: false, last: false, base: 4000, span: 4000 },
      { events: [{ note: 65, at: 100, dur: 400 }], whole: true, first: false, last: true, base: 3 * 3600000, span: 4000 },
      { stop: true },
    ]);
    assert.strictEqual((await request("POST", "/api/piano/control", { cmd: "listenAll" })).status, 200, "the link page can ask the TV to play the whole song");
    for (const cmd of ["fx", "fxIntensity"]) assert.strictEqual((await request("POST", "/api/piano/control", { cmd, id: "lite" })).status, 200, "the link page can set the light effects: " + cmd);
    hear.stop();
    // Pages open for long learn when the server's code changed (the build id), the wall page does not need it.
    const tvB = listen("tv"), linkB = listen("link"), wallB = listen("wall");
    await wait(300);
    const ids = [tvB, linkB].map((l) => (l.events.find((e) => e.event === "build") || { data: {} }).data.id);
    assert(ids[0] && ids[0] === ids[1], "TV and link page get the same build id on connect");
    assert(!wallB.events.some((e) => e.event === "build"), "the wall page is not sent one");
    tvB.stop(); linkB.stop(); wallB.stop();

    console.log("server tests passed");
  } finally {
    child.kill();
    fakeBulb.close();
    fs.rmSync(cfgDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
