/*
 * Dealers: what a dealer is, how its card is written, and how the list is searched.
 *
 * ONE COPY FOR TWO PLACES. The build (tools/dealers.mjs) runs this file in a Node vm context
 * to prerender dealers.html, and the page runs it to draw the cards again when Paddock says
 * something has changed. A card is therefore the same string of HTML whoever writes it, which
 * tools/check/dealers.mjs proves. So, like assets/hours.js, it leans on nothing but the
 * language: no DOM, no URL, no Intl, and no locale-dependent sorting.
 *
 *   gridDealers.normalize(doc, { warn })   Paddock's GET dealers, checked and cleaned (below)
 *   gridDealers.renderCard(dealer, opts)   one <li> card; opts { now, base, distanceKm, eager }
 *   gridDealers.renderCities(cities, key)  the city chips
 *   gridDealers.countText(n, context)      the line above the list
 *   gridDealers.textSearch / pincodeSearch / haversine / formatKm   the finder's arithmetic
 *
 * WHAT NORMALIZE ENFORCES, beyond the contract's shape (Part 0 of the platform plan):
 *   - a pin inside India (Paddock's inIndia bounds), or the dealer is dropped: a card whose
 *     directions lead out to sea is worse than no card
 *   - phones in E.164, at most four, exactly one primary; no phone, no card
 *   - a Maps link only to Google Maps over https (google.com/maps, maps.google.com,
 *     maps.app.goo.gl); anything else is dropped, never shown as a link
 *   - hours in the contract's shape (gridHours.normalize), or none at all
 *   - services from the known five, each once
 *   - a photo either on this site (dealers/photos/, written by the build) or on Paddock; a
 *     card only ever shows the first kind, so the page's img-src 'self' is never tested
 * Text is trimmed and capped, never trusted: every value is escaped where it is written.
 *
 * NEVER A PHONE NUMBER AS TEXT. A number appears only inside a tel: or wa.me link, whose
 * accessible name is the action and the dealer ("Call Okhla Swap Hub").
 */
