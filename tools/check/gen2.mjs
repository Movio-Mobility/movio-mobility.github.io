#!/usr/bin/env node
/*
 * The Gen2 pre-booking page's configurator, in headless Chrome, against the working copy
 * (tools/serve.mjs) and the Paddock mock (tools/check/paddock-mock.mjs).
 *
 *   node tools/check/gen2.mjs [--root dir]
 *
 * At 390x844 and again at 1440x900 (?check&launch=60, so pre-booking is open):
 *   - the footer says Pre-book at ₹399 (Fully refundable) and Continue from the start, and
 *     keeps saying it whatever is chosen; the review's Starts at row carries the price, with
 *     the finance note right under it
 *   - no vehicle: the Komaki step is hidden, the review starts at ₹29,999 and says "Your
 *     own ride"
 *   - a vehicle: the step shows, the review starts at ₹59,999 (the floor), the stage says
 *     data-vehicle="yes" and, with the field, the pod rides into the scooter (a screenshot
 *     lands in tools/check/out/); X1 and X3 move the review to ₹59,999 and ₹69,999
 *   - the picture up close: no large picture is requested before a tap; the tap on the X1
 *     card puts exactly one picture on the page, the X1's large one, and nothing else; the X
 *     takes it out again with the radios and the review as they were; Escape and the back
 *     button close it too, and each opening is one request
 *   - the button says Continue on the configure and details stages
 *   - no page errors
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

/** The page, its calls to Paddock answered by the mock, every request for a large picture noted. */
async function open(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  const vehicles = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = req.url();
    if (/komaki-x[13]-large\.webp/.test(url)) vehicles.push(url);
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
  await page.goto(`${SITE}/powerpod-gen2.html?check&launch=60`, { waitUntil: 'load' });
  return { page, errors, vehicles };
}

const shoot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

const state = (page) => page.evaluate(() => ({
  modelHidden: document.getElementById('step-model').hidden,
  vehicle: document.getElementById('pg2-stage').dataset.vehicle,
  label: document.getElementById('pg2-total-label').textContent,
  amount: document.getElementById('pg2-total').textContent,
  note: document.getElementById('pg2-foot-note').textContent,
  // The review's last row: "Starts at" and the floor for what is chosen so far.
  startsAt: document.querySelector('#pg2-review li:last-child .review__value')?.textContent,
  finance: document.getElementById('pg2-review').nextElementSibling?.textContent,
  next: document.getElementById('pg2-next-label').textContent,
  review: document.getElementById('pg2-review').textContent,
  checked: [...document.querySelectorAll('.opt__input:checked')].map((r) => `${r.name}=${r.value}`),
  viewerOpen: !document.getElementById('pg2-viewer').hidden,
  frames: [...document.querySelectorAll('#pg2-viewer-pic img')].map((f) => f.getAttribute('src')),
  loaded: document.getElementById('pg2-viewer').dataset.loaded,
  viewing: document.documentElement.classList.contains('is-viewing'),
  title: document.getElementById('pg2-viewer-title').textContent,
  stage: Number(document.querySelector('.pg2-view.is-active').dataset.stage),
}));

const choose = async (page, group, value) => {
  await page.evaluate(([g, v]) => document.querySelector(`input[name="${g}"][value="${v}"]`).click(), [group, value]);
  await sleep(500);
};

const until = (page, fn, timeout = 5000) => page.waitForFunction(fn, { timeout }).then(() => true).catch(() => false);

