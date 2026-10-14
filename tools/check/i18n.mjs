#!/usr/bin/env node
/*
 * The five languages, line by line (tools/i18n.mjs, i18n/STYLE.md).
 *
 *   node tools/check/i18n.mjs              every language
 *   node tools/check/i18n.mjs --lang hi    one
 *   node tools/check/i18n.mjs --missing    also list every line still in English
 *
 * Fails on:
 *   - a translated line the build would not use: a placeholder lost or invented, a number or
 *     a ₹ price that is not the English's, native digits, a brand name out of Latin script, an
 *     em dash, a banned word (any word for a reservation, "small" for the team)
 *   - a page line, a shared line or a script line with no translation at all
 *   - a catalogue entry whose English no longer exists (an orphan: the English was edited, and
 *     the nearest English that does exist is named, so it can be moved across)
 *   - a page whose markup tools/i18n.mjs cannot read (an element never closed inside a sentence)
 *   - a translated page that loses a <!-- marker --> the build fills (dealers, careers)
 *   - assets/i18n.js and i18n/languages.mjs disagreeing about the languages
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  LANGS, LANGUAGES, PAGES_IN_EVERY_LANGUAGE, loadCatalogue, localise, sourceList, valid, scriptKeys,
} from '../i18n.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const only = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : null;
const listMissing = args.includes('--missing');
let failed = 0;
const fail = (msg) => { failed++; console.log(`FAIL  ${msg}`); };
const pass = (msg) => console.log(`PASS  ${msg}`);

// The browser's list and the build's list are the same languages.
{
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(SRC, 'assets/i18n.js'), 'utf8'), ctx);
  const codes = ctx.gridLang.codes.filter((c) => c !== 'en');
  if (codes.join() !== LANGS.join()) fail(`assets/i18n.js has ${codes.join(', ')}; i18n/languages.mjs has ${LANGS.join(', ')}`);
  for (const l of ctx.gridLang.langs.filter((x) => x.code !== 'en')) {
    if (LANGUAGES[l.code]?.name !== l.name) fail(`${l.code}: assets/i18n.js calls it ${l.name}, i18n/languages.mjs ${LANGUAGES[l.code]?.name}`);
  }
}

const src = sourceList();
const allKeys = new Set([...Object.keys(src.common), ...Object.keys(src.picker), ...Object.values(src.pages).flat().map((s) => s.key), ...Object.keys(src.scripts)]);

/** The nearest English that exists, for an orphan: most words in common. */
function nearest(key) {
  const words = new Set(key.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  let best = null;
  let score = 0;
  for (const k of allKeys) {
    const s = k.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
    if (s > score) { score = s; best = k; }
  }
  return score >= 2 ? best : null;
}

for (const lang of LANGS) {
  if (only && lang !== only) continue;
  const cat = loadCatalogue(lang, { fresh: true });
  const app = LANGUAGES[lang].app;
  let missing = 0;
  let bad = 0;

  // Pages: what the build would leave in English, and what it would refuse.
  for (const page of PAGES_IN_EVERY_LANGUAGE) {
    const html = fs.readFileSync(path.join(SRC, page), 'utf8');
    const warnings = [];
    const out = localise(page, lang, html, { warn: (m) => warnings.push(m) });
    const lost = out.missing.filter((k) => !k.startsWith('app::') || app);
    missing += lost.length;
    if (listMissing) for (const k of lost) console.log(`      ${lang}/${page} still English: ${JSON.stringify(k).slice(0, 140)}`);
    for (const r of out.rejected) {
      bad++;
      fail(`${lang}/${page}: ${JSON.stringify(r.key).slice(0, 90)}: ${r.why}`);
    }
    for (const w of warnings.filter((m) => /never closed/.test(m))) fail(w);
    for (const marker of html.match(/<!-- (dealers|careers|lang):[\w-]+ -->/g) || []) {
      if (!out.html.includes(marker)) fail(`${lang}/${page}: the marker ${marker} did not survive`);
    }
  }

  // Shared lines and the picker's.
  for (const key of [...Object.keys(src.common), ...Object.keys(src.picker)]) {
    const v = cat.common[key];
    if (v === undefined) {
      if (!Object.prototype.hasOwnProperty.call(src.picker, key) && !src.common[key].every((p) => p.startsWith('('))) continue; // counted with its pages
      missing++;
      if (listMissing) console.log(`      ${lang}/common still English: ${JSON.stringify(key)}`);
      continue;
    }
    const verdict = key.startsWith('lang::') ? { ok: typeof v === 'string' && v.trim() && !v.includes('\u2014') } : valid(key, v, lang);
    if (!verdict.ok) { bad++; fail(`${lang}/common: ${JSON.stringify(key).slice(0, 90)}: ${verdict.why || 'empty or an em dash'}`); }
  }

  // Scripts.
  for (const key of scriptKeys().keys()) {
    if (key.startsWith('app::') && !app) continue;
    const v = cat.scripts[key];
    if (v === undefined) {
      missing++;
      if (listMissing) console.log(`      ${lang}/scripts still English: ${JSON.stringify(key).slice(0, 140)}`);
      continue;
    }
    const verdict = valid(key, v, lang);
    if (!verdict.ok) { bad++; fail(`${lang}/scripts: ${JSON.stringify(key).slice(0, 90)}: ${verdict.why}`); }
  }

  // Orphans: entries for English that no longer exists.
  const orphan = (file, obj) => {
    for (const key of Object.keys(obj || {})) {
      if (key.startsWith('@') || allKeys.has(key)) continue;
      const near = nearest(key);
      fail(`${lang}/${file}: no English "${key.slice(0, 70)}" any more${near ? `; nearest is "${near.slice(0, 70)}"` : ''}`);
    }
  };
  orphan('common.json', cat.common);
  orphan('scripts.json', cat.scripts);
  for (const page of PAGES_IN_EVERY_LANGUAGE) orphan(`pages/${page.replace(/\.html$/, '.json')}`, cat.pages[page]);

  if (missing) fail(`${lang}: ${missing} lines still in English (--missing lists them)`);
  else if (!bad) pass(`${lang}: every line translated and every rule kept`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall language checks passed');
process.exitCode = failed ? 1 : 0;
