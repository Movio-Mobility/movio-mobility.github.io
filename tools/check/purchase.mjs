#!/usr/bin/env node
/*
 * The accessory purchase flow end to end, in headless Chrome, against the working copy
 * (tools/serve.mjs) and the Paddock mock (tools/check/paddock-mock.mjs).
 *
 *   node tools/check/purchase.mjs [--root dir] [--keep]
 *
 * The pages talk to http://localhost:3000; as in support.mjs, the mock runs on a port of
 * its own and this file answers the page's requests to :3000 from it. Razorpay's window
 * cannot open headless, so window.Razorpay is stood in for before each page loads: a class
 * whose open() calls options.handler after a moment, which is exactly the signal the page
 * gets when a real payment goes through.
 *
 * On adapter.html, at 390x844 and again at 1440x900 (a screenshot of every stage lands in
 * tools/check/out/):
 *   - stage 1: quantity to 2, Continue advances to the details view
 *   - stage 2: the details, street address included, Continue advances to the bill
 *   - stage 3: the bill's rows and the Pay button's exact amount (catalogue arithmetic)
 *   - Pay: the pending ring and copy, then (the mock's webhook landing on the third poll)
 *     the drawn tick, the confirmed order, GX-MOCKAA1 in sessionStorage for the tracker
 * Then the payment leg again on powerpod-gen2.html (?check&launch=60, so pre-booking is
 * open): a Komaki X3 chosen with the footer still Pre-book at ₹399 and Continue, the payment
 * page naming it, the hold, the platform fee beside it and the balance, Pay naming exactly
 * what Razorpay is asked for, then Gen2's own pending line and nouns with the footer Paid; and once more on adapter.html with the
 * mock's confirm mode 'slow' and a 6 second deadline (?check&confirm=6), which must end in
 * the calm "we are checking" card, never a failure.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { startMock } from './paddock-mock.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--root');
const root = path.resolve(i >= 0 ? args[i + 1] : '.');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
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

const server = await serve({ root, port: PORT, quiet: true });
const mock = await startMock({ port: MOCK_PORT, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { width: 1440, height: 900, deviceScaleFactor: 1 };

const setModes = (modes) => fetch(`${mock.url}/__mock/state`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modes }),
});

/** A page whose calls to Paddock are answered by the mock, with Razorpay stood in for. */
async function open(name, { viewport = PHONE } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = req.url();
    // Neither Google nor Razorpay is part of what is being checked, and neither answers
    // sensibly from CI anyway. Blocked, the page does what it does behind an ad blocker.
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
  // The page only ever hands Razorpay an order and waits for its handler; this stand-in
  // answers the same way a successful payment does, a moment later.
  await page.evaluateOnNewDocument(() => {
    window.Razorpay = class {
      constructor(options) { this.options = options; window.__razorpayAsked = options.amount; }
      on() {}
      open() { setTimeout(() => this.options.handler({ razorpay_payment_id: 'pay_mock1' }), 400); }
    };
  });
  await page.goto(`${SITE}/${name}`, { waitUntil: 'load' });
  return { page, errors };
}

const shoot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

const activeStage = (page) => page.evaluate(() => {
  const view = document.querySelector('.pg2-view.is-active');
  return view ? Number(view.dataset.stage) : 0;
});

