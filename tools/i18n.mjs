/*
 * The site in six languages, for the build (tools/build.mjs), the dev server (tools/serve.mjs)
 * and the checks (tools/check/i18n.mjs).
 *
 * English is the source and stays the thing to edit. A translated page is never written by
 * hand: the build reads the English page, finds every piece of text a visitor can read, looks
 * each one up in that language's catalogue (i18n/<lang>/), and splices the translation in at
 * exactly the place the English stood. Everything else, the markup, the scripts, the styles,
 * stays byte for byte, so a page edited by anyone (or any tool) keeps working in every
 * language, and the only thing that can fall behind is a sentence: tools/check/i18n.mjs names
 * it, and until it is translated that one sentence shows in English.
 *
 * WHAT IS A PIECE OF TEXT. A segment is the smallest element that holds a whole thought:
 * an element with text of its own whose children are all inline (a, span, strong, sup, ...).
 * Inline children become numbered placeholders, so the catalogue never sees markup:
 *
 *     Shipping across India, starting 6<sup>th</sup> November
 *     key  "Shipping across India, starting 6<0>th</0> November"
 *     hi   "6 नवंबर से पूरे भारत में शिपिंग"           (the ordinal's <sup> dropped)
 *
 * A translation may reorder placeholders and drop the presentational ones (sup, strong, em,
 * br, a class-only span); a link, anything with an id or a data-* hook, and an icon must stay.
 * Three structures are split rather than held (SPLITS below): headlines written word by word
 * (.w spans the intro animates), headlines of lines of words (the Gen1 story, the footer's
 * credit), and sentences in phrases (.ph, so a caption breaks only where you would pause
 * reading it aloud). Their translations bring their own words, lines and pauses.
 *
 * Also translated: alt, title, aria-label, placeholder, journey's data-theme and data-peek,
 * the page's title and description, and the message a WhatsApp link prefills (?text=).
 * Never: script, style, svg, code, anything marked translate="no", and data-topic (an
 * analytics key). An element with data-i18n-key="..." is looked up by that name instead of
 * its English, where one English stands for two things (the phone's S for Saturday and Sunday). Text inside data-i18n="app" (the film's phone) is the GridX app's own, and
 * is translated only where the app is (LANGUAGES[lang].app, i18n/languages.mjs).
 *
 * A TRANSLATION THAT BREAKS A RULE IS NOT USED. Each one is checked as it is applied: its
 * placeholders, every number and ₹ amount of the English, Western digits, the brand names
 * still in Latin script, no em dash and none of the language's banned words. One that fails
 * falls back to the English for that segment, with a warning, so a slip in a catalogue can
 * never stop a deploy (the Pages workflow runs no checks, and tools/seo.mjs refuses to build
 * a product page whose price is not printed on it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { LANGUAGES, LANGS, PSEUDO, BRANDS, NAMES as PEOPLE, PAGES_IN_EVERY_LANGUAGE } from '../i18n/languages.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGUE = path.join(SRC, 'i18n');
export const SITE_ORIGIN = 'https://gridxenergy.in';

export { LANGS, PSEUDO, LANGUAGES, PAGES_IN_EVERY_LANGUAGE };
export const isTranslated = (page) => PAGES_IN_EVERY_LANGUAGE.includes(page);
const known = (lang) => lang === PSEUDO || LANGS.includes(lang);

// ---------------------------------------------------------------- the catalogue
/*
 * i18n/<lang>/common.json     the shared chrome: top bar, footer, picker, card alts
 * i18n/<lang>/pages/<page>.json   one per translated page ("index.json" for index.html)
 * i18n/<lang>/scripts.json    what scripts write, by the English they ask gridLang.t for
 * A page's own entry wins over common's. Values are strings, or { one, other } for a count.
 * "@assets" maps an English asset to the language's own (the Hindi finale still).
 */
