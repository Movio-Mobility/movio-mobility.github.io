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
 * the field follows whichever sheet is up without either file knowing about the other.
 *
 * The CSS lives with .story in store.css. This file assumes that markup: a dialog with an
 * optional .story__close and .story__scroll inside it.
 */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  /** Long enough for the slide-out in store.css to finish before the dialog is closed. */
  const CLOSE_MS = 480;

  /** At most one modal dialog is ever on top, so one variable covers every sheet. */
  let openEl = null;

  const cue = (name) => {
    const api = window.gridBG;
    if (api && typeof api.transition === 'function') api.transition(name);
  };

  /**
   * @param {HTMLDialogElement} el
   * @param {{ onOpen?: function, onClose?: function }} [opts]
   * @returns {{ open: function, close: function, isOpen: function, el: HTMLDialogElement }}
   */
  function create(el, opts = {}) {
    const canOpen = el && typeof el.showModal === 'function';
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
      if (opts.onOpen) opts.onOpen();
    }

    function close() {
      if (!canOpen || !el.open || closeTimer) return;
      el.classList.remove('is-open', 'is-revealed', 'is-dragging');
      el.style.transform = '';
      document.documentElement.classList.remove('story-open');
      openEl = null;
      cue('sheet-release');
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
          startY = event.touches[0].clientY;
          startT = performance.now();
          dragY = 0;
          dragging = true;
          el.classList.add('is-dragging');
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
    /** The dialog currently up, or null. Read by the halo loops. */
    openElement: () => (openEl && openEl.open ? openEl : null),
  };
})();
