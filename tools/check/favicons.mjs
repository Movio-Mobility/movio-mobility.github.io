#!/usr/bin/env node
/*
 * The site's icons (tools/source/favicons.py), checked: the files, every page's links to them,
 * and each one fetched and decoded by a real browser at the size it claims.
 *
 *   node tools/check/favicons.mjs                 the sources
 *   node tools/check/favicons.mjs --root=dist     the built site
 *
 * Files: favicon.ico holds 16, 32 and 48, each a drawing of its own size; the home screen icons
 * are their sizes, and the full-bleed ones (apple-touch, maskable) have no transparent pixel
 * for a phone to fill with black; the manifest names its icons at their current versions.
 * Pages: every page, and the job page template built as a nested page is, links the three, at
 * paths that reach the files from where the page lives. Browser: on every page each link is
 * fetched and decoded at its size, the manifest's icons too, with no console error or blocked
 * request; the built 404 page does the same from a missing path three folders deep.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { serve } from '../serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require = createRequire(path.join(REPO, 'package.json'));
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg ? path.resolve(rootArg.slice(7)) : REPO;
const BUILT = ROOT !== REPO;

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

// ---------------------------------------------------------------- the files
function icoFrames(buf) {
  const count = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    const data = buf.subarray(offset, offset + size);
    const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? PNG.sync.read(data) : null;
    frames.push({ w: buf[e] || 256, h: buf[e + 1] || 256, png });
  }
  return { reserved: buf.readUInt16LE(0), type: buf.readUInt16LE(2), frames };
}

const ico = icoFrames(read('favicon.ico'));
const sizes = ico.frames.map((f) => `${f.w}x${f.h}`).sort();
report('favicon.ico: an icon file with 16, 32 and 48', ico.reserved === 0 && ico.type === 1 && sizes.join() === ['16x16', '32x32', '48x48'].sort().join(), sizes.join(' '));
report('favicon.ico: each frame decodes at its stated size',
  ico.frames.every((f) => f.png && f.png.width === f.w && f.png.height === f.h));
// Each frame its own drawing: the 16 is not the 32 scaled down (its gap sits on a whole row).
const row = (png, y) => { let s = 0; for (let x = 0; x < png.width; x++) s += png.data[(y * png.width + x) * 4]; return s / png.width; };
const f16 = ico.frames.find((f) => f.w === 16);
report('favicon.ico: the 16 has a dark gap row between two cream bars', f16 && row(f16.png, 7) < 40 && row(f16.png, 6) > 120 && row(f16.png, 8) > 120,
  f16 ? `rows 6-8: ${[6, 7, 8].map((y) => row(f16.png, y).toFixed(0)).join(' ')}` : 'no 16');

const pngAt = (rel) => PNG.sync.read(read(rel));
const opaque = (png) => { for (let i = 3; i < png.data.length; i += 4) if (png.data[i] !== 255) return false; return true; };
for (const [rel, size, full] of [
  ['apple-touch-icon.png', 180, true],
  ['assets/icons/apple-touch-icon.png', 180, true],
  ['assets/icons/icon-192.png', 192, false],
  ['assets/icons/icon-512.png', 512, false],
  ['assets/icons/icon-maskable-512.png', 512, true],
]) {
  const png = pngAt(rel);
  report(`${rel}: ${size} square${full ? ', no transparent pixel' : ''}`, png.width === size && png.height === size && (!full || opaque(png)), `${png.width}x${png.height}`);
}
report('apple-touch-icon.png at the root is the same as the linked one', read('apple-touch-icon.png').equals(read('assets/icons/apple-touch-icon.png')));

const manifest = JSON.parse(read('assets/icons/site.webmanifest').toString('utf8'));
const stale = manifest.icons.filter((i) => {
  const [file, v] = i.src.split('?v=');
  const hash = crypto.createHash('sha256').update(read(`assets/icons/${file}`)).digest('hex').slice(0, 10);
  return v !== hash;
});
report('manifest: a name, and its icons at their current versions', manifest.name && manifest.short_name && !stale.length, stale.map((i) => i.src).join(' '));
report('manifest: one maskable icon at 512, any at 192 and 512',
  manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')
  && ['192x192', '512x512'].every((s) => manifest.icons.some((i) => i.purpose === 'any' && i.sizes === s)));

// ---------------------------------------------------------------- every page links them
const LINKS = [
  /<link rel="icon" href="([^"]*favicon\.ico[^"]*)" sizes="16x16 32x32 48x48">/,
  /<link rel="apple-touch-icon" href="([^"]*assets\/icons\/apple-touch-icon\.png[^"]*)">/,
  /<link rel="manifest" href="([^"]*assets\/icons\/site\.webmanifest[^"]*)">/,
];
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();
const without = pages.filter((p) => !LINKS.every((re) => re.test(read(p).toString('utf8'))));
report(`every page links the three (${pages.length} pages)`, !without.length, without.join(' '));

// The job page template, built as a nested page is (jobs/<slug>/index.html): its links climb
// back to the root and land on the files.
if (!BUILT) {
  const build = await import('../build.mjs');
  const html = await build.buildPage('jobs/x/index.html', 'check', { html: fs.readFileSync(path.join(REPO, 'tools/source/job.html'), 'utf8'), prefix: '../../' });
  const hrefs = LINKS.map((re) => (html.match(re) || [])[1]);
  const lands = hrefs.map((h) => h && h.startsWith('../../') && fs.existsSync(path.join(REPO, h.slice(6).split('?')[0])));
  report('a job page (two folders down) links the three, reaching the files', lands.every(Boolean), hrefs.join(' '));
}

// ---------------------------------------------------------------- in a browser
const server = await serve({ root: ROOT, port: 8148, quiet: true });
const chrome = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] });
const SITE = 'http://localhost:8148';
try {
  // The 404 page's links are made root-absolute by the build, so only the built one is tried
  // from deep down; the source one is tried where its relative links work.
  const notFound = BUILT ? ['404.html, three folders down', `${SITE}/a/b/c/missing`] : ['404.html', `${SITE}/missing`];
  const visits = [...pages.filter((p) => p !== '404.html').map((p) => [p, `${SITE}/${p}?check`]), notFound];
  for (const [label, url] of visits) {
    const tab = await chrome.newPage();
    await tab.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const errors = [];
    tab.on('console', (m) => { if (m.type() === 'error' && /icon|manifest|Content Security Policy|webmanifest/i.test(m.text())) errors.push(m.text()); });
    tab.on('requestfailed', (q) => { if (/favicon|icons\//.test(q.url())) errors.push(`${q.url()} ${(q.failure() || {}).errorText}`); });
    await tab.goto(url, { waitUntil: 'domcontentloaded' });
    const seen = await tab.evaluate(async () => {
      const decode = (src) => new Promise((res) => {
        const img = new Image();
        img.onload = () => res({ src, w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => res({ src, w: 0, h: 0 });
        img.src = src;
      });
      const out = [];
      for (const link of document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')) {
        const r = await fetch(link.href);
        out.push({ rel: link.rel, status: r.status, type: r.headers.get('content-type'), ...(await decode(link.href)) });
      }
      const m = document.querySelector('link[rel="manifest"]');
      const r = await fetch(m.href);
      const json = await r.json().catch(() => null);
      out.push({ rel: 'manifest', status: r.status, type: r.headers.get('content-type'), icons: json ? json.icons.length : 0 });
      for (const icon of (json ? json.icons : [])) {
        const d = await decode(new URL(icon.src, m.href).href);
        out.push({ rel: `manifest icon ${icon.sizes} ${icon.purpose}`, status: d.w ? 200 : 0, want: icon.sizes, ...d });
      }
      return out;
    });
    const bad = seen.filter((s) => s.status !== 200
      || (s.rel === 'icon' && !(s.w === 48 || s.w === 32 || s.w === 16))
      || (s.rel === 'apple-touch-icon' && s.w !== 180)
      || (s.want && `${s.w}x${s.h}` !== s.want)
      || (s.rel === 'manifest' && s.icons !== 3));
    report(`${label}: the tab icon, the touch icon, the manifest and its icons all load at their sizes`, seen.length === 6 && !bad.length,
      bad.map((s) => `${s.rel} ${s.status} ${s.w}x${s.h}`).join('; '));
    report(`${label}: no errors`, !errors.length, errors.slice(0, 2).join(' | '));
    await tab.close();
  }
} finally {
  await chrome.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
