/*
 * Dealers, for the build (tools/build.mjs imports this).
 *
 * dealers.html is prerendered from what Paddock publishes, so the list is there in the HTML
 * for a first paint, for anything crawling the page, and for a browser with JavaScript off.
 * The page then keeps itself fresh from Paddock (assets/dealers.js).
 *
 * The rules a dealer has to pass, and the card's markup, are not written here: they are
 * assets/dealers-core.js (and assets/hours.js under it), run in a vm context exactly as the
 * browser runs them, so the build and the page can never disagree about either.
 *
 *   normalizeDealers(doc, { warn })          the contract, checked and cleaned (dealers-core.js)
 *   downloadDealerPhotos(data, { outDir })   each photo onto this site, as
 *                                            dist/dealers/photos/<id>-<w>.webp
 *   renderDealerCard(dealer, { now, base })  one card, the same function the page uses
 *   dealersJsonLd(data)                      an ItemList of AutoDealer, for search engines
 *   dealersTransform(data)                   fills the comment markers in dealers.html
 *
 * PHOTOS. The page's policy lets images come only from the site itself (img-src 'self' in
 * tools/build.mjs), so a photo is shown only once the build has fetched it here. Each width
 * Paddock offers (320, 640, 1280) is fetched, checked to be a WebP of at most 400 KB, written
 * under dealers/photos/ and versioned with ?v=<hash of its bytes>, which the service worker
 * keeps in its media cache until the photo changes. Nothing here can fail the build: a photo
 * that cannot be fetched is left off its card (photo: null) with a warning.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const SITE_ORIGIN = 'https://gridxenergy.in';

export const PHOTO_DIR = 'dealers/photos';
export const PHOTO_WIDTHS = [320, 640, 1280];
export const PHOTO_MAX_BYTES = 400 * 1024;

const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
function defaultWarn(message) {
  console.warn(IN_ACTIONS ? `::warning::${message.replace(/\r?\n/g, ' ')}` : `warning: ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
// Out of the vm's realm and into this one, so its arrays and objects behave as ours do.
const plain = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------- the shared scripts
let shared = null;
/** assets/hours.js and assets/dealers-core.js, run in one vm context as a page runs them. */
export function loadShared() {
  if (shared) return shared;
  const context = vm.createContext({});
  for (const rel of ['assets/hours.js', 'assets/dealers-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, rel), 'utf8'), context, { filename: rel });
  }
  shared = { gridHours: context.gridHours, gridDealers: context.gridDealers };
  return shared;
}

/** GET dealers, checked against the contract and cleaned. null when the document is unusable. */
export function normalizeDealers(doc, { warn = defaultWarn } = {}) {
  return plain(loadShared().gridDealers.normalize(doc, { warn }));
}

/** One card, exactly as assets/dealers.js would write it. */
export function renderDealerCard(dealer, opts = {}) {
  return loadShared().gridDealers.renderCard(dealer, opts);
}

// ---------------------------------------------------------------- photos
/** A WebP's pixel size from its header, or null when the bytes are not a WebP. */
export function webpSize(buf) {
  if (!buf || buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** The same photo at another width: Paddock names them <id>-<width>.webp. */
const variantUrl = (url, w) => (/-\d{2,4}\.webp(?=$|[?#])/.test(url) ? url.replace(/-\d{2,4}\.webp(?=$|[?#])/, `-${w}.webp`) : null);

/** Fetch one image, capped at maxBytes as it streams. Resolves { buf, size } or { error }. */
async function fetchImage(url, { maxBytes, timeoutMs, attempts }) {
  let error = '';
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(1000 * i);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'image/webp', 'User-Agent': 'gridx-site-build' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!res.ok) {
        error = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
        continue;
      }
      const declared = Number(res.headers.get('content-length'));
      if (declared > maxBytes) {
        res.body?.cancel().catch(() => {});
        return { error: `larger than ${Math.round(maxBytes / 1024)} KB` };
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) return { error: `larger than ${Math.round(maxBytes / 1024)} KB` };
        chunks.push(chunk);
      }
      const buf = Buffer.concat(chunks);
      const dims = webpSize(buf);
      if (!dims) return { error: 'not a WebP image' };
      return { buf, dims };
    } catch (err) {
      error = err && err.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : String((err && err.message) || err);
    }
  }
  return { error };
}

async function pool(items, size, fn) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

/**
 * Every dealer's photo onto this site. Returns a copy of the data with each photo's url on
 * the site (dealers/photos/<id>-640.webp?v=<hash>) and a srcset of the widths that arrived, or
 * photo null where none did. Never throws.
 *
 *   outDir   the build's output folder
 *   base     what a relative photo url resolves against: a snapshot of the live site names its
 *            photos relative to the site, and they are fetched back from there
 */
export async function downloadDealerPhotos(data, {
  outDir,
  base = `${SITE_ORIGIN}/`,
  widths = PHOTO_WIDTHS,
  maxBytes = PHOTO_MAX_BYTES,
  timeoutMs = 15000,
  attempts = 2,
  concurrency = 4,
  warn = defaultWarn,
} = {}) {
  if (!data || !Array.isArray(data.dealers)) return data;
  const out = plain(data);
  const dir = path.join(outDir, PHOTO_DIR);
  const withPhoto = out.dealers.filter((d) => d.photo);
  await pool(withPhoto, concurrency, async (d) => {
    try {
      let source;
      try {
        source = new URL(d.photo.url, base).href;
      } catch {
        throw new Error('its address is not a URL');
      }
      const tries = variantUrl(source, 640) ? widths.map((w) => [w, variantUrl(source, w)]) : [[d.photo.w || 640, source]];
      const got = [];
      let lastError = '';
      for (const [w, url] of tries) {
        const r = await fetchImage(url, { maxBytes, timeoutMs, attempts });
        if (r.error) {
          lastError = `${w}: ${r.error}`;
          continue;
        }
        const file = `${d.id}-${w}.webp`;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, file), r.buf);
        got.push({ w, dims: r.dims, url: `${PHOTO_DIR}/${file}?v=${hash(r.buf)}` });
      }
      if (!got.length) throw new Error(lastError || 'nothing arrived');
      // The card's src is the 640 (what Paddock's own url names) or the nearest that came.
      const main = got.find((g) => g.w === 640) || got.reduce((a, b) => (Math.abs(b.w - 640) < Math.abs(a.w - 640) ? b : a));
      // srcset by each file's real width, one entry per width.
      const seen = new Set();
      const srcset = got
        .slice()
        .sort((a, b) => a.dims.w - b.dims.w)
        .filter((g) => !seen.has(g.dims.w) && seen.add(g.dims.w))
        .map((g) => `${g.url} ${g.dims.w}w`)
        .join(', ');
      d.photo = { url: main.url, w: main.dims.w, h: main.dims.h, alt: d.photo.alt || '', srcset };
      if (got.length < tries.length) warn(`dealers: ${d.id}'s photo arrived at ${got.length} of ${tries.length} widths (${lastError})`);
    } catch (err) {
      warn(`dealers: ${d.id}'s photo could not be fetched (${err.message}); shown without it`);
      d.photo = null;
    }
  });
  return out;
}

