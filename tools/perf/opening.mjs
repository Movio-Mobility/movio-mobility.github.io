#!/usr/bin/env node
/*
 * The home page's opening on a first visit: how long until the headline lands, and whether
 * the particles move smoothly on the way there.
 *
 *   node tools/perf/opening.mjs                     the built site (dist/), every profile
 *   node tools/perf/opening.mjs --root . --runs 5   the sources, five cold loads each
 *   node tools/perf/opening.mjs --profiles low
 *   node tools/perf/opening.mjs --net fast          no network throttling (a phone on Wi-Fi):
 *                                                   three.js then arrives during the opening
 *   node tools/perf/opening.mjs --compile-ms 2500   the field's shaders report "still compiling"
 *                                                   for that long: a phone's first visit, with no
 *                                                   compiled shaders cached yet
 *
 * Each run is a first visit: empty cache, the profile's CPU and network throttling (the same
 * profiles as run.mjs). The opening runs on its own clock, which advances at most 1/20 s a
 * frame, so every stalled frame slows the whole sequence down and lands the headline late.
 * That is what this measures:
 *   reveal      ms from navigation to the headline's reveal (2.24 s of opening when nothing
 *               stalls, after the field's shaders are in)
 *   late        how much later than that the headline landed (time the opening lost to stalls)
 *   frames      the field's frame intervals from its first frame to the reveal: p50, p95, worst,
 *               and how many took longer than 50 ms
 *   stalls      long animation frames before the reveal, with the script that held each one up
 *   after       the same for the 2.5 s after it, while the headline comes in and the pod builds
 *
 * Chrome's throttling slows the main thread, not the GPU, so this finds what the page does on
 * the main thread during the opening. GPU-bound smoothness is for real devices and ?perf.
 */
import { serve } from '../serve.mjs';
import puppeteer from 'puppeteer-core';
import { CHROME, CHROME_ARGS, PROFILES } from './run.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ROOT = opt('root', 'dist');
const RUNS = Math.max(1, parseInt(opt('runs', '3'), 10) || 3);
const PROFILE_NAMES = opt('profiles', 'low,mid,high').split(',');
const PORT = parseInt(opt('port', '8093'), 10);
const FAST_NET = opt('net', '') === 'fast';
const COMPILE_MS = Math.max(0, parseInt(opt('compile-ms', '0'), 10) || 0);
const OPENING_MS = 2240; // at(3.2 * OPENING_SCALE) in index.html, with OPENING_SCALE 0.70

// Injected before the page's own scripts: records the field's frames, the reveal, and every
// long animation frame with the scripts that ran in it.
const PROBE = () => {
  const m = (window.__opening = { frames: [], live: 0, reveal: 0, loaf: [] });
  const tick = (now) => {
    if (!m.reveal || now - m.reveal < 2500) requestAnimationFrame(tick);
    // Read each frame: when this runs, the new document has no root element yet.
    const root = document.documentElement;
    if (root && root.classList.contains('gl-live')) {
      if (!m.live) m.live = now;
      m.frames.push(now);
    }
  };
  requestAnimationFrame(tick);
  new MutationObserver(() => {
    const h = document.querySelector('.headline');
    if (h && !m.reveal && h.classList.contains('is-revealed')) m.reveal = performance.now();
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const scripts = (e.scripts || [])
          .filter((s) => s.duration > 15)
          .map((s) => `${(s.sourceURL || '').split('/').pop().split('?')[0] || 'inline'}:${s.sourceFunctionName || s.invoker || '?'} ${Math.round(s.duration)}ms`);
        m.loaf.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), scripts });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch { /* older Chrome: no attribution */ }
};

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

