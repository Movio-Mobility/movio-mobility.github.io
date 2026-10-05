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
 * The form folds away under its heading until it is asked for: that, and the particle field
 * that follows it, is assets/disclose.js.
 */
(() => {
  'use strict';

  const form = document.getElementById('track-form');
  if (!form) return;

  const refInput = form.querySelector('[name="reference"]');
  const phoneInput = form.querySelector('[name="phone"]');
  const button = document.getElementById('track-go');
  const note = document.getElementById('track-note');
  const result = document.getElementById('track-result');

  /** The key order-sheet.js writes on a successful payment, in this tab only. */
  const LAST_REF = 'gridx.lastOrder';

  // ---------------------------------------------------------------- validation
  // Deliberately loose on the reference: the server is the only thing that can say whether
  // one is real, and a client-side guess at the format would reject valid references the
  // day the format changes. This only catches an empty field.
  const CHECK = {
    reference: (v) => (v.trim().length >= 6 ? '' : 'Enter the reference from your invoice or WhatsApp.'),
    phone: (v) => (/^(\+?91)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, ''))
      ? '' : 'Enter the 10 digit mobile number the order was placed with.'),
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
    return new Intl.DateTimeFormat('en-IN', {
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
    if (done('delivered') || done('collected') || done('shipped') || done('ready')) return '';
    if (order.delivery === 'dealership') {
      return 'You will collect this from your dealership. We will tell you when it is ready.';
    }
    if (order.delivery === 'ship') {
      return 'This will be shipped to the address on your order.';
    }
    return '';
  }

  const COPY_ICON = 'M9 9V6.5A1.5 1.5 0 0 1 10.5 5h7A1.5 1.5 0 0 1 19 6.5v7a1.5 1.5 0 0 1-1.5 1.5H15'
    + 'M6.5 9h7A1.5 1.5 0 0 1 15 10.5v7A1.5 1.5 0 0 1 13.5 19h-7A1.5 1.5 0 0 1 5 17.5v-7A1.5 1.5 0 0 1 6.5 9z';

  function copyButton(value) {
    const b = el('button', 'track__copy');
    b.type = 'button';
    b.setAttribute('aria-label', 'Copy the consignment number');
    // A constant, not anything from the response.
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${COPY_ICON}"/></svg>`;
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        b.dataset.copied = 'true';
        b.setAttribute('aria-label', 'Copied');
        window.setTimeout(() => {
          b.dataset.copied = 'false';
          b.setAttribute('aria-label', 'Copy the consignment number');
        }, 1600);
      } catch {
        // No clipboard permission, or an insecure context. The number is on screen and
        // selectable, so this is a convenience that is allowed to fail silently.
      }
    });
    return b;
  }

  function paint(order) {
    result.textContent = '';

    const head = el('h3', 'track__headline', order.headline);
    head.tabIndex = -1;
    result.append(head);

    if (order.summary) result.append(el('p', 'track__summary', order.summary));

    // Reference and amount on one line: the two things someone cross-checks.
    const ref = el('p', 'track__ref', `Order reference ${order.reference}`);
    const paid = rupees(order.chargedInr);
    if (paid) {
      ref.append(document.createTextNode(' \u00b7 '));
      ref.append(el('span', 'track__paid', `${paid} paid`));
    }
    result.append(ref);

    const delivery = deliveryLine(order);
    if (delivery) result.append(el('p', 'track__delivery', delivery));

    const list = el('ol', 'track__steps');
    for (const step of order.steps || []) {
      const li = el('li', `track__step${step.done ? ' track__step--done' : ''}`);
      li.append(el('span', 'track__step-label', step.label));
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

    result.append(el('p', 'track__help',
      'Something not right? Message us on WhatsApp and quote your reference.'));

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
      say('Could not reach GridX. Please check your connection and try again.', true);
      return;
    }

    busy = true;
    result.hidden = true;
    say('Checking.');
    button.setAttribute('aria-busy', 'true');

    window.gridxApi.postJSON('/api/public/website/orders/track', {
      reference: refInput.value,
      phone: phoneInput.value,
    })
      .then((res) => {
        say('');
        paint(res.order);
      })
      .catch((err) => {
        // Two failures never reached the server, so err.message is the browser's own
        // wording rather than ours. A 20s timeout aborts the fetch (gridx-api.js) and reads
        // as "The user aborted a request", which sounds like the customer did something;
        // a dropped connection reads as "Failed to fetch". Neither is a sentence to show
        // someone waiting on an order. A response always carries err.status, so its absence
        // is what tells these apart from anything the server said.
        if (err.name === 'AbortError') {
          say('That took too long to come back. Please try again in a moment.', true);
          return;
        }
        if (err.status === undefined) {
          say('Could not reach GridX. Please check your connection and try again.', true);
          return;
        }

        // The server sends one message for every kind of failure, on purpose: it must not
        // say whether it was the reference or the phone that was wrong. Show what it said.
        const tooMany = err.status === 429;
        say(err.message || 'We could not find an order with those details.', !tooMany);
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
      say('Filled in the reference from the order you just placed.');
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