const catalogues = new Map();
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${path.relative(SRC, file)}: not valid JSON (${err.message})`);
  }
}
export function loadCatalogue(lang, { fresh = false } = {}) {
  if (!fresh && catalogues.has(lang)) return catalogues.get(lang);
  const dir = path.join(CATALOGUE, lang);
  const pages = {};
  for (const page of PAGES_IN_EVERY_LANGUAGE) pages[page] = readJson(path.join(dir, 'pages', page.replace(/\.html$/, '.json')));
  const cat = { lang, common: readJson(path.join(dir, 'common.json')), scripts: readJson(path.join(dir, 'scripts.json')), pages };
  catalogues.set(lang, cat);
  return cat;
}
export const forgetCatalogues = () => catalogues.clear();

/** Every catalogue file, for the build id: a change to any of them is a new build. */
export function catalogueFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(SRC, full).split(path.sep).join('/'));
    }
  };
  walk(CATALOGUE);
  return out;
}

const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k) && !k.startsWith('@');
function lookup(cat, page, key) {
  if (cat.lang === PSEUDO) return pseudo(key);
  const own = cat.pages[page];
  if (has(own, key)) return own[key];
  if (has(cat.common, key)) return cat.common[key];
  return undefined;
}

/** A line the build itself writes (a card's alt, a breadcrumb), in the language, or the English. */
export function translateLine(lang, key, page = null) {
  if (!lang || lang === 'en') return key;
  const value = lookup(loadCatalogue(lang), page, key);
  return typeof value === 'string' && valid(key, value, lang).ok ? value : key;
}

// ---------------------------------------------------------------- the rules a translation keeps
const NUMBER = /(?<![\w.])\d+(?:[,.]\d+)*/g;
const PLACEHOLDER = /<\/?\d+\/?>/g;
const numbersOf = (s) => (s.replace(PLACEHOLDER, ' ').match(NUMBER) || []).map((n) => n.replace(/,/g, ''));
const VARS = /\{(\w+)\}/g;

/** { ok, why }: whether a translation of key may be used in lang. */
export function valid(key, value, lang) {
  if (lang === PSEUDO) return { ok: true };
  const meta = LANGUAGES[lang];
  const forms = typeof value === 'string' ? [value] : value && typeof value === 'object' ? [value.one, value.other].filter((v) => typeof v === 'string') : [];
  if (!forms.length) return { ok: false, why: 'not a string or { one, other }' };
  const english = key.replace(/^[a-z][\w-]*::/, '');
  for (const v of forms) {
    if (!v.trim()) return { ok: false, why: 'empty' };
    if (meta.digits.test(v)) return { ok: false, why: `${meta.gloss} digits (write Western digits)` };
    const banned = meta.banned.find((w) => v.includes(w));
    if (banned) return { ok: false, why: `"${banned}" is not used (STYLE.md)` };
    for (const brand of BRANDS) {
      if (new RegExp(`(^|[^A-Za-z])${brand}(?![A-Za-z])`).test(english) && !v.includes(brand)) return { ok: false, why: `${brand} must stay in Latin script` };
    }
    for (const name of PEOPLE) {
      if (new RegExp(`(^|[^A-Za-z])${name}(?![A-Za-z])`).test(english) && !v.includes(name)) return { ok: false, why: `the name ${name} must stay as the English writes it` };
    }
  }
  // Every {value} of the English, somewhere in the translation (a plural's "one" may spell it out).
  for (const name of new Set(english.match(VARS) || [])) {
    if (!forms.some((v) => v.includes(name))) return { ok: false, why: `${name} is missing` };
  }
  // Every price exactly as the English prints it (tools/seo.mjs looks for "₹2,199" on the page).
  const all = forms.join(' ');
  for (const price of english.match(/₹\s?\d+(?:,\d+)*(?:\.\d+)?/g) || []) {
    if (!all.includes(price)) return { ok: false, why: `${price} must be written as it is` };
  }
  // Every number of the English, in some form of the translation (a plural's forms share it).
  const got = new Set(numbersOf(all));
  const missing = [...new Set(numbersOf(english.split('|').join(' ')))].filter((n) => !got.has(n));
  if (missing.length) return { ok: false, why: `the number${missing.length > 1 ? 's' : ''} ${missing.join(', ')} of the English ${missing.length > 1 ? 'are' : 'is'} missing` };
  return { ok: true };
}

// ---------------------------------------------------------------- the pseudo-locale
// Each Latin word becomes about 40% more Devanagari, heavy with marks above and below the
// line (the tallest clusters the site will ever set), keeping placeholders, numbers, {vars},
// brand names and the " | " splits. For layout only.
const SYLLABLES = ['कि', 'की', 'कु', 'कू', 'के', 'कै', 'को', 'कौ', 'क्षि', 'त्रु', 'ज्ञे', 'श्री', 'ङ्गू', 'ठ्ठि', 'द्धू', 'ह्मे'];
function pseudoWord(w) {
  const n = Math.max(1, Math.round((w.length * 1.4) / 2));
  let out = '';
  for (let i = 0; i < n; i++) out += SYLLABLES[(w.charCodeAt(i % w.length) + i) % SYLLABLES.length];
  return out;
}
export function pseudo(key) {
  const english = key.replace(/^[a-z][\w-]*::/, '');
  const one = (s) => s.split(/(<\/?\d+\/?>|\{\w+\}|\s+\|\s+|\s+)/).map((part) => {
    if (!part || /^(<\/?\d+\/?>|\{\w+\}|\s+\|\s+|\s+)$/.test(part)) return part;
    if (BRANDS.some((b) => part.includes(b)) || /\d/.test(part)) return part;
    const lead = part.match(/^[^A-Za-z]*/)[0];
    const tail = part.match(/[^A-Za-z]*$/)[0];
    const word = part.slice(lead.length, part.length - tail.length);
    return word ? lead + pseudoWord(word) + tail.replace(/\.$/, '।') : part;
  }).join('');
  if (english.includes('|') && !english.includes(' | ')) {
    const [a, b] = english.split('|');
    return { one: one(a), other: one(b) };
  }
  return one(english);
}

// ---------------------------------------------------------------- reading a page
const SKIP = new Set(['script', 'style', 'svg', 'math', 'template', 'code', 'pre', 'canvas', 'iframe', 'object', 'textarea', 'head']);
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'button', 'cite', 'data', 'dfn', 'em', 'i', 'img', 'input', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'svg', 'time', 'u', 'var', 'wbr']);
// Held whole inside a segment, as <n/>: copied as they are.
const ATOMIC = new Set(['br', 'wbr', 'img', 'svg', 'input']);
// A placeholder a translation may leave out.
const DROPPABLE = new Set(['br', 'wbr', 'sup', 'sub', 'strong', 'b', 'em', 'i', 'small', 'span', 'u', 'mark']);
const ATTRS = ['alt', 'title', 'aria-label', 'placeholder', 'data-theme', 'data-peek'];
const META_CONTENT = /^(description|og:title|og:description|og:image:alt|twitter:title|twitter:description|twitter:image:alt)$/;
const WHATSAPP = /^(https:\/\/wa\.me\/\d+\?(?:[^#]*&)?text=)([^&#]*)(.*)$/;

const attr = (el, name) => (el.attrs || []).find((a) => a.name === name)?.value;
const isEl = (n) => n && n.tagName;
const isText = (n) => n && n.nodeName === '#text';
const blank = (n) => isText(n) && !n.value.trim();
const squash = (s) => s.replace(/\s+/g, ' ');

/** Nothing a reader needs translated: numbers, codes, brand names, addresses of things. */
export function untranslatable(s) {
  const v = s.trim();
  if (!v || !/\p{L}/u.test(v)) return true;
  if (/^(https?:|mailto:|tel:)|@[\w-]+\.|^[\w.+-]+@[\w-]+\.\w+$/.test(v)) return true;
  if (!/[a-z]/.test(v) && (/\d/.test(v) || /X{4,}/.test(v))) return true; // GX-XXXXXXXXXX, 22AAAAA0000A1Z5, 56.4V
  if (/^[\d.,\s%°]+\s?(kWh|km|V|A|W|h|min|°C)$/.test(v)) return true;
  const words = v.split(/[\s,/·]+/).filter(Boolean);
  return words.every((w) => BRANDS.includes(w.replace(/[^\w-]/g, '')) || /^(Instagram|YouTube|LinkedIn|Delhivery|iOS|Android)$/.test(w));
}

function blocky(el) {
  if (!isEl(el)) return false;
  if (!INLINE.has(el.tagName)) return true;
  if (ATOMIC.has(el.tagName)) return false;
  return (el.childNodes || []).some((c) => isEl(c) && !SKIP.has(c.tagName) && blocky(c));
}
function hasText(n) {
  if (isText(n)) return Boolean(n.value.trim());
  if (!isEl(n) || SKIP.has(n.tagName) || ATOMIC.has(n.tagName) || attr(n, 'translate') === 'no') return false;
  return (n.childNodes || []).some(hasText);
}
const elementKids = (el) => (el.childNodes || []).filter(isEl);
const onlySpacing = (el) => (el.childNodes || []).every((c) => isEl(c) || blank(c) || c.nodeName === '#comment');

// ---------------------------------------------------------------- splits
/** <x class="w" style="--i:3">word</x> ... : words the intro animates one by one. */
function wordsOf(el) {
  const kids = elementKids(el);
  if (kids.length < 1 || !onlySpacing(el)) return null;
  const cls = attr(kids[0], 'class');
  const tag = kids[0].tagName;
  if (!cls) return null;
  const words = [];
  let start = null;
  for (const k of kids) {
    if (k.tagName !== tag || attr(k, 'class') !== cls) return null;
    if ((k.attrs || []).some((a) => a.name !== 'class' && a.name !== 'style')) return null;
    const i = /^--i:\s*(\d+);?$/.exec(attr(k, 'style') || '');
    if (!i || (k.childNodes || []).some(isEl)) return null;
    if (start === null) start = Number(i[1]);
    words.push(squash(k.childNodes.map((c) => c.value || '').join('')).trim());
  }
  return { tag, cls, start, words };
}
/** Lines of such words: the Gen1 story's headline, the footer's credit. */
function linesOf(el) {
  const kids = elementKids(el);
  if (kids.length < 2 || !onlySpacing(el)) return null;
  const lines = kids.map((k) => ({ el: k, w: wordsOf(k) }));
  if (lines.some((l) => !l.w || l.el.tagName !== kids[0].tagName || l.w.cls !== lines[0].w.cls)) return null;
  return lines;
}
/** A sentence in plain .ph phrases. */
function phrasesOf(el) {
  const kids = elementKids(el);
  if (kids.length < 2 || !onlySpacing(el)) return null;
  if (!kids.every((k) => k.tagName === 'span' && (k.attrs || []).length === 1 && attr(k, 'class') === 'ph')) return null;
  return kids;
}

// ---------------------------------------------------------------- segments
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Every piece of a page that a visitor reads, in document order:
 *   { kind, key, scope, start, end, render(value) -> html | null, inner: [attribute edits] }
 * start/end are offsets into html; render returns null for a translation whose placeholders
 * do not fit, which is then not used.
 */
export function segmentsOf(html, { page = '' } = {}) {
  const doc = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  const out = [];
  const problems = [];
  const src = (a, b) => html.slice(a, b);

  // Attribute edits per element start offset, for elements a segment holds as a placeholder.
  const attrEdits = new Map();

  function attrsOf(el, scope) {
    const loc = el.sourceCodeLocation;
    if (!loc || !loc.attrs) return [];
    const found = [];
    const add = (name, key, make) => {
      const at = loc.attrs[name];
      if (!at || untranslatable(key)) return;
      found.push({ kind: 'attr', name, key: scope ? `${scope}::${key}` : key, scope, start: at.startOffset, end: at.endOffset, render: make, owner: loc.startOffset });
    };
    for (const name of ATTRS) {
      const v = attr(el, name);
      if (v !== undefined && v.trim()) add(name, squash(v).trim(), (t) => `${name}="${escAttr(t)}"`);
    }
    if (el.tagName === 'meta') {
      const which = attr(el, 'name') || attr(el, 'property') || '';
      const v = attr(el, 'content');
      if (META_CONTENT.test(which) && v) add('content', squash(v).trim(), (t) => `content="${escAttr(t)}"`);
    }
    const href = attr(el, 'href');
    const wa = href && WHATSAPP.exec(href);
    if (wa && wa[2]) {
      let text = '';
      try { text = decodeURIComponent(wa[2].replace(/\+/g, ' ')); } catch { text = ''; }
      if (text) add('href', squash(text).trim(), (t) => `href="${escAttr(wa[1] + encodeURIComponent(t) + wa[3])}"`);
    }
    return found;
  }

  /** Placeholder encoding of a run of nodes. */
  function encoder() {
    const ph = [];
    const enc = (n) => {
      if (isText(n)) return n.value;
      if (!isEl(n)) return '';
      const k = ph.length;
      const atomic = ATOMIC.has(n.tagName) || attr(n, 'translate') === 'no' || SKIP.has(n.tagName);
      const required = !DROPPABLE.has(n.tagName)
        || (n.attrs || []).some((a) => a.name === 'id' || a.name.startsWith('data-'))
        || (n.tagName === 'span' && (n.attrs || []).some((a) => a.name !== 'class'));
      ph.push({ el: n, atomic, required: required && n.tagName !== 'br' && n.tagName !== 'wbr' });
      if (atomic) return `<${k}/>`;
      return `<${k}>${(n.childNodes || []).map(enc).join('')}</${k}>`;
    };
    return { ph, enc };
  }

  function tagSource(el, part) {
    const loc = el.sourceCodeLocation;
    const range = part === 'start' ? loc.startTag || loc : part === 'end' ? loc.endTag : loc;
    if (!range) return part === 'end' ? `</${el.tagName}>` : null;
    let text = src(range.startOffset, range.endOffset);
    // Translated attributes inside the tag, applied right to left.
    const edits = (attrEdits.get(loc.startOffset) || []).filter((e) => e.start >= range.startOffset && e.end <= range.endOffset);
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      if (e.value === undefined) continue;
      text = text.slice(0, e.start - range.startOffset) + e.value + text.slice(e.end - range.startOffset);
    }
    return text;
  }

  /** Turn a translation back into markup, with this segment's placeholders. */
  function renderer(ph, shared = null) {
    return (value) => {
      const state = shared || { used: new Set() };
      const tokens = value.split(/(<\/?\d+\/?>)/);
      const stack = [];
      let html2 = '';
      for (const tok of tokens) {
        let m;
        if ((m = /^<(\d+)\/>$/.exec(tok))) {
          const p = ph[Number(m[1])];
          if (!p || !p.atomic || state.used.has(p)) return null;
          state.used.add(p);
          html2 += tagSource(p.el, 'whole');
        } else if ((m = /^<(\d+)>$/.exec(tok))) {
          const p = ph[Number(m[1])];
          if (!p || p.atomic || state.used.has(p)) return null;
          state.used.add(p);
          stack.push(p);
          html2 += tagSource(p.el, 'start');
        } else if ((m = /^<\/(\d+)>$/.exec(tok))) {
          const p = ph[Number(m[1])];
          if (!p || stack.pop() !== p) return null;
          html2 += tagSource(p.el, 'end');
        } else {
          html2 += escText(tok);
        }
      }
      if (stack.length) return null;
      if (!shared && ph.some((p) => p.required && !state.used.has(p))) return null;
      return html2;
    };
  }

  function trimmedRange(a, b) {
    const inner = src(a, b);
    const lead = inner.length - inner.trimStart().length;
    const trail = inner.length - inner.trimEnd().length;
    return [a + lead, b - trail];
  }

  /** A run of text and inline elements, as one segment. own: the element holding it. */
  function runSegment(nodes, scope, where, own = null) {
    const first = nodes.find((n) => !blank(n) && n.nodeName !== '#comment') || nodes[0];
    const last = [...nodes].reverse().find((n) => !blank(n) && n.nodeName !== '#comment') || nodes[nodes.length - 1];
    if (!first.sourceCodeLocation || !last.sourceCodeLocation) return;
    const { ph, enc } = encoder();
    const key = squash(nodes.map(enc).join('')).trim();
    if (untranslatable(key.replace(PLACEHOLDER, ' '))) {
      for (const n of nodes) if (isEl(n)) walk(n, scope, true);
      return;
    }
    for (const p of ph) {
      if (!p.atomic && !p.el.sourceCodeLocation?.endTag && !['br', 'wbr', 'img', 'input'].includes(p.el.tagName)) {
        problems.push(`${page}: <${p.el.tagName}> inside "${key.slice(0, 50)}" is never closed, so the segment cannot be translated`);
        return;
      }
    }
    const [start, end] = trimmedRange(first.sourceCodeLocation.startOffset, last.sourceCodeLocation.endOffset);
    // Attributes of the elements it holds travel inside it (through tagSource).
    const inner = [];
    const collect = (n) => {
      if (!isEl(n)) return;
      const edits = attrsOf(n, scope);
      if (edits.length) {
        attrEdits.set(n.sourceCodeLocation.startOffset, edits);
        inner.push(...edits);
      }
      if (!SKIP.has(n.tagName) && attr(n, 'translate') !== 'no') (n.childNodes || []).forEach(collect);
    };
    nodes.forEach(collect);
    // data-i18n-key names a line whose English is not enough to tell it apart (the phone's
    // week strip: S is Saturday and Sunday both).
    const named = own && attr(own, 'data-i18n-key');
    const said = named || key;
    out.push({ kind: 'text', key: scope ? `${scope}::${said}` : said, scope, start, end, render: renderer(ph), inner, where });
  }

  function splitSegment(el, scope) {
    const loc = el.sourceCodeLocation;
    if (!loc || !loc.startTag || !loc.endTag) return false;
    const [start, end] = trimmedRange(loc.startTag.endOffset, loc.endTag.startOffset);
    const where = whereOf(el);
    const lines = linesOf(el);
    if (lines) {
      const key = lines.map((l) => l.w.words.join(' ')).join(' | ');
      const starts = lines.map((l) => tagSource(l.el, 'start'));
      const sameTags = starts.every((s) => s === starts[0]);
      const tag = lines[0].el.tagName;
      const { tag: wtag, cls, start: i0 } = lines[0].w;
      if (!/^(w|word|.*__word)$/.test(cls)) return false;
      out.push({
        kind: 'lines', key: scope ? `${scope}::${key}` : key, scope, start, end, where, inner: [],
        render: (value) => {
          const vals = value.split(/\s*\|\s*/).map((v) => v.trim()).filter(Boolean);
          if (!sameTags && vals.length !== lines.length) return null;
          let i = i0;
          return vals.map((v, n) => `${sameTags ? starts[0] : starts[n]}${v.split(/\s+/).map((w) => `<${wtag} class="${cls}" style="--i:${i++}">${escText(w)}</${wtag}>`).join(' ')}</${tag}>`).join('\n');
        },
      });
      return true;
    }
    const words = wordsOf(el);
    if (words && words.words.length >= 1 && elementKids(el).length >= 1 && words.cls.split(/\s+/).some((c) => /^(w|word|.*__word)$/.test(c))) {
      const key = words.words.join(' ');
      if (untranslatable(key)) return true;
      out.push({
        kind: 'words', key: scope ? `${scope}::${key}` : key, scope, start, end, where, inner: [],
        render: (value) => value.trim().split(/\s+/).map((w, n) => `<${words.tag} class="${words.cls}" style="--i:${words.start + n}">${escText(w)}</${words.tag}>`).join(' '),
      });
      return true;
    }
    const phrases = phrasesOf(el);
    if (phrases) {
      const { ph, enc } = encoder();
      const chunks = phrases.map((p) => squash(p.childNodes.map(enc).join('')).trim());
      const key = chunks.join(' | ');
      out.push({
        kind: 'phrases', key: scope ? `${scope}::${key}` : key, scope, start, end, where, inner: [],
        render: (value) => {
          const state = { used: new Set() };
          const parts = value.split(/\s*\|\s*/).map((v) => v.trim()).filter(Boolean);
          const r = renderer(ph, state);
          const rendered = parts.map((p) => r(p));
          if (rendered.some((h) => h === null) || ph.some((p) => p.required && !state.used.has(p))) return null;
          return rendered.map((h) => `<span class="ph">${h}</span>`).join(' ');
        },
      });
      return true;
    }
    return false;
  }

  function whereOf(el) {
    const cls = attr(el, 'class');
    return `${el.tagName}${cls ? `.${cls.split(/\s+/)[0]}` : ''}`;
  }

  function walk(el, scope = null, attrsOnly = false) {
    if (!isEl(el)) return;
    if (attr(el, 'translate') === 'no') return;
    const own = attr(el, 'data-i18n') === 'app' ? 'app' : scope;
    if (el.tagName === 'head') {
      // Only the title and the description, never what scripts and styles hold.
      for (const c of el.childNodes || []) {
        if (c.tagName === 'title') walkChildren(c, own);
        else if (c.tagName === 'meta') attrsOf(c, own).forEach((e) => out.push(e));
      }
      return;
    }
    if (SKIP.has(el.tagName)) return;
    attrsOf(el, own).forEach((e) => out.push(e));
    if (attrsOnly) {
      (el.childNodes || []).forEach((c) => walk(c, own, true));
      return;
    }
    if (splitSegment(el, own)) return;
    walkChildren(el, own);
  }

  function walkChildren(el, scope) {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const nodes = run;
      run = [];
      // A segment is a run with words of its own. Inline elements side by side with none
      // between them (the footer's legal links, a button's icon and label) are separate
      // things, each read on its own.
      const direct = nodes.some((n) => isText(n) && n.value.trim());
      if (!direct) {
        nodes.forEach((n) => walk(n, scope, !hasText(n)));
        return;
      }
      runSegment(nodes, scope, whereOf(el), el);
    };
    for (const c of el.childNodes || []) {
      if (isText(c) || c.nodeName === '#comment' || (isEl(c) && INLINE.has(c.tagName) && !blocky(c) && attr(c, 'data-i18n') !== 'app')) run.push(c);
      else {
        flush();
        walk(c, scope);
      }
    }
    flush();
  }

  walk(doc.childNodes.find((n) => n.tagName === 'html'));
  return { segments: out, problems, doc };
}

// ---------------------------------------------------------------- one page, in one language
/**
 * The page in lang, from its English source. Returns { html, missing, rejected } where missing
 * lists keys with no translation and rejected those whose translation broke a rule; both show
 * in English. Links and assets are not touched here (build.mjs and relink() do that).
 */
export function localise(page, lang, html, { warn = () => {}, origin = SITE_ORIGIN } = {}) {
  if (!known(lang)) throw new Error(`no such language: ${lang}`);
  const cat = loadCatalogue(lang);
  const htmlLang = lang === PSEUDO ? 'hi' : lang;
  const appToo = lang === PSEUDO || LANGUAGES[lang].app;

  // Assets with a language of their own (the Hindi finale still), swapped before anything else.
  let source = html;
  const assets = { ...(cat.common['@assets'] || {}), ...(cat.pages[page]?.['@assets'] || {}) };
  for (const [from, to] of Object.entries(assets)) source = source.split(from).join(to);

  const { segments, problems } = segmentsOf(source, { page });
  for (const p of problems) warn(p);
  const missing = [];
  const rejected = [];
  const edits = [];
  /** A translation for seg, checked, or undefined when there is none fit to use. */
  const resolve = (seg) => {
    const value = lookup(cat, page, seg.key);
    if (value === undefined) {
      missing.push(seg.key);
      return undefined;
    }
    const verdict = typeof value === 'string' ? valid(seg.key, value, lang) : { ok: false, why: 'page text cannot be a plural' };
    if (!verdict.ok) {
      rejected.push({ key: seg.key, why: verdict.why });
      warn(`${lang}/${page}: not using the translation of "${seg.key.slice(0, 60)}": ${verdict.why}`);
      return undefined;
    }
    return value;
  };
  const inScope = (seg) => seg.scope !== 'app' || appToo;

  for (const seg of segments) {
    if (!inScope(seg)) continue;
    if (seg.kind === 'attr') {
      const value = resolve(seg);
      if (value !== undefined) edits.push({ start: seg.start, end: seg.end, text: seg.render(value) });
      continue;
    }
    // The attributes it holds first: its placeholders render them translated.
    for (const a of seg.inner) {
      const value = inScope(a) ? resolve(a) : undefined;
      a.value = value === undefined ? undefined : a.render(value);
    }
    const value = resolve(seg);
    const rendered = value === undefined ? null : seg.render(value);
    if (value !== undefined && rendered === null) {
      rejected.push({ key: seg.key, why: 'its placeholders do not match the English' });
      warn(`${lang}/${page}: not using the translation of "${seg.key.slice(0, 60)}": its placeholders do not match the English`);
    }
    if (rendered !== null) edits.push({ start: seg.start, end: seg.end, text: rendered });
    // Left in English, its attributes are still translated, each on its own.
    else for (const a of seg.inner) if (a.value !== undefined) edits.push({ start: a.start, end: a.end, text: a.value });
  }

  // The page itself: its language, its own address.
  const htmlTag = /<html\b[^>]*>/i.exec(source);
  if (htmlTag) {
    const tag = htmlTag[0];
    const next = /\slang="[^"]*"/.test(tag) ? tag.replace(/\slang="[^"]*"/, ` lang="${htmlLang}"`) : tag.replace('<html', `<html lang="${htmlLang}"`);
    edits.push({ start: htmlTag.index, end: htmlTag.index + tag.length, text: lang === PSEUDO ? next.replace('<html', '<html data-pseudo') : next });
  }
  const canonical = /<link rel="canonical" href="([^"]*)">/.exec(source);
  if (canonical) {
    const pagePath = page === 'index.html' ? '' : page;
    const at = canonical.index + canonical[0].indexOf(canonical[1]);
    edits.push({ start: at, end: at + canonical[1].length, text: `${origin}/${lang}/${pagePath}` });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = source;
  let floor = Infinity;
  for (const e of edits) {
    if (e.end > floor) throw new Error(`${lang}/${page}: overlapping edits at ${e.start}`);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }

  // The language's words for the scripts, ahead of the first page script in the body.
  const body = out.search(/<body\b/i);
  const firstScript = out.slice(body).search(/<script\s+src="assets\//);
  if (body >= 0 && firstScript >= 0) {
    const at = body + firstScript;
    out = `${out.slice(0, at)}<script src="assets/i18n/${lang}.js"></script>\n  ${out.slice(at)}`;
  }
  return { html: out, missing, rejected };
}

// ---------------------------------------------------------------- the scripts' words
/** The files whose words go through gridLang.t, and the inline film script of index.html. */
export const SCRIPT_SOURCES = [
  'assets/lang.js', 'assets/launch.js', 'assets/powerpod-gen2.js', 'assets/accessory-flow.js',
  'assets/pay-confirm.js', 'assets/catalogue.js', 'assets/product.js', 'assets/store.js',
  'assets/support-form.js', 'assets/contact.js', 'assets/track.js', 'assets/hours.js',
  'assets/dealers-core.js', 'assets/dealers.js', 'assets/dealer-join.js', 'assets/journey.js',
  'assets/tape.js', 'assets/gridx-api.js', 'assets/gstin.js', 'assets/topbar.js', 'assets/footer.js',
  'assets/sheet.js', 'assets/disclose.js', 'assets/keyboard.js', 'assets/analytics.js',
  'index.html', '404.html',
];
const T_CALL = /\b[tT]\(\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
function unquote(body, q) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, e) => {
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r' }[e] ?? e;
  });
}
/** Every English line the scripts ask for, with where it is asked. */
export function scriptKeys() {
  const keys = new Map();
  for (const rel of SCRIPT_SOURCES) {
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(T_CALL)) {
      const key = unquote(m[2], m[1]);
      if (!keys.has(key)) keys.set(key, []);
      keys.get(key).push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  return keys;
}

/** The language's words for every script, checked like the pages'. */
export function scriptWords(lang, { warn = () => {} } = {}) {
  const cat = loadCatalogue(lang);
  const words = {};
  for (const key of scriptKeys().keys()) {
    if (key.startsWith('app::') && !(lang === PSEUDO || LANGUAGES[lang].app)) continue;
    const value = lang === PSEUDO ? pseudo(key) : cat.scripts[key];
    if (value === undefined) continue;
    const verdict = valid(key, value, lang);
    if (!verdict.ok) {
      warn(`${lang}/scripts: not using the translation of "${key.slice(0, 60)}": ${verdict.why}`);
      continue;
    }
    words[key] = value;
  }
  return words;
}

/** assets/i18n/<lang>.js, which a translated page loads before its first script. */
export function scriptDictionary(lang, opts = {}) {
  return `/* ${LANGUAGES[lang]?.gloss || 'Pseudo'}: the words assets/*.js write, from i18n/${lang}/scripts.json (tools/i18n.mjs). */\nwindow.gridLang && window.gridLang.add(${JSON.stringify(scriptWords(lang, opts))});\n`;
}

// ---------------------------------------------------------------- links, for the dev server
/*
 * A translated page sits one folder down (/hi/store.html). Its assets are at ../assets/, its
 * links to the other translated pages stay as they are (store.html is /hi/store.html), and
 * its links to the pages kept in English climb back to the root (../privacy_policy.html).
 * build.mjs does the same while it versions everything; this is the plain version the dev
 * server serves straight from the working copy.
 */
export function linkPrefixFor(page, { root = '../' } = {}) {
  return isTranslated(page) ? '' : root;
}
const DEV_ASSET = /(^|[^\w/.-])(assets\/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)(?![\w])/g;
const DEV_LINK = /(\s(?:href|action|formaction)\s*=\s*)(["'])([A-Za-z0-9_-]+\.html|favicon\.ico)(?=[?#"'])/gi;
// The scripts the build writes into the page itself (build.mjs INLINE), so their own asset
// literals climb from the page as they do there.
const DEV_INLINE = ['assets/i18n.js', 'assets/perf.js', 'assets/pod-assets.js'];
export function relink(html) {
  const inlined = html.replace(/<script src="(assets\/[\w.-]+\.js)"><\/script>/g, (m, rel) => (
    DEV_INLINE.includes(rel) ? `<script>${fs.readFileSync(path.join(SRC, rel), 'utf8')}</script>` : m));
  return inlined
    .replace(DEV_ASSET, (m, pre, rel) => `${pre}../${rel}`)
    .replace(DEV_LINK, (m, a, q, p) => `${a}${q}${linkPrefixFor(p)}${p}`)
    .replace(/(^|[\s"',])(dealers\/photos\/)/g, '$1../$2')
    .replace(/(<script>)/, '$1window.GRID_ROOT="../";');
}

// ---------------------------------------------------------------- the source list
/** Every key of every page and script, for translators and the checks. */
export function extract() {
  const pages = {};
  for (const page of PAGES_IN_EVERY_LANGUAGE) {
    const html = fs.readFileSync(path.join(SRC, page), 'utf8');
    const { segments, problems } = segmentsOf(html, { page });
    // A segment's own attributes too (a WhatsApp link's message, an icon's label inside a sentence).
    const all = segments.flatMap((s) => [s, ...(s.inner || [])]);
    pages[page] = { segments: all.map((s) => ({ key: s.key, kind: s.kind, where: s.where || s.name, scope: s.scope })), problems };
  }
  return { pages, scripts: scriptKeys() };
}

// ---------------------------------------------------------------- the language picker
/*
 * The button in every top bar (<!-- lang:picker --> in each page's <header class="topbar">),
 * written here for each page in each language, so its six rows are real links that work
 * without JavaScript and that crawlers follow:
 *   - a translated page links to its own copy in every language (English with ?lang=en,
 *     which assets/i18n.js remembers, so the reader is not sent straight back)
 *   - a page kept in English (a policy, careers, a role) links to itself with ?lang=<code>:
 *     the choice is remembered for the rest of the site, and the page says, in that
 *     language, that it stays in English (the .lang__note lines; assets/lang.js shows one)
 *   - the 404 page, served at any depth, links to each language's home
 * On a root page that exists in every language it also carries the one-time offer
 * (assets/lang.js decides whether to show it), in each of the five, since it is shown in the
 * language of the reader's state, not the page's.
 */
const NAMES = { en: { name: 'English', gloss: 'English', letter: 'A' }, ...Object.fromEntries(LANGS.map((l) => [l, { name: LANGUAGES[l].name, gloss: LANGUAGES[l].gloss, letter: LANGUAGES[l].letter }])) };

function linkFor(page, from, to) {
  if (page === '404.html') return to === 'en' ? '/?lang=en' : `/${to}/`;
  const file = page === 'index.html' ? '' : page;
  if (!isTranslated(page)) return `?lang=${to}`;
  if (from === 'en') return to === 'en' ? `${file || './'}?lang=en` : `${to}/${file}`;
  if (to === from) return file || './';
  return to === 'en' ? `../${file}?lang=en` : `../${to}/${file}`;
}

/** A line of the picker in lang, from its catalogue ("lang::" keys), or the English. */
function pickerLine(lang, key, english) {
  if (lang === 'en') return english;
  const value = loadCatalogue(lang).common[key];
  return typeof value === 'string' && value.trim() ? value : english;
}

export function pickerMarkup(page, lang = 'en') {
  const here = known(lang) && lang !== PSEUDO ? lang : 'en';
  const current = NAMES[here];
  const label = `${pickerLine(here, 'lang::Language', 'Language')}: ${current.name}`;
  const rows = ['en', ...LANGS].map((code) => {
    const n = NAMES[code];
    const on = code === here ? ' aria-current="true"' : '';
    const gloss = code === 'en' ? '' : `<span class="lang__gloss" lang="en">${n.gloss}</span>`;
    return `<li><a class="lang__row" href="${escAttr(linkFor(page, here, code))}" hreflang="${code}" lang="${code}" data-lang-to="${code}"${on}><span class="lang__name">${n.name}</span>${gloss}</a></li>`;
  }).join('');
  const notes = isTranslated(page) ? '' : LANGS.map((code) => `<p class="lang__note" lang="${code}" data-lang-note="${code}" hidden>${escText(pickerLine(code, 'lang::kept-in-english', 'This page is kept in English.'))}</p>`).join('');
  const offers = here !== 'en' || !isTranslated(page) || page === '404.html' ? '' : `<div class="lang__offers">${LANGS.map((code) => `<div class="lang__offer" lang="${code}" data-lang-offer="${code}" hidden><p class="lang__offer-line">${escText(pickerLine(code, 'lang::offer', `This site is in ${NAMES[code].gloss} too.`))}</p><div class="lang__offer-actions"><a class="lang__offer-yes" href="${escAttr(linkFor(page, 'en', code))}" hreflang="${code}" data-lang-to="${code}">${escText(pickerLine(code, 'lang::offer-yes', `Read in ${NAMES[code].gloss}`))}</a><button class="lang__offer-no" type="button" lang="en" data-lang-stay>English</button></div></div>`).join('')}</div>`;
  return `<div class="lang" data-lang="${here}">`
    + `<details class="lang__pick"><summary class="lang__btn" aria-label="${escAttr(label)}"><span class="lang__face" aria-hidden="true">${current.letter}</span></summary>`
    + `<div class="lang__menu"><p class="lang__title">${escText(pickerLine(here, 'lang::Language', 'Language'))}</p><ul class="lang__list">${rows}</ul>${notes}</div></details>`
    + `${offers}</div>`;
}

/**
 * The same six at the very bottom of the page, under the footer's legal line
 * (<!-- lang:footer -->): where people look for a language when the top bar has scrolled away,
 * each name in its own script, the page's own lit. On a page kept in English a choice is
 * remembered and said in one line, as the picker does (assets/lang.js).
 */
export function footerLangsMarkup(page, lang = 'en') {
  const here = known(lang) && lang !== PSEUDO ? lang : 'en';
  const label = pickerLine(here, 'lang::Language', 'Language');
  const rows = ['en', ...LANGS].map((code) => {
    const on = code === here ? ' aria-current="true"' : '';
    return `<li><a class="credits__lang" href="${escAttr(linkFor(page, here, code))}" hreflang="${code}" lang="${code}" data-lang-to="${code}"${on}>${NAMES[code].name}</a></li>`;
  }).join('');
  return `<nav class="credits__langs" aria-label="${escAttr(label)}"><span class="credits__langs-label">${escText(label)}</span><ul class="credits__langs-list">${rows}</ul><p class="credits__langs-note" data-lang-footnote hidden></p></nav>`;
}

/** The markers filled, for the build (a source transform) and the dev server. */
export function fillPicker(html, page, lang = 'en') {
  let out = html;
  if (out.includes('<!-- lang:picker -->')) out = out.replace('<!-- lang:picker -->', () => pickerMarkup(page, lang));
  if (out.includes('<!-- lang:footer -->')) out = out.replace('<!-- lang:footer -->', () => footerLangsMarkup(page, lang));
  return out;
}

// ---------------------------------------------------------------- the command line
/*
 *   node tools/i18n.mjs extract    writes i18n/source.json: every line to translate, by page,
 *                                  with where it sits; lines on two or more pages go to
 *                                  "common" (one translation, i18n/<lang>/common.json)
 *   node tools/i18n.mjs status     how much of each language is translated
 */
export const BUILD_LINES = [
  // tools/seo.mjs: breadcrumbs and the share cards' alt text
  'Store', 'Chargers', 'Portable Charging Adapter', 'Vehicle Dock',
  'The GridX PowerPod Gen2 portable battery', 'The GridX lineup: PowerPod batteries, the charging adapter and the vehicle dock',
  'The GridX mark', 'The GridX portable charging adapter', 'A GridX PowerPod seated in the vehicle dock',
];
export const PICKER_LINES = {
  'lang::Language': 'Language (the picker\'s title, and the button\'s label: "Language: हिंदी")',
  'lang::kept-in-english': 'On a page kept in English (policies, careers), in this language: this page stays in English; the rest of the site is in this language',
  'lang::offer': 'The one-time card offering this language to a reader from its state: "This site is in <language> too." Warm, short, never naming the state',
  'lang::offer-yes': 'Its button: "Read in <language>"',
};

export function sourceList() {
  const { pages, scripts } = extract();
  const seen = new Map();
  for (const [page, { segments }] of Object.entries(pages)) {
    for (const s of segments) {
      if (!seen.has(s.key)) seen.set(s.key, new Set());
      seen.get(s.key).add(page);
    }
  }
  const common = {};
  for (const [key, where] of seen) if (where.size >= 2) common[key] = [...where].sort();
  const byPage = {};
  for (const [page, { segments }] of Object.entries(pages)) {
    const keep = [];
    const once = new Set();
    for (const s of segments) {
      if (common[s.key] || once.has(s.key)) continue;
      once.add(s.key);
      keep.push({ key: s.key, kind: s.kind, where: s.where, ...(s.scope ? { scope: s.scope } : {}) });
    }
    byPage[page] = keep;
  }
  for (const line of BUILD_LINES) if (!common[line]) common[line] = ['(built: tools/seo.mjs)'];
  return {
    note: 'Generated by node tools/i18n.mjs extract. Translate into i18n/<lang>/common.json, pages/<page>.json and scripts.json, keyed by these exact strings. See i18n/STYLE.md and i18n/gist.json.',
    common,
    picker: PICKER_LINES,
    pages: byPage,
    scripts: Object.fromEntries([...scripts].map(([k, v]) => [k, v])),
  };
}

function status() {
  const src = sourceList();
  const pageKeys = Object.entries(src.pages).flatMap(([p, list]) => list.map((s) => [p, s.key, s.scope]));
  for (const lang of LANGS) {
    const cat = loadCatalogue(lang);
    const app = LANGUAGES[lang].app;
    const want = pageKeys.filter(([, , scope]) => scope !== 'app' || app);
    const pagesDone = want.filter(([p, k]) => lookup(cat, p, k) !== undefined).length;
    const commonDone = Object.keys(src.common).filter((k) => has(cat.common, k)).length;
    const scriptKeys = Object.keys(src.scripts).filter((k) => !k.startsWith('app::') || app);
    const scriptsDone = scriptKeys.filter((k) => cat.scripts[k] !== undefined).length;
    console.log(`${lang}  pages ${pagesDone}/${want.length}  common ${commonDone}/${Object.keys(src.common).length}  scripts ${scriptsDone}/${scriptKeys.length}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'extract') {
    fs.writeFileSync(path.join(CATALOGUE, 'source.json'), `${JSON.stringify(sourceList(), null, 2)}\n`);
    console.log('i18n/source.json written');
  } else if (cmd === 'status') status();
  else console.log('usage: node tools/i18n.mjs extract | status');
}

