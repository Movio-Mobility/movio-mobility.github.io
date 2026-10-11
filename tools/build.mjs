#!/usr/bin/env node
/*
 * The deployable site, in dist/. The sources stay exactly as they are and stay the thing to
 * edit; this only makes a smaller, cache-friendly copy of them for GitHub Pages.
 *
 *   npm run build                    → dist/
 *   node tools/build.mjs --out <dir> → <dir>   (or BUILD_OUT=<dir>), so a check can build
 *                                      without clobbering dist/
 *
 * What it does:
 *   - Minifies every script and stylesheet (esbuild), file by file. Nothing is bundled and no
 *     syntax is rewritten, so each script still runs as the classic script it was written as,
 *     with its globals where they were.
 *   - Minifies the scripts and styles written inline in the pages, and drops the HTML
 *     comments. Whitespace between tags is left alone: the headlines are split into words
 *     with spaces between them, and collapsing it is not worth the risk for what gzip saves.
 *     Data blocks (<script type="application/json"> and application/ld+json) are not code
 *     and go out byte for byte.
 *   - Inlines the two tiny scripts every visit needs before anything else (perf.js, and
 *     pod-assets.js where the pod is), saving a request each.
 *   - Versions every local asset reference with ?v=<content hash>: in pages, in stylesheets
 *     and in script string literals. GitHub Pages caches everything for ten minutes and lets
 *     nothing be configured, so the version is what lets the service worker (sw.js) keep a
 *     file until it really changes. A query rather than a renamed file, so a page still
 *     cached from the last deploy never asks for a file that no longer exists.
 *   - Copies assets/ without what no page uses (the source renders and CAD exports in
 *     productImages, the base64 model) and checks that every local reference resolves.
 *   - Writes sw.js, sitemap.xml, .nojekyll and, if present, CNAME, robots.txt and the icons.
 *   - Builds 404.html with root-absolute references (prefix '/'), because GitHub Pages serves
 *     it at whatever path was missing: /jobs/some-role/ must still find /assets/site.css.
 *   - Fetches the live data the pages are built from (careers, dealers) when it is asked to
 *     (see DATA below), and never fails the build over it. Dealers are prerendered into
 *     dealers.html with their photos copied onto the site (tools/dealers.mjs).
 *   - Locks each page down with a Content Security Policy (see SECURITY below). GitHub Pages
 *     cannot send headers, so it goes in a <meta> tag, with every inline script allowed by
 *     the hash of exactly the bytes this build wrote, and nothing else inline allowed at all.
 *
 * Importable, for the checks: buildPage(), loadData(), registerSourceTransform() and the
 * validators are exported, and the build itself only runs when this file is run directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { normalizeDealers, downloadDealerPhotos, dealersTransform, siteRootOf } from './dealers.mjs';
import { seoTransform, lastmodOf } from './seo.mjs';
import { prepareCareers, writeCareers } from './careers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

const INLINE = new Set(['assets/perf.js', 'assets/pod-assets.js']);
const ALREADY_MINIFIED = new Set(['assets/three.min.js']);
const EXCLUDE = [
  /(^|\/)\.DS_Store$/,
  /^assets\/productImages\/.*\.png$/i, // source renders and CAD exports; pages use the WebP exports
];
// Copied as they are. sitemap.xml is not here: it is generated (see sitemap() below).
const ROOT_FILES = ['CNAME', 'robots.txt', 'favicon.ico', 'apple-touch-icon.png'];

// The site's one origin, for everything that has to be absolute: the sitemap, the snapshot
// fallback, and later the canonical and OG tags.
export const SITE_ORIGIN = 'https://gridxenergy.in';

// Pages that exist but are not for search engines: the 404 is not a page anyone links to,
// the interview page is reached only from a private link, and better.html only by reaching
// for DevTools (assets/guard.js).
const NOT_IN_SITEMAP = new Set(['404.html', 'interview.html', 'better.html']);

/** A slug, as Paddock mints them (Part 0 of the platform plan): 3 to 48 characters. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isSlug = (s) => typeof s === 'string' && s.length >= 3 && s.length <= 48 && SLUG.test(s);

const posix = (p) => p.split(path.sep).join('/');
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
const exists = (rel) => fs.existsSync(path.join(SRC, rel)) && fs.statSync(path.join(SRC, rel)).isFile();
const excluded = (rel) => EXCLUDE.some((re) => re.test(rel));

// The root pages, which a nested page has to reach through its prefix. Read once.
const ROOT_PAGES = fs.readdirSync(SRC).filter((f) => f.endsWith('.html')).sort();
const ROOT_LINKS = new Set([...ROOT_PAGES, 'favicon.ico']);

// ---------------------------------------------------------------- the asset graph
// Each asset is processed once: its own references versioned first (so a script's hash covers
// the versions it points at), then minified, then hashed.
const done = new Map(); // rel path → { out: Buffer, hash }

// Local asset paths inside JS/CSS source. JS: string literals that are exactly a path under
// assets/. CSS: url(...) relative to the stylesheet.
const JS_PATH = /(['"`])(assets\/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)\1/g;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
// In HTML (outside scripts and styles): any assets/ path, in any attribute, srcset included.
const HTML_PATH = /(^|[^\w/.-])(assets\/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)(?![\w?])/g;
// In HTML: a link to one of the root pages (or the favicon) by its bare name, in an href or a
// form action. Only these are prefixed for a nested page; anything else is left alone.
const PAGE_LINK = /(\s(?:href|action|formaction)\s*=\s*)(["'])([A-Za-z0-9_-]+\.html|favicon\.ico)(?=[?#"'])/gi;
// In HTML: a file the build itself writes into the site rather than copies from assets/ (the
// dealer photos, tools/dealers.mjs), in a src or a srcset. Already versioned by its writer;
// prefixed for a nested page like any other root-relative path.
const SITE_FILE = /(^|[\s"',])(dealers\/photos\/[A-Za-z0-9_-]+\.webp)(?=[?"'\s,])/g;

const missing = new Set();
function versioned(rel) {
  if (!exists(rel) || excluded(rel)) {
    missing.add(rel);
    return rel;
  }
  return `${rel}?v=${processAsset(rel).hash}`;
}

// prefix is for scripts written into a page: their string literals resolve against the
// page's URL, so a nested page needs them to climb back to the root. A script file's own
// literals (rewriteJs from processAsset) are never prefixed, which is why no shared script
// may name an asset a nested page needs (none of the shell's scripts do).
function rewriteJs(code, prefix = '') {
  return code.replace(JS_PATH, (m, q, rel) => `${q}${prefix}${versioned(rel)}${q}`);
}

function rewriteCss(code, fromRel, prefix = '') {
  const dir = path.posix.dirname(fromRel);
  return code.replace(CSS_URL, (m, q, url) => {
    if (/^(data:|https?:|#|\/\/)/.test(url)) return m;
    const clean = url.split(/[?#]/)[0];
    const rel = path.posix.normalize(path.posix.join(dir, clean));
    if (!rel.startsWith('assets/')) return m;
    const v = versioned(rel);
    const tail = v.slice(rel.length); // ?v=...
    return `url(${q}${prefix}${clean}${tail}${q})`;
  });
}

async function minifyJs(code, file) {
  const r = await esbuild.transform(code, { loader: 'js', minify: true, legalComments: 'none', charset: 'utf8', sourcefile: file });
  return r.code;
}
async function minifyCss(code, file) {
  const r = await esbuild.transform(code, { loader: 'css', minify: true, legalComments: 'none', charset: 'utf8', sourcefile: file });
  return r.code;
}

// Synchronous by design (versioned() is called from inside string replacements), so the
// minifier runs through esbuild's sync API here.
function processAsset(rel) {
  if (done.has(rel)) return done.get(rel);
  done.set(rel, { out: null, hash: 'pending' }); // a cycle would reference itself unversioned
  const src = fs.readFileSync(path.join(SRC, rel));
  let out = src;
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.js' && !ALREADY_MINIFIED.has(rel)) {
    const code = rewriteJs(src.toString('utf8'));
    out = Buffer.from(esbuild.transformSync(code, { loader: 'js', minify: true, legalComments: 'none', charset: 'utf8', sourcefile: rel }).code);
  } else if (ext === '.css') {
    const code = rewriteCss(src.toString('utf8'), rel);
    out = Buffer.from(esbuild.transformSync(code, { loader: 'css', minify: true, legalComments: 'none', charset: 'utf8', sourcefile: rel }).code);
  }
  const entry = { out, hash: hash(out) };
  done.set(rel, entry);
  return entry;
}

// ---------------------------------------------------------------- pages
const BLOCK = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
// Data, not code: never minified (esbuild would read a JSON object as a block statement),
// never versioned, never hashed into the CSP (a browser does not run them).
const DATA_SCRIPT = /\btype\s*=\s*["']?application\/(?:ld\+)?json["']?/i;

/*
 * Source transforms: changes to a page's source made before anything else touches it, so a
 * marker written as an HTML comment (<!-- careers:data -->) can be filled in before the
 * comments are stripped. Each is (name, html) => html, run in the order registered; name is
 * the page's path within the site ('careers.html', 'jobs/<slug>/index.html').
 */
