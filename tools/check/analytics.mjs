#!/usr/bin/env node
/*
 * assets/analytics.js, checked outside the browser.
 *
 *   node tools/check/analytics.mjs
 *
 * The real gridx-api.js and analytics.js run in a vm context dressed as a page: a small fake
 * DOM (just what the two scripts touch), sessionStorage, a clock this file moves by hand,
 * requestIdleCallback that runs when told to, and fetch caught on its way out, so every beacon
 * is read exactly as Paddock would receive it. Nothing reaches the network.
 *
 * What it holds the script to:
 *   - the allowlist is Paddock's catalog (as tools/check/paddock-mock.mjs carries it), name for
 *     name and property for property, and anything else is dropped before it is sent
 *   - funnel steps go once per session (ONCE), and only those
 *   - batches go at ten events, on idle, and on the way out (hidden, pagehide), at most 20 a
 *     beacon
 *   - calls queued before it arrived keep their page and their time
 *   - the tab id is 22 base64url characters, kept for the tab and never anywhere else
 *   - campaign tags are kept for the session, lower cased, and `term` never leaves the page
 *   - the pageview waits for a real view (not hidden, not prerendering) and the page going idle
 *   - the heartbeat pauses while hidden, stops after 30 minutes without input, and is off
 *     under ?nosw
 *   - every beacon is text/plain with credentials omitted (no preflight, no cookies)
 *   - not one requestAnimationFrame, anywhere
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const API_SRC = fs.readFileSync(path.join(REPO, 'assets/gridx-api.js'), 'utf8');
const ANALYTICS_SRC = fs.readFileSync(path.join(REPO, 'assets/analytics.js'), 'utf8');

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The catalog, as the mock carries it (Part 0 of the plan; Paddock's eventCatalog.js).
const mockSrc = fs.readFileSync(path.join(HERE, 'paddock-mock.mjs'), 'utf8');
const CATALOG = new Function(`return ${mockSrc.match(/const EVENTS = (\{[\s\S]*?\n\});/)[1]}`)();

// ---------------------------------------------------------------- the fake page
let rafCalls = 0;

function toCamel(attr) {
  return attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class FakeElement {
  constructor(tag, attrs = {}, parent = null) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.parentElement = parent;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  get dataset() {
    const out = {};
    for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith('data-')) out[toCamel(k)] = v;
    return out;
  }

  // Enough of a selector engine for what analytics.js asks: "[attr]" and "tag[attr]".
  matches(selector) {
    const m = /^([a-z]*)\[([a-z-]+)\]$/.exec(selector);
    if (!m) throw new Error(`fake DOM cannot match ${selector}`);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    return Object.prototype.hasOwnProperty.call(this.attrs, m[2]);
  }

  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el;
    return null;
  }
}

/**
 * One page load. `shared` carries what outlives a page in the same tab: sessionStorage, the
 * clock and every request sent so far.
 */
