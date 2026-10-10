/*
 * DevTools are met with a joke rather than the site. Reaching for them swaps the page for
 * better.html: a line of type, some drifting light, and not one line of code to look at.
 *
 * Three ways in, three answers:
 *   - The shortcuts, every one that opens DevTools, a panel of them or the page's source, in
 *     every desktop browser on Windows, macOS, Linux and ChromeOS (SHORTCUTS below):
 *     swallowed, and the page swapped.
 *   - The context menu, whose last item is Inspect, however it is opened (right click, the
 *     menu key, Shift+F10): never shown, except in a text field, where paste matters more. On a
 *     phone this is also the long-press menu, with its new tab and download link. A right click
 *     is usually innocent, so on its own it swaps nothing.
 *   - DevTools opened some other way (the browser's menu, or left open from another site in
 *     this tab): a bare `debugger`, which only does anything while DevTools is open. Then it
 *     stops the clock until the inspector lets go, so a jump across it is the tell. Checked on
 *     arrival, every couple of seconds while the page is in view, and whenever it comes back.
 *
 * Off on localhost and file:, so the site can still be built with DevTools open; ?guard turns
 * it on there to try it. None of this is security. A page's files are public by nature, and
 * anyone set on reading them can (view-source:, curl, breakpoints off). It is a wink.
 */
(() => {
  'use strict';

  const local = location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (local && !new URLSearchParams(location.search).has('guard')) return;

  const NOPE = '/better.html'; // from the root, so the 404 page, served at any depth, finds it too
  const FADE_MS = 450;
  const PAUSE_MS = 100;        // far beyond a no-op's microseconds, far below any human resume
  const CHECK_MS = 2000;
  const ua = navigator.userAgent;
  const firefox = /firefox\//i.test(ua);
  const safari = !firefox && /^((?!chrome|chromium|crios|edg|opr|android).)*safari/i.test(ua);

  // Every way a keyboard opens the inspector, one of its panels or the page's source, in every
  // desktop browser on every system. Chrome, Edge, Brave, Opera, Vivaldi and Arc share
  // Chromium's keys; Firefox and Safari add their own. Modifiers match exactly, so Ctrl+Shift+U
  // (Linux's Unicode entry) is not Ctrl+U. A rule tied to one browser is one whose keys mean
  // something innocent in the others. The last field lets a text field keep its keys where they
  // are editing too (Ctrl+Shift+Z is redo).
  //   [modifiers, keys, applies here, a text field keeps them]
  const SHORTCUTS = [
    // Windows, Linux and ChromeOS
    ['ctrl shift', 'I J C K E'],          // DevTools, console, element picker, Firefox's console and network
    ['ctrl shift', 'M', firefox],         // responsive design (Chrome: switch profile)
    ['ctrl shift', 'Z', firefox, true],   // debugger
    ['ctrl alt shift', 'I', firefox],     // browser toolbox
    ['ctrl', 'U'],                        // page source
    ['shift', 'F2 F5 F7 F9', firefox],    // command line, performance, style editor, storage (Chrome: Shift+F5 reloads)
    // macOS
    ['meta alt', 'I J C K E U'],          // DevTools, console, element picker, Firefox's console and network, page source
    ['meta alt', 'Z M', firefox],         // debugger, responsive design
    ['meta alt', 'A R', safari],          // page resources, responsive design (Firefox: Cmd+Opt+R is reader view)
    ['meta alt shift', 'I', firefox],     // browser toolbox
    ['meta alt shift', 'T', safari],      // timeline recording
    ['meta shift', 'C'],                  // element picker
    ['meta shift', 'J', firefox],         // browser console (Chrome: Downloads)
    ['meta', 'U', firefox],               // page source
  ];
  const blocked = new Map(); // 'ctrl shift+I' -> whether a text field keeps it
  for (const [mods, keys, applies = true, fieldKeeps = false] of SHORTCUTS) {
    if (applies) for (const key of keys.split(' ')) blocked.set(`${mods}+${key}`, fieldKeeps);
  }

  const inField = (el) => el instanceof Element && Boolean(el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));

  let gone = false;
  let timer = 0;

  // The content leaves before the page does, so the swap reads as meant rather than as a crash.
  // Everything but the studio dissolves, and the drifting light carries over into better.html.
  function nope() {
    if (gone) return;
    gone = true;
    clearInterval(timer);
    const go = () => location.replace(NOPE);
    if (!document.body || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      go();
      return;
    }
    const style = document.createElement('style');
    style.textContent = `body > :not(#bg) {
      transition: opacity ${FADE_MS}ms ease, filter ${FADE_MS}ms ease !important;
      opacity: 0 !important;
      filter: blur(10px) !important;
      pointer-events: none !important;
    }`;
    document.head.appendChild(style);
    setTimeout(go, FADE_MS);
  }

  // The key as the shortcut sees it. The letter the layout types, where it types a Latin one,
  // since that is what the browsers match on (Ctrl+Shift+I on a Dvorak keyboard is the key
  // marked I, wherever it sits). Otherwise the key's place: Option on a Mac turns letters into
  // symbols, and a Cyrillic layout types no Latin letter at all.
  function keyName(event) {
    if (event.code === 'F12' || /^F\d{1,2}$/.test(event.key)) return event.code === 'F12' ? 'F12' : event.key;
    if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase();
    return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : '';
  }

  window.addEventListener('keydown', (event) => {
    // AltGr (Ctrl+Alt to the browser on Windows) and an input method composing are typing.
    if (event.isComposing || event.getModifierState?.('AltGraph')) return;
    const key = keyName(event);
    if (!key) return;
    const mods = [event.ctrlKey && 'ctrl', event.metaKey && 'meta', event.altKey && 'alt', event.shiftKey && 'shift']
      .filter(Boolean)
      .join(' ');
    const combo = `${mods}+${key}`;
    // F12 opens DevTools under any modifier, in every browser that has them.
    if (key !== 'F12' && !blocked.has(combo)) return;
    if (blocked.get(combo) && inField(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    nope();
  }, true);

  // Right click, the keyboard's menu key and Shift+F10 all open this menu, and Inspect is in it.
  window.addEventListener('contextmenu', (event) => {
    if (inField(event.target)) return;
    event.preventDefault();
  }, true);

  // Kept in a function of its own with nothing else in it, so a paused inspector has one line
  // to show.
  function trap() {
    debugger;
  }

  function check() {
    if (gone || document.visibilityState !== 'visible') return;
    const t = performance.now();
    trap();
    if (performance.now() - t > PAUSE_MS) nope();
  }

  check();
  timer = setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', check);
  // Back from another site through the back/forward cache, possibly with DevTools opened there.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) check();
  });
})();