const SOURCE_TRANSFORMS = [];
export function registerSourceTransform(fn) {
  SOURCE_TRANSFORMS.push(fn);
}
export function transformSource(name, html) {
  let out = html;
  for (const fn of SOURCE_TRANSFORMS) {
    const next = fn(name, out);
    if (typeof next === 'string') out = next;
  }
  return out;
}

// ---------------------------------------------------------------- SECURITY
//
// Where a page may load code from and talk to. Kept to exactly what the site uses:
//   - itself
//   - Paddock, the only API (assets/gridx-api.js); localhost:3000 is Paddock in development
//   - Razorpay Checkout: its script, the frames it opens, and the endpoints it reports to
//   - reCAPTCHA Enterprise, which Paddock checks before it creates an order
//   - Google Fonts, the fallback copy of DM Sans (assets/site.css)
// Inline scripts are allowed one by one, by hash. A script injected into a page by anyone
// else, or a page framed by another site to trick a click, gets nowhere.
//
// frame-ancestors cannot be set from a <meta> tag, so FRAME_GUARD does its job instead: a
// page that finds itself inside someone else's frame takes over the top window, or hides
// itself if it is not allowed to.
const CSP_SOURCES = {
  'default-src': ["'self'"],
  // cdn.razorpay.com: Checkout loads its fraud-detection script from there into the page.
  'script-src': ["'self'", 'https://checkout.razorpay.com', 'https://cdn.razorpay.com', 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'https://cdn.razorpay.com'],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'connect-src': ["'self'", 'https://paddockgridx.app', 'http://localhost:3000', 'https://api.razorpay.com', 'https://lumberjack.razorpay.com', 'https://lumberjack-cx.razorpay.com', 'https://www.google.com/recaptcha/'],
  'frame-src': ['https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'],
  'worker-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
  'media-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
};

