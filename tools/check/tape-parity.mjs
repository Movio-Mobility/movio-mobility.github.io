#!/usr/bin/env node
/*
 * Tape parity: proves a change to the timeline tape (assets/tape.js and tape.css, or the
 * journey page that drives them) leaves the journey page exactly as it was. Two copies of the
 * site run side by side, frame by frame, and every frame of the tape has to match.
 *
 *   node tools/check/tape-parity.mjs --before <dir> [--after <dir>]
 *        [--viewports phone,tablet,laptop,desktop] [--motion normal,reduce]
 *        [--scenarios film,deep,drag,keys,wheel,history,scroll,resize,founders,lightbox]
 *        [--jobs 2] [--out <dir>] [--ports 8131,8132] [--chrome-args "..."] [--verbose]
 *
 * --after defaults to the working copy; --before is a copy of the site from before the change
 * (a git worktree, or any directory). Self-test: run a copy against itself (0 differences
 * expected), then against a copy with one tuning constant nudged (LENS 0.6 to 0.61, say),
 * which has to be caught on the first frame. Differing pictures land in --out (default
 * tools/check/out/tape-parity, which git ignores).
 *
 * Time is virtual, as in tools/perf/reel.mjs: Math.random is seeded, and requestAnimationFrame,
 * performance.now, timers and idle callbacks are replaced before the page runs, so both copies
 * reach every frame through the same sequence of events. On top of that:
 *   - WAAPI animations (the FLIP flights, the odometer, the lightbox zoom), CSS transitions and
 *     keyframe animations are paused as they appear and stepped on the virtual clock, finishing
 *     on the frame their time runs out (image fade-ins excepted: they follow real-time loads);
 *   - pointer, wheel and key events report the virtual clock as their timeStamp, so a fling's
 *     speed is the same on both sides;
 *   - every Element.animate call and every gridBG.setHalo / sweepX call is logged per frame.
 * Each virtual frame runs inside one task (microtasks only), then the harness lets the browser
 * render in real time until every IntersectionObserver has made its first pass, so scroll,
 * resize, observer and animation events land between the same two frames on both sides.
 * Loading is pinned down the same way: nothing renders until parsing ends, a link's hash is
 * set before the scripts run, and the web font is held back until they have run and the page
 * has rendered.
 *
 * Per frame it records the labels' inline transform and opacity (plus tab state), a hash of
 * the tape canvas, the classes on main, the bar, the peek and the hint, the title's digits,
 * the theme line, --horizon-y, the panels shown, scrollY, the hash and history.state, the
 * focused element, and the halo, sweep and WAAPI logs. The two traces must be equal, frame
 * for frame; the first difference is printed with three frames either side.
 *
 * At each rest point (image loads and their fades run on real time, so it waits for them, and
 * holds the review's endless drift) it also compares, with the field (#bg) hidden: the
 * computed style, every property, of every element in main and .topbar, with its exact box
 * and scroll offsets; main's outerHTML, where the only difference allowed is main's own `tape`
 * class; and a screenshot, pixel for pixel (pixelmatch, threshold 0), drawn afresh (see
 * __repaint) and taken until two in a row agree.
 *
 * Exit code 0 only when every scenario in every viewport and motion setting matched.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// tools/perf/run.mjs's flags, plus the ones that keep a page that is not in front running its
// frames, and CPU rasterization: GPU raster draws the same photo a level or two apart from one
// load to the next (its filtering depends on real-time timing), which no pixel comparison at
// threshold 0 survives. The field still renders with WebGL; it is hidden for the pictures.
const CHROME_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-gpu-rasterization'];

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const beforeDir = opt('before', null) && path.resolve(opt('before'));
const afterDir = path.resolve(opt('after', REPO));
const outDir = path.resolve(opt('out', path.join(HERE, 'out', 'tape-parity')));
const [PORT_A, PORT_B] = opt('ports', '8131,8132').split(',').map(Number);
const JOBS = Math.max(1, Number(opt('jobs', 2)));
const PAGE = opt('page', 'journey');
const VERBOSE = args.includes('--verbose');
const T0 = Date.now();
const dbg = (msg) => { if (VERBOSE) console.log(`  [${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`); };

const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop: { width: 1366, height: 768, deviceScaleFactor: 1 },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
};
// Where scenario "resize" turns each one to, mid-spring: across the phone/desktop breakpoints
// the tape's spacing and the close button's place both change.
const RESIZED = {
  phone: { width: 844, height: 390 },
  tablet: { width: 1180, height: 820 },
  laptop: { width: 1000, height: 700 },
  desktop: { width: 1024, height: 900 },
};
const MOTIONS = { normal: 'no-preference', reduce: 'reduce' };

// ---------------------------------------------------------------- inside the page
// Installed before any page script runs.
const HARNESS = (seed, hash) => {
  // A link to a year: the hash is set before any script runs, rather than navigated to, so the
  // page reads the same location.hash and nothing else differs from one load to the next.
  if (hash && /\.html$/.test(location.pathname)) {
    try { history.replaceState(history.state, '', location.pathname + location.search + hash); } catch (err) { /* not this document */ }
  }
  // Nothing is rendered until the parser is done. Otherwise whether the browser rendered
  // between the page's scripts and the end of parsing (where Chrome scrolls to the URL's
  // fragment) is a matter of real time, and an IntersectionObserver made by a script (the
  // arrivals, when a year opens during the load under reduced motion) made its first pass
  // before that scroll on one side and after it on the other. An expect link to an id that
  // never comes holds rendering until parsing ends.
  const holdRendering = () => {
    if (!document.head || document.body) return !!document.body;
    const link = document.createElement('link');
    link.rel = 'expect';
    link.href = '#tape-parity-end-of-parsing';
    link.setAttribute('blocking', 'render');
    document.head.append(link);
    return true;
  };
  if (!holdRendering()) {
    const watch = new MutationObserver(() => {
      if (holdRendering()) watch.disconnect();
    });
    watch.observe(document, { childList: true, subtree: true });
  }
  const real = {
    raf: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    animate: Element.prototype.animate,
  };

  // Seeded Math.random, as in tools/perf/reel.mjs (createImageData restarts it, for the pod).
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const createImageData = CanvasRenderingContext2D.prototype.createImageData;
  CanvasRenderingContext2D.prototype.createImageData = function (...rest) {
    a = seed >>> 0;
    return createImageData.apply(this, rest);
  };

  // The virtual clock: frames, timers and idle callbacks all run on it.
  const STEP = 1000 / 60;
  let T = 1000;
  performance.now = () => T;
  const rafs = new Map();
  let rafNext = 1;
  window.requestAnimationFrame = (cb) => { const id = rafNext++; rafs.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { rafs.delete(id); };
  const timers = new Map();
  let timerNext = 1;
  const addTimer = (fn, ms, rest, every) => {
    const id = timerNext++;
    timers.set(id, { id, at: T + Math.max(0, Number(ms) || 0), fn, rest, every });
    return id;
  };
  window.setTimeout = (fn, ms, ...rest) => addTimer(fn, ms, rest, 0);
  window.setInterval = (fn, ms, ...rest) => addTimer(fn, ms, rest, Math.max(1, Number(ms) || 0));
  window.clearTimeout = (id) => { timers.delete(id); };
  window.clearInterval = window.clearTimeout;
  window.requestIdleCallback = (fn) => addTimer(() => fn({ didTimeout: false, timeRemaining: () => 12 }), 0, [], 0);
  window.cancelIdleCallback = window.clearTimeout;
  window.__frames = 0;

  // Input reports the virtual clock, so a fling measures the same speed on both sides.
  for (const C of [PointerEvent, WheelEvent, KeyboardEvent]) {
    Object.defineProperty(C.prototype, 'timeStamp', { configurable: true, get() { return T; } });
  }

  const pathOf = (el) => {
    if (!el || el.nodeType !== 1) return String(el && el.nodeName);
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) i++;
      parts.push(`${e.localName}${e.id ? `#${e.id}` : ''}${e.classList[0] ? `.${e.classList[0]}` : ''}:${i}`);
    }
    return parts.reverse().join('>');
  };

  const log = { halo: [], sweep: [], waapi: [], errors: [] };
  window.addEventListener('error', (e) => log.errors.push(String(e.message)));

  // WAAPI on the virtual clock: paused as it is made, stepped every frame, finished on time.
  let driven = [];
  const drivenSet = new WeakSet();
  const drive = (anim) => {
    drivenSet.add(anim);
    anim.pause();
    anim.currentTime = 0;
    driven.push({ anim, t0: T });
  };
  Element.prototype.animate = function (keyframes, options) {
    const anim = real.animate.call(this, keyframes, options);
    log.waapi.push({ f: window.__frames, el: pathOf(this), kf: keyframes, opt: options });
    try {
      drive(anim);
    } catch (err) {
      log.errors.push(`animate: ${err.message}`);
    }
    return anim;
  };
  // CSS transitions and keyframe animations join the virtual clock as soon as they exist. Left
  // on real time, anything that reads layout mid-transition (the top bar places its chip from
  // the island's rects as the island grows) reads a value set by how fast this machine is.
  // Image fades stay on real time: they start whenever an image happens to load, and finish
  // while a rest point waits.
  function pickUp() {
    document.documentElement.getBoundingClientRect(); // style is current: every transition due exists
    for (const anim of document.getAnimations()) {
      if (drivenSet.has(anim)) continue;
      drivenSet.add(anim);
      if (!(anim instanceof CSSTransition || anim instanceof CSSAnimation)) continue;
      const target = anim.effect && anim.effect.target;
      if (target && target.localName === 'img') continue;
      try {
        drive(anim);
      } catch (err) {
        log.errors.push(`css animation: ${err.message}`);
      }
    }
  }
  function driveAnimations() {
    const keep = [];
    for (const d of driven) {
      if (d.anim.playState === 'idle') continue; // cancelled
      const end = d.anim.effect ? d.anim.effect.getComputedTiming().endTime : 0;
      const t = T - d.t0;
      if (t >= end) {
        d.anim.finish();
        continue;
      }
      d.anim.currentTime = t;
      keep.push(d);
    }
    driven = keep;
  }

  // The field's two hooks, logged with their arguments.
  let bg;
  Object.defineProperty(window, 'gridBG', {
    configurable: true,
    get() { return bg; },
    set(v) {
      if (v && typeof v === 'object') {
        const { setHalo, sweepX } = v;
        if (typeof setHalo === 'function') {
          v.setHalo = function (spec) {
            log.halo.push(JSON.stringify(spec));
            return setHalo.apply(this, arguments);
          };
        }
        if (typeof sweepX === 'function') {
          v.sweepX = function (px) {
            log.sweep.push(px);
            return sweepX.apply(this, arguments);
          };
        }
      }
      bg = v;
    },
  });

  // IntersectionObservers with targets still waiting for their first notification. The
  // harness lets the browser render until there are none before it moves on, so a first pass
  // (which batches what is on screen, and so sets the arrivals' stagger) always sees the same
  // layout on both sides.
  const RealIO = window.IntersectionObserver;
  const unseen = new Set();
  const ioLog = [];
  window.__ioLog = () => ioLog.slice(-12);
  if (RealIO) {
    window.IntersectionObserver = class extends RealIO {
      constructor(cb, options) {
        super((entries, observer) => {
          unseen.delete(observer);
          // What each pass saw, for the report when a rest point differs.
          ioLog.push(`f${window.__frames} fonts:${document.fonts.status} `
            + entries.map((e) => `${e.target.className.split(' ')[0]}${e.isIntersecting ? '+' : '-'}${Math.round(e.boundingClientRect.top)}`).join(' '));
          cb.call(observer, entries, observer);
        }, options);
      }
      observe(target) {
        unseen.add(this);
        return super.observe(target);
      }
      disconnect() {
        unseen.delete(this);
        return super.disconnect();
      }
    };
  }

  // Events the harness waits on before it moves the clock again.
  const counts = { popstate: 0, resize: 0 };
  window.addEventListener('popstate', () => { counts.popstate++; }, true);
  window.addEventListener('resize', () => { counts.resize++; }, true);

  // Microtasks only: the whole virtual frame stays one task, so the browser cannot render
  // (and deliver scroll, observer or animation events) in the middle of it.
  const drain = async () => { for (let i = 0; i < 12; i++) await null; };
  const realFrame = () => new Promise((r) => real.raf(() => r()));
  // Each wait resumes inside a rendering update, before its layout and paint: what the last
  // frame or event started is put on the virtual clock before it is ever drawn.
  const settle = async () => {
    pickUp();
    await realFrame();
    pickUp();
    await realFrame();
    pickUp();
    for (let i = 0; unseen.size && i < 60; i++) {
      await realFrame();
      pickUp();
    }
    unseen.clear(); // one that never reports (a target out of the document) must not stall every frame
    await new Promise((r) => real.setTimeout(r, 0));
  };

  async function frame() {
    pickUp();
    const to = T + STEP;
    window.__frames++;
    // Timers due before this frame, in order, each at its own moment.
    for (let guard = 0; guard < 2000; guard++) {
      let next = null;
      for (const t of timers.values()) {
        if (t.at <= to && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      }
      if (!next) break;
      T = Math.max(T, next.at);
      if (next.every) next.at += next.every;
      else timers.delete(next.id);
      try {
        if (typeof next.fn === 'function') next.fn(...next.rest);
      } catch (err) {
        log.errors.push(`timer: ${err.message}`);
      }
      await drain();
    }
    T = to;
    driveAnimations();
    await drain();
    const due = [...rafs.values()];
    rafs.clear();
    for (const cb of due) {
      try {
        cb(T);
      } catch (err) {
        log.errors.push(`raf: ${err.message}`);
      }
      await drain();
    }
  }

  // FNV-1a over the canvas's pixels, a word at a time.
  function canvasHash(c) {
    if (!c || !c.width || !c.height) return 'empty';
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
    let h = 0x811c9dc5;
    for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 16777619);
    return `${c.width}x${c.height}:${(h >>> 0).toString(16)}`;
  }

  const noTape = (cls) => cls.split(/\s+/).filter((c) => c && c !== 'tape').join(' ');

  function record() {
    const main = document.querySelector('main');
    const q = (sel) => main.querySelector(sel);
    const peekText = q('.tl-peek__text');
    const peekBtn = q('.tl-peek__open');
    const digits = q('.tl-title__digits');
    const title = q('.tl-title');
    const theme = q('.tl-theme');
    const hint = q('.tl-hint');
    const bar = q('.tl-bar');
    const always = q('.tl-always');
    return {
      labels: [...main.querySelectorAll('.tl-bar__labels > *')].map((el) => [
        el.id, el.style.transform, el.style.opacity, el.tabIndex, el.getAttribute('aria-selected'),
      ]),
      canvas: canvasHash(q('canvas.tl-bar__ticks')),
      main: noTape(main.className),
      bar: bar && bar.className,
      peek: peekText && [peekText.className, peekText.textContent, peekBtn && peekBtn.getAttribute('aria-label')],
      hint: hint && hint.className,
      title: digits && digits.innerHTML,
      titleStyle: title && title.getAttribute('style'),
      theme: theme && [theme.textContent, theme.className],
      horizon: main.style.getPropertyValue('--horizon-y'),
      panels: [...main.querySelectorAll('.tl-panel')].map((p) => `${p.id}:${p.hidden ? 'h' : 's'}${p.classList.contains('is-active') ? 'a' : ''}`).join(' ')
        + (always ? ` always:${always.hidden ? 'h' : 's'}` : ''),
      arrived: `${main.querySelectorAll('.is-in').length}/${main.querySelectorAll('.is-leaving').length}`,
      scrollY: window.scrollY,
      hash: location.hash,
      hstate: JSON.stringify(history.state),
      active: pathOf(document.activeElement),
      halo: log.halo.splice(0),
      sweep: log.sweep.splice(0),
      waapi: JSON.parse(JSON.stringify(log.waapi.splice(0))),
      errors: log.errors.splice(0),
    };
  }

  // n frames, each followed by real rendering, each recorded.
  window.__run = async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      await frame();
      await settle();
      out.push({ f: window.__frames, ...record() });
    }
    return out;
  };
  window.__settle = settle;
  window.__counts = counts;
  window.__pathOf = pathOf;

  // ---------------------------------------------------------------- rest-point probes
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  };
  // Sorted: custom properties come out of a hash table, in no fixed order. An element's own
  // entry also carries its exact box and scroll offsets, which serialized styles round off.
  const styleText = (el, pseudo) => {
    const cs = getComputedStyle(el, pseudo);
    const all = [];
    for (let i = 0; i < cs.length; i++) all.push(`${cs[i]}:${cs.getPropertyValue(cs[i])}`);
    if (!pseudo) {
      const r = el.getBoundingClientRect();
      all.push(`(box):${r.x},${r.y},${r.width},${r.height}`, `(scroll):${el.scrollLeft},${el.scrollTop}`);
    }
    return all.sort().join(';');
  };
  let styled = new Map();
  window.__styles = () => {
    styled = new Map();
    const out = [];
    for (const r of [document.querySelector('main'), document.querySelector('.topbar')]) {
      if (!r) continue;
      for (const el of [r, ...r.querySelectorAll('*')]) {
        const p = pathOf(el);
        styled.set(p, [el, null]);
        out.push([p, fnv(styleText(el, null))]);
        for (const pseudo of ['::before', '::after']) {
          const c = getComputedStyle(el, pseudo).content;
          if (c && c !== 'none' && c !== 'normal') {
            styled.set(p + pseudo, [el, pseudo]);
            out.push([p + pseudo, fnv(styleText(el, pseudo))]);
          }
        }
      }
    }
    return out;
  };
  window.__styleOf = (p) => {
    const [el, pseudo] = styled.get(p) || [];
    if (!el) return null;
    return Object.fromEntries(styleText(el, pseudo).split(';').filter(Boolean).map((kv) => {
      const i = kv.indexOf(':');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }));
  };
  window.__html = () => {
    const main = document.querySelector('main');
    return main.outerHTML.replace(/^<main\b[^>]*>/, (tag) => tag.replace(/class="([^"]*)"/, (m, cls) => `class="${noTape(cls)}"`));
  };
  // For a rest point: the field hidden, and the review's drift (endless, on real time, and run
  // by the compositor, which a paused animation does not reliably reach) held at its start.
  const styleTag = (css) => {
    const tag = document.createElement('style');
    tag.textContent = css;
    document.head.append(tag);
    return tag;
  };
  let holdTag = null;
  window.__hold = async (on) => {
    if (on && !holdTag) holdTag = styleTag('#bg { visibility: hidden !important; } .review__track { animation: none !important; }');
    else if (!on && holdTag) {
      holdTag.remove();
      holdTag = null;
    }
    await settle();
  };
  // For the picture alone (styles, boxes and markup are read before it), everything is drawn
  // afresh. A composited layer keeps the raster offset it was first drawn with, mid-transition,
  // at a moment set by real time, and the same glyphs then land a fraction of a pixel apart:
  //   - every layer kept for will-change is let go (none holds a fixed-position descendant,
  //     so nothing moves and no observer fires);
  //   - the top bar, fixed and out of the page's flow, leaves rendering for a moment and comes
  //     back (no transition starts from display: none). Skipped while it holds focus, which
  //     taking it away would move.
  let paintTag = null;
  window.__repaint = async (on) => {
    if (on && !paintTag) {
      const bar = document.querySelector('.topbar');
      const focused = bar && bar.contains(document.activeElement);
      paintTag = styleTag(`*, *::before, *::after { will-change: auto !important; }${focused ? '' : ' .topbar { display: none !important; }'}`);
      await settle();
      paintTag.textContent = '*, *::before, *::after { will-change: auto !important; }';
    } else if (!on && paintTag) {
      paintTag.remove();
      paintTag = null;
    }
    await settle();
  };

  // ---------------------------------------------------------------- input
  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  window.__pointer = (type, target, { x, y, pointerType = 'mouse', id = 7 } = {}) => {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    const [cx, cy] = centre(el);
    const init = {
      bubbles: !/enter|leave/.test(type), cancelable: true, composed: true,
      pointerId: id, pointerType, isPrimary: true, button: 0, buttons: /up|cancel|leave/.test(type) ? 0 : 1,
      clientX: x ?? cx, clientY: y ?? cy,
    };
    el.dispatchEvent(new PointerEvent(type, init));
    return [init.clientX, init.clientY];
  };
  window.__wheel = (target, dx, dy) => {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    const [cx, cy] = centre(el);
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, deltaX: dx, deltaY: dy, deltaMode: 0, clientX: cx, clientY: cy }));
  };
  window.__key = (key) => {
    const el = document.activeElement || document.body;
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, composed: true }));
  };
};