// ---------------------------------------------------------------- the checks' words
/**
 * What a page in lang says for an English line, the way gridLang.t (assets/i18n.js) would:
 * scripts' words first, then the page's and the shared ones, plurals by the language's rule,
 * {values} filled in. For checks that expect a sentence (tools/check/gen2-fit.mjs).
 */
const ZERO_IS_ONE = new Set(['hi', 'bn', 'kn']);
export function translator(lang = 'en', page = null) {
  const words = lang === 'en' ? {} : scriptWords(lang);
  const cat = lang === 'en' ? null : loadCatalogue(lang);
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
  return (src, vars) => {
    const n = vars && typeof vars.n === 'number' ? vars.n : null;
    let hit = lang === 'en' ? undefined : (Object.prototype.hasOwnProperty.call(words, src) ? words[src] : lookup(cat, page, src));
    if (hit !== undefined && typeof hit === 'object') {
      const one = n === 1 || (ZERO_IS_ONE.has(lang) && n === 0);
      hit = one ? hit.one || hit.other : hit.other || hit.one;
    }
    if (hit === undefined) {
      hit = src.replace(/^[a-z][\w-]*::/, '');
      if (n !== null && hit.includes('|')) hit = hit.split('|')[n === 1 ? 0 : 1];
    }
    return fill(hit, vars);
  };
}
