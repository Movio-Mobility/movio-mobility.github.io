/*
 * Store interactions.
 *
 * 1. The particle field is handed one rounded rect to gather on, eased every frame:
 *    the Gen2 card's rim at rest, whichever pod card is being pressed, and whichever
 *    sheet is open — brought forward to the sheet plane, filled, and held firmly, so the
 *    field reads as the thing the dialog is made of.
 *    Targets are read live, so the gather follows the sheet as it slides and drags.
 * 2. The muted Gen1 card opens its story sheet: Esc, the close button, a tap outside and
 *    a swipe down all dismiss it.
 * 3. The Gen2 card goes to its order page, holding the gather through the navigation.
 *
 * Three sheets open over this page: the Gen1 story, the questions picker and the accessories
 * order. How a sheet behaves lives in sheet.js and what is inside the order one lives in
 * order-sheet.js; this file opens the first two and lets the field follow whichever is up.
 *
 * Does not call setPod (that path damps scroll).
 */
(() => {
  'use strict';

  const gen2 = document.querySelector('[data-halo="gen2"]');
  const gen1 = document.querySelector('.store-card--muted');
  const trigger = gen1 && gen1.querySelector('.store-card__hit');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const radiusOf = (el, fallback) => {
    const n = parseFloat(getComputedStyle(el).borderTopLeftRadius);
    return Number.isFinite(n) ? n : fallback;
  };
  const visibility = (r) => {
    const vis = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (vis <= 0) return 0;
    return Math.min(1, vis / Math.max(48, Math.min(r.height, window.innerHeight)));
  };

  let mode = 'idle'; // 'idle' | 'press'

  // ---------------------------------------------------------------- the story sheet
  // Mechanics from sheet.js; this page supplies the dialog and the trigger.
  const story = window.gridSheet.create(document.getElementById('gen1-story'));

  // ---------------------------------------------------------------- questions
  // "Text GridX on WhatsApp" first asks what it is about, then opens WhatsApp with the message
  // already written. Every topic is a real link (the surest way to open WhatsApp, on iOS too);
  // this only writes its message. The halo loop below follows this sheet like any other.
  const askEl = document.getElementById('ask-sheet');
  const askButton = document.querySelector('[aria-controls="ask-sheet"]');
  if (askEl && askButton) {
    const ask = window.gridSheet.create(askEl);
    const WHATSAPP = 'https://wa.me/919220199098?text=';
    const opening = 'Hey, I was checking out the GridX store and have a few doubts';
    for (const topic of askEl.querySelectorAll('[data-topic]')) {
      const about = topic.dataset.topic;
      topic.href = WHATSAPP + encodeURIComponent(about ? `${opening} regarding ${about}.` : `${opening}.`);
      topic.setAttribute('aria-label', `${topic.textContent.trim()}, opens WhatsApp`);
      // WhatsApp opens in its own tab or app; tidy the sheet away behind it.
      topic.addEventListener('click', () => window.setTimeout(ask.close, 200));
    }
    askButton.addEventListener('click', (event) => {
      if (typeof askEl.showModal !== 'function') return; // no dialogs: straight to WhatsApp
      event.preventDefault();
      ask.open(askButton);
    });
  }

  // ---------------------------------------------------------------- the pod cards
  // Both pods press the same way: the card sinks and the field firms onto its rim. Gen1
  // then opens its story sheet, Gen2 goes on to its order page.
  let pressedCard = null;

  function bindPress(card, hit) {
    if (!card || !hit) return null;
    let relax = 0;

    const press = () => {
      if (window.gridSheet.openElement()) return;
      window.clearTimeout(relax);
      mode = 'press';
      pressedCard = card;
      card.classList.add('store-card--pressed');
    };
    // Let go a beat late: a click follows pointerup, and this keeps the gather from
    // starting back toward Gen2 in between.
    const release = (delay) => {
      card.classList.remove('store-card--pressed');
      window.clearTimeout(relax);
      relax = window.setTimeout(() => {
        if (mode === 'press' && pressedCard === card) {
          mode = 'idle';
          pressedCard = null;
        }
      }, delay);
    };

    hit.addEventListener('pointerdown', press);
    hit.addEventListener('pointerup', () => release(160));
    hit.addEventListener('pointercancel', () => release(0));
    hit.addEventListener('pointerleave', () => release(0));
    // Keyboard: no pointer events, so give the field the same beat before it acts.
    hit.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') press();
    });

    return {
      hold() {
        window.clearTimeout(relax);
        mode = 'press';
        pressedCard = card;
        card.classList.add('store-card--pressed');
      },
      clear() {
        window.clearTimeout(relax);
        card.classList.remove('store-card--pressed');
      },
    };
  }

  const gen1Press = bindPress(gen1, trigger);
  if (gen1Press) {
    trigger.addEventListener('click', () => {
      gen1Press.clear();
      story.open(trigger);
    });
  }

  const gen2Hit = gen2 && gen2.querySelector('.store-card__hit');
  const gen2Press = bindPress(gen2, gen2Hit);
  if (gen2Press) {
    gen2Hit.addEventListener('click', (event) => {
      // Leave modified clicks to the browser: new tab, new window, copy link.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
      event.preventDefault();
      gen2Press.hold();
      // A beat for the field to visibly commit before the page changes. Short enough to
      // stay under the perceptual threshold for a tap, and it matches the release above.
      window.setTimeout(() => location.assign(gen2Hit.href), reduceMotion ? 0 : 150);
    });
  }

  // ---------------------------------------------------------------- halo loop
  // setHalo already no-ops under reduced motion; skip the loop entirely there.
  if (reduceMotion || (!gen2 && !gen1)) return;

  const spec = { left: 0, top: 0, width: 1, height: 1, radius: 24, depth: 6, fill: 0, grip: 0, weight: 0 };
  let placed = false;
  let last = performance.now();

  function targetFor(proj) {
    // A sheet outranks everything: while one is up the field is what it is made of.
    const sheetEl = window.gridSheet.openElement();
    if (sheetEl) {
      return {
        rect: sheetEl.getBoundingClientRect(),
        radius: radiusOf(sheetEl, 28),
        depth: proj.sheetDepth || 3.2,
        fill: 0.5, // half hold the edge of the panel, half fill it behind the glass
        grip: 1,
        weight: 1,
      };
    }
    if (mode === 'press' && pressedCard) {
      return {
        rect: pressedCard.getBoundingClientRect(),
        radius: radiusOf(pressedCard, 24),
        depth: proj.depth,
        fill: 0.25,
        grip: 0.55,
        weight: 1,
      };
    }
    if (!gen2) return null;
    const rect = gen2.getBoundingClientRect();
    return {
      rect,
      radius: radiusOf(gen2, 24),
      depth: proj.depth,
      fill: 0,
      grip: 0,
      weight: smoother(visibility(rect)),
    };
  }

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;

    const api = window.gridBG;
    if (api && typeof api.setHalo === 'function') {
      const proj = typeof api.projection === 'function' ? api.projection() : { depth: 6, sheetDepth: 3.2 };
      const t = targetFor(proj);
      if (!t) {
        api.setHalo(null);
      } else {
        // Exponential easing, so the rim visibly travels between cards and onto the sheet.
        const k = placed ? 1 - Math.exp(-dt / 0.1) : 1;
        const kSlow = placed ? 1 - Math.exp(-dt / 0.16) : 1;
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

        if (spec.weight < 0.002) {
          api.setHalo(null);
        } else {
          api.setHalo({
            rect: { left: spec.left, top: spec.top, width: spec.width, height: spec.height },
            radius: spec.radius,
            depth: spec.depth,
            fill: spec.fill,
            grip: spec.grip,
            weight: spec.weight,
          });
        }
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
