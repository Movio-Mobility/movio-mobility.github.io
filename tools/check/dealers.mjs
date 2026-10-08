#!/usr/bin/env node
/*
 * The dealers page, end to end: a build made from the Paddock mock, served by tools/serve.mjs,
 * driven in headless Chrome. The same harness as smoke.mjs and sweep.mjs.
 *   node tools/check/dealers.mjs [--keep]      (--keep leaves the temporary build in place)
 *
 *   build      dealers/snapshot.json, the photos (local, WebP, at most 400 KB), JSON-LD, the
 *              service worker's media cache, no Paddock image named anywhere in the page
 *   no JS      the prerendered list on its own: plain links, no phone number as text
 *   parity     every card in the built page is byte for byte what the page's own renderer
 *              writes; and with a fixed clock, Node and the browser write the same card
 *   hours      India's time at fixed moments, on a machine set to New York, and the line
 *              turning over at the minute without a reload
 *   search     city chips (and ?city=), pincodes, words, the empty state; nothing typed
 *              reaches the address; each settled search counted by kind only
 *   near me    a mocked position: nearest first, distances shown, the position sent nowhere
 *   fresh      a change in the mock picked up: renamed, added (with no photo, since its photo
 *              is still on Paddock), removed, and the scroll held still
 *   states     the page built without data: loading, Paddock failing, Try again
 *   policy     no image from anywhere but the site, no Content Security Policy violation
 *   phone      390x844: the dock clear of the nav pill, and above a simulated keyboard
 *
 * gridx-api.js talks to http://localhost:3000 on localhost; the browser's requests there are
 * forwarded to this run's mock, so a Paddock or a mock already on :3000 is left alone.
 * Each check prints PASS or FAIL with what it saw; exits 1 if any failed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { startMock } from './paddock-mock.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';
import { renderDealerCard, webpSize, PHOTO_MAX_BYTES } from '../dealers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keep = process.argv.includes('--keep');

let failed = 0;
function report(label, ok, detail = '', errors = []) {
  const pass = ok && !errors.length;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}${errors.length ? `\n      errors: ${errors.join(' | ')}` : ''}`);
}

// ---------------------------------------------------------------- the mock and the build
async function listen(start) {
  for (let port = start; port < start + 20; port++) {
    try {
      return await startMock({ port, quiet: true });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error('no free port for the mock');
}
const mock = await listen(3127);
const MOCK = mock.url;
const API = `${MOCK}/api/public/website/dealers`;
const control = (body) => fetch(`${MOCK}/__mock/state`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const mockLog = () => fetch(`${MOCK}/__mock/log`).then((r) => r.json()).then((j) => j.entries);

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'gridx-dealers-'));
const built = await run(process.execPath, ['tools/build.mjs', '--out', OUT], {
  cwd: REPO,
  maxBuffer: 1 << 24,
  env: { ...process.env, DEALERS_API: API, DEALERS_SNAPSHOT: 'http://127.0.0.1:9/none', CAREERS_API: '', CAREERS_FIXTURE: '', DEALERS_FIXTURE: '' },
}).then((r) => ({ ...r, code: 0 }), (err) => ({ stdout: err.stdout || '', stderr: err.stderr || '', code: err.code }));
const dealerWarnings = built.stderr.split('\n').filter((l) => /dealer/i.test(l));
report('build from the mock', /dealers paddock \(d-fixture1\)/.test(built.stdout) && fs.existsSync(path.join(OUT, 'dealers.html')),
  `exit ${built.code}; ${(built.stdout.match(/data: .*/) || ['no data line'])[0]}${built.code ? ' (a non-zero exit from pages other than this one is left to npm run build)' : ''}`,
  dealerWarnings.filter((l) => !/photo arrived at/.test(l)));

const HTML = fs.readFileSync(path.join(OUT, 'dealers.html'), 'utf8');
const SNAPSHOT_FILE = path.join(OUT, 'dealers/snapshot.json');
const snapshot = fs.existsSync(SNAPSHOT_FILE) ? JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) : null;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/dealers.json'), 'utf8'));

{
  const photos = snapshot ? snapshot.dealers.filter((d) => d.photo) : [];
  const files = fs.existsSync(path.join(OUT, 'dealers/photos')) ? fs.readdirSync(path.join(OUT, 'dealers/photos')) : [];
  const allLocal = photos.every((d) => /^dealers\/photos\/[A-Za-z0-9_-]+-640\.webp\?v=[0-9a-f]{10}$/.test(d.photo.url)
    && d.photo.srcset.split(', ').every((s) => fs.existsSync(path.join(OUT, s.split('?')[0]))));
  const sizes = files.map((f) => fs.statSync(path.join(OUT, 'dealers/photos', f)).size);
  const webp = files.every((f) => webpSize(fs.readFileSync(path.join(OUT, 'dealers/photos', f))));
  report('snapshot: the API shape, every photo on the site', Boolean(snapshot) && snapshot.version === 'd-fixture1'
    && snapshot.dealers.length === FIXTURE.dealers.length && Array.isArray(snapshot.cities) && photos.length === 11 && allLocal,
    `${snapshot ? snapshot.dealers.length : 0} dealers, ${photos.length} with photos, all local ${allLocal}`);
  report('photos: WebP, at most 400 KB, three widths each', files.length === 33 && webp && sizes.every((s) => s <= PHOTO_MAX_BYTES),
    `${files.length} files, largest ${Math.max(0, ...sizes)} bytes, all WebP ${webp}`);
  const sw = fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8');
  report('service worker keeps dealer photos in its media cache',
    /url\.pathname\.startsWith\('\/dealers\/photos\/'\)\)\s*{\s*event\.respondWith\(url\.searchParams\.has\('v'\) \? fromCache\(request, MEDIA\) : refreshing\(request, MEDIA\)\)/.test(sw));
  const csp = (HTML.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  const imgSrc = (csp.match(/img-src ([^;]+)/) || [])[1] || '';
  report('policy: images only from the site (and data:, blob:, Razorpay)', imgSrc && !/paddock|localhost/.test(imgSrc), imgSrc);
  report('prerender names no image on Paddock or the mock', !/dealers\/photo\/|paddockgridx\.app\/api\/public\/website\/dealers\/photo/.test(HTML.replace(/<script type="application\/(?:ld\+)?json"[\s\S]*?<\/script>/g, '')));
  let ld = null;
  try { ld = JSON.parse((HTML.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1]); } catch { ld = null; }
  const first = ld && ld.itemListElement[0].item;
  report('JSON-LD: an ItemList of AutoDealer with hours, phone and address', Boolean(ld) && ld['@type'] === 'ItemList'
    && ld.itemListElement.length === 12 && ld.itemListElement.every((e) => e.item['@type'] === 'AutoDealer' && /^\+\d+$/.test(e.item.telephone) && e.item.address.addressCountry === 'IN')
    && first.openingHoursSpecification[0].opens === '10:00',
    first ? `${first.name}, ${first.telephone}, ${first.openingHoursSpecification.length} hours spec(s)` : 'none');
}

// ---------------------------------------------------------------- the browser
const SITE_PORT = 8127;
const server = await serve({ root: OUT, port: SITE_PORT, quiet: true });
const SRC_PORT = 8128;
const sources = await serve({ root: REPO, port: SRC_PORT, quiet: true });
const SITE = `http://localhost:${SITE_PORT}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS, protocolTimeout: 180000 });

