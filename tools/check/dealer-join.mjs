#!/usr/bin/env node
/*
 * The dealers page's join sheet (assets/dealer-join.js): "Join the GridX Dealership Network",
 * end to end and at every screen size, in headless Chrome against the Paddock mock.
 *
 *   node tools/check/dealer-join.mjs [--root dir] [--only flow|fit] [--sizes 390x844,1025x768]
 *
 * The flow, at 390x844 and 1440x900:
 *   - the link sits right under the lede, and is a WhatsApp link with the short message
 *   - opening it counts dealer_join_open (once); location allowed at Indore says "Near Indore,
 *     Madhya Pradesh" and walks on to the name by itself
 *   - the name and the shop are demanded, and Yes walks on to the shop; the message and the
 *     link are exactly gridDealers.joinMessage's
 *   - Open WhatsApp opens wa.me with that text in a new tab, counts contact_tap with the topic
 *     "dealer join", and the sheet closes; the position is in no request, address or event
 *   - location refused: the connection's state from Paddock ("in Madhya Pradesh"); location
 *     skipped with Paddock down: no place at all
 *   - Not yet skips the shop, back walks back, Esc and the browser's back button close it,
 *     and opening it again picks up where it was left
 *   - without JavaScript the link still goes to WhatsApp
 * The fit, at every size tools/check/gen2-fit.mjs walks and at 125% and 150% text: each step
 * (opened with ?check&join=<step>), the location found, a name refused, and the keyboard
 * stood in for at touch sizes, measured for clipping, overlap, sideways scroll and the sheet
 * and its button being on screen. Screenshots and contact sheets land in
 * tools/check/out/dealer-join/. Any problem prints FAIL and the run exits 1.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { startMock } from './paddock-mock.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const root = path.resolve(arg('--root') || '.');
const only = arg('--only');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out', 'dealer-join');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const PORT = await freePort();
const MOCK_PORT = await freePort();
const SITE = `http://localhost:${PORT}`;
const PADDOCK = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The message, as the page writes it: dealers-core.js run here the way the build runs it.
const core = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(REPO, 'assets/hours.js'), 'utf8'), core);
vm.runInContext(fs.readFileSync(path.join(REPO, 'assets/dealers-core.js'), 'utf8'), core);
const joinMessage = (a) => core.gridDealers.joinMessage(a);
const waUrl = (text) => `https://wa.me/919220199098?text=${encodeURIComponent(text)}`;

const server = await serve({ root, port: PORT, quiet: true });
const mock = await startMock({ port: MOCK_PORT, quiet: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [...CHROME_ARGS, '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  protocolTimeout: 300000,
});
const setModes = (modes) => fetch(`${mock.url}/__mock/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modes }),
});

let failed = 0;
const report = (label, ok, detail = '', errors = []) => {
  const pass = ok && !errors.length;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}${errors.length ? `\n      errors: ${errors.join(' | ')}` : ''}`);
};

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { width: 1440, height: 900, deviceScaleFactor: 1 };
const INDORE = { latitude: 22.7186, longitude: 75.8553 };
const MARKS = ['22.718', '75.855', '22.72', '75.86'];

const outbound = [];
/** The dealers page, its Paddock calls answered by the mock, its events recorded. */
async function open(url, { viewport = PHONE, js = true, text = 100, before, fix } = {}) {
  // A window of its own, not a tab: a tab behind another is not drawn, so its sheet would
  // wait at the bottom of its slide for frames that never come.
  const page = await browser.newPage({ type: 'window' });
  await page.setViewport(viewport);
  if (!js) await page.setJavaScriptEnabled(false);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    outbound.push(`${u} ${r.postData() || ''}`);
    if (/^https:\/\/(www\.)?(facebook\.com|connect\.facebook\.net)\//.test(u)) { r.abort(); return; }
    if (u.startsWith(`${PADDOCK}/`)) r.continue({ url: u.replace(PADDOCK, mock.url) });
    else r.continue();
  });
  if (js) {
    await page.evaluateOnNewDocument((size) => {
      const calls = [];
      const record = function (name, props) { calls.push([name, props]); };
      Object.defineProperty(window, 'gridTrack', { configurable: true, get: () => record, set: () => {} });
      window.__track = calls;
      if (size !== 100) document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${size}%`; });
    }, text);
  }
  if (fix) {
    // A fix stood in for inside the page, for the layout sweep: no permission to grant, so
    // pages running side by side cannot take one another's away.
    await page.evaluateOnNewDocument((at) => {
      const geo = navigator.geolocation;
      geo.getCurrentPosition = (ok) => setTimeout(() => ok({ coords: { latitude: at.latitude, longitude: at.longitude, accuracy: 30 } }), 250);
    }, fix);
  }
  if (before) await before(page);
  await page.goto(url, { waitUntil: 'load' });
  return { page, errors };
}

const state = (page) => page.evaluate(() => {
  const sheet = document.getElementById('join-sheet');
  const step = [...sheet.querySelectorAll('.join__step')].find((s) => !s.hidden);
  const shown = (id) => { const el = document.getElementById(id); return Boolean(el) && !el.hidden; };
  return {
    open: sheet.open,
    revealed: sheet.classList.contains('is-revealed'),
    step: step ? step.dataset.step : null,
    primary: document.getElementById('join-primary').hidden ? null : document.getElementById('join-primary').textContent.trim(),
    skip: shown('join-skip'),
    back: !sheet.querySelector('.join__back').hidden,
    found: shown('join-found') ? document.getElementById('join-found-text').textContent : null,
    note: document.getElementById('join-note').textContent,
    nameErr: document.getElementById('join-name-err').textContent,
    shopErr: document.getElementById('join-shop-err').textContent,
    choiceErr: document.getElementById('join-choice-err').textContent,
    message: document.getElementById('join-message').textContent,
    href: document.getElementById('join-whatsapp').getAttribute('href'),
    whatsapp: shown('join-whatsapp'),
    progress: [...sheet.querySelectorAll('.join__progress li')].map((li) => li.dataset.state).join(','),
    track: (window.__track || []).map(([n, p]) => `${n}${p && p.topic ? `:${p.topic}` : ''}`),
    url: location.href,
  };
});
const until = (page, fn, timeout = 6000) => page.waitForFunction(fn, { timeout, polling: 50 }).then(() => true).catch(() => false);
const stepIs = (page, s) => until(page, (want) => {
  const step = [...document.querySelectorAll('#join-sheet .join__step')].find((el) => !el.hidden);
  return step && step.dataset.step === want;
}, 6000).then(() => true);
const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
// Open, and still: the slide up and the step's rise both finished (the spring's tail runs
// longer at large text and under load). A tap or a measure mid-slide lands where the sheet
// no longer is. The location ping loops for ever and is not waited for.
const still = (page, timeout = 6000) => until(page, () => {
  const sheet = document.getElementById('join-sheet');
  return sheet.classList.contains('is-revealed')
    && sheet.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getTiming().iterations === Infinity);
}, timeout);
const revealed = async (page) => {
  await still(page);
  await sleep(120);
};
const press = async (page, sel) => {
  // A real tap where a person would make one: the choice cards walk on only after a pointer.
  const el = await page.$(sel);
  await el.click();
};
const fill = async (page, sel, value) => {
  await page.$eval(sel, (el) => { el.value = ''; });
  await page.type(sel, value, { delay: 8 });
};

// ---------------------------------------------------------------- the flow
async function flow(label, viewport) {
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(SITE, ['geolocation']);
  const sentBefore = outbound.length;
  const { page, errors } = await open(`${SITE}/dealers.html`, { viewport, before: (p) => p.setGeolocation(INDORE) });
  await sleep(600);

  const link = await page.evaluate(() => {
    const a = document.getElementById('join-open');
    const lede = document.querySelector('.dealers-lede');
    return {
      text: a.textContent.trim(),
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      underlined: getComputedStyle(a).textDecorationLine.includes('underline'),
      underLede: lede.nextElementSibling === a.closest('.dealers-join'),
    };
  });
  report(`${label}: the link is under the lede, underlined, and a WhatsApp link without a script`,
    link.text === 'Join the GridX Dealership Network' && link.underLede && link.underlined && link.target === '_blank'
    && link.href === waUrl(joinMessage({})), JSON.stringify(link));

  await press(page, '#join-open');
  await revealed(page);
  let s = await state(page);
  report(`${label}: it opens on where they are, with Share my location and Not now`,
    s.open && s.step === 'location' && s.primary === 'Share my location' && s.skip && !s.back
    && s.progress === 'current,todo,todo,todo' && s.track.filter((t) => t === 'dealer_join_open').length === 1, JSON.stringify(s).slice(0, 300));
  await page.screenshot({ path: path.join(OUT, `flow-${label}-1-location.png`) });

  await press(page, '#join-primary');
  const named = await until(page, () => !document.getElementById('join-found').hidden, 8000);
  s = await state(page);
  report(`${label}: allowed at Indore, it says where, on this phone`, named && s.found === 'Near Indore, Madhya Pradesh' && !s.skip, `${s.found} / ${s.note}`);
  await page.screenshot({ path: path.join(OUT, `flow-${label}-2-found.png`) });
  report(`${label}: and walks on to the name by itself`, await stepIs(page, 'name'), '');

  await press(page, '#join-primary');
  s = await state(page);
  report(`${label}: a name is asked for before going on`, s.step === 'name' && s.nameErr === 'Please enter your name.', s.nameErr);
  await page.screenshot({ path: path.join(OUT, `flow-${label}-3-name-error.png`) });
  await fill(page, '#join-name', 'Ramesh Kumar');
  s = await state(page);
  report(`${label}: and the error goes as it is put right`, s.nameErr === '', s.nameErr);
  await page.keyboard.press('Enter');
  report(`${label}: Enter in the name goes on to the dealership question`, await stepIs(page, 'dealership'), '');

  await press(page, '#join-primary');
  s = await state(page);
  report(`${label}: a choice is asked for before going on`, s.step === 'dealership' && s.choiceErr === 'Choose one to carry on.', s.choiceErr);
  await press(page, '.join-opt:has(input[value="yes"])');
  report(`${label}: Yes walks on to the shop by itself`, await stepIs(page, 'shop'), '');
  await press(page, '#join-primary');
  s = await state(page);
  report(`${label}: the shop's name is asked for`, s.shopErr === 'Please enter your shop\'s name.', s.shopErr);
  await fill(page, '#join-shop', 'Shree Auto Works');
  await press(page, '#join-primary');
  await stepIs(page, 'send');
  s = await state(page);
  const want = joinMessage({ name: 'Ramesh Kumar', shop: 'Shree Auto Works', planning: false, place: { town: 'Indore', state: 'Madhya Pradesh' } });
  report(`${label}: the message is shown, and the link carries exactly it`,
    s.message === want && s.href === waUrl(want) && s.whatsapp && s.primary === null && s.back && s.progress === 'done,done,done,current',
    s.message);
  await page.screenshot({ path: path.join(OUT, `flow-${label}-4-send.png`) });

  // Not yet: back to the question, the other answer, and the shop is skipped both ways.
  await press(page, '.join__back');
  await stepIs(page, 'shop');
  await press(page, '.join__back');
  await stepIs(page, 'dealership');
  await press(page, '.join-opt:has(input[value="no"])');
  await stepIs(page, 'send');
  s = await state(page);
  const planning = joinMessage({ name: 'Ramesh Kumar', planning: true, place: { town: 'Indore', state: 'Madhya Pradesh' } });
  report(`${label}: Not yet skips the shop and says they are planning one`, s.message === planning && s.href === waUrl(planning), s.message);
  await press(page, '.join__back');
  report(`${label}: and back from the message goes to the question, not the shop`, await stepIs(page, 'dealership'), '');
  await press(page, '.join-opt:has(input[value="yes"])');
  await stepIs(page, 'shop');
  await press(page, '#join-primary');
  await stepIs(page, 'send');

  // Esc closes; opening again picks up at the message.
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('join-sheet').open, 3000);
  await press(page, '#join-open');
  await revealed(page);
  s = await state(page);
  report(`${label}: Esc closes it, and it opens again where it was left`, s.step === 'send' && s.message === want
    && s.track.filter((t) => t === 'dealer_join_open').length === 2, s.step);

  // Open WhatsApp: a new tab at wa.me with the text, contact_tap counted, the sheet put away.
  const tab = browser.waitForTarget((t) => /^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test(t.url()), { timeout: 8000 }).catch(() => null);
  await press(page, '#join-whatsapp');
  const target = await tab;
  const opened = target ? target.url() : '';
  if (target) {
    const p = await target.page().catch(() => null);
    if (p) await p.close().catch(() => {});
  }
  const closed = await until(page, () => !document.getElementById('join-sheet').open, 3000);
  s = await state(page);
  // WhatsApp may already have sent the tab on from wa.me to api.whatsapp.com/send: either way
  // the number and the text must be exactly ours.
  const sent = (() => {
    try {
      const u = new URL(opened);
      if (u.hostname === 'wa.me') return { phone: u.pathname.slice(1), text: u.searchParams.get('text') };
      return { phone: u.searchParams.get('phone'), text: u.searchParams.get('text') };
    } catch {
      return {};
    }
  })();
  report(`${label}: Open WhatsApp opens WhatsApp with the message, is counted, and the sheet goes`,
    sent.phone === '919220199098' && sent.text === want && closed && s.track.includes('contact_tap:dealer join'),
    `${opened.split('?')[0]} ${s.track.join(',')}`);

  // Fresh after sending: the next one starts at the beginning, the place kept.
  await press(page, '#join-open');
  await revealed(page);
  s = await state(page);
  report(`${label}: after sending, the next opening starts afresh`, s.step === 'location' && s.found === 'Near Indore, Madhya Pradesh' && s.primary === 'Continue', `${s.step} ${s.primary}`);

  // The browser's back button closes it, and leaves the address as it was.
  const before = await page.evaluate(() => location.href);
  await page.goBack();
  const backClosed = await until(page, () => !document.getElementById('join-sheet').open, 3000);
  report(`${label}: the back button closes it and the page stays`, backClosed && (await page.evaluate(() => location.href)) === before, '');

  await sleep(300);
  const leaked = outbound.slice(sentBefore).filter((r) => MARKS.some((m) => r.includes(m)));
  const track = JSON.stringify(await page.evaluate(() => window.__track));
  report(`${label}: the position goes nowhere (no request, no address, no event)`,
    !leaked.length && !MARKS.some((m) => track.includes(m) || s.url.includes(m)), leaked.slice(0, 2).join(' | ') || `${outbound.length - sentBefore} requests looked at`, errors);
  await page.close();
  await ctx.clearPermissionOverrides();
}

