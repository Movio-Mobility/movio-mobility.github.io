/*
 * The timeline tape, shared by the pages that tell something in order (the journey's years;
 * careers' teams). Each page brings its stops and what they open; this file is the instrument.
 *
 * A line of stops runs across the studio's horizon. A needle stays fixed at the centre of the
 * screen and the tape travels beneath it: one point per stop, evenly spaced, each with its
 * label above it.
 *
 *   The film       On arrival the tape runs from the first stop to the one the page asks for,
 *                  with a beat of anticipation, a smooth start and a long settle, and that stop
 *                  opens. Any touch, wheel or key takes over on the way.
 *   The tape       Drag it, fling it, wheel it sideways or arrow through it. It snaps to the
 *                  nearest stop that opens.
 *   A stop         Tapping one lifts its label off the tape and grows it into the title (FLIP),
 *                  compacts the tape and pins it under the top bar, and its panel rises in.
 *   Switching      The page rolls its title over (the journey's odometer) while the tape glides.
 *
 * The field reacts through two hooks on window.gridBG, both feature-detected: sweepX() streams
 * the particles along with the tape's travel, and setHalo() lets a few of the brighter sparks
 * drift along the hairline, or gather wherever the page points them (haloOverride: the
 * journey's founders). When the footer is in play the halo is its, not ours.
 *
 * The canvas paints the hairline and dots, and only while something moves. Labels are real
 * buttons (a tablist over the panels) placed with transforms. One rAF loop does all of it and
 * sleeps whenever the tape and every tween are at rest.
 *
 *   const tape = GridTape.create(mainEl, options);
 *
 * The markup is the journey's (see journey.html): .tl-head (.tl-title, .tl-theme), .tl-bar
 * (.tl-bar__inner holding the canvas, the glint, .tl-bar__labels and the needle, then
 * .tl-close) and .tl-peek (.tl-peek__open with .tl-peek__text, then .tl-hint). tape.css styles
 * it, against the class `tape` on the element passed in.
 *
 * Options (every one optional but `stops`; the defaults are the journey's behaviour):
 *   stops          [{ id, panel?, theme?, peek?, openable, data? }] in tape order. `openable`
 *                  defaults to having a panel.
 *   label          { className ('tl-year'), tabId(s), controls(s), render(s, button),
 *                    flipParts(s, button), drop (5) }: how a stop's tab is made, which of its
 *                  parts fly into the title's parts when it opens (pairs, by index), and how
 *                  many px the labels settle toward the line as the tape compacts. render is
 *                  called again on every setStops(), with the button emptied first.
 *   title          { el, parts(), set(s), roll(s, dir), rest?(s, i, { ir, width }) }: the big
 *                  title, its parts for the FLIP, setting it, rolling it over on a switch, and
 *                  where part i lands on the tape when a stop closes ({ cx, cy, h }).
 *   peek(s)        { text, label } for the line under the tape in the overview.
 *   arrivals(s)    the elements that rise in when s opens; arrivals(null) for the overview.
 *   hooks          onShowPanel(s), onHidePanels(), onLayout(), onLanded(s), onOpened(s),
 *                  onClosed(s), onStart().
 *   history        { key, hash(s), parse(hash) }: the history entry and the URL of an open stop.
 *   hintKey        sessionStorage key that remembers the drag hint has been seen.
 *   spacing(vw, { maxLabelWidth })   px between stops. Asked again after setStops(), and the
 *                  tape eases to the new value.
 *   arrival(deep)  { id, open }: where the film runs to (deep is the stop the URL names, or null).
 *   haloOverride(depth)   a halo spec to use instead of the hairline, or null.
 *   handedOver()   true while someone else has the halo (default: the footer's night, a photo).
 *   escapeBlocked()   true while Escape belongs to something else (a photo).
 *   focusHiddenSelector   containers that, hidden, take keyboard focus with them.
 *
 * Returns { open(id, how), switchTo(id, how), close(), requestClose(), focusOn(id),
 * setStops(stops), arrive(list, delayMs), layout(), wake(), syncHalo(), state, stopOf(id) }.
 *
 * Also GridTape.placeHorizon(host): sets the host's --horizon-y the way the tape does, for a
 * page that shows something on the horizon before it has a tape (careers, while it loads).
 */
