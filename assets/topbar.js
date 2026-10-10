/*
 * Top bar: the logo and the island fade in gently after the headline. Scrolling down folds
 * both away at once, and a few idle seconds does the same: the logo to its X, the island to
 * a circle holding the current page's icon. A single class on <html> drives both, with the
 * same duration and spring, so they always move in sync. Scrolling back up, hovering,
 * focusing or tapping the circle brings them back.
 *
 * Hold the current page's grey chip, then slide across the island and release
 * to open that page. The highlight stays inside the bar.
 *
 * Four tabs are the site; a fifth, set off by a hairline, belongs to the page. Journey, Careers
 * and Legal are reached from the footer, so the island grows a tab for whichever one is open.
 * It arrives a beat after the page: the pill settles at its usual four, then makes room on the
 * same spring, and the page's own tab, its chip already on it, comes out from under the edge.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const headline = document.querySelector('.headline');
  const topbar = document.querySelector('.topbar');
  const brand = topbar.querySelector('.brand');
  const lockup = topbar.querySelector('.brand-lockup') || brand;
  const wrap = topbar.querySelector('.island-wrap');
  const island = wrap.querySelector('.island');
  const list = island.querySelector('.island__list');
  const thumb = island.querySelector('.island__thumb');
  const links = [...list.querySelectorAll('.island__link')];
  // Any aria-current, not only "page": a page that lives under a section (a role page under
  // Careers) marks that section's tab aria-current="true", and it is still the chip to hold.
  const current = list.querySelector('.island__link[aria-current]') || links[0];
  const context = list.querySelector('.island__context');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const skipIntro = root.classList.contains('skip-intro');
  // Opt in, for pages that want the island out of the way until it is asked for. It starts
  // collapsed and only a click opens it. Scrolling is ignored, because on a page whose
  // content scrolls inside a panel a wheel tick does not mean "I want the nav", and hover
  // no longer opens it either, though hovering one that is already open still holds it
  // there. Keyboard focus is the one exception that still opens it: without that, tabbing
  // would land inside a menu nobody can see.
  const clickOnly = root.classList.contains('island-click-only');

  const SHOW_DELAY_MS = skipIntro ? 0 : (reduceMotion ? 200 : 450); // after the headline starts revealing
  const IDLE_MS = 4500;
  const HOLD_MS = reduceMotion ? 80 : 180;
  const CONTEXT_DELAY_MS = 420; // after the island appears, before it makes room for the fifth tab
  const SLOP2 = 12 * 12;
  const DIR_SLOP = 6;  // px of scroll before it counts as a direction, so jitter is not a gesture
  const TOP_REST = 8;  // and the band at the top of the page where down means nothing

  let shown = false;
  let held = false; // mouse or keyboard focus is on the top bar
  let idleTimer = 0;
  let scrubbing = false;
  let holdTimer = 0;
  let aim = current;
  let startX = 0;
  let startY = 0;
  let swallowClick = false;
  let lastY = window.scrollY;

  // Until the fifth tab has arrived, the pill is measured to the end of the four and the tab
  // waits hidden past its edge, so rounding can never let its hairline show and Tab cannot
  // land on it. Without motion there is nothing to stage, and the pill starts at full width.
  let contextPending = Boolean(context) && !reduceMotion;
  if (contextPending) island.classList.add('is-context-pending');

  // The island animates between two numeric widths, so measure the full nav. On phones the
  // expanded pill also centres itself off this width, so set it before the first paint:
  // show() can be seconds away, and until then the pill would sit at the wrong offset.
  const measure = () => {
    let w = list.offsetWidth;
    if (contextPending) {
      const last = context.previousElementSibling;
      w = last.offsetLeft + last.offsetWidth + parseFloat(getComputedStyle(list).paddingRight);
    }
    wrap.style.setProperty('--island-w', `${Math.ceil(w)}px`);
  };
  // The first measure is a jump, not a move. Styles computed before this script ran saw no
  // width at all, and on phones the pill would spring in sideways from there to the centre.
  island.style.transition = 'none';
  measure();
  void island.offsetWidth;
  island.style.transition = '';

  // A new width is all it takes: the island's width transition (and on phones, the centring
  // transform that rides on the same variable) carries the rest. The right edge holds, so the
  // four slide over as one and the page's tab is uncovered rather than faded in.
  function revealContext() {
    if (!contextPending) return;
    contextPending = false;
    island.classList.remove('is-context-pending');
    measure();
  }

  function placeThumb(link) {
    if (!thumb || !link) return;
    const ir = island.getBoundingClientRect();
    const r = link.getBoundingClientRect();
    const y = r.top - ir.top;
    let left = r.left - ir.left;
    let right = left + r.width;
    // Concentric with the pill. At either end the chip reaches out to the same gap it keeps
    // above and below, so its curve runs alongside the pill's instead of floating inside it.
    // The list's wider end padding on phones is room for the labels, not for the chip.
    if (link === links[0]) left = Math.min(left, y);
    if (link === links[links.length - 1]) right = Math.max(right, list.offsetWidth - y);
    thumb.style.width = `${Math.round(right - left)}px`;
    thumb.style.height = `${Math.round(r.height)}px`;
    thumb.style.transform = `translate3d(${left}px, ${y}px, 0)`;
  }

  function syncThumb() {
    // The fifth tab's chip waits past the edge with it, so its first placement is a jump too:
    // gliding in from the left, it would cross the four tabs and vanish under the edge.
    const snap = contextPending && thumb && !island.classList.contains('thumb-ready');
    if (snap) thumb.style.transition = 'none';
    placeThumb(scrubbing ? aim : current);
    if (thumb) island.classList.add('thumb-ready');
    if (snap) {
      void thumb.offsetWidth;
      thumb.style.transition = '';
    }
  }

  const setCompact = (compact) => {
    root.classList.toggle('is-compact', compact);
    if (!compact) requestAnimationFrame(syncThumb);
  };

  function scheduleCollapse() {
    clearTimeout(idleTimer);
    if (!held && !scrubbing) idleTimer = setTimeout(() => setCompact(true), IDLE_MS);
  }

  function wake() {
    if (!shown) return;
    setCompact(false);
    scheduleCollapse();
  }

  // The other half of wake: fold the island away now rather than after the idle wait. Hover,
  // keyboard focus and a scrub in progress all outrank it, because those are someone using
  // the thing, and nothing should shut under a pointer that is resting on it.
  function sleep() {
    if (!shown || held || scrubbing) return;
    clearTimeout(idleTimer);
    setCompact(true);
  }

  // Direction, not activity. Heading down the page is heading into the content, so the chrome
  // gets out of the way the moment it starts; heading back up is the gesture that means "let
  // me out of here", so that is what returns it, along with a tap on the circle.
  //
  // Read off scrollY rather than off wheel and touch deltas, because position is the one
  // signal every input agrees on: a trackpad fling, a finger, a scrollbar drag, Page Down and
  // a screen reader all move it the same way, and momentum reports itself honestly. It also
  // means the keyboard needs no cases of its own.
  function onScroll() {
    if (!shown) return;
    const y = window.scrollY;
    const dy = y - lastY;
    // Under the slop the travel is kept, not discarded, so a slow crawl still resolves into a
    // direction once it has gone far enough to be one.
    if (Math.abs(dy) < DIR_SLOP) return;
    lastY = y;
    // Nothing to hide from at the very top, and iOS rubber-banding there returns to zero as
    // downward travel when the finger was going the other way.
    if (dy > 0 && y > TOP_REST) sleep();
    else wake();
  }

  function show() {
    if (shown) return;
    shown = true;
    measure();
    // The island arrives a second or so in, by which time the page may already have moved.
    // Direction is measured from where it actually appears, not from where the script loaded.
    lastY = window.scrollY;
    root.classList.add('chrome-in');
    requestAnimationFrame(syncThumb);
    // Timed from the first frame, not from now: on a page still busy loading, the four have
    // to be seen settled before the island makes room for the fifth.
    if (contextPending) requestAnimationFrame(() => setTimeout(revealContext, CONTEXT_DELAY_MS));
    // Pages using clickOnly set is-compact themselves so the first paint is already
    // collapsed and nothing animates shut on arrival; this is only the safety net.
    if (clickOnly) setCompact(true);
    else scheduleCollapse();
  }

  function nearestLink(clientX) {
    let best = links[0];
    let bestDist = Infinity;
    for (const link of links) {
      const r = link.getBoundingClientRect();
      const d = Math.abs(clientX - (r.left + r.width / 2));
      if (d < bestDist) {
        bestDist = d;
        best = link;
      }
    }
    return best;
  }

  function setAim(link) {
    if (!link || aim === link) return;
    aim = link;
    for (const item of links) item.classList.toggle('is-aimed', item === link);
    placeThumb(link);
    // Chrome refuses a vibration before the page has had a tap, and says so in the console.
    if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(10);
  }

  function startScrub(link, pointerId) {
    if (scrubbing) return;
    scrubbing = true;
    held = true;
    clearTimeout(idleTimer);
    island.classList.add('is-scrubbing');
    try { link.setPointerCapture(pointerId); } catch (_) { /* ignore */ }
    placeThumb(aim);
  }

  function endScrub(navigate) {
    clearTimeout(holdTimer);
    holdTimer = 0;
    if (!scrubbing) return;
    const target = aim;
    island.classList.remove('is-scrubbing');
    for (const item of links) item.classList.remove('is-aimed');
    swallowClick = true;
    scrubbing = false;
    held = false;
    if (navigate && target && target.getAttribute('aria-current') !== 'page') {
      location.assign(target.href);
      return;
    }
    aim = current;
    placeThumb(current);
    scheduleCollapse();
  }

  if (!clickOnly) {
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  for (const el of [lockup, island]) {
    el.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse') return;
      held = true;
      // Under clickOnly, hover holds an open island open but never opens a closed one.
      if (!clickOnly) wake();
    });
    el.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'mouse') return;
      if (scrubbing) return;
      held = false;
      scheduleCollapse();
    });
  }

  topbar.addEventListener('focusin', (event) => {
    if (!event.target.matches(':focus-visible')) return; // keyboard focus only, not mouse clicks
    held = true;
    revealContext(); // so the next Tab can reach the page's own tab
    wake();
  });
  topbar.addEventListener('focusout', (event) => {
    if (topbar.contains(event.relatedTarget)) return;
    held = false;
    scheduleCollapse();
  });

  // Tapping the collapsed circle opens the island instead of navigating.
  island.addEventListener('click', (event) => {
    if (swallowClick) {
      event.preventDefault();
      swallowClick = false;
      return;
    }
    if (!root.classList.contains('is-compact')) return;
    event.preventDefault();
    wake();
  });

  island.addEventListener('pointerdown', (event) => {
    // A long press on a touch screen often ends without a click at all, which would leave the
    // last scrub's flag up to eat the next real tap. Every new press starts clean.
    swallowClick = false;
    if (root.classList.contains('is-compact')) return;
    if (event.button) return;
    const link = event.target.closest('.island__link');
    if (!link || !link.hasAttribute('aria-current')) return;
    event.preventDefault();
    startX = event.clientX;
    startY = event.clientY;
    aim = link;
    const pointerId = event.pointerId;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => startScrub(link, pointerId), HOLD_MS);
  });

  island.addEventListener('pointermove', (event) => {
    if (scrubbing) {
      setAim(nearestLink(event.clientX));
      return;
    }
    if (!holdTimer) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (dx * dx + dy * dy > SLOP2) {
      clearTimeout(holdTimer);
      holdTimer = 0;
    }
  });

  island.addEventListener('pointerup', () => endScrub(true));
  island.addEventListener('pointercancel', () => endScrub(false));

  // On a phone a long press is the scrub, never the browser's link menu (open in a new tab,
  // download the link, preview it), and a press never lifts a tab out as a dragged link.
  island.addEventListener('contextmenu', (event) => event.preventDefault());
  island.addEventListener('dragstart', (event) => event.preventDefault());

  const onLayout = () => {
    measure();
    syncThumb();
  };
  window.addEventListener('resize', onLayout);
  if (document.fonts) document.fonts.ready.then(onLayout);

  const queueShow = () => setTimeout(show, SHOW_DELAY_MS);
  if (skipIntro) {
    show();
  } else if (headline.classList.contains('is-revealed')) {
    queueShow();
  } else {
    const observer = new MutationObserver(() => {
      if (!headline.classList.contains('is-revealed')) return;
      observer.disconnect();
      queueShow();
    });
    observer.observe(headline, { attributes: true, attributeFilter: ['class'] });
  }
})();