/** Stage 1 and 2 of the adapter flow: quantity to 2, then the details. */
async function driveToBill(page, label, { screenshots = true } = {}) {
  await sleep(600);
  if (screenshots) await shoot(page, `purchase-${label}-1-product`);
  await page.evaluate(() => document.querySelector('.qty-row .stepper__btn[data-step="1"]').click());
  const qty = await page.evaluate(() => document.getElementById('product-qty').value);
  await page.evaluate(() => document.getElementById('product-buy').click());
  await sleep(600);
  report(`${label}: quantity steps to 2 and Continue opens the details`, qty === '2' && (await activeStage(page)) === 2);

  for (const [sel, value] of [
    ['#af-name', 'Asha Verma'], ['#af-phone', '9876543210'], ['#af-email', 'asha@example.com'],
    ['#af-address', '12 Lake View Road'], ['#af-city', 'Raipur'], ['#af-pin', '492001'],
  ]) {
    await page.type(sel, value);
  }
  if (screenshots) await shoot(page, `purchase-${label}-2-details`);
  await page.evaluate(() => document.getElementById('product-buy').click());
  await sleep(600);
  report(`${label}: a complete form continues to the bill`, (await activeStage(page)) === 3);

  const bill = await page.evaluate(() => {
    const c = window.gridCatalogue;
    const items = c.priceOf('adapter') * 2;
    return {
      labels: [...document.querySelectorAll('#af-bill .bill__label')].map((e) => e.textContent),
      values: [...document.querySelectorAll('#af-bill .bill__value')].map((e) => e.textContent),
      total: document.querySelector('#af-bill .bill__row--total .bill__value')?.textContent,
      pay: document.getElementById('af-next-label').textContent,
      wantTotal: c.money(c.grossUp(items)),
      wantItems: c.money(items),
    };
  });
  report(`${label}: the bill says what the order is and what is paid now`,
    bill.labels.join('|') === 'Adapter x 2|Items incl. GST|Processing fee|Total payable'
    && bill.values[0] === bill.wantItems && bill.total === bill.wantTotal,
    `${bill.labels.join(', ')} / ${bill.values.join(', ')}`);
  report(`${label}: Pay names the exact amount`, bill.pay === `Pay ${bill.wantTotal}`, bill.pay);
  if (screenshots) await shoot(page, `purchase-${label}-3-bill`);
}

const pendingState = (page) => page.evaluate(() => ({
  title: document.querySelector('.pg2-done__title')?.textContent,
  line: document.querySelector('.pg2-done__status')?.textContent,
  spinning: Boolean(document.querySelector('.pay-tick--pending')),
  billHidden: !document.getElementById('af-bill') || Boolean(document.getElementById('af-bill').closest('[hidden]')),
}));

// ================================================================ the happy path, phone and desk
for (const [label, viewport] of [['phone', PHONE], ['desk', DESK]]) {
  await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
  const { page, errors } = await open('adapter.html', { viewport });
  await driveToBill(page, label);

  await page.evaluate(() => document.getElementById('product-buy').click());
  await page.waitForFunction(
    () => document.querySelector('.pg2-done__title')?.textContent === 'Confirming your payment.',
    { timeout: 8000 },
  ).catch(() => {});
  const pending = await pendingState(page);
  report(`${label}: Razorpay's handler lands on the pending ring, never a claim`,
    pending.title === 'Confirming your payment.' && pending.spinning && pending.billHidden
    && pending.line === 'This usually takes a few seconds. Please keep this page open.',
    JSON.stringify(pending));
  await shoot(page, `purchase-${label}-4-pending`);

  // The mock's webhook lands on the third poll (about five seconds in).
  await page.waitForFunction(
    () => document.querySelector('.pay-tick:not(.pay-tick--pending)') && document.querySelector('.pg2-done__title')?.textContent === 'You are all set.',
    { timeout: 20000 },
  ).catch(() => {});
  const done = await page.evaluate(() => ({
    title: document.querySelector('.pg2-done__title')?.textContent,
    tick: Boolean(document.querySelector('svg.pay-tick:not(.pay-tick--pending):not(.pay-tick--wait)')),
    body: document.querySelector('.pg2-done__body')?.textContent || '',
    ref: document.getElementById('af-done-ref')?.textContent,
    track: document.querySelector('.pg2-done__link[href="support.html#track"]')?.offsetParent !== null,
    stored: sessionStorage.getItem('gridx.lastOrder'),
    foot: document.getElementById('product-total-label')?.textContent,
  }));
  report(`${label}: the webhook's word draws the tick and confirms the order`,
    done.title === 'You are all set.' && done.tick && /order is confirmed/.test(done.body)
    && /tax invoice/.test(done.body) && /asha@example\.com/.test(done.body) && done.ref === 'GX-MOCKAA1',
    JSON.stringify({ title: done.title, tick: done.tick, ref: done.ref }));
  report(`${label}: the tracking link is up and the reference is kept for it`,
    done.track && done.stored === 'GX-MOCKAA1' && done.foot === 'Paid', JSON.stringify({ track: done.track, stored: done.stored, foot: done.foot }));
  await sleep(1600); // let the tick finish drawing before the picture is taken
  await shoot(page, `purchase-${label}-5-done`);
  report(`${label}: no page errors`, errors.length === 0, errors.join(' | '));
  await page.close();
}