// ---------------------------------------------------------------- scenarios
// Each starts from a fresh load. `t` drives both copies in lockstep (see Lockstep below).
const touchOf = (t) => (t.vp.hasTouch ? 'touch' : 'mouse');
const PRELUDE = 330; // the arrival film and the current year's opening, with room to settle

async function escape(t) {
  await t.act(() => window.__key('Escape'));
}

async function drag(t, step, moves) {
  const type = touchOf(t);
  const [x0, y0] = await t.act((pointerType) => {
    const inner = document.querySelector('.tl-bar__inner');
    const r = inner.getBoundingClientRect();
    const x = r.left + r.width / 2 + 40;
    const y = r.top + r.height * 0.6;
    const hit = document.elementFromPoint(x, y);
    window.__dragTarget = hit && inner.contains(hit) ? hit : inner;
    return window.__pointer('pointerdown', window.__dragTarget, { x, y, pointerType });
  }, type);
  for (let i = 1; i <= moves; i++) {
    await t.act((x, y, pointerType) => window.__pointer('pointermove', window.__dragTarget, { x, y, pointerType }), x0 + step * i, y0, type);
    await t.frames(1);
  }
  await t.act((x, y, pointerType) => window.__pointer('pointerup', window.__dragTarget, { x, y, pointerType }), x0 + step * moves, y0, type);
}

