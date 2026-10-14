#!/usr/bin/env node
/*
 * The Gen2 page at every screen size: the footer, the first step and the review fit, with
 * nothing overlapping, clipped, running off screen or wrapping where it should not.
 *
 *   node tools/check/gen2-fit.mjs [--root dir] [--only 390x844,1025x768] [--lang hi]
 *
 * --lang walks the page in that language (/hi/powerpod-gen2.html), expecting each line as its
 * catalogue says it (tools/i18n.mjs translator): the same rules, in every language.
 *
 * Every size walks the real flow, against the Paddock mock with Razorpay stood in for (as
 * purchase.mjs does), and is measured at each stop:
 *   s1-top        the configurator as it opens: no heading over the PowerPod card
 *   s1-pod        Just the PowerPod, at the review: Starts at ₹29,999, the finance note under it
 *   s1-x3         a Komaki X3, at the review: Starts at ₹69,999
 *   s2            the details: Pre-book at ₹399 (Fully refundable), Continue
 *   s2-hint       Continue with the details blank: the footer's hint row as well
 *   s2-keys       an on-screen keyboard (touch sizes only): the panel above the keys, the
 *                 field being typed in visible; where the panel is too short for the
 *                 header, the footer and a field (a phone on its side, the smallest
 *                 phones with large text) the header and the footer step aside for it
 *   s3            the payment page: + ₹9.89 (Platform fee), Pay ₹408.89
 *   s3-confirming the webhook awaited: already Paid ₹408.89, the button gone
 *   paid          Paid ₹408.89
 * and across the stops: the footer keeps one height (the button going after payment
 * included) and the button one width from Continue to Pay. The phones, tablets and desktops
 * are walked at 100% text; a few sizes again at 125% and 150% text, and with reduced motion.
 *
 * Screenshots, and contact sheets of them (the whole screen, and the footer up close), land
 * in tools/check/out/gen2-fit/. A problem prints FAIL with the size, the stop and what was
 * wrong, and the run exits 1.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { startMock } from './paddock-mock.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';
import { translator } from '../i18n.mjs';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const root = path.resolve(arg('--root') || '.');
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const LANG = arg('--lang') || 'en';
const T = translator(LANG, 'powerpod-gen2.html');
const PAGE_PATH = LANG === 'en' ? '/powerpod-gen2.html' : `/${LANG}/powerpod-gen2.html`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', LANG === 'en' ? 'gen2-fit' : `gen2-fit-${LANG}`);
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

// ---------------------------------------------------------------- sizes
const phone = (width, height) => ({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const desk = (width, height) => ({ width, height, deviceScaleFactor: 1 });
const SIZES = [
  // Phones, portrait. 280 and 344 are the Galaxy Fold covers.
  ['phones', phone(280, 653)], ['phones', phone(320, 568)], ['phones', phone(344, 882)],
  ['phones', phone(359, 740)], ['phones', phone(360, 640)], ['phones', phone(360, 780)],
  ['phones', phone(375, 667)], ['phones', phone(375, 812)], ['phones', phone(390, 844)],
  ['phones', phone(393, 852)], ['phones', phone(402, 874)], ['phones', phone(412, 915)],
  ['phones', phone(430, 932)], ['phones', phone(440, 956)],
  // Phones on their side, and the tablets (673 is the Fold open).
  ['wide', phone(568, 320)], ['wide', phone(667, 375)], ['wide', phone(844, 390)], ['wide', phone(932, 430)],
  ['wide', phone(673, 841)], ['wide', phone(744, 1133)], ['wide', phone(759, 1000)], ['wide', phone(760, 1000)],
  ['wide', phone(768, 1024)], ['wide', phone(810, 1080)], ['wide', phone(820, 1180)], ['wide', phone(834, 1194)],
  ['wide', phone(1024, 1366)], ['wide', phone(1180, 820)], ['wide', phone(1366, 1024)],
  // Laptops and desktops. 1024 is the last stacked width, 1025 the first split.
  ['desktops', desk(1024, 768)], ['desktops', desk(1025, 768)], ['desktops', desk(1100, 800)],
  ['desktops', desk(1280, 800)], ['desktops', desk(1366, 768)], ['desktops', desk(1440, 900)],
  ['desktops', desk(1536, 864)], ['desktops', desk(1920, 1080)], ['desktops', desk(2560, 1440)],
];
const RUNS = SIZES.map(([group, viewport]) => ({ group, viewport, text: 100, motion: 'full' }));
for (const text of [125, 150]) {
  for (const viewport of [phone(320, 568), phone(360, 780), phone(390, 844), desk(1025, 768), desk(1440, 900)]) {
    RUNS.push({ group: 'text', viewport, text, motion: 'full' });
  }
}
for (const viewport of [phone(390, 844), desk(1440, 900)]) RUNS.push({ group: 'motion', viewport, text: 100, motion: 'reduce' });

const nameOf = (run) => `${run.viewport.width}x${run.viewport.height}${run.text !== 100 ? `@${run.text}` : ''}${run.motion === 'reduce' ? '-still' : ''}`;
const runs = RUNS.filter((run) => !only || only.has(nameOf(run)) || only.has(`${run.viewport.width}x${run.viewport.height}`));

// ---------------------------------------------------------------- what each stop must say
const BEFORE = { label: T('Pre-book at'), amount: '₹399', note: T('(Fully refundable)'), next: T('Continue') };
const EXPECT = {
  's1-top': BEFORE,
  's1-pod': BEFORE,
  's1-x3': BEFORE,
  s2: BEFORE,
  's2-hint': BEFORE,
  's2-keys': BEFORE,
  s3: { label: T('Pre-book at'), amount: '₹399', note: `+ ₹9.89 ${T('(Platform fee)')}`, next: T('Pay {amount}', { amount: '₹408.89' }) },
  's3-confirming': { label: T('Paid'), amount: '₹408.89', note: T('{amount} comes off your final payment', { amount: '₹399' }), next: null },
  paid: { label: T('Paid'), amount: '₹408.89', note: T('{amount} comes off your final payment', { amount: '₹399' }), next: null },
};
const STOPS = Object.keys(EXPECT);
// The page's own lines the stops read, in the language walked.
const SAID = {
  lang: LANG,
  startsAt: T('Starts at'),
  finance: T('Finance options available at the time of purchase.'),
  paySub: T('₹399 today plus the platform fee, charged by GridX Energy. The rest only when your order is ready for shipment.'),
};
// The card that says the money is in and the pre-booking is being confirmed.
const PENDING = T('Payment received. We are confirming your pre-booking.');

// ---------------------------------------------------------------- the measure
/**
 * Runs in the page. Everything that can go wrong with the footer and the parts of the panel
 * this change touched, as a list of sentences, plus the figures compared across stops.
 * keysAt: the top of an on-screen keyboard, when one is being stood in for. text: the text
 * size in percent.
 */
