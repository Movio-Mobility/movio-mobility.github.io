/*
 * Bottom sheets.
 *
 * One dialog's worth of behaviour, for any page that has one. This used to live inside
 * store.js, which meant a product page wanting a sheet had to load the whole store page's
 * script to get it. Now store.js, order-sheet.js and product.js all take it from here.
 *
 * What a sheet does: opens modally, locks the page behind it, slides up, and dismisses four
 * ways (the close button, Esc, a tap on the backdrop, a swipe down on a phone). Closing
 * strips the classes first and calls the native close() only once the slide-out has run, so
 * the sheet never simply vanishes.
 *
 * It also tells the particle field which sheet is open, through openElement(). The halo
 * loops in store.js and product.js read that rather than tracking dialogs themselves, so
 * the field follows whichever sheet is up without either file knowing about the other, and
 * a page with a halo of its own (disclose.js on the support page) can stand it down while a
 * sheet is up. A page with no halo loop of its own can ask the sheet to drive the field
 * instead (the halo option below), so the field gathers behind the glass the same way.
 *
 * A sheet holding a form can refuse the swipe (canSwipe below): a half-filled application
 * must not vanish because a thumb scrolled the wrong way.
 *
 * The CSS is .story in sheet.css. This file assumes that markup: a dialog with an optional
 * .story__close and .story__scroll inside it.
 */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  /** Long enough for the slide-out in sheet.css to finish before the dialog is closed. */
  const CLOSE_MS = 480;

  /** At most one modal dialog is ever on top, so one variable covers every sheet. */
  let openEl = null;

  /*
   * The sheet whose opt-in halo has the field right now, or null. It keeps it a little past
   * closing, while the rim fades out over the slide down, so a page's own halo (disclose.js)
   * waits for holdsField() to go false, and for the gridx:sheet-field event that says so,
   * before it takes the field back. Two loops writing the halo in turn would flicker.
   */
  let fieldHolder = null;
  const letGo = (el) => {
    if (fieldHolder !== el) return;
    fieldHolder = null;
    document.dispatchEvent(new CustomEvent('gridx:sheet-field', { detail: { held: false } }));
  };

  const cue = (name) => {
    const api = window.gridBG;
    if (api && typeof api.transition === 'function') api.transition(name);
  };

  // ---------------------------------------------------------------- the field behind the glass
  /*
   * The opt-in halo: the particle field gathers onto the open sheet, brought forward to the
   * sheet's plane, half on its edge and half filling it behind the glass. The same target
   * store.js gives its sheets (its sheet branch), eased the same way, so a sheet looks the
   * same on every page whether the page drives the field or the sheet does.
   *
   * The loop runs only while something is moving: the slide in and out, a drag, a resize, the
   * keyboard reshaping the panel. Otherwise it lands exactly on the sheet and sleeps. Each
   * frame reads the sheet's rect first, before anything is written, and writes nothing to the
   * DOM (setHalo only sets the field's uniforms), so the read can never force a layout; and it
   * reads it only on frames where the sheet is known to be moving. On closing, the rim fades
   * out over the slide down and then the field is let go (setHalo(null)).
   */
  const SETTLE_MS = 800; // a little past the 0.55s open spring and the 0.48s close

  function haloLoop(el, overrides) {
    const spec = { left: 0, top: 0, width: 1, height: 1, radius: 28, depth: 3.2, fill: 0, grip: 0, weight: 0 };
    let placed = false;
    let held = false;
    let active = false; // the sheet is open (or opening)
    let radius = null; // read once per open, not per frame
    let rafId = 0;
    let last = 0;
    let busyUntil = 0;
    let dragging = false;

    const settledOn = (t) => Math.abs(t.rect.left - spec.left) < 0.01 && Math.abs(t.rect.top - spec.top) < 0.01
      && Math.abs(t.rect.width - spec.width) < 0.01 && Math.abs(t.rect.height - spec.height) < 0.01
      && Math.abs(t.radius - spec.radius) < 0.01 && Math.abs(t.depth - spec.depth) < 1e-4
      && Math.abs(t.fill - spec.fill) < 1e-4 && Math.abs(t.grip - spec.grip) < 1e-4
      && Math.abs(t.weight - spec.weight) < 1e-4;

    function frame(now) {
      rafId = 0;
      const api = window.gridBG;
      if (!api || typeof api.setHalo !== 'function') return;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;

      // Read first. A closed dialog has no box, so a sheet that has finished sliding out
      // fades where it last was.
      const rect = el.open ? el.getBoundingClientRect() : spec;
      const proj = typeof api.projection === 'function' ? api.projection() : { depth: 6, sheetDepth: 3.2 };
      const t = {
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        radius: radius === null ? 28 : radius,
        depth: overrides.depth || proj.sheetDepth || 3.2,
        fill: overrides.fill ?? 0.5, // half hold the edge of the panel, half fill it behind the glass
        grip: overrides.grip ?? 1,
        weight: active ? 1 : 0,
      };

      // Exponential easing, as on the store, so the rim visibly travels with the sheet.
      const k = placed ? 1 - Math.exp(-dt / 0.1) : 1;
      const kSlow = placed ? 1 - Math.exp(-dt / 0.16) : 1;
      // The first placement lands on the sheet with no weight, so the gather fades in rather
      // than flying in from wherever the last one was.
      if (!placed) spec.weight = 0;
      placed = true;
      spec.left += (t.rect.left - spec.left) * k;
      spec.top += (t.rect.top - spec.top) * k;
      spec.width += (t.rect.width - spec.width) * k;
      spec.height += (t.rect.height - spec.height) * k;
      spec.radius += (t.radius - spec.radius) * k;
      spec.depth += (t.depth - spec.depth) * kSlow;
      spec.fill += (t.fill - spec.fill) * kSlow;
      spec.grip += (t.grip - spec.grip) * kSlow;
      spec.weight += (t.weight - spec.weight) * kSlow;

      const moving = dragging || now < busyUntil;
      const settled = !moving && settledOn(t);
      if (settled) {
        Object.assign(spec, { left: t.rect.left, top: t.rect.top, width: t.rect.width, height: t.rect.height,
          radius: t.radius, depth: t.depth, fill: t.fill, grip: t.grip, weight: t.weight });
      }

      if (!active && spec.weight < 0.002) {
        // Closed and faded: hand the field back.
        if (held) api.setHalo(null);
        held = false;
        placed = false;
        letGo(el);
        return;
      }
      held = true;
      fieldHolder = el;
      api.setHalo({
        rect: { left: spec.left, top: spec.top, width: spec.width, height: spec.height },
        radius: spec.radius,
        depth: spec.depth,
        fill: spec.fill,
        grip: spec.grip,
        weight: spec.weight,
      });
      if (!settled) rafId = requestAnimationFrame(frame);
    }

    function wake(busyMs = 0) {
      if (reduceMotion) return; // setHalo declines under reduced motion anyway
      if (!active && !held) return;
      if (busyMs) busyUntil = Math.max(busyUntil, performance.now() + busyMs);
      if (rafId || document.hidden) return;
      last = performance.now();
      rafId = requestAnimationFrame(frame);
    }

    // What can move an open sheet without this file moving it.
    const nudge = () => wake(SETTLE_MS / 4);
    window.addEventListener('resize', nudge);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', nudge);
      window.visualViewport.addEventListener('scroll', nudge);
    }
    if ('ResizeObserver' in window) new ResizeObserver(nudge).observe(el);
    el.addEventListener('transitionend', nudge);
    document.addEventListener('visibilitychange', () => wake());

    return {
      opened() {
        active = true;
        const n = parseFloat(getComputedStyle(el).borderTopLeftRadius);
        radius = Number.isFinite(n) ? n : 28;
        wake(SETTLE_MS);
      },
      closed() {
        active = false;
        dragging = false;
        wake(SETTLE_MS);
      },
      drag(on) {
        dragging = on;
        wake(on ? 0 : SETTLE_MS / 2);
      },
    };
  }

  /**
   * @param {HTMLDialogElement} el
   * @param {{
   *   onOpen?: function,
   *   onClose?: function,
   *   canSwipe?: function(TouchEvent): boolean,  return false to keep a swipe from dismissing
   *   halo?: boolean | { fill?: number, grip?: number, depth?: number },  drive the field
   * }} [opts]
   * @returns {{ open: function, close: function, isOpen: function, el: HTMLDialogElement }}
   */
  function create(el, opts = {}) {
    const canOpen = el && typeof el.showModal === 'function';
    // Only a page that has no halo loop of its own asks for this; store.js and product.js
    // drive the field themselves and leave it off.
    const halo = canOpen && opts.halo && !reduceMotion
      ? haloLoop(el, typeof opts.halo === 'object' ? opts.halo : {})
      : null;
    let closeTimer = 0;
    let scrollLock = '';
    // Where focus goes when this closes. Set per open, because a sheet can be opened from
    // any of several controls and has to hand focus back to the one that was used.
    let returnTo = null;

    function open(focusReturn) {
      if (!canOpen || el.open) return;
      returnTo = focusReturn || null;
      el.showModal();
      scrollLock = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.documentElement.classList.add('story-open'); // the page recedes, the field does not
      // One frame in the closed pose, so the slide-up has somewhere to come from.
      requestAnimationFrame(() => {
        el.classList.add('is-open');
        requestAnimationFrame(() => el.classList.add('is-revealed'));
      });
      openEl = el;
      cue('sheet'); // lens racks forward, bokeh collapses to points, the field thickens
      if (halo) halo.opened();
      if (opts.onOpen) opts.onOpen();
    }

    function close() {
      if (!canOpen || !el.open || closeTimer) return;
      el.classList.remove('is-open', 'is-revealed', 'is-dragging');
      el.style.transform = '';
      document.documentElement.classList.remove('story-open');
      openEl = null;
      cue('sheet-release');
      if (halo) halo.closed();
      closeTimer = window.setTimeout(() => {
        closeTimer = 0;
        el.close();
      }, reduceMotion ? 200 : CLOSE_MS);
    }

    if (canOpen) {
      el.addEventListener('close', () => {
        document.documentElement.style.overflow = scrollLock;
        document.documentElement.classList.remove('story-open');
        if (openEl === el) openEl = null;
        // Closed by something other than close() above (a form's method="dialog", a script
        // calling el.close()): the field still lets go.
        if (halo) halo.closed();
        if (returnTo) returnTo.focus({ preventScroll: true });
        if (opts.onClose) opts.onClose();
      });

      // Esc: run our own close so the sheet slides out instead of vanishing.
      el.addEventListener('cancel', (event) => {
        event.preventDefault();
        close();
      });

      const closeButton = el.querySelector('.story__close');
      if (closeButton) closeButton.addEventListener('click', close);

      // A click that lands on the dialog element itself, outside its box, is the backdrop.
      el.addEventListener('click', (event) => {
        if (event.target !== el) return;
        const r = el.getBoundingClientRect();
        const inside = event.clientX >= r.left && event.clientX <= r.right
          && event.clientY >= r.top && event.clientY <= r.bottom;
        if (!inside) close();
      });

      // Swipe to dismiss, phones only.
      if (coarse) {
        const content = el.querySelector('.story__scroll');
        let startY = 0;
        let startT = 0;
        let dragY = 0;
        let dragging = false;

        el.addEventListener('touchstart', (event) => {
          if (!el.open || closeTimer || event.touches.length !== 1) return;
          if (content && content.scrollTop > 0) return; // let the copy scroll first
          // The page's say: a sheet holding unsaved work is closed on purpose (the close
          // button, Esc), never by a stray swipe.
          if (opts.canSwipe && opts.canSwipe(event) === false) return;
          startY = event.touches[0].clientY;
          startT = performance.now();
          dragY = 0;
          dragging = true;
          el.classList.add('is-dragging');
          if (halo) halo.drag(true);
        }, { passive: true });

        el.addEventListener('touchmove', (event) => {
          if (!dragging) return;
          dragY = Math.max(0, event.touches[0].clientY - startY);
          el.style.transform = `translate3d(0, ${dragY}px, 0)`;
        }, { passive: true });

        const end = () => {
          if (!dragging) return;
          dragging = false;
          el.classList.remove('is-dragging');
          if (halo) halo.drag(false);
          el.style.transform = '';
          const flick = dragY / Math.max(1, performance.now() - startT) > 0.5; // px/ms
          if (flick || dragY > el.getBoundingClientRect().height * 0.25) close();
        };

        el.addEventListener('touchend', end, { passive: true });
        el.addEventListener('touchcancel', end, { passive: true });
      }
    }

    return { open, close, isOpen: () => Boolean(el && el.open), el };
  }

  window.gridSheet = {
    create,
    /**
     * The dialog currently up, or null. Read by the halo loops (store.js, product.js), and by
     * anything else that drives the field and has to stand down while a sheet is up.
     */
    openElement: () => (openEl && openEl.open ? openEl : null),
    /** Whether a sheet's own halo (the halo option) is still holding the field. */
    holdsField: () => fieldHolder !== null,
  };
})();
