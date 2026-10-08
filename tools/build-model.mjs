#!/usr/bin/env node
/*
 * The PowerPod model as files the browser can use directly, from the mesh and logo that used
 * to ship inside a 1.1 MB script (tools/source/powerpod-data.js, the GEO and LOGO globals).
 *
 *   assets/powerpod.bin.gz   the mesh, gzipped (what pages load: GitHub Pages does not
 *                            compress unknown file types, so the page inflates it itself)
 *   assets/powerpod.bin      the same, uncompressed, for browsers without DecompressionStream
 *   assets/powerpod-logo.png the wordmark texture, byte for byte the PNG that was inlined
 *   assets/powerpod-model.js the same mesh (gzipped, base64) and the logo as a data URL, in a
 *                            script, for a page opened straight from disk (file://): there a
 *                            browser refuses to fetch() a local file and will not let WebGL
 *                            read a local image, but still runs a local script
 *
 * The mesh is exactly the quantised data the script carried, no longer as base64 text:
 *   [u32 header length][header JSON][pad to 4][positions u16 x nv*3][normals i8 x nv*3][pad][indices u16 x nf*3]
 * The header holds lo, sc, nv, nf and split, and the byte offset of each array. Decoded, the
 * arrays are identical to what decode() built from the base64 (tools/check/model.mjs proves it).
 *
 *   node tools/build-model.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SOURCE = path.join(HERE, 'source/powerpod-data.js');

export function loadSource(file = SOURCE) {
  const src = fs.readFileSync(file, 'utf8');
  return new Function(`${src}\nreturn { GEO, LOGO: typeof LOGO !== 'undefined' ? LOGO : null };`)();
}

export function encodeModel(GEO) {
  const pos = Buffer.from(GEO.v, 'base64');
  const nor = Buffer.from(GEO.n, 'base64');
  const idx = Buffer.from(GEO.f, 'base64');
  if (pos.length !== GEO.nv * 6 || nor.length !== GEO.nv * 3 || idx.length !== GEO.nf * 6) {
    throw new Error('powerpod-data.js does not match its own counts');
  }
  // Offsets are filled in once the header's own length is known; each array starts on a
  // boundary its typed view can read from.
  const header = { lo: GEO.lo, sc: GEO.sc, nv: GEO.nv, nf: GEO.nf, split: GEO.split, pos: 0, nor: 0, idx: 0 };
  let json = '';
  for (let pass = 0; pass < 3; pass++) {
    json = JSON.stringify(header);
    const start = 4 + Buffer.byteLength(json);
    header.pos = Math.ceil(start / 4) * 4;
    header.nor = header.pos + pos.length;
    header.idx = Math.ceil((header.nor + nor.length) / 4) * 4;
  }
  json = JSON.stringify(header);
  const out = Buffer.alloc(header.idx + idx.length);
  out.writeUInt32LE(Buffer.byteLength(json), 0);
  out.write(json, 4, 'utf8');
  pos.copy(out, header.pos);
  nor.copy(out, header.nor);
  idx.copy(out, header.idx);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GEO, LOGO } = loadSource();
  const bin = encodeModel(GEO);
  fs.writeFileSync(path.join(REPO, 'assets/powerpod.bin'), bin);
  const gz = zlib.gzipSync(bin, { level: 9 });
  fs.writeFileSync(path.join(REPO, 'assets/powerpod.bin.gz'), gz);
  const match = /^data:image\/png;base64,(.*)$/.exec(LOGO || '');
  if (!match) throw new Error('LOGO is not a PNG data URL');
  const png = Buffer.from(match[1], 'base64');
  fs.writeFileSync(path.join(REPO, 'assets/powerpod-logo.png'), png);
  fs.writeFileSync(path.join(REPO, 'assets/powerpod-model.js'), [
    '/* The PowerPod model for pages opened straight from disk (file://), where a browser will not',
    '   fetch() a local file or let WebGL read a local image. Same bytes as powerpod.bin.gz, base64,',
    '   and the logo as a data URL. Written by tools/build-model.mjs; used only by pod-assets.js. */',
    `window.GridPodModel = { gz: '${gz.toString('base64')}', logo: '${LOGO}' };`,
    '',
  ].join('\n'));
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`powerpod.bin     ${kb(bin.length)}`);
  console.log(`powerpod.bin.gz  ${kb(gz.length)}  (powerpod-data.js was ${kb(fs.statSync(SOURCE).size)}, ${kb(zlib.gzipSync(fs.readFileSync(SOURCE)).length)} gzipped)`);
  console.log(`powerpod-logo.png ${kb(png.length)}`);
}
