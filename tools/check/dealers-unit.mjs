#!/usr/bin/env node
/*
 * tools/dealers.mjs and assets/dealers-core.js, without a browser.
 *   node tools/check/dealers-unit.mjs
 *
 * Covers: what normalizeDealers keeps and drops (India's bounds, E.164, the Maps allowlist,
 * hours, services, ids and slugs), the card (escaping, no phone number as text, the links),
 * the JSON-LD, JSON that is safe inside a <script>, the page transform, the photo download
 * (its size cap, WebP only, partial and total failure, never throwing), the finder's
 * arithmetic, and buildPage's prefix for a nested page.
 *
 * Each check prints PASS or FAIL; exits 1 if any failed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  normalizeDealers, renderDealerCard, downloadDealerPhotos, dealersJsonLd, dealersTransform,
  scriptJson, webpSize, loadShared, siteRootOf, PHOTO_MAX_BYTES,
} from '../dealers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/dealers.json'), 'utf8'));
const WEBP = fs.readFileSync(path.join(HERE, 'fixtures/dealer.webp'));
const clone = (v) => JSON.parse(JSON.stringify(v));

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
}
const quiet = () => {
  const said = [];
  const warn = (m) => said.push(m);
  warn.said = said;
  return warn;
};

// ---------------------------------------------------------------- normalize
{
  const warn = quiet();
  const data = normalizeDealers(FIXTURE, { warn });
  check('normalize: the fixture passes whole', data && data.dealers.length === 12 && warn.said.length === 0, warn.said.join(' | '));
  check('normalize: cities recounted, most first, twins keyed by state',
    JSON.stringify(data.cities.map((c) => `${c.key}:${c.count}`)) === JSON.stringify(['delhi:4', 'aurangabad-bihar:2', 'aurangabad-maharashtra:2', 'bengaluru:2', 'gurugram:2']),
    data.cities.map((c) => c.key).join(', '));
  check('normalize: an unusable document is null', normalizeDealers({ dealers: [] }, { warn: quiet() }) === null && normalizeDealers('x', { warn: quiet() }) === null);

  const base = FIXTURE.dealers[0];
  const one = (patch) => {
    const w = quiet();
    const out = normalizeDealers({ version: 'd-t', dealers: [{ ...clone(base), ...patch }] }, { warn: w });
    return { d: out.dealers[0] || null, said: w.said.join(' | ') };
  };
  check('normalize: a pin outside India is dropped', one({ lat: 51.5, lng: -0.12 }).d === null, one({ lat: 51.5, lng: -0.12 }).said);
  check('normalize: a pin that is not a number is dropped', one({ lat: '28.5' }).d === null);
  check('normalize: no usable phone, no card', one({ phones: [{ label: 'Shop', e164: '98765 43201', display: '98765 43201', whatsapp: true, primary: true }] }).d === null);
  const phones = one({ phones: [
    { label: 'Shop', e164: 'tel:+91', display: 'x' },
    { label: 'Sales', e164: '+919876543299', display: '+91 98765 43299', whatsapp: true, primary: false },
    { label: 'Owner', e164: '+919876543298', display: '+91 98765 43298', whatsapp: false, primary: false },
  ] }).d;
  check('normalize: bad phones left out, exactly one primary', phones.phones.length === 2 && phones.phones.filter((p) => p.primary).length === 1 && phones.phones[0].primary,
    JSON.stringify(phones.phones.map((p) => [p.e164, p.primary])));
  check('normalize: a bad id is dropped (it names files)', one({ id: '../../etc/passwd' }).d === null && one({ id: 'a b' }).d === null);
  check('normalize: a bad slug is dropped', one({ slug: 'Not A Slug' }).d === null);
  const dup = normalizeDealers({ version: 'd', dealers: [clone(base), { ...clone(base), id: 'other1' }] }, { warn: quiet() });
  check('normalize: a duplicate slug is dropped', dup.dealers.length === 1);

  const maps = (url) => one({ mapsUrl: url }).d.mapsUrl;
  const allowed = [
    'https://www.google.com/maps/search/?api=1&query=28.5,77.2',
    'https://google.com/maps/place/x',
    'https://maps.google.com/?q=28.5,77.2',
    'https://maps.app.goo.gl/AbC123',
  ];
  const refused = [
    'http://www.google.com/maps/search/?api=1',
    'javascript:alert(1)',
    'https://evil.example/?u=https://www.google.com/maps',
    'https://google.com.evil.example/maps',
    'https://maps.google.com.evil.example/',
    'https://www.google.co.in/maps',
    'https://maps.app.goo.gl',
    'https://www.google.com/maps"><script>',
    'https://www.google.com/mapsevil',
  ];
  check('maps links: Google Maps over https kept', allowed.every((u) => maps(u) === u), allowed.filter((u) => maps(u) !== u).join(', '));
  check('maps links: anything else refused', refused.every((u) => maps(u) === null), refused.filter((u) => maps(u) !== null).join(', '));

  const badHours = one({ hours: { mon: [['19:00', '10:00']] } });
  check('normalize: hours that do not fit are dropped, with a warning', badHours.d.hours === null && /hours/.test(badHours.said));
  check('normalize: 24:00 closing kept', one({ hours: { fri: [['18:00', '24:00']] } }).d.hours.fri[0][1] === '24:00');
  check('normalize: services known and once each', JSON.stringify(one({ services: ['swap', 'swap', 'teleport', 'sales'] }).d.services) === JSON.stringify(['swap', 'sales']));
  check('normalize: a pincode that is not one is left out', one({ pincode: '01234' }).d.pincode === null && one({ pincode: '110020' }).d.pincode === '110020');
  check('normalize: text is trimmed and capped', one({ name: `  ${'x'.repeat(300)}\n ` }).d.name.length === 120);
  const photo = one({ photo: { url: 'ftp://x/y.webp', w: 640, h: 480, alt: '' } });
  check('normalize: a photo not over https is dropped, with a warning', photo.d.photo === null && /photo/.test(photo.said));
  check('normalize: a local photo with a local srcset is kept',
    one({ photo: { url: 'dealers/photos/dlrOkhla0001-640.webp?v=abc', w: 640, h: 480, alt: 'a', srcset: 'dealers/photos/dlrOkhla0001-320.webp?v=1 320w, dealers/photos/dlrOkhla0001-640.webp?v=abc 640w' } }).d.photo.srcset.split(', ').length === 2);
  check('normalize: a srcset naming anywhere else is dropped',
    one({ photo: { url: 'dealers/photos/dlrOkhla0001-640.webp', w: 640, h: 480, alt: 'a', srcset: 'https://evil.example/x.webp 320w' } }).d.photo.srcset === undefined);
}

// ---------------------------------------------------------------- the card
{
  const data = normalizeDealers(FIXTURE, { warn: quiet() });
  const nasty = data.dealers.find((d) => d.id === 'dlrScript0004');
  const html = renderDealerCard(nasty, { now: null });
  check('card: markup in a name or an address is text', html.includes('A&lt;/script&gt;B') && !html.includes('</script>') && !html.includes('<b>')
    && html.includes('Note with &quot;quotes&quot; &amp; &lt;tags&gt;.'));
  const text = (h) => h.replace(/<[^>]*>/g, ' ');
  const printed = data.dealers.filter((d) => {
    const t = text(renderDealerCard(d, { now: Date.now() }));
    return d.phones.some((p) => t.includes(p.display) || t.includes(p.e164) || t.includes(p.e164.slice(3)));
  });
  check('card: no phone number as text, on any card', printed.length === 0, printed.map((d) => d.id).join(', '));
  const okhla = renderDealerCard(data.dealers[0], { now: null });
  check('card: Call is a tel: link named for the dealer', okhla.includes('href="tel:+919876543201" data-act="call" aria-label="Call Okhla Swap Hub"'));
  check('card: WhatsApp names GridX in its message', /href="https:\/\/wa\.me\/919876543201\?text=Hi%20Okhla%20Swap%20Hub%2C%20I%20found%20you%20on%20the%20GridX%20website/.test(okhla));
  check('card: Directions to the pin, with its place', okhla.includes('href="https://www.google.com/maps/dir/?api=1&amp;destination=28.5355,77.273&amp;destination_place_id=ChIJokhla0001"'));
  const sohna = renderDealerCard(data.dealers.find((d) => d.id === 'dlrSohna0006'), { now: null });
  check('card: Directions without a place id', sohna.includes('destination=28.4089,77.0418"'));
  const cyber = renderDealerCard(data.dealers.find((d) => d.id === 'dlrCyber0005'), { now: null });
  check('card: no WhatsApp where the dealer has none', !cyber.includes('data-act="whatsapp"') && cyber.includes('data-act="call"'));
  check('card: Share links to the card itself', okhla.includes('href="#d-okhla-swap-hub" data-act="share"'));
  check('card: a photo still on Paddock is not shown', !okhla.includes('<img') && okhla.includes('dealer__media--mark'));
  const local = { ...data.dealers[0], photo: { url: 'dealers/photos/dlrOkhla0001-640.webp?v=abc', w: 640, h: 480, alt: 'Shopfront', srcset: 'dealers/photos/dlrOkhla0001-320.webp?v=a 320w, dealers/photos/dlrOkhla0001-640.webp?v=abc 640w' } };
  const nested = renderDealerCard(local, { now: null, base: '../../', eager: true });
  check('card: a local photo, prefixed for a nested page, eager when asked',
    nested.includes('src="../../dealers/photos/dlrOkhla0001-640.webp?v=abc"') && nested.includes('srcset="../../dealers/photos/dlrOkhla0001-320.webp?v=a 320w, ../../dealers/photos/dlrOkhla0001-640.webp?v=abc 640w"')
    && nested.includes('loading="eager"') && nested.includes('width="640" height="480"'));
  check('card: prerendered, the live line is blank but holds its place', okhla.includes('<p class="dealer__now is-pending" data-now>&nbsp;</p>'));
  const monNoon = Date.UTC(2026, 9, 5, 6, 30);
  check('card: with a clock, the live line is written', renderDealerCard(data.dealers[0], { now: monNoon }).includes('<p class="dealer__now is-open" data-now>Open now · closes 7 PM</p>'));
  const karol = renderDealerCard(data.dealers.find((d) => d.id === 'dlrKarol0003'), { now: monNoon });
  check('card: no hours, no live line, and it says to call', !karol.includes('data-now>') && karol.includes('Call ahead for opening hours.') && karol.includes('Call ahead on Sundays.'));
  check('card: distance when known', renderDealerCard(data.dealers[0], { now: null, distanceKm: 2.43 }).includes('data-dist> · 2.4 km</span>'));
  check('card: service names as Paddock shows them', okhla.includes('<li>Sales</li><li>Service</li><li>Battery swap</li><li>Test ride</li>'));
}

// ---------------------------------------------------------------- JSON-LD and script-safe JSON
{
  const data = normalizeDealers(FIXTURE, { warn: quiet() });
  const ld = dealersJsonLd(data);
  const okhla = ld.itemListElement[0].item;
  const karol = ld.itemListElement.find((e) => e.item.name === 'Karol Bagh Batteries').item;
  check('JSON-LD: ItemList of AutoDealer', ld['@type'] === 'ItemList' && ld.itemListElement.length === 12 && ld.itemListElement.every((e, i) => e.position === i + 1 && e.item['@type'] === 'AutoDealer'));
  check('JSON-LD: phone, address and hours', okhla.telephone === '+919876543201' && okhla.address.postalCode === '110020' && okhla.address.addressCountry === 'IN'
    && okhla.openingHoursSpecification.length === 1 && okhla.openingHoursSpecification[0].dayOfWeek.length === 6 && okhla.url === 'https://gridxenergy.in/dealers.html#d-okhla-swap-hub');
  check('JSON-LD: no hours known, no hours claimed; a photo on Paddock is not named', karol.openingHoursSpecification === undefined && okhla.image === undefined);
  const evil = { a: '</script><script>alert(1)</script>', b: '<!-- x -->', c: '\u2028\u2029', d: 'a & b' };
  const safe = scriptJson(evil);
  check('script JSON: nothing in it can close the element or open a comment', !/<|>|&|\u2028|\u2029/.test(safe) && JSON.stringify(JSON.parse(safe)) === JSON.stringify(evil));
}

// ---------------------------------------------------------------- the page transform
{
  const data = normalizeDealers(FIXTURE, { warn: quiet() });
  const source = fs.readFileSync(path.join(HERE, '../../dealers.html'), 'utf8');
  const filled = dealersTransform(data, { warn: quiet() })('dealers.html', source);
  check('transform: every marker filled', !/<!-- dealers:[a-z]+ -->/.test(filled) && filled.includes('id="dealers-data"') && filled.includes('application/ld+json')
    && filled.includes('<li class="dealer" id="d-okhla-swap-hub"') && filled.includes('>12 dealers in 5 cities<') && filled.includes('data-city="aurangabad-bihar"'));
  check('transform: other pages and no data are left alone', dealersTransform(data)('store.html', source) === source && dealersTransform(null)('dealers.html', source) === source);
  const dollars = normalizeDealers({ version: 'd', dealers: [{ ...clone(FIXTURE.dealers[0]), name: "Shop $& $' $1" }] }, { warn: quiet() });
  check('transform: a $ in a name is not read as a replacement pattern', dealersTransform(dollars, { warn: quiet() })('dealers.html', source).includes("Shop $&amp; $&#39; $1"));
  const warn = quiet();
  dealersTransform(data, { warn })('dealers.html', '<p>no markers</p>');
  check('transform: a page that lost its markers is reported', warn.said.length === 5, warn.said[0] || '');
  check('snapshot root: a relative photo resolves against the site it came from', siteRootOf('https://gridxenergy.in/dealers/snapshot.json') === 'https://gridxenergy.in/' && siteRootOf('nonsense') === 'https://gridxenergy.in/');
}

// ---------------------------------------------------------------- photos
{
  const big = Buffer.concat([WEBP.subarray(0, 30), Buffer.alloc(PHOTO_MAX_BYTES + 10)]);
  const server = http.createServer((req, res) => {
    const m = /^\/p\/([a-z]+)-(\d+)\.webp/.exec(req.url);
    const kind = m && m[1];
    if (kind === 'ok' || kind === 'local' || (kind === 'half' && m[2] === '640')) return res.writeHead(200, { 'Content-Type': 'image/webp' }).end(WEBP);
    if (kind === 'big') return res.writeHead(200, { 'Content-Type': 'image/webp' }).end(big);
    if (kind === 'chunked') {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.write(WEBP.subarray(0, 30));
      return res.end(Buffer.alloc(PHOTO_MAX_BYTES + 10));
    }
    if (kind === 'html') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Sign in</title>');
    if (kind === 'slow') return setTimeout(() => res.writeHead(200).end(WEBP), 3000);
    return res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${server.address().port}`;
  const dealer = (id, file) => ({ ...clone(FIXTURE.dealers[0]), id, slug: `s-${id.toLowerCase()}`, photo: { url: `${at}/p/${file}-640.webp?v=3`, w: 640, h: 480, alt: `Photo of ${id}` } });
  const input = normalizeDealers({
    version: 'd-p',
    dealers: [dealer('ok', 'ok'), dealer('half', 'half'), dealer('big', 'big'), dealer('chunked', 'chunked'), dealer('html', 'html'), dealer('gone', 'gone'), dealer('slow', 'slow')],
  }, { warn: quiet() });
  // A relative photo, as a snapshot names its own; it resolves against `base`. (This test
  // server's path is not dealers/photos/, so it is added after normalize rather than through it.)
  input.dealers.push({ ...dealer('local', 'x'), photo: { url: 'p/local-640.webp?v=9', w: 640, h: 480, alt: 'From a snapshot' } });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gridx-photos-'));
  const warn = quiet();
  let threw = null;
  let result = null;
  try {
    result = await downloadDealerPhotos(input, { outDir: out, base: `${at}/`, timeoutMs: 1000, attempts: 1, warn });
  } catch (err) {
    threw = err;
  }
  const by = (id) => result.dealers.find((d) => d.id === id).photo;
  const files = fs.readdirSync(path.join(out, 'dealers/photos')).sort();
  check('photos: never throws', threw === null, threw ? threw.message : '');
  check('photos: three widths written, the src local and versioned by content', /^dealers\/photos\/ok-640\.webp\?v=[0-9a-f]{10}$/.test(by('ok').url)
    && ['ok-320.webp', 'ok-640.webp', 'ok-1280.webp'].every((f) => files.includes(f)) && by('ok').alt === 'Photo of ok' && by('ok').w === 160 && by('ok').h === 120,
    JSON.stringify(by('ok')));
  check('photos: one width arriving is enough', /half-640\.webp/.test(by('half').url) && !files.includes('half-320.webp') && warn.said.some((m) => /half/.test(m) && /1 of 3/.test(m)));
  check('photos: larger than 400 KB is refused, by header or as it streams', by('big') === null && by('chunked') === null && !files.some((f) => /^(big|chunked)-/.test(f)));
  check('photos: something that is not a WebP is refused', by('html') === null && warn.said.some((m) => /html/.test(m) && /not a WebP/.test(m)));
  check('photos: a missing or slow photo leaves the card without one', by('gone') === null && by('slow') === null);
  check('photos: a snapshot\'s relative photo is fetched back from its site', /local-640\.webp/.test(by('local').url) && by('local').alt === 'From a snapshot');
  check('photos: every file written is at most 400 KB', files.every((f) => fs.statSync(path.join(out, 'dealers/photos', f)).size <= PHOTO_MAX_BYTES));
  check('photos: the input is not changed', input.dealers[0].photo.url.startsWith(at));
  check('webpSize: VP8X, and not a WebP', JSON.stringify(webpSize(WEBP)) === '{"w":160,"h":120}' && webpSize(Buffer.from('<!doctype html>')) === null);
  server.close();
  fs.rmSync(out, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the finder
{
  const { gridDealers: D } = loadShared();
  const data = normalizeDealers(FIXTURE, { warn: quiet() });
  const ids = (list) => list.map((d) => d.id);
  check('text: words begin words', JSON.stringify(ids(D.textSearch(data.dealers, 'koram'))) === '["dlrKoram0008"]' && D.textSearch(data.dealers, 'ram').length === 0);
  check('text: every word must match', JSON.stringify(ids(D.textSearch(data.dealers, 'aurangabad bihar'))) === '["dlrBihar0011","dlrDaud0012"]');
  check('text: a name beats a place', ids(D.textSearch(data.dealers, 'aurangabad'))[0] === 'dlrBihar0011');
  check('text: accents and punctuation fold away', ids(D.textSearch(data.dealers, 'Cidco É-mob')).join() === 'dlrCidco0009');
  const exact = D.pincodeSearch(data.dealers, '110020');
  check('pincode: exact first, then nearby by distance, not the far side of India', ids(exact.list)[0] === 'dlrOkhla0001' && exact.exact === 1 && !exact.partial
    && ids(exact.list).includes('dlrCyber0005') && !ids(exact.list).includes('dlrIndira0007'), ids(exact.list).join(', '));
  const none = D.pincodeSearch(data.dealers, '560001');
  check('pincode: no dealer there, the ladder finds the nearest from the shared prefix', none.exact === 0 && none.list.length === 2 && Math.abs(none.anchor.lat - 12.95355) < 0.001,
    `${ids(none.list).join(', ')} around ${JSON.stringify(none.anchor)}`);
  check('pincode: partial is a prefix', D.pincodeSearch(data.dealers, '4310').list.length === 2 && D.pincodeSearch(data.dealers, '4310').partial);
  check('pincode: a region with no dealer at all is empty', D.pincodeSearch(data.dealers, '999999').list.length === 0);
  check('query kind', D.queryKind('110 020') === 'pincode' && D.queryKind('okhla') === 'text' && D.queryKind('1100201') === 'text' && D.queryKind('  ') === null);
  const km = D.haversine({ lat: 28.6139, lng: 77.209 }, { lat: 19.076, lng: 72.8777 });
  check('haversine: Delhi to Mumbai', km > 1140 && km < 1160, `${km.toFixed(1)} km`);
  check('distances read naturally', JSON.stringify([0.43, 0.01, 2.43, 2.0, 38.4, 1240.2].map(D.formatKm)) === JSON.stringify(['450 m', '50 m', '2.4 km', '2 km', '38 km', '1,240 km']));
  check('counts', [D.countText(12, { cities: 5 }), D.countText(1, { kind: 'city', city: 'Delhi' }), D.countText(2, { kind: 'text' }), D.countText(6, { kind: 'pincode', pincode: '110020', exact: 1 }),
    D.countText(2, { kind: 'pincode', pincode: '560001', exact: 0 }), D.countText(2, { kind: 'pincode', pincode: '4310', partial: true }), D.countText(12, { kind: 'near' })].join(' / ')
    === '12 dealers in 5 cities / 1 dealer in Delhi / 2 dealers match your search / 1 dealer in 110020, 5 more nearby / 2 dealers near 560001 / 2 dealers with pincodes starting 4310 / 12 dealers, nearest first');
  const chips = D.renderCities(data.cities, 'delhi');
  check('chips: All first, the chosen one pressed, twins named with their state', chips.startsWith('<button class="dealers-city" type="button" data-city="" aria-pressed="false">All</button>')
    && chips.includes('data-city="delhi" aria-pressed="true">Delhi') && chips.includes('>Aurangabad, Bihar <') && chips.includes('>Aurangabad, Maharashtra <'));
}

// ---------------------------------------------------------------- buildPage, nested
{
  const build = await import('../build.mjs');
  const data = normalizeDealers(FIXTURE, { warn: quiet() });
  data.dealers[0].photo = { url: 'dealers/photos/dlrOkhla0001-640.webp?v=abc', w: 640, h: 480, alt: 'a', srcset: 'dealers/photos/dlrOkhla0001-320.webp?v=1 320w, dealers/photos/dlrOkhla0001-640.webp?v=abc 640w' };
  build.registerSourceTransform(dealersTransform(data, { warn: quiet() }));
  const nested = await build.buildPage('dealers.html', 'unit', { prefix: '../../' });
  const root = await build.buildPage('dealers.html', 'unit', { prefix: '' });
  check('buildPage: photos prefixed on a nested page, untouched at the root',
    nested.includes('src="../../dealers/photos/dlrOkhla0001-640.webp?v=abc" srcset="../../dealers/photos/dlrOkhla0001-320.webp?v=1 320w, ../../dealers/photos/dlrOkhla0001-640.webp?v=abc 640w"')
    && root.includes('src="dealers/photos/dlrOkhla0001-640.webp?v=abc"'));
  const dataHash = crypto.createHash('sha256').update(scriptJson(data), 'utf8').digest('base64');
  check('buildPage: the data blocks go out byte for byte, and are not hashed into the policy', root.includes(`<script type="application/json" id="dealers-data">${scriptJson(data)}</script>`)
    && !root.includes(dataHash));
  check('validateDealers is the shared normalizer', JSON.stringify(build.validateDealers(clone(FIXTURE))) === JSON.stringify(normalizeDealers(clone(FIXTURE), { warn: quiet() })));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall dealers unit checks passed');
process.exitCode = failed ? 1 : 0;
