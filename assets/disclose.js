/*
 * Disclosures, and the particle field that follows them.
 *
 * Every .disclose on the page folds away under its heading until it is asked for: whole
 * sections, and the items nested inside them. Opening and closing is CSS (disclose.css). This
 * keeps the state, and tells the field.
 *
 * One field for the whole page, however many disclosures it has, so nothing here ever writes
 * over itself. The particles follow what the reader is doing, the way the store's follow a
 * press. A press on a heading firms them onto it. Opening draws them out around what opened as
 * it unfolds, held firmly while it moves and loosening to a rim once it rests. Whichever box is
 * being typed into gathers them round its curve. Closing a question hands the rim back out to
 * the section around it; closing a section follows the fold back up and lets go.
 *
 * The footer owns the field once its lights go down. This fades out on the night's own curve
 * and is gone by HANDOVER, where the footer starts gathering the field onto its credit, and
 * like the footer it lets go once rather than every frame, so neither writes over the other.
 *
 * window.gridDisclose.open(el) opens one from outside, for a page that knows why the reader
 * came (track.js does, for an order placed in this tab).
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const all = [...document.querySelectorAll('.disclose')];
  if (!all.length) return;

  const HANDOVER = 0.25;
  const EDGE = 12; // px the rim stays inside the screen
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const toggleOf = (d) => d.querySelector(':scope > .disclose__head .disclose__toggle');
  const panelOf = (d) => d.querySelector(':scope > .disclose__panel');
  const parentOf = (d) => d.parentElement && d.parentElement.closest('.disclose');
  const isOpen = (d) => d.classList.contains('is-open');

  let current = null; // the disclosure last opened or closed
  let pressed = null; // the toggle or [data-press] under a finger, pointer or key right now
  const settleTimers = new Map();

  // ---------------------------------------------------------------- the state
  // Open, and finished opening: only then does the panel stop clipping (see disclose.css).
  function settle(d) {
    window.clearTimeout(settleTimers.get(d));
    if (isOpen(d)) d.classList.add('is-settled');
  }

  function setOpen(d, want) {
    if (!d || !toggleOf(d) || !panelOf(d)) return;
    // Opening something nested opens what it sits in, or it would open out of sight.
    if (want) setOpen(parentOf(d), true);
    if (isOpen(d) === want) return;
    toggleOf(d).setAttribute('aria-expanded', String(want));
    d.classList.remove('is-settled');
    d.classList.toggle('is-open', want);
    // transitionend is the signal. The timer covers a browser that does not animate grid rows.
    window.clearTimeout(settleTimers.get(d));
    if (want) settleTimers.set(d, window.setTimeout(() => settle(d), 1200));
    current = d;
    wakeField();
  }

  // ---------------------------------------------------------------- the field
  const halo = { left: 0, top: 0, width: 1, height: 1, radius: 24, fill: 0, grip: 0, weight: 0 };
  let placed = false;
  let held = false;
  let fieldId = 0;
  let fieldLast = 0;

  const grow = (r, pad) => ({
    left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2,
  });

  // A section is rounded as far out as the screen allows; on a phone that is not far, so the
  // rim keeps EDGE clear of the sides rather than running down them. A nested item is hugged
  // closer, so the rim reads as that question rather than as the section it sits in.
  function rim(d) {
    const nested = Boolean(parentOf(d));
    const r = d.getBoundingClientRect();
    const reach = nested ? 8 : 20;
    const pad = Math.max(0, Math.min(reach, r.left - EDGE, window.innerWidth - r.right - EDGE));
    return { rect: grow(r, pad), radius: nested ? 20 : 28 };
  }

  function aim() {
    if (pressed) {
      const r = grow(pressed.getBoundingClientRect(), 10);
      return { rect: r, radius: r.height / 2, fill: 0.25, grip: 0.55, weight: 1 };
    }
    const active = document.activeElement;
    if (active && active.matches('.field__input') && active.closest('.disclose.is-open')) {
      const r = grow(active.getBoundingClientRect(), 4);
      return { rect: r, radius: r.height / 2, fill: 0, grip: 0.5, weight: 1 };
    }
    if (!current) return null;
    // A closed disclosure hands the rim to the nearest open one around it.
    let d = current;
    while (d && !isOpen(d)) d = parentOf(d);
    if (!d) return { ...rim(current), fill: 0, grip: 0, weight: 0 };
    const resting = d.classList.contains('is-settled');
    return { ...rim(d), fill: 0, grip: resting ? 0.1 : 0.4, weight: resting ? 0.6 : 1 };
  }

  function fieldFrame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - fieldLast) / 1000));
    fieldLast = now;
    const api = window.gridBG;
    if (!api || typeof api.setHalo !== 'function') {
      fieldId = 0;
      return;
    }

    // Nothing to aim at: stay where it is and fade.
    const t = aim() || {
      rect: halo, radius: halo.radius, fill: halo.fill, grip: halo.grip, weight: 0,
    };
    // Exponential easing, as on the store: the rim is seen to travel from a heading onto what
    // it opened and from box to box. The first placement snaps, so it never flies in from 0,0.
    const k = placed ? 1 - Math.exp(-dt / 0.1) : 1;
    const kSlow = 1 - Math.exp(-dt / 0.16);
    halo.left += (t.rect.left - halo.left) * k;
    halo.top += (t.rect.top - halo.top) * k;
    halo.width += (t.rect.width - halo.width) * k;
    halo.height += (t.rect.height - halo.height) * k;
    halo.radius += (t.radius - halo.radius) * k;
    halo.fill += (t.fill - halo.fill) * (placed ? kSlow : 1);
    halo.grip += (t.grip - halo.grip) * (placed ? kSlow : 1);
    placed = true;
    halo.weight += (t.weight - halo.weight) * kSlow;

    // Read from the inline style footer.js writes, so asking costs no layout.
    const night = parseFloat(root.style.getPropertyValue('--night')) || 0;
    const lit = Math.max(0, 1 - night / HANDOVER);
    const shown = halo.weight * lit;

    // Asleep once there is nothing to show and nothing coming. A sleep in the dark starts
    // again from nothing, so the rim eases back in with the lights rather than popping.
    if (shown < 0.002 && (t.weight === 0 || lit === 0)) {
      halo.weight = 0;
      placed = false;
      if (held) {
        api.setHalo(null);
        held = false;
      }
      fieldId = 0;
      return;
    }

    held = true;
    api.setHalo({
      rect: { left: halo.left, top: halo.top, width: halo.width, height: halo.height },
      radius: halo.radius,
      depth: api.projection().depth,
      fill: halo.fill,
      grip: halo.grip,
      weight: shown,
    });
    fieldId = window.requestAnimationFrame(fieldFrame);
  }

  function wakeField() {
    // setHalo already declines under reduced motion, so there is nothing to run for.
    if (reduceMotion || fieldId) return;
    fieldLast = performance.now();
    fieldId = window.requestAnimationFrame(fieldFrame);
  }

  // ---------------------------------------------------------------- wiring
  let relax = 0;
  // Held a beat past the release, so a quick tap still shows the field firming.
  const press = (toggle) => {
    window.clearTimeout(relax);
    pressed = toggle;
    wakeField();
  };
  const release = (delay) => {
    window.clearTimeout(relax);
    relax = window.setTimeout(() => { pressed = null; }, delay);
  };

  function pressable(el) {
    el.addEventListener('pointerdown', (event) => { if (!event.button) press(el); });
    el.addEventListener('pointerup', () => release(140));
    el.addEventListener('pointercancel', () => release(0));
    // Mouse only: a finger always leaves on lifting, which would cut the beat above short.
    el.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse') release(0); });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') press(el);
    });
    el.addEventListener('keyup', () => release(140));
  }

  for (const d of all) {
    const toggle = toggleOf(d);
    const panel = panelOf(d);
    if (!toggle || !panel) continue;

    toggle.addEventListener('click', () => setOpen(d, !isOpen(d)));
    panel.addEventListener('transitionend', (event) => {
      if (event.target === panel && event.propertyName === 'grid-template-rows') settle(d);
    });
    pressable(toggle);
  }

  // Anything inside marked data-press (the contact pills, a manual to download) firms the field
  // onto itself the same way, the moment it is pressed.
  for (const el of document.querySelectorAll('.disclose [data-press]')) pressable(el);

  // A box taking or losing focus moves the rim, so the field has to be running to see it.
  const onFocus = (event) => { if (event.target.closest('.disclose')) wakeField(); };
  document.addEventListener('focusin', onFocus);
  document.addEventListener('focusout', onFocus);

  // Back up out of the footer's dark: the rim comes back with the lights. Watched on the class
  // rather than on scroll, because the night eases out after the last scroll event.
  new MutationObserver(() => {
    if (!root.classList.contains('is-night') && document.querySelector('.disclose.is-open')) wakeField();
  }).observe(root, { attributes: true, attributeFilter: ['class'] });

  window.gridDisclose = { open: (el) => setOpen(el, true) };

  // A link to one of them (support.html#track from an order confirmation, #faq) opens it.
  const linked = window.location.hash && document.getElementById(window.location.hash.slice(1));
  if (linked && linked.matches('.disclose')) setOpen(linked, true);
})();
