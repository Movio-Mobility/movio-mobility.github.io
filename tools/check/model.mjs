#!/usr/bin/env node
/*
 * The binary model against the base64 it replaced: every vertex position, normal, UV and
 * index the page builds from assets/powerpod.bin(.gz) must equal, bit for bit, what the old
 * decode() built from tools/source/powerpod-data.js. Also checks the logo PNG is the same bytes,
 * and that the script copy pages use when opened from disk (powerpod-model.js) holds both.
 *   node tools/check/model.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadSource } from '../build-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

// The decode() index.html and powerpod-3d.js used to run, verbatim apart from THREE.
function oldDecode(o) {
  const vb = Buffer.from(o.v, 'base64').toString('latin1');
  const pos = new Float32Array(o.nv * 3);
  for (let i = 0; i < o.nv * 3; i++) {
    const k = i * 2;
    const q = vb.charCodeAt(k) | (vb.charCodeAt(k + 1) << 8);
    pos[i] = o.lo[i % 3] + q * o.sc[i % 3];
  }
  const nb = Buffer.from(o.n, 'base64').toString('latin1');
  const nor = new Float32Array(o.nv * 3);
  for (let i = 0; i < o.nv * 3; i++) {
    let c = nb.charCodeAt(i);
    if (c > 127) c -= 256;
    nor[i] = c / 127;
  }
  const fb = Buffer.from(o.f, 'base64').toString('latin1');
  const idx = new Uint16Array(o.nf * 3);
  for (let i = 0; i < o.nf * 3; i++) {
    const k = i * 2;
    idx[i] = fb.charCodeAt(k) | (fb.charCodeAt(k + 1) << 8);
  }
  const uv = new Float32Array(o.nv * 2);
  for (let i = 0; i < o.nv; i++) {
    uv[i * 2] = pos[i * 3] * 0.01;
    uv[i * 2 + 1] = pos[i * 3 + 1] * 0.01;
  }
  return { pos, nor, idx, uv, groups: [[0, o.split * 3, 0], [o.split * 3, (o.nf - o.split) * 3, 1]] };
}

// The loader's own parseModel() and geometry(), run from the shipped file with a stub THREE.
function newDecode(buffer) {
  const sandbox = { window: {}, document: {}, location: { protocol: 'https:' }, DataView, TextDecoder, Uint8Array, Uint16Array, Int8Array, Float32Array, JSON };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(REPO, 'assets/pod-assets.js'), 'utf8')
    .replace("window.GridPodAssets = { load, geometry, logoUrl: LOGO_URL };",
      'window.GridPodAssets = { load, geometry, parseModel, logoUrl: LOGO_URL };');
  vm.runInContext(src, sandbox);
  const api = sandbox.window.GridPodAssets;
  const attrs = {};
  const groups = [];
  let index = null;
  class BufferAttribute { constructor(array) { this.array = array; } }
  class BufferGeometry {
    setAttribute(name, a) { attrs[name] = a.array; }
    setIndex(a) { index = a.array; }
    addGroup(start, count, mat) { groups.push([start, count, mat]); }
    computeBoundingBox() {}
  }
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
  api.geometry({ BufferGeometry, BufferAttribute }, api.parseModel(ab));
  return { pos: attrs.position, nor: attrs.normal, idx: index, uv: attrs.uv, groups };
}

const same = (a, b) => a.length === b.length
  && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

const { GEO, LOGO } = loadSource();
const before = oldDecode(GEO);
let failed = false;
for (const file of ['assets/powerpod.bin', 'assets/powerpod.bin.gz']) {
  let buf = fs.readFileSync(path.join(REPO, file));
  if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  const after = newDecode(buf);
  for (const k of ['pos', 'nor', 'idx', 'uv']) {
    const ok = same(before[k], after[k]);
    if (!ok) failed = true;
    console.log(`${file} ${k}: ${ok ? 'identical' : 'DIFFERENT'} (${before[k].length} values)`);
  }
  const groupsOk = JSON.stringify(before.groups) === JSON.stringify(after.groups);
  if (!groupsOk) failed = true;
  console.log(`${file} groups: ${groupsOk ? 'identical' : 'DIFFERENT'}`);
}
// The script copy for pages opened from disk: the same gzipped bytes, and the same logo.
{
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'assets/powerpod-model.js'), 'utf8'), sandbox);
  const { gz, logo } = sandbox.window.GridPodModel;
  const fromScript = zlib.gunzipSync(Buffer.from(gz, 'base64'));
  const same = fromScript.equals(fs.readFileSync(path.join(REPO, 'assets/powerpod.bin')));
  if (!same || logo !== LOGO) failed = true;
  console.log(`powerpod-model.js: mesh ${same ? 'identical' : 'DIFFERENT'}, logo ${logo === LOGO ? 'identical' : 'DIFFERENT'}`);
}
const png = fs.readFileSync(path.join(REPO, 'assets/powerpod-logo.png'));
const logoOk = png.equals(Buffer.from(LOGO.split(',')[1], 'base64'));
if (!logoOk) failed = true;
console.log(`powerpod-logo.png: ${logoOk ? 'identical to the inlined PNG' : 'DIFFERENT'}`);
process.exitCode = failed ? 1 : 0;
