#!/usr/bin/env node
/*
 * The towns of India, for naming where someone is without asking anyone.
 *
 * The dealers page's join sheet (assets/dealer-join.js) asks a would-be dealer for their
 * location and writes "near Indore, Madhya Pradesh" into the WhatsApp message they send us.
 * Turning a position into a town name usually means sending the position to a geocoding
 * service; this keeps it on the phone instead. The page fetches assets/data/india-towns.json
 * (only once the visitor has allowed their location) and gridDealers.placeNear() in
 * assets/dealers-core.js picks the town.
 *
 *   node tools/source/india-towns.mjs                 download GeoNames and regenerate
 *   node tools/source/india-towns.mjs --from <dir>    from cities5000.txt and
 *                                                     admin1CodesASCII.txt already in <dir>
 *
 * Source: GeoNames (https://www.geonames.org), cities5000 (every place of 5,000 people or
 * more) and admin1CodesASCII (the state names), licensed CC BY 4.0. The privacy policy credits
 * it. Neighbourhoods (PPLX) and abandoned, religious and farm places are left out, so a
 * position in Mumbai reads "Mumbai" rather than the name of a quarter. Names are GeoNames'
 * plain spellings ("Karol Bagh", not "Karol Bāgh"), and the state names are the ones Paddock
 * uses for the connection's state (src/lib/website/analytics/indiaSubdivisions.js), so the
 * two ways of knowing where someone is always spell a state the same way.
 *
 * Each town carries a reach in km that grows with its population: 3 km for a town of
 * 50,000 or fewer, about 10 for half a million. placeNear() names the town whose reach covers
 * the position most snugly, cities before towns, so a point in Noida is "Noida", not "Delhi".
 *
 * Delhi is one place. GeoNames lists a hundred of its urban villages as towns of their own
 * (Deoli, Burari, Najafgarh), some of them over 100,000 people, and nobody in Saket would say
 * they were near Deoli. So every place in Delhi is called "Delhi", keeping its own position
 * and reach, which together cover the territory out to Narela and Najafgarh. A few names are
 * brought up to date or corrected (RENAME): Kanayannur is a taluk listed with the whole
 * taluk's population, three km from Kochi, and is Kochi to anyone there.
 *
 * Output, committed (the build ships it like any other asset):
 *   { about, states: [name, ...], towns: [[name, lat*1000, lng*1000, reach*10, state], ...] }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');
const OUT = path.join(SRC, 'assets/data/india-towns.json');
const GEONAMES = 'https://download.geonames.org/export/dump/';

// Places, not parts of places or places nobody lives in any more.
const KEEP = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLL']);

// Where GeoNames and Paddock spell a state differently, Paddock's spelling.
const STATE_NAMES = { 'Andaman and Nicobar': 'Andaman and Nicobar Islands' };

// Official names GeoNames has not caught up with, and a taluk listed as a town.
const RENAME = { Panjim: 'Panaji', Tumkur: 'Tumakuru', Kanayannur: 'Kochi' };

async function download(dir) {
  for (const file of ['cities5000.zip', 'admin1CodesASCII.txt']) {
    const res = await fetch(GEONAMES + file);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    fs.writeFileSync(path.join(dir, file), Buffer.from(await res.arrayBuffer()));
  }
  execFileSync('unzip', ['-o', '-q', path.join(dir, 'cities5000.zip'), '-d', dir]);
}

const reach = (population) => 3 + 7 * Math.max(0, Math.log10(population / 50000));

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--from');
  let dir = i >= 0 ? path.resolve(args[i + 1]) : null;
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geonames-'));
    await download(dir);
  }

  const stateOf = new Map();
  for (const line of fs.readFileSync(path.join(dir, 'admin1CodesASCII.txt'), 'utf8').split('\n')) {
    const [code, name] = line.split('\t');
    if (code && code.startsWith('IN.')) stateOf.set(code.slice(3), STATE_NAMES[name] || name);
  }

  const states = [...new Set(stateOf.values())].sort();
  const towns = [];
  const seen = new Set();
  for (const line of fs.readFileSync(path.join(dir, 'cities5000.txt'), 'utf8').split('\n')) {
    const f = line.split('\t');
    if (f[8] !== 'IN' || !KEEP.has(f[7])) continue;
    const state = stateOf.get(f[10]);
    const name = state === 'Delhi' ? 'Delhi' : RENAME[f[2].trim()] || f[2].trim();
    const lat = Number(f[4]);
    const lng = Number(f[5]);
    const population = Number(f[14]) || 5000;
    if (!state || !name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // GeoNames lists a few places twice; one is enough. By GeoNames' own name, so Delhi's
    // places, all called "Delhi" here, are not taken for copies of one another.
    const key = `${f[2]}|${state}|${lat.toFixed(1)}|${lng.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    towns.push([name, Math.round(lat * 1000), Math.round(lng * 1000), Math.round(reach(population) * 10), states.indexOf(state)]);
  }
  towns.sort((a, b) => a[0].localeCompare(b[0]));

  const about = 'Indian towns of 5,000 people or more, from GeoNames (geonames.org, CC BY 4.0). '
    + 'Made by tools/source/india-towns.mjs; read by gridDealers.placeNear in assets/dealers-core.js.';
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({ about, states, towns })}\n`);
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`${towns.length} towns in ${states.length} states and territories, ${kb} KB: ${path.relative(SRC, OUT)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
