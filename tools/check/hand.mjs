#!/usr/bin/env node
/*
 * The hand on the grip ("Made to be lifted."), checked for fit.
 *
 *   node tools/check/hand.mjs              the geometry, outside the browser
 *   node tools/check/hand.mjs --browser    and its registration with the pod, in headless Chrome
 *
 * Geometry. gripHand in index.html is self-contained, so it is cut out of the page and run as
 * is, the way tools/check/lift.mjs runs liftFilm:
 *   - its table of the bar's cross-section against a fresh section of assets/powerpod.bin,
 *   - a sweep through the wrap: no bone ever cuts into the bar or the cap's floor, the closed
 *     fingers rest on the bar, and nothing jumps from one step to the next,
 *   - the same through the grip beat's roll into its lifting hold, where the thumb also lets go
 *     and takes hold again and must never pass through a finger,
 *   - how long a frame of the drawing takes to build.
 *
 * Registration. The film is stepped on a virtual clock to points in the hand's beat and left to
 * settle. The field's targets are caught on their way to the GPU, and the pod is shot on its own
 * over magenta, which tells its own pixels from the window the hand opens in it. For that shot
 * the window is opened over the whole hand, without its depth test (the page's ?check hook), so
 * a finger the bar rightly hides is inside it like the rest. An outline out of step with its
 * window would leave a band of the drawing just outside the window's edge, on the pod, all the
 * way round the hand; so the check counts visible points of the drawing that the pod covers
 * within three CSS pixels of the window, and allows one in a hundred.
 * Crops of the grip go to tools/check/out/ for a look by eye; --overlay adds the pod on its own
 * with the drawing in red and any such stray points in green. --only=desktop,phone and --quick
 * (one point in the beat) narrow the run.
 *
 * Motion. A drawing that holds the pod has to move with it, frame by frame, however fast the
 * page is scrolled. The page is flung through the grip beat and the lift a few viewports a
 * second, and after every frame the field's particles are read back off the GPU and compared
 * with the targets it was given in that same frame: the hand on the grip, and her body and her
 * hand in the lift. They must sit on them to within half a pixel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
let failed = 0;
const report = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
};

function loadGripHand() {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const start = html.indexOf('const gripHand = (() => {');
  if (start < 0) throw new Error('no gripHand in index.html');
  const end = html.indexOf('\n    })();', start);
  return new Function(`${html.slice(start, end + '\n    })();'.length)}\nreturn gripHand;`)();
}

// ---------------------------------------------------------------- the model's bar
function loadModel() {
  const buf = fs.readFileSync(path.join(REPO, 'assets/powerpod.bin'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const len = new DataView(ab).getUint32(0, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, len)));
  const q = new Uint16Array(ab, h.pos, h.nv * 3);
  const P = new Float32Array(h.nv * 3);
  for (let i = 0; i < h.nv * 3; i++) P[i] = h.lo[i % 3] + q[i] * h.sc[i % 3];
  return { P, idx: new Uint16Array(ab, h.idx, h.nf * 3), nf: h.nf };
}

// The bar's outer half-width at height u, from the model cut across the bar at q.
function modelHalfWidth(model, q0, u) {
  const S = Math.SQRT1_2;
  const V = (i) => [model.P[i * 3], (model.P[i * 3 + 1] - model.P[i * 3 + 2]) * S, (model.P[i * 3 + 1] + model.P[i * 3 + 2]) * S];
  let w = -1;
  for (let f = 0; f < model.nf; f++) {
    const vs = [V(model.idx[f * 3]), V(model.idx[f * 3 + 1]), V(model.idx[f * 3 + 2])];
    if (Math.max(vs[0][0], vs[1][0], vs[2][0]) < 179) continue;
    const cut = [];
    for (let e = 0; e < 3; e++) {
      const a = vs[e], b = vs[(e + 1) % 3];
      const da = a[1] - q0, db = b[1] - q0;
      if ((da < 0) !== (db < 0)) { const t = da / (da - db); cut.push([a[2] + (b[2] - a[2]) * t, a[0] + (b[0] - a[0]) * t]); }
    }
    if (cut.length !== 2) continue;
    const [a, b] = cut;
    if ((a[1] - u) * (b[1] - u) > 0) continue;
    const t = Math.abs(b[1] - a[1]) < 1e-9 ? 0.5 : (u - a[1]) / (b[1] - a[1]);
    const p = Math.abs(a[0] + (b[0] - a[0]) * t);
    if (p < 30) w = Math.max(w, p);
  }
  return w;
}

function geometry() {
  const H = loadGripHand();

  // 1. The section table against the model, at each tabulated place along the bar and between
  //    them, below the top's last rounding (where the half-width falls off a cliff).
  const model = loadModel();
  let worst = 0;
  let where = '';
  for (const q of [0, 11, 22, 26, 30, 34]) {
    // The section is flat (p, u) pairs, its near side first, bottom to top.
    const poly = H.section(q);
    const n = H.BAR[0][1].length;
    const top = poly[(n - 1) * 2 + 1];
    for (let k = 2; k < n - 1; k++) {
      const w = poly[k * 2], u = poly[k * 2 + 1];
      if (u > top - 0.3) continue;
      // Both sides of the bar, as the table was made, and the gap measured square to the
      // surface: on the steep keel a width error is mostly a height error of a fraction of it.
      const m = (modelHalfWidth(model, q, u) + modelHalfWidth(model, -q, u)) / 2;
      const slope = (poly[(k + 1) * 2] - poly[(k - 1) * 2]) / (poly[(k + 1) * 2 + 1] - poly[(k - 1) * 2 + 1]);
      const d = Math.abs(m - w) / Math.sqrt(1 + slope * slope);
      if (d > worst) { worst = d; where = `q ${q} u ${u.toFixed(2)}: table ${w.toFixed(2)} model ${m.toFixed(2)}`; }
    }
  }
  report('bar section matches the model', worst <= 0.25, `worst ${worst.toFixed(3)} mm (${where})`);

  // 2. The wrap, step by step, for each grip: reaching for the bar in the grip beat, and
  //    carrying the pod in the lift.
  for (const grip of ['reach', 'carry']) wrapSweep(H, grip);

  // 3. The grip beat's roll into its lifting hold.
  turnSweep(H);

  // 4. Cost of a frame: pose, solid and drawing, with the wrap moving, and with the roll.
  const alloc = H.reach.allocation(8000);
  const out = new Float64Array(8000 * 4);
  for (const [what, at] of [['wrap', (i) => [0.4 + i * 0.01, 0, 0]], ['roll', (i) => [1, 0, 0.2 + i * 0.01]]]) {
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) H.reach.points(H.reach.solid(H.reach.pose(...at(i)), 400), H.reach.REF_EYE, alloc, 0, out, 1);
    const ms = (performance.now() - t0) / 60;
    report(`a frame of the drawing builds quickly (${what})`, ms < 3, `${ms.toFixed(2)} ms (8000 particles, ${what} moving)`);
  }
}

// The roll, step by step, at the wrap's end: the hand turns round the bar into a hook, the thumb
// letting go of the far face and taking hold over the top.
function turnSweep(G) {
  const H = G.reach;
  const thumbR = H.THUMB.r.slice(1);
  let deepest = Infinity;
  let deepestAt = '';
  let jump = 0;
  let jumpAt = '';
  let touch = Infinity;
  let touchAt = '';
  let prev = null;
  // Nearest approach of a point to a segment.
  const toSeg = (p, a, b) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
    const s = Math.min(1, Math.max(0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2));
    return [Math.hypot(p[0] - a[0] - ab[0] * s, p[1] - a[1] - ab[1] * s, p[2] - a[2] - ab[2] * s), s];
  };
  for (let t = 0; t <= 1.0001; t += 0.002) {
    const turn = +t.toFixed(4);
    const P = H.pose(1, 0, turn);
    const chains = P.fingers.map((f, i) => ({ q: f.q, pts: f.pts, r: f.r, name: `finger ${i}` }))
      .concat([{ q: P.thumb.pts[0][0], pts: P.thumb.pts, r: thumbR, name: 'thumb' }]);
    const flat = [];
    for (const c of chains) {
      const pu = c.pts.map((p) => [p[1], p[2]]);
      for (let j = 0; j < pu.length - 1; j++) {
        const cl = Math.min(G.clearance(c.q, pu[j], pu[j + 1], c.r[j], c.r[j + 1]), G.clearance(c.q, pu[j + 1], pu[j + 1], c.r[j + 1], c.r[j + 1]));
        if (cl < deepest) { deepest = cl; deepestAt = `${c.name} bone ${j} at turn ${turn.toFixed(3)}`; }
      }
      flat.push(...pu.flat());
    }
    if (prev) {
      const d = Math.max(...flat.map((v, i) => Math.abs(v - prev[i])));
      if (d > jump) { jump = d; jumpAt = `turn ${turn.toFixed(3)}`; }
    }
    prev = flat;
    // The thumb's bones against every finger bone, as tapered rounds.
    const thumb = chains[chains.length - 1];
    for (const f of chains.slice(0, -1)) {
      for (let a = 0; a < thumb.pts.length - 1; a++) {
        for (let b = 0; b < f.pts.length - 1; b++) {
          for (let k = 0; k <= 10; k++) {
            const s = k / 10;
            const p = thumb.pts[a].map((v, i) => v + (thumb.pts[a + 1][i] - v) * s);
            const [d, u] = toSeg(p, f.pts[b], f.pts[b + 1]);
            const gap = d - (thumb.r[a] + (thumb.r[a + 1] - thumb.r[a]) * s) - (f.r[b] + (f.r[b + 1] - f.r[b]) * u);
            if (gap < touch) { touch = gap; touchAt = `thumb bone ${a} and ${f.name} bone ${b} at turn ${turn.toFixed(3)}`; }
          }
        }
      }
    }
  }
  report('reach roll: nothing cuts into the bar or the floor', deepest >= -0.05, `deepest ${deepest.toFixed(3)} mm (${deepestAt})`);
  report('reach roll: the hand rolls without jumps', jump <= 3, `largest joint move per 0.002 of the roll ${jump.toFixed(2)} mm (${jumpAt})`);
  report('reach roll: the thumb never passes through a finger', touch >= -0.5, `closest ${touch.toFixed(2)} mm (${touchAt})`);
  const hook = H.pose(1, 0, 1);
  let gap = 0;
  hook.fingers.forEach((f) => {
    const pts = f.pts.map((p) => [p[1], p[2]]);
    for (const j of [0, 1]) gap = Math.max(gap, G.clearance(f.q, pts[j], pts[j + 1], f.r[j], f.r[j + 1]));
  });
  report('reach roll: the hook rests on the bar', gap <= 0.25, `widest gap ${gap.toFixed(3)} mm`);
}

function wrapSweep(G, grip) {
  const H = G[grip];
  let deepest = Infinity;
  let deepestAt = '';
  let jump = 0;
  let jumpAt = '';
  let prev = null;
  for (let w = 0; w <= 1.0001; w += 0.002) {
    const P = H.pose(+w.toFixed(4), 0);
    const chains = P.fingers.map((f) => ({ q: f.q, pts: f.pts.map((p) => [p[1], p[2]]), r: f.r, name: `finger ${P.fingers.indexOf(f)}` }))
      .concat([{ q: P.thumb.pts[0][0], pts: P.thumb.pts.map((p) => [p[1], p[2]]), r: H.THUMB.r.slice(1), name: 'thumb' }]);
    const flat = [];
    for (const c of chains) {
      for (let j = 0; j < c.pts.length - 1; j++) {
        const cl = Math.min(G.clearance(c.q, c.pts[j], c.pts[j + 1], c.r[j], c.r[j + 1]),
          G.clearance(c.q, c.pts[j + 1], c.pts[j + 1], c.r[j + 1], c.r[j + 1]));
        if (cl < deepest) { deepest = cl; deepestAt = `${c.name} bone ${j} at wrap ${w.toFixed(3)}`; }
      }
      flat.push(...c.pts.flat());
    }
    if (prev) {
      const d = Math.max(...flat.map((v, i) => Math.abs(v - prev[i])));
      if (d > jump) { jump = d; jumpAt = `wrap ${w.toFixed(3)}`; }
    }
    prev = flat;
  }
  report(`${grip}: nothing cuts into the bar or the floor`, deepest >= -0.05, `deepest ${deepest.toFixed(3)} mm (${deepestAt})`);
  report(`${grip}: the wrap moves without jumps`, jump <= 3, `largest joint move per 0.002 of wrap ${jump.toFixed(2)} mm (${jumpAt})`);

  // The closed hand rests on the bar: every finger's first two bones touch it.
  const held = H.pose(1, 0);
  let gap = 0;
  held.fingers.forEach((f) => {
    const pts = f.pts.map((p) => [p[1], p[2]]);
    for (const j of [0, 1]) gap = Math.max(gap, G.clearance(f.q, pts[j], pts[j + 1], f.r[j], f.r[j + 1]));
  });
  report(`${grip}: the closed fingers rest on the bar`, gap <= 0.25, `widest gap ${gap.toFixed(3)} mm`);
}

// ---------------------------------------------------------------- held, at speed
// Flings the page through a stretch of the film a frame at a time and, after each frame, reads
// the field's particles back and measures how far the held ones (visible, and in the drawing that
// holds the pod) are from the targets sent that frame, in CSS pixels.
async function motion(tab, name, report) {
  const HAND_SHARE = 0.16;
  for (const [label, from, to, lift] of [['grip beat', 2.52, 3.24, false], ['lift', 6.0, 7.66, true]]) {
    const worst = await tab.evaluate(async (from, to, lift, share) => {
      const vh = document.getElementById('bg').clientHeight || innerHeight;
      // Scroll events are the browser's to fire between frames, and none fire inside this one
      // synchronous run, so each step raises its own, as the page would see it.
      const scrollTo = (top) => {
        window.scrollTo({ top, behavior: 'instant' });
        window.dispatchEvent(new Event('scroll'));
      };
      scrollTo(from * vh);
      window.__advance(120);
      let worstPx = 0, frames = 0, checked = 0;
      // A fling: about four viewports a second, as fast as a trackpad throws the page.
      for (let y = from; y <= to; y += 4 / 60) {
        scrollTo(y * vh);
        window.__advance(1);
        const T = window.__targets;
        const S = window.__state;
        if (!T || !S) continue;
        const gl = S.gl;
        const count = T.vis.length;
        const data = new Float32Array(count * 12);
        gl.bindBuffer(gl.COPY_READ_BUFFER, S.buffer);
        gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, data);
        gl.bindBuffer(gl.COPY_READ_BUFFER, null);
        const P = window.gridBG.projection();
        const halfH = P.depth * P.tanHalfY;
        const field = document.getElementById('bg');
        const toPx = (x, y, z) => {
          const d = -z / P.depth;
          return [(x / d / (halfH * P.aspect) * 0.5 + 0.5) * field.clientWidth, (0.5 - y / d / halfH * 0.5) * field.clientHeight];
        };
        frames++;
        for (let i = 0; i < count; i++) {
          if (T.vis[i] < 0.1) continue;
          // The glow is set deep and soft on purpose; the lines are what must hold. And only
          // particles lit on screen count: one reborn this frame is dark until it is back.
          if (-T.xyz[i * 3 + 2] / P.depth > 1.4 || data[i * 12 + 11] < 0.01) continue;
          const [tx, ty] = toPx(T.xyz[i * 3], T.xyz[i * 3 + 1], T.xyz[i * 3 + 2]);
          const [px, py] = toPx(data[i * 12], data[i * 12 + 1], data[i * 12 + 2]);
          const e = Math.hypot(px - tx, py - ty);
          if (e > worstPx) { worstPx = e; window.__worst = { i, y, t: [tx, ty], p: [px, py], vis: T.vis[i], tz: T.xyz[i * 3 + 2], pz: data[i * 12 + 2], age: data[i * 12 + 3], life: data[i * 12 + 7], alpha: data[i * 12 + 11] }; }
          checked++;
        }
      }
      return { worstPx, frames, checked, detail: window.__worst };
    }, from, to, lift, HAND_SHARE);
    if (process.argv.includes('--why')) console.log(JSON.stringify(worst.detail));
    report(`${name} ${label} at speed: held drawing on its targets`, worst.worstPx <= 0.5,
      `worst ${worst.worstPx.toFixed(3)} px over ${worst.frames} frames (${worst.checked} particle checks)`);
  }
}

// ---------------------------------------------------------------- in the browser
async function browser() {
  const { default: puppeteer } = await import('puppeteer-core');
  const { PNG } = await import('pngjs');
  const { serve } = await import('../serve.mjs');
  const { CHROME, CHROME_ARGS } = await import('../perf/run.mjs');
  const outDir = path.join(HERE, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  // Virtual time, as tools/perf/reel.mjs runs it: the harness steps the frames itself.
  const VIRTUAL = (seed) => {
    let a = seed >>> 0;
    Math.random = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let T = 1000;
    const queue = new Map();
    let next = 1;
    window.requestAnimationFrame = (cb) => { const id = next++; queue.set(id, cb); return id; };
    window.cancelAnimationFrame = (id) => { queue.delete(id); };
    performance.now = () => T;
    window.__podLoop = () => [...queue.values()].some((cb) => cb.name === 'loop');
    // The field's particle state: the buffer its last simulation pass wrote, for reading back.
    const bindBase = WebGL2RenderingContext.prototype.bindBufferBase;
    WebGL2RenderingContext.prototype.bindBufferBase = function (target, index, buffer) {
      if (target === this.TRANSFORM_FEEDBACK_BUFFER && buffer) window.__state = { gl: this, buffer };
      return bindBase.call(this, target, index, buffer);
    };
    window.__advance = (n) => {
      for (let i = 0; i < n; i++) {
        T += 1000 / 60;
        const due = [...queue.values()];
        queue.clear();
        for (const cb of due) {
          try { cb(T); } catch (err) { console.error(err && err.stack || err); }
        }
      }
    };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const VIEWPORTS = {
    desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
    laptop: { width: 1280, height: 800, deviceScaleFactor: 2 },
    tablet: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  };
  // The grip beat, where the hand has the field to itself, and the lift, where her hand shares
  // it with her and the lift and only its own slots are checked (her body rightly runs behind
  // the pod). HAND_SHARE is the lift's in index.html.
  const HAND_SHARE = 0.16;
  const only_t = process.argv.find((a) => a.startsWith('--at='));
  // The grip beat: reaching, holding at a slant, rolling, and lifting with the knuckles up.
  const AT = only_t ? only_t.slice(5).split(',').map(Number) : process.argv.includes('--quick') ? [3.0, 6.75] : [2.62, 2.74, 2.86, 3.0, 6.10, 6.75, 7.35];

  const port = 8133;
  const rootArg = process.argv.find((a) => a.startsWith('--root='));
  const server = await serve({ root: rootArg ? path.resolve(rootArg.slice(7)) : REPO, port, quiet: true });
  const chrome = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS, protocolTimeout: 600000 });
  try {
    const only = process.argv.find((a) => a.startsWith('--only='));
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      if (only && !only.slice(7).split(',').includes(name)) continue;
      const tab = await chrome.newPage();
      await tab.setViewport(viewport);
      const errors = [];
      tab.on('pageerror', (e) => errors.push(e.message));
      tab.on('console', (m) => { if (m.type() === 'error' && !/localhost:3000|ERR_CONNECTION|favicon|404/.test(m.text())) errors.push(m.text()); });
      await tab.evaluateOnNewDocument(VIRTUAL, 1234);
      await tab.goto(`http://localhost:${port}/index.html?check`, { waitUntil: 'load' });
      await sleep(800);
      await tab.evaluate(() => window.__advance(300));
      for (let i = 0; i < 200 && !(await tab.evaluate(() => window.__podLoop())); i++) {
        await sleep(100);
        await tab.evaluate(() => window.__advance(1));
      }
      // Catch the targets on their way to the field.
      await tab.evaluate(() => {
        const bg = window.gridBG;
        const set = bg.setPodTargets;
        bg.setPodTargets = (xyz, vis) => {
          window.__targets = { xyz: Float32Array.from(xyz), vis: vis ? Float32Array.from(vis) : null };
          set(xyz, vis);
        };
      });
      for (const t of AT) {
        await tab.evaluate((at) => {
          const vh = document.getElementById('bg').clientHeight || innerHeight;
          window.scrollTo({ top: at * vh, behavior: 'instant' });
        }, t);
        await sleep(60);
        await tab.evaluate(() => window.__advance(150));
        await sleep(1200);
        await tab.evaluate(() => window.__advance(2));
        const full = PNG.sync.read(Buffer.from(await tab.screenshot({ type: 'png' })));

        // The window opened over the whole hand, drawn afresh with the drawing's targets.
        await tab.evaluate(() => {
          window.__gripCheck.window.material.depthTest = false;
          window.__gripCheck.redraw();
          window.__advance(2);
        });

        // Visible points of the drawing, in device pixels.
        const drawn = await tab.evaluate((lift, share) => {
          const T = window.__targets;
          const P = window.gridBG.projection();
          const halfH = P.depth * P.tanHalfY;
          const field = document.getElementById('bg');
          const w = field.clientWidth;
          const h = field.clientHeight;
          // In the lift, only her hand's slots (see liftTargets in index.html).
          const count = T.vis.length;
          let mine = () => true;
          if (lift) {
            const gcd = (a, b) => (b ? gcd(b, a % b) : a);
            let stride = Math.max(1, Math.round(count * 0.6180339887));
            while (gcd(stride, count) !== 1) stride++;
            const nScene = count - Math.round(count * share);
            mine = (i) => (i * stride) % count >= nScene;
          }
          let max = 0;
          for (let i = 0; i < count; i++) if (mine(i)) max = Math.max(max, T.vis[i]);
          const pts = [];
          for (let i = 0; i < count; i++) {
            if (!mine(i) || T.vis[i] < 0.25 * max) continue;
            const x = T.xyz[i * 3] / (halfH * P.aspect);
            const y = T.xyz[i * 3 + 1] / halfH;
            pts.push([(x * 0.5 + 0.5) * w * devicePixelRatio, (0.5 - y * 0.5) * h * devicePixelRatio]);
          }
          return { pts, dpr: devicePixelRatio };
        }, t > 5, HAND_SHARE);

        // The pod on its own over magenta: its own pixels are grey, the window over it is
        // magenta at the window's strength, and the rest is magenta.
        await tab.addStyleTag({ content: '#bg, .topbar, .film, .hero, .credits, .island-wrap, header { visibility: hidden !important; } html, body { background: #f0f !important; }' });
        await tab.evaluate(() => window.__advance(2));
        const pod = PNG.sync.read(Buffer.from(await tab.screenshot({ type: 'png' })));
        await tab.evaluate(() => {
          const tags = document.querySelectorAll('style');
          tags[tags.length - 1].remove();
          window.__gripCheck.window.material.depthTest = true;
          window.__gripCheck.redraw();
          window.__advance(2);
        });

        const W = pod.width;
        const Hh = pod.height;
        const kind = new Uint8Array(W * Hh); // 0 pod, 1 window, 2 open (no pod), 3 edge between
        for (let i = 0; i < W * Hh; i++) {
          const r = pod.data[i * 4], g = pod.data[i * 4 + 1], b = pod.data[i * 4 + 2];
          const m = (r + b) / 2 - g;
          kind[i] = m > 235 ? 2 : m > 110 && m < 215 ? 1 : m < 60 ? 0 : 3;
        }
        const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= Hh ? 2 : kind[y * W + x]);

        // Every pixel's distance, in device pixels, to the nearest pixel that is not the pod's
        // own (window, open page or the antialiased band between): two passes of a chamfer
        // distance transform.
        const far = new Float32Array(W * Hh);
        for (let i = 0; i < W * Hh; i++) far[i] = kind[i] === 0 ? 1e9 : 0;
        const D1 = 1, D2 = Math.SQRT2;
        for (let y = 0; y < Hh; y++) {
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (!far[i]) continue;
            let d = far[i];
            if (x > 0) d = Math.min(d, far[i - 1] + D1);
            if (y > 0) {
              d = Math.min(d, far[i - W] + D1);
              if (x > 0) d = Math.min(d, far[i - W - 1] + D2);
              if (x < W - 1) d = Math.min(d, far[i - W + 1] + D2);
            }
            far[i] = d;
          }
        }
        for (let y = Hh - 1; y >= 0; y--) {
          for (let x = W - 1; x >= 0; x--) {
            const i = y * W + x;
            if (!far[i]) continue;
            let d = far[i];
            if (x < W - 1) d = Math.min(d, far[i + 1] + D1);
            if (y < Hh - 1) {
              d = Math.min(d, far[i + W] + D1);
              if (x < W - 1) d = Math.min(d, far[i + W + 1] + D2);
              if (x > 0) d = Math.min(d, far[i + W - 1] + D2);
            }
            far[i] = d;
          }
        }

        // Points of the drawing the pod covers. With the window open over the whole hand, none
        // should be, bar the odd one where an outline's last point rounds off the window's edge
        // by a pixel. A drawing out of step with its window would instead put a band of its
        // outline just outside the window's edge, a pixel or three into the pod, all the way
        // round the hand. So: of the points the pod covers, how many are within three CSS pixels
        // of the window, against all the points.
        const px = drawn.dpr;
        let covered = 0;
        let fringe = 0;
        for (const [x, y] of drawn.pts) {
          const X = Math.round(x), Y = Math.round(y);
          if (X < 0 || Y < 0 || X >= W || Y >= Hh) continue;
          const d = far[Y * W + X];
          if (d <= 0.75 * px) continue;
          covered++;
          if (d <= 3 * px) fringe++;
        }
        const label = `${name} at ${t.toFixed(2)}`;
        report(`${label}: outline in step with its window`, fringe <= drawn.pts.length * 0.01,
          `${fringe} of ${drawn.pts.length} visible points just outside the window `
          + `(${covered} covered by the pod in all)`);
        if (errors.length) report(`${label}: no page errors`, false, errors.join(' | '));
        const untraced = [];
        for (const [x, y] of drawn.pts) {
          const X = Math.round(x), Y = Math.round(y);
          if (X >= 0 && Y >= 0 && X < W && Y < Hh && far[Y * W + X] > 0.75 * px && far[Y * W + X] <= 3 * px) untraced.push([X, Y]);
        }

        // A crop round the hand for review, and with --overlay, the same crop of the pod on its
        // own with the drawing's visible points marked on it in red.
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of drawn.pts) {
          if (x < 0 || y < 0 || x >= W || y >= Hh) continue;
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
        if (Number.isFinite(x0)) {
          const pad = 40 * drawn.dpr;
          const cx0 = Math.max(0, Math.floor(x0 - pad)), cy0 = Math.max(0, Math.floor(y0 - pad));
          const cw = Math.min(W - cx0, Math.ceil(x1 - x0 + 2 * pad)), ch = Math.min(Hh - cy0, Math.ceil(y1 - y0 + 2 * pad));
          const crop = new PNG({ width: cw, height: ch });
          PNG.bitblt(full, crop, cx0, cy0, cw, ch, 0, 0);
          fs.writeFileSync(path.join(outDir, `hand-${name}-${t.toFixed(2)}.png`), PNG.sync.write(crop));
          if (process.argv.includes('--overlay')) {
            const over = new PNG({ width: W, height: Hh });
            pod.data.copy(over.data);
            for (const [x, y] of drawn.pts) {
              const X = Math.round(x), Y = Math.round(y);
              if (X < 0 || Y < 0 || X >= W || Y >= Hh) continue;
              const o = (Y * W + X) * 4;
              over.data[o] = 255; over.data[o + 1] = 0; over.data[o + 2] = 0;
            }
            for (const [x, y] of untraced) {
              const o = (y * W + x) * 4;
              over.data[o] = 0; over.data[o + 1] = 255; over.data[o + 2] = 0;
            }
            const oc = new PNG({ width: cw, height: ch });
            PNG.bitblt(over, oc, cx0, cy0, cw, ch, 0, 0);
            fs.writeFileSync(path.join(outDir, `hand-${name}-${t.toFixed(2)}-overlay.png`), PNG.sync.write(oc));
          }
        }
      }
      if (!process.argv.includes('--no-motion')) await motion(tab, name, report);
      await tab.close();
    }
  } finally {
    await chrome.close();
    server.close();
  }
  console.log(`crops written to ${outDir}`);
}

geometry();
if (process.argv.includes('--browser')) await browser();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exitCode = 1;
}
