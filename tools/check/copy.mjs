#!/usr/bin/env node
/*
 * The two house rules for anything written on or about the site, checked:
 *   - no em dashes (U+2014), in copy, comments or code: commas, colons and full stops instead
 *   - the company is GridX, never "GRID" (the old name, written as a word on its own)
 *
 *   node tools/check/copy.mjs                      every file changed since HEAD, and every
 *                                                  new file git does not ignore
 *   node tools/check/copy.mjs a.html assets/b.js   just these
 *   node tools/check/copy.mjs --added              only the lines added since HEAD (new
 *                                                  files count as wholly added)
 *
 * --added exists because older files carry em dashes and "GRID"s from before the rules, which
 * are the original author's to change: it holds new work to the rules without demanding a
 * rewrite of the old. Exits 1 on any hit, listing each as file:line:column.
 *
 * GRID_BUILD and other identifiers are not hits: the rule is the word, and an underscore or a
 * letter either side makes it part of a longer name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

const TEXT = /\.(html?|css|m?js|json|md|txt|ya?ml|xml|svg)$/i;
// Generated, vendored or recorded output: not anyone's writing.
// This file is skipped too: it has to name the word it forbids.
const SKIP = [/^node_modules\//, /^dist\//, /(^|\/)package-lock\.json$/, /^tools\/perf\/results\//, /^tools\/check\/out\//, /\.min\.js$/,
  /^tools\/check\/copy\.mjs$/];

// Built from char codes, so this file never contains the character it hunts for.
const EM_DASH = String.fromCharCode(0x2014);
const RULES = [
  { name: 'em dash', re: new RegExp(EM_DASH, 'g'), say: 'use a comma, a colon or a full stop' },
  { name: 'old name', re: /\bGRID\b/g, say: 'the company is GridX' },
];

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function changedFiles() {
  const tracked = git('diff', '--name-only', 'HEAD').split('\n');
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n');
  return [...new Set([...tracked, ...untracked])].filter(Boolean);
}

function untrackedSet() {
  try {
    return new Set(git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Line numbers (1-based) added since HEAD, from a zero-context diff. */
function addedLines(rel) {
  const lines = new Set();
  let diff = '';
  try {
    diff = git('diff', '-U0', 'HEAD', '--', rel);
  } catch {
    return null;
  }
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

const args = process.argv.slice(2);
const addedOnly = args.includes('--added');
const named = args.filter((a) => !a.startsWith('--'));
const files = (named.length ? named.map((f) => path.relative(REPO, path.resolve(f))) : changedFiles())
  .map((f) => f.split(path.sep).join('/'))
  .filter((f) => TEXT.test(f) && !SKIP.some((re) => re.test(f)) && fs.existsSync(path.join(REPO, f)));
const fresh = addedOnly ? untrackedSet() : null;

let hits = 0;
for (const rel of files) {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const only = addedOnly && !fresh.has(rel) ? addedLines(rel) : null;
  text.split('\n').forEach((line, i) => {
    if (only && !only.has(i + 1)) return;
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.re)) {
        hits++;
        const from = Math.max(0, m.index - 30);
        const excerpt = line.slice(from, m.index + m[0].length + 30).trim();
        console.log(`${rel}:${i + 1}:${m.index + 1}  ${rule.name} (${rule.say}): ${excerpt}`);
      }
    }
  });
}

console.log(hits
  ? `\n${hits} hit(s) in ${files.length} file(s)${addedOnly ? ', added lines only' : ''}`
  : `copy: ${files.length} file(s) clean${addedOnly ? ' (added lines only)' : ''}`);
process.exitCode = hits ? 1 : 0;
