#!/usr/bin/env node
/*
 * The PowerPod Gen2 launch, checked in headless Chrome: the home page's line under the headline
 * (when pre-booking opens), the button it brings in at 12 PM IST on 12 October, and the
 * configurator holding its payment until then. assets/launch.js keeps the time for both.
 *
 *   node tools/check/launch.mjs              the working copy
 *   node tools/check/launch.mjs --root dist  the built site (also catches CSP refusals)
 *
 * Time is moved with the page's own hook, ?check&launch=<seconds after the launch> (negative is
 * before), so the real clock and the page's correction of it never come into it.
 *
 * Home page, on a phone (390 × 844 and 320 × 568), a desktop and a landscape phone:
 *   - before the launch the line says when, under the headline, in after it, and reads whole
 *   - the headline is exactly where it is without the line
 *   - the line (and later the button) clears the phone's island, and nothing scrolls sideways
 *   - at the launch the line changes, the button comes in ready to be pressed, and a screen
 *     reader hears it; opened after the launch, the button is simply there
 *   - scrolled away, the button leaves the tab order
 *   - reduced motion, no WebGL and no JavaScript each still show the line
 * Configurator: before the launch every way into a payment waits and says when; at the launch
 * it opens without a reload; and Paddock's refusal reads out as sent.
 * Screenshots go to tools/check/out/launch-*.png for a look by eye.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const args = process.argv.slice(2);
const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : '.';
const ROOT = path.resolve(REPO, rootArg);
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const PORT = 8143;
const BASE = `http://localhost:${PORT}`;
const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  small: { width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  landscape: { width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const NOT_OPEN = 'Pre-booking opens 12 October, 12 PM IST. Shipping across India.';
const IGNORE = /favicon|status of 404|localhost:3000|ERR_CONNECTION_REFUSED|recaptcha|net::ERR_FAILED/i;

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve({ root: ROOT, port: PORT, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });

async function open(url, { viewport = VIEWPORTS.phone, js = true, before, ignore = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.setBypassServiceWorker(true);
  await page.setJavaScriptEnabled(js);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE.test(m.text()) && !(ignore && ignore.test(m.text()))) errors.push(m.text());
  });
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  if (before) await before(page);
  await page.goto(`${BASE}/${url}`, { waitUntil: 'load' });
  return { page, errors };
}

async function until(page, fn, timeout = 8000, arg) {
  const start = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg)) return Date.now() - start;
    if (Date.now() - start > timeout) return -1;
    await wait(25);
  }
}
async function finish(name, page, errors) {
  const csp = await page.evaluate(() => window.__csp || []);
  report(`${name}: no errors`, !errors.length, errors.join(' | '));
  report(`${name}: no CSP refusals`, !csp.length, csp.join(' | '));
  await page.close();
}

// ---------------------------------------------------------------- home page, before the launch
const LINE = 'Pre-booking opens 12 October, 12 PM. Shipping across India.';
const placement = (page) => page.evaluate(() => {
  const r = (el) => el.getBoundingClientRect();
  const launch = document.querySelector('.launch');
  const island = document.querySelector('.island-wrap');
  // The island where it rests, and only if it is under the line (a landscape phone keeps it to
  // the right).
  let floor = innerHeight;
  if (island) {
    const ir = r(island);
    const lr = r(launch.querySelector('.launch__note'));
    const shift = new DOMMatrixReadOnly(getComputedStyle(island).transform).m42;
    if (ir.top > innerHeight / 2 && ir.left < lr.right && ir.right > lr.left) floor = ir.top - shift;
  }
  const shown = [...launch.children].filter((el) => getComputedStyle(el).display !== 'none' && !el.classList.contains('sr-only'));
  return {
    headline: r(document.querySelector('.headline')).bottom,
    top: Math.min(...shown.map((el) => r(el).top)),
    bottom: Math.max(...shown.map((el) => r(el).bottom)),
    floor,
    sideways: document.documentElement.scrollWidth > innerWidth,
    opacity: shown.map((el) => Number(getComputedStyle(el).opacity)),
    text: launch.querySelector('[data-launch-note]').textContent,
  };
});

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  const { page, errors } = await open('index.html?check&launch=-300000', { viewport });
  await until(page, () => document.querySelector('.headline').classList.contains('is-revealed'), 8000);
  await wait(1800);
  const p = await placement(page);
  report(`${name}: says when`, p.text === LINE, p.text);
  report(`${name}: in with the headline`, p.opacity.every((o) => o > 0.99), p.opacity.join(', '));
  report(`${name}: under the headline`, p.top >= p.headline + 6 && p.top <= p.headline + 40,
    `headline ends ${Math.round(p.headline)}, line starts ${Math.round(p.top)}`);
  report(`${name}: clear of the island`, p.bottom <= p.floor - 12, `ends ${Math.round(p.bottom)}, island at ${Math.round(p.floor)}`);
  report(`${name}: nothing sideways`, !p.sideways);
  const lines = await page.evaluate(() => {
    const note = document.querySelector('.launch__note');
    return Math.round(note.getBoundingClientRect().height / parseFloat(getComputedStyle(note).lineHeight));
  });
  report(`${name}: reads whole`, lines <= (name === 'small' ? 3 : 2), `${lines} line(s)`);
  await page.screenshot({ path: path.join(OUT, `launch-${name}-before.png`) });
  await finish(name, page, errors);

  // The headline is where it always was: the same page with the line taken out.
  const rects = [];
  for (const remove of [true, false]) {
    const { page: p2 } = await open('index.html?check&launch=-300000', {
      viewport,
      before: remove ? (pg) => pg.evaluateOnNewDocument(() => {
        document.addEventListener('DOMContentLoaded', () => document.querySelector('.launch').remove());
      }) : undefined,
    });
    rects.push(await p2.evaluate(() => JSON.stringify(document.querySelector('.headline').getBoundingClientRect())));
    await p2.close();
  }
  report(`${name}: headline unmoved`, rects[0] === rects[1], rects[0] === rects[1] ? '' : `${rects[0]} vs ${rects[1]}`);
}

// ---------------------------------------------------------------- the launch itself
for (const name of ['phone', 'small', 'desktop', 'landscape']) {
  const { page, errors } = await open('index.html?check&launch=-5', { viewport: VIEWPORTS[name] });
  const opened = await until(page, () => document.querySelector('.launch').classList.contains('is-open'), 9000);
  report(`${name}: opens at the instant`, opened >= 0);
  await wait(1600);
  const cta = await page.evaluate(() => {
    const a = document.querySelector('.launch__cta');
    const r = a.getBoundingClientRect();
    const style = getComputedStyle(a);
    a.focus();
    return {
      shown: style.display !== 'none' && Number(style.opacity) > 0.99,
      height: Math.round(r.height),
      hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === a,
      focused: document.activeElement === a,
      note: document.querySelector('[data-launch-note]').textContent,
      news: document.querySelector('[data-launch-news]').textContent,
      href: a.getAttribute('href'),
    };
  });
  report(`${name}: the button is in`, cta.shown && cta.hit && cta.focused, JSON.stringify(cta));
  report(`${name}: the button is big enough`, cta.height >= (name === 'landscape' ? 40 : 52), `${cta.height}px`);
  report(`${name}: says pre-booking is open`, cta.note === 'Pre-booking is now open. Shipping across India.' && cta.news === 'Pre-booking is open.', `${cta.note} / ${cta.news}`);
  report(`${name}: goes to the configurator`, cta.href === 'powerpod-gen2.html', cta.href);
  const p = await placement(page);
  report(`${name}: open, clear of the island`, p.bottom <= p.floor - 12 && !p.sideways, `ends ${Math.round(p.bottom)}, island at ${Math.round(p.floor)}`);
  await page.screenshot({ path: path.join(OUT, `launch-${name}-open.png`) });

  // Away with the headline, and back.
  await page.evaluate(() => window.scrollTo(0, innerHeight * 0.06));
  const left = await until(page, () => document.querySelector('.launch__cta').getAttribute('tabindex') === '-1', 3000);
  report(`${name}: leaves the tab order with the headline`, left >= 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  const back = await until(page, () => !document.querySelector('.launch__cta').hasAttribute('tabindex'), 3000);
  report(`${name}: back in it at the top`, back >= 0);
  await finish(`${name} launch`, page, errors);
}

// Opened after the launch: simply the button, nothing announced.
{
  const { page, errors } = await open('index.html?check&launch=120', { viewport: VIEWPORTS.phone });
  await until(page, () => document.querySelector('.headline').classList.contains('is-revealed'), 8000);
  await wait(1800);
  const s = await page.evaluate(() => ({
    open: document.querySelector('.launch').classList.contains('is-open'),
    button: getComputedStyle(document.querySelector('.launch__cta')).opacity,
    news: document.querySelector('[data-launch-news]').textContent,
  }));
  report('after the launch: the button, nothing announced', s.open && s.button === '1' && s.news === '', JSON.stringify(s));
  await finish('after the launch', page, errors);
}

// ---------------------------------------------------------------- fallbacks
for (const [label, before] of [
  ['reduced motion', (p) => p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])],
  ['no WebGL', (p) => p.evaluateOnNewDocument(() => {
    delete window.WebGL2RenderingContext;
    HTMLCanvasElement.prototype.getContext = function getContext() { return null; };
  })],
]) {
  // Without WebGL the pod's renderer says so too; that is the pod's own fallback, not this.
  const { page, errors } = await open('index.html?check&launch=-300000', { before, ignore: /WebGLRenderer|WebGL context/ });
  await wait(1800);
  const p = await placement(page);
  report(`${label}: the line, under the headline`, p.text === LINE && p.opacity.every((o) => o > 0.99) && p.top >= p.headline + 8,
    `${p.text} / ${p.opacity.join(', ')} / ${Math.round(p.top)} after ${Math.round(p.headline)}`);
  if (label === 'reduced motion') await page.screenshot({ path: path.join(OUT, 'launch-reduced.png') });
  await finish(label, page, errors);
}
{
  const { page } = await open('index.html', { js: false });
  const r = await page.evaluate(() => {
    const note = document.querySelector('.launch__note');
    const n = note.getBoundingClientRect();
    return {
      shown: getComputedStyle(note).opacity === '1' && n.height > 0,
      below: n.top >= document.querySelector('.headline').getBoundingClientRect().bottom,
      button: getComputedStyle(document.querySelector('.launch__cta')).display,
    };
  });
  report('no JavaScript: the line, and no button', r.shown && r.below && r.button === 'none', JSON.stringify(r));
  await page.screenshot({ path: path.join(OUT, 'launch-nojs.png') });
  await page.close();
}

// ---------------------------------------------------------------- configurator
async function toPayment(page) {
  for (const [group, value] of [['vehicle', 'no'], ['charger', '6a'], ['adapter', 'no'], ['dock', 'no']]) {
    await page.click(`label.opt[data-group="${group}"][data-value="${value}"]`);
  }
  await page.click('#pg2-next');
  await wait(400);
  for (const [id, value] of [['#f-name', 'Asha Menon'], ['#f-phone', '9876543210'], ['#f-email', 'asha@example.com'], ['#f-city', 'Bengaluru'], ['#f-pin', '560001']]) {
    await page.type(id, value);
  }
  await page.click('#pg2-next');
  await wait(500);
}
const payState = (page) => page.evaluate(() => ({
  offer: document.querySelector('#pg2-pay-reserve .pg2-step__sub').textContent,
  card: document.getElementById('pg2-reserve').getAttribute('aria-disabled'),
  next: document.getElementById('pg2-next').getAttribute('aria-disabled'),
  hint: document.getElementById('pg2-hint').textContent,
  status: document.getElementById('pg2-status').textContent,
  bill: !document.getElementById('pg2-pay-review').hidden,
}));
{
  const { page, errors } = await open('powerpod-gen2.html?check&launch=-6', { viewport: VIEWPORTS.phone });
  await toPayment(page);
  let s = await payState(page);
  report('configurator: the offer says when', s.offer === NOT_OPEN, s.offer);
  report('configurator: the card and the button rest', s.card === 'true' && s.next === 'true', JSON.stringify(s));
  await page.click('#pg2-next');
  await page.click('#pg2-reserve');
  s = await payState(page);
  report('configurator: a press says when, and stays put', s.hint === NOT_OPEN && s.status === NOT_OPEN && !s.bill, JSON.stringify(s));
  await page.screenshot({ path: path.join(OUT, 'launch-configurator-before.png') });
  const opened = await until(page, () => document.getElementById('pg2-reserve').getAttribute('aria-disabled') === 'false', 9000);
  s = await payState(page);
  report('configurator: opens at the instant, no reload', opened >= 0 && s.offer !== NOT_OPEN && s.hint === '' && s.status === '', JSON.stringify(s));
  await page.click('#pg2-reserve');
  s = await payState(page);
  report('configurator: then the bill', s.bill, JSON.stringify(s));
  await finish('configurator', page, errors);
}
{
  // A clock that thinks it is open, against a Paddock that knows better.
  const refusal = 'Pre-booking opens 12 October, 12 PM IST.';
  const { page, errors } = await open('powerpod-gen2.html?check&launch=60', {
    viewport: VIEWPORTS.phone,
    ignore: /status of 409/,
    before: async (p) => {
      await p.setRequestInterception(true);
      p.on('request', (r) => {
        if (/\/api\/public\/website\/orders$/.test(r.url())) {
          if (r.method() === 'OPTIONS') {
            r.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' } });
          } else {
            r.respond({
              status: 409,
              contentType: 'application/json',
              headers: { 'access-control-allow-origin': '*' },
              body: JSON.stringify({ success: false, error: refusal, code: 'not_open', opensAt: '2026-10-12T06:30:00.000Z' }),
            });
          }
        } else if (/recaptcha|gstatic/.test(r.url())) {
          r.abort();
        } else {
          r.continue();
        }
      });
    },
  });
  await toPayment(page);
  await page.click('#pg2-reserve');
  await wait(300);
  await page.click('#pg2-next');
  const shown = await until(page, (text) => document.getElementById('pg2-status').textContent === text, 15000, refusal);
  const s = await payState(page);
  report("configurator: Paddock's refusal reads as sent", shown >= 0, s.status);
  await finish('configurator refusal', page, errors);
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nlaunch: all checks passed');
process.exitCode = failed ? 1 : 0;