function page(shared, {
  url = 'https://gridxenergy.in/support.html',
  visibility = 'visible',
  prerendering = false,
  readyState = 'complete',
  touch = true,
  width = 390,
  height = 844,
  dpr = 3,
  lang = 'en-IN',
  referrer = '',
  marked = [], // elements in the page, for querySelectorAll
  before, // (win) => {}, after gridx-api.js and before analytics.js
} = {}) {
  const clock = shared.clock;
  const timers = new Map();
  const idles = [];
  let nextTimer = 1;

  const winEvents = new EventTarget();
  const docEvents = new EventTarget();
  const loc = new URL(url);

  const document = {
    visibilityState: visibility,
    get hidden() { return this.visibilityState === 'hidden'; },
    prerendering,
    readyState,
    referrer,
    addEventListener: docEvents.addEventListener.bind(docEvents),
    removeEventListener: docEvents.removeEventListener.bind(docEvents),
    dispatchEvent: docEvents.dispatchEvent.bind(docEvents),
    querySelectorAll: (selector) => marked.filter((el) => el.matches(selector)),
  };

  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }

  const win = {
    location: {
      href: loc.href, pathname: loc.pathname, search: loc.search, hostname: loc.hostname,
      protocol: loc.protocol, origin: loc.origin, hash: loc.hash,
    },
    document,
    navigator: { language: lang },
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: dpr,
    sessionStorage: shared.storage,
    crypto: { getRandomValues: (a) => webcrypto.getRandomValues(a) },
    btoa: (s) => globalThis.btoa(s),
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? touch : q === '(hover: hover)' ? !touch : false }),
    setTimeout: (fn, ms = 0) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: clock.now + Math.max(0, ms) });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    requestIdleCallback: (fn) => { idles.push(fn); return idles.length; },
    requestAnimationFrame: () => { rafCalls++; return 1; },
    cancelAnimationFrame: () => {},
    performance: { now: () => clock.now - clock.start },
    fetch: (url2, init) => {
      shared.sent.push({ url: String(url2), init, body: JSON.parse(init.body), at: clock.now });
      return Promise.resolve({ status: 204, ok: true, json: async () => ({}), headers: { get: () => null } });
    },
    addEventListener: winEvents.addEventListener.bind(winEvents),
    removeEventListener: winEvents.removeEventListener.bind(winEvents),
    dispatchEvent: winEvents.dispatchEvent.bind(winEvents),
    URL,
    URLSearchParams,
    AbortController,
    Event,
    CustomEvent,
    Element: FakeElement,
    Date: ClockDate,
    console,
  };
  win.window = win;
  win.self = win;
  vm.createContext(win);
  vm.runInContext(API_SRC, win, { filename: 'gridx-api.js' });
  if (before) before(win);
  vm.runInContext(ANALYTICS_SRC, win, { filename: 'analytics.js' });

  const api = {
    win,
    document,
    /** Move the clock, running every timer that falls due on the way, in order. */
    advance(ms) {
      const until = clock.now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        clock.now = Math.max(clock.now, next[1].at);
        next[1].fn();
      }
      clock.now = until;
    },
    idle() {
      while (idles.length) idles.shift()({ didTimeout: false, timeRemaining: () => 10 });
    },
    load() {
      document.readyState = 'complete';
      win.dispatchEvent(new Event('load'));
    },
    show(visible) {
      document.visibilityState = visible ? 'visible' : 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    activate() {
      document.prerendering = false;
      document.dispatchEvent(new Event('prerenderingchange'));
    },
    click(el, { prevented = false } = {}) {
      const event = new Event('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: el });
      if (prevented) Object.defineProperty(event, 'defaultPrevented', { value: true });
      document.dispatchEvent(event);
    },
    input(type = 'pointerdown') {
      win.dispatchEvent(new Event(type));
    },
    track: (name, props) => win.gridTrack(name, props),
  };
  return api;
}

function freshTab() {
  const map = new Map();
  return {
    clock: { now: 1760000000000, start: 1760000000000 },
    sent: [],
    storage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
      map,
    },
  };
}

const beacons = (tab, kind) => tab.sent.filter((s) => s.url.endsWith(`/api/public/website/${kind}`));
const events = (tab) => beacons(tab, 'event').flatMap((b) => b.body.events);

// ---------------------------------------------------------------- 1. the tab id
{
  const tab = freshTab();
  const p1 = page(tab);
  p1.idle();
  const view1 = beacons(tab, 'pageview')[0];
  const sid = view1 && view1.body.sid;
  report('sid is 22 base64url characters (128 random bits)', typeof sid === 'string' && /^[A-Za-z0-9_-]{22}$/.test(sid), String(sid));
  report('sid matches what Paddock accepts', /^[A-Za-z0-9_-]{16,64}$/.test(sid || ''));
  report('sid kept in sessionStorage only', tab.storage.map.get('gridx.sid') === sid
    && !('cookie' in p1.document) && !('localStorage' in p1.win));

  const p2 = page(tab, { url: 'https://gridxenergy.in/store.html' });
  p2.idle();
  const view2 = beacons(tab, 'pageview')[1];
  report('sid persists across pages in the tab', view2 && view2.body.sid === sid);
  report('firstOfSession only on the tab\'s first page', view1.body.firstOfSession === true && view2.body.firstOfSession === false);

  const other = freshTab();
  page(other).idle();
  const sid2 = beacons(other, 'pageview')[0].body.sid;
  report('a new tab gets a new sid', sid2 && sid2 !== sid);
}