const FRAME_GUARD = 'if(window.top!==window.self){try{window.top.location.replace(window.location.href)}catch(e){document.documentElement.style.display="none"}}';

const scriptHash = (code) => `'sha256-${crypto.createHash('sha256').update(code, 'utf8').digest('base64')}'`;

function contentSecurityPolicy(inlineHashes) {
  return Object.entries(CSP_SOURCES)
    .map(([directive, sources]) => [directive, directive === 'script-src' ? [...sources, ...inlineHashes] : sources])
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

/** The policy, the referrer rule and the frame guard, placed straight after the charset. */
function secureHead(html) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => scriptHash(m[1]));
  hashes.unshift(scriptHash(FRAME_GUARD));
  // A page that sets its own referrer rule keeps it (interview.html: no-referrer at all).
  const ownReferrer = /<meta name="referrer"/i.test(html);
  const head = `\n  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy([...new Set(hashes)])}">`
    + (ownReferrer ? '' : '\n  <meta name="referrer" content="strict-origin-when-cross-origin">')
    + `\n  <script>${FRAME_GUARD}</script>`;
  const charset = /<meta charset="utf-8">/i;
  if (!charset.test(html)) throw new Error('page has no <meta charset="utf-8"> to anchor its security policy after');
  return html.replace(charset, (m) => m + head);
}

/**
 * One page, built.
 *
 * @param {string} name     the page's path within the site ('store.html', 'jobs/x/index.html');
 *                          read from the sources when no html is given
 * @param {string} buildId
 * @param {{ html?: string, prefix?: string }} [opts]
 *   html    the source, for a page generated rather than read from disk
 *   prefix  what climbs from the page back to the site root, put in front of every local
 *           asset reference and every link to a root page: '' for a root page, '../../' for
 *           jobs/<slug>/index.html, '/' for 404.html (served at any depth)
 */
