#!/usr/bin/env node
/*
 * The app beat's hands, rendered once into images (npm run hands).
 *
 *   node tools/source/hands/render.mjs             writes assets/app/hand-*.webp and hands.json
 *   node tools/source/hands/render.mjs --preview   a quick look: the hands laid on a stand-in
 *                                                  phone over the studio grey, in
 *                                                  tools/check/out/hands-preview.png
 *
 * Each hand is posed in poses.mjs and drawn by hands.html in headless Chrome. The images are
 * laid out in the phone's own points (471 x 987, as index.html builds it), and hands.json says
 * where: the box each covers with the fingertip touching the glass at the phone's middle, so
 * the page can put that point on whatever it taps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { SCENES, PHONE } from './poses.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const require = createRequire(path.join(REPO, 'package.json'));
const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PREVIEW = process.argv.includes('--preview');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

// What each image shows, in millimetres of the world (poses.mjs).
const SHOTS = [
  { name: 'hand-right-hover', scene: 'hand-right-hover', rect: [-20, -230, 200, 22] },
  { name: 'hand-right-press', scene: 'hand-right-press', rect: [-20, -230, 200, 22] },
];
const SIZES = PREVIEW ? [640] : [2100, 1400, 700];
// The look, shared by every image: outline width at the final size, body and ink opacity, how
// far up the forearm the body and the line run before they are gone, the faint shadow.
const LOOK = { line: 1.5, fill: 0.34, ink: 0.95, fade: [45, 120], halo: 0.075, dots: 22 };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(pathToFileURL(path.join(HERE, 'hands.html')).href);
await page.waitForFunction('window.ready === true');

const pts = PHONE.pts;
const toPts = ([x0, y0, x1, y1]) => ({
  left: 235.5 + x0 * pts,
  top: 493.5 - y1 * pts,
  width: (x1 - x0) * pts,
  height: (y1 - y0) * pts,
});

const meta = {};
const outDir = PREVIEW ? path.join(REPO, 'tools/check/out') : path.join(REPO, 'assets/app');
fs.mkdirSync(outDir, { recursive: true });
const previews = [];
for (const shot of SHOTS) {
  if (ONLY.length && !ONLY.some((o) => shot.name.includes(o))) continue;
  const { cones } = SCENES[shot.scene]();
  // Crop to what is drawn: a quick render of the whole box finds it, and every size is then
  // rendered over just that part of the world (with a millimetre to spare), so the sizes line
  // up exactly and no image carries empty space to the GPU.
  if (!PREVIEW) {
    const probe = await page.evaluate((scene) => window.renderHand(scene), { ...LOOK, ...shot.look, cones, rect: shot.rect, height: 700, clip: shot.clip, mode: shot.mode, ss: 1 });
    const [x0, y0, x1, y1] = shot.rect;
    const [u0, v0, u1, v1] = probe.bbox;
    const pad = 1;
    shot.rect = [
      Math.max(x0, x0 + u0 * (x1 - x0) - pad),
      Math.max(y0, y1 - v1 * (y1 - y0) - pad),
      Math.min(x1, x0 + u1 * (x1 - x0) + pad),
      Math.min(y1, y1 - v0 * (y1 - y0) + pad),
    ].map((v) => Math.round(v * 10) / 10);
  }
  for (const height of SIZES) {
    const t0 = Date.now();
    // The sizes are the largest dimension, so a wide crop is not rendered huge.
    const [cx0, cy0, cx1, cy1] = shot.rect;
    const tall = (cy1 - cy0) >= (cx1 - cx0);
    const h = PREVIEW ? height : Math.round(tall ? height : height * (cy1 - cy0) / (cx1 - cx0));
    const res = await page.evaluate((scene) => window.renderHand(scene), {
      ...LOOK, ...shot.look, cones, rect: shot.rect, height: h, clip: shot.clip, mode: shot.mode, ss: 2,
    });
    const file = path.join(outDir, `${shot.name}-${height}.${PREVIEW ? 'png' : 'webp'}`);
    const data = (PREVIEW ? res.png : res.webp).split(',')[1];
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`${path.relative(REPO, file)}  ${res.width}x${res.height}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB  ${Date.now() - t0} ms`);
    if (PREVIEW) previews.push({ shot, file });
  }
  meta[shot.name] = { box: toPts(shot.rect), mm: shot.rect };
}

if (!PREVIEW) {
  fs.writeFileSync(path.join(HERE, 'hands.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log('tools/source/hands/hands.json');
} else {
  // Lay them out the way the page will: a stand-in phone at the studio's grey, the hand's
  // fingertip on a point of the screen.
  const html = `<!doctype html><body style="margin:0;background:radial-gradient(120% 90% at 30% 20%,#e9e9e9,#c9c9c9)">
  <div style="position:relative;width:1200px;height:900px;overflow:hidden">
  ${[0, 1].map((k) => {
    const s = 0.62; // phone points to px
    const ox = 140 + k * 560, oy = 70;
    const at = (b) => `left:${ox + b.left * s}px;top:${oy + b.top * s}px;width:${b.width * s}px;height:${b.height * s}px`;
    const img = (name) => `file://${path.join(outDir, `${name}-640.png`)}`;
    const R = toPts(SHOTS[0].rect);
    // The right hand's fingertip is the world origin of its scene: in the phone's points,
    // (235.5, 493.5) at x = y = 0. Put it on the live row (k = 0) or the pod (k = 1).
    const target = k === 0 ? [372, 905] : [110, 520];
    const shift = [(target[0] - 235.5) * s, (target[1] - 493.5) * s];
    return `
      <div style="position:absolute;left:${ox}px;top:${oy}px;width:${471 * s}px;height:${987 * s}px;border-radius:${77.5 * s}px;background:linear-gradient(140deg,#4b5a7a,#1d263a 52%,#3a4766);box-shadow:0 30px 70px rgb(0 0 0/.3)"><div style="position:absolute;inset:${6 * s}px;border-radius:${71.5 * s}px;background:#222"></div>
        <div style="position:absolute;left:${target[0] * s - 4}px;top:${target[1] * s - 4}px;width:8px;height:8px;border-radius:50%;background:#e57373"></div></div>
      <img src="${img(k === 0 ? 'hand-right-hover' : 'hand-right-press')}" style="position:absolute;${at(R)};transform:translate(${shift[0]}px,${shift[1]}px)">`;
  }).join('')}
  </div></body>`;
  const sheet = path.join(outDir, 'hands-preview.html');
  fs.writeFileSync(sheet, html);
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(pathToFileURL(sheet).href);
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(outDir, 'hands-preview.png') });
  console.log('tools/check/out/hands-preview.png');
}
await browser.close();
