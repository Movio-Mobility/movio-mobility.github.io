/*
 * Order status: tracking an order.
 *
 * Two fields, one button, and the answer rendered in place. Someone on this page is
 * usually worried about a parcel, so nothing here navigates, reloads, or makes them start
 * again after a typo.
 *
 * THE SERVER OWNS THE WORDING. Paddock returns a timeline already resolved into labels,
 * dates and a headline; this file paints what it is given. So adding a status or rewording
 * one is a change in that repository alone, and the customer-facing vocabulary cannot
 * drift from the enum it is derived from.
 *
 * EVERYTHING IS RENDERED AS TEXT. The courier and consignment are typed by a member of
 * staff, which makes them the one part of this response that a person authored. They go in
 * through textContent, never innerHTML, so the worst a compromised staff account can do is
 * put odd characters on a page.
 *
 * Nothing is stored. The reference is offered back from sessionStorage if the order was
 * placed in this tab, which is same-tab only and never reaches a URL.
 *
 * An order waiting at a dealership says where: the server sends collectFrom (the counter's
 * name, address, hours and phone, or null), and this shows it with a Call link and, when the
 * map link is one of Google Maps' own, Directions. "Something not right?" opens the contact
 * form (support-form.js) on the order, with the reference already in it.
 *
 * Each lookup is counted (analytics.js, track_lookup) as found, not found or an error, and
 * nothing else: never the reference or the number.
 *
 * The form folds away under its heading until it is asked for: that, and the particle field
 * that follows it, is assets/disclose.js.
 */
