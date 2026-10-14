#!/usr/bin/env node
/*
 * Regression sweep: the situations that only show up off the happy path.
 *   node tools/check/sweep.mjs [--root dir]
 *
 *   reduced motion · no WebGL2 · the footer's night · accessory flow → Razorpay on demand ·
 *   the journey lightbox · rotating a phone · hiding and showing the tab · losing and
 *   restoring both WebGL contexts · opening the pages straight from disk (file://) · the Gen2
 *   pod's still, in every one of those that has it
 *
 * Each check prints PASS or FAIL with what it saw; page errors fail the check they happen in.
 */
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--root');
const root = path.resolve(i >= 0 ? args[i + 1] : '.');
const port = 8120;
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IGNORE = /localhost:3000|ERR_CONNECTION_REFUSED|favicon|status of 404|razorpay|ERR_BLOCKED_BY_ORB/i;

const server = await serve({ root, port, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS, protocolTimeout: 300000 });
let failed = 0;

async function open(name, { viewport = { width: 1440, height: 900, deviceScaleFactor: 2 }, before } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); });
  if (before) await before(page);
  await page.goto(`${base}/${name}.html`, { waitUntil: 'load' });
  return { page, errors };
}

function report(label, ok, detail, errors = []) {
  const pass = ok && !errors.length;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: ${detail}${errors.length ? `\n      errors: ${errors.join(' | ')}` : ''}`);
}

// A frame of a canvas is "drawn" if a screenshot of its box has more than one colour in it.
async function canvasDrawn(page, id) {
  const el = await page.$(`#${id}`);
  if (!el) return false;
  const shot = await el.screenshot({ type: 'png', encoding: 'base64' }).catch(() => '');
  return shot.length > 2000;
}

// The Gen2 page's pod is a still (tools/source/pod-stills.mjs): loaded and in focus. No
// WebGL, no reduced motion, no server: it is there all the same.
const STAND_SHOWN = () => {
  const img = document.querySelector('#pg2-pod-stand img');
  if (!img) return 'n/a';
  const cs = getComputedStyle(img);
  const box = img.getBoundingClientRect();
  return img.complete && img.naturalWidth > 0 && cs.opacity === '1' && cs.filter === 'none'
    && cs.visibility === 'visible' && box.height > 100;
};

// 1. Reduced motion: the field slows and stops gathering, the film is a set of product shots.
for (const name of ['index', 'journey', 'store', 'powerpod-gen2']) {
  const { page, errors } = await open(name, { before: (p) => p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]) });
  await sleep(3000);
  if (name === 'index') {
    await page.evaluate(() => window.scrollTo({ top: innerHeight * 2.4, behavior: 'instant' }));
    await sleep(2500);
  }
  const st = await page.evaluate((shown) => ({
    gl: document.documentElement.classList.contains('gl-live'),
    pod: document.getElementById('pod') ? document.getElementById('pod').style.opacity : 'n/a',
    stand: (0, eval)(`(${shown})`)(),
  }), STAND_SHOWN.toString());
  report(`reduced motion ${name}`, st.gl && (name !== 'index' || parseFloat(st.pod) > 0.5)
    && (name !== 'powerpod-gen2' || st.stand === true), JSON.stringify(st), errors);
  await page.close();
}

// 2. No WebGL2: the CSS studio, and every page still works.
for (const name of ['index', 'journey', 'store', 'powerpod-gen2', 'support']) {
  const { page, errors } = await open(name, {
    before: (p) => p.evaluateOnNewDocument(() => {
      delete window.WebGL2RenderingContext;
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        return type === 'webgl2' ? null : get.call(this, type, attrs);
      };
    }),
  });
  await sleep(2500);
  const st = await page.evaluate((shown) => ({
    gl: document.documentElement.classList.contains('gl'),
    bg: getComputedStyle(document.getElementById('bg')).display,
    htmlBg: getComputedStyle(document.documentElement).backgroundImage.slice(0, 15),
    stand: (0, eval)(`(${shown})`)(),
  }), STAND_SHOWN.toString());
  report(`no WebGL2 ${name}`, !st.gl && st.bg === 'none' && st.htmlBg.startsWith('radial')
    && (name !== 'powerpod-gen2' || st.stand === true), JSON.stringify(st), errors);
  await page.close();
}