const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const IGNORE = /favicon|status of 404/i;
const offSite = [];       // images asked for from anywhere but the site
const violations = [];    // CSP violations, from any page
const outbound = [];      // every request body and URL, to look for coordinates in

async function open(url, { viewport = DESKTOP, js = true, before, at, tz, ignore = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.setBypassServiceWorker(true);
  await page.setJavaScriptEnabled(js);
  if (tz) await page.emulateTimezone(tz);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (/Content.Security.Policy/i.test(m.text())) violations.push(m.text());
    else if (m.type() === 'error' && !IGNORE.test(m.text()) && !(ignore && ignore.test(m.text()))) errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    outbound.push(`${u} ${r.postData() || ''}`);
    if (r.resourceType() === 'image' && !u.startsWith('data:') && !u.startsWith(new URL(url).origin)) offSite.push(u);
    if (u.startsWith('http://localhost:3000/')) r.continue({ url: u.replace('http://localhost:3000', MOCK) });
    else r.continue();
  });
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    // A recorder in place of the analytics queue, kept whatever analytics.js does later.
    const calls = [];
    const record = function (name, props) { calls.push([name, props]); };
    Object.defineProperty(window, 'gridTrack', { configurable: true, get: () => record, set: () => {} });
    window.__track = calls;
  });
  if (at !== undefined) {
    await page.evaluateOnNewDocument((t) => {
      const Real = Date;
      const shift = t - Real.now();
      class Fixed extends Real {
        constructor(...a) {
          if (a.length) super(...a);
          else super(Real.now() + shift);
        }
        static now() { return Real.now() + shift; }
      }
      window.Date = Fixed;
    }, at);
  }
  if (before) await before(page);
  await page.goto(url, { waitUntil: 'load' });
  return { page, errors };
}

