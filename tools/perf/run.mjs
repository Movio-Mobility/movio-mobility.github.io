#!/usr/bin/env node
/*
 * Page performance under three device profiles, measured the same way before and after a
 * change so the two runs can be compared line by line.
 *
 *   node tools/perf/run.mjs --label before --root <dir>      measure a copy of the site
 *   node tools/perf/run.mjs --label after                    measure the working copy
 *   node tools/perf/run.mjs --compare before after           print the two side by side
 *
 * Options: --pages index,journey  --profiles low,mid,high  --port 8090
 *
 * What it can and cannot see. Chrome's CPU throttling slows the page's main thread, so script,
 * style, layout and load costs scale the way they do on a slow phone. It does not slow the GPU,
 * and this Mac's GPU is far faster than any phone's, so GPU-bound smoothness has to be checked
 * on real devices (the ?perf overlay is there for that). Results land in tools/perf/results/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const RESULTS = path.join(HERE, 'results');
export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const CHROME_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--hide-scrollbars'];

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 12; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

export const PROFILES = {
  // A budget Android: small screen, slow cores, a congested 4G link.
  low: {
    viewport: { width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    ua: ANDROID_UA, cpu: 6,
    net: { latency: 150, download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8 },
  },
  // An office laptop: 1366x768 panel, an older quad-core, decent broadband.
  mid: {
    viewport: { width: 1366, height: 768, deviceScaleFactor: 1 },
    cpu: 4,
    net: { latency: 60, download: (9 * 1024 * 1024) / 8, upload: (1.5 * 1024 * 1024) / 8 },
  },
  // This class of machine: no throttling at all.
  high: {
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    cpu: 1,
    net: null,
  },
};

const PAGES = ['index', 'journey', 'store', 'powerpod-gen2', 'adapter', 'vehicle-dock', 'chargers', 'support', 'careers', 'dealers'];

// Injected before any page script runs: a passive frame probe plus the paint and long-frame
// observers. The probe is one extra rAF callback per frame, too cheap to move the numbers.
const PROBE = () => {
  const w = window;
  const m = (w.__perf = { frames: [], marking: false, loaf: [], longtasks: [], lcp: 0, fcp: 0, gpu: {}, gpuFrames: {} });

  // GPU time per frame for every WebGL2 canvas, from timer queries that bracket everything a
  // context does between one frame's start and the next. This callback is registered before
  // any page script, so it runs first in every frame.
  const contexts = [];
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = getContext.call(this, type, attrs);
    if (ctx && type === 'webgl2' && !contexts.some((c) => c.gl === ctx)) {
      const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
      if (ext) contexts.push({ gl: ctx, ext, name: this.id || 'canvas', active: null, pending: [] });
    }
    return ctx;
  };
  function sampleGpu() {
    for (const c of contexts) {
      const { gl, ext } = c;
      if (gl.isContextLost()) continue;
      if (c.active) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        c.pending.push([c.active, m.marking]);
        c.active = null;
      }
      while (c.pending.length && gl.getQueryParameter(c.pending[0][0], gl.QUERY_RESULT_AVAILABLE)) {
        const [q, marked] = c.pending.shift();
        if (marked && !gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          m.gpu[c.name] = (m.gpu[c.name] || 0) + ms;
          m.gpuFrames[c.name] = (m.gpuFrames[c.name] || 0) + 1;
        }
        gl.deleteQuery(q);
      }
      if (c.pending.length < 8) {
        c.active = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, c.active);
      }
    }
  }

  let last = 0;
  const tick = (now) => {
    if (m.marking && last) m.frames.push(now - last);
    last = now;
    try { sampleGpu(); } catch { /* a context mid-loss: skip this frame */ }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') m.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) m.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) m.longtasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (m.marking) m.loaf.push([e.duration, e.blockingDuration || 0]);
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    // observers missing in this Chrome: the frame probe still works
  }
};

// The interaction for each page, run inside the page. Scrolls with the main thread, one step
// per frame at a fixed speed, so a slow main thread shows up as a slow, stepped scroll.
const SCENARIOS = {
  // The whole film at a reading pace, with a hold on the lift ride (its animation keeps running).
  index: { idle: 1500, legs: [[0, 7.4, 0.55], ['hold', 2500], [7.4, 'end', 0.55]], cap: 40000 },
  journey: { idle: 1500, legs: [[0, 'end', 1.2]], cap: 22000 },
  default: { idle: 4000, legs: [[0, 'end', 1.0]], cap: 12000 },
};