function measure(stop, keysAt, text, expected) {
  const E = 0.5;
  const problems = [];
  const $ = (sel) => document.querySelector(sel);
  const rect = (el) => el.getBoundingClientRect();
  const shown = (el) => Boolean(el) && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const inside = (a, b) => a.left >= b.left - E && a.right <= b.right + E && a.top >= b.top - E && a.bottom <= b.bottom + E;
  const meet = (a, b) => a.left < b.right - E && b.left < a.right - E && a.top < b.bottom - E && b.top < a.bottom - E;
  const tag = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].join('.')}` : ''}`;
  // Lines of text in an element: the distinct tops of its text's boxes.
  const lines = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top));
    return new Set(tops.map((t) => tops.find((u) => Math.abs(u - t) <= 3))).size;
  };

  const foot = $('.pg2__foot');
  const money = $('.pg2-foot__money');
  const label = $('#pg2-total-label');
  const amount = $('#pg2-total');
  const note = $('#pg2-foot-note');
  const next = $('#pg2-next');
  const nextLabel = $('#pg2-next-label');
  const hint = $('#pg2-hint');
  const scroll = $('#pg2-scroll');

  // The page.
  const doc = document.documentElement;
  if (doc.scrollWidth > innerWidth + E) problems.push(`the page scrolls sideways (${doc.scrollWidth}px in ${innerWidth}px)`);
  const bottom = keysAt || innerHeight;
  const panel = rect(scroll);

  // With a keyboard up, the field being typed in is in view above it.
  if (stop === 's2-keys') {
    const field = document.activeElement;
    if (!field || !field.matches('.field__input')) problems.push('no field has the focus');
    else {
      const r = rect(field);
      if (r.top < panel.top - E || r.bottom > Math.min(panel.bottom, bottom) + E) {
        problems.push(`the field being typed in is out of view (${Math.round(r.top)} to ${Math.round(r.bottom)}, visible ${Math.round(panel.top)} to ${Math.round(Math.min(panel.bottom, bottom))})`);
      }
    }
    if (panel.bottom > bottom + E) problems.push('the content runs under the keyboard');
  }

  // The footer steps aside only for a keyboard, and only where the panel above it is shorter
  // than 17.5rem (the stylesheet's typing section). Everywhere else it is there.
  if (!shown(foot)) {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const short = rect($('#pg2-panel')).height <= 17.5 * rem + E;
    if (!(stop === 's2-keys' && short)) problems.push('the footer is not showing');
    return { problems, said: null, footH: 0, buttonW: null, stacked: false, foot: null };
  }

  // The footer, on screen and under the content, never over it.
  const f = rect(foot);
  const cs = getComputedStyle(foot);
  const box = {
    left: f.left + parseFloat(cs.paddingLeft), right: f.right - parseFloat(cs.paddingRight),
    top: f.top + parseFloat(cs.paddingTop) - E, bottom: f.bottom - parseFloat(cs.paddingBottom) + E,
  };
  if (f.top < -E || f.bottom > bottom + E) problems.push(`the footer is off screen (${Math.round(f.top)} to ${Math.round(f.bottom)} of ${bottom})`);
  if (rect(scroll).bottom > f.top + E) problems.push(`the content runs under the footer by ${Math.round(rect(scroll).bottom - f.top)}px`);

  // Its parts: inside it, clear of one another, nothing clipped, each on one line.
  const m = rect(money);
  if (!inside(m, box)) problems.push('the money is outside the footer');
  const button = shown(next) ? rect(next) : null;
  if (button) {
    if (!inside(button, box)) problems.push('the button is outside the footer');
    if (meet(m, button)) problems.push('the money and the button overlap');
    if (!inside(rect(nextLabel), button)) problems.push('the button\'s words spill out of it');
    if (lines(nextLabel) !== 1) problems.push(`the button's words take ${lines(nextLabel)} lines`);
  }
  if (shown(hint) && hint.textContent.trim()) {
    const h = rect(hint);
    if (!inside(h, box)) problems.push('the hint is outside the footer');
    if (meet(h, m) || (button && meet(h, button))) problems.push('the hint overlaps the money or the button');
  }
  for (const el of foot.querySelectorAll('*')) {
    if (!shown(el) || getComputedStyle(el).display === 'inline') continue;
    if (el.scrollWidth > el.clientWidth + 1) problems.push(`${tag(el)} is clipped (${el.scrollWidth}px in ${el.clientWidth}px)`);
  }
  // One line each. The one exception: after payment, with large text, the note is a
  // sentence with the whole footer to itself, and two lines of it read better than smaller type.
  const settled = stop === 'paid' || stop === 's3-confirming';
  for (const el of [label, amount, note]) {
    const most = el === note && settled && text > 100 ? 2 : 1;
    if (lines(el) > most) problems.push(`"${el.textContent}" takes ${lines(el)} lines`);
  }
  const l = rect(label);
  const a = rect(amount);
  if (!(l.top < a.bottom && a.top < l.bottom)) problems.push('the amount has dropped under its label');

  // What it says.
  const said = {
    label: label.textContent.trim(),
    amount: amount.textContent.trim(),
    note: note.textContent.trim(),
    next: button ? nextLabel.textContent.trim() : null,
  };

  // The stops' own parts.
  if (stop === 's1-top') {
    const pod = $('#step-pod');
    if (pod.querySelector('.pg2-step__title, .pg2-step__sub')) problems.push('step 1 still has a heading');
    if (expected.lang === 'en' && /Power, reimagined/.test(document.body.textContent)) problems.push('"Power, reimagined." is still on the page');
    const card = rect(pod.querySelector('.opt--locked'));
    if (card.top < panel.top - E) problems.push('the PowerPod card starts under the panel\'s header');
    if (card.top > panel.bottom) problems.push('the PowerPod card is not in view');
    if (card.left < panel.left - E || card.right > panel.right + E) problems.push('the PowerPod card is wider than the panel');
  }
  if (stop === 's1-pod' || stop === 's1-x3') {
    const list = $('#pg2-review');
    const last = list.lastElementChild;
    const want = stop === 's1-pod' ? '₹29,999' : '₹69,999';
    if (!last || last.textContent !== `${expected.startsAt}${want}`) problems.push(`the review ends "${last && last.textContent}", not ${expected.startsAt} ${want}`);
    const fin = list.nextElementSibling;
    if (!fin || fin.id !== 'pg2-finance' || fin.textContent.replace(/\s+/g, ' ').trim() !== expected.finance) {
      problems.push('the finance note is not right under the review');
    } else {
      const r = rect(fin);
      if (r.left < panel.left - E || r.right > panel.right + E) problems.push('the finance note is wider than the panel');
      if (r.top < panel.top - E || r.bottom > panel.bottom + E) problems.push('the finance note is not in view');
      if (r.top < rect(last).bottom - E) problems.push('the finance note overlaps the Starts at row');
    }
  }
  if (stop === 's3') {
    const sub = $('#pg2-pay-sub').textContent;
    if (sub.replace(/\s+/g, ' ').trim() !== expected.paySub) {
      problems.push(`the payment page's line says "${sub}"`);
    }
  }

  return {
    problems,
    said,
    footH: f.height,
    buttonW: button ? button.width : null,
    stacked: Boolean(button) && button.top >= m.bottom - E,
    foot: { left: f.left, top: f.top, width: f.width, height: f.height },
  };
}