async function finish(page) {
  const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
  violations.push(...csp);
  await page.close();
}

const visible = (page) => page.$$eval('#dealers-list > li', (lis) => lis.filter((li) => !li.hidden && getComputedStyle(li).display !== 'none').map((li) => li.id));
const settle = () => sleep(250);
async function typeQuery(page, text) {
  await page.$eval('#dealer-q', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  if (text) await page.type('#dealer-q', text, { delay: 15 });
  await settle();
}

// India: 2026-10-05 is a Monday.
const IST = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 9, 5 + ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(day), h, m) - 330 * 60000;
};

// ---------------------------------------------------------------- no JS
{
  const { page, errors } = await open(`${SITE}/dealers.html`, { js: false, viewport: PHONE });
  const st = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#dealers-list > li.dealer')];
    const shown = (sel) => [...document.querySelectorAll(sel)].some((el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
    return {
      cards: cards.length,
      tel: cards.every((c) => /^tel:\+\d{8,15}$/.test(c.querySelector('[data-act="call"]').getAttribute('href'))),
      directions: cards.every((c) => c.querySelector('[data-act="directions"]').href.startsWith('https://www.google.com/maps/dir/?api=1&destination=')),
      labels: cards.every((c) => [...c.querySelectorAll('[data-act]')].every((a) => a.getAttribute('aria-label').includes(c.querySelector('.dealer__name').textContent))),
      dock: shown('.dealer-dock'),
      chips: shown('.dealers-cities'),
      share: shown('[data-act="share"]'),
      now: shown('.dealer__now'),
      nojs: shown('.dealers-nojs'),
      loading: shown('.dealers-loading'),
      hours: document.querySelector('#d-okhla-swap-hub .dealer__hours').textContent,
      count: document.getElementById('dealers-count').textContent,
      // textContent, not innerText: cards content-visibility has not rendered yet still count,
      // and the data blocks (where numbers rightly are) are taken out first.
      text: (() => {
        const copy = document.body.cloneNode(true);
        for (const s of copy.querySelectorAll('script, style, noscript')) s.remove();
        return copy.textContent;
      })(),
      imgs: [...document.querySelectorAll('#dealers-list img')].map((i) => i.src),
    };
  });
  const phones = FIXTURE.dealers.flatMap((d) => d.phones.flatMap((p) => [p.display, p.e164, p.e164.slice(3), p.e164.slice(1)]));
  const printed = phones.filter((p) => st.text.includes(p) || st.text.replace(/\s+/g, '').includes(p.replace(/\s+/g, '')));
  report('no JS: the prerendered list with plain links', st.cards === 12 && st.tel && st.directions && st.labels && st.count === '12 dealers in 5 cities'
    && st.hours === 'Mon to Sat, 10 AM to 7 PM. Closed Sun.',
    `${st.cards} cards, tel ${st.tel}, directions ${st.directions}, labelled ${st.labels}, "${st.count}"`, errors);
  report('no JS: nothing that needs a script is shown', !st.dock && !st.chips && !st.share && !st.now && !st.nojs && !st.loading,
    `dock ${st.dock}, chips ${st.chips}, share ${st.share}, live line ${st.now}, nojs note ${st.nojs}, loading ${st.loading}`);
  report('no JS: no phone number printed as text', printed.length === 0, printed.length ? `printed: ${printed.join(', ')}` : `${phones.length} forms of ${FIXTURE.dealers.length} dealers' numbers checked`);
  report('no JS: every image from the site', st.imgs.length === 11 && st.imgs.every((s) => s.startsWith(SITE)), `${st.imgs.length} images`);
  report('escaping: a name that tries to close a script tag is shown as text', st.text.includes('A</script>B') && !HTML.includes('<b>Inner Circle</b>'));
  await finish(page);
}

