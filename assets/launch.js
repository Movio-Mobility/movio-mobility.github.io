/*
 * When PowerPod Gen2 pre-booking opens, for every page that has to know: the home page says when
 * under its headline and, from that moment, shows the button to pre-book one, and the
 * configurator holds its payment step until it. One instant, 12:00 PM IST on 12 October 2026,
 * compared in epoch milliseconds, so the visitor's time zone never matters, only whether their
 * clock is right.
 *
 * Paddock holds the same instant (lib/website/launch.js) and refuses an early order whatever a
 * browser believes, so a wrong clock here can only make the page look early or late, never let
 * anyone in. To keep even that rare, the site is asked the time once, in idle time, and a
 * clock more than a minute out is corrected.
 *
 *   gridLaunch.at              the instant, in epoch ms
 *   gridLaunch.when            the instant in words, "12 October, 12 PM" (IST)
 *   gridLaunch.now()           Date.now(), corrected
 *   gridLaunch.isOpen()
 *   gridLaunch.subscribe(fn)   fn(open) now, then again the moment pre-booking opens, including
 *                              on a page left open across it. Returns a function that
 *                              unsubscribes.
 *
 * For tools/check/launch.mjs, only with ?check in the address: &launch=<seconds> puts the page
 * that many seconds after the launch (negative is before), and the clock is never corrected.
 */
(function () {
  'use strict';

  const AT = Date.UTC(2026, 9, 12, 6, 30); // 12 October 2026, 12:00 PM IST
  const WHEN = '12 October, 12 PM'; // the same instant in words; change the two together
  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const params = new URLSearchParams(location.search);
  const checking = params.has('check');

  let skew = 0;
  const faked = checking ? Number(params.get('launch')) : NaN;
  if (Number.isFinite(faked)) skew = AT + faked * 1000 - Date.now();

  const now = () => Date.now() + skew;
  const isOpen = () => now() >= AT;

  const listeners = new Set();
  let wasOpen = isOpen();
  let timer = 0;

  // Wakes at the launch, or within the hour before it, and looks again: worked out from the
  // clock every time rather than counted down, so a late timer never drifts.
  function tick() {
    clearTimeout(timer);
    const open = isOpen();
    if (open !== wasOpen) {
      wasOpen = open;
      listeners.forEach((fn) => fn(open));
    }
    if (!open) timer = setTimeout(tick, Math.min(AT - now(), HOUR) + 15);
  }

  // A background tab or a sleeping phone holds timers back: catch up the moment it is seen.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('pageshow', tick);
  window.addEventListener('focus', tick);

  // The clock check. Only a clock more than a minute out is corrected, and only on a quick
  // answer, so a slow network never moves a good clock. robots.txt is the smallest file the
  // site serves, and the service worker never keeps it (it holds pages, versioned assets and
  // images), so with no-store this is always the server's own time. A HEAD request would be
  // smaller still, but Chrome logs one with a length and no body as aborted.
  function checkClock() {
    if (checking || !/^https?:$/.test(location.protocol) || !window.fetch) return;
    const sent = Date.now();
    fetch('/robots.txt', { cache: 'no-store' }).then((res) => {
      const back = Date.now();
      const server = Date.parse(res.headers.get('date') || '');
      if (!Number.isFinite(server) || back - sent > 3000) return;
      // The header is to the second, rounded down: half a second puts it in the middle.
      const off = server + 500 - (sent + back) / 2;
      if (Math.abs(off) > MINUTE) {
        skew = off;
        tick();
      }
    }).catch(() => {});
  }
  const idle = window.GridPerf && window.GridPerf.idle;
  window.addEventListener('load', () => (idle ? idle(checkClock, 4000) : setTimeout(checkClock, 2000)), { once: true });

  window.gridLaunch = {
    at: AT,
    when: WHEN,
    now,
    isOpen,
    subscribe(fn) {
      listeners.add(fn);
      fn(isOpen());
      return () => listeners.delete(fn);
    },
  };
  tick();

  const box = document.querySelector('[data-launch]');
  if (box) underHeadline(box);

  // ---------------------------------------------------------------- the home page's line
  // Under the headline: when pre-booking opens, and from that moment the button to pre-book one.
  function underHeadline(box) {
    const hero = box.parentElement;
    const headline = hero.querySelector('.headline');
    const cta = box.querySelector('.launch__cta');
    const note = box.querySelector('[data-launch-note]');
    const news = box.querySelector('[data-launch-news]');

    // Just under the headline, as its subline. Laid out in an idle moment after the first
    // frames rather than in them, since placing it means a layout of the whole page; a headline
    // that is already up (reduced motion, no WebGL) has it placed at once, so nothing moves in
    // front of it.
    function layout() {
      const below = headline.offsetTop + headline.offsetHeight;
      // A landscape phone has little room under the headline, and the island to clear.
      const gap = window.innerHeight <= 480 ? 8 : Math.max(14, Math.min(28, headline.offsetHeight * 0.14));
      hero.style.setProperty('--launch-top', `${Math.round(below + gap)}px`);
    }
    function watch() {
      if ('ResizeObserver' in window) new ResizeObserver(layout).observe(headline);
      else layout();
      window.addEventListener('resize', layout);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
    }
    if (headline.classList.contains('is-revealed') || !idle) watch();
    else idle(watch, 700);

    // The button only takes a tab while it can be seen.
    const away = () => headline.classList.contains('is-leaving');
    const syncTab = () => {
      if (away()) cta.setAttribute('tabindex', '-1');
      else cta.removeAttribute('tabindex');
    };
    syncTab();
    new MutationObserver(syncTab).observe(headline, { attributes: true, attributeFilter: ['class'] });

    let loading = true;
    window.gridLaunch.subscribe((open) => {
      const first = loading;
      loading = false;
      if (!open || box.classList.contains('is-open')) return;
      // Opened in front of the reader: the line changes and the button rises in after it.
      // Otherwise the button is simply there, arriving with the headline.
      const watching = !first && !document.hidden && headline.classList.contains('is-revealed') && !away();
      box.classList.add('is-open');
      if (watching) {
        box.classList.add('is-opening');
        setTimeout(() => box.classList.remove('is-opening'), 1500);
      }
      // In phrases, as the line before it is, so a break only ever falls between them.
      const strong = document.createElement('strong');
      strong.textContent = 'now open.';
      const phrase = (...parts) => {
        const span = document.createElement('span');
        span.className = 'ph';
        span.append(...parts);
        return span;
      };
      note.replaceChildren(phrase('Pre-booking is ', strong), ' ', phrase('Shipping across India.'));
      if (!first && news) news.textContent = 'Pre-booking is open.';
    });
  }
})();