export async function buildPage(name, buildId, { html, prefix = '' } = {}) {
  const source = transformSource(name, html === undefined ? fs.readFileSync(path.join(SRC, name), 'utf8') : html);
  const parts = [];
  let last = 0;
  for (const m of source.matchAll(BLOCK)) {
    parts.push({ text: source.slice(last, m.index) });
    parts.push({ tag: m[1].toLowerCase(), attrs: m[2], body: m[3], raw: m[0] });
    last = m.index + m[0].length;
  }
  parts.push({ text: source.slice(last) });

  // Inline styles and scripts were written as if the page sat at the root.
  const asRoot = prefix ? 'index.html' : name;

  const out = [];
  for (const p of parts) {
    if (p.text !== undefined) {
      // HTML comments go (not IE conditionals, which this site has none of anyway).
      let t = p.text.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
      t = t.replace(HTML_PATH, (m, pre, rel) => `${pre}${prefix}${versioned(rel)}`);
      if (prefix) {
        t = t.replace(PAGE_LINK, (m, attr, q, page) => (ROOT_LINKS.has(page) ? `${attr}${q}${prefix}${page}` : m));
        t = t.replace(SITE_FILE, (m, pre, rel) => `${pre}${prefix}${rel}`);
      }
      out.push(t);
      continue;
    }
    if (p.tag === 'style') {
      const css = rewriteCss(p.body, asRoot, prefix); // page-relative urls
      out.push(`<style${p.attrs}>${await minifyCss(css, name)}</style>`);
      continue;
    }
    if (DATA_SCRIPT.test(p.attrs)) {
      out.push(p.raw);
      continue;
    }
    const src = /\bsrc="([^"]+)"/.exec(p.attrs);
    if (src) {
      const rel = src[1].split('?')[0];
      if (INLINE.has(rel)) {
        let code = fs.readFileSync(path.join(SRC, rel), 'utf8');
        if (rel === 'assets/perf.js') code = `window.GRID_BUILD=${JSON.stringify(buildId)};\n${code}`;
        out.push(`<script>${await minifyJs(rewriteJs(code, prefix), rel)}</script>`);
      } else if (rel.startsWith('assets/')) {
        out.push(`<script${p.attrs.replace(src[0], `src="${prefix}${versioned(rel)}"`)}></script>`);
      } else {
        out.push(`<script${p.attrs}></script>`);
      }
      continue;
    }
    out.push(`<script${p.attrs}>${await minifyJs(rewriteJs(p.body, prefix), name)}</script>`);
  }
  // Blank lines left where comments were.
  return secureHead(out.join('').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n'));
}

// ---------------------------------------------------------------- DATA
//
// Careers and dealers are published from Paddock, and the pages that show them are built
// from what Paddock says at build time (and then kept fresh in the browser). The build must
// never be the thing that takes the site down, so every source is tried in turn and a
// failure is a warning, never an exception:
//
//   1. a fixture file, named by an environment variable (checks and local work)
//   2. Paddock's public API (CI sets the URL; 15s per try, two retries with a backoff)
//   3. the snapshot the live site published last time (<origin>/<kind>/snapshot.json)
//   4. nothing: the page ships with its no-data state, and the browser fetches live
//
// A kind is loaded only when one of its variables is set, so a plain `npm run build` stays
// offline and builds exactly what it always has. Whatever was loaded is validated against
// the public contract (Part 0 of the platform plan), entries that do not fit are dropped with
// a warning, and the result is published as dist/<kind>/snapshot.json for step 3 next time.
//
// In GitHub Actions the sources go to the step's outputs, which the workflow uses to decide
// whether a scheduled or dispatched build is worth deploying (see .github/workflows/pages.yml).

const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function warn(message) {
  // An annotation on the run's summary page in Actions; a plain line anywhere else.
  console.warn(IN_ACTIONS ? `::warning::${message.replace(/\r?\n/g, ' ')}` : `warning: ${message}`);
}

/** GET one JSON document. Resolves { data } or { error }, never rejects. */
async function fetchJson(url, { attempts = 3, timeoutMs = 15000, backoffMs = [1500, 4000] } = {}) {
  let error = '';
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(backoffMs[Math.min(i - 1, backoffMs.length - 1)]);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'gridx-site-build' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!res.ok) {
        error = `HTTP ${res.status}`;
        // A 4xx other than a timeout or a rate limit will say the same thing next time.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
        continue;
      }
      return { data: await res.json() };
    } catch (err) {
      error = err && err.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : String((err && err.message) || err);
    }
  }
  return { error };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v.trim() !== '';