// ---------------------------------------------------------------- parity
{
  const { page, errors } = await open(`${SITE}/dealers.html`);
  const T = IST('mon', '12:00');
  const browserCards = await page.evaluate((t) => {
    const data = window.gridDealers.normalize(JSON.parse(document.getElementById('dealers-data').textContent));
    return data.dealers.map((d, i) => ({
      prerender: window.gridDealers.renderCard(d, { now: null, base: '', eager: i < 2 }),
      timed: window.gridDealers.renderCard(d, { now: t, base: '', eager: i < 2 }),
    }));
  }, T);
  const inBuild = browserCards.filter((c) => HTML.includes(c.prerender)).length;
  const nodeTimed = snapshot.dealers.map((d, i) => renderDealerCard(d, { now: T, base: '', eager: i < 2 }));
  const same = browserCards.filter((c, i) => c.timed === nodeTimed[i]).length;
  report('parity: every prerendered card is exactly what the page would write', inBuild === 12, `${inBuild} of 12 found byte for byte in the built HTML`, errors);
  report('parity: with a fixed clock, Node and the browser write the same card', same === 12 && nodeTimed[0].includes('Open now · closes 7 PM'), `${same} of 12 identical`);
  await finish(page);
}

// ---------------------------------------------------------------- hours in India's time
{
  const cases = [
    ['mon', '12:00', { 'd-okhla-swap-hub': 'Open now · closes 7 PM', 'd-lajpat-ev-point': 'Open now · closes 1:30 PM' }],
    ['mon', '14:00', { 'd-okhla-swap-hub': 'Open now · closes 7 PM', 'd-lajpat-ev-point': 'Closed · opens 3 PM' }],
    ['sat', '19:30', { 'd-okhla-swap-hub': 'Closed · opens 10 AM Mon', 'd-lajpat-ev-point': 'Open now · closes 8 PM' }],
    ['sun', '12:00', { 'd-okhla-swap-hub': 'Closed · opens 10 AM tomorrow', 'd-lajpat-ev-point': 'Open now · closes 2 PM' }],
  ];
  for (const [day, time, want] of cases) {
    const { page, errors } = await open(`${SITE}/dealers.html`, { at: IST(day, time), tz: 'America/New_York' });
    const got = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id} [data-now]`).textContent])), Object.keys(want));
    const karol = await page.$eval('#d-karol-bagh-batteries', (el) => ({ now: Boolean(el.querySelector('[data-now]')), hours: el.querySelector('.dealer__hours').textContent }));
    report(`hours: ${day} ${time} in India, on a machine in New York`, JSON.stringify(got) === JSON.stringify(want) && !karol.now && karol.hours === 'Call ahead for opening hours.',
      JSON.stringify(got), errors);
    await finish(page);
  }
  // The turn of the minute, without a reload: 18:59:54 becomes 19:00.
  const at = IST('mon', '18:59') + 54000;
  const { page, errors } = await open(`${SITE}/dealers.html`, { at });
  const before = await page.$eval('#d-okhla-swap-hub [data-now]', (el) => el.textContent);
  await sleep(7000);
  const after = await page.$eval('#d-okhla-swap-hub [data-now]', (el) => ({ text: el.textContent, open: el.classList.contains('is-open') }));
  report('hours: the line turns over at the minute', before === 'Open now · closes 7 PM' && after.text === 'Closed · opens 10 AM tomorrow' && !after.open,
    `"${before}" then "${after.text}"`, errors);
  await finish(page);
}

// ---------------------------------------------------------------- search
{
  const { page, errors } = await open(`${SITE}/dealers.html`, { viewport: PHONE });
  await sleep(400);
  const all = await visible(page);
  await page.click('.dealers-city[data-city="delhi"]');
  await settle();
  const delhi = await visible(page);
  const delhiUrl = await page.evaluate(() => location.search);
  const delhiCount = await page.$eval('#dealers-count', (el) => el.textContent);
  report('search: the Delhi chip', all.length === 12 && delhi.length === 4 && delhiUrl === '?city=delhi' && delhiCount === '4 dealers in Delhi',
    `${delhi.join(', ')}; address ${delhiUrl}; "${delhiCount}"`, errors);
  await page.click('.dealers-city[data-city=""]');
  await settle();
  report('search: All again', (await visible(page)).length === 12 && (await page.evaluate(() => location.search)) === '');

  await typeQuery(page, '110020');
  const pin = await visible(page);
  const pinCount = await page.$eval('#dealers-count', (el) => el.textContent);
  report('search: an exact pincode first, then the rest nearby', pin[0] === 'd-okhla-swap-hub' && pin.includes('d-cyber-city-motors') && !pin.includes('d-indiranagar-electric'),
    `${pin.join(', ')}; "${pinCount}"`);
  await typeQuery(page, '560001');
  const blr = await visible(page);
  const blrNote = await page.$eval('#dealers-note', (el) => (el.hidden ? '' : el.textContent));
  report('search: a pincode with no dealer gets the nearest, by the prefix ladder', blr.length === 2 && blr.every((id) => ['d-indiranagar-electric', 'd-koramangala-swap'].includes(id))
    && blrNote === 'No dealer in 560001 yet. These are the nearest.', `${blr.join(', ')}; "${blrNote}"`);
  await typeQuery(page, '122018');
  const sohna = await visible(page);
  report('search: the ladder crosses a state line when it is near (Gurugram to Delhi)', sohna[0] === 'd-sohna-road-ev' && sohna[1] === 'd-cyber-city-motors' && sohna.includes('d-okhla-swap-hub') && !sohna.includes('d-cidco-e-mobility'),
    sohna.join(', '));
  await typeQuery(page, '8241');
  report('search: a partial pincode', JSON.stringify((await visible(page)).sort()) === JSON.stringify(['d-aurangabad-bihar-ev-centre', 'd-daudnagar-road-motors']));
  await typeQuery(page, 'koram');
  report('search: words', JSON.stringify(await visible(page)) === JSON.stringify(['d-koramangala-swap']));
  await typeQuery(page, 'aurangabad');
  report('search: a city in two states', (await visible(page)).length === 4);
  await typeQuery(page, 'cidco e-mob');
  report('search: punctuation is no obstacle', JSON.stringify(await visible(page)) === JSON.stringify(['d-cidco-e-mobility']));
  await typeQuery(page, 'nowhere at all');
  const empty = await page.evaluate(() => ({ shown: !document.getElementById('dealers-empty').hidden, title: document.querySelector('#dealers-empty h3').textContent, wa: document.querySelector('#dealers-empty a').href }));
  report('search: the empty state, with a way to reach GridX', empty.shown && empty.title === 'No dealers in that area yet' && empty.wa.startsWith('https://wa.me/'), JSON.stringify(empty));
  await page.click('#dealers-empty [data-reset]');
  await settle();
  report('search: "Show every dealer" puts the list back', (await visible(page)).length === 12 && (await page.$eval('#dealer-q', (el) => el.value)) === '');
  await typeQuery(page, '110020');
  await sleep(1500);
  const address = await page.evaluate(() => location.href);
  const tracked = await page.evaluate(() => window.__track.slice());
  const searches = tracked.filter(([n]) => n === 'dealer_search');
  report('search: nothing typed reaches the address', !/110020|koram|aurangabad|nowhere/.test(address), address);
  report('search: each settled search counted once, by kind only', searches.length >= 3 && searches.every(([, p]) => Object.keys(p).join() === 'kind' && ['city', 'pincode', 'text', 'near_me'].includes(p.kind))
    && searches.some(([, p]) => p.kind === 'city') && searches.some(([, p]) => p.kind === 'pincode') && searches.some(([, p]) => p.kind === 'text')
    && !JSON.stringify(tracked).match(/110020|koram|nowhere/), JSON.stringify(searches));
  // A card's actions are counted by action and dealer id.
  await page.evaluate(() => {
    for (const a of document.querySelectorAll('#d-okhla-swap-hub [data-act]')) {
      a.addEventListener('click', (e) => e.preventDefault());
      a.click();
    }
  });
  const actions = (await page.evaluate(() => window.__track.slice())).filter(([n]) => n === 'dealer_action');
  report('actions: call, WhatsApp, directions and share are counted with the dealer id', JSON.stringify(actions.map(([, p]) => p.action)) === JSON.stringify(['call', 'whatsapp', 'directions', 'share'])
    && actions.every(([, p]) => p.dealerId === 'dlrOkhla0001' && Object.keys(p).sort().join() === 'action,dealerId'), JSON.stringify(actions));
  await finish(page);

  for (const [query, want] of [['?city=gurugram', 2], ['?city=aurangabad-bihar', 2], ['?city=Bengaluru', 2]]) {
    const o = await open(`${SITE}/dealers.html${query}`);
    const ids = await visible(o.page);
    const pressed = await o.page.$eval('.dealers-city[aria-pressed="true"]', (el) => el.dataset.city);
    report(`search: opened at ${query}`, ids.length === want && pressed !== '', `${ids.join(', ')}; chip ${pressed}`, o.errors);
    await finish(o.page);
  }

  // A link to one dealer: scrolled to and lit.
  const linked = await open(`${SITE}/dealers.html?city=delhi#d-cidco-e-mobility`);
  await sleep(500);
  const lit = await linked.page.evaluate(() => {
    const el = document.getElementById('d-cidco-e-mobility');
    const r = el.getBoundingClientRect();
    return { hidden: el.hidden, inView: r.top >= 0 && r.bottom <= innerHeight + 2, lit: el.classList.contains('is-target') || el.matches(':target') };
  });
  report('link: #d-<slug> shows that dealer even when a city chip would hide it, in view and lit', !lit.hidden && lit.inView && lit.lit, JSON.stringify(lit), linked.errors);
  await finish(linked.page);
}

