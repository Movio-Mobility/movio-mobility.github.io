/*
 * Payment confirmation, shared by accessory-flow.js and powerpod-gen2.js.
 *
 * Razorpay's handler only says the window closed happily. The webhook is what actually
 * marks an order paid, moments later, so instead of promising a receipt on the handler's
 * word, the page asks Paddock until the webhook has landed:
 *
 *   POST {base}/api/public/website/orders/confirm   { reference, phone }
 *     success:  { success: true, paid: boolean, status }
 *     failure:  a uniform 404, whatever the reason, so the endpoint can never be used to
 *               probe which references exist; 429 carries Retry-After
 *
 * confirm(reference, phone) polls that endpoint: every 2.5s for the first 20s, then every
 * 4s, giving up at 60s. A 404, a dropped connection or a 5xx is a missed poll and nothing
 * more; a 429 waits the server's Retry-After (capped to the time left). It resolves
 * { paid: true } the moment the server says paid, { paid: false } at the deadline, and
 * NEVER rejects: by this point the money may well have moved, so there is no failure to
 * report, only "confirmed" or "still checking".
 *
 * The three show* calls own the .pg2-done card both pages carry (title, body, reference
 * box, notes, links, and the tick in .pg2-done__mark; drawn by the CSS in
 * powerpod-gen2.css):
 *
 *   showPending(el, opts)   the ring spinning, "Confirming your payment."
 *   showPaid(el, opts)      the tick draws, the confirmed order, the reference, the links
 *   showTimeout(el, opts)   the webhook outran 60s: a calm "we are checking", never a
 *                           failure, because a slow webhook is almost always a paid order
 *
 * opts carries reference, email, phone, and the page's nouns ({ thing, doc }), so Gen2
 * says pre-booking and receipt voucher where an accessory says order and tax invoice. On
 * paid and on timeout the reference is written to sessionStorage['gridx.lastOrder'] for
 * the tracking form, same-tab only, exactly as the order flows always have.
 *
 * Every node is built with createElement and textContent: an email address or a phone
 * number can never be read as markup.
 *
 * For tools/check/purchase.mjs, only with ?check in the address: &confirm=<seconds>
 * shortens the 60s deadline, the way launch.js takes &launch under ?check.
 */