// ---------------------------------------------------------------- 2. campaign tags
{
  const tab = freshTab();
  page(tab, {
    url: 'https://gridxenergy.in/store.html?utm_source=LinkedIn%20Ads&utm_medium=CPC&utm_campaign=Gen2.Launch&utm_content=Hero&utm_term=asha%40example.com',
  }).idle();
  const first = beacons(tab, 'pageview')[0].body;
  report('UTM captured and lower cased', eq(first.utm, { source: 'linkedin_ads', medium: 'cpc', campaign: 'gen2_launch', content: 'hero' }), JSON.stringify(first.utm));
  const p2 = page(tab, { url: 'https://gridxenergy.in/support.html' });
  p2.idle();
  p2.track('faq_open', { id: 'how-long-does-a-charge-take' });
  p2.idle();
  const second = beacons(tab, 'pageview')[1].body;
  report('UTM kept for the session', eq(second.utm, first.utm));
  const wire = JSON.stringify(tab.sent.map((s) => s.body)) + JSON.stringify([...tab.storage.map.values()]);
  report('utm_term never stored or sent', !/term|asha|example\.com/i.test(wire));
}

// ---------------------------------------------------------------- 3. the pageview
{
  const tab = freshTab();
  const p = page(tab, { referrer: 'https://www.google.com/search?q=gridx+battery+price', touch: true, width: 390, height: 844, dpr: 3 });
  report('no pageview before the page is idle', beacons(tab, 'pageview').length === 0);
  p.idle();
  const body = beacons(tab, 'pageview')[0].body;
  report('pageview shape', body.path === '/support.html' && body.lang === 'en-IN' && typeof body.firstOfSession === 'boolean', JSON.stringify(body));
  report('referrer reduced to its origin', body.referrer === 'https://www.google.com/', body.referrer);
  report('device: a touch phone is mobile', eq(body.device, { class: 'mobile', vw: 390, vh: 844, dpr: 3 }), JSON.stringify(body.device));

  const t2 = freshTab();
  page(t2, { touch: true, width: 820, height: 1180, dpr: 2 }).idle();
  const t3 = freshTab();
  page(t3, { touch: false, width: 1440, height: 900, dpr: 2 }).idle();
  report('device: touch tablet and desktop', beacons(t2, 'pageview')[0].body.device.class === 'tablet'
    && beacons(t3, 'pageview')[0].body.device.class === 'desktop');

  const hidden = freshTab();
  const ph = page(hidden, { visibility: 'hidden' });
  ph.idle();
  const before = beacons(hidden, 'pageview').length;
  ph.show(true);
  ph.idle();
  report('a background tab waits until it is seen', before === 0 && beacons(hidden, 'pageview').length === 1);

  const pre = freshTab();
  const pp = page(pre, { prerendering: true });
  pp.idle();
  pp.advance(60000);
  const during = pre.sent.length;
  pp.activate();
  pp.idle();
  report('a prerendered page waits for prerenderingchange', during === 0 && beacons(pre, 'pageview').length === 1, `sent while prerendering: ${during}`);

  const loading = freshTab();
  const pl = page(loading, { readyState: 'interactive' });
  pl.idle();
  const early = beacons(loading, 'pageview').length;
  pl.load();
  pl.idle();
  report('the pageview waits for load, then idle', early === 0 && beacons(loading, 'pageview').length === 1);

  const leaving = freshTab();
  const plv = page(leaving, { readyState: 'interactive' });
  plv.win.dispatchEvent(new Event('pagehide'));
  report('someone leaving before idle is still counted', beacons(leaving, 'pageview').length === 1);
}

