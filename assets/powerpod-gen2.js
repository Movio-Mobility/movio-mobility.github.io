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
 * 3. Particle field:  on the configure stage, setHalo only, gathered on a pod sized square
 *                     in the middle of the stage, firming up briefly whenever a choice is
 *                     made. On details and payment the pod steps aside and the field gathers
 *                     into a drawing instead (setForm): a profile, then a rupee. Never setPod:
 *                     that path seizes scroll control for good (grid-bg.js takeScroll).
 *                     The stage is also made inert, see swallowing below.
 * 4. The 3D pod:      1.8 MB of Three.js and mesh data, loaded on idle. The flow is fully
 *                     usable before any of it arrives, and stays usable if none does. It
 *                     only draws on the configure stage, and is not even built off it.
 * 5. Payment:         one way to pay, a reservation, then the full bill before Razorpay.
 * 6. The keyboard:    while an on-screen keyboard is up the panel fits itself above it and
 *                     keeps the field being typed in on screen.
 * 7. Analytics:       each step the buyer reaches (configurator_step, a short slug, once a
 *                     page), the reservation going in (order_submit: the SKU and whether it is
 *                     collected or shipped) and what Razorpay's window did. Nothing typed.
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
  const CHEAPEST_CHARGER = 2199;
  const CHOICES = ['vehicle', 'charger', 'adapter', 'dock'];

  // The reservation, the only way to pay on this page: an advance against the PowerPod, with
  // Razorpay's fee passed on as a platform fee. Paddock decides both (RESERVE_FEE_INR and
  // GATEWAY_FEE_RATE in its pricing.js), and Razorpay is charged against Paddock's figure.
  // This is what the page prints until Paddock's own quote arrives; the quote wins.
  const RESERVE_INR = 500;
  // Every line is taxed at 18% and every price already includes it (Paddock's pricing.js:
  // one rate on every line). Only used to print the breakdown; the invoice is Paddock's.
  const GST_RATE = 0.18;
  // Chhattisgarh's PIN codes by their first three digits. GridX is registered there (Paddock's
  // HOME_STATE_CODE 22), so a PowerPod shipped there is an intrastate supply.
  const HOME_PIN = [490, 497];

  // Nothing is preselected. Every group answers null until the buyer says otherwise. pay is
  // the exception because there is nothing to choose: it is always a reservation.
  const state = { vehicle: null, charger: null, adapter: null, dock: null, pay: 'reserve' };
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
  // Paise only when there are paise, so a round figure does not read as ₹500.00.
  const money = cat ? cat.money : (n) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)}`;

  const priceOf = (group) => (state[group] ? CATALOG[group][state[group]].price : 0);
  const subtotal = () => CATALOG.base.price + priceOf('adapter') + priceOf('dock');
  const total = () => subtotal() + priceOf('charger');
  const fromPrice = () => subtotal() + CHEAPEST_CHARGER;
  const configured = () => CHOICES.every((g) => state[g] !== null);

  // What today's payment comes to. Paddock's own figures once createOrder() has answered,
  // and until then the same arithmetic it uses: the fee grossed up, not marked up.
  let quoted = null;
  function reservation() {
    if (quoted) return quoted;
    const chargedInr = cat ? cat.grossUp(RESERVE_INR) : RESERVE_INR;
    return { itemsInr: RESERVE_INR, feeInr: round2(chargedInr - RESERVE_INR), chargedInr };
  }

  // The order's lines, as Paddock's selectionsFromBuild() turns a build into SKUs.
  function orderLines() {
    const lines = [{ label: CATALOG.base.label, price: CATALOG.base.price }];
    const c = state.charger ? CATALOG.charger[state.charger] : null;
    if (c) lines.push({ label: c.summary, price: c.price });
    for (const g of ['adapter', 'dock']) {
      if (state[g] === 'yes') lines.push({ label: CATALOG[g].yes.summary, price: CATALOG[g].yes.price });
    }
    return lines;
  }

  // Place of supply, as Paddock's composeOrder() decides it. Collecting at a dealership is an
  // over the counter supply in our own state; a shipment goes by its PIN code. Paddock reads
  // the state off a table of postal circles and treats a PIN it does not recognise as
  // intrastate. Only the home state's range is known here, so such a PIN shows IGST on this
  // bill; the tax invoice at the final payment is Paddock's either way.
  function interstate() {
    if (state.vehicle === 'yes') return false;
    const prefix = Number(String(details.pincode || '').trim().slice(0, 3));
    return !(prefix >= HOME_PIN[0] && prefix <= HOME_PIN[1]);
  }

  /**
   * The GST inside the order value, line by line, exactly as Paddock's pricingCore.js does
   * it: each tax inclusive line is split into taxable value and tax (splitInclusive), the tax
   * apportioned to CGST and SGST or to IGST (apportionTax), and the rounded lines summed, so
   * this agrees with the eventual tax invoice to the paisa.
   */
  function orderTax(lines, across) {
    const sum = { value: 0, taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0 };
    for (const line of lines) {
      const taxable = round2(line.price / (1 + GST_RATE));
      const tax = round2(line.price - taxable);
      const cgst = across ? 0 : round2(tax / 2);
      sum.value += line.price;
      sum.taxable += taxable;
      sum.tax += tax;
      sum.cgst += cgst;
      sum.sgst += across ? 0 : round2(tax - cgst);
      sum.igst += across ? tax : 0;
    }
    for (const k of Object.keys(sum)) sum[k] = round2(sum[k]);
    return sum;
  }

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

  // ---------------------------------------------------------------- analytics
  // Through the queue gridx-api.js sets up. Each step is counted the first time this page
  // reaches it, so walking back and forth through the list does not count it again.
  const track = (name, props) => {
    if (typeof window.gridTrack === 'function') window.gridTrack(name, props);
  };
  const STEP_SLUG = ['powerpod', 'vehicle', 'charger', 'adapter', 'dock', 'review'];
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
  // Payment has nothing left to choose, so it can always move on: from the offer to the bill,
  // and from the bill to Razorpay.
  function canAdvance(n) {
    if (n === 1) return configured();
    if (n === 2) return detailsValid();
    return !busy && !paid;
  }

  const HINTS = {
    1: 'Choose an option in every step to continue.',
    2: 'Please complete the fields above.',
  };

  // ---------------------------------------------------------------- render
  const backBtn = document.getElementById('pg2-back');
  const nextBtn = document.getElementById('pg2-next');
  const nextLabel = document.getElementById('pg2-next-label');
  const totalLabel = document.getElementById('pg2-total-label');
  const totalAmount = document.getElementById('pg2-total');
  const hint = document.getElementById('pg2-hint');
  const status = document.getElementById('pg2-status');
  const footTax = document.getElementById('pg2-foot-tax');
  const dealerNote = document.getElementById('pg2-dealer');
  const reviewList = document.getElementById('pg2-review');
  const payReserve = document.getElementById('pg2-pay-reserve');
  const payReview = document.getElementById('pg2-pay-review');
  const reserveBtn = document.getElementById('pg2-reserve');
  const bill = document.getElementById('pg2-bill');
  const moneyEls = [...document.querySelectorAll('[data-money]')];
  const segs = [...document.querySelectorAll('.pg2-progress__seg')];
  const optEls = [...form.querySelectorAll('.opt[data-group]')];

  let paid = false;
  let busy = false;
  // The payment stage has two beats: the offer ('reserve'), then the bill ('review').
  let payStep = 'reserve';

  function render() {
    for (const el of optEls) {
      el.dataset.selected = String(state[el.dataset.group] === el.dataset.value);
    }

    const r = reservation();
    if (stage === LAST_STAGE) {
      // At payment the footer speaks for today's payment, not the PowerPod's price: the
      // redeemable amount, and the fee that rides on top of it.
      totalLabel.textContent = paid ? 'Paid' : (payStep === 'review' ? 'Reservation' : 'Reserve for');
      totalAmount.textContent = money(paid ? r.chargedInr : r.itemsInr);
      footTax.textContent = paid
        ? `${money(r.itemsInr)} comes off your final payment`
        : (r.feeInr > 0 ? `+ ${money(r.feeInr)} platform fee` : 'No platform fee');
    } else {
      // Footer total. "From" until a charger is chosen, because that is the only group with
      // no free option, so it is the only one that can move the floor.
      const priced = state.charger !== null;
      totalLabel.textContent = priced ? 'Total' : 'From';
      totalAmount.textContent = money(priced ? total() : fromPrice());
      footTax.textContent = '(inclusive of all taxes)';
    }
    for (const el of moneyEls) {
      if (el.dataset.money === 'reserve') el.textContent = money(r.itemsInr);
    }

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
      paid ? 100 : (stage === LAST_STAGE && payStep === 'review' ? 50 : 0),
    ];
    segs.forEach((seg, i) => {
      seg.querySelector('.pg2-progress__fill').style.setProperty('--fill', `${Math.round(fills[i])}%`);
      const n = i + 1;
      seg.dataset.state = n === stage ? 'current' : (n < stage ? 'done' : 'todo');
    });

    // Back: out to the store from the first stage, one stage back from the others, and from
    // the bill back to the offer.
    const onBill = stage === LAST_STAGE && payStep === 'review' && !paid;
    backBtn.setAttribute('aria-label', stage === 1 ? 'Back to the store'
      : (onBill ? 'Back to the reservation' : 'Back to the previous stage'));

    // Primary action. On the bill it names the exact amount Razorpay is about to ask for.
    nextBtn.setAttribute('aria-disabled', String(!canAdvance(stage)));
    if (stage !== LAST_STAGE) nextLabel.textContent = 'Continue';
    else nextLabel.textContent = payStep === 'review' ? `Pay ${money(r.chargedInr)}` : 'Reserve Now';

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

  /**
   * The bill: the last thing on screen before Razorpay opens, so it says everything. What the
   * order is and what it is worth, the GST inside that, what is paid today and why, and what
   * is left to pay at the end. Every label is ours and every figure is a number, so it is
   * built as markup like the review list above.
   */
  function renderBill() {
    if (!bill) return;
    const lines = orderLines();
    const across = interstate();
    const tax = orderTax(lines, across);
    const r = reservation();
    const balance = round2(tax.value - r.itemsInr);

    const row = (label, value, mod = '', note = '') => `<li class="bill__row${mod ? ` bill__row--${mod}` : ''}">`
      + `<span class="bill__label">${label}${note ? `<small class="bill__aside">${note}</small>` : ''}</span>`
      + `<span class="bill__value">${value}</span></li>`;
    const group = (title, rows, after = '') => `<section class="bill__group">`
      + `<h3 class="bill__title">${title}</h3><ul class="bill__rows">${rows.join('')}</ul>${after}</section>`;

    const order = lines.map((l) => row(l.label, money(l.price)));
    if (state.vehicle === 'yes') order.push(row('EV two wheeler', 'At the dealership', 'soft'));
    order.push(row('GridX-Pro Pack', 'Free for the first year', 'soft'));
    order.push(row('Order value, incl. GST', money(tax.value), 'total'));

    const gst = [row('Taxable value', money(tax.taxable))];
    if (across) {
      gst.push(row('IGST @ 18%', money(tax.igst)));
    } else {
      gst.push(row('CGST @ 9%', money(tax.cgst)));
      gst.push(row('SGST @ 9%', money(tax.sgst)));
    }
    gst.push(row('Total GST', money(tax.tax), 'total'));

    const now = [row('Reservation amount', money(r.itemsInr), '', 'Redeemable at your final payment')];
    if (r.feeInr > 0) now.push(row('Platform fee', money(r.feeInr), '', 'Payment processing'));
    now.push(row('GST', money(0), '', 'None on an advance for goods'));
    now.push(row('Total payable now', money(r.chargedInr), 'total'));

    const later = [
      row('Order value', money(tax.value)),
      row('Less your reservation', `−${money(r.itemsInr)}`),
      row('Balance', money(balance), 'total',
        state.vehicle === 'yes' ? 'Plus your two wheeler, priced at the dealership' : ''),
    ];

    bill.innerHTML = group('Your order', order)
      + group('GST included in your order', gst,
        '<p class="bill__note">Billed on your tax invoice at the final payment, not today.</p>')
      + group('Pay now', now)
      + group('At your final payment', later)
      + `<p class="bill__note bill__note--end">Your ${money(r.itemsInr)} reservation is fully redeemable: it comes off `
      + 'your PowerPod amount when you make the final payment. The platform fee covers payment processing '
      + 'and is not part of what is deducted. Your receipt voucher will be sent by email and on WhatsApp.</p>';
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

    // Payment always opens on the offer. Coming back to it from details starts it over.
    if (stage === LAST_STAGE && !paid) showPayStep('reserve');
    if (stage === 2) stepReached('details');
    if (stage === LAST_STAGE) stepReached('reserve');

    // Stage 1 hands the camera back to whichever step is in play. The other two are not the
    // pod's: it stops drawing and the field gathers into their drawing instead.
    if (stage === 1) goToStep(currentStep, false);
    else setArt('idle');
    setScene();
    render();

    if (focus !== false) focusTitle(el);
  }

  // The visible title of a view: the payment stage holds two, one per beat.
  function focusTitle(view) {
    const title = [...view.querySelectorAll('.pg2-step__title')].find((t) => !t.closest('[hidden]'));
    if (title) title.focus({ preventScroll: true });
  }

  // The payment stage's two beats. Hidden, not removed, so the bill can be rebuilt in place
  // and Back is a matter of showing the offer again.
  function showPayStep(step, dir) {
    payStep = step;
    if (payReserve) {
      payReserve.hidden = step !== 'reserve';
      payReserve.dataset.dir = dir === 'back' ? 'back' : 'fwd';
    }
    if (payReview) {
      payReview.hidden = step !== 'review';
      payReview.dataset.dir = dir === 'back' ? 'back' : 'fwd';
    }
    if (step === 'review') renderBill();
  }

  function goToPayStep(step, dir) {
    if (stage !== LAST_STAGE || paid || step === payStep) return;
    showPayStep(step, dir);
    if (step === 'review') stepReached('bill');
    scroller.scrollTop = 0;
    if (status) status.textContent = '';
    render();
    focusTitle(views[LAST_STAGE - 1]);
  }

  // The pod moves here and only here: on a selection, or on a stage change. Never on
  // scroll.
  function goToStep(n, scrollThere) {
    currentStep = stage === 1 ? clamp(n, 1, LAST_STEP) : currentStep;
    if (stage === 1) stepReached(STEP_SLUG[clamp(n, 1, LAST_STEP) - 1]);
    shotTarget = n;
    setArt(ART[n] || 'idle');
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
      }
      return;
    }
    if (stage === LAST_STAGE) {
      if (payStep === 'reserve') goToPayStep('review', 'fwd');
      else pay();
      return;
    }
    goToStage(stage + 1, 'fwd');
  }

  if (reserveBtn) reserveBtn.addEventListener('click', () => goToPayStep('review', 'fwd'));

  nextBtn.addEventListener('click', tryAdvance);

  backBtn.addEventListener('click', () => {
    if (stage === 1) { location.assign('store.html'); return; }
    if (stage === LAST_STAGE && payStep === 'review' && !paid && !busy) {
      goToPayStep('reserve', 'back');
      return;
    }
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
    { at: 0, az: -0.86, el: 0.26, frame: P(0.52, 0.47), target: 0 },              // entry
    { at: 1, az: -0.62, el: 0.17, frame: P(0.62, 0.58), target: 0 },              // 1 PowerPod
    { at: 2, az: -0.50, el: -0.10, frame: P(0.50, 0.46), target: -6 },            // 2 Vehicle
    { at: 3, az: -0.34, el: -0.28, frame: P(0.92, 1.05), target: P(-120, -140) }, // 3 Charger: the contacts
    { at: 4, az: -0.95, el: 0.10, frame: P(0.60, 0.54), target: 6 },              // 4 Adapter: carried
    { at: 5, az: -0.20, el: 0.06, frame: P(0.62, 0.60), target: -10 },            // 5 Dock: face on
    { at: 6, az: -0.55, el: 0.19, frame: P(0.58, 0.54), target: 0 },              // 6 Review
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
      // The ring belongs to the pod. On the other stages it lets go, and the drawing that
      // takes the pod's place is gathered by the field itself (setForm, below).
      weight: scene === 'pod' ? weight * smoother(visibility(r)) : 0,
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

  /**
   * A drawing as `count` points, ordered for the field. It only ever draws its first
   * particles, and fewer of them on a device the governor has thinned, so any prefix of the
   * list must read as the whole drawing. The sampler walks the strokes in order, so the points
   * are stepped through with a stride coprime to their number instead, which spreads every
   * prefix across the entire figure (as the home page's scooter does). A hair of scatter off
   * the line, so it reads as drawn rather than plotted.
   */
  const shapes = {};
  function shapePoints(key) {
    const api = window.gridBG;
    const count = api.capacity || 8000;
    if (shapes[key] && shapes[key].length === count * 2) return shapes[key];

    const sample = (strokes, n) => api.sampleVehicle({ height: 1, wheels: [], strokes }, n);
    let points;
    if (key === 'profile') {
      // The ring is sampled on its own and kept to about a third of the points. Shared out by
      // length it would take most of them and leave the figure inside it faint.
      const { figure, ring } = profileStrokes();
      const nRing = Math.round(count * 0.34);
      points = sample(figure, count - nRing).concat(sample(ring, nRing));
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
      const p = points[(i * stride) % points.length];
      out[i * 2] = p[0] + scatter(i + 0.17) * 0.012;
      out[i * 2 + 1] = p[1] + scatter(i + 0.71) * 0.012;
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
      api.setForm(null);
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

    // Only on its own stage. Elsewhere its canvas fades out on the last frame it drew.
    if (pod && scene === 'pod') {
      const driftAz = reduceMotion ? 0 : Math.sin(now * 0.00017) * 0.004;
      const driftEl = reduceMotion ? 0 : Math.cos(now * 0.00013) * 0.003;
      pod.setShot(shotAt(shotT), driftAz, driftEl, lens());
    }
    if (haloOn) stepHalo(dt, now);

    // Off the pod's stage there is nothing left to do here once the ring has let go: the
    // drawing is the particle field's own work. So the loop sleeps until the pod is back.
    if (scene !== 'pod' && (!haloOn || spec.weight < 0.002)) stopLoop();
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
    // The drawing is pinned to the stage, so it moves with it. Same drawing, so the field
    // just shifts to the new place rather than gathering again.
    if (scene !== 'pod') sendForm();
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

    // three.js, the model and the scene module download side by side (assets/pod-assets.js);
    // they used to come one after another, three round trips back to back.
    if (!window.GridPodAssets) return;
    Promise.all([window.GridPodAssets.load(), loadScript('assets/powerpod-3d.js')])
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
    const steps = perf.podRatios(phone);
    perf.registerPod(steps.length - 1);
    let level = -1;
    const follow = (p) => {
      if (!pod || p.podLevel === level) return;
      level = p.podLevel;
      // Through the handle, not the renderer: the module caps the ratio by buffer area on
      // every resize, so a value written straight onto the renderer would not survive one.
      pod.setPixelRatio(level > 0 ? steps[Math.min(steps.length - 1, level)] : 0);
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
      throw new Error('Could not reach GridX. Please check your connection and try again.');
    }
    // A fresh token per attempt: they are single use and expire in minutes.
    const token = window.gridxApi.recaptchaToken
      ? await window.gridxApi.recaptchaToken('create_order')
      : null;
    return window.gridxApi.postJSON('/api/public/website/orders', {
      build: {
        vehicle: state.vehicle,
        charger: state.charger,
        adapter: state.adapter,
        dock: state.dock,
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
  function checkoutContact(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.slice(-10);
    return ten.length === 10 ? `+91${ten}` : undefined;
  }

  function openCheckout(created) {
    return window.gridxApi.loadRazorpay().then(() => new Promise((resolve, reject) => {
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
        description: `PowerPod Gen2 reservation, ${created.orderNumber}`,
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
            reject(new Error('Payment was cancelled. Your order is saved, you can try again.'));
          },
        },
      });
      rzp.on('payment.failed', (response) => {
        settled = true;
        track('payment_failed');
        reject(new Error(response?.error?.description || 'That payment did not go through. Please try again.'));
      });
      rzp.open();
      track('payment_open');
    }));
  }

  function pay() {
    // One order per press: a second tap while the first is still being set up would create a
    // second order and open a second payment window.
    if (busy || paid) return;
    for (const key of ALL_FIELDS) details[key] = fieldEls[key] ? fieldEls[key].input.value.trim() : '';
    // Uppercased here so the browser and the server normalize identically.
    if (details.gstin && window.gridGstin) details.gstin = window.gridGstin.normalize(details.gstin);
    // gen2 is Paddock's SKU for the PowerPod; buying it with a two wheeler means collecting both
    // at the dealership, and on its own it is shipped.
    track('order_submit', { sku: 'gen2', intent: 'reserve', delivery: state.vehicle === 'yes' ? 'dealership' : 'ship' });
    busy = true;
    if (status) status.textContent = 'Setting up your payment.';
    render();

    createOrder()
      .then((created) => {
        // Paddock priced it. If that is not what the bill said, the bill changes before the
        // Razorpay window opens rather than after, so the two never disagree on screen. It is
        // what gets charged either way.
        if ([created.itemsInr, created.feeInr, created.chargedInr].every(Number.isFinite)) {
          quoted = { itemsInr: created.itemsInr, feeInr: created.feeInr, chargedInr: created.chargedInr };
          renderBill();
        }
        // Still busy: the payment window is opening, and it is the window that settles this.
        if (status) status.textContent = '';
        render();
        return openCheckout(created);
      })
      .then((created) => {
        paid = true;
        busy = false;
        if (status) status.textContent = '';
        showConfirmation(created);
        render();
      })
      .catch((err) => {
        busy = false;
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
    // The offer and the bill have both been acted on. The confirmation carries its own title.
    if (payReserve) payReserve.hidden = true;
    if (payReview) payReview.hidden = true;
    scroller.scrollTop = 0;

    const done = document.getElementById('pg2-done');
    if (done) {
      done.hidden = false;
      const ref = document.getElementById('pg2-done-ref');
      if (ref) ref.textContent = created.orderNumber;
      const where = document.getElementById('pg2-done-where');
      if (where) {
        where.textContent = 'Your reservation is confirmed. We have sent your receipt voucher to ';
      }
      const to = document.getElementById('pg2-done-to');
      if (to) to.textContent = `${details.email} and on WhatsApp to ${details.phone}.`;
      const heading = done.querySelector('h3');
      if (heading) heading.focus?.();
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
  // Stage 1 already carries is-active in the markup, so there is no flash of an empty
  // panel before this runs; the camera just needs pointing at the first step.
  render();
  goToStep(1, false);
  counting = true;
  startLoop();
  window.addEventListener('load', () => {
    if ('requestIdleCallback' in window) requestIdleCallback(boot3D, { timeout: 1200 });
    else window.setTimeout(boot3D, 300);
  });
})();
