/*
 * Buying an accessory: the three stage flow on adapter.html, vehicle-dock.html and
 * chargers.html.
 *
 * Its twins: assets/powerpod-gen2.js, the configurator this flow takes its shell, stages,
 * progress bar and stage drawings from, and the retired assets/order-sheet.js, the bottom
 * sheet it replaces, which is where the validation, the order-reuse cache and the checkout
 * opening were lifted from. The gallery on the stage is product.js's; what something costs
 * is catalogue.js's; this file owns the purchase.
 *
 * TWO RULES, both inherited from the configurator and both worth keeping:
 *
 *   The browser never sends a price. It posts which SKU and how many; Paddock prices the
 *   order, records it, and answers with the Razorpay order to open. A doctored total in
 *   here changes nothing.
 *
 *   Nothing in this file confirms a payment. The Razorpay webhook is the only thing that
 *   marks an order paid, so once Razorpay's window closes happily the page asks Paddock
 *   whether the webhook has landed (assets/pay-confirm.js) and only then says so.
 *
 * The stages: 1 the product (quantity, and on the chargers page the 6A or 10A choice),
 * 2 the details a parcel and a tax invoice need, 3 the bill and Pay. One .pg2-view is
 * shown at a time; without JavaScript all three are visible and the page reads as one
 * document, with WhatsApp ordering in the <noscript> as before.
 *
 * Analytics (analytics.js) hears the steps of the funnel and nothing typed: the details
 * stage opening for a SKU (order_sheet_open, the same event the sheet sent), the order
 * going in (order_submit), and what Razorpay's window did (payment_*).
 */