async function scroll(page, scenario) {
  return page.evaluate(async ({ legs, cap, minMs }) => {
    // The product pages scroll inside their panel, not the window.
    const box = document.getElementById('pg2-scroll');
    const scroller = box && box.scrollHeight > box.clientHeight + 1 ? box : null;
    const vh = window.innerHeight;
    const getY = () => (scroller ? scroller.scrollTop : window.scrollY);
    // Instant: a container with scroll-behavior: smooth would otherwise animate every step.
    const setY = (y) => (scroller || window).scrollTo({ top: y, behavior: 'instant' });
    const end = () => Math.max(0, scroller ? scroller.scrollHeight - scroller.clientHeight : document.documentElement.scrollHeight - vh);
    const window_ = { scrollY: 0 };
    Object.defineProperty(window_, 'scrollY', { get: getY });
    const started = performance.now();
    for (const leg of legs) {
      if (leg[0] === 'hold') {
        await new Promise((r) => setTimeout(r, leg[1]));
        continue;
      }
      const [fromV, toV, speed] = leg;
      const drive = (from) => new Promise((resolve) => {
        setY(from);
        let last = 0;
        let pos = getY();
        let stuck = 0;
        const step = (now) => {
          const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
          last = now;
          const target = toV === 'end' ? end() : Math.min(end(), toV * vh);
          // Driven from our own position, not scrollY, so a page that holds the scroll in place
          // cannot hold the driver with it; stuck still ends the leg if nothing moves at all.
          pos = Math.min(target, pos + speed * vh * dt);
          const was = window_.scrollY;
          setY(pos);
          stuck = window_.scrollY <= was + 0.01 && dt > 0 ? stuck + 1 : 0;
          if (pos >= target - 0.5 || stuck > 90 || (cap && performance.now() - started > cap)) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      await drive(Math.min(end(), fromV * vh));
      // The footer's gate is the end of the page until the reader comes to rest against it
      // (see footer.js), so do what a reader does: stop, and scroll on into the footer once it
      // has opened.
      if (toV === 'end') {
        await new Promise((r) => setTimeout(r, 400));
        if (end() > getY() + 1 && !(cap && performance.now() - started > cap)) await drive(getY());
      }
    }
    // Short pages: keep measuring the page at rest until the window is long enough to mean
    // something (the field and any halo keep animating).
    const left = minMs - (performance.now() - started);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }, { legs: scenario.legs, cap: scenario.cap || 0, minMs: scenario.minMs || 6000 });
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function measure(browser, base, name, profileName) {
  const profile = PROFILES[profileName];
  // A fresh profile for every page: a first visit, with no service worker or cache left over
  // from the page measured before it.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const cdp = await page.createCDPSession();
  await page.setViewport(profile.viewport);
  if (profile.ua) await page.setUserAgent(profile.ua);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Performance.enable');
  if (profile.net) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: profile.net.latency,
      downloadThroughput: profile.net.download, uploadThroughput: profile.net.upload,
    });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });

  const bytes = { total: 0, js: 0, css: 0, font: 0, image: 0, other: 0 };
  const types = new Map();
  cdp.on('Network.responseReceived', (e) => types.set(e.requestId, e.type));
  cdp.on('Network.loadingFinished', (e) => {
    const t = (types.get(e.requestId) || 'Other').toLowerCase();
    const n = e.encodedDataLength || 0;
    bytes.total += n;
    if (t === 'script') bytes.js += n;
    else if (t === 'stylesheet') bytes.css += n;
    else if (t === 'font') bytes.font += n;
    else if (t === 'image') bytes.image += n;
    else bytes.other += n;
  });

  await page.evaluateOnNewDocument(PROBE);
  const t0 = Date.now();
  await page.goto(`${base}/${name}.html`, { waitUntil: 'load', timeout: 180000 });
  const loadMs = Date.now() - t0;
  const scenario = SCENARIOS[name] || SCENARIOS.default;
  await new Promise((r) => setTimeout(r, scenario.idle));

  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const before = await metrics();
  // LCP as a browser reports it: it stops at the reader's first scroll, so it is frozen here,
  // before the scripted one (which is programmatic and would not stop it).
  await page.evaluate(() => { window.__perf.lcpLoad = window.__perf.lcp; window.__perf.marking = true; });
  const tScroll = Date.now();
  await scroll(page, scenario);
  const scrollMs = Date.now() - tScroll;
  await page.evaluate(() => { window.__perf.marking = false; });
  const after = await metrics();
  const probe = await page.evaluate(() => window.__perf);

  const frames = probe.frames;
  const n = Math.max(1, frames.length);
  const delta = (k) => ((after[k] || 0) - (before[k] || 0)) * 1000;
  const loadLong = probe.longtasks.filter(([start]) => start < loadMs + scenario.idle);
  const result = {
    page: name, profile: profileName,
    fcp: Math.round(probe.fcp), lcp: Math.round(probe.lcpLoad), load: loadMs,
    tbt: Math.round(loadLong.reduce((s, [, d]) => s + Math.max(0, d - 50), 0)),
    kb: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, Math.round(v / 1024)])),
    scroll: {
      ms: scrollMs, frames: frames.length,
      fps: +(1000 / (frames.reduce((a, b) => a + b, 0) / n)).toFixed(1),
      p50: +pct(frames, 50).toFixed(1), p95: +pct(frames, 95).toFixed(1), p99: +pct(frames, 99).toFixed(1),
      // GPU time per frame on each canvas (bg = particle field, pod = the 3D PowerPod).
      gpu: Object.fromEntries(Object.entries(probe.gpu).map(([k, v]) => [k, +(v / Math.max(1, probe.gpuFrames[k])).toFixed(3)])),
      dropped: frames.filter((f) => f > 25).length,
      jank: +(100 * frames.filter((f) => f > 25).length / n).toFixed(1),
      loaf: probe.loaf.length,
      loafBlocking: Math.round(probe.loaf.reduce((s, [, b]) => s + b, 0)),
      // Main-thread time per rendered frame, by kind (ms, at the profile's CPU slowdown).
      perFrame: {
        task: +(delta('TaskDuration') / n).toFixed(2),
        script: +(delta('ScriptDuration') / n).toFixed(2),
        style: +(delta('RecalcStyleDuration') / n).toFixed(2),
        layout: +(delta('LayoutDuration') / n).toFixed(2),
      },
    },
  };
  await context.close();
  return result;
}

