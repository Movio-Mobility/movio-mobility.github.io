#!/usr/bin/env node
/*
 * What search engines read, checked (npm run check:seo).
 *
 *   node tools/check/seo.mjs                against dist/ (build first)
 *   node tools/check/seo.mjs --root=<dir>   against another build
 *
 * Sources: every indexable page's head has one title (at most 60 characters), one description
 * (50 to 160), one absolute canonical; the noindex pages (404, interview, better) carry
 * noindex and none of the search tags; every share card is a real JPEG at 1200 by 630 under
 * 300 KB; tools/seo.mjs holds the same launch instant as assets/launch.js; and while the Gen2
 * offer still says PreOrder, a review date bounds how long that can stay unexamined.
 *
 * The build: every indexable page's og:url equals its canonical, its og:image is an absolute
 * address on the site that resolves to a shipped file, its JSON-LD parses, every price an
 * offer claims is printed on the page, the FAQ data says exactly what the page says, the
 * sitemap lists every page once with the home page first and every address serving, and
 * robots.txt ships byte for byte.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../serve.mjs';
import { GEN2, PHONE, SOCIAL, faqJsonLd } from '../seo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const OUT = rootArg ? path.resolve(rootArg.slice(7)) : path.join(REPO, 'dist');

let failed = 0;
const report = (label, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};

const ORIGIN = 'https://gridxenergy.in';
const INDEXABLE = ['index.html', 'store.html', 'powerpod-gen2.html', 'chargers.html', 'adapter.html',
  'vehicle-dock.html', 'journey.html', 'dealers.html', 'support.html', 'careers.html',
  'privacy_policy.html', 'subscription_policy.html'];
const NOINDEX = ['404.html', 'interview.html', 'better.html'];
const CARDS = ['home.jpg', 'powerpod-gen2.jpg', 'store.jpg', 'adapter.jpg', 'vehicle-dock.jpg', 'brand.jpg'];

// While the Gen2 offer says PreOrder, someone has to look at it again by this date: either
// Gen2 ships and GEN2.availability becomes InStock in tools/seo.mjs, or this date moves.
const GEN2_REVIEW = Date.UTC(2027, 2, 31);

const src = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const meta = (html, name) => (html.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`)) || [])[1];
const canonicalOf = (html) => (html.match(/<link rel="canonical" href="([^"]*)">/) || [])[1];
const visible = (html) => html
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#8377;|&#x20b9;/g, '₹')
  .replace(/\s+/g, ' ');

/** A JPEG's width and height, from its start-of-frame marker. */
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// ---------------------------------------------------------------- the sources
for (const page of INDEXABLE) {
  const html = src(page);
  const problems = [];
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)];
  const descriptions = [...html.matchAll(/<meta name="description" content="([^"]*)">/g)];
  const canonicals = [...html.matchAll(/<link rel="canonical"/g)];
  const h1s = [...html.matchAll(/<h1[\s>]/g)];
  if (titles.length !== 1 || titles[0][1].length > 60) problems.push(`title ${titles.length ? titles[0][1].length + ' chars' : 'missing'}`);
  if (descriptions.length !== 1 || descriptions[0][1].length < 50 || descriptions[0][1].length > 160) {
    problems.push(`description ${descriptions.length ? descriptions[0][1].length + ' chars' : 'missing'}`);
  }
  if (canonicals.length !== 1) problems.push(`${canonicals.length} canonicals`);
  const want = page === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${page}`;
  if (canonicalOf(html) !== want) problems.push(`canonical ${canonicalOf(html)}`);
  if (page !== 'interview.html' && h1s.length !== 1) problems.push(`${h1s.length} h1s`);
  report(`${page}: one title (<= 60), one description (50-160), the canonical, one h1`, !problems.length, problems.join('; '));
}
for (const page of NOINDEX) {
  const html = src(page);
  const ok = /<meta name="robots" content="noindex/.test(html)
    && !/rel="canonical"/.test(html) && !/property="og:/.test(html) && !/application\/ld\+json/.test(html);
  report(`${page}: noindex, and none of the search tags`, ok);
}
for (const card of CARDS) {
  const buf = fs.readFileSync(path.join(REPO, 'assets/og', card));
  const size = jpegSize(buf);
  report(`assets/og/${card}: a 1200 by 630 JPEG under 300 KB`,
    size && size.w === 1200 && size.h === 630 && buf.length < 300 * 1024,
    size ? `${size.w}x${size.h}, ${(buf.length / 1024).toFixed(0)} KB` : 'not a JPEG');
}

// The launch instant, in both places.
{
  const m = src('assets/launch.js').match(/Date\.UTC\((\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/);
  const launchJs = m && Date.UTC(+m[1], +m[2], +m[3], +m[4], +m[5]);
  const seoMjs = Date.parse(GEN2.availabilityStarts);
  report('tools/seo.mjs and assets/launch.js hold the same launch instant', m && launchJs === seoMjs,
    `${launchJs} vs ${seoMjs}`);
  report('the Gen2 offer has been looked at recently enough',
    GEN2.availability !== 'PreOrder' || Date.now() < GEN2_REVIEW,
    'still PreOrder: if Gen2 ships now, make GEN2.availability "InStock" in tools/seo.mjs; if not, move GEN2_REVIEW in this check');
}

// ---------------------------------------------------------------- the build
if (!fs.existsSync(path.join(OUT, 'index.html'))) {
  report(`a build at ${OUT} (run npm run build first)`, false);
} else {
  const built = (rel) => fs.readFileSync(path.join(OUT, rel), 'utf8');
  for (const page of INDEXABLE) {
    const html = built(page);
    const problems = [];
    const canonical = canonicalOf(html);
    const image = meta(html, 'og:image');
    // careers.html's card comes from the careers pipeline; built with no careers data it may
    // point at Paddock's address, which is the documented fallback.
    const fromCareers = page === 'careers.html';
    if (meta(html, 'og:url') !== canonical) problems.push(`og:url ${meta(html, 'og:url')} vs canonical ${canonical}`);
    if (!image || !/^https:\/\//.test(image)) problems.push(`og:image ${image}`);
    if (image && image.startsWith(`${ORIGIN}/`) ) {
      const rel = image.slice(ORIGIN.length + 1).split('?')[0];
      const file = path.join(OUT, rel);
      if (!fs.existsSync(file)) problems.push(`og:image file missing: ${rel}`);
      else {
        const size = jpegSize(fs.readFileSync(file));
        if (!size || size.w !== 1200 || size.h !== 630) problems.push(`og:image ${size ? `${size.w}x${size.h}` : 'not a JPEG'}`);
        if (fs.statSync(file).size >= 300 * 1024) problems.push('og:image over 300 KB');
      }
    } else if (image && !fromCareers) problems.push(`og:image off the site: ${image}`);
    if (!meta(html, 'twitter:card')) problems.push('no twitter:card');
    if (!/<meta http-equiv="Content-Security-Policy"/.test(html)) problems.push('no CSP meta');
    report(`built ${page}: the card is whole and its picture ships`, !problems.length, problems.join('; '));

    // Its structured data parses, and its offers' prices are printed on the page.
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const dataProblems = [];
    const text = visible(html);
    for (const [, block] of blocks) {
      let graph;
      try {
        graph = JSON.parse(block);
      } catch (e) {
        dataProblems.push(`does not parse: ${e.message}`);
        continue;
      }
      for (const node of graph['@graph'] || [graph]) {
        for (const offer of [node.offers].flat().filter(Boolean)) {
          const printed = `₹${new Intl.NumberFormat('en-IN').format(+offer.price)}`;
          if (!text.includes(printed)) dataProblems.push(`${node.name}: ${printed} not on the page`);
        }
        if (node['@type'] === 'Organization' && node.sameAs) {
          if (!node.sameAs.every((u) => /^https:\/\//.test(u))) dataProblems.push('sameAs not all https');
          if (node.contactPoint && node.contactPoint.telephone !== PHONE) dataProblems.push('phone drifted');
          if (node.sameAs.length !== SOCIAL.length) dataProblems.push('sameAs drifted');
        }
      }
    }
    report(`built ${page}: the structured data parses and tells the page's truth`,
      !dataProblems.length, dataProblems.join('; '));
  }

  // The FAQ data says exactly what the page says, question for question.
  {
    const html = built('support.html');
    const graph = JSON.parse((html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1]);
    const data = (graph['@graph'] || [graph]).find((n) => n['@type'] === 'FAQPage');
    const onPage = faqJsonLd(html).mainEntity.map((q) => q.name);
    const inData = (data ? data.mainEntity : []).map((q) => q.name);
    report('built support.html: the FAQ data asks exactly the questions the page asks',
      inData.length >= 10 && JSON.stringify(onPage) === JSON.stringify(inData),
      `${inData.length} in the data, ${onPage.length} on the page`);
  }

  report('robots.txt ships byte for byte', built('robots.txt') === src('robots.txt'));

  // The sitemap: every page once, the home page first, every address serving.
  const locs = [...built('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  const lastmods = [...built('sitemap.xml').matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].map((m) => m[1]);
  const problems = [];
  if (locs[0] !== `${ORIGIN}/`) problems.push(`first is ${locs[0]}`);
  if (new Set(locs).size !== locs.length) problems.push('duplicates');
  for (const page of NOINDEX) if (locs.includes(`${ORIGIN}/${page}`)) problems.push(`${page} listed`);
  for (const page of INDEXABLE) {
    const want = page === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${page}`;
    if (!locs.includes(want)) problems.push(`${page} missing`);
  }
  if (!lastmods.every((d) => /^\d{4}-\d{2}-\d{2}/.test(d) && !Number.isNaN(Date.parse(d)))) problems.push('a lastmod does not parse');
  report('sitemap.xml: home first, every page once, dates that parse', !problems.length, problems.join('; '));

  const server = await serve({ root: OUT, port: 8149, quiet: true });
  try {
    const bad = [];
    for (const loc of locs) {
      const url = loc.replace(ORIGIN, 'http://localhost:8149');
      const r = await fetch(url).catch(() => null);
      if (!r || r.status !== 200 || !/text\/html/.test(r.headers.get('content-type') || '')) {
        bad.push(`${loc} ${r ? r.status : 'unreachable'}`);
      }
    }
    report(`every sitemap address serves (${locs.length})`, !bad.length, bad.slice(0, 3).join('; '));
  } finally {
    server.close();
  }
}

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