// ---------------------------------------------------------------- near me
{
  const here = { latitude: 12.9447, longitude: 77.6201 }; // a little north of Koramangala
  const marks = ['12.944', '77.620', '12.9447', '77.6201'];
  const sentBefore = outbound.length;
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(SITE, ['geolocation']);
  const { page, errors } = await open(`${SITE}/dealers.html`, { viewport: PHONE, before: (p) => p.setGeolocation(here) });
  await page.click('.dealers-city[data-city="delhi"]');
  await page.click('.dealer-dock__near');
  await sleep(800);
  const st = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('#dealers-list > li')].filter((li) => !li.hidden).map((li) => li.id),
    dist: [...document.querySelectorAll('#dealers-list > li')].filter((li) => !li.hidden).slice(0, 3).map((li) => li.querySelector('[data-dist]').textContent),
    pressed: document.querySelector('.dealer-dock__near').getAttribute('aria-pressed'),
    note: document.getElementById('dealers-note').textContent,
    count: document.getElementById('dealers-count').textContent,
    url: location.href,
  }));
  const nearTracked = (await page.evaluate(() => window.__track.slice())).filter(([n, p]) => n === 'dealer_search' && p.kind === 'near_me');
  report('near me: every dealer, nearest first, with distances', st.ids.length === 12 && st.ids[0] === 'd-koramangala-swap' && st.ids[1] === 'd-indiranagar-electric'
    && /^ · \d(\.\d)? km$/.test(st.dist[0]) && st.pressed === 'true' && st.count === '12 dealers, nearest first' && nearTracked.length === 1,
    `${st.ids.slice(0, 3).join(', ')}; ${st.dist.join(' /')}; "${st.note}"`, errors);
  await page.click('.dealers-city[data-city="delhi"]');
  await settle();
  const delhiNear = await page.evaluate(() => [...document.querySelectorAll('#dealers-list > li')].filter((li) => !li.hidden).map((li) => li.querySelector('[data-dist]').textContent));
  report('near me: a city chip keeps the distances', delhiNear.length === 4 && delhiNear.every((t) => / km$/.test(t)), delhiNear.join(' /'));
  await sleep(300);
  const leaked = outbound.slice(sentBefore).filter((r) => marks.some((m) => r.includes(m)));
  const logged = (await mockLog()).filter((e) => marks.some((m) => JSON.stringify(e).includes(m)));
  report('near me: the position goes nowhere (no request, no address, no event)', !leaked.length && !logged.length && !marks.some((m) => st.url.includes(m))
    && !marks.some((m) => JSON.stringify(nearTracked).includes(m)), leaked.length || logged.length ? `${leaked.concat(logged.map((e) => e.path)).join(' | ')}` : `${outbound.length - sentBefore} requests looked at`);
  await finish(page);
  await ctx.clearPermissionOverrides();

  const denied = await open(`${SITE}/dealers.html`, { viewport: PHONE });
  await denied.page.click('.dealer-dock__near');
  await sleep(800);
  const note = await denied.page.$eval('#dealers-note', (el) => el.textContent);
  report('near me: refused, the page says what to do instead', /Search by city, area or pincode instead\.$/.test(note) && (await visible(denied.page)).length === 12, note, denied.errors);
  await finish(denied.page);
}

