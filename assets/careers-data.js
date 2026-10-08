/*
 * Careers data, for every careers page: what is open, kept fresh.
 *
 * One copy of the careers document per page, shared by whatever on the page needs it (the
 * role page's banner, the apply sheet, the timeline on careers.html), so the page asks
 * Paddock once however many parts of it are listening.
 *
 * WHERE IT COMES FROM, in order:
 *   1. The snapshot the build wrote into the page, if it has one:
 *        <script type="application/json" id="careers-snapshot">{...}</script>
 *      careers.html carries the whole document (the build fills <!-- careers:data -->);
 *      a role page carries a slice of it, its own job plus what applying needs (domains,
 *      the apply settings), marked "scope": "role". Either is there at first paint.
 *   2. Paddock's live document (GET /api/public/website/careers), fetched straight away and
 *      then kept fresh: every 60 seconds (give or take 10, so a room full of open tabs does
 *      not ask in step) while the page is visible, and again on focus, on coming back to the
 *      tab and on coming back online. A failure backs off (30s, 1, 2, 4, then every 10
 *      minutes) and keeps whatever was already here. The browser revalidates with the ETag
 *      by itself (gridx-api.js getJSON), so a check that finds nothing new is a 304.
 *
 * Event and timer driven only: nothing runs per frame, and nothing runs while hidden.
 *
 *   gridCareers.get()            the current state (below)
 *   gridCareers.subscribe(fn)    fn(state) now (when there is data) and on every change;
 *                                returns a function that unsubscribes
 *   gridCareers.refresh()        ask Paddock now; resolves the state
 *   gridCareers.findJob(ref)     an open job by id, slug or previous slug, or null
 *   gridCareers.findClosed(ref)  a recently closed or paused role, or null
 *   gridCareers.domain(key)      a domain, or null
 *   gridCareers.roleState(ref)   'open' | 'closed' | 'paused' | 'gone', or 'unknown' until
 *                                Paddock itself has answered (a snapshot can be hours old,
 *                                so it never decides that a role has closed)
 *
 * State: { data, source: 'none'|'snapshot'|'live', live, version, partial, updatedAt, error }
 *   data       the careers document (the Paddock contract), or null
 *   live       true once data has come from Paddock in this visit
 *   partial    true while data is a role page's slice rather than the whole document
 *   error      the last failed fetch (gridx-api.js error shape), cleared by the next success
 * A change is a new version, a new source or an error appearing or clearing; a check that
 * finds the same version tells nobody.
 */
(() => {
  'use strict';

  if (window.gridCareers) return;

  const PATH = '/api/public/website/careers';
  const EVERY_MS = 60000;
  const JITTER_MS = 10000;
  const BACKOFF_MS = [30000, 60000, 120000, 240000, 600000];
  const NUDGE_MIN_MS = 10000; // focus and visibility nudges, at most this often

  const listeners = new Set();
  let state = { data: null, source: 'none', live: false, version: '', partial: false, updatedAt: 0, error: null };
  let timer = 0;
  let inflight = null;
  let failures = 0;
  let lastTry = 0;

  const isDoc = (d) => Boolean(d) && typeof d === 'object' && typeof d.version === 'string'
    && Array.isArray(d.jobs) && Array.isArray(d.domains);

  function emit() {
    for (const fn of listeners) {
      try { fn(state); } catch (err) { console.warn('[gridCareers] listener failed', err); }
    }
  }

  function set(next) {
    const changed = next.version !== state.version || next.source !== state.source
      || Boolean(next.error) !== Boolean(state.error) || next.partial !== state.partial;
    state = { ...state, ...next };
    if (changed) emit();
  }

  // ---------------------------------------------------------------- 1. the snapshot
  (function readSnapshot() {
    const el = document.getElementById('careers-snapshot');
    if (!el) return;
    try {
      const data = JSON.parse(el.textContent || 'null');
      if (!isDoc(data)) return;
      state = { ...state, data, source: 'snapshot', version: data.version, partial: data.scope === 'role', updatedAt: Date.now() };
    } catch (_) {
      // A snapshot that does not parse is no snapshot: the live fetch fills in.
    }
  }());

  // ---------------------------------------------------------------- 2. Paddock
  function schedule(ms) {
    clearTimeout(timer);
    timer = 0;
    if (document.hidden) return; // picked up again on visibilitychange
    timer = setTimeout(() => { refresh(); }, ms);
  }

  const jitter = (ms, spread) => ms + (Math.random() * 2 - 1) * spread;

  function refresh() {
    if (inflight) return inflight;
    const api = window.gridxApi;
    if (!api || typeof api.getJSON !== 'function') return Promise.resolve(state);
    lastTry = Date.now();
    clearTimeout(timer);
    inflight = api.getJSON(PATH, { cache: 'no-cache' })
      .then((data) => {
        if (!isDoc(data)) {
          const err = new Error('That answer was not the careers list.');
          err.kind = 'http';
          err.code = 'invalid_response';
          throw err;
        }
        failures = 0;
        set({ data, source: 'live', live: true, version: data.version, partial: false, updatedAt: Date.now(), error: null });
        schedule(jitter(EVERY_MS, JITTER_MS));
      })
      .catch((err) => {
        failures++;
        set({ error: err });
        const wait = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
        schedule(jitter(wait, wait * 0.2));
      })
      .then(() => {
        inflight = null;
        return state;
      });
    return inflight;
  }

  const nudge = () => {
    if (document.hidden) return;
    if (Date.now() - lastTry < NUDGE_MIN_MS) return;
    refresh();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
      timer = 0;
    } else {
      nudge();
      if (!timer && !inflight) schedule(jitter(EVERY_MS, JITTER_MS));
    }
  });
  window.addEventListener('focus', nudge);
  window.addEventListener('online', () => { failures = 0; refresh(); });

  // ---------------------------------------------------------------- lookups
  const jobs = () => (state.data && Array.isArray(state.data.jobs) ? state.data.jobs : []);
  const closed = () => (state.data && Array.isArray(state.data.recentlyClosed) ? state.data.recentlyClosed : []);

  /** ref: an id, a slug, a previous slug, or an object carrying an id or a slug. */
  function matches(entry, ref) {
    if (!entry || !ref) return false;
    if (typeof ref === 'object') {
      return (ref.id && entry.id === ref.id) || (ref.slug && matches(entry, ref.slug)) || false;
    }
    return entry.id === ref || entry.slug === ref
      || (Array.isArray(entry.previousSlugs) && entry.previousSlugs.includes(ref));
  }

  const findJob = (ref) => jobs().find((j) => matches(j, ref)) || null;
  const findClosed = (ref) => closed().find((r) => matches(r, ref)) || null;
  const domain = (key) => ((state.data && state.data.domains) || []).find((d) => d.key === key) || null;

  function roleState(ref) {
    if (!state.live) return 'unknown';
    if (findJob(ref)) return 'open';
    const gone = findClosed(ref);
    if (gone) return gone.state === 'paused' ? 'paused' : 'closed';
    return 'gone';
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    if (state.data || state.error) {
      try { fn(state); } catch (err) { console.warn('[gridCareers] listener failed', err); }
    }
    return () => listeners.delete(fn);
  }

  window.gridCareers = {
    get: () => state,
    subscribe,
    refresh,
    findJob,
    findClosed,
    domain,
    roleState,
  };

  // Straight away, unless the tab is in the background: then on its first showing.
  if (!document.hidden) refresh();
})();
