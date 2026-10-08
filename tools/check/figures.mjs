#!/usr/bin/env node
/*
 * How bright the home film's particle drawings read (the hand on the grip, the dock and its
 * scooter, the woman and the lift), on each screen size.
 *
 *   node tools/check/figures.mjs                   the working copy: desktop, tablet and phone
 *   node tools/check/figures.mjs --root dist       the built site
 *   node tools/check/figures.mjs --only phone
 *   node tools/check/figures.mjs --save <dir>      also write each frame there, for a look by eye
 *
 * The film is stepped on a virtual clock (as tools/check/hand.mjs does) to a point in each
 * scene and left to settle, then the field's own canvas is read back in the frame it was drawn,
 * so the pod above it never gets into the measurement. The drawings are light added over a
 * studio that changes slowly across the frame, so the studio is estimated by blurring the frame
 * and the drawing is what stands above it. Reported per scene:
 *   stroke   how far the brightest part of the drawing stands above the studio (the 99.7th
 *            percentile of that excess, in 8-bit levels): how bright a line looks
 *   body     the mean excess over the pixels that make up the drawing: how solid it looks
 *   pixels   how many CSS pixels stand out at all (a sparser drawing has fewer)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ROOT = path.resolve(REPO, opt('root', '.'));
const PORT = parseInt(opt('port', '8097'), 10);
const ONLY = opt('only', '');
const SAVE = opt('save', '');

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
// Film positions, in viewport heights of scroll (the beats in index.html).
const SCENES = [
  ['hand on the grip', 2.95],
  ['dock and scooter', 5.2],
  ['her, at the lift', 6.4],
  ['the ride', 7.3],
];

// The page's clock, made virtual and deterministic, as in tools/check/hand.mjs.
const VIRTUAL = (seed) => {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let T = 1000;
  const queue = new Map();
  let next = 1;
  window.requestAnimationFrame = (cb) => { const id = next++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
  performance.now = () => T;
  window.__podLoop = () => [...queue.values()].some((cb) => cb.name === 'loop');
  window.__advance = (n) => {
    for (let i = 0; i < n; i++) {
      T += 1000 / 60;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) {
        try { cb(T); } catch (err) { console.error(err && err.stack || err); }
      }
    }
  };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Luminance, the studio under it (a wide box blur, run twice), and what stands above it.
function measure(png) {
  const { width: w, height: h, data } = png;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  const blur = (src, r) => {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s / (2 * r + 1);
        s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / (2 * r + 1);
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  };
  const r = Math.max(6, Math.round(Math.min(w, h) * 0.03));
  const studio = blur(blur(L, r), r);
  const excess = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) excess[i] = Math.max(0, L[i] - studio[i]);
  const sorted = Float32Array.from(excess).sort();
  const stroke = sorted[Math.floor(sorted.length * 0.997)];
  let n = 0;
  let sum = 0;
  for (let i = 0; i < excess.length; i++) {
    if (excess[i] > 4) {
      n++;
      sum += excess[i];
    }
  }
  return { stroke: +stroke.toFixed(1), body: +(n ? sum / n : 0).toFixed(1), pixels: n };
}

const server = await serve({ root: ROOT, port: PORT, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
try {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    if (ONLY && !ONLY.split(',').includes(name)) continue;
    const tab = await browser.newPage();
    await tab.setViewport(viewport);
    await tab.evaluateOnNewDocument(VIRTUAL, 1234);
    await tab.goto(`http://localhost:${PORT}/index.html?check&nosw`, { waitUntil: 'load' });
    await sleep(800);
    await tab.evaluate(() => window.__advance(300));
    for (let i = 0; i < 200 && !(await tab.evaluate(() => window.__podLoop())); i++) {
      await sleep(100);
      await tab.evaluate(() => window.__advance(1));
    }
    console.log(`\n== ${name} ${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}`);
    for (const [label, at] of SCENES) {
      await tab.evaluate((t) => {
        const vh = document.getElementById('bg').clientHeight || innerHeight;
        window.scrollTo({ top: t * vh, behavior: 'instant' });
      }, at);
      await sleep(60);
      await tab.evaluate(() => window.__advance(180));
      await sleep(600);
      // Drawn and read back in one task, before the frame is handed to the compositor.
      const url = await tab.evaluate(() => {
        window.__advance(1);
        return document.getElementById('bg').toDataURL('image/png');
      });
      const bytes = Buffer.from(url.split(',')[1], 'base64');
      const png = PNG.sync.read(bytes);
      if (SAVE) {
        fs.mkdirSync(SAVE, { recursive: true });
        fs.writeFileSync(path.join(SAVE, `${name}-${label.replace(/[^a-z]+/gi, '-').replace(/-$/, '')}.png`), bytes);
      }
      const m = measure(png);
      console.log(`${label.padEnd(18)} stroke ${String(m.stroke).padStart(5)}   body ${String(m.body).padStart(5)}   pixels ${m.pixels}  (${png.width}x${png.height})`);
    }
    await tab.close();
  }
} finally {
  await browser.close();
  server.close();
}