for (const [label, viewport] of [['phone', PHONE], ['desktop', DESK]]) {
  const { page, errors, vehicles } = await open(viewport);
  await sleep(900);

  let s = await state(page);
  // The footer is what pre-booking costs, the review what the whole thing starts at.
  const footerSays = (f) => f.label === 'Pre-book at' && f.amount === '₹399' && f.note === '(Fully refundable)' && f.next === 'Continue';
  report(`${label}: the footer says what pre-booking costs from the start, the review the price`,
    footerSays(s) && s.startsAt === '₹29,999' && s.finance === 'Finance options available at the time of purchase.',
    JSON.stringify({ label: s.label, amount: s.amount, note: s.note, next: s.next, startsAt: s.startsAt, finance: s.finance }));
  report(`${label}: the Komaki step is hidden until a vehicle is wanted`, s.modelHidden && s.vehicle === 'no');

  await choose(page, 'vehicle', 'no');
  s = await state(page);
  report(`${label}: no vehicle: the step stays hidden, the review says your own ride, ₹29,999`,
    s.modelHidden && /Your own ride/.test(s.review) && s.startsAt === '₹29,999' && footerSays(s) && s.vehicle === 'no',
    JSON.stringify({ hidden: s.modelHidden, startsAt: s.startsAt, amount: s.amount, review: s.review }));

  await choose(page, 'vehicle', 'yes');
  s = await state(page);
  report(`${label}: a vehicle: the step shows, the floor is ₹59,999, the stage knows`,
    !s.modelHidden && s.startsAt === '₹59,999' && footerSays(s) && s.vehicle === 'yes' && /model not chosen/.test(s.review),
    JSON.stringify({ hidden: s.modelHidden, startsAt: s.startsAt, amount: s.amount, vehicle: s.vehicle }));

  await choose(page, 'model', 'x1');
  const x1 = await state(page);
  await choose(page, 'model', 'x3');
  s = await state(page);
  report(`${label}: X1 starts at ₹59,999, X3 at ₹69,999, and the review names it`,
    x1.startsAt === '₹59,999' && s.startsAt === '₹69,999' && /Komaki X3/.test(s.review) && footerSays(x1) && footerSays(s),
    JSON.stringify({ x1: x1.startsAt, x3: s.startsAt, footer: s.amount }));
  // The ride: give the field its gather and the pod its slide before the picture.
  await sleep(2600);
  await shoot(page, `gen2-ride-${label}`);
  const ride = await page.evaluate(() => {
    const r = window.__pg2.ride;
    return { on: r.rideOn, t: r.rideT, live: r.live, frame: r.bay && r.bay.frame, dist: r.dist, far: r.far, roll: r.last && r.last.shot.roll };
  });
  report(`${label}: the pod is in the bay, a tenth of the stage tall, rolled, and within the camera's reach`,
    ride.on && ride.t === 1 && ride.live && ride.frame > 0.08 && ride.frame < 0.3 && ride.dist < ride.far * 0.9
    && Math.abs(ride.roll - Math.PI / 4) < 1e-6,
    JSON.stringify(ride));

  report(`${label}: no large picture was fetched before a tap`, vehicles.length === 0, vehicles.join(', '));

  // Open the X1 up close, with the X3 chosen: the choice must survive the view.
  await page.evaluate(() => document.querySelector('[data-view="x1"]').click());
  const opened = await until(page, () => !document.getElementById('pg2-viewer').hidden && document.querySelector('#pg2-viewer-pic img'));
  s = await state(page);
  report(`${label}: the tap opens exactly one picture, the X1's, over the page`,
    opened && s.viewerOpen && s.frames.length === 1 && /komaki-x1-large\.webp/.test(s.frames[0])
    && s.viewing && s.title === 'Komaki X1' && s.checked.includes('model=x3'),
    JSON.stringify({ open: s.viewerOpen, frames: s.frames, title: s.title, checked: s.checked }));
  const loaded = await until(page, () => document.getElementById('pg2-viewer').dataset.loaded === 'true');
  report(`${label}: the picture loads and the ring gives way to it`, loaded);
  await sleep(700); // past the fade, so the picture is the view and not the page through it
  await shoot(page, `gen2-viewer-${label}`);
  report(`${label}: the tap fetched the X1's large picture and nothing else`,
    vehicles.length === 1 && /komaki-x1-large\.webp/.test(vehicles[0]), vehicles.join(', '));

  await page.evaluate(() => document.getElementById('pg2-viewer-close').click());
  const closed = await until(page, () => document.getElementById('pg2-viewer').hidden && !document.querySelector('#pg2-viewer-pic img'));
  s = await state(page);
  report(`${label}: the X closes it, the picture is gone, the choices and the review stand`,
    closed && !s.viewerOpen && s.frames.length === 0 && !s.viewing && s.checked.includes('model=x3')
    && s.checked.includes('vehicle=yes') && s.startsAt === '₹69,999' && s.vehicle === 'yes',
    JSON.stringify({ closed, frames: s.frames, checked: s.checked, startsAt: s.startsAt }));

  // Escape closes it too.
  await page.evaluate(() => document.querySelector('[data-view="x3"]').click());
  await until(page, () => document.getElementById('pg2-viewer').dataset.loaded === 'true');
  await page.keyboard.press('Escape');
  const escaped = await until(page, () => document.getElementById('pg2-viewer').hidden && !document.querySelector('#pg2-viewer-pic img'));
  report(`${label}: Escape closes it`, escaped);

  // And so does going back, the way a phone's back gesture does.
  await page.evaluate(() => document.querySelector('[data-view="x3"]').click());
  await until(page, () => document.getElementById('pg2-viewer').dataset.loaded === 'true');
  await page.goBack();
  const back = await until(page, () => document.getElementById('pg2-viewer').hidden && !document.querySelector('#pg2-viewer-pic img'));
  s = await state(page);
  report(`${label}: the back button closes it and the page is still the page`,
    back && s.stage === 1 && s.checked.includes('model=x3') && s.startsAt === '₹69,999',
    JSON.stringify({ back, stage: s.stage, checked: s.checked }));
  // The browser may serve the second X3 from its cache without a request, so two or three.
  report(`${label}: each opening is a request for that picture and no other`,
    vehicles.length >= 2 && vehicles.length <= 3 && /x1/.test(vehicles[0]) && vehicles.slice(1).every((u) => /x3/.test(u)),
    vehicles.map((u) => u.split('/').pop()).join(', '));

  // On to the details: the same words on the button.
  await page.evaluate(() => document.getElementById('pg2-next').click());
  await sleep(600);
  s = await state(page);
  report(`${label}: the details stage keeps Pre-book at ₹399 and Continue`, s.stage === 2 && footerSays(s),
    JSON.stringify({ stage: s.stage, label: s.label, amount: s.amount, note: s.note, next: s.next }));

  // Back to the configurator: the scooter returns with the choice.
  await page.evaluate(() => document.getElementById('pg2-back').click());
  await sleep(600);
  s = await state(page);
  report(`${label}: back on the configurator the choice and the ride are still there`,
    s.stage === 1 && s.vehicle === 'yes' && s.checked.includes('model=x3'), JSON.stringify({ stage: s.stage, vehicle: s.vehicle }));

  report(`${label}: no page errors`, errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.close();
await mock.close?.();
console.log(failed ? `\n${failed} check(s) failed` : '\ngen2: all checks passed');
process.exitCode = failed ? 1 : 0;