async function keys(t, list) {
  for (const [key, wait] of list) {
    await t.act((k) => window.__key(k), key);
    await t.frames(wait);
  }
}

const click = (t, sel) => t.act((s) => {
  const el = document.querySelector(s);
  if (!el) throw new Error(`nothing matches ${s}`);
  el.click();
}, sel);

const SCENARIOS = {
  // (a) The arrival film runs to the current year, which opens.
  async film(t) {
    await t.frames(600);
    await t.rest('open');
  },

  // (b) A link to a year runs the film there instead and opens it.
  async deep(t) {
    await t.frames(500);
    await t.rest('open-2021');
  },

  // (c) Escape closes the year; a drag past the end rubber-bands and flings back; a drag the
  // other way flings across years.
  async drag(t) {
    await t.frames(PRELUDE);
    await escape(t);
    await t.frames(90);
    await t.rest('closed');
    await drag(t, -15, 20);
    await t.frames(150);
    await t.rest('flung-past-end');
    await drag(t, 15, 20);
    await t.frames(150);
    await t.rest('flung-back');
  },

  // (d) The tablist: arrows, Home and End in the overview (they only centre a year), then the
  // same with a year open (they switch it), some fast enough to queue behind a transition.
  async keys(t) {
    await t.frames(PRELUDE);
    await escape(t);
    await t.frames(90);
    await t.act(() => document.querySelector('.tl-bar__labels [tabindex="0"]').focus());
    await t.frames(2);
    await keys(t, [['ArrowLeft', 30], ['ArrowLeft', 6], ['ArrowLeft', 30], ['ArrowRight', 20], ['ArrowRight', 20], ['ArrowRight', 20], ['Home', 40], ['End', 60]]);
    await t.rest('overview-keys');
    await keys(t, [['Home', 40]]);
    await t.act(() => document.activeElement.click());
    await t.frames(90);
    await keys(t, [['ArrowRight', 40], ['ArrowRight', 5], ['ArrowRight', 60], ['ArrowLeft', 40], ['ArrowLeft', 40], ['ArrowLeft', 60], ['End', 60], ['Home', 90]]);
    await t.frames(60);
    await t.rest('open-keys');
  },

  // (e) A wheel outside the tape mid-film lets it go to the nearest year; a sideways series
  // scrubs the tape; a vertical one afterwards must leave it where it is.
  async wheel(t) {
    await t.frames(60);
    await t.act(() => window.__wheel(document.body, 0, 40));
    await t.frames(150);
    await t.rest('film-interrupted');
    for (let i = 0; i < 12; i++) {
      await t.act(() => window.__wheel('.tl-bar__inner', 24, 1));
      await t.frames(1);
    }
    await t.frames(60);
    await t.rest('scrubbed');
    for (let i = 0; i < 12; i++) {
      await t.act(() => window.__wheel('.tl-bar__inner', 2, 30));
      await t.frames(1);
    }
    await t.frames(60);
    await t.rest('vertical-ignored');
  },

  // (f) Open from the overview (pushes history), continue to the next year, close with the
  // button (back through history), then forward and back again.
  async history(t) {
    await t.frames(PRELUDE);
    await escape(t);
    await t.frames(90);
    await click(t, '.tl-bar__labels > :nth-child(2)');
    await t.frames(150);
    await t.rest('opened');
    await click(t, '.tl-panel.is-active .tl-next');
    await t.frames(150);
    await t.rest('continued');
    await t.history(() => document.querySelector('.tl-close').click());
    await t.frames(150);
    await t.rest('closed');
    await t.history(() => history.forward());
    await t.frames(150);
    await t.rest('forward');
    await t.history(() => history.back());
    await t.frames(150);
    await t.rest('back');
  },

  // (g) Scroll the open year until the tape pins under the top bar, and back to the top.
  async scroll(t) {
    await t.frames(PRELUDE);
    await t.act(() => {
      const head = document.querySelector('.tl-head');
      window.scrollTo({ top: head.getBoundingClientRect().bottom + window.scrollY + 320, behavior: 'instant' });
    });
    await t.frames(60);
    await t.rest('stuck');
    await t.act(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await t.frames(60);
    await t.rest('top');
  },

  // (h) The window changes size while the tape is springing across the years.
  async resize(t) {
    await t.frames(PRELUDE);
    await click(t, '.tl-bar__labels > :first-child');
    await t.frames(12);
    await t.viewport({ ...t.vp, ...RESIZED[t.vpName] });
    await t.frames(200);
    await t.rest('resized');
    await t.viewport(t.vp);
    await t.frames(120);
    await t.rest('restored');
  },

  // (i) A founder hovered (mouse) or pressed (touch) draws the halo round their card.
  async founders(t) {
    await t.frames(PRELUDE);
    await escape(t);
    await t.frames(90);
    await t.act(() => {
      const card = document.querySelector('.founder');
      window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - 140, behavior: 'instant' });
    });
    await t.frames(40);
    await t.act(() => window.__pointer('pointerenter', document.querySelectorAll('.founder')[1], { pointerType: 'mouse' }));
    await t.frames(60);
    await t.rest('hover');
    await t.act(() => {
      const cards = document.querySelectorAll('.founder');
      window.__pointer('pointerleave', cards[1], { pointerType: 'mouse' });
      window.__pointer('pointerenter', cards[2], { pointerType: 'mouse' });
    });
    await t.frames(20);
    await t.act(() => window.__pointer('pointerleave', document.querySelectorAll('.founder')[2], { pointerType: 'mouse' }));
    await t.frames(60);
    await t.act(() => window.__pointer('pointerdown', document.querySelectorAll('.founder')[0], { pointerType: 'touch', id: 9 }));
    await t.frames(30);
    await t.act(() => window.__pointer('pointerup', document.querySelectorAll('.founder')[0], { pointerType: 'touch', id: 9 }));
    await t.frames(90);
    await t.rest('let-go');
  },

  // (j) A photo opens in the lightbox; Escape puts the photo away and the year stays open.
  async lightbox(t) {
    await t.frames(PRELUDE);
    await click(t, '.tl-bar__labels > :nth-child(2)');
    await t.frames(150);
    await t.act(() => {
      const frame = document.querySelector('.tl-panel.is-active .frame');
      const r = frame.getBoundingClientRect();
      window.scrollTo({ top: r.top + window.scrollY - (window.innerHeight - r.height) / 2, behavior: 'instant' });
    });
    await t.frames(60);
    await t.rest('before-photo');
    await click(t, '.tl-panel.is-active .frame');
    await t.frames(60);
    await t.press('Escape');
    await t.frames(60);
    await t.expect('the year is still open', () => document.querySelector('main').classList.contains('is-open'));
    await t.frames(60);
    await t.rest('after-photo');
  },
};

