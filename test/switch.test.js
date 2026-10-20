// Wall <-> piano switch: remote key matching and where each switch goes. Run: node test/switch.test.js
const assert = require("assert");
const S = require("../public/switch.js");

// Keys that reach the page on the Fire TV remote (checked with adb against Fully Kiosk).
assert(S.isSwitchKey({ key: "MediaRewind", keyCode: 227 }));
assert(S.isSwitchKey({ key: "MediaFastForward", keyCode: 228 }));
assert(S.isSwitchKey({ key: "m" }));
assert(S.isSwitchKey({ key: "Unidentified", keyCode: 228 }), "key code fallback");
// Keys the pages already use must not switch.
for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " ", "MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "r", "c", "Backspace"]) {
  assert(!S.isSwitchKey({ key, keyCode: 0 }), key);
}
assert(!S.isSwitchKey({ key: "m", metaKey: true }), "browser shortcuts are left alone");

// Hear it first on the piano page: Rewind (checked to reach the page with adb, like Fast-Forward) or P.
assert(S.isListenKey({ key: "MediaRewind", keyCode: 227 }));
assert(S.isListenKey({ key: "Unidentified", keyCode: 227 }), "key code fallback");
assert(S.isListenKey({ key: "p" }));
assert(!S.isListenKey({ key: "MediaFastForward", keyCode: 228 }), "Fast-Forward still goes to the wall");
assert(!S.isListenKey({ key: "p", ctrlKey: true }));
for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " ", "MediaPlayPause", "l", "h", "c", "r", "m", "f"]) {
  assert(!S.isListenKey({ key, keyCode: 0 }), key);
}

// A remote request only moves a TV that is not already there.
assert(S.shouldMove("piano", "wall"));
assert(!S.shouldMove("piano", "piano"));
assert(S.shouldMove("wall", "piano"));
assert(!S.shouldMove("wall", "wall"));
assert(!S.shouldMove("nonsense", "wall"));
assert(!S.shouldMove("toString", "wall"), "inherited properties are not targets");
assert(S.isTarget("wall") && S.isTarget("piano") && !S.isTarget("toString") && !S.isTarget(undefined));

// Configured addresses: {host} is the host the page came from, empty means none configured.
assert.strictEqual(S.resolveUrl(S.DEFAULT_PIANO_URL, "tv-host"), "http://tv-host:4420/piano");
assert.strictEqual(S.resolveUrl("http://{host}:4410/", "10.0.0.5"), "http://10.0.0.5:4410/");
assert.strictEqual(S.resolveUrl("http://{host}:4410/", ""), "http://localhost:4410/");
assert.strictEqual(S.resolveUrl("http://{host}:4410/", "::1"), "http://[::1]:4410/");
assert.strictEqual(S.resolveUrl("https://wall.example/", "x"), "https://wall.example/");
assert.strictEqual(S.resolveUrl("", "x"), "");
assert.strictEqual(S.resolveUrl(undefined, "x"), "");

// The server part of an address, for its API.
assert.strictEqual(S.originOf("http://tv-host:4420/piano"), "http://tv-host:4420");
assert.strictEqual(S.originOf("https://wall.example"), "https://wall.example");
assert.strictEqual(S.originOf("/piano"), "");
assert.strictEqual(S.originOf(""), "");
console.log("switch tests passed");
