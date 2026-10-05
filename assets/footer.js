/*
 * The footer: the end of the film.
 *
 * One value does all of it. `night` is how far the footer has risen into the viewport,
 * 0 at its first pixel and 1 once it fills the screen. It is published three ways, so the
 * shader, the DOM and the phone's status bar all dim on the same curve:
 *
 *   1. gridBG.setNight(night): the house lights come down over the cyclorama while the
 *      particle buffer stays at full strength, and the field goes out a spark at a time.
 *   2. --night on <html>:        the page's chrome recedes with the room (see footer.css).
 *   3. <meta name="theme-color">: the status bar goes dark with everything else.
 *
 * Then the credit reveals out of the dark, and the colophon rises once the stage has pinned.
 *
 * The value is read live from getBoundingClientRect in a rAF loop, the way store.js and
 * powerpod-gen2.js drive their halos, because an observer reports crossings and this needs
 * a continuous position. But a crossing is exactly the right signal for when to *run* that
 * loop, so one IntersectionObserver decides whether the footer is near enough to be worth
 * a frame. A page can be seven viewports long, and two forced layouts a frame all the way
 * down it is a bill nobody should pay to read the top of the page.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const credits = document.querySelector('.credits');
  if (!credits) return;

  const line = credits.querySelector('.credits__line');
  const colophon = credits.querySelector('.credits__colophon');

  // The copyright year, from the reader's own clock, so nobody has to remember to change it
  // in six files every January. The markup carries a real year rather than an empty span, so
  // the line still reads correctly with JavaScript off and for anything crawling the page.
  const year = credits.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const DAY_THEME = themeMeta ? themeMeta.content : '#c4c4c2';
  const NIGHT_THEME = '#0b0b0a';
  // Where the chrome, at opacity 1 - night, has faded past use. Just ahead of the colophon's
  // 0.92, because below 1025px the nav pill sits over the footer's links.
  const LIGHTS_OUT = 0.9;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const remap01 = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a), 0, 1);

  const bg = () => window.gridBG;

  let night = 0;
  let target = 0;
  let isNight = false;
  let isLightsOut = false;
  let themeIsNight = false;
  let revealed = false;
  let colophonUp = false;
  let lastNow = 0;
  let rafId = 0;
  let near = false;   // the observer's verdict: close enough to be worth a frame
  let rectTop = Infinity; // the footer's top edge, viewport-relative
  let docTop = Infinity;  // and the same edge in document space

  // ---------------------------------------------------------------- the halo
  // The last surviving sparks gather loosely onto the credit, so the final light on the page
  // is the light collected on the words. An outline, not a panel, and a gentle grip: the
  // field should look drawn to them as it dies, not assembled into a plaque.
  //
  // index.html's inline engine predates setHalo, so this is feature-detected. Every other
  // page gets it; index gets the same blackout without this last flourish.
  const haloState = { weight: 0, placed: false, held: false };

  function driveHalo(dt, rect) {
    const api = bg();
    if (!api || typeof api.setHalo !== 'function' || reduceMotion) return;

    // Peaks while the room is going dark, then lets go as the field itself goes out,
    // because there is nothing left to gather by the end.
    const want = smoother(remap01(night, 0.25, 0.6)) * (1 - smoother(remap01(night, 0.72, 0.98)));
    const k = haloState.placed ? 1 - Math.exp(-dt / 0.16) : 1;
    haloState.weight += (want - haloState.weight) * k;
    haloState.placed = true;

    // Let go once, not every frame. Until the room is dark enough for the credit the halo
    // belongs to whatever the page is doing, and on a short page like support the footer is
    // in range, and this loop running, from the first frame.
    if (haloState.weight < 0.002) {
      if (haloState.held) {
        api.setHalo(null);
        haloState.held = false;
      }
      return;
    }
    haloState.held = true;
    const proj = api.projection();
    api.setHalo({
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      radius: Math.min(rect.width, rect.height) * 0.5,
      depth: proj.depth,      // the drift plane, not the sheet plane: these are loose, not built
      fill: 0,                // hover around the words, never fill them in
      grip: 0.25,
      weight: haloState.weight * (api.quality || 1),
    });
  }

  // ---------------------------------------------------------------- the loop
  // One rect a frame answers both questions: how far the night has come, and whether the
  // stage has pinned. docTop is kept fresh alongside it so a sleeping page can decide
  // whether to wake with arithmetic instead of another forced layout.
  function measure() {
    const rect = credits.getBoundingClientRect();
    const vh = Math.max(1, window.innerHeight);
    rectTop = rect.top;
    docTop = rectTop + window.scrollY;
    // 0 when the footer's first pixel touches the bottom of the screen, 1 once it fills it.
    target = clamp((vh - rectTop) / vh, 0, 1);
    return target;
  }

  // The cheap version, for the scroll handler: no rect, no layout.
  const inPlay = () => window.scrollY + window.innerHeight > docTop;

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;

    measure();
    // Critically damped, like every other follow on the site: the room dims smoothly even
    // when a trackpad delivers scroll in lumps. Reduced motion takes the value straight.
    night += (target - night) * (reduceMotion ? 1 : 1 - Math.exp(-dt / 0.12));
    if (Math.abs(target - night) < 0.0005) night = target;

    root.style.setProperty('--night', night.toFixed(4));

    const on = night > 0.02;
    if (on !== isNight) {
      isNight = on;
      root.classList.toggle('is-night', on);
    }

    // The chrome keeps taking taps until it has actually gone (see footer.css). is-night is
    // too early for that: it flips at 0.02, with the nav pill still 98% on screen.
    const out = night > LIGHTS_OUT;
    if (out !== isLightsOut) {
      isLightsOut = out;
      root.classList.toggle('is-lights-out', out);
    }

    const api = bg();
    if (api && typeof api.setNight === 'function') api.setNight(night);

    // The credit comes out of the dark, not into a lit room: it waits until the house is down.
    // Scrolling back up past 0.35 resets it, so it lands again on the way down.
    if (!revealed && night > 0.5) {
      revealed = true;
      if (line) line.classList.add('is-revealed');
    } else if (revealed && night < 0.35) {
      revealed = false;
      if (line) line.classList.remove('is-revealed');
    }

    // The colophon waits for the stage to pin, so it arrives after the credit, not with it.
    const up = rectTop <= 1 && night > 0.92;
    if (up !== colophonUp) {
      colophonUp = up;
      if (colophon) colophon.classList.toggle('is-revealed', up);
    }

    if (themeMeta) {
      const wantNight = night > 0.5;
      if (wantNight !== themeIsNight) {
        themeIsNight = wantNight;
        themeMeta.content = wantNight ? NIGHT_THEME : DAY_THEME;
      }
    }

    if (line) driveHalo(dt, line.getBoundingClientRect());

    // Sleep only once the observer agrees the footer is out of range. Sleeping on `target`
    // alone would strand the loop: scroll up a hair to target 0 while still in range, and
    // nothing would be left to wake it on the way back down.
    if (!near && night <= 0 && haloState.weight < 0.002) {
      rafId = 0;
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (rafId || document.hidden) return;
    lastNow = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // The observer decides when the footer is worth a frame, a viewport early, so the room
  // is already dimming by the time it appears. It is the one wake signal that does not
  // depend on a scroll event being delivered: a restored scroll position, an anchor jump
  // or a programmatic scrollTo can all move the page without one.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      near = entries[entries.length - 1].isIntersecting;
      if (near) start();
    }, { rootMargin: '120% 0px 0px 0px' }).observe(credits);
  } else {
    near = true; // no observer: the loop leans on the scroll handler and never self-sleeps
  }

  // Cheap belt and braces: arithmetic only, no layout, and it covers the no-observer case.
  const wake = () => { if (!rafId && inPlay()) start(); };
  const relayout = () => { if (!rafId) measure(); wake(); };
  window.addEventListener('scroll', wake, { passive: true });
  window.addEventListener('resize', relayout);
  if (document.fonts) document.fonts.ready.then(relayout);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else wake();
  });

  // Arriving already deep in the page (a reload, a restored position) must not play the
  // blackout as an animation. It is simply already night.
  if (measure() > 0) {
    night = target;
    start();
  }

  // ---------------------------------------------------------------- the gate
  // However hard the page is thrown, it should not land in the footer. The footer is the end
  // of the thing, not somewhere to arrive by accident, so it costs a second, deliberate
  // scroll to open.
  //
  // The gate is one line: while it is closed, any scroll past it is put straight back to it.
  // The stop sits where the footer's first pixel meets the bottom of the screen, which is
  // also where `night` is still 0, so nothing of the sequence above has begun and the footer
  // itself needs no changes at all. Come to rest against it and the gate is spent; the next
  // scroll opens the footer and behaves exactly as it always did.
  //
  // CSS scroll-snap was tried first and cannot do this. With one snap position, `mandatory`
  // drags the page to it from any distance (five viewports above, measured), so there is no
  // zone that catches a fling without also grabbing a reader; and `scroll-snap-stop: always`
  // is not applied to compositor-driven momentum, so flings and trackpad bursts pass straight
  // through whether it is armed early or late. Hence an explicit clamp, which is the one
  // thing on this page that moves the scroll, and only ever by the width of an overshoot.
  (function gate() {
    // A page whose footer starts within a screen of the top has no room for a gate: the
    // stop would land at zero and pin the page rather than the footer. The stubs are exactly
    // that, a hero and a footer. Anything with real content above it gets gated, however
    // little. Re-checked on resize, since the answer depends on the viewport.
    const worthGating = () => docTop > window.innerHeight * 1.2;

    const RESET = 0.5;   // viewports back above the stop at which it closes again
    const REST = 200;    // ms of stillness that counts as having come to rest against it
    const NEAR = 3;      // px within the stop that counts as being at it

    let spent = false;
    let bypass = false;   // an explicit jump to the end, honoured until the scroll settles
    let timer = 0;

    const stopY = () => Math.max(0, docTop - window.innerHeight);

    function onScroll() {
      if (!worthGating()) return;
      const stop = stopY();
      const y = window.scrollY;

      // Back up into the page: the gate closes again, so it is there next time down.
      if (spent && y < stop - RESET * window.innerHeight) spent = false;

      // Every event restarts the stillness timer, clamping ones included. That ordering is
      // the whole trick. A fling is not one push against the gate but a hundred, and while
      // it is being absorbed the page sits within a pixel or two of the stop. Let a clamp
      // skip this line and the timer runs to its end mid-struggle, the gate reads a position
      // near the stop as having come to rest, declares itself spent, and the rest of the
      // momentum sails through.
      clearTimeout(timer);

      // Any pixel past is a pixel of footer showing, so the clamp has no dead zone of
      // its own. NEAR is only ever used to decide whether the page has come to rest.
      if (!spent && !bypass && y > stop) {
        window.scrollTo(0, stop);
        // The top bar folds itself away by reading which way the page is going, and this is a
        // jump backwards that nobody asked for. Say so, or a fling absorbed here reads as a
        // hundred small scrolls up and flaps the nav pill open and shut the whole way through.
        // Fired synchronously, so the baseline is corrected before the browser's own scroll
        // event for the jump arrives and that event reads as no movement at all.
        window.dispatchEvent(new Event('grid:scroll-clamped'));
      }

      timer = setTimeout(() => {
        // Resting against the gate is what spends it, and resting means the scroll has
        // genuinely stopped, not merely passed close by.
        if (!spent && Math.abs(window.scrollY - stopY()) <= NEAR) spent = true;
        bypass = false;
      }, REST);
    }

    // An explicit jump to the end is an instruction, not an overshoot. Fighting it would put
    // the footer's own links out of reach of the keyboard. It has to be its own flag rather
    // than simply spending the gate: End starts from above the stop, and the first scroll
    // event it produces is still high enough to trip the re-close test and arm it again.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'End') { bypass = true; spent = true; }
    });

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // A restored position already inside the footer is where the reader left off, not an
    // overshoot, so the gate starts open there.
    if (measure() > 0) spent = true;
    onScroll();
  }());
})();