// ---------------------------------------------------------------- lockstep
class Divergence extends Error {}

const brief = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 600 ? `${s.slice(0, 600)}... (${s.length} chars)` : s;
};

class Lockstep {
  constructor(job, sides, report) {
    Object.assign(this, job);
    this.sides = sides; // [{ name, page, errors }]
    this.report = report;
    this.recent = []; // the last few frame pairs, for context
    this.frameCount = 0;
    this.restCount = 0;
  }

  both(fn) {
    return Promise.all(this.sides.map((s) => fn(s.page, s)));
  }

  async act(fn, ...rest) {
    const [ra, rb] = await this.both((p) => p.evaluate(fn, ...rest));
    await this.both((p) => p.evaluate(() => window.__settle()));
    if (JSON.stringify(ra) !== JSON.stringify(rb)) {
      throw new Divergence(`an action returned different values: before ${brief(ra)}, after ${brief(rb)}`);
    }
    return ra;
  }

  async frames(n) {
    for (let done = 0; done < n;) {
      const k = Math.min(20, n - done);
      const [A, B] = await this.both((p) => p.evaluate((m) => window.__run(m), k));
      for (let i = 0; i < k; i++) {
        const a = A[i];
        const b = B[i];
        const ka = JSON.stringify(a);
        const kb = JSON.stringify(b);
        this.recent.push([a, b]);
        if (this.recent.length > 4) this.recent.shift();
        if (ka !== kb) {
          // Three more frames after the difference, for context.
          const [A2, B2] = await this.both((p) => p.evaluate(() => window.__run(3)));
          throw new Divergence(this.describe(this.recent.slice(), A2.map((x, j) => [x, B2[j]])));
        }
        for (const e of [...a.errors]) this.report.note(`${this.label}: page error (both sides) at frame ${a.f}: ${e}`);
      }
      done += k;
      this.frameCount += k;
    }
  }

