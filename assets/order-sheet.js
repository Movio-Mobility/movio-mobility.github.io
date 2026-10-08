/*
 * Ordering accessories from the store.
 *
 * How a sheet behaves is sheet.js's, and what it costs is catalogue.js's. This file owns
 * what is inside one: a quantity per accessory, the details we need to post the parcel and
 * raise the invoice, and one button. It builds its own markup, so any page that loads it
 * can order.
 *
 * TWO RULES, both inherited from the configurator and both worth keeping:
 *
 *   The browser never sends a price. It posts which SKUs and how many; Paddock prices the
 *   order, records it, and answers with the Razorpay order to open. A doctored total in
 *   here changes nothing.
 *
 *   Nothing on this page confirms a payment. The Razorpay webhook is the only thing that
 *   marks an order paid and sends the bill, because a browser can be closed, throttled or
 *   lied to halfway through. So the confirmation below says the bill is on its way, never
 *   that it has been sent.
 *
 * The one thing this page does that powerpod-gen2.html does not: it shows the real amount
 * Razorpay will charge, gateway fee and all. See GATEWAY_FEE_RATE.
 *
 * Analytics (analytics.js) hears the steps of the funnel and nothing typed: the sheet opening
 * for a SKU, the order going in (which SKUs, never who), and what Razorpay's window did.
 */
