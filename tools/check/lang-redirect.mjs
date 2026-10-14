#!/usr/bin/env node
/*
 * The way into the site's languages (assets/i18n.js, assets/lang.js), in Chrome, against the
 * working copy (tools/serve.mjs makes the /hi/ pages on the fly) and a stand-in for Paddock
 * on localhost:3000 that answers region and counts every pageview.
 *
 *   node tools/check/lang-redirect.mjs
 *
 *   1. a device set to Hindi, arriving from Google at /store.html, lands on /hi/store.html;
 *      exactly one pageview is counted, by the Hindi page, carrying Google as its referrer
 *   2. a click inside the site never sends anyone by device language (only an arrival does)
 *   3. a page kept in English (a policy, careers) is never left, and nor is anything under ?check
 *   4. ?lang=en wins over the device, is remembered, and leaves the address clean
 *   5. with storage blocked, a reader who picks English stays in English page after page
 *   6. a page in a language folder is never left: a shared Hindi link opens in Hindi
 *   7. a tab that was reading Hindi comes back to Hindi from an English-only page
 *   8. the state offer: shown once, from Paddock's region, in that language; never again
 *   9. the picker works with JavaScript off: it opens, and its rows link to this page's copies
 *  10. the 404 page keeps a reader in their language folder
 */
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { CHROME } from '../perf/run.mjs';

const PORT = 8161;
const BASE = `http://localhost:${PORT}`;
let failed = 0;
const report = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};

const server = await serve({ root: '.', port: PORT, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--lang=en-US'] });

/** A fresh profile (no storage) with the given device languages, and Paddock stood in for. */
async function visitor({ languages = ['en-US', 'en'], region = null, blockStorage = false, js = true } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setJavaScriptEnabled(js);
  const views = [];
  const regionCalls = [];
  await page.evaluateOnNewDocument((langs, block) => {
    Object.defineProperty(navigator, 'languages', { get: () => langs });
    Object.defineProperty(navigator, 'language', { get: () => langs[0] });
    if (block) {
      const deny = () => { throw new DOMException('blocked', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', { get: deny });
      Object.defineProperty(window, 'sessionStorage', { get: deny });
    }
  }, languages, blockStorage);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (!url.startsWith('http://localhost:3000/')) return req.continue();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    if (url.includes('/region')) {
      regionCalls.push(page.url());
      return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ state: region }) });
    }
    if (url.includes('/pageview')) {
      try { views.push({ from: page.url(), body: JSON.parse(req.postData() || '{}') }); } catch { views.push({ from: page.url(), body: {} }); }
    }
    return req.respond({ status: 204, headers: cors });
  });
  return { context, page, views, regionCalls };
}
const path = (page) => page.url().replace(BASE, '');
const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));
/** Send the pageview now (it otherwise waits for idle or for the page to be left). */
const flush = (page) => page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => {});

// 1. arriving from Google with a Hindi device
{
  const v = await visitor({ languages: ['hi-IN', 'en-IN'] });
  // An http referrer: Chrome sends none from https to this http server (live, both are https).
  await v.page.goto(`${BASE}/store.html`, { waitUntil: 'networkidle2', referer: 'http://www.google.com/' });
  await settle();
  await flush(v.page);
  await settle(600);
  const landed = path(v.page);
  const hiViews = v.views.filter((x) => x.body.path === '/hi/store.html');
  const enViews = v.views.filter((x) => x.body.path === '/store.html');
  report('a Hindi device arriving lands in Hindi', landed === '/hi/store.html', landed);
  report('counted once, by the page it landed on', hiViews.length === 1 && enViews.length === 0, `${hiViews.length} Hindi, ${enViews.length} English pageviews`);
  report('with the referrer it arrived with', hiViews[0] && hiViews[0].body.referrer === 'http://www.google.com/', hiViews[0] ? hiViews[0].body.referrer : 'none');

  // 6. a Hindi link stays Hindi, and so does the rest of the tab
  await v.page.goto(`${BASE}/hi/dealers.html`, { waitUntil: 'networkidle2' });
  report('a page in a language folder is never left', path(v.page) === '/hi/dealers.html', path(v.page));
  await v.context.close();
}

// 2. a click inside the site does not send anyone by device language
{
  const v = await visitor({ languages: ['hi-IN'] });
  await v.page.goto(`${BASE}/privacy_policy.html`, { waitUntil: 'networkidle2' });
  report('a policy is never left', path(v.page) === '/privacy_policy.html', path(v.page));
  await Promise.all([v.page.waitForNavigation({ waitUntil: 'networkidle2' }), v.page.evaluate(() => { location.href = '/store.html'; })]);
  await settle(600);
  report('a click inside the site stays where it goes', path(v.page) === '/store.html', path(v.page));
  await v.page.goto(`${BASE}/careers.html`, { waitUntil: 'networkidle2' });
  report('careers is never left', path(v.page) === '/careers.html', path(v.page));
  await v.context.close();
}

// 3. ?check leaves everything where it is
{
  const v = await visitor({ languages: ['te-IN'] });
  await v.page.goto(`${BASE}/support.html?check`, { waitUntil: 'networkidle2' });
  report('?check never redirects', path(v.page) === '/support.html?check', path(v.page));
  await v.context.close();
}