  describe(beforeAndAt, after) {
    const lines = [];
    const at = beforeAndAt[beforeAndAt.length - 1];
    const keys = Object.keys(at[0]).filter((k) => JSON.stringify(at[0][k]) !== JSON.stringify(at[1][k]));
    lines.push(`first divergence at frame ${at[0].f}, in: ${keys.join(', ')}`);
    const show = (pair, tag) => {
      const [a, b] = pair;
      const diff = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      lines.push(`  frame ${a.f}${tag}: ${diff.length ? `differs in ${diff.join(', ')}` : 'equal'}`);
      for (const k of (diff.length ? diff : keys)) {
        lines.push(`    ${k} before: ${brief(a[k])}`);
        lines.push(`    ${k} after:  ${brief(b[k])}`);
      }
    };
    beforeAndAt.forEach((pair, i) => show(pair, i === beforeAndAt.length - 1 ? ' (first difference)' : ''));
    after.forEach((pair) => show(pair, ''));
    return lines.join('\n');
  }

  // Runs something that moves through history, then waits (in real time, with the clock
  // stopped) for its popstate to arrive on both sides.
  async history(fn) {
    const before = await this.both((p) => p.evaluate(() => window.__counts.popstate));
    await this.both((p) => p.evaluate(fn));
    await this.waitCount('popstate', before);
    await this.both((p) => p.evaluate(() => window.__settle()));
  }

