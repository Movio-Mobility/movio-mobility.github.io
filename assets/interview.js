/*
 * Choosing an interview time: the candidate's side of self-scheduling.
 *
 * GridX emails a one-off link, interview.html?t=<token>. The page's first inline script has
 * already moved the token into this tab's sessionStorage and out of the address; this file
 * reads it from there and talks to Paddock (POST careers/schedule) with it:
 *
 *   lookup         what the link offers: the times, or the booking already made
 *   book           take a time
 *   reschedule     move a booking to another offered time, until the change deadline
 *   cancel         give a booking back, until the change deadline
 *   request_other  none of the times work: a short note for the team
 *
 * What the visitor sees is one of:
 *   pick       the offered times, grouped by day in India Standard Time (their own time
 *              beside each, when they are somewhere else), a Confirm button that stays in
 *              reach, and "None of these work"
 *   booked     when, how to join (Meet, the office, or a call), add to a calendar (Google, or
 *              an .ics file for anything else), and reschedule or cancel while that is allowed
 *   empty      every time offered has gone: "None of these work" is the way on
 *   requested  the note has been sent
 *   expired, revoked, past, invalid: what happened, and to reply to the email. Every bad
 *              link reads the same, whatever was wrong with it
 *   error      Paddock could not be reached: try again
 * Someone else taking a time first (409) redraws the times where the visitor was, and says so.
 *
 * Nothing personal goes anywhere but Paddock: no events, and the token never reaches a URL.
 */
