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
 *   node tools/perf/opening.mjs --cold --profiles high
 *                                                   a first visit as the GPU sees it: see COLD
 *   node tools/perf/opening.mjs --cold --until 13000  and watch until 13 s after navigation (the
 *                                                   riders arrive about 11 s in)
 *
 * Each run is a first visit: empty cache, the profile's CPU and network throttling (the same
 * profiles as run.mjs). The opening runs on its own clock, which advances at most 1/20 s a
 * frame, so every stalled frame slows the whole sequence down and lands the headline late.
 * That is what this measures:
 *   reveal      ms from navigation to the headline's reveal (2.24 s of opening when nothing
 *               stalls, after the field's shaders are in)
 *   late        how much later than that the headline landed (time the opening lost to stalls)
 *   frames      the field's frame intervals from the lights coming up (its first frame, on a
 *               page that does not say when that is) to the reveal: p50, p95, worst, and how
 *               many took longer than 50 ms
 *   stalls      long animation frames from the lights coming up to the reveal, with the script
 *               that held each one up
 *   after       the same for the 2.5 s after it, while the headline comes in and the pod builds
 *
 * Chrome's throttling slows the main thread, not the GPU, so this finds what the page does on
 * the main thread during the opening. GPU-bound smoothness is for real devices and ?perf.
 *
 * COLD. The worst of a first visit is invisible to all of the above. The first time a shader
 * program is linked, and again the first time it is drawn, the driver compiles it, and in
 * Chrome that work runs on the GPU process's main thread, which also puts every frame on
 * screen: the screen freezes while the page's own clock, and its animation frames, carry on
 * as if nothing happened. And on the machine running this it never happens at all, because
 * the GPU's compiler caches what it has compiled once, across browsers and across runs. So
 * --cold starts a fresh browser for every run with Chrome's shader cache off, and gives every
 * shader the page compiles a uniform of its own, named for that run, so nothing it compiles
 * can be found in any cache. Then it records a trace and counts the frames the GPU process
 * actually presented (macOS: ImageTransportSurfaceOverlayMac::Present):
 *   dark        ms the opening spent on its dark stage before the lights came up (the field's
 *               shaders, and anything else that asked it to wait: gridBG.hold)
 *   frozen      every gap over 25 ms between two presented frames once the lights are up, to
 *               2.5 s after the reveal (or --until): the stutter a first-time reader sees
 * A gap on the dark stage is not counted: there is nothing lit to see stop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const COLD = args.includes('--cold');
const UNTIL = Math.max(0, parseInt(opt('until', '0'), 10) || 0);
const LIGHTS_UP_MS = 105; // play('exposure', 1, 1.6, 0.15) in index.html, times OPENING_SCALE
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
    // The first frame with the lights up (gridBG.dark, where the page has it).
    const bg = window.gridBG;
    if (!m.lit && bg && 'dark' in bg && !bg.dark) m.lit = now;
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