(function (root) {
  'use strict';

  const H = root.gridHours;

  const SERVICES = { sales: 'Sales', installation: 'Fitting', service: 'Service', swap: 'Battery swap', test_ride: 'Test ride' };
  const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  const E164 = /^\+[1-9]\d{7,14}$/;
  const PINCODE = /^[1-9]\d{5}$/;
  const PLACE_ID = /^[A-Za-z0-9_-]{1,300}$/;
  const MAPS = /^https:\/\/(?:(?:www\.)?google\.com\/maps(?:[/?#]|$)|maps\.google\.com(?:[/?#]|$)|maps\.app\.goo\.gl\/)[^\s"'<>\\^`{|}]*$/;
  // A photo the build has put on this site, and one still on Paddock (or the mock).
  const LOCAL_PHOTO = /^dealers\/photos\/[A-Za-z0-9_-]+-\d{2,4}\.webp(?:\?v=[A-Za-z0-9]{1,32})?$/;
  const REMOTE_PHOTO = /^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)[^\s"'<>\\]+$/;
  // Within this of where a pincode probably is, a dealer counts as nearby whatever its code.
  const NEAR_KM = 60;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isSlug = (s) => typeof s === 'string' && s.length >= 3 && s.length <= 48 && SLUG.test(s);
  const inIndia = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= 6 && lat <= 37.5 && lng >= 68 && lng <= 97.5;

  /** A string from the outside: control characters out, whitespace collapsed, capped. */
  function text(v, max) {
    if (typeof v !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);

  /** Lower case, accents off, punctuation to spaces: "CIDCO E-Mobility" → "cidco e mobility". */
  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  const slugify = (s) => fold(s).replace(/ /g, '-');

  // ---------------------------------------------------------------- normalize
  function phonesOf(list, warn, id) {
    const phones = [];
    for (const p of Array.isArray(list) ? list.slice(0, 4) : []) {
      if (!isObj(p) || typeof p.e164 !== 'string' || !E164.test(p.e164)) {
        warn(`dealers: ${id} has a phone that is not an E.164 number; left out`);
        continue;
      }
      if (phones.some((q) => q.e164 === p.e164)) continue;
      phones.push({
        label: text(p.label, 20) || 'Shop',
        e164: p.e164,
        display: text(p.display, 24) || p.e164,
        whatsapp: p.whatsapp === true,
        primary: p.primary === true,
      });
    }
    // Exactly one primary: the first marked one, or else the first.
    const first = phones.findIndex((p) => p.primary);
    phones.forEach((p, i) => { p.primary = i === (first < 0 ? 0 : first); });
    return phones;
  }

  function photoOf(p) {
    if (p === null || p === undefined) return null;
    if (!isObj(p) || typeof p.url !== 'string') return undefined;
    const local = LOCAL_PHOTO.test(p.url);
    if (!local && !REMOTE_PHOTO.test(p.url)) return undefined;
    const w = Number(p.w);
    const h = Number(p.h);
    if (!(w > 0 && h > 0 && w <= 8192 && h <= 8192)) return undefined;
    const out = { url: p.url, w: Math.round(w), h: Math.round(h), alt: text(p.alt, 160) };
    // srcset: only ever the build's own, every entry on this site.
    if (local && typeof p.srcset === 'string') {
      const parts = p.srcset.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length && parts.every((s) => /^\S+ \d{2,4}w$/.test(s) && LOCAL_PHOTO.test(s.split(' ')[0]))) out.srcset = parts.join(', ');
    }
    return out;
  }

  /** One dealer, cleaned, or a reason it cannot be shown. */
  function dealerOf(d, warn) {
    if (!isObj(d)) return 'not an object';
    if (typeof d.id !== 'string' || !ID.test(d.id)) return 'no usable id';
    if (!isSlug(d.slug)) return `bad slug ${JSON.stringify(d.slug)}`;
    const name = text(d.name, 120);
    if (!name) return 'no name';
    const city = text(d.city, 60);
    const state = text(d.state, 60);
    if (!city || !state) return 'no city or state';
    const lat = Number(d.lat);
    const lng = Number(d.lng);
    if (typeof d.lat !== 'number' || typeof d.lng !== 'number' || !inIndia(lat, lng)) return 'its pin is not in India';
    const phones = phonesOf(d.phones, warn, d.id);
    if (!phones.length) return 'no usable phone number';

    let mapsUrl = null;
    if (typeof d.mapsUrl === 'string' && d.mapsUrl) {
      if (d.mapsUrl.length <= 2048 && MAPS.test(d.mapsUrl)) mapsUrl = d.mapsUrl;
      else warn(`dealers: ${d.id} has a Maps link that is not Google Maps over https; left out`);
    }
    let hours = null;
    if (d.hours !== null && d.hours !== undefined) {
      hours = H.normalize(d.hours);
      if (!hours) warn(`dealers: ${d.id} has hours that do not fit the contract; shown without them`);
    }
    let photo = photoOf(d.photo);
    if (photo === undefined) {
      warn(`dealers: ${d.id} has a photo that does not fit the contract; shown without it`);
      photo = null;
    }
    const services = [];
    for (const s of Array.isArray(d.services) ? d.services : []) {
      if (Object.prototype.hasOwnProperty.call(SERVICES, s) && !services.includes(s)) services.push(s);
    }
    const pincode = typeof d.pincode === 'string' && PINCODE.test(d.pincode) ? d.pincode : null;
    return {
      id: d.id,
      slug: d.slug,
      name,
      area: text(d.area, 60) || null,
      city,
      state,
      pincode,
      address: text(d.address, 300),
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      placeId: typeof d.placeId === 'string' && PLACE_ID.test(d.placeId) ? d.placeId : null,
      mapsUrl,
      phones,
      hours,
      hoursNote: text(d.hoursNote, 160) || null,
      services,
      photo,
      featured: d.featured === true,
      sortOrder: Number.isFinite(d.sortOrder) ? d.sortOrder : 0,
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt.slice(0, 40) : null,
    };
  }

  /**
   * The cities, from the dealers that survived: most dealers first, then by name. Each gets the
   * key ?city= uses: its name as a slug, with the state added only where two states share a
   * name (Aurangabad, Bihar and Aurangabad, Maharashtra).
   */
  function citiesOf(dealers) {
    const byCity = new Map();
    for (const d of dealers) {
      const k = `${d.city}|${d.state}`;
      if (!byCity.has(k)) byCity.set(k, { name: d.city, state: d.state, count: 0 });
      byCity.get(k).count++;
    }
    const cities = [...byCity.values()].sort((a, b) => b.count - a.count
      || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0)
      || (a.state < b.state ? -1 : a.state > b.state ? 1 : 0));
    const names = new Map();
    for (const c of cities) names.set(fold(c.name), (names.get(fold(c.name)) || 0) + 1);
    for (const c of cities) {
      c.shared = names.get(fold(c.name)) > 1;
      c.key = slugify(c.shared ? `${c.name} ${c.state}` : c.name) || 'city';
    }
    return cities;
  }

  /** GET dealers, checked and cleaned. null when the document itself is unusable. */
  function normalize(doc, { warn = () => {} } = {}) {
    if (!isObj(doc) || typeof doc.version !== 'string' || !doc.version.trim() || !Array.isArray(doc.dealers)) return null;
    const ids = new Set();
    const slugs = new Set();
    const dealers = [];
    doc.dealers.forEach((raw, i) => {
      const d = dealerOf(raw, warn);
      const label = isObj(raw) && typeof raw.id === 'string' ? ` (${raw.id.slice(0, 64)})` : '';
      if (typeof d === 'string') {
        warn(`dealers: dropped dealer ${i}${label}: ${d}`);
        return;
      }
      if (ids.has(d.id)) return warn(`dealers: dropped dealer ${i}${label}: duplicate id`);
      if (slugs.has(d.slug)) return warn(`dealers: dropped dealer ${i}${label}: duplicate slug ${d.slug}`);
      ids.add(d.id);
      slugs.add(d.slug);
      dealers.push(d);
    });
    const cities = citiesOf(dealers).map(({ name, state, count, key }) => ({ name, state, count, key }));
    return { version: doc.version.trim().slice(0, 80), cities, dealers };
  }

  // ---------------------------------------------------------------- links
  const primaryPhone = (d) => d.phones.find((p) => p.primary) || d.phones[0];
  const whatsappPhone = (d) => [primaryPhone(d), ...d.phones].find((p) => p && p.whatsapp) || null;

  function directionsUrl(d) {
    const place = d.placeId ? `&destination_place_id=${encodeURIComponent(d.placeId)}` : '';
    return `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}${place}`;
  }

  function whatsappUrl(d) {
    const p = whatsappPhone(d);
    if (!p) return null;
    const message = `Hi ${d.name}, I found you on the GridX website and would like to know more about the PowerPod.`;
    return `https://wa.me/${p.e164.slice(1)}?text=${encodeURIComponent(message)}`;
  }

  // ---------------------------------------------------------------- the card
  // The site's outline icons: 24 box, 1.6 stroke, round caps (site.css .island svg).
  const ICON = {
    call: '<path d="M6.6 3.5h2.3c.5 0 .9.3 1 .8l.7 3.1c.1.4 0 .8-.3 1.1L8.8 10a11.5 11.5 0 0 0 5.2 5.2l1.5-1.5c.3-.3.7-.4 1.1-.3l3.1.7c.5.1.8.5.8 1v2.3c0 1.1-.9 2-2 2A15.5 15.5 0 0 1 4.6 5.5c0-1.1.9-2 2-2z"/>',
    whatsapp: '<path d="M20.5 11.9a8.4 8.4 0 0 1-12.4 7.4l-4.6 1.2 1.2-4.5A8.4 8.4 0 1 1 20.5 11.9z"/><path d="M9.7 9.5c.2-.4.4-.4.7-.4h.4c.2 0 .4 0 .6.5l.5 1.3c.1.2 0 .4-.1.5l-.4.4c-.1.2-.2.3 0 .5a6 6 0 0 0 2.4 2.1c.2.1.4.1.5-.1l.4-.5c.2-.2.3-.2.5-.1l1.3.6c.2.1.4.2.4.4 0 .4-.3 1-1 1.2-.8.2-2-.2-3.4-1.4a8 8 0 0 1-2.4-3.3c-.2-.7-.1-1.3.2-1.7z"/>',
    directions: '<path d="M12 2.9 21.1 12 12 21.1 2.9 12z"/><path d="M9.6 14.6v-2.3c0-.8.6-1.4 1.4-1.4h4.2"/><path d="m13.2 8.9 2 2-2 2"/>',
    share: '<path d="M12 14.5v-11"/><path d="M8.5 7 12 3.5 15.5 7"/><path d="M8.8 10.5H7.2c-.9 0-1.7.8-1.7 1.7v6.6c0 .9.8 1.7 1.7 1.7h9.6c.9 0 1.7-.8 1.7-1.7v-6.6c0-.9-.8-1.7-1.7-1.7h-1.6"/>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

  /** "650 m", "2.4 km", "38 km", "1,240 km". */
  function formatKm(km) {
    if (!Number.isFinite(km) || km < 0) return '';
    if (km < 1) return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m`;
    if (km < 10) return `${(Math.round(km * 10) / 10).toString()} km`;
    return `${String(Math.round(km)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} km`;
  }

  /** The distance as it sits at the end of the area line, separator and all. */
  const distanceText = (km) => (Number.isFinite(km) ? ` · ${formatKm(km)}` : '');

  /** Only photos the build put on this site are ever shown (img-src 'self'). */
  const isLocalPhoto = (photo) => Boolean(photo && LOCAL_PHOTO.test(photo.url));

  /**
   * One dealer's card, as HTML.
   *   now         a Date or epoch ms for the live open or closed line; null leaves the line
   *               blank but holding its height, for the page to fill (a prerender must not
   *               freeze "Open now" at the moment it was built)
   *   base        what climbs from the page to the site root, for the photo ('' at the root)
   *   distanceKm  shown after the city when known
   *   eager       the first cards' photos load at once rather than lazily
   */
  function renderCard(d, { now = null, base = '', distanceKm = null, eager = false } = {}) {
    const name = esc(d.name);
    const out = [`<li class="dealer" id="d-${esc(d.slug)}" data-id="${esc(d.id)}">`];

    if (isLocalPhoto(d.photo)) {
      const p = d.photo;
      const srcset = p.srcset
        ? ` srcset="${esc(p.srcset.split(', ').map((s) => `${base}${s}`).join(', '))}" sizes="(min-width: 1200px) 384px, (min-width: 760px) 46vw, 100vw"`
        : '';
      out.push(`<div class="dealer__media"><img src="${esc(base + p.url)}"${srcset} width="${p.w}" height="${p.h}" alt="${esc(p.alt || `${d.name}, ${d.city}`)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async"></div>`);
    } else {
      out.push(`<div class="dealer__media dealer__media--mark" aria-hidden="true">${svg('pin')}</div>`);
    }

    out.push('<div class="dealer__body">');
    out.push(`<h3 class="dealer__name">${name}</h3>`);
    const where = [d.area, d.city].filter(Boolean).map(esc).join(' · ');
    out.push(`<p class="dealer__where">${where}<span class="dealer__dist" data-dist>${esc(distanceText(distanceKm))}</span></p>`);
    if (d.address) out.push(`<p class="dealer__address">${esc(d.address)}</p>`);

    if (d.hours) {
      const s = now === null || now === undefined ? null : H.status(d.hours, now);
      out.push(s
        ? `<p class="dealer__now${s.open ? ' is-open' : ''}" data-now>${esc(s.text)}</p>`
        : '<p class="dealer__now is-pending" data-now>&nbsp;</p>');
      out.push(`<p class="dealer__hours">${esc(H.summary(d.hours) || 'Closed every day.')}</p>`);
    } else {
      out.push('<p class="dealer__hours">Call ahead for opening hours.</p>');
    }
    if (d.hoursNote) out.push(`<p class="dealer__note">${esc(d.hoursNote)}</p>`);

    if (d.services.length) {
      out.push(`<ul class="dealer__services" aria-label="Services">${d.services.map((s) => `<li>${esc(SERVICES[s])}</li>`).join('')}</ul>`);
    }

    const call = primaryPhone(d);
    const wa = whatsappUrl(d);
    out.push('<div class="dealer__actions">');
    out.push(`<a class="dealer__act dealer__act--call" href="tel:${esc(call.e164)}" data-act="call" aria-label="Call ${name}">${svg('call')}<span>Call</span></a>`);
    if (wa) out.push(`<a class="dealer__act" href="${esc(wa)}" target="_blank" rel="noopener" data-act="whatsapp" aria-label="WhatsApp ${name}">${svg('whatsapp')}<span>WhatsApp</span></a>`);
    out.push(`<a class="dealer__act" href="${esc(directionsUrl(d))}" target="_blank" rel="noopener" data-act="directions" aria-label="Directions to ${name}">${svg('directions')}<span>Directions</span></a>`);
    out.push(`<a class="dealer__act dealer__act--share" href="#d-${esc(d.slug)}" data-act="share" aria-label="Share ${name}">${svg('share')}<span>Share</span></a>`);
    out.push('</div></div></li>');
    return out.join('');
  }

  /** The chips: All, then each city with its count. `selected` is a city key or ''. */
  function renderCities(cities, selected = '') {
    const chip = (key, label, count) => `<button class="dealers-city" type="button" data-city="${esc(key)}" aria-pressed="${key === selected ? 'true' : 'false'}">${label}${count === null ? '' : ` <span class="dealers-city__n">${count}<span class="sr-only"> ${count === 1 ? 'dealer' : 'dealers'}</span></span>`}</button>`;
    return [chip('', 'All', null)]
      .concat(cities.map((c) => chip(c.key, esc(cityLabel(c, cities)), c.count)))
      .join('');
  }

  /** A city's name, with its state where another state has a city of the same name. */
  function cityLabel(c, cities) {
    const twin = cities.some((o) => o !== c && fold(o.name) === fold(c.name));
    return twin ? `${c.name}, ${c.state}` : c.name;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** The line above the list, for what is being shown. */
  function countText(n, ctx = {}) {
    switch (ctx.kind) {
      case 'city': return `${plural(n, 'dealer', 'dealers')} in ${ctx.city}`;
      case 'text': return n ? `${plural(n, 'dealer matches', 'dealers match')} your search` : '';
      case 'pincode':
        if (!n) return '';
        if (!ctx.partial && ctx.exact) return `${plural(ctx.exact, 'dealer', 'dealers')} in ${ctx.pincode}${n > ctx.exact ? `, ${n - ctx.exact} more nearby` : ''}`;
        return ctx.partial
          ? `${plural(n, 'dealer', 'dealers')} with pincodes starting ${ctx.pincode}`
          : `${plural(n, 'dealer', 'dealers')} near ${ctx.pincode}`;
      case 'near': return `${plural(n, 'dealer', 'dealers')}, nearest first`;
      default: return n ? `${plural(n, 'dealer', 'dealers')} in ${plural(ctx.cities || 0, 'city', 'cities')}` : '';
    }
  }

  // ---------------------------------------------------------------- the finder
  const RAD = Math.PI / 180;
  /** Great-circle distance in km between two { lat, lng }. */
  function haversine(a, b) {
    const dLat = (b.lat - a.lat) * RAD;
    const dLng = (b.lng - a.lng) * RAD;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function centroid(list) {
    let lat = 0;
    let lng = 0;
    for (const d of list) { lat += d.lat; lng += d.lng; }
    return { lat: lat / list.length, lng: lng / list.length };
  }

  /** What a query is: a pincode (all digits, up to six) or words. */
  function queryKind(q) {
    const t = String(q || '').replace(/\s+/g, '');
    if (!t) return null;
    return /^\d{1,6}$/.test(t) ? 'pincode' : 'text';
  }

  /**
   * Words: every one must begin a word of the dealer's name, area, city, state or pincode.
   * Best first (a name beats an area beats a place), then in the list's own order.
   * Returns the matching dealers.
   */
  function textSearch(dealers, query) {
    const tokens = fold(query).split(' ').filter(Boolean);
    if (!tokens.length) return dealers.slice();
    const scored = [];
    dealers.forEach((d, i) => {
      const fields = [
        [fold(d.name).split(' '), 4],
        [fold(d.area).split(' '), 3],
        [fold(`${d.city} ${d.state}`).split(' '), 2],
        [[d.pincode || ''], 2],
      ];
      let score = 0;
      for (const t of tokens) {
        let best = 0;
        for (const [words, weight] of fields) {
          for (const w of words) {
            if (w && w.startsWith(t)) best = Math.max(best, w === t ? weight + 0.5 : weight);
          }
        }
        if (!best) return;
        score += best;
      }
      scored.push({ d, score, i });
    });
    return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.d);
  }

  /**
   * A pincode. Digits shared from the left say how close two codes are (region, circle,
   * sorting district, office), so, with no geocoder and nothing sent anywhere:
   *   - while fewer than six digits are typed, the dealers whose code begins with them
   *   - six digits: the dealers with exactly that code first; then a ladder down the prefix
   *     to the longest one some dealer shares, whose dealers' centroid stands in for where
   *     the code probably is; and the rest, from the same postal circle or within NEAR_KM of
   *     that point, nearest to it first
   * Returns { list, exact, partial, anchor }.
   */
  function pincodeSearch(dealers, query) {
    const q = String(query || '').replace(/\s+/g, '');
    const n = q.length;
    const tiers = dealers.map((d, i) => {
      let k = 0;
      const p = d.pincode || '';
      while (k < n && p[k] === q[k]) k++;
      return { d, k, i };
    });
    const top = tiers.reduce((m, t) => Math.max(m, t.k), 0);
    if (!top) return { list: [], exact: 0, partial: n < 6, anchor: null };
    const exact = tiers.filter((t) => t.k === n);
    if (n < 6 && exact.length) return { list: exact.map((t) => t.d), exact: exact.length, partial: true, anchor: null };
    const anchor = centroid(tiers.filter((t) => t.k === top).map((t) => t.d));
    const floor = top >= 2 ? 2 : 1;
    const rest = tiers
      .filter((t) => t.k < n)
      .map((t) => ({ ...t, km: haversine(anchor, t.d) }))
      .filter((t) => t.k >= floor || t.km <= NEAR_KM)
      .sort((a, b) => a.km - b.km || a.i - b.i);
    return { list: exact.map((t) => t.d).concat(rest.map((t) => t.d)), exact: exact.length, partial: false, anchor };
  }

  root.gridDealers = {
    SERVICES,
    NEAR_KM,
    normalize,
    citiesOf,
    renderCard,
    renderCities,
    cityLabel,
    countText,
    directionsUrl,
    whatsappUrl,
    isLocalPhoto,
    formatKm,
    distanceText,
    haversine,
    queryKind,
    textSearch,
    pincodeSearch,
    fold,
    slugify,
    esc,
  };
})(typeof window !== 'undefined' ? window : globalThis);
