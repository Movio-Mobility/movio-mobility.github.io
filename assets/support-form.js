/*
 * The contact form on the support page: "Request a callback" and "Write to us".
 *
 * One sheet (dialog#support-sheet in support.html) for both. How a sheet behaves is sheet.js's;
 * this file owns what is in it: the questions, the checks, the request to Paddock and the
 * answer. Paddock writes the request and sends the WhatsApp confirmation itself, server side,
 * so the page only ever says what the server has already confirmed it will do.
 *
 * OPENED BY anything carrying data-support-open="callback" or "message" (with an optional
 * data-topic, and data-order-ref for a reference to fill in, which is how track.js's
 * "Something not right?" arrives on the order), and by the links support.html#callback and
 * support.html#write, which take a topic too: #callback?topic=order.
 *
 * THE SAME RULES AS THE SERVER. Every check below is Paddock's validateSupportInput, so the
 * form never sends what will come straight back. When the server does object (a 400 with its
 * fields), each message is put on the input it names. A 429 says how long to wait; any other
 * failure is said the way order tracking says it (gridxApi.describeError).
 *
 * WHAT IS KEPT. A draft of the answers lives in sessionStorage while the tab is open, so a
 * closed sheet or a reload loses nothing; the consent box is never part of it, and a sent
 * request clears it. The order reference may be offered from gridx.lastOrder, which
 * order-sheet.js writes to sessionStorage (this tab only) after a payment.
 *
 * QUIET SAFEGUARDS. A hidden field (company_website) that only a script fills, and the time
 * since the form first opened (elapsedMs): Paddock answers either with a believable success
 * and keeps nothing. reCAPTCHA Enterprise scores the request (action support_contact), loaded
 * the way the order sheet loads it, when the sheet first opens.
 *
 * A half-filled form is not swiped away: the sheet's swipe to dismiss is off while it holds
 * anything (canSwipe). The close button and Esc still close it, and the draft keeps the words.
 * On a phone the field being typed in stays above the keyboard (assets/keyboard.js).
 *
 * Analytics (analytics.js): support_form_open and support_form_submit, with no properties.
 * Nothing typed here is ever sent to analytics.
 */
