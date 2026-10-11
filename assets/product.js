/*
 * Accessory product pages: the gallery in the stage, and nothing else.
 *
 * Shared by adapter.html, vehicle-dock.html and chargers.html. Nothing here names a
 * product; everything specific to one is in that page's markup. The quantity, the variant
 * cards and the foot used to live here too; they belong to the purchase and moved into
 * assets/accessory-flow.js with the rest of it.
 *
 * THE IMAGES ARE IN THE HTML, not built here, so the first is discoverable by the preload
 * scanner before this script runs and a page with no renders simply has no gallery: the
 * chargers page is exactly that, and buildNav and buildArrows both bail on it.
 */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const smooth = reduceMotion ? 'auto' : 'smooth';

  // ---------------------------------------------------------------- gallery
  const stage = document.querySelector('.pg2__stage');
  const frame = document.querySelector('.gallery__frame');
  const nav = document.querySelector('.gallery__nav');
  const images = frame ? [...frame.querySelectorAll('.gallery__img')] : [];

  let active = 0;
  let arrows = [];

  /*
   * The stage is inert, exactly as on the configurator: grid-bg.js treats wheel and
   * touchmove on window as a stand-in for page scroll whenever the document itself cannot
   * scroll, which on this shell is always. Stopping propagation here keeps a swipe through
   * the gallery from also dragging the particle field. It stops the event reaching window,
   * not the browser's own scrolling, so the gallery still slides.
   */
  if (stage) {
    const swallow = (event) => event.stopPropagation();
    stage.addEventListener('wheel', swallow, { passive: true });
    stage.addEventListener('touchmove', swallow, { passive: true });
  }

  function buildNav() {
    if (!nav || images.length < 2) return;
    images.forEach((img, i) => {
      const b = document.createElement('button');
      b.className = 'gallery__thumb';
      b.type = 'button';
      b.setAttribute('aria-current', i === 0 ? 'true' : 'false');
      b.setAttribute('aria-label', `Image ${i + 1} of ${images.length}`);
      b.addEventListener('click', () => show(i));
      nav.appendChild(b);
    });
  }

  /*
   * Chevrons at the stage's edges, for the mouse that a scroller and a row of lines both
   * underserve. Outside .gallery__frame, so they do not ride along with the slides. An
   * arrow at its end of the line fades out (is-edge, product.css) rather than greying:
   * the lines underneath already say where you are.
   */
  function buildArrows() {
    if (!stage || images.length < 2) return;
    const CHEVRONS = {
      prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>',
      next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg>',
    };
    arrows = [['prev', 'Previous image', -1], ['next', 'Next image', 1]].map(([dir, label, step]) => {
      const b = document.createElement('button');
      b.className = `gallery__arrow gallery__arrow--${dir}`;
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.innerHTML = CHEVRONS[dir]; // a constant above, never anything dynamic
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') === 'true') return;
        show(active + step);
      });
      stage.appendChild(b);
      return b;
    });
    syncArrows();
  }

  /** The arrows follow the active image: at either end, that side rests and fades. */
  function syncArrows() {
    if (!arrows.length) return;
    const atEdge = [active <= 0, active >= images.length - 1];
    arrows.forEach((b, i) => {
      b.setAttribute('aria-disabled', atEdge[i] ? 'true' : 'false');
      b.classList.toggle('is-edge', atEdge[i]);
    });
  }

  function setActive(i) {
    if (i === active || i < 0 || i >= images.length) return;
    active = i;
    syncArrows();
    if (!nav) return;
    [...nav.children].forEach((b, n) => b.setAttribute('aria-current', n === i ? 'true' : 'false'));
  }

  /** Scrolling is the only way the image changes, so swipe and click agree by construction. */
  function show(i) {
    if (!frame || i < 0 || i >= images.length) return;
    frame.scrollTo({ left: i * frame.clientWidth, behavior: smooth });
    setActive(i);
  }

  function watchScroll() {
    if (!frame || images.length < 2) return;
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(images.indexOf(entry.target));
        }
      }, { root: frame, threshold: 0.6 });
      for (const img of images) io.observe(img);
      return;
    }
    let ticking = false;
    frame.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        setActive(Math.round(frame.scrollLeft / Math.max(1, frame.clientWidth)));
      });
    }, { passive: true });
  }

  function keys() {
    if (!frame || images.length < 2) return;
    frame.tabIndex = 0;
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', 'Product images');
    frame.addEventListener('keydown', (event) => {
      const jump = { ArrowLeft: -1, ArrowRight: 1 };
      if (event.key in jump) {
        event.preventDefault();
        show(Math.min(images.length - 1, Math.max(0, active + jump[event.key])));
      } else if (event.key === 'Home') {
        event.preventDefault();
        show(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        show(images.length - 1);
      }
    });
  }

  /** A resize changes what one page of the scroller is, so keep the current image framed. */
  function keepFramed() {
    if (!frame || images.length < 2) return;
    let last = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth === last) return;
      last = window.innerWidth;
      frame.scrollTo({ left: active * frame.clientWidth, behavior: 'auto' });
    });
  }

  buildNav();
  buildArrows();
  watchScroll();
  keys();
  keepFramed();
})();
