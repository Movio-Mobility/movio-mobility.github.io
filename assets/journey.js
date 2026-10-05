/*
 * Journey: the timeline tape.
 *
 * A line of years runs across the studio's horizon. A needle stays fixed at the centre of the
 * screen and the tape travels beneath it: one point per year, evenly spaced, each with its
 * label above it.
 *
 *   The film       On arrival the tape runs from the first year to the reader's current year,
 *                  with a beat of anticipation, a smooth start and a long settle, and the
 *                  current year opens. Any touch, wheel or key takes over on the way.
 *   The tape       Drag it, fling it, wheel it sideways or arrow through it. It snaps to the
 *                  nearest year.
 *   A year         Tapping one lifts its label off the tape and grows it into the title (FLIP),
 *                  compacts the tape and pins it under the top bar, and the chapters rise in.
 *   Switching      The title's digits roll like an odometer while the tape glides over.
 *
 * The field reacts through two hooks on window.gridBG, both feature-detected: sweepX() streams
 * the particles along with the tape's travel, and setHalo() lets a few of the brighter sparks
 * drift along the hairline, or gather round a founder you hover. When the footer is in play
 * the halo is its, not ours.
 *
 * The canvas paints ticks, hairline and dots, and only while something moves. Labels are real
 * buttons (a tablist over the year panels) placed with transforms. One rAF loop does all of
 * it and sleeps whenever the tape and every tween are at rest.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const journey = document.querySelector('.journey');
  if (!journey) return;
  // The page arrives mid-film: say so before anything below reads a computed style.
  journey.classList.add('is-filming');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const head = journey.querySelector('.tl-head');
  const title = journey.querySelector('.tl-title');
  const digits = journey.querySelector('.tl-title__digits');
  const theme = journey.querySelector('.tl-theme');
  const bar = journey.querySelector('.tl-bar');
  const inner = bar.querySelector('.tl-bar__inner');
  const canvas = bar.querySelector('.tl-bar__ticks');
  const ctx = canvas.getContext('2d');
  const labels = bar.querySelector('.tl-bar__labels');
  const closeBtn = bar.querySelector('.tl-close');
  const peekBtn = journey.querySelector('.tl-peek__open');
  const peekText = journey.querySelector('.tl-peek__text');
  const hint = journey.querySelector('.tl-hint');

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clamp01 = (v) => clamp(v, 0, 1);
  const smoothstep = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // The site's damped spring (site.css), so the title lands the way the island settles.
  const SPRING = getComputedStyle(root).getPropertyValue('--spring').trim() || 'cubic-bezier(0.32, 0.72, 0, 1)';

  // ---------------------------------------------------------------- the years
  // Every year with a story is an ordinary panel. The tape runs from the first of them to the
  // reader's current year, one stop each, and the current year always ends with who we are,
  // the founders and our backers: the yearless .tl-today block, moved in here. If the current
  // year already has chapters of its own, it opens with "This year in review" over its photos.
  //
  // So it all moves on by itself. Next January the year just gone becomes an ordinary year
  // with a "Continue to" at its end, and the new one starts as an empty panel holding the three
  // parts, until its first chapters are written.
  const panelsEl = journey.querySelector('.tl-panels');
  const todayBlock = journey.querySelector('.tl-today');
  const panels = [...journey.querySelectorAll('.tl-panel[data-year]')];
  const NOW = Math.max(new Date().getFullYear(), ...panels.map((p) => Number(p.dataset.year)));

  let current = panels.find((p) => Number(p.dataset.year) === NOW);
  if (!current) {
    current = document.createElement('section');
    current.className = 'tl-panel';
    current.id = String(NOW);
    current.dataset.year = String(NOW);
    current.setAttribute('role', 'tabpanel');
    current.setAttribute('aria-labelledby', `tab-${NOW}`);
    const heading = document.createElement('h2');
    heading.className = 'tl-panel__year';
    heading.innerHTML = `<span>${NOW}</span> <span class="tl-panel__theme"></span>`;
    current.append(heading);
    panelsEl.insertBefore(current, todayBlock || null);
    panels.push(current);
  }
  panels.sort((a, b) => Number(a.dataset.year) - Number(b.dataset.year));

  // This year's own chapters, then the review over their photos, then the three parts.
  const ownTitles = [...current.querySelectorAll('.chapter__title')].map((t) => t.textContent.trim());
  const reviewPhotos = [...current.querySelectorAll('.frame img')];
  if (reviewPhotos.length) {
    // The year's own chapters fold away under the review until it is opened.
    const heading = current.querySelector('.tl-panel__year');
    const review = buildReview(reviewPhotos, NOW);
    const fold = document.createElement('div');
    fold.className = 'review-fold';
    fold.id = `year-${NOW}-stories`;
    const foldInner = document.createElement('div');
    foldInner.className = 'review-fold__inner';
    for (const chapter of current.querySelectorAll(':scope > .chapter')) foldInner.append(chapter);
    fold.append(foldInner);
    current.insertBefore(review, heading ? heading.nextSibling : current.firstChild);
    review.after(fold);
    wireReview(review, fold);
  }
  if (todayBlock) {
    const heading = todayBlock.querySelector('.tl-today__heading');
    if (heading) heading.remove();
    while (todayBlock.firstChild) current.append(todayBlock.firstChild);
    todayBlock.remove();
  }
  current.dataset.theme = 'Today';
  const currentTheme = current.querySelector('.tl-panel__theme');
  if (currentTheme) currentTheme.textContent = 'Today';
  current.dataset.peek = [...ownTitles, 'Who we are', 'Founders', 'Backers'].join(' · ');

  // Every year but the current one ends with the way on to the next.
  panels.forEach((panel, i) => {
    const next = panels[i + 1];
    let link = panel.querySelector(':scope > .tl-next');
    if (!next) {
      if (link) link.remove();
      return;
    }
    if (!link) {
      link = document.createElement('a');
      link.className = 'tl-next';
      link.innerHTML = '<span class="tl-next__kicker">Continue to</span> <span class="tl-next__year"></span> <span class="tl-next__title"></span>';
      panel.append(link);
    }
    const year = next.dataset.year;
    const first = next.querySelector('.chapter__title');
    link.href = `#${year}`;
    link.dataset.year = year;
    link.querySelector('.tl-next__year').textContent = year;
    link.querySelector('.tl-next__title').textContent = next === current && reviewPhotos.length
      ? 'This year in review'
      : (first ? first.textContent.trim() : '');
  });

  // One label, a tab, per story year, in order.
  for (const y of panels.map((p) => Number(p.dataset.year))) {
    const el = document.createElement('button');
    el.className = 'tl-year';
    el.type = 'button';
    el.id = `tab-${y}`;
    el.tabIndex = -1;
    el.dataset.year = String(y);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-controls', String(y));
    el.setAttribute('aria-selected', 'false');
    const text = document.createElement('span');
    text.textContent = String(y);
    el.append(text);
    labels.append(el);
  }

  // Each year owns one slot on the tape, slot i spanning i to i + 1. Positions along the tape
  // (tape.pos and everything measured against it) are in slots, not calendar years.
  const years = [...labels.querySelectorAll('.tl-year')].map((el, slot) => {
    const year = Number(el.dataset.year);
    const panel = document.getElementById(String(year));
    const chapters = panel ? [...panel.querySelectorAll('.chapter')] : [];
    return {
      year,
      slot,
      el,
      panel,
      chapters,
      text: el.firstElementChild,
      arrivals: panel ? [...panel.querySelectorAll('.review, .chapter, .tl-next, .tl-end')] : [],
      theme: panel ? panel.dataset.theme || '' : '',
      peek: panel ? panel.dataset.peek || '' : '',
      width: 0,
      shown: true,
      lift: 1,   // the label's own visibility: 0 while its year is out flying as the title
      liftTo: 1,
    };
  });
  if (!years.length) return;
  const byYear = new Map(years.map((y) => [y.year, y]));
  const story = years.filter((y) => y.panel);
  const FIRST = years[0].year;
  const LAST = years[years.length - 1].year;
  const SLOTS = years.length;

  // ---------------------------------------------------------------- tuning
  const LENS = 0.6;        // width of the swell around the needle, in slots
  const PROJECT = 0.32;    // seconds of momentum a fling carries before it picks a year
  const SPRING_K = 90;     // tape spring: ω ≈ 9.5 rad/s ...
  const SPRING_C = 17;     // ... just under critical, so a fling lands with the faintest give
  const HOLD = 0.35;       // the film: a still beat first,
  const WIND = 0.18;       // then a short draw back the other way before it sets off
  const FLIGHT = 940;      // ms for the label to become the title
  // The flights lift off gently, travel, then take a long soft landing. The site's spring is
  // right for a capsule morphing in place, but it spends most of a big move in its first
  // quarter, which reads as a jump when a label grows five times over.
  const FLIGHT_EASE = 'cubic-bezier(0.45, 0, 0.12, 1)';

  const tape = { pos: 0.5, vel: 0, target: 0.5, mode: 'idle', spacing: 112, width: 0, height: 0, dpr: 1 };
  const state = { open: null, busy: false, pushed: false };
  let hairline = 56;
  let compact = 0;         // 0 on the horizon, 1 pinned under the top bar
  let compactTo = 0;
  let reveal = reduceMotion ? 1 : 0; // the tape drawing itself out from the needle on arrival
  let film = null;
  let focus = byYear.get(FIRST); // the story year nearest the needle in the overview
  let flights = 0;         // FLIP animations in progress (the halo follows the bar during them)

  const api = () => window.gridBG;

  function nearestStory(p) {
    let best = story[0];
    let dist = Infinity;
    for (const y of story) {
      const d = Math.abs(y.slot + 0.5 - p);
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
    const hi = SLOTS - 0.5;
    if (p < lo) return lo - (lo - p) * 0.35;
    if (p > hi) return hi + (p - hi) * 0.35;
    return p;
  }

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

  // The film's end. When it has somewhere to go next (opening the year it landed on), that
  // goes first, so the overview's peek and hint never get a frame in between.
  function filmLanded(then) {
    if (then) then();
    else landed();
    journey.classList.remove('is-filming');
  }

  function startFilm(toYear, then) {
    const to = byYear.get(toYear).slot + 0.5;
    const from = tape.pos;
    journey.classList.add('is-filming'); // the peek stays out of the way while the tape travels
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
    journey.classList.remove('is-filming');
    return true;
  }

  // Something other than a drag cut the film short: carry its momentum into the nearest year.
  function interruptFilm() {
    if (!cancelFilm()) return;
    tape.target = nearestStory(tape.pos + tape.vel * PROJECT).slot + 0.5;
    tape.mode = 'spring';
    wake();
  }

  // ---------------------------------------------------------------- the loop
  let raf = 0;
  let last = 0;
  let inFrame = false; // wake() from inside a frame (a film landing opens a year) must not
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
    for (const y of years) {
      if (y.lift === y.liftTo) continue;
      y.lift += (y.liftTo - y.lift) * (1 - Math.exp(-dt / 0.09));
      if (Math.abs(y.liftTo - y.lift) < 0.004) y.lift = y.liftTo;
      else lifting = true;
    }

    if (!state.open && tape.mode !== 'film' && Math.abs(px / dt) < 700) updateFocus();

    paint();
    placeLabels();
    const haloMoving = stepHalo(dt);

    const still = tape.mode !== 'film' && tape.mode !== 'spring'
      && compact === compactTo && reveal >= 1 && !lifting && !flights && !haloMoving;
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
    // the line, the chapter dots and the needle are the whole instrument.
    const xa = Math.max(0, xAt(0));
    const xb = Math.min(W, xAt(SLOTS));
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
    trail(xAt(SLOTS), 1);

    // One point per year, under its label, the years evenly spaced. A point swells and
    // catches the light as the needle reaches it.
    for (const y of years) {
      const t = y.slot + 0.5;
      if (t < tMin || t > tMax) continue;
      const x = xAt(t);
      const near = Math.exp(-((((t - tape.pos) * s) / 18) ** 2));
      const a = (0.45 + 0.55 * near) * appear(x);
      if (a < 0.005) continue;
      if (near > 0.02) {
        const glow = ctx.createRadialGradient(x, y0, 0, x, y0, 14);
        glow.addColorStop(0, `rgba(255, 255, 255, ${(0.85 * near).toFixed(3)})`);
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

  // Labels sit over their year's middle and swell as they pass under the needle.
  function placeLabels() {
    const s = tape.spacing;
    const W = tape.width;
    for (const y of years) {
      const c = y.slot + 0.5;
      const x = W / 2 + (c - tape.pos) * s;
      if (x < -80 || x > W + 80) {
        if (y.shown) {
          y.el.style.opacity = '0';
          y.shown = false;
        }
        continue;
      }
      y.shown = true;
      const g = Math.exp(-(((c - tape.pos) / LENS) ** 2));
      const scale = (1 + 0.34 * g) * (1 - 0.12 * compact);
      const alpha = (0.4 + 0.6 * g) * appear(x) * y.lift;
      y.el.style.transform = `translate3d(${(x - y.width / 2).toFixed(2)}px, ${(compact * 5).toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
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
    const text = y.year === LAST ? `Today · ${y.peek}` : y.peek;
    peekBtn.setAttribute('aria-label', `Open ${y.year}: ${y.peek}`);
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

  const HINT_KEY = 'gridx-journey-hint';
  let hintDone = false;
  try { hintDone = window.sessionStorage.getItem(HINT_KEY) === '1'; } catch (err) { /* storage blocked: show it */ }
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
  }

  // ---------------------------------------------------------------- layout
  const cssPx = (name, fallback) => {
    const v = parseFloat(getComputedStyle(journey).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };

  // The tape lies on the cyclorama's bright horizon band. These are STUDIO_FS's numbers in
  // grid-bg.js: the horizon is mix(-0.12, -0.17, portrait) screen-min-dimensions above the
  // centre, and the band peaks 0.045 below it. #bg is fixed at the top, so its height (100lvh)
  // is the right one to measure from even while a phone's URL bar is showing.
  function placeHorizon() {
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
    journey.style.setProperty('--horizon-y', `${y.toFixed(1)}px`);
  }

  function layout() {
    placeHorizon();
    hairline = cssPx('--hairline', 56);
    const vw = window.innerWidth;
    tape.width = inner.clientWidth;
    tape.height = inner.clientHeight;
    tape.spacing = vw < 760 ? 112 : clamp(vw * 0.15, 150, 220);
    tape.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(tape.width * tape.dpr);
    const ch = Math.round(tape.height * tape.dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    for (const y of years) y.width = y.el.offsetWidth;
    measureStick();
    updateStuck();
    paint();
    placeLabels();
    updateStrips();
    layoutReview();
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
  // is, for all purposes, a line. While a founder is hovered, focused or pressed, their card:
  // the light comes to the person, and drifts apart again once you move on.
  //
  // The halo eases toward its aim in the main loop, the way store.js moves its rim between
  // cards, so the sparks travel instead of jumping. It is let go outright while the footer has
  // the room (the footer drives its own) or a photo is up.
  let hoverCard = null;
  let haloAim = null;
  let haloSpec = null;
  const HALO_POS = ['left', 'top', 'width', 'height', 'radius'];
  const HALO_LOOK = ['depth', 'fill', 'grip', 'weight'];

  function haloApi() {
    const g = api();
    return !reduceMotion && g && typeof g.setHalo === 'function' && typeof g.projection === 'function' ? g : null;
  }
  const handedOver = () => root.classList.contains('is-night') || root.classList.contains('lightbox-open');

  function aimHalo(g) {
    const depth = g.projection().depth;
    if (hoverCard) {
      const r = hoverCard.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight) {
        // A firm grip draws in most of the drifting field and tightens the rim into a clean
        // band of light. No fill: the photo is opaque, so sparks behind it would be wasted.
        // The ring sits a little outside the card, in the gap the other founders leave.
        return { left: r.left - 11, top: r.top - 11, width: r.width + 22, height: r.height + 22, radius: 26, depth, fill: 0, grip: 0.8, weight: 1 };
      }
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
  // The footer flips is-night on <html>; hand the halo over and take it back.
  new MutationObserver(syncHalo).observe(root, { attributes: true, attributeFilter: ['class'] });

  // ---------------------------------------------------------------- the title
  function face(ch) {
    const span = document.createElement('span');
    span.textContent = ch;
    return span;
  }

  function setTitle(year) {
    digits.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    digits.textContent = '';
    for (const ch of String(year)) {
      const cell = document.createElement('span');
      cell.className = 'tl-digit';
      cell.append(face(ch));
      digits.append(cell);
    }
    digits.dataset.year = String(year);
  }

  // An odometer: only the digits that change roll, rightmost first, up when going forward in
  // time and down when going back.
  function rollTitle(year, dir) {
    const from = digits.dataset.year || '';
    const to = String(year);
    if (reduceMotion || from.length !== to.length) {
      setTitle(year);
      if (!reduceMotion) digits.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease' });
      return;
    }
    const cells = [...digits.children];
    let k = 0;
    for (let i = to.length - 1; i >= 0; i--) {
      const cell = cells[i];
      cell.getAnimations({ subtree: true }).forEach((a) => a.cancel());
      while (cell.children.length > 1) cell.firstElementChild.remove();
      const old = cell.lastElementChild;
      if (old.textContent === to[i]) continue;
      const next = face(to[i]);
      cell.append(next);
      const opts = { duration: 680, delay: k++ * 60, easing: SPRING, fill: 'both' };
      old.animate([
        { transform: 'translate3d(0, 0, 0)', opacity: 1 },
        { transform: `translate3d(0, ${-dir * 105}%, 0)`, opacity: 0 },
      ], opts).onfinish = () => old.remove();
      const arrive = next.animate([
        { transform: `translate3d(0, ${dir * 105}%, 0)`, opacity: 0 },
        { transform: 'translate3d(0, 0, 0)', opacity: 1 },
      ], opts);
      arrive.onfinish = () => arrive.cancel(); // its end state is the resting state
    }
    digits.dataset.year = to;
  }

  // The subtitle under the year. Opening writes its text at once, because the open transition
  // measures the layout with it in place (written late, it used to shove the tape down
  // mid-flight); only its opacity animates. Between years it dips out and back in at the same
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
      y.panel.classList.toggle('is-active', on);
      y.panel.hidden = !on;
      y.el.setAttribute('aria-selected', String(on));
    }
    for (const el of info.arrivals) {
      el.classList.remove('is-in', 'is-leaving');
      el.style.removeProperty('--delay');
      el.style.removeProperty('--leave-x');
    }
    updateStrips(); // the panel has a layout now, so its strips know whether they scroll
    if (info.panel === current) layoutReview();
    stopArrivals();
    if (!('IntersectionObserver' in window)) {
      info.arrivals.forEach((el) => el.classList.add('is-in'));
      return;
    }
    // Whatever is on screen when the year opens arrives in a short stagger; anything further
    // down rises in as it is reached.
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
    info.arrivals.forEach((el) => io.observe(el));
  }

  function hidePanels() {
    stopArrivals();
    for (const y of story) {
      y.panel.classList.remove('is-active');
      y.panel.hidden = true;
      y.el.setAttribute('aria-selected', 'false');
    }
  }

  function leave(info, dx) {
    stopArrivals();
    for (const el of info.arrivals) {
      el.style.setProperty('--leave-x', `${dx}px`);
      el.classList.add('is-leaving');
    }
  }

  // Controls that vanish with a state change hand keyboard focus to the year's tab.
  function keepFocus(info, before) {
    if (!before || before === document.body) return;
    const gone = before === peekBtn || before === closeBtn || !before.isConnected
      || !!before.closest('.tl-panel[hidden]');
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
  function writeHistory(year, how) {
    if (how === 'none') return;
    try {
      if (how === 'replace') {
        window.history.replaceState({ journey: year }, '', `#${year}`);
      } else {
        window.history.pushState({ journey: year }, '', `#${year}`);
        state.pushed = true;
      }
    } catch (err) { /* sandboxed: the page still works without it */ }
  }

  function open(year, how = {}) {
    const info = byYear.get(year);
    if (!info || !info.panel) return false;
    if (state.busy) {
      whenFree(() => open(year, how));
      return true;
    }
    if (state.open === year) return true;
    if (state.open) return switchTo(year, how);

    const before = document.activeElement;
    hideHint();
    cancelFilm();
    state.busy = true;
    if (window.scrollY > 0) window.scrollTo(0, 0);

    // First: the label on the tape, and the tape on the horizon.
    const from = info.text.getBoundingClientRect();
    const barFrom = inner.getBoundingClientRect().top;

    setTitle(year);
    showPanel(info, reduceMotion ? 0 : 260);
    state.open = year;
    journey.classList.add('is-open');
    setRoving(info);
    setTheme(info.theme);
    compactTo = 1;
    // The label has left the tape: it is the title now, and stays off the tape while its year
    // is open. One year on screen, never two.
    info.lift = 0;
    info.liftTo = 0;
    placeLabels(); // this frame, not the next, so the two never show at once

    // Last: the same things in the open layout.
    const to = digits.getBoundingClientRect();
    const barTo = inner.getBoundingClientRect().top;
    measureStick();
    updateStuck();
    tape.target = info.slot + 0.5;
    tape.mode = 'spring';

    if (!reduceMotion && to.height > 0) {
      const s = from.height / to.height;
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      flight(digits.animate([
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})` },
        { transform: 'none' },
      ], { duration: FLIGHT, easing: FLIGHT_EASE }));
      flight(inner.animate([
        { transform: `translate3d(0, ${barFrom - barTo}px, 0)` },
        { transform: 'none' },
      ], { duration: FLIGHT, easing: FLIGHT_EASE }));
    }

    window.setTimeout(() => { state.busy = false; }, reduceMotion ? 0 : FLIGHT - 220);

    writeHistory(year, how.history || 'push');
    keepFocus(info, before);
    wake();
    syncHalo();
    return true;
  }

  function switchTo(year, how = {}) {
    const info = byYear.get(year);
    const prev = byYear.get(state.open);
    if (!info || !info.panel || !prev) return false;
    if (info === prev) return true;
    if (state.busy) {
      whenFree(() => switchTo(year, how));
      return true;
    }
    const before = document.activeElement;
    state.busy = true;
    const dir = Math.sign(year - prev.year);
    leave(prev, -dir * 28);

    // The tape sets off at once, toward the new year's first dot. The year being left goes back
    // onto the tape; the one arriving leaves it, since the title is about to roll over to it.
    state.open = year;
    setRoving(info);
    prev.liftTo = 1;
    info.liftTo = 0;
    tape.target = info.slot + 0.5;
    tape.mode = 'spring';
    wake();
    writeHistory(year, how.history || 'replace');

    window.setTimeout(() => {
      if (window.scrollY > 0) window.scrollTo(0, 0);
      showPanel(info, reduceMotion ? 0 : 80);
      rollTitle(year, dir);
      setTheme(info.theme, true);
      measureStick();
      updateStuck();
      state.busy = false;
      keepFocus(info, before);
      syncHalo();
    }, reduceMotion ? 0 : 240);
    return true;
  }

  function close() {
    const info = byYear.get(state.open);
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
      const from = digits.getBoundingClientRect();
      const barFrom = inner.getBoundingClientRect().top;

      title.style.opacity = '1'; // stays lit for its flight home
      journey.classList.remove('is-open');
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
      // The tape heads for the year's centre, where its label takes the title back.
      tape.target = info.slot + 0.5;
      tape.mode = 'spring';

      const ir = inner.getBoundingClientRect();
      const barTo = ir.top;
      const finish = () => {
        title.style.opacity = '';
        info.lift = 1;
        info.liftTo = 1;
        placeLabels(); // the label takes over in the same frame the title goes
        wake();
      };
      if (!reduceMotion && from.height > 0) {
        // Where the label will be: centred under the needle at the lens's full swell.
        const h = info.text.offsetHeight * 1.34;
        const cx = ir.left + tape.width / 2;
        const cy = ir.top + info.el.offsetHeight / 2;
        const s = h / from.height;
        const dx = cx - (from.left + from.width / 2);
        const dy = cy - (from.top + from.height / 2);
        const back = flight(digits.animate([
          { transform: 'none' },
          { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})` },
        ], { duration: 860, easing: FLIGHT_EASE, fill: 'forwards' }));
        back.finished.then(() => {
          finish();
          back.cancel();
        }, finish);
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
    };
    if (reduceMotion) land();
    else window.setTimeout(land, 200);
  }

  // Closing goes back through history when we put the entry there, so the browser's back
  // button and the close button always agree.
  function requestClose() {
    if (!state.open) return;
    if (state.pushed && window.history.state && window.history.state.journey) {
      window.history.back(); // popstate closes it
      return;
    }
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (err) { /* fine */ }
    close();
  }

  const hashYear = () => {
    const m = /^#(\d{4})$/.exec(window.location.hash);
    return m ? Number(m[1]) : null;
  };

  window.addEventListener('popstate', () => {
    const y = hashYear();
    const info = y && byYear.get(y);
    if (info && info.panel) {
      state.pushed = !!(window.history.state && window.history.state.journey);
      if (!state.open) open(y, { history: 'none' });
      else if (y !== state.open) switchTo(y, { history: 'none' });
    } else if (state.open) {
      state.pushed = false;
      close();
    }
  });

  // ---------------------------------------------------------------- input: taps
  let swallowClick = false;

  labels.addEventListener('click', (e) => {
    const el = e.target.closest('button.tl-year');
    if (!el || swallowClick) return;
    const y = Number(el.dataset.year);
    hideHint();
    if (!state.open) open(y);
    else if (y !== state.open) switchTo(y);
    else window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  });

  peekBtn.addEventListener('click', () => {
    if (focus) open(focus.year);
  });
  closeBtn.addEventListener('click', requestClose);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open && !lightboxOpen) {
      e.preventDefault();
      requestClose();
    }
  });

  // Arrow keys move along the tablist. In the overview they only centre a year (Enter opens
  // it); with a year open they switch, so the panel always matches the selected tab.
  labels.addEventListener('keydown', (e) => {
    const el = e.target.closest('button.tl-year');
    if (!el) return;
    const i = story.indexOf(byYear.get(Number(el.dataset.year)));
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
    if (state.open) {
      switchTo(to.year);
    } else {
      cancelFilm();
      tape.target = to.slot + 0.5;
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
      journey.classList.add('is-dragging');
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
    journey.classList.remove('is-dragging');
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

  // Release: carry the momentum a little way, then settle on the nearest year with a story.
  function fling(v) {
    v = clamp(v, -14, 14);
    tape.vel = v;
    const target = nearestStory(tape.pos + v * PROJECT);
    if (state.open && target.year !== state.open && switchTo(target.year)) return;
    tape.target = (state.open ? byYear.get(state.open) : target).slot + 0.5;
    tape.mode = 'spring';
    wake();
  }

  // Trackpads and shift-wheel scrub the tape sideways; plain vertical wheel still scrolls.
  let wheelTimer = 0;
  inner.addEventListener('wheel', (e) => {
    let dx = e.deltaX;
    if (e.shiftKey && !dx) dx = e.deltaY;
    if (!dx || (Math.abs(dx) <= Math.abs(e.deltaY) && !e.shiftKey)) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerWidth : 1;
    cancelFilm();
    hideHint();
    tape.mode = 'drag';
    tape.pos = rubber(tape.pos + (dx * unit) / tape.spacing);
    wake();
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => fling(0), 140);
  }, { passive: false });

  // Wheel or keys anywhere during the film let it go to the nearest year.
  window.addEventListener('wheel', (e) => { if (film && !inner.contains(e.target)) interruptFilm(); }, { passive: true });
  window.addEventListener('keydown', () => { if (film) interruptFilm(); });

  // ---------------------------------------------------------------- this year in review
  // The current year opens with its photos as one rectangle of randomly sized tiles, drifting
  // sideways for ever under the words "This year in review". Built fresh on every visit.
  //
  // Each page is the rectangle's width and is cut by guillotine splits (always split the largest
  // tile, across its longer side, somewhere between 38% and 62%), so the tiles vary in size but
  // always fill the rectangle exactly. Photos go to the tiles whose shape suits them best. The
  // pages are laid out twice in a row, and the track slides left by exactly one copy before it
  // starts over, so the loop never shows a seam.
  function buildReview(imgs, year) {
    const review = document.createElement('div');
    review.className = 'review';
    const win = document.createElement('div');
    win.className = 'review__window';
    win.setAttribute('aria-hidden', 'true'); // the same photos follow, with their captions
    const track = document.createElement('div');
    track.className = 'review__track';
    win.append(track);
    const title = document.createElement('div');
    title.className = 'review__title';
    title.innerHTML = `<p class="review__kicker">${year}</p>`
      + '<h3 class="review__heading"><span>This year</span> <span>in review</span></h3>'
      + '<p class="review__cta"><span class="review__cta-text">See it unfold</span>'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></p>';
    // The whole rectangle is the button: it opens the year's stories beneath it.
    const toggle = document.createElement('button');
    toggle.className = 'review__toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', `Show ${year}'s stories`);
    review.append(win, title, toggle);
    review.photos = imgs.map((img) => ({
      src: img.getAttribute('src'),
      aspect: (Number(img.getAttribute('width')) || 4) / (Number(img.getAttribute('height')) || 3),
    }));
    return review;
  }

  // Opening unfolds the stories (a grid row easing from 0fr to 1fr, so it slides to their real
  // height) and they rise in as they come into view. Clipped while it moves, so nothing spills;
  // let go once it has settled, so the photo strips can run edge to edge again.
  function wireReview(review, fold) {
    const toggle = review.querySelector('.review__toggle');
    const text = review.querySelector('.review__cta-text');
    const year = current.dataset.year;
    toggle.setAttribute('aria-controls', fold.id);
    let settle = 0;
    toggle.addEventListener('click', () => {
      const open = !review.classList.contains('is-open');
      window.clearTimeout(settle);
      review.classList.toggle('is-open', open);
      fold.classList.toggle('is-open', open);
      fold.classList.remove('is-settled');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} ${year}'s stories`);
      text.textContent = open ? 'Fold it away' : 'See it unfold';
      if (open) {
        settle = window.setTimeout(() => {
          fold.classList.add('is-settled');
          updateStrips();
        }, reduceMotion ? 0 : 760);
      }
    });
  }

  function partition(count, aspect) {
    const tiles = [{ x: 0, y: 0, w: 1, h: 1 }];
    while (tiles.length < count) {
      let k = 0;
      for (let i = 1; i < tiles.length; i++) if (tiles[i].w * tiles[i].h > tiles[k].w * tiles[k].h) k = i;
      const t = tiles.splice(k, 1)[0];
      const at = 0.38 + Math.random() * 0.24;
      if (t.w * aspect >= t.h) {
        tiles.push({ x: t.x, y: t.y, w: t.w * at, h: t.h }, { x: t.x + t.w * at, y: t.y, w: t.w * (1 - at), h: t.h });
      } else {
        tiles.push({ x: t.x, y: t.y, w: t.w, h: t.h * at }, { x: t.x, y: t.y + t.h * at, w: t.w, h: t.h * (1 - at) });
      }
    }
    return tiles;
  }

  let reviewAspect = 0;
  function layoutReview() {
    const review = current.querySelector('.review');
    if (!review) return;
    const win = review.querySelector('.review__window');
    const W = win.clientWidth;
    const H = win.clientHeight;
    if (!W || !H) return; // its year is not on screen yet: done when it opens
    review.style.setProperty('--page-w', `${W}px`);
    const aspect = W / H;
    if (reviewAspect && Math.abs(aspect / reviewAspect - 1) < 0.25) return;
    reviewAspect = aspect;

    const photos = review.photos.slice();
    for (let i = photos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [photos[i], photos[j]] = [photos[j], photos[i]];
    }
    const pageCount = Math.max(1, Math.round(photos.length / 5));
    const pages = [];
    for (let p = 0; p < pageCount; p++) {
      const share = photos.slice(Math.floor((p * photos.length) / pageCount), Math.floor(((p + 1) * photos.length) / pageCount));
      const tiles = partition(share.length, aspect);
      // Widest photos to the widest tiles, tallest to the tallest.
      const byShape = (list, f) => list.slice().sort((a, b) => f(a) - f(b));
      const tilesSorted = byShape(tiles, (t) => (t.w * aspect) / t.h);
      const photosSorted = byShape(share, (ph) => ph.aspect);
      const page = document.createElement('div');
      page.className = 'review__page';
      tilesSorted.forEach((t, i) => {
        const tile = document.createElement('div');
        tile.className = 'review__tile';
        tile.style.cssText = `left:${(t.x * 100).toFixed(3)}%;top:${(t.y * 100).toFixed(3)}%;width:${(t.w * 100).toFixed(3)}%;height:${(t.h * 100).toFixed(3)}%`;
        const img = document.createElement('img');
        img.src = photosSorted[i].src;
        img.alt = '';
        img.decoding = 'async';
        tile.append(img);
        page.append(tile);
      });
      pages.push(page);
    }
    const track = review.querySelector('.review__track');
    track.textContent = '';
    for (const page of pages) track.append(page);
    for (const page of pages) track.append(page.cloneNode(true));
    review.style.setProperty('--review-dur', `${pages.length * 28}s`);

    // Drift only while it can be seen.
    if (!review.watched && 'IntersectionObserver' in window) {
      review.watched = true;
      new IntersectionObserver(([entry]) => {
        review.classList.toggle('is-paused', !entry.isIntersecting);
      }).observe(review);
    }
  }

  // ---------------------------------------------------------------- photos
  let swallowStripClick = false;

  for (const strip of journey.querySelectorAll('.strip')) {
    // A mouse can drag a strip the way a finger swipes it.
    let s = null;
    strip.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      s = { id: e.pointerId, x: e.clientX, left: strip.scrollLeft, moved: false };
    });
    strip.addEventListener('pointermove', (e) => {
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x;
      if (!s.moved && Math.abs(dx) > 5) {
        s.moved = true;
        strip.classList.add('is-grabbing');
        try { strip.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      }
      if (s.moved) strip.scrollLeft = s.left - dx;
    });
    const end = () => {
      if (!s) return;
      if (s.moved) {
        swallowStripClick = true;
        window.setTimeout(() => { swallowStripClick = false; }, 0);
        strip.classList.remove('is-grabbing'); // snapping comes back on and settles the strip
      }
      s = null;
    };
    strip.addEventListener('pointerup', end);
    strip.addEventListener('pointercancel', end);
    strip.addEventListener('dragstart', (e) => e.preventDefault());
  }

  // Arrows either side of each strip, for anyone who would rather click than swipe. Each one
  // steps exactly one photo, to the next snap position, and hides at its end of the strip.
  const stripUpdaters = [];
  function updateStrips() {
    for (const update of stripUpdaters) update();
  }

  function stepStrip(strip, dir) {
    const sr = strip.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(strip).scrollPaddingLeft) || 0;
    const offsets = [...strip.querySelectorAll('.frame')].map((f) => f.getBoundingClientRect().left - sr.left - pad);
    let by = null;
    if (dir > 0) by = offsets.find((o) => o > 4);
    else for (const o of offsets) if (o < -4) by = o;
    if (by != null) strip.scrollBy({ left: by, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  journey.querySelectorAll('.chapter__media').forEach((media, i) => {
    const strip = media.querySelector('.strip');
    if (!strip) return;
    if (!strip.id) strip.id = `photos-${i + 1}`;
    const make = (dir) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `strip-arrow strip-arrow--${dir < 0 ? 'prev' : 'next'}`;
      b.disabled = true;
      b.setAttribute('aria-label', dir < 0 ? 'Previous photo' : 'Next photo');
      b.setAttribute('aria-controls', strip.id);
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${dir < 0 ? 'm14 7-5 5 5 5' : 'm10 7 5 5-5 5'}"/></svg>`;
      b.addEventListener('click', () => stepStrip(strip, dir));
      media.append(b);
      return b;
    };
    const prev = make(-1);
    const next = make(1);
    const show = (b, other, on) => {
      if (b.disabled === !on) return;
      // An arrow that hides under keyboard focus hands it to the other one.
      if (!on && document.activeElement === b && !other.disabled) other.focus({ preventScroll: true });
      b.disabled = !on;
      b.classList.toggle('is-shown', on);
    };
    const update = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      show(prev, next, max > 4 && strip.scrollLeft > 4);
      show(next, prev, max > 4 && strip.scrollLeft < max - 4);
    };
    let queued = false;
    strip.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    }, { passive: true });
    stripUpdaters.push(update);
  });

  // Photos and portraits fade in as they arrive instead of painting in strips.
  for (const img of journey.querySelectorAll('.frame img, .founder img, .person img')) {
    const done = () => img.classList.add('is-loaded');
    if (img.complete && img.naturalWidth) done();
    else {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }
  }

  journey.addEventListener('click', (e) => {
    const next = e.target.closest('.tl-next');
    if (next) {
      e.preventDefault();
      switchTo(Number(next.dataset.year));
      return;
    }
    // Back to the beginning: the tape glides back across every year and the story starts over.
    if (e.target.closest('[data-rewind]')) {
      e.preventDefault();
      if (state.open) switchTo(FIRST);
      else open(FIRST);
      return;
    }
    const frame = e.target.closest('.frame');
    if (frame) {
      if (swallowStripClick || openLightbox(frame)) e.preventDefault();
    }
  });

  // ---------------------------------------------------------------- founders
  // Hovering a founder, or focusing one from the keyboard, brings the light to them; moving on
  // lets it drift apart. A finger gets the same while it is down and a beat after, so the
  // gather is seen before LinkedIn opens in its new tab.
  let letGoTimer = 0;
  function setHover(card) {
    window.clearTimeout(letGoTimer);
    if (hoverCard === card) return;
    hoverCard = card;
    syncHalo();
  }
  for (const card of journey.querySelectorAll('.founder')) {
    card.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') setHover(card); });
    card.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && hoverCard === card) setHover(null);
    });
    card.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') setHover(card); });
    const lift = (e) => {
      if (e.pointerType !== 'touch' || hoverCard !== card) return;
      window.clearTimeout(letGoTimer);
      letGoTimer = window.setTimeout(() => {
        if (hoverCard === card) setHover(null);
      }, e.type === 'pointercancel' ? 0 : 900); // a cancel is the page scrolling: let go now
    };
    card.addEventListener('pointerup', lift);
    card.addEventListener('pointercancel', lift);
    card.addEventListener('focus', () => { if (card.matches(':focus-visible')) setHover(card); });
    card.addEventListener('blur', () => { if (hoverCard === card) setHover(null); });
  }

  // ---------------------------------------------------------------- lightbox
  const lb = document.querySelector('.lightbox');
  const lbImg = lb && lb.querySelector('.lightbox__img');
  const lbCap = lb && lb.querySelector('.lightbox__caption');
  const lbPrev = lb && lb.querySelector('.lightbox__prev');
  const lbNext = lb && lb.querySelector('.lightbox__next');
  let lightboxOpen = false;
  let lbFrames = [];
  let lbIndex = 0;
  let lbSwallow = false;

  function showPhoto(i, dir) {
    const frame = lbFrames[i];
    const thumb = frame.querySelector('img');
    lbIndex = i;
    lbImg.src = thumb.currentSrc || thumb.src; // already loaded: shows at once
    lbImg.alt = thumb.alt;
    lbCap.textContent = thumb.alt;
    lbPrev.disabled = i === 0;
    lbNext.disabled = i === lbFrames.length - 1;
    const full = frame.getAttribute('href');
    if (full && full !== lbImg.getAttribute('src')) {
      const big = new Image();
      big.src = full;
      (big.decode ? big.decode() : Promise.resolve())
        .then(() => { if (lightboxOpen && lbIndex === i) lbImg.src = full; })
        .catch(() => { /* keep the smaller one */ });
    }
    if (dir && !reduceMotion) {
      lbImg.animate([
        { opacity: 0, transform: `translate3d(${dir * 36}px, 0, 0)` },
        { opacity: 1, transform: 'none' },
      ], { duration: 360, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    }
  }

  // The photo grows out of its frame in the strip: scaled to cover the frame's box and clipped
  // to it, so the start of the move is exactly what was on screen.
  function zoom(frame, out) {
    const a = frame.getBoundingClientRect();
    const b = lbImg.getBoundingClientRect();
    if (!a.width || !b.width || !b.height) return null;
    const k = Math.max(a.width / b.width, a.height / b.height);
    const ix = Math.max(0, (b.width - a.width / k) / 2);
    const iy = Math.max(0, (b.height - a.height / k) / 2);
    const dx = a.left + a.width / 2 - (b.left + b.width / 2);
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    const inFrame = { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${k})`, clipPath: `inset(${iy}px ${ix}px round ${14 / k}px)` };
    const atRest = { transform: 'none', clipPath: 'inset(0px 0px round 14px)' };
    return lbImg.animate(out ? [atRest, inFrame] : [inFrame, atRest], {
      duration: out ? 420 : 560,
      easing: out ? 'cubic-bezier(0.3, 0, 0.2, 1)' : SPRING,
      fill: out ? 'forwards' : 'none',
    });
  }

  function openLightbox(frame) {
    if (!lb || typeof lb.showModal !== 'function' || lightboxOpen) return false;
    lbFrames = [...frame.closest('.strip').querySelectorAll('.frame')];
    showPhoto(lbFrames.indexOf(frame), 0);
    lb.showModal();
    lightboxOpen = true;
    root.classList.add('lightbox-open');
    requestAnimationFrame(() => lb.classList.add('is-open'));
    if (!reduceMotion) zoom(frame, false);
    return true;
  }

  function closeLightbox() {
    if (!lightboxOpen) return;
    const frame = lbFrames[lbIndex];
    const strip = frame.parentElement;
    // Bring the strip round to the photo you ended on, so it lands back where it belongs.
    const fr = frame.getBoundingClientRect();
    const sr = strip.getBoundingClientRect();
    if (fr.left < sr.left || fr.right > sr.right) {
      strip.scrollLeft += fr.left - sr.left - (parseFloat(getComputedStyle(strip).paddingLeft) || 0);
    }
    lb.classList.remove('is-open');
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      lb.close();
      lightboxOpen = false;
      root.classList.remove('lightbox-open');
      lbImg.getAnimations().forEach((a) => a.cancel());
      lbImg.removeAttribute('src');
    };
    const r = frame.getBoundingClientRect();
    const onScreen = r.bottom > 0 && r.top < window.innerHeight;
    const anim = !reduceMotion && onScreen ? zoom(frame, true) : null;
    if (anim) anim.finished.then(done, done);
    else done();
  }

  if (lb) {
    lb.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeLightbox();
    });
    lb.addEventListener('click', (e) => {
      if (lbSwallow) return;
      if (e.target.closest('.lightbox__prev')) showStep(-1);
      else if (e.target.closest('.lightbox__next')) showStep(1);
      else if (!e.target.closest('.lightbox__img')) closeLightbox();
    });
    lb.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        showStep(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        showStep(1);
      }
    });
    // Swipe sideways for the next photo, down to put it away.
    let sw = null;
    lb.addEventListener('pointerdown', (e) => { sw = { x: e.clientX, y: e.clientY }; });
    lb.addEventListener('pointerup', (e) => {
      if (!sw) return;
      const dx = e.clientX - sw.x;
      const dy = e.clientY - sw.y;
      sw = null;
      let handled = false;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        showStep(dx < 0 ? 1 : -1);
        handled = true;
      } else if (dy > 90 && dy > Math.abs(dx)) {
        closeLightbox();
        handled = true;
      }
      if (handled) {
        lbSwallow = true;
        window.setTimeout(() => { lbSwallow = false; }, 0);
      }
    });
  }

  function showStep(d) {
    const i = lbIndex + d;
    if (i < 0 || i >= lbFrames.length) return;
    showPhoto(i, d);
  }

  // ---------------------------------------------------------------- start
  for (const y of story) y.panel.hidden = true;
  try {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  } catch (err) { /* fine */ }

  setTitle(LAST);
  setRoving(focus);
  updatePeek(true);
  // Before layout(): its measuring resolves styles, and a peek still visible at that moment
  // would fade out on screen instead of never appearing.
  journey.classList.add('is-filming');
  layout();
  journey.classList.add('is-ready');

  // Pay the glass band's one-off setup cost now, in the film's still beat (see journey.css).
  if (!reduceMotion && root.classList.contains('gl')) {
    journey.classList.add('is-warming');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.setTimeout(() => journey.classList.remove('is-warming'), 200);
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

  // Arrival: the tape runs from the first year to today and today opens. A link to a year
  // runs to that year instead and opens it.
  const deep = byYear.get(hashYear());
  const target = deep && deep.panel ? deep : null;
  if (window.location.hash && !target) {
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (err) { /* fine */ }
  }
  const arrival = target || byYear.get(NOW) || story[story.length - 1];
  startFilm(arrival.year, () => open(arrival.year, { history: target ? 'replace' : 'none' }));
})();
