/*
 * PowerPod Gen2 pre-booking page.
 *
 * 1. The flow:        three stages, one shown at a time. Stage 1 is four steps running
 *                     vertically, all on screen at once: a step you have not reached is
 *                     lightened rather than hidden, so what is coming is always in sight.
 *                     No IntersectionObserver and no scroll mapping, so the pod moves on
 *                     intent rather than on how far down the panel someone happens to be.
 * 2. Configuration:   two real radio groups, nothing preselected: a vehicle or not, and
 *                     which Komaki when there is one. The Komaki step is only shown with a
 *                     vehicle. Nothing is priced per option: the footer says what the whole
 *                     thing starts at, and Paddock prices the order.
 * 3. Particle field:  on the configure stage, setHalo only, gathered on a pod sized square
 *                     in the middle of the stage, firming up briefly whenever a choice is
 *                     made. Choosing a vehicle hands the field the home film's scooter
 *                     (setForm, the ride below) and the pod rolls into its bay. On details
 *                     and payment the pod steps aside and the field gathers into a drawing
 *                     instead: a profile, then a rupee. Never setPod: that path seizes
 *                     scroll control for good (grid-bg.js takeScroll). The stage is also
 *                     made inert, see swallowing below.
 * 4. The 3D pod:      1.8 MB of Three.js and mesh data, loaded on idle. The flow is fully
 *                     usable before any of it arrives, and stays usable if none does. It
 *                     only draws on the configure stage, and is not even built off it.
 * 5. The Komaki, up close: each model's picture, full size over everything, on a tap and
 *                     on nothing else: the large file is fetched then, not with the page,
 *                     and the image is removed again on the X. The page's own canvases
 *                     sleep meanwhile.
 * 6. Payment:         one way to pay, a ₹399 hold, on one page that says everything:
 *                     what is pre-booked, what is paid now and why, what is left and when.
 * 7. The keyboard:    while an on-screen keyboard is up the panel fits itself above it and
 *                     keeps the field being typed in on screen.
 * 8. Analytics:       each step the buyer reaches (configurator_step, a short slug, once a
 *                     page), a Komaki opened up close, the hold going in (order_submit: the SKU,
 *                     the model, and whether it is collected or shipped) and what Razorpay's
 *                     window did. Nothing typed.
 */
