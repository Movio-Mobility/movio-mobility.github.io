#!/usr/bin/env node
/*
 * The warranty beat ("5 years, covered.") and its two pods, the studio render that stands in for
 * the 3D pod there (.film__pair in index.html), checked in headless Chrome.
 *
 *   node tools/check/warranty.mjs                  every width
 *   --only=phone,desktop   --root=dist   narrow the run, or check the built site
 *
 * The picture must not be fetched with the page, or before the film is into the app beats. In
 * the beat it is shown, loaded, and placed: on a phone centred, below the logo and with the
 * pods clear of the caption; on desktop beside the caption, never under it; on screen either
 * way, without the page scrolling sideways. Before and after the beat it is hidden, so nothing
 * of it is drawn.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { serve } from '../serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require = createRequire(path.join(REPO, 'package.json'));
const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const rootArg = process.argv.find((a) => a.startsWith('--root='));

const VIEWPORTS = {
  small: { width: 320, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  se: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  large: { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop: { width: 1024, height: 768, deviceScaleFactor: 2 },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
};
// The pods within the picture's box (tools/source/stills.py): the rest is their shadow.
const PODS = { left: 110 / 1202, right: 1092 / 1202, top: 6 / 1191, bottom: 1051 / 1191 };

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function scrollTo(tab, t) {
  await tab.evaluate((at) => {
    const vh = document.getElementById('bg').clientHeight || innerHeight;
    window.scrollTo({ top: at * vh, behavior: 'instant' });
  }, t);
  await sleep(2400);
}

const STATE = (pods) => {
  const pair = document.querySelector('.film__pair');
  const img = pair.querySelector('img');
  const b = pair.getBoundingClientRect();
  const ink = {
    l: b.left + pods.left * b.width, r: b.left + pods.right * b.width,
    t: b.top + pods.top * b.height, b: b.top + pods.bottom * b.height,
  };
  const cs = getComputedStyle(pair);
  const words = [...document.querySelectorAll('.film__caption[data-beat="6"] > *')].map((el) => el.getBoundingClientRect());
  const caption = { l: Math.min(...words.map((w) => w.left)), t: Math.min(...words.map((w) => w.top)) };
  const logo = document.querySelector('.topbar__logo, .brand, header img, .topbar');
  return {
    shown: cs.visibility === 'visible' && parseFloat(cs.opacity) > 0.99,
    hidden: cs.visibility === 'hidden',
    loaded: img.complete && img.naturalWidth > 0,
    ink,
    caption,
    logoBottom: logo ? logo.getBoundingClientRect().bottom : 0,
    title: document.querySelector('.film__caption[data-beat="6"] .film__title').textContent.trim(),
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    vw: innerWidth,
    vh: innerHeight,
  };
};

const server = await serve({ root: rootArg ? path.resolve(rootArg.slice(7)) : REPO, port: 8144, quiet: true });
const chrome = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] });
try {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const tab = await chrome.newPage();
    await tab.setViewport(viewport);
    const errors = [];
    const fetched = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    // Failed requests are judged by their address (the analytics endpoint on :3000 is not run
    // here); the console's own line for them carries none.
    tab.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|localhost:3000|favicon|paddock/i.test(m.text())) errors.push(m.text()); });
    tab.on('requestfailed', (q) => { if (!/localhost:3000|favicon/.test(q.url()) && !/ERR_ABORTED/.test((q.failure() || {}).errorText || '')) errors.push(`${q.url()} ${(q.failure() || {}).errorText}`); });
    tab.on('request', (r) => { if (/standing-resting/.test(r.url())) fetched.push(r.url()); });
    await tab.goto('http://localhost:8144/index.html?check', { waitUntil: 'load' });
    await sleep(1500);
    const wide = viewport.width >= 860;

    report(`${name}: not fetched with the page`, !fetched.length);
    // Through the film to the first app beat, which lays out the captions on the way.
    await scrollTo(tab, 4.0);
    await scrollTo(tab, 8.45);
    report(`${name}: not fetched before the app beats`, !fetched.length);
    let st = await tab.evaluate(STATE, PODS);
    report(`${name}: hidden before its beat`, st.hidden);

    await scrollTo(tab, 13.6);
    st = await tab.evaluate(STATE, PODS);
    const wrong = [];
    if (!st.shown) wrong.push('not shown');
    if (!st.loaded) wrong.push('picture not loaded');
    if (st.title !== '5 years, covered.') wrong.push(`title "${st.title}"`);
    if (st.ink.l < 0 || st.ink.r > st.vw || st.ink.t < 0 || st.ink.b > st.vh) wrong.push('pods run off screen');
    if (st.overflowX) wrong.push('the page scrolls sideways');
    if (wide) {
      if (st.ink.r > st.caption.l - 24) wrong.push(`pods reach the caption (${(st.ink.r - st.caption.l).toFixed(0)}px)`);
    } else {
      if (Math.abs((st.ink.l + st.ink.r) / 2 - st.vw / 2) > 2) wrong.push(`pods off centre by ${((st.ink.l + st.ink.r) / 2 - st.vw / 2).toFixed(1)}px`);
      if (st.ink.b > st.caption.t - 12) wrong.push(`pods ${(st.caption.t - st.ink.b).toFixed(0)}px above the caption`);
      if (st.ink.t < st.logoBottom) wrong.push('pods under the logo');
    }
    report(`${name}: in its beat, shown and placed`, !wrong.length, wrong.join('; '));
    report(`${name}: fetched once`, fetched.length === 1, `${fetched.length} requests`);

    for (const t of [12.5, 15.8]) {
      await scrollTo(tab, t);
      st = await tab.evaluate(STATE, PODS);
      report(`${name}: hidden at t ${t}`, st.hidden);
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