// 3. The footer's night: the chrome recedes with the room, the status bar goes dark, and on the
//    home page the pod goes out with it.
for (const name of ['journey', 'index', 'careers']) {
  const { page, errors } = await open(name);
  await sleep(name === 'index' ? 4000 : 1500);
  // Past the gate: an End key press is the explicit jump the gate always honours.
  await page.keyboard.press('End');
  await sleep(600);
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await sleep(3000);
  // The bar itself never dims (its glass reads the page through it, see site.css): its parts
  // do, the logo (in its lockup on inner pages) and the island.
  const partsOpacity = () => Math.max(...['.topbar > .brand-lockup', '.topbar > .brand', '.topbar > .island-wrap']
    .map((sel) => document.querySelector(sel)).filter(Boolean).map((el) => parseFloat(getComputedStyle(el).opacity)));
  const st = await page.evaluate((partsOpacity) => ({
    night: window.gridNight ? +window.gridNight.value.toFixed(3) : null,
    topbarNight: document.querySelector('.topbar').style.getPropertyValue('--night'),
    topbarOpacity: getComputedStyle(document.querySelector('.topbar')).opacity,
    partsOpacity: (0, eval)(`(${partsOpacity})`)(),
    theme: document.querySelector('meta[name="theme-color"]').content,
    isNight: document.documentElement.classList.contains('is-night'),
    pod: document.getElementById('pod') ? document.getElementById('pod').style.opacity : 'n/a',
    rootNight: document.documentElement.style.getPropertyValue('--night'),
  }), partsOpacity.toString());
  const ok = st.night > 0.95 && parseFloat(st.topbarOpacity) === 1 && st.partsOpacity < 0.06 && st.theme === '#0b0b0a' && st.isNight
    && st.rootNight === '' && (name !== 'index' || parseFloat(st.pod) < 0.06);
  report(`footer night ${name}`, ok, JSON.stringify(st), errors);
  // And back up: the lights come back.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(2500);
  const back = await page.evaluate((partsOpacity) => ({
    night: window.gridNight ? +window.gridNight.value.toFixed(3) : null,
    partsOpacity: (0, eval)(`(${partsOpacity})`)(),
  }), partsOpacity.toString());
  report(`footer lights back ${name}`, back.night < 0.05 && back.partsOpacity > 0.9, JSON.stringify(back), errors);
  await page.close();
}

// 3b. The footer's gate: a throw to the end of the page stops where the footer begins, with the
//     lights still up; at rest the gate opens, the next throw goes in, and back up it closes.
for (const name of ['journey', 'store']) {
  const { page, errors } = await open(name);
  // Journey is a single screen until its tape has run and today's year opens.
  if (name === 'journey') await page.waitForSelector('.journey.is-open', { timeout: 20000 }).catch(() => {});
  await sleep(1500);
  const throwToEnd = () => page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  const read = () => page.evaluate(() => {
    const credits = document.querySelector('.credits');
    const stop = credits.getBoundingClientRect().top + window.scrollY - window.innerHeight;
    return {
      y: Math.round(window.scrollY),
      stop: Math.round(stop),
      gated: credits.classList.contains('is-gated'),
      night: window.gridNight ? +window.gridNight.value.toFixed(3) : null,
    };
  });
  await throwToEnd();
  await sleep(100);
  const held = await read();
  await sleep(600);
  const opened = await read();
  await throwToEnd();
  await sleep(3000);
  const inside = await read();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(600);
  const closed = await read();
  const ok = held.gated && Math.abs(held.y - held.stop) <= 2 && held.night === 0
    && !opened.gated && inside.y > inside.stop && inside.night > 0.95 && closed.gated;
  report(`footer gate ${name}`, ok, JSON.stringify({ held, opened, inside, closed }), errors);
  await page.close();
}