// ---------------------------------------------------------------- the walk
const server = await serve({ root, port: PORT, quiet: true });
const mock = await startMock({ port: MOCK_PORT, quiet: true });
// Four pages run at once, and a page that is not in front would otherwise have its timers,
// transitions and smooth scrolls held back, and be photographed mid-move.
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [...CHROME_ARGS, '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  protocolTimeout: 300000,
});

let failed = 0;
const results = [];

// The mock gives every Gen2 order the same reference and counts its confirmation polls by
// reference, so two payments at once would share one count and one of them would be paid on
// its first poll. Payments take turns; everything before them runs four at a time.
let payTurn = Promise.resolve();
const oneAtATime = (fn) => {
  const turn = payTurn.then(fn);
  payTurn = turn.catch(() => {});
  return turn;
};

async function open(run) {
  const page = await browser.newPage();
  await page.setViewport(run.viewport);
  if (run.motion === 'reduce') await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = req.url();
    if (/^https:\/\/(www\.(google|gstatic)\.com\/recaptcha|checkout\.razorpay\.com)\//.test(url)) { req.abort(); return; }
    if (!url.startsWith(`${PADDOCK}/`)) { req.continue(); return; }
    const cors = { 'Access-Control-Allow-Origin': SITE, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    try {
      if (req.method() === 'OPTIONS') { await req.respond({ status: 204, headers: cors }); return; }
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
  await page.evaluateOnNewDocument((text) => {
    // Razorpay's window cannot open headless: the stand-in reports a payment, as the real one does.
    window.Razorpay = class {
      constructor(options) { this.options = options; }
      on() {}
      open() { setTimeout(() => this.options.handler({ razorpay_payment_id: 'pay_mock1' }), 400); }
    };
    // Large text in the browser's settings: the root size, which every rem follows.
    if (text !== 100) document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${text}%`; });
  }, run.text);
  await page.goto(`${SITE}${PAGE_PATH}?check&launch=60`, { waitUntil: 'load' });
  return { page, errors };
}

async function walk(run) {
  const name = nameOf(run);
  const { page, errors } = await open(run);
  const seen = {};
  const at = async (stop, keysAt = 0, settle = 900) => {
    await sleep(run.motion === 'reduce' ? Math.min(settle, 450) : settle);
    const got = await page.evaluate(measure, stop, keysAt, run.text, SAID);
    const file = `${name}--${stop}.jpg`;
    await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 88 });
    const want = EXPECT[stop];
    for (const key of got.said ? ['label', 'amount', 'note', 'next'] : []) {
      if (got.said[key] !== want[key]) got.problems.push(`the footer's ${key} is "${got.said[key]}", not "${want[key]}"`);
    }
    seen[stop] = { ...got, file };
  };
  const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
  const reveal = (sel) => page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }), sel);

  await at('s1-top');
  await click('input[name="vehicle"][value="no"]');
  await sleep(700);
  await reveal('#pg2-finance');
  await at('s1-pod');
  await click('input[name="vehicle"][value="yes"]');
  await sleep(400);
  await click('input[name="model"][value="x3"]');
  await sleep(700);
  await reveal('#pg2-finance');
  await at('s1-x3');

  await click('#pg2-next');
  await at('s2');
  await click('#pg2-next');
  await at('s2-hint');
  if (run.viewport.hasTouch) {
    // An on-screen keyboard over the lower 42% of the window, the way assets/keyboard.js
    // reports one: is-typing, and the visible area as --vv-top and --vv-h.
    // Typing in the email field, halfway down the form, which keyboard.js scrolls into view.
    const keysAt = await page.evaluate(() => {
      const top = Math.round(innerHeight * 0.58);
      const field = document.getElementById('f-email');
      field.focus({ preventScroll: true });
      document.documentElement.classList.add('is-typing');
      const shell = document.querySelector('.pg2');
      shell.style.setProperty('--vv-top', '0px');
      shell.style.setProperty('--vv-h', `${top}px`);
      return top;
    });
    await sleep(100);
    await page.evaluate(() => document.getElementById('f-email').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await at('s2-keys', keysAt);
    await page.evaluate(() => {
      document.documentElement.classList.remove('is-typing');
      const shell = document.querySelector('.pg2');
      shell.style.removeProperty('--vv-top');
      shell.style.removeProperty('--vv-h');
    });
  }
  for (const [sel, value] of [
    ['#f-name', 'Asha Verma'], ['#f-phone', '9876543210'], ['#f-email', 'asha@example.com'],
    ['#f-city', 'Raipur'], ['#f-pin', '492001'],
  ]) {
    await page.evaluate((s, v) => {
      const input = document.querySelector(s);
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, sel, value);
  }
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await click('#pg2-next');
  await at('s3');

  const pending = await oneAtATime(async () => {
    await click('#pg2-next');
    // The pending card, measured as soon as the footer's fade has run: the mock's webhook
    // lands on the third poll, a few seconds on.
    // In the language walked, as everywhere else in this check.
    const shown = await page.waitForFunction(
      (words) => (document.querySelector('.pg2-done__status')?.textContent || '').includes(words),
      // On an interval: frames are throttled in a tab that is not in front.
      { timeout: 10000, polling: 50 },
      PENDING,
    ).then(() => true).catch(() => false);
    if (shown) await at('s3-confirming', 0, 300);
    await page.waitForFunction(() => document.querySelector('.pay-tick:not(.pay-tick--pending)'), { timeout: 20000, polling: 50 }).catch(() => {});
    return shown;
  });
  await at('paid');

  // Across the stops: one footer height and one button width, Continue to Pay. Stacked, the
  // button is a row of its own, and its going after payment takes the row with it.
  const stackedRun = Boolean(seen.s3 && seen.s3.stacked);
  const steady = ['s1-top', 's1-pod', 's1-x3', 's2', 's3', ...(stackedRun ? [] : ['s3-confirming', 'paid'])].filter((s) => seen[s]);
  const heights = steady.map((s) => seen[s].footH);
  const widths = ['s1-top', 's2', 's3'].map((s) => seen[s].buttonW);
  const across = [];
  if (Math.max(...heights) - Math.min(...heights) > 0.5) across.push(`the footer changes height between stops (${heights.map((h) => h.toFixed(1)).join(', ')})`);
  if (Math.max(...widths) - Math.min(...widths) > 0.5) across.push(`the button changes width from Continue to Pay (${widths.map((w) => w.toFixed(1)).join(', ')})`);

  const errs = [...new Set(errors)];
  const problems = [
    ...STOPS.filter((s) => seen[s]).flatMap((s) => seen[s].problems.map((p) => `${s}: ${p}`)),
    ...across,
    ...errs.map((e) => `page error: ${e}`),
  ];
  if (!pending) problems.push('s3-confirming: the pending card never showed');
  if (problems.length) failed++;
  const stacked = stackedRun ? ', stacked' : '';
  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${name.padEnd(17)} footer ${heights[0].toFixed(0)}px, button ${widths[0].toFixed(0)}px${stacked}`
    + `${problems.length ? `\n        ${problems.join('\n        ')}` : ''}`);
  results.push({ run, name, seen, problems });
  await page.close();
}

// Four at a time: each page runs the particle field and the pod, and more than that in one
// headless Chrome starts to starve their frames.
const queue = [...runs];
await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
  while (queue.length) {
    const run = queue.shift();
    try {
      await walk(run);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${nameOf(run)}: the walk broke: ${e.message}`);
    }
  }
}));

