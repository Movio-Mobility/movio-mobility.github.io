/*
 * The dealers page: finding one, and keeping the list true.
 *
 * The cards arrive as HTML, prerendered by the build from what Paddock published (see
 * tools/dealers.mjs), along with the same data as JSON (#dealers-data). This script:
 *
 *   FINDS. Words, a pincode, a city chip or "Near me", all worked out here on the list already
 *   loaded (assets/dealers-core.js). Nothing typed and no position ever leaves the page: the
 *   location from "Near me" lives in a variable, and only a chosen city is written to the
 *   address (?city=). Each settled search and each tap on a card's action is counted through
 *   window.gridTrack with its kind only, never what was typed or where anyone is.
 *
 *   KEEPS THE HOURS LIVE. Each card's "Open now · closes 7 PM" line is worked out in India's
 *   time (assets/hours.js) and redone at the turn of every minute while the page is visible.
 *   A timer, not a frame loop: nothing here runs per frame.
 *
 *   KEEPS THE LIST FRESH. After the first paint, again when the page comes back into focus
 *   or view, it asks Paddock for the list (backing off when Paddock does not answer) and
 *   redraws only the cards that changed, holding the scroll position still while it does.
 *   A dealer added since the last build has its photo only on Paddock, and the page may show
 *   images from the site alone, so its card shows no photo until the next build brings one.
 *
 *   LINKS. dealers.html#d-<slug> scrolls to that dealer and lights its card. Share hands that
 *   link to the phone's share sheet, or copies it.
 *
 * Without JavaScript the prerendered cards are the page: plain tel:, wa.me and Maps links.
 */