(() => {
  'use strict';

  const EARLY_MS = 2500;   // the webhook usually lands within a few seconds
  const EARLY_FOR = 20000; // after this, back off
  const LATE_MS = 4000;
  let deadlineMs = 60000;

  const params = new URLSearchParams(location.search);
  if (params.has('check') && Number(params.get('confirm')) > 0) {
    deadlineMs = Number(params.get('confirm')) * 1000;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------- the poll
  // One active poller: starting a new confirmation stands the previous one down, so a
  // retried payment can never race two polls against each other.
  let standDown = null;

  function cancel() {
    if (standDown) standDown();
    standDown = null;
  }

  function confirm(reference, phone) {
    cancel();
    let cancelled = false;
    standDown = () => { cancelled = true; };

    const started = Date.now();
    const left = () => started + deadlineMs - Date.now();

    return (async () => {
      for (;;) {
        if (cancelled) return { paid: false, cancelled: true };
        if (left() <= 0) return { paid: false };
        let wait = Date.now() - started < EARLY_FOR ? EARLY_MS : LATE_MS;
        try {
          if (!window.gridxApi) throw new Error('no api');
          const data = await window.gridxApi.postJSON('/api/public/website/orders/confirm',
            { reference, phone }, { timeoutMs: Math.min(10000, Math.max(3000, left())) });
          if (data && data.success === true && data.paid === true) {
            return { paid: true, status: data.status };
          }
        } catch (err) {
          // A 404, a 5xx or a dropped connection is a missed poll, never an answer. Only a
          // 429 changes anything: it says how long to stay away.
          if (err && err.status === 429) {
            const asked = Number(err.retryAfterSec);
            if (Number.isFinite(asked) && asked > 0) wait = Math.max(wait, asked * 1000);
          }
        }
        if (cancelled) return { paid: false, cancelled: true };
        await sleep(Math.max(250, Math.min(wait, left())));
      }
    })();
  }

  // ---------------------------------------------------------------- the card
  const SVG = 'http://www.w3.org/2000/svg';

  /** The tick: a ring and a check, drawn by CSS. 'pending' spins, 'wait' rests muted. */
  function tick(mode) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', `pay-tick${mode ? ` pay-tick--${mode}` : ''}`);
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('aria-hidden', 'true');
    const ring = document.createElementNS(SVG, 'circle');
    ring.setAttribute('cx', '32');
    ring.setAttribute('cy', '32');
    ring.setAttribute('r', '29');
    ring.setAttribute('pathLength', '1');
    const check = document.createElementNS(SVG, 'path');
    check.setAttribute('d', 'm21 33.5 8 8L43.5 25');
    check.setAttribute('pathLength', '1');
    svg.append(ring, check);
    return svg;
  }

  /** The pg2-done card's parts, found by structure so the two pages' ids do not matter. */
  function parts(el) {
    let mark = el.querySelector('.pg2-done__mark');
    if (!mark) {
      mark = document.createElement('div');
      mark.className = 'pg2-done__mark';
      mark.setAttribute('aria-hidden', 'true');
      el.prepend(mark);
    }
    let status = el.querySelector('.pg2-done__status');
    if (!status) {
      status = document.createElement('p');
      status.className = 'pg2-done__note pg2-done__status';
      status.setAttribute('role', 'status');
      const title = el.querySelector('.pg2-done__title');
      if (title) title.after(status);
      else el.appendChild(status);
    }
    return {
      mark,
      status,
      title: el.querySelector('.pg2-done__title'),
      body: el.querySelector('.pg2-done__body'),
      ref: el.querySelector('.pg2-done__ref'),
      refValue: el.querySelector('.pg2-done__ref span:last-child'),
      notes: [...el.querySelectorAll('.pg2-done__note:not(.pg2-done__status)')],
      links: [...el.querySelectorAll('.pg2-done__link')],
    };
  }

  const NOUNS = { thing: 'order', doc: 'tax invoice' };

  function remember(reference) {
    /*
     * For the tracking form on the support page. sessionStorage, not localStorage, and not
     * the URL: it dies with the tab, never follows a shared machine's next visitor, and a
     * reference in a query string would end up in history and in any Referer sent.
     */
    try {
      window.sessionStorage.setItem('gridx.lastOrder', String(reference || ''));
    } catch (_) {
      // Private mode, or storage blocked. The tracking form still works, it just opens empty.
    }
  }

  function showPending(el, opts = {}) {
    const p = parts(el);
    el.hidden = false;
    p.mark.replaceChildren(tick('pending'));
    if (p.title) p.title.textContent = 'Confirming your payment.';
    p.status.textContent = opts.pending
      || 'This usually takes a few seconds. Please keep this page open.';
    if (p.body) p.body.hidden = true;
    if (p.ref) p.ref.hidden = true;
    for (const note of p.notes) note.hidden = true;
    for (const link of p.links) link.hidden = true;
    if (p.title && p.title.focus) p.title.focus({ preventScroll: true });
  }

  /** The confirmed order: what the webhook has now made true, said plainly. */
  function showPaid(el, opts = {}) {
    const nouns = { ...NOUNS, ...(opts.nouns || {}) };
    const p = parts(el);
    el.hidden = false;
    p.mark.replaceChildren(tick(''));
    if (p.title) p.title.textContent = 'You are all set.';
    p.status.textContent = '';
    p.status.hidden = true;
    if (p.body) {
      p.body.hidden = false;
      const email = document.createElement('strong');
      email.textContent = String(opts.email || '');
      const phone = document.createElement('strong');
      phone.textContent = String(opts.phone || '');
      p.body.replaceChildren(
        `Your ${nouns.thing} is confirmed. Your ${nouns.doc} is on its way to `,
        email, ' and on WhatsApp to ', phone, '.',
      );
    }
    if (p.ref) p.ref.hidden = false;
    if (p.refValue) p.refValue.textContent = String(opts.reference || '');
    for (const note of p.notes) note.hidden = false;
    for (const link of p.links) link.hidden = false;
    remember(opts.reference);
    if (p.title && p.title.focus) p.title.focus({ preventScroll: true });
  }

  /**
   * The deadline passed with the webhook still out. Almost always that is a paid order and
   * a slow webhook, so this never claims a failure: it says what is true, points at the
   * tracking page, and keeps the reference handy.
   */
  function showTimeout(el, opts = {}) {
    const nouns = { ...NOUNS, ...(opts.nouns || {}) };
    const p = parts(el);
    el.hidden = false;
    p.mark.replaceChildren(tick('wait'));
    if (p.title) p.title.textContent = 'Payment received? We are checking.';
    p.status.textContent = '';
    p.status.hidden = true;
    if (p.body) {
      p.body.hidden = false;
      p.body.replaceChildren(
        `If your payment went through, your ${nouns.thing} is confirmed and your `
        + `${nouns.doc} will arrive by email and on WhatsApp shortly. You can check its `
        + 'status any time on the support page.',
      );
    }
    if (p.ref) p.ref.hidden = false;
    if (p.refValue) p.refValue.textContent = String(opts.reference || '');
    for (const note of p.notes) note.hidden = false;
    for (const link of p.links) link.hidden = false;
    remember(opts.reference);
    if (p.title && p.title.focus) p.title.focus({ preventScroll: true });
  }

  window.gridPayConfirm = { confirm, cancel, showPending, showPaid, showTimeout };
})();