// ================================================================ the same leg on Gen2
{
  await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
  const { page, errors } = await open('powerpod-gen2.html?check&launch=60');
  await sleep(800);
  for (const [name, value] of [['vehicle', 'yes'], ['model', 'x3']]) {
    await page.evaluate(([n, v]) => document.querySelector(`input[name="${n}"][value="${v}"]`).click(), [name, value]);
    await sleep(150);
  }
  const foot = await page.evaluate(() => ({
    label: document.getElementById('pg2-total-label').textContent,
    amount: document.getElementById('pg2-total').textContent,
    note: document.getElementById('pg2-foot-note').textContent,
    next: document.getElementById('pg2-next-label').textContent,
    startsAt: document.querySelector('#pg2-review li:last-child')?.textContent,
  }));
  report('gen2: with the Komaki X3 chosen the footer still says Pre-book at ₹399, the review the price',
    foot.label === 'Pre-book at' && foot.amount === '₹399' && foot.note === '(Fully refundable)' && foot.next === 'Continue'
    && foot.startsAt === 'Starts at₹69,999',
    JSON.stringify(foot));
  await page.evaluate(() => document.getElementById('pg2-next').click());
  await sleep(600);
  for (const [sel, value] of [
    ['#f-name', 'Asha Verma'], ['#f-phone', '9876543210'], ['#f-email', 'asha@example.com'],
    ['#f-city', 'Raipur'], ['#f-pin', '492001'],
  ]) {
    await page.type(sel, value);
  }
  await page.evaluate(() => document.getElementById('pg2-next').click());
  await sleep(600);
  const billed = await page.evaluate(() => ({
    title: document.getElementById('pg2-pay-title').textContent,
    text: document.getElementById('pg2-bill').textContent,
    label: document.getElementById('pg2-total-label').textContent,
    amount: document.getElementById('pg2-total').textContent,
    fee: document.getElementById('pg2-foot-note').textContent,
    next: document.getElementById('pg2-next-label').textContent,
    sub: document.getElementById('pg2-pay-sub').textContent,
  }));
  report('gen2: the payment page names the Komaki, the hold, the fee and the balance',
    billed.title === 'Pre-book your PowerPod Gen2 with Komaki X3.' && /Komaki X3/.test(billed.text)
    && /Pre-booking amount/.test(billed.text) && /₹399/.test(billed.text) && /from ₹69,600/.test(billed.text)
    && /Total payable now₹408\.89/.test(billed.text) && /fully refundable/i.test(billed.text) && /not refunded/.test(billed.text)
    && billed.label === 'Pre-book at' && billed.amount === '₹399' && billed.fee === '+ ₹9.89 (Platform fee)'
    && billed.next === 'Pay ₹408.89' && /^₹399 today plus the platform fee, charged by GridX Energy\./.test(billed.sub),
    JSON.stringify(billed).slice(0, 400));
  await shoot(page, 'purchase-gen2-bill');
  await page.evaluate(() => document.getElementById('pg2-next').click());
  // The figure on the button is the figure Razorpay was asked for, which is Paddock's.
  await page.waitForFunction(() => window.__razorpayAsked !== undefined, { timeout: 8000 }).catch(() => {});
  const asked = await page.evaluate(() => window.__razorpayAsked);
  report('gen2: Pay ₹408.89 is exactly what Razorpay is asked for', asked === 40889, `amount ${asked} paise`);

  await page.waitForFunction(
    () => document.querySelector('.pg2-done__status')?.textContent.includes('confirming your pre-booking'),
    { timeout: 8000 },
  ).catch(() => {});
  const pending = await page.evaluate(() => ({
    title: document.querySelector('.pg2-done__title')?.textContent,
    line: document.querySelector('.pg2-done__status')?.textContent,
    spinning: Boolean(document.querySelector('.pay-tick--pending')),
    foot: document.getElementById('pg2-next-label')?.textContent,
    paid: `${document.getElementById('pg2-total-label').textContent} ${document.getElementById('pg2-total').textContent}`,
  }));
  report('gen2: the pending card says the pre-booking is being confirmed, the footer that it is paid',
    pending.title === 'Confirming your payment.' && pending.spinning
    && pending.line === 'Payment received. We are confirming your pre-booking.' && pending.foot === 'Confirming'
    && pending.paid === 'Paid ₹408.89',
    JSON.stringify(pending));
  await shoot(page, 'purchase-gen2-pending');

  await page.waitForFunction(
    () => document.querySelector('.pay-tick:not(.pay-tick--pending)') && document.querySelector('.pg2-done__title')?.textContent === 'You are all set.',
    { timeout: 20000 },
  ).catch(() => {});
  const done = await page.evaluate(() => ({
    title: document.querySelector('.pg2-done__title')?.textContent,
    body: document.querySelector('.pg2-done__body')?.textContent || '',
    ref: document.getElementById('pg2-done-ref')?.textContent,
    track: Boolean(document.querySelector('.pg2-done__link[href="support.html#track"]:not([hidden])')),
    stored: sessionStorage.getItem('gridx.lastOrder'),
  }));
  report('gen2: the confirmed card speaks in pre-booking and receipt voucher',
    done.title === 'You are all set.' && /pre-booking is confirmed/.test(done.body)
    && /receipt voucher/.test(done.body) && done.ref === 'GX-MOCKPP1' && done.track && done.stored === 'GX-MOCKPP1',
    JSON.stringify({ ref: done.ref, track: done.track, stored: done.stored }));
  await sleep(1600); // let the tick finish drawing before the picture is taken
  await shoot(page, 'purchase-gen2-done');
  report('gen2: no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ================================================================ the webhook outruns the wait
{
  await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
  await setModes({ confirm: 'slow' });
  // ?check&confirm=6 shortens pay-confirm.js's 60s deadline to 6s, the way launch.js takes
  // &launch under ?check, so this leg does not hold the whole run for a minute.
  const { page, errors } = await open('adapter.html?check&confirm=6');
  await driveToBill(page, 'timeout', { screenshots: false });
  await page.evaluate(() => document.getElementById('product-buy').click());
  await page.waitForFunction(
    () => document.querySelector('.pg2-done__title')?.textContent === 'Payment received? We are checking.',
    { timeout: 15000 },
  ).catch(() => {});
  const st = await page.evaluate(() => ({
    title: document.querySelector('.pg2-done__title')?.textContent,
    body: document.querySelector('.pg2-done__body')?.textContent || '',
    ring: Boolean(document.querySelector('.pay-tick--wait')),
    stored: sessionStorage.getItem('gridx.lastOrder'),
  }));
  report('timeout: a slow webhook ends in "we are checking", never a failure',
    st.title === 'Payment received? We are checking.' && st.ring
    && /your order is confirmed and your tax invoice will arrive/.test(st.body)
    && /support page/.test(st.body) && st.stored === 'GX-MOCKAA1',
    JSON.stringify({ title: st.title, ring: st.ring }));
  await shoot(page, 'purchase-timeout');
  report('timeout: no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
  await setModes({ confirm: 'ok' });
}

if (!args.includes('--keep')) {
  await browser.close();
  server.close();
  await mock.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\npurchase: all checks passed');
process.exitCode = failed ? 1 : 0;
