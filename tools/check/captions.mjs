#!/usr/bin/env node
/*
 * The film's captions all start from one place, checked in headless Chrome.
 *
 *   node tools/check/captions.mjs                every width
 *   --only=phone,desktop   --root=dist   narrow the run, or check the built site
 *
 * Every caption's title starts at exactly the same point, beat after beat: on desktop one
 * column, fixed in the CSS; on phones one text line, set from the tallest caption. Nothing the
 * film shows comes into the text: on desktop the pod in every shot, the scooter, the lift, the
 * phone, the two pods and the finale's pod and phone all end left of the column; on phones the
 * pod (by its own dark pixels, with the captions hidden), the phone, the two pods and the
 * finale's group all end above the text line. The page never scrolls sideways. And a reload
 * straight onto a beat shows its title in its place from the first frame, never anywhere else.
 */
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
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const rootArg = process.argv.find((a) => a.startsWith('--root='));

const VIEWPORTS = {
  small: { width: 320, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  se: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  large: { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop: { width: 1024, height: 768, deviceScaleFactor: 1 },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  wide: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  ultra: { width: 2560, height: 1080, deviceScaleFactor: 1 },
};
// Each caption's beat, at a moment it is fully in.
const BEATS = { 0: 1.45, 1: 2.7, 2: 3.95, 3: 5.6, 4: 8.45, 5: 12.5, 6: 13.6, 7: 15.95 };
// The pod's own beats, where it is on its own or in a drawing.
const POD_AT = [1.45, 2.7, 3.95, 5.0, 6.6];
const INK = {
  pod: { l: 0.1877, t: 0.0049, r: 0.8123, b: 0.8852 },
  phone: { l: 0.2511, t: 0.0096, r: 0.7489, b: 0.7636 },
  pair: { l: 0.0915, t: 0.0050, r: 0.9085, b: 0.8825 },
};

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function scrollTo(tab, t, wait = 1600) {
  await tab.evaluate((at) => {
    const vh = document.getElementById('bg').clientHeight || innerHeight;
    window.scrollTo({ top: at * vh, behavior: 'instant' });
  }, t);
  await sleep(wait);
}
const titleAt = (beat) => {
  const r = document.querySelector(`.film__caption[data-beat="${beat}"] .film__title`).getBoundingClientRect();
  return { x: r.left, y: r.top };
};
const box = (sel, ink) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  if (!ink) return { l: r.left, r: r.right, t: r.top, b: r.bottom };
  return { l: r.left + ink.l * r.width, r: r.left + ink.r * r.width, t: r.top + ink.t * r.height, b: r.top + ink.b * r.height };
};

// The lowest row of dark pixels (the pod and the phones are near black; the studio is light grey)
// above the bottom of the screen, with the captions and the chrome hidden.
async function darkBottom(tab) {
  await tab.addStyleTag({ content: '.film__caption, .film__tap, .film__prebook, .topbar, .island-wrap { visibility: hidden !important; }' });
  await sleep(120);
  const png = PNG.sync.read(Buffer.from(await tab.screenshot({ type: 'png' })));
  const dpr = await tab.evaluate(() => devicePixelRatio);
  let bottom = -1;
  for (let y = 0; y < png.height; y++) {
    let n = 0;
    for (let x = 0; x < png.width; x += 2) {
      const i = (y * png.width + x) * 4;
      if ((png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3 < 60) n++;
    }
    if (n > 6) bottom = y;
  }
  await tab.evaluate(() => { document.head.lastElementChild.remove(); });
  return bottom / dpr;
}

const server = await serve({ root: rootArg ? path.resolve(rootArg.slice(7)) : REPO, port: 8146, quiet: true });
const chrome = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] });
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
    await tab.goto('http://localhost:8146/index.html?check&launch=60', { waitUntil: 'load' });
    await sleep(2000);
    const wide = viewport.width >= 860;

    // Every title at one point.
    const spots = [];
    let overflow = false;
    for (const [beat, t] of Object.entries(BEATS)) {
      await scrollTo(tab, t);
      spots.push({ beat, ...(await tab.evaluate(titleAt, beat)) });
      overflow = overflow || (await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1));
    }
    const first = spots[0];
    const off = spots.filter((s) => Math.abs(s.x - first.x) > 1 || Math.abs(s.y - first.y) > 1);
    report(`${name}: every title starts at one point`, !off.length, off.map((s) => `beat ${s.beat} at ${s.x.toFixed(0)},${s.y.toFixed(0)} not ${first.x.toFixed(0)},${first.y.toFixed(0)}`).join('; '));
    report(`${name}: the page never scrolls sideways`, !overflow);

    // Nothing the film shows comes into the text.
    const wrong = [];
    if (wide) {
      const col = first.x;
      const reach = await tab.evaluate((ts) => ts.map((t) => window.__reach && window.__reach(t)), POD_AT);
      reach.forEach((r, i) => {
        if (!r) return;
        if (r.pod > col - 32) wrong.push(`the pod at t ${POD_AT[i]} reaches ${Math.round(r.pod)}`);
        if (i === 0 && r.scooter > col - 32) wrong.push(`the scooter reaches ${Math.round(r.scooter)}`);
        if (i === 0 && r.lift > col - 32) wrong.push(`the lift reaches ${Math.round(r.lift)}`);
      });
      await scrollTo(tab, 8.45);
      const phone = await tab.evaluate(box, '.phone');
      if (phone.r > col - 32) wrong.push(`the phone reaches ${Math.round(phone.r)}`);
      await scrollTo(tab, 13.6);
      const pair = await tab.evaluate(box, '.film__pair', INK.pair);
      if (pair.r > col - 32) wrong.push(`the two pods reach ${Math.round(pair.r)}`);
      await scrollTo(tab, 15.95, 2200);
      const still = await tab.evaluate(box, '.film__still', INK.phone);
      const row = await tab.evaluate(box, '.film__prebook');
      if (still.r > col - 32) wrong.push(`the finale's phone reaches ${Math.round(still.r)}`);
      if (row.r > col - 16) wrong.push(`the pre-book row reaches ${Math.round(row.r)}`);
    } else {
      const line = first.y;
      for (const t of [1.45, 2.7, 3.95]) {
        await scrollTo(tab, t, 2000);
        const b = await darkBottom(tab);
        if (b > line - 8) wrong.push(`the pod at t ${t} comes down to ${Math.round(b)}`);
      }
      await scrollTo(tab, 8.45);
      const row = await tab.evaluate(box, '.film__tap[data-beat="4"] .film__points');
      if (row.b > line - 8) wrong.push(`the phone's row comes down to ${Math.round(row.b)}`);
      await scrollTo(tab, 13.6);
      const pair = await tab.evaluate(box, '.film__pair', INK.pair);
      if (pair.b > line - 8) wrong.push(`the two pods come down to ${Math.round(pair.b)}`);
      await scrollTo(tab, 15.95, 2200);
      const prebook = await tab.evaluate(box, '.film__prebook');
      if (prebook.b > line - 8) wrong.push(`the pre-book row comes down to ${Math.round(prebook.b)}`);
    }
    report(`${name}: nothing comes into the text`, !wrong.length, wrong.join('; '));

    // A reload straight onto a beat: in place from the first frame.
    if (wide) {
      for (const beat of [1, 4, 6, 7]) {
        await scrollTo(tab, BEATS[beat], 600);
        await tab.reload({ waitUntil: 'domcontentloaded' });
        await tab.waitForSelector('.film__caption');
        const seen = [];
        for (const wait of [300, 1500, 4000]) {
          await sleep(wait - (seen.length ? [300, 1500, 4000][seen.length - 1] : 0));
          seen.push(await tab.evaluate(titleAt, beat));
        }
        const moved = seen.filter((s) => Math.abs(s.x - first.x) > 1 || Math.abs(s.y - first.y) > 1);
        report(`${name}: reloaded on beat ${beat}, its title is in place throughout`, !moved.length, moved.map((s) => `${s.x.toFixed(0)},${s.y.toFixed(0)}`).join('; '));
      }
    }

    report(`${name}: no errors`, !errors.length, errors.slice(0, 3).join(' | '));
    await tab.close();
  }
} finally {
  await chrome.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
