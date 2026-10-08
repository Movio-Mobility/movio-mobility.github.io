/*
 * Analytics, first party and cookieless.
 *
 * WHAT IS SENT, to Paddock only (paddockgridx.app, through gridxApi.beacon):
 *
 *   pageview   one per page actually seen: the path, the referring site reduced to its origin,
 *              whether this is the tab's first page, the campaign tags the visit arrived with
 *              (utm source, medium, campaign and content, lower cased), a coarse device bucket
 *              (mobile, tablet or desktop, from whether it is a touch screen and the window's
 *              size, plus the window's width and height in CSS pixels and its pixel density,
 *              which Paddock files into a handful of width and density buckets) and the
 *              browser's language.
 *   event      named actions from a fixed list (ALLOW below), each with only the properties
 *              that list names: an order sheet opened for a SKU, a FAQ opened by its id, a tap on
 *              a call, WhatsApp or email link and the page it was on. Sent in small batches.
 *   live       every 30 seconds while the tab is visible, "still here", for the count of people
 *              on the site right now. Stops when hidden, and after 30 minutes with no input.
 *
 * Each carries `sid`: a random 128-bit number made in this tab (crypto.getRandomValues), kept in
 * sessionStorage, so it lives exactly as long as the tab and is never shared with another tab,
 * another visit or another site. Paddock uses it only to count live visitors and not to count
 * one person's page twice, in a short-lived cache (Redis) that forgets it after 30 minutes; it
 * is never written to Paddock's database (Firestore) or its logs.
 *
 * WHAT IS NEVER COLLECTED: no cookies, no localStorage, no fingerprinting (nothing is read to
 * tell one browser from another; the device bucket is the same for every phone of a size),
 * no location from the browser (Paddock counts the city its load balancer reports for a
 * request, from the request's own headers), and nothing anyone types: no names, phone
 * numbers, emails, order references or search text, in any event. The `term` campaign tag is
 * never read, because a search term can be personal. An event name or property not on the
 * list is dropped here before sending, and Paddock drops it again on arrival.
 *
 * SESSIONS. "First of session" and the campaign tags live in sessionStorage too, so a session
 * is a browsing tab. That is why none of this needs a consent banner: nothing identifies a
 * person, and a leak of the resulting counts would reveal nothing about anyone.
 *
 * COST. Nothing runs during the page's first paint: the script is deferred, sets up its
 * listeners and then waits for the page to load and go idle. No animation frames, ever; the
 * heartbeat is a plain timer. Every request is text/plain JSON with credentials omitted, so
 * none of them costs a CORS preflight.
 *
 * HOW PAGES SPEAK TO IT:
 *   window.gridTrack(name, props)   from any script, any time. gridx-api.js queues calls made
 *                                   before this file arrives, with their page and time, and this
 *                                   drains that queue.
 *   data-event="name" data-event-<prop>="value"   on anything clicked.
 *   data-view-event="name"          on an element, sent once when the page loads (store_view).
 *   data-manual-id="id"             on a manual's download link (manual_download).
 *   gridx:disclose { id }           from disclose.js, when a FAQ opens (faq_open).
 *   tel:, mailto:, wa.me and api.whatsapp.com links are recognised on their own (contact_tap,
 *   with data-topic from the link or around it), so the footer on every page is covered.
 */