// https only, except Paddock on this machine (or tools/check/paddock-mock.mjs) in development.
const httpsUrl = (v) => typeof v === 'string'
  && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)[^\s"'<>]+$/.test(v);

/** Keeps what passes, warns about what does not. */
function keep(list, kind, label, check) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((item, i) => {
    const why = check(item);
    if (why === true) out.push(item);
    else warn(`${kind}: dropped ${label} ${i}${isObj(item) && item.id ? ` (${item.id})` : ''}: ${why}`);
  });
  return out;
}

const QUESTION_TYPES = new Set(['short_text', 'long_text', 'yes_no', 'single_select', 'multi_select', 'number', 'url']);
const EMPLOYMENT = new Set(['full-time', 'part-time', 'internship', 'contract']);
const WORK_MODE = new Set(['onsite', 'hybrid', 'remote']);

/** GET careers, checked against its contract. Null when the document itself is unusable. */
export function validateCareers(data) {
  if (!isObj(data)) return null;
  if (!str(data.version) || !Array.isArray(data.domains) || !Array.isArray(data.jobs)) return null;
  const domains = keep(data.domains, 'careers', 'domain', (d) => {
    if (!isObj(d)) return 'not an object';
    if (!str(d.key) || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(d.key)) return 'bad key';
    if (!str(d.label)) return 'no label';
    return true;
  });
  const keys = new Set(domains.map((d) => d.key));
  const seen = new Set();
  const jobs = keep(data.jobs, 'careers', 'job', (j) => {
    if (!isObj(j)) return 'not an object';
    if (!str(j.id)) return 'no id';
    if (!isSlug(j.slug)) return `bad slug ${JSON.stringify(j.slug)}`;
    if (seen.has(j.slug)) return `duplicate slug ${j.slug}`;
    if (!str(j.title)) return 'no title';
    if (!str(j.domain)) return 'no domain';
    if (j.employmentType != null && !EMPLOYMENT.has(j.employmentType)) return `bad employmentType ${j.employmentType}`;
    if (j.workMode != null && !WORK_MODE.has(j.workMode)) return `bad workMode ${j.workMode}`;
    if (j.screeningQuestions != null && !Array.isArray(j.screeningQuestions)) return 'screeningQuestions is not a list';
    seen.add(j.slug);
    return true;
  }).map((j) => {
    if (!keys.has(j.domain)) warn(`careers: job ${j.id} is in domain "${j.domain}", which is not in the domain list`);
    const questions = keep(j.screeningQuestions || [], 'careers', `screening question of ${j.slug},`, (q) => {
      if (!isObj(q)) return 'not an object';
      if (!str(q.id) || !str(q.label)) return 'no id or label';
      if (!QUESTION_TYPES.has(q.type)) return `bad type ${q.type}`;
      if ((q.type === 'single_select' || q.type === 'multi_select')
        && (!Array.isArray(q.options) || !q.options.length || !q.options.every(str))) return 'a select with no options';
      return true;
    });
    return {
      ...j,
      previousSlugs: Array.isArray(j.previousSlugs) ? j.previousSlugs.filter(isSlug) : [],
      screeningQuestions: questions,
      ogImage: httpsUrl(j.ogImage) ? j.ogImage : null,
    };
  });
  const recentlyClosed = keep(data.recentlyClosed || [], 'careers', 'closed role', (r) => {
    if (!isObj(r) || !str(r.id) || !isSlug(r.slug) || !str(r.title)) return 'needs an id, a slug and a title';
    if (r.state !== 'closed' && r.state !== 'paused') return `bad state ${r.state}`;
    return true;
  }).map((r) => ({ ...r, previousSlugs: Array.isArray(r.previousSlugs) ? r.previousSlugs.filter(isSlug) : [] }));
  return { ...data, domains, jobs, recentlyClosed };
}

/**
 * GET dealers, checked against its contract. Null when the document itself is unusable.
 * The rules are assets/dealers-core.js, through tools/dealers.mjs: the same file the page
 * runs on what it fetches live, so the build and the browser keep and drop the same dealers.
 * Beyond the contract's shape: a pin inside India, E.164 phones, Maps links only to Google
 * Maps over https, hours that make sense, and known services.
 */
export function validateDealers(data) {
  return normalizeDealers(data, { warn });
}

const VALIDATORS = { careers: validateCareers, dealers: validateDealers };

/**
 * One kind of data, from the first source that has it. Never throws.
 * @returns {Promise<{ data: object|null, source: 'fixture'|'paddock'|'snapshot'|'none' }>}
 */