async function refused(label, viewport) {
  // No permission: the browser says no, and the connection's state stands in.
  await setModes({ region: 'ok' });
  const { page, errors } = await open(`${SITE}/dealers.html`, { viewport });
  await sleep(500);
  await press(page, '#join-open');
  await revealed(page);
  await press(page, '#join-primary');
  await until(page, () => document.getElementById('join-note').textContent !== '', 15000);
  let s = await state(page);
  report(`${label}: refused, it says so kindly and offers Continue`,
    /That is fine, you can carry on\.$/.test(s.note) && s.primary === 'Continue' && !s.skip && s.found === null, s.note);
  await page.screenshot({ path: path.join(OUT, `refused-${label}-1.png`) });
  await press(page, '#join-primary');
  await stepIs(page, 'name');
  await fill(page, '#join-name', 'Asha Verma');
  await press(page, '#join-primary');
  await stepIs(page, 'dealership');
  await press(page, '.join-opt:has(input[value="no"])');
  await stepIs(page, 'send');
  s = await state(page);
  const want = joinMessage({ name: 'Asha Verma', planning: true, place: { town: null, state: 'Madhya Pradesh' } });
  report(`${label}: the connection's state goes in instead ("in Madhya Pradesh")`, s.message === want && s.href === waUrl(want), s.message, errors);
  await page.close();

  // Skipped, with Paddock down: no place at all, and nothing broken.
  await setModes({ region: 'down' });
  const down = await open(`${SITE}/dealers.html`, { viewport });
  await sleep(500);
  await press(down.page, '#join-open');
  await revealed(down.page);
  await press(down.page, '#join-skip');
  await stepIs(down.page, 'name');
  await fill(down.page, '#join-name', 'Asha Verma');
  await press(down.page, '#join-primary');
  await stepIs(down.page, 'dealership');
  await press(down.page, '.join-opt:has(input[value="yes"])');
  await stepIs(down.page, 'shop');
  await fill(down.page, '#join-shop', 'Verma Motors');
  await press(down.page, '#join-primary');
  await stepIs(down.page, 'send');
  s = await state(down.page);
  const plain = joinMessage({ name: 'Asha Verma', shop: 'Verma Motors', planning: false, place: null });
  report(`${label}: skipped with Paddock down, the message simply leaves the place out`, s.message === plain && s.href === waUrl(plain), s.message,
    down.errors.filter((e) => !/503|Service Unavailable/.test(e)));
  await down.page.close();
  await setModes({ region: 'ok' });
}

