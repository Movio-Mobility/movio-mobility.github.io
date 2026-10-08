#!/usr/bin/env node
/*
 * GridX design kit
 * ----------------
 * The website's visual system as files a design team can build decks from (Canva, PowerPoint,
 * Google Slides and Docs): studio backgrounds, particle shapes, the logo, the nav pill, glass
 * cards and buttons, the journey timeline, a tokens sheet, two example slides, and Particle
 * Studio, the drop-an-image tool. Everything is drawn from the site's own sources, so running
 * this again after a site change brings the kit along with it.
 *
 *   npm run design-kit                                   everything, into ../New Particle system design files
 *   npm run design-kit -- --out <dir>                    somewhere else
 *   npm run design-kit -- --only particles,timeline      some groups: backgrounds, particles, logo, pill,
 *                                                        cards, timeline, tokens, studio, readme
 *
 * Backgrounds and particles come from particles.js, a still-frame port of assets/grid-bg.js.
 * Anything with type or CSS in it is drawn by kit.html in headless Chrome.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';
import './particles.js';

const P = globalThis.GridParticles;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = path.resolve(arg('out', path.resolve(REPO, '..', 'New Particle system design files')));
const ONLY = new Set(arg('only', '').split(',').filter(Boolean));
const wants = (group) => ONLY.size === 0 || ONLY.has(group);
const MAX_SIDE = 4096; // no element is written larger than this on its long side
const INK = [20, 20, 20];

// ---------------------------------------------------------------- files
const manifest = [];

function writePNG(rel, width, height, rgba, meta, opaque = false) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  fs.writeFileSync(file, PNG.sync.write(png, opaque ? { colorType: 2 } : {}));
  manifest.push({ rel, width, height, ...meta });
}

function writeBuffer(rel, bytes, meta) {
  const buffer = Buffer.from(bytes); // puppeteer hands back a Uint8Array
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  manifest.push({ rel, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), ...meta });
}

function readPNG(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

// A stable seed per item name, so every size of an item is the same artwork.
const seedOf = (name) => {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};

const scalesFor = (w, h, list = [1, 2, 4]) => list.filter((s) => Math.max(w, h) * s <= MAX_SIDE);
const log = (msg) => process.stdout.write(`${msg}\n`);

// ---------------------------------------------------------------- 01 backgrounds
const FORMATS = [
  { id: '16x9', label: '16:9 slide', sizes: [[1920, 1080], [2560, 1440], [3840, 2160]] },
  { id: '4x3', label: '4:3 slide', sizes: [[1600, 1200], [3200, 2400]] },
  { id: 'a4-portrait', label: 'A4 portrait (150 and 300 dpi)', sizes: [[1240, 1754], [2480, 3508]] },
  { id: 'letter-portrait', label: 'US Letter portrait (150 and 300 dpi)', sizes: [[1275, 1650], [2550, 3300]] },
  { id: '1x1', label: 'Square', sizes: [[1080, 1080], [2160, 2160]] },
];

// The night is grid-bg.js nightGrade() with the house down: lights at 10%, the survivors brighter.
const NIGHT = { house: 0.1, gain: 1.45 };

const BACKGROUNDS = [
  { id: 'studio', title: 'Studio', note: 'The grey cyclorama with the lights up and no particles. The default for most slides.' },
  { id: 'studio-drift', field: 'drift', title: 'Studio, drift', note: 'The resting field the site settles into, spread evenly: fine dust with a few soft bokeh discs.' },
  { id: 'studio-grid', field: 'grid', title: 'Studio, grid', note: 'Particles resting on an even lattice, easing off toward the edges. Quiet enough for dense content.' },
  { id: 'studio-ribbon', field: 'ribbon', title: 'Studio, ribbon', note: 'The opening\'s five-lane road of particles across the horizon. For title and section slides.' },
  { id: 'night', night: true, title: 'Night', note: 'The footer\'s room with the house lights down. For closing, quote and section-break slides.' },
  { id: 'night-drift', night: true, field: 'drift', title: 'Night, drift', note: 'The last sparks in the dark room, large and soft.' },
  { id: 'night-grid', night: true, field: 'grid', title: 'Night, grid', note: 'The lattice glowing in the dark room.' },
];

function backgrounds() {
  for (const format of FORMATS) {
    for (const [w, h] of format.sizes) {
      const t0 = Date.now();
      const base = P.studio(w, h);
      const minDim = Math.min(w, h);
      const aspect = w / h;
      const area = (w * h) / (minDim * minDim) / (16 / 9); // frame area against a 16:9 slide's
      const scale = minDim / 1080;
      const cam = (focus, aperture) => P.camera({ scale, resY: h, minDim, aspect, focus, aperture });
      for (const bg of BACKGROUNDS) {
        let light = null;
        if (bg.field === 'drift') {
          light = bg.night
            ? P.render(w, h, P.drift(w, h, { count: Math.round(520 * area), seed: 12 }), cam(10.2, 0.18))
            : P.render(w, h, P.drift(w, h, { count: Math.round(1300 * area), seed: 11 }), cam(7, 0.085));
        } else if (bg.field === 'grid') {
          light = P.render(w, h, P.grid(w, h, { gain: bg.night ? 0.9 : 1.15 }), cam(7, 0.085));
        } else if (bg.field === 'ribbon') {
          const count = Math.round((12000 * Math.max(aspect, 1)) / (16 / 9));
          light = P.render(w, h, P.ribbon(w, h, { count }), cam(6, 0.08));
        }
        const rgba = P.compose(w, h, base, light, bg.night ? NIGHT : {});
        writePNG(`01_backgrounds/${bg.id}/gridx_bg_${bg.id}_${format.id}_${w}x${h}.png`, w, h, rgba,
          { group: 'backgrounds', section: bg.id, item: format.id, label: format.label }, true);
      }
      log(`  backgrounds ${format.id} ${w}x${h} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }
}

// ---------------------------------------------------------------- 02 particle shapes
// Shapes are laid out in pixels of a 1920x1080 slide, so an @1x file drops onto a slide at
// its natural size, and drawn @1x/@2x/@4x as the same artwork with sharper pixels. Each file
// has a transparent margin of PAD around the shape for the particles' glow.
const PAD = 16;
const SPACING = 2.2;  // px between points along a stroke, @1x: reads as particles yet holds the line
const SCATTER = 1.3;  // px off the line, @1x

function roundRect(x, y, w, h, r) {
  return [
    ['line', x + r, y, x + w - r, y],
    ['arc', x + w - r, y + r, r, -90, 0],
    ['line', x + w, y + r, x + w, y + h - r],
    ['arc', x + w - r, y + h - r, r, 0, 90],
    ['line', x + w - r, y + h, x + r, y + h],
    ['arc', x + r, y + h - r, r, 90, 180],
    ['line', x, y + h - r, x, y + r],
    ['arc', x + r, y + r, r, 180, 270],
  ];
}

const polyline = (pts, close = false) => {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) out.push(['line', ...pts[i], ...pts[i + 1]]);
  if (close) out.push(['line', ...pts[pts.length - 1], ...pts[0]]);
  return out;
};

// Rotate line strokes about (cx, cy) to face `dir` (drawn facing right).
const TURN = { right: 0, down: 90, left: 180, up: 270 };
function orient(strokes, dir, cx, cy) {
  const a = (TURN[dir] * Math.PI) / 180;
  const c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  const rot = (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  return strokes.map((st) => ['line', ...rot(st[1], st[2]), ...rot(st[3], st[4])]);
}

// Points scattered evenly over a rect or circle: the dust inside a panel or disc.
function fillPoints(rnd, test, x, y, w, h, step, weight) {
  const pts = [];
  for (let yy = y; yy < y + h; yy += step) {
    for (let xx = x; xx < x + w; xx += step) {
      const px = xx + rnd() * step, py = yy + rnd() * step;
      if (test(px, py)) pts.push([px, py, weight * (0.6 + 0.4 * rnd()), 0.35]);
    }
  }
  return pts;
}

// Strokes to formation points. `fade(index, along)` thins and dims points toward 0 (a tail).
function strokePoints(strokes, s, seed, fade = null) {
  const rnd = P.random(seed);
  const thin = P.random(seed ^ 0x5bd1);
  const pts = [];
  for (const [x, y, along, index] of P.sampleStrokes(strokes, SPACING * s, SCATTER * s, rnd)) {
    const f = fade ? fade(index, along) : 1;
    if (f < 1 && thin() > P.mix(0.15, 1, f)) continue;
    pts.push([x, y, f]);
  }
  return pts;
}

// Every particle element: { section, item, title, w, h, pad?, points(s) -> [x, y, weight] in
// output px (margin included), focus?, aperture?, soft? }.
function particleElements() {
  const els = [];
  const SIZES = ['s', 'm', 'l', 'xl'];

  // Boxes: rounded-rect outlines (the store card's corner) and panels (outline plus a faint
  // dust fill, the way the field stands in for a dialog panel).
  const BOX_SETS = [
    ['square', [[240, 240], [360, 360], [480, 480], [720, 720]]],
    ['4x3', [[320, 240], [480, 360], [640, 480], [960, 720]]],
    ['3x2', [[360, 240], [540, 360], [720, 480], [1080, 720]]],
    ['16x9', [[384, 216], [640, 360], [960, 540], [1600, 900]]],
    ['4x5', [[288, 360], [384, 480], [480, 600], [640, 800]]],
    ['3x4', [[240, 320], [360, 480], [480, 640], [720, 960]]],
    ['banner-4x1', [[480, 120], [960, 240], [1440, 360], [1760, 440]]],
  ];
  for (const [ratio, sizes] of BOX_SETS) {
    sizes.forEach(([w, h], k) => {
      const r = k < 2 ? 24 : 28;
      for (const kind of ['outline', 'panel']) {
        const item = `box_${ratio}_${SIZES[k]}-${w}x${h}_${kind}`;
        els.push({
          section: 'boxes', item, title: `${ratio} ${SIZES[k].toUpperCase()} ${kind}`, w, h,
          points(s) {
            const o = PAD * s;
            const pts = strokePoints(roundRect(o, o, w * s, h * s, r * s), s, seedOf(item));
            if (kind === 'panel') {
              const inset = 10 * s;
              const rr = (r - 6) * s;
              const inside = (px, py) => {
                const qx = Math.max(Math.abs(px - (o + (w * s) / 2)) - ((w * s) / 2 - inset - rr), 0);
                const qy = Math.max(Math.abs(py - (o + (h * s) / 2)) - ((h * s) / 2 - inset - rr), 0);
                return Math.hypot(qx, qy) <= rr;
              };
              pts.push(...fillPoints(P.random(seedOf(item) ^ 7), inside, o, o, w * s, h * s, 13 * s, 0.3));
            }
            return pts;
          },
        });
      }
    });
  }

  // Circles: rings, discs (ring plus dust), and single-particle bullets.
  for (const d of [48, 96, 160, 240, 360, 480, 720, 960]) {
    const item = `ring_${d}`;
    els.push({ section: 'circles', item, title: `Ring ${d}`, w: d, h: d,
      points: (s) => strokePoints([['arc', (PAD + d / 2) * s, (PAD + d / 2) * s, (d / 2) * s, 0, 360]], s, seedOf(item)) });
  }
  for (const d of [96, 160, 240, 360, 480, 720]) {
    const item = `disc_${d}`;
    els.push({ section: 'circles', item, title: `Disc ${d}`, w: d, h: d,
      points(s) {
        const c = (PAD + d / 2) * s, r = (d / 2) * s;
        const pts = strokePoints([['arc', c, c, r, 0, 360]], s, seedOf(item));
        const inside = (px, py) => Math.hypot(px - c, py - c) <= r - 9 * s;
        pts.push(...fillPoints(P.random(seedOf(item) ^ 7), inside, c - r, c - r, 2 * r, 2 * r, 13 * s, 0.3));
        return pts;
      } });
  }
  // A bright in-focus spark, and soft bokeh discs at three sizes: bullets and accents.
  els.push({ section: 'circles', item: 'bullet_spark', title: 'Bullet, spark', w: 8, h: 8, pad: 12,
    points: (s) => [[(12 + 4) * s, (12 + 4) * s, 1]], spark: true });
  for (const d of [24, 48, 96]) {
    const R = d / 2;
    els.push({ section: 'circles', item: `bullet_bokeh-${d}`, title: `Bullet, bokeh ${d}`, w: d, h: d, pad: 8,
      points: (s) => [[(8 + R) * s, (8 + R) * s, 1]], bokeh: R });
  }

  // Chevrons: thin marks, doubles, and the process-step outline.
  for (const H of [24, 48, 96, 160, 240]) {
    for (const dir of ['right', 'left', 'up', 'down']) {
      const vertical = dir === 'up' || dir === 'down';
      const w = vertical ? H : H / 2, h = vertical ? H / 2 : H;
      const item = `chevron_${dir}-${H}`;
      els.push({ section: 'chevrons', item, title: `Chevron ${dir} ${H}`, w, h,
        points(s) {
          const cx = (PAD + w / 2) * s, cy = (PAD + h / 2) * s;
          const half = (H / 2) * s, q = (H / 4) * s;
          const right = polyline([[cx - q, cy - half], [cx + q, cy], [cx - q, cy + half]]);
          return strokePoints(orient(right, dir, cx, cy), s, seedOf(item));
        } });
    }
  }
  for (const H of [48, 96, 160]) {
    for (const dir of ['right', 'left', 'up', 'down']) {
      const vertical = dir === 'up' || dir === 'down';
      const len = H * 0.92;
      const w = vertical ? H : len, h = vertical ? len : H;
      const item = `chevron-double_${dir}-${H}`;
      els.push({ section: 'chevrons', item, title: `Double chevron ${dir} ${H}`, w, h,
        points(s) {
          const cx = (PAD + w / 2) * s, cy = (PAD + h / 2) * s;
          const half = (H / 2) * s, L = (len / 2) * s, gap = H * 0.42 * s;
          const a = polyline([[cx - L, cy - half], [cx - L + half, cy], [cx - L, cy + half]]);
          const b = polyline([[cx - L + gap, cy - half], [cx - L + gap + half, cy], [cx - L + gap, cy + half]]);
          return strokePoints(orient([...a, ...b], dir, cx, cy), s, seedOf(item));
        } });
    }
  }
  for (const [w, h] of [[280, 100], [360, 120], [480, 160]]) {
    for (const kind of ['first', 'middle', 'last']) {
      const item = `process-chevron_${kind}-${w}x${h}`;
      els.push({ section: 'chevrons', item, title: `Process step, ${kind}, ${w}x${h}`, w, h,
        points(s) {
          const o = PAD * s, W = w * s, Hh = h * s, n = h * 0.32 * s;
          const shape = kind === 'first'
            ? [[o, o], [o + W - n, o], [o + W, o + Hh / 2], [o + W - n, o + Hh], [o, o + Hh]]
            : kind === 'middle'
              ? [[o, o], [o + W - n, o], [o + W, o + Hh / 2], [o + W - n, o + Hh], [o, o + Hh], [o + n, o + Hh / 2]]
              : [[o, o], [o + W, o], [o + W, o + Hh], [o, o + Hh], [o + n, o + Hh / 2]];
          return strokePoints(polyline(shape, true), s, seedOf(item));
        } });
    }
  }

  // Arrows: a long shaft that gathers out of nothing at its tail, and an open head.
  const HEAD = 18;
  const arrow = (dir, L) => {
    const vertical = dir === 'up' || dir === 'down';
    const w = vertical ? HEAD * 2 : L, h = vertical ? L : HEAD * 2;
    const item = `arrow_${dir}-${L}`;
    return { section: 'arrows', item, title: `Arrow ${dir} ${L}`, w, h,
      points(s) {
        const cx = (PAD + w / 2) * s, cy = (PAD + h / 2) * s;
        const x0 = cx - (L / 2) * s, x1 = cx + (L / 2) * s, a = HEAD * s;
        const right = [['line', x0, cy, x1, cy], ['line', x1, cy, x1 - a, cy - a], ['line', x1, cy, x1 - a, cy + a]];
        const fade = (index, along) => (index === 0 ? P.smoothstep(0, Math.min(0.22, 260 / L), along) : 1);
        return strokePoints(orient(right, dir, cx, cy), s, seedOf(item), fade);
      } };
  };
  for (const L of [240, 480, 720, 960, 1440, 1800]) for (const dir of ['right', 'left']) els.push(arrow(dir, L));
  for (const L of [240, 480, 720, 960]) for (const dir of ['down', 'up']) els.push(arrow(dir, L));

  // Lines: dividers that fade in and out at both ends, like the timeline's tape.
  const line = (dir, L) => {
    const vertical = dir === 'vertical';
    const w = vertical ? 4 : L, h = vertical ? L : 4;
    const item = `line_${dir}-${L}`;
    return { section: 'lines', item, title: `Line ${dir} ${L}`, w, h,
      points(s) {
        const cx = (PAD + w / 2) * s, cy = (PAD + h / 2) * s, half = (L / 2) * s;
        const st = vertical ? [['line', cx, cy - half, cx, cy + half]] : [['line', cx - half, cy, cx + half, cy]];
        const fade = (_, along) => P.smoothstep(0, 0.15, along) * P.smoothstep(1, 0.85, along);
        return strokePoints(st, s, seedOf(item), fade);
      } };
  };
  for (const L of [240, 480, 960, 1440, 1800]) els.push(line('horizontal', L));
  for (const L of [240, 480, 720, 960]) els.push(line('vertical', L));

  // The road from the opening, as a band across a full slide.
  els.push({ section: 'lines', item: 'ribbon_1920x600', title: 'Ribbon 1920x600', w: 1920, h: 600, pad: 0,
    ribbon: true, focus: 6, aperture: 0.08 });

  return els;
}

// The particle logo: the lockup and the X traced into particles from the logo's alpha.
function logoElements() {
  const src = readPNG(path.join(REPO, 'assets/gridX_logo.png'));
  const parts = [
    { name: 'lockup', crop: [0, 0, 2048, 256], width: 960 },
    { name: 'mark', crop: [1416, 0, 632, 256], width: 240 },
  ];
  const els = [];
  for (const part of parts) {
    const img = crop(src, ...part.crop);
    const k = part.width / img.width;
    const h = Math.round(img.height * k);
    for (const mode of ['outline', 'fill']) {
      const item = `particle-logo_${part.name}-${mode}_${part.width}`;
      // Spacing is set in slide pixels and converted to the source's.
      const spacing = (mode === 'outline' ? 2.6 : 4.4) / k;
      const pts = P.imagePoints(img, { mode, spacing, tone: 'alpha', seed: seedOf(item) });
      els.push({ section: 'logo', item, title: `Particle logo, ${part.name}, ${mode}`, w: part.width, h, soft: 0.03,
        points: (s) => pts.map(([x, y, wt]) => [(PAD + x * k) * s, (PAD + y * k) * s, wt]) });
    }
  }
  return els;
}

function particles() {
  const els = [...particleElements(), ...logoElements()];
  let files = 0;
  for (const el of els) {
    const pad = el.pad == null ? PAD : el.pad;
    for (const s of scalesFor(el.w + pad * 2, el.h + pad * 2)) {
      const W = Math.round((el.w + pad * 2) * s), H = Math.round((el.h + pad * 2) * s);
      let light;
      let inkLight = null;
      if (el.ribbon) {
        // Drawn in a full slide frame and cut to the band through its middle.
        const frame = P.ribbon(1920 * s, 1080 * s, { count: 12000 });
        const top = ((1080 - el.h) / 2) * s;
        const shifted = frame.map((p) => ({ ...p, y: p.y - top }));
        light = P.render(W, H, shifted, P.camera({ scale: s, focus: el.focus, aperture: el.aperture }));
      } else if (el.spark || el.bokeh) {
        // One particle. A bokeh disc of radius R comes from the depth whose circle of
        // confusion is R at the drift's aperture (grid-bg.js PARTICLE_VS, solved for depth).
        const [[x, y]] = el.points(s);
        const aperture = 0.085, focus = 6;
        const d = el.bokeh ? (91.8 * focus) / (91.8 + focus * el.bokeh) : focus;
        const p = { x, y, d, a: el.bokeh ? 4.2 : 3.2, c: [1.15, 1.12, 1.08] };
        light = P.render(W, H, [p], P.camera({ scale: s, focus, aperture }));
      } else {
        // Ink keeps every point in focus: on a white page a soft disc reads as a smudge.
        const pts = el.points(s);
        const cam = P.camera({ scale: s, focus: el.focus || 6, aperture: el.aperture || 0.06 });
        const opts = { seed: seedOf(el.item) ^ 0x2e9f, focus: 6 };
        // Small shapes keep every point in focus: a soft disc is too large a share of them.
        const soft = el.soft ?? (Math.max(el.w, el.h) < 100 ? 0 : 0.06);
        light = P.render(W, H, P.formation(pts, { ...opts, soft }), cam);
        inkLight = P.render(W, H, P.formation(pts, { ...opts, soft: 0 }), cam);
      }
      const name = `gridx_${el.item}`;
      const meta = { group: 'particles', section: el.section, item: el.item, title: el.title, scale: s };
      writePNG(`02_particles/${el.section}/light/${name}_light@${s}x.png`, W, H, P.toTransparent(W, H, light), { ...meta, tone: 'light' });
      writePNG(`02_particles/${el.section}/ink/${name}_ink@${s}x.png`, W, H, P.toTransparent(W, H, inkLight || light, { color: INK, strength: 2.4 }), { ...meta, tone: 'ink' });
      files += 2;
    }
  }
  log(`  particles: ${els.length} shapes, ${files} files`);
}

// ---------------------------------------------------------------- 03 logo
function crop(img, x, y, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) data.set(img.data.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4), j * w * 4);
  return { width: w, height: h, data };
}

function trim(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let j = 0; j < img.height; j++) {
    for (let i = 0; i < img.width; i++) {
      if (img.data[(j * img.width + i) * 4 + 3] > 8) {
        if (i < x0) x0 = i;
        if (i > x1) x1 = i;
        if (j < y0) y0 = j;
        if (j > y1) y1 = j;
      }
    }
  }
  return crop(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

const lanczos3 = (x) => {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};

// One pass of a separable Lanczos-3 resize over premultiplied RGBA floats: `count` lines of
// `from` samples become lines of `to`; at(k, line) and put(i, line) give the offsets.
function resizeAxis(input, output, from, to, count, at, put) {
  const scale = to / from;
  const f = Math.max(1, 1 / scale);
  const support = 3 * f;
  for (let i = 0; i < to; i++) {
    const center = (i + 0.5) / scale - 0.5;
    const lo = Math.ceil(center - support), hi = Math.floor(center + support);
    const weights = [];
    let sum = 0;
    for (let k = lo; k <= hi; k++) {
      const w = lanczos3((k - center) / f);
      weights.push(w);
      sum += w;
    }
    for (let line = 0; line < count; line++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = lo; k <= hi; k++) {
        const w = weights[k - lo];
        const o = at(Math.min(from - 1, Math.max(0, k)), line);
        r += input[o] * w; g += input[o + 1] * w; b += input[o + 2] * w; a += input[o + 3] * w;
      }
      const o = put(i, line);
      output[o] = r / sum; output[o + 1] = g / sum; output[o + 2] = b / sum; output[o + 3] = a / sum;
    }
  }
}

// The logo at any width. There is no vector logo, so enlarging re-sharpens the alpha edge to
// the width it had at the source's resolution; `color` (sRGB) recolours it, keeping the alpha.
function resizeLogo(img, width, color = null) {
  const sw = img.width, sh = img.height;
  const height = Math.round((sh * width) / sw);
  const pre = new Float32Array(sw * sh * 4);
  for (let p = 0; p < sw * sh; p++) {
    const a = img.data[p * 4 + 3] / 255;
    pre[p * 4] = (img.data[p * 4] / 255) * a;
    pre[p * 4 + 1] = (img.data[p * 4 + 1] / 255) * a;
    pre[p * 4 + 2] = (img.data[p * 4 + 2] / 255) * a;
    pre[p * 4 + 3] = a;
  }
  const tmp = new Float32Array(width * sh * 4);
  resizeAxis(pre, tmp, sw, width, sh, (k, line) => (line * sw + k) * 4, (i, line) => (line * width + i) * 4);
  const out = new Float32Array(width * height * 4);
  resizeAxis(tmp, out, sh, height, width, (k, line) => (k * width + line) * 4, (i, line) => (i * width + line) * 4);
  const up = width / sw;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const A = out[p * 4 + 3];
    let a = Math.min(1, Math.max(0, A));
    if (up > 1) a = Math.min(1, Math.max(0, (a - 0.5) * up + 0.5));
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) {
      rgba[p * 4 + c] = color ? color[c] : (A > 1e-4 ? (out[p * 4 + c] / A) * 255 + 0.5 : 0);
    }
    rgba[p * 4 + 3] = a * 255 + 0.5;
  }
  return { width, height, data: rgba };
}

function logo() {
  const gridx = readPNG(path.join(REPO, 'assets/gridX_logo.png'));
  const pod = readPNG(path.join(REPO, 'assets/powerpod-logo.png'));
  const sets = [
    { brand: 'gridx', dir: '03_logo', img: trim(gridx), part: 'lockup', widths: [512, 1024, 2048, 4096] },
    { brand: 'gridx', dir: '03_logo', img: trim(crop(gridx, 0, 0, 1308, 256)), part: 'wordmark', widths: [512, 1024, 2048] },
    { brand: 'gridx', dir: '03_logo', img: trim(crop(gridx, 1416, 0, 632, 256)), part: 'mark', widths: [128, 256, 512, 1024] },
    { brand: 'powerpod', dir: '03_logo/powerpod', img: trim(pod), part: 'lockup', widths: [512, 1024, 2048] },
  ];
  const colors = { color: null, black: [0, 0, 0], white: [255, 255, 255] };
  for (const set of sets) {
    for (const [tone, color] of Object.entries(colors)) {
      for (const w of set.widths) {
        const out = resizeLogo(set.img, w, color);
        writePNG(`${set.dir}/${set.brand}_logo_${set.part}_${tone}_${w}w.png`, out.width, out.height, out.data,
          { group: 'logo', section: `${set.brand}-${set.part}`, item: `${set.brand} ${set.part}`, tone, scale: w });
      }
    }
  }
  log('  logo done');
}

// ---------------------------------------------------------------- Chrome-drawn parts
const YEARS = [
  { label: '2018', theme: 'Where it started' },
  { label: '2021', theme: 'From campus rides to a company' },
  { label: '2022', theme: 'Software, and a grant' },
  { label: '2023', theme: 'Delhi, a team, a product' },
  { label: '2024', theme: 'Out in the world' },
  { label: '2025', theme: 'Out of the garage' },
  { label: '2026', theme: 'From prototype to the road' },
];

const BOXES_FOR_CARDS = [
  ['square', [[240, 240], [360, 360], [480, 480], [720, 720]]],
  ['4x3', [[320, 240], [480, 360], [640, 480], [960, 720]]],
  ['16x9', [[384, 216], [640, 360], [960, 540], [1600, 900]]],
  ['4x5', [[288, 360], [384, 480], [480, 600], [640, 800]]],
  ['3x4', [[240, 320], [360, 480], [480, 640], [720, 960]]],
  ['banner-4x1', [[480, 120], [960, 240], [1440, 360], [1760, 440]]],
];

async function withChrome(fn) {
  const port = 8131;
  const server = await serve({ root: REPO, port, quiet: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS, protocolTimeout: 600000 });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 2000, height: 1200, deviceScaleFactor: 1 });
    await page.goto(`http://localhost:${port}/tools/design-kit/kit.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => window.kit.ready);
    await fn(page);
  } finally {
    await browser.close();
    server.close();
  }
}

async function capture(page, scale, build, args) {
  const vp = page.viewport();
  if (vp.deviceScaleFactor !== scale) await page.setViewport({ width: 2000, height: 1200, deviceScaleFactor: scale });
  await page.evaluate((b, a) => { window.kit[b](a); }, build, args);
  const el = await page.$('#stage > *');
  return el.screenshot({ omitBackground: true, type: 'png' });
}

async function pills(page) {
  const SIZES = { desktop: 44, tablet: 52, phone: 56 };
  for (const s of [1, 2, 4]) {
    for (const [size, h] of Object.entries(SIZES)) {
      for (const active of ['home', 'store', 'dealers', 'support', 'journey']) {
        const context = active === 'journey' ? 'journey' : null;
        const buf = await capture(page, s, 'pill', { size, active, context });
        writeBuffer(`04_pill/expanded/gridx_pill_${size}-${h}_${active}-active@${s}x.png`, buf,
          { group: 'pill', section: 'expanded', item: `${size}-${h}_${active}`, title: `${size} ${h}px, ${active} active`, scale: s });
        const icon = await capture(page, s, 'pill', { size, active, compact: true });
        writeBuffer(`04_pill/compact/gridx_pill_compact-${h}_${active}@${s}x.png`, icon,
          { group: 'pill', section: 'compact', item: `compact-${h}_${active}`, title: `Compact ${h}px, ${active}`, scale: s });
      }
      for (const width of [160, 280, 400]) {
        const buf = await capture(page, s, 'pill', { size, blank: true, width });
        writeBuffer(`04_pill/blank/gridx_pill_blank-${h}_${width}w@${s}x.png`, buf,
          { group: 'pill', section: 'blank', item: `blank-${h}_${width}w`, title: `Blank ${h}px x ${width}`, scale: s });
      }
    }
  }
  log('  pill done');
}

async function cards(page) {
  const SIZES = ['s', 'm', 'l', 'xl'];
  for (const [ratio, sizes] of BOXES_FOR_CARDS) {
    for (const [k, [w, h]] of sizes.entries()) {
      const radius = k < 2 ? 24 : 28;
      for (const s of scalesFor(w + 80, h + 80, [1, 2])) {
        const buf = await capture(page, s, 'card', { width: w, height: h, radius });
        writeBuffer(`06_cards-buttons/cards/gridx_card_glass_${ratio}_${SIZES[k]}-${w}x${h}@${s}x.png`, buf,
          { group: 'cards', section: 'cards', item: `glass_${ratio}_${SIZES[k]}-${w}x${h}`, title: `Glass card ${ratio} ${SIZES[k].toUpperCase()}`, scale: s });
      }
    }
  }
  for (const style of ['black', 'ink', 'glass', 'dark']) {
    for (const width of [160, 200, 240]) {
      for (const s of [1, 2, 4]) {
        const buf = await capture(page, s, 'button', { style, width });
        writeBuffer(`06_cards-buttons/buttons/gridx_button_${style}_${width}w@${s}x.png`, buf,
          { group: 'cards', section: 'buttons', item: `${style}_${width}w`, title: `Button, ${style}, ${width}`, scale: s });
      }
    }
  }
  log('  cards and buttons done');
}

async function timelines(page) {
  const draw = async (spec) => {
    const url = await page.evaluate((a) => window.kit.timeline(a), spec);
    return Buffer.from(url.split(',')[1], 'base64');
  };
  for (const width of [1920, 1600]) {
    for (const tone of ['ink', 'white']) {
      for (const s of scalesFor(width, 1, [1, 2])) {
        const variants = [{ key: 'all', all: true }, ...YEARS.map((y, i) => ({ key: `active-${y.label}`, active: i }))];
        for (const v of variants) {
          for (const captions of [false, true]) {
            const buf = await draw({ width, years: YEARS, active: v.active ?? null, all: !!v.all, captions, tone, scale: s });
            const cap = captions ? '_captions' : '';
            writeBuffer(`05_timeline/journey/gridx_timeline_2018-2026_${v.key}${cap}_${tone}_${width}w@${s}x.png`, buf,
              { group: 'timeline', section: 'journey', item: `${v.key}${cap}_${width}w`, title: `2018-2026, ${v.key.replace('-', ' ')}${captions ? ', captions' : ''}`, tone, scale: s });
          }
        }
        for (let n = 3; n <= 8; n++) {
          const years = Array.from({ length: n }, () => ({ label: '' }));
          const buf = await draw({ width, years, all: true, tone, scale: s });
          writeBuffer(`05_timeline/blank/gridx_timeline_blank-${n}-nodes_${tone}_${width}w@${s}x.png`, buf,
            { group: 'timeline', section: 'blank', item: `blank-${n}-nodes_${width}w`, title: `Blank, ${n} nodes`, tone, scale: s });
        }
      }
    }
  }
  for (const tone of ['ink', 'white']) {
    for (const s of [1, 2, 4]) {
      const buf = await draw({ width: 24, needleOnly: true, tone, scale: s });
      writeBuffer(`05_timeline/gridx_timeline_needle_${tone}@${s}x.png`, buf,
        { group: 'timeline', section: 'needle', item: 'needle', title: 'Needle', tone, scale: s });
    }
  }
  log('  timeline done');
}

// ---------------------------------------------------------------- 07 tokens
// A studio grey as the composite shows it (no particles, no dither).
function studioHex(w, h, fx, fy, house = 1) {
  const base = P.studio(w, h);
  const v = base[Math.round(fy * (h - 1)) * w + Math.round(fx * (w - 1))];
  const TINT = [1.0, 0.996, 0.988];
  return '#' + TINT.map((t) => {
    let lin = Math.pow(v * t, 2.2) * house;
    const over = Math.max(lin - 0.8, 0);
    lin = Math.min(lin, 0.8) + 0.2 * (1 - Math.exp(-over / 0.2));
    return Math.round(Math.pow(lin, 1 / 2.2) * 255).toString(16).padStart(2, '0');
  }).join('').toUpperCase();
}

function swatches() {
  const s = (name, hex, css = hex) => ({ name, hex, css });
  return [
    s('Ink', '#141414'),
    s('Ink soft', '#141414 at 78%', 'rgb(20 20 20 / 0.78)'),
    s('Ink quiet', '#141414 at 52%', 'rgb(20 20 20 / 0.52)'),
    s('Ink faint', '#141414 at 40%', 'rgb(20 20 20 / 0.4)'),
    s('Studio wall', studioHex(1920, 1080, 0.06, 0.08)),
    s('Studio key light', studioHex(1920, 1080, 0.41, 0.29)),
    s('Studio horizon', studioHex(1920, 1080, 0.82, 0.42)),
    s('Studio floor', studioHex(1920, 1080, 0.5, 0.82)),
    s('Night room', studioHex(1920, 1080, 0.5, 0.6, NIGHT.house)),
    s('Pill black', '#000000'),
    s('Logo sage', '#98C082'),
    s('Logo navy', '#1E1E2F'),
    s('Particle warm white', '#FFF9F0'),
    s('Particle sage', '#B3C999'),
  ];
}

function dataURL(file) {
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

function ensureBackground(id, w, h) {
  const file = path.join(OUT, `01_backgrounds/${id}/gridx_bg_${id}_16x9_${w}x${h}.png`);
  if (!fs.existsSync(file)) {
    const base = P.studio(w, h);
    const night = id.startsWith('night');
    const rgba = P.compose(w, h, base, null, night ? NIGHT : {});
    const png = new PNG({ width: w, height: h });
    png.data = Buffer.from(rgba.buffer);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PNG.sync.write(png, { colorType: 2 }));
  }
  return file;
}

async function tokens(page) {
  const background = dataURL(ensureBackground('studio', 1920, 1080));
  const list = swatches();
  for (const s of [1, 2]) {
    const buf = await capture(page, s, 'tokens', { background, swatches: list });
    writeBuffer(`07_tokens/gridx_tokens_sheet@${s}x.png`, buf, { group: 'tokens', section: 'sheet', item: 'sheet', title: 'Tokens sheet', scale: s });
  }
  fs.writeFileSync(path.join(OUT, '07_tokens/gridx_tokens.json'), `${JSON.stringify({
    font: { family: 'DM Sans', weights: [400, 500, 600, 700], source: 'https://fonts.google.com/specimen/DM+Sans' },
    colors: Object.fromEntries(list.map((c) => [c.name, c.hex])),
    type: {
      headline: { weight: 500, tracking: '-0.03em', lineHeight: 1.02 },
      yearTitle: { weight: 600, tracking: '-0.065em', numerals: 'tabular' },
      heading: { weight: 600, tracking: '-0.03em', lineHeight: 1.05 },
      body: { weight: 500, tracking: '-0.01em', lineHeight: 1.5, color: 'ink 78%' },
      eyebrow: { weight: 500, size: '0.72rem', tracking: '0.09em', case: 'uppercase', color: 'ink 40%' },
    },
    radii: { card: 24, cardLarge: 28, frame: 14, pill: 999 },
    pill: { heights: { desktop: 44, tablet: 52, phone: 56 }, tab: '36 / 42 / 48', thumb: 'white 14%', text: 'white 60%, current 100%' },
  }, null, 2)}\n`);
  log('  tokens done');
}

// Two slides put together from the kit, to show how the parts sit at @1x on a 16:9 slide.
async function examples(page) {
  const img = (rel) => dataURL(path.join(OUT, rel));
  const need = [
    '01_backgrounds/studio-ribbon/gridx_bg_studio-ribbon_16x9_1920x1080.png',
    '01_backgrounds/studio-grid/gridx_bg_studio-grid_16x9_1920x1080.png',
    '03_logo/gridx_logo_lockup_black_512w.png',
    '02_particles/boxes/light/gridx_box_4x5_s-288x360_outline_light@1x.png',
    '02_particles/arrows/light/gridx_arrow_right-240_light@1x.png',
    '05_timeline/journey/gridx_timeline_2018-2026_active-2025_ink_1600w@1x.png',
    '04_pill/expanded/gridx_pill_desktop-44_home-active@1x.png',
  ];
  if (!need.every((rel) => fs.existsSync(path.join(OUT, rel)))) {
    log('  examples skipped (run the full kit first)');
    return;
  }
  const slides = [
    { key: 'title', html: `
      <div style="position:relative;width:1920px;height:1080px;background:url(${img(need[0])}) center/cover">
        <img src="${img(need[2])}" style="position:absolute;left:104px;top:88px;width:256px">
        <img src="${img(need[6])}" style="position:absolute;right:72px;top:56px">
        <div style="position:absolute;left:0;right:0;top:770px;text-align:center">
          <div style="font-size:96px;font-weight:500;letter-spacing:-0.03em;line-height:1.02">The only battery you need</div>
          <div style="margin-top:22px;font-size:26px;font-weight:500;letter-spacing:-0.01em;color:rgb(20 20 20 / 0.52)">Investor update · October 2026</div>
        </div>
      </div>` },
    { key: 'content', html: `
      <div style="position:relative;width:1920px;height:1080px;background:url(${img(need[1])}) center/cover">
        <img src="${img(need[2])}" style="position:absolute;left:104px;top:88px;width:180px">
        <div style="position:absolute;left:104px;top:190px;font-size:12px;font-weight:500;letter-spacing:0.09em;text-transform:uppercase;color:rgb(20 20 20 / 0.4)">How it works</div>
        <div style="position:absolute;left:104px;top:216px;font-size:60px;font-weight:600;letter-spacing:-0.03em;line-height:1.05">Swap, charge, ride</div>
        ${[0, 1, 2].map((i) => `
          <img src="${img(need[3])}" style="position:absolute;left:${360 + i * 448}px;top:360px">
          <div style="position:absolute;left:${360 + i * 448 + 16 + 34}px;top:${360 + 16 + 40}px;width:240px">
            <div style="font-size:64px;font-weight:600;letter-spacing:-0.065em;line-height:1">0${i + 1}</div>
            <div style="margin-top:150px;font-size:28px;font-weight:600;letter-spacing:-0.03em">${['Swap', 'Charge', 'Ride'][i]}</div>
            <div style="margin-top:8px;font-size:17px;font-weight:500;letter-spacing:-0.01em;line-height:1.45;color:rgb(20 20 20 / 0.78)">${['Trade a spent pack for a full one in seconds.', 'Packs refill at the dock, on clean power.', 'Back on the road with a full range.'][i]}</div>
          </div>
          ${i < 2 ? `<img src="${img(need[4])}" style="position:absolute;left:${360 + i * 448 + 320 + 8}px;top:${360 + 196 - 34}px;width:136px">` : ''}
        `).join('')}
        <img src="${img(need[5])}" style="position:absolute;left:160px;top:850px">
      </div>` },
  ];
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  for (const slide of slides) {
    await page.evaluate((html) => { document.getElementById('stage').innerHTML = html; }, slide.html);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    const el = await page.$('#stage > *');
    const buf = await el.screenshot({ type: 'png' });
    writeBuffer(`07_tokens/gridx_example-slide_${slide.key}.png`, buf, { group: 'tokens', section: 'examples', item: slide.key, title: `Example slide, ${slide.key}`, scale: 1 });
  }
  log('  example slides done');
}

// ---------------------------------------------------------------- Particle Studio
function studioTool() {
  const dir = path.join(OUT, 'Particle Studio');
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'studio/index.html'), path.join(dir, 'index.html'));
  fs.copyFileSync(path.join(HERE, 'particles.js'), path.join(dir, 'particles.js'));
  fs.copyFileSync(path.join(REPO, 'assets/fonts/dm-sans-latin.woff2'), path.join(dir, 'fonts/dm-sans-latin.woff2'));
  log('  Particle Studio copied');
}

// ---------------------------------------------------------------- run
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  log(`GridX design kit -> ${OUT}`);
  const t0 = Date.now();
  if (wants('backgrounds')) backgrounds();
  if (wants('particles')) particles();
  if (wants('logo')) logo();
  const chrome = ['pill', 'cards', 'timeline', 'tokens'].filter(wants);
  if (chrome.length) {
    await withChrome(async (page) => {
      if (wants('pill')) await pills(page);
      if (wants('cards')) await cards(page);
      if (wants('timeline')) await timelines(page);
      if (wants('tokens')) {
        await tokens(page);
        await examples(page);
      }
    });
  }
  if (wants('studio')) studioTool();

  // The manifest accumulates across partial runs, so the README always lists everything.
  const listFile = path.join(OUT, '.kit-manifest.json');
  const previous = fs.existsSync(listFile) ? JSON.parse(fs.readFileSync(listFile, 'utf8')) : [];
  const merged = new Map(previous.map((m) => [m.rel, m]));
  for (const m of manifest) merged.set(m.rel, m);
  const all = [...merged.values()].filter((m) => fs.existsSync(path.join(OUT, m.rel)));
  fs.writeFileSync(listFile, JSON.stringify(all));
  if (wants('readme')) {
    const { readme } = await import('./readme.mjs');
    fs.writeFileSync(path.join(OUT, 'README.html'), readme(all, { formats: FORMATS, backgrounds: BACKGROUNDS, swatches: swatches() }));
    log('  README written');
  }

  // Every file written this run must be a real PNG of the size the manifest says.
  let bad = 0;
  for (const m of manifest) {
    const buf = fs.readFileSync(path.join(OUT, m.rel));
    if (buf.length < 100 || buf.readUInt32BE(16) !== m.width || buf.readUInt32BE(20) !== m.height) {
      log(`  BAD ${m.rel}`);
      bad++;
    }
  }
  const counts = {};
  for (const m of manifest) counts[m.group] = (counts[m.group] || 0) + 1;
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${manifest.length} files ${JSON.stringify(counts)}${bad ? `, ${bad} BAD` : ''}`);
  if (bad) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