// ---------------------------------------------------------------- 4. the allowlist
{
  const allowBlock = ANALYTICS_SRC.slice(ANALYTICS_SRC.indexOf('const ALLOW = {'), ANALYTICS_SRC.indexOf('\n  };', ANALYTICS_SRC.indexOf('const ALLOW = {')));
  const clientNames = [...allowBlock.matchAll(/^\s+([a-z_]+): \{/gm)].map((m) => m[1]).sort();
  report('ALLOW names are exactly the catalog', eq(clientNames, Object.keys(CATALOG).sort()), clientNames.join(','));

  const SAMPLE = {
    sku: 'adapter', intent: 'full', delivery: 'ship', step: 'charger', slug: 'battery-engineer',
    channel: 'call', page: '/support', topic: 'order', id: 'how-long-does-a-charge-take',
    result: 'found', kind: 'city', action: 'call', dealerId: 'dlr_0001',
  };
  const tab = freshTab();
  const p = page(tab);
  let propsOk = true;
  const bad = [];
  for (const [name, props] of Object.entries(CATALOG)) {
    const given = { email: 'asha@example.com', phone: '9876543210', name: 'Asha' };
    for (const prop of props) given[prop] = SAMPLE[prop];
    p.track(name, given);
  }
  p.track('page_scroll', { depth: '50' });
  p.track('Support_Form_Open');
  p.track('__proto__');
  p.track('constructor');
  p.idle();
  const got = events(tab);
  for (const [name, props] of Object.entries(CATALOG)) {
    const e = got.find((x) => x.name === name);
    if (!e || !eq(Object.keys(e.props).sort(), [...props].sort())) { propsOk = false; bad.push(name); }
  }
  report('every catalog event goes, with exactly its listed properties', propsOk, bad.join(','));
  report('unknown names are dropped', got.length === Object.keys(CATALOG).length && !got.some((e) => /page_scroll|Support_Form_Open|__proto__|constructor/.test(e.name)));
  report('unlisted properties (name, phone, email) never sent', !/asha|9876543210|example\.com/i.test(JSON.stringify(got)));

  const t2 = freshTab();
  const p2 = page(t2);
  p2.track('order_submit', { sku: 'chg6a+adapter', intent: 'full', delivery: 'ship' });
  p2.track('order_submit', { sku: 'gen2+toaster', intent: 'later', delivery: 'drone' });
  p2.track('contact_tap', { channel: 'whatsapp', page: '/support', topic: 'PowerPod specifications' });
  p2.track('contact_tap', { channel: 'fax', page: 'support', topic: 'a@b.c' });
  p2.track('track_lookup', { result: 'maybe' });
  p2.track('faq_open', { id: 'Not A Slug!' });
  p2.track('role_view', { slug: 'x' });
  p2.track('apply_open', { slug: 'open' });
  p2.idle();
  const g2 = events(t2);
  report('values cleaned as Paddock cleans them', eq(g2.map((e) => e.props), [
    { sku: 'adapter+chg6a', intent: 'full', delivery: 'ship' },
    {},
    { channel: 'whatsapp', page: '/support', topic: 'powerpod-specifications' },
    {},
    {},
    {},
    {},
    { slug: 'open' },
  ]), JSON.stringify(g2.map((e) => e.props)));
}

// ---------------------------------------------------------------- 5. once per session
{
  const tab = freshTab();
  const p = page(tab, { url: 'https://gridxenergy.in/store.html', marked: [new FakeElement('main', { 'data-view-event': 'store_view' })] });
  p.track('store_view');
  p.track('order_sheet_open', { sku: 'adapter' });
  p.track('order_sheet_open', { sku: 'dock' });
  p.track('order_sheet_open', { sku: 'adapter' });
  p.track('support_form_open');
  p.track('support_form_open');
  p.track('faq_open', { id: 'how-do-i-charge-my-powerpod' });
  p.track('faq_open', { id: 'how-do-i-charge-my-powerpod' });
  p.track('payment_success');
  p.track('payment_success');
  p.idle();
  const p2 = page(tab, { url: 'https://gridxenergy.in/store.html', marked: [new FakeElement('main', { 'data-view-event': 'store_view' })] });
  p2.track('order_sheet_open', { sku: 'adapter' });
  p2.track('support_form_open');
  p2.idle();
  const names = events(tab).map((e) => `${e.name}${e.props.sku ? `:${e.props.sku}` : ''}`);
  report('ONCE: a funnel step at most once per session per name and props', eq(names, [
    'store_view', 'order_sheet_open:adapter', 'order_sheet_open:dock', 'support_form_open',
    'faq_open', 'faq_open', 'payment_success', 'payment_success',
  ]), names.join(' '));
  report('ONCE remembered in sessionStorage', tab.storage.map.has('gridx.once'));
  report('data-view-event read on load', names[0] === 'store_view');
}

// ---------------------------------------------------------------- 6. batching
{
  const tab = freshTab();
  const p = page(tab);
  p.idle(); // the pageview
  for (let i = 0; i < 9; i++) p.track('faq_open', { id: `q-${i}` });
  const at9 = beacons(tab, 'event').length;
  p.track('faq_open', { id: 'q-9' });
  const at10 = beacons(tab, 'event');
  report('a batch goes at ten events, without waiting', at9 === 0 && at10.length === 1 && at10[0].body.events.length === 10);

  for (let i = 0; i < 3; i++) p.track('faq_open', { id: `r-${i}` });
  const before = beacons(tab, 'event').length;
  p.idle();
  const after = beacons(tab, 'event');
  report('a partial batch goes on idle', before === 1 && after.length === 2 && after[1].body.events.length === 3);

  for (let i = 0; i < 2; i++) p.track('faq_open', { id: `s-${i}` });
  p.show(false);
  const hid = beacons(tab, 'event');
  report('the rest goes when the tab is hidden', hid.length === 3 && hid[2].body.events.length === 2);
  p.show(true);

  p.track('faq_open', { id: 't-0' });
  p.win.dispatchEvent(new Event('pagehide'));
  report('and on pagehide', beacons(tab, 'event').length === 4);

  const every = beacons(tab, 'event').every((b) => b.body.sid === beacons(tab, 'pageview')[0].body.sid);
  report('every batch carries the sid', every);

  const pre = freshTab();
  const pp = page(pre, { prerendering: true });
  for (let i = 0; i < 25; i++) pp.track('faq_open', { id: `p-${i}` });
  pp.idle();
  const held = beacons(pre, 'event').length;
  pp.activate();
  pp.idle();
  const sizes = beacons(pre, 'event').map((b) => b.body.events.length);
  report('nothing sent while prerendering, then at most 20 a beacon', held === 0 && eq(sizes, [20, 5]), `held ${held}, sizes ${sizes}`);
}

// ---------------------------------------------------------------- 7. the early queue
{
  const tab = freshTab();
  const t0 = tab.clock.now;
  let stub = null;
  const p = page(tab, {
    url: 'https://gridxenergy.in/support.html',
    before(win) {
      stub = win.gridTrack;
      win.gridTrack('faq_open', { id: 'what-does-the-warranty-cover' });
      tab.clock.now += 4000;
      win.gridTrack('support_form_open');
      win.gridTrack('not_an_event', { x: '1' });
      tab.clock.now += 3000;
    },
  });
  p.idle();
  const got = events(tab);
  report('queued calls drained, with their original time and page',
    got.length === 2 && got[0].t === t0 && got[1].t === t0 + 4000 && got.every((e) => e.path === '/support.html'),
    JSON.stringify(got.map((e) => [e.name, e.t - t0, e.path])));
  report('gridTrack is the real function afterwards', p.win.gridTrack !== stub && !Array.isArray(p.win.gridTrack.q));
  p.track('faq_open', { id: 'live-one' });
  p.idle();
  const live = events(tab).find((e) => e.props.id === 'live-one');
  report('calls after takeover are stamped now', live && live.t === tab.clock.now);
}

// ---------------------------------------------------------------- 8. clicks, FAQs and manuals
{
  const tab = freshTab();
  const p = page(tab, { url: 'https://gridxenergy.in/support.html' });
  const footer = new FakeElement('footer', {});
  const tel = new FakeElement('a', { href: 'tel:+919220199098' }, footer);
  const wa = new FakeElement('a', { href: 'https://wa.me/919220199098?text=Hi' }, new FakeElement('li', { 'data-topic': 'Fitment' }));
  const waApi = new FakeElement('a', { href: 'https://api.whatsapp.com/send?phone=919220199098' });
  const mail = new FakeElement('a', { href: 'mailto:info@gridxenergy.in' });
  const opener = new FakeElement('a', { href: 'https://wa.me/919220199098', 'data-support-open': 'callback' });
  const plain = new FakeElement('a', { href: 'store.html' });
  const iconInTel = new FakeElement('span', {}, tel);
  const tagged = new FakeElement('button', { 'data-event': 'order_sheet_open', 'data-event-sku': 'chg6a' });
  const manual = new FakeElement('a', { href: 'assets/manuals/x.pdf', 'data-manual-id': 'powerpod-gen2-user-manual' });

  p.click(iconInTel);
  p.click(wa);
  p.click(waApi);
  p.click(mail);
  p.click(opener, { prevented: true });
  p.click(plain);
  p.click(tagged);
  p.click(manual);
  p.document.dispatchEvent(new CustomEvent('gridx:disclose', { detail: { id: 'how-long-does-a-charge-take' } }));
  p.idle();
  const got = events(tab).map((e) => [e.name, e.props]);
  report('tel, wa.me, api.whatsapp.com and mailto classified, with page and topic', eq(got.slice(0, 4), [
    ['contact_tap', { channel: 'call', page: '/support' }],
    ['contact_tap', { channel: 'whatsapp', page: '/support', topic: 'fitment' }],
    ['contact_tap', { channel: 'whatsapp', page: '/support' }],
    ['contact_tap', { channel: 'email', page: '/support' }],
  ]), JSON.stringify(got.slice(0, 4)));
  report('a link a script took over (preventDefault) is not a tap; plain links are not taps',
    got.filter((e) => e[0] === 'contact_tap').length === 4);
  report('data-event and data-event-* attributes', got.some((e) => e[0] === 'order_sheet_open' && e[1].sku === 'chg6a'));
  report('data-manual-id is a manual_download', got.some((e) => e[0] === 'manual_download' && e[1].id === 'powerpod-gen2-user-manual'));
  report('gridx:disclose is a faq_open', got.some((e) => e[0] === 'faq_open' && e[1].id === 'how-long-does-a-charge-take'));

  const home = freshTab();
  const ph = page(home, { url: 'https://gridxenergy.in/' });
  ph.click(new FakeElement('a', { href: 'tel:+919220199098' }));
  ph.idle();
  report('the home page is "/"', events(home)[0].props.page === '/');
}

// ---------------------------------------------------------------- 9. the heartbeat
{
  const tab = freshTab();
  const p = page(tab);
  p.idle(); // pageview
  p.advance(29000);
  const early = beacons(tab, 'live').length;
  p.advance(1000);
  const one = beacons(tab, 'live');
  report('a beat 30 s after the pageview', early === 0 && one.length === 1
    && one[0].body.path === '/support.html' && one[0].body.sid === beacons(tab, 'pageview')[0].body.sid);
  p.advance(30000);
  report('then every 30 s while visible', beacons(tab, 'live').length === 2);

  p.show(false);
  p.advance(5 * 60000);
  const whileHidden = beacons(tab, 'live').length;
  report('paused while hidden', whileHidden === 2);
  p.show(true);
  p.advance(0);
  report('back on showing (it has been over 30 s)', beacons(tab, 'live').length === 3);

  p.input('pointerdown');
  const quietFrom = tab.clock.now;
  p.advance(31 * 60000);
  const lastBeat = beacons(tab, 'live').at(-1).at;
  report('stops after 30 minutes without input', lastBeat - quietFrom <= 30 * 60000 && lastBeat - quietFrom >= 29 * 60000,
    `last beat ${Math.round((lastBeat - quietFrom) / 60000)} min after the last input`);
  const stoppedAt = beacons(tab, 'live').length;
  p.advance(10 * 60000);
  const stillStopped = beacons(tab, 'live').length === stoppedAt;
  p.input('keydown');
  p.advance(0);
  report('input brings it back', stillStopped && beacons(tab, 'live').length === stoppedAt + 1);

  const nosw = freshTab();
  const pn = page(nosw, { url: 'https://gridxenergy.in/support.html?nosw' });
  pn.idle();
  pn.advance(5 * 60000);
  report('off under ?nosw (the pageview still goes)', beacons(nosw, 'live').length === 0 && beacons(nosw, 'pageview').length === 1);

  const pre = freshTab();
  const pp = page(pre, { prerendering: true });
  pp.idle();
  pp.advance(5 * 60000);
  report('off while prerendering', beacons(pre, 'live').length === 0);
}

// ---------------------------------------------------------------- 10. the wire
{
  const tab = freshTab();
  const p = page(tab);
  p.idle();
  p.track('faq_open', { id: 'how-do-i-charge-my-powerpod' });
  p.idle();
  p.advance(30000);
  const all = tab.sent;
  const simple = all.every((s) => /^text\/plain/.test(s.init.headers['Content-Type'])
    && s.init.credentials === 'omit' && s.init.keepalive === true && s.init.method === 'POST');
  report('every beacon text/plain, keepalive, credentials omitted', all.length === 3 && simple, `${all.length} beacons`);
  report('to Paddock only', all.every((s) => s.url.startsWith('https://paddockgridx.app/api/public/website/')));
  // Each body's own fields, and each event's properties: nothing else is said.
  const keys = new Set();
  for (const s of all) {
    for (const k of Object.keys(s.body)) keys.add(k);
    for (const e of s.body.events || []) for (const k of Object.keys(e.props)) keys.add(k);
  }
  const SAID = ['path', 'referrer', 'firstOfSession', 'sid', 'utm', 'device', 'lang', 'events', 'id'];
  report('nothing on the wire beyond the documented fields', [...keys].every((k) => SAID.includes(k)), [...keys].join(','));
}

report('zero requestAnimationFrame calls, in every scenario above', rafCalls === 0, `${rafCalls} calls`);

console.log(failed ? `\n${failed} check(s) failed` : '\nanalytics: all checks passed');
process.exitCode = failed ? 1 : 0;