// 4. Buying an accessory: Razorpay's script is fetched on the first touch of the panel,
//    never with the page, and the Buy button walks the staged flow in place: no dialog
//    anywhere (the order sheet it replaced was one).
{
  const { page, errors } = await open('adapter');
  const requested = [];
  page.on('request', (r) => { if (/checkout\.razorpay\.com\/v1\/checkout\.js/.test(r.url())) requested.push(r.url()); });
  await sleep(2500);
  const atLoad = requested.length;
  await page.click('#pg2-panel').catch(() => {});
  await sleep(1500);
  const afterTouch = requested.length;
  await page.evaluate(() => document.getElementById('product-buy').click());
  await sleep(800);
  const st = await page.evaluate(() => ({
    stage2: Boolean(document.querySelector('.pg2-view[data-stage="2"].is-active')),
    stage1: Boolean(document.querySelector('.pg2-view[data-stage="1"].is-active')),
    dialog: Boolean(document.querySelector('dialog[open]')),
    anyDialog: document.querySelectorAll('dialog').length,
  }));
  report('accessory flow: Razorpay on first touch, Buy advances to details in place',
    atLoad === 0 && afterTouch === 1 && st.stage2 && !st.stage1 && !st.dialog,
    `at load ${atLoad}, after touch ${afterTouch}, ${JSON.stringify(st)}`, errors);
  await page.close();
}
{
  const { page, errors } = await open('powerpod-gen2');
  const requested = [];
  page.on('request', (r) => { if (/checkout\.razorpay\.com/.test(r.url())) requested.push(r.url()); });
  await sleep(2500);
  const atLoad = requested.length;
  await page.click('#pg2-panel').catch(() => {});
  await sleep(1500);
  report('configurator loads Razorpay on first use', atLoad === 0 && requested.length >= 1, `at load ${atLoad}, after a tap ${requested.length}`, errors);
  await page.close();
}

// 5. The journey lightbox: opens, the review drift rests beneath it, and it closes.
{
  const { page, errors } = await open('journey');
  await sleep(2500);
  const frame = await page.evaluate(() => {
    const f = [...document.querySelectorAll('.frame')].find((el) => el.getBoundingClientRect().width > 0);
    if (!f) return false;
    f.scrollIntoView({ block: 'center' });
    return true;
  });
  await sleep(600);
  await page.evaluate(() => [...document.querySelectorAll('.frame')].find((el) => el.getBoundingClientRect().width > 0).click());
  await sleep(1200);
  const st = await page.evaluate(() => ({
    open: document.documentElement.classList.contains('lightbox-open'),
    drift: document.querySelector('.review__track') ? getComputedStyle(document.querySelector('.review__track')).animationPlayState : 'n/a',
  }));
  await page.keyboard.press('Escape');
  await sleep(1200);
  const closed = await page.evaluate(() => !document.documentElement.classList.contains('lightbox-open'));
  report('journey lightbox', frame && st.open && closed && (st.drift === 'paused' || st.drift === 'n/a'), `${JSON.stringify(st)} closed ${closed}`, errors);
  await page.close();
}

// 6. Rotating a phone mid-film: both canvases follow, nothing throws.
{
  const { page, errors } = await open('index', { viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true } });
  await sleep(4500);
  await page.evaluate(() => window.scrollTo({ top: innerHeight * 6.8, behavior: 'instant' }));
  await sleep(2000);
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await sleep(1000);
  // The same scroll in pixels is much further down the film in landscape, past the lift, where
  // the pod has no part any more; back to the dock shot, so the pod is on screen to be measured.
  await page.evaluate(() => window.scrollTo({ top: innerHeight * 6.8, behavior: 'instant' }));
  await sleep(2000);
  const st = await page.evaluate(() => {
    // The pod's density on this phone, at the governor's current step (assets/perf.js).
    const perf = window.GridPerf;
    const steps = perf.podRatios(true);
    const ratio = steps[Math.min(steps.length - 1, perf.podLevel)];
    return {
      bg: `${document.getElementById('bg').width}x${document.getElementById('bg').height}`,
      pod: `${document.getElementById('pod').width}x${document.getElementById('pod').height}`,
      want: `${Math.round(844 * ratio)}x${Math.round(390 * ratio)}`,
    };
  });
  const drawn = await canvasDrawn(page, 'pod');
  report('rotate mid-film', st.bg === '844x390' && st.pod === st.want && drawn, JSON.stringify(st), errors);
  await page.close();
}

