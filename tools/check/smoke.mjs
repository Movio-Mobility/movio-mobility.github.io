#!/usr/bin/env node
/*
 * Loads each page in headless Chrome and reports console errors, failed requests and the
 * state of the field and governor. A quick "does it still run" pass after a change.
 *   node tools/check/smoke.mjs [--root dir] [--pages index,store] [--wait 4000] [--query perf]
 */
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = path.resolve(opt('root', '.'));
const pages = opt('pages', 'index,journey,store,powerpod-gen2,adapter,vehicle-dock,chargers,support,careers,dealers,privacy_policy').split(',');
const wait = Number(opt('wait', 4000));
const query = opt('query', '');
const port = 8091;

const server = await serve({ root, port, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
let failures = 0;
for (const name of pages) {
  for (const vp of [{ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, { width: 1440, height: 900, deviceScaleFactor: 2 }]) {
    const page = await browser.newPage();
    await page.setViewport(vp);
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
    await page.goto(`http://localhost:${port}/${name}.html${query ? `?${query}` : ''}`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, wait));
    const state = await page.evaluate(() => {
      const bg = document.getElementById('bg');
      const pod = document.getElementById('pod');
      const P = window.GridPerf;
      return {
        cls: document.documentElement.className,
        bg: bg ? `${bg.width}x${bg.height} css ${bg.clientWidth}x${bg.clientHeight}` : 'none',
        pod: pod ? `${pod.width}x${pod.height}` : 'none',
        perf: P ? `tier ${P.tier} cap ${P.capHz} pod ${P.podLevel} shed ${P.shed} hz ${Math.round(P.refreshHz)} gpu ${P.gpu.slice(0, 40)}` : 'missing',
        bgApi: !!window.gridBG,
      };
    });
    // The dev API (localhost:3000) is not running here, and Razorpay refuses headless loads.
    // (A 404 also shows up as a console line without its URL; the response handler above
    // reports it with the URL, which is where favicon.ico, the one the site lacks, is let off.)
    const bad = errors.filter((e) => !/favicon|localhost:3000|ERR_CONNECTION_REFUSED|razorpay|status of 404/i.test(e));
    if (bad.length) failures++;
    console.log(`${name} @${vp.width}x${vp.height}x${vp.deviceScaleFactor}: ${JSON.stringify(state)}`);
    for (const e of bad) console.log(`   ${e}`);
    await page.close();
  }
}
await browser.close();
server.close();
process.exitCode = failures ? 1 : 0;
