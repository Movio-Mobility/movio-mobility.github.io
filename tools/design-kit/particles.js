/*
 * GridX particles: still frames of the site's field, for the deck kit and Particle Studio.
 * ------------------------------------------------------------------------------------
 * A plain-JS port of the maths in assets/grid-bg.js, so a picture made here looks like the
 * site without a GPU, at any size, the same every time it is drawn:
 *
 *   studio()   the grey cyclorama (STUDIO_FS studio()), the lights' wander at rest
 *   splat()    one particle into a float light buffer (PARTICLE_VS + PARTICLE_FS): the
 *              thin-lens circle of confusion, the soft in-focus glow, the 70/30 circle and
 *              hexagon bokeh disc with its brighter rim
 *   compose()  the composite (STUDIO_FS main()): linear light, the soft shoulder, gamma, dither
 *   toTransparent()  the light buffer alone, as a PNG-ready RGBA with straight alpha
 *
 * Fields (lists of particles) are built by formation(), drift(), grid() and ribbon(), and from
 * pictures by imagePoints(). Particle sizes are CSS pixels of a 1080-line frame times `scale`,
 * so a 2x render is the same artwork with twice the pixels.
 *
 * Loads as a classic script (window.GridParticles) or as a CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GridParticles = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const TAN_HALF_FOV = Math.tan((25 * Math.PI) / 180);
  const WARM = [1.0, 0.975, 0.94];   // the field's warm white
  const SAGE = [0.70, 0.79, 0.60];   // what it drifts toward with speed
  const AGED = [0.86, 0.82, 0.77];   // and toward with age
  const TINT = [1.0, 0.996, 0.988];  // the studio's paper tint

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const mix = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const sq = (x) => x * x;

  // Seeded random numbers (mulberry32): one seed, one picture, at every size.
  function random(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A per-pixel hash for the dither, so it never repeats as a pattern.
  function hash2(x, y, s) {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------- studio
  // The grey value of every pixel, before the tint: darker wall top-left, key light above the
  // horizon, the bright horizon band strongest on the right, a lighter floor with a light pool
  // at the left edge. Rows run top to bottom here, so c.y needs no flip.
  function studio(width, height) {
    const out = new Float32Array(width * height);
    const minDim = Math.min(width, height);
    const aspect = width / height;
    const portrait = clamp((1 - aspect) / 0.55, 0, 1);
    const horizon = mix(-0.12, -0.17, portrait);
    const leftEdge = -0.5 * Math.max(aspect, 1);
    for (let j = 0; j < height; j++) {
      const cy = (j + 0.5 - height / 2) / minDim;
      const by = cy - horizon;
      const wallY = 0.11 * smoothstep(-0.7, horizon, cy);
      const floorY = 0.80 + 0.045 * smoothstep(0.0, 0.7, by);
      const toFloor = smoothstep(-0.012, 0.03, by);
      const band = Math.exp(-sq(by - 0.045) / 0.0035);
      const hy = cy - (horizon - 0.085);
      for (let i = 0; i < width; i++) {
        const cx = (i + 0.5 - width / 2) / minDim;
        const wall = 0.635 + 0.11 * smoothstep(-0.65, 0.65, cx) + wallY;
        let floorV = floorY;
        floorV -= 0.045 * Math.exp(-(sq((cx - leftEdge - 0.25) / 0.35) + sq((by - 0.16) / 0.08)));
        floorV += 0.11 * Math.exp(-(sq((cx - leftEdge) / 0.07) + sq((by - 0.42) / 0.10)));
        floorV -= 0.03 * Math.exp(-(sq(cx / 0.35) + sq((by - 0.62) / 0.2)));
        let v = mix(wall, floorV, toFloor);
        const hx = (cx + 0.14) * 0.75;
        const h2 = hx * hx + hy * hy;
        v += 0.10 * Math.exp(-h2 / 0.012) + 0.035 * Math.exp(-h2 / 0.09);
        v += band * (0.05 + 0.13 * smoothstep(-0.35, 0.55, cx));
        v -= 0.05 * smoothstep(0.45, 1.1, Math.hypot(cx * 0.85, cy));
        out[j * width + i] = v;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- particles
  // What the site's camera knows. `scale` is output pixels per CSS pixel of the reference frame
  // (1080 lines tall for a slide), `minDim`/`resY` that frame in output pixels.
  function camera(opts) {
    const scale = opts.scale || 1;
    const aspect = opts.aspect || 16 / 9;
    return {
      scale,
      resY: opts.resY || 1080 * scale,
      minDim: opts.minDim || opts.resY || 1080 * scale,
      tanHalfY: TAN_HALF_FOV / Math.min(aspect, 1),
      focus: opts.focus || 6,
      aperture: opts.aperture == null ? 0.06 : opts.aperture,
      core: 0.012,     // in-focus glow radius, world units
      minCore: 1.1,    // smallest glow radius, CSS px
      floor: 0.012,    // minimum intensity of large discs
    };
  }

  function sdHexagon(px, py, r) {
    const kx = -0.866025404, ky = 0.5, kz = 0.577350269;
    px = Math.abs(px);
    py = Math.abs(py);
    const d = 2 * Math.min(kx * px + ky * py, 0);
    px -= d * kx;
    py -= d * ky;
    px -= clamp(px, -kz * r, kz * r);
    py -= r;
    return Math.hypot(px, py) * Math.sign(py);
  }

  // One particle, added into `light`: RGB floats (3 per pixel) or one intensity per pixel.
  // p = { x, y (output px), d (depth), a (brightness), c ([r, g, b] linear) }.
  function splat(light, width, height, p, cam) {
    const mono = light.length === width * height;
    const s = cam.scale;
    const halfH = p.d * cam.tanHalfY;
    const pxPerUnit = (0.5 * cam.resY) / halfH;
    const minCore = cam.minCore * s;
    const core = Math.max(cam.core * pxPerUnit, minCore);
    const coc = (cam.aperture * cam.minDim * Math.abs(p.d - cam.focus)) / (p.d * cam.focus);
    const radius = clamp(Math.max(core, coc), minCore, 0.07 * cam.minDim);
    const intensity = Math.max(Math.pow(core / radius, 1.7), cam.floor);
    const defocus = smoothstep(2 * s, 5 * s, radius);
    // In focus the brightness range is compressed: faint dust still sparkles, bright sources
    // don't blow out.
    const k = mix(0.75 * Math.sqrt(p.a), p.a, defocus) * intensity;
    if (!(k > 0)) return;

    const half = Math.max(radius + 1.5 * s, core * 3);
    const x0 = Math.max(0, Math.floor(p.x - half));
    const x1 = Math.min(width - 1, Math.ceil(p.x + half));
    const y0 = Math.max(0, Math.floor(p.y - half));
    const y1 = Math.min(height - 1, Math.ceil(p.y + half));
    if (x0 > x1 || y0 > y1) return;

    const core2 = core * core;
    const edge = 0.9 * s + radius * 0.06;
    const hexR = radius * 0.94;
    const cr = p.c[0] * k, cg = p.c[1] * k, cb = p.c[2] * k;
    const ci = Math.max(p.c[0], p.c[1], p.c[2]) * k;

    for (let j = y0; j <= y1; j++) {
      const uy = p.y - (j + 0.5); // y up, as the shader sees it
      for (let i = x0; i <= x1; i++) {
        const ux = i + 0.5 - p.x;
        const r2 = ux * ux + uy * uy;
        const glow = defocus < 1 ? Math.exp(-r2 / core2) : 0;
        let bokeh = 0;
        if (defocus > 0) {
          const r = Math.sqrt(r2);
          const qx = 0.9659 * ux + 0.2588 * uy;
          const qy = -0.2588 * ux + 0.9659 * uy;
          const sd = mix(r - radius, sdHexagon(qx, qy, hexR), 0.3);
          if (defocus >= 1 && sd >= edge) continue;
          const disc = 1 - smoothstep(-edge, edge, sd);
          const rim = smoothstep(-radius * 0.5, 0, sd) * disc;
          bokeh = disc * 0.78 + rim * 0.32;
        }
        const w = mix(glow, bokeh, defocus);
        if (w < 1e-5) continue;
        const o = j * width + i;
        if (mono) {
          light[o] += ci * w;
        } else {
          light[o * 3] += cr * w;
          light[o * 3 + 1] += cg * w;
          light[o * 3 + 2] += cb * w;
        }
      }
    }
  }

  function render(width, height, particles, cam, mono) {
    const light = new Float32Array(width * height * (mono ? 1 : 3));
    for (const p of particles) splat(light, width, height, p, cam);
    return light;
  }

  // ---------------------------------------------------------------- output
  // The composite pass: the studio and the light added in linear light, the soft shoulder so
  // dense light rolls off instead of clipping, gamma, then a triangular dither against banding.
  // `base` may be null (black stage); a mono `light` takes `color` (linear RGB).
  function compose(width, height, base, light, opts = {}) {
    const house = opts.house == null ? 1 : opts.house;
    const gain = opts.gain == null ? 1 : opts.gain;
    const dither = (opts.dither == null ? 1.5 : opts.dither) / 255;
    const seed = opts.seed || 7;
    const color = opts.color || [1, 1, 1];
    const mono = light && light.length === width * height;
    const out = new Uint8ClampedArray(width * height * 4);
    const ink = [0, 0, 0];
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const p = j * width + i;
        const n = (hash2(i, j, seed) + hash2(i, j, seed + 1) - 1) * dither;
        for (let c = 0; c < 3; c++) {
          let lin = base ? Math.pow(Math.max(base[p] * TINT[c], 0), 2.2) * house : 0;
          if (light) lin += (mono ? light[p] * color[c] : light[p * 3 + c]) * gain;
          const over = Math.max(lin - 0.8, 0);
          lin = Math.min(lin, 0.8) + 0.2 * (1 - Math.exp(-over / 0.2));
          ink[c] = Math.pow(lin, 1 / 2.2) + n;
        }
        out[p * 4] = ink[0] * 255 + 0.5;
        out[p * 4 + 1] = ink[1] * 255 + 0.5;
        out[p * 4 + 2] = ink[2] * 255 + 0.5;
        out[p * 4 + 3] = 255;
      }
    }
    return out;
  }

  // The light alone, for a PNG with no background. Alpha grows with the light (1 - e^-kL), so
  // over the studio it reads the way the field adds light there. Colour is the light's own hue,
  // whitening as it gets brighter the way the composite's shoulder whitens it, or a fixed
  // `color` (sRGB 0-255) such as ink for white pages.
  function toTransparent(width, height, light, opts = {}) {
    const strength = opts.strength || 3;
    const fixed = opts.color || null;
    const tint = opts.tint || [1, 1, 1];
    const mono = light.length === width * height;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      const r = mono ? light[p] * tint[0] : light[p * 3];
      const g = mono ? light[p] * tint[1] : light[p * 3 + 1];
      const b = mono ? light[p] * tint[2] : light[p * 3 + 2];
      const m = Math.max(r, g, b);
      if (!(m > 1e-5)) continue;
      const alpha = 1 - Math.exp(-strength * m);
      if (fixed) {
        out[p * 4] = fixed[0];
        out[p * 4 + 1] = fixed[1];
        out[p * 4 + 2] = fixed[2];
      } else {
        const white = smoothstep(0.15, 1.1, m);
        out[p * 4] = Math.pow(mix(r / m, 1, white), 1 / 2.2) * 255 + 0.5;
        out[p * 4 + 1] = Math.pow(mix(g / m, 1, white), 1 / 2.2) * 255 + 0.5;
        out[p * 4 + 2] = Math.pow(mix(b / m, 1, white), 1 / 2.2) * 255 + 0.5;
      }
      out[p * 4 + 3] = alpha * 255 + 0.5;
    }
    return out;
  }

  // ---------------------------------------------------------------- strokes
  // grid-bg.js's stroke format: ['line', x1, y1, x2, y2] | ['quad', x1, y1, cx, cy, x2, y2] |
  // ['arc', cx, cy, r, deg0, deg1]. Coordinates here are output-space pixels, y down.
  function strokePoint(stroke, t) {
    if (stroke[0] === 'line') return [stroke[1] + (stroke[3] - stroke[1]) * t, stroke[2] + (stroke[4] - stroke[2]) * t];
    if (stroke[0] === 'arc') {
      const a = ((stroke[4] + (stroke[5] - stroke[4]) * t) * Math.PI) / 180;
      return [stroke[1] + Math.cos(a) * stroke[3], stroke[2] + Math.sin(a) * stroke[3]];
    }
    const m = 1 - t;
    return [m * m * stroke[1] + 2 * m * t * stroke[3] + t * t * stroke[5], m * m * stroke[2] + 2 * m * t * stroke[4] + t * t * stroke[6]];
  }

  function strokeLength(stroke) {
    if (stroke[0] === 'line') return Math.hypot(stroke[3] - stroke[1], stroke[4] - stroke[2]);
    if (stroke[0] === 'arc') return ((Math.abs(stroke[5] - stroke[4]) * Math.PI) / 180) * stroke[3];
    let length = 0;
    let [px, py] = strokePoint(stroke, 0);
    for (let i = 1; i <= 48; i++) {
      const [x, y] = strokePoint(stroke, i / 48);
      length += Math.hypot(x - px, y - py);
      px = x;
      py = y;
    }
    return length;
  }

  // Evenly spaced points along strokes, carried across stroke ends so joins don't bunch, with
  // a hair of scatter so a line reads as drawn rather than plotted. Each point is
  // [x, y, along, index]: `along` runs 0 to 1 over its stroke, `index` is which stroke.
  function sampleStrokes(strokes, spacing, scatter, rnd) {
    const points = [];
    let offset = spacing * 0.5;
    strokes.forEach((stroke, index) => {
      const len = strokeLength(stroke);
      for (let d = offset; d < len; d += spacing) {
        const [x, y] = strokePoint(stroke, d / len);
        points.push([x + (rnd() - 0.5) * 2 * scatter, y + (rnd() - 0.5) * 2 * scatter, d / len, index]);
      }
      offset = (((offset - len) % spacing) + spacing) % spacing;
    });
    return points;
  }

  // ---------------------------------------------------------------- fields
  // A drawing held by the field (UPDATE_VS with the formation weight at 1): mostly faint dust,
  // about one point in nine a bright spark, warm white leaning a touch toward sage, brightened
  // by the hold. A few points sit off the focal plane so the line keeps some depth; they stay
  // faint, so they soften the line rather than blot it.
  // points: [x, y, weight?, sparkle?]; opts: { focus, seed, soft, sparkle, gain }. The random
  // sequence does not depend on `soft`, so the same points with and without soft ones match.
  function formation(points, opts = {}) {
    const rnd = random(opts.seed || 1);
    const focus = opts.focus || 6;
    const soft = opts.soft == null ? 0.06 : opts.soft;
    const sparkle = opts.sparkle == null ? 1 : opts.sparkle;
    const gain = opts.gain == null ? 1 : opts.gain;
    const out = [];
    for (const pt of points) {
      const weight = pt.length > 2 ? pt[2] : 1;
      const spark = sparkle * (pt.length > 3 ? pt[3] : 1);
      const hz = rnd();
      const hy = rnd();
      const envelope = 0.55 + 0.45 * rnd();
      let a = (0.05 + spark * 3 * Math.pow(hz, 9)) * 1.5 * envelope * gain * weight;
      const sage = clamp(hy * 0.14 + 0.06 + 0.03 * rnd(), 0, 0.3);
      const c = [0, 1, 2].map((i) => mix(WARM[i], SAGE[i], sage) * 1.15);
      let d = focus;
      const off = rnd(), side = rnd(), depth = rnd();
      if (off < soft) {
        d = focus + (side < 0.5 ? -1 : 1) * mix(1.2, 3.5, depth);
        a = Math.min(a, 0.5 * gain * weight);
      }
      if (a > 0) out.push({ x: pt[0], y: pt[1], d, a, c });
    }
    return out;
  }

  // The drift at rest: the field the site leaves after the opening, spread evenly over the
  // frame (one particle per cell of a jittered grid, so there are no clumps or holes), each at
  // its own depth through the frustum, at a random moment of its lifespan.
  function drift(width, height, opts = {}) {
    const rnd = random(opts.seed || 11);
    const count = opts.count || 900;
    const aspect = width / height;
    const cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
    const rows = Math.max(1, Math.round(count / cols));
    const near = opts.near || 1.6;
    const far = opts.far || 16;
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const x = ((q + 0.5 + (rnd() - 0.5) * 0.92) / cols) * width;
        const y = ((r + 0.5 + (rnd() - 0.5) * 0.92) / rows) * height;
        const d = mix(near, far, Math.pow(rnd(), 0.75));
        const hz = rnd();
        const hy = rnd();
        const lt = rnd();
        const envelope = smoothstep(0, 0.15, lt) * (1 - smoothstep(0.8, 1, lt));
        const a = (0.05 + 3 * Math.pow(hz, 9)) * envelope * (opts.gain || 1);
        const speed = 0.1 + 0.4 * rnd();
        const sage = clamp(hy * 0.14 + speed * 0.08, 0, 0.3);
        const aged = smoothstep(0.55, 1, lt) * 0.4;
        const c = [0, 1, 2].map((i) => mix(mix(WARM[i], SAGE[i], sage), AGED[i], aged) * 0.85);
        if (a > 0.002) out.push({ x, y, d, a, c });
      }
    }
    return out;
  }

  // Particles resting on an even lattice, all on the focal plane: faint, a spark here and there,
  // easing off toward the frame's edges the way the studio's light does.
  function grid(width, height, opts = {}) {
    const rnd = random(opts.seed || 23);
    const minDim = Math.min(width, height);
    const step = (opts.spacing || 0.0444) * minDim;
    const cols = Math.floor(width / step);
    const rows = Math.floor(height / step);
    const ox = (width - (cols - 1) * step) / 2;
    const oy = (height - (rows - 1) * step) / 2;
    const focus = opts.focus || 7;
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const x = ox + q * step;
        const y = oy + r * step;
        const nx = (x - width / 2) / (width / 2);
        const ny = (y - height / 2) / (height / 2);
        const fade = 1 - 0.65 * smoothstep(0.35, 1.05, Math.hypot(nx * 0.9, ny));
        const hz = rnd();
        const hy = rnd();
        const a = (0.07 + 1.6 * Math.pow(hz, 14)) * fade * (opts.gain || 1);
        const sage = clamp(hy * 0.14 + 0.03, 0, 0.3);
        const c = [0, 1, 2].map((i) => mix(WARM[i], SAGE[i], sage));
        out.push({ x, y, d: focus, a, c });
      }
    }
    return out;
  }

  // The opening's road: five travelling sine lanes around the focal plane (LANE_GLSL and
  // ribbonTarget), frozen at time `t`.
  function ribbon(width, height, opts = {}) {
    const rnd = random(opts.seed || 31);
    const count = opts.count || 12000;
    const t = opts.t == null ? 2.2 : opts.t;
    const aspect = width / height;
    const tanHalfY = TAN_HALF_FOV / Math.min(aspect, 1);
    const depthOf = (band) => 6 + (band - 2) * 0.55;
    const laneY = (band, x, hw, vs) => {
      const k = 3.9269908 / hw;
      const phase = k * x + t * 0.55 + band * 0.45;
      return (band - 2) * 0.13 * vs + 0.075 * vs * Math.sin(phase) + 0.02 * vs * Math.sin(2.3 * phase - t * 0.3);
    };
    const out = [];
    for (let n = 0; n < count; n++) {
      const h0 = rnd(), h1 = rnd(), h2 = rnd();
      const band = Math.floor(h0 * 5);
      const depth = depthOf(band);
      const hh = depth * tanHalfY;
      const hw = hh * aspect;
      const vs = hh * Math.sqrt(Math.min(aspect, 1));
      const x = (h1 * 2 - 1) * hw * 1.15;
      const y = laneY(band, x, hw, vs) + (h2 - 0.5) * 0.018 * vs + (rnd() - 0.5) * 0.006 * vs;
      const z = depth + ((h2 * 17) % 1 - 0.5) * 0.3;
      const halfH = z * tanHalfY;
      const sx = ((x / (halfH * aspect)) * 0.5 + 0.5) * width;
      const sy = (0.5 - (y / halfH) * 0.5) * height;
      if (sx < -40 || sx > width + 40) continue;
      const hz = rnd();
      const hy = rnd();
      const envelope = 0.55 + 0.45 * rnd();
      const a = (0.05 + 3 * Math.pow(hz, 9)) * 1.5 * envelope * (opts.gain || 1);
      const sage = clamp(hy * 0.14 + 0.06 + 0.05 * rnd(), 0, 0.3);
      const c = [0, 1, 2].map((i) => mix(WARM[i], SAGE[i], sage) * 1.15);
      out.push({ x: sx, y: sy, d: z, a, c });
    }
    return out;
  }

  // ---------------------------------------------------------------- pictures
  // A picture as points. `fill` stipples it (by alpha for a cut-out, or by tone), `outline`
  // follows its edges the way the site draws its line formations, `both` does the two. Points
  // come back in the picture's pixels as [x, y, weight]; `spacing` is in those pixels.
  // opts: { mode, spacing, seed, tone: 'alpha'|'light'|'dark', knockout }
  function imagePoints(img, opts = {}) {
    const { width: w, height: h, data } = img;
    const rnd = random(opts.seed || 5);
    const spacing = Math.max(0.75, opts.spacing || 3);
    const mode = opts.mode || 'both';
    const tone = opts.tone || 'alpha';

    // The weight map: how much of the picture is at each pixel.
    const field = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const r = data[p * 4] / 255, g = data[p * 4 + 1] / 255, b = data[p * 4 + 2] / 255;
      let alpha = data[p * 4 + 3] / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (opts.knockout) alpha *= 1 - smoothstep(0.86, 0.97, Math.min(r, g, b));
      field[p] = tone === 'alpha' ? alpha : tone === 'dark' ? alpha * (1 - lum) : alpha * lum;
    }
    // A light blur, so edges come out of it as a clean band rather than pixel steps.
    const soft = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += field[yy * w + xx];
            n++;
          }
        }
        soft[y * w + x] = sum / n;
      }
    }
    const at = (map, x, y) => map[clamp(Math.round(y), 0, h - 1) * w + clamp(Math.round(x), 0, w - 1)];

    const points = [];
    if (mode === 'fill' || mode === 'both') {
      const step = mode === 'both' ? spacing * 1.6 : spacing;
      const strength = mode === 'both' ? 0.45 : 1;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const px = x + rnd() * step;
          const py = y + rnd() * step;
          // A tone curve, so a photo's midtones thin out rather than fill in as an even haze.
          const v = at(soft, px, py);
          if (rnd() < smoothstep(0.1, 0.9, v)) points.push([px, py, (0.55 + 0.45 * v) * strength]);
        }
      }
    }
    if (mode === 'outline' || mode === 'both') {
      // Sobel over the soft map; a pixel-wide band of edge, sampled on a finer grid.
      const edge = new Float32Array(w * h);
      let peak = 1e-6;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gx = soft[i - w + 1] + 2 * soft[i + 1] + soft[i + w + 1] - soft[i - w - 1] - 2 * soft[i - 1] - soft[i + w - 1];
          const gy = soft[i + w - 1] + 2 * soft[i + w] + soft[i + w + 1] - soft[i - w - 1] - 2 * soft[i - w] - soft[i - w + 1];
          const m = Math.hypot(gx, gy);
          edge[i] = m;
          if (m > peak) peak = m;
        }
      }
      // Normalise against a strong edge, not the single strongest pixel, so a photo's soft
      // edges still register.
      const ref = Math.min(peak, 2.2);
      const step = spacing * 0.5;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const px = x + rnd() * step;
          const py = y + rnd() * step;
          const e = at(edge, px, py) / ref;
          if (rnd() < smoothstep(0.12, 0.6, e) * 0.5) points.push([px, py, 1]);
        }
      }
    }
    return points;
  }

  return {
    TAN_HALF_FOV, WARM, SAGE, AGED,
    clamp, mix, smoothstep, random,
    studio, camera, splat, render, compose, toTransparent,
    strokePoint, strokeLength, sampleStrokes,
    formation, drift, grid, ribbon, imagePoints,
  };
});