(() => {
  'use strict';

  // sheet.js gives the dialog its behaviour, catalogue.js the prices. Without either there
  // is nothing to mount.
  if (!window.gridSheet || typeof window.gridSheet.create !== 'function') return;
  if (!window.gridCatalogue) return;

  const { ITEMS, MAX_QTY, round2, grossUp, money } = window.gridCatalogue;
  const SKUS = ITEMS.map((it) => it.sku);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Through the queue gridx-api.js sets up, so nothing is lost to analytics.js arriving late.
  const track = (name, props) => {
    if (typeof window.gridTrack === 'function') window.gridTrack(name, props);
  };

  // ---------------------------------------------------------------- the markup
  /*
   * The sheet builds itself.
   *
   * It began as 170 lines inline in store.html, which was fine while the store was the only
   * page that could order. Four pages later it would have been four copies to keep in step,
   * on a static site with no build step to do it for us. So the markup lives here with the
   * behaviour that drives it.
   *
   * The shell below is a constant with nothing interpolated into it. The item rows do carry
   * values, so they are built through the DOM instead, where a name goes in as textContent
   * and can never be read as markup. Nothing from the network or the URL reaches either.
   *
   * The cost is that checkout is invisible without JavaScript. Razorpay already requires it,
   * and every page carrying this script also carries a <noscript> saying so.
   */
  const MINUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>';
  const PLUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';

  const SHELL = `
    <div class="story__grabber" aria-hidden="true"></div>
    <button class="story__close" type="button" aria-label="Close">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
    </button>

    <form class="order" id="order-form" novalidate>
      <div class="story__scroll">
        <h2 class="story__headline order__headline" id="order-title">Accessories</h2>

        <ul class="order__items" id="order-items"></ul>

        <div class="order__details">
          <h3 class="order__sub">Where it goes.</h3>

          <div class="field">
            <label class="field__label" for="o-name">Full name</label>
            <input class="field__input" id="o-name" name="name" type="text"
                   autocomplete="name" autocapitalize="words" spellcheck="false"
                   aria-describedby="eo-name">
            <p class="field__err" id="eo-name"></p>
          </div>

          <div class="field">
            <label class="field__label" for="o-phone">Phone number</label>
            <input class="field__input" id="o-phone" name="phone" type="tel"
                   inputmode="tel" autocomplete="tel" placeholder="10 digit mobile number"
                   aria-describedby="eo-phone ho-phone">
            <p class="field__hint" id="ho-phone">Your bill is sent here on WhatsApp.</p>
            <p class="field__err" id="eo-phone"></p>
          </div>

          <div class="field">
            <label class="field__label" for="o-email">Email</label>
            <input class="field__input" id="o-email" name="email" type="email"
                   inputmode="email" autocomplete="email" spellcheck="false"
                   aria-describedby="eo-email">
            <p class="field__err" id="eo-email"></p>
          </div>

          <div class="field">
            <label class="field__label" for="o-address">Address</label>
            <input class="field__input" id="o-address" name="address" type="text"
                   autocomplete="street-address" autocapitalize="words"
                   placeholder="Flat, building, street" maxlength="200"
                   aria-describedby="eo-address">
            <p class="field__err" id="eo-address"></p>
          </div>

          <div class="field-row">
            <div class="field">
              <label class="field__label" for="o-city">City</label>
              <input class="field__input" id="o-city" name="city" type="text"
                     autocomplete="address-level2" autocapitalize="words"
                     aria-describedby="eo-city">
              <p class="field__err" id="eo-city"></p>
            </div>

            <div class="field">
              <label class="field__label" for="o-pin">Pincode</label>
              <input class="field__input" id="o-pin" name="pincode" type="text"
                     inputmode="numeric" autocomplete="postal-code" maxlength="6"
                     aria-describedby="eo-pin">
              <p class="field__err" id="eo-pin"></p>
            </div>
          </div>

          <div class="field">
            <label class="field__label" for="o-gstin">
              GSTIN <span class="field__opt">optional</span>
            </label>
            <!-- maxlength is 18, not 15, for the same reason as on powerpod-gen2.html:
                 a pasted GSTIN often carries spaces, and a tight cap would clip the
                 check digit off the end before the script could strip them. -->
            <input class="field__input" id="o-gstin" name="gstin" type="text"
                   inputmode="text" autocomplete="off" spellcheck="false"
                   maxlength="18" placeholder="22AAAAA0000A1Z5"
                   aria-describedby="eo-gstin ho-gstin">
            <p class="field__hint" id="ho-gstin">Buying through a business? Add your GSTIN and it will appear on your tax invoice.</p>
            <p class="field__err" id="eo-gstin"></p>
          </div>
        </div>

        <!-- Revealed in place once Razorpay hands back. -->
        <div class="order__done" id="order-done" hidden>
          <h3 class="order__done-title" tabindex="-1">You are all set.</h3>
          <p class="order__done-where" id="order-done-where"></p>
          <p class="order__done-ref">Order reference <span id="order-done-ref"></span></p>
          <p class="order__done-note">Keep this handy. Quote it if you get in touch about this order.</p>
          <p class="order__done-note"><a class="story__link" href="support.html#track">Track this order</a></p>
        </div>
      </div>

      <div class="order__foot">
        <div class="order__money">
          <p class="order__total">
            <span class="order__total-label">Total</span>
            <span class="order__total-amount" id="order-total">₹0</span>
          </p>
          <p class="order__tax" id="order-tax">(inclusive of all taxes)</p>
        </div>
        <button class="order__pay" id="order-pay" type="submit" aria-disabled="true" aria-describedby="order-hint">
          <span id="order-pay-label">Pay</span>
        </button>
        <p class="order__hint" id="order-hint" role="status" aria-live="polite"></p>
        <!-- Google's terms for hiding the reCAPTCHA badge, which would otherwise sit on top of
             this button on a phone: say so where the check happens. -->
        <p class="order__legal">Protected by reCAPTCHA: Google's <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> apply. Payments are processed by Razorpay.</p>
      </div>
    </form>`;

  function stepperButton(step, label, describedBy, icon) {
    const b = document.createElement('button');
    b.className = 'stepper__btn';
    b.type = 'button';
    b.dataset.step = String(step);
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-describedby', describedBy);
    b.innerHTML = icon; // a constant defined above, never anything dynamic
    return b;
  }

  /** One row per SKU. Every value goes in as text or an attribute, never as markup. */
  function itemRow(item) {
    const nameId = `n-${item.sku}`;

    const name = document.createElement('p');
    name.className = 'order__item-name';
    name.id = nameId;
    name.textContent = item.short || item.label;

    const price = document.createElement('p');
    price.className = 'order__item-price';
    price.textContent = money(item.price);

    const text = document.createElement('div');
    text.className = 'order__item-text';
    text.append(name, price);

    const count = document.createElement('output');
    count.className = 'stepper__count';
    count.setAttribute('for', nameId);
    count.setAttribute('aria-live', 'polite');
    count.textContent = '0';

    const stepper = document.createElement('div');
    stepper.className = 'stepper';
    stepper.dataset.sku = item.sku;
    stepper.append(
      stepperButton(-1, 'One fewer', nameId, MINUS_ICON),
      count,
      stepperButton(1, 'One more', nameId, PLUS_ICON),
    );

    const li = document.createElement('li');
    li.className = 'order__item';
    li.dataset.sku = item.sku;
    li.append(text, stepper);
    return li;
  }

  const sheetEl = document.createElement('dialog');
  sheetEl.className = 'story story--order';
  sheetEl.id = 'order-sheet';
  sheetEl.setAttribute('aria-labelledby', 'order-title');
  sheetEl.innerHTML = SHELL;
  document.body.appendChild(sheetEl);

  const form = sheetEl.querySelector('#order-form');
  const itemsEl = sheetEl.querySelector('#order-items');
  for (const item of ITEMS) itemsEl.appendChild(itemRow(item));

  const qty = {};
  for (const sku of SKUS) qty[sku] = 0;

  const details = { name: '', phone: '', email: '', address: '', city: '', pincode: '', gstin: '' };

  // ---------------------------------------------------------------- money
  const itemsTotal = () => ITEMS.reduce((sum, it) => sum + it.price * qty[it.sku], 0);
  const lineCount = () => SKUS.reduce((n, sku) => n + (qty[sku] > 0 ? 1 : 0), 0);

  /**
   * What the foot shows. The server's own figures once we have them, our estimate until
   * then, so the numbers never jump between the button and the Razorpay window.
   */
  let quoted = null; // { itemsInr, feeInr, chargedInr } straight off the order response

  function totals() {
    if (quoted) return quoted;
    const itemsInr = itemsTotal();
    const chargedInr = itemsInr > 0 ? grossUp(itemsInr) : 0;
    return { itemsInr, chargedInr, feeInr: round2(chargedInr - itemsInr) };
  }

  // ---------------------------------------------------------------- validation
  // Lifted from assets/powerpod-gen2.js so the two forms accept and reject exactly the
  // same things, plus the street address, which only this flow asks for.
  const FIELDS = ['name', 'phone', 'email', 'address', 'city', 'pincode'];
  // Validated but never demanded, so an empty one cannot hold up the Pay button.
  const OPTIONAL = ['gstin'];
  const ALL_FIELDS = FIELDS.concat(OPTIONAL);
  const CHECK = {
    name: (v) => (v.trim().length >= 2 ? '' : 'Please enter your name.'),
    phone: (v) => (/^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, ''))
      ? '' : 'Enter a 10 digit Indian mobile number.'),
    email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())
      ? '' : 'Enter a valid email address.'),
    address: (v) => (v.trim().length >= 6 ? '' : 'Please enter the address to deliver to.'),
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
    const wrap = input.closest('.field');
    fieldEls[key] = { input, wrap, err: wrap && wrap.querySelector('.field__err') };
  }

  const fieldOk = (key) => CHECK[key](fieldEls[key] ? fieldEls[key].input.value : '') === '';
  // A filled in but invalid GSTIN blocks Pay: the API would reject the order anyway, and
  // finding that out at the payment step is worse than finding it out here.
  const detailsValid = () => ALL_FIELDS.every(fieldOk);

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

  // ---------------------------------------------------------------- the sheet
  const detailsEl = sheetEl.querySelector('.order__details');
  const doneEl = sheetEl.querySelector('#order-done');
  const totalLabel = sheetEl.querySelector('.order__total-label');
  const totalAmount = sheetEl.querySelector('#order-total');
  const taxLine = sheetEl.querySelector('#order-tax');
  const payBtn = sheetEl.querySelector('#order-pay');
  const payLabel = sheetEl.querySelector('#order-pay-label');
  const hint = sheetEl.querySelector('#order-hint');
  const foot = sheetEl.querySelector('.order__foot');
  const headline = sheetEl.querySelector('#order-title');

  let paid = false;
  let busy = false;

  const sheet = window.gridSheet.create(sheetEl, {
    onClose() {
      // A finished order does not come back. Reset to a fresh sheet once it has slid away,
      // so reopening from a card is not a receipt nobody asked to see again.
      if (paid) reset();
    },
  });

  function setQty(sku, next) {
    const clamped = Math.max(0, Math.min(MAX_QTY, next));
    if (clamped === qty[sku]) return;
    qty[sku] = clamped;
    forgetOrder();
    render();
  }

  if (itemsEl) {
    // Delegated, so the rows stay plain markup and the wiring is one listener.
    itemsEl.addEventListener('click', (event) => {
      const btn = event.target.closest('.stepper__btn');
      if (!btn || paid) return;
      const row = btn.closest('.stepper');
      const sku = row && row.dataset.sku;
      if (!sku || !(sku in qty)) return;
      if (btn.getAttribute('aria-disabled') === 'true') return;
      setQty(sku, qty[sku] + Number(btn.dataset.step || 0));
    });
  }

  // ---------------------------------------------------------------- render
  function render() {
    const t = totals();
    const count = lineCount();

    for (const it of ITEMS) {
      const row = itemsEl && itemsEl.querySelector(`.order__item[data-sku="${it.sku}"]`);
      if (!row) continue;
      row.dataset.qty = String(qty[it.sku]);
      const out = row.querySelector('.stepper__count');
      if (out) out.textContent = String(qty[it.sku]);
      for (const btn of row.querySelectorAll('.stepper__btn')) {
        const step = Number(btn.dataset.step || 0);
        const atBound = step < 0 ? qty[it.sku] <= 0 : qty[it.sku] >= MAX_QTY;
        btn.setAttribute('aria-disabled', atBound ? 'true' : 'false');
      }
    }

    if (paid) return;

    if (totalLabel) totalLabel.textContent = count ? 'Items' : 'Total';
    if (totalAmount) totalAmount.textContent = money(t.itemsInr);
    if (taxLine) {
      taxLine.textContent = count
        ? `Incl. taxes and ${money(t.feeInr)} processing`
        : '(inclusive of all taxes)';
    }
    if (payLabel) payLabel.textContent = count ? `Pay ${money(t.chargedInr)}` : 'Pay';

    const ready = count > 0 && detailsValid() && !busy;
    if (payBtn) payBtn.setAttribute('aria-disabled', ready ? 'false' : 'true');
  }

  /** What is standing between the buyer and the button, in one line. */
  function missing() {
    if (!lineCount()) return 'Choose at least one accessory.';
    const bad = ALL_FIELDS.find((k) => !fieldOk(k));
    if (bad && fieldEls[bad]) {
      for (const key of ALL_FIELDS) showFieldError(key, true);
      fieldEls[bad].input.focus({ preventScroll: false });
      return CHECK[bad](fieldEls[bad].input.value);
    }
    return '';
  }

  function say(message, bad) {
    if (!hint) return;
    hint.textContent = message || '';
    hint.classList.toggle('is-bad', Boolean(bad));
  }

  // ---------------------------------------------------------------- payment
  /*
   * Two steps, and the split matters. createOrder() prices and records the order on the
   * server; openCheckout() collects the money. Neither confirms anything.
   */
  let created = null;
  let createdFor = '';

  /** What an order was created for, so a retry can tell "again" from "something changed". */
  const signature = () => JSON.stringify([cart(), details]);

  const forgetOrder = () => { created = null; createdFor = ''; quoted = null; };

  function cart() {
    return ITEMS
      .filter((it) => qty[it.sku] > 0)
      .map((it) => ({ sku: it.sku, qty: qty[it.sku] }));
  }

  function createOrder() {
    if (!window.gridxApi) {
      return Promise.reject(new Error('Could not reach GridX. Please check your connection and try again.'));
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
        reject(new Error('The payment window could not load. Please refresh and try again.'));
        return;
      }
      let settled = false;
      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.razorpayOrderId,
        amount: order.amountPaise,
        currency: 'INR',
        name: 'GridX Energy',
        description: `GridX accessories, ${order.orderNumber}`,
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
        // Presentational only. The webhook is what actually confirms the money and sends
        // the bill, so this handler never claims more than "we have it from here".
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
    for (const key of ALL_FIELDS) details[key] = fieldEls[key] ? fieldEls[key].input.value.trim() : '';
    // Uppercased here so the browser and the server normalize identically.
    if (details.gstin && window.gridGstin) details.gstin = window.gridGstin.normalize(details.gstin);

    // Which SKUs, as "adapter+chg6a": never a name, a number or an address.
    track('order_submit', { sku: cart().map((line) => line.sku).join('+'), intent: 'full', delivery: 'ship' });

    busy = true;
    say('Setting up your payment.');
    render();

    createOrder()
      .then((order) => {
        // The server priced it. If that is not what the button said, say so before the
        // Razorpay window opens rather than after: a price can change between the page
        // loading and Pay being pressed, and the amount charged is the server's either way.
        quoted = {
          itemsInr: order.itemsInr,
          feeInr: order.feeInr,
          chargedInr: order.chargedInr,
        };
        busy = false;
        render();
        return openCheckout(order);
      })
      .then((order) => {
        paid = true;
        busy = false;
        say('');
        showConfirmation(order);
      })
      .catch((err) => {
        busy = false;
        say(err.message, true);
        render();
      });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (paid || busy) return;
    const why = missing();
    if (why) {
      say(why, true);
      render();
      return;
    }
    say('');
    pay();
  });

  /**
   * The buyer is done. The bill is rendered and sent server side from the webhook, so this
   * says it is on its way rather than pretending to have sent it.
   */
  function showConfirmation(order) {
    if (itemsEl) itemsEl.hidden = true;
    if (detailsEl) detailsEl.hidden = true;
    if (foot) foot.hidden = true;
    // "Accessories" named a thing to choose. Nothing is being chosen now, and the
    // confirmation carries its own heading, so the sheet should not have two.
    if (headline) headline.hidden = true;
    if (!doneEl) return;

    doneEl.hidden = false;
    const ref = document.getElementById('order-done-ref');
    if (ref) ref.textContent = order.orderNumber;

    /*
     * Hand the reference to the tracking form, so someone following the link below does not
     * have to copy it by hand or go back to WhatsApp for it.
     *
     * sessionStorage, not localStorage, and not the URL: it dies with the tab, never
     * follows a shared machine's next visitor, and a reference in a query string would end
     * up in history and in any Referer the browser sends.
     */
    try {
      window.sessionStorage.setItem('gridx.lastOrder', order.orderNumber);
    } catch {
      // Private mode, or storage blocked. The link still works, it just arrives empty.
    }
    const where = document.getElementById('order-done-where');
    if (where) {
      where.textContent = 'Your order is confirmed. Your tax invoice is on its way to '
        + `${details.email} and on WhatsApp to ${details.phone}.`;
    }
    const heading = doneEl.querySelector('.order__done-title');
    if (heading) heading.focus?.({ preventScroll: true });
  }

  /** Back to an empty sheet, once a finished order has slid away. */
  function reset() {
    paid = false;
    busy = false;
    forgetOrder();
    for (const sku of SKUS) qty[sku] = 0;
    for (const key of ALL_FIELDS) {
      details[key] = '';
      if (fieldEls[key]) fieldEls[key].input.value = '';
      showFieldError(key, false);
    }
    if (itemsEl) itemsEl.hidden = false;
    if (detailsEl) detailsEl.hidden = false;
    if (foot) foot.hidden = false;
    if (headline) headline.hidden = false;
    if (doneEl) doneEl.hidden = true;
    say('');
    const scroll = form.querySelector('.story__scroll');
    if (scroll) scroll.scrollTop = 0;
    render();
  }

  // ---------------------------------------------------------------- opening
  /**
   * Open the sheet, aimed at one accessory.
   *
   * `want` is how many of it the opener already decided on: a product page's stepper says
   * three, so the sheet opens at three. A store card says nothing, and then the row is
   * nudged to one if it was empty, because tapping a card is a statement of interest.
   *
   * Either way the row is scrolled to and briefly lit, so the sheet visibly answers the
   * tap that opened it rather than just appearing.
   *
   * @param {string} [sku]
   * @param {HTMLElement} [returnTo] where focus goes when the sheet closes
   * @param {number} [want] quantity to set, clamped by setQty
   */
  function open(sku, returnTo, want) {
    // Someone opening the order sheet may well pay: fetch the checkout script now, while they
    // fill it in, rather than on the Pay press.
    if (window.gridxApi && window.gridxApi.loadRazorpay) window.gridxApi.loadRazorpay();
    if (window.gridxApi && window.gridxApi.loadRecaptcha) window.gridxApi.loadRecaptcha();
    if (sku && sku in qty && !paid) {
      if (Number.isFinite(want) && want > 0) setQty(sku, Math.floor(want));
      else if (qty[sku] === 0) setQty(sku, 1);
    }
    sheet.open(returnTo);
    track('order_sheet_open', { sku: sku && sku in qty ? sku : 'none' });

    const row = sku && itemsEl && itemsEl.querySelector(`.order__item[data-sku="${CSS.escape(sku)}"]`);
    if (!row) return;
    row.classList.remove('is-aimed');
    // After the sheet has arrived, or the scroll happens while it is still sliding up.
    window.setTimeout(() => {
      row.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
      // Reflow, so retriggering the animation on a second open actually restarts it.
      void row.offsetWidth;
      row.classList.add('is-aimed');
    }, reduceMotion ? 0 : 420);
  }

  /*
   * Anything carrying data-order-sku opens the sheet: a store card, a product page's Buy
   * button. A separate attribute from the plain data-sku that marks which SKU a control
   * belongs to, because a product page's own stepper carries that and must not become an
   * opener by standing too close.
   *
   * data-qty-from names an element whose value is the quantity to carry across, which is
   * how a product page's stepper reaches a sheet that knows nothing about product pages.
   */
  for (const hit of document.querySelectorAll('[data-order-sku]')) {
    hit.addEventListener('click', () => {
      const source = hit.dataset.qtyFrom && document.getElementById(hit.dataset.qtyFrom);
      const want = source ? Number(source.value ?? source.textContent) : undefined;
      open(hit.dataset.orderSku, hit, want);
    });
  }

  /** So a page can open the sheet without a click, and read the cap it must respect. */
  window.gridOrder = { open, MAX_QTY };

  render();
})();
