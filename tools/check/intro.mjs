#!/usr/bin/env node
// Watches the home page's opening: canvas density over time, riders, errors.
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';
const port = 8092;
const server = await serve({ root: process.argv[2] || '.', port, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/localhost:3000|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`${m.type()}: ${m.text()}`); });
await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });
const t0 = Date.now();
for (const at of [1, 3, 6, 9, 12, 15, 20, 26]) {
  await new Promise((r) => setTimeout(r, Math.max(0, at * 1000 - (Date.now() - t0))));
  const st = await page.evaluate(() => {
    const bg = document.getElementById('bg');
    return `${bg.width}x${bg.height} cls=${document.documentElement.className} revealed=${document.querySelector('.headline').classList.contains('is-revealed')}`;
  });
  console.log(`t=${at}s ${st}`);
}
console.log(errors.length ? errors.join('\n') : 'no errors');
await browser.close();
server.close();
