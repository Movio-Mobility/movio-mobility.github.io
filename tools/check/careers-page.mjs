#!/usr/bin/env node
/*
 * careers.html in a real browser, against Paddock played by the mock:
 *
 *   the tape    one stop per team with an open role, in Paddock's order, then the open
 *               application; each label its mark above the hairline and its name below it
 *               (measured), the needle clear of the mark; opening a team flies the mark and
 *               the name separately into the title (FLIP, measured on the first frame) and
 *               closing flies them home onto the label; switching rolls the title over;
 *               #<team> opens a team and Back closes it; a touch drag moves the tape on
 *   reactive    with the mock's state switch: a role added above the reader (the card being
 *               read stays put), a role closed (no scroll jump), a new team (a stop in the
 *               right place, the same tape), the open team emptied (closed gracefully), the
 *               open role closing under its sheet, applications paused
 *   deep links  ?role=<slug>, a previous slug, ?job=<id> (made ?role=), ?apply=open, a closed
 *               role, an unknown one
 *   states      loading (stand-ins exactly where the labels land), the list failing with no
 *               copy (retry), failing with the build's copy (kept, with a quiet retry), no open
 *               roles, and no JavaScript (the build's plain list)
 *   keyboard    arrows along the tablist, Enter opens, a card opens its sheet, Escape closes
 *               the sheet and then the team, focus handed back each time
 *   analytics   careers_view, and role_view with the slug, as Paddock receives them
 *   and on every page: no page errors and no Content Security Policy violations
 *
 *   npm run check:careers-page          (--keep to keep the build)
 *
 * It builds the site with the mock as Paddock, so the page runs exactly as deployed (minified,
 * versioned, under its CSP, with the build's snapshot), serves the build and drives headless
 * Chrome at 1440x900 and at 390x844 as a phone. The pages reach Paddock at
 * http://localhost:3000, so the mock listens there (one already there is used).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startMock } from './paddock-mock.mjs';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PADDOCK = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let passed = 0;
function report(label, ok, detail = '', problems = []) {
  const pass = Boolean(ok) && !problems.length;
  if (pass) passed++;
  else failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}${problems.length ? `\n      page: ${problems.join(' | ')}` : ''}`);
}

// ---------------------------------------------------------------- Paddock, the build, the server
let mock = null;
try {
  mock = await startMock({ port: 3000, quiet: true });
} catch (err) {
  const there = await fetch(`${PADDOCK}/__mock/state`).then((r) => r.ok).catch(() => false);
  if (!there) {
    console.error('Port 3000 is taken by something that is not the mock (Paddock?). Stop it and run again.');
    process.exit(1);
  }
  console.log('note: using the mock already listening on :3000');
}
const ctl = (route, body) => fetch(`${PADDOCK}${route}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
const reset = () => ctl('/__mock/reset', {});
const setMock = (body) => ctl('/__mock/state', body);
const careersDoc = () => fetch(`${PADDOCK}/api/public/website/careers`).then((r) => r.json());
const logSince = async (seq) => (await ctl(`/__mock/log?since=${seq}`)).entries;
const lastSeq = async () => {
  const all = (await ctl('/__mock/log?since=0')).entries;
  return all.length ? all[all.length - 1].seq : 0;
};

const scratch = fs.mkdtempSync(path.join(process.env.CHECK_TMP || os.tmpdir(), 'gridx-careers-page-'));
const out = path.join(scratch, 'site');
await reset();
const built = await new Promise((resolve) => {
  const env = { ...process.env, CAREERS_API: `${PADDOCK}/api/public/website/careers`, CAREERS_SNAPSHOT: `${PADDOCK}/no-snapshot.json` };
  for (const k of ['GITHUB_OUTPUT', 'GITHUB_ACTIONS', 'CAREERS_FIXTURE', 'DEALERS_API', 'DEALERS_FIXTURE', 'BUILD_OUT']) delete env[k];
  const child = spawn(process.execPath, [path.join(REPO, 'tools/build.mjs'), '--out', out], { cwd: REPO, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('close', (status) => resolve({ status, log }));
});
if (built.status !== 0 || !fs.existsSync(path.join(out, 'careers.html'))) {
  console.error(`The build failed:\n${built.log.slice(-1500)}`);
  process.exit(1);
}

// careers.html as a build without careers data would write it: no snapshot.
fs.writeFileSync(path.join(out, 'careers-nodata.html'), fs.readFileSync(path.join(out, 'careers.html'), 'utf8')
  .replace(/<script type="application\/json" id="careers-snapshot">[\s\S]*?<\/script>/, ''));

const server = await serve({ root: out, port: 0, quiet: true });
const SITE = `http://localhost:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS, protocolTimeout: 180000 });

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/careers.json'), 'utf8'));
const TEAMS = FIXTURE.domains.slice().sort((a, b) => a.order - b.order).map((d) => d.key);

/** A page, with every page error and CSP violation collected. */
async function open(url, { viewport = DESKTOP, before, js = true, noSnapshot = false, motion } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  // Straight to the network, as on a first visit: no service worker answering from its cache.
  await page.setBypassServiceWorker(true);
  if (!js) await page.setJavaScriptEnabled(false);
  if (motion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: motion }]);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|connect|apply|frame)/i.test(t)) problems.push(`CSP: ${t.slice(0, 160)}`);
    else if (m.type() === 'error' && !/Failed to load resource|favicon/i.test(t)) problems.push(t.slice(0, 160));
  });
  if (before) await before(page);
  // The page as a build with no careers data ships it: no snapshot to paint from (a copy of
  // the built page beside it, so it still reaches the mock as a local page may).
  await page.goto(noSnapshot ? url.replace('/careers.html', '/careers-nodata.html') : url, { waitUntil: 'load' });
  return { page, problems };
}

