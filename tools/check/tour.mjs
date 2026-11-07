#!/usr/bin/env node
/*
 * The tour of the app's tabs between the two app beats (driveTour in index.html), checked in
 * headless Chrome.
 *
 *   node tools/check/tour.mjs              every check, every width
 *   node tools/check/tour.mjs --reel       and stills at each point, on contact sheets in
 *                                          tools/check/out/
 *   --only=phone,desktop   --root=dist   narrow the run, or check the built site
 *
 * The film is scrolled to each point of the tour, forwards and then back, and at each it checks
 * what a visitor would see: the phone in the middle and larger, which tab's page is in the phone
 * (by which page is actually showing, the app swapping them in place), the tab bar held open
 * with its pill on that tab, the finger down on the tab it is pressing, only ever one hand (its
 * two poses never showing together), and nothing pushing the page sideways. Before and after
 * the tour the phone must be exactly where it rests, on Home, with nothing of the tour left on
 * it. It also checks the 3D PowerPod has gone for good after the lift: its loop asleep through
 * the app beats, the warranty and the credits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { serve } from '../serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require = createRequire(path.join(REPO, 'package.json'));
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(HERE, 'out');
const REEL = process.argv.includes('--reel');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const rootArg = process.argv.find((a) => a.startsWith('--root='));

const VIEWPORTS = {
  small: { width: 320, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  large: { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop: { width: 1024, height: 768, deviceScaleFactor: 2 },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
};

// The points, in the film's viewports, and what should be true there. `tab` is the tab open in
// the phone; `press` the tab the finger is down on (index.html TOUR: each tap's finger is down
// from 0.42 to 0.6 of its window, and its page swaps in as it lifts).
const POINTS = [
  { t: 10.25, label: 'before', touring: false, tab: 'home' },
  { t: 11.3, label: 'grown', touring: true, tab: 'home' },
  { t: 11.60, label: 'pressing Energy', touring: true, tab: 'home', press: 'energy' },
  { t: 11.85, label: 'energy', touring: true, tab: 'energy' },
  { t: 12.16, label: 'pressing Owner', touring: true, tab: 'energy', press: 'owner' },
  { t: 12.40, label: 'owner', touring: true, tab: 'owner' },
  { t: 12.71, label: 'pressing Home', touring: true, tab: 'owner', press: 'home' },
  { t: 13.0, label: 'home again', touring: true, tab: 'home' },
  { t: 14.3, label: 'after', touring: false, tab: 'home' },
];

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Counts the pod's frames: the film's pod loop is the only requestAnimationFrame callback named
// `loop`.
const COUNT_POD = () => {
  window.__podFrames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((now) => {
    if (cb.name === 'loop') window.__podFrames++;
    cb(now);
  });
};

const STATE = () => {
  const device = document.querySelector('.film__device');
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };
  // The pages showing: the app swaps them in place, one at a time.
  const shown = [...document.querySelectorAll('.app__page')].filter((el) => getComputedStyle(el).visibility !== 'hidden').map((el) => el.dataset.page);
  const bar = document.querySelector('.gx-tabbar');
  const items = Object.fromEntries([...bar.querySelectorAll('.gx-tabbar__item')].map((el) => [el.dataset.tab, rect(el)]));
  const on = [...bar.querySelectorAll('.gx-tabbar__item.is-on')].map((el) => el.dataset.tab);
  const pill = rect(bar.querySelector('.gx-tabbar__pill'));
  // The tab the pill sits on, by its middle.
  const pillOn = Object.entries(items).find(([, r]) => Math.abs(r.cx - pill.cx) < r.w / 4);
  const touch = rect(document.querySelector('.film__touch--tour'));
  const touchOn = Object.entries(items).find(([, r]) => touch.cx > r.l && touch.cx < r.r && touch.cy > r.t && touch.cy < r.b);
  const tourStyled = [...document.querySelectorAll('.film__tourhand, .film__tourhand .film__hand, .film__touch--tour')]
    .filter((el) => (el.style.transform || el.style.opacity || el.style.scale)).length;
  return {
    touring: device.classList.contains('is-touring'),
    device: rect(device),
    tab: document.querySelector('.app').dataset.tab,
    shown,
    on,
    pillOn: pillOn ? pillOn[0] : null,
    compact: bar.dataset.compact === 'true',
    touchOpacity: parseFloat(getComputedStyle(document.querySelector('.film__touch--tour')).opacity),
    touchOn: touchOn ? touchOn[0] : null,
    tourStyled,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    // The tour hand's two poses: never both showing.
    hands: [...document.querySelectorAll('.film__tourhand .film__hand')].map((img) => parseFloat(getComputedStyle(img).opacity)),
    vw: innerWidth,
    vh: innerHeight,
  };
};

async function scrollTo(tab, t) {
  await tab.evaluate((at) => {
    const vh = document.getElementById('bg').clientHeight || innerHeight;
    window.scrollTo({ top: at * vh, behavior: 'instant' });
  }, t);
  await sleep(1600);
}

const server = await serve({ root: rootArg ? path.resolve(rootArg.slice(7)) : REPO, port: 8143, quiet: true });
const chrome = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] });
fs.mkdirSync(OUT, { recursive: true });
try {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const tab = await chrome.newPage();
    await tab.setViewport(viewport);
    const errors = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    // Failed requests are judged by their address (the analytics endpoint on :3000 is not run
    // here); the console's own line for them carries none.
    tab.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|localhost:3000|favicon|paddock/i.test(m.text())) errors.push(m.text()); });
    tab.on('requestfailed', (q) => { if (!/localhost:3000|favicon/.test(q.url()) && !/ERR_ABORTED/.test((q.failure() || {}).errorText || '')) errors.push(`${q.url()} ${(q.failure() || {}).errorText}`); });
    await tab.evaluateOnNewDocument(COUNT_POD);
    await tab.goto('http://localhost:8143/index.html?check', { waitUntil: 'load' });
    await sleep(1500);

    let rest = null;
    const stills = [];
    const visit = async (points, dir) => {
      for (const pt of points) {
        await scrollTo(tab, pt.t);
        const st = await tab.evaluate(STATE);
        const wrong = [];
        if (st.touring !== pt.touring) wrong.push(`touring ${st.touring}`);
        if (st.overflowX) wrong.push('the page scrolls sideways');
        // The open tab: its page the only one showing, the tab bar's highlight and pill on it.
        if (st.tab !== pt.tab) wrong.push(`tab ${st.tab}, wanted ${pt.tab}`);
        if (st.shown.join() !== pt.tab) wrong.push(`pages showing [${st.shown}]`);
        if (st.on.join() !== pt.tab) wrong.push(`tab bar highlights [${st.on}]`);
        if (st.pillOn !== pt.tab) wrong.push(`pill on ${st.pillOn}`);
        if (!pt.touring) {
          if (!rest) rest = st.device;
          else if (Math.abs(st.device.cx - rest.cx) > 1 || Math.abs(st.device.cy - rest.cy) > 1 || Math.abs(st.device.h - rest.h) > 1) wrong.push(`phone not back at rest (${st.device.cx.toFixed(1)},${st.device.cy.toFixed(1)} h${st.device.h.toFixed(1)} vs ${rest.cx.toFixed(1)},${rest.cy.toFixed(1)} h${rest.h.toFixed(1)})`);
          if (st.tourStyled) wrong.push(`${st.tourStyled} tour styles left on`);
          if (st.touchOpacity > 0.01) wrong.push('the tour\'s touch left showing');
        } else {
          if (Math.abs(st.device.cx - st.vw / 2) > 2) wrong.push(`phone off centre by ${(st.device.cx - st.vw / 2).toFixed(1)}px`);
          if (rest && st.device.h <= rest.h + 1) wrong.push('phone not larger');
          if (st.device.t < 0 || st.device.b > st.vh) wrong.push('phone runs off screen');
          // Held open while the hand is on it.
          if (st.compact) wrong.push('the tab bar folded');
          if (pt.press && !(st.touchOpacity > 0.3 && st.touchOn === pt.press)) wrong.push(`finger not down on ${pt.press} (on ${st.touchOn}, shade ${st.touchOpacity})`);
          if (!pt.press && st.touchOpacity > 0.01) wrong.push('a touch showing with no finger down');
        }
        report(`${name}: ${dir} ${pt.label} (t ${pt.t})`, !wrong.length, wrong.join('; '));
        if (REEL && dir === 'forwards') stills.push({ label: pt.label, png: await tab.screenshot({ type: 'png' }) });
      }
    };
    await visit(POINTS, 'forwards');
    await visit([...POINTS].reverse(), 'backwards');

    // One hand, never two: through each part of a press and flick on the pill.
    {
      const doubled = [];
      for (const t of [11.50, 11.56, 11.57, 11.60, 11.64, 11.65, 11.70, 12.10, 12.12, 12.19, 12.20, 12.66, 12.67, 12.74, 12.75, 12.92]) {
        await scrollTo(tab, t);
        const st = await tab.evaluate(STATE);
        if (st.hands.filter((o) => o > 0.01).length > 1) doubled.push(t);
      }
      report(`${name}: only ever one hand on the pill`, !doubled.length, doubled.join(', '));
    }

    // The pod is gone after the lift: once the film settles anywhere past it, its loop sleeps.
    for (const t of [10.25, 11.8, 14.3, 15.4]) {
      await scrollTo(tab, t);
      await sleep(600);
      const before = await tab.evaluate(() => window.__podFrames);
      await sleep(1000);
      const after = await tab.evaluate(() => window.__podFrames);
      report(`${name}: no pod loop at rest at t ${t}`, after === before, `${after - before} pod frames in a second`);
    }

    report(`${name}: no errors`, !errors.length, errors.slice(0, 3).join(' | '));
    if (REEL && stills.length) {
      const imgs = stills.map((s) => PNG.sync.read(Buffer.from(s.png)));
      const scale = imgs[0].width > 1600 ? 4 : 3;
      const w = Math.floor(imgs[0].width / scale), h = Math.floor(imgs[0].height / scale);
      const cols = 4, rows = Math.ceil(imgs.length / cols);
      const out = new PNG({ width: w * cols, height: h * rows });
      out.data.fill(255);
      imgs.forEach((png, i) => {
        const ox = (i % cols) * w, oy = Math.floor(i / cols) * h;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const si = (y * scale * png.width + x * scale) * 4;
            const di = ((oy + y) * out.width + ox + x) * 4;
            out.data[di] = png.data[si];
            out.data[di + 1] = png.data[si + 1];
            out.data[di + 2] = png.data[si + 2];
            out.data[di + 3] = 255;
          }
        }
      });
      const file = path.join(OUT, `tour-${name}.png`);
      fs.writeFileSync(file, PNG.sync.write(out));
      console.log(`${path.relative(REPO, file)}  ${stills.map((s) => s.label).join(', ')}`);
    }
    await tab.close();
  }
  // The app's pages never change what they show: the same on any visitor's clock.
  if (!ONLY.length || ONLY.includes('phone')) {
    const read = async (iso) => {
      const tab = await chrome.newPage();
      await tab.setViewport(VIEWPORTS.phone);
      await tab.evaluateOnNewDocument((at) => {
        const real = Date;
        const shift = new real(at).getTime() - real.now();
        // eslint-disable-next-line no-global-assign
        Date = class extends real {
          constructor(...a) { super(...(a.length ? a : [real.now() + shift])); }
          static now() { return real.now() + shift; }
        };
      }, iso);
      await tab.goto('http://localhost:8143/index.html?check', { waitUntil: 'load' });
      await sleep(1500);
      await scrollTo(tab, 10.25);
      const text = await tab.evaluate(() => [...document.querySelectorAll('.app__page')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
      await sleep(3500);
      const later = await tab.evaluate(() => [...document.querySelectorAll('.app__page')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
      await tab.close();
      return { text, later };
    };
    const morning = await read('2026-11-20T03:30:00Z');
    const night = await read('2027-03-02T17:45:00Z');
    const same = morning.text.every((t, i) => t === night.text[i]) && morning.text.every((t, i) => t === morning.later[i]);
    report('the app\'s pages show the same, whatever the clock and however long they are up', same,
      same ? '' : morning.text.map((t, i) => (t === night.text[i] ? '' : `page ${i}: "${t.slice(0, 80)}" vs "${night.text[i].slice(0, 80)}"`)).filter(Boolean).join(' | '));
  }
} finally {
  await chrome.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