(() => {
  'use strict';

  const panel = document.querySelector('[data-iv-panel]');
  if (!panel) return;

  const PATH = '/api/public/website/careers/schedule';
  const IST = 'Asia/Kolkata';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const api = () => window.gridxApi;

  // ---------------------------------------------------------------- the token
  function readToken() {
    try {
      const t = sessionStorage.getItem('gridx.interview.t');
      if (t) return t;
    } catch (_) { /* storage blocked: the inline script kept it on window instead */ }
    return typeof window.__gridxInterviewToken === 'string' ? window.__gridxInterviewToken : '';
  }
  const token = readToken();

  // ---------------------------------------------------------------- time
  const localTz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
  })();
  const fmtCache = new Map();
  function fmt(opts, tz = IST) {
    const key = JSON.stringify([opts, tz]);
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-IN', { timeZone: tz, ...opts }));
    return fmtCache.get(key);
  }
  const upper = (s) => s.replace(/\b(am|pm)\b/g, (m) => m.toUpperCase());
  const time = (t, tz) => upper(fmt({ hour: 'numeric', minute: '2-digit', hour12: true }, tz).format(t));
  const dayKey = (t) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  /** Day words without the commas en-IN puts in: "Wednesday 14 October", "Wed 14 Oct". */
  function dayWords(t, tz, { weekday = 'long', month = 'long', year = false } = {}) {
    const parts = fmt({ weekday, day: 'numeric', month, ...(year ? { year: 'numeric' } : {}) }, tz).formatToParts(t);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    return [get('weekday'), get('day'), get('month'), year ? get('year') : ''].filter(Boolean).join(' ');
  }
  const dayTitle = (t) => dayWords(t, IST);
  const shortDay = (t, tz) => dayWords(t, tz || IST, { weekday: 'short', month: 'short' });
  const when = (t) => `${shortDay(t)}, ${time(t)}`;
  /** Whether the visitor's clock reads differently from India's at that moment. */
  const elsewhere = (t) => new Date(t).getTimezoneOffset() !== -330;
  const place = localTz ? localTz.split('/').pop().replace(/_/g, ' ') : '';

  // ---------------------------------------------------------------- small DOM helpers
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
    return n;
  }
  function button(cls, text, onClick, type = 'button') {
    const b = el('button', cls, text);
    b.type = type;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  const ICONS = {
    check: '<path d="m6.5 12.5 3.5 3.5 7.5-8"/>',
    video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    phone: '<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/>',
    calendar: '<path d="M16 19h6"/><path d="M16 2v4"/><path d="M19 16v6"/><path d="M21 12.598V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8.5"/><path d="M3 10h18"/><path d="M8 2v4"/>',
    download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  function icon(name) {
    const span = el('span', 'iv__icon');
    span.setAttribute('aria-hidden', 'true');
    // A constant from ICONS above, never anything from the network.
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  }

  // ---------------------------------------------------------------- state
  let view = null; // Paddock's last answer: the offer and any booking
  let mode = 'pick'; // 'pick' | 'reschedule'
  let selected = '';
  let busy = false;
  let message = { text: '', bad: false };
  let icsUrl = '';
  let keyboard = null;

  const roleTitle = (v) => {
    const r = v && v.role;
    if (!r) return '';
    return typeof r === 'string' ? r : r.title || '';
  };
  const deadlineOf = (v) => (v && (v.changeDeadline || v.rescheduleDeadline || v.cancelDeadline)) || null;
  const VIEW_KEYS = ['candidateFirstName', 'role', 'round', 'timeZone', 'expiresAt', 'slots', 'booked', 'canReschedule', 'canCancel', 'changeDeadline', 'rescheduleDeadline', 'cancelDeadline'];
  function merge(body) {
    if (!body || typeof body !== 'object') return;
    const next = { ...(view || {}) };
    for (const k of VIEW_KEYS) if (k in body) next[k] = body[k];
    view = next;
  }

  // ---------------------------------------------------------------- talking to Paddock
  function call(action, extra = {}) {
    const a = api();
    if (!a) return Promise.reject(Object.assign(new Error('Could not reach GridX.'), { kind: 'offline' }));
    return a.postJSON(PATH, { t: token, action, ...extra });
  }

  const say = (text, bad = false) => { message = { text, bad }; };
  const describe = (err) => (api() ? api().describeError(err) : 'Something went wrong. Please try again.');

  /** What a failure means for the page as a whole, or null when it is a message on this one. */
  function terminal(err) {
    if (err.status === 404) return 'invalid';
    if (err.status === 410 && ['expired', 'revoked', 'past'].includes(err.code)) return err.code;
    return null;
  }

  async function lookup() {
    if (!token) {
      render('invalid');
      return;
    }
    try {
      const body = await call('lookup');
      view = null;
      merge(body);
      mode = 'pick';
      render();
    } catch (err) {
      render(terminal(err) || 'error', err);
    }
  }

  async function act(action, extra, { keepPlace = true } = {}) {
    if (busy) return;
    busy = true;
    const y = window.scrollY;
    say('');
    render(null, null, { keepFocus: true });
    try {
      const body = await call(action, extra);
      busy = false;
      if (body.requested) {
        render('requested');
        return;
      }
      merge(body);
      if (body.cancelled) {
        mode = 'pick';
        selected = '';
        say('Your interview is cancelled. If you would like another time, choose one below.');
      } else if (action === 'book' || action === 'reschedule') {
        mode = 'pick';
        selected = '';
      }
      render();
      if (action !== 'cancel') focusTitle();
    } catch (err) {
      busy = false;
      const end = terminal(err);
      if (end) {
        render(end, err);
        return;
      }
      if (err.code === 'already_booked' || err.code === 'not_booked') {
        // The link's state moved under the page (booked in another tab): show what is true now.
        if (err.body && err.body.slots) merge(err.body);
        else await lookup();
        mode = 'pick';
        say(err.code === 'already_booked' ? 'This interview was already booked. Here are the details.' : '');
        render();
        return;
      }
      if (err.status === 409) {
        // Taken a moment ago by someone else: fresh times, the same place on the page.
        merge(err.body);
        const still = view && Array.isArray(view.slots) && view.slots.find((s) => s.id === selected && s.available);
        if (!still) selected = '';
        say('Someone has just taken that time. Please choose another.', true);
        render(null, null, { keepFocus: true });
        if (keepPlace) window.scrollTo({ top: y, behavior: 'auto' });
        const first = panel.querySelector('.iv__slot-input:not(:disabled)');
        if (first) first.focus({ preventScroll: true });
        return;
      }
      if (err.status === 422) {
        merge(err.body);
        mode = 'pick';
        say(err.message || 'It is too late to change this online. Please reply to the email we sent you.', true);
        render();
        return;
      }
      say(describe(err), true);
      render(null, null, { keepFocus: true });
    }
  }

  // ---------------------------------------------------------------- drawing
  function focusTitle() {
    const h = panel.querySelector('.iv__title');
    if (h) h.focus({ preventScroll: false });
  }

  function clear() {
    if (keyboard) keyboard.stop();
    keyboard = null;
    panel.textContent = '';
    panel.removeAttribute('aria-busy');
  }

  /** Which screen: forced (a dead end, or the note sent) or worked out from the view. */
  function render(forced, err, { keepFocus = false } = {}) {
    const active = keepFocus ? document.activeElement : null;
    const activeKey = active && active.dataset ? active.dataset.ivKey : '';
    const state = forced || stateOf();
    clear();
    panel.dataset.state = state;
    switch (state) {
      case 'booked': drawBooked(); break;
      case 'pick':
      case 'empty': drawPick(state === 'empty'); break;
      case 'requested': drawEnd('Thank you. We have your note.', 'We will look for times that suit you and write to you with new ones.', 'check'); break;
      case 'expired': drawEnd('This link has expired.', 'The times it offered have passed. Reply to the email we sent you and we will send new ones.'); break;
      case 'revoked': drawEnd('This link has been withdrawn.', 'There may be a newer one in your inbox. If not, reply to the email we sent you and we will sort it out.'); break;
      case 'past': drawEnd('This interview has already taken place.', 'Thank you for your time. If you have a question, reply to the email we sent you.'); break;
      case 'invalid': drawEnd('This link does not work.', 'Open it again from the email we sent you, and check that the whole link was copied. If it still does not work, reply to that email and we will send a new one.'); break;
      default: drawError(err);
    }
    if (activeKey) {
      const again = panel.querySelector(`[data-iv-key="${CSS.escape(activeKey)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function stateOf() {
    if (!view) return 'error';
    if (view.booked && mode !== 'reschedule') return 'booked';
    const open = (view.slots || []).some((s) => s.available && !(view.booked && view.booked.slotId === s.id));
    return open ? 'pick' : 'empty';
  }

  function head(eyebrowParts, title, lede) {
    const wrap = el('div', 'iv__head');
    if (eyebrowParts.length) {
      const eb = el('p', 'iv__eyebrow');
      eyebrowParts.forEach((p) => eb.append(el('span', '', p)));
      wrap.append(eb);
    }
    const h = el('h1', 'iv__title', title);
    h.tabIndex = -1;
    wrap.append(h);
    if (lede) wrap.append(el('p', 'iv__lede', lede));
    return wrap;
  }

  function roundBits(v) {
    const r = v.round || {};
    const bits = [];
    if (r.name) bits.push(r.name);
    if (r.durationMin) bits.push(`${r.durationMin} minutes`);
    return bits;
  }

  function modeLine(v) {
    const r = v.round || {};
    if (r.mode === 'onsite') return `In person, at ${r.location || 'our office in Okhla, New Delhi'}.`;
    if (r.mode === 'phone') return 'On a phone call. We will ring the number you gave us.';
    return 'On Google Meet. The link comes with your booking.';
  }

  function note(text, bad) {
    const p = el('p', `iv__message${bad ? ' is-bad' : ''}`, text);
    p.setAttribute('role', bad ? 'alert' : 'status');
    return p;
  }

  // ---- pick
  function drawPick(empty) {
    const v = view;
    const role = roleTitle(v);
    const resched = mode === 'reschedule';
    const title = empty
      ? 'All the times we offered have gone.'
      : resched ? 'Choose a new time.' : `${v.candidateFirstName ? `Hi ${v.candidateFirstName}, c` : 'C'}hoose a time.`;
    const lede = empty
      ? 'Sorry about that. Tell us what suits you and we will send new times.'
      : `${role ? `For the ${role} role. ` : ''}${modeLine(v)}`;
    panel.append(head(roundBits(v), title, lede));

    if (message.text) panel.append(note(message.text, message.bad));

    const slots = Array.isArray(v.slots) ? v.slots.slice().sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)) : [];
    if (!empty) {
      const tz = el('p', 'iv__tz');
      tz.append(icon('clock'));
      const away = slots.some((s) => elsewhere(Date.parse(s.startsAt)));
      tz.append(el('span', '', away && place
        ? `Times are in India (IST). Your own time, in ${place}, is shown under each.`
        : 'Times are in India Standard Time (IST).'));
      panel.append(tz);

      const form = el('form', 'iv__pick');
      form.noValidate = true;
      const days = new Map();
      for (const s of slots) {
        const t = Date.parse(s.startsAt);
        if (!Number.isFinite(t)) continue;
        const k = dayKey(t);
        if (!days.has(k)) days.set(k, { title: dayTitle(t), slots: [] });
        days.get(k).slots.push(s);
      }
      for (const [, day] of days) {
        const fs = el('fieldset', 'iv__day');
        const legend = el('legend', 'iv__day-title', day.title);
        fs.append(legend);
        const list = el('div', 'iv__slots');
        for (const s of day.slots) {
          const t = Date.parse(s.startsAt);
          const current = view.booked && view.booked.slotId === s.id;
          const lab = el('label', 'iv__slot');
          const input = el('input', 'iv__slot-input');
          input.type = 'radio';
          input.name = 'slot';
          input.value = s.id;
          input.dataset.ivKey = `slot-${s.id}`;
          input.disabled = !s.available || current || busy;
          input.checked = selected === s.id;
          const face = el('span', 'iv__slot-face');
          face.append(el('span', 'iv__slot-time', time(t)));
          if (current) face.append(el('span', 'iv__slot-sub', 'Your time now'));
          else if (!s.available) face.append(el('span', 'iv__slot-sub', 'Taken'));
          else if (elsewhere(t)) {
            const sameDay = fmt({ day: 'numeric' }).format(t) === fmt({ day: 'numeric' }, localTz).format(t);
            face.append(el('span', 'iv__slot-sub', `${time(t, localTz)}${sameDay ? '' : `, ${fmt({ weekday: 'short' }, localTz).format(t)}`} your time`));
          }
          lab.append(input, face);
          list.append(lab);
        }
        fs.append(list);
        form.append(fs);
      }
      form.addEventListener('change', (e) => {
        if (e.target.name !== 'slot') return;
        selected = e.target.value;
        if (message.bad) message = { text: '', bad: false };
        syncConfirm();
      });

      const bar = el('div', 'iv__confirm');
      const confirm = button('iv__btn iv__btn--primary', '', null, 'submit');
      confirm.dataset.ivKey = 'confirm';
      confirm.dataset.ivConfirm = '';
      bar.append(confirm);
      form.append(bar);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (busy) return;
        if (!selected) {
          say('Choose a time first.', true);
          render(null, null, { keepFocus: true });
          return;
        }
        act(resched ? 'reschedule' : 'book', { slotId: selected });
      });
      panel.append(form);
      syncConfirm();
    }
    if (resched) {
      panel.append(button('iv__btn iv__btn--quiet iv__keep', 'Keep my current time', () => {
        mode = 'pick';
        selected = '';
        say('');
        render();
        focusTitle();
      }));
    }

    panel.append(drawOther(empty));
  }

  function syncConfirm() {
    const b = panel.querySelector('[data-iv-confirm]');
    if (!b) return;
    const s = view && (view.slots || []).find((x) => x.id === selected);
    const label = busy ? 'Booking' : s ? `${mode === 'reschedule' ? 'Move to' : 'Confirm'} ${when(Date.parse(s.startsAt))}` : 'Choose a time';
    b.textContent = label;
    b.setAttribute('aria-disabled', !s || busy ? 'true' : 'false');
  }

  // ---- none of these work
  function drawOther(open) {
    const box = el('section', 'iv__other');
    const form = el('form', 'iv__other-form');
    form.noValidate = true;
    form.hidden = !open;
    const toggle = button('iv__link', 'None of these work for me', () => {
      form.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      const ta = form.querySelector('textarea');
      if (ta) ta.focus();
    });
    toggle.dataset.ivKey = 'other';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) box.append(toggle);

    const field = el('div', 'field');
    const label = el('label', 'field__label', 'What times would suit you?');
    label.htmlFor = 'iv-note';
    label.append(' ', el('span', 'field__opt', 'optional'));
    const ta = el('textarea', 'field__input');
    ta.id = 'iv-note';
    ta.rows = 3;
    ta.maxLength = 500;
    ta.placeholder = 'For example: weekday mornings after the 20th';
    ta.dataset.ivKey = 'note';
    const hint = el('p', 'field__hint', 'We read this ourselves and write back with new times.');
    field.append(label, ta, hint);
    const send = button('iv__btn iv__btn--secondary', 'Ask for other times', null, 'submit');
    send.dataset.ivKey = 'send-note';
    form.append(field, send);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      act('request_other', { note: ta.value.trim().slice(0, 500) }, { keepPlace: false });
    });
    box.append(form);

    if (window.gridKeyboard) keyboard = window.gridKeyboard.watch({ shell: panel, scope: form });
    return box;
  }

  // ---- booked
  function drawBooked() {
    const v = view;
    const b = v.booked;
    const start = Date.parse(b.startsAt);
    const end = Date.parse(b.endsAt);
    const role = roleTitle(v);
    const mark = el('span', 'iv__mark');
    mark.append(icon('check'));
    panel.append(mark);
    panel.append(head(roundBits(v), `You are booked${v.candidateFirstName ? `, ${v.candidateFirstName}` : ''}.`, role ? `Your interview for the ${role} role.` : ''));
    if (message.text) panel.append(note(message.text, message.bad));

    const card = el('div', 'iv__when');
    card.append(el('p', 'iv__when-day', dayWords(start, IST, { year: true })));
    card.append(el('p', 'iv__when-time', `${time(start)} to ${time(end)} IST`));
    if (elsewhere(start) && localTz) {
      card.append(el('p', 'iv__when-local', `${shortDay(start, localTz)}, ${time(start, localTz)} to ${time(end, localTz)} in ${place}`));
    }
    panel.append(card);

    panel.append(drawJoin(v, b));
    panel.append(drawCalendar(v, b, start, end));
    panel.append(drawChange(v, b, start));
  }

  function drawJoin(v, b) {
    const r = v.round || {};
    const box = el('section', 'iv__block');
    box.append(el('h2', 'iv__h2', 'How to join'));
    if (r.mode === 'onsite') {
      const where = r.location || 'D66, Pocket D, Okhla Phase 1, New Delhi 110020';
      const row = el('p', 'iv__row');
      row.append(icon('pin'), el('span', '', where));
      box.append(row);
      const maps = el('a', 'iv__btn iv__btn--secondary', 'Open in Google Maps');
      maps.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}`;
      maps.target = '_blank';
      maps.rel = 'noopener noreferrer';
      box.append(maps);
      box.append(el('p', 'iv__small', 'Please bring a photo ID, and arrive ten minutes early.'));
    } else if (r.mode === 'phone') {
      const row = el('p', 'iv__row');
      row.append(icon('phone'), el('span', '', 'We will call you on the number you gave us, at the time above.'));
      box.append(row);
    } else if (b.meetLink && /^https:\/\/meet\.google\.com\//.test(b.meetLink)) {
      const actions = el('div', 'iv__actions');
      const join = el('a', 'iv__btn iv__btn--primary');
      join.append(icon('video'), el('span', '', 'Join on Google Meet'));
      join.href = b.meetLink;
      join.target = '_blank';
      join.rel = 'noopener noreferrer';
      const copy = button('iv__btn iv__btn--secondary', '', async () => {
        let ok = false;
        try {
          await navigator.clipboard.writeText(b.meetLink);
          ok = true;
        } catch (_) { /* no clipboard: the link is printed below to copy by hand */ }
        copyLabel.textContent = ok ? 'Copied' : 'Copy it below';
        window.setTimeout(() => { copyLabel.textContent = 'Copy link'; }, 2200);
      });
      const copyLabel = el('span', '', 'Copy link');
      copy.append(icon('copy'), copyLabel);
      copy.dataset.ivKey = 'copy';
      actions.append(join, copy);
      box.append(actions);
      box.append(el('p', 'iv__small iv__link-text', b.meetLink.replace(/^https:\/\//, '')));
    } else {
      const row = el('p', 'iv__row');
      row.append(icon('video'), el('span', '', 'On Google Meet. Your link is on its way by email, and will appear here once it is ready.'));
      box.append(row);
    }
    return box;
  }

  // ---- add to calendar
  const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  function fold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 74) {
      out.push(rest.slice(0, 74));
      rest = ` ${rest.slice(74)}`;
    }
    out.push(rest);
    return out.join('\r\n');
  }

  function eventDetails(v, b) {
    const r = v.round || {};
    const role = roleTitle(v);
    const title = `GridX interview${r.name ? `: ${r.name}` : ''}`;
    const lines = [`${r.name || 'Your interview'}${role ? ` for the ${role} role` : ''} at GridX.`];
    let location = '';
    if (r.mode === 'onsite') location = r.location || 'D66, Pocket D, Okhla Phase 1, New Delhi 110020';
    else if (r.mode === 'phone') location = 'Phone call';
    else if (b.meetLink) {
      location = b.meetLink;
      lines.push(`Join on Google Meet: ${b.meetLink}`);
    } else {
      location = 'Google Meet';
      lines.push('The Google Meet link comes by email.');
    }
    lines.push('To change it, open the link in the email we sent you.');
    return { title, details: lines.join('\n'), location };
  }

  function drawCalendar(v, b, start, end) {
    const box = el('section', 'iv__block');
    box.append(el('h2', 'iv__h2', 'Add it to your calendar'));
    const { title, details, location } = eventDetails(v, b);
    const actions = el('div', 'iv__actions');

    const g = el('a', 'iv__btn iv__btn--secondary');
    g.append(icon('calendar'), el('span', '', 'Google Calendar'));
    const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${stamp(start)}/${stamp(end)}`, details, location, ctz: IST });
    g.href = `https://calendar.google.com/calendar/render?${q.toString()}`;
    g.target = '_blank';
    g.rel = 'noopener noreferrer';

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//GridX//Interview//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${icsText(`${b.slotId || 'slot'}-${stamp(start)}`)}@gridxenergy.in`,
      `DTSTAMP:${stamp(Date.now())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${icsText(title)}`,
      `DESCRIPTION:${icsText(details)}`,
      `LOCATION:${icsText(location)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:GridX interview',
      'TRIGGER:-PT30M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].map(fold).join('\r\n');
    if (icsUrl) URL.revokeObjectURL(icsUrl);
    icsUrl = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const file = el('a', 'iv__btn iv__btn--secondary');
    file.append(icon('download'), el('span', '', 'Apple, Outlook and others (.ics)'));
    file.href = icsUrl;
    file.download = 'gridx-interview.ics';
    file.dataset.ivIcs = '';

    actions.append(g, file);
    box.append(actions);
    return box;
  }

  // ---- reschedule and cancel
  function drawChange(v, b, start) {
    const box = el('section', 'iv__block iv__change');
    box.append(el('h2', 'iv__h2', 'Need to change it?'));
    const deadline = Date.parse(deadlineOf(v));
    const canMove = Boolean(v.canReschedule);
    const canCancel = Boolean(v.canCancel);
    if (!canMove && !canCancel) {
      box.append(el('p', 'iv__text', 'It is too late to change this online. Reply to the email we sent you and we will help.'));
      return box;
    }
    if (Number.isFinite(deadline)) {
      box.append(el('p', 'iv__text', `You can ${canMove ? 'move' : 'cancel'} it here until ${when(deadline)} IST. After that, reply to the email we sent you.`));
    }
    const actions = el('div', 'iv__actions');
    if (canMove) {
      const move = button('iv__btn iv__btn--secondary', 'Pick another time', () => {
        mode = 'reschedule';
        selected = '';
        say('');
        render();
        focusTitle();
      });
      move.dataset.ivKey = 'reschedule';
      actions.append(move);
    }
    if (canCancel) {
      const cancel = button('iv__btn iv__btn--quiet', 'Cancel the interview', () => {
        actions.hidden = true;
        ask.hidden = false;
        const yes = ask.querySelector('[data-iv-key="cancel-yes"]');
        if (yes) yes.focus();
      });
      cancel.dataset.ivKey = 'cancel';
      actions.append(cancel);
    }
    box.append(actions);

    const ask = el('div', 'iv__ask');
    ask.hidden = true;
    ask.append(el('p', 'iv__text iv__text--strong', `Cancel your interview on ${when(start)}?`));
    const row = el('div', 'iv__actions');
    const yes = button('iv__btn iv__btn--primary', 'Yes, cancel it', () => act('cancel', {}, { keepPlace: false }));
    yes.dataset.ivKey = 'cancel-yes';
    const no = button('iv__btn iv__btn--secondary', 'Keep it', () => {
      ask.hidden = true;
      actions.hidden = false;
    });
    row.append(yes, no);
    ask.append(row);
    box.append(ask);
    return box;
  }

  // ---- dead ends
  function drawEnd(title, text, mark = 'info') {
    const m = el('span', `iv__mark${mark === 'info' ? ' iv__mark--quiet' : ''}`);
    m.append(icon(mark));
    panel.append(m, head([], title, text));
    const link = el('a', 'iv__btn iv__btn--secondary', 'Visit gridxenergy.in');
    link.href = 'index.html';
    panel.append(link);
  }

  function drawError(err) {
    panel.append(head([], 'We could not load your interview.', err ? describe(err) : 'Check your connection and try again.'));
    const retry = button('iv__btn iv__btn--primary', 'Try again', () => {
      clear();
      panel.setAttribute('aria-busy', 'true');
      panel.append(el('p', 'iv__lede', 'Trying again.'));
      lookup();
    });
    retry.dataset.ivKey = 'retry';
    panel.append(retry);
  }

  // ---------------------------------------------------------------- the keyboard
  // The note is typed in the page itself, not in a fixed panel, so the browser keeps it in
  // view; keyboard.js says when a keyboard is up (html.is-typing), which hides the floating
  // Confirm bar so it can never sit over the field. A reveal, in case a browser leaves the
  // field under the keys: measured against the visual viewport, on its events only.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    let frame = 0;
    const reveal = () => {
      frame = 0;
      const f = document.activeElement;
      if (!f || f.id !== 'iv-note') return;
      const r = f.getBoundingClientRect();
      const top = vv.offsetTop + 12;
      const bottom = vv.offsetTop + vv.height - 12;
      if (r.bottom > bottom) window.scrollBy({ top: r.bottom - bottom, behavior: reduceMotion ? 'auto' : 'smooth' });
      else if (r.top < top) window.scrollBy({ top: r.top - top, behavior: reduceMotion ? 'auto' : 'smooth' });
    };
    vv.addEventListener('resize', () => { if (!frame) frame = requestAnimationFrame(reveal); });
  }

  lookup();
})();
