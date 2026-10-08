#!/usr/bin/env node
/*
 * The support page's contact form and order tracking, in headless Chrome, against the working
 * copy (tools/serve.mjs) and the Paddock mock (tools/check/paddock-mock.mjs).
 *
 *   node tools/check/support.mjs [--root dir] [--keep]
 *
 * The pages talk to http://localhost:3000. Rather than take that port (another check or
 * `npm run mock` may have it), the mock runs on a port of its own and this file answers the
 * page's requests to :3000 from it, so the page sees exactly what Paddock would send. A few
 * answers the mock cannot be asked for (Paddock's 400 with its fields as a list, a map link
 * that is not Google's) are written here instead.
 *
 * At 390x844, a phone:
 *   - every FAQ has a stable data-faq-id Paddock will accept, the manual a data-manual-id, and
 *     opening a FAQ is counted (faq_open reaches the mock's event log)
 *   - the halo: while the sheet is up only the sheet writes the field, and the disclosure's
 *     rim takes it back only once the sheet has let go
 *   - validation as the server validates, inline per field, and the server's own field errors
 *     land on the right inputs (both of Paddock's shapes)
 *   - a draft survives in sessionStorage without the consent box; a filled form is not swiped
 *     away, an empty one is
 *   - with a keyboard up (visualViewport stubbed to 508px), the field being typed in is in view
 *   - 201: the GXS reference, the WhatsApp line, the call time; what Paddock received
 *   - 429: how many minutes to wait
 *   - the honeypot is never filled, focusable or announced, and goes up empty
 *   - a tracked dealership order shows Collect from (call, directions, hours), a map link that
 *     is not Google's is not shown, and "Something not right?" opens the form on that order
 *   - #callback?topic=... opens the form on its own, and closing it spends the link
 * And at 1440x900, the centred panel opens and fits.
 */
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { startMock } from './paddock-mock.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--root');
const root = path.resolve(i >= 0 ? args[i + 1] : '.');
// Ports the system hands out, so this never collides with another check, a dev server or the
// mock someone has running on :3000.
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