// ---------------------------------------------------------------- the page
/** JSON for inside a <script> element: nothing in it can close the element or open a comment. */
export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** schema.org: the dealers as an ItemList of AutoDealer, with hours, phone and address. */
export function dealersJsonLd(data, { origin = SITE_ORIGIN } = {}) {
  const { gridHours, gridDealers } = loadShared();
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'GridX dealers',
    numberOfItems: data.dealers.length,
    itemListElement: data.dealers.map((d, i) => {
      const phone = d.phones.find((p) => p.primary) || d.phones[0];
      const page = `${origin}/dealers.html#d-${d.slug}`;
      const specs = plain(gridHours.specs(d.hours));
      return {
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'AutoDealer',
          '@id': page,
          name: d.name,
          url: page,
          telephone: phone.e164,
          address: {
            '@type': 'PostalAddress',
            streetAddress: d.address || undefined,
            addressLocality: d.city,
            addressRegion: d.state,
            postalCode: d.pincode || undefined,
            addressCountry: 'IN',
          },
          geo: { '@type': 'GeoCoordinates', latitude: d.lat, longitude: d.lng },
          hasMap: d.mapsUrl || gridDealers.directionsUrl(d),
          image: gridDealers.isLocalPhoto(d.photo) ? `${origin}/${d.photo.url}` : undefined,
          openingHoursSpecification: specs.length ? specs : undefined,
        },
      };
    }),
  };
}

/** The pieces of dealers.html that come from the data, by marker. */
export function dealersSections(data, { now = null, base = '' } = {}) {
  const { gridDealers } = loadShared();
  return {
    'dealers:count': gridDealers.countText(data.dealers.length, { cities: data.cities.length }),
    'dealers:cities': gridDealers.renderCities(data.cities, ''),
    'dealers:list': data.dealers.map((d, i) => gridDealers.renderCard(d, { now, base, eager: i < 2 })).join(''),
    'dealers:data': `<script type="application/json" id="dealers-data">${scriptJson(data)}</script>`,
    'dealers:jsonld': `<script type="application/ld+json">${scriptJson(dealersJsonLd(data))}</script>`,
  };
}

/**
 * A source transform (tools/build.mjs registerSourceTransform) for dealers.html: each
 * <!-- dealers:<part> --> marker filled from the data. With no data the page is left as it is,
 * the build strips the markers with the other comments, and the page fetches the list itself.
 * Card markup is written with a function replacement, so nothing in a dealer's name can be
 * read as a replacement pattern.
 */
export function dealersTransform(data, { file = 'dealers.html', warn = defaultWarn } = {}) {
  return (name, html) => {
    if (name !== file || !data) return html;
    let out = html;
    for (const [marker, content] of Object.entries(dealersSections(data))) {
      const comment = `<!-- ${marker} -->`;
      const at = out.indexOf(comment);
      if (at < 0) {
        warn(`dealers: ${file} has no ${comment} marker; that part is not prerendered`);
        continue;
      }
      out = out.slice(0, at) + content + out.slice(at + comment.length);
    }
    return out;
  };
}

/** What a relative photo url in a snapshot resolves against: the root of the site it came from. */
export function siteRootOf(snapshotUrl) {
  try {
    return new URL('../', snapshotUrl).href;
  } catch {
    return `${SITE_ORIGIN}/`;
  }
}