// 4. ?lang=en
{
  const v = await visitor({ languages: ['kn-IN'] });
  await v.page.goto(`${BASE}/store.html?lang=en&utm_source=x`, { waitUntil: 'networkidle2' });
  report('?lang=en wins over the device', path(v.page) === '/store.html?utm_source=x', path(v.page));
  await v.page.goto(`${BASE}/support.html`, { waitUntil: 'networkidle2' });
  report('and is remembered on the next arrival', path(v.page) === '/support.html', path(v.page));
  await v.context.close();
}

// 5. storage blocked
{
  const v = await visitor({ languages: ['bn-IN'], blockStorage: true });
  await v.page.goto(`${BASE}/journey.html`, { waitUntil: 'networkidle2' });
  const first = path(v.page);
  await Promise.all([v.page.waitForNavigation({ waitUntil: 'networkidle2' }), v.page.evaluate(() => { location.href = '/journey.html?lang=en'; })]);
  await Promise.all([v.page.waitForNavigation({ waitUntil: 'networkidle2' }), v.page.evaluate(() => { location.href = '/store.html'; })]);
  report('with storage blocked, English stays English page after page', first === '/bn/journey.html' && path(v.page) === '/store.html', `${first}, then ${path(v.page)}`);
  await v.context.close();
}

// 7. a tab reading Hindi comes back to Hindi
{
  const v = await visitor({ languages: ['en-US'] });
  await v.page.goto(`${BASE}/hi/store.html`, { waitUntil: 'networkidle2' });
  await Promise.all([v.page.waitForNavigation({ waitUntil: 'networkidle2' }), v.page.evaluate(() => { location.href = '/warranty_terms.html'; })]);
  await Promise.all([v.page.waitForNavigation({ waitUntil: 'networkidle2' }), v.page.evaluate(() => { location.href = '/support.html'; })]);
  report('a tab reading Hindi comes back to Hindi', path(v.page) === '/hi/support.html', path(v.page));
  await v.context.close();
}

// 8. the offer
{
  const v = await visitor({ languages: ['en-IN'], region: 'Maharashtra' });
  await v.page.goto(`${BASE}/store.html`, { waitUntil: 'networkidle2' });
  const shown = await v.page.waitForFunction(() => {
    const card = document.querySelector('[data-lang-offer="mr"]');
    return card && !card.hidden;
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  const others = await v.page.evaluate(() => [...document.querySelectorAll('[data-lang-offer]')].filter((c) => !c.hidden).map((c) => c.dataset.langOffer));
  report('the offer comes in Marathi to a reader in Maharashtra', shown && others.join() === 'mr', `shown ${shown}, visible ${others.join() || 'none'}`);
  await v.page.goto(`${BASE}/support.html`, { waitUntil: 'networkidle2' });
  await settle(6000);
  const again = await v.page.evaluate(() => [...document.querySelectorAll('[data-lang-offer]')].some((c) => !c.hidden));
  report('only once, and Paddock is asked once', !again && v.regionCalls.length === 1, `shown again ${again}, region asked ${v.regionCalls.length} times`);
  await v.context.close();

  const w = await visitor({ languages: ['en-IN'], region: 'Tamil Nadu' });
  await w.page.goto(`${BASE}/store.html`, { waitUntil: 'networkidle2' });
  await settle(6000);
  const none = await w.page.evaluate(() => [...document.querySelectorAll('[data-lang-offer]')].every((c) => c.hidden));
  report('a state with no language of ours is offered nothing', none);
  await w.context.close();
}

// 9. no JavaScript
{
  const v = await visitor({ js: false });
  await v.page.goto(`${BASE}/hi/store.html`, { waitUntil: 'networkidle2' });
  const rows = await v.page.evaluate(() => {
    document.querySelector('.lang__btn').click();
    const open = document.querySelector('.lang__pick').open;
    const links = Object.fromEntries([...document.querySelectorAll('.lang__row')].map((a) => [a.hreflang, a.getAttribute('href')]));
    return { open, links };
  });
  const want = { en: '../store.html?lang=en', hi: 'store.html', mr: '../mr/store.html', bn: '../bn/store.html', kn: '../kn/store.html', te: '../te/store.html' };
  report('the picker opens with JavaScript off, its rows this page in each language', rows.open && JSON.stringify(rows.links) === JSON.stringify(want), JSON.stringify(rows.links));
  await v.context.close();
}

// 10. the 404 page
{
  const v = await visitor();
  await v.page.goto(`${BASE}/mr/no-such-page`, { waitUntil: 'networkidle2' });
  await settle(600);
  report('a missing page in a language folder is that language\'s 404', path(v.page) === '/mr/404.html', path(v.page));
  await v.page.goto(`${BASE}/te/aboutus`, { waitUntil: 'networkidle2' });
  await settle(600);
  report('an old link in a language folder lands in that language', path(v.page) === '/te/journey.html', path(v.page));
  await v.context.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall language redirect checks passed');
process.exitCode = failed ? 1 : 0;
