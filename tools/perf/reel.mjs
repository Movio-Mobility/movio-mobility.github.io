#!/usr/bin/env node
/*
 * Frames of the site at fixed moments, from two copies side by side, so a change can be
 * checked by eye and, where the picture is deterministic, by pixel.
 *
 *   node tools/perf/reel.mjs --before <dir> [--after <dir>] [--page index] [--out <dir>]
 *
 * Time is virtual. requestAnimationFrame and performance.now are replaced before the page
 * runs, Math.random is seeded, and the harness steps frames itself, so both copies reach each
 * moment through exactly the same sequence of frames. Per shot it writes:
 *   <shot>-full.png  before | after, the page as a reader sees it
 *   <shot>-pod.png   before | after | difference, the 3D pod on its own (field hidden)
 * and prints how far apart the pod frames are (they are expected to match exactly).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from './run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const beforeDir = path.resolve(opt('before', REPO));
const afterDir = path.resolve(opt('after', REPO));
const page = opt('page', 'index');
const outDir = path.resolve(opt('out', path.join(HERE, 'reel')));
const viewports = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const which = opt('viewports', 'desktop,phone').split(',');
// Query strings for each side, e.g. --query-after "perf&level=3" to see a governor step.
const queryBefore = opt('query-before', '');
const queryAfter = opt('query-after', '');
const shotsWanted = opt('shots', '');

// Film positions (viewports down the home page) worth looking at, from index.html's beats.
const SHOTS = page === 'index'
  ? [['hero', 0], ['haze', 0.55], ['reveal', 1.0], ['grip', 2.4], ['hand-held', 2.74], ['hand-lift', 3.02], ['hand-gone', 3.4],
    ['overhead', 3.6], ['dock', 5.0],
    ['lift-wait', 6.1], ['lift-walk', 6.75], ['ride', 7.35], ['app', 8.6], ['warranty', 10.7], ['footer', 13.5]]
  : [['top', 0], ['middle', 0.5], ['bottom', 1]];

const VIRTUAL = (seed) => {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // The pod's grain texture is Math.random noise, drawn into a fresh ImageData. Restart the
  // sequence there, so both copies make the same noise however many random numbers other
  // scripts drew before it (the newer page builds the pod later, after more of them).
  const createImageData = CanvasRenderingContext2D.prototype.createImageData;
  CanvasRenderingContext2D.prototype.createImageData = function (...args) {
    a = seed >>> 0;
    return createImageData.apply(this, args);
  };
  let T = 1000;
  const queue = new Map();
  let next = 1;
  window.requestAnimationFrame = (cb) => { const id = next++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
  performance.now = () => T;
  window.__frames = 0;
  // Whether the pod's loop is running: its callback is the one named `loop` in the queue.
  window.__podLoop = () => [...queue.values()].some((cb) => cb.name === 'loop');
  window.__advance = (n, step = 1000 / 60) => {
    for (let i = 0; i < n; i++) {
      T += step;
      window.__frames++;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) {
        try { cb(T); } catch (err) { console.error(err && err.stack || err); }
      }
    }
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(browser, base, vpName, query) {
  const tab = await browser.newPage();
  await tab.setViewport(viewports[vpName]);
  const errors = [];
  tab.on('pageerror', (e) => errors.push(e.message));
  tab.on('console', (m) => { if (m.type() === 'error' && !/localhost:3000|ERR_CONNECTION|favicon|404/.test(m.text())) errors.push(m.text()); });
  await tab.evaluateOnNewDocument(VIRTUAL, 1234);
  await tab.goto(`${base}/${page}.html${query ? `?${query}` : ''}`, { waitUntil: 'load' });
  await sleep(800); // shaders compile in real time, before the first virtual frame
  // The opening, then wait (in real time) for the pod to finish building, stepping a frame at a
  // time so its loop can start.
  await tab.evaluate(() => window.__advance(300));
  // Waited for in real time, without stepping frames, so both copies are on the same frame
  // when the shots start however long the pod took to build.
  for (let i = 0; i < 200; i++) {
    const ready = await tab.evaluate(() => !document.getElementById('pod') || window.__podLoop());
    if (ready) break;
    await sleep(100);
  }
  const shots = [];
  for (const [name, at] of SHOTS.filter(([n]) => !shotsWanted || shotsWanted.split(',').includes(n))) {
    await tab.evaluate((at, isFilm) => {
      // The footer's gate holds the page short of the credits until it opens; an End key press
      // is the explicit jump it always honours (see footer.js).
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
      const max = document.documentElement.scrollHeight - window.innerHeight;
      // The film is laid out in large-viewport heights (vh): the same unit on both copies.
      const vh = document.getElementById('bg') ? document.getElementById('bg').clientHeight || window.innerHeight : window.innerHeight;
      window.scrollTo({ top: isFilm ? Math.min(max, at * vh) : at * max, behavior: 'instant' });
    }, at, page === 'index');
    await sleep(60);
    await tab.evaluate(() => window.__advance(150)); // 2.5 s for the camera and field to settle
    await sleep(1200);                               // CSS transitions run on real time
    await tab.evaluate(() => window.__advance(2));
    const full = Buffer.from(await tab.screenshot({ type: 'png' }));
    // The pod alone: hide the field and the page around it.
    await tab.addStyleTag({ content: '#bg, .topbar, .film, .hero, .credits, main > :not(#pod) { visibility: hidden !important; } html, body { background: #000 !important; }' });
    await tab.evaluate(() => window.__advance(2));
    const pod = page === 'index' ? Buffer.from(await tab.screenshot({ type: 'png' })) : null;
    await tab.evaluate(() => {
      const tags = document.querySelectorAll('style');
      tags[tags.length - 1].remove();
      window.__advance(2);
    });
    shots.push({ name, full, pod });
  }
  await tab.close();
  return { shots, errors };
}

function sideBySide(images, gap = 8) {
  const pngs = images.map((b) => PNG.sync.read(b));
  const w = pngs.reduce((s, p) => s + p.width, 0) + gap * (pngs.length - 1);
  const h = Math.max(...pngs.map((p) => p.height));
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  let x = 0;
  for (const p of pngs) {
    PNG.bitblt(p, out, 0, 0, p.width, p.height, x, 0);
    x += p.width + gap;
  }
  return PNG.sync.write(out);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const servers = [await serve({ root: beforeDir, port: 8101, quiet: true }), await serve({ root: afterDir, port: 8102, quiet: true })];
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS, protocolTimeout: 600000 });
  let worst = 0;
  try {
    for (const vp of which) {
      const a = await capture(browser, 'http://localhost:8101', vp, queryBefore);
      const b = await capture(browser, 'http://localhost:8102', vp, queryAfter);
      for (const e of a.errors) console.log(`  before error: ${e}`);
      for (const e of b.errors) console.log(`  after error: ${e}`);
      for (let i = 0; i < a.shots.length; i++) {
        const sa = a.shots[i];
        const sb = b.shots[i];
        fs.writeFileSync(path.join(outDir, `${page}-${vp}-${String(i).padStart(2, '0')}-${sa.name}-full.png`), sideBySide([sa.full, sb.full]));
        let note = '';
        if (sa.pod && sb.pod) {
          const pa = PNG.sync.read(sa.pod);
          const pb = PNG.sync.read(sb.pod);
          const diff = new PNG({ width: pa.width, height: pa.height });
          const n = pixelmatch(pa.data, pb.data, diff.data, pa.width, pa.height, { threshold: 0.0, includeAA: true });
          const share = n / (pa.width * pa.height);
          worst = Math.max(worst, share);
          note = `pod pixels differing: ${n} (${(share * 100).toFixed(3)}%)`;
          fs.writeFileSync(path.join(outDir, `${page}-${vp}-${String(i).padStart(2, '0')}-${sa.name}-pod.png`), sideBySide([sa.pod, sb.pod, PNG.sync.write(diff)]));
        }
        console.log(`${vp} ${sa.name}: ${note}`);
      }
    }
  } finally {
    await browser.close();
    servers.forEach((s) => s.close());
  }
  console.log(`frames written to ${outDir}`);
}

main();
