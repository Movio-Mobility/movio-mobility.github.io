#!/usr/bin/env node
/*
 * The careers pages in a real browser, against Paddock played by the mock:
 *
 *   apply      validation (answers.* included, and Paddock's own 400s in both shapes), the
 *              draft brought back, the keyboard on a 390x844 phone, a swipe refused while
 *              the form holds work, 201, the upload's progress and Cancel, 409, 410 turned
 *              into an open application, 413, 415, 429, and the honeypot left alone
 *   interview  lookup, book, a time taken first (409), reschedule, cancel, too late (422),
 *              none of these work, expired, every bad link alike, and the token gone from
 *              the address
 *   role page  the closed-since-build and paused banners, and the docked Apply
 *
 *   npm run check:careers
 *
 * It builds the site with the mock as Paddock (so the pages run under their real CSP, and
 * a violation fails the check), serves the build, and drives headless Chrome. The pages
 * reach Paddock at http://localhost:3000 (gridx-api.js on localhost), so the mock listens
 * there; if something else holds the port, a mock already there is used, and anything
 * else is an error.
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
// The site's port is whatever the system has free: a fixed one can be held, on 127.0.0.1
// alone, by another server, and then "localhost" quietly reaches that one instead.
let SITE = '';
let ROLE = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function report(label, ok, detail = '', problems = []) {
  const pass = ok && !problems.length;
  if (!pass) failed++;
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
const logSince = async (seq) => (await ctl(`/__mock/log?since=${seq}`)).entries;
const lastSeq = async () => {
  const all = (await ctl('/__mock/log?since=0')).entries;
  return all.length ? all[all.length - 1].seq : 0;
};

const scratch = fs.mkdtempSync(path.join(process.env.CHECK_TMP || os.tmpdir(), 'gridx-careers-'));
const out = path.join(scratch, 'site');
await reset();
const built = await new Promise((resolve) => {
  const env = { ...process.env, CAREERS_API: `${PADDOCK}/api/public/website/careers`, CAREERS_SNAPSHOT: `${PADDOCK}/no-snapshot.json` };
  delete env.GITHUB_OUTPUT;
  const child = spawn(process.execPath, [path.join(REPO, 'tools/build.mjs'), '--out', out], { cwd: REPO, env });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('close', (status) => resolve({ status, log }));
});
if (built.status !== 0 || !fs.existsSync(path.join(out, 'jobs/embedded-firmware-engineer/index.html'))) {
  console.error(`The build failed:\n${built.log.slice(-1500)}`);
  process.exit(1);
}

// Resumes: a real PDF, a big one (slow uploads, the 413), a fake PDF, a zip that is not Word.
const files = {
  pdf: path.join(scratch, 'resume.pdf'),
  slow: path.join(scratch, 'long-resume.pdf'),
  big: path.join(scratch, 'huge-resume.pdf'),
  fake: path.join(scratch, 'not-really.pdf'),
  xlsx: path.join(scratch, 'sheet.docx'),
};
fs.writeFileSync(files.pdf, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4000, 0x20), Buffer.from('\n%%EOF\n')]));
fs.writeFileSync(files.slow, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1600 * 1024, 0x20)]));
fs.writeFileSync(files.big, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10.5 * 1024 * 1024, 0x20)]));
fs.writeFileSync(files.fake, 'Just some text, not a PDF at all.');
fs.writeFileSync(files.xlsx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml xl/workbook.xml'), Buffer.alloc(500, 0x20)]));

const server = await serve({ root: out, port: 0, quiet: true });
SITE = `http://localhost:${server.address().port}`;
ROLE = `${SITE}/jobs/embedded-firmware-engineer/`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS, protocolTimeout: 180000 });

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/** A page, with every page error and CSP violation collected. */
async function open(url, { viewport = PHONE, before } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(t)) problems.push(`CSP: ${t.slice(0, 160)}`);
    else if (m.type() === 'error' && !/Failed to load resource|favicon/i.test(t)) problems.push(t.slice(0, 160));
  });
  // reCAPTCHA stays offline: the apply sheet is under test, not Google, whose frame logs things
  // of its own. Blocked, it is what an ad blocker does, and the application goes without a
  // token. Blocked below request interception, so a scenario's own interceptor still works.
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*://www.google.com/recaptcha/*', '*://www.gstatic.com/recaptcha/*'] });
  if (before) await before(page);
  await page.goto(url, { waitUntil: 'load' });
  return { page, problems };
}

const click = (page, sel) => page.$eval(sel, (el) => el.click());
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const viewIs = (page, v, timeout = 8000) => page.waitForFunction((want) => document.getElementById('apply-sheet')?.dataset.view === want, { timeout }, v);