(() => {
  'use strict';

  // Every word this page writes, in the page's language (assets/i18n.js).
  const t = window.gridLang ? window.gridLang.t : (src, vars) => { let out = String(src).replace(/^[a-z][\w-]*::/, ''); if (vars && typeof vars.n === 'number' && out.includes('|')) out = out.split('|')[vars.n === 1 ? 0 : 1]; return out.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)); };
  const tags = (text, pairs) => String(text).replace(/<(\/?)(\d+)>/g, (m, close, k) => (pairs[k] ? pairs[k][close ? 1 : 0] : ''));

  const root = document.documentElement;
  const stageEl = document.getElementById('pg2-stage');
  const panel = document.getElementById('pg2-panel');
  const scroller = document.getElementById('pg2-scroll');
  const form = document.getElementById('pg2-config');
  const podCanvas = document.getElementById('pod');

  // The configurator is a purchase flow, so the checkout script is fetched at the first sign of
  // use (a tap, a key, a focus in the panel) rather than with the page, and has long arrived by
  // the time Pay is pressed. openCheckout() waits for it either way.
  if (panel && window.gridxApi && window.gridxApi.loadRazorpay) {
    // reCAPTCHA warms up with it: Paddock asks Google about the order before creating it.
    const warm = () => {
      window.gridxApi.loadRazorpay();
      if (window.gridxApi.loadRecaptcha) window.gridxApi.loadRecaptcha();
    };
    for (const type of ['pointerdown', 'keydown', 'focusin']) panel.addEventListener(type, warm, { once: true, passive: true });
  }
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
  // "Starts at" figures, for display only. The vehicle's variant and its final price are
  // settled with the dealership, and Paddock holds the same numbers (lib/website/pricing.js:
  // GEN2_STARTS_AT_INR and VEHICLES) and pins them against this file in its tests.
  const PRICES = { pod: 29999, x1: 59999, x3: 69999 };
  const MODELS = { x1: 'Komaki X1', x3: 'Komaki X3' };
  const CHOICES = ['vehicle', 'model'];

  // The hold, the only way to pay on this page: an advance against the PowerPod, with
  // Razorpay's fee passed on as a platform fee. Paddock decides both (RESERVE_FEE_INR and
  // GATEWAY_FEE_RATE in its pricing.js), and Razorpay is charged against Paddock's figure.
  // This is what the page prints until Paddock's own quote arrives; the quote wins.
  const RESERVE_INR = 399;

  // Nothing is preselected. Every group answers null until the buyer says otherwise. pay is
  // the exception because there is nothing to choose: it is always a reservation.
  const state = { vehicle: null, model: null, pay: 'reserve' };
  // Seeded from the DOM rather than from the literal, so a bfcache restore or a browser's
  // own form restoration can never leave the flow disagreeing with the checked radios.
  for (const input of form.querySelectorAll('.opt__input')) {
    if (input.checked) state[input.name] = input.value;
  }

  // gstin is optional and usually stays empty. Present from the start so the payload
  // shape never changes between a B2C and a B2B order.
  const details = { name: '', phone: '', email: '', city: '', pincode: '', gstin: '' };

  // ---------------------------------------------------------------- money
  // catalogue.js is the site's one copy of Paddock's rounding and gateway fee. The fallbacks
  // only keep the page standing if it failed to load; Razorpay is charged Paddock's figure
  // whatever is printed here.
  const cat = window.gridCatalogue || null;
  const round2 = cat ? cat.round2 : (x) => Math.sign(x) * Math.round(Math.abs(x) * 100) / 100;
  // Paise only when there are paise, so a round figure does not read as ₹399.00.
  const money = cat ? cat.money : (n) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`;

  const withVehicle = () => state.vehicle === 'yes';
  const configured = () => state.vehicle !== null && (!withVehicle() || state.model !== null);
  // The floor for what has been chosen so far: a vehicle without a model yet is the cheaper
  // Komaki, and before any answer it is the PowerPod on its own.
  const startsAt = () => (withVehicle() ? PRICES[state.model || 'x1'] : PRICES.pod);
  const vehicleName = () => (withVehicle() && state.model ? MODELS[state.model] : '');
  const towards = () => (vehicleName() ? t('PowerPod Gen2 with {model}', { model: vehicleName() }) : 'PowerPod Gen2');

  // What today's payment comes to. Paddock's own figures once createOrder() has answered,
  // and until then the same arithmetic it uses: the fee grossed up, not marked up.
  let quoted = null;
  function reservation() {
    if (quoted) return quoted;
    const chargedInr = cat ? cat.grossUp(RESERVE_INR) : RESERVE_INR;
    return { itemsInr: RESERVE_INR, feeInr: round2(chargedInr - RESERVE_INR), chargedInr };
  }
  const quotedStartsAt = () => (quoted && Number.isFinite(quoted.startsAtInr) ? quoted.startsAtInr : startsAt());

  // ---------------------------------------------------------------- stages and steps
  // Three stage views, one shown at a time. Stage 1 holds four steps that run vertically,
  // all on screen together: the ones you have not reached are lightened rather than
  // hidden, so what is coming next is always in sight. The Komaki step is the one
  // exception: it is hidden outright unless a vehicle is wanted.
  const views = [...form.querySelectorAll('.pg2-view')]
    .sort((a, b) => Number(a.dataset.stage) - Number(b.dataset.stage));
  const steps = [...form.querySelectorAll('.pg2-step')]
    .sort((a, b) => Number(a.dataset.step) - Number(b.dataset.step));
  const LAST_STAGE = views.length; // 3
  const LAST_STEP = steps.length;  // 4
  const MODEL_STEP = 3;
  // The configuration group each step owns. Step 1 is the pod and step 4 the summary, so
  // neither of them owns one.
  const STEP_GROUP = { 2: 'vehicle', 3: 'model' };
  const modelStep = document.getElementById('step-model');

  // ---------------------------------------------------------------- analytics
  // Through the queue gridx-api.js sets up. Each step is counted the first time this page
  // reaches it, so walking back and forth through the list does not count it again.
  const track = (name, props) => {
    if (typeof window.gridTrack === 'function') window.gridTrack(name, props);
  };
  const STEP_SLUG = ['powerpod', 'vehicle', 'model', 'review'];
  const stepsSeen = new Set();
  let counting = false; // off for the page's own first placement, which nobody chose
  const stepReached = (slug) => {
    if (!counting || !slug || stepsSeen.has(slug)) return;
    stepsSeen.add(slug);
    track('configurator_step', { step: slug });
  };

  let stage = 1;
  let currentStep = 1;

  const stepAt = (n) => steps[n - 1];

  // How far the flow has opened up: the vehicle question is always open, the Komaki step
  // once a vehicle is wanted, and the summary once everything before it has an answer.
  function reachedStep() {
    if (state.vehicle === null) return 2;
    if (!withVehicle()) return LAST_STEP;
    return state.model === null ? MODEL_STEP : LAST_STEP;
  }

  // The step a choice walks on to: the Komaki step after wanting a vehicle, the summary
  // after everything else.
  const stepAfter = (owner) => (owner === 2 && withVehicle() ? MODEL_STEP : LAST_STEP);

  // ---------------------------------------------------------------- validation
  const FIELDS = ['name', 'phone', 'email', 'city', 'pincode'];
  /**
   * Optional fields are validated but never demanded. They stay out of FIELDS so they
   * cannot hold up the primary button or dilute the progress bar, which counts how many
   * of the things we actually need are filled in.
   */
  const OPTIONAL = ['gstin'];
  const ALL_FIELDS = FIELDS.concat(OPTIONAL);
  const CHECK = {
    name: (v) => (v.trim().length >= 2 ? '' : t('Please enter your name.')),
    phone: (v) => (/^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, ''))
      ? '' : t('Enter a 10 digit Indian mobile number.')),
    email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())
      ? '' : t('Enter a valid email address.')),
    city: (v) => (v.trim().length >= 2 ? '' : t('Please enter your city.')),
    pincode: (v) => (/^\d{6}$/.test(v.trim()) ? '' : t('Enter a 6 digit pincode.')),
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
  // A filled in but invalid GSTIN blocks the way on: the API would reject the order anyway,
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

  // ---------------------------------------------------------------- the launch
  // Pre-booking opens at one instant (assets/launch.js). Until then everything up to the
  // payment page works, so people can choose and fill in their details ahead of time, and
  // both ways into a payment wait: the footer button (through canAdvance) and pay() itself.
  // Paddock refuses an early order whatever this page believes, so a wrong clock here can
  // only show the wrong thing, never take a payment. Without launch.js nothing waits.
  const launch = window.gridLaunch;
  const launchOpen = () => !launch || launch.isOpen();
  const NOT_OPEN = t('Pre-booking opens {when} IST. Shipping across India.', { when: launch ? launch.when : t('12 October, 12 PM') });

  // ---------------------------------------------------------------- completeness
  // Payment has nothing left to choose, so it can always move on, to Razorpay. Once
  // pre-booking is open, that is.
  function canAdvance(n) {
    if (n === 1) return configured();
    if (n === 2) return detailsValid();
    return !busy && !paid && launchOpen();
  }

  const HINTS = {
    1: t('Choose an option in every step to continue.'),
    2: t('Please complete the fields above.'),
    3: NOT_OPEN,
  };

  // ---------------------------------------------------------------- render
  const backBtn = document.getElementById('pg2-back');
  const nextBtn = document.getElementById('pg2-next');
  const nextLabel = document.getElementById('pg2-next-label');
  const totalLabel = document.getElementById('pg2-total-label');
  const totalAmount = document.getElementById('pg2-total');
  const hint = document.getElementById('pg2-hint');
  const status = document.getElementById('pg2-status');
  const footNote = document.getElementById('pg2-foot-note');
  const dealerNote = document.getElementById('pg2-dealer');
  const reviewList = document.getElementById('pg2-review');
  const payView = document.getElementById('pg2-pay');
  const payTitle = document.getElementById('pg2-pay-title');
  const paySub = document.getElementById('pg2-pay-sub');
  const PAY_LINE = paySub ? paySub.textContent : '';
  const bill = document.getElementById('pg2-bill');
  const segs = [...document.querySelectorAll('.pg2-progress__seg')];
  const optEls = [...form.querySelectorAll('.opt[data-group]')];

  let paid = false;
  let busy = false;
  // Razorpay's window has closed happily and the webhook's word is being waited on
  // (assets/pay-confirm.js). Busy stays true with it, so nothing takes a second press.
  let confirming = false;

  /**
   * The footer's words, written only when they change. render() runs on every keystroke in
   * the details, and rewriting the same text each time would restart the fade for nothing.
   * A real change (a stage, Confirming, Paid) fades in (.is-new in the stylesheet), so the
   * swap reads as one deliberate step. The first write is the page's own and does not fade.
   */
  function swap(el, key, fill) {
    if (!el || el.dataset.key === key) return;
    const first = el.dataset.key === undefined;
    el.dataset.key = key;
    fill(el);
    if (first) return;
    el.classList.remove('is-new');
    void el.offsetWidth; // restart the animation if one is still running
    el.classList.add('is-new');
  }
  function swapText(el, text) {
    swap(el, text, (node) => { node.textContent = text; });
  }

  function render() {
    for (const el of optEls) {
      el.dataset.selected = String(state[el.dataset.group] === el.dataset.value);
    }
    // The Komaki step only exists with a vehicle.
    if (modelStep) modelStep.hidden = !withVehicle();
    stageEl.dataset.vehicle = withVehicle() ? 'yes' : 'no';

    // The footer speaks for today's payment and nothing else, whatever is chosen: the
    // PowerPod's and the Komaki's prices are the review's to say. On the payment page the
    // fee that rides on top takes the second line, so the hold and the fee sit side by side
    // and the button can name their sum. Once Razorpay has taken the money, the total and
    // where the hold goes: already while the webhook is awaited, because the card above says
    // "Payment received" and the button has gone, and a footer still asking for ₹399 plus a
    // fee would read as a second charge.
    const r = reservation();
    const settled = paid || confirming;
    const fee = !settled && stage === LAST_STAGE && r.feeInr > 0;
    swapText(totalLabel, settled ? t('Paid') : t('Pre-book at'));
    swapText(totalAmount, money(settled ? r.chargedInr : r.itemsInr));
    footNote.classList.toggle('pg2-foot__note--fee', fee);
    if (settled) swapText(footNote, t('{amount} comes off your final payment', { amount: money(r.itemsInr) }));
    else if (!fee) swapText(footNote, t('(Fully refundable)'));
    else {
      swap(footNote, `fee ${r.feeInr}`, (el) => {
        const figure = document.createElement('span');
        figure.className = 'pg2-foot__fee';
        figure.textContent = `+ ${money(r.feeInr)}`;
        el.replaceChildren(figure, ` ${t('(Platform fee)')}`);
      });
    }

    // Steps you have not reached lighten, rather than disappear.
    const reached = reachedStep();
    for (const el of steps) {
      el.dataset.open = String(Number(el.dataset.step) <= reached);
    }
    if (stage === 1) renderReview();

    // Progress. Segment 1 is the choices: the vehicle question, and the Komaki when one is
    // wanted, so it is full only once every question that applies has an answer.
    const asked = withVehicle() ? CHOICES.length : 1;
    const answered = CHOICES.filter((g) => state[g] !== null).length;
    const fills = [
      (Math.min(answered, asked) / asked) * 100,
      (validCount() / FIELDS.length) * 100,
      paid ? 100 : (confirming ? 50 : 0),
    ];
    segs.forEach((seg, i) => {
      seg.querySelector('.pg2-progress__fill').style.setProperty('--fill', `${Math.round(fills[i])}%`);
      const n = i + 1;
      seg.dataset.state = n === stage ? 'current' : (n < stage ? 'done' : 'todo');
    });

    // Back: out to the store from the first stage, one stage back from the others.
    backBtn.setAttribute('aria-label', stage === 1 ? t('Back to the store') : t('Back to the previous stage'));

    // Primary action. Continue walks on to the details and then to the payment page, where
    // it names the exact figure Razorpay will ask for, the hold and the fee together.
    nextBtn.setAttribute('aria-disabled', String(!canAdvance(stage)));
    swapText(nextLabel, confirming ? t('Confirming') : (stage === LAST_STAGE ? t('Pay {amount}', { amount: money(r.chargedInr) }) : t('Continue')));

    // Before the launch the payment page says when, in place of its usual line.
    if (paySub) paySub.textContent = launchOpen() ? PAY_LINE : NOT_OPEN;
    if (payTitle) payTitle.textContent = t('Pre-book your {what}.', { what: towards() });

    if (dealerNote) dealerNote.hidden = !vehicleName();
    syncRide();
  }

  function renderReview() {
    if (!reviewList) return;
    const rows = [
      ['PowerPod Gen2', t('Included'), true],
      ['GridX-Pro Pack', t('Free for the first year'), true],
    ];
    if (state.vehicle === null) rows.push([t('Vehicle'), t('Not chosen'), true]);
    else if (!withVehicle()) rows.push([t('Vehicle'), t('Your own ride'), true]);
    else rows.push([t('Vehicle'), state.model ? MODELS[state.model] : t('Komaki, model not chosen'), !state.model]);
    rows.push([t('Starts at'), money(startsAt()), false]);

    reviewList.innerHTML = rows.map(([label, value, soft]) =>
      `<li><span class="review__label">${label}</span>`
      + `<span class="review__value${soft ? ' review__value--soft' : ''}">${value}</span></li>`,
    ).join('');
  }

  /**
   * The payment page: the last thing on screen before Razorpay opens, so it says everything.
   * What is being pre-booked, what is paid today and why, and what is left and when. Every
   * label is ours and every figure is a number, so it is built as markup like the review
   * list above. The links are the support page's.
   */
  function renderBill() {
    if (!bill) return;
    const r = reservation();
    const starts = quotedStartsAt();
    const balance = round2(starts - r.itemsInr);

    const row = (label, value, mod = '', note = '') => `<li class="bill__row${mod ? ` bill__row--${mod}` : ''}">`
      + `<span class="bill__label">${label}${note ? `<small class="bill__aside">${note}</small>` : ''}</span>`
      + `<span class="bill__value">${value}</span></li>`;
    const group = (title, rows, after = '') => `<section class="bill__group">`
      + `<h3 class="bill__title">${title}</h3><ul class="bill__rows">${rows.join('')}</ul>${after}</section>`;

    const what = [row('PowerPod Gen2', t('Included'), 'soft')];
    if (vehicleName()) {
      what.push(row(vehicleName(), t('With your dealership'), 'soft',
        t('The model and its specifics can be changed before the final order is placed')));
    }
    what.push(row('GridX-Pro Pack', t('Free for the first year'), 'soft'));

    const now = [row(t('Pre-booking amount'), money(r.itemsInr), '', t('Fully refundable'))];
    if (r.feeInr > 0) now.push(row(t('Platform fee'), money(r.feeInr), '', t('Payment processing, not refunded')));
    now.push(row(t('GST'), money(0), '', t('None on an advance for goods')));
    now.push(row(t('Total payable now'), money(r.chargedInr), 'total'));

    const later = [
      row(t('Starts at'), money(starts), '',
        vehicleName() ? t('The final price depends on the variant you confirm at the dealership') : ''),
      row(t('Less your pre-booking'), `−${money(r.itemsInr)}`),
      row(t('Balance'), t('from {amount}', { amount: money(balance) }), 'total', t('Taken only when your order is ready for shipment')),
    ];

    bill.innerHTML = group(t('You are pre-booking'), what)
      + group(t('Pay now to GridX Energy'), now)
      + group(t('At your final payment'), later)
      + `<p class="bill__note bill__note--end">${tags(t('Your {amount} is fully refundable, whenever you ask: message us on <0>WhatsApp</0>, <1>call us</1>, or email <2>info@gridxenergy.in</2> and it comes straight back. The platform fee is the payment gateway\'s charge and is not refunded. Your receipt voucher will be sent by email and on WhatsApp.', { amount: money(r.itemsInr) }), [
        ['<a href="https://wa.me/919220199098" target="_blank" rel="noopener noreferrer">', '</a>'],
        ['<a href="tel:+919220199098">', '</a>'],
        ['<a href="mailto:info@gridxenergy.in">', '</a>'],
      ])}</p>`;
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

    if (stage === 2) stepReached('details');
    if (stage === LAST_STAGE && !paid) {
      renderBill();
      stepReached('reserve');
    }

    // Stage 1 hands the camera back to whichever step is in play. The other two are not the
    // pod's: it stops drawing and the field gathers into their drawing instead.
    if (stage === 1) goToStep(currentStep, false);
    setScene();
    render();

    if (focus !== false) focusTitle(el);
  }

  // The visible title of a view.
  function focusTitle(view) {
    const title = [...view.querySelectorAll('.pg2-step__title')].find((t) => !t.closest('[hidden]'));
    if (title) title.focus({ preventScroll: true });
  }

  // The pod moves here and only here: on a selection, or on a stage change. Never on
  // scroll.
  function goToStep(n, scrollThere) {
    currentStep = stage === 1 ? clamp(n, 1, LAST_STEP) : currentStep;
    if (stage === 1) stepReached(STEP_SLUG[clamp(n, 1, LAST_STEP) - 1]);
    shotTarget = n;
    startLoop();
    if (scrollThere && stage === 1) {
      const el = stepAt(clamp(n, 1, LAST_STEP));
      if (el) scroller.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  function tryAdvance() {
    // Payment already under way, or done: a press has nothing to add and nothing to explain.
    if (stage === LAST_STAGE && (busy || paid)) return;
    if (!canAdvance(stage)) {
      if (hint) hint.textContent = HINTS[stage] || t('Please complete this step.');
      if (stage === 2) {
        // Mark every outstanding field at once, then take them to the first one.
        for (const key of ALL_FIELDS) showFieldError(key, true);
        const bad = ALL_FIELDS.find((k) => !fieldOk(k));
        if (bad && fieldEls[bad]) fieldEls[bad].input.focus({ preventScroll: false });
      } else if (stage === 1) {
        // Take them to the first step that is still unanswered.
        const missing = state.vehicle === null ? 2 : (withVehicle() && state.model === null ? MODEL_STEP : 0);
        if (missing) {
          goToStep(missing, true);
          const first = stepAt(missing).querySelector('.opt__input');
          if (first) first.focus({ preventScroll: true });
        }
      } else if (stage === LAST_STAGE && status) {
        status.textContent = NOT_OPEN;
      }
      return;
    }
    if (stage === LAST_STAGE) {
      pay();
      return;
    }
    goToStage(stage + 1, 'fwd');
  }

  nextBtn.addEventListener('click', tryAdvance);

  backBtn.addEventListener('click', () => {
    if (stage === 1) { location.assign('store.html'); return; }
    // While the payment is being confirmed there is nothing to go back to.
    if (confirming) return;
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
    // No vehicle, no model: the Komaki step goes, and so does anything chosen on it.
    if (input.name === 'vehicle' && input.value === 'no' && state.model !== null) {
      state.model = null;
      for (const radio of form.querySelectorAll('input[name="model"]')) radio.checked = false;
    }
    if (status) status.textContent = '';
    if (hint) hint.textContent = '';
    render();
    pulse();

    const owner = Object.keys(STEP_GROUP).map(Number).find((k) => STEP_GROUP[k] === input.name);
    if (fromPointer && owner) {
      // A beat so the tick visibly lands before the flow walks on.
      window.clearTimeout(advanceTimer);
      advanceTimer = window.setTimeout(
        () => goToStep(stepAfter(owner), true),
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
        const nextStep = stepAfter(owner);
        goToStep(nextStep, true);
        const first = stepAt(nextStep).querySelector('.opt__input');
        if (first) first.focus({ preventScroll: true });
        return;
      }
    }
    // In a details field, Enter is the keyboard's Next: on to the following field, which the
    // keyboard handling then keeps in view. Only the last field moves the flow on, so nobody
    // is told off for the fields below the one they have just finished.
    if (!opt) {
      const at = ALL_FIELDS.findIndex((k) => fieldEls[k] && fieldEls[k].input === event.target);
      const following = at >= 0 ? ALL_FIELDS.slice(at + 1).find((k) => fieldEls[k]) : null;
      if (following) {
        fieldEls[following].input.focus({ preventScroll: true });
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
    { at: 0, az: -0.86, el: 0.26, frame: P(0.52, 0.47), target: 0 },   // entry
    { at: 1, az: -0.62, el: 0.17, frame: P(0.62, 0.58), target: 0 },   // 1 PowerPod
    { at: 2, az: -0.50, el: -0.10, frame: P(0.50, 0.46), target: -6 }, // 2 Vehicle
    { at: 3, az: -0.34, el: 0.04, frame: P(0.56, 0.52), target: -4 },  // 3 Komaki
    { at: 4, az: -0.55, el: 0.19, frame: P(0.58, 0.54), target: 0 },   // 4 Review
  ];
  // Details and payment have no beat: the pod is not on screen for them (see scenes below).
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
  let lastShot = null; // what the pod was last told, for the checks

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
      // The ring belongs to the pod on its own. With the scooter up the field is the
      // scooter's, and on the other stages it lets go for their drawings (setForm, below).
      weight: scene === 'pod' && !rideOn ? weight * smoother(visibility(r)) : 0,
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

  // ---------------------------------------------------------------- scenes
  // What the stage shows: the pod while the PowerPod is being configured, then a drawing the
  // particle field gathers into, a profile while details are filled in and a rupee at
  // payment. The 3D pod is the heaviest thing on the page, so it is not drawn, and not even
  // built, while it is not the scene. Without the WebGL field, or with reduced motion, the
  // drawings are still SVGs on the stage instead (.pg2__glyph).
  const SCENES = { 1: 'pod', 2: 'profile', 3: 'rupee' };
  let scene = stageEl.dataset.scene || 'pod';
  const formOn = haloOn && root.classList.contains('gl') && typeof window.gridBG.setForm === 'function';
  stageEl.classList.toggle('is-glyph-static', !formOn);

  // Mounting waits for the pod's own stage, see boot3D.
  let podSceneWaiters = [];
  const whenPodScene = () => (scene === 'pod' ? Promise.resolve()
    : new Promise((resolve) => podSceneWaiters.push(resolve)));

  function setScene() {
    const next = SCENES[stage] || 'pod';
    if (next === scene) return;
    scene = next;
    stageEl.dataset.scene = next;
    sendForm();
    if (next === 'pod') {
      const waiting = podSceneWaiters;
      podSceneWaiters = [];
      for (const resolve of waiting) resolve();
    }
    startLoop();
  }

  // The drawings, as strokes in a unit box, y up, in grid-bg.js's stroke format:
  // ['line', x1, y1, x2, y2] | ['arc', cx, cy, r, deg0, deg1].
  // The profile is the familiar account glyph: a head, and shoulders cut off by the ring.
  function profileStrokes() {
    const cy = -0.95;
    const r = 0.68;
    // Where the shoulder arc meets the unit ring: r^2 + cy^2 + 2 cy r sin(a) = 1.
    const a = (Math.asin((1 - r * r - cy * cy) / (2 * cy * r)) * 180) / Math.PI;
    return {
      figure: [['arc', 0, 0.25, 0.32, 0, 360], ['arc', 0, cy, r, a, 180 - a]],
      ring: [['arc', 0, 0, 1, 0, 360]],
    };
  }

  // ₹: two bars, the bowl hanging off the top one, a short return to the left, and the leg.
  const RUPEE_STROKES = [
    ['line', -0.55, 0.9, 0.55, 0.9],
    ['line', -0.55, 0.52, 0.55, 0.52],
    ['arc', -0.06, 0.5, 0.4, 90, -90],
    ['line', -0.06, 0.1, -0.5, 0.1],
    ['line', -0.5, 0.1, 0.46, -0.95],
  ];

  // ---------------------------------------------------------------- the ride
  // The home film's "It comes with you" shot, on this stage and on a tap rather than a
  // scroll: the field gathers into the scooter (grid-bg.js carries the stroke table,
  // dockScooter) and the pod rolls onto its slant and slides into the bay. The numbers are
  // the film's (index.html: DOCK, CLOSE.entry), so the two compositions are the same one.
  const DOCK = {
    // Where the pod comes to rest, in the scooter's figure units: a centre and a long axis
    // rather than a box, base down into the left of the boot and top out to the right.
    pod: { x: 1.050, y: 0.490, len: 0.300, tilt: 45 },
    // The vehicle dock it lands in, in axis coordinates: `a` along the pod from its centre,
    // `b` across it, so the cradle follows the pod wherever the pod goes.
    cradle: { from: -0.20, to: -0.05, halfW: 0.085, lip: 0.022, plug: 0.032 },
    // How far up its own slant the pod starts, before it slides home.
    entry: 0.12,
  };
  // The drawing's extent in its own units: the floor line, fender tip to tail, and the top
  // of the leg shield. The form rect keeps this aspect, so the mapping is one uniform scale.
  const FIGURE = { x0: -0.20, x1: 1.85, y0: 0, y1: 1.0 };
  const FIG_SPAN = FIGURE.x1 - FIGURE.x0;
  const FIG_ASPECT = (FIGURE.y1 - FIGURE.y0) / FIG_SPAN;
  const toUnit = (x, y) => [
    ((x - (FIGURE.x0 + FIGURE.x1) / 2) * 2) / FIG_SPAN,
    ((y - (FIGURE.y0 + FIGURE.y1) / 2) * 2) / (FIGURE.y1 - FIGURE.y0),
  ];
  // The camera while the pod is in the bay: nearly side on, so it reads as part of the
  // machine, with the roll that lays it on the dock's slant.
  const RIDE_AZ = -0.30;
  const RIDE_EL = 0.06;
  const RIDE_ROLL = (DOCK.pod.tilt * Math.PI) / 180;
  const RIDE_SECONDS = 0.9;

  // The vehicle dock, as strokes in the scooter's figure units. Built from DOCK.pod rather
  // than written into a stroke table so the two can never drift apart. Open at the mouth,
  // because the pod has to visibly go into it.
  function dockCradle() {
    const Pd = DOCK.pod;
    const C = DOCK.cradle;
    const th = (Pd.tilt * Math.PI) / 180;
    const ax = [Math.cos(th), Math.sin(th)];   // along the pod, base to top
    const pe = [-Math.sin(th), Math.cos(th)];  // across it
    const at = (a, b) => [Pd.x + ax[0] * a + pe[0] * b, Pd.y + ax[1] * a + pe[1] * b];
    const seg = (a1, b1, a2, b2) => ['line', ...at(a1, b1), ...at(a2, b2)];
    const w = C.halfW;
    // A bracket hangs vertically in figure space, not along the pod's axis.
    const foot = (a, drop) => {
      const [x, y] = at(a, -w);
      return ['line', x, y, x, y - drop];
    };
    return [
      seg(C.from, -w, C.to, -w),                           // the two long walls
      seg(C.from, w, C.to, w),
      seg(C.from, -w, C.from, w),                          // closed base
      seg(C.to, w, C.to, w + C.lip),                       // a lip either side of the mouth
      seg(C.to, -w, C.to, -w - C.lip),
      seg(C.from + 0.015, -C.plug, C.from + 0.015, C.plug), // the connector the pod lands on
      // Two brackets dropping to the body underside, so the dock is bolted into the bay.
      foot(C.from + 0.005, 0.039),
      foot(C.from + 0.065, 0.062),
    ];
  }

  // Whether the ride is on screen: a vehicle wanted, on the configure stage, with a field
  // that can draw it. Without one the static glyph stands in (CSS, data-vehicle).
  let rideOn = false;
  let rideT = 0;        // 0 on the pod's own beat, 1 docked in the bay
  let rideRect = null;  // the scooter's box, viewport CSS px
  let stageRect = null; // the stage's, for the pod's lens

  // Where the scooter sits: most of the stage's width, and no more height than the film
  // gives it. Under 1025px the brand lockup floats over the top of the stage, so the box is
  // centred in what is left below it.
  function vehicleRect() {
    const r = stageEl.getBoundingClientRect();
    let top = r.top;
    if (stacked()) {
      const lockup = document.querySelector('.brand-lockup');
      if (lockup) top = Math.max(top, lockup.getBoundingClientRect().bottom);
    }
    const h = Math.max(1, r.bottom - top);
    const width = Math.min(r.width * P(0.94, 0.86), (h * 0.62) / FIG_ASPECT, 980);
    const height = width * FIG_ASPECT;
    return { left: r.left + (r.width - width) / 2, top: top + (h - height) / 2, width, height };
  }

  // The pod's place in the bay, as the pod module wants it: a lens shift to the bay's point
  // on this canvas and a frame so the pod is the dock's length. `away` is how far up its
  // slant it still is, in figure units.
  function bayShot(away) {
    const [ux, uy] = toUnit(DOCK.pod.x + away * Math.SQRT1_2, DOCK.pod.y + away * Math.SQRT1_2);
    const px = rideRect.left + (ux * 0.5 + 0.5) * rideRect.width;
    const py = rideRect.top + (0.5 - uy * 0.5) * rideRect.height;
    const nx = ((px - stageRect.left) / Math.max(1, stageRect.width)) * 2 - 1;
    const ny = 1 - ((py - stageRect.top) / Math.max(1, stageRect.height)) * 2;
    const podPx = DOCK.pod.len * (rideRect.width / FIG_SPAN);
    return { lens: { x: -nx / 2, y: ny / 2 }, frame: podPx / Math.max(1, stageRect.height) };
  }

  // Called from render(): the ride follows the choice, and the field is told the moment it
  // changes. Layout is read here, never per frame.
  function syncRide() {
    const want = formOn && stage === 1 && withVehicle();
    if (want === rideOn && (!want || rideRect)) return;
    rideOn = want;
    stageRect = stageEl.getBoundingClientRect();
    if (rideOn) rideRect = vehicleRect();
    if (scene === 'pod') sendForm();
    startLoop();
  }

  /**
   * A drawing as `count` points, ordered for the field. It only ever draws its first
   * particles, and fewer of them on a device the governor has thinned, so any prefix of the
   * list must read as the whole drawing. The sampler walks the strokes in order, so the points
   * are stepped through with a stride coprime to their number instead, which spreads every
   * prefix across the entire figure (as the home page's scooter does). A hair of scatter off
   * the line, so it reads as drawn rather than plotted; the dock, a machined part among
   * hand-drawn panels, gets a third of it.
   */
  const shapes = {};
  function shapePoints(key) {
    const api = window.gridBG;
    const count = api.capacity || 8000;
    if (shapes[key] && shapes[key].length === count * 2) return shapes[key];

    const sample = (strokes, n) => api.sampleVehicle({ height: 1, wheels: [], strokes }, n);
    let points;
    let hair = 0.012;
    let soft = () => 1;
    if (key === 'profile') {
      // The ring is sampled on its own and kept to about a third of the points. Shared out by
      // length it would take most of them and leave the figure inside it faint.
      const { figure, ring } = profileStrokes();
      const nRing = Math.round(count * 0.34);
      points = sample(figure, count - nRing).concat(sample(ring, nRing));
    } else if (key === 'scooter') {
      // The cradle is sampled separately: shared out by length it would take about 5% of the
      // points and read as more of the same scribble. It gets 14% and a third of the jitter,
      // which is what makes it read as hardware the pod sits in.
      const nCradle = Math.round(count * 0.14);
      const body = api.sampleVehicle(api.dockScooter, count - nCradle).map((p) => toUnit(p[0], p[1]));
      const cradle = sample(dockCradle(), nCradle).map((p) => toUnit(p[0], p[1]));
      points = body.concat(cradle);
      hair = 0.007;
      soft = (i) => (i >= body.length ? 0.35 : 1);
    } else {
      points = sample(RUPEE_STROKES, count);
    }

    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    let stride = Math.max(1, Math.round(points.length * 0.6180339887));
    while (gcd(stride, points.length) !== 1) stride++;
    // The scatter is hashed rather than stepped: a regular pattern rides the stride and shows
    // up along a straight stroke as a saw tooth.
    const scatter = (n) => {
      const x = Math.sin(n * 12.9898) * 43758.5453;
      return (x - Math.floor(x)) - 0.5;
    };
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const m = (i * stride) % points.length;
      const p = points[m];
      const j = hair * soft(m);
      out[i * 2] = p[0] + scatter(i + 0.17) * j;
      out[i * 2 + 1] = p[1] + scatter(i + 0.71) * j;
    }
    shapes[key] = out;
    return out;
  }

  // Where the drawing sits: a square in the open part of the stage, the same proportion of
  // it the halo ring takes. Under 1025px the brand lockup floats over the top of the stage, so
  // the square is centred in what is left below it.
  function formRect() {
    const r = stageEl.getBoundingClientRect();
    let top = r.top;
    if (stacked()) {
      const lockup = document.querySelector('.brand-lockup');
      if (lockup) top = Math.max(top, lockup.getBoundingClientRect().bottom);
    }
    const h = Math.max(1, r.bottom - top);
    // Capped, so on a wide desktop stage it stays a quiet mark rather than a poster.
    const side = Math.min(r.width * 0.6, h * 0.66, 300);
    return {
      left: r.left + (r.width - side) / 2,
      top: top + (h - side) / 2,
      width: side,
      height: side,
    };
  }

  function sendForm() {
    if (!formOn) return;
    const api = window.gridBG;
    if (scene === 'pod') {
      if (!rideOn) {
        api.setForm(null);
        return;
      }
      // The scooter is wider than the glyphs and has more line to it, so it takes more of
      // the field; still a fraction of what the pod costs to draw.
      const wanted = clamp(rideRect.width * 3.5, 900, 2600);
      api.setForm({ key: 'scooter', points: shapePoints('scooter'), rect: rideRect, density: wanted / (api.capacity || 8000) });
      return;
    }
    const rect = formRect();
    // A few points per pixel of width: enough to read as a line at any size while still
    // reading as particles, and a fraction of what the pod costs to draw.
    const wanted = clamp(rect.width * 5, 650, 1300);
    api.setForm({ key: scene, points: shapePoints(scene), rect, density: wanted / (api.capacity || 8000) });
  }

  // ---------------------------------------------------------------- one loop
  let pod = null;
  let rafId = 0;
  let last = 0;

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    // Paced with the particle field (assets/perf.js), so the two canvases draw together.
    if (window.GridPerf && !window.GridPerf.frame(now)) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;

    // Critically damped follow. Slower than the home page's 9 because the target here
    // jumps a whole beat at a time, so arrivals should settle rather than stop dead.
    const k = reduceMotion ? 30 : (phone ? 3.6 : 3.0);
    shotT += (clamp(shotTarget, 0, LAST_BEAT) - shotT) * (1 - Math.exp(-dt * k));

    // The ride: a clock that runs to 1 while the scooter is wanted and back to 0 when it is
    // not, so the pod slides in and out of the bay the same way.
    const want = rideOn ? 1 : 0;
    if (rideT !== want) rideT = clamp(rideT + (want ? dt : -dt) / RIDE_SECONDS, 0, 1);
    const ride = smoother(rideT);

    // Only on its own stage. Elsewhere its canvas fades out on the last frame it drew.
    if (pod && scene === 'pod') {
      const driftAz = reduceMotion ? 0 : Math.sin(now * 0.00017) * 0.004;
      const driftEl = reduceMotion ? 0 : Math.cos(now * 0.00013) * 0.003;
      let shot = shotAt(shotT);
      let offset = lens();
      if (ride > 0 && rideRect && stageRect) {
        // Into the bay: the beat's framing gives way to the dock's, the pod rolls onto the
        // slant, and the last of the way is a slide down it (DOCK.entry).
        const bay = bayShot(DOCK.entry * (1 - ride));
        shot = {
          az: mix(shot.az, RIDE_AZ, ride),
          el: mix(shot.el, RIDE_EL, ride),
          frame: mix(shot.frame, bay.frame, ride),
          target: mix(shot.target, 0, ride),
          roll: RIDE_ROLL * ride,
        };
        offset = { x: mix(offset.x, bay.lens.x, ride), y: mix(offset.y, bay.lens.y, ride) };
      }
      pod.setShot(shot, driftAz, driftEl, offset);
      lastShot = { shot, offset };
    }
    if (haloOn) stepHalo(dt, now);

    // Off the pod's stage there is nothing left to do here once the ring has let go: the
    // drawing is the particle field's own work. So the loop sleeps until the pod is back.
    if (scene !== 'pod' && (!haloOn || spec.weight < 0.002)) stopLoop();
  }

  function startLoop() {
    if (rafId || document.hidden || viewerOpen) return;
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
    stageRect = stageEl.getBoundingClientRect();
    // The drawings are pinned to the stage, so they move with it. Same drawing, so the field
    // just shifts to the new place rather than gathering again.
    if (rideOn) rideRect = vehicleRect();
    if (scene !== 'pod' || rideOn) sendForm();
    startLoop();
  };
  window.addEventListener('resize', onResize);
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(stageEl);

  // ---------------------------------------------------------------- the Komaki, up close
  // Each model's picture, full size over everything, on a tap and on nothing else: the large
  // file is fetched then, not with the page, and the image is removed again on the X. The
  // page's own canvases sleep while it is up.
  const VIEWER_SRC = {
    // From the site's root, so a page in a language folder (hi/powerpod-gen2.html) finds them.
    x1: (window.GRID_ROOT || '') + 'assets/productImages/store/komaki-x1-large.webp',
    x3: (window.GRID_ROOT || '') + 'assets/productImages/store/komaki-x3-large.webp',
  };
  const viewer = document.getElementById('pg2-viewer');
  const viewerPic = document.getElementById('pg2-viewer-pic');
  const viewerTitle = document.getElementById('pg2-viewer-title');
  const viewerClose = document.getElementById('pg2-viewer-close');
  let viewerOpen = false;
  let viewerTrigger = null;
  // Opening pushes a history entry, so a phone's back gesture closes the view rather than
  // leaving the page. Closing from the X goes back through history for the same reason,
  // so there is exactly one way out and the entry never lingers.
  let viewerPushed = false;

  function openViewer(model, trigger) {
    if (!viewer || !viewerPic || !VIEWER_SRC[model] || viewerOpen) return;
    viewerOpen = true;
    viewerTrigger = trigger || null;
    if (viewerTitle) viewerTitle.textContent = MODELS[model];
    viewer.dataset.loaded = 'false';
    viewer.dataset.model = model;

    const pic = document.createElement('img');
    pic.className = 'pg2-viewer__img';
    pic.alt = MODELS[model];
    pic.decoding = 'async';
    // Either way the ring goes: a picture that failed is a blank, never a spinner for good.
    const shown = () => { viewer.dataset.loaded = 'true'; };
    pic.addEventListener('load', shown);
    pic.addEventListener('error', shown);
    pic.src = VIEWER_SRC[model];
    viewerPic.replaceChildren(pic);

    viewer.hidden = false;
    root.classList.add('is-viewing');
    stopLoop();
    if (window.gridBG && typeof window.gridBG.pause === 'function') window.gridBG.pause();
    try {
      history.pushState({ pg2Viewer: model }, '');
      viewerPushed = true;
    } catch {
      viewerPushed = false;
    }
    track('vehicle_view', { model });
    if (viewerClose) viewerClose.focus({ preventScroll: true });
  }

  function closeViewer(viaHistory) {
    if (!viewerOpen) return;
    if (viewerPushed && !viaHistory) {
      history.back(); // popstate brings us back here with viaHistory set
      return;
    }
    viewerPushed = false;
    viewerOpen = false;
    if (viewerPic) viewerPic.replaceChildren();
    viewer.hidden = true;
    root.classList.remove('is-viewing');
    if (window.gridBG && typeof window.gridBG.resume === 'function') window.gridBG.resume();
    startLoop();
    if (viewerTrigger && viewerTrigger.focus) viewerTrigger.focus({ preventScroll: true });
    viewerTrigger = null;
  }

  form.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    // The button sits inside the card's label: the tap opens the view and leaves the radio
    // exactly as it was.
    event.preventDefault();
    openViewer(button.dataset.view, button);
  });
  if (viewerClose) viewerClose.addEventListener('click', () => closeViewer(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && viewerOpen) {
      event.preventDefault();
      closeViewer(false);
    }
  });
  window.addEventListener('popstate', () => {
    if (viewerOpen) closeViewer(true);
  });

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

    // three.js, the model and the scene module download side by side (assets/pod-assets.js);
    // they used to come one after another, three round trips back to back.
    if (!window.GridPodAssets) return;
    Promise.all([window.GridPodAssets.load(), loadScript((window.GRID_ROOT || '') + 'assets/powerpod-3d.js')])
      .then(async ([assets]) => {
        if (!window.gridPod) return;
        // The download can run whenever, but building the pod compiles every material on the
        // main thread. Someone typing their details should never be competing with that, so
        // the build waits until the pod is the scene again.
        await whenPodScene();
        // Built in idle slices; resolves once it can draw without stalling a frame.
        pod = await window.gridPod.mount({
          canvas: podCanvas,
          assets,
          phone,
          onContextLost: () => {
            pod = null;
            stageEl.classList.remove('is-pod-live');
          },
        });
        if (!pod) return;
        pod.resize();
        stageRect = stageEl.getBoundingClientRect();
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

  // Two GL contexts share this device, and one governor paces both (assets/perf.js). While the
  // device is struggling with the pod on screen it draws the pod a little under full density,
  // and gives that back as soon as it can. The densities are the governor's (podRatios), the
  // same ones the home page's pod uses.
  function watchQuality() {
    const perf = window.GridPerf;
    if (!perf || !pod) return;
    const steps3d = perf.podRatios(phone);
    perf.registerPod(steps3d.length - 1);
    let level = -1;
    const follow = (p) => {
      if (!pod || p.podLevel === level) return;
      level = p.podLevel;
      // Through the handle, not the renderer: the module caps the ratio by buffer area on
      // every resize, so a value written straight onto the renderer would not survive one.
      pod.setPixelRatio(level > 0 ? steps3d[Math.min(steps3d.length - 1, level)] : 0);
    };
    perf.on(follow);
    follow(perf);
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
  async function createOrder() {
    if (!window.gridxApi) {
      throw new Error(t('Could not reach GridX. Please check your connection and try again.'));
    }
    // A fresh token per attempt: they are single use and expire in minutes.
    const token = window.gridxApi.recaptchaToken
      ? await window.gridxApi.recaptchaToken('create_order')
      : null;
    return window.gridxApi.postJSON('/api/public/website/orders', {
      build: {
        vehicle: state.vehicle,
        model: withVehicle() ? state.model : null,
        pay: state.pay,
      },
      customer: { ...details },
      recaptcha: { token, action: 'create_order' },
    });
  }

  /**
   * The phone as Razorpay wants it, +91 and ten digits. Checkout opens with the contact
   * locked (readonly below), so a number it could not parse would leave nothing to fix.
   */
  function checkoutContact(phoneNumber) {
    const digits = String(phoneNumber || '').replace(/\D/g, '');
    const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.slice(-10);
    return ten.length === 10 ? `+91${ten}` : undefined;
  }

  function openCheckout(created) {
    return window.gridxApi.loadRazorpay().then(() => new Promise((resolve, reject) => {
      if (!window.Razorpay) {
        reject(new Error(t('The payment window could not load. Please refresh and try again.')));
        return;
      }
      let settled = false;
      const rzp = new window.Razorpay({
        key: created.keyId,
        order_id: created.razorpayOrderId,
        amount: created.amountPaise,
        currency: 'INR',
        name: 'GridX Energy',
        description: t('{what} pre-booking, {order}', { what: towards(), order: created.orderNumber }),
        // Filed under this customer in Razorpay, which also emails them its receipt.
        customer_id: created.customerId || undefined,
        prefill: {
          name: created.customer?.name || details.name,
          email: created.customer?.email || details.email,
          contact: checkoutContact(created.customer?.phone || details.phone),
        },
        // What Paddock stored is what Razorpay records, and where its receipt goes.
        readonly: { name: true, email: true, contact: true },
        // No `notes` here, on purpose. Checkout notes come from the browser, so nothing
        // trusts them; Paddock writes the order's notes itself, server side.
        theme: { color: '#141414' },
        // Presentational only. The webhook is what actually confirms the money and sends
        // the receipt, so this handler never claims more than "we have it from here".
        handler() {
          settled = true;
          track('payment_success');
          resolve(created);
        },
        modal: {
          ondismiss() {
            if (settled) return;
            track('payment_dismissed');
            reject(new Error(t('Payment was cancelled. Your order is saved, you can try again.')));
          },
        },
      });
      rzp.on('payment.failed', (response) => {
        settled = true;
        track('payment_failed');
        // Razorpay's own words are English; a translated page says it in its own.
        const said = window.gridLang && window.gridLang.code !== 'en' ? '' : response?.error?.description;
        reject(new Error(said || t('That payment did not go through. Please try again.')));
      });
      rzp.open();
      track('payment_open');
    }));
  }

  function pay() {
    // One order per press: a second tap while the first is still being set up would create a
    // second order and open a second payment window.
    if (busy || paid) return;
    if (!launchOpen()) {
      if (status) status.textContent = NOT_OPEN;
      render();
      return;
    }
    for (const key of ALL_FIELDS) details[key] = fieldEls[key] ? fieldEls[key].input.value.trim() : '';
    // Uppercased here so the browser and the server normalize identically.
    if (details.gstin && window.gridGstin) details.gstin = window.gridGstin.normalize(details.gstin);
    // gen2 is Paddock's SKU for the PowerPod; taking it with a Komaki means collecting both
    // at the dealership, and on its own it is shipped.
    track('order_submit', {
      sku: 'gen2',
      intent: 'reserve',
      delivery: withVehicle() ? 'dealership' : 'ship',
      model: withVehicle() ? state.model : 'none',
    });
    busy = true;
    if (status) status.textContent = t('Setting up your payment.');
    render();

    createOrder()
      .then((created) => {
        // Paddock priced it. If that is not what the page said, the page changes before the
        // Razorpay window opens rather than after, so the two never disagree on screen. It is
        // what gets charged either way.
        if ([created.itemsInr, created.feeInr, created.chargedInr].every(Number.isFinite)) {
          quoted = {
            itemsInr: created.itemsInr,
            feeInr: created.feeInr,
            chargedInr: created.chargedInr,
            startsAtInr: Number.isFinite(created.startsAtInr) ? created.startsAtInr : null,
          };
          renderBill();
        }
        // Still busy: the payment window is opening, and it is the window that settles this.
        if (status) status.textContent = '';
        render();
        return openCheckout(created);
      })
      .then((created) => confirmPayment(created))
      .catch((err) => {
        busy = false;
        if (status) status.textContent = err.message;
        render();
      });
  }

  /**
   * Razorpay's window closed happily. The webhook is what actually marks the pre-booking
   * paid, so the page now waits for its word (assets/pay-confirm.js), the ring spinning in
   * the done card, and only then says so. If pay-confirm.js is somehow missing (a cached
   * page mid-deploy), this behaves exactly as it always did: the display-only confirmation,
   * so a partial deploy can never break a payment.
   */
  function confirmPayment(created) {
    if (status) status.textContent = '';
    if (!window.gridPayConfirm) {
      paid = true;
      busy = false;
      showConfirmation(created, null);
      render();
      return undefined;
    }

    // Still busy, with the segment held halfway and the button resting on "Confirming":
    // nothing can take a second press while the poll runs.
    confirming = true;
    if (payView) payView.hidden = true;
    scroller.scrollTop = 0;
    nextBtn.hidden = true;
    const done = document.getElementById('pg2-done');
    if (done) {
      window.gridPayConfirm.showPending(done, {
        pending: t('Payment received. We are confirming your pre-booking.'),
      });
    }
    render();

    return window.gridPayConfirm.confirm(created.orderNumber, details.phone).then((result) => {
      if (result && result.cancelled) return;
      paid = true;
      busy = false;
      confirming = false;
      showConfirmation(created, result);
      render();
    });
  }

  /**
   * The customer is done. With pay-confirm.js on the page the card's contents are its:
   * the confirmed pre-booking once the webhook has answered, or the quiet keep-an-eye-out
   * version if it outran the wait. Without it, the old display-only card, word for word.
   */
  function showConfirmation(created, result) {
    const view = views[LAST_STAGE - 1];
    if (!view) return;
    // The payment page has been acted on. The confirmation carries its own title.
    if (payView) payView.hidden = true;
    scroller.scrollTop = 0;

    const done = document.getElementById('pg2-done');
    if (done) {
      if (window.gridPayConfirm && result) {
        const opts = {
          reference: created.orderNumber,
          email: details.email,
          phone: details.phone,
          kind: 'prebook',
        };
        if (result.paid) window.gridPayConfirm.showPaid(done, opts);
        else window.gridPayConfirm.showTimeout(done, opts);
      } else {
        done.hidden = false;
        const ref = document.getElementById('pg2-done-ref');
        if (ref) ref.textContent = created.orderNumber;
        const where = document.getElementById('pg2-done-where');
        if (where) {
          where.textContent = t('Your pre-booking is confirmed. We have sent your receipt voucher to {email} and on WhatsApp to {phone}.', { email: details.email, phone: details.phone });
        }
        const to = document.getElementById('pg2-done-to');
        if (to) to.textContent = '';
        const heading = done.querySelector('h3');
        if (heading) heading.focus?.();
      }
    }
    nextBtn.hidden = true;
  }

  // ---------------------------------------------------------------- the on-screen keyboard
  // The page is a fixed shell, and a phone's keyboard shrinks only the visual viewport. While
  // one is up the panel takes exactly the visible area above it and the field being typed in
  // is scrolled into view inside it (html.is-typing, --vv-top and --vv-h on .pg2, see section
  // 16 of the stylesheet). The mechanics are assets/keyboard.js, which every form on the site
  // shares; it was lifted out of this file unchanged. Event driven only: nothing runs per frame.
  if (window.gridKeyboard) {
    window.gridKeyboard.watch({ shell: document.querySelector('.pg2'), scope: panel, scroller });
  }

  // ---------------------------------------------------------------- go
  // For tools/check/gen2.mjs, only with ?check in the address: where the ride put things.
  if (new URLSearchParams(location.search).has('check')) {
    window.__pg2 = {
      get ride() {
        const bay = rideRect && stageRect ? bayShot(0) : null;
        return {
          rideOn, rideT, rideRect, stageRect, live: Boolean(pod),
          bay,
          // How far out the camera sits for the bay, against how far it can see: a pod on
          // the far plane draws as a dot.
          dist: pod && bay ? pod.frameDist(bay.frame) : null,
          far: pod ? pod.camera.far : null,
          last: lastShot,
        };
      },
    };
  }
  // Stage 1 already carries is-active in the markup, so there is no flash of an empty
  // panel before this runs; the camera just needs pointing at the first step.
  stageRect = stageEl.getBoundingClientRect();
  render();
  // The page can be open across the launch: at that moment the holds lift and their sentence
  // goes, without a reload. Called at once with the current state, which render() just drew.
  if (launch) {
    launch.subscribe((open) => {
      if (!open) return;
      if (hint && hint.textContent === NOT_OPEN) hint.textContent = '';
      if (status && status.textContent === NOT_OPEN) status.textContent = '';
      render();
    });
  }
  goToStep(1, false);
  // Also only with ?check: open straight on a state, for Safari in the iOS Simulator, which
  // cannot be scripted. &build=pod|x1|x3 answers the choices through the real radios and
  // shows the review, and &stage=2 or 3 walks on, the payment page with a made-up buyer in
  // the details.
  const checkAt = new URLSearchParams(location.search);
  if (checkAt.has('check')) {
    const picks = { pod: { vehicle: 'no' }, x1: { vehicle: 'yes', model: 'x1' }, x3: { vehicle: 'yes', model: 'x3' } }[checkAt.get('build')];
    for (const [name, value] of Object.entries(picks || {})) {
      const input = form.querySelector(`input[name="${name}"][value="${value}"]`);
      if (input) input.click();
    }
    const to = clamp(Number(checkAt.get('stage')) || 1, 1, LAST_STAGE);
    if (to === LAST_STAGE) {
      const buyer = { name: 'Asha Verma', phone: '9876543210', email: 'asha@example.com', city: 'Raipur', pincode: '492001' };
      for (const [key, value] of Object.entries(buyer)) {
        if (fieldEls[key]) fieldEls[key].input.value = value;
        details[key] = value;
      }
    }
    if (to > 1) goToStage(to, 'fwd', false);
    else if (picks) goToStep(LAST_STEP, true);
  }
  counting = true;
  startLoop();
  window.addEventListener('load', () => {
    if ('requestIdleCallback' in window) requestIdleCallback(boot3D, { timeout: 1200 });
    else window.setTimeout(boot3D, 300);
  });
})();