async function noScript() {
  const { page } = await open(`${SITE}/dealers.html`, { js: false });
  const st = await page.evaluate(() => {
    const a = document.getElementById('join-open');
    const r = a.getBoundingClientRect();
    return { href: a.getAttribute('href'), seen: r.width > 0 && r.height > 0, sheet: getComputedStyle(document.getElementById('join-sheet')).display };
  });
  report('no JavaScript: the link is on the page and goes to WhatsApp, and the sheet is not shown',
    st.seen && st.href === waUrl(joinMessage({})) && st.sheet === 'none', JSON.stringify(st));
  await page.close();
}

if (only !== 'fit') {
  for (const [label, viewport] of [['phone', PHONE], ['desktop', DESK]]) {
    await flow(label, viewport);
    await refused(label, viewport);
  }
  await noScript();
}

// ---------------------------------------------------------------- the fit
const phone = (width, height) => ({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const desk = (width, height) => ({ width, height, deviceScaleFactor: 1 });
const SIZES = [
  phone(280, 653), phone(320, 568), phone(344, 882), phone(359, 740), phone(360, 640), phone(360, 780),
  phone(375, 667), phone(375, 812), phone(390, 844), phone(393, 852), phone(402, 874), phone(412, 915),
  phone(430, 932), phone(440, 956),
  phone(568, 320), phone(667, 375), phone(844, 390), phone(932, 430),
  phone(673, 841), phone(744, 1133), phone(759, 1000), phone(760, 1000), phone(768, 1024), phone(810, 1080),
  phone(820, 1180), phone(834, 1194), phone(1024, 1366), phone(1180, 820), phone(1366, 1024),
  desk(1024, 768), desk(1025, 768), desk(1100, 800), desk(1280, 800), desk(1366, 768), desk(1440, 900),
  desk(1536, 864), desk(1920, 1080), desk(2560, 1440),
];
const RUNS = SIZES.map((viewport) => ({ viewport, text: 100 }));
for (const text of [125, 150]) {
  for (const viewport of [phone(320, 568), phone(390, 844), desk(1025, 768), desk(1440, 900)]) RUNS.push({ viewport, text });
}
const sizesArg = arg('--sizes');
const runs = RUNS.filter((r) => !sizesArg || sizesArg.split(',').includes(`${r.viewport.width}x${r.viewport.height}`));
const nameOf = (r) => `${r.viewport.width}x${r.viewport.height}${r.text !== 100 ? `@${r.text}` : ''}`;

/** Runs in the page: what is wrong with the sheet as it stands, as sentences. */
function measure(keysAt) {
  const E = 0.5;
  const out = [];
  const rect = (el) => el.getBoundingClientRect();
  const shown = (el) => Boolean(el) && !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
  const inside = (a, b) => a.left >= b.left - E && a.right <= b.right + E && a.top >= b.top - E && a.bottom <= b.bottom + E;
  const meet = (a, b) => a.left < b.right - E && b.left < a.right - E && a.top < b.bottom - E && b.top < a.bottom - E;
  const tag = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].join('.')}` : ''}`;
  const sheet = document.getElementById('join-sheet');
  const s = rect(sheet);
  const bottom = keysAt || innerHeight;
  if (document.documentElement.scrollWidth > innerWidth + E) out.push('the page scrolls sideways');
  if (s.top < -E || s.left < -E || s.right > innerWidth + E || s.bottom > bottom + E) {
    out.push(`the sheet is off screen (${Math.round(s.left)},${Math.round(s.top)} to ${Math.round(s.right)},${Math.round(s.bottom)} in ${innerWidth}x${bottom})`);
  }
  if (sheet.scrollWidth > sheet.clientWidth + 1) out.push('the sheet scrolls sideways');
  const scroller = sheet.querySelector('.join__scroll');
  if (scroller.scrollWidth > scroller.clientWidth + 1) out.push('the questions scroll sideways');
  const foot = sheet.querySelector('.join__foot');
  const f = rect(foot);
  if (!inside(f, s)) out.push('the button bar is outside the sheet');
  const action = [document.getElementById('join-primary'), document.getElementById('join-whatsapp')].find(shown);
  if (!action) out.push('there is no button');
  else {
    const a = rect(action);
    if (!inside(a, f)) out.push('the button is outside its bar');
    if (action.scrollWidth > action.clientWidth + 1) out.push(`"${action.textContent.trim()}" does not fit its button`);
    if (a.height < 43.5) out.push(`the button is ${Math.round(a.height)}px tall, too small to tap`);
  }
  // The bar: back, progress and close side by side, none on another or on the title.
  const bar = [sheet.querySelector('.join__back'), sheet.querySelector('.join__progress'), sheet.querySelector('.story__close')].filter(shown);
  for (let i = 0; i < bar.length; i++) {
    for (let j = i + 1; j < bar.length; j++) if (meet(rect(bar[i]), rect(bar[j]))) out.push(`${tag(bar[i])} overlaps ${tag(bar[j])}`);
  }
  const step = [...sheet.querySelectorAll('.join__step')].find((el) => !el.hidden);
  const title = step && step.querySelector('.join__title');
  const close = sheet.querySelector('.story__close');
  // Only the part of the title in view: scrolled up behind the bar, it is out of sight.
  const view = rect(scroller);
  if (title && shown(close)) {
    const t = rect(title);
    const seen = { left: t.left, right: t.right, top: Math.max(t.top, view.top), bottom: Math.min(t.bottom, view.bottom) };
    if (seen.bottom > seen.top && meet(seen, rect(close))) out.push('the title runs under the close button');
  }
  // Nothing clipped inside the step or the bar.
  for (const el of [...sheet.querySelectorAll('.join__step:not([hidden]) *, .join__foot *')]) {
    if (!shown(el) || el instanceof SVGElement || getComputedStyle(el).display === 'inline') continue;
    // The bubble's tail hangs out of it on purpose; it is checked against the chat below.
    if (el.matches('.sr-only, input[type="radio"], .join__bubble')) continue;
    if (el.scrollWidth > el.clientWidth + 1) out.push(`${tag(el)} is clipped (${el.scrollWidth}px in ${el.clientWidth}px)`);
  }
  // Every option card and the bubble sit inside the step's width.
  for (const el of sheet.querySelectorAll('.join__step:not([hidden]) .join-opt, .join__step:not([hidden]) .join__bubble, .join__step:not([hidden]) .join__found')) {
    if (!shown(el)) continue;
    const r = rect(el);
    const box = rect(scroller);
    if (r.left < box.left - E || r.right > box.right + E) out.push(`${tag(el)} is wider than the sheet`);
  }
  const bubble = sheet.querySelector('.join__step:not([hidden]) .join__bubble');
  if (shown(bubble)) {
    const b = rect(bubble);
    const chat = rect(bubble.parentElement);
    // The tail is 7px past the bubble's right edge.
    if (b.right + 7 > chat.right + E || b.left < chat.left - E) out.push('the message bubble or its tail leaves the chat');
    if (bubble.scrollHeight > bubble.clientHeight + 1) out.push('the message is cut off');
  }
  // With a keyboard up, the field being typed in is in view above it.
  if (keysAt) {
    const field = document.activeElement;
    if (field && field.matches('.field__input')) {
      const r = rect(field);
      const box = rect(scroller);
      if (r.top < box.top - E || r.bottom > Math.min(box.bottom, keysAt) + E) out.push('the field being typed in is out of view');
    }
  }
  return {
    problems: out,
    scrolls: scroller.scrollHeight > scroller.clientHeight + 1,
    sheet: { left: s.left, top: s.top, width: s.width, height: s.height },
  };
}