function table(rows, label) {
  const lines = [`\n${label}`,
    'page            prof  FCP    LCP    TBT   KB(js)      fps   p95   jank%  task/f  script/f style/f layout/f  gpu ms/f'];
  for (const r of rows) {
    lines.push([
      r.page.padEnd(15), r.profile.padEnd(5), String(r.fcp).padStart(5), String(r.lcp).padStart(6),
      String(r.tbt).padStart(6), `${r.kb.total}(${r.kb.js})`.padStart(11), String(r.scroll.fps).padStart(6),
      String(r.scroll.p95).padStart(6), String(r.scroll.jank).padStart(6), String(r.scroll.perFrame.task).padStart(7),
      String(r.scroll.perFrame.script).padStart(8), String(r.scroll.perFrame.style).padStart(7), String(r.scroll.perFrame.layout).padStart(8),
      `  ${Object.entries(r.scroll.gpu || {}).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    ].join(' '));
  }
  return lines.join('\n');
}

function compare(a, b) {
  const A = JSON.parse(fs.readFileSync(path.join(RESULTS, `${a}.json`), 'utf8'));
  const B = JSON.parse(fs.readFileSync(path.join(RESULTS, `${b}.json`), 'utf8'));
  const key = (r) => `${r.page}/${r.profile}`;
  const byKey = new Map(B.map((r) => [key(r), r]));
  const out = ['page/profile            FCP          LCP          TBT          KB           fps          p95 ms       jank %       main ms/f    style ms/f   gpu bg ms/f  gpu pod ms/f'];
  const cell = (x, y) => `${x}→${y}`.padEnd(12);
  for (const r of A) {
    const s = byKey.get(key(r));
    if (!s) continue;
    out.push([key(r).padEnd(23), cell(r.fcp, s.fcp), cell(r.lcp, s.lcp), cell(r.tbt, s.tbt), cell(r.kb.total, s.kb.total),
      cell(r.scroll.fps, s.scroll.fps), cell(r.scroll.p95, s.scroll.p95), cell(r.scroll.jank, s.scroll.jank),
      cell(r.scroll.perFrame.task, s.scroll.perFrame.task), cell(r.scroll.perFrame.style, s.scroll.perFrame.style),
      cell((r.scroll.gpu || {}).bg ?? '-', (s.scroll.gpu || {}).bg ?? '-'), cell((r.scroll.gpu || {}).pod ?? '-', (s.scroll.gpu || {}).pod ?? '-')].join(' '));
  }
  console.log(out.join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  if (args.includes('--compare')) {
    const i = args.indexOf('--compare');
    compare(args[i + 1], args[i + 2]);
    return;
  }
  const label = opt('label', 'run');
  const root = path.resolve(opt('root', REPO));
  const port = Number(opt('port', 8090));
  const pages = opt('pages', PAGES.join(',')).split(',');
  const profiles = opt('profiles', 'low,mid,high').split(',');

  const server = await serve({ root, port, quiet: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS, protocolTimeout: 600000 });
  const rows = [];
  try {
    for (const profile of profiles) {
      for (const name of pages) {
        try {
          const r = await measure(browser, `http://localhost:${port}`, name, profile);
          rows.push(r);
          console.log(`${name}/${profile}: fps ${r.scroll.fps}, p95 ${r.scroll.p95}ms, jank ${r.scroll.jank}%, main ${r.scroll.perFrame.task}ms/frame, gpu ${JSON.stringify(r.scroll.gpu)}, LCP ${r.lcp}ms, ${r.kb.total}KB`);
        } catch (err) {
          console.warn(`${name}/${profile} failed: ${err.message}`);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `${label}.json`);
  let all = rows;
  if (args.includes('--merge') && fs.existsSync(file)) {
    // Re-measured pages replace their old rows; everything else is kept.
    const fresh = new Set(rows.map((r) => `${r.page}/${r.profile}`));
    all = JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => !fresh.has(`${r.page}/${r.profile}`)).concat(rows);
  }
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  console.log(table(rows, `${label} (${root})`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