(() => {
  'use strict';

  const sheetEl = document.getElementById('support-sheet');
  if (!sheetEl || !window.gridSheet || typeof window.gridSheet.create !== 'function') return;
  const form = sheetEl.querySelector('#support-form');
  if (!form) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const KINDS = ['callback', 'message'];
  const TOPICS = ['order', 'product', 'dealer', 'charging', 'other'];
  // Paddock's PREFERRED_TIMES, worded as it words them in the WhatsApp confirmation.
  const TIMES = {
    morning: 'in the morning',
    afternoon: 'in the afternoon',
    evening: 'in the evening',
    any: 'at a convenient time',
  };
  // The hours published beside the phone number (assets/contact.js), and the hours Paddock's
  // support clock counts in. Change all three together.
  const HOURS = 'Monday to Friday, 11 AM to 6 PM';
  const MESSAGE_MIN = 10;
  const MESSAGE_MAX = 2000;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const DRAFT_KEY = 'gridx.supportDraft';
  const LAST_REF = 'gridx.lastOrder';

  const track = (name) => {
    if (typeof window.gridTrack === 'function') window.gridTrack(name);
  };

  const session = (() => {
    try { return window.sessionStorage; } catch { return null; }
  })();
  const readStore = (key) => {
    try { return session ? session.getItem(key) : null; } catch { return null; }
  };
  const writeStore = (key, value) => {
    try {
      if (!session) return;
      if (value === null) session.removeItem(key);
      else session.setItem(key, value);
    } catch {
      // Private mode, or storage full. The form works without a draft.
    }
  };

  // ---------------------------------------------------------------- the parts
  const $ = (sel) => sheetEl.querySelector(sel);
  const scroller = $('.story__scroll');
  const askEl = $('#support-ask');
  const doneEl = $('#support-done');
  const lede = $('#support-lede');
  const refField = $('#s-ref-field');
  const timeField = $('#s-time-field');
  const phoneHint = $('#hs-phone');
  const messageLabel = $('#ls-message');
  const counter = $('#cs-message');
  const consent = $('#s-consent');
  const trap = $('#s-company');
  const promiseLabel = $('#support-promise-label');
  const promiseValue = $('#support-promise-value');
  const promise = $('#support-promise');
  const sendBtn = $('#support-send');
  const sendLabel = $('#support-send-label');
  const finishBtn = $('#support-finish');
  const hint = $('#support-hint');

  const radios = (name) => [...form.querySelectorAll(`input[type="radio"][name="${name}"]`)];
  const picked = (name) => {
    const hit = radios(name).find((r) => r.checked);
    return hit ? hit.value : '';
  };
  const pick = (name, value) => {
    for (const r of radios(name)) r.checked = r.value === value;
  };
  const input = (name) => form.querySelector(`[name="${name}"]`);
  const text = (name) => {
    const el = input(name);
    return el ? el.value : '';
  };

  /** A 10 digit Indian mobile from whatever was typed (+91, 0, spaces, dashes), or ''. */
  function mobile(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return /^[6-9]\d{9}$/.test(digits) ? digits : '';
  }

  const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const cleanRef = (v) => String(v || '').replace(/\s+/g, '').replace(/^gx-?/i, 'GX-');
  const messageLength = () => text('message').trim().length;

  // ---------------------------------------------------------------- the checks
  // Paddock's validateSupportInput, message for message.
  const CHECK = {
    kind: () => (KINDS.includes(picked('kind')) ? '' : 'Choose a callback or a message.'),
    topic: () => (TOPICS.includes(picked('topic')) ? '' : 'Choose what this is about.'),
    orderRef: () => {
      if (picked('topic') !== 'order') return '';
      const ref = cleanRef(text('orderRef'));
      return !ref || /^[A-Za-z0-9-]{4,40}$/.test(ref) ? '' : 'That does not look like an order reference.';
    },
    name: () => (cleanName(text('name')).length >= 2 ? '' : 'Enter your name.'),
    phone: () => (mobile(text('phone')) ? '' : 'Enter a 10 digit Indian mobile number.'),
    email: () => {
      const v = text('email').trim();
      return !v || (v.length <= 160 && EMAIL.test(v)) ? '' : 'Enter a valid email address, or leave it empty.';
    },
    message: () => {
      const n = messageLength();
      if (n < MESSAGE_MIN) return 'Tell us a little more (at least 10 characters).';
      if (n > MESSAGE_MAX) return 'Please keep it to 2,000 characters.';
      return '';
    },
    consent: () => (consent && consent.checked ? '' : 'Please agree so we can contact you about this.'),
  };
  const ORDER = ['kind', 'topic', 'orderRef', 'name', 'phone', 'email', 'message', 'consent'];

  // Where each check shows: the wrapper that turns red, the line that says why, what to focus.
  const fields = {
    kind: { wrap: $('#s-kind'), err: $('#es-kind'), focus: () => radios('kind')[0] },
    topic: { wrap: $('#s-topic'), err: $('#es-topic'), focus: () => radios('topic')[0] },
    orderRef: { wrap: refField, err: $('#es-ref'), focus: () => input('orderRef') },
    name: { wrap: input('name').closest('.field'), err: $('#es-name'), focus: () => input('name') },
    phone: { wrap: input('phone').closest('.field'), err: $('#es-phone'), focus: () => input('phone') },
    email: { wrap: input('email').closest('.field'), err: $('#es-email'), focus: () => input('email') },
    message: { wrap: input('message').closest('.field'), err: $('#es-message'), focus: () => input('message') },
    consent: { wrap: $('#s-consent-field'), err: $('#es-consent'), focus: () => consent },
    preferredTime: { wrap: timeField, err: $('#es-time'), focus: () => radios('preferredTime')[0] },
  };

  /** What the server said about a field, shown until that field is changed. */
  const serverSaid = {};

  const ok = (key) => !serverSaid[key] && (!CHECK[key] || CHECK[key]() === '');
  const ready = () => ORDER.every(ok);

  function showError(key, show) {
    const f = fields[key];
    if (!f) return;
    const msg = show ? (serverSaid[key] || (CHECK[key] ? CHECK[key]() : '')) : '';
    if (f.err) f.err.textContent = msg;
    if (f.wrap) f.wrap.classList.toggle('is-bad', Boolean(msg));
  }

  function say(message, bad) {
    if (!hint) return;
    hint.textContent = message || '';
    hint.classList.toggle('is-bad', Boolean(bad));
  }

  // ---------------------------------------------------------------- render
  let busy = false;
  let sent = false;

  function render() {
    const kind = picked('kind') || 'callback';
    const callback = kind === 'callback';

    if (lede) {
      lede.textContent = callback
        ? 'Leave your number and someone at GridX will call you back.'
        : 'Tell us what you need and someone at GridX will write back to you.';
    }
    if (refField) refField.hidden = picked('topic') !== 'order';
    if (timeField) timeField.hidden = !callback;
    if (phoneHint) {
      phoneHint.textContent = callback
        ? 'We will call you on this number, and send your confirmation here on WhatsApp.'
        : 'We will send your confirmation here on WhatsApp.';
    }
    if (messageLabel) messageLabel.textContent = callback ? 'What would you like to talk about?' : 'Your message';
    if (promiseLabel) promiseLabel.textContent = callback ? 'Monday to Friday' : 'We reply';
    if (promiseValue) promiseValue.textContent = callback ? '11 AM to 6 PM' : 'Within a working day';
    if (sendLabel && !busy) sendLabel.textContent = callback ? 'Request callback' : 'Send message';

    if (counter) {
      const n = messageLength();
      counter.textContent = `${n.toLocaleString('en-IN')} / 2,000`;
      counter.classList.toggle('is-near', n > MESSAGE_MAX * 0.9 && n <= MESSAGE_MAX);
      counter.classList.toggle('is-over', n > MESSAGE_MAX);
    }

    if (sendBtn) sendBtn.setAttribute('aria-disabled', ready() && !busy ? 'false' : 'true');
  }

  // ---------------------------------------------------------------- the draft
  const DRAFTED = ['kind', 'topic', 'orderRef', 'name', 'phone', 'email', 'preferredTime', 'message'];
  const RADIO = new Set(['kind', 'topic', 'preferredTime']);

  function saveDraft() {
    if (sent) return;
    const draft = {};
    for (const key of DRAFTED) {
      const v = RADIO.has(key) ? picked(key) : text(key);
      if (v) draft[key] = v;
    }
    writeStore(DRAFT_KEY, Object.keys(draft).length ? JSON.stringify(draft) : null);
  }

  let draftTimer = 0;
  const saveSoon = () => {
    window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(saveDraft, 250);
  };

  function restoreDraft() {
    let draft = null;
    try {
      draft = JSON.parse(readStore(DRAFT_KEY) || 'null');
    } catch {
      draft = null;
    }
    if (!draft || typeof draft !== 'object') return;
    for (const key of DRAFTED) {
      const v = draft[key];
      if (typeof v !== 'string' || !v) continue;
      if (RADIO.has(key)) pick(key, v);
      else if (input(key)) input(key).value = v.slice(0, key === 'message' ? MESSAGE_MAX * 2 : 200);
    }
  }

  /** Holding anything worth keeping: then a stray swipe must not close it. */
  const dirty = () => !sent && ['name', 'phone', 'email', 'message'].some((k) => text(k).trim() !== '');

  // ---------------------------------------------------------------- the sheet
  let keyboard = null;
  let openedAt = 0; // when the form first opened on this page, for elapsedMs
  let fromHash = false;

  const sheet = window.gridSheet.create(sheetEl, {
    halo: true, // the field gathers behind the glass, as it does behind the store's sheets
    canSwipe: () => !dirty(),
    onOpen() {
      if (window.gridKeyboard) keyboard = window.gridKeyboard.watch({ shell: sheetEl, scope: form, scroller });
    },
    onClose() {
      if (keyboard) keyboard.stop();
      keyboard = null;
      saveDraft();
      // A link that opened the form (#write) is spent: Back or a reload should not reopen it.
      if (fromHash && /^#(callback|write)\b/.test(window.location.hash)) {
        history.replaceState(history.state, '', window.location.pathname + window.location.search);
      }
      fromHash = false;
      if (sent) reset();
    },
  });

  /** The order this tab has just paid for, offered when the topic is an order. */
  function offerLastOrder() {
    const ref = input('orderRef');
    if (!ref || ref.value) return;
    const last = readStore(LAST_REF);
    if (last && /^[A-Za-z0-9-]{4,40}$/.test(last)) ref.value = last;
  }

  /**
   * @param {{ kind?: string, topic?: string, orderRef?: string, returnTo?: HTMLElement }} [opts]
   */
  function open(opts = {}) {
    if (sheet.isOpen()) return;
    if (sent) reset();
    // Someone opening this form is about to send it: fetch the check now, not on Send.
    if (window.gridxApi && window.gridxApi.loadRecaptcha) window.gridxApi.loadRecaptcha();

    const kind = opts.kind === 'write' ? 'message' : opts.kind;
    if (KINDS.includes(kind)) pick('kind', kind);
    else if (!picked('kind')) pick('kind', 'callback');
    if (TOPICS.includes(opts.topic)) pick('topic', opts.topic);
    if (opts.orderRef && /^[A-Za-z0-9-]{4,40}$/.test(String(opts.orderRef))) input('orderRef').value = String(opts.orderRef);
    if (picked('topic') === 'order') offerLastOrder();
    if (!picked('preferredTime')) pick('preferredTime', 'any');

    if (!openedAt) openedAt = performance.now();
    if (scroller) scroller.scrollTop = 0;
    render();
    sheet.open(opts.returnTo || null);
    track('support_form_open');
  }

  // ---------------------------------------------------------------- typing
  function edited(key) {
    if (serverSaid[key]) {
      delete serverSaid[key];
      showError(key, true);
    }
    const f = fields[key];
    // Only correct an error already on screen; do not scold mid-typing.
    if (f && f.wrap && f.wrap.classList.contains('is-bad')) showError(key, true);
  }

  function onEdit(event) {
    const name = event.target.name;
    if (!name || name === 'company_website') return;
    edited(name);
    if (name === 'topic' && picked('topic') === 'order') offerLastOrder();
    if (name === 'topic' || name === 'kind') {
      // A change of topic can take the reference field away, and its error with it.
      showError('orderRef', false);
    }
    if (!sent) saveSoon();
    say('');
    render();
  }
  // Text as it is typed; a chip or the box once it has changed (every browser says change for
  // those, not all of them say input).
  const choosing = (el) => el.type === 'radio' || el.type === 'checkbox';
  form.addEventListener('input', (event) => { if (!choosing(event.target)) onEdit(event); });
  form.addEventListener('change', (event) => { if (choosing(event.target)) onEdit(event); });

  for (const key of ['orderRef', 'name', 'phone', 'email', 'message']) {
    const el = input(key);
    if (!el) continue;
    el.addEventListener('blur', () => {
      if (key === 'name') el.value = el.value.replace(/\s+/g, ' ').trim();
      if (key === 'orderRef') el.value = el.value.trim();
      showError(key, el.value.trim() !== '');
      render();
    });
  }

  // Enter in a one-line box is the keyboard's Next: on to the following box, which the
  // keyboard handling keeps in view. A textarea keeps Enter for a new line.
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target.tagName !== 'INPUT' || !event.target.matches('.field__input')) return;
    event.preventDefault();
    const boxes = [...form.querySelectorAll('.field__input')].filter((b) => !b.closest('[hidden]'));
    const next = boxes[boxes.indexOf(event.target) + 1];
    if (next) next.focus({ preventScroll: true });
  });

  // ---------------------------------------------------------------- sending
  /** The campaign the visit came from, as analytics.js kept it for the session. */
  function utm() {
    try {
      const kept = JSON.parse(readStore('gridx.utm') || 'null');
      if (!kept || typeof kept !== 'object') return undefined;
      const out = {};
      for (const k of ['source', 'medium', 'campaign', 'content']) {
        if (typeof kept[k] === 'string' && kept[k]) out[k] = kept[k].slice(0, 60);
      }
      return Object.keys(out).length ? out : undefined;
    } catch {
      return undefined;
    }
  }

  /** The server's per-field messages, either shape: [{ field, message }] or { field: message }. */
  function markServerFields(list) {
    const pairs = Array.isArray(list)
      ? list.map((f) => [f && f.field, f && f.message])
      : Object.entries(list || {});
    const marked = [];
    let unplaced = '';
    for (const [field, message] of pairs) {
      if (typeof field !== 'string' || typeof message !== 'string') continue;
      const f = fields[field];
      if (!f || !f.wrap || f.wrap.hidden || (f.wrap.closest && f.wrap.closest('[hidden]'))) {
        unplaced = unplaced || message;
        continue;
      }
      serverSaid[field] = message;
      showError(field, true);
      marked.push(field);
    }
    const first = ORDER.concat('preferredTime').find((k) => marked.includes(k));
    if (first) fields[first].focus()?.focus({ preventScroll: false });
    return unplaced;
  }

  async function send() {
    busy = true;
    sendBtn.setAttribute('aria-busy', 'true');
    if (sendLabel) sendLabel.textContent = 'Sending';
    say('');
    render();
    track('support_form_submit');

    const api = window.gridxApi;
    const kind = picked('kind');
    const topic = picked('topic');
    const ref = cleanRef(text('orderRef'));
    const email = text('email').trim().toLowerCase();
    const body = {
      kind,
      name: cleanName(text('name')),
      phone: `+91${mobile(text('phone'))}`,
      email: email || undefined,
      topic,
      orderRef: topic === 'order' && ref ? ref : undefined,
      message: text('message').trim(),
      preferredTime: kind === 'callback' ? (picked('preferredTime') || 'any') : undefined,
      consent: true,
      recaptchaToken: null,
      // Never filled by this script, only ever by one that fills every box it finds.
      company_website: trap ? trap.value : '',
      elapsedMs: Math.max(0, Math.round(performance.now() - openedAt)),
      sourcePage: window.location.pathname,
      utm: utm(),
    };

    try {
      if (!api) throw Object.assign(new Error(''), { kind: 'offline' });
      body.recaptchaToken = api.recaptchaToken ? await api.recaptchaToken('support_contact') : null;
      const res = await api.postJSON('/api/public/website/support', body);
      done(res && typeof res.reference === 'string' ? res.reference : '');
    } catch (err) {
      let message = api ? api.describeError(err, 'We could not send that just now. Please try again, or call us.')
        : 'Could not reach GridX. Check your connection and try again.';
      if (err && err.status === 400 && err.fields) {
        const unplaced = markServerFields(err.fields);
        if (unplaced) message = unplaced;
      }
      say(message, true);
    } finally {
      busy = false;
      sendBtn.removeAttribute('aria-busy');
      render();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || sent) return;
    if (!ready()) {
      for (const key of ORDER) showError(key, true);
      const bad = ORDER.find((k) => !ok(k));
      if (bad) {
        const target = fields[bad].focus();
        if (target) target.focus({ preventScroll: false });
        say(serverSaid[bad] || CHECK[bad](), true);
      }
      render();
      return;
    }
    send();
  });

  // ---------------------------------------------------------------- sent
  function done(reference) {
    sent = true;
    writeStore(DRAFT_KEY, null);
    window.clearTimeout(draftTimer);
    const callback = picked('kind') === 'callback';
    const time = TIMES[picked('preferredTime')] || TIMES.any;

    $('#support-done-title').textContent = callback ? 'We have your request.' : 'We have your message.';
    $('#support-done-ref').textContent = reference || 'On its way to you on WhatsApp';
    const when = $('#support-done-when');
    when.textContent = callback
      ? `We will call you ${time}, ${HOURS}.`
      : 'Our team will reply within one working day.';

    askEl.hidden = true;
    doneEl.hidden = false;
    if (promise) promise.hidden = true;
    sendBtn.hidden = true;
    finishBtn.hidden = false;
    say('');
    if (scroller) scroller.scrollTop = 0;
    // Off the keyboard and onto the answer, so a screen reader reads it out.
    const title = $('#support-done-title');
    if (title) title.focus({ preventScroll: true });
  }

  /** A fresh form, once a sent one has slid away. Name and number stay out of it too. */
  function reset() {
    sent = false;
    busy = false;
    form.reset();
    if (trap) trap.value = '';
    for (const key of Object.keys(serverSaid)) delete serverSaid[key];
    for (const key of Object.keys(fields)) showError(key, false);
    askEl.hidden = false;
    doneEl.hidden = true;
    if (promise) promise.hidden = false;
    sendBtn.hidden = false;
    finishBtn.hidden = true;
    openedAt = 0;
    say('');
    render();
  }

  if (finishBtn) finishBtn.addEventListener('click', () => sheet.close());

  // ---------------------------------------------------------------- the ways in
  /*
   * Delegated, and in the capture phase, so an opener added later (track.js paints one into
   * a tracked order) works with no wiring of its own, and so the link it may be (a WhatsApp
   * link for anyone without JavaScript) is stopped before anything else reads the click as a
   * WhatsApp tap.
   */
  document.addEventListener('click', (event) => {
    const hit = event.target instanceof Element ? event.target.closest('[data-support-open]') : null;
    if (!hit) return;
    if (typeof sheetEl.showModal !== 'function') return; // no dialogs: the link goes where it says
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
    event.preventDefault();
    open({
      kind: hit.dataset.supportOpen,
      topic: hit.dataset.topic,
      orderRef: hit.dataset.orderRef,
      returnTo: hit,
    });
  }, true);

  // support.html#callback, support.html#write, and either with ?topic=...
  function openFromHash() {
    const m = /^#(callback|write)(?:\?(.*))?$/.exec(window.location.hash);
    if (!m) return;
    const params = new URLSearchParams(m[2] || '');
    fromHash = true;
    open({ kind: m[1] === 'write' ? 'message' : 'callback', topic: params.get('topic') || undefined });
  }
  window.addEventListener('hashchange', openFromHash);

  window.gridSupport = { open };

  restoreDraft();
  render();
  // After the page has arrived, so the sheet slides up over it rather than being there first.
  if (/^#(callback|write)\b/.test(window.location.hash)) {
    const go = () => window.setTimeout(openFromHash, reduceMotion ? 0 : 120);
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go, { once: true });
  }
})();