const STEPS = ['location', 'located', 'name', 'name-error', 'name-keys', 'dealership', 'shop', 'send'];
const results = [];


async function fit(run) {
  const name = nameOf(run);
  const seen = {};
  const touch = Boolean(run.viewport.hasTouch);
  const at = async (page, stepName, keysAt = 0) => {
    await still(page);
    await sleep(150);
    const got = await page.evaluate(measure, keysAt);
    const file = `${name}--${stepName}.jpg`;
    await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 88 });
    seen[stepName] = { ...got, file };
  };
  for (const stepName of STEPS) {
    if (stepName === 'name-keys' && !touch) continue;
    const hook = { located: 'location', 'name-error': 'name', 'name-keys': 'name' }[stepName] || stepName;
    const located = stepName === 'located';
    const { page, errors } = await open(`${SITE}/dealers.html?check&join=${hook}`, {
      viewport: run.viewport, text: run.text, fix: located ? INDORE : undefined,
    });
    await still(page, 8000);
    if (located) {
      await click(page, '#join-primary');
      const placed = await until(page, () => !document.getElementById('join-found').hidden, 8000);
      await sleep(400);
      seen[stepName] = { ...(await page.evaluate(measure, 0)), file: `${name}--${stepName}.jpg` };
      if (!placed) seen[stepName].problems.push('the place never showed');
      // The place they are told they are in is in view, above the button.
      const inView = await page.evaluate(() => {
        const chip = document.getElementById('join-found').getBoundingClientRect();
        const box = document.querySelector('#join-sheet .join__scroll').getBoundingClientRect();
        return chip.top >= box.top - 0.5 && chip.bottom <= box.bottom + 0.5;
      });
      if (!inView) seen[stepName].problems.push('the place is out of view');
      await page.screenshot({ path: path.join(OUT, `${name}--${stepName}.jpg`), type: 'jpeg', quality: 88 });
    } else if (stepName === 'name-error') {
      await page.$eval('#join-name', (el) => { el.value = ''; });
      await click(page, '#join-primary');
      await at(page, stepName);
    } else if (stepName === 'name-keys') {
      const keysAt = await page.evaluate(() => {
        const top = Math.round(innerHeight * 0.58);
        document.getElementById('join-name').focus({ preventScroll: true });
        document.documentElement.classList.add('is-typing');
        const sheet = document.getElementById('join-sheet');
        sheet.style.setProperty('--vv-top', '0px');
        sheet.style.setProperty('--vv-h', `${top}px`);
        return top;
      });
      await sleep(100);
      await page.evaluate(() => document.getElementById('join-name').scrollIntoView({ block: 'center', behavior: 'instant' }));
      await at(page, stepName, keysAt);
    } else {
      await at(page, stepName);
    }
    if (errors.length) seen[stepName].problems.push(...errors.map((e) => `page error: ${e}`));
    await page.close();
  }
  const problems = Object.entries(seen).flatMap(([k, v]) => v.problems.map((p) => `${k}: ${p}`));
  // At 100% text on a screen of 640px or more, every step fits without scrolling.
  if (run.text === 100 && run.viewport.height >= 640 && run.viewport.width >= 320) {
    for (const [k, v] of Object.entries(seen)) {
      if (k !== 'name-keys' && v.scrolls) problems.push(`${k}: the step has to scroll`);
    }
  }
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${name.padEnd(13)} ${Object.keys(seen).length} steps`
    + `${problems.length ? `\n        ${problems.join('\n        ')}` : ''}`);
  results.push({ run, name, seen });
}

if (only !== 'flow') {
  const queue = [...runs];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const run = queue.shift();
      try {
        await fit(run);
      } catch (e) {
        failed++;
        console.log(`FAIL  ${nameOf(run)}: ${e.message}`);
      }
    }
  }));

  // Contact sheets: one per step, every size side by side.
  const ORDER = new Map(runs.map((r, i) => [nameOf(r), i]));
  results.sort((a, b) => ORDER.get(a.name) - ORDER.get(b.name));
  for (const stepName of STEPS) {
    const have = results.filter((r) => r.seen[stepName]);
    if (!have.length) continue;
    const html = `<!doctype html><meta charset="utf-8"><style>
      body { margin: 0; padding: 24px; background: #e9e9e7; font: 13px/1.4 system-ui, sans-serif; }
      .grid { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
      figure { margin: 0; } img { height: 460px; display: block; outline: 1px solid rgb(0 0 0 / 0.15); }
      .bad figcaption { color: #b3261e; font-weight: 600; }
    </style><h1>${stepName}</h1><div class="grid">${have.map((r) => `<figure class="${r.seen[stepName].problems.length ? 'bad' : ''}"><img src="${r.seen[stepName].file}"><figcaption>${r.name}</figcaption></figure>`).join('')}</div>`;
    const file = path.join(OUT, `sheet-${stepName}.html`);
    fs.writeFileSync(file, html);
    const page = await browser.newPage();
    await page.setViewport({ width: 1800, height: 1000, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    await page.screenshot({ path: file.replace('.html', '.png'), fullPage: true });
    await page.close();
  }
}

await browser.close();
server.close();
await mock.close?.();
console.log(failed ? `\n${failed} check(s) failed` : '\ndealer-join: all checks passed');
process.exitCode = failed ? 1 : 0;
