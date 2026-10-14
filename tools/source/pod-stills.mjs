#!/usr/bin/env node
/*
 * The Gen2 page's two pods, rendered once from the 3D scene (npm run pod-stills).
 *
 *   node tools/source/pod-stills.mjs     writes the masters, then pod-ladder.py the web sizes
 *
 *   stand   the pod as the page opens on it: beat 1 of the configurator (az -0.62, el 0.17,
 *           frame 0.58), standing, seen from a little above and to the left
 *   bay     the pod as it lies in the Komaki's bay: the ride's camera (az -0.30, el 0.06),
 *           drawn upright. The page lays it on the bay's 45 degree slant with a CSS rotation,
 *           which is exactly what the scene's camera roll did: the light never rolled with it.
 *
 * The scene is tools/source/pod-scene.js, the module the page used to build live, lit and
 * finished the same way (studio environment, ACES, fog, the display's green 75%), so the
 * images are that pod's own pixels. Math.random is seeded, so the cap's grain is the same on
 * every run.
 *
 * Each is drawn at twice the size of its master, in tiles through the camera's view offset, so
 * no part of the scene ever changes with the tiling and no drawing buffer gets near a GPU's
 * limits. The master is then cut symmetric about the point the camera looks at (the pod's
 * middle), so on the page the image's own centre is that point: centring it on the stage puts
 * the pod exactly where the 3D camera put it, and rotating it about its centre is the camera's
 * roll. What the page needs to size it is written beside the web images (pod.json):
 *
 *   frameH, frameW   the image's height and width in "frames", the height the camera's frame
 *                    value refers to (the pod's full height at its middle, 2 * HALF). The page
 *                    sets the image to frame * frameH of the stage, as the camera set the pod
 *                    to frame of it.
 *
 * Masters: assets/productImages/Gen2/pod-stand.png and pod-bay.png (PNGs under productImages
 * are kept out of git and out of the build). The web sizes come from pod-ladder.py.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require = createRequire(path.join(REPO, 'package.json'));
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');

const GEN2 = path.join(REPO, 'assets/productImages/Gen2');
const SS = 2;        // drawn at twice the master's size, then brought down by pod-ladder.py
const TILE = 2048;
const MARGIN = 0.012; // air around the pod, in frames, so no edge pixel is ever cut

// frameMaster is the frame's height in the master's pixels. The stand's tallest web size is
// 2400 px (a 2560 x 1440 window at 2x, with the page's 15% to spare), the bay's 560.
const STILLS = [
  { name: 'stand', shot: { az: -0.62, el: 0.17, frame: 0.58, target: 0 }, frameMaster: 2200 },
  // The bay's frame is the dock's length over the stage (powerpod-gen2.js, bayShot): about
  // 0.13 on a laptop. It sets only how far out the camera is, which at this size is invisible.
  { name: 'bay', shot: { az: -0.30, el: 0.06, frame: 0.13, target: 0 }, frameMaster: 510 },
];

const PORT = 8174;
const server = await serve({ root: REPO, port: PORT, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'warn' || m.type() === 'error') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[page error]', e.message));

// The grain is Math.random noise in a fresh ImageData: the sequence restarts there.
await page.evaluateOnNewDocument(() => {
  const SEED = 0x9e3779b9;
  let a = SEED;
  Math.random = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const createImageData = CanvasRenderingContext2D.prototype.createImageData;
  CanvasRenderingContext2D.prototype.createImageData = function (...args) {
    a = SEED;
    return createImageData.apply(this, args);
  };
});
await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${PORT}/tools/source/pod-stills.html`, { waitUntil: 'networkidle0' });
const mounted = await page.evaluate(async () => {
  const assets = await window.GridPodAssets.load();
  window.handle = await window.gridPod.mount({ canvas: document.getElementById('pod'), assets, phone: false, pixelRatio: 1 });
  return Boolean(window.handle);
});
if (!mounted) throw new Error('the scene did not mount (no GPU?)');

const meta = {};
for (const still of STILLS) {
  const F = still.frameMaster * SS;                 // the frame, in drawn pixels
  const full = 2 * Math.round(F / still.shot.frame / 2);
  // A window about the centre, generous enough for any pose; trimmed to the pod below.
  const A = Math.round(0.34 * F);
  const B = Math.round(0.66 * F);
  const tiles = await page.evaluate((shot, full, A, B, TILE) => {
    const h = window.handle;
    const cam = h.camera;
    const R = h.renderer;
    R.setPixelRatio(1);
    cam.clearViewOffset();
    cam.aspect = 1;
    cam.updateProjectionMatrix();
    h.place(shot, 0, 0, null);
    const out = [];
    for (let ty = 0; ty < 2 * B; ty += TILE) {
      for (let tx = 0; tx < 2 * A; tx += TILE) {
        const tw = Math.min(TILE, 2 * A - tx);
        const th = Math.min(TILE, 2 * B - ty);
        R.setSize(tw, th, false);
        cam.setViewOffset(full, full, full / 2 - A + tx, full / 2 - B + ty, tw, th);
        R.render(h.scene, cam);
        out.push({ tx, ty, tw, th, gw: R.getContext().drawingBufferWidth, url: h.canvas.toDataURL('image/png') });
      }
    }
    return out;
  }, still.shot, full, A, B, TILE);

  const img = new PNG({ width: 2 * A, height: 2 * B });
  for (const t of tiles) {
    if (t.gw !== t.tw) throw new Error(`a ${t.tw} px tile came back ${t.gw} px wide`);
    const tile = PNG.sync.read(Buffer.from(t.url.split(',')[1], 'base64'));
    PNG.bitblt(tile, img, 0, 0, t.tw, t.th, t.tx, t.ty);
  }

  // Trim to the pod, symmetric about the centre, which is the point the camera looked at.
  let x0 = img.width; let y0 = img.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x0 === 0 || y0 === 0 || x1 === img.width - 1 || y1 === img.height - 1) {
    throw new Error(`${still.name}: the pod runs off the drawn window`);
  }
  const m = Math.ceil(MARGIN * F);
  // Halves in master pixels (SS of them each), so the master is centred to the pixel too.
  const halfW = SS * Math.ceil((Math.max(A - x0, x1 + 1 - A) + m) / SS);
  const halfH = SS * Math.ceil((Math.max(B - y0, y1 + 1 - B) + m) / SS);
  const out = new PNG({ width: 2 * halfW, height: 2 * halfH });
  PNG.bitblt(img, out, A - halfW, B - halfH, 2 * halfW, 2 * halfH, 0, 0);
  const file = path.join(GEN2, `pod-${still.name}.png`);
  fs.writeFileSync(file, PNG.sync.write(out));
  meta[still.name] = {
    frameH: +((2 * halfH) / F).toFixed(5),
    frameW: +((2 * halfW) / F).toFixed(5),
    shot: still.shot,
    master: { width: out.width, height: out.height, scale: SS },
  };
  console.log(`${still.name}: ${out.width} x ${out.height} (${SS}x), ${(fs.statSync(file).size / 1e6).toFixed(1)} MB; ` +
    `${meta[still.name].frameH} frames tall, ${meta[still.name].frameW} wide`);
}

await browser.close();
server.close();

const metaFile = path.join(GEN2, 'web/pod.json');
fs.mkdirSync(path.dirname(metaFile), { recursive: true });
fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

const ladder = spawnSync('python3', [path.join(HERE, 'pod-ladder.py')], { stdio: 'inherit' });
process.exitCode = ladder.status || 0;
