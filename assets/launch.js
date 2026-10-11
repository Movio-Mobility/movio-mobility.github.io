/*
 * When PowerPod Gen2 pre-booking opens, for every page that has to know: the home page counts
 * down to it under its headline (and under the finale's pod and phone), to the minute, and from
 * that moment shows the button to pre-book one in the count's place, and the configurator holds
 * its payment step until it. One instant, 12:00 PM IST on 12 October 2026, compared in epoch
 * milliseconds, so the visitor's time zone never matters, only whether their clock is right.
 *
 * Paddock holds the same instant (lib/website/launch.js) and refuses an early order whatever a
 * browser believes, so a wrong clock here can only make the page look early or late, never let
 * anyone in. To keep even that rare, the site is asked the time once, in idle time, and a
 * clock more than a minute out is corrected.
 *
 *   gridLaunch.at              the instant, in epoch ms
 *   gridLaunch.when            the instant in words, "12 October, 12 PM" (IST)
 *   gridLaunch.now()           Date.now(), corrected
 *   gridLaunch.left()          how long is left, in words: "26 hours, 12 minutes"
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

  // How long is left, in hours and minutes, the minute rounded up so the count never says a
  // minute that has already gone: "26 hours, 12 minutes", "1 hour, 1 minute", "40 minutes".
  function left() {
    const minutes = Math.max(1, Math.ceil((AT - now()) / MINUTE));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    return h ? `${unit(h, 'hour')}, ${unit(m, 'minute')}` : unit(m, 'minute');
  }

  // The count, written into every line on the page that carries it (the home page's hero and
  // its finale), and the "in" that turns "Pre-booking opens" into a count.
  const counts = [...document.querySelectorAll('[data-launch-count]')];
  const leads = [...document.querySelectorAll('[data-launch-lead]')];
  function paint() {
    if (!counts.length || isOpen()) return;
    const words = left();
    for (const el of counts) if (el.textContent !== words) el.textContent = words;
    for (const el of leads) if (el.textContent !== 'Pre-booking opens in') el.textContent = 'Pre-booking opens in';
  }

  // Wakes at the launch, and every minute before it as the count changes, and looks again:
  // worked out from the clock every time rather than counted down, so a late timer never
  // drifts, and a page woken late simply shows the right minute.
  function tick() {
    clearTimeout(timer);
    const open = isOpen();
    if (open !== wasOpen) {
      wasOpen = open;
      listeners.forEach((fn) => fn(open));
    }
    paint();
    if (!open) {
      const toGo = AT - now();
      // The count changes when what is left crosses a whole minute.
      const change = (toGo % MINUTE) || MINUTE;
      timer = setTimeout(tick, Math.min(toGo, change) + 15);
    }
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
    left,
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
  // Under the headline: the count until pre-booking opens, and from that moment, in its place,
  // the button to pre-book one.
  function underHeadline(box) {
    const hero = box.parentElement;
    const headline = hero.querySelector('.headline');
    const cta = box.querySelector('.launch__cta');
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
      // Opened in front of the reader: the count goes and the button rises in its place.
      // Otherwise the button is simply there, arriving with the headline.
      const watching = !first && !document.hidden && headline.classList.contains('is-revealed') && !away();
      box.classList.add('is-open');
      if (watching) {
        box.classList.add('is-opening');
        setTimeout(() => box.classList.remove('is-opening'), 1500);
      }
      if (!first && news) news.textContent = 'Pre-booking is open.';
    });
  }
})();
