/*
 * PowerPod Gen2 order page.
 *
 * 1. The flow:        three stages, one shown at a time. Stage 1 is six steps running
 *                     vertically, all on screen at once: a step you have not reached is
 *                     lightened rather than hidden, so what is coming is always in sight.
 *                     No IntersectionObserver and no scroll mapping, so the pod moves on
 *                     intent rather than on how far down the panel someone happens to be.
 * 2. Configuration:   real radios, nothing preselected. A group with no answer leaves its
 *                     step incomplete and the primary action resting.
 * 3. Particle field:  setHalo only, gathered on a pod sized square in the middle of the
 *                     stage, firming up briefly whenever a choice is made. Never setPod:
 *                     that path seizes scroll control for good (grid-bg.js takeScroll).
 *                     The stage is also made inert, see swallowing below.
 * 4. The 3D pod:      1.8 MB of Three.js and mesh data, loaded on idle. The flow is fully
 *                     usable before any of it arrives, and stays usable if none does.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const stageEl = document.getElementById('pg2-stage');
  const panel = document.getElementById('pg2-panel');
  const scroller = document.getElementById('pg2-scroll');
  const form = document.getElementById('pg2-config');
  const podCanvas = document.getElementById('pod');
  const companion = document.getElementById('pg2-companion');
  const companionImg = document.getElementById('pg2-companion-img');
  if (!stageEl || !panel || !form || !scroller) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const phone = coarse && Math.min(window.innerWidth, window.innerHeight) < 600;
  const stacked = () => !window.matchMedia('(min-width: 1025px)').matches;

  const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const remap01 = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a), 0, 1);
  const mix = (a, b, t) => a + (b - a) * t;
  const P = (phoneValue, wideValue) => (phone ? phoneValue : wideValue);

  // ---------------------------------------------------------------- the left side is inert
  // grid-bg.js listens for wheel and touchmove on window, in the bubble phase, and treats
  // them as a stand-in for page scroll whenever the document itself cannot scroll, which
  // here is always. Stopping propagation at the stage means those events never reach it,
  // so nothing on the left responds to a scroll gesture. topbar.js listens on window too,
  // so this keeps the nav island still as well.
  const swallow = (event) => event.stopPropagation();
  stageEl.addEventListener('wheel', swallow, { passive: true });
  stageEl.addEventListener('touchmove', swallow, { passive: true });

  // ---------------------------------------------------------------- catalog
  const CATALOG = {
    base: { label: 'PowerPod Gen2', price: 24999 },
    vehicle: {
      yes: { summary: 'With an EV two wheeler', note: 'At the dealership', price: 0 },
      no: { summary: 'PowerPod on its own', note: 'Not included', price: 0 },
    },
    charger: {
      '6a': { summary: '6A Charger', price: 2199 },
      '10a': { summary: '10A Charger', price: 2699 },
    },
    adapter: {
      yes: { summary: 'Portable Charging Adapter', price: 499 },
      no: { summary: 'Portable Charging Adapter', note: 'Not added', price: 0 },
    },
    dock: {
      yes: { summary: 'Vehicle Dock', price: 2999 },
      no: { summary: 'Vehicle Dock', note: 'Not added', price: 0 },
    },
  };
  // The reservation amount and the gateway fee are decided by the server, which is what
  // Razorpay is actually charged against. The page only ever displays them.
  const CHEAPEST_CHARGER = 2199;
  const CHOICES = ['vehicle', 'charger', 'adapter', 'dock'];

  // Nothing is preselected. Every group answers null until the buyer says otherwise.
  const state = { vehicle: null, charger: null, adapter: null, dock: null, pay: null };
  // Seeded from the DOM rather than from the literal, so a bfcache restore or a browser's
  // own form restoration can never leave the flow disagreeing with the checked radios.
  for (const input of form.querySelectorAll('.opt__input')) {
    if (input.checked) state[input.name] = input.value;
  }

  // gstin is optional and usually stays empty. Present from the start so the payload
  // shape never changes between a B2C and a B2B order.
  const details = { name: '', phone: '', email: '', city: '', pincode: '', gstin: '' };

  // ---------------------------------------------------------------- money
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const money = (n) => `₹${inr.format(n)}`;

  const priceOf = (group) => (state[group] ? CATALOG[group][state[group]].price : 0);
  const subtotal = () => CATALOG.base.price + priceOf('adapter') + priceOf('dock');
  const total = () => subtotal() + priceOf('charger');
  const fromPrice = () => subtotal() + CHEAPEST_CHARGER;
  const configured = () => CHOICES.every((g) => state[g] !== null);

  // ---------------------------------------------------------------- stages and steps
  // Three stage views, one shown at a time. Stage 1 holds six steps that run vertically,
  // all on screen together: the ones you have not reached are lightened rather than
  // hidden, so what is coming next is always in sight.
  const views = [...form.querySelectorAll('.pg2-view')]
    .sort((a, b) => Number(a.dataset.stage) - Number(b.dataset.stage));
  const steps = [...form.querySelectorAll('.pg2-step')]
    .sort((a, b) => Number(a.dataset.step) - Number(b.dataset.step));
  const LAST_STAGE = views.length; // 3
  const LAST_STEP = steps.length;  // 6
  // The configuration group each step owns. Step 1 is the pod and step 6 the summary, so
  // neither of them owns one.
  const STEP_GROUP = { 2: 'vehicle', 3: 'charger', 4: 'adapter', 5: 'dock' };

  let stage = 1;
  let currentStep = 1;

  const stepAt = (n) => steps[n - 1];

  // How far the flow has opened up. A step is open once every group before it has an
  // answer, so the lightening walks down the list as the buyer works through it.
  function reachedStep() {
    let n = 1;
    for (let k = 2; k <= LAST_STEP; k++) {
      const previous = STEP_GROUP[k - 1];
      if (previous && state[previous] === null) break;
      n = k;
    }
    return n;
  }

  // ---------------------------------------------------------------- validation
  const FIELDS = ['name', 'phone', 'email', 'city', 'pincode'];
  /**
   * Optional fields are validated but never demanded. They stay out of FIELDS so they
   * cannot hold up the Continue button or dilute the progress bar, which counts how many
   * of the things we actually need are filled in.
   */
  const OPTIONAL = ['gstin'];
  const ALL_FIELDS = FIELDS.concat(OPTIONAL);
  const CHECK = {
    name: (v) => (v.trim().length >= 2 ? '' : 'Please enter your name.'),
    phone: (v) => (/^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, ''))
      ? '' : 'Enter a 10 digit Indian mobile number.'),
    email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())
      ? '' : 'Enter a valid email address.'),
    city: (v) => (v.trim().length >= 2 ? '' : 'Please enter your city.'),
    pincode: (v) => (/^\d{6}$/.test(v.trim()) ? '' : 'Enter a 6 digit pincode.'),
    // Blank is fine. Wrong is not, because it would be printed on a tax invoice the buyer
    // files a return against, so it runs the same check digit the server does.
    gstin: (v) => (window.gridGstin ? window.gridGstin.error(v) : ''),
  };
  const fieldEls = {};
  for (const key of ALL_FIELDS) {
    const input = form.querySelector(`[name="${key}"]`);
    if (!input) continue;
    // Optional fields name a hint alongside their error node, so take the error one.
    const described = (input.getAttribute('aria-describedby') || '').split(/\s+/);
    const errId = described.find((id) => id.startsWith('e-')) || described[0];
    fieldEls[key] = { input, wrap: input.closest('.field'), err: document.getElementById(errId) };
  }

  const fieldOk = (key) => CHECK[key](fieldEls[key] ? fieldEls[key].input.value : '') === '';
  // A filled in but invalid GSTIN blocks Continue: the API would reject the order anyway,
  // and finding that out at the payment step is worse than finding it out here.
  const detailsValid = () => ALL_FIELDS.every(fieldOk);
  const validCount = () => FIELDS.filter(fieldOk).length;

  function showFieldError(key, show) {
    const f = fieldEls[key];
    if (!f) return;
    const msg = show ? CHECK[key](f.input.value) : '';
    if (f.err) f.err.textContent = msg;
    if (f.wrap) f.wrap.classList.toggle('is-bad', Boolean(msg));
  }

  /**
   * A GSTIN is upper case and unspaced, and people paste it grouped or with a trailing
   * space from wherever they copied it. Clean it in place so what is validated, shown and
   * sent are the same 15 characters.
   *
   * The caret is put back allowing for the characters removed before it, otherwise typing
   * into the middle of a corrected value jumps to the end.
   */
  function tidyGstin(input) {
    const before = input.value;
    const cleaned = before.replace(/\s+/g, '').toUpperCase();
    if (cleaned === before) return;
    const caret = input.selectionStart;
    const removedBefore = before.slice(0, caret).length - before.slice(0, caret).replace(/\s+/g, '').length;
    input.value = cleaned;
    try {
      input.setSelectionRange(caret - removedBefore, caret - removedBefore);
    } catch {
      // Some input types refuse selection APIs. Losing the caret beats losing the value.
    }
  }

  for (const key of ALL_FIELDS) {
    const f = fieldEls[key];
    if (!f) continue;
    f.input.addEventListener('blur', () => { showFieldError(key, f.input.value !== ''); render(); });
    f.input.addEventListener('input', () => {
      if (key === 'gstin') tidyGstin(f.input);
      details[key] = f.input.value;
      // Only correct an error already on screen; do not scold mid-typing.
      if (f.wrap && f.wrap.classList.contains('is-bad')) showFieldError(key, true);
      render();
    });
  }

  // ---------------------------------------------------------------- completeness
  function canAdvance(n) {
    if (n === 1) return configured();
    if (n === 2) return detailsValid();
    return state.pay !== null;
  }

  const HINTS = {
    1: 'Choose an option in every step to continue.',
    2: 'Please complete the fields above.',
    3: 'Choose how you would like to pay.',
  };

  // ---------------------------------------------------------------- render
  const backBtn = document.getElementById('pg2-back');
  const nextBtn = document.getElementById('pg2-next');
  const nextLabel = document.getElementById('pg2-next-label');
  const totalLabel = document.getElementById('pg2-total-label');
  const totalAmount = document.getElementById('pg2-total');
  const hint = document.getElementById('pg2-hint');
  const status = document.getElementById('pg2-status');
  const payFull = document.getElementById('pg2-pay-full');
  const dealerNote = document.getElementById('pg2-dealer');
  const reviewList = document.getElementById('pg2-review');
  const segs = [...document.querySelectorAll('.pg2-progress__seg')];
  const optEls = [...form.querySelectorAll('.opt[data-group]')];

  let paid = false;

  function render() {
    for (const el of optEls) {
      el.dataset.selected = String(state[el.dataset.group] === el.dataset.value);
    }

    // Footer total. "From" until a charger is chosen, because that is the only group with
    // no free option, so it is the only one that can move the floor.
    const priced = state.charger !== null;
    totalLabel.textContent = priced ? 'Total' : 'From';
    totalAmount.textContent = money(priced ? total() : fromPrice());
    if (payFull) payFull.textContent = money(total());

    // Steps you have not reached lighten, rather than disappear.
    const reached = reachedStep();
    for (const el of steps) {
      el.dataset.open = String(Number(el.dataset.step) <= reached);
    }
    if (stage === 1) renderReview();

    // Progress. Segment 1 is the four configuration choices, so it is full only once
    // every one of them has an answer.
    const fills = [
      (CHOICES.filter((g) => state[g] !== null).length / CHOICES.length) * 100,
      (validCount() / FIELDS.length) * 100,
      paid ? 100 : (state.pay ? 100 : 0),
    ];
    segs.forEach((seg, i) => {
      seg.querySelector('.pg2-progress__fill').style.setProperty('--fill', `${Math.round(fills[i])}%`);
      const n = i + 1;
      seg.dataset.state = n === stage ? 'current' : (n < stage ? 'done' : 'todo');
    });

    // Back: out to the store from the first stage, one stage back from the others.
    backBtn.setAttribute('aria-label', stage === 1 ? 'Back to the store' : 'Back to the previous stage');

    // Primary action
    nextBtn.setAttribute('aria-disabled', String(!canAdvance(stage)));
    nextLabel.textContent = stage === LAST_STAGE ? 'Confirm and pay' : 'Continue';

    if (dealerNote) dealerNote.hidden = state.vehicle !== 'yes';
    syncCompanion();
  }

  function renderReview() {
    if (!reviewList) return;
    const rows = [[CATALOG.base.label, money(CATALOG.base.price), false]];

    const v = state.vehicle ? CATALOG.vehicle[state.vehicle] : null;
    rows.push(['EV two wheeler', v ? v.note : 'Not chosen', true]);

    const c = state.charger ? CATALOG.charger[state.charger] : null;
    rows.push([c ? c.summary : 'Charger', c ? money(c.price) : 'Not chosen', !c]);

    for (const g of ['adapter', 'dock']) {
      const pick = state[g] ? CATALOG[g][state[g]] : null;
      const label = CATALOG[g].yes.summary;
      if (!pick) rows.push([label, 'Not chosen', true]);
      else if (pick.price > 0) rows.push([label, money(pick.price), false]);
      else rows.push([label, pick.note, true]);
    }

    reviewList.innerHTML = rows.map(([label, value, soft]) =>
      `<li><span class="review__label">${label}</span>`
      + `<span class="review__value${soft ? ' review__value--soft' : ''}">${value}</span></li>`,
    ).join('');
  }

  // ---------------------------------------------------------------- navigation
  let advanceTimer = 0;

  // Moving between the three stages. Within a stage nothing is swapped; the steps are a
  // vertical list the buyer scrolls.
  function goToStage(n, dir, focus) {
    const next = clamp(n, 1, LAST_STAGE);
    if (next === stage && views[next - 1].classList.contains('is-active')) return;
    window.clearTimeout(advanceTimer);
    advanceTimer = 0;

    stage = next;
    for (const v of views) v.classList.remove('is-active');
    const el = views[stage - 1];
    el.dataset.dir = dir === 'back' ? 'back' : 'fwd';
    el.classList.add('is-active');

    scroller.scrollTop = 0;
    if (hint) hint.textContent = '';
    if (status) status.textContent = '';

    // Stage 1 hands the camera back to whichever step is in play; 2 and 3 have a pose of
    // their own, calm enough not to compete with a form.
    goToStep(stage === 1 ? currentStep : LAST_STEP + (stage - 1), false);
    render();

    if (focus !== false) {
      const title = el.querySelector('.pg2-step__title');
      if (title) title.focus({ preventScroll: true });
    }
  }

  // The pod moves here and only here: on a selection, or on a stage change. Never on
  // scroll.
  function goToStep(n, scrollThere) {
    currentStep = stage === 1 ? clamp(n, 1, LAST_STEP) : currentStep;
    shotTarget = n;
    setArt(ART[n] || 'idle');
    startLoop();
    if (scrollThere && stage === 1) {
      const el = stepAt(clamp(n, 1, LAST_STEP));
      if (el) scroller.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  function tryAdvance() {
    if (!canAdvance(stage)) {
      if (hint) hint.textContent = HINTS[stage] || 'Please complete this step.';
      if (stage === 2) {
        // Mark every outstanding field at once, then take them to the first one.
        for (const key of ALL_FIELDS) showFieldError(key, true);
        const bad = ALL_FIELDS.find((k) => !fieldOk(k));
        if (bad && fieldEls[bad]) fieldEls[bad].input.focus({ preventScroll: false });
      } else if (stage === 1) {
        // Take them to the first step that is still unanswered.
        const missing = Object.keys(STEP_GROUP)
          .map(Number).sort((a, b) => a - b)
          .find((k) => state[STEP_GROUP[k]] === null);
        if (missing) {
          goToStep(missing, true);
          const first = stepAt(missing).querySelector('.opt__input');
          if (first) first.focus({ preventScroll: true });
        }
      } else {
        const first = views[stage - 1].querySelector('.opt__input');
        if (first) first.focus({ preventScroll: true });
      }
      return;
    }
    if (stage === LAST_STAGE) { pay(); return; }
    goToStage(stage + 1, 'fwd');
  }

  nextBtn.addEventListener('click', tryAdvance);

  backBtn.addEventListener('click', () => {
    if (stage === 1) { location.assign('store.html'); return; }
    goToStage(stage - 1, 'back');
  });

  // ---------------------------------------------------------------- selection
  // A choice opens the next step and walks down to it, but only when it came from a
  // pointer. Arrow keys move the selection inside a radio group, and scrolling away on
  // every arrow press would make the flow unusable from a keyboard.
  let viaPointer = false;
  form.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.opt')) viaPointer = true;
  });

  form.addEventListener('change', (event) => {
    const input = event.target.closest('.opt__input');
    if (!input) return;
    const fromPointer = viaPointer;
    viaPointer = false;

    state[input.name] = input.value;
    if (status) status.textContent = '';
    if (hint) hint.textContent = '';
    render();
    pulse();

    const owner = Object.keys(STEP_GROUP).map(Number).find((k) => STEP_GROUP[k] === input.name);
    if (fromPointer && owner) {
      // A beat so the tick visibly lands before the flow walks on.
      window.clearTimeout(advanceTimer);
      advanceTimer = window.setTimeout(
        () => goToStep(Math.min(owner + 1, LAST_STEP), true),
        reduceMotion ? 120 : 420,
      );
    }
  });

  // Enter moves on, which is what a keyboard user expects. Inside stage 1 that means the
  // next step rather than the next stage, and focus follows so the flow keeps its place.
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const opt = event.target.closest('.opt__input');
    if (!opt && !event.target.closest('.field__input')) return;
    event.preventDefault();

    if (opt && stage === 1) {
      const owner = Object.keys(STEP_GROUP).map(Number).find((k) => STEP_GROUP[k] === opt.name);
      if (owner && owner < LAST_STEP) {
        const nextStep = owner + 1;
        goToStep(nextStep, true);
        const first = stepAt(nextStep).querySelector('.opt__input');
        if (first) first.focus({ preventScroll: true });
        return;
      }
    }
    tryAdvance();
  });

  form.addEventListener('submit', (event) => event.preventDefault());

  // ---------------------------------------------------------------- camera beats
  // az and el are spherical, frame is the share of the stage height the pod fills, target
  // is the world Y the camera looks at. The pod stands 391 tall, so its contacts are near
  // -195 and its display near +195 (see powerpod-3d.js).
  const BEATS = [
    { at: 0, az: -0.86, el: 0.26, frame: P(0.52, 0.47), target: 0 },              // entry
    { at: 1, az: -0.62, el: 0.17, frame: P(0.62, 0.58), target: 0 },              // 1 PowerPod
    { at: 2, az: -0.50, el: -0.10, frame: P(0.50, 0.46), target: -6 },            // 2 Vehicle
    { at: 3, az: -0.34, el: -0.28, frame: P(0.92, 1.05), target: P(-120, -140) }, // 3 Charger: the contacts
    { at: 4, az: -0.95, el: 0.10, frame: P(0.60, 0.54), target: 6 },              // 4 Adapter: carried
    { at: 5, az: -0.20, el: 0.06, frame: P(0.62, 0.60), target: -10 },            // 5 Dock: face on
    { at: 6, az: -0.55, el: 0.19, frame: P(0.58, 0.54), target: 0 },              // 6 Review
    { at: 7, az: -0.70, el: 0.22, frame: P(0.46, 0.42), target: 0 },              // 7 Details: steps back
    { at: 8, az: -0.58, el: 0.16, frame: P(0.56, 0.52), target: 0 },              // 8 Payment
  ];
  const LAST_BEAT = BEATS[BEATS.length - 1].at;

  function shotAt(t) {
    let i = 0;
    while (i < BEATS.length - 1 && t > BEATS[i + 1].at) i++;
    const a = BEATS[i];
    const b = BEATS[Math.min(BEATS.length - 1, i + 1)];
    const k = b === a ? 0 : smoother(remap01(t, a.at, b.at));
    return {
      az: mix(a.az, b.az, k),
      el: mix(a.el, b.el, k),
      frame: mix(a.frame, b.frame, k),
      target: mix(a.target, b.target, k),
    };
  }

  // The stage is a short top band under 1025px, with the brand lockup floating over it, so
  // the pod is dropped clear of the chrome with a lens shift rather than with padding.
  const lens = () => ({ x: 0, y: stacked() ? -0.07 : 0 });

  let shotT = 0;
  let shotTarget = 1;

  const ART = { 4: 'adapter', 5: 'dock' };
  const ART_SRC = {
    adapter: 'assets/productImages/store/adapter.webp',
    dock: 'assets/productImages/store/vehicle-dock.webp',
  };
  let artKey = 'idle';

  function syncCompanion() {
    if (!companion) return;
    companion.dataset.declined = String(
      (artKey === 'adapter' && state.adapter === 'no')
      || (artKey === 'dock' && state.dock === 'no'),
    );
  }

  function setArt(key) {
    if (!companion || key === artKey) return;
    artKey = key;
    if (ART_SRC[key]) companionImg.src = ART_SRC[key];
    companion.dataset.art = key;
    syncCompanion();
  }

  // ---------------------------------------------------------------- the halo
  const haloOn = !reduceMotion && typeof window.gridBG !== 'undefined';
  const REST_WEIGHT = phone ? 0.78 : 0.62;
  const REST_GRIP = phone ? 0.10 : 0.06;
  const PULSE_HOLD = 220;
  const PULSE_END = 860;

  const spec = { left: 0, top: 0, width: 1, height: 1, radius: 24, depth: 6, fill: 0, grip: 0, weight: 0 };
  let placed = false;
  let pulseAt = -Infinity;
  let pulseT = 0;

  function pulse() {
    pulseAt = performance.now();
    startLoop();
  }

  const visibility = (r) => {
    const vis = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (vis <= 0) return 0;
    return Math.min(1, vis / Math.max(48, Math.min(r.height, window.innerHeight)));
  };

  function haloTarget(api, proj) {
    const r = stageEl.getBoundingClientRect();
    // A pod sized square in the middle of the stage. A halo the size of the whole column
    // would just be a border around the screen.
    const side = Math.min(r.width, r.height) * (0.60 + 0.06 * pulseT);
    // The idle field is only DRIFT_DENSITY of capacity, and the governor thins it further
    // under load, so the ring is scaled to what is actually left to gather.
    const q = typeof api.quality === 'number' ? Math.min(1, api.quality / 0.6) : 1;
    const weight = Math.min(1, mix(REST_WEIGHT, 0.98, pulseT) * q);
    return {
      rect: {
        left: r.left + (r.width - side) / 2,
        top: r.top + (r.height - side) / 2,
        width: side,
        height: side,
      },
      radius: side * 0.28,
      depth: proj.depth,
      fill: 0.08 * pulseT,
      grip: mix(REST_GRIP, 0.55, pulseT),
      weight: weight * smoother(visibility(r)),
    };
  }

  function stepHalo(dt, now) {
    const api = window.gridBG;
    if (!api || typeof api.setHalo !== 'function') return;

    const age = now - pulseAt;
    pulseT = age < PULSE_HOLD ? 1 : 1 - smoother(remap01(age, PULSE_HOLD, PULSE_END));
    if (age > PULSE_END) pulseT = 0;

    const proj = typeof api.projection === 'function' ? api.projection() : { depth: 6 };
    const t = haloTarget(api, proj);

    // Exponential easing, so the ring visibly gathers and lets go.
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

  // ---------------------------------------------------------------- one loop
  let pod = null;
  let rafId = 0;
  let last = 0;

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;

    // Critically damped follow. Slower than the home page's 9 because the target here
    // jumps a whole beat at a time, so arrivals should settle rather than stop dead.
    const k = reduceMotion ? 30 : (phone ? 3.6 : 3.0);
    shotT += (clamp(shotTarget, 0, LAST_BEAT) - shotT) * (1 - Math.exp(-dt * k));

    if (pod) {
      const driftAz = reduceMotion ? 0 : Math.sin(now * 0.00017) * 0.004;
      const driftEl = reduceMotion ? 0 : Math.cos(now * 0.00013) * 0.003;
      pod.setShot(shotAt(shotT), driftAz, driftEl, lens());
    }
    if (haloOn) stepHalo(dt, now);
  }

  function startLoop() {
    if (rafId || document.hidden) return;
    if (!pod && !haloOn) return;
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLoop();
      if (haloOn && window.gridBG && window.gridBG.setHalo) window.gridBG.setHalo(null);
      placed = false;
    } else {
      startLoop();
    }
  });

  const onResize = () => {
    if (pod) pod.resize();
    startLoop();
  };
  window.addEventListener('resize', onResize);
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(stageEl);

  // ---------------------------------------------------------------- the 3D pod, on idle
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  function boot3D() {
    if (!podCanvas || !root.classList.contains('gl')) return; // no WebGL2: the poster stays
    const conn = navigator.connection;
    if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;

    // Loaded in sequence, not in parallel: powerpod-data.js declares the GEO and LOGO
    // globals that powerpod-3d.js reads, and three.min.js has to be there before both.
    loadScript('assets/three.min.js')
      .then(() => loadScript('assets/powerpod-data.js'))
      .then(() => loadScript('assets/powerpod-3d.js'))
      .then(() => {
        if (!window.gridPod) return;
        pod = window.gridPod.mount({
          canvas: podCanvas,
          phone,
          onContextLost: () => {
            pod = null;
            stageEl.classList.remove('is-pod-live');
          },
        });
        if (!pod) return;
        pod.resize();
        pod.setShot(shotAt(reduceMotion ? shotTarget : 0), 0, 0, lens());
        // One frame in the entry pose before the cross fade, so the pod is never revealed
        // mid-build or in the wrong place.
        requestAnimationFrame(() => {
          stageEl.classList.add('is-pod-live');
          if (reduceMotion) shotT = shotTarget;
          startLoop();
        });
        watchQuality();
      })
      .catch((err) => console.warn('[gridPod] 3D unavailable:', err));
  }

  // Two GL contexts share this device. If grid-bg's own frame-time governor is already
  // shedding particles, step this renderer down once and leave it there, so the two do not
  // chase each other up and down.
  function watchQuality() {
    let steppedDown = false;
    const timer = window.setInterval(() => {
      if (steppedDown || !pod || !window.gridBG) return;
      if (typeof window.gridBG.quality === 'number' && window.gridBG.quality < 0.6) {
        steppedDown = true;
        // Through the handle, not the renderer: the module caps the ratio by buffer area on
        // every resize, so a value written straight onto the renderer would not survive one.
        pod.setPixelRatio(1);
        window.clearInterval(timer);
      }
    }, 2000);
  }

  // ---------------------------------------------------------------- payment
  // Two steps, and the split matters. createOrder() prices and records the order on the
  // server; openCheckout() collects the money. Neither of them confirms anything: the
  // Razorpay webhook is the only thing that marks an order paid and sends the receipt,
  // because a browser can be closed, throttled or lied to halfway through.
  /**
   * Create the order on the server, then open Razorpay Checkout against it.
   *
   * The server prices the order. What goes up is which options were chosen, never an
   * amount, so a doctored total in the browser changes nothing. The server answers with
   * the Razorpay order id and the publishable key.
   */
  function createOrder() {
    if (!window.gridxApi) {
      return Promise.reject(new Error('Could not reach GridX. Please check your connection and try again.'));
    }
    return window.gridxApi.postJSON('/api/public/website/orders', {
      build: {
        vehicle: state.vehicle,
        charger: state.charger,
        adapter: state.adapter,
        dock: state.dock,
        pay: state.pay,
      },
      customer: { ...details },
    });
  }

  function openCheckout(created) {
    return new Promise((resolve, reject) => {
      if (!window.Razorpay) {
        reject(new Error('The payment window could not load. Please refresh and try again.'));
        return;
      }
      let settled = false;
      const rzp = new window.Razorpay({
        key: created.keyId,
        order_id: created.razorpayOrderId,
        amount: created.amountPaise,
        currency: 'INR',
        name: 'GridX Energy',
        description: state.pay === 'reserve' ? 'PowerPod Gen2 reservation' : 'PowerPod Gen2',
        prefill: {
          name: created.customer?.name || details.name,
          email: created.customer?.email || details.email,
          contact: created.customer?.phone || details.phone,
        },
        notes: { gridxOrderNumber: created.orderNumber },
        theme: { color: '#141414' },
        // Presentational only. The webhook is what actually confirms the money and sends
        // the receipt, so this handler never claims more than "we have it from here".
        handler() {
          settled = true;
          resolve(created);
        },
        modal: {
          ondismiss() {
            if (settled) return;
            reject(new Error('Payment was cancelled. Your order is saved, you can try again.'));
          },
        },
      });
      rzp.on('payment.failed', (response) => {
        settled = true;
        reject(new Error(response?.error?.description || 'That payment did not go through. Please try again.'));
      });
      rzp.open();
    });
  }

  function pay() {
    for (const key of ALL_FIELDS) details[key] = fieldEls[key] ? fieldEls[key].input.value.trim() : '';
    // Uppercased here so the browser and the server normalize identically.
    if (details.gstin && window.gridGstin) details.gstin = window.gridGstin.normalize(details.gstin);
    if (status) status.textContent = 'Setting up your payment.';
    nextBtn.setAttribute('aria-disabled', 'true');

    createOrder()
      .then((created) => openCheckout(created))
      .then((created) => {
        paid = true;
        if (status) status.textContent = '';
        showConfirmation(created);
        render();
      })
      .catch((err) => {
        if (status) status.textContent = err.message;
        render();
      });
  }

  /**
   * The customer is done. The receipt is generated and sent server side from the webhook,
   * so this says it is on its way rather than pretending to have sent it.
   */
  function showConfirmation(created) {
    const view = views[LAST_STAGE - 1];
    if (!view) return;
    view.querySelectorAll('.pg2-step__options, .pg2-step__sub').forEach((el) => { el.hidden = true; });
    const title = view.querySelector('.pg2-step__title');
    if (title) title.textContent = 'Thank you.';

    const done = document.getElementById('pg2-done');
    if (done) {
      done.hidden = false;
      const ref = document.getElementById('pg2-done-ref');
      if (ref) ref.textContent = created.orderNumber;
      const where = document.getElementById('pg2-done-where');
      if (where) {
        where.textContent = state.pay === 'reserve'
          ? 'Your reservation is confirmed. We have sent your receipt voucher to '
          : 'Your order is confirmed. We have sent your receipt to ';
      }
      const to = document.getElementById('pg2-done-to');
      if (to) to.textContent = `${details.email} and on WhatsApp to ${details.phone}.`;
      const heading = done.querySelector('h3');
      if (heading) heading.focus?.();
    }
    nextBtn.hidden = true;
  }

  // ---------------------------------------------------------------- go
  // Stage 1 already carries is-active in the markup, so there is no flash of an empty
  // panel before this runs; the camera just needs pointing at the first step.
  render();
  goToStep(1, false);
  startLoop();
  window.addEventListener('load', () => {
    if ('requestIdleCallback' in window) requestIdleCallback(boot3D, { timeout: 1200 });
    else window.setTimeout(boot3D, 300);
  });
})();
