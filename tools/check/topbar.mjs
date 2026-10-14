#!/usr/bin/env node
/*
 * The top bar and its band. Proves, in headless Chrome at a phone and a desktop size:
 *   - the glass pill is built as site.css says: the blur on an oversized ::before clipped to
 *     the pill, none on .brand itself, and the pill's box exactly as before the change;
 *   - the band under the page title forms on the pages that ask for it (topbar--band) once
 *     their text has scrolled up to the bar, goes again at the top, and never forms on the
 *     pages that do not (home, store, the tapes, the product pages);
 *   - the room going dark fades the bar's parts and never the bar itself;
 *   - on the journey, who we are, the founders and our backers stay on the page when the
 *     timeline collapses, an older year hides all three, and the current year's line under
 *     the tape names only its own chapters.
 *
 *   node tools/check/topbar.mjs [--root dir] [--sheet]
 *
 * --sheet also writes the band on a legal page at some fifty sizes (280px fold to 2560
 * desktop, landscape phones, 125 and 150 % text) to tools/check/out/topbar/ to look at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--root');
const root = path.resolve(i >= 0 ? args[i + 1] : '.');
const sheet = args.includes('--sheet');
const port = 8150;
const base = `http://localhost:${port}`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'topbar');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IGNORE = /localhost:3000|ERR_CONNECTION_REFUSED|favicon|status of 404|razorpay|ERR_BLOCKED_BY_ORB/i;

const BAND_PAGES = ['privacy_policy', 'warranty_terms', 'subscription_policy', 'support', 'dealers', 'interview', '404'];
const PLAIN_PAGES = ['index', 'store', 'journey', 'careers', 'powerpod-gen2'];
const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
};

const server = await serve({ root, port, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS, protocolTimeout: 300000 });
let failed = 0;

function report(label, ok, detail, errors = []) {
  const pass = ok && !errors.length;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: ${detail}${errors.length ? `\n      errors: ${errors.join(' | ')}` : ''}`);
}

async function open(name, vp) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); });
  await page.goto(`${base}/${name}.html`, { waitUntil: 'load' });
  if (name === 'journey') await page.waitForSelector('.journey.is-open', { timeout: 30000 }).catch(() => errors.push('journey never opened'));
  else if (name === 'index') await page.waitForFunction(() => document.documentElement.classList.contains('chrome-in'), { timeout: 30000 }).catch(() => errors.push('chrome never came in'));
  await sleep(name === 'index' ? 2500 : 1200);
  return { page, errors };
}

// Polls until fn (run in the page) is truthy, up to ms. Returns the last value.
async function until(page, fn, ms = 1500) {
  const t0 = Date.now();
  let v;
  do {
    v = await page.evaluate(fn);
    if (v) return v;
    await sleep(60);
  } while (Date.now() - t0 < ms);
  return v;
}

const bandState = () => ({
  on: document.documentElement.classList.contains('band-on'),
  content: getComputedStyle(document.querySelector('.topbar'), '::before').content,
  opacity: Number(getComputedStyle(document.querySelector('.topbar'), '::before').opacity),
  // On a short page the footer is in range at once and the band goes with the room.
  night: Number(document.querySelector('.topbar').style.getPropertyValue('--night') || 0),
});
const scrollTo = (page, y) => page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), y);

// The pill, as built: blur on the oversized ::before, none on .brand, the box as it was.
const pillState = () => {
  const brand = document.querySelector('.brand');
  const own = getComputedStyle(brand);
  const glass = getComputedStyle(brand, '::before');
  const r = brand.getBoundingClientRect();
  const bf = (cs) => cs.backdropFilter || cs.webkitBackdropFilter || 'none';
  return {
    glassBlur: bf(glass), ownBlur: bf(own), overflow: own.overflow, inset: glass.top,
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','),
    compact: document.documentElement.classList.contains('is-compact'),
  };
};
const PILL_BOX = { phone: '16,18,172,44', desktop: '24,18,204,44' };

// ---------------------------------------------------------------- 1. the band, where it belongs
for (const name of BAND_PAGES) {
  for (const [vn, vp] of Object.entries(VIEWPORTS)) {
    const { page, errors } = await open(name, vp);
    const top = await page.evaluate(bandState);
    await scrollTo(page, 600);
    const on = await until(page, () => document.documentElement.classList.contains('band-on') && Number(getComputedStyle(document.querySelector('.topbar'), '::before').opacity) > 0, 1500);
    await sleep(500); // the 0.35s fade, and the room if it is moving
    const scrolled = await page.evaluate(bandState);
    await scrollTo(page, 0);
    await until(page, () => !document.documentElement.classList.contains('band-on') && Number(getComputedStyle(document.querySelector('.topbar'), '::before').opacity) === 0, 1500);
    const back = await page.evaluate(bandState);
    const want = 1 - scrolled.night;
    const ok = !top.on && top.opacity === 0 && on && scrolled.on && Math.abs(scrolled.opacity - want) < 0.03 && !back.on && back.opacity === 0;
    report(`band ${name} ${vn}`, ok, `top off (${top.opacity}) → scrolled on (${scrolled.opacity.toFixed(2)}${scrolled.night ? `, room at ${scrolled.night.toFixed(2)}` : ''}) → top off (${back.opacity})`, errors);
    await page.close();
  }
}

// ---------------------------------------------------------------- 2. and nowhere else
for (const name of PLAIN_PAGES) {
  for (const [vn, vp] of Object.entries(VIEWPORTS)) {
    const { page, errors } = await open(name, vp);
    await scrollTo(page, 600);
    await sleep(700);
    const s = await page.evaluate(bandState);
    report(`no band ${name} ${vn}`, !s.on && s.content === 'none', `band-on=${s.on}, ::before content ${s.content}`, errors);
    await page.close();
  }
}

// ---------------------------------------------------------------- 3. the pill, as built
for (const name of ['index', 'store', 'privacy_policy', 'journey', 'powerpod-gen2']) {
  for (const [vn, vp] of Object.entries(VIEWPORTS)) {
    const { page, errors } = await open(name, vp);
    await page.mouse.move(40, 40); // a hover holds the bar open where it would fold
    await sleep(300);
    const s = await page.evaluate(pillState);
    const boxOk = s.compact || s.box === PILL_BOX[vn]; // the product pages start folded
    const ok = /blur\(14px\)/.test(s.glassBlur) && s.ownBlur === 'none' && s.overflow === 'hidden' && s.inset === '-32px' && boxOk && s.box.endsWith(',44');
    report(`pill ${name} ${vn}`, ok, `glass ${s.glassBlur}, own ${s.ownBlur}, overflow ${s.overflow}, reach ${s.inset}, box ${s.box}${s.compact ? ' (folded)' : ''}`, errors);
    await page.close();
  }
}

// ---------------------------------------------------------------- 4. the room goes dark
for (const name of ['privacy_policy', 'index']) {
  const { page, errors } = await open(name, VIEWPORTS.desktop);
  // Twice: the footer's stage lays itself out once it is near, so the first jump lands short.
  await scrollTo(page, 10 ** 7);
  await sleep(700);
  await scrollTo(page, 10 ** 7);
  const dark = await until(page, () => Number(document.querySelector('.topbar').style.getPropertyValue('--night')) > 0.5, 8000);
  const s = await page.evaluate(() => {
    const op = (sel) => { const el = document.querySelector(sel); return el ? Number(getComputedStyle(el).opacity) : null; };
    return { night: document.querySelector('.topbar').style.getPropertyValue('--night'), bar: op('.topbar'), lockup: op('.brand-lockup'), brand: op('.brand'), island: op('.island-wrap') };
  });
  const part = name === 'index' ? s.brand : s.lockup;
  const ok = dark && s.bar === 1 && part < 0.5 && s.island < 0.5;
  report(`night ${name}`, ok, `--night ${s.night}: bar ${s.bar}, ${name === 'index' ? 'logo' : 'lockup'} ${part}, island ${s.island}`, errors);
  await page.close();
}

// ---------------------------------------------------------------- 5. the journey's three parts
for (const [vn, vp] of Object.entries(VIEWPORTS)) {
  const { page, errors } = await open('journey', vp);
  const shown = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; if (el.closest('[hidden]')) return false; return getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; }, sel);
  const three = async () => (await shown('.chapter--lead')) && (await shown('.chapter--team')) && (await shown('.chapter--backers'));
  const peek = () => page.evaluate(() => document.querySelector('.tl-peek__text').textContent.trim());
  const order = await page.evaluate(() => [...document.querySelector('.tl-always').children].map((c) => c.classList[1] || c.classList[0]).join(' > '));
  const openOk = await three();
  await page.click('.tl-close');
  await sleep(1500);
  const closedOk = await three();
  const line = await peek();
  const lineOk = /^Today · /.test(line) && !/Who we are|Founders|Backers/.test(line);
  const y2021 = await page.$('.tl-year[data-year="2021"]');
  if (y2021) await page.evaluate((el) => el.click(), y2021);
  await sleep(2600);
  const olderHides = !(await shown('.chapter--lead')) && !(await shown('.chapter--team')) && !(await shown('.chapter--backers'));
  await page.keyboard.press('Escape');
  await sleep(1800);
  const backOk = await three();
  const ok = order === 'chapter--lead > chapter--team > chapter--backers > tl-end' && openOk && closedOk && lineOk && olderHides && backOk;
  report(`journey parts ${vn}`, ok, `order ${order}; shown with 2026 open ${openOk}, collapsed ${closedOk}, back ${backOk}; hidden by 2021 ${olderHides}; line "${line.slice(0, 48)}…"`, errors);
  await page.close();
}

// ---------------------------------------------------------------- 6. the band at every size (to look at)
if (sheet) {
  fs.mkdirSync(OUT, { recursive: true });
  const sizes = [];
  for (const w of [280, 320, 360, 375, 390, 412, 430, 540, 600, 744, 768, 820, 1024, 1180, 1280, 1366, 1440, 1680, 1920, 2560]) sizes.push({ w, h: w < 700 ? 844 : w < 1100 ? 1024 : 900, label: `${w}` });
  for (const [w, h] of [[844, 390], [932, 430], [1180, 820]]) sizes.push({ w, h, label: `${w}x${h}-landscape` });
  for (const z of [125, 150]) for (const w of [390, 1440]) sizes.push({ w, h: w < 700 ? 844 : 900, zoom: z, label: `${w}-text${z}` });
  const strips = [];
  for (const s of sizes) {
    const page = await browser.newPage();
    const mobile = s.w < 1024;
    await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
    await page.goto(`${base}/privacy_policy.html`, { waitUntil: 'load' });
    if (s.zoom) await page.evaluate((z) => { document.documentElement.style.fontSize = `${z}%`; }, s.zoom);
    await sleep(900);
    await scrollTo(page, 500);
    await sleep(500);
    await page.evaluate(() => window.scrollBy(0, -24)); // up: the logo unfolds again
    await sleep(1100);
    const png = PNG.sync.read(Buffer.from(await page.screenshot({ type: 'png', captureBeyondViewport: false })));
    const h = Math.min(png.height, 150 * 2);
    const strip = new PNG({ width: png.width, height: h });
    PNG.bitblt(png, strip, 0, 0, png.width, h, 0, 0);
    fs.writeFileSync(path.join(OUT, `band-${s.label}.png`), PNG.sync.write(strip));
    strips.push({ label: s.label, png: strip });
    await page.close();
  }
  // One sheet: strips wider than 1200px are scaled down to it, the rest kept 1:1 and
  // left-aligned (nearest neighbour is fine for a look).
  const W = 1200;
  const rows = strips.map((s) => { const k = Math.min(1, W / s.png.width); return { ...s, w: Math.round(s.png.width * k), h: Math.round(s.png.height * k) }; });
  const H = rows.reduce((a, r) => a + r.h + 6, 0);
  const out = new PNG({ width: W, height: H });
  out.data.fill(255);
  let y = 0;
  for (const r of rows) {
    for (let yy = 0; yy < r.h; yy++) {
      const sy = Math.min(r.png.height - 1, Math.floor((yy * r.png.height) / r.h));
      for (let xx = 0; xx < r.w; xx++) {
        const sx = Math.min(r.png.width - 1, Math.floor((xx * r.png.width) / r.w));
        const si = (sy * r.png.width + sx) * 4, di = ((y + yy) * W + xx) * 4;
        out.data[di] = r.png.data[si]; out.data[di + 1] = r.png.data[si + 1]; out.data[di + 2] = r.png.data[si + 2]; out.data[di + 3] = 255;
      }
    }
    y += r.h + 6;
  }
  fs.writeFileSync(path.join(OUT, 'sheet.png'), PNG.sync.write(out));
  console.log(`sheet: ${strips.length} sizes in ${path.relative(process.cwd(), OUT)}/`);
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