// ---------------------------------------------------------------- revalidation
{
  await fetch(`${MOCK}/__mock/reset`, { method: 'POST' });
  const { page, errors } = await open(`${SITE}/dealers.html`, { viewport: PHONE });
  // The first look at Paddock, after the page has painted and gone quiet.
  let asked = false;
  for (let i = 0; i < 40 && !asked; i++) {
    await sleep(150);
    asked = (await mockLog()).some((e) => e.path.startsWith('/api/public/website/dealers') && e.origin === SITE);
  }
  const unchanged = await page.evaluate(() => document.querySelectorAll('#dealers-list > li').length);
  report('fresh: asks Paddock after the first paint, and an unchanged list redraws nothing', asked && unchanged === 12, `asked ${asked}`, errors);

  // Scrolled into the list, so a change above the reader would move them if nothing held it.
  await page.evaluate(() => document.getElementById('d-cyber-city-motors').scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -100));
  await sleep(400);
  const anchorBefore = await page.$eval('#d-cyber-city-motors', (el) => el.getBoundingClientRect().top);
  await control({
    patch: { dealers: [{ id: 'dlrLajpat0002', name: 'Lajpat EV Point & Service', hoursNote: 'Closed for lunch from 1:30 to 3 PM. Service bay open all day on Saturdays, so ask for it at the counter.' }] },
    add: { dealers: [{ ...FIXTURE.dealers[0], id: 'dlrNew0013', slug: 'saket-ev-corner', name: 'Saket EV Corner', area: 'Saket', pincode: '110017', lat: 28.5245, lng: 77.2066, photo: { url: 'https://paddockgridx.app/api/public/website/dealers/photo/dlrNew0013-640.webp?v=1', w: 640, h: 480, alt: 'Saket EV Corner' } }] },
    remove: { dealers: ['dlrDaud0012'] },
  });
  await page.evaluate(() => window.gridDealersPage.refresh());
  // Past the moment the redrawn cards go back to content-visibility (dealers.js, 400ms).
  await sleep(900);
  const st = await page.evaluate(() => ({
    name: document.querySelector('#d-lajpat-ev-point .dealer__name').textContent,
    added: Boolean(document.getElementById('d-saket-ev-corner')),
    addedImg: Boolean(document.querySelector('#d-saket-ev-corner img')),
    addedNow: Boolean(document.querySelector('#d-saket-ev-corner [data-now]:not(.is-pending)')),
    removed: !document.getElementById('d-daudnagar-road-motors'),
    count: document.getElementById('dealers-count').textContent,
    anchor: document.getElementById('d-cyber-city-motors').getBoundingClientRect().top,
  }));
  report('fresh: a renamed, an added and a removed dealer, picked up in place', st.name === 'Lajpat EV Point & Service' && st.added && !st.addedImg && st.addedNow && st.removed && st.count === '12 dealers in 5 cities',
    JSON.stringify({ ...st, anchor: undefined }), errors);
  report('fresh: the list does not jump under the reader', Math.abs(st.anchor - anchorBefore) < 1.5, `card top ${anchorBefore.toFixed(1)} then ${st.anchor.toFixed(1)}`);
  // Paddock failing while a list is on show: the list stays, nothing alarming appears.
  await control({ modes: { dealers: 'error' }, patch: { dealers: [{ id: 'dlrOkhla0001', name: 'Okhla Swap Hub' }] } });
  await page.evaluate(() => window.gridDealersPage.refresh());
  await sleep(400);
  const quiet = await page.evaluate(() => ({ error: !document.getElementById('dealers-error').hidden, cards: document.querySelectorAll('#dealers-list > li').length }));
  report('fresh: Paddock failing later leaves the list as it was', !quiet.error && quiet.cards === 12, JSON.stringify(quiet));
  await finish(page);
  await fetch(`${MOCK}/__mock/reset`, { method: 'POST' });
}