(() => {
  'use strict';

  const root = document.documentElement;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clamp01 = (v) => clamp(v, 0, 1);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // ---------------------------------------------------------------- tuning
  const LENS = 0.6;        // width of the swell around the needle, in slots
  const PROJECT = 0.32;    // seconds of momentum a fling carries before it picks a stop
  const SPRING_K = 90;     // tape spring: ω ≈ 9.5 rad/s ...
  const SPRING_C = 17;     // ... just under critical, so a fling lands with the faintest give
  const HOLD = 0.35;       // the film: a still beat first,
  const WIND = 0.18;       // then a short draw back the other way before it sets off
  const FLIGHT = 940;      // ms for the label to become the title
  // The flights lift off gently, travel, then take a long soft landing. The site's spring is
  // right for a capsule morphing in place, but it spends most of a big move in its first
  // quarter, which reads as a jump when a label grows five times over.
  const FLIGHT_EASE = 'cubic-bezier(0.45, 0, 0.12, 1)';
  const REFLOW = 0.16;     // s: stops easing to new slots, in and out, after setStops()

  const defaultSpacing = (vw) => (vw < 760 ? 112 : clamp(vw * 0.15, 150, 220));

  // ---------------------------------------------------------------- the film
  // Speed profile of the run: out of rest gently, peaking a little over a third of the way,
  // then a long, unhurried settle. A beta curve, u^1.6 (1 - u)^2.6, integrated into a table.
  const CURVE = (() => {
    const n = 256;
    const out = new Float32Array(n + 1);
    let sum = 0;
    for (let i = 1; i <= n; i++) {
      const u = (i - 0.5) / n;
      sum += Math.pow(u, 1.6) * Math.pow(1 - u, 2.6);
      out[i] = sum;
    }
    for (let i = 1; i <= n; i++) out[i] /= sum;
    return out;
  })();
  function curve(u) {
    const x = clamp01(u) * 256;
    const i = Math.floor(x);
    if (i >= 256) return 1;
    return CURVE[i] + (CURVE[i + 1] - CURVE[i]) * (x - i);
  }

  const HALO_POS = ['left', 'top', 'width', 'height', 'radius'];
  const HALO_LOOK = ['depth', 'fill', 'grip', 'weight'];

  // The tape lies on the cyclorama's bright horizon band. These are STUDIO_FS's numbers in
  // grid-bg.js: the horizon is mix(-0.12, -0.17, portrait) screen-min-dimensions above the
  // centre, and the band peaks 0.045 below it. #bg is fixed at the top, so its height (100lvh)
  // is the right one to measure from even while a phone's URL bar is showing.
  function placeHorizon(host) {
    const vh = window.innerHeight;
    const bg = document.getElementById('bg');
    let y = vh * 0.4; // the CSS studio's band, for browsers without WebGL2
    if (bg && root.classList.contains('gl') && bg.clientHeight > 0) {
      const W = bg.clientWidth;
      const H = bg.clientHeight;
      const portrait = clamp01((1 - W / H) / 0.55);
      y = H / 2 + (-0.12 - 0.05 * portrait + 0.045) * Math.min(W, H);
    }
    y = clamp(y, 150, Math.max(150, vh - 190));
    host.style.setProperty('--horizon-y', `${y.toFixed(1)}px`);
  }

  function create(host, opts = {}) {
    if (!host) return null;
    // The page arrives mid-film: say so before anything below reads a computed style.
    if (!host.classList.contains('is-filming')) host.classList.add('is-filming');

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const label = opts.label || {};
    const title = opts.title || {};
    const hist = opts.history || {};

    const head = host.querySelector('.tl-head');
    const titleEl = title.el || host.querySelector('.tl-title');
    const theme = host.querySelector('.tl-theme');
    const bar = host.querySelector('.tl-bar');
    const inner = bar.querySelector('.tl-bar__inner');
    const canvas = bar.querySelector('.tl-bar__ticks');
    const ctx = canvas.getContext('2d');
    const labels = bar.querySelector('.tl-bar__labels');
    const closeBtn = bar.querySelector('.tl-close');
    const peekBtn = host.querySelector('.tl-peek__open');
    const peekText = host.querySelector('.tl-peek__text');
    const hint = host.querySelector('.tl-hint');

    const LABEL_CLASS = label.className || 'tl-year';
    const LABEL_SELECTOR = `button.${LABEL_CLASS}`;
    const tabIdOf = label.tabId || ((s) => `tab-${s.id}`);
    const controlsOf = label.controls || ((s) => (s.panel && s.panel.id) || null);
    const renderLabel = label.render || ((s, button) => {
      const text = document.createElement('span');
      text.textContent = String(s.id);
      button.append(text);
    });
    const flipPartsOf = label.flipParts || ((s, button) => [button.firstElementChild || button]);
    const DROP = Number.isFinite(label.drop) ? label.drop : 5;
    const titleParts = title.parts || (() => [titleEl]);
    const setTitle = title.set || (() => {});
    const rollTitle = title.roll || ((s) => setTitle(s));
    const peekOf = opts.peek || ((s) => ({ text: s.peek || '', label: `Open ${s.peek || s.id}` }));
    const arrivalsOf = opts.arrivals || ((s) => (s && s.panel ? [...s.panel.querySelectorAll('[data-arrive]')] : []));
    const HISTORY_KEY = hist.key || 'tape';
    const hashOf = hist.hash || ((s) => `#${encodeURIComponent(s.id)}`);
    const parseHash = hist.parse || ((hash) => (hash.length > 1 ? decodeURIComponent(hash.slice(1)) : null));
    const handedOver = opts.handedOver
      || (() => root.classList.contains('is-night') || root.classList.contains('lightbox-open'));
    const escapeBlocked = opts.escapeBlocked || (() => false);
    const FOCUS_HIDDEN = opts.focusHiddenSelector || '.tl-panel[hidden]';
    const hook = (name, ...rest) => (typeof opts[name] === 'function' ? opts[name](...rest) : undefined);

    // ---------------------------------------------------------------- the stops
    // Each stop owns one slot on the tape, slot i spanning i to i + 1, and sits at its middle,
    // `at`. Positions along the tape (tape.pos and everything measured against it) are in
    // slots. setStops() eases `at` to a new slot and fades a stop in or out through
    // `presence`; until it is called they are simply slot + 0.5 and 1.
    const byEl = new Map();
    function makeStop(spec, slot) {
      const el = document.createElement('button');
      el.className = LABEL_CLASS;
      el.type = 'button';
      const s = {
        id: spec.id,
        slot,
        at: slot + 0.5,
        atTo: slot + 0.5,
        presence: 1,
        presenceTo: 1,
        leaving: false,
        el,
        panel: spec.panel || null,
        openable: spec.openable === undefined ? !!spec.panel : !!spec.openable,
        theme: spec.theme || '',
        peek: spec.peek || '',
        data: spec.data,
        arrivals: [],
        width: 0,
        shown: true,
        lift: 1,   // the label's own visibility: 0 while its stop is out flying as the title
        liftTo: 1,
      };
      el.id = tabIdOf(s);
      el.tabIndex = -1;
      renderLabel(s, el);
      el.setAttribute('role', 'tab');
      const controls = controlsOf(s);
      if (controls) el.setAttribute('aria-controls', controls);
      el.setAttribute('aria-selected', 'false');
      byEl.set(el, s);
      return s;
    }

    // One label, a tab, per stop, in order.
    let stops = (opts.stops || []).map((spec, slot) => {
      const s = makeStop(spec, slot);
      labels.append(s.el);
      return s;
    });
    if (!stops.length) return null;
    for (const s of stops) s.arrivals = arrivalsOf(s);
    // The overview's own arrivals: what shows below the tape while nothing is open.
    const overview = arrivalsOf(null) || [];
    let byId = new Map(stops.map((s) => [s.id, s]));
    let story = stops.filter((s) => s.openable); // the stops that open, in order
    let extent = stops.length;                   // where the hairline ends, in slots

    const tape = { pos: 0.5, vel: 0, target: 0.5, mode: 'idle', spacing: 112, width: 0, height: 0, dpr: 1 };
    let spacingTo = tape.spacing; // where setStops() is easing the spacing to
    const state = { open: null, busy: false, pushed: false };
    let hairline = 56;
    let compact = 0;         // 0 on the horizon, 1 pinned under the top bar
    let compactTo = 0;
    let reveal = reduceMotion ? 1 : 0; // the tape drawing itself out from the needle on arrival
    let film = null;
    let focus = story[0] || null; // the stop nearest the needle in the overview
    let flights = 0;         // FLIP animations in progress (the halo follows the bar during them)

    const api = () => window.gridBG;

    function nearestStory(p) {
      let best = story[0];
      let dist = Infinity;
      for (const y of story) {
        const d = Math.abs(y.at - p);
        if (d < dist) {
          dist = d;
          best = y;
        }
      }
      return best;
    }

    // Past either end the tape gives a little, then pulls back.
    function rubber(p) {
      const lo = 0.5;
      const hi = extent - 0.5;
      if (p < lo) return lo - (lo - p) * 0.35;
      if (p > hi) return hi + (p - hi) * 0.35;
      return p;
    }

    // ---------------------------------------------------------------- the film
    // The film's end. When it has somewhere to go next (opening the stop it landed on), that
    // goes first, so the overview's peek and hint never get a frame in between.
    function filmLanded(then) {
      if (then) then();
      else landed();
      host.classList.remove('is-filming');
    }

    function startFilm(toId, then) {
      const to = byId.get(toId).at;
      const from = tape.pos;
      host.classList.add('is-filming'); // the peek stays out of the way while the tape travels
      if (reduceMotion) {
        tape.pos = to;
        tape.vel = 0;
        tape.mode = 'idle';
        filmLanded(then);
        wake();
        return;
      }
      if (Math.abs(to - from) < 0.01) {
        tape.mode = 'idle';
        window.setTimeout(() => filmLanded(then), 450); // let the tape draw itself first
        wake();
        return;
      }
      film = {
        t: 0,
        from,
        to,
        // A beat of anticipation: the opposite way to the trip, about 10 px.
        wind: (-Math.sign(to - from) * 10) / tape.spacing,
        dur: 0.8 + 0.16 * Math.abs(to - from),
        hold: reveal < 1 ? HOLD : 0.12,
        then,
      };
      tape.mode = 'film';
      wake();
    }

    function stepFilm(dt) {
      film.t += dt;
      const t = film.t;
      const w0 = film.hold;
      const w1 = w0 + WIND;
      if (t < w0) {
        tape.pos = film.from;
      } else if (t < w1) {
        tape.pos = film.from + film.wind * easeInOut((t - w0) / WIND);
      } else {
        const u = (t - w1) / film.dur;
        tape.pos = film.from + film.wind + (film.to - film.from - film.wind) * curve(u);
        if (u >= 1) {
          tape.pos = film.to;
          const then = film.then;
          film = null;
          tape.mode = 'idle';
          tape.vel = 0;
          filmLanded(then);
        }
      }
    }

    function cancelFilm() {
      if (!film) return false;
      film = null;
      host.classList.remove('is-filming');
      return true;
    }

    // Something other than a drag cut the film short: carry its momentum into the nearest stop.
    function interruptFilm() {
      if (!cancelFilm()) return;
      tape.target = nearestStory(tape.pos + tape.vel * PROJECT).at;
      tape.mode = 'spring';
      wake();
    }

    // ---------------------------------------------------------------- the loop
    let raf = 0;
    let last = 0;
    let inFrame = false; // wake() from inside a frame (a film landing opens a stop) must not
    let again = false;   // start a second rAF chain: it asks this frame to schedule the next

    function wake() {
      if (inFrame) {
        again = true;
        return;
      }
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function frame(now) {
      raf = 0;
      inFrame = true;
      again = false;
      let still = true;
      try {
        still = step(now);
      } finally {
        inFrame = false;
      }
      if (!still || again) raf = requestAnimationFrame(frame);
    }

    // One frame of everything. Returns true when all of it is at rest.
    function step(now) {
      const dt = clamp((now - last) / 1000, 0.001, 1 / 20);
      last = now;

      // Stops gliding to new slots after setStops(). The tape moves with whatever is under the
      // needle, so that shift is not travel: it happens before travel is measured.
      if (reflowing) stepStops(dt);

      const before = tape.pos;
      if (tape.mode === 'film') stepFilm(dt);
      else if (tape.mode === 'spring') stepSpring(dt);
      const moved = tape.pos - before;
      if (tape.mode === 'film' || tape.mode === 'idle') tape.vel = moved / dt;

      // Content moving right is +px. The field is swept along with it.
      const px = -moved * tape.spacing;
      sweep(px);


      compact += (compactTo - compact) * (1 - Math.exp(-dt / 0.13));
      if (Math.abs(compactTo - compact) < 0.001) compact = compactTo;
      if (reveal < 1) reveal = Math.min(1, reveal + dt / 0.75);

      let lifting = false;
      for (const y of stops) {
        if (y.lift === y.liftTo) continue;
        y.lift += (y.liftTo - y.lift) * (1 - Math.exp(-dt / 0.09));
        if (Math.abs(y.liftTo - y.lift) < 0.004) y.lift = y.liftTo;
        else lifting = true;
      }

      if (!state.open && tape.mode !== 'film' && Math.abs(px / dt) < 700) updateFocus();

      // The loop is often awake only for the halo (a scroll re-aims it while the tape stands
      // still), and then the tape would be drawn exactly as it already is: skip the canvas and
      // the labels' style writes unless something they show has moved.
      const key = tapeKey();
      if (key !== paintedKey) {
        paintedKey = key;
        paint();
        placeLabels();
      }
      const haloMoving = stepHalo(dt);

      const still = tape.mode !== 'film' && tape.mode !== 'spring'
        && compact === compactTo && reveal >= 1 && !lifting && !flights && !haloMoving && !reflowing;
      return still;
    }

    function stepSpring(dt) {
      const a = SPRING_K * (tape.target - tape.pos) - SPRING_C * tape.vel;
      tape.vel += a * dt;
      tape.pos += tape.vel * dt;
      if (Math.abs(tape.target - tape.pos) < 0.0006 && Math.abs(tape.vel) < 0.01) {
        tape.pos = tape.target;
        tape.vel = 0;
        tape.mode = 'idle';
        if (!state.open) landed();
      }
    }

    function sweep(px) {
      if (reduceMotion || !px) return;
      const g = api();
      if (g && typeof g.sweepX === 'function') g.sweepX(px * (state.open ? 0.55 : 1));
    }

    // ---------------------------------------------------------------- painting
    const xAt = (t) => tape.width / 2 + (t - tape.pos) * tape.spacing;

    // Everything paint() and placeLabels() draw from. layout() repaints unconditionally (a resize
    // can change the canvas without changing any of these) and then records it.
    let paintedKey = '';
    function tapeKey() {
      let k = `${tape.pos}|${tape.width}|${tape.height}|${tape.spacing}|${tape.dpr}|${hairline}|${reveal}|${compact}|${extent}`;
      for (const y of stops) k += `|${y.lift}|${y.width}|${y.at}|${y.presence}`;
      return k;
    }

    // On arrival the tape draws itself outward from the needle.
    function appear(x) {
      if (reveal >= 1) return 1;
      const dn = Math.abs(x - tape.width / 2) / Math.max(1, tape.width / 2);
      return clamp01((reveal * 1.6 - dn) / 0.6);
    }

    function paint() {
      const W = tape.width;
      const H = tape.height;
      if (!W || !H) return;
      const d = tape.dpr;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const y0 = hairline;
      const s = tape.spacing;
      const span = W / 2 / s + 0.1;
      const tMin = tape.pos - span;
      const tMax = tape.pos + span;

      // The hairline, from the first slot's start to the last one's end. No ticks, no segments:
      // the line, the dots and the needle are the whole instrument.
      const xa = Math.max(0, xAt(0));
      const xb = Math.min(W, xAt(extent));
      if (xb > xa) {
        let a = xa;
        let b = xb;
        if (reveal < 1) {
          const half = reveal * 1.6 * (W / 2);
          a = Math.max(a, W / 2 - half);
          b = Math.min(b, W / 2 + half);
        }
        if (b > a) {
          ctx.strokeStyle = 'rgba(20, 20, 20, 0.26)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a, y0 + 0.5);
          ctx.lineTo(b, y0 + 0.5);
          ctx.stroke();
        }
      }

      // Past either end the line carries on a little and fades, so the tape never looks cut off.
      const trail = (x0, dir) => {
        const alpha = 0.26 * appear(x0);
        const x1 = x0 + dir * 0.9 * s;
        if (alpha < 0.005 || (dir < 0 ? x0 < 0 : x0 > W)) return;
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, `rgba(20, 20, 20, ${alpha.toFixed(3)})`);
        g.addColorStop(1, 'rgba(20, 20, 20, 0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, y0 + 0.5);
        ctx.lineTo(x1, y0 + 0.5);
        ctx.stroke();
      };
      trail(xAt(0), -1);
      trail(xAt(extent), 1);

      // One point per stop, under its label, the stops evenly spaced. A point swells and
      // catches the light as the needle reaches it.
      for (const y of stops) {
        const t = y.at;
        if (t < tMin || t > tMax) continue;
        const x = xAt(t);
        const near = Math.exp(-((((t - tape.pos) * s) / 18) ** 2));
        const a = (0.45 + 0.55 * near) * appear(x) * y.presence;
        if (a < 0.005) continue;
        if (near > 0.02) {
          const glow = ctx.createRadialGradient(x, y0, 0, x, y0, 14);
          glow.addColorStop(0, `rgba(255, 255, 255, ${(0.85 * near * y.presence).toFixed(3)})`);
          glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y0, 14, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = `rgba(20, 20, 20, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y0 + 0.5, 2.5 + 1.2 * near, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Labels sit over their stop's middle and swell as they pass under the needle. Off-screen
    // ones are hidden once they are clear of the edge (a wide label needs more room to clear).
    function placeLabels() {
      const s = tape.spacing;
      const W = tape.width;
      for (const y of stops) {
        const c = y.at;
        const x = W / 2 + (c - tape.pos) * s;
        const margin = Math.max(80, y.width / 2 + 8);
        if (x < -margin || x > W + margin) {
          if (y.shown) {
            y.el.style.opacity = '0';
            y.shown = false;
          }
          continue;
        }
        y.shown = true;
        const g = Math.exp(-(((c - tape.pos) / LENS) ** 2));
        const scale = (1 + 0.34 * g) * (1 - 0.12 * compact);
        const alpha = (0.4 + 0.6 * g) * appear(x) * y.lift * y.presence;
        y.el.style.transform = `translate3d(${(x - y.width / 2).toFixed(2)}px, ${(compact * DROP).toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
        y.el.style.opacity = alpha.toFixed(3);
      }
    }

    // ---------------------------------------------------------------- overview: focus, peek, hint
    function setRoving(y) {
      for (const s of story) s.el.tabIndex = s === y ? 0 : -1;
    }

    function updateFocus() {
      const f = nearestStory(tape.pos);
      if (f === focus) return;
      focus = f;
      setRoving(f);
      updatePeek();
    }

    let peekShown = null;
    let peekTimer = 0;
    function updatePeek(instant) {
      const y = focus;
      if (!y || (peekShown === y && !instant)) return;
      peekShown = y;
      const peek = peekOf(y);
      const text = peek.text;
      peekBtn.setAttribute('aria-label', peek.label);
      window.clearTimeout(peekTimer);
      if (instant || reduceMotion) {
        peekText.textContent = text;
        peekText.classList.remove('is-swapping');
        return;
      }
      peekText.classList.add('is-swapping');
      peekTimer = window.setTimeout(() => {
        peekText.textContent = text;
        peekText.classList.remove('is-swapping');
      }, 150);
    }

    const HINT_KEY = opts.hintKey || 'gridx-tape-hint';
    let hintDone = !hint;
    try { hintDone = hintDone || window.sessionStorage.getItem(HINT_KEY) === '1'; } catch (err) { /* storage blocked: show it */ }
    let hintTimer = 0;
    function showHint() {
      if (!hintDone && !state.open) hint.classList.add('is-shown');
    }
    function hideHint() {
      window.clearTimeout(hintTimer);
      if (hintDone) return;
      hintDone = true;
      hint.classList.remove('is-shown');
      try { window.sessionStorage.setItem(HINT_KEY, '1'); } catch (err) { /* fine */ }
    }

    // The tape has come to rest in the overview.
    function landed() {
      if (state.open) return;
      updateFocus();
      updatePeek();
      if (!hintDone) {
        window.clearTimeout(hintTimer);
        hintTimer = window.setTimeout(showHint, 380);
      }
      hook('onLanded', focus);
    }

    // ---------------------------------------------------------------- layout
    const cssPx = (name, fallback) => {
      const v = parseFloat(getComputedStyle(host).getPropertyValue(name));
      return Number.isFinite(v) ? v : fallback;
    };

    function layout() {
      placeHorizon(host);
      hairline = cssPx('--hairline', 56);
      const vw = window.innerWidth;
      tape.width = inner.clientWidth;
      tape.height = inner.clientHeight;
      if (opts.spacing) {
        for (const y of stops) y.width = y.el.offsetWidth;
        tape.spacing = opts.spacing(vw, { maxLabelWidth: Math.max(0, ...stops.map((y) => y.width)) });
      } else {
        tape.spacing = defaultSpacing(vw);
      }
      spacingTo = tape.spacing;
      tape.dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.round(tape.width * tape.dpr);
      const ch = Math.round(tape.height * tape.dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      for (const y of stops) y.width = y.el.offsetWidth;
      measureStick();
      updateStuck();
      paint();
      placeLabels();
      paintedKey = tapeKey();
      hook('onLayout');
      syncHalo();
      wake();
    }

    // ---------------------------------------------------------------- pinning
    let stickAt = Infinity;
    let stuck = false;

    // The scroll position at which the open tape reaches the top and pins there.
    function measureStick() {
      if (!state.open) return;
      const margin = parseFloat(getComputedStyle(bar).marginTop) || 0;
      stickAt = head.getBoundingClientRect().bottom + window.scrollY + margin - 0.5;
    }


    function updateStuck() {
      const s = !!state.open && window.scrollY >= stickAt;
      if (s === stuck) return;
      stuck = s;
      bar.classList.toggle('is-stuck', s);
    }

    let scrollQueued = false;
    window.addEventListener('scroll', () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        updateStuck();
        syncHalo();
      });
    }, { passive: true });

    // ---------------------------------------------------------------- the field
    // Where the brighter sparks gather. Usually the hairline: the halo of a rect two pixels tall
    // is, for all purposes, a line. The page can point it somewhere else for a while
    // (haloOverride: the journey's founders, while one is hovered, focused or pressed): the
    // light comes to them, and drifts apart again once that is over.
    //
    // The halo eases toward its aim in the main loop, the way store.js moves its rim between
    // cards, so the sparks travel instead of jumping. It is let go outright while the footer has
    // the room (the footer drives its own) or a photo is up.
    let haloAim = null;
    let haloSpec = null;

    function haloApi() {
      const g = api();
      return !reduceMotion && g && typeof g.setHalo === 'function' && typeof g.projection === 'function' ? g : null;
    }

    function aimHalo(g) {
      const depth = g.projection().depth;
      if (opts.haloOverride) {
        const spec = opts.haloOverride(depth);
        if (spec) return spec;
      }
      const y = inner.getBoundingClientRect().top + hairline;
      if (y < 0 || y > window.innerHeight) return null;
      return {
        left: 0, top: y - 1, width: window.innerWidth, height: 2, radius: 1, depth,
        fill: 0, grip: 0, weight: (state.open ? 0.3 : 0.5) * (g.quality || 1),
      };
    }

    function letGo(g) {
      haloAim = null;
      if (!haloSpec) return;
      g.setHalo(null);
      haloSpec = null;
    }

    // Something moved: re-aim, and let the loop carry the halo there.
    function syncHalo() {
      const g = haloApi();
      if (!g) return;
      if (handedOver()) {
        letGo(g);
        return;
      }
      haloAim = aimHalo(g);
      if (haloAim || haloSpec) wake();
    }

    // One step of the ease, from the main loop. True while the halo is still travelling.
    function stepHalo(dt) {
      const g = haloApi();
      if (!g || (!haloAim && !haloSpec)) return false;
      if (handedOver()) {
        letGo(g);
        return false;
      }
      if (flights) haloAim = aimHalo(g); // a FLIP is carrying the tape: follow it
      if (!haloSpec) haloSpec = { ...haloAim, weight: 0 }; // fade in where it is aimed
      const aim = haloAim || { ...haloSpec, weight: 0 };    // nothing to aim at: fade out in place
      const kp = 1 - Math.exp(-dt / 0.1);
      const kl = 1 - Math.exp(-dt / 0.16);
      let moving = false;
      for (const key of HALO_POS) {
        const d = aim[key] - haloSpec[key];
        if (Math.abs(d) > 0.5) {
          haloSpec[key] += d * kp;
          moving = true;
        } else {
          haloSpec[key] = aim[key];
        }
      }
      for (const key of HALO_LOOK) {
        const d = aim[key] - haloSpec[key];
        if (Math.abs(d) > 0.002) {
          haloSpec[key] += d * kl;
          moving = true;
        } else {
          haloSpec[key] = aim[key];
        }
      }
      if (!haloAim && haloSpec.weight < 0.004) {
        letGo(g);
        return false;
      }
      g.setHalo({
        rect: { left: haloSpec.left, top: haloSpec.top, width: haloSpec.width, height: haloSpec.height },
        radius: haloSpec.radius,
        depth: haloSpec.depth,
        fill: haloSpec.fill,
        grip: haloSpec.grip,
        weight: haloSpec.weight,
      });
      return moving;
    }
    // The footer flips is-night on <html>; hand the halo over and take it back. Read on the next
    // frame, not in the observer: a class has only just changed, so measuring the page there
    // forced a style and layout pass in the middle of whatever changed it (the nav folding away
    // on every change of scroll direction, among others).
    let haloQueued = false;
    new MutationObserver(() => {
      if (haloQueued) return;
      haloQueued = true;
      requestAnimationFrame(() => {
        haloQueued = false;
        syncHalo();
      });
    }).observe(root, { attributes: true, attributeFilter: ['class'] });

    // ---------------------------------------------------------------- the theme line
    // The subtitle under the title. Opening writes its text at once, because the open transition
    // measures the layout with it in place (written late, it used to shove the tape down
    // mid-flight); only its opacity animates. Between stops it dips out and back in at the same
    // height, so nothing below it moves.
    let themeTimer = 0;
    function setTheme(text, crossfade) {
      window.clearTimeout(themeTimer);
      if (!crossfade || reduceMotion || !theme.classList.contains('is-shown')) {
        theme.textContent = text;
        theme.classList.add('is-shown');
        return;
      }
      theme.classList.remove('is-shown');
      themeTimer = window.setTimeout(() => {
        if (!state.open) return;
        theme.textContent = text;
        theme.classList.add('is-shown');
      }, 260);
    }

    // Track FLIP animations, so the loop keeps the halo on the bar while it moves.
    function flight(anim) {
      flights++;
      wake();
      const done = () => { flights = Math.max(0, flights - 1); syncHalo(); };
      anim.finished.then(done, done);
      return anim;
    }

    // ---------------------------------------------------------------- panels and arrivals
    let io = null;
    let arrivalBase = 0;

    function stopArrivals() {
      if (io) io.disconnect();
      io = null;
    }

    function showPanel(info, firstDelay) {
      for (const y of story) {
        const on = y === info;
        if (y.panel) {
          y.panel.classList.toggle('is-active', on);
          y.panel.hidden = !on;
        }
        y.el.setAttribute('aria-selected', String(on));
      }
      hook('onShowPanel', info); // the panel has a layout now: the page can measure in it
      // Asked afresh: a page that changes its panels (setStops) may have added to this one.
      info.arrivals = arrivalsOf(info);
      arrive(info.arrivals, firstDelay);
    }

    // Whatever is on screen arrives in a short stagger; anything further down rises in as it is
    // reached.
    function arrive(list, firstDelay) {
      for (const el of list) {
        el.classList.remove('is-in', 'is-leaving');
        el.style.removeProperty('--delay');
        el.style.removeProperty('--leave-x');
      }
      stopArrivals();
      if (!('IntersectionObserver' in window)) {
        list.forEach((el) => el.classList.add('is-in'));
        return;
      }
      arrivalBase = firstDelay;
      io = new IntersectionObserver((entries) => {
        const incoming = entries.filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        incoming.forEach((e, k) => {
          e.target.style.setProperty('--delay', `${arrivalBase + k * 90}ms`);
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        });
        if (incoming.length) arrivalBase = 0;
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
      list.forEach((el) => io.observe(el));
    }

    // The tape collapsed: nothing is open, and whatever the page keeps below the overview
    // arrives.
    function hidePanels() {
      for (const y of story) {
        if (y.panel) {
          y.panel.classList.remove('is-active');
          y.panel.hidden = true;
        }
        y.el.setAttribute('aria-selected', 'false');
      }
      hook('onHidePanels');
      arrive(overview, 0);
    }

    function leave(info, dx) {
      stopArrivals();
      info.arrivals = arrivalsOf(info);
      for (const el of info.arrivals) {
        el.style.setProperty('--leave-x', `${dx}px`);
        el.classList.add('is-leaving');
      }
    }

    // Controls that vanish with a state change hand keyboard focus to the stop's tab.
    function keepFocus(info, before) {
      if (!before || before === document.body) return;
      const gone = before === peekBtn || before === closeBtn || !before.isConnected
        || !!before.closest(FOCUS_HIDDEN);
      if (gone) info.el.focus({ preventScroll: true });
    }

    // Retry once the current transition has finished. Only the latest request is kept.
    let queued = null;
    function whenFree(fn) {
      if (!state.busy) {
        fn();
        return;
      }
      const first = !queued;
      queued = fn;
      if (!first) return;
      const poll = () => {
        if (state.busy) {
          window.setTimeout(poll, 60);
          return;
        }
        const run = queued;
        queued = null;
        if (run) run();
      };
      window.setTimeout(poll, 60);
    }

    // ---------------------------------------------------------------- open, switch, close
    function writeHistory(info, how) {
      if (how === 'none') return;
      try {
        if (how === 'replace') {
          window.history.replaceState({ [HISTORY_KEY]: info.id }, '', hashOf(info));
        } else {
          window.history.pushState({ [HISTORY_KEY]: info.id }, '', hashOf(info));
          state.pushed = true;
        }
      } catch (err) { /* sandboxed: the page still works without it */ }
    }

    const opens = (info) => !!info && info.openable && !info.leaving;

    function open(id, how = {}) {
      const info = byId.get(id);
      if (!opens(info)) return false;
      if (state.busy) {
        whenFree(() => open(id, how));
        return true;
      }
      if (state.open === id) return true;
      if (state.open != null) return switchTo(id, how);

      const before = document.activeElement;
      hideHint();
      cancelFilm();
      state.busy = true;
      if (window.scrollY > 0) window.scrollTo(0, 0);

      // First: the label on the tape, and the tape on the horizon.
      const sources = flipPartsOf(info, info.el);
      const from = sources.map((el) => el.getBoundingClientRect());
      const barFrom = inner.getBoundingClientRect().top;

      setTitle(info);
      showPanel(info, reduceMotion ? 0 : 260);
      state.open = id;
      host.classList.add('is-open');
      setRoving(info);
      setTheme(info.theme);
      compactTo = 1;
      // The label has left the tape: it is the title now, and stays off the tape while its stop
      // is open. One title on screen, never two.
      info.lift = 0;
      info.liftTo = 0;
      placeLabels(); // this frame, not the next, so the two never show at once

      // Last: the same things in the open layout.
      const parts = titleParts();
      const to = parts.map((el) => el.getBoundingClientRect());
      const barTo = inner.getBoundingClientRect().top;
      measureStick();
      updateStuck();
      tape.target = info.at;
      tape.mode = 'spring';

      if (!reduceMotion && to.length && to[0].height > 0) {
        // Each part of the label flies into its part of the title.
        parts.forEach((el, i) => {
          const f = from[i];
          const t = to[i];
          if (!f || !(t.height > 0)) return;
          const s = f.height / t.height;
          const dx = f.left + f.width / 2 - (t.left + t.width / 2);
          const dy = f.top + f.height / 2 - (t.top + t.height / 2);
          flight(el.animate([
            { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})` },
            { transform: 'none' },
          ], { duration: FLIGHT, easing: FLIGHT_EASE }));
        });
        flight(inner.animate([
          { transform: `translate3d(0, ${barFrom - barTo}px, 0)` },
          { transform: 'none' },
        ], { duration: FLIGHT, easing: FLIGHT_EASE }));
      }

      window.setTimeout(() => { state.busy = false; }, reduceMotion ? 0 : FLIGHT - 220);

      writeHistory(info, how.history || 'push');
      keepFocus(info, before);
      wake();
      syncHalo();
      hook('onOpened', info);
      return true;
    }

    function switchTo(id, how = {}) {
      const info = byId.get(id);
      const prev = byId.get(state.open);
      if (!opens(info) || !prev) return false;
      if (info === prev) return true;
      if (state.busy) {
        whenFree(() => switchTo(id, how));
        return true;
      }
      const before = document.activeElement;
      state.busy = true;
      const dir = Math.sign(info.slot - prev.slot);
      leave(prev, -dir * 28);

      // The tape sets off at once, toward the new stop's dot. The stop being left goes back onto
      // the tape; the one arriving leaves it, since the title is about to roll over to it.
      state.open = id;
      setRoving(info);
      prev.liftTo = 1;
      info.liftTo = 0;
      tape.target = info.at;
      tape.mode = 'spring';
      wake();
      writeHistory(info, how.history || 'replace');

      window.setTimeout(() => {
        if (window.scrollY > 0) window.scrollTo(0, 0);
        showPanel(info, reduceMotion ? 0 : 80);
        rollTitle(info, dir);
        setTheme(info.theme, true);
        measureStick();
        updateStuck();
        state.busy = false;
        keepFocus(info, before);
        syncHalo();
        hook('onOpened', info);
      }, reduceMotion ? 0 : 240);
      return true;
    }

    function close() {
      const info = byId.get(state.open);
      if (!info) return;
      if (state.busy) {
        whenFree(close);
        return;
      }
      const before = document.activeElement;
      state.busy = true;
      leave(info, 0);

      const land = () => {
        if (window.scrollY > 0) window.scrollTo(0, 0);
        const parts = titleParts();
        const from = parts.map((el) => el.getBoundingClientRect());
        const barFrom = inner.getBoundingClientRect().top;

        titleEl.style.opacity = '1'; // stays lit for its flight home
        host.classList.remove('is-open');
        bar.classList.remove('is-stuck');
        stuck = false;
        theme.classList.remove('is-shown');
        hidePanels();
        state.open = null;
        compactTo = 0;
        info.lift = 0;
        info.liftTo = 0;
        focus = info;
        setRoving(info);
        updatePeek(true);
        // The tape heads for the stop's centre, where its label takes the title back.
        tape.target = info.at;
        tape.mode = 'spring';

        const ir = inner.getBoundingClientRect();
        const barTo = ir.top;
        const finish = () => {
          titleEl.style.opacity = '';
          info.lift = 1;
          info.liftTo = 1;
          placeLabels(); // the label takes over in the same frame the title goes
          wake();
        };
        if (!reduceMotion && from.length && from[0].height > 0) {
          // Where the label will be: centred under the needle at the lens's full swell.
          const sources = flipPartsOf(info, info.el);
          const backs = [];
          parts.forEach((el, i) => {
            const f = from[i];
            if (!(f.height > 0)) return;
            let rest;
            if (title.rest) {
              rest = title.rest(info, i, { ir, width: tape.width });
            } else {
              const h = (sources[i] || sources[0]).offsetHeight * 1.34;
              const cx = ir.left + tape.width / 2;
              const cy = ir.top + info.el.offsetHeight / 2;
              rest = { cx, cy, h };
            }
            const s = rest.h / f.height;
            const dx = rest.cx - (f.left + f.width / 2);
            const dy = rest.cy - (f.top + f.height / 2);
            backs.push(flight(el.animate([
              { transform: 'none' },
              { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})` },
            ], { duration: 860, easing: FLIGHT_EASE, fill: 'forwards' })));
          });
          // They all take the same time: the last one home hands the title back.
          const back = backs[backs.length - 1];
          if (back) {
            back.finished.then(() => {
              finish();
              backs.forEach((b) => b.cancel());
            }, finish);
          } else {
            finish();
          }
          flight(inner.animate([
            { transform: `translate3d(0, ${barFrom - barTo}px, 0)` },
            { transform: 'none' },
          ], { duration: 860, easing: FLIGHT_EASE }));
        } else {
          finish();
        }

        window.setTimeout(() => { state.busy = false; }, reduceMotion ? 0 : 740);
        keepFocus(info, before);
        wake();
        syncHalo();
        hook('onClosed', info);
      };
      if (reduceMotion) land();
      else window.setTimeout(land, 200);
    }

    // Closing goes back through history when we put the entry there, so the browser's back
    // button and the close button always agree.
    function requestClose() {
      if (state.open == null) return;
      if (state.pushed && window.history.state && window.history.state[HISTORY_KEY] != null) {
        window.history.back(); // popstate closes it
        return;
      }
      try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (err) { /* fine */ }
      close();
    }

    // The stop the URL names, if any.
    const hashStop = () => {
      let id = null;
      try { id = parseHash(window.location.hash); } catch (err) { /* a malformed hash names nothing */ }
      return id == null ? null : byId.get(id) || null;
    };

    window.addEventListener('popstate', () => {
      const info = hashStop();
      if (opens(info)) {
        state.pushed = !!(window.history.state && window.history.state[HISTORY_KEY] != null);
        if (state.open == null) open(info.id, { history: 'none' });
        else if (info.id !== state.open) switchTo(info.id, { history: 'none' });
      } else if (state.open != null) {
        state.pushed = false;
        close();
      }
    });

    // ---------------------------------------------------------------- input: taps
    let swallowClick = false;

    labels.addEventListener('click', (e) => {
      const el = e.target.closest(LABEL_SELECTOR);
      if (!el || swallowClick) return;
      const info = byEl.get(el);
      if (!info || info.leaving) return;
      hideHint();
      if (state.open == null) open(info.id);
      else if (info.id !== state.open) switchTo(info.id);
      else window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });

    peekBtn.addEventListener('click', () => {
      if (focus) open(focus.id);
    });
    closeBtn.addEventListener('click', requestClose);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open != null && !escapeBlocked()) {
        e.preventDefault();
        requestClose();
      }
    });

    // Arrow keys move along the tablist. In the overview they only centre a stop (Enter opens
    // it); with a stop open they switch, so the panel always matches the selected tab.
    labels.addEventListener('keydown', (e) => {
      const el = e.target.closest(LABEL_SELECTOR);
      if (!el) return;
      const i = story.indexOf(byEl.get(el));
      let to = null;
      if (e.key === 'ArrowRight') to = story[Math.min(story.length - 1, i + 1)];
      else if (e.key === 'ArrowLeft') to = story[Math.max(0, i - 1)];
      else if (e.key === 'Home') to = story[0];
      else if (e.key === 'End') to = story[story.length - 1];
      if (!to) return;
      e.preventDefault();
      hideHint();
      setRoving(to);
      to.el.focus({ preventScroll: true });
      if (state.open != null) {
        switchTo(to.id);
      } else {
        cancelFilm();
        tape.target = to.at;
        tape.mode = 'spring';
        wake();
      }
    });

    // ---------------------------------------------------------------- the shine
    // A soft light runs along the hairline only when a mouse moves over the tape, travelling the
    // way the pointer moves. One sweep at a time: keep moving and the next follows the last, so
    // it reads as a calm rhythm, never a strobe. Touch and reduced motion never see it.
    const glint = bar.querySelector('.tl-bar__glint');
    let sweeping = false;
    let lastPointerX = null;
    if (glint && !reduceMotion) {
      inner.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
        const dx = lastPointerX === null ? 0 : e.clientX - lastPointerX;
        lastPointerX = e.clientX;
        if (sweeping || Math.abs(dx) < 1) return;
        sweeping = true;
        glint.classList.add(dx > 0 ? 'is-sweeping-right' : 'is-sweeping-left');
      });
      inner.addEventListener('pointerleave', () => { lastPointerX = null; });
      glint.addEventListener('animationend', () => {
        glint.classList.remove('is-sweeping-right', 'is-sweeping-left');
        sweeping = false;
      });
    }

    // ---------------------------------------------------------------- input: dragging the tape
    let drag = null;

    inner.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('.tl-close')) return;
      swallowClick = false;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pos: tape.pos, on: false, samples: [] };
      // A finger on the tape mid-film stops it where it is, ready to be dragged.
      if (film && cancelFilm()) {
        tape.mode = 'drag';
        tape.vel = 0;
      }
    });

    inner.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.on) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          drag = null; // a vertical swipe: the page's, not ours
          if (tape.mode === 'drag') fling(0);
          return;
        }
        if (Math.abs(dx) < 6) return;
        drag.on = true;
        drag.x = e.clientX;
        drag.pos = tape.pos;
        try { inner.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
        cancelFilm();
        hideHint();
        tape.mode = 'drag';
        host.classList.add('is-dragging');
      }
      tape.pos = rubber(drag.pos - (e.clientX - drag.x) / tape.spacing);
      const t = e.timeStamp;
      drag.samples.push([t, tape.pos]);
      while (drag.samples.length > 2 && t - drag.samples[0][0] > 90) drag.samples.shift();
      wake();
    });

    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.on) {
        if (tape.mode === 'drag') fling(0);
        return;
      }
      swallowClick = true;
      window.setTimeout(() => { swallowClick = false; }, 0);
      host.classList.remove('is-dragging');
      let v = 0;
      const s = d.samples;
      if (e.type !== 'pointercancel' && s.length > 1) {
        const [t0, p0] = s[0];
        const [t1, p1] = s[s.length - 1];
        if (t1 > t0) v = (p1 - p0) / ((t1 - t0) / 1000);
      }
      fling(v);
    }
    inner.addEventListener('pointerup', endDrag);
    inner.addEventListener('pointercancel', endDrag);

    // Release: carry the momentum a little way, then settle on the nearest stop that opens.
    function fling(v) {
      v = clamp(v, -14, 14);
      tape.vel = v;
      const target = nearestStory(tape.pos + v * PROJECT);
      if (state.open != null && target.id !== state.open && switchTo(target.id)) return;
      tape.target = (state.open != null ? byId.get(state.open) : target).at;
      tape.mode = 'spring';
      wake();
    }

    // Trackpads and shift-wheel scrub the tape sideways; plain vertical wheel still scrolls.
    //
    // Which of the two a gesture is gets decided once, from its first few pixels, and held until
    // its events stop. A trackpad reports every swipe with a pixel or two of drift on the other
    // axis, and its momentum tail fades to vertical deltas of 0 and 1 where that drift wins, so
    // judged event by event a page scroll that passed over the tape (the pinned tape sits right
    // under a resting pointer) twitched it sideways and stalled the page at random moments. The
    // gesture is followed on the window, not just the tape, because the tape usually slides in
    // under the pointer mid-scroll, when only that drifting tail is left to judge by.
    const wheelGesture = { axis: null, sumX: 0, sumY: 0, endTimer: 0 };
    const AXIS_AFTER = 6;    // px of travel before a gesture's direction is decided
    const GESTURE_GAP = 180; // ms without a wheel event that ends a gesture
    const wheelDelta = (e) => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerWidth : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; } // a mouse wheel turned sideways
      return [dx, dy];
    };
    window.addEventListener('wheel', (e) => {
      const g = wheelGesture;
      window.clearTimeout(g.endTimer);
      g.endTimer = window.setTimeout(() => { g.axis = null; g.sumX = 0; g.sumY = 0; }, GESTURE_GAP);
      if (g.axis) return;
      const [dx, dy] = wheelDelta(e);
      g.sumX += Math.abs(dx);
      g.sumY += Math.abs(dy);
      if (g.sumX + g.sumY >= AXIS_AFTER) g.axis = g.sumX > g.sumY ? 'x' : 'y';
    }, { passive: true, capture: true });

    let wheelTimer = 0;
    inner.addEventListener('wheel', (e) => {
      if (wheelGesture.axis !== 'x') return; // the page's scroll, or not yet decided
      e.preventDefault(); // a sideways swipe is the tape's alone: the page must not creep
      const [dx] = wheelDelta(e);
      if (!dx) return;
      cancelFilm();
      hideHint();
      tape.mode = 'drag';
      tape.pos = rubber(tape.pos + dx / tape.spacing);
      wake();
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => fling(0), 140);
    }, { passive: false });

    // Wheel or keys anywhere during the film let it go to the nearest stop.
    window.addEventListener('wheel', (e) => { if (film && !inner.contains(e.target)) interruptFilm(); }, { passive: true });
    window.addEventListener('keydown', () => { if (film) interruptFilm(); });

    // ---------------------------------------------------------------- changing the stops
    // setStops() takes the whole list again, in order. Stops that stay keep their labels and
    // glide to their new slots; new ones fade in at theirs; ones that are gone fade out where
    // they stand and are then removed. Whatever is under the needle stays under it while the
    // rest move round it, and the labels' order in the tablist follows the slots. A change that
    // arrives mid-transition, mid-drag or mid-film waits for it to finish. The journey never
    // calls this: its stops are fixed, and everything below is idle for it.
    let pendingStops = null;
    let stopsTimer = 0;
    let reflowing = false;
    let extentTo = extent;
    let anchor = null;   // the stop under the needle, which the tape moves with
    let settleOn = null; // the stop the tape springs to when the one under the needle went

    function setStops(list) {
      pendingStops = Array.isArray(list) ? list.slice() : [];
      window.clearTimeout(stopsTimer);
      applyStops();
    }

    function applyStops() {
      if (!pendingStops) return;
      if (state.busy || drag || film || tape.mode === 'drag') {
        stopsTimer = window.setTimeout(applyStops, 60);
        return;
      }
      const list = pendingStops;
      const ids = new Set(list.map((spec) => spec.id));
      // The open stop is going: close it first, then come back.
      if (state.open != null && !ids.has(state.open)) {
        try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (err) { /* fine */ }
        state.pushed = false;
        close();
        stopsTimer = window.setTimeout(applyStops, 60);
        return;
      }
      pendingStops = null;

      // What is under the needle now.
      let near = null;
      let best = Infinity;
      for (const y of stops) {
        if (y.leaving) continue;
        const d = Math.abs(y.at - tape.pos);
        if (d < best) {
          best = d;
          near = y;
        }
      }
      const held = state.open != null ? byId.get(state.open) : near;

      const next = list.map((spec, slot) => {
        let y = byId.get(spec.id);
        if (!y) {
          y = makeStop(spec, slot);
          y.presence = 0;
          labels.append(y.el);
          y.width = y.el.offsetWidth;
        } else {
          y.slot = slot;
          y.atTo = slot + 0.5;
          y.leaving = false;
          y.el.inert = false;
          y.el.removeAttribute('aria-hidden');
          if (spec.panel !== undefined) y.panel = spec.panel || null;
          y.openable = spec.openable === undefined ? !!y.panel : !!spec.openable;
          y.theme = spec.theme || '';
          y.peek = spec.peek || '';
          y.data = spec.data;
          // Its name or its mark may have changed: drawn again from the new data. The button
          // itself stays, so keyboard focus on it does too.
          y.el.textContent = '';
          renderLabel(y, y.el);
          const controls = controlsOf(y);
          if (controls) y.el.setAttribute('aria-controls', controls);
          else y.el.removeAttribute('aria-controls');
        }
        y.presenceTo = 1;
        y.arrivals = arrivalsOf(y);
        return y;
      });
      const kept = new Set(next);
      const going = stops.filter((y) => !kept.has(y));
      for (const y of going) {
        y.leaving = true;
        y.presenceTo = 0;
        y.atTo = y.at;
        y.el.tabIndex = -1;
        y.el.inert = true;
        y.el.setAttribute('aria-hidden', 'true');
      }
      stops = next.concat(going);
      byId = new Map(stops.map((y) => [y.id, y]));
      story = next.filter((y) => y.openable);
      extentTo = next.length;

      // The tablist reads in slot order. Moved without losing keyboard focus.
      const active = document.activeElement;
      stops.forEach((y, i) => {
        const at = labels.children[i] || null;
        if (at === y.el) return;
        if (typeof labels.moveBefore === 'function' && y.el.isConnected) labels.moveBefore(y.el, at);
        else labels.insertBefore(y.el, at);
      });
      if (active && active !== document.activeElement && active.isConnected && !active.inert) active.focus({ preventScroll: true });

      // The labels may be wider or narrower now: the spacing eases to suit them.
      for (const y of next) y.width = y.el.offsetWidth;
      if (opts.spacing) {
        spacingTo = opts.spacing(window.innerWidth, { maxLabelWidth: Math.max(0, ...next.map((y) => y.width)) });
      }

      anchor = held && !held.leaving ? held : null;
      settleOn = null;
      if (!anchor && story.length) {
        // What was under the needle is going: settle on the nearest stop that stays.
        let d = Infinity;
        for (const y of story) {
          const dd = Math.abs(y.atTo - tape.pos);
          if (dd < d) {
            d = dd;
            settleOn = y;
          }
        }
        tape.mode = 'spring';
      }
      if (state.open == null && (!focus || focus.leaving || !focus.openable)) {
        focus = settleOn || anchor || story[0] || null;
        updatePeek(true);
      } else if (state.open == null && focus) {
        updatePeek(true); // its text may have changed
      }
      setRoving(state.open != null ? byId.get(state.open) : focus);
      reflowing = true;
      wake();
    }

    // One step of the reflow, from the main loop.
    function stepStops(dt) {
      const k = 1 - Math.exp(-dt / REFLOW);
      const was = anchor ? anchor.at : 0;
      let moving = false;
      for (const y of stops) {
        if (y.at !== y.atTo) {
          y.at += (y.atTo - y.at) * k;
          if (Math.abs(y.atTo - y.at) < 0.0005) y.at = y.atTo;
          else moving = true;
        }
        if (y.presence !== y.presenceTo) {
          y.presence += (y.presenceTo - y.presence) * k;
          if (Math.abs(y.presenceTo - y.presence) < 0.004) y.presence = y.presenceTo;
          else moving = true;
        }
      }
      if (extent !== extentTo) {
        extent += (extentTo - extent) * k;
        if (Math.abs(extentTo - extent) < 0.0005) extent = extentTo;
        else moving = true;
      }
      if (tape.spacing !== spacingTo) {
        tape.spacing += (spacingTo - tape.spacing) * k;
        if (Math.abs(spacingTo - tape.spacing) < 0.05) tape.spacing = spacingTo;
        else moving = true;
      }
      if (anchor) {
        const d = anchor.at - was;
        tape.pos += d;
        tape.target += d;
      } else if (settleOn) {
        tape.target = settleOn.at;
      }
      // Gone: off the tape for good.
      const gone = stops.filter((y) => y.leaving && y.presence === 0);
      if (gone.length) {
        for (const y of gone) {
          y.el.remove();
          byEl.delete(y.el);
          if (byId.get(y.id) === y) byId.delete(y.id);
        }
        stops = stops.filter((y) => !gone.includes(y));
      }
      if (!moving) {
        reflowing = false;
        anchor = null;
        settleOn = null;
      }
    }

    function focusOn(id) {
      const info = byId.get(id);
      if (!opens(info) || state.open != null) return false;
      cancelFilm();
      setRoving(info);
      tape.target = info.at;
      tape.mode = 'spring';
      wake();
      return true;
    }

    // ---------------------------------------------------------------- start
    hidePanels();
    try {
      if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    } catch (err) { /* fine */ }

    setTitle(stops[stops.length - 1]);
    setRoving(focus);
    updatePeek(true);
    // Before layout(): its measuring resolves styles, and a peek still visible at that moment
    // would fade out on screen instead of never appearing.
    host.classList.add('is-filming');
    layout();
    host.classList.add('is-ready');

    // Pay the glass band's one-off setup cost now, in the film's still beat (see tape.css).
    if (!reduceMotion && root.classList.contains('gl')) {
      host.classList.add('is-warming');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.setTimeout(() => host.classList.remove('is-warming'), 200);
      }));
    }

    let resizeQueued = false;
    let lastSize = `${window.innerWidth}x${window.innerHeight}`;
    window.addEventListener('resize', () => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        const size = `${window.innerWidth}x${window.innerHeight}`;
        if (size === lastSize) return;
        lastSize = size;
        layout();
      });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

    // Arrival: the tape runs from the first stop to the one the page names, and it opens. A
    // link to a stop runs to that stop instead and opens it.
    const deep = hashStop();
    const target = opens(deep) ? deep : null;
    if (window.location.hash && !target) {
      try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (err) { /* fine */ }
    }
    const pick = opts.arrival ? opts.arrival(target) : { id: (target || story[story.length - 1]).id, open: true };
    const arrival = byId.get(pick.id) || target || story[story.length - 1];
    startFilm(arrival.id, pick.open === false ? null : () => open(arrival.id, { history: target ? 'replace' : 'none' }));
    hook('onStart');

    return {
      open: (id, how) => open(id, how),
      switchTo: (id, how) => switchTo(id, how),
      close,
      requestClose,
      focusOn,
      setStops,
      arrive: (list, delayMs = 0) => arrive([...list], delayMs),
      layout,
      wake,
      syncHalo,
      state: {
        get open() { return state.open; },
        get busy() { return state.busy; },
        get focus() { return focus ? focus.id : null; },
      },
      stopOf: (id) => byId.get(id) || null,
    };
  }

  window.GridTape = { create, placeHorizon };
})();