(() => {
  'use strict';

  const D = window.gridDealers;
  const H = window.gridHours;
  const api = window.gridxApi;
  const main = document.getElementById('dealers');
  if (!main || !D || !H) return;

  const ROUTE = '/api/public/website/dealers';
  const FRESH_MS = 60000;          // a focus within this of the last answer asks nothing
  const SETTLE_MS = 1200;          // typing this still counts as one search
  const TOPBAR_CLEAR = 88;         // px under the fixed top bar where results begin

  const $ = (id) => document.getElementById(id);
  const listEl = $('dealers-list');
  const citiesEl = $('dealers-cities');
  const countEl = $('dealers-count');
  const noteEl = $('dealers-note');
  const sayEl = $('dealers-say');
  const emptyEl = $('dealers-empty');
  const errorEl = $('dealers-error');
  const errorLine = $('dealers-error-line');
  const dock = $('dealer-dock');
  const input = $('dealer-q');
  const clearBtn = dock.querySelector('.dealer-dock__clear');
  const nearBtn = dock.querySelector('.dealer-dock__near');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const perf = window.GridPerf;
  const idle = perf ? perf.idle : (fn, timeout) => setTimeout(fn, Math.min(timeout || 0, 300));

  // The site's root, from this script's own address, so a card's photo and a shared link are
  // right wherever the page sits. base is the relative climb a card's photo needs: '' here.
  const ROOT = new URL('../', (document.currentScript && document.currentScript.src) || new URL('assets/', location.href).href);
  const base = (() => {
    if (ROOT.origin !== location.origin || !location.pathname.startsWith(ROOT.pathname)) return ROOT.href;
    return '../'.repeat(location.pathname.slice(ROOT.pathname.length).split('/').length - 1);
  })();

  const track = (name, props) => {
    try {
      if (typeof window.gridTrack === 'function') window.gridTrack(name, props);
    } catch (_) { /* counting must never break the page */ }
  };

  // ---------------------------------------------------------------- state
  let data = null;                 // the list on show, normalized
  const byId = new Map();          // id → dealer
  const nodes = new Map();         // id → its <li>
  const drawn = new Map();         // id → the HTML its <li> was drawn from
  const local = new Map();         // id → a photo this site has (from the build)
  const view = { city: '', query: '', here: null };
  const km = new Map();            // id → km from view.here
  let pendingCity = new URLSearchParams(location.search).get('city') || '';

  const fromHtml = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html;
    return t.content;
  };

  // ---------------------------------------------------------------- the list
  /** Draw `doc` into the list, touching only the cards that differ from what is there. */
  function sync(doc) {
    for (const d of doc.dealers) {
      // Only a photo the build put on this site; Paddock's alt text wins if it changed.
      if (d.photo && D.isLocalPhoto(d.photo)) local.set(d.id, d.photo);
      const have = local.get(d.id);
      d.photo = d.photo && have ? { ...have, alt: d.photo.alt || have.alt } : null;
    }
    const anchor = scrollAnchor();
    const added = [];
    const drawnNow = [];
    const seen = new Set();
    doc.dealers.forEach((d, i) => {
      seen.add(d.id);
      const html = D.renderCard(d, { now: null, base, eager: i < 2 });
      const old = nodes.get(d.id);
      if (old && drawn.get(d.id) === html) return;
      const node = fromHtml(html).firstElementChild;
      // A new card off screen would be laid out at content-visibility's placeholder height
      // and take its real one a frame later, after the scroll had been held: so it is laid
      // out in full now, and handed back to content-visibility once its size is known.
      node.style.contentVisibility = 'visible';
      drawnNow.push(node);
      if (old) {
        node.hidden = old.hidden;
        old.replaceWith(node);
      } else {
        listEl.appendChild(node);
        if (data) added.push(node);
      }
      nodes.set(d.id, node);
      drawn.set(d.id, html);
    });
    for (const [id, node] of nodes) {
      if (seen.has(id)) continue;
      node.remove();
      nodes.delete(id);
      drawn.delete(id);
    }
    const citiesBefore = data ? JSON.stringify(data.cities) : '';
    data = doc;
    byId.clear();
    for (const d of doc.dealers) byId.set(d.id, d);
    if (JSON.stringify(doc.cities) !== citiesBefore || !citiesEl.querySelector('.dealers-city')) drawCities();
    if (pendingCity) {
      const key = cityKeyFor(pendingCity);
      pendingCity = '';
      if (key) setCity(key, { write: false });
    } else if (view.city && !doc.cities.some((c) => c.key === view.city)) {
      setCity('', { write: true });
    }
    const first = !main.classList.contains('is-loaded');
    main.classList.add('is-loaded');
    showError(null);
    tick();
    apply();
    restore(anchor);
    if (drawnNow.length) setTimeout(() => { for (const node of drawnNow) node.style.removeProperty('content-visibility'); }, 400);
    // A link to one dealer: once the list is first in place, prerendered or fetched.
    if (first) showLinked(false);
    if (!reduceMotion) for (const node of added) node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out' });
  }

  /** Adopt the prerendered cards as they are, so nothing is redrawn on the way in. */
  function adopt(doc) {
    doc.dealers.forEach((d, i) => {
      if (d.photo && D.isLocalPhoto(d.photo)) local.set(d.id, d.photo);
      const node = document.getElementById(`d-${d.slug}`);
      if (!node || node.parentElement !== listEl) return;
      nodes.set(d.id, node);
      drawn.set(d.id, D.renderCard(d, { now: null, base, eager: i < 2 }));
    });
    // Anything in the list the data does not know is redrawn or dropped by sync.
    for (const li of [...listEl.children]) {
      if (!nodes.has(li.dataset.id)) li.remove();
    }
    sync(doc);
  }

  function drawCities() {
    if (!data) return;
    citiesEl.innerHTML = '';
    citiesEl.appendChild(fromHtml(D.renderCities(data.cities, view.city)));
  }

  /** ?city= as written, or a city's plain name where only one state has it. */
  function cityKeyFor(raw) {
    const want = D.slugify(raw);
    if (!want || !data) return '';
    const exact = data.cities.find((c) => c.key === want);
    if (exact) return exact.key;
    const named = data.cities.filter((c) => D.slugify(c.name) === want);
    return named.length ? named[0].key : '';
  }

  /** The chosen city, on the chips and in the address. A chosen city drops a #d- link, which
   *  would otherwise bring back a dealer the city hides on the next visit; keepHash keeps it. */
  function setCity(key, { write = true, keepHash = false } = {}) {
    view.city = key;
    for (const chip of citiesEl.querySelectorAll('.dealers-city')) {
      chip.setAttribute('aria-pressed', chip.dataset.city === key ? 'true' : 'false');
    }
    if (!write) return;
    try {
      const url = new URL(location.href);
      if (key) url.searchParams.set('city', key);
      else url.searchParams.delete('city');
      history.replaceState(history.state, '', url.pathname + url.search + (keepHash ? url.hash : ''));
    } catch (_) { /* a sandboxed frame: the filter still works */ }
  }

  const distanceTo = (d) => {
    if (!view.here) return null;
    if (!km.has(d.id)) km.set(d.id, D.haversine(view.here, d));
    return km.get(d.id);
  };
  const nearestFirst = (list) => list
    .map((d, i) => ({ d, i, k: distanceTo(d) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.d);

  /** What is shown, in what order, and what the lines above it say. */
  function results() {
    const all = data ? data.dealers : [];
    const q = view.query.trim();
    const kind = D.queryKind(q);
    if (kind === 'pincode') {
      const pin = q.replace(/\s+/g, '');
      const r = D.pincodeSearch(all, pin);
      const none = !r.partial && !r.exact && r.list.length;
      return {
        list: r.list,
        count: D.countText(r.list.length, { kind: 'pincode', pincode: pin, exact: r.exact, partial: r.partial }),
        note: none ? `No dealer in ${pin} yet. These are the nearest.` : '',
      };
    }
    if (kind === 'text') {
      const list = D.textSearch(all, q);
      return { list: view.here ? nearestFirst(list) : list, count: D.countText(list.length, { kind: 'text' }) };
    }
    if (view.city) {
      const c = data.cities.find((x) => x.key === view.city);
      const list = c ? all.filter((d) => d.city === c.name && d.state === c.state) : all;
      return { list: view.here ? nearestFirst(list) : list, count: D.countText(list.length, { kind: 'city', city: c ? D.cityLabel(c, data.cities) : '' }) };
    }
    if (view.here) return { list: nearestFirst(all), count: D.countText(all.length, { kind: 'near' }) };
    return { list: all, count: D.countText(all.length, { cities: data ? data.cities.length : 0 }) };
  }

  let lastOrder = '';
  let noteText = '';
  /** Show the results: reorder, hide the rest, set distances, counts and the empty state. */
  function apply({ animate = false, reveal = false } = {}) {
    if (!data) return;
    const { list, count, note = '' } = results();
    const order = list.map((d) => nodes.get(d.id)).filter(Boolean);
    let cursor = listEl.firstElementChild;
    for (const node of order) {
      if (node === cursor) cursor = cursor.nextElementSibling;
      else listEl.insertBefore(node, cursor);
      if (node.hidden) node.hidden = false;
    }
    for (let n = cursor; n; n = n.nextElementSibling) n.hidden = true;

    for (const d of list) {
      const el = nodes.get(d.id) && nodes.get(d.id).querySelector('[data-dist]');
      const text = D.distanceText(distanceTo(d));
      if (el && el.textContent !== text) el.textContent = text;
    }

    if (countEl.textContent !== count) countEl.textContent = count;
    setNote(note || noteText);
    emptyEl.hidden = list.length > 0;

    const sig = list.map((d) => d.id).join(',');
    if (sig !== lastOrder) {
      // Read out when the results change, not when the page first shows them.
      if (lastOrder) sayLater(list.length ? count : 'No dealers in that area yet');
      lastOrder = sig;
      if (reveal) revealResults();
      if (animate && !reduceMotion) {
        order.slice(0, 6).forEach((node, i) => node.animate(
          [{ opacity: 0, transform: 'translate3d(0, 10px, 0)' }, { opacity: 1, transform: 'none' }],
          { duration: 420, delay: i * 40, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' },
        ));
      }
    }
  }

  function setNote(text) {
    if (noteEl.textContent !== text) noteEl.textContent = text;
    noteEl.hidden = !text;
  }

  let sayTimer = 0;
  function sayLater(text) {
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => { sayEl.textContent = text; }, 700);
  }

  /** The results' top edge just under the top bar, if the reader has scrolled past it. */
  function revealResults() {
    const top = citiesEl.getBoundingClientRect().top;
    if (top < TOPBAR_CLEAR) window.scrollTo({ top: Math.max(0, window.scrollY + top - TOPBAR_CLEAR), behavior: 'auto' });
  }

  // Scroll held still across a redraw: the first card in view keeps its place on screen.
  function scrollAnchor() {
    if (window.scrollY < 1) return null;
    for (const node of listEl.children) {
      if (node.hidden) continue;
      const r = node.getBoundingClientRect();
      if (r.bottom > TOPBAR_CLEAR) return { id: node.dataset.id, top: r.top };
    }
    return null;
  }
  function restore(anchor) {
    const node = anchor && nodes.get(anchor.id);
    if (!node || !node.isConnected || node.hidden) return;
    const dy = node.getBoundingClientRect().top - anchor.top;
    if (Math.abs(dy) >= 1) window.scrollBy(0, dy);
  }

  // ---------------------------------------------------------------- open or closed
  const nowEls = new WeakMap();
  /** Every card's live line, in India's time. Writes only what changed. */
  function tick() {
    const now = Date.now();
    for (const [id, node] of nodes) {
      const d = byId.get(id);
      if (!d || !d.hours) continue;
      let el = nowEls.get(node);
      if (!el) {
        el = node.querySelector('[data-now]');
        if (!el) continue;
        nowEls.set(node, el);
      }
      const s = H.status(d.hours, now);
      if (el.textContent !== s.text) el.textContent = s.text;
      el.classList.toggle('is-open', s.open);
      el.classList.remove('is-pending');
    }
  }
  let tickTimer = 0;
  function everyMinute() {
    clearTimeout(tickTimer);
    if (document.hidden) return;
    tickTimer = setTimeout(() => {
      tick();
      everyMinute();
    }, 60000 - (Date.now() % 60000) + 50);
  }

  // ---------------------------------------------------------------- Paddock
  let inflight = null;
  let lastOk = 0;
  let failures = 0;
  let nextTry = 0;
  let retryTimer = 0;

  /** Ask Paddock for the list; redraw what changed. Resolves when done, never rejects. */
  function refresh() {
    if (!api) return Promise.resolve();
    if (inflight) return inflight;
    clearTimeout(retryTimer);
    // no-cache: the browser revalidates with the ETag, and an unchanged list costs a 304.
    inflight = api.getJSON(ROUTE, { cache: 'no-cache', timeoutMs: 12000 })
      .then((doc) => {
        const fresh = D.normalize(doc);
        if (!fresh) {
          const err = new Error('Something went wrong on our side. Please try again in a moment.');
          err.kind = 'http';
          err.status = 200;
          throw err;
        }
        lastOk = Date.now();
        failures = 0;
        if (!data || fresh.version !== data.version) sync(fresh);
        showError(null);
      })
      .catch((err) => {
        failures++;
        const wait = Math.min(300000, 5000 * 3 ** (failures - 1)) * (0.8 + Math.random() * 0.4);
        nextTry = Date.now() + wait;
        if (!data) showError(err);
        if (!document.hidden) retryTimer = setTimeout(refresh, wait);
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function maybeRefresh() {
    if (document.hidden) return;
    const now = Date.now();
    if (failures ? now < nextTry : now - lastOk < FRESH_MS) return;
    refresh();
  }

  function showError(err) {
    if (!err) {
      errorEl.hidden = true;
      main.classList.remove('is-error');
      return;
    }
    errorLine.textContent = api ? api.describeError(err) : 'Could not reach GridX. Check your connection and try again.';
    errorEl.hidden = false;
    main.classList.add('is-error');
    sayLater('Could not load the dealers');
  }

  // ---------------------------------------------------------------- searching
  let settleTimer = 0;
  let lastSearch = '';
  /** A search counts once it has been still for a moment, or was sent. Kind only, never text. */
  function settle() {
    clearTimeout(settleTimer);
    const q = view.query.trim();
    const kind = D.queryKind(q);
    if (!kind) return;
    const sig = `${kind}:${q.toLowerCase()}`;
    if (sig === lastSearch) return;
    lastSearch = sig;
    track('dealer_search', { kind });
  }

  input.addEventListener('input', () => {
    view.query = input.value;
    clearBtn.hidden = !input.value;
    // A search covers every city.
    if (view.query.trim() && view.city) setCity('', { write: true });
    apply({ animate: true, reveal: true });
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  });
  input.addEventListener('blur', settle);
  dock.addEventListener('submit', (event) => {
    event.preventDefault();
    settle();
    input.blur(); // the keyboard goes, and the results are there to read
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    view.query = '';
    clearBtn.hidden = true;
    apply({ animate: true });
    input.focus();
  });

  citiesEl.addEventListener('click', (event) => {
    const chip = event.target.closest('.dealers-city');
    if (!chip || !data) return;
    const key = chip.dataset.city || '';
    if (input.value) {
      input.value = '';
      view.query = '';
      clearBtn.hidden = true;
    }
    const changed = key !== view.city;
    setCity(key, { write: true });
    apply({ animate: true });
    if (changed && key) track('dealer_search', { kind: 'city' });
    chip.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  });

  // "Near me": the position stays in this variable and nowhere else. Not in the address, not
  // in storage, not in what is counted, and not sent to anyone.
  nearBtn.addEventListener('click', () => {
    if (view.here) {
      view.here = null;
      km.clear();
      noteText = '';
      nearBtn.setAttribute('aria-pressed', 'false');
      apply({ animate: true });
      return;
    }
    if (!('geolocation' in navigator)) {
      noteText = 'This browser cannot share a location. Search by city, area or pincode instead.';
      apply();
      return;
    }
    nearBtn.classList.add('is-busy');
    nearBtn.setAttribute('aria-busy', 'true');
    noteText = 'Finding where you are…';
    apply();
    navigator.geolocation.getCurrentPosition((pos) => {
      nearBtn.classList.remove('is-busy');
      nearBtn.removeAttribute('aria-busy');
      view.here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      km.clear();
      input.value = '';
      view.query = '';
      clearBtn.hidden = true;
      if (view.city) setCity('', { write: true });
      nearBtn.setAttribute('aria-pressed', 'true');
      noteText = 'Nearest to you first. Your location stays on this device.';
      apply({ animate: true, reveal: true });
      track('dealer_search', { kind: 'near_me' });
    }, (err) => {
      nearBtn.classList.remove('is-busy');
      nearBtn.removeAttribute('aria-busy');
      noteText = err && err.code === 1
        ? 'Location is off for this site. Search by city, area or pincode instead.'
        : 'Could not find where you are just now. Search by city, area or pincode instead.';
      apply();
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
  });

  function resetFinder({ keepHash = false } = {}) {
    input.value = '';
    view.query = '';
    clearBtn.hidden = true;
    if (view.city) setCity('', { write: true, keepHash });
  }
  emptyEl.querySelector('[data-reset]').addEventListener('click', () => {
    resetFinder();
    view.here = null;
    km.clear();
    noteText = '';
    nearBtn.setAttribute('aria-pressed', 'false');
    apply({ animate: true, reveal: true });
  });
  errorEl.querySelector('[data-retry]').addEventListener('click', () => {
    failures = 0;
    refresh();
  });

  // ---------------------------------------------------------------- a card's actions
  listEl.addEventListener('click', (event) => {
    const link = event.target.closest('[data-act]');
    const card = link && link.closest('.dealer');
    if (!card) return;
    const action = link.dataset.act;
    track('dealer_action', { action, dealerId: card.dataset.id });
    if (action === 'share') {
      event.preventDefault();
      share(byId.get(card.dataset.id), link);
    }
  });

  async function share(d, link) {
    if (!d) return;
    const url = new URL(`dealers.html#d-${d.slug}`, ROOT).href;
    if (navigator.share) {
      try {
        await navigator.share({ title: `${d.name}, GridX dealer`, text: `${d.name}, ${[d.area, d.city].filter(Boolean).join(', ')}`, url });
      } catch (_) { /* dismissed */ }
      return;
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = url;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(area);
      area.select();
      try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
      area.remove();
    }
    const label = link.querySelector('span');
    if (copied && label) {
      label.textContent = 'Copied';
      sayLater('Link copied');
      setTimeout(() => { label.textContent = 'Share'; }, 1800);
    } else {
      noteText = `The link to ${d.name}: ${url}`;
      apply();
    }
  }

  // ---------------------------------------------------------------- dealers.html#d-<slug>
  function showLinked(smooth) {
    const m = /^#d-([a-z0-9-]{3,48})$/.exec(location.hash);
    const node = m && document.getElementById(`d-${m[1]}`);
    if (!node || node.parentElement !== listEl) return;
    if (node.hidden) {
      resetFinder({ keepHash: true });
      apply();
    }
    // Cards off screen are laid out at an estimated height (content-visibility), so they are
    // all measured once before the jump, or it would land short of the card.
    listEl.classList.add('is-measuring');
    node.scrollIntoView({ block: 'center', behavior: smooth && !reduceMotion ? 'smooth' : 'auto' });
    setTimeout(() => listEl.classList.remove('is-measuring'), smooth ? 900 : 50);
    node.classList.remove('is-target');
    requestAnimationFrame(() => {
      node.classList.add('is-target');
      setTimeout(() => node.classList.remove('is-target'), 2800);
    });
  }
  window.addEventListener('hashchange', () => showLinked(true));

  // ---------------------------------------------------------------- start
  let embedded = null;
  try {
    const el = $('dealers-data');
    embedded = el ? D.normalize(JSON.parse(el.textContent)) : null;
  } catch (_) {
    embedded = null;
  }

  if (embedded) adopt(embedded);
  else {
    listEl.innerHTML = '';
    sayLater('Loading dealers');
  }
  everyMinute();
  // The first row's rise has played (by 1.4s); a card moved by the finder later must not
  // rise again.
  setTimeout(() => main.classList.remove('is-entering'), 1600);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(tickTimer);
      return;
    }
    tick();
    everyMinute();
    maybeRefresh();
  });
  window.addEventListener('focus', maybeRefresh);
  window.addEventListener('pageshow', (event) => { if (event.persisted) maybeRefresh(); });

  // The phone's keyboard: the dock rides it (dealers.css, html.is-typing).
  if (window.gridKeyboard) window.gridKeyboard.watch({ shell: dock, scope: dock });

  // Paddock: straight away when there is nothing to show, otherwise once the page has
  // painted and gone quiet, so the check never competes with the first frames.
  if (!embedded) refresh();
  else {
    const later = () => idle(() => refresh(), 3000);
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });
  }

  // For tools/check/dealers.mjs, and anyone at the console: ask Paddock now.
  window.gridDealersPage = { refresh };
})();
