#!/usr/bin/env node
/*
 * The film's phone as a still (the finale, "Made in India. Every inch of it."), rendered from
 * the page's own CSS phone so the still and the live phone can never disagree.
 *
 *   node tools/source/phone-still.mjs      writes tools/check/out/phone-home.png
 *
 * The page is settled on the first app beat, the app's own small animations are stopped, and the
 * phone is laid out at its real size in points (471 x 987, --k 1), without the soft shadow the
 * film gives it: tools/source/stills.py lays the same ground shadow under it as under the pods,
 * so the three read as one lit set. The app's evening, as everywhere in the film.
 * Rendered at 2x on a transparent background.
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
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(REPO, 'tools/check/out/phone-home.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve({ root: REPO, port: 8147, quiet: true });
const chrome = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] });
try {
  const page = await chrome.newPage();
  await page.setViewport({ width: 1600, height: 1300, deviceScaleFactor: 2 });
  await page.goto('http://localhost:8147/index.html?check', { waitUntil: 'load' });
  await sleep(1500);
  await page.evaluate(() => {
    const vh = document.getElementById('bg').clientHeight || innerHeight;
    window.scrollTo({ top: 8.45 * vh, behavior: 'instant' });
  });
  // The film settles, the app makes its entrance and its first readings arrive.
  await sleep(4000);

  const clip = await page.evaluate(() => {
    for (const a of document.getAnimations()) a.pause();
    const device = document.querySelector('.film__device');
    const phone = device.querySelector('.phone');
    // Only the phone, at its own size, on nothing.
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    for (const el of document.querySelectorAll('#bg, .topbar, .hero, .film > :not(.film__device), .credits')) el.style.visibility = 'hidden';
    Object.assign(device.style, { opacity: '1', visibility: 'visible', transform: 'translate(-50%, -50%)', height: '987px', top: '50%', left: '50%' });
    device.style.setProperty('--k', '1');
    // The frame keeps its own edges (the insets); the film's drop shadow goes.
    const insets = getComputedStyle(phone).boxShadow.split(/,(?![^(]*\))/).filter((s) => /inset/.test(s));
    phone.style.boxShadow = insets.join(',') || 'none';
    // The side buttons stand a few points proud of the frame.
    const r = phone.getBoundingClientRect();
    // (A clip is measured from the top of the page, not of the screen.)
    return { x: r.left - 8 + scrollX, y: r.top - 4 + scrollY, width: r.width + 16, height: r.height + 8 };
  });
  await sleep(300);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // Within the screen: capturing beyond it would resize the page, and the film with it.
  await page.screenshot({ path: OUT, clip, omitBackground: true, captureBeyondViewport: false });
  console.log(`${path.relative(REPO, OUT)}  ${Math.round(clip.width * 2)}x${Math.round(clip.height * 2)}`);
} finally {
  await chrome.close();
  server.close();
}