// 7. Hiding and showing the tab: loops stop, and come back drawing.
{
  const { page, errors } = await open('index');
  await sleep(4000);
  await page.evaluate(() => window.scrollTo({ top: innerHeight * 1.0, behavior: 'instant' }));
  await sleep(1500);
  const flip = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await flip(true);
  await sleep(800);
  await flip(false);
  await sleep(1500);
  const drawn = await canvasDrawn(page, 'pod');
  report('tab hidden and shown', drawn, `pod drawn after return: ${drawn}`, errors);
  await page.close();
}

// 8. Losing and restoring both WebGL contexts.
{
  const { page, errors } = await open('index');
  await sleep(4000);
  await page.evaluate(() => window.scrollTo({ top: innerHeight * 1.0, behavior: 'instant' }));
  await sleep(2000);
  await page.evaluate(() => {
    window.__lose = [];
    for (const id of ['bg', 'pod']) {
      const c = document.getElementById(id);
      const gl = c.getContext('webgl2');
      const ext = gl && gl.getExtension('WEBGL_lose_context');
      if (ext) { ext.loseContext(); window.__lose.push([id, ext]); }
    }
  });
  await sleep(1000);
  await page.evaluate(() => { for (const [, ext] of window.__lose) ext.restoreContext(); });
  await sleep(2500);
  const st = await page.evaluate(() => ({
    gl: document.documentElement.classList.contains('gl'),
    lost: ['bg', 'pod'].map((id) => document.getElementById(id).getContext('webgl2').isContextLost()),
  }));
  const bgDrawn = await canvasDrawn(page, 'bg');
  const podDrawn = await canvasDrawn(page, 'pod');
  report('context lost and restored', st.gl && !st.lost[0] && !st.lost[1] && bgDrawn && podDrawn, `${JSON.stringify(st)} drawn bg ${bgDrawn} pod ${podDrawn}`, errors);
  await page.close();
}

// 9. Opened straight from disk (file://), as a page is when double-clicked. Browsers refuse to
//    fetch() local files there, read local fonts, or hand local images to WebGL, so the pod
//    and the font each have a way in that does not need any of that. (On the Gen2 page the pod
//    is a plain image.)
for (const name of ['index', 'powerpod-gen2']) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`file://${root}/${name}.html`.replace(/ /g, '%20'), { waitUntil: 'load' });
  await sleep(6000);
  if (name === 'index') await page.evaluate(() => window.scrollTo(0, innerHeight));
  await sleep(3000);
  if (name === 'powerpod-gen2') {
    const st = await page.evaluate((shown) => ({
      stand: (0, eval)(`(${shown})`)(),
      font: [...document.fonts].some((f) => f.family.includes('DM Sans') && f.status === 'loaded'),
    }), STAND_SHOWN.toString());
    report(`opened from disk ${name}`, st.stand === true && st.font, JSON.stringify(st), errors);
    await page.close();
    continue;
  }
  const st = await page.evaluate(() => {
    const pod = document.getElementById('pod');
    return {
      pod: pod.width > 300,
      live: parseFloat(pod.style.opacity) > 0.5,
      font: [...document.fonts].some((f) => f.family.includes('DM Sans') && f.status === 'loaded'),
    };
  });
  const drawn = await canvasDrawn(page, 'pod');
  report(`opened from disk ${name}`, st.pod && st.live && st.font && drawn, `${JSON.stringify(st)} drawn ${drawn}`, errors);
  await page.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exitCode = failed ? 1 : 0;
