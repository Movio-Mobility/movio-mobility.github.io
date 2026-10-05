/*
 * Accessory product pages: the gallery in the stage, the quantity, and the foot.
 *
 * Shared by adapter.html, vehicle-dock.html and chargers.html. Nothing here names a
 * product; everything specific to one is in that page's markup.
 *
 * The page is the PowerPod Gen2 shell, so the parts behave the way they do there: a choice
 * is an .opt card whose state lives on data-selected, and the foot carries the running
 * total and the one action. What this file adds is the gallery, which stands where the 3D
 * pod stands on that page.
 *
 * THE IMAGES ARE IN THE HTML, not built here, so the first is discoverable by the preload
 * scanner before this script runs and a page with no renders simply has no gallery.
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

  function setActive(i) {
    if (i === active || i < 0 || i >= images.length) return;
    active = i;
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
  watchScroll();
  keys();
  keepFramed();

  // ---------------------------------------------------------------- choice and quantity
  if (!window.gridCatalogue) return;
  const { MAX_QTY, money, grossUp, priceOf } = window.gridCatalogue;

  const cta = document.getElementById('product-buy');
  const totalAmount = document.getElementById('product-total');
  const totalLabel = document.getElementById('product-total-label');
  const count = document.getElementById('product-qty');
  const unitLine = document.querySelector('.qty-row__unit');
  if (!cta) return;

  /*
   * Most pages sell one thing and the SKU is fixed on the button. The chargers page sells
   * two that differ only by rating, so it carries .opt cards instead and the SKU follows
   * whichever is chosen. Selection state lives on data-selected, not on :checked, which is
   * how every choice on this shell works.
   */
  const variants = [...document.querySelectorAll('.opt__input[name="variant"]')];
  const skuNow = () => {
    const picked = variants.find((r) => r.checked);
    return picked ? picked.value : cta.dataset.orderSku;
  };

  let qty = 1;

  function render() {
    const sku = skuNow();
    cta.dataset.orderSku = sku;

    for (const radio of variants) {
      const label = radio.closest('.opt');
      if (label) label.dataset.selected = radio.checked ? 'true' : 'false';
    }

    if (count) count.value = String(qty);
    for (const b of document.querySelectorAll('.qty-row .stepper__btn')) {
      const step = Number(b.dataset.step || 0);
      const atBound = step < 0 ? qty <= 1 : qty >= MAX_QTY;
      b.setAttribute('aria-disabled', atBound ? 'true' : 'false');
    }

    const unit = priceOf(sku);
    if (unitLine) unitLine.textContent = `${money(unit)} each`;
    if (totalLabel) totalLabel.textContent = 'Total';
    if (totalAmount) totalAmount.textContent = money(grossUp(unit * qty));
  }

  const qtyRow = document.querySelector('.qty-row');
  if (qtyRow) {
    qtyRow.addEventListener('click', (event) => {
      const b = event.target.closest('.stepper__btn');
      if (!b || b.getAttribute('aria-disabled') === 'true') return;
      qty = Math.min(MAX_QTY, Math.max(1, qty + Number(b.dataset.step || 0)));
      render();
    });
  }

  for (const radio of variants) radio.addEventListener('change', render);

  render();
})();