const server = await serve({ root, port: PORT, quiet: true });
const mock = await startMock({ port: MOCK_PORT, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};

const mockLog = async (since = 0) => (await (await fetch(`${mock.url}/__mock/log?since=${since}`)).json()).entries;
const lastSeq = async () => { const e = await mockLog(); return e.length ? e[e.length - 1].seq : 0; };
/** Wait for the mock to have seen something, up to `ms`. */
async function seen(match, since, ms = 8000) {
  const until = Date.now() + ms;
  for (;;) {
    const hit = (await mockLog(since)).find(match);
    if (hit || Date.now() > until) return hit || null;
    await sleep(150);
  }
}
const eventSeen = (name, test = () => true) => (e) => e.path.endsWith('/event')
  && e.body && e.body.accepted && e.body.accepted.some((ev) => ev.name === name && test(ev.props));

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { width: 1440, height: 900, deviceScaleFactor: 1 };

/**
 * A page whose calls to Paddock are answered by the mock, or by `overrides[path]` when given
 * (a function returning { status, body }).
 */
async function open(hash = '', { viewport = PHONE, overrides = {}, keyboard = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The browser logs its own line for every 4xx answer; the ones here are asked for on purpose.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = req.url();
    if (!url.startsWith(`${PADDOCK}/`)) { req.continue(); return; }
    const cors = { 'Access-Control-Allow-Origin': SITE, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    try {
      if (req.method() === 'OPTIONS') { await req.respond({ status: 204, headers: cors }); return; }
      const route = new URL(url).pathname;
      if (overrides[route]) {
        const { status, body } = overrides[route](JSON.parse(req.postData() || '{}'));
        await req.respond({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
        return;
      }
      const res = await fetch(url.replace(PADDOCK, mock.url), {
        method: req.method(), headers: { ...req.headers(), origin: SITE }, body: req.postData(),
      });
      const headers = {};
      res.headers.forEach((v, k) => { if (!/content-encoding|content-length/i.test(k)) headers[k] = v; });
      await req.respond({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    } catch {
      req.abort().catch(() => {});
    }
  });
  if (keyboard) {
    // A phone's keyboard shrinks only the visual viewport. Stand one in that can be told to.
    await page.evaluateOnNewDocument(() => {
      const vv = new EventTarget();
      let h = window.innerHeight;
      Object.defineProperties(vv, {
        width: { get: () => window.innerWidth },
        height: { get: () => h },
        offsetTop: { get: () => 0 },
        offsetLeft: { get: () => 0 },
        pageTop: { get: () => window.scrollY },
        scale: { get: () => 1 },
      });
      window.__keyboard = (px) => { h = window.innerHeight - px; vv.dispatchEvent(new Event('resize')); };
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    });
  }
  await page.goto(`${SITE}/support.html${hash}`, { waitUntil: 'load' });
  return { page, errors };
}

const sheetOpen = (page) => page.evaluate(() => {
  const d = document.getElementById('support-sheet');
  return Boolean(d && d.open && d.classList.contains('is-open'));
});
const waitOpen = (page) => page.waitForFunction(() => document.getElementById('support-sheet').classList.contains('is-revealed'), { timeout: 4000 }).then(() => sleep(350)).catch(() => {});
const waitClosed = (page) => page.waitForFunction(() => !document.getElementById('support-sheet').open, { timeout: 4000 }).catch(() => {});

/** Fill the form through the keyboard, as a person would. */
async function fill(page, { name = 'Asha Verma', phone = '98765 43210', message = 'My PowerPod shows 80% after a full charge, is that normal?', topic = 'charging', time = 'morning', consent = true } = {}) {
  await page.evaluate((t) => document.querySelector(`input[name="topic"][value="${t}"]`).click(), topic);
  if (time) await page.evaluate((t) => { const r = document.querySelector(`input[name="preferredTime"][value="${t}"]`); if (r && !r.closest('[hidden]')) r.click(); }, time);
  for (const [sel, value] of [['#s-name', name], ['#s-phone', phone], ['#s-message', message]]) {
    await page.$eval(sel, (el) => { el.value = ''; });
    await page.type(sel, value);
  }
  if (consent) await page.evaluate(() => { const c = document.getElementById('s-consent'); if (!c.checked) c.click(); });
}

// ================================================================ the page
{
  const since = await lastSeq();
  const { page, errors } = await open();

  const ids = await page.evaluate(() => ({
    faq: [...document.querySelectorAll('.faq__item')].map((el) => el.dataset.faqId || ''),
    manual: [...document.querySelectorAll('.manuals__link')].map((el) => el.dataset.manualId || ''),
  }));
  const okId = (s) => /^[a-z0-9-]{1,48}$/.test(s);
  report('every FAQ has a stable, unique data-faq-id Paddock accepts', ids.faq.length >= 10 && ids.faq.every(okId)
    && new Set(ids.faq).size === ids.faq.length, `${ids.faq.length} FAQs`);
  report('every manual download has a data-manual-id', ids.manual.length > 0 && ids.manual.every(okId), ids.manual.join(','));

  // A FAQ opening is counted.
  await page.evaluate(() => document.querySelector('#faq .disclose__toggle').click());
  await sleep(300);
  await page.evaluate(() => document.querySelector('[data-faq-id="how-long-does-a-charge-take"] .disclose__toggle').click());
  const faq = await seen(eventSeen('faq_open', (p) => p.id === 'how-long-does-a-charge-take'), since);
  report('opening a FAQ sends faq_open with its id', Boolean(faq));
  const view = await seen((e) => e.path.endsWith('/pageview'), since);
  report('the pageview carries a tab id and a device bucket, as text/plain', Boolean(view && view.body.sid === 'given' && view.body.device && view.simple),
    view ? JSON.stringify({ device: view.body.device, simple: view.simple }) : 'no pageview');

  // ---------------------------------------------------------------- the halo
  // Open the Contact section (the disclosure's rim goes round it), then the sheet: from then
  // until the sheet has let the field go, only the sheet may write it.
  const hasField = await page.evaluate(() => Boolean(window.gridBG && window.gridBG.setHalo));
  await page.evaluate(() => {
    window.__halo = [];
    const api = window.gridBG;
    const real = api.setHalo.bind(api);
    const sheetDepth = api.projection().sheetDepth;
    api.setHalo = (spec) => {
      const who = !spec ? 'off' : Math.abs(spec.depth - sheetDepth) < 0.25 ? 'sheet' : 'page';
      window.__halo.push([performance.now(), who]);
      real(spec);
    };
    document.addEventListener('gridx:sheet-field', () => window.__halo.push([performance.now(), 'released']));
    document.querySelector('#contact .disclose__toggle').click();
  });
  await sleep(700);
  await page.evaluate(() => { window.__opened = performance.now(); document.querySelector('[data-support-open="callback"]').click(); });
  await waitOpen(page);
  await page.evaluate(() => document.querySelector('#support-sheet .story__close').click());
  await waitClosed(page);
  // The sheet's rim fades out after the slide; then the disclosure takes the field back.
  await page.waitForFunction(() => window.__halo.some(([, w]) => w === 'released'), { timeout: 4000 }).catch(() => {});
  await sleep(400);
  const halo = await page.evaluate(() => ({ log: window.__halo, opened: window.__opened }));
  const after = halo.log.filter(([t]) => t >= halo.opened);
  const releasedAt = after.findIndex(([, who]) => who === 'released');
  const during = releasedAt < 0 ? after : after.slice(0, releasedAt);
  const afterwards = releasedAt < 0 ? [] : after.slice(releasedAt + 1);
  const pageBefore = halo.log.filter(([t, who]) => t < halo.opened && who === 'page').length;
  report('the field is there to share', hasField && pageBefore > 0, `${pageBefore} page writes before the sheet`);
  report('no halo conflict: only the sheet writes while it is up', during.filter(([, w]) => w === 'sheet').length > 5
    && !during.some(([, w]) => w === 'page'),
    `${during.filter(([, w]) => w === 'sheet').length} sheet writes, ${during.filter(([, w]) => w === 'page').length} page writes`);
  report('the rim comes back once the sheet lets go, and the sheet stays out',
    releasedAt >= 0 && afterwards.some(([, w]) => w === 'page') && !afterwards.some(([, w]) => w === 'sheet'),
    `${afterwards.length} writes after the release`);
  report('no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ================================================================ the form
{
  const since = await lastSeq();
  const overrides = {}; // filled in below, for answers the mock cannot be asked for
  const { page, errors } = await open('', { keyboard: true, overrides });
  await page.evaluate(() => document.querySelector('#contact .disclose__toggle').click());
  await sleep(500);
  await page.evaluate(() => document.querySelector('[data-support-open="callback"]').click());
  await waitOpen(page);
  const t0 = Date.now();

  const opened = await page.evaluate(() => ({
    kind: document.querySelector('input[name="kind"]:checked')?.value,
    time: !document.getElementById('s-time-field').hidden,
    ref: !document.getElementById('s-ref-field').hidden,
    send: document.getElementById('support-send').getAttribute('aria-disabled'),
  }));
  report('"Request a callback" opens the form as a callback, with the call time showing', opened.kind === 'callback' && opened.time && !opened.ref && opened.send === 'true', JSON.stringify(opened));
  report('support_form_open sent', Boolean(await seen(eventSeen('support_form_open'), since)));

  // Nothing filled: a press says what is missing, field by field, and goes to the first.
  await page.evaluate(() => document.getElementById('support-send').click());
  await sleep(200);
  const empty = await page.evaluate(() => ({
    bad: [...document.querySelectorAll('#support-form .is-bad')].map((el) => el.id || el.querySelector('input,textarea')?.name),
    topic: document.getElementById('es-topic').textContent,
    name: document.getElementById('es-name').textContent,
    phone: document.getElementById('es-phone').textContent,
    message: document.getElementById('es-message').textContent,
    consent: document.getElementById('es-consent').textContent,
    hint: document.getElementById('support-hint').textContent,
    focus: document.activeElement?.name,
  }));
  report('an empty press marks each field with the server\'s own words',
    empty.topic === 'Choose what this is about.' && empty.name === 'Enter your name.'
    && empty.phone === 'Enter a 10 digit Indian mobile number.'
    && empty.message === 'Tell us a little more (at least 10 characters).'
    && empty.consent === 'Please agree so we can contact you about this.'
    && empty.hint === 'Choose what this is about.' && empty.focus === 'topic', JSON.stringify(empty));

  // Wrong, then right: errors correct themselves as they are fixed.
  await page.type('#s-phone', '12345');
  await page.type('#s-email', 'asha@');
  await page.type('#s-message', 'too short');
  await page.evaluate(() => document.getElementById('s-name').focus());
  await sleep(100);
  const wrong = await page.evaluate(() => ({
    phone: document.getElementById('es-phone').textContent,
    email: document.getElementById('es-email').textContent,
    message: document.getElementById('es-message').textContent,
  }));
  report('inline errors for a short phone, a half email and a short message', wrong.phone.includes('10 digit')
    && wrong.email === 'Enter a valid email address, or leave it empty.' && wrong.message.includes('at least 10'), JSON.stringify(wrong));
  await page.$eval('#s-email', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('blur')); });
  await fill(page, { phone: '+91 98765-43210' });
  const fixed = await page.evaluate(() => ({
    bad: document.querySelectorAll('#support-form .is-bad').length,
    send: document.getElementById('support-send').getAttribute('aria-disabled'),
    count: document.getElementById('cs-message').textContent,
  }));
  report('a valid form clears every error and wakes the button', fixed.bad === 0 && fixed.send === 'false', JSON.stringify(fixed));

  // The draft: everything typed, never the consent box, never the honeypot.
  await sleep(400);
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('gridx.supportDraft') || 'null'));
  report('a draft is kept in sessionStorage, without consent', draft && draft.name === 'Asha Verma' && draft.topic === 'charging'
    && !('consent' in draft) && !('company_website' in draft), JSON.stringify(draft && Object.keys(draft)));

  // A filled form is not swiped away.
  const box = await page.$eval('#support-sheet', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60, h: r.height }; });
  await page.$eval('#support-sheet .story__scroll', (el) => { el.scrollTop = 0; });
  const t = await page.touchscreen.touchStart(box.x, box.y);
  for (let k = 1; k <= 6; k++) await t.move(box.x, box.y + k * 60);
  await t.end();
  await sleep(700);
  report('a swipe does not close a form holding anything (canSwipe off)', await sheetOpen(page));

  // ---------------------------------------------------------------- the keyboard
  await page.evaluate(() => document.getElementById('s-message').focus());
  await page.evaluate(() => window.__keyboard(336));
  await sleep(900);
  const kb = await page.evaluate(() => {
    const vvH = window.visualViewport.height;
    const field = document.getElementById('s-message').closest('.field').getBoundingClientRect();
    const scroll = document.querySelector('#support-sheet .story__scroll').getBoundingClientRect();
    const sheet = document.getElementById('support-sheet').getBoundingClientRect();
    const foot = document.querySelector('.support__foot').getBoundingClientRect();
    return {
      typing: document.documentElement.classList.contains('is-typing'),
      vvH, sheetBottom: Math.round(sheet.bottom), fieldTop: Math.round(field.top), fieldBottom: Math.round(field.bottom),
      scrollTop: Math.round(scroll.top), scrollBottom: Math.round(scroll.bottom), footTop: Math.round(foot.top),
      focus: document.activeElement.id,
    };
  });
  report('keyboard up: the sheet fits above it and the focused field is in view (390x844)',
    kb.typing && kb.sheetBottom <= kb.vvH + 1 && kb.fieldTop >= kb.scrollTop - 1 && kb.fieldBottom <= kb.scrollBottom + 1
    && kb.fieldBottom <= kb.footTop + 1 && kb.fieldBottom <= kb.vvH && kb.focus === 's-message', JSON.stringify(kb));
  await page.evaluate(() => document.getElementById('s-name').focus());
  await sleep(700);
  const kb2 = await page.evaluate(() => {
    const r = document.getElementById('s-name').closest('.field').getBoundingClientRect();
    const s = document.querySelector('#support-sheet .story__scroll').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), sTop: Math.round(s.top), sBottom: Math.round(s.bottom) };
  });
  report('moving up to the name field brings it into view too', kb2.top >= kb2.sTop - 1 && kb2.bottom <= kb2.sBottom + 1, JSON.stringify(kb2));
  await page.evaluate(() => { document.activeElement.blur(); window.__keyboard(0); });
  await sleep(300);

  // ---------------------------------------------------------------- 201
  const wait = 3300 - (Date.now() - t0);
  if (wait > 0) await sleep(wait); // Paddock treats a form sent inside 3 s as a script's
  const before201 = await lastSeq();
  await page.evaluate(() => document.getElementById('support-send').click());
  await page.waitForFunction(() => !document.getElementById('support-done').hidden, { timeout: 8000 }).catch(() => {});
  const done = await page.evaluate(() => ({
    title: document.getElementById('support-done-title').textContent,
    ref: document.getElementById('support-done-ref').textContent,
    lines: [...document.querySelectorAll('.support__done-line')].map((p) => p.textContent),
    focus: document.activeElement.id,
    draft: sessionStorage.getItem('gridx.supportDraft'),
    finish: !document.getElementById('support-finish').hidden,
  }));
  report('201: the GXS reference, shown in place', /^GXS-[A-Z0-9]{6}$/.test(done.ref) && done.title === 'We have your request.' && done.focus === 'support-done-title', done.ref);
  report('201: the WhatsApp line and when we will call', done.lines[0] === 'We have sent a WhatsApp confirmation to your number.'
    && done.lines[1] === 'We will call you in the morning, Monday to Friday, 11 AM to 6 PM.', done.lines.join(' / '));
  report('201: the draft is cleared', done.draft === null && done.finish);
  const posted = await seen((e) => e.path.endsWith('/support'), before201);
  const b = posted && posted.body;
  report('what Paddock received follows the contract', Boolean(b && b.kind === 'callback' && b.name === 'Asha Verma'
    && b.phone === '+919876543210' && b.topic === 'charging' && b.preferredTime === 'morning' && b.consent === true
    && b.sourcePage === '/support.html' && b.elapsedMs >= 3000 && b.message.length >= 10 && !('orderRef' in b) && 'recaptchaToken' in b
    && posted.status === 201 && posted.note !== 'honeypot'), JSON.stringify(b && { ...b, message: `${b.message.length} chars` }));
  report('honeypot untouched: sent empty', Boolean(b && b.company_website === ''));
  const trap = await page.evaluate(() => {
    const el = document.getElementById('s-company');
    const r = el.getBoundingClientRect();
    return { value: el.value, tab: el.tabIndex, hidden: el.closest('[aria-hidden="true"]') !== null, visible: r.right > 0 && r.bottom > 0 && r.left < innerWidth };
  });
  report('honeypot: empty, out of the tab order, hidden from sight and screen readers', trap.value === '' && trap.tab === -1 && trap.hidden && !trap.visible, JSON.stringify(trap));
  report('support_form_submit sent', Boolean(await seen(eventSeen('support_form_submit'), since)));

  // Done closes, and the next open is a fresh form.
  await page.evaluate(() => document.getElementById('support-finish').click());
  await waitClosed(page);
  await page.evaluate(() => document.querySelector('[data-support-open="message"]').click());
  await waitOpen(page);
  const fresh = await page.evaluate(() => ({
    name: document.getElementById('s-name').value,
    kind: document.querySelector('input[name="kind"]:checked')?.value,
    ask: !document.getElementById('support-ask').hidden,
    time: document.getElementById('s-time-field').hidden,
  }));
  report('after Done, "Write to us" opens a fresh message form (no call time)', fresh.name === '' && fresh.kind === 'message' && fresh.ask && fresh.time, JSON.stringify(fresh));

  // An empty form swipes away as any sheet does.
  await page.$eval('#support-sheet .story__scroll', (el) => { el.scrollTop = 0; });
  const box2 = await page.$eval('#support-sheet', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; });
  const t2 = await page.touchscreen.touchStart(box2.x, box2.y);
  for (let k = 1; k <= 6; k++) await t2.move(box2.x, box2.y + k * 70);
  await t2.end();
  await waitClosed(page);
  report('an empty form can be swiped away', !(await sheetOpen(page)));

  // ---------------------------------------------------------------- 429 and 400
  // Paddock's own answers, sent from here: the 429 a phone over its budget gets, and the 400
  // with its fields as Paddock lists them ({ field, message }) and as the mock maps them.
  const SUPPORT = '/api/public/website/support';
  overrides[SUPPORT] = () => ({ status: 429, body: { success: false, code: 'rate_limited', retryAfterSec: 3600, error: 'You have sent a few requests already. Please try again later, or call us.' } });
  await page.evaluate(() => document.querySelector('[data-support-open="message"]').click());
  await waitOpen(page);
  await fill(page, { topic: 'other', time: null });
  await page.evaluate(() => document.getElementById('support-send').click());
  await page.waitForFunction(() => document.getElementById('support-hint').textContent.length > 10, { timeout: 6000 }).catch(() => {});
  const limited = await page.evaluate(() => ({
    hint: document.getElementById('support-hint').textContent,
    bad: document.getElementById('support-hint').classList.contains('is-bad'),
    stillAsking: !document.getElementById('support-ask').hidden,
  }));
  report('429: says how many minutes to wait', /wait 60 minutes/.test(limited.hint) && limited.bad && limited.stillAsking, limited.hint);

  const shapes = {
    list: [{ field: 'phone', message: 'This number cannot receive WhatsApp messages.' }, { field: 'message', message: 'Please leave out links.' }],
    map: { phone: 'This number cannot receive WhatsApp messages.', message: 'Please leave out links.' },
  };
  for (const [shape, fields] of Object.entries(shapes)) {
    overrides[SUPPORT] = () => ({ status: 400, body: { success: false, code: 'invalid', error: 'Please check the highlighted fields.', fields } });
    await page.evaluate(() => { document.getElementById('support-hint').textContent = ''; document.getElementById('support-send').click(); });
    await page.waitForFunction(() => document.getElementById('support-hint').textContent.length > 5, { timeout: 6000 }).catch(() => {});
    const st = await page.evaluate(() => ({
      phone: document.getElementById('es-phone').textContent,
      phoneBad: document.getElementById('s-phone').closest('.field').classList.contains('is-bad'),
      message: document.getElementById('es-message').textContent,
      hint: document.getElementById('support-hint').textContent,
      focus: document.activeElement.id,
    }));
    report(`server field errors (${shape}) marked on their inputs, focus on the first`,
      st.phone === 'This number cannot receive WhatsApp messages.' && st.phoneBad && st.message === 'Please leave out links.'
      && st.hint === 'Please check the highlighted fields.' && st.focus === 's-phone', JSON.stringify(st));
    // Editing a field takes the server's word off it; the next answer marks it again.
    await page.$eval('#s-phone', (el) => { el.value = '9876543211'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#s-message', (el) => { el.value += ' Thanks.'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const cleared = await page.evaluate(() => [document.getElementById('es-phone').textContent, document.getElementById('es-message').textContent]);
    report(`editing a field clears the server's message on it (${shape})`, cleared.join('') === '', cleared.join(' / '));
  }
  report('no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ================================================================ tracking
{
  const since = await lastSeq();
  const overrides = {};
  const { page, errors } = await open('', { overrides });
  await page.evaluate(() => document.querySelector('#track .disclose__toggle').click());
  await sleep(400);
  await page.type('#t-ref', 'GX-COLLECT1');
  await page.type('#t-phone', '9876543210');
  await page.evaluate(() => document.getElementById('track-go').click());
  await page.waitForFunction(() => !document.getElementById('track-result').hidden, { timeout: 6000 }).catch(() => {});
  const collect = await page.evaluate(() => {
    const box = document.querySelector('.track__collect');
    const links = box ? [...box.querySelectorAll('a')] : [];
    return {
      shown: Boolean(box),
      name: box?.querySelector('.track__collect-name')?.textContent,
      text: box?.textContent || '',
      call: links.find((a) => a.protocol === 'tel:')?.getAttribute('href'),
      callLabel: links.find((a) => a.protocol === 'tel:')?.textContent.trim(),
      maps: links.find((a) => /maps/.test(a.href))?.href,
      mapsTarget: links.find((a) => /maps/.test(a.href))?.rel,
      numberPrinted: (box?.textContent.match(/98765 43201/g) || []).length,
    };
  });
  report('Collect from: name, address and hours', collect.shown && collect.name === 'Okhla Swap Hub'
    && collect.text.includes('Okhla Phase 1') && collect.text.includes('Open Monday to Saturday'), collect.text.slice(0, 120));
  report('Collect from: a Call link, the number only as its label', collect.call === 'tel:+919876543201' && collect.callLabel === '+91 98765 43201' && collect.numberPrinted === 1);
  report('Collect from: Directions to Google Maps, in a new tab without a referrer', /^https:\/\/www\.google\.com\/maps\//.test(collect.maps || '') && /noopener/.test(collect.mapsTarget || ''), collect.maps);
  report('track_lookup found sent', Boolean(await seen(eventSeen('track_lookup', (p) => p.result === 'found'), since)));

  // "Something not right?" opens the form on this order.
  await page.evaluate(() => document.querySelector('.track__help-link').click());
  await waitOpen(page);
  const help = await page.evaluate(() => ({
    topic: document.querySelector('input[name="topic"]:checked')?.value,
    ref: document.getElementById('s-ref').value,
    refShown: !document.getElementById('s-ref-field').hidden,
    kind: document.querySelector('input[name="kind"]:checked')?.value,
  }));
  report('"Something not right?" opens the form on the order, reference filled in', help.topic === 'order' && help.ref === 'GX-COLLECT1' && help.refShown && help.kind === 'message', JSON.stringify(help));
  await page.evaluate(() => document.querySelector('#support-sheet .story__close').click());
  await waitClosed(page);

  // A wrong reference is counted as not found.
  await page.$eval('#t-ref', (el) => { el.value = ''; });
  await page.type('#t-ref', 'GX-NOPE123');
  await page.evaluate(() => document.getElementById('track-go').click());
  report('track_lookup not_found sent', Boolean(await seen(eventSeen('track_lookup', (p) => p.result === 'not_found'), since)));

  // A map link that is not Google's own, and a phone that is not a number: neither is shown.
  const order = (mapsUrl, e164) => ({
    status: 200,
    body: { success: true, order: {
      reference: 'GX-COLLECT1', headline: 'Ready for collection', summary: 'PowerPod Gen2', kind: 'powerpod', delivery: 'dealership', chargedInr: 5000,
      steps: [{ key: 'ready', label: 'Ready for collection', done: true, at: '2026-10-04T06:30:00.000Z' }],
      collectFrom: { name: 'Okhla Swap Hub', address: null, mapsUrl, phone: { display: '+91 98765 43201', e164 }, hoursNote: null },
    } },
  });
  for (const [label, url, e164] of [['another site', 'https://evil.example/maps/place', 'javascript:alert(1)'], ['a script link', 'javascript:alert(1)', '+91 98765'], ['plain http', 'http://maps.google.com/?q=x', '']]) {
    overrides['/api/public/website/orders/track'] = () => order(url, e164);
    await page.evaluate(() => { document.getElementById('track-result').hidden = true; document.getElementById('track-go').click(); });
    await page.waitForFunction(() => !document.getElementById('track-result').hidden, { timeout: 6000 }).catch(() => {});
    const st = await page.evaluate(() => ({
      shown: Boolean(document.querySelector('.track__collect')),
      links: [...document.querySelectorAll('.track__collect a')].map((el) => el.getAttribute('href')),
    }));
    report(`Collect from: no Directions or Call for ${label}`, st.shown && st.links.length === 0, JSON.stringify(st.links));
  }
  report('no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ================================================================ deep links, and the desk
{
  const { page, errors } = await open('#callback?topic=order');
  await waitOpen(page);
  const st = await page.evaluate(() => ({
    open: document.getElementById('support-sheet').open,
    kind: document.querySelector('input[name="kind"]:checked')?.value,
    topic: document.querySelector('input[name="topic"]:checked')?.value,
  }));
  report('#callback?topic=order opens the form on its own', st.open && st.kind === 'callback' && st.topic === 'order', JSON.stringify(st));
  await page.keyboard.press('Escape');
  await waitClosed(page);
  report('closing spends the link (no hash left to reopen it)', await page.evaluate(() => window.location.hash === ''));
  report('no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
{
  const { page, errors } = await open('#write', { viewport: DESK });
  await waitOpen(page);
  const st = await page.evaluate(() => {
    const r = document.getElementById('support-sheet').getBoundingClientRect();
    const foot = document.querySelector('.support__foot').getBoundingClientRect();
    return { w: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom), footBottom: Math.round(foot.bottom), kind: document.querySelector('input[name="kind"]:checked')?.value };
  });
  report('1440x900: the centred panel opens on #write and fits the window', st.kind === 'message' && st.w <= 640 && st.top >= 0 && st.bottom <= 900 && st.footBottom <= st.bottom, JSON.stringify(st));
  report('no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

if (!args.includes('--keep')) {
  await browser.close();
  server.close();
  await mock.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nsupport: all checks passed');
process.exitCode = failed ? 1 : 0;
