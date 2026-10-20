// Wall <-> piano switch: which remote key toggles the two TV pages and where each switch goes.
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

  var PATHS = { wall: "/", piano: "/piano" };

  function isPiano(pathname) {
    return pathname === "/piano" || pathname.indexOf("/piano/") === 0;
  }

  function isSwitchKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    return KEYS.indexOf(e.key) >= 0 || ((e.key === undefined || e.key === "Unidentified") && KEY_CODES.indexOf(e.keyCode) >= 0);
  }

  function isListenKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    return LISTEN_KEYS.indexOf(e.key) >= 0 || ((e.key === undefined || e.key === "Unidentified") && LISTEN_KEY_CODES.indexOf(e.keyCode) >= 0);
  }

  // The page a toggle press goes to from pathname.
  function togglePath(pathname) {
    return isPiano(pathname) ? PATHS.wall : PATHS.piano;
  }

  // A remote "show <to>" request: the path to open, or "" when the TV is already there (or the target is unknown).
  function pathFor(to, pathname) {
    if (!PATHS.hasOwnProperty(to)) return "";
    return isPiano(pathname) === (to === "piano") ? "" : PATHS[to];
  }

  return { KEYS: KEYS, PATHS: PATHS, isSwitchKey: isSwitchKey, isListenKey: isListenKey, togglePath: togglePath, pathFor: pathFor, isPiano: isPiano };
});