export async function loadData(kind, { fixtureEnv, apiUrl, snapshotUrl } = {}) {
  const validate = VALIDATORS[kind] || ((d) => (isObj(d) ? d : null));
  const tryOne = (label, raw) => {
    const data = validate(raw);
    if (!data) warn(`${kind}: the ${label} is not a ${kind} document; trying the next source`);
    return data;
  };

  const fixture = fixtureEnv && process.env[fixtureEnv];
  if (fixture) {
    try {
      const data = tryOne(`fixture ${fixture}`, JSON.parse(fs.readFileSync(path.resolve(fixture), 'utf8')));
      if (data) return { data, source: 'fixture' };
    } catch (err) {
      warn(`${kind}: could not read the fixture ${fixture} (${err.message}); trying the next source`);
    }
  }

  if (apiUrl) {
    const r = await fetchJson(apiUrl);
    if (r.error) warn(`${kind}: Paddock did not answer (${r.error}); trying the live snapshot`);
    else {
      const data = tryOne(`answer from ${apiUrl}`, r.data);
      if (data) return { data, source: 'paddock' };
    }
  }

  const snap = snapshotUrl || `${SITE_ORIGIN}/${kind}/snapshot.json`;
  const r = await fetchJson(snap, { attempts: 2 });
  if (r.error) warn(`${kind}: no live snapshot either (${r.error}); building without ${kind} data`);
  else {
    const data = tryOne(`snapshot at ${snap}`, r.data);
    if (data) return { data, source: 'snapshot' };
  }
  return { data: null, source: 'none' };
}

/** The kinds this build knows how to load, and the variables that switch each one on. */
const DATA_KINDS = [
  { kind: 'careers', fixtureEnv: 'CAREERS_FIXTURE', apiEnv: 'CAREERS_API', snapshotEnv: 'CAREERS_SNAPSHOT' },
  { kind: 'dealers', fixtureEnv: 'DEALERS_FIXTURE', apiEnv: 'DEALERS_API', snapshotEnv: 'DEALERS_SNAPSHOT' },
];

async function loadAllData() {
  const loaded = {};
  for (const k of DATA_KINDS) {
    const apiUrl = process.env[k.apiEnv] || '';
    if (!process.env[k.fixtureEnv] && !apiUrl) {
      loaded[k.kind] = { data: null, source: 'skipped' };
      continue;
    }
    loaded[k.kind] = await loadData(k.kind, { fixtureEnv: k.fixtureEnv, apiUrl, snapshotUrl: process.env[k.snapshotEnv] || '' });
  }
  return loaded;
}

/**
 * Whether this build carries anything new from Paddock: at least one kind came from Paddock
 * itself and none came up empty. A build that loaded nothing (no variables set) is fine too.
 */
export function dataOk(loaded) {
  const ran = Object.values(loaded).filter((l) => l.source !== 'skipped');
  if (!ran.length) return true;
  return ran.some((l) => l.source === 'paddock') && ran.every((l) => l.source !== 'none');
}