/** The tape has run its film and nothing is moving (springs given a moment to settle). */
async function settled(page, { timeout = 12000, extra = 450 } = {}) {
  await page.waitForFunction(() => {
    const t = window.gridCareersPage && window.gridCareersPage.tape;
    const m = document.querySelector('main.careers');
    return t && m.classList.contains('is-ready') && !m.classList.contains('is-filming') && !t.state.busy
      && !document.querySelector('.cr-face')?.getAnimations().length;
  }, { timeout });
  await sleep(extra);
}

const stopIds = (page) => page.$$eval('.tl-stop:not([aria-hidden="true"])', (bs) => bs.map((b) => b.dataset.stop));

/** Every label on screen: mark above the hairline, name below, centred on each other. */
function measureLabels(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main.careers');
    const inner = document.querySelector('.tl-bar__inner');
    const hair = inner.getBoundingClientRect().top + parseFloat(getComputedStyle(main).getPropertyValue('--hairline'));
    const out = [];
    for (const b of document.querySelectorAll('.tl-stop:not([aria-hidden="true"])')) {
      if (parseFloat(b.style.opacity || '0') < 0.3) continue;
      const i = b.querySelector('.tl-stop__icon').getBoundingClientRect();
      const n = b.querySelector('.tl-stop__name').getBoundingClientRect();
      if (i.right < 0 || i.left > innerWidth) continue;
      out.push({
        id: b.dataset.stop,
        iconBottom: +(hair - i.bottom).toFixed(1), // > 0: the mark is above the line
        nameTop: +(n.top - hair).toFixed(1),       // > 0: the name is below it
        offset: +Math.abs((i.left + i.right) / 2 - (n.left + n.right) / 2).toFixed(1),
        text: b.textContent.trim(),
        hasIcon: Boolean(b.querySelector('.tl-stop__icon svg')),
        iconHidden: b.querySelector('.tl-stop__icon').getAttribute('aria-hidden') === 'true',
      });
    }
    const needle = document.querySelector('.tl-bar__needle').getBoundingClientRect();
    const centre = [...document.querySelectorAll('.tl-stop')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.left < innerWidth / 2 && r.right > innerWidth / 2 && parseFloat(b.style.opacity || '0') > 0.5;
    });
    const gap = centre ? needle.top - centre.querySelector('.tl-stop__icon').getBoundingClientRect().bottom : null;
    const nameGap = centre ? centre.querySelector('.tl-stop__name').getBoundingClientRect().top - needle.bottom : null;
    return { labels: out, needleGap: gap, needleNameGap: nameGap };
  });
}

/**
 * Clicks a label and catches the FLIP on its first frame: every animation paused at 0, and
 * each part of the title compared with the part of the label it flew from.
 */
function flipFirstFrame(page, id) {
  return page.evaluate((stop) => {
    const b = document.querySelector(`.tl-stop[data-stop="${stop}"]`);
    const parts = [b.querySelector('.tl-stop__icon'), b.querySelector('.tl-stop__name')].map((el) => el.getBoundingClientRect());
    b.click();
    const anims = document.getAnimations();
    anims.forEach((a) => { a.pause(); a.currentTime = 0; });
    const faces = [document.querySelector('.cr-title__icon').lastElementChild, document.querySelector('.cr-title__name').lastElementChild];
    const flying = faces.map((f) => f.getAnimations().length);
    const now = faces.map((f) => f.getBoundingClientRect());
    anims.forEach((a) => a.play());
    const cmp = parts.map((p, i) => ({
      dx: +Math.abs((p.left + p.right) / 2 - (now[i].left + now[i].right) / 2).toFixed(2),
      dy: +Math.abs((p.top + p.bottom) / 2 - (now[i].top + now[i].bottom) / 2).toFixed(2),
      dh: +(now[i].height / p.height).toFixed(3),
    }));
    return { flying, cmp, name: faces[1].textContent };
  }, id);
}

/**
 * Closes the open team and catches the flight home on its last frame (paused at its end),
 * to compare later with where the label really comes to rest.
 */
function closeLastFrame(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const main = document.querySelector('main.careers');
    const mo = new MutationObserver(() => {
      if (main.classList.contains('is-open')) return;
      mo.disconnect();
      const faces = [document.querySelector('.cr-title__icon').lastElementChild, document.querySelector('.cr-title__name').lastElementChild];
      const anims = faces.flatMap((f) => f.getAnimations());
      anims.forEach((a) => { a.pause(); a.currentTime = a.effect.getComputedTiming().endTime - 1; });
      const rects = faces.map((f) => {
        const r = f.getBoundingClientRect();
        return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, h: r.height };
      });
      anims.forEach((a) => a.play());
      resolve({ rects, flew: anims.length });
    });
    mo.observe(main, { attributes: true, attributeFilter: ['class'] });
    document.querySelector('.tl-close').click();
  }));
}

