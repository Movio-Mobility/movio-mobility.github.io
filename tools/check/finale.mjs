#!/usr/bin/env node
/*
 * The film's finale ("Made in India. Every inch of it."), checked in headless Chrome.
 *
 *   node tools/check/finale.mjs                  every width
 *   --only=phone,desktop   --root=dist   narrow the run, or check the built site
 *
 * Its pictures (the pod and the phone) must not be fetched with the page, or before the warranty
 * beat, and each only once. On the final frame both are shown and loaded, and everything is on
 * screen with nothing overlapping anything else (the pictures, the pre-book row, the words, the
 * top bar's logo, the nav island), without the page scrolling sideways. The phone stands
 * beside the pod the size it really is, 163.4 mm to its 395, on the same ground, and the pod is
 * no bigger than its share of the frame. The pre-book row hangs under the pod and the phone,
 * centred on them. Before pre-booking opens it says exactly what the hero's line says and has
 * no button; after, the hero's open line and a "Pre-book Gen2" button that takes a tap there
 * and nowhere else on the page, in the same place, so nothing moves at the instant. Scrolling
 * back, the warranty shot returns with nothing of the finale left. Reduced motion: the same
 * final frame.
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
  wide: { width: 1920, height: 1080, deviceScaleFactor: 1 },
};
const HOLD = 15.95;
const FILES = /perspective-front|phone-home/;

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function scrollTo(tab, t, wait = 2000) {
  await tab.evaluate((at) => {
    const vh = document.getElementById('bg').clientHeight || innerHeight;
    window.scrollTo({ top: at * vh, behavior: 'instant' });
  }, t);
  await sleep(wait);
}
// Through the film on the way, as a visitor comes.
async function toHold(tab) {
  for (const t of [4.0, 8.45, 13.6]) await scrollTo(tab, t, 1200);
  await scrollTo(tab, HOLD, 2600);
}

// What is on screen, in CSS px. The pictures by their ink, the part of each that is the thing
// itself (tools/source/stills.py), not their shadows.
const STATE = () => {
  const INK = {
    pod: { l: 0.1877, t: 0.0049, r: 0.8123, b: 0.8852 },
    phone: { l: 0.2511, t: 0.0096, r: 0.7489, b: 0.7636 },
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const ink = (el, I) => {
    const r = el.getBoundingClientRect();
    return { l: r.left + I.l * r.width, r: r.left + I.r * r.width, t: r.top + I.t * r.height, b: r.top + I.b * r.height };
  };
  const shown = (el) => getComputedStyle(el).visibility === 'visible' && parseFloat(getComputedStyle(el).opacity) > 0.99;
  const hidden = (el) => getComputedStyle(el).visibility === 'hidden';
  const loaded = (el) => { const i = el.querySelector('img'); return i.complete && i.naturalWidth > 0; };
  const solo = document.querySelector('.film__solo');
  const still = document.querySelector('.film__still');
  const cap = document.querySelector('.film__caption[data-beat="7"]');
  const row = document.querySelector('.film__prebook');
  const cta = row.querySelector('.film__prebook-cta');
  const words = [...cap.querySelectorAll('.film__title, .film__line')].map(rect);
  const ctaShown = getComputedStyle(cta).visibility === 'visible';
  let ctaHit = false;
  if (ctaShown) {
    const r = cta.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    ctaHit = hit === cta || cta.contains(hit);
  }
  return {
    wide: innerWidth >= 860,
    vw: innerWidth,
    vh: innerHeight,
    shown: [solo, still].map(shown),
    hidden: [solo, still].map(hidden),
    pairShown: shown(document.querySelector('.film__pair')),
    loaded: [solo, still].map(loaded),
    pod: ink(solo, INK.pod),
    phone: ink(still, INK.phone),
    row: rect(row),
    rowShown: parseFloat(getComputedStyle(row).opacity) > 0.99,
    words,
    cta: ctaShown ? rect(cta) : null,
    ctaText: cta.textContent.trim(),
    ctaHref: cta.getAttribute('href'),
    ctaHit,
    note: row.querySelector('[data-prebook-note]').textContent.replace(/\s+/g, ' ').trim(),
    heroNote: document.querySelector('[data-launch-note]').textContent.replace(/\s+/g, ' ').trim(),
    brand: rect(document.querySelector('.brand')),
    island: rect(document.querySelector('.island')),
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
  };
};

const overlap = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

const server = await serve({ root: rootArg ? path.resolve(rootArg.slice(7)) : REPO, port: 8145, quiet: true });
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
    tab.on('request', (r) => { if (FILES.test(r.url())) fetched.push(r.url().split('/').pop().split('?')[0]); });

    // Before pre-booking opens.
    await tab.goto('http://localhost:8145/index.html?check&launch=-3600', { waitUntil: 'load' });
    await sleep(1500);
    report(`${name}: nothing of the finale fetched with the page`, !fetched.length, fetched.join(', '));
    for (const t of [4.0, 8.45, 12.5]) await scrollTo(tab, t, 1200);
    report(`${name}: nothing fetched before the warranty beat`, !fetched.length, fetched.join(', '));
    await scrollTo(tab, 13.6, 1500);
    await scrollTo(tab, HOLD, 2600);
    let st = await tab.evaluate(STATE);
    const before = st.row;
    {
      const wrong = [];
      st.shown.forEach((s, i) => { if (!s) wrong.push(`${['pod', 'phone'][i]} not shown`); });
      st.loaded.forEach((s, i) => { if (!s) wrong.push(`${['pod', 'phone'][i]} not loaded`); });
      if (!st.rowShown) wrong.push('the pre-book row not shown');
      const podH = st.pod.b - st.pod.t;
      const ratio = (st.phone.b - st.phone.t) / podH;
      if (Math.abs(ratio / (163.4 / 395) - 1) > 0.02) wrong.push(`phone ${(ratio * 395).toFixed(1)} mm to the pod's 395`);
      if (Math.abs(st.phone.b - st.pod.b) > 2) wrong.push(`phone ${(st.phone.b - st.pod.b).toFixed(1)}px off the pod's ground`);
      if (st.phone.l <= st.pod.r) wrong.push('phone not beside the pod');
      const most = st.wide ? Math.min(0.5 * st.vh, 450) : Math.min(0.42 * st.vh, 360);
      if (podH > most + 1) wrong.push(`pod ${podH.toFixed(0)}px tall, more than ${most.toFixed(0)}`);
      // The row under the group, centred on it.
      const mid = (st.pod.l + st.phone.r) / 2;
      if (st.row.t < Math.max(st.pod.b, st.phone.b) - 2) wrong.push('the pre-book row is not under the pod and the phone');
      if (Math.abs((st.row.l + st.row.r) / 2 - mid) > 3) wrong.push(`the pre-book row ${((st.row.l + st.row.r) / 2 - mid).toFixed(1)}px off their middle`);
      const things = [['pod', st.pod], ['phone', st.phone], ['pre-book row', st.row], ...st.words.map((w, i) => [`words ${i}`, w])];
      for (let i = 0; i < things.length; i++) {
        const [n, r] = things[i];
        if (r.l < 0 || r.r > st.vw || r.t < 0 || r.b > st.vh) wrong.push(`${n} off screen`);
        if (overlap(r, st.brand)) wrong.push(`${n} under the top bar's logo`);
        if (!st.wide && overlap(r, st.island)) wrong.push(`${n} under the nav island`);
        for (let j = i + 1; j < things.length; j++) {
          const [m, s] = things[j];
          if (n.startsWith('words') && m.startsWith('words')) continue;
          if (overlap(r, s)) wrong.push(`${n} overlaps ${m}`);
        }
      }
      if (st.overflowX) wrong.push('the page scrolls sideways');
      report(`${name}: the final frame, before pre-booking opens`, !wrong.length, wrong.join('; '));
      report(`${name}: says what the hero says, with no button`, st.note === st.heroNote && !st.cta && /^Pre-booking opens/.test(st.note), `"${st.note}" / "${st.heroNote}"`);
    }
    const counts = {};
    for (const f of fetched) {
      const key = f.replace(/-\d+\.webp$/, '');
      counts[key] = (counts[key] || 0) + 1;
    }
    report(`${name}: each fetched once`, Object.keys(counts).length === 2 && Object.values(counts).every((c) => c === 1), JSON.stringify(counts));

    // Scrolling back: the warranty shot, and nothing of the finale on screen.
    await scrollTo(tab, 13.6, 2200);
    st = await tab.evaluate(STATE);
    report(`${name}: back to the warranty shot`, st.pairShown && st.hidden.every(Boolean), JSON.stringify({ pair: st.pairShown, hidden: st.hidden }));

    // Once pre-booking is open.
    await tab.goto('http://localhost:8145/index.html?check&launch=60', { waitUntil: 'load' });
    await sleep(1500);
    // Away from the finale its button is in the page but must take no tap: it would sit over
    // whatever is under it, the hero's own button included.
    const inert = await tab.evaluate(() => getComputedStyle(document.querySelector('.film__prebook-cta')).pointerEvents);
    report(`${name}: the button takes no taps away from the finale`, inert === 'none', inert);
    await toHold(tab);
    st = await tab.evaluate(STATE);
    {
      const wrong = [];
      if (!st.cta) wrong.push('no button');
      else {
        if (st.ctaText !== 'Pre-book Gen2') wrong.push(`button "${st.ctaText}"`);
        if (st.ctaHref !== 'powerpod-gen2.html') wrong.push(`goes to ${st.ctaHref}`);
        if (!st.ctaHit) wrong.push('does not take a tap');
        for (const [n, r] of [['pod', st.pod], ['phone', st.phone], ['island', st.island], ...st.words.map((w, i) => [`words ${i}`, w])]) {
          if ((st.wide && n === 'island') || !overlap(st.cta, r)) continue;
          wrong.push(`button overlaps the ${n}`);
        }
        if (st.cta.b > st.vh || st.cta.r > st.vw || st.cta.l < 0) wrong.push('button off screen');
      }
      if (st.note !== st.heroNote || !/now open/.test(st.note)) wrong.push(`"${st.note}" / "${st.heroNote}"`);
      if (Math.abs(st.row.t - before.t) > 1 || Math.abs((st.row.l + st.row.r) / 2 - (before.l + before.r) / 2) > 1) wrong.push('the row moved when pre-booking opened');
      if (st.overflowX) wrong.push('the page scrolls sideways');
      report(`${name}: once open, the hero's line and a Pre-book Gen2 button, in the same place`, !wrong.length, wrong.join('; '));
    }

    // Reduced motion: the same final frame.
    if (name === 'phone' || name === 'desktop') {
      await tab.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await tab.reload({ waitUntil: 'load' });
      await sleep(1500);
      await toHold(tab);
      st = await tab.evaluate(STATE);
      report(`${name}: reduced motion, the same final frame`, st.shown.every(Boolean) && st.rowShown, JSON.stringify({ shown: st.shown, row: st.rowShown }));
      await tab.emulateMediaFeatures([]);
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