// ---------------------------------------------------------------- generated files
function sitemap(pages, extra = []) {
  // Home first, then the rest in name order. Each page carries the date it last changed, from
  // git (tools/seo.mjs lastmodOf); when git cannot say, under a shallow clone, the date is
  // left out rather than stamping the scheduled build's own date on everything.
  const urls = pages
    .filter((f) => !NOT_IN_SITEMAP.has(f))
    .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)))
    .map((f) => ({ loc: f === 'index.html' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${f}`, lastmod: lastmodOf(f) }))
    .concat(extra.map((loc) => ({ loc })));
  const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map(({ loc, lastmod }) => `  <url><loc>${x(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>\n`).join('')
    + '</urlset>\n';
}

// ---------------------------------------------------------------- the service worker
function serviceWorker(buildId) {
  return `/*
 * GridX service worker, written by tools/build.mjs (build ${buildId}).
 *
 * GitHub Pages caches every file for ten minutes and cannot be told otherwise, so a return
 * visit used to re-check the field's engine, the fonts, the stylesheets and the 3D model one
 * request at a time. The build versions every asset (?v=<content hash>), which makes a
 * versioned file safe to keep until its version changes:
 *   - versioned assets: from the cache, fetched once
 *   - other images and fonts: from the cache, refreshed in the background
 *   - dealer photos: with the images, so a long list of them never crowds the code out
 *   - pages: from the network first, so a deploy shows up at once; the cache is the fallback,
 *     kept once per page whatever its query (?role=, ?utm_source=)
 *   - the interview page: never cached. Its link carries a private token.
 *
 * To retire it, deploy a sw.js that unregisters itself:
 *   self.addEventListener('install', () => self.skipWaiting());
 *   self.addEventListener('activate', () => self.registration.unregister());
 * A visitor can also open any page with ?nosw.
 */
const BUILD = ${JSON.stringify(buildId)};
const ASSETS = 'gridx-assets';
const MEDIA = 'gridx-media';
const PAGES = 'gridx-pages-' + BUILD;
const LIMITS = { [ASSETS]: 160, [MEDIA]: 240 };
const NEVER_CACHED = new Set(['/interview.html', '/interview']); // Pages answers both

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gridx-pages-') && k !== PAGES).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(name) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - LIMITS[name]; i++) await cache.delete(keys[i]);
}

async function fromCache(request, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
    trim(name);
  }
  return response;
}

async function refreshing(request, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(request);
  const fresh = fetch(request).then(async (response) => {
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
      trim(name);
    }
    return response;
  });
  return hit || fresh;
}

// One entry per page, whatever its query: careers.html?role=a and ?role=b are the same page,
// and a campaign's utm_ links must not fill the cache with copies of it.
function pageKey(request) {
  const url = new URL(request.url);
  url.search = '';
  return url.href;
}

async function page(request) {
  const cache = await caches.open(PAGES);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(pageKey(request), response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(pageKey(request), { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (NEVER_CACHED.has(url.pathname)) return; // straight to the network, as if there were no worker
    event.respondWith(page(request));
  } else if (url.pathname.startsWith('/dealers/photos/')) {
    event.respondWith(url.searchParams.has('v') ? fromCache(request, MEDIA) : refreshing(request, MEDIA));
  } else if (url.searchParams.has('v')) {
    event.respondWith(fromCache(request, ASSETS));
  } else if (/\\.(webp|png|jpe?g|svg|woff2)$/i.test(url.pathname)) {
    event.respondWith(refreshing(request, MEDIA));
  }
});
`;
}

// ---------------------------------------------------------------- run
function walk(dir, base = SRC) {
  const out = [];
  for (const name of fs.readdirSync(path.join(base, dir))) {
    const rel = posix(path.join(dir, name));
    const st = fs.statSync(path.join(base, rel));
    if (st.isDirectory()) out.push(...walk(rel, base));
    else out.push(rel);
  }
  return out;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const gz = (buf) => zlib.gzipSync(buf, { level: 6 }).length;

/** Where the build goes: --out <dir>, then BUILD_OUT, then dist/. */
function outputDir() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const chosen = (i >= 0 && args[i + 1]) || process.env.BUILD_OUT || '';
  const out = chosen ? path.resolve(chosen) : path.join(SRC, 'dist');
  // The output is emptied first, so it must never be the sources or anything holding them,
  // and an existing folder must be empty or an earlier build (which always has .nojekyll).
  const rel = path.relative(out, SRC);
  if (out === SRC || !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(`refusing to build into ${out}: it holds the sources`);
  }
  if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, '.nojekyll'))) {
    throw new Error(`refusing to build into ${out}: it is not empty and not an earlier build`);
  }
  return out;
}

async function main() {
  const OUT = outputDir();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // The data first: its versions are part of the build id.
  const loaded = await loadAllData();

  // Dealers: their photos onto the site before anything else, since the page may only show
  // images from the site itself; then dealers.html is prerendered from the same data, and it
  // is what goes out as dealers/snapshot.json below. A snapshot names its photos relative to
  // the site it came from, and they are fetched back from there. With no data the transform
  // leaves the page alone and it fetches the list in the browser.
  if (loaded.dealers.data) {
    const snapshotUrl = process.env.DEALERS_SNAPSHOT || `${SITE_ORIGIN}/dealers/snapshot.json`;
    loaded.dealers.data = await downloadDealerPhotos(loaded.dealers.data, { outDir: OUT, base: siteRootOf(snapshotUrl), warn });
  }
  registerSourceTransform(dealersTransform(loaded.dealers.data, { warn }));

  // Careers (tools/careers.mjs): the share images onto the site and careers.html's tags
  // registered before any page is built; the role pages themselves come after the pages.
  const careers = await prepareCareers(loaded.careers.data, { out: OUT, registerSourceTransform, warn, siteOrigin: SITE_ORIGIN });

  // What search engines and link scrapers read (tools/seo.mjs): every indexable page's share
  // card and structured data, built from the page's own head. After careers, so careers.html
  // and the job pages, which that transform serves, are already spoken for.
  registerSourceTransform(seoTransform({ siteOrigin: SITE_ORIGIN }));

  // The build id: the hash of every source file that ships, and of the data it was built
  // from, so it changes exactly when the site does.
  const pages = ROOT_PAGES;
  const assets = walk('assets').filter((rel) => !excluded(rel)).sort();
  const idHash = crypto.createHash('sha256');
  for (const rel of [...pages, ...assets]) idHash.update(rel).update(fs.readFileSync(path.join(SRC, rel)));
  for (const [kind, { data }] of Object.entries(loaded)) {
    if (data) idHash.update(`data:${kind}:${data.version}`);
  }
  const buildId = idHash.digest('hex').slice(0, 12);

  // Assets: every file under assets/ that ships, processed (minified where it applies).
  for (const rel of assets) processAsset(rel);
  for (const [rel, { out }] of done) {
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
  }

  // Pages. The 404 page is served at whatever path was missing, so its references are
  // root-absolute; every other page sits at the root and keeps them relative.
  const report = [];
  for (const file of pages) {
    const before = fs.readFileSync(path.join(SRC, file));
    const after = Buffer.from(await buildPage(file, buildId, { prefix: file === '404.html' ? '/' : '' }));
    fs.writeFileSync(path.join(OUT, file), after);
    report.push([file, before.length, gz(before), after.length, gz(after)]);
  }
  const roles = await writeCareers(careers, { out: OUT, buildId, buildPage });

  // The data, published for the next build's fallback and for Paddock's "is it live" check.
  // Dealers go out as the page was built from them: photos named on this site, not Paddock.
  for (const [kind, { data }] of Object.entries(loaded)) {
    if (!data) continue;
    fs.mkdirSync(path.join(OUT, kind), { recursive: true });
    fs.writeFileSync(path.join(OUT, kind, 'snapshot.json'), JSON.stringify(data));
  }

  for (const f of ROOT_FILES) if (exists(f)) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), sitemap(pages, roles.urls));
  fs.writeFileSync(path.join(OUT, 'sw.js'), serviceWorker(buildId));

  // Size report: pages, then the scripts and stylesheets that changed most.
  const relOut = path.relative(process.cwd(), OUT);
  const outName = relOut && !relOut.startsWith('..') ? relOut : OUT;
  console.log(`${outName}/ built (${buildId})\n`);
  console.log('page                   source        gzip     →  built        gzip');
  for (const [f, a, ag, b, bg] of report) {
    console.log(`${f.padEnd(22)} ${kb(a).padStart(9)} ${kb(ag).padStart(9)}  →  ${kb(b).padStart(9)} ${kb(bg).padStart(9)}`);
  }
  // The from-disk copy of the model is fetched only by a page opened straight from disk, or
  // whose fetch of the real file failed, so it is not part of what a visit downloads.
  const ONLY_FROM_DISK = new Set(['assets/powerpod-model.js']);
  const code = assets.filter((r) => /\.(js|css)$/.test(r) && !ONLY_FROM_DISK.has(r));
  let srcTotal = 0;
  let outTotal = 0;
  for (const rel of code) {
    srcTotal += gz(fs.readFileSync(path.join(SRC, rel)));
    outTotal += gz(done.get(rel).out);
  }
  console.log(`\nscripts and stylesheets, gzipped: ${kb(srcTotal)} → ${kb(outTotal)} (not counting the from-disk model copy)`);
  const shipped = walk('.', OUT).reduce((s, rel) => s + fs.statSync(path.join(OUT, rel)).size, 0);
  console.log(`${outName}/ on disk: ${(shipped / 1024 / 1024).toFixed(1)} MB`);

  // Where the data came from. In Actions this also becomes the job's outputs.
  const sources = Object.fromEntries(Object.entries(loaded).map(([k, l]) => [k, l.source]));
  const ok = dataOk(loaded);
  console.log(`data: ${Object.entries(loaded).map(([k, l]) => `${k} ${l.source}${l.data ? ` (${l.data.version})` : ''}`).join(', ')}; data_ok ${ok}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `careers_source=${sources.careers}\ndealers_source=${sources.dealers}\ndata_ok=${ok}\n`);
  }

  if (missing.size) {
    console.error(`\nUnresolved local references (not shipped):\n  ${[...missing].join('\n  ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
