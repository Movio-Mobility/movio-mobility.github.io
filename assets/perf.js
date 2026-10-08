/*
 * GridX performance governor
 * --------------------------
 * One place that decides how hard the page's canvases work, so the particle field and the
 * PowerPod never disagree and never fight each other for the GPU. Loaded first on every page
 * (the build inlines it).
 *
 * The rule it enforces: what is on screen stays the same. A device that cannot keep up gives
 * up the things nobody can see first, and only then things that are hard to see:
 *   1. on a 90/120/144 Hz screen, render at 60 instead of at the screen's rate
 *   2. draw the 3D pod a little below its full pixel density (only while it is up; see
 *      podRatios for what full is)
 *   3. a steady 30 fps for both canvases together, rather than an uneven 40 to 50
 *   4. an emergency only: the field's own particle shedding (grid-bg.js setQuality)
 * It steps down after two struggling seconds and back up, slowly, after a long run of easy
 * ones, backing off further each time a step up does not hold. A step that makes no
 * difference is taken back and that step left alone for a minute: a device held up by its
 * processor rather than its GPU gains nothing from fewer particles or a softer pod, so it
 * does not give them up.
 *
 * Every animation loop asks frame(now) once per rAF. Callbacks in one frame share a
 * timestamp, so they all get the same answer and the two canvases always move together.
 * Loops that are skipped keep their last frame on screen, and their time steps simply cover
 * the frames they did not draw.
 *
 * Health is judged against the display's own refresh (learned from the rAF clock), so a
 * phone in Low Power Mode, which runs everything at 30, is not mistaken for a slow GPU.
 *
 * ?perf shows the overlay; ?perf&level=N pins a step (0 = everything at full) for screening.
 */