(() => {
  'use strict';

  const api = window.gridxApi;
  if (!api || typeof api.beacon !== 'function') return;

  const ROUTE = '/api/public/website/';
  const params = new URLSearchParams(window.location.search);

  // ---------------------------------------------------------------- storage (this tab only)
  let session = null;
  try {
    session = window.sessionStorage;
  } catch (_) {
    session = null; // blocked: every count still goes, nothing is remembered between pages
  }
  const read = (key) => {
    try { return session ? session.getItem(key) : null; } catch (_) { return null; }
  };
  const write = (key, value) => {
    try { if (session) session.setItem(key, value); } catch (_) { /* full or blocked */ }
  };

  // ---------------------------------------------------------------- the tab's id
  const SID_KEY = 'gridx.sid';
  const SID_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

  /** 128 random bits, base64url: 22 characters. */
  function freshSid() {
    const c = window.crypto;
    if (!c || typeof c.getRandomValues !== 'function' || typeof window.btoa !== 'function') return null;
    const bytes = c.getRandomValues(new Uint8Array(16));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return window.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  let sid = read(SID_KEY);
  if (!sid || !SID_SHAPE.test(sid)) {
    sid = freshSid();
    if (sid) write(SID_KEY, sid);
  }

  // ---------------------------------------------------------------- first of the session
  const SEEN_KEY = 'gridx.seen';
  function firstOfSession() {
    if (!session) return false; // counting the view but not the visitor beats inventing one
    if (read(SEEN_KEY)) return false;
    write(SEEN_KEY, '1');
    return true;
  }

  // ---------------------------------------------------------------- campaign tags
  // Paddock's own cleaning (sanitizeUtmValue), so what is kept is what it would keep.
  const UTM_KEY = 'gridx.utm';
  const UTM_FIELDS = ['source', 'medium', 'campaign', 'content']; // never term
  function utmValue(raw) {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase().replace(/[\s.]+/g, '_').slice(0, 60);
    return /^[a-z0-9][a-z0-9_+-]{0,59}$/.test(v) ? v : null;
  }
  function utmFrom(get) {
    const out = {};
    for (const field of UTM_FIELDS) {
      const v = utmValue(get(field));
      if (v) out[field] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  // The tags the session landed with: kept from the first page that carried any, for the rest
  // of the tab's life, so a visit that arrives from a campaign and then wanders is still that
  // campaign's.
  let utm = null;
  try {
    const kept = JSON.parse(read(UTM_KEY) || 'null');
    if (kept && typeof kept === 'object') utm = utmFrom((field) => kept[field]);
  } catch (_) {
    utm = null;
  }
  if (!utm) {
    utm = utmFrom((field) => params.get(`utm_${field}`));
    if (utm) write(UTM_KEY, JSON.stringify(utm));
  }

  // ---------------------------------------------------------------- scheduling
  const prerendering = () => Boolean(document.prerendering);
  const whenIdle = (fn, timeout) => (typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback(() => fn(), { timeout })
    : window.setTimeout(fn, 500));

  /** Once the page is really being looked at: not prerendered, not in a background tab. */
  function whenSeen(fn) {
    if (prerendering()) {
      document.addEventListener('prerenderingchange', () => whenSeen(fn), { once: true });
      return;
    }
    if (document.visibilityState !== 'hidden') {
      fn();
      return;
    }
    document.addEventListener('visibilitychange', function once() {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', once);
      fn();
    });
  }

  // ---------------------------------------------------------------- the pageview
  /** The referring site as an origin only: never its path or query, which can say too much. */
  function referrer() {
    const raw = document.referrer;
    if (!raw) return '';
    try {
      const u = new URL(raw);
      return /^https?:$/.test(u.protocol) ? `${u.origin}/` : `${u.protocol}//${u.host}`;
    } catch (_) {
      return '';
    }
  }

  const matches = (query) => {
    try { return window.matchMedia(query).matches; } catch (_) { return false; }
  };

  /** Coarse on purpose: the same answer for every phone of a size. */
  function device() {
    const vw = Math.round(window.innerWidth || 0);
    const vh = Math.round(window.innerHeight || 0);
    const touch = matches('(pointer: coarse)') && !matches('(hover: hover)');
    const kind = !touch ? 'desktop' : (Math.min(vw, vh) < 600 ? 'mobile' : 'tablet');
    return { class: kind, vw, vh, dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100 };
  }

  let viewed = false;
  function sendPageview() {
    if (viewed) return;
    viewed = true;
    const body = {
      path: window.location.pathname,
      referrer: referrer(),
      firstOfSession: firstOfSession(),
    };
    if (sid) body.sid = sid;
    if (utm) body.utm = utm;
    body.device = device(); // read once, here, while the page is idle
    const lang = typeof navigator.language === 'string' ? navigator.language.slice(0, 35) : '';
    if (lang) body.lang = lang;
    api.beacon(`${ROUTE}pageview`, body);
    startHeartbeat();
  }

  // ---------------------------------------------------------------- the allowlist
  // Paddock's eventCatalog.js, name for name and property for property. Each property's
  // function returns the cleaned value, or null to drop that property.
  const SKUS = ['gen2', 'chg6a', 'chg10a', 'adapter', 'dock'];
  const ROLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const oneOf = (...values) => (v) => (typeof v === 'string' && values.includes(v) ? v : null);
  const slugOf = (re) => (v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    return re.test(s) ? s.replace(/\s+/g, '-') : null;
  };
  // "chg6a+adapter" in any order becomes "adapter+chg6a", as Paddock folds it.
  const sku = (v) => {
    if (v === 'none') return v;
    if (typeof v !== 'string' || v.length > 60) return null;
    const parts = [...new Set(v.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean))];
    return parts.length && parts.length <= 5 && parts.every((p) => SKUS.includes(p)) ? parts.sort().join('+') : null;
  };
  const role = (v) => (typeof v === 'string' && v.length >= 3 && v.length <= 48 && ROLE.test(v) ? v : null);
  const roleOrOpen = (v) => (v === 'open' ? v : role(v));
  // A page, as a path ("/support"): Paddock folds it into its page key.
  const page = (v) => (typeof v === 'string' && /^\/[a-z0-9_/-]{0,60}$/.test(v) ? v : null);
  const dealerId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(v) ? v : null);

  const ALLOW = {
    // Store
    store_view: {},
    order_sheet_open: { sku },
    order_submit: { sku, intent: oneOf('reserve', 'full'), delivery: oneOf('dealership', 'ship') },
    payment_open: {},
    payment_success: {},
    payment_dismissed: {},
    payment_failed: {},
    configurator_step: { step: slugOf(/^[a-z0-9_-]{1,24}$/) },
    // Careers
    careers_view: {},
    role_view: { slug: role },
    apply_open: { slug: roleOrOpen },
    apply_submit: { slug: roleOrOpen },
    apply_success: {},
    // Support
    contact_tap: { channel: oneOf('call', 'whatsapp', 'email'), page, topic: slugOf(/^[a-z0-9 _-]{1,30}$/) },
    faq_open: { id: slugOf(/^[a-z0-9-]{1,48}$/) },
    manual_download: { id: slugOf(/^[a-z0-9-]{1,48}$/) },
    support_form_open: {},
    support_form_submit: {},
    track_lookup: { result: oneOf('found', 'not_found', 'error') },
    // Dealers
    dealer_search: { kind: oneOf('city', 'pincode', 'near_me', 'text') },
    dealer_action: { action: oneOf('call', 'whatsapp', 'directions', 'share'), dealerId },
  };

  /** The event as it may be sent, or null when its name is not on the list. */
  function clean(name, props) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(ALLOW, name)) return null;
    const spec = ALLOW[name];
    const given = props && typeof props === 'object' ? props : {};
    const out = {};
    for (const key of Object.keys(spec)) {
      if (!Object.prototype.hasOwnProperty.call(given, key)) continue;
      const v = spec[key](given[key]);
      if (v !== null) out[key] = v;
    }
    return out;
  }

  // ---------------------------------------------------------------- once per session
  // Funnel steps count sessions that reached them, so each is sent at most once per tab for
  // the same name and properties: reopening the order sheet for the same SKU is not a new
  // step. Kept in sessionStorage, or for the page alone when storage is blocked.
  const ONCE = new Set(['store_view', 'order_sheet_open', 'payment_open', 'careers_view', 'apply_open', 'support_form_open']);
  const ONCE_KEY = 'gridx.once';
  let onceSeen = null;
  function seenBefore(name, props) {
    if (!onceSeen) {
      try {
        const list = JSON.parse(read(ONCE_KEY) || '[]');
        onceSeen = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
      } catch (_) {
        onceSeen = new Set();
      }
    }
    const key = `${name}|${Object.keys(props).sort().map((k) => `${k}=${props[k]}`).join('&')}`;
    if (onceSeen.has(key)) return true;
    onceSeen.add(key);
    write(ONCE_KEY, JSON.stringify([...onceSeen].slice(-100)));
    return false;
  }

  // ---------------------------------------------------------------- batching
  const SEND_AT = 10; // a full batch goes at once
  const PER_BEACON = 20; // Paddock reads at most this many from one request
  const queue = [];
  let idleFlush = false;

  function flush() {
    idleFlush = false;
    if (!queue.length || prerendering()) return;
    while (queue.length) api.beacon(`${ROUTE}event`, { sid: sid || undefined, events: queue.splice(0, PER_BEACON) });
  }

  function flushSoon() {
    if (idleFlush) return;
    idleFlush = true;
    whenIdle(flush, 4000);
  }

  function track(name, props, path, t) {
    const cleaned = clean(name, props);
    if (!cleaned) return;
    if (ONCE.has(name) && seenBefore(name, cleaned)) return;
    queue.push({
      name,
      props: cleaned,
      path: typeof path === 'string' && path.charAt(0) === '/' ? path.slice(0, 200) : window.location.pathname,
      t: Number.isFinite(t) ? t : Date.now(),
    });
    if (queue.length >= SEND_AT) flush();
    else flushSoon();
  }

  // ---------------------------------------------------------------- clicks
  /** "/support" for support.html, "/" for the home page: the page, as a path. */
  function pagePath() {
    const p = window.location.pathname.toLowerCase()
      .replace(/\/index(\.html)?$/, '/')
      .replace(/\.html$/, '')
      .replace(/\/+$/, '');
    return p || '/';
  }

  /** data-event-sku="adapter" -> { sku: 'adapter' }; data-event-dealer-id -> dealerId. */
  function propsOf(el, prefix) {
    const out = {};
    for (const key of Object.keys(el.dataset)) {
      if (key.length <= prefix.length || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest[0] !== rest[0].toUpperCase()) continue; // data-eventful is not data-event-*
      out[rest[0].toLowerCase() + rest.slice(1)] = el.dataset[key];
    }
    return out;
  }

  function channelOf(link) {
    let url;
    try {
      url = new URL(link.getAttribute('href') || '', window.location.href);
    } catch (_) {
      return null;
    }
    if (url.protocol === 'tel:') return 'call';
    if (url.protocol === 'mailto:') return 'email';
    if (/^https?:$/.test(url.protocol) && (url.hostname === 'wa.me' || url.hostname === 'api.whatsapp.com')) return 'whatsapp';
    return null;
  }

  // Bubbling, so a script that takes over a link first (the contact form's openers are
  // WhatsApp links without JavaScript) has already said so with preventDefault.
  document.addEventListener('click', (event) => {
    const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (!target) return;

    const tagged = target.closest('[data-event]');
    if (tagged) window.gridTrack(tagged.dataset.event, propsOf(tagged, 'event'));

    const manual = target.closest('[data-manual-id]');
    if (manual) window.gridTrack('manual_download', { id: manual.dataset.manualId });

    if (event.defaultPrevented) return;
    const link = target.closest('a[href]');
    const channel = link ? channelOf(link) : null;
    if (!channel) return;
    const props = { channel, page: pagePath() };
    const topical = link.closest('[data-topic]');
    if (topical && topical.dataset.topic) props.topic = topical.dataset.topic;
    window.gridTrack('contact_tap', props);
  });

  // A FAQ opening (disclose.js).
  document.addEventListener('gridx:disclose', (event) => {
    const id = event.detail && event.detail.id;
    if (id) window.gridTrack('faq_open', { id });
  });

  // ---------------------------------------------------------------- the heartbeat
  const BEAT_MS = 30000;
  const IDLE_STOP_MS = 30 * 60000;
  const liveOn = !params.has('nosw');
  let beatTimer = 0;
  let beating = false; // started, and not stopped for want of input
  let lastBeat = 0;
  let lastInput = Date.now();

  function beat() {
    beatTimer = 0;
    if (!beating || document.visibilityState === 'hidden' || prerendering()) return;
    if (Date.now() - lastInput > IDLE_STOP_MS) {
      beating = false; // walked away: input brings it back
      return;
    }
    lastBeat = Date.now();
    api.beacon(`${ROUTE}live`, { sid, path: window.location.pathname });
    beatTimer = window.setTimeout(beat, BEAT_MS);
  }

  function beatIn(ms) {
    window.clearTimeout(beatTimer);
    beatTimer = window.setTimeout(beat, Math.max(0, ms));
  }

  function startHeartbeat() {
    if (!liveOn || !sid || beating) return;
    beating = true;
    lastBeat = Date.now(); // the pageview has just said "here"
    beatIn(BEAT_MS);
  }

  const noteInput = () => {
    lastInput = Date.now();
    if (viewed && liveOn && sid && !beating && document.visibilityState !== 'hidden') {
      beating = true;
      beatIn(0);
    }
  };
  for (const type of ['pointerdown', 'keydown', 'touchstart', 'scroll', 'wheel']) {
    window.addEventListener(type, noteInput, { passive: true, capture: true });
  }

  // ---------------------------------------------------------------- leaving and coming back
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush();
      window.clearTimeout(beatTimer); // paused, not stopped
      beatTimer = 0;
    } else if (beating) {
      beatIn(BEAT_MS - (Date.now() - lastBeat));
    }
  });
  window.addEventListener('pagehide', flush);
  // Anything said while the page was prerendered goes once someone is looking at it.
  document.addEventListener('prerenderingchange', flushSoon);

  // ---------------------------------------------------------------- taking over
  // The stub in gridx-api.js has been queueing [name, props, path, time]; each keeps the page
  // and the moment it happened, not the moment it is sent.
  const early = window.gridTrack && Array.isArray(window.gridTrack.q) ? window.gridTrack.q.slice() : [];
  window.gridTrack = function gridTrack(name, props) {
    track(name, props, window.location.pathname, Date.now());
  };
  for (const item of early) {
    if (Array.isArray(item)) track(item[0], item[1], item[2], item[3]);
  }

  // Views a page declares in its markup (store.html: store_view).
  for (const el of document.querySelectorAll('[data-view-event]')) {
    window.gridTrack(el.dataset.viewEvent, propsOf(el, 'viewEvent'));
  }

  // The pageview: once the page has loaded and gone quiet, so a report nobody is waiting on
  // never shares the network or the main thread with the page's own first seconds. A reader
  // who leaves before then is still counted on the way out (keepalive).
  whenSeen(() => {
    const idle = () => whenIdle(sendPageview, 3000);
    if (document.readyState === 'complete') idle();
    else window.addEventListener('load', idle, { once: true });
    window.addEventListener('pagehide', sendPageview, { once: true });
  });
})();