async function setValue(page, sel, value) {
  await page.$eval(sel, (el, v) => {
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
const check = (page, sel) => page.$eval(sel, (el) => { if (!el.checked) el.click(); });

async function openSheetForm(page) {
  await page.waitForFunction(() => window.gridApply && window.gridCareers && window.gridCareers.get().data, { timeout: 10000 }).catch(async (err) => {
    const why = await page.evaluate(() => ({ url: location.href, apply: Boolean(window.gridApply), careers: Boolean(window.gridCareers), api: Boolean(window.gridxApi) }));
    throw new Error(`the page never got ready: ${JSON.stringify(why)}`);
  });
  await click(page, '.role__apply [data-role-apply]');
  await viewIs(page, 'intro');
  await click(page, '.apply__primary');
  await viewIs(page, 'form');
}

/** Everything the firmware role asks, filled the way a person would leave it. */
async function fillFirmware(page, { email = 'asha@example.com', resume = files.pdf } = {}) {
  await setValue(page, '#ap-firstName', 'Asha');
  await setValue(page, '#ap-lastName', 'Verma');
  await setValue(page, '#ap-email', email);
  await setValue(page, '#ap-phone', '98765 43210');
  await setValue(page, '#ap-city', 'New Delhi');
  await setValue(page, '#ap-whyGridX', 'I have spent two years on BMS firmware and want it on the road, in packs riders use.');
  await check(page, 'input[name="availability"][value="1m"]');
  await check(page, 'input[name="q-q1"][value="yes"]');
  await check(page, 'input[name="q-q2"][value="LFP"]');
  await setValue(page, '#ap-q-q3', 'github.com/asha/bms');
  await check(page, '#ap-consent');
  if (resume) {
    const input = await page.$('#ap-resume');
    await input.uploadFile(resume);
    await page.waitForFunction(() => !document.querySelector('[data-ref="chosen"]').hidden || document.querySelector('#ap-resume-err').textContent, { timeout: 8000 });
  }
}

/** Paddock ignores a form sent in under four seconds (the mock, three): wait like a person. */
async function sendWhenHuman(page) {
  await page.waitForFunction(() => true);
  await sleep(4200);
  await click(page, '.apply__primary');
}

const isBad = (page, name) => page.$eval(`[data-field="${name}"], [name="${name}"]`, (el) => Boolean((el.closest('.field') || el).classList.contains('is-bad'))).catch(() => false);
const lastApply = async (seq) => (await logSince(seq)).filter((e) => e.path.endsWith('/careers/apply') && e.method === 'POST').pop();

try {
  // ================================================================ apply
  // ---- validation, client side
  {
    await reset();
    const { page, problems } = await open(ROLE);
    await openSheetForm(page);
    await click(page, '.apply__primary');
    await sleep(300);
    const bad = {};
    for (const n of ['firstName', 'lastName', 'email', 'phone', 'city', 'resume', 'whyGridX', 'availability', 'answers.q1', 'answers.q2', 'answers.q3', 'consent']) bad[n] = await isBad(page, n);
    const hint = await text(page, '[data-ref="hint"]');
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    const want = Object.entries(bad).every(([n, b]) => (n === 'answers.q3' ? !b : b));
    report('apply: an empty form says what is missing, answers.* included', want && /highlighted/.test(hint) && focused === 'ap-firstName', JSON.stringify(bad), problems);

    await setValue(page, '#ap-phone', '98765 43210');
    const okPhone = !(await isBad(page, 'phone'));
    await setValue(page, '#ap-phone', '12345');
    await page.$eval('#ap-phone', (el) => el.blur());
    const badPhone = await isBad(page, 'phone');
    await setValue(page, '#ap-linkedinUrl', 'github.com/asha');
    await page.$eval('#ap-linkedinUrl', (el) => el.blur());
    const badLinked = /LinkedIn/.test(await text(page, '#ap-linkedinUrl-err'));
    await setValue(page, '#ap-whyGridX', 'Too short.');
    const whyMsg = await text(page, '#ap-whyGridX-err');
    const count = await text(page, '[data-ref="whyCount"]');
    report('apply: phone, LinkedIn and the why counter checked as Paddock checks them', okPhone && badPhone && badLinked && /more character/.test(whyMsg) && count === '10 / 3000', JSON.stringify({ okPhone, badPhone, badLinked, whyMsg, count }), problems);

    const input = await page.$('#ap-resume');
    await input.uploadFile(files.fake);
    await sleep(400);
    const fakeMsg = await text(page, '#ap-resume-err');
    await input.uploadFile(files.big);
    await sleep(600);
    const bigMsg = await text(page, '#ap-resume-err');
    await input.uploadFile(files.pdf);
    await sleep(400);
    const chosen = await page.$eval('[data-ref="chosen"]', (el) => !el.hidden && el.textContent.includes('resume.pdf'));
    report('apply: the resume is checked before upload (type by its bytes, size)', /real PDF/.test(fakeMsg) && /limit is 10 MB/.test(bigMsg) && chosen, `${fakeMsg} | ${bigMsg}`, problems);
    await page.close();
  }

  // ---- the draft, kept in this tab and brought back
  {
    await reset();
    const { page, problems } = await open(ROLE);
    await openSheetForm(page);
    await setValue(page, '#ap-firstName', 'Asha');
    await setValue(page, '#ap-email', 'asha@example.com');
    await setValue(page, '#ap-whyGridX', 'Batteries that tell you how they feel.');
    await check(page, 'input[name="q-q2"][value="LTO"]');
    await check(page, 'input[name="availability"][value="date"]');
    await setValue(page, '#ap-availableFrom', '2030-01-15');
    await check(page, '#ap-consent');
    const input = await page.$('#ap-resume');
    await input.uploadFile(files.pdf);
    await sleep(700);
    await page.keyboard.press('Escape');
    await sleep(700);
    const stored = await page.evaluate(() => sessionStorage.getItem('gridx.apply.draft.role:job-firmware-01') || '');
    await page.reload({ waitUntil: 'load' });
    await openSheetForm(page);
    const back = await page.evaluate(() => ({
      first: document.getElementById('ap-firstName').value,
      email: document.getElementById('ap-email').value,
      why: document.getElementById('ap-whyGridX').value,
      q2: (document.querySelector('input[name="q-q2"]:checked') || {}).value,
      from: document.getElementById('ap-availableFrom').value,
      dateShown: !document.querySelector('[data-ref="dateWrap"]').hidden,
      consent: document.getElementById('ap-consent').checked,
      file: !document.querySelector('[data-ref="chosen"]').hidden,
    }));
    const ok = back.first === 'Asha' && back.email === 'asha@example.com' && back.why.startsWith('Batteries') && back.q2 === 'LTO'
      && back.from === '2030-01-15' && back.dateShown && !back.consent && !back.file
      && !/consent|resume|company_website|talent/i.test(stored);
    report('apply: the draft comes back after a reload, without the file or the consent', ok, JSON.stringify(back), problems);
    await page.close();
  }

  // ---- the keyboard, on a 390x844 phone
  {
    await reset();
    const { page, problems } = await open(ROLE, {
      before: (p) => p.evaluateOnNewDocument(() => {
        // A visual viewport this check can shrink, as a phone's keyboard does.
        const vv = new EventTarget();
        let h = null;
        Object.defineProperties(vv, {
          width: { get: () => window.innerWidth },
          height: { get: () => (h === null ? window.innerHeight : h) },
          offsetTop: { get: () => 0 },
          offsetLeft: { get: () => 0 },
          pageTop: { get: () => window.scrollY },
          scale: { get: () => 1 },
        });
        Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
        window.__keyboard = (height) => {
          h = height;
          vv.dispatchEvent(new Event('resize'));
        };
      }),
    });
    await openSheetForm(page);
    await sleep(600);
    await page.$eval('#ap-whyGridX', (el) => el.focus({ preventScroll: true }));
    await page.evaluate(() => window.__keyboard(844 - 336));
    await sleep(900);
    const up = await page.evaluate(() => {
      const sheet = document.getElementById('apply-sheet').getBoundingClientRect();
      const scroller = document.querySelector('.apply__scroll').getBoundingClientRect();
      const field = document.getElementById('ap-whyGridX').closest('.field').getBoundingClientRect();
      return {
        typing: document.documentElement.classList.contains('is-typing'),
        top: Math.round(sheet.top),
        height: Math.round(sheet.height),
        inView: field.top >= scroller.top - 1 && field.bottom <= scroller.bottom + 1,
        field: [Math.round(field.top), Math.round(field.bottom)],
        scroller: [Math.round(scroller.top), Math.round(scroller.bottom)],
      };
    });
    await page.$eval('#ap-whyGridX', (el) => el.blur());
    await page.evaluate(() => window.__keyboard(844));
    await sleep(300);
    const down = await page.evaluate(() => document.documentElement.classList.contains('is-typing'));
    report('apply: with the keyboard up, the sheet fits above it and the field stays in view',
      up.typing && Math.abs(up.top) <= 1 && Math.abs(up.height - 508) <= 1 && up.inView && !down, JSON.stringify(up), problems);
    await page.close();
  }

  // ---- a swipe never throws away a half-filled form
  {
    await reset();
    const { page, problems } = await open(ROLE);
    await page.waitForFunction(() => window.gridApply && window.gridCareers.get().data);
    const cdp = await page.target().createCDPSession();
    const swipe = async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 260 }] });
      for (let y = 280; y <= 700; y += 60) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(900);
      return page.evaluate(() => document.getElementById('apply-sheet').open);
    };
    await click(page, '.role__apply [data-role-apply]');
    await viewIs(page, 'intro');
    await sleep(700);
    const cleanOpen = await swipe();
    await click(page, '.role__apply [data-role-apply]');
    await viewIs(page, 'intro');
    await click(page, '.apply__primary');
    await viewIs(page, 'form');
    await setValue(page, '#ap-firstName', 'Asha');
    await page.$eval('#ap-firstName', (el) => el.blur());
    await sleep(500);
    const dirtyOpen = await swipe();
    report('apply: a swipe closes the intro, never a form with work in it', !cleanOpen && dirtyOpen, `intro open after swipe ${cleanOpen}, form open after swipe ${dirtyOpen}`, problems);
    await page.close();
  }

  // ---- 201
  {
    await reset();
    const seq = await lastSeq();
    const { page, problems } = await open(`${ROLE}?utm_source=linkedin&utm_campaign=autumn`);
    await openSheetForm(page);
    await fillFirmware(page);
    const trap = await page.$eval('#ap-company', (el) => ({ value: el.value, tab: el.tabIndex, hidden: el.closest('[aria-hidden="true"]') !== null }));
    await sendWhenHuman(page);
    await viewIs(page, 'done', 15000);
    const done = await page.evaluate(() => ({
      ref: document.querySelector('[data-ref="doneRef"]').textContent,
      mail: document.querySelector('[data-ref="doneMail"]').textContent,
      focus: document.activeElement && document.activeElement.id,
      draft: sessionStorage.getItem('gridx.apply.draft.role:job-firmware-01'),
    }));
    const entry = await lastApply(seq);
    const b = (entry && entry.body) || {};
    let answers = {};
    let source = {};
    try { answers = JSON.parse(b.answers); source = JSON.parse(b.source); } catch (_) { /* reported below */ }
    const sentOk = entry && entry.status === 201 && !entry.note && b.kind === 'role' && b.jobId === 'job-firmware-01'
      && b.phone === '+919876543210' && b.consent === 'true' && b.consentVersion === '2026-10' && b.availability === '1m'
      && answers.q1 === 'yes' && answers.q2 === 'LFP' && answers.q3 === 'https://github.com/asha/bms'
      && b.resume && b.resume.name === 'resume.pdf' && source.utm && source.utm.source === 'linkedin'
      && b.company_website === '' && Number(b.elapsedMs) >= 4000;
    report('apply: 201, the reference and where the confirmation went, focus on it', /^GXA-[A-Z0-9]{6}$/.test(done.ref) && done.mail === 'We have emailed a confirmation to a***@example.com.' && done.focus === 'apply-done-title' && !done.draft, JSON.stringify({ ref: done.ref, mail: done.mail, focus: done.focus }), problems);
    report('apply: sent exactly Paddock\'s contract (+91 phone, answers, consent version, utm)', Boolean(sentOk), JSON.stringify({ status: entry && entry.status, note: entry && entry.note, phone: b.phone, answers, utm: source.utm }));
    report('apply: the honeypot is never touched', trap.value === '' && trap.tab === -1 && trap.hidden && b.company_website === '', JSON.stringify(trap));
    // What analytics.js sent Paddock: leaving the page flushes whatever it still holds.
    await page.goto('about:blank');
    await sleep(800);
    const beacons = (await logSince(seq)).filter((e) => /\/(event|pageview|live)$/.test(e.path));
    const events = beacons.filter((e) => e.path.endsWith('/event')).flatMap((e) => (e.body && e.body.accepted) || []);
    const names = events.map((e) => e.name);
    const all = JSON.stringify(beacons.map((e) => e.body));
    report('apply: analytics carry the slug and nothing personal',
      ['role_view', 'apply_open', 'apply_submit', 'apply_success'].every((n) => names.includes(n))
      && events.every((e) => Object.keys(e.props || {}).every((k) => k === 'slug'))
      && events.filter((e) => e.props && e.props.slug).every((e) => e.props.slug === 'embedded-firmware-engineer')
      && !/@|9876|Asha|Verma|New Delhi|GXA-/i.test(all), JSON.stringify(events).slice(0, 240));
    await page.close();
  }

  // ---- the upload's progress, and Cancel
  {
    await reset();
    const { page, problems } = await open(ROLE);
    await openSheetForm(page);
    await fillFirmware(page, { email: 'slow@example.com', resume: files.slow });
    await sendWhenHuman(page);
    await page.waitForFunction(() => /Sending \d+%|Almost there/.test(document.querySelector('[data-ref="primaryLabel"]').textContent), { timeout: 10000 }).catch(() => null);
    const during = await page.evaluate(() => ({
      label: document.querySelector('[data-ref="primaryLabel"]').textContent,
      progress: getComputedStyle(document.querySelector('.apply__primary')).getPropertyValue('--progress'),
      cancel: !document.querySelector('[data-ref="cancel"]').hidden,
    }));
    await click(page, '[data-ref="cancel"]');
    await sleep(500);
    const after = await text(page, '[data-ref="hint"]');
    const label = await text(page, '[data-ref="primaryLabel"]');
    report('apply: the button fills as the resume goes up, and Cancel stops it',
      /Sending \d+%|Almost there/.test(during.label) && Number(during.progress) > 0 && during.cancel && /Cancelled/.test(after) && label === 'Send application',
      `${JSON.stringify(during)} then "${after}"`, problems);
    await page.close();
  }

  // ---- 409, 429
  for (const [email, label, want] of [
    ['dup@example.com', '409: already applied, and when', (s) => /already applied for this role/.test(s.notice) && /1 October 2026/.test(s.notice)],
    ['rate@example.com', '429: how many minutes until another try', (s) => /wait 30 minutes/.test(s.hint)],
  ]) {
    await reset();
    const { page, problems } = await open(ROLE);
    await openSheetForm(page);
    await fillFirmware(page, { email });
    await sendWhenHuman(page);
    await page.waitForFunction(() => !document.getElementById('apply-sheet').classList.contains('is-busy') && (document.querySelector('[data-ref="hint"]').textContent || !document.querySelector('[data-ref="formNotice"]').hidden), { timeout: 15000 }).catch(() => null);
    const s = { notice: await text(page, '[data-ref="formNotice"]'), hint: await text(page, '[data-ref="hint"]') };
    report(`apply: ${label}`, want(s), JSON.stringify(s), problems);
    await page.close();
  }

  // ---- 410, and on as an open application
  {
    await reset();
    const seq = await lastSeq();
    const { page, problems } = await open(ROLE);
    await openSheetForm(page);
    await fillFirmware(page, { email: 'closed@example.com' });
    await sendWhenHuman(page);
    await page.waitForSelector('.apply__notice-action', { timeout: 15000 }).catch(() => null);
    const notice = await text(page, '[data-ref="formNotice"]');
    await click(page, '.apply__notice-action');
    await sleep(500);
    const switched = await page.evaluate(() => ({
      title: document.querySelector('[data-ref="formTitle"]').textContent,
      interests: !document.querySelector('[data-ref="interestGroup"]').hidden,
      domain: (document.querySelector('input[name="interestDomains"]:checked') || {}).value,
      type: (document.querySelector('input[name="interestType"]:checked') || {}).value,
      questions: document.querySelector('[data-ref="questionsGroup"]').hidden,
      first: document.getElementById('ap-firstName').value,
      file: !document.querySelector('[data-ref="chosen"]').hidden,
    }));
    await setValue(page, '#ap-email', 'asha.open@example.com');
    await click(page, '.apply__primary');
    await viewIs(page, 'done', 15000).catch(() => null);
    const view = await page.evaluate(() => document.getElementById('apply-sheet').dataset.view);
    const entry = await lastApply(seq);
    const b = (entry && entry.body) || {};
    const ok = /closed while you were writing/.test(notice) && switched.title === 'Your application' && switched.interests
      && switched.domain === 'electronics' && switched.type === 'full-time' && switched.questions && switched.first === 'Asha' && switched.file
      && view === 'done' && b.kind === 'open' && b.interestDomains === '["electronics"]' && b.interestType === 'full-time' && b.answers === '{}' && !b.jobId;
    report('apply: 410 offers an open application and keeps everything written', ok, JSON.stringify({ switched, view, kind: b.kind, interests: b.interestDomains }), problems);
    await page.close();
  }

  // ---- 413 and 415, on the resume field
  {
    await reset();
    const seq = await lastSeq();
    const { page, problems } = await open(ROLE);
    await openSheetForm(page);
    await fillFirmware(page);
    // Paddock's limit drops under the page: the page still thinks 10 MB, Paddock says no.
    const doc = await fetch(`${PADDOCK}/api/public/website/careers`).then((r) => r.json());
    doc.apply.maxResumeBytes = 1000;
    await ctl('/__mock/state', { careers: doc });
    await sendWhenHuman(page);
    await page.waitForFunction(() => document.querySelector('#ap-resume-err').textContent, { timeout: 15000 }).catch(() => null);
    const tooBig = await text(page, '#ap-resume-err');
    const statusBig = (await lastApply(seq) || {}).status;
    await reset();
    const seq2 = await lastSeq();
    const input = await page.$('#ap-resume');
    await input.uploadFile(files.xlsx);
    await sleep(500);
    await click(page, '.apply__primary');
    await page.waitForFunction((before) => document.querySelector('#ap-resume-err').textContent && document.querySelector('#ap-resume-err').textContent !== before, { timeout: 15000 }, tooBig).catch(() => null);
    const wrongType = await text(page, '#ap-resume-err');
    const statusType = (await lastApply(seq2) || {}).status;
    report('apply: 413 and 415 land on the resume field', statusBig === 413 && /too large/.test(tooBig) && statusType === 415 && /PDF or a Word/.test(wrongType), `${statusBig} "${tooBig}" / ${statusType} "${wrongType}"`, problems);
    await page.close();
  }

  // ---- Paddock's own 400s land on the right fields, in both shapes
  {
    await reset();
    const { page, problems } = await open(ROLE);
    await openSheetForm(page);
    await fillFirmware(page);
    await setValue(page, '#ap-q-q3', '');
    // The mock's shape (an object), from a question made required after the page loaded.
    const fixture = await fetch(`${PADDOCK}/api/public/website/careers`).then((r) => r.json());
    const job = fixture.jobs.find((j) => j.id === 'job-firmware-01');
    await ctl('/__mock/state', { patch: { jobs: [{ id: job.id, screeningQuestions: job.screeningQuestions.map((q) => (q.id === 'q3' ? { ...q, required: true } : q)) }] } });
    await sendWhenHuman(page);
    await page.waitForFunction(() => document.querySelector('[data-field="answers.q3"]').classList.contains('is-bad'), { timeout: 15000 }).catch(() => null);
    const q3 = { bad: await isBad(page, 'answers.q3'), msg: await text(page, '#ap-q-q3-err'), focus: await page.evaluate(() => document.activeElement.id) };
    // Paddock's shape (a list of { field, message }).
    await page.evaluate(() => {
      window.gridxApi.postForm = () => Promise.reject(Object.assign(new Error('Please check the highlighted fields.'), {
        kind: 'http', status: 400, code: 'invalid', body: {},
        fields: [{ field: 'answers.q2', message: 'Choose one of the options.' }, { field: 'city', message: 'Enter the city you live in.' }],
      }));
    });
    await click(page, '.apply__primary');
    await sleep(600);
    const list = { q2: await isBad(page, 'answers.q2'), q2msg: await text(page, '#ap-q-q2-err'), city: await isBad(page, 'city') };
    report('apply: Paddock\'s 400 lands on answers.<question> and the other fields, either shape',
      q3.bad && q3.msg === 'Please answer this question.' && q3.focus === 'ap-q-q3' && list.q2 && list.q2msg === 'Choose one of the options.' && list.city,
      JSON.stringify({ q3, list }), problems);
    await page.close();
  }

  // ================================================================ role page
  {
    await reset();
    const { page, problems } = await open(ROLE);
    await page.waitForFunction(() => window.gridCareers && window.gridCareers.get().live);
    await sleep(400);
    const before = await page.evaluate(() => ({ status: document.querySelector('[data-role-status]').hidden, dock: document.querySelector('.role__dock').classList.contains('is-shown') }));
    await page.evaluate(() => window.scrollTo(0, 1400));
    await sleep(400);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForFunction(() => document.documentElement.classList.contains('is-compact'), { timeout: 8000 }).catch(() => null);
    await sleep(700);
    const dock = await page.evaluate(() => {
      const d = document.querySelector('.role__dock');
      return { shown: d.classList.contains('is-shown'), inert: d.inert, opacity: getComputedStyle(d).opacity };
    });
    report('role page: open, no banner; the docked Apply appears once the card has scrolled away', before.status && !before.dock && dock.shown && !dock.inert && Number(dock.opacity) > 0.9, JSON.stringify({ before, dock }), problems);
    await page.close();
  }
  for (const [label, prepare, want] of [
    ['closed', () => ctl('/__mock/state', { close: ['job-firmware-01'] }), /This role has closed/],
    ['paused', async () => {
      const doc = await fetch(`${PADDOCK}/api/public/website/careers`).then((r) => r.json());
      const job = doc.jobs.find((j) => j.id === 'job-firmware-01');
      doc.jobs = doc.jobs.filter((j) => j !== job);
      doc.recentlyClosed = [{ id: job.id, slug: job.slug, previousSlugs: job.previousSlugs, title: job.title, domain: job.domain, state: 'paused', since: new Date().toISOString() }];
      await ctl('/__mock/state', { careers: doc });
    }, /This role is paused for now/],
  ]) {
    await reset();
    await prepare();
    const { page, problems } = await open(ROLE);
    await page.waitForSelector('[data-role-status]:not([hidden])', { timeout: 10000 }).catch(() => null);
    const s = await page.evaluate(() => ({
      text: document.querySelector('[data-role-status]').textContent,
      closed: document.querySelector('main.role').classList.contains('is-closed'),
      apply: getComputedStyle(document.querySelector('.role__apply')).display,
      offer: Boolean(document.querySelector('[data-role-status] [data-apply="open"]')),
    }));
    let opened = '';
    if (s.offer) {
      await click(page, '[data-role-status] [data-apply="open"]');
      await viewIs(page, 'intro').catch(() => null);
      opened = await text(page, '[data-ref="eyebrow"]');
    }
    report(`role page: ${label} since the build, said so, with an open application offered`, want.test(s.text) && s.closed && s.apply === 'none' && s.offer && /Open application/i.test(opened), JSON.stringify({ ...s, opened }), problems);
    await page.close();
  }

  // ================================================================ interview
  const IV = (t) => `${SITE}/interview.html${t === undefined ? '' : `?t=${t}`}`;
  const ivState = (page, timeout = 8000) => page.waitForFunction(() => document.querySelector('[data-iv-panel]').dataset.state, { timeout }).then(() => page.$eval('[data-iv-panel]', (el) => el.dataset.state));
  const tokenGone = (page) => page.evaluate(() => !/[?&]t=/.test(location.href) && !performance.getEntriesByType('resource').some((e) => /[?&]t=/.test(e.name)));

  {
    await reset();
    const seq = await lastSeq();
    const { page, problems } = await open(IV('valid'));
    const state = await ivState(page);
    const look = await page.evaluate(() => ({
      stored: sessionStorage.getItem('gridx.interview.t'),
      slots: [...document.querySelectorAll('.iv__slot-input')].map((i) => `${i.value}:${i.disabled ? 'x' : 'o'}`).join(','),
      tall: Math.min(...[...document.querySelectorAll('.iv__slot-face')].map((f) => f.getBoundingClientRect().height)),
      days: [...document.querySelectorAll('.iv__day-title')].map((d) => d.textContent),
    }));
    const gone = await tokenGone(page);
    report('interview: lookup, times grouped by day as 48px+ chips, the token out of the address', state === 'pick' && look.stored === 'valid' && look.slots === 's1:o,s2:o,s3:x,s4:o' && look.tall >= 48 && look.days[0] === 'Wednesday 14 October' && gone, JSON.stringify({ state, ...look, gone }), problems);

    await click(page, '.iv__slot-input[value="s2"]');
    const confirm = await text(page, '[data-iv-confirm]');
    await click(page, '[data-iv-confirm]');
    const after = await page.waitForFunction(() => document.querySelector('[data-iv-panel]').dataset.state === 'booked', { timeout: 8000 }).then(() => true).catch(() => false);
    const booked = await page.evaluate(() => ({
      time: document.querySelector('.iv__when-time').textContent,
      ics: (document.querySelector('[data-iv-ics]') || {}).href || '',
      download: (document.querySelector('[data-iv-ics]') || {}).download || '',
      gcal: [...document.querySelectorAll('a')].map((a) => a.href).find((h) => h.startsWith('https://calendar.google.com/')) || '',
      pending: /on its way/.test(document.querySelector('[data-iv-panel]').textContent),
    }));
    const entry = (await logSince(seq)).filter((e) => e.path.endsWith('/careers/schedule')).pop() || {};
    report('interview: book, then how to join and add to a calendar (Google, .ics)',
      after && confirm === 'Confirm Wed 14 Oct, 12:00 PM' && booked.time === '12:00 PM to 12:45 PM IST' && booked.ics.startsWith('blob:') && booked.download === 'gridx-interview.ics'
      && /dates=20261014T063000Z%2F20261014T071500Z/.test(booked.gcal) && booked.pending && entry.body && entry.body.action === 'book' && entry.body.slotId === 's2',
      JSON.stringify({ confirm, ...booked, gcal: booked.gcal.slice(0, 90) }), problems);
    await page.close();
  }

  {
    await reset();
    const { page, problems } = await open(IV('taken'));
    await ivState(page);
    await page.evaluate(() => window.scrollTo(0, 120));
    await sleep(200);
    const y0 = await page.evaluate(() => window.scrollY);
    await click(page, '.iv__slot-input[value="s1"]');
    await click(page, '[data-iv-confirm]');
    await page.waitForFunction(() => /just taken/.test(document.querySelector('[data-iv-panel]').textContent), { timeout: 8000 }).catch(() => null);
    const s = await page.evaluate(() => ({
      msg: (document.querySelector('.iv__message') || {}).textContent || '',
      slots: [...document.querySelectorAll('.iv__slot-input')].map((i) => `${i.value}:${i.disabled ? 'x' : 'o'}`).join(','),
      y: window.scrollY,
      state: document.querySelector('[data-iv-panel]').dataset.state,
    }));
    report('interview: a time taken first (409) redraws the fresh times where the visitor was', s.state === 'pick' && /just taken/.test(s.msg) && s.slots === 's1:x,s2:x,s3:x,s4:o' && Math.abs(s.y - y0) <= 4, JSON.stringify({ ...s, y0 }), problems);
    await page.close();
  }

  {
    await reset();
    const seq = await lastSeq();
    const { page, problems } = await open(IV('booked'));
    const first = await ivState(page);
    const deadline = /until Tue 13 Oct, 10:00 AM IST/.test(await text(page, '.iv__change'));
    await click(page, '[data-iv-key="reschedule"]');
    await sleep(300);
    const pick = await page.evaluate(() => ({
      title: document.querySelector('.iv__title').textContent,
      current: [...document.querySelectorAll('.iv__slot')].find((l) => /Your time now/.test(l.textContent))?.querySelector('input').value,
    }));
    await click(page, '.iv__slot-input[value="s4"]');
    await click(page, '[data-iv-confirm]');
    await page.waitForFunction(() => document.querySelector('[data-iv-panel]').dataset.state === 'booked', { timeout: 8000 }).catch(() => null);
    const time = await text(page, '.iv__when-time');
    const entry = (await logSince(seq)).filter((e) => e.path.endsWith('/careers/schedule')).pop() || {};
    report('interview: reschedule to another time, the deadline shown', first === 'booked' && deadline && pick.title === 'Choose a new time.' && pick.current === 's1' && time === '4:00 PM to 4:45 PM IST' && entry.body?.action === 'reschedule' && entry.body?.slotId === 's4', JSON.stringify({ first, deadline, ...pick, time }), problems);

    await click(page, '[data-iv-key="cancel"]');
    await click(page, '[data-iv-key="cancel-yes"]');
    await page.waitForFunction(() => /is cancelled/.test(document.querySelector('[data-iv-panel]').textContent), { timeout: 8000 }).catch(() => null);
    const after = await page.evaluate(() => document.querySelector('[data-iv-panel]').dataset.state);
    report('interview: cancel, and the times are offered again', after === 'pick', after, problems);
    await page.close();
  }

  {
    await reset();
    const { page, problems } = await open(IV('late'));
    await ivState(page);
    const late = await page.evaluate(() => ({
      text: document.querySelector('.iv__change').textContent,
      move: Boolean(document.querySelector('[data-iv-key="reschedule"]')),
      cancel: Boolean(document.querySelector('[data-iv-key="cancel"]')),
    }));
    report('interview: past the change deadline, it says to reply to the email', /too late to change this online/.test(late.text) && !late.move && !late.cancel, JSON.stringify(late), problems);
    await page.close();

    // And Paddock refusing a change the page still offered (422 too_late): the lookup is
    // answered as if the deadline were still ahead, and the change goes to the mock.
    await reset();
    const { page: p2, problems: pr2 } = await open(IV('late'), {
      before: async (p) => {
        await p.setRequestInterception(true);
        p.on('request', async (req) => {
          const body = req.postData() || '';
          if (req.method() === 'POST' && req.url().endsWith('/careers/schedule') && /"action":"lookup"/.test(body)) {
            const view = await fetch(`${PADDOCK}/api/public/website/careers/schedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.json());
            await req.respond({
              status: 200,
              headers: { 'Access-Control-Allow-Origin': SITE, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...view, canReschedule: true, canCancel: true }),
            });
            return;
          }
          req.continue();
        });
      },
    });
    await ivState(p2);
    await click(p2, '[data-iv-key="reschedule"]');
    await click(p2, '.iv__slot-input[value="s4"]');
    await click(p2, '[data-iv-confirm]');
    await p2.waitForFunction(() => /too late/i.test((document.querySelector('.iv__message') || {}).textContent || ''), { timeout: 8000 }).catch(() => null);
    const msg = await text(p2, '.iv__message');
    report('interview: a 422 too_late from Paddock is said plainly', /too late/i.test(msg), msg, pr2);
    await p2.close();
  }

  {
    await reset();
    const seq = await lastSeq();
    const { page, problems } = await open(IV('valid'));
    await ivState(page);
    await click(page, '[data-iv-key="other"]');
    await setValue(page, '#iv-note', 'Weekday mornings after the 20th');
    await click(page, '[data-iv-key="send-note"]');
    await page.waitForFunction(() => document.querySelector('[data-iv-panel]').dataset.state === 'requested', { timeout: 8000 }).catch(() => null);
    const state = await page.$eval('[data-iv-panel]', (el) => el.dataset.state);
    const entry = (await logSince(seq)).filter((e) => e.path.endsWith('/careers/schedule')).pop() || {};
    report('interview: none of these work sends a note', state === 'requested' && entry.body?.action === 'request_other' && entry.body?.note === 'Weekday mornings after the 20th', state, problems);
    await page.close();
  }

  {
    await reset();
    const seen = [];
    for (const t of ['nope', 'x'.repeat(32), undefined, 'expired']) {
      const { page, problems } = await open(IV(t));
      const state = await ivState(page);
      const words = await page.$eval('[data-iv-panel]', (el) => el.innerText.trim());
      seen.push({ t, state, words, gone: await tokenGone(page), problems });
      await page.close();
    }
    const [a, b, c, e] = seen;
    report('interview: every bad link reads the same, with or without a token', a.state === 'invalid' && a.words === b.words && b.words === c.words && /does not work/.test(a.words) && a.gone && b.gone, a.words.slice(0, 60), [...a.problems, ...b.problems, ...c.problems]);
    report('interview: an expired link says so, and to reply to the email', e.state === 'expired' && /expired/.test(e.words) && /Reply to the email/.test(e.words) && e.gone, e.words.slice(0, 80), e.problems);
  }
} catch (err) {
  failed++;
  console.log(`FAIL  the check itself: ${err.stack || err}`);
} finally {
  await browser.close();
  server.close();
  if (mock) await mock.close();
  if (!process.argv.includes('--keep')) fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} careers check(s) failed` : '\ncareers: all checks pass');
process.exitCode = failed ? 1 : 0;