const labelPartRects = (page, id) => page.evaluate((stop) => {
  const b = document.querySelector(`.tl-stop[data-stop="${stop}"]`);
  return [b.querySelector('.tl-stop__icon'), b.querySelector('.tl-stop__name')].map((el) => {
    const r = el.getBoundingClientRect();
    return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, h: r.height };
  });
}, id);

const NEW_ROLE = {
  id: 'job-design-09', slug: 'product-designer', previousSlugs: [], title: 'Product Designer', domain: 'software', teamName: 'Rider app',
  location: 'Okhla, New Delhi', employmentType: 'full-time', workMode: 'hybrid', experience: { min: 2, max: 4 }, openings: 1,
  summary: 'Shape how riders swap, pay and find a station.', description: 'Design the rider app.', aboutTeamAndRole: '',
  responsibilities: ['Own flows end to end'], experienceAndQualifications: ['Shipped mobile work'], mustHaveCompetencies: ['Figma'],
  niceToHave: [], screeningQuestions: [], resumeRequired: true, featured: false, sortOrder: -1,
  publishedAt: '2026-10-08T05:00:00.000Z', updatedAt: '2026-10-08T05:00:00.000Z', closesAt: null, publicVersion: 1,
};

/** A fresh document from Paddock, now, rather than at the next minute's revalidation. */
const refresh = (page) => page.evaluate(() => window.gridCareers.refresh().then(() => true));