// ---------------------------------------------------------------- built without data
{
  // Slow and then failing, so the loading cards are there to be seen first. The browser
  // reports the mock's 500 itself; that one is expected here.
  await control({ modes: { dealers: 'error', latencyMs: 1500 } });
  const { page, errors } = await open(`http://localhost:${SRC_PORT}/dealers.html`, { ignore: /status of 500/ });
  const loadingSeen = await page.evaluate(() => getComputedStyle(document.querySelector('.dealers-loading')).display);
  await sleep(2200);
  await control({ modes: { latencyMs: 0 } });
  const err = await page.evaluate(() => ({ shown: !document.getElementById('dealers-error').hidden, line: document.getElementById('dealers-error-line').textContent, loading: getComputedStyle(document.querySelector('.dealers-loading')).display }));
  await control({ modes: { dealers: 'ok' } });
  await page.click('#dealers-error [data-retry]');
  await sleep(800);
  const after = await page.evaluate(() => ({ cards: document.querySelectorAll('#dealers-list > li').length, error: !document.getElementById('dealers-error').hidden, count: document.getElementById('dealers-count').textContent, chips: document.querySelectorAll('.dealers-city').length, now: document.querySelectorAll('[data-now].is-pending').length }));
  report('no data: loading, then Paddock failing, then Try again', loadingSeen === 'grid' && err.shown && err.line === 'Something went wrong.' && err.loading === 'none' && after.cards === 12 && !after.error && after.chips === 6 && after.now === 0,
    `loading ${loadingSeen} → error "${err.line}" → ${after.cards} cards, "${after.count}"`, errors);
  const photos = await page.$$eval('#dealers-list img', (imgs) => imgs.length);
  report('no data: photos still only on Paddock are not shown', photos === 0, `${photos} images`);
  await finish(page);
}