(() => {
  'use strict';

  // Every word this sheet writes, in the page's language (assets/i18n.js).
  const t = window.gridLang ? window.gridLang.t : (src, vars) => { let out = String(src).replace(/^[a-z][\w-]*::/, ''); if (vars && typeof vars.n === 'number' && out.includes('|')) out = out.split('|')[vars.n === 1 ? 0 : 1]; return out.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)); };

  const root = document.documentElement;
  const stageEl = document.getElementById('pg2-stage');
  const panel = document.getElementById('pg2-panel');
  const scroller = document.getElementById('pg2-scroll');
  const form = document.getElementById('af-form');
  const cta = document.getElementById('product-buy');
  if (!panel || !scroller || !form || !cta || !window.gridCatalogue) return;

  const { ITEMS, MAX_QTY, round2, grossUp, money, priceOf } = window.gridCatalogue;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const stacked = () => !window.matchMedia('(min-width: 1025px)').matches;

  // Through the queue gridx-api.js sets up, so nothing is lost to analytics.js arriving late.
  const track = (name, props) => {
    if (typeof window.gridTrack === 'function') window.gridTrack(name, props);
  };

  // ---------------------------------------------------------------- config and state
  /*
   * Most pages sell one thing and the SKU is fixed on the button. The chargers page sells
   * two that differ only by rating, so it carries .opt cards instead and the SKU follows
   * whichever is chosen. Selection state lives on data-selected, as every choice on this
   * shell does.
   */
  const variants = [...form.querySelectorAll('.opt__input[name="variant"]')];
  const skuNow = () => {
    const picked = variants.find((r) => r.checked);
    return picked ? picked.value : cta.dataset.orderSku;
  };

  const state = { qty: 1, stage: 1, busy: false, paid: false, confirming: false };
  const details = { name: '', phone: '', email: '', address: '', city: '', pincode: '', gstin: '' };

  // ---------------------------------------------------------------- warm-up
  // A purchase flow, so the checkout script is fetched at the first sign of use (a tap, a
  // key, a focus in the panel) rather than with the page, and has long arrived by the time
  // Pay is pressed. openCheckout() waits for it either way. reCAPTCHA warms up with it:
  // Paddock asks Google about the order before creating it.
  if (window.gridxApi && window.gridxApi.loadRazorpay) {
    const warm = () => {
      window.gridxApi.loadRazorpay();
      if (window.gridxApi.loadRecaptcha) window.gridxApi.loadRecaptcha();
    };
    for (const type of ['pointerdown', 'keydown', 'focusin']) {
      panel.addEventListener(type, warm, { once: true, passive: true });
    }
  }

  // ---------------------------------------------------------------- money
  /**
   * What the foot and the bill show. The server's own figures once we have them, our
   * estimate until then, so the numbers never jump between the button and the Razorpay
   * window. The estimate is Paddock's own arithmetic (catalogue.js): the gateway fee
   * grossed up, not marked up.
   */
  let quoted = null; // { itemsInr, feeInr, chargedInr } straight off the order response

  function totals() {
    if (quoted) return quoted;
    const itemsInr = priceOf(skuNow()) * state.qty;
    const chargedInr = itemsInr > 0 ? grossUp(itemsInr) : 0;
    return { itemsInr, feeInr: round2(chargedInr - itemsInr), chargedInr };
  }

  // ---------------------------------------------------------------- validation
  // Lifted from the retired order-sheet.js, which lifted it from powerpod-gen2.js, so every
  // form on the site accepts and rejects exactly the same things. The street address is the
  // one field only this flow asks for: an accessory ships, a pre-booking does not.
  const FIELDS = ['name', 'phone', 'email', 'address', 'city', 'pincode'];
  // Validated but never demanded, so an empty one cannot hold up the Pay button.
  const OPTIONAL = ['gstin'];
  const ALL_FIELDS = FIELDS.concat(OPTIONAL);
  const CHECK = {
    name: (v) => (v.trim().length >= 2 ? '' : t('Please enter your name.')),
    phone: (v) => (/^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, ''))
      ? '' : t('Enter a 10 digit Indian mobile number.')),
    email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())
      ? '' : t('Enter a valid email address.')),
    address: (v) => (v.trim().length >= 6 ? '' : t('Please enter the address to deliver to.')),
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
    const wrap = input.closest('.field');
    fieldEls[key] = { input, wrap, err: wrap && wrap.querySelector('.field__err') };
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
      // Changing anything invalidates the order we may already have created.
      forgetOrder();
      // Only correct an error already on screen; do not scold mid-typing.
      if (f.wrap && f.wrap.classList.contains('is-bad')) showFieldError(key, true);
      render();
    });
  }

  // ---------------------------------------------------------------- render
  const views = [...form.querySelectorAll('.pg2-view')]
    .sort((a, b) => Number(a.dataset.stage) - Number(b.dataset.stage));
  const segs = [...document.querySelectorAll('#af-progress .pg2-progress__seg')];
  const backEl = document.querySelector('.pg2-back');
  const nextLabel = document.getElementById('af-next-label');
  const totalLabel = document.getElementById('product-total-label');
  const totalAmount = document.getElementById('product-total');
  const countEl = document.getElementById('product-qty');
  const unitLine = document.querySelector('.qty-row__unit');
  const billEl = document.getElementById('af-bill');
  const payWrap = document.getElementById('af-pay');
  const statusEl = document.getElementById('af-status');
  const doneEl = document.getElementById('af-done');

  const say = (message) => { if (statusEl) statusEl.textContent = message || ''; };

  function render() {
    const sku = skuNow();
    cta.dataset.orderSku = sku;

    for (const radio of variants) {
      const label = radio.closest('.opt');
      if (label) label.dataset.selected = radio.checked ? 'true' : 'false';
    }

    if (countEl) countEl.value = String(state.qty);
    for (const b of form.querySelectorAll('.qty-row .stepper__btn')) {
      const step = Number(b.dataset.step || 0);
      const atBound = step < 0 ? state.qty <= 1 : state.qty >= MAX_QTY;
      b.setAttribute('aria-disabled', atBound ? 'true' : 'false');
    }

    const unit = priceOf(sku);
    if (unitLine) unitLine.textContent = t('{amount} each', { amount: money(unit) });

    const sum = totals();
    if (totalLabel) totalLabel.textContent = state.paid ? t('Paid') : t('Total');
    if (totalAmount) totalAmount.textContent = money(sum.chargedInr);

    // Progress. The product is always a complete answer (something is always selected and
    // a quantity always set), so its segment reads full from the start; details fill as
    // the fields do; payment is half done on the bill and full once the money has moved.
    const fills = [
      100,
      (validCount() / FIELDS.length) * 100,
      state.paid ? 100 : (state.stage === 3 ? 50 : 0),
    ];
    segs.forEach((seg, i) => {
      const fill = seg.querySelector('.pg2-progress__fill');
      if (fill) fill.style.setProperty('--fill', `${Math.round(fills[i])}%`);
      const n = i + 1;
      seg.dataset.state = n === state.stage ? 'current' : (n < state.stage ? 'done' : 'todo');
    });

    if (backEl) {
      backEl.setAttribute('aria-label',
        state.stage === 1 ? t('Back to the store') : t('Back to the previous stage'));
    }

    // The one action. On the bill it names the exact amount Razorpay is about to ask for.
    if (nextLabel) {
      nextLabel.textContent = state.confirming ? t('Confirming')
        : (state.stage === 3 ? t('Pay {amount}', { amount: money(sum.chargedInr) }) : t('Continue'));
    }
    cta.setAttribute('aria-disabled', String(state.busy || state.paid || state.confirming));
  }

  /** The bill: the last thing on screen before Razorpay opens. Built with createElement,
   * so a quantity or a label can never be read as markup. */
  function renderBill() {
    if (!billEl) return;
    const sum = totals();
    const item = ITEMS.find((it) => it.sku === skuNow());
    const name = item ? (item.short || item.label) : skuNow();

    const row = (label, value, total) => {
      const li = document.createElement('li');
      li.className = total ? 'bill__row bill__row--total' : 'bill__row';
      const l = document.createElement('span');
      l.className = 'bill__label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'bill__value';
      v.textContent = value;
      li.append(l, v);
      return li;
    };
    const group = (title, rows) => {
      const section = document.createElement('section');
      section.className = 'bill__group';
      const h = document.createElement('h3');
      h.className = 'bill__title';
      h.textContent = title;
      const ul = document.createElement('ul');
      ul.className = 'bill__rows';
      ul.append(...rows);
      section.append(h, ul);
      return section;
    };

    billEl.replaceChildren(
      group(t('Your order'), [row(t('{item} x {qty}', { item: name, qty: state.qty }), money(sum.itemsInr))]),
      group(t('Pay now'), [
        row(t('Items incl. GST'), money(sum.itemsInr)),
        row(t('Processing fee'), money(sum.feeInr)),
        row(t('Total payable'), money(sum.chargedInr), true),
      ]),
    );
  }

  // ---------------------------------------------------------------- stages
  const LAST_STAGE = views.length; // 3

  // The visible title of a view, for focus to land on after a stage change.
  function focusTitle(view) {
    const title = [...view.querySelectorAll('.pg2-step__title')].find((t) => !t.closest('[hidden]'));
    if (title) title.focus({ preventScroll: true });
  }

  function goToStage(n, dir) {
    const next = clamp(n, 1, LAST_STAGE);
    if (next === state.stage && views[next - 1].classList.contains('is-active')) return;
    state.stage = next;
    for (const v of views) v.classList.remove('is-active');
    const el = views[state.stage - 1];
    el.dataset.dir = dir === 'back' ? 'back' : 'fwd';
    el.classList.add('is-active');

    scroller.scrollTop = 0;
    say('');

    // The same funnel event the order sheet sent when it opened for a SKU: the moment
    // someone moves from looking to buying. Counted once a page by analytics.js.
    if (state.stage === 2) track('order_sheet_open', { sku: skuNow() });
    if (state.stage === 3) renderBill();

    setScene();
    render();
    focusTitle(el);
  }

  function tryAdvance() {
    if (state.busy || state.paid || state.confirming) return;
    if (state.stage === 2 && !detailsValid()) {
      // Mark every outstanding field at once, then take them to the first one.
      for (const key of ALL_FIELDS) showFieldError(key, true);
      const bad = ALL_FIELDS.find((k) => !fieldOk(k));
      if (bad && fieldEls[bad]) fieldEls[bad].input.focus({ preventScroll: false });
      return;
    }
    if (state.stage === LAST_STAGE) {
      pay();
      return;
    }
    goToStage(state.stage + 1, 'fwd');
  }

  cta.addEventListener('click', tryAdvance);

  // The back chevron is a real anchor to the store, which is all it can be without
  // JavaScript. Past stage 1 it steps back through the flow instead; once the payment is
  // under way or done there is nothing to step back to, so it is the way out again.
  if (backEl) {
    backEl.addEventListener('click', (event) => {
      if (state.stage === 1 || state.paid || state.confirming) return;
      event.preventDefault();
      goToStage(state.stage - 1, 'back');
    });
  }

  // ---------------------------------------------------------------- choice and quantity
  const qtyRow = form.querySelector('.qty-row');
  if (qtyRow) {
    qtyRow.addEventListener('click', (event) => {
      const b = event.target.closest('.stepper__btn');
      if (!b || b.getAttribute('aria-disabled') === 'true') return;
      if (state.busy || state.paid || state.confirming) return;
      state.qty = clamp(state.qty + Number(b.dataset.step || 0), 1, MAX_QTY);
      forgetOrder();
      render();
    });
  }

  for (const radio of variants) {
    radio.addEventListener('change', () => {
      forgetOrder();
      render();
    });
  }

  // In a details field, Enter is the keyboard's Next: on to the following field, which
  // keyboard.js then keeps in view. Only the last field moves the flow on, so nobody is
  // told off for the fields below the one they have just finished.
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.closest('.field__input')) return;
    event.preventDefault();
    const at = ALL_FIELDS.findIndex((k) => fieldEls[k] && fieldEls[k].input === event.target);
    const following = at >= 0 ? ALL_FIELDS.slice(at + 1).find((k) => fieldEls[k]) : null;
    if (following) {
      fieldEls[following].input.focus({ preventScroll: true });
      return;
    }
    tryAdvance();
  });

  form.addEventListener('submit', (event) => event.preventDefault());

  // ---------------------------------------------------------------- payment
  /*
   * Two steps, and the split matters. createOrder() prices and records the order on the
   * server; openCheckout() collects the money. Neither confirms anything: that is
   * pay-confirm.js's, which asks Paddock whether the webhook has landed.
   */
  let created = null;
  let createdFor = '';

  /** What an order was created for, so a retry can tell "again" from "something changed". */
  const signature = () => JSON.stringify([cart(), details]);

  function forgetOrder() {
    created = null;
    createdFor = '';
    quoted = null;
  }

  function cart() {
    return [{ sku: skuNow(), qty: state.qty }];
  }

  function createOrder() {
    if (!window.gridxApi) {
      return Promise.reject(new Error(t('Could not reach GridX. Please check your connection and try again.')));
    }
    // A retry after a cancelled or failed payment reuses the order already on the server.
    // A Razorpay order stays open until it is paid, and minting a fresh one per attempt
    // would leave a trail of pending orders behind one fumbled UPI request.
    if (created && createdFor === signature()) return Promise.resolve(created);

    // A fresh reCAPTCHA token per new order: they are single use and expire in minutes.
    const token = window.gridxApi.recaptchaToken
      ? window.gridxApi.recaptchaToken('create_order')
      : Promise.resolve(null);
    return token.then((recaptchaToken) => window.gridxApi.postJSON('/api/public/website/orders', {
      kind: 'accessories',
      items: cart(),
      customer: { ...details },
      recaptcha: { token: recaptchaToken, action: 'create_order' },
    })).then((order) => {
      created = order;
      createdFor = signature();
      return order;
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

  function openCheckout(order) {
    return window.gridxApi.loadRazorpay().then(() => new Promise((resolve, reject) => {
      if (!window.Razorpay) {
        reject(new Error(t('The payment window could not load. Please refresh and try again.')));
        return;
      }
      let settled = false;
      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.razorpayOrderId,
        amount: order.amountPaise,
        currency: 'INR',
        name: 'GridX Energy',
        description: t('GridX accessories, {order}', { order: order.orderNumber }),
        // Filed under this customer in Razorpay, which also emails them its receipt.
        customer_id: order.customerId || undefined,
        prefill: {
          name: order.customer?.name || details.name,
          email: order.customer?.email || details.email,
          contact: checkoutContact(order.customer?.phone || details.phone),
        },
        // What Paddock stored is what Razorpay records, and where its receipt goes.
        readonly: { name: true, email: true, contact: true },
        // No `notes` here, on purpose. Checkout notes come from the browser, so nothing
        // trusts them; Paddock writes the order's notes itself, server side.
        theme: { color: '#141414' },
        // Presentational only. The webhook is what actually confirms the money, which is
        // exactly what the confirmation poll then waits for.
        handler() {
          settled = true;
          track('payment_success');
          resolve(order);
        },
        modal: {
          // Razorpay closes its own modal after a success too, so without the settled flag
          // this would reject a promise that has already resolved.
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
    // One order per press: a second tap while the first is still being set up would create
    // a second order and open a second payment window.
    if (state.busy || state.paid || state.confirming) return;
    for (const key of ALL_FIELDS) details[key] = fieldEls[key] ? fieldEls[key].input.value.trim() : '';
    // Uppercased here so the browser and the server normalize identically.
    if (details.gstin && window.gridGstin) details.gstin = window.gridGstin.normalize(details.gstin);

    // Which SKU: never a name, a number or an address.
    track('order_submit', { sku: skuNow(), intent: 'full', delivery: 'ship' });

    state.busy = true;
    say(t('Setting up your payment.'));
    render();

    createOrder()
      .then((order) => {
        // The server priced it. If that is not what the bill said, the bill changes before
        // the Razorpay window opens rather than after: a price can change between the page
        // loading and Pay being pressed, and the amount charged is the server's either way.
        if ([order.itemsInr, order.feeInr, order.chargedInr].every(Number.isFinite)) {
          quoted = { itemsInr: order.itemsInr, feeInr: order.feeInr, chargedInr: order.chargedInr };
          renderBill();
        }
        say('');
        render();
        return openCheckout(order);
      })
      .then((order) => confirmPayment(order))
      .catch((err) => {
        state.busy = false;
        say(err.message);
        render();
      });
  }

  /**
   * Razorpay's window closed happily: now wait for the webhook's word (pay-confirm.js) and
   * show the result in the done card. If pay-confirm.js is somehow missing (a cached page
   * mid-deploy), fall back to the display-only confirmation this flow always had, so a
   * partial deploy can never break a payment.
   */
  function confirmPayment(order) {
    say('');
    if (payWrap) payWrap.hidden = true;
    scroller.scrollTop = 0;
    cta.hidden = true;

    if (!window.gridPayConfirm) {
      state.paid = true;
      state.busy = false;
      showFallback(order);
      render();
      return undefined;
    }

    state.confirming = true;
    window.gridPayConfirm.showPending(doneEl);
    render();

    return window.gridPayConfirm.confirm(order.orderNumber, details.phone).then((result) => {
      if (result && result.cancelled) return;
      state.paid = true;
      state.busy = false;
      state.confirming = false;
      const opts = { reference: order.orderNumber, email: details.email, phone: details.phone };
      if (result && result.paid) window.gridPayConfirm.showPaid(doneEl, opts);
      else window.gridPayConfirm.showTimeout(doneEl, opts);
      render();
    });
  }

  /** The old confirmation, word for word, for a page running without pay-confirm.js. */
  function showFallback(order) {
    if (!doneEl) return;
    doneEl.hidden = false;
    const where = document.getElementById('af-done-where');
    if (where) where.textContent = t('Your order is confirmed. Your tax invoice is on its way to {email} and on WhatsApp to {phone}.', { email: details.email, phone: details.phone });
    const to = document.getElementById('af-done-to');
    if (to) to.textContent = '';
    const ref = document.getElementById('af-done-ref');
    if (ref) ref.textContent = order.orderNumber;
    try {
      window.sessionStorage.setItem('gridx.lastOrder', order.orderNumber);
    } catch {
      // Private mode, or storage blocked. The tracking link still works, just empty.
    }
    const heading = doneEl.querySelector('.pg2-done__title');
    if (heading) heading.focus?.({ preventScroll: true });
  }

  // ---------------------------------------------------------------- scenes
  // What the stage shows: the gallery while the product is chosen, then a drawing the
  // particle field gathers into, a profile while details are filled in and a rupee at
  // payment. Copied from powerpod-gen2.js (its twin, where 'pod' stands where 'gallery'
  // does here); without the WebGL field, or with reduced motion, the drawings are still
  // SVGs on the stage instead (.pg2__glyph).
  const SCENES = { 1: 'gallery', 2: 'profile', 3: 'rupee' };
  let scene = (stageEl && stageEl.dataset.scene) || 'gallery';
  const formOn = !reduceMotion && typeof window.gridBG !== 'undefined'
    && root.classList.contains('gl') && typeof window.gridBG.setForm === 'function';
  if (stageEl) stageEl.classList.toggle('is-glyph-static', !formOn);

  function setScene() {
    if (!stageEl) return;
    const next = SCENES[state.stage] || 'gallery';
    if (next === scene) return;
    scene = next;
    stageEl.dataset.scene = next;
    sendForm();
  }

  // The drawings, as strokes in a unit box, y up, in grid-bg.js's stroke format:
  // ['line', x1, y1, x2, y2] | ['arc', cx, cy, r, deg0, deg1]. The twin of the same
  // functions in powerpod-gen2.js; change one, change the other.
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
   * A drawing as `count` points, ordered for the field: stepped with a stride coprime to
   * their number, so any prefix reads as the whole figure, with a hair of hashed scatter
   * so it reads as drawn rather than plotted. The twin of powerpod-gen2.js shapePoints.
   */
  const shapes = {};
  function shapePoints(key) {
    const api = window.gridBG;
    const count = api.capacity || 8000;
    if (shapes[key] && shapes[key].length === count * 2) return shapes[key];

    const sample = (strokes, n) => api.sampleVehicle({ height: 1, wheels: [], strokes }, n);
    let points;
    if (key === 'profile') {
      // The ring is sampled on its own and kept to about a third of the points. Shared out
      // by length it would take most of them and leave the figure inside it faint.
      const { figure, ring } = profileStrokes();
      const nRing = Math.round(count * 0.34);
      points = sample(figure, count - nRing).concat(sample(ring, nRing));
    } else {
      points = sample(RUPEE_STROKES, count);
    }

    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    let stride = Math.max(1, Math.round(points.length * 0.6180339887));
    while (gcd(stride, points.length) !== 1) stride++;
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

  // Where the drawing sits: a square in the open part of the stage. Under 1025px the brand
  // lockup floats over the top of the stage, so the square is centred in what is left.
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
    if (scene === 'gallery') {
      api.setForm(null);
      return;
    }
    const rect = formRect();
    // A few points per pixel of width: enough to read as a line at any size while still
    // reading as particles.
    const wanted = clamp(rect.width * 5, 650, 1300);
    api.setForm({ key: scene, points: shapePoints(scene), rect, density: wanted / (api.capacity || 8000) });
  }

  // The drawing is pinned to the stage, so a resize moves it with the stage. Same drawing,
  // so the field just shifts to the new place rather than gathering again.
  window.addEventListener('resize', () => {
    if (scene !== 'gallery') sendForm();
  });

  // ---------------------------------------------------------------- the on-screen keyboard
  // While a phone's keyboard is up the panel takes exactly the visible area above it and
  // the field being typed in stays in view (assets/keyboard.js, shared with every form).
  if (window.gridKeyboard) {
    window.gridKeyboard.watch({ shell: document.querySelector('.pg2'), scope: panel, scroller });
  }

  // ---------------------------------------------------------------- go
  // Stage 1 already carries is-active in the markup, so there is no flash of an empty
  // panel before this runs.
  render();
})();