  // Polled from here, not with waitForFunction: the page's own timers are on the virtual
  // clock, which stands still while we wait.
  async waitCount(key, base) {
    await Promise.all(this.sides.map(async (s, i) => {
      for (let tries = 0; ; tries++) {
        if (await s.page.evaluate((k) => window.__counts[k], key) > base[i]) return;
        if (tries > 750) throw new Error(`${s.name}: no ${key} event`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }));
  }

  async viewport(vp) {
    const before = await this.both((p) => p.evaluate(() => window.__counts.resize));
    await this.both((p) => p.setViewport(vp));
    await this.waitCount('resize', before);
    await this.both((p) => p.evaluate(() => window.__settle()));
  }

  async press(key) {
    await this.both((p) => p.keyboard.press(key));
    await this.both((p) => p.evaluate(() => window.__settle()));
  }

  async expect(what, fn) {
    const [a, b] = await this.both((p) => p.evaluate(fn));
    if (!a || !b) this.report.fail(`${this.label}: expected ${what} (before ${a}, after ${b})`);
  }

  async rest(name) {
    const label = `${this.label} @${name}`;
    this.restCount++;
    // Everything below is read with the field hidden and the review's drift held (see
    // __hold): both run on real time.
    await this.both((p) => p.evaluate(() => window.__hold(true)));
    // CSS transitions and image loads run on real time: let them finish.
    await new Promise((r) => setTimeout(r, 2600));
    await this.both((p) => p.waitForNetworkIdle({ idleTime: 300, timeout: 20000 }).catch(() => {}));
    const [sa, sb] = await this.both((p) => p.evaluate(() => window.__styles()));
    const [ha, hb] = await this.both((p) => p.evaluate(() => window.__html()));
    await this.both((p) => p.evaluate(() => window.__repaint(true)));
    const shots = await this.both((p) => stableShot(p));
    await this.both((p) => p.evaluate(() => window.__repaint(false)));
    const problems = [];

    const [pa, pb] = shots.map((b) => PNG.sync.read(Buffer.from(b)));
    if (pa.width !== pb.width || pa.height !== pb.height) {
      problems.push(`screenshot sizes differ: ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`);
    } else {
      const diff = new PNG({ width: pa.width, height: pa.height });
      const n = pixelmatch(pa.data, pb.data, diff.data, pa.width, pa.height, { threshold: 0, includeAA: true });
      if (n) {
        problems.push(`${n} pixels differ`);
        const base = path.join(outDir, `${this.label.replace(/[^\w-]+/g, '_')}-${name}`);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(`${base}-before.png`, PNG.sync.write(pa));
        fs.writeFileSync(`${base}-after.png`, PNG.sync.write(pb));
        fs.writeFileSync(`${base}-diff.png`, PNG.sync.write(diff));
      }
    }

    if (sa.length !== sb.length) problems.push(`computed styles: ${sa.length} elements before, ${sb.length} after`);
    const mapB = new Map(sb);
    let styleDiffs = 0;
    for (const [p, h] of sa) {
      if (mapB.get(p) === h) continue;
      styleDiffs++;
      if (styleDiffs > 5) continue;
      const [xa, xb] = await this.both((pg) => pg.evaluate((q) => window.__styleOf(q), p));
      if (!xb) {
        problems.push(`computed style: ${p} missing after`);
        continue;
      }
      const props = Object.keys(xa).filter((k) => xa[k] !== xb[k]).slice(0, 8);
      problems.push(`computed style of ${p}: ${props.map((k) => `${k} ${brief(xa[k])} -> ${brief(xb[k])}`).join('; ')}`);
    }
    if (styleDiffs > 5) problems.push(`... ${styleDiffs} elements differ in computed style`);

    if (ha !== hb) {
      let i = 0;
      while (i < ha.length && ha[i] === hb[i]) i++;
      problems.push(`main's outerHTML differs at ${i}:\n      before ...${ha.slice(Math.max(0, i - 160), i + 160)}...\n      after  ...${hb.slice(Math.max(0, i - 160), i + 160)}...`);
    }
    await this.both((p) => p.evaluate(() => window.__hold(false)));

    if (problems.length) {
      if (VERBOSE) {
        const logs = await this.both((p) => p.evaluate(() => window.__ioLog()));
        problems.push(`observer passes before:\n      ${logs[0].join('\n      ')}\n    observer passes after:\n      ${logs[1].join('\n      ')}`);
      }
      this.report.fail(`${label}:\n    ${problems.join('\n    ')}`);
    } else {
      this.report.pass(`${label}: identical (${pa.width}x${pa.height}, ${sa.length} styles)`);
    }
  }
}

// The page as it has settled: shots are taken until two in a row agree, so a tile still being
// re-rastered or an image still decoding is never what gets compared.
async function stableShot(page) {
  let last = null;
  for (let i = 0; i < 8; i++) {
    const shot = Buffer.from(await page.screenshot({ type: 'png', captureBeyondViewport: false }));
    if (last && shot.equals(last)) return shot;
    last = shot;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

// ---------------------------------------------------------------- serving
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.bin': 'application/octet-stream',
};

// A plain static server of its own: this check must not depend on tools/serve.mjs's port or
// its caching, and each copy gets its own origin.
function staticServer(root, port) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.join(base, pathname);
    if (!file.startsWith(base)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      // the 404 below
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- running
async function openSide(browser, port, job, name) {
  dbg(`${name}: context`);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const side = { name, page, context, errors: [] };
  page.on('pageerror', (e) => side.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/localhost:3000|ERR_|favicon|404|Failed to load resource/.test(m.text())) side.errors.push(`console: ${m.text()}`);
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  // Nothing beyond the copy itself: no API, no reCAPTCHA, no payment script.
  await cdp.send('Network.setBlockedURLs', { urls: ['*localhost:3000*', '*://www.google.com/*', '*://www.gstatic.com/*', '*://checkout.razorpay.com/*', '*://paddockgridx.app/*'] });
  // The web font is held back until the page's scripts have run and the page has rendered
  // twice. Otherwise whether it beat them is a race: the first layout (the labels' widths, so
  // the transforms left on labels culled before the font came) and, under reduced motion, the
  // arrivals' first IntersectionObserver pass (the year opens during the script) would depend
  // on it. Late, it always swaps in after both.
  const heldFonts = [];
  let fontsOpen = false;
  const letThrough = (requestId) => cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
  cdp.on('Fetch.requestPaused', (e) => {
    if (fontsOpen) letThrough(e.requestId);
    else heldFonts.push(e.requestId);
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*.woff2', requestStage: 'Request' }] });
  await page.setViewport(job.vp);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: MOTIONS[job.motion] }]);
  await page.evaluateOnNewDocument(HARNESS, 1234, job.hash || '');
  await page.bringToFront();
  dbg(`${name}: goto`);
  await page.goto(`http://127.0.0.1:${port}/${PAGE}.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => window.__settle());
  fontsOpen = true;
  await Promise.all(heldFonts.splice(0).map(letThrough));
  await page.evaluate(() => (document.readyState === 'complete' ? null : new Promise((r) => window.addEventListener('load', () => r(null), { once: true }))));
  dbg(`${name}: loaded`);
  // Fonts and first images in real time, with the clock stopped: both copies start their
  // first frame from the same place.
  await page.evaluate(() => document.fonts.ready.then(() => null));
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 30000 }).catch(() => {});
  dbg(`${name}: idle`);
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => window.__settle());
  dbg(`${name}: ready`);
  return side;
}

const labelOf = (job) => `${job.vpName}/${job.motion}/${job.scenario}`;

// A browser that went away mid-run (killed from outside, or out of memory) says nothing about
// parity: such a run is thrown away and run again on fresh browsers.
const browserGone = (err, browsers) => browsers.some((b) => !b.connected)
  || /Target closed|Connection closed|Session closed|has been closed|disconnected/i.test(String(err && err.message));

// One scenario in one viewport and motion setting. Its report is held until it has finished,
// so a run that is thrown away leaves nothing behind.
async function runJob(browsers, job) {
  const label = labelOf(job);
  const lines = [];
  let fails = 0;
  const report = {
    pass: (m) => lines.push(`  ok    ${m}`),
    done: (m) => lines.push(`PASS  ${m}`),
    note: (m) => lines.push(`  note  ${m}`),
    fail: (m) => {
      fails++;
      lines.push(`FAIL  ${m}`);
    },
  };
  let sides = [];
  let gone = null;
  const started = Date.now();
  try {
    sides = await Promise.all([
      openSide(browsers[0], PORT_A, job, 'before'),
      openSide(browsers[1], PORT_B, job, 'after'),
    ]);
    const t = new Lockstep({ ...job, label }, sides, report);
    await SCENARIOS[job.scenario](t);
    report.done(`${label}: ${t.frameCount} frames equal, ${t.restCount} rest points (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  } catch (err) {
    if (browserGone(err, browsers)) gone = err;
    else if (err instanceof Divergence) report.fail(`${label}: trace differs\n${err.message}`);
    else report.fail(`${label}: ${err.stack || err}`);
  } finally {
    if (!gone && sides.length) {
      const [ea, eb] = sides.map((s) => s.errors.join('\n'));
      if (ea !== eb) report.fail(`${label}: page errors differ\n  before: ${ea || '(none)'}\n  after: ${eb || '(none)'}`);
      else if (ea) report.note(`${label}: page errors (both sides): ${ea}`);
    }
    dbg(`${label}: closing`);
    await Promise.all(sides.map((s) => s.context.close().catch(() => {})));
    dbg(`${label}: closed`);
  }
  return { lines, fails, gone };
}

async function main() {
  if (!beforeDir) {
    console.error('usage: node tools/check/tape-parity.mjs --before <dir> [--after <dir>] [--viewports ...] [--motion ...] [--scenarios ...]');
    process.exit(2);
  }
  const vpNames = opt('viewports', Object.keys(VIEWPORTS).join(',')).split(',');
  const motions = opt('motion', Object.keys(MOTIONS).join(',')).split(',');
  const scenarios = opt('scenarios', Object.keys(SCENARIOS).join(',')).split(',');
  for (const s of scenarios) if (!SCENARIOS[s]) throw new Error(`unknown scenario ${s} (have ${Object.keys(SCENARIOS).join(', ')})`);
  for (const v of vpNames) if (!VIEWPORTS[v]) throw new Error(`unknown viewport ${v}`);

  const jobs = [];
  for (const vpName of vpNames) {
    for (const motion of motions) {
      for (const scenario of scenarios) {
        jobs.push({ vpName, vp: VIEWPORTS[vpName], motion, scenario, hash: scenario === 'deep' ? '#2021' : '' });
      }
    }
  }

  let failures = 0;

  console.log(`tape parity: ${beforeDir} (before, :${PORT_A}) vs ${afterDir} (after, :${PORT_B}), ${jobs.length} runs, ${JOBS} at a time`);
  const servers = [await staticServer(beforeDir, PORT_A), await staticServer(afterDir, PORT_B)];
  const extra = opt('chrome-args', '').split(/\s+/).filter(Boolean);
  const launch = () => puppeteer.launch({ executablePath: CHROME, headless: true, args: [...CHROME_ARGS, ...extra], protocolTimeout: 600000 });
  const queue = jobs.slice();
  const workers = [];
  for (let w = 0; w < Math.min(JOBS, jobs.length); w++) {
    workers.push((async () => {
      let browsers = [await launch(), await launch()];
      try {
        while (queue.length) {
          const job = queue.shift();
          let result = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            result = await runJob(browsers, job);
            if (!result.gone) break;
            console.log(`  retry ${labelOf(job)}: a browser went away mid-run (${result.gone.message.split('\n')[0]}); relaunching`);
            await Promise.all(browsers.map((b) => b.close().catch(() => {})));
            browsers = [await launch(), await launch()];
          }
          if (result.gone) {
            failures++;
            console.log(`FAIL  ${labelOf(job)}: could not be run: ${result.gone.message.split('\n')[0]}`);
            continue;
          }
          for (const line of result.lines) console.log(line);
          failures += result.fails;
        }
      } finally {
        await Promise.all(browsers.map((b) => b.close().catch(() => {})));
      }
    })());
  }
  try {
    await Promise.all(workers);
  } finally {
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
  }
  console.log(failures ? `\n${failures} difference(s): see above${fs.existsSync(outDir) ? ` and ${outDir}` : ''}` : `\nall ${jobs.length} runs identical`);
  return failures ? 1 : 0;
}

// Exits outright: a CDP call left waiting on a closed browser would otherwise hold the process
// open until its protocol timeout.
main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
