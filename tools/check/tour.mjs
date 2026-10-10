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
 * what a visitor would see: the phone in the middle and larger, the pages either side of it,
 * which page is in the phone (by what is actually under the middle of its screen), the pill's
 * highlight and the lock, the hand on the pill while it presses, only ever one hand (its two
 * poses never showing together), and nothing pushing the page
 * sideways. Before and after the tour the phone must be exactly where it rests, with nothing of
 * the tour left on it. It also checks the 3D PowerPod has gone for good after the lift: its loop
 * asleep through the app beats, the warranty and the credits.
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

// The points, in the film's viewports, and what should be true there. `page` is the tab in the
// phone (-1 Charging, 0 Home, 1 PowerPod); `press` that the finger is down on the pill.
const POINTS = [
  { t: 8.45, label: 'before', touring: false },
  { t: 9.5, label: 'grown', touring: true, page: 0 },
  { t: 9.70, label: 'press', touring: true, page: 0, press: true },
  { t: 9.97, label: 'powerpod', touring: true, page: 1 },
  { t: 10.42, label: 'home', touring: true, page: 0 },
  { t: 10.87, label: 'charging', touring: true, page: -1 },
  { t: 11.32, label: 'home again', touring: true, page: 0 },
  { t: 12.5, label: 'after', touring: false },
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
  const screen = document.querySelector('.phone__screen');
  const s = rect(screen);
  // Which page is really under the middle of the phone's screen. (The film takes no pointer
  // events, so this is by the pages' boxes, not a hit test.)
  const pages = { charging: -1, home: 0, powerpod: 1 };
  let page = null;
  for (const [n, v] of Object.entries(pages)) {
    const r = document.querySelector(`.app__slot--${n}`).getBoundingClientRect();
    if (r.left <= s.cx && r.right >= s.cx && getComputedStyle(document.querySelector(`.app__slot--${n}`)).visibility !== 'hidden') page = v;
  }
  const icons = [...document.querySelectorAll('.app__nav > span')].map((i) => parseFloat(getComputedStyle(i).opacity));
  const sides = [...document.querySelectorAll('.side__slot')].map((el) => ({ ...rect(el), vis: getComputedStyle(el).visibility }));
  const touch = rect(document.querySelector('.film__touch--tour'));
  const pill = rect(document.querySelector('.app__nav'));
  const tourStyled = [...document.querySelectorAll('.app__pager, .film__side, .app__navhi, .app__lock, .film__tourhand, .film__touch--tour, .app__nav > span')]
    .filter((el) => (el.style.transform || el.style.opacity || el.style.scale)).length;
  return {
    touring: device.classList.contains('is-touring'),
    device: rect(device),
    page,
    active: icons.indexOf(Math.max(...icons)) - 1,
    lock: parseFloat(getComputedStyle(document.querySelector('.app__lock')).opacity),
    sides,
    touchOpacity: parseFloat(getComputedStyle(document.querySelector('.film__touch--tour')).opacity),
    touchOnPill: touch.cx > pill.l - 30 && touch.cx < pill.r + 30 && touch.cy > pill.t - 10 && touch.cy < pill.b + 10,
    sideVisible: getComputedStyle(document.querySelector('.film__side')).visibility,
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
    const wide = viewport.width >= 860;

    let rest = null;
    const stills = [];
    const visit = async (points, dir) => {
      for (const pt of points) {
        await scrollTo(tab, pt.t);
        const st = await tab.evaluate(STATE);
        const wrong = [];
        if (st.touring !== pt.touring) wrong.push(`touring ${st.touring}`);
        if (st.overflowX) wrong.push('the page scrolls sideways');
        if (!pt.touring) {
          if (!rest) rest = st.device;
          else if (Math.abs(st.device.cx - rest.cx) > 1 || Math.abs(st.device.cy - rest.cy) > 1 || Math.abs(st.device.h - rest.h) > 1) wrong.push(`phone not back at rest (${st.device.cx.toFixed(1)},${st.device.cy.toFixed(1)} h${st.device.h.toFixed(1)} vs ${rest.cx.toFixed(1)},${rest.cy.toFixed(1)} h${rest.h.toFixed(1)})`);
          if (st.sideVisible !== 'hidden') wrong.push('side screens visible');
          if (st.tourStyled) wrong.push(`${st.tourStyled} tour styles left on`);
        } else {
          if (Math.abs(st.device.cx - st.vw / 2) > 2) wrong.push(`phone off centre by ${(st.device.cx - st.vw / 2).toFixed(1)}px`);
          if (rest && st.device.h <= rest.h + 1) wrong.push('phone not larger');
          if (st.device.t < 0 || st.device.b > st.vh) wrong.push('phone runs off screen');
          if (pt.page !== undefined && st.page !== pt.page) wrong.push(`page ${st.page}, wanted ${pt.page}`);
          if (pt.page !== undefined && st.active !== pt.page) wrong.push(`pill on ${st.active}`);
          if (pt.page === 0 && st.lock < 0.99) wrong.push('lock hidden on Home');
          if (pt.page !== undefined && pt.page !== 0 && st.lock > 0.01) wrong.push('lock showing off Home');
          if (pt.press && !(st.touchOpacity > 0.3 && st.touchOnPill)) wrong.push(`finger not down on the pill (shade ${st.touchOpacity})`);
          // The pages next to the phone: on a desktop, wholly on screen; on a phone, peeking in.
          // (The far page, two along, is meant to be off the side.)
          const shown = st.sides.filter((s) => s.vis !== 'hidden' && Math.abs(s.cx - st.device.cx) < 1.5 * s.w);
          for (const s of shown) {
            if (wide && (s.l < -1 || s.r > st.vw + 1)) wrong.push('a side screen runs off screen');
            if (!wide && s.r < 0 && s.l > st.vw) wrong.push('a side screen out of sight');
          }
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
      for (const t of [9.62, 9.65, 9.68, 9.72, 9.76, 9.78, 9.80, 10.10, 10.20, 10.25, 10.55, 10.65, 11.00, 11.12]) {
        await scrollTo(tab, t);
        const st = await tab.evaluate(STATE);
        if (st.hands.filter((o) => o > 0.01).length > 1) doubled.push(t);
      }
      report(`${name}: only ever one hand on the pill`, !doubled.length, doubled.join(', '));
    }

    // The pod is gone after the lift: once the film settles anywhere past it, its loop sleeps.
    for (const t of [8.45, 10.0, 12.5, 13.6]) {
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
      await scrollTo(tab, 8.45);
      const text = await tab.evaluate(() => [...document.querySelectorAll('.app__slot')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
      await sleep(3500);
      const later = await tab.evaluate(() => [...document.querySelectorAll('.app__slot')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
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