try {
  // ================================================================ the tape, at both sizes
  for (const [vpName, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await reset();
    const { page, problems } = await open(`${SITE}/careers.html`, { viewport });
    await settled(page);

    const ids = await stopIds(page);
    report(`${vpName} tape: one stop per team with roles, in Paddock's order, then the open application`,
      JSON.stringify(ids) === JSON.stringify([...TEAMS, 'open-application']), JSON.stringify(ids), problems);

    const tabs = await page.evaluate(() => [...document.querySelectorAll('.tl-stop')].map((b) => ({
      role: b.getAttribute('role'),
      controls: Boolean(document.getElementById(b.getAttribute('aria-controls'))),
      panelRole: document.getElementById(b.getAttribute('aria-controls'))?.getAttribute('role'),
      name: b.querySelector('.tl-stop__name').textContent,
      label: b.getAttribute('aria-label'),
    })));
    report(`${vpName} tape: each label is a tab with a text name, controlling its tabpanel`,
      tabs.every((t) => t.role === 'tab' && t.controls && t.panelRole === 'tabpanel' && t.name && t.label.startsWith(t.name)), JSON.stringify(tabs.map((t) => t.label)));

    const m = await measureLabels(page);
    const ok = m.labels.length >= 2 && m.labels.every((l) => l.iconBottom > 4 && l.nameTop > 4 && l.offset < 1.5 && l.hasIcon && l.iconHidden);
    report(`${vpName} tape: every label's mark is above the hairline and its name below it, centred`, ok,
      m.labels.map((l) => `${l.id} mark ${l.iconBottom}px above, name ${l.nameTop}px below`).join('; '));
    report(`${vpName} tape: the needle never reaches the mark (or the name) under it`, m.needleGap > 2 && m.needleNameGap > 2,
      `mark ${m.needleGap?.toFixed(1)}px above the needle, name ${m.needleNameGap?.toFixed(1)}px below`);

    const intro = await page.evaluate(() => ({
      count: document.querySelector('[data-intro-count]').textContent,
      title: document.querySelector('[data-intro-title]').textContent,
      peek: document.querySelector('.tl-peek__text').textContent,
    }));
    report(`${vpName} overview: the intro, the count of roles and teams, the peek`, intro.count === '5 open roles across 3 teams' && intro.title && /Embedded Firmware Engineer/.test(intro.peek), JSON.stringify(intro));

    // Open: the two parts fly separately, starting exactly on the label.
    const f = await flipFirstFrame(page, 'electronics');
    const flipOk = f.flying.every((n) => n > 0) && f.cmp.every((c) => c.dx < 2 && c.dy < 2 && Math.abs(c.dh - 1) < 0.04);
    report(`${vpName} open: the mark and the name each fly from their place on the label into the title (FLIP)`, flipOk, JSON.stringify(f));
    await settled(page);
    const opened = await page.evaluate(() => ({
      open: document.querySelector('main').classList.contains('is-open'),
      hash: location.hash,
      title: document.querySelector('.cr-title__name').textContent,
      theme: document.querySelector('.tl-theme').textContent,
      cards: document.querySelectorAll('#team-electronics .cr-role').length,
      selected: document.querySelector('.tl-stop[data-stop="electronics"]').getAttribute('aria-selected'),
      lifted: parseFloat(document.querySelector('.tl-stop[data-stop="electronics"]').style.opacity),
      next: document.querySelector('#team-electronics .tl-next')?.dataset.stop,
    }));
    report(`${vpName} open: the team's title, its roles as cards, #electronics, the label lifted off the tape`,
      opened.open && opened.hash === '#electronics' && opened.title === 'Electronics' && opened.theme === '2 open roles'
      && opened.cards === 2 && opened.selected === 'true' && opened.lifted === 0 && opened.next === 'software', JSON.stringify(opened));

    // Switch: the title rolls over, whole words.
    await page.$eval('.tl-stop[data-stop="software"]', (b) => b.click());
    await sleep(380);
    const rolling = await page.evaluate(() => ({ faces: [...document.querySelector('.cr-title__name').children].map((x) => x.textContent), cls: document.querySelector('.cr-title__name').className }));
    await settled(page);
    const after = await page.evaluate(() => ({ faces: [...document.querySelector('.cr-title__name').children].map((x) => x.textContent), hash: location.hash }));
    report(`${vpName} switch: the title rolls from one team's name to the next`,
      JSON.stringify(rolling.faces) === '["Electronics","Software"]' && /is-rolling/.test(rolling.cls) && JSON.stringify(after.faces) === '["Software"]' && after.hash === '#software',
      JSON.stringify({ rolling, after }));

    // Close: the parts fly home and land exactly where the label rests.
    const home = await closeLastFrame(page);
    await settled(page, { extra: 900 });
    const rest = await labelPartRects(page, 'software');
    const d = home.rects.map((r, i) => ({ dx: +Math.abs(r.cx - rest[i].cx).toFixed(1), dy: +Math.abs(r.cy - rest[i].cy).toFixed(1), dh: +(r.h / rest[i].h).toFixed(3) }));
    const closed = await page.evaluate(() => ({ open: document.querySelector('main').classList.contains('is-open'), hash: location.hash, lift: parseFloat(document.querySelector('.tl-stop[data-stop="software"]').style.opacity) }));
    report(`${vpName} close: the title flies home onto the label (title.rest), and the label takes over`,
      home.flew >= 2 && d.every((x) => x.dx < 2.5 && x.dy < 2.5 && Math.abs(x.dh - 1) < 0.05) && !closed.open && closed.hash === '' && closed.lift > 0.9,
      JSON.stringify({ d, closed }));
    await page.close();
  }

  // ================================================================ #team, history, and a touch drag
  {
    await reset();
    const { page, problems } = await open(`${SITE}/careers.html#operations`, { viewport: PHONE });
    await settled(page);
    const deep = await page.evaluate(() => ({ open: window.gridCareersPage.tape.state.open, title: document.querySelector('.cr-title__name').textContent }));
    report('#operations: arrives with that team open', deep.open === 'operations' && deep.title === 'Operations', JSON.stringify(deep), problems);
    await page.close();

    const p2 = await open(`${SITE}/careers.html`, { viewport: PHONE });
    await settled(p2.page);
    await p2.page.$eval('.tl-stop[data-stop="software"]', (b) => b.click());
    await settled(p2.page);
    const pushed = await p2.page.evaluate(() => location.hash);
    await p2.page.goBack();
    await settled(p2.page, { extra: 900 });
    const back = await p2.page.evaluate(() => ({ open: window.gridCareersPage.tape.state.open, hash: location.hash }));
    report('history: opening a team is a history entry, and Back closes it', pushed === '#software' && back.open === null && back.hash === '', JSON.stringify({ pushed, back }), p2.problems);

    // A finger drags the tape a little over a stop's width to the left: it moves on a stop.
    const before = await p2.page.evaluate(() => window.gridCareersPage.tape.state.focus);
    const box = await p2.page.$eval('.tl-bar__inner', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const cdp = await p2.page.createCDPSession();
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: box.y }] });
    await touch('touchStart', box.x);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', box.x - i * 15);
      await sleep(16);
    }
    await touch('touchEnd', box.x - 180);
    await settled(p2.page, { extra: 1200 });
    const afterDrag = await p2.page.evaluate(() => window.gridCareersPage.tape.state.focus);
    const order = [...TEAMS, 'open-application'];
    const still = await p2.page.evaluate(() => window.gridCareersPage.tape.state.open === null && !document.querySelector('main').classList.contains('is-dragging'));
    report('phone: a touch drag moves the tape on along the teams, and it settles on one', order.indexOf(afterDrag) > order.indexOf(before) && still, `${before} -> ${afterDrag}`);
    await p2.page.close();
  }

  // ================================================================ reactivity
  for (const [vpName, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await reset();
    const { page, problems } = await open(`${SITE}/careers.html#software`, { viewport });
    await settled(page);
    const tapeBefore = await page.evaluate(() => { window.__tape = window.gridCareersPage.tape; window.__label = document.querySelector('.tl-stop[data-stop="software"]'); return true; });
    // Read the second card: scroll it to just under the pinned tape.
    await page.evaluate(() => {
      const c = document.querySelectorAll('#team-software .cr-role')[1];
      const bar = document.querySelector('.tl-bar__inner').getBoundingClientRect().bottom;
      window.scrollBy(0, c.getBoundingClientRect().top - (bar + 70));
    });
    await sleep(500);
    const where = () => page.evaluate(() => ({
      y: Math.round(window.scrollY),
      cards: [...document.querySelectorAll('#team-software .cr-role:not(.cr-role--ghost)')].map((c) => [c.dataset.id, +c.getBoundingClientRect().top.toFixed(1)]),
    }));
    const a = await where();
    await setMock({ add: { jobs: [NEW_ROLE] } });
    await refresh(page);
    await sleep(80);
    const animating = await page.evaluate(() => document.querySelector('#team-software .cr-role[data-id="job-design-09"]')?.getAnimations().length || 0);
    await sleep(900);
    const b = await where();
    const readA = a.cards.find((c) => c[0] === 'job-mobile-04');
    const readB = b.cards.find((c) => c[0] === 'job-mobile-04');
    report(`${vpName} reactive: a role added above the reader arrives (FLIP) and the card being read stays put`,
      tapeBefore && b.cards.length === 3 && b.cards[0][0] === 'job-design-09' && Math.abs(readB[1] - readA[1]) < 2 && animating > 0,
      JSON.stringify({ a, b, animating }), problems);

    await setMock({ close: ['job-fullstack-03'] });
    await refresh(page);
    await sleep(150);
    const ghost = await page.evaluate(() => Boolean(document.querySelector('#team-software .cr-role--ghost')));
    await sleep(900);
    const c = await where();
    report(`${vpName} reactive: a role closed fades where it stood, with no jump of the page`,
      c.cards.length === 2 && !c.cards.some((x) => x[0] === 'job-fullstack-03') && c.y === b.y && ghost,
      JSON.stringify({ c, ghost }));

    const doc = await careersDoc();
    doc.domains.push({ key: 'design', label: 'Design', icon: 'palette', blurb: 'How GridX looks, feels and reads.', order: 2.5, openCount: 1 });
    doc.jobs.push({ ...NEW_ROLE, id: 'job-brand-10', slug: 'brand-designer', title: 'Brand Designer', domain: 'design', teamName: 'Brand', sortOrder: 0 });
    await setMock({ careers: doc });
    await refresh(page);
    await sleep(1200);
    const grown = await page.evaluate(() => ({
      ids: [...document.querySelectorAll('.tl-stop:not([aria-hidden="true"])')].map((x) => x.dataset.stop),
      same: window.__tape === window.gridCareersPage.tape && window.__label === document.querySelector('.tl-stop[data-stop="software"]'),
      panel: Boolean(document.getElementById('team-design')),
      open: window.gridCareersPage.tape.state.open,
      y: Math.round(window.scrollY),
      next: document.querySelector('#team-software .tl-next').dataset.stop,
    }));
    report(`${vpName} reactive: a new team joins the tape in its place (setStops, the same tape and labels)`,
      JSON.stringify(grown.ids) === '["electronics","software","design","operations","open-application"]' && grown.same && grown.panel
      && grown.open === 'software' && grown.y === c.y && grown.next === 'design', JSON.stringify(grown));

    // The open team loses its last roles: it closes, gracefully.
    await setMock({ close: ['job-design-09', 'job-mobile-04'] });
    await refresh(page);
    await page.waitForFunction(() => window.gridCareersPage.tape.state.open === null, { timeout: 8000 }).catch(() => {});
    await settled(page, { extra: 1200 });
    const gone = await page.evaluate(() => ({
      open: window.gridCareersPage.tape.state.open,
      ids: [...document.querySelectorAll('.tl-stop')].map((x) => x.dataset.stop),
      hash: location.hash,
      count: document.querySelector('[data-intro-count]').textContent,
    }));
    report(`${vpName} reactive: the open team emptied closes and leaves the tape`,
      gone.open === null && !gone.ids.includes('software') && gone.hash === '' && gone.count === '4 open roles across 3 teams', JSON.stringify(gone));
    await page.close();
  }

  // ---- reduced motion: the same changes, made at once; and focusOn() in the overview
  {
    await reset();
    const { page, problems } = await open(`${SITE}/careers.html#software`, { viewport: PHONE, motion: 'reduce' });
    await settled(page);
    await setMock({ add: { jobs: [NEW_ROLE] } });
    await refresh(page);
    await sleep(60);
    const r = await page.evaluate(() => {
      const li = document.querySelector('#team-software .cr-role[data-id="job-design-09"]');
      return { there: Boolean(li), shown: li ? getComputedStyle(li).opacity : null, anims: li ? li.getAnimations().length : -1, cards: document.querySelectorAll('#team-software .cr-role').length };
    });
    report('reduced motion: a new role is simply there, with no animation', r.there && r.anims === 0 && r.cards === 3 && Number(r.shown) > 0.5, JSON.stringify(r), problems);
    await page.close();

    await reset();
    const p2 = await open(`${SITE}/careers.html`, { viewport: DESKTOP });
    await settled(p2.page);
    const moved = await p2.page.evaluate(() => window.gridCareersPage.tape.focusOn('operations'));
    await settled(p2.page, { extra: 1200 });
    const f = await p2.page.evaluate(() => ({ focus: window.gridCareersPage.tape.state.focus, open: window.gridCareersPage.tape.state.open, peek: document.querySelector('.tl-peek__text').textContent, tab: document.querySelector('.tl-stop[data-stop="operations"]').tabIndex }));
    report('focusOn: centres a team in the overview without opening it, and the peek follows', moved && f.focus === 'operations' && f.open === null && f.peek === 'Swap Station Technician' && f.tab === 0, JSON.stringify(f), p2.problems);
    await p2.page.close();
  }

  // ---- the open role closes under its sheet; applications paused
  {
    await reset();
    const { page, problems } = await open(`${SITE}/careers.html?role=embedded-firmware-engineer`, { viewport: PHONE });
    await page.waitForFunction(() => document.getElementById('role-sheet')?.open, { timeout: 8000 });
    await settled(page);
    const t0 = await page.$eval('#rs-title', (h) => h.textContent);
    await setMock({ close: ['job-firmware-01'] });
    await refresh(page);
    await sleep(500);
    const t1 = await page.evaluate(() => ({ title: document.getElementById('rs-title').textContent, rows: [...document.querySelectorAll('.rs__other-title')].map((x) => x.textContent), primary: document.querySelector('[data-rs-primary]').textContent }));
    report('reactive: the role open in its sheet closes, and the sheet says so, with what is still open',
      t0 === 'Embedded Firmware Engineer' && t1.title === 'This role has closed.' && JSON.stringify(t1.rows) === '["Power Electronics Intern"]' && t1.primary === 'Send an open application',
      JSON.stringify({ t0, t1 }), problems);

    await reset();
    const doc = await careersDoc();
    await setMock({ careers: { ...doc, applicationsPaused: true } });
    await refresh(page);
    await page.evaluate(() => window.gridCareersPage.openRole('power-electronics-intern'));
    await sleep(600);
    const paused = await page.evaluate(() => ({
      apply: document.querySelector('[data-rs-primary]').getAttribute('aria-disabled'),
      notice: document.querySelector('.rs__notice-title')?.textContent,
      status: document.querySelector('[data-intro-status]').textContent,
      panel: !document.querySelector('#team-electronics .cr-paused').hidden,
      open: document.querySelector('.cr-panel--open .cr-pill').getAttribute('aria-disabled'),
    }));
    report('paused: a quiet banner, and every Apply disabled',
      paused.apply === 'true' && /paused/.test(paused.notice) && /paused/.test(paused.status) && paused.panel && paused.open === 'true', JSON.stringify(paused));
    await page.close();
  }

  // ================================================================ deep links
  {
    const cases = [
      ['?role=', 'embedded-firmware-engineer', 'Embedded Firmware Engineer', 'role=embedded-firmware-engineer'],
      ['a previous slug', 'firmware-engineer', 'Embedded Firmware Engineer', 'role=embedded-firmware-engineer'],
      ['?job= (the old site)', null, 'Full Stack Developer', 'role=full-stack-developer'],
      ['a closed role', 'battery-test-engineer', 'This role has closed.', null],
      ['an unknown role', 'no-such-role-here', 'This role is no longer listed.', null],
      ['a mistyped address', 'X', 'This role is no longer listed.', null],
    ];
    for (const [label, slug, want, query] of cases) {
      await reset();
      const seq = await lastSeq();
      const url = slug ? `${SITE}/careers.html?role=${slug}` : `${SITE}/careers.html?job=job-fullstack-03`;
      const { page, problems } = await open(url, { viewport: DESKTOP });
      await page.waitForFunction((w) => document.getElementById('rs-title')?.textContent === w, { timeout: 8000 }, want).catch(() => {});
      await settled(page);
      const s = await page.evaluate(() => ({
        open: document.getElementById('role-sheet').open,
        title: document.getElementById('rs-title')?.textContent,
        team: window.gridCareersPage.tape?.state.open,
        search: location.search,
        rows: document.querySelectorAll('.rs__other').length,
      }));
      let ok = s.open && s.title === want && (!query || s.search.includes(query));
      if (label === 'a closed role') ok = ok && s.team === 'electronics' && s.rows === 2;
      if (label === 'an unknown role') ok = ok && s.rows === 5;
      if (label === '?role=') {
        // role_view, as Paddock receives it (the beacon goes on the way out).
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await sleep(400);
        const events = (await logSince(seq)).filter((e) => /\/event$/.test(e.path)).flatMap((e) => (e.body && e.body.accepted) || []);
        const names = events.map((e) => `${e.name}${e.props && e.props.slug ? `:${e.props.slug}` : ''}`);
        report('analytics: careers_view once, and role_view with the role\'s slug', names.filter((n) => n === 'careers_view').length === 1 && names.includes('role_view:embedded-firmware-engineer'), JSON.stringify(names));
        ok = ok && s.team === 'electronics';
      }
      report(`deep link, ${label}: ${want}`, ok, JSON.stringify(s), problems);

      if (label === '?role=') {
        await page.keyboard.press('Escape');
        await sleep(900);
        const after = await page.evaluate(() => ({ open: document.getElementById('role-sheet').open, search: location.search, hash: location.hash, team: window.gridCareersPage.tape.state.open }));
        report('deep link: closing the sheet clears ?role and leaves the team open behind it', !after.open && after.search === '' && after.hash === '#electronics' && after.team === 'electronics', JSON.stringify(after));
      }
      await page.close();
    }

    await reset();
    const { page, problems } = await open(`${SITE}/careers.html?apply=open`, { viewport: PHONE });
    await page.waitForFunction(() => document.getElementById('apply-sheet')?.open, { timeout: 8000 }).catch(() => {});
    await sleep(800);
    const s = await page.evaluate(() => ({
      open: document.getElementById('apply-sheet')?.open,
      eyebrow: document.querySelector('#apply-sheet [data-ref="eyebrow"]')?.textContent,
      search: location.search,
    }));
    report('deep link, ?apply=open: the open application sheet', s.open && s.eyebrow === 'Open application' && s.search === '', JSON.stringify(s), problems);
    await page.close();
  }

  // ================================================================ keyboard
  {
    await reset();
    const { page, problems } = await open(`${SITE}/careers.html`, { viewport: DESKTOP });
    await settled(page);
    await page.focus('.tl-stop[data-stop="electronics"]');
    await page.keyboard.press('ArrowRight');
    await settled(page);
    const k1 = await page.evaluate(() => ({ focus: document.activeElement.dataset.stop, tape: window.gridCareersPage.tape.state.focus, tabindex: [...document.querySelectorAll('.tl-stop')].map((b) => b.tabIndex).join('') }));
    await page.keyboard.press('Enter');
    await settled(page);
    const k2 = await page.evaluate(() => ({ open: window.gridCareersPage.tape.state.open, focus: document.activeElement.dataset.stop }));
    // Tab on into the panel, to the first card.
    let reached = '';
    for (let i = 0; i < 6 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => (document.activeElement.classList.contains('cr-card__hit') ? document.activeElement.textContent : ''));
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('role-sheet').open, { timeout: 5000 }).catch(() => {});
    await sleep(700);
    const k3 = await page.evaluate(() => ({ sheet: document.getElementById('role-sheet').open, inside: document.getElementById('role-sheet').contains(document.activeElement) }));
    await page.keyboard.press('Escape');
    await sleep(900);
    const k4 = await page.evaluate(() => ({ sheet: document.getElementById('role-sheet').open, team: window.gridCareersPage.tape.state.open, focus: document.activeElement.textContent }));
    await page.keyboard.press('Escape');
    await settled(page, { extra: 900 });
    const k5 = await page.evaluate(() => ({ team: window.gridCareersPage.tape.state.open, focus: document.activeElement.dataset.stop }));
    report('keyboard: arrows move along the tablist, Enter opens, a card opens its sheet, Escape closes the sheet then the team, focus handed back',
      k1.focus === 'software' && k1.tape === 'software' && k1.tabindex === '-10-1-1' && k2.open === 'software'
      && reached === 'Full Stack Developer' && k3.sheet && k3.inside && !k4.sheet && k4.team === 'software' && k4.focus === 'Full Stack Developer'
      && k5.team === null && k5.focus === 'software',
      JSON.stringify({ k1, k2, reached, k3, k4, k5 }), problems);
    await page.close();
  }

  // ================================================================ states
  // ---- loading: stand-ins where the labels will land
  for (const [vpName, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await reset();
    await setMock({ modes: { latencyMs: 2500 } });
    const { page, problems } = await open(`${SITE}/careers.html`, { viewport, noSnapshot: true });
    await sleep(600);
    const skel = await page.evaluate(() => {
      const main = document.querySelector('main.careers');
      const s = document.querySelector('.cr-skel__stop--near');
      const before = getComputedStyle(s, '::before');
      const sr = s.getBoundingClientRect();
      const inner = document.querySelector('.tl-bar__inner').getBoundingClientRect();
      return {
        loading: main.classList.contains('is-loading'),
        shown: getComputedStyle(document.querySelector('.cr-skel')).opacity,
        // The stand-in mark's box at the lens's swell, centred on the stop.
        x: sr.left,
        iconBottom: inner.top + parseFloat(getComputedStyle(main).getPropertyValue('--hairline')) - (parseFloat(getComputedStyle(main).getPropertyValue('--stop-gap-above')) * 1.34),
        hairY: inner.top + parseFloat(getComputedStyle(main).getPropertyValue('--hairline')),
        horizon: getComputedStyle(main).getPropertyValue('--horizon-y'),
        before: before.width,
      };
    });
    await settled(page);
    const real = await page.evaluate(() => {
      const main = document.querySelector('main.careers');
      const b = document.querySelector('.tl-stop[data-stop="electronics"]');
      const i = b.querySelector('.tl-stop__icon').getBoundingClientRect();
      const inner = document.querySelector('.tl-bar__inner').getBoundingClientRect();
      return { x: (i.left + i.right) / 2, iconBottom: i.bottom, hairY: inner.top + parseFloat(getComputedStyle(main).getPropertyValue('--hairline')), horizon: getComputedStyle(main).getPropertyValue('--horizon-y'), loading: main.classList.contains('is-loading') };
    });
    report(`${vpName} loading: stand-in labels on the horizon, exactly where the first label lands`,
      skel.loading && skel.shown === '1' && Math.abs(skel.x - real.x) < 1 && Math.abs(skel.hairY - real.hairY) < 1 && Math.abs(skel.iconBottom - real.iconBottom) < 1.5
      && skel.horizon === real.horizon && !real.loading, JSON.stringify({ skel, real }), problems);
    await page.close();
  }

  // ---- the list fails with nothing to show: a retry, and it recovers
  {
    await reset();
    await setMock({ modes: { careers: 'error' } });
    const { page, problems } = await open(`${SITE}/careers.html`, { viewport: PHONE, noSnapshot: true });
    await page.waitForFunction(() => document.querySelector('main').classList.contains('is-failed'), { timeout: 8000 }).catch(() => {});
    const f = await page.evaluate(() => ({ failed: document.querySelector('main').classList.contains('is-failed'), text: document.querySelector('[data-notice]').textContent, retry: Boolean(document.querySelector('[data-notice] [data-retry]')) }));
    await setMock({ modes: { careers: 'ok' } });
    await page.$eval('[data-notice] [data-retry]', (b) => b.click());
    await settled(page);
    const r = await page.evaluate(() => ({ failed: document.querySelector('main').classList.contains('is-failed'), stops: document.querySelectorAll('.tl-stop').length, notice: document.querySelector('[data-notice]').hidden }));
    report('failed, no copy: says so with a retry, and Try again brings the teams in', f.failed && /could not load/.test(f.text) && f.retry && !r.failed && r.stops === 4 && r.notice,
      JSON.stringify({ f, r }), problems.filter((p) => !/500/.test(p)));
    await page.close();
  }

  // ---- the list fails with the build's copy: the copy stays, with a quiet retry
  {
    await reset();
    await setMock({ modes: { careers: 'error' } });
    const { page, problems } = await open(`${SITE}/careers.html`, { viewport: DESKTOP });
    await page.waitForFunction(() => document.querySelector('[data-intro-status] [data-retry]'), { timeout: 8000 }).catch(() => {});
    const s = await page.evaluate(() => ({ stops: document.querySelectorAll('.tl-stop').length, status: document.querySelector('[data-intro-status]').textContent, source: window.gridCareers.get().source }));
    report('failed, with the build\'s copy: the teams stay up, with a quiet retry', s.stops === 4 && s.source === 'snapshot' && /could not check/.test(s.status), JSON.stringify(s), problems);
    await page.close();
  }

  // ---- no open roles, and the roles coming back
  {
    await reset();
    const doc = await careersDoc();
    await setMock({ careers: { ...doc, jobs: [] } });
    const { page, problems } = await open(`${SITE}/careers.html`, { viewport: PHONE, noSnapshot: true });
    await page.waitForFunction(() => document.querySelector('main').classList.contains('is-empty'), { timeout: 8000 }).catch(() => {});
    await sleep(500);
    const e = await page.evaluate(() => ({
      empty: document.querySelector('main').classList.contains('is-empty'),
      title: document.querySelector('[data-intro-title]').textContent,
      apply: Boolean(document.querySelector('[data-notice] [data-open-apply]')),
      mail: document.querySelector('[data-notice] a[href^="mailto:"]')?.getAttribute('href'),
      tape: getComputedStyle(document.querySelector('.tl-bar')).visibility,
    }));
    report('empty: a warm word, the open application and the careers email, no tape', e.empty && e.title === 'No open roles right now.' && e.apply && e.mail === 'mailto:info@gridxenergy.in' && e.tape === 'hidden', JSON.stringify(e), problems);
    await reset();
    await refresh(page);
    await settled(page);
    const back = await page.evaluate(() => ({ empty: document.querySelector('main').classList.contains('is-empty'), stops: document.querySelectorAll('.tl-stop').length, title: document.querySelector('[data-intro-title]').textContent }));
    report('empty: roles opening while the page is up bring the tape in', !back.empty && back.stops === 4 && back.title === 'Build the energy India rides on.', JSON.stringify(back));
    await page.close();
  }

  // ---- no JavaScript: the build's plain list
  {
    await reset();
    const { page } = await open(`${SITE}/careers.html`, { viewport: PHONE, js: false });
    const n = await page.evaluate(() => ({
      links: [...document.querySelectorAll('.cr-static a.cr-static__role')].map((a) => a.getAttribute('href')),
      teams: [...document.querySelectorAll('.cr-static__name')].map((h) => h.textContent),
      shown: getComputedStyle(document.querySelector('.cr-static')).display,
      tape: getComputedStyle(document.querySelector('.tl-bar')).display,
    }));
    const want = FIXTURE.jobs.map((j) => `jobs/${j.slug}/`).sort();
    report('no JavaScript: every team and role, each role a link to its own page, the tape hidden',
      JSON.stringify(n.links.slice().sort()) === JSON.stringify(want) && JSON.stringify(n.teams) === '["Electronics","Software","Operations"]' && n.shown === 'block' && n.tape === 'none', JSON.stringify(n));
    await page.close();
  }
} catch (err) {
  failed++;
  console.log(`FAIL  the check itself: ${err.stack || err}`);
} finally {
  await browser.close();
  server.close();
  if (mock) await mock.close();
  if (!process.argv.includes('--keep')) fs.rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept ${scratch}`);
}

console.log(failed ? `\n${failed} careers page check(s) failed, ${passed} passed` : `\ncareers page: all ${passed} checks pass`);
process.exitCode = failed ? 1 : 0;