(() => {
  'use strict';
  if (window.GridPerf) return;

  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 0; // Chromium only; 0 = unknown

  // ---------------------------------------------------------------- tier hint
  // Only ever picks where the ladder starts. Particle budgets are set by the engine's own
  // deviceTier(), because they define how the field looks.
  const WEAK_GPU = /mali-(4\d\d|t\d+|g(31|51|52|57|68|71|72|76)\b)|adreno[^0-9]*(3\d\d|4\d\d|5\d\d|60\d|61\d)\b|powervr|sgx|intel\(r\) (hd|uhd) graphics|intel (hd|uhd) graphics|swiftshader|llvmpipe|software/i;
  const STRONG_GPU = /apple m\d|nvidia|geforce|quadro|rtx|radeon (rx|pro)|adreno[^0-9]*(7\d\d|8\d\d)\b|mali-g7\d\d|immortalis|iris\(r\) xe|iris xe|intel\(r\) arc|intel arc/i;
  let gpu = '';
  let tier = (memory && memory <= 2) || (coarse && cores <= 4) ? 'low' : 'mid';

  function classify(gl) {
    if (gpu || !gl) return tier;
    try {
      gpu = String(gl.getParameter(gl.RENDERER) || '');
      if (!gpu || /^webkit webgl$/i.test(gpu)) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || gpu);
      }
    } catch {
      // some browsers refuse the query: keep the hint from cores and memory
    }
    if (STRONG_GPU.test(gpu)) tier = 'high';
    else if (WEAK_GPU.test(gpu)) tier = 'low';
    // Unknown and weak GPUs start at the 60 fps ceiling; it only matters on a fast screen.
    if (!pinned) capHz = tier === 'high' ? Infinity : 60;
    root.dataset.perf = tier;
    notify();
    return tier;
  }

  // ---------------------------------------------------------------- the knobs
  let capHz = Infinity;   // rendering ceiling: Infinity, 60 or 30
  let podLevel = 0;       // 0 = pod at full density; up to podLevels
  let podLevels = 0;      // how many lower densities the pod offers on this device
  let shed = 0;           // emergency particle shedding steps
  const MAX_SHED = 4;     // 0.85^4 ≈ 0.52, held at the engine's 0.6 floor

  const listeners = [];
  function notify() {
    for (const fn of listeners) {
      try { fn(api); } catch (err) { console.warn('[GridPerf] listener failed', err); }
    }
  }

  // ?perf&level=N pins the ladder (for screening each step on a fast machine).
  let pinned = false;
  if (params.has('level')) {
    pinned = true;
    const n = Math.max(0, parseInt(params.get('level'), 10) || 0);
    capHz = n >= 1 ? 60 : Infinity;
    podLevel = Math.min(2, Math.max(0, n - 1));
    if (n >= 4) capHz = 30;
    shed = Math.max(0, n - 4);
  }

  // ---------------------------------------------------------------- frame clock
  const REFRESH_STEPS = [1000 / 144, 1000 / 120, 1000 / 90, 1000 / 75, 1000 / 60, 1000 / 50, 1000 / 30];
  let vsync = 1000 / 60;  // learned display interval, ms
  let lastStamp = -1;
  let lastDecision = true;
  let lastTick = 0;       // previous rAF timestamp seen
  let lastRender = 0;     // previous timestamp a frame was drawn
  let startedAt = 0;
  let podSeen = 0;        // last timestamp the pod drew

  // One-second windows of what happened.
  let win = { start: 0, ticks: [], renders: [] };
  let slow = 0;
  let easy = 0;
  let easyNeeded = 8;     // grows each time a step up fails to hold, shrinks when one holds
  let lastChange = 0;
  let lastUpAt = 0;
  let trial = null;       // the last step down, and how things stood before it
  const futileUntil = { pod: 0, shed: 0 };
  const recent = [];      // the last few windows' { p50, late }
  const mean = (list, k) => list.reduce((sum, w) => sum + w[k], 0) / Math.max(1, list.length);
  const stats = { fps: 0, p50: 0, p95: 0, late: 0 };

  function snapRefresh(ms) {
    let best = ms;
    let err = Infinity;
    for (const s of REFRESH_STEPS) {
      const e = Math.abs(ms - s) / s;
      if (e < err) { err = e; best = s; }
    }
    return err < 0.12 ? best : ms;
  }

  const percentile = (arr, p) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };

  function targetInterval() {
    return Math.max(vsync, Number.isFinite(capHz) ? 1000 / capHz : 0);
  }

  function closeWindow(now) {
    const ticks = win.ticks;
    const renders = win.renders;
    win = { start: now, ticks: [], renders: [] };
    if (ticks.length < 8) return; // a hidden tab or a stall: nothing to learn from

    // The display's interval: the quickest steady ticks seen, snapped to a real refresh rate.
    const fast = snapRefresh(percentile(ticks, 0.1));
    if (fast > 4 && fast < vsync * 0.92) vsync = fast;
    else if (fast > vsync * 1.6 && percentile(ticks, 0.5) > vsync * 1.6 && ticks.length > 20) {
      // Every tick in a full window is slower: the screen itself has slowed (Low Power Mode,
      // battery saver, a 30 Hz external display). Follow it rather than call it overload.
      const spread = percentile(ticks, 0.9) / Math.max(1, percentile(ticks, 0.1));
      if (spread < 1.15) vsync = fast;
    }

    const T = targetInterval();
    const late = renders.filter((d) => d > T * 1.5).length / Math.max(1, renders.length);
    const p50 = percentile(renders, 0.5);
    stats.fps = Math.round(renders.length * 1000 / Math.max(1, renders.reduce((a, b) => a + b, 0)));
    stats.p50 = +p50.toFixed(1);
    stats.p95 = +percentile(renders, 0.95).toFixed(1);
    stats.late = Math.round(late * 100);
    if (hud) drawHud();

    recent.push({ p50, late });
    if (recent.length > 4) recent.shift();
    if (pinned || now - startedAt < 1500) return;
    const struggling = late > 0.25 || p50 > T * 1.25;
    const comfortable = late < 0.05 && p50 < T * 1.1;

    // Two windows after a step down to a softer pod or fewer particles, compared with the two
    // before it: if it made no real difference the bottleneck is elsewhere, so it is taken
    // back rather than leave a cost on screen for no gain.
    if (trial) trial.after.push({ p50, late });
    if (trial && trial.after.length >= 2) {
      const p50After = mean(trial.after, 'p50');
      const lateAfter = mean(trial.after, 'late');
      const helped = !struggling
        || (p50After < trial.p50 * 0.92 && lateAfter <= trial.late)
        || lateAfter < trial.late - Math.max(0.1, trial.late * 0.3);
      if (!helped && (trial.knob === 'pod' || trial.knob === 'shed')) {
        if (trial.knob === 'pod') podLevel = Math.max(0, podLevel - 1);
        else shed = Math.max(0, shed - 1);
        futileUntil[trial.knob] = now + 60000;
        trial = null;
        lastChange = now;
        notify();
        return;
      }
      trial = null;
    }
    // A step up that has held for a while earns the next one a shorter wait.
    if (lastUpAt && now - lastUpAt > 6000) {
      easyNeeded = Math.max(8, easyNeeded / 2);
      lastUpAt = 0;
    }
    if (now - lastChange < 1200) return;

    if (struggling) {
      easy = 0;
      if (++slow >= 2) {
        slow = 0;
        // A step up that falls over within a few seconds makes the next attempt wait longer.
        if (lastUpAt && now - lastUpAt < 6000) {
          easyNeeded = Math.min(64, easyNeeded * 2);
          lastUpAt = 0;
        }
        stepDown(now, p50, late);
      }
    } else if (comfortable) {
      slow = 0;
      if (++easy >= easyNeeded) {
        easy = 0;
        stepUp(now);
      }
    } else {
      slow = 0;
      easy = 0;
    }
  }

  function podOnScreen(now) {
    return now - podSeen < 1500;
  }

  function stepDown(now, p50, late) {
    const fastScreen = vsync < 1000 / 65;
    let knob;
    if (fastScreen && capHz > 60) {
      capHz = 60;
      knob = 'cap';
    } else if (podOnScreen(now) && podLevel < podLevels && now > futileUntil.pod) {
      podLevel++;
      knob = 'pod';
    } else if (capHz > 30) {
      capHz = 30;
      knob = 'cap';
    } else if (shed < MAX_SHED && now > futileUntil.shed) {
      shed++;
      knob = 'shed';
    } else {
      return;
    }
    const before = recent.slice(-2);
    trial = { knob, p50: before.length ? mean(before, 'p50') : p50, late: before.length ? mean(before, 'late') : late, after: [], at: now };
    lastChange = now;
    notify();
  }

  function stepUp(now) {
    if (shed > 0) shed--;
    else if (capHz === 30) capHz = 60;
    else if (podLevel > 0) podLevel--;
    else if (capHz === 60 && tier === 'high') capHz = Infinity;
    else return;
    lastChange = now;
    lastUpAt = now;
    notify();
  }

  // Call once at the top of every animation frame. false: leave this frame as it is.
  function frame(now) {
    if (now === lastStamp) return lastDecision;
    lastStamp = now;
    if (!startedAt) {
      startedAt = now;
      win.start = now;
    }
    const tick = lastTick ? now - lastTick : 0;
    lastTick = now;
    if (tick > 0 && tick < 250) win.ticks.push(tick);
    else if (tick >= 250) {
      // Back from a hidden tab or a long stall: start the timing over.
      lastRender = 0;
      win = { start: now, ticks: [], renders: [] };
    }

    const T = targetInterval();
    // Half a refresh of tolerance, so a 60 cap on a 120 Hz screen lands on every other tick.
    const due = !lastRender || now - lastRender >= T - vsync * 0.5;
    if (due) {
      if (lastRender) win.renders.push(now - lastRender);
      lastRender = now;
    }
    lastDecision = due;
    if (now - win.start >= 1000) closeWindow(now);
    return due;
  }

  document.addEventListener('visibilitychange', () => {
    lastTick = 0;
    lastRender = 0;
    slow = 0;
    easy = 0;
  });

  // ---------------------------------------------------------------- the pod's densities
  // Pixel densities the 3D pod is drawn at, best first: the first is what it is drawn at
  // whenever the device keeps up, the rest are the governor's pod steps (registerPod with
  // length - 1). Every page that shows the pod asks here, so they all agree.
  //   - Up to 2x everywhere. Phones used to stop at 1.5 and drew without antialiasing, which
  //     on a 3x screen is a stepped edge on every curve of the pod. A phone the browser says
  //     is short of memory (Chromium only) holds at 1.5: antialiasing keeps four samples of
  //     every pixel.
  //   - A screen below 1.5x is drawn at 1.5 and scaled down on the way to the screen. At one
  //     pixel per CSS pixel the pod's silhouette and its highlights alias, which antialiasing
  //     only partly fixes (it smooths edges, not a highlight that falls between pixels).
  //   - Each step is an eighth below the one before, never more than two steps: at worst a
  //     2x screen draws at 1.5, as before, and a 1x one at a touch over 1x.
  function podRatios(phone) {
    const dpr = window.devicePixelRatio || 1;
    const ceiling = phone && memory && memory <= 2 ? 1.5 : 2;
    const full = Math.min(ceiling, Math.max(dpr, 1.5));
    return [full, full * 0.875, full * 0.75].map((r) => Math.round(r * 100) / 100);
  }

  // ---------------------------------------------------------------- scheduling helpers
  const idle = window.requestIdleCallback
    ? (fn, timeout = 1500) => window.requestIdleCallback(fn, { timeout })
    : (fn) => setTimeout(() => fn({ didTimeout: true, timeRemaining: () => 8 }), 32);
  // Resolves at the start of a fresh task, so long setup work can be cut into slices that
  // never hold up a frame.
  const nextTask = () => (window.scheduler && typeof window.scheduler.yield === 'function'
    ? window.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0)));
  const nextIdle = (timeout) => new Promise((resolve) => idle(resolve, timeout));

  // ---------------------------------------------------------------- overlay (?perf)
  const hud = params.has('perf') ? document.createElement('pre') : null;
  const reports = {};
  function drawHud() {
    if (!hud) return;
    if (!hud.isConnected && document.body) {
      hud.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;margin:0;padding:8px 10px;'
        + 'font:11px/1.35 ui-monospace,Menlo,monospace;color:#e8ffe8;background:rgb(0 0 0 / 0.72);'
        + 'border-radius:8px;pointer-events:none;white-space:pre;max-width:calc(100vw - 16px);overflow:hidden';
      document.body.appendChild(hud);
    }
    const lines = [
      `tier ${tier}${pinned ? ' (level pinned)' : ''}  ${Math.round(1000 / vsync)} Hz screen`,
      `gpu ${gpu.replace(/^ANGLE \(|\)$/g, '').slice(0, 60) || 'n/a'}`,
      `fps ${stats.fps}  p50 ${stats.p50}ms  p95 ${stats.p95}ms  late ${stats.late}%`,
      `cap ${Number.isFinite(capHz) ? capHz : 'screen'}  pod step ${podLevel}/${podLevels}  shed ${shed}`,
    ];
    for (const [k, v] of Object.entries(reports)) lines.push(`${k} ${v}`);
    hud.textContent = lines.join('\n');
  }

  // ---------------------------------------------------------------- service worker
  // Only in the built site (the build defines GRID_BUILD): during development a cache in
  // front of the files being edited would only get in the way. ?nosw takes it back out.
  // Registered by its root path with the root scope: a relative 'sw.js' would resolve
  // against the page, so a nested page (jobs/<slug>/) would register a second worker at
  // jobs/<slug>/sw.js, which does not exist, instead of joining the site's one.
  if ('serviceWorker' in navigator) {
    if (params.has('nosw')) {
      navigator.serviceWorker.getRegistrations().then((list) => list.forEach((r) => r.unregister()));
    } else if (window.GRID_BUILD && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      window.addEventListener('load', () => idle(() => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
      }, 4000));
    }
  }

  const api = {
    classify,
    frame,
    on(fn) { listeners.push(fn); },
    // The pod says how many lower densities it can drop to here (0 on a 1x screen).
    registerPod(levels) {
      podLevels = Math.max(0, levels | 0);
      if (podLevel > podLevels) podLevel = podLevels;
    },
    podDrawn(now) { podSeen = now || performance.now(); },
    podRatios,
    report(name, text) {
      reports[name] = text;
    },
    idle,
    nextIdle,
    nextTask,
    get tier() { return tier; },
    get gpu() { return gpu; },
    get capHz() { return capHz; },
    get podLevel() { return podLevel; },
    get shed() { return shed; },
    get refreshHz() { return 1000 / vsync; },
    get pinned() { return pinned; },
    get reduceMotion() { return reduceMotion; },
    get hudOn() { return !!hud; },
  };
  window.GridPerf = api;
})();
