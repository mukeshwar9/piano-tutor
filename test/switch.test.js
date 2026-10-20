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

// Toggle goes to the other page.
assert.strictEqual(S.togglePath("/"), "/piano");
assert.strictEqual(S.togglePath("/piano"), "/");
assert.strictEqual(S.togglePath("/piano/link"), "/");

// A remote request only moves a TV that is not already there.
assert.strictEqual(S.pathFor("piano", "/"), "/piano");
assert.strictEqual(S.pathFor("piano", "/piano"), "");
assert.strictEqual(S.pathFor("wall", "/piano"), "/");
assert.strictEqual(S.pathFor("wall", "/"), "");
assert.strictEqual(S.pathFor("nonsense", "/"), "");
assert.strictEqual(S.pathFor("toString", "/"), "", "inherited properties are not targets");
console.log("switch tests passed");