// --cold: every shader source the page hands WebGL gets a uniform named for this run, read in
// a branch that never runs, so it compiles to the same picture but matches nothing cached.
const SALT = (run) => {
  let n = 0;
  const proto = WebGL2RenderingContext.prototype;
  // Each shader's stage, as it was asked for (a transform feedback pass's vertex shader need not
  // write a position, so the source alone does not say).
  const stages = new WeakMap();
  const create = proto.createShader;
  proto.createShader = function (type) {
    const shader = create.call(this, type);
    if (shader) stages.set(shader, type);
    return shader;
  };
  const real = proto.shaderSource;
  proto.shaderSource = function (shader, source) {
    n++;
    const name = `uColdRun${run}x${n}`;
    const vertex = stages.get(shader) === this.VERTEX_SHADER;
    const guard = vertex ? `if (${name} > 1e30) return;` : `if (${name} > 1e30) discard;`;
    let out = source.replace(/void\s+main\s*\(\s*(void)?\s*\)\s*\{/, (m) => `${m}\n${guard}`);
    const decl = `uniform float ${name};\n`;
    // After the last precision statement, or the #version line, so the declaration is legal.
    const precisions = [...out.matchAll(/precision\s+\w+\s+\w+\s*;[^\n]*\n/g)];
    if (precisions.length) {
      const last = precisions[precisions.length - 1];
      const at = last.index + last[0].length;
      out = out.slice(0, at) + decl + out.slice(at);
    } else if (/^#version[^\n]*\n/.test(out)) {
      out = out.replace(/^(#version[^\n]*\n)/, `$1${decl}`);
    } else {
      out = decl + out;
    }
    return real.call(this, shader, out);
  };
};

// Gaps between frames the GPU process presented, from a trace, in ms since navigation.
function presentedGaps(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = raw.traceEvents || raw;
  const nav = events
    .filter((e) => e.name === 'navigationStart' && e.args && e.args.data && /localhost/.test(e.args.data.documentLoaderURL || ''))
    .sort((a, b) => a.ts - b.ts)[0];
  if (!nav) return [];
  const presents = events
    .filter((e) => e.name === 'ImageTransportSurfaceOverlayMac::Present' && e.ph === 'X')
    .map((e) => (e.ts - nav.ts) / 1000)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < presents.length; i++) gaps.push({ at: presents[i - 1], gap: presents[i] - presents[i - 1] });
  return gaps;
}

async function once(shared, profile, run) {
  // Cold: a browser of its own, with Chrome's shader cache off, for every run.
  const browser = COLD
    ? await puppeteer.launch({ executablePath: CHROME, headless: true, args: [...CHROME_ARGS, '--disable-gpu-shader-disk-cache'] })
    : shared;
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
  const traceFile = COLD ? path.join(os.tmpdir(), `gridx-opening-${process.pid}-${run}.json`) : null;
  if (COLD) {
    await page.evaluateOnNewDocument(SALT, `${Date.now().toString(36)}${run}`);
    await page.tracing.start({ path: traceFile, categories: ['-*', 'gpu', 'blink.user_timing', 'devtools.timeline'] });
  }
  // A fresh origin every run, so no service worker or storage carries over.
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/index.html?nosw`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__opening && window.__opening.reveal > 0, { timeout: 60000, polling: 100 });
  // The reveal starts the headline's own transition and lets the pod start building, so the
  // frames just after it count as much as the ones before.
  await new Promise((r) => setTimeout(r, 2800));
  if (UNTIL) await new Promise((r) => setTimeout(r, Math.max(0, UNTIL + 300 - (Date.now() - t0))));
  const m = await page.evaluate(() => window.__opening);
  if (!m.live) throw new Error('the field never went live (no WebGL2, or its shaders failed): nothing here would mean anything');
  let frozen = null;
  if (COLD) {
    await page.tracing.stop();
    const lit = m.lit || m.live;
    const end = UNTIL || m.reveal + 2500;
    frozen = presentedGaps(traceFile).filter((g) => g.gap > 25 && g.at >= lit && g.at < end);
    fs.unlinkSync(traceFile);
  }
  await page.close();
  if (COLD) await browser.close();

  const gaps = [];
  const gapsAfter = [];
  const from = m.lit || m.live;
  for (let i = 1; i < m.frames.length; i++) {
    if (m.frames[i - 1] < from) continue; // the dark stage: nothing lit to see stop
    (m.frames[i] <= m.reveal ? gaps : gapsAfter).push(m.frames[i] - m.frames[i - 1]);
  }
  const before = m.loaf.filter((l) => l.start < m.reveal);
  const after = m.loaf.filter((l) => l.start >= m.reveal && l.start < m.reveal + 2500);
  return {
    reveal: Math.round(m.reveal),
    live: Math.round(m.live),
    // Counted from the lights coming up where the page says when that was: the dark stage can be
    // held on purpose (gridBG.hold), and holding it costs the opening nothing once it plays.
    late: Math.round(m.lit ? m.reveal - m.lit - (OPENING_MS - LIGHTS_UP_MS) : m.reveal - m.live - OPENING_MS),
    dark: m.lit ? Math.round(m.lit - m.live) : null,
    frozen,
    p50: +pct(gaps, 0.5).toFixed(1),
    p95: +pct(gaps, 0.95).toFixed(1),
    worst: Math.round(Math.max(0, ...gaps)),
    over50: gaps.filter((g) => g > 50).length,
    stalls: before.filter((l) => l.start >= from - 1).sort((a, b) => b.dur - a.dur).slice(0, 4),
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
    for (let i = 0; i < RUNS; i++) results.push(await once(browser, profile, i));
    const med = (k) => pct(results.map((r) => r[k]), 0.5);
    console.log(`\n== ${name}${FAST_NET ? ', fast network' : ''}${COMPILE_MS ? `, shaders ${COMPILE_MS} ms` : ''}${COLD ? ', cold GPU' : ''} (${ROOT}, ${RUNS} cold loads)`);
    if (COLD) {
      results.forEach((r, i) => {
        const total = r.frozen.reduce((sum, f) => sum + f.gap, 0);
        const worst = Math.max(0, ...r.frozen.map((f) => f.gap));
        console.log(`run ${i + 1}: dark ${r.dark === null ? '?' : r.dark} ms   frozen ${r.frozen.length}x, ${Math.round(total)} ms in all, worst ${Math.round(worst)} ms`
          + (r.frozen.length ? `   at ${r.frozen.map((f) => `${Math.round(f.at)} (${Math.round(f.gap)})`).join(', ')}` : ''));
      });
    }
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