(() => {
  'use strict';

  // Every word this card writes, in the page's language (assets/i18n.js). On an English page
  // Paddock's own lines stand as sent (it owns that wording); a translated page writes them
  // from the keys that come with them (headlineKey, each step's key, build and items).
  const lang = window.gridLang || null;
  const t = lang ? lang.t : (src, vars) => { let out = String(src).replace(/^[a-z][\w-]*::/, ''); if (vars && typeof vars.n === 'number' && out.includes('|')) out = out.split('|')[vars.n === 1 ? 0 : 1]; return out.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)); };
  const english = !lang || lang.code === 'en';
  const HEADLINES = {
    cancelled: t('track::Cancelled'),
    cancelled_refunded: t('Cancelled and refunded'),
    cancelled_refunding: t('Cancelled, refund on its way'),
    unpaid: t('Payment not completed'),
    refunded: t('Refunded'),
    delivered: t('track::Delivered'),
    collected: t('track::Collected'),
    shipped: t('On its way'),
    ready: t('track::Ready for collection'),
    packed: t('Packed and ready to go'),
    confirmed: t('Confirmed, and being prepared'),
  };
  const STEPS = {
    placed: t('Order placed'),
    paid: t('Payment received'),
    cancelled: t('step::Cancelled'),
    packed: t('Packed'),
    shipped: t('Shipped'),
    delivered: t('step::Delivered'),
    ready: t('step::Ready for collection'),
    collected: t('step::Collected'),
    refund_initiated: t('Refund initiated'),
    refund_processed: t('Refund processed'),
  };
  const VEHICLES = { x1: 'Komaki X1', x3: 'Komaki X3' };
  /** What was ordered, in the page's language: Paddock's summary, from its parts. */
  function summaryOf(order) {
    if (english || (!order.build && !order.items)) return order.summary;
    if (order.kind === 'powerpod' && order.build) {
      if (order.build.vehicle !== 'yes') return t('PowerPod Gen2 · Your own ride');
      return t('PowerPod Gen2 · {vehicle}', { vehicle: VEHICLES[order.build.model] || t('With a two wheeler') });
    }
    const items = (window.gridCatalogue && window.gridCatalogue.ITEMS) || [];
    return (order.items || []).map((it) => {
      const item = items.find((x) => x.sku === it.sku);
      return `${it.qty} × ${item ? item.short || item.label : it.sku}`;
    }).join(' · ') || order.summary;
  }

  const form = document.getElementById('track-form');
  if (!form) return;

  const refInput = form.querySelector('[name="reference"]');
  const phoneInput = form.querySelector('[name="phone"]');
  const button = document.getElementById('track-go');
  const note = document.getElementById('track-note');
  const result = document.getElementById('track-result');

  /** The key pay-confirm.js writes on a successful payment, in this tab only. */
  const LAST_REF = 'gridx.lastOrder';

  // Through the queue gridx-api.js sets up, so it is never lost to analytics.js arriving late.
  const count = (result) => {
    if (typeof window.gridTrack === 'function') window.gridTrack('track_lookup', { result });
  };

  // ---------------------------------------------------------------- validation
  // Deliberately loose on the reference: the server is the only thing that can say whether
  // one is real, and a client-side guess at the format would reject valid references the
  // day the format changes. This only catches an empty field.
  const CHECK = {
    reference: (v) => (v.trim().length >= 6 ? '' : t('Enter the reference from your invoice or WhatsApp.')),
    phone: (v) => (/^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, ''))
      ? '' : t('Enter the 10 digit mobile number the order was placed with.')),
  };

  const fields = {};
  for (const key of Object.keys(CHECK)) {
    const input = form.querySelector(`[name="${key}"]`);
    if (!input) continue;
    const wrap = input.closest('.field');
    fields[key] = { input, wrap, err: wrap && wrap.querySelector('.field__err') };
  }

  const ok = (key) => CHECK[key](fields[key] ? fields[key].input.value : '') === '';
  const ready = () => Object.keys(CHECK).every(ok);

  function showError(key, show) {
    const f = fields[key];
    if (!f) return;
    const msg = show ? CHECK[key](f.input.value) : '';
    if (f.err) f.err.textContent = msg;
    if (f.wrap) f.wrap.classList.toggle('is-bad', Boolean(msg));
  }

  function say(message, bad) {
    if (!note) return;
    note.textContent = message || '';
    note.classList.toggle('is-bad', Boolean(bad));
  }

  function render() {
    if (button) button.setAttribute('aria-disabled', ready() ? 'false' : 'true');
  }

  for (const key of Object.keys(fields)) {
    const f = fields[key];
    f.input.addEventListener('blur', () => { showError(key, f.input.value !== ''); render(); });
    f.input.addEventListener('input', () => {
      // Only correct an error already on screen; do not scold mid-typing.
      if (f.wrap && f.wrap.classList.contains('is-bad')) showError(key, true);
      render();
    });
  }

  // ---------------------------------------------------------------- painting
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text; // never innerHTML
    return n;
  };

  /** "26 Sep, 4:30 pm" for something that happened, nothing for something that has not. */
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(english ? 'en-IN' : `${lang.code}-IN-u-nu-latn`, {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d);
  }

  /**
   * "Rs 589" for a figure someone is checking against their bank statement.
   *
   * Intl with currency INR would render "₹589.00", and the trailing .00 on a rupee amount
   * that is always whole reads like a spreadsheet. maximumFractionDigits:0 keeps the
   * grouping (₹24,999) without the noise.
   */
  function rupees(inr) {
    // Zero is not a figure worth showing: "Rs 0 paid" on an order that cost something is a
    // bug report, and an order that genuinely cost nothing does not exist in this catalogue.
    if (typeof inr !== 'number' || !Number.isFinite(inr) || inr <= 0) return '';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', maximumFractionDigits: 0,
    }).format(inr);
  }

  /**
   * One sentence on how the order reaches the customer, or nothing.
   *
   * Nothing once the order is far enough along that the headline already says it: repeating
   * "on its way to you" under a headline reading "On its way" is filler. The server owns the
   * status wording, so this keys off its own step data rather than parsing the headline.
   */
  function deliveryLine(order) {
    const done = (key) => (order.steps || []).some((s) => s.key === key && s.done);
    // A cancelled order is not going anywhere; promising a parcel under a "Cancelled"
    // headline is the one sentence here that must never appear.
    if (done('cancelled')) return '';
    if (done('delivered') || done('collected') || done('shipped') || done('ready')) return '';
    if (order.delivery === 'dealership') {
      return t('You will collect this from your dealership. We will tell you when it is ready.');
    }
    if (order.delivery === 'ship') {
      return t('This will be shipped to the address on your order.');
    }
    return '';
  }

  const COPY_ICON = 'M9 9V6.5A1.5 1.5 0 0 1 10.5 5h7A1.5 1.5 0 0 1 19 6.5v7a1.5 1.5 0 0 1-1.5 1.5H15'
    + 'M6.5 9h7A1.5 1.5 0 0 1 15 10.5v7A1.5 1.5 0 0 1 13.5 19h-7A1.5 1.5 0 0 1 5 17.5v-7A1.5 1.5 0 0 1 6.5 9z';

  function copyButton(value) {
    const b = el('button', 'track__copy');
    b.type = 'button';
    b.setAttribute('aria-label', t('Copy the consignment number'));
    // A constant, not anything from the response.
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${COPY_ICON}"/></svg>`;
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        b.dataset.copied = 'true';
        b.setAttribute('aria-label', t('Copied'));
        window.setTimeout(() => {
          b.dataset.copied = 'false';
          b.setAttribute('aria-label', t('Copy the consignment number'));
        }, 1600);
      } catch {
        // No clipboard permission, or an insecure context. The number is on screen and
        // selectable, so this is a convenience that is allowed to fail silently.
      }
    });
    return b;
  }

  // Constants, never anything from the response.
  const CALL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5h2.3c.5 0 .9.3 1 .8l.7 3.1c.1.4 0 .8-.3 1.1L8.8 10a11.5 11.5 0 0 0 5.2 5.2l1.5-1.5c.3-.3.7-.4 1.1-.3l3.1.7c.5.1.8.5.8 1v2.3c0 1.1-.9 2-2 2A15.5 15.5 0 0 1 4.6 5.5c0-1.1.9-2 2-2z"/></svg>';
  const DIRECTIONS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 11.3 19.2 4.8l-6.5 14.7-1.7-6.5z"/></svg>';

  /**
   * A map link, but only one that opens Google Maps itself, over https. The URL is typed by a
   * member of staff, so anything else (another site, a javascript: link) is simply not shown.
   */
  function mapsLink(raw) {
    let url;
    try {
      url = new URL(String(raw || ''));
    } catch {
      return '';
    }
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    const host = url.hostname.toLowerCase();
    const ok = host === 'maps.google.com' || host === 'maps.app.goo.gl'
      || ((host === 'google.com' || host === 'www.google.com') && /^\/maps(\/|$)/.test(url.pathname));
    return ok ? url.href : '';
  }

  /** Where a dealership order is waiting, and the two ways to get there. */
  function collectBlock(from) {
    if (!from || typeof from !== 'object' || !from.name) return null;
    const box = el('section', 'track__collect');
    box.setAttribute('aria-label', t('Collect from'));
    box.append(el('h4', 'track__collect-label', t('Collect from')));
    box.append(el('p', 'track__collect-name', from.name));
    if (from.address) box.append(el('p', 'track__collect-text', from.address));
    if (from.hoursNote) box.append(el('p', 'track__collect-note', from.hoursNote));

    const actions = el('div', 'track__collect-actions');
    const phone = from.phone && typeof from.phone === 'object' ? from.phone : null;
    const e164 = phone && typeof phone.e164 === 'string' ? phone.e164.replace(/[^\d+]/g, '') : '';
    if (/^\+\d{8,15}$/.test(e164)) {
      // The number is the link's label and nowhere else on the card. data-topic tells the
      // analytics tap apart from a call to GridX itself.
      const call = el('a', 'track__action');
      call.href = `tel:${e164}`;
      call.dataset.topic = 'dealer';
      call.setAttribute('aria-label', t('Call {name}, {phone}', { name: from.name, phone: phone.display || e164 }));
      call.innerHTML = CALL_ICON;
      call.append(el('span', null, phone.display || e164));
      actions.append(call);
    }
    const map = mapsLink(from.mapsUrl);
    if (map) {
      const go = el('a', 'track__action');
      go.href = map;
      go.target = '_blank';
      go.rel = 'noopener noreferrer';
      go.setAttribute('aria-label', t('Directions to {name}, opens Google Maps', { name: from.name }));
      go.innerHTML = DIRECTIONS_ICON;
      go.append(el('span', null, t('Directions')));
      actions.append(go);
    }
    if (actions.childElementCount) box.append(actions);
    return box;
  }

  /** "Something not right?", opening the contact form on this order (support-form.js). */
  function helpLine(reference) {
    const line = el('p', 'track__help', `${t('Something not right?')} `);
    const ask = el('button', 'track__help-link', t('Tell us about it'));
    ask.type = 'button';
    ask.dataset.supportOpen = 'message';
    ask.dataset.topic = 'order';
    if (reference) ask.dataset.orderRef = reference;
    ask.setAttribute('aria-haspopup', 'dialog');
    ask.setAttribute('aria-controls', 'support-sheet');
    line.append(ask);
    return line;
  }

  /**
   * What the money is doing on a cancelled order, or nothing.
   *
   * The timeline says "Refund initiated" or "Refund processed"; this sentence adds the two
   * things the steps cannot carry: the figure to check against a bank statement, and how
   * long banks take. The server owns whether a refund exists (refundedInr is null until one
   * does), so this only words what it was given.
   */
  function refundLine(order) {
    const amount = rupees(order.refundedInr);
    if (!amount) return '';
    const done = (key) => (order.steps || []).some((s) => s.key === key && s.done);
    if (done('refund_processed')) {
      return t('A refund of {amount} has been processed to your original payment method. It usually shows in your bank account within 5 to 7 working days.', { amount });
    }
    return t('A refund of {amount} is on its way to your original payment method. It usually reaches your bank account within 5 to 7 working days.', { amount });
  }

  function paint(order) {
    result.textContent = '';

    const cancelled = (order.steps || []).some((s) => s.key === 'cancelled' && s.done);

    const head = el('h3', 'track__headline', english ? order.headline : HEADLINES[order.headlineKey] || order.headline);
    head.tabIndex = -1;
    result.append(head);

    const summary = summaryOf(order);
    if (summary) result.append(el('p', 'track__summary', summary));

    // Reference and amount on one line: the two things someone cross-checks. On a cancelled
    // order the figure that matters is the refund, which gets its own sentence; "paid" next
    // to "Cancelled" would read as a contradiction.
    const ref = el('p', 'track__ref', t('Order reference {reference}', { reference: order.reference }));
    const paid = rupees(order.chargedInr);
    if (paid && !cancelled) {
      ref.append(document.createTextNode(' \u00b7 '));
      ref.append(el('span', 'track__paid', t('{amount} paid', { amount: paid })));
    }
    result.append(ref);

    const refund = refundLine(order);
    if (refund) result.append(el('p', 'track__refund', refund));

    const delivery = deliveryLine(order);
    if (delivery) result.append(el('p', 'track__delivery', delivery));

    // Where to go, above the timeline: it is what someone with a ready order needs next.
    const collect = collectBlock(order.collectFrom);
    if (collect) result.append(collect);

    const list = el('ol', 'track__steps');
    for (const step of order.steps || []) {
      const mods = `${step.done ? ' track__step--done' : ''}${step.key === 'cancelled' ? ' track__step--cancelled' : ''}`;
      const li = el('li', `track__step${mods}`);
      li.append(el('span', 'track__step-label', english ? step.label : STEPS[step.key] || step.label));
      const at = when(step.at);
      if (at) li.append(el('span', 'track__step-at', at));

      // The courier rides under the step it belongs to, so it reads as part of that event
      // rather than as a detached fact at the bottom of the card.
      if (step.key === 'shipped' && step.done && order.courier) {
        const row = el('div', 'track__courier');
        if (order.courier.partner) row.append(el('span', null, order.courier.partner));
        if (order.courier.awb) {
          row.append(el('span', 'track__awb', order.courier.awb));
          row.append(copyButton(order.courier.awb));
        }
        li.append(row);
      }
      list.append(li);
    }
    result.append(list);

    result.append(helpLine(order.reference));

    result.hidden = false;
    // Move focus to the answer, so a screen reader lands on it rather than being left on
    // the button that has just stopped being the point.
    head.focus?.({ preventScroll: true });
  }

  // ---------------------------------------------------------------- submitting
  let busy = false;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;

    if (!ready()) {
      for (const key of Object.keys(fields)) showError(key, true);
      const bad = Object.keys(CHECK).find((k) => !ok(k));
      if (bad && fields[bad]) fields[bad].input.focus();
      say(bad ? CHECK[bad](fields[bad].input.value) : '', true);
      return;
    }

    if (!window.gridxApi) {
      say(t('Could not reach GridX. Please check your connection and try again.'), true);
      return;
    }

    busy = true;
    result.hidden = true;
    say(t('Checking.'));
    button.setAttribute('aria-busy', 'true');

    window.gridxApi.postJSON('/api/public/website/orders/track', {
      reference: refInput.value,
      phone: phoneInput.value,
    })
      .then((res) => {
        say('');
        paint(res.order);
        count('found');
      })
      .catch((err) => {
        // A 404 is the server's "no such order with that number"; anything else went wrong.
        count(err.status === 404 ? 'not_found' : 'error');
        // Two failures never reached the server, so err.message is the browser's own
        // wording rather than ours. A 20s timeout aborts the fetch (gridx-api.js) and reads
        // as "The user aborted a request", which sounds like the customer did something;
        // a dropped connection reads as "Failed to fetch". Neither is a sentence to show
        // someone waiting on an order. A response always carries err.status, so its absence
        // is what tells these apart from anything the server said.
        if (err.name === 'AbortError') {
          say(t('That took too long to come back. Please try again in a moment.'), true);
          return;
        }
        if (err.status === undefined) {
          say(t('Could not reach GridX. Please check your connection and try again.'), true);
          return;
        }

        // The server sends one message for every kind of failure, on purpose: it must not
        // say whether it was the reference or the phone that was wrong. Show what it said.
        const tooMany = err.status === 429;
        // In another language, Paddock's sentence in that language (gridx-api.js knows them).
        const words = english || !window.gridxApi.describeError ? err.message : window.gridxApi.describeError(err, t('We could not find an order with those details.'));
        say(words || t('We could not find an order with those details.'), !tooMany);
      })
      .finally(() => {
        busy = false;
        button.removeAttribute('aria-busy');
      });
  });

  // ---------------------------------------------------------------- arriving
  /*
   * If the order was placed in this tab, offer the reference back rather than making
   * someone dig it out of WhatsApp. sessionStorage, not localStorage: it dies with the tab,
   * is never shared between visitors on a shared machine, and never reaches a URL.
   */
  let prefilled = false;
  try {
    const last = window.sessionStorage.getItem(LAST_REF);
    if (last && refInput && !refInput.value) {
      refInput.value = last;
      prefilled = true;
      say(t('Filled in the reference from the order you just placed.'));
    }
  } catch {
    // Private mode, or storage blocked. Nothing here is load bearing.
  }

  // Someone who just placed an order has come here to track it, so the form is open for them
  // rather than folded away with a note inside it that nobody can see. A link to #track opens
  // it too, which disclose.js does for any disclosure.
  if (prefilled && window.gridDisclose) window.gridDisclose.open(form.closest('.disclose'));

  // A link from a confirmation lands on #track; put the cursor where it is useful.
  if (window.location.hash === '#track') {
    const target = refInput && refInput.value ? phoneInput : refInput;
    target?.focus({ preventScroll: true });
  }

  render();
})();