async function once(browser, profile) {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (profile.net && !FAST_NET) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: profile.net.latency,
      downloadThroughput: profile.net.download, uploadThroughput: profile.net.upload,
    });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  if (profile.ua) await page.setUserAgent(profile.ua);
  await page.setViewport(profile.viewport);
  await page.evaluateOnNewDocument(PROBE);
  if (COMPILE_MS) {
    // KHR_parallel_shader_compile's COMPLETION_STATUS answers false until then, the way a driver
    // with nothing cached does while it compiles. Nothing else about the context changes.
    await page.evaluateOnNewDocument((ms) => {
      const real = WebGL2RenderingContext.prototype.getProgramParameter;
      WebGL2RenderingContext.prototype.getProgramParameter = function (program, pname) {
        if (pname === 0x91B1 && performance.now() < ms) return false;
        return real.call(this, program, pname);
      };
    }, COMPILE_MS);
  }
  // A fresh origin every run, so no service worker or storage carries over.
  await page.goto(`http://localhost:${PORT}/index.html?nosw`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__opening && window.__opening.reveal > 0, { timeout: 60000, polling: 100 });
  // The reveal starts the headline's own transition and lets the pod start building, so the
  // frames just after it count as much as the ones before.
  await new Promise((r) => setTimeout(r, 2800));
  const m = await page.evaluate(() => window.__opening);
  await page.close();

  const gaps = [];
  const gapsAfter = [];
  for (let i = 1; i < m.frames.length; i++) (m.frames[i] <= m.reveal ? gaps : gapsAfter).push(m.frames[i] - m.frames[i - 1]);
  const before = m.loaf.filter((l) => l.start < m.reveal);
  const after = m.loaf.filter((l) => l.start >= m.reveal && l.start < m.reveal + 2500);
  return {
    reveal: Math.round(m.reveal),
    live: Math.round(m.live),
    late: Math.round(m.reveal - m.live - OPENING_MS),
    p50: +pct(gaps, 0.5).toFixed(1),
    p95: +pct(gaps, 0.95).toFixed(1),
    worst: Math.round(Math.max(0, ...gaps)),
    over50: gaps.filter((g) => g > 50).length,
    stalls: before.filter((l) => l.start >= m.live - 1).sort((a, b) => b.dur - a.dur).slice(0, 4),
    afterP95: +pct(gapsAfter, 0.95).toFixed(1),
    afterWorst: Math.round(Math.max(0, ...gapsAfter)),
    afterOver50: gapsAfter.filter((g) => g > 50).length,
    afterStalls: after.sort((a, b) => b.dur - a.dur).slice(0, 4).map((l) => ({ ...l, start: Math.round(l.start - m.reveal) })),
    preLive: before.filter((l) => l.start < m.live).reduce((sum, l) => sum + l.dur, 0),
  };
}

const server = await serve({ root: ROOT, port: PORT, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
try {
  for (const name of PROFILE_NAMES) {
    const profile = PROFILES[name];
    if (!profile) continue;
    const results = [];
    for (let i = 0; i < RUNS; i++) results.push(await once(browser, profile));
    const med = (k) => pct(results.map((r) => r[k]), 0.5);
    console.log(`\n== ${name}${FAST_NET ? ', fast network' : ''}${COMPILE_MS ? `, shaders ${COMPILE_MS} ms` : ''} (${ROOT}, ${RUNS} cold loads)`);
    console.log(`reveal ${med('reveal')} ms   field live ${med('live')} ms   late ${med('late')} ms`
      + `   frames p50 ${med('p50')} p95 ${med('p95')} worst ${med('worst')}   >50ms ${med('over50')}`);
    console.log(`after the reveal (2.5 s): frames p95 ${med('afterP95')} worst ${med('afterWorst')}   >50ms ${med('afterOver50')}`);
    const worstRun = results.slice().sort((a, b) => b.late - a.late)[0];
    for (const s of worstRun.stalls) {
      console.log(`  stall ${s.dur} ms at ${s.start}: ${s.scripts.join(', ') || '(no script: style, layout, GPU or GC)'}`);
    }
    const worstAfter = results.slice().sort((a, b) => b.afterWorst - a.afterWorst)[0];
    for (const s of worstAfter.afterStalls) {
      console.log(`  after: stall ${s.dur} ms at reveal+${s.start}: ${s.scripts.join(', ') || '(no script: style, layout, GPU or GC)'}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}