// ---------------------------------------------------------------- contact sheets
// One page of screenshots per group and stop, and one of just the footers, at twice their
// size, so the type and its spacing can be read side by side across every size.
const ORDER = new Map(runs.map((run, i) => [nameOf(run), i]));
results.sort((a, b) => ORDER.get(a.name) - ORDER.get(b.name));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sheet = async (file, title, tiles) => {
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>
    body { margin: 0; padding: 24px; background: #e9e9e7; font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #222; }
    h1 { margin: 0 0 16px; font-size: 18px; }
    .grid { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
    figure { margin: 0; }
    figcaption { margin-top: 6px; }
    .bad figcaption { color: #b3261e; font-weight: 600; }
    .crop { position: relative; overflow: hidden; outline: 1px solid rgb(0 0 0 / 0.15); background: #fff; }
    .crop img { position: absolute; display: block; }
    .whole img { display: block; height: 520px; outline: 1px solid rgb(0 0 0 / 0.15); }
  </style><h1>${esc(title)}</h1><div class="grid">${tiles.join('')}</div>`;
  const htmlPath = path.join(OUT, `${file}.html`);
  fs.writeFileSync(htmlPath, html);
  const page = await browser.newPage();
  await page.setViewport({ width: 1800, height: 1000, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(OUT, `${file}.png`), fullPage: true });
  await page.close();
};
const caption = (r, stop) => `${esc(r.name)}${r.seen[stop].problems.length ? ' (problem)' : ''}`;
for (const group of [...new Set(results.map((r) => r.run.group))]) {
  const rows = results.filter((r) => r.run.group === group);
  for (const stop of STOPS) {
    const have = rows.filter((r) => r.seen[stop]);
    if (!have.length) continue;
    await sheet(`sheet-${group}-${stop}`, `${group}, ${stop}`, have.map((r) => `<figure class="whole${r.seen[stop].problems.length ? ' bad' : ''}">`
      + `<img src="${esc(r.seen[stop].file)}"><figcaption>${caption(r, stop)}</figcaption></figure>`));
  }
  // The footers alone, at 2x: one tile per size and stop that has a footer worth reading.
  const footTiles = [];
  for (const r of rows) {
    for (const stop of ['s2', 's2-hint', 's3', 's3-confirming', 'paid']) {
      const got = r.seen[stop];
      if (!got || !got.foot) continue;
      const k = 2;
      const { left, top, width, height } = got.foot;
      footTiles.push(`<figure class="${got.problems.length ? 'bad' : ''}"><div class="crop" style="width:${width * k}px;height:${height * k}px">`
        + `<img src="${esc(got.file)}" style="width:${r.run.viewport.width * k}px;left:${-left * k}px;top:${-top * k}px"></div>`
        + `<figcaption>${caption(r, stop)}, ${stop}</figcaption></figure>`);
    }
  }
  await sheet(`sheet-${group}-footers`, `${group}, footers at 2x`, footTiles);
}

await browser.close();
server.close();
await mock.close?.();
console.log(`\n${runs.length} sizes walked, ${failed} with problems. Screenshots and sheets: ${path.relative(process.cwd(), OUT)}/`);
process.exitCode = failed ? 1 : 0;
