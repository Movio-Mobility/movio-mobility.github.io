#!/usr/bin/env node
/*
 * Whether every language fits, at every size (tools/i18n.mjs; the device sweep rule: nothing
 * overlapping, clipped, scrolling sideways or wrapping where it should not).
 *
 *   node tools/check/i18n-fit.mjs                      the five languages, every page, every size
 *   node tools/check/i18n-fit.mjs --lang hi,qps        some (qps: the pseudo-locale, longer than any)
 *   node tools/check/i18n-fit.mjs --pages index,store  some pages
 *   node tools/check/i18n-fit.mjs --root dist          the build rather than the working copy
 *   node tools/check/i18n-fit.mjs --port 8170          its own port, to run languages side by side
 *
 * Every finding is held against the English page at the same size, element for element (the
 * copies share the English markup), so only what the language itself breaks is reported.
 * Text hidden for screen readers (.sr-only, clipped to a pixel) is clipped on purpose.
 *
 * At each size, on each translated page:
 *   - no sideways scroll
 *   - no text cut off: nothing set on one line (white-space: nowrap) is wider than its box
 *     where the box hides its overflow or ends it in an ellipsis
 *   - the island's labels fit their slots (52px each on a phone)
 *   - the language button clears the logo and the page's title
 *   - on the home page, at phone sizes, the tallest caption is at most 1.25x the English one
 *     (it sets the text line for every beat, and the pod's room with it)
 * and a screenshot of each goes to tools/check/out/i18n-fit/<lang>/, to be looked at by eye.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { serve } from '../serve.mjs';
import { CHROME, CHROME_ARGS } from '../perf/run.mjs';
import { LANGS, PAGES_IN_EVERY_LANGUAGE } from '../i18n.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = path.resolve(opt('root', '.'));
const langs = opt('lang', LANGS.join(',')).split(',');
const pages = opt('pages', PAGES_IN_EVERY_LANGUAGE.filter((p) => p !== 'better.html').map((p) => p.replace(/\.html$/, '')).join(',')).split(',');
const SIZES = (opt('sizes', '') || '280x653,320x568,360x780,390x844,430x932,844x390,768x1024,1024x768,1280x800,1440x900,2560x1440')
  .split(',').map((s) => s.split('x').map(Number));
const OUT = path.resolve('tools/check/out/i18n-fit');
const PORT = Number(opt('port', 8163));

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  if (!ok || process.env.VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};

const server = await serve({ root, port: PORT, quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [...CHROME_ARGS, '--lang=en-US'] });

async function measure(url, [w, h]) {
  const page = await browser.newPage();
  const phone = w < 760 || h < 500;
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: phone, hasTouch: w < 1025 || h < 500 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await new Promise((r) => setTimeout(r, 1800));
  const m = await page.evaluate(() => {
    const out = { sideways: 0, clipped: [], island: [], overlap: null, caption: 0 };
    out.sideways = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth;
    // The element's place in the page, the same in every language.
    const where = (el) => {
      const parts = [];
      for (let n = el; n && n !== document.body; n = n.parentElement) parts.push([...n.parentElement.children].indexOf(n));
      return parts.reverse().join('.');
    };
    const shown = (el) => {
      if (el.closest('[hidden], [aria-hidden="true"] [hidden], .sr-only, .visually-hidden')) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const el of document.querySelectorAll('body *')) {
      if (!el.childNodes.length || el.closest('svg, .film__device, .lang__menu, .lang__offers')) continue;
      const cs = getComputedStyle(el);
      if (cs.whiteSpace !== 'nowrap' && cs.whiteSpace !== 'pre') continue;
      if (cs.overflowX === 'visible' && cs.textOverflow !== 'ellipsis') continue;
      if (!shown(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 2 && box.height <= 2) continue; // clipped to a pixel: for screen readers
      if (el.scrollWidth > el.clientWidth + 1 && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
        out.clipped.push({ at: where(el), say: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} "${el.textContent.trim().slice(0, 30)}" ${el.scrollWidth}>${el.clientWidth}` });
      }
    }
    for (const label of document.querySelectorAll('.island__label')) {
      if (!shown(label)) continue;
      const link = label.closest('.island__link');
      const lr = label.getBoundingClientRect();
      const kr = link.getBoundingClientRect();
      if (lr.width > kr.width + 0.5 || label.scrollWidth > label.clientWidth + 1) out.island.push({ at: where(label), say: `"${label.textContent.trim()}" ${Math.round(lr.width)}>${Math.round(kr.width)}` });
    }
    const btn = document.querySelector('.lang__btn');
    const left = document.querySelector('.brand-lockup') || document.querySelector('.topbar .brand');
    if (btn && left && shown(btn)) {
      const a = btn.getBoundingClientRect();
      const b = left.getBoundingClientRect();
      const title = left.querySelector('.headline');
      const t = title ? title.getBoundingClientRect() : b;
      const right = Math.max(b.left + (left.scrollWidth || b.width), t.right);
      if (a.left < right + 6 && a.top < b.bottom && a.bottom > b.top) out.overlap = `button at ${Math.round(a.left)}, the lockup ends at ${Math.round(right)}`;
    }
    for (const c of document.querySelectorAll('.film__caption')) out.caption = Math.max(out.caption, c.scrollHeight);
    return out;
  });
  return { page, m };
}

// The English, measured once per page and size: what it already does is not the language's doing.
const english = new Map();
async function englishOf(name, size) {
  const key = `${name} ${size.join('x')}`;
  if (!english.has(key)) {
    const { page, m } = await measure(`http://localhost:${PORT}/${name}.html?check`, size);
    await page.close();
    english.set(key, m);
  }
  return english.get(key);
}

for (const lang of langs) {
  fs.mkdirSync(path.join(OUT, lang), { recursive: true });
  for (const name of pages) {
    for (const size of SIZES) {
      const tag = `${lang}/${name} ${size.join('x')}`;
      const en = await englishOf(name, size);
      const { page, m } = await measure(`http://localhost:${PORT}/${lang}/${name}.html?check`, size);
      await page.screenshot({ path: path.join(OUT, lang, `${name}-${size.join('x')}.png`) });
      await page.close();
      const problems = [];
      const fresh = (list, base) => list.filter((x) => !base.some((b) => b.at === x.at));
      if (m.sideways > 1 && m.sideways > en.sideways + 1) problems.push(`scrolls sideways by ${m.sideways}px`);
      const clipped = fresh(m.clipped, en.clipped);
      if (clipped.length) problems.push(`cut off: ${clipped.slice(0, 3).map((x) => x.say).join('; ')}`);
      const island = fresh(m.island, en.island);
      if (island.length) problems.push(`island labels: ${island.map((x) => x.say).join(', ')}`);
      if (m.overlap && !en.overlap) problems.push(`the language button meets the lockup (${m.overlap})`);
      if (name === 'index' && en.caption && size[0] < 760 && size[1] > 500 && m.caption > en.caption * 1.25) problems.push(`tallest caption ${m.caption}px, English ${en.caption}px`);
      report(tag, !problems.length, problems.join(' | '));
    }
  }
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed (screenshots in ${path.relative(process.cwd(), OUT)})` : `\nevery language fits (screenshots in ${path.relative(process.cwd(), OUT)})`);
process.exitCode = failed ? 1 : 0;
