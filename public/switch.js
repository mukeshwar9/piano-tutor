// Wall <-> piano switch: which remote key toggles the two TV pages and where each switch goes.
// The wall and the piano tutor are separate servers, so each page links to the other by a
// configured address in which "{host}" stands for the host the page itself was loaded from.
// Plain ES5 so it runs unchanged in the TV browser and in Node (server and tests).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TVSwitch = factory();
})(this, function () {
  "use strict";

  // Menu and Back never reach the page in Fully Kiosk on the Fire TV; Rewind and Fast-Forward do,
  // and both pages already have Left/Right for what those keys used to duplicate. "M" is for keyboards.
  var KEYS = ["MediaRewind", "MediaFastForward", "m", "M"];
  var KEY_CODES = [227, 228];

  // On the piano page Rewind plays the bar first ("hear it first") and Fast-Forward alone goes back
  // to the wall; on the wall both still switch. "P" is for keyboards.
  var LISTEN_KEYS = ["MediaRewind", "p", "P"];
  var LISTEN_KEY_CODES = [227];

  var TARGETS = { wall: true, piano: true };

  // Where the piano tutor runs when nothing else is configured: its own server on the same machine.
  var DEFAULT_PIANO_URL = "http://{host}:4420/piano";

  function isTarget(to) {
    return typeof to === "string" && Object.prototype.hasOwnProperty.call(TARGETS, to);
  }

  function isSwitchKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    return KEYS.indexOf(e.key) >= 0 || ((e.key === undefined || e.key === "Unidentified") && KEY_CODES.indexOf(e.keyCode) >= 0);
  }

  function isListenKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    return LISTEN_KEYS.indexOf(e.key) >= 0 || ((e.key === undefined || e.key === "Unidentified") && LISTEN_KEY_CODES.indexOf(e.keyCode) >= 0);
  }

  // A remote "show <to>" request seen by the page `here` ("wall" or "piano"): true when the TV should move.
  function shouldMove(to, here) {
    return isTarget(to) && to !== here;
  }

  // A configured address with "{host}" replaced by hostname ("" stays "": no page configured).
  function resolveUrl(template, hostname) {
    var t = String(template || "").trim();
    if (!t) return "";
    var h = String(hostname || "localhost");
    if (h.indexOf(":") >= 0 && h.charAt(0) !== "[") h = "[" + h + "]"; // IPv6 literal
    return t.replace(/\{host\}/g, h);
  }

  // The scheme, host and port of an address, for reaching that server's API ("" when it has none).
  function originOf(url) {
    var m = /^(https?:\/\/[^\/?#]+)/i.exec(String(url || ""));
    return m ? m[1] : "";
  }

  return {
    KEYS: KEYS, DEFAULT_PIANO_URL: DEFAULT_PIANO_URL, isTarget: isTarget, isSwitchKey: isSwitchKey,
    isListenKey: isListenKey, shouldMove: shouldMove, resolveUrl: resolveUrl, originOf: originOf,
  };
});
