#!/usr/bin/env node
/*
 * A static server that behaves like GitHub Pages where it matters for testing: gzip for the
 * text types Pages compresses (and only those, so an unknown type like .bin goes out raw),
 * the same ten-minute Cache-Control, and the same answers for paths that are not a file:
 *   - a folder without its trailing slash is a 301 to the slash form (query kept)
 *   - a folder with it serves its index.html
 *   - /name serves name.html when there is one (Pages' extensionless URLs)
 *   - anything else is the root 404.html with status 404, which is how /jobs/<slug>/ reaches
 *     its redirect before a role has a page of its own (plain "Not found" if there is none)
 * It listens on every interface, so a phone on the same Wi-Fi can open the site by the
 * Mac's LAN address.
 *
 * Serving the working copy, it also serves the languages the way the build writes them:
 * /hi/store.html (and /mr/, /bn/, /kn/, /te/, and /qps/, the pseudo-locale) is store.html put
 * into that language from i18n/ as it stands on disk (tools/i18n.mjs), with its assets one
 * folder up, and /assets/i18n/<lang>.js is that language's words for the scripts. Edit a
 * catalogue and reload. /hi/assets/ is never answered, so a page that names an asset relative
 * to itself fails here exactly as it would live.
 *
 *   node tools/serve.mjs                    working copy on :8002
 *   node tools/serve.mjs --root dist        the built site
 *   node tools/serve.mjs --root <dir> --port 8001
 *
 * Also importable: serve({ root, port }) resolves to the running http.Server.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { localise, relink, scriptDictionary, isTranslated, forgetCatalogues, fillPicker, LANGS, PSEUDO } from './i18n.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
};
// What GitHub Pages (Fastly) gzips. Everything else is served as stored.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.svg', '.txt', '.xml']);

const LANG_PATH = new RegExp(`^/(${[...LANGS, PSEUDO].join('|')})(?:/(.*))?$`);
const DICT_PATH = new RegExp(`^/assets/i18n/(${[...LANGS, PSEUDO].join('|')})\\.js$`);

export function serve({ root, port = 8002, quiet = false } = {}) {
  const base = path.resolve(root || process.cwd());
  // The working copy, not a build: the languages are made on the fly.
  const sources = fs.existsSync(path.join(base, 'i18n', 'languages.mjs'));
  const inside = (file) => file === base || file.startsWith(base + path.sep);
  const isFile = (file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  };
  const isDir = (file) => {
    try { return fs.statSync(file).isDirectory(); } catch { return false; }
  };

  function send(req, res, file, status) {
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const headers = {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'max-age=600',
        'Access-Control-Allow-Origin': '*',
      };
      const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      if (gzip) {
        body = zlib.gzipSync(body, { level: 6 });
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
      }
      headers['Content-Length'] = body.length;
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  }

  function sendText(req, res, text, ext, status = 200) {
    let body = Buffer.from(text);
    const headers = { 'Content-Type': TYPES[ext], 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      body = zlib.gzipSync(body, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer((req, res) => {
    let url;
    let pathname;
    try {
      url = new URL(req.url, 'http://x');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.join(base, pathname);
    if (!inside(file)) {
      res.writeHead(403).end();
      return;
    }

    if (sources) {
      const dict = DICT_PATH.exec(pathname);
      if (dict && !isFile(file)) {
        forgetCatalogues();
        sendText(req, res, scriptDictionary(dict[1], { warn: quiet ? () => {} : (m) => console.warn(m) }), '.js');
        return;
      }
      const lang = LANG_PATH.exec(pathname);
      if (lang) {
        const rest = (lang[2] || '').replace(/\/+$/, '');
        const page = !rest ? 'index.html' : /\.html$/.test(rest) ? rest : `${rest}.html`;
        if (!rest.includes('/') && isTranslated(page) && isFile(path.join(base, page))) {
          if (!pathname.endsWith('/') && !rest) {
            res.writeHead(301, { Location: `${url.pathname}/${url.search}` }).end();
            return;
          }
          forgetCatalogues();
          const { html } = localise(page, lang[1], fs.readFileSync(path.join(base, page), 'utf8'), { warn: quiet ? () => {} : (m) => console.warn(m) });
          sendText(req, res, relink(fillPicker(html, page, lang[1])), '.html', page === '404.html' ? 404 : 200);
          return;
        }
      }
      // An English page of the working copy, with its picker written in (the build does it too).
      const htmlFile = isFile(file) && file.endsWith('.html') ? file
        : !pathname.endsWith('/') && isFile(`${file}.html`) ? `${file}.html`
          : isDir(file) && pathname.endsWith('/') && isFile(path.join(file, 'index.html')) ? path.join(file, 'index.html') : null;
      if (htmlFile) {
        forgetCatalogues();
        const rel = path.relative(base, htmlFile).split(path.sep).join('/');
        sendText(req, res, fillPicker(fs.readFileSync(htmlFile, 'utf8'), rel, 'en'), '.html');
        return;
      }
    }

    if (isDir(file)) {
      // Pages redirects a folder to its slash form before it looks inside it.
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${url.pathname}/${url.search}`, 'Cache-Control': 'max-age=600' }).end();
        return;
      }
      const index = path.join(file, 'index.html');
      if (isFile(index)) {
        send(req, res, index, 200);
        return;
      }
    } else if (isFile(file)) {
      send(req, res, file, 200);
      return;
    } else if (!pathname.endsWith('/') && isFile(`${file}.html`)) {
      send(req, res, `${file}.html`, 200);
      return;
    }

    if (!quiet) console.log(`404 ${pathname}`);
    const notFound = path.join(base, '404.html');
    if (isFile(notFound) && sources) sendText(req, res, fillPicker(fs.readFileSync(notFound, 'utf8'), '404.html', 'en'), '.html', 404);
    else if (isFile(notFound)) send(req, res, notFound, 404);
    else res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  });
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      if (!quiet) {
        const lan = Object.values(os.networkInterfaces()).flat()
          .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
        console.log(`Serving ${base}`);
        console.log(`  http://localhost:${port}/`);
        for (const ip of lan) console.log(`  http://${ip}:${port}/   (phones on the same Wi-Fi)`);
      }
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  serve({ root: opt('root', '.'), port: Number(opt('port', 8002)) });
}
