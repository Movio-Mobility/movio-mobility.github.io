/*
 * The footer: the end of the film.
 *
 * One value does all of it. `night` is how far the footer has risen into the viewport,
 * 0 at its first pixel and 1 once it fills the screen. It is published three ways, so the
 * shader, the DOM and the phone's status bar all dim on the same curve:
 *
 *   1. gridBG.setNight(night): the house lights come down over the cyclorama while the
 *      particle buffer stays at full strength, and the field goes out a spark at a time.
 *   2. --night on the chrome:    the page's chrome recedes with the room (see footer.css).
 *      It is written on the handful of elements that dim, not on <html>: a value there is
 *      inherited by every element on the page, and the whole page was restyled every frame
 *      of the blackout for the sake of five opacities. window.gridNight carries the same
 *      number to scripts (the home page's pod, support's disclosure halo).
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

  // Everything that recedes with the room (see footer.css). The credits carry the value for
  // the no-WebGL scrim, which is their own ::before.
  const dimmed = [...document.querySelectorAll('.topbar, .hero, .store, .film, .journey, .careers, .role, .interview, .lost, .dealers')];
  const published = (window.gridNight = window.gridNight || { value: 0 });
  let written = '';
  function publish() {
    const v = night.toFixed(4);
    published.value = night;
    if (v === written) return;
    written = v;
    for (const el of dimmed) el.style.setProperty('--night', v);
    credits.style.setProperty('--night-scrim', v);
  }

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

  // Whether there is a halo to drive at all: index.html's engine has none.
  const haloWanted = () => {
    const api = bg();
    return !!(line && api && typeof api.setHalo === 'function' && !reduceMotion);
  };

  // Returns whether the halo is still moving.
  function driveHalo(dt, rect) {
    const api = bg();
    if (!api || typeof api.setHalo !== 'function' || reduceMotion) return false;

    // Peaks while the room is going dark, then lets go as the field itself goes out,
    // because there is nothing left to gather by the end.
    const want = smoother(remap01(night, 0.25, 0.6)) * (1 - smoother(remap01(night, 0.72, 0.98)));
    const k = haloState.placed ? 1 - Math.exp(-dt / 0.16) : 1;
    haloState.weight += (want - haloState.weight) * k;
    haloState.placed = true;

    // Let go once, not every frame. Until the room is dark enough for the credit the halo
    // belongs to whatever the page is doing, and on a short page like support the footer is
    // in range, and this loop running, from the first frame.
    const moving = Math.abs(want - haloState.weight) > 0.001;
    if (haloState.weight < 0.002) {
      if (haloState.held) {
        api.setHalo(null);
        haloState.held = false;
      }
      return moving;
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
    return moving;
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

    // Both rects are read before anything is written, so the frame costs at most one layout.
    measure();
    const lineRect = haloWanted() ? line.getBoundingClientRect() : null;
    // Critically damped, like every other follow on the site: the room dims smoothly even
    // when a trackpad delivers scroll in lumps. Reduced motion takes the value straight.
    night += (target - night) * (reduceMotion ? 1 : 1 - Math.exp(-dt / 0.12));
    if (Math.abs(target - night) < 0.0005) night = target;

    publish();

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

    const haloMoving = lineRect ? driveHalo(dt, lineRect) : false;

    // Sleep once the observer agrees the footer is out of range. Sleeping on `target` alone
    // would strand the loop: scroll up a hair to target 0 while still in range, and nothing
    // would be left to wake it on the way back down.
    if (!near && night <= 0 && haloState.weight < 0.002) {
      rafId = 0;
      return;
    }
    // In range but settled: nothing moves until the page does. On a page as short as support
    // or careers the footer is in range from the first frame, and this loop used to run, and
    // restyle the page, on every one of them. Scrolling, a resize or a change in the page's
    // height (a disclosure opening above the footer) wakes it again.
    if (night === target && !haloMoving) {
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
      // Leaving range with the room still dark has to bring the lights back up too.
      if (near || night > 0) start();
    }, { rootMargin: '120% 0px 0px 0px' }).observe(credits);
  } else {
    near = true; // no observer: the loop leans on the scroll handler and never self-sleeps
  }

  // Cheap belt and braces: arithmetic only, no layout, and it covers the no-observer case. A
  // room that is still dark wakes it wherever the page is: the loop rests once the night has
  // settled, and a jump back to the top (Home, a fling, a link) must still bring the lights up.
  const wake = () => { if (!rafId && (inPlay() || night > 0 || haloState.weight > 0.002)) start(); };
  const relayout = () => { if (!rafId) measure(); wake(); };
  window.addEventListener('scroll', wake, { passive: true });
  window.addEventListener('resize', relayout);
  if ('ResizeObserver' in window) new ResizeObserver(() => relayout()).observe(document.body);
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
  publish();

  // ---------------------------------------------------------------- the gate
  // However hard the page is thrown, it should not land in the footer. The footer is the end
  // of the thing, not somewhere to arrive by accident, so it costs a second, deliberate
  // scroll to open.
  //
  // While the gate is closed the footer takes no room (footer.css, .credits.is-gated), so as
  // far as the browser knows the page ends where the footer's first pixel meets the bottom of
  // the screen. That is also where `night` is still 0, so nothing of the sequence above has
  // begun. A fling of any speed stops there on the browser's own scroller, with its own end of
  // page physics, and nothing here runs in the scroll path. Come to rest against it and the
  // gate opens: the footer gets its room back below the fold, where nothing shows, and the
  // next scroll goes in exactly as it always did.
  //
  // It used to clamp instead, putting every scroll past the stop back with scrollTo. Scrolling
  // runs ahead of the main thread, so each momentum frame was painted past the stop before it
  // was pulled back, a hundred times a fling, and the field and the nav pill read every one.
  //
  // CSS scroll-snap was tried before either and cannot do this. With one snap position,
  // `mandatory` drags the page to it from any distance (five viewports above, measured), so
  // there is no zone that catches a fling without also grabbing a reader; and
  // `scroll-snap-stop: always` is not applied to compositor-driven momentum, so flings and
  // trackpad bursts pass straight through whether it is armed early or late.
  (function gate() {
    // A page whose footer starts within a screen of the top has no room for a gate: the
    // stop would land at zero and pin the page rather than the footer. The stubs are exactly
    // that, a hero and a footer. Anything with real content above it gets gated, however
    // little. Re-checked on resize, since the answer depends on the viewport.
    const worthGating = () => docTop > window.innerHeight * 1.2;

    const RESET = 0.5;   // viewports back above the stop at which it closes again
    const REST = 200;    // ms of stillness that counts as having come to rest against it
    const NEAR = 3;      // px within the stop that counts as being at it

    let gated = false;
    let bypass = false;   // an explicit jump to the end, honoured until the scroll settles
    let touching = false; // a finger on the glass is a gesture still going on
    let timer = 0;

    const stopY = () => Math.max(0, docTop - window.innerHeight);

    function setGated(on) {
      if (on === gated) return;
      gated = on;
      credits.classList.toggle('is-gated', on);
    }

    function settle() {
      timer = 0;
      bypass = false;
      // Resting means the input has genuinely stopped at the stop, not merely passed close by.
      if (gated && !touching && window.scrollY >= stopY() - NEAR) setGated(false);
    }

    // Every sign of input restarts the stillness timer, and only at the stop does it run at
    // all. Wheel events count as well as scrolls: a trackpad's momentum keeps arriving as wheel
    // events after the page has stopped against the end, and opening under it would let the
    // rest of the fling sail into the footer.
    function restart() {
      clearTimeout(timer);
      timer = 0;
      if (touching) return;
      if (bypass || (gated && window.scrollY >= stopY() - NEAR)) timer = setTimeout(settle, REST);
    }

    function onScroll() {
      if (!worthGating()) {
        setGated(false);
        return;
      }
      // Back up into the page: the gate closes again, so it is there next time down. All of
      // the room it takes away is below the fold, so nothing on screen moves.
      if (!gated && !bypass && window.scrollY < stopY() - RESET * window.innerHeight) setGated(true);
      restart();
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // The page can also grow above the footer without anyone scrolling: journey opens its year
    // after the tape has run, and a page that was too short to gate at load becomes worth it.
    // Layout is clean inside an observer callback, so the fresh rect costs nothing extra. The
    // gate's own toggles land here too, and find nothing left to change.
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => { measure(); onScroll(); }).observe(document.body);
    }
    window.addEventListener('wheel', restart, { passive: true });
    window.addEventListener('touchstart', () => {
      touching = true;
      clearTimeout(timer);
      timer = 0;
    }, { passive: true });
    const lift = () => { touching = false; restart(); };
    window.addEventListener('touchend', lift, { passive: true });
    window.addEventListener('touchcancel', lift, { passive: true });

    // An explicit jump to the end is an instruction, not an overshoot. Fighting it would put
    // the footer's own links out of reach of the keyboard. The bypass keeps the gate open for
    // the jump itself: End starts from above the stop, and the first scroll events it produces
    // are still high enough to close it again. The read forces the new height into layout
    // before the browser works out where the end of the page is.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'End' || (e.key === 'ArrowDown' && e.metaKey)) {
        bypass = true;
        setGated(false);
        void credits.offsetHeight;
        restart();
      }
    });
    // Tabbing into the footer's links is the same instruction. Focus events fire before the
    // browser scrolls the focused link into view, so it has a page to scroll to.
    credits.addEventListener('focusin', () => setGated(false));

    // A restored position already inside the footer is where the reader left off, not an
    // overshoot, so the gate starts open there.
    if (worthGating() && target <= 0) setGated(true);
  }());
})();
