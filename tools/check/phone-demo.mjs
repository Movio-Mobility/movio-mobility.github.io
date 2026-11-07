#!/usr/bin/env node
/*
 * The app beat's "Tap to experience" demos (phoneDemo in index.html), checked in headless
 * Chrome.
 *
 *   node tools/check/phone-demo.mjs            every check, every width
 *   node tools/check/phone-demo.mjs --reel     and stills of each demo at its moments, on
 *                                              contact sheets in tools/check/out/
 *   --only=phone,desktop   --root=dist   narrow the run, or check the built site
 *
 * First it checks the points sit just below the phone, centred under it and clear of the
 * caption. Each demo is then held still at chosen moments through the page's ?check hook
 * (window.__phoneDemo.seek), so every frame is the same on every run. At each it checks the
 * app is in the state the real app would be (the row, which screen is open, the SOS phase and
 * its count), that the phone hasn't moved from where it rests, and that nothing has spilled
 * sideways off the page; then it plays each demo for
 * real, ends one by tapping another and one by scrolling, and checks the page is back at rest:
 * no open screen, no stray transform, the points released.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { serve } from '../serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require = createRequire(path.join(REPO, 'package.json'));
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(HERE, 'out');
const REEL = process.argv.includes('--reel');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const rootArg = process.argv.find((a) => a.startsWith('--root='));

const VIEWPORTS = {
  small: { width: 320, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  large: { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop: { width: 1024, height: 768, deviceScaleFactor: 2 },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
};

// The moments to hold each demo at, and what the app shows then. Times are found from the
// demo's own cues where they move, so these are generous: the middle of each state.
const MOMENTS = {
  live: [
    ['arrive', 300, { row: 'idle', open: [] }],
    ['hover', 900, { row: 'idle', open: [] }],
    ['sheet', 1700, { row: 'idle', open: ['share-sheet'], value: '30 minutes' }],
    ['an hour', 2800, { row: 'idle', open: ['share-sheet'], value: '1 hour' }],
    ['busy', 4300, { row: 'idle', open: ['share-sheet'], busy: true }],
    ['share sheet', 6800, { row: 'live', open: ['ios-share'] }],
    ['live', 8100, { row: 'live', open: [] }],
  ],
  share: [
    ['arrive', 600, { row: 'live', open: [] }],
    ['share sheet', 1800, { row: 'live', open: ['ios-share'] }],
    ['whatsapp', 3800, { row: 'live', open: ['ios-share', 'wa-send'] }],
    ['sent', 5540, { row: 'live', open: [] }],
  ],
  sos: [
    ['arrive', 700, { open: [], tab: 'home' }],
    ['safety', 1900, { open: ['safety'], phase: 'idle' }],
    ['five', 3600, { open: ['safety'], phase: 'counting', digit: '5' }],
    ['three', 5700, { open: ['safety'], phase: 'counting', digit: '3' }],
    ['sending', 8400, { open: ['safety'], phase: 'sending' }],
    ['sent', 10200, { open: ['safety'], phase: 'sent', read: false, banner: true }],
    ['read', 11900, { open: ['safety'], phase: 'sent', read: true, banner: true }],
    ['are you safe', 13700, { open: ['safety'], phase: 'sent', confirm: true }],
    ['safe', 16000, { open: ['safety'], phase: 'idle', confirm: false, banner: false }],
  ],
  // The second app beat's row.
  crash: [
    ['alert', 1800, { open: ['crash'], count: '3:59:59' }],
    ['counting', 3800, { open: ['crash'], count: '3:59:57' }],
  ],
  energy: [
    ['energy', 2000, { open: [], tab: 'energy' }],
    ['insights', 4000, { open: ['ins'], tab: 'energy' }],
    ['last ride', 6500, { open: ['ins'], lastRide: true }],
    ['home', 11000, { open: [], tab: 'home' }],
  ],
  insights: [
    ['insights', 3600, { open: ['ins'], tab: 'energy', day: false }],
    ['thursday', 5600, { open: ['ins'], day: true }],
    ['the week', 7600, { open: ['ins'], day: false }],
    ['scrolled', 10300, { open: ['ins'], scrolled: true }],
    ['home', 13300, { open: [], tab: 'home' }],
  ],
};
const SECOND_ROW = new Set(['crash', 'insights', 'energy']);

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the page shows: the app's state, and whether anything reaches past the page's sides.
const SNAPSHOT = () => {
  const LAYER = /^(share-sheet|ios-share|wa-send|safety|ins|crash)$/;
  const open = [...document.querySelectorAll('.app-layer.is-open')].map((l) => [...l.classList].find((c) => LAYER.test(c)));
  const safety = document.querySelector('.safety');
  const digits = [...safety.querySelectorAll('.safety__face--count span')];
  const shown = digits.find((d) => parseFloat(getComputedStyle(d).opacity) > 0.5);
  const wide = document.documentElement.scrollWidth;
  const phone = document.querySelector('.phone').getBoundingClientRect();
  const screen = document.querySelector('.phone__screen').getBoundingClientRect();
  return {
    phoneOff: phone.left < -2 || phone.right > innerWidth + 2,
    row: document.querySelector('.home__share').dataset.share,
    open,
    phase: safety.dataset.phase,
    read: safety.dataset.read === 'true',
    confirm: safety.dataset.confirm === 'true',
    digit: shown ? shown.textContent : null,
    busy: document.querySelector('.share-sheet').dataset.busy === 'true',
    value: document.querySelector('[data-share-sheet="value"]').textContent,
    tab: document.querySelector('.app').dataset.tab,
    day: document.querySelector('[data-ins="week"]').dataset.day === 'true',
    // Home's SOS banner, grown under the Safety sheet once the SOS is sent.
    banner: document.querySelector('[data-sos="banner"]').getBoundingClientRect().height > 1,
    overflowX: wide > innerWidth + 1,
    pressed: [...document.querySelectorAll('.film__point')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.demo),
    // The demos' own pieces only, everything their timelines move: the tour between the app
    // beats has its own hand and touch.
    styled: [...document.querySelectorAll([
      '.film__finger', '.film__finger .film__hand', '.film__touch:not(.film__touch--tour)', '.app', '.app-layer',
      '.share-sheet .gx-sheet', '.gx-scrim', '.ios-share__sheet', '.ios-share__dim', '.wa-send__sheet',
      '.safety__sheet', '.safety__disc', '.safety__arc', '.safety__confirm', '.safety__confirm-scrim', '.safety__face--count span',
      '[data-sos="banner"]', '[data-ins="scroll"]', '.ins__bar',
      '.crash__eyebrow', '.crash__title', '.crash__hero', '.crash__words', '.crash__actions',
    ].join(', '))].filter((el) => el.getAttribute('style')).map((el) => el.className.baseVal ?? el.className),
    demo: window.__phoneDemo.active,
    count: document.querySelector('[data-crash="count"]').textContent,
    // Riding insights scrolled down from its top.
    scrolled: new DOMMatrix(getComputedStyle(document.querySelector('[data-ins="scroll"]')).transform).m42 < -100,
    // The last ride's group whole on the screen.
    lastRide: (() => {
      const last = document.querySelector('[data-ins="last"]').getBoundingClientRect();
      return last.top >= screen.top - 1 && last.bottom <= screen.bottom + 1;
    })(),
    // The finger's two poses: never both showing.
    hands: [...document.querySelectorAll('.film__finger .film__hand')].map((img) => parseFloat(getComputedStyle(img).opacity)),
  };
};

// A click where the point is on screen. (ElementHandle.click scrolls its element into view
// first, and scrolling moves the film.)
async function press(tab, sel) {
  const r = await tab.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel);
  await tab.mouse.click(r[0], r[1]);
}

async function toBeat(tab, at = 10.25) {
  await tab.evaluate((t) => {
    const vh = document.getElementById('bg').clientHeight || innerHeight;
    window.scrollTo({ top: t * vh, behavior: 'instant' });
  }, at);
  // The film follows the scroll with a little damping, and the app opens with its entrance.
  await sleep(2600);
}

const server = await serve({ root: rootArg ? path.resolve(rootArg.slice(7)) : REPO, port: 8141, quiet: true });
const chrome = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] });
fs.mkdirSync(OUT, { recursive: true });
const sheets = [];
try {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const tab = await chrome.newPage();
    await tab.setViewport(viewport);
    const errors = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    // Failed requests are judged by their address (the analytics endpoint on :3000 is not run
    // here); the console's own line for them carries none.
    tab.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|localhost:3000|favicon|paddock/i.test(m.text())) errors.push(m.text()); });
    tab.on('requestfailed', (q) => { if (!/localhost:3000|favicon/.test(q.url()) && !/ERR_ABORTED/.test((q.failure() || {}).errorText || '')) errors.push(`${q.url()} ${(q.failure() || {}).errorText}`); });
    await tab.goto(`http://localhost:8141/index.html?check`, { waitUntil: 'load' });
    await sleep(1200);

    // Before the beat: the points can't be tapped.
    await toBeat(tab, 8.7);
    const before = await tab.evaluate(() => [...document.querySelectorAll('.film__point')].every((b) => b.getAttribute('tabindex') === '-1' && getComputedStyle(b).pointerEvents === 'none'));
    report(`${name}: the points are not tappable before their beat`, before);

    // Each row's points are tappable in their own beat and no other, and a finger on each one's
    // middle lands on it (the two rows share a place under the phone).
    const TAPPABLE = (beat) => [...document.querySelectorAll('.film__tap .film__point')].map((b) => {
      const mine = b.closest('.film__tap').dataset.beat === String(beat);
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const live = !b.hasAttribute('tabindex') && getComputedStyle(b).pointerEvents === 'auto';
      return { ok: mine ? live && hit === b : !live, demo: b.dataset.demo, hit: hit && hit.className, mine };
    });
    // The middle label of each row sits on the phone's centre line.
    const MIDDLES = () => {
      const phone = document.querySelector('.phone').getBoundingClientRect();
      const cx = phone.left + phone.width / 2;
      return [...document.querySelectorAll('.film__tap')].map((row) => {
        const mid = row.querySelectorAll('.film__point')[1].getBoundingClientRect();
        const label = row.querySelector('.film__try').getBoundingClientRect();
        return { beat: row.dataset.beat, mid: mid.left + mid.width / 2 - cx, label: label.left + label.width / 2 - cx };
      });
    };
    await toBeat(tab, 14.3);
    const second = await tab.evaluate(TAPPABLE, 6);
    report(`${name}: the second row is tappable in its beat, the first is not`, second.every((d) => d.ok), second.filter((d) => !d.ok).map((d) => `${d.demo} (${d.mine ? `lands on ${d.hit}` : 'live out of its beat'})`).join('; '));
    await toBeat(tab);
    const during = await tab.evaluate(TAPPABLE, 5);
    report(`${name}: the points are tappable in their beat`, during.every((d) => d.ok), during.filter((d) => !d.ok).map((d) => `${d.demo} (${d.mine ? `lands on ${d.hit}` : 'live out of its beat'})`).join('; '));
    const middles = await tab.evaluate(MIDDLES);
    report(`${name}: each row's middle label and its "Click to experience" sit on the phone's centre`, middles.every((m) => Math.abs(m.mid) <= 1 && Math.abs(m.label) <= 1),
      middles.map((m) => `beat ${m.beat}: ${m.mid.toFixed(1)}, ${m.label.toFixed(1)}`).join('; '));

    // "Tap to experience" and the points sit just below the phone, centred under it, clear of
    // the caption and on screen.
    const PLACES = () => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const phone = r('.phone');
      const words = [...document.querySelectorAll('.film__tap[data-beat="5"] .film__try, .film__tap[data-beat="5"] .film__point')].map((el) => el.getBoundingClientRect());
      const row = { l: Math.min(...words.map((w) => w.left)), r: Math.max(...words.map((w) => w.right)), t: Math.min(...words.map((w) => w.top)), b: Math.max(...words.map((w) => w.bottom)) };
      const caption = [...document.querySelectorAll('.film__caption[data-beat="5"] > *')].map((el) => el.getBoundingClientRect());
      const overlaps = caption.some((c) => c.left < row.r && c.right > row.l && c.top < row.b && c.bottom > row.t);
      return { phone: { l: phone.left, t: phone.top, b: phone.bottom, cx: phone.left + phone.width / 2, h: phone.height }, row, overlaps, vh: innerHeight };
    };
    const placed = await tab.evaluate(PLACES);
    {
      const { phone, row } = placed;
      const wrong = [];
      if (row.t < phone.b || row.t > phone.b + 40) wrong.push(`row ${(row.t - phone.b).toFixed(1)}px below the phone`);
      if (Math.abs((row.l + row.r) / 2 - phone.cx) > 2) wrong.push(`row off the phone's centre by ${((row.l + row.r) / 2 - phone.cx).toFixed(1)}px`);
      if (placed.overlaps) wrong.push('row runs into the caption');
      if (row.b > placed.vh) wrong.push('row off the bottom of the screen');
      report(`${name}: the points sit just below the phone`, !wrong.length, wrong.join('; '));
    }
    const lengths = await tab.evaluate(() => window.__phoneDemo.lengths());

    // Every demo, held at its moments.
    const stills = [];
    for (const [demo, moments] of Object.entries(MOMENTS)) {
      await toBeat(tab, SECOND_ROW.has(demo) ? 14.3 : 10.25);
      for (const [label, ms, want] of moments) {
        await tab.evaluate((d, t) => window.__phoneDemo.seek(d, t), demo, ms);
        await sleep(650); // the screens' own short transitions (the SOS faces, captions)
        const got = await tab.evaluate(SNAPSHOT);
        const wrong = [];
        if (want.row && got.row !== want.row) wrong.push(`row ${got.row}, wanted ${want.row}`);
        if (want.open && want.open.join() !== got.open.join()) wrong.push(`open [${got.open}], wanted [${want.open}]`);
        if (want.phase && got.phase !== want.phase) wrong.push(`phase ${got.phase}, wanted ${want.phase}`);
        if (want.digit && got.digit !== want.digit) wrong.push(`count ${got.digit}, wanted ${want.digit}`);
        if (want.busy !== undefined && got.busy !== want.busy) wrong.push(`busy ${got.busy}`);
        if (want.value && got.value !== want.value) wrong.push(`value ${got.value}`);
        if (want.count && got.count !== want.count) wrong.push(`count ${got.count}, wanted ${want.count}`);
        if (want.tab && got.tab !== want.tab) wrong.push(`tab ${got.tab}, wanted ${want.tab}`);
        if (want.read !== undefined && got.read !== want.read) wrong.push(`read ${got.read}`);
        if (want.confirm !== undefined && got.confirm !== want.confirm) wrong.push(`"Are you safe now?" ${got.confirm ? 'open' : 'not open'}`);
        if (want.banner !== undefined && got.banner !== want.banner) wrong.push(`Home's SOS banner ${got.banner ? 'shown' : 'not shown'}`);
        if (want.day !== undefined && got.day !== want.day) wrong.push(`Thursday picked ${got.day}`);
        if (want.scrolled !== undefined && got.scrolled !== want.scrolled) wrong.push(`scrolled ${got.scrolled}`);
        if (want.lastRide !== undefined && got.lastRide !== want.lastRide) wrong.push('the last ride not in view');
        if (got.overflowX) wrong.push('the page scrolls sideways');
        if (got.phoneOff) wrong.push('the phone runs off the side of the screen');
        if (got.hands.filter((o) => o > 0.01).length > 1) wrong.push('two hands');
        // The phone stays where it rests while the hand works it, on every layout.
        const now = await tab.evaluate(PLACES);
        if (Math.abs(now.phone.t - placed.phone.t) > 1 || Math.abs(now.phone.l - placed.phone.l) > 1 || Math.abs(now.phone.h - placed.phone.h) > 1) wrong.push('the phone moved');
        report(`${name}: ${demo} at ${label} (${ms} ms)`, !wrong.length, wrong.join('; '));
        if (REEL) stills.push({ label: `${demo}: ${label}`, png: await tab.screenshot({ type: 'png' }) });
      }
      await tab.evaluate(() => window.__phoneDemo.stop());
      await sleep(500);
    }

    // One hand, never two: Riding insights (flicks, taps) held every 40 ms of its length.
    {
      await toBeat(tab, 14.3);
      const doubled = await tab.evaluate((end) => {
        const bad = [];
        for (let ms = 0; ms <= end; ms += 40) {
          window.__phoneDemo.seek('insights', ms);
          const o = [...document.querySelectorAll('.film__finger .film__hand')].map((img) => parseFloat(getComputedStyle(img).opacity));
          if (o.filter((v) => v > 0.01).length > 1) bad.push(ms);
        }
        window.__phoneDemo.stop();
        return bad;
      }, lengths.insights);
      await sleep(600);
      report(`${name}: only ever one hand`, !doubled.length, doubled.slice(0, 8).join(', '));
    }

    // Played for real: Crash detection to its end, then back at rest.
    await toBeat(tab, 14.3);
    await press(tab, '[data-demo="crash"]');
    await sleep(lengths.crash + 1200);
    {
      const r = await tab.evaluate(SNAPSHOT);
      report(`${name}: Crash detection plays to its end and puts everything back`, !r.open.length && !r.demo && !r.pressed.length && !r.styled.length && r.count === '4:00:00',
        JSON.stringify({ open: r.open, demo: r.demo, styled: r.styled, count: r.count }));
    }

    // Played for real: Live location to its end, then back at rest.
    await toBeat(tab);
    await press(tab, '[data-demo="live"]');
    await sleep(lengths.live + 1200);
    let rest = await tab.evaluate(SNAPSHOT);
    report(`${name}: Live location plays to its end and leaves the row live`, rest.row === 'live' && !rest.open.length && !rest.demo && !rest.pressed.length && !rest.styled.length && rest.tab === 'home',
      JSON.stringify({ row: rest.row, open: rest.open, demo: rest.demo, pressed: rest.pressed, styled: rest.styled }));

    // Another point mid-demo takes the first one home and starts the second.
    await press(tab, '[data-demo="share"]');
    await sleep(2400);
    await press(tab, '[data-demo="sos"]');
    await sleep(900);
    const switched = await tab.evaluate(SNAPSHOT);
    report(`${name}: another point switches demos`, switched.demo === 'sos' && switched.pressed.join() === 'sos' && !switched.open.includes('ios-share'), JSON.stringify({ demo: switched.demo, open: switched.open }));

    // Scrolling away ends it.
    await tab.evaluate(() => {
      const vh = document.getElementById('bg').clientHeight || innerHeight;
      window.scrollTo({ top: 14.3 * vh, behavior: 'instant' });
    });
    await sleep(1500);
    rest = await tab.evaluate(SNAPSHOT);
    report(`${name}: scrolling away ends a demo and puts everything back`, !rest.demo && !rest.open.length && !rest.pressed.length && !rest.styled.length && rest.phase === 'idle' && !rest.banner, JSON.stringify({ demo: rest.demo, open: rest.open, styled: rest.styled, phase: rest.phase }));

    // Keyboard: Enter plays, Escape ends.
    await toBeat(tab);
    await tab.focus('[data-demo="sos"]');
    await tab.keyboard.press('Enter');
    await sleep(800);
    const keyed = await tab.evaluate(() => window.__phoneDemo.active);
    await tab.keyboard.press('Escape');
    await sleep(700);
    const escaped = await tab.evaluate(() => window.__phoneDemo.active);
    report(`${name}: Enter plays and Escape ends`, keyed === 'sos' && escaped === null, `${keyed} then ${escaped}`);

    // Reduced motion: the same steps, cut rather than travelled.
    if (name === 'desktop' || name === 'phone') {
      await tab.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await tab.reload({ waitUntil: 'load' });
      await sleep(1200);
      await toBeat(tab);
      await press(tab, '[data-demo="sos"]');
      await sleep(7500);
      const mid = await tab.evaluate(SNAPSHOT);
      await sleep(lengths.sos - 7500 + 1500);
      const end = await tab.evaluate(SNAPSHOT);
      report(`${name}: reduced motion plays SOS through and ends at rest`, mid.open.includes('safety') && ['counting', 'sending', 'sent'].includes(mid.phase) && !end.demo && !end.open.length && !end.styled.length,
        JSON.stringify({ mid: [mid.open, mid.phase], end: [end.demo, end.open, end.styled] }));
      await tab.emulateMediaFeatures([]);
    }

    report(`${name}: no errors`, !errors.length, errors.slice(0, 3).join(' | '));
    if (REEL) sheets.push({ name, viewport, stills });
    await tab.close();
  }

  if (REEL) {
    // Contact sheets: the stills of each viewport four across, scaled down.
    for (const { name, stills } of sheets) {
      const imgs = stills.map((s) => ({ label: s.label, png: PNG.sync.read(Buffer.from(s.png)) }));
      const cols = 4;
      const scale = imgs[0].png.width > 1600 ? 4 : 3;
      const w = Math.floor(imgs[0].png.width / scale);
      const h = Math.floor(imgs[0].png.height / scale);
      const rows = Math.ceil(imgs.length / cols);
      const out = new PNG({ width: w * cols, height: h * rows });
      out.data.fill(255);
      imgs.forEach(({ png }, i) => {
        const ox = (i % cols) * w, oy = Math.floor(i / cols) * h;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const sx = x * scale, sy = y * scale;
            const si = (sy * png.width + sx) * 4;
            const di = ((oy + y) * out.width + ox + x) * 4;
            out.data[di] = png.data[si];
            out.data[di + 1] = png.data[si + 1];
            out.data[di + 2] = png.data[si + 2];
            out.data[di + 3] = 255;
          }
        }
      });
      const file = path.join(OUT, `phone-demo-${name}.png`);
      fs.writeFileSync(file, PNG.sync.write(out));
      console.log(`${path.relative(REPO, file)}  ${imgs.map((s) => s.label).join(', ')}`);
    }
  }
} finally {
  await chrome.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