// ---------------------------------------------------------------- the phone
{
  const { page, errors } = await open(`${SITE}/dealers.html`, {
    viewport: PHONE,
    before: (p) => p.evaluateOnNewDocument(() => {
      // A visual viewport the check can shrink, as a phone's keyboard does.
      let keyboard = 0;
      const target = new EventTarget();
      const vv = {
        get width() { return innerWidth; },
        get height() { return innerHeight - keyboard; },
        offsetTop: 0,
        offsetLeft: 0,
        get pageTop() { return scrollY; },
        pageLeft: 0,
        scale: 1,
        addEventListener: (...a) => target.addEventListener(...a),
        removeEventListener: (...a) => target.removeEventListener(...a),
      };
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
      window.__keyboard = (px) => {
        keyboard = px;
        target.dispatchEvent(new Event('resize'));
      };
    }),
  });
  await sleep(1200);
  const rects = () => page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
    const input = document.getElementById('dealer-q');
    return {
      dock: r(document.querySelector('.dealer-dock')),
      island: r(document.querySelector('.island')),
      input: r(input),
      typing: document.documentElement.classList.contains('is-typing'),
      compact: document.documentElement.classList.contains('is-compact'),
      vw: innerWidth,
      vh: innerHeight,
    };
  });
  const open1 = await rects();
  const clear = (s) => s.dock.bottom <= s.island.top - 4 && s.dock.top >= 0 && s.dock.left >= 0 && s.dock.right <= s.vw;
  report('phone: the dock sits clear above the nav pill', clear(open1), `dock ${open1.dock.top.toFixed(0)} to ${open1.dock.bottom.toFixed(0)}, pill from ${open1.island.top.toFixed(0)} (open)`, errors);
  await page.evaluate(() => window.scrollBy(0, 600));
  await sleep(1400);
  const compact = await rects();
  report('phone: and above the pill folded to its circle', compact.compact && clear(compact), `dock bottom ${compact.dock.bottom.toFixed(0)}, pill top ${compact.island.top.toFixed(0)}`);
  // The space under the last card clears the dock and the pill together.
  const room = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#dealers-list > li')];
    const last = cards[cards.length - 1].getBoundingClientRect();
    const main = document.getElementById('dealers').getBoundingClientRect();
    return { below: main.bottom - last.bottom, needed: innerHeight - document.querySelector('.dealer-dock').getBoundingClientRect().top };
  });
  report('phone: the last card can scroll clear of the dock and the pill', room.below >= room.needed, `${room.below.toFixed(0)}px under the last card, ${room.needed.toFixed(0)}px needed`);

  await page.focus('#dealer-q');
  await sleep(100);
  await page.evaluate(() => window.__keyboard(336));
  await sleep(400);
  const typing = await rects();
  const top = typing.vh - 336;
  report('phone: with the keyboard up, the dock rides on top of it', typing.typing && typing.dock.bottom <= top && typing.dock.bottom >= top - 40 && typing.dock.top >= 0
    && typing.input.top >= 0 && typing.input.bottom <= top,
    `keyboard from ${top}, dock ${typing.dock.top.toFixed(0)} to ${typing.dock.bottom.toFixed(0)}, field ${typing.input.top.toFixed(0)} to ${typing.input.bottom.toFixed(0)}`);
  await page.type('#dealer-q', 'delhi', { delay: 10 });
  await sleep(200);
  const typed = await rects();
  report('phone: and stays there while typing', typed.typing && typed.dock.bottom <= top, `dock bottom ${typed.dock.bottom.toFixed(0)}`);
  await page.evaluate(() => { document.activeElement.blur(); window.__keyboard(0); });
  await sleep(400);
  const down = await rects();
  report('phone: keyboard down, the dock goes back above the pill', !down.typing && clear(down), `dock bottom ${down.dock.bottom.toFixed(0)}`);
  await finish(page);
}

// ---------------------------------------------------------------- policy, over everything above
report('policy: no image asked for from anywhere but the site', offSite.length === 0, offSite.length ? offSite.slice(0, 5).join(', ') : 'every image request was same-origin');
report('policy: no Content Security Policy violations', violations.length === 0, violations.length ? violations.slice(0, 5).join(' | ') : 'none reported');

await browser.close();
server.close();
sources.close();
await mock.close();
if (!keep) fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`build kept at ${OUT}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall dealers checks passed');
process.exitCode = failed ? 1 : 0;
