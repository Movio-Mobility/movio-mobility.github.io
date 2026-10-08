/*
 * Careers: the teams, on the timeline tape.
 *
 * The tape itself (the film, dragging and flinging, the FLIP into the title, pinning, the peek
 * and the hint, the halo, history) is assets/tape.js, shared with the journey. This file is
 * what it runs over, all of it drawn from the careers document Paddock publishes
 * (careers-data.js keeps it fresh) and redrawn in place whenever that changes:
 *
 *   The teams      One stop per team with an open role, in Paddock's order, then one for an
 *                  open application when those are taken. Each label is the team's mark above
 *                  the line and its name below it, and both fly up into the title when it
 *                  opens. Switching rolls the title over, whole words, as the journey's
 *                  odometer rolls its digits.
 *   A team         Its line about itself, a card per role, and the way on to the next team.
 *                  Roles that open or close while the page is up arrive and leave in place
 *                  (FLIP), and whatever is being read stays where it is on the screen.
 *   A role         Its own sheet on this page, laid out as its page under /jobs/ is, with
 *                  Apply (the shared application sheet) and its address to share.
 *   Deep links     #<team> opens that team (the tape's history); ?role=<slug> (the 404 page
 *                  sends /jobs/<slug> here) and the old site's ?job=<id> open that role, and
 *                  ?apply=open an open application. A role that has closed says so calmly,
 *                  with what is still open in its team.
 *   States         Loading (stand-in labels where the real ones will be), no open roles, the
 *                  list not loading (the build's copy stays up if there is one), applications
 *                  paused. Without JavaScript the build's plain list of roles reads instead.
 *
 * Nothing here runs per frame: the tape's own loop does the moving, and the rest is events.
 * Everything from Paddock goes into the page as text, never as markup; the only markup set
 * here is constant (the icons, the sheet's shell).
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const main = document.querySelector('main.careers');
  const careers = window.gridCareers;
  if (!main || !window.GridTape || !careers) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  // The site's damped spring (site.css), so the title lands the way the island settles.
  const SPRING = getComputedStyle(root).getPropertyValue('--spring').trim() || 'cubic-bezier(0.32, 0.72, 0, 1)';
  const EASE_OUT = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

  const OPEN_ID = 'open-application';
  const KEY = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
  const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const FALLBACK_EMAIL = 'careers@gridxenergy.in';
  const LENS = 1.34; // a label's scale at the needle (tape.js placeLabels, the lens at full swell)

  const track = (name, props) => {
    try { if (typeof window.gridTrack === 'function') window.gridTrack(name, props); } catch (_) { /* never in the way */ }
  };

  // ---------------------------------------------------------------- small helpers
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim();
  const list = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const rolesText = (n) => plural(n, 'open role', 'open roles');

  // Lucide's (ISC licence), drawn as the site draws its own: a 24 unit grid, a 1.6 stroke.
  const SVG = (paths, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const ICON = {
    pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    briefcase: '<path d="M12 12h.01"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M22 13a18.15 18.15 0 0 1-20 0"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
    onsite: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
    hybrid: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    remote: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    experience: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
    team: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
    pay: '<path d="M6 3h12"/><path d="M6 8h12"/><path d="m6 13 8.5 8"/><path d="M6 13h3"/><path d="M9 13c6.667 0 6.667-10 0-10"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    share: '<path d="M12 2v13"/><path d="m16 6-4-4-4 4"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>',
  };
  const icon = (name, size, cls) => {
    const span = el('span', cls || 'cr-icon');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = SVG(ICON[name], size); // a constant above, never anything from the network
    return span;
  };
  /** A team's mark: its pinned icon (careers-icons.js), or the paper plane of an open application. */
  function markOf(d, size) {
    if (d.kind === 'open') return SVG(ICON.send, size);
    if (window.gridIcons) return window.gridIcons.svg(d.icon || '', { size }); // constant markup
    return SVG('<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>', size);
  }

  // The role page's words for the same facts (tools/careers.mjs), so a role reads the same here.
  const EMPLOYMENT = { 'full-time': 'Full time', 'part-time': 'Part time', internship: 'Internship', contract: 'Contract' };
  const WORK_MODE = { onsite: 'On site', hybrid: 'Hybrid', remote: 'Remote' };

  function formatExperience(e) {
    if (!e || typeof e !== 'object') return '';
    const min = Number.isFinite(e.min) ? e.min : 0;
    const max = Number.isFinite(e.max) ? e.max : null;
    const yrs = (n) => `${n} year${n === 1 ? '' : 's'}`;
    if (max === null) return min > 0 ? `${yrs(min)} or more` : '';
    if (max === 0) return 'No experience needed';
    if (min <= 0) return `Up to ${yrs(max)}`;
    if (min === max) return yrs(min);
    return `${min} to ${yrs(max)}`;
  }

  const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  function rupees(n) {
    if (n >= 10000000) return `${+(n / 10000000).toFixed(2)} crore`;
    if (n >= 100000) return `${+(n / 100000).toFixed(1)} lakh`;
    return INR.format(n);
  }
  function formatPay(c) {
    if (!c || typeof c !== 'object' || !Number.isFinite(c.min) || c.min <= 0) return '';
    const per = c.period === 'month' ? 'a month' : 'a year';
    const max = Number.isFinite(c.max) && c.max > c.min ? c.max : null;
    if (!max) return `From ₹${rupees(c.min)} ${per}`;
    const a = rupees(c.min);
    const b = rupees(max);
    const unit = (s) => (s.match(/ (lakh|crore)$/) || [''])[0];
    if (unit(a) && unit(a) === unit(b)) return `₹${a.slice(0, -unit(a).length)} to ${b} ${per}`;
    return `₹${a} to ₹${b} ${per}`;
  }
  const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const formatDate = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? DATE.format(t) : '';
  };

  /** Paragraphs from plain text: a blank line starts a new one, a single newline is a break. */
  function paragraphs(text) {
    return clean(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => {
      const node = el('p');
      p.split('\n').forEach((line, i) => {
        if (i) node.append(el('br'));
        node.append(document.createTextNode(line));
      });
      return node;
    });
  }

  /** A role's place in its team: Paddock's order, then featured first, then newest (as the build). */
  function byRoleOrder(a, b) {
    const s = (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
    if (s) return s;
    if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
    const t = (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
    if (t) return t;
    return String(a.title).localeCompare(String(b.title));
  }

  // ---------------------------------------------------------------- the document, as teams
  const OPEN_STOP = { kind: 'open', key: OPEN_ID, label: 'Open application', jobs: [] };

  /**
   * The careers document as this page uses it: the teams with something open, in order, each
   * with its roles in order. A role in a team the document does not list (Paddock added the
   * team after the list was cut) still shows, under its own key.
   */
  function model(data) {
    const m = { teams: [], byKey: new Map(), openOk: false, paused: false, email: FALLBACK_EMAIL, total: 0 };
    if (!data) return m;
    const jobs = (Array.isArray(data.jobs) ? data.jobs : []).filter((j) => j && j.id && j.slug && j.title && KEY.test(String(j.domain || '')));
    const domains = (Array.isArray(data.domains) ? data.domains : [])
      .filter((d) => d && KEY.test(String(d.key || '')) && d.key !== OPEN_ID && clean(d.label))
      .slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.label).localeCompare(String(b.label)));
    const known = new Set(domains.map((d) => d.key));
    for (const key of new Set(jobs.map((j) => j.domain))) {
      if (!known.has(key) && key !== OPEN_ID) {
        domains.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]+/g, ' '), icon: '', blurb: '' });
      }
    }
    for (const d of domains) {
      const roles = jobs.filter((j) => j.domain === d.key).sort(byRoleOrder);
      if (!roles.length) continue;
      m.teams.push({ kind: 'team', key: d.key, label: clean(d.label), icon: d.icon || '', blurb: clean(d.blurb), jobs: roles });
    }
    m.byKey = new Map(m.teams.map((t) => [t.key, t]));
    m.openOk = Boolean(data.openApplication && data.openApplication.enabled);
    m.paused = Boolean(data.applicationsPaused);
    m.email = (data.org && clean(data.org.careersEmail)) || FALLBACK_EMAIL;
    m.total = m.teams.reduce((n, t) => n + t.jobs.length, 0);
    return m;
  }

  let now = model(null); // the model on the page

  // ---------------------------------------------------------------- the page's parts
  const titleEl = main.querySelector('.tl-title');
  const iconCell = titleEl.querySelector('.cr-title__icon');
  const nameCell = titleEl.querySelector('.cr-title__name');
  const themeEl = main.querySelector('.tl-theme');
  const labelsEl = main.querySelector('.tl-bar__labels');
  const panelsEl = main.querySelector('.tl-panels');
  const noticeEl = main.querySelector('[data-notice]');
  const intro = {
    kicker: main.querySelector('[data-intro-kicker]'),
    title: main.querySelector('[data-intro-title]'),
    count: main.querySelector('[data-intro-count]'),
    status: main.querySelector('[data-intro-status]'),
  };
  const INTRO_KICKER = intro.kicker.textContent;
  const INTRO_TITLE = intro.title.textContent;

  // The build's plain list is for reading without JavaScript; the tape takes over from here.
  for (const node of main.querySelectorAll('.cr-static')) node.remove();

  // ---------------------------------------------------------------- the title
  // The open team's mark over its name, each in a cell of its own. A switch rolls each cell
  // over, the old face out and the new one in, the way the journey's digits roll; the cells
  // clip only while rolling, so the faces can fly in from the tape unclipped.
  function iconFace(d) {
    const f = el('span', 'cr-face cr-face--icon');
    f.innerHTML = markOf(d, 64);
    return f;
  }
  function nameFace(d) {
    return el('span', 'cr-face cr-face--name', d.label);
  }
  // A long name shrinks to fit the width; the line it sits in never changes height.
  function fit(face) {
    face.style.fontSize = '';
    const avail = titleEl.clientWidth;
    const w = face.offsetWidth;
    if (avail > 0 && w > avail) {
      const size = parseFloat(getComputedStyle(face).fontSize) * (avail / w) * 0.98;
      face.style.fontSize = `${size.toFixed(2)}px`;
    }
  }
  function setTitle(s) {
    if (!s) return;
    iconCell.replaceChildren(iconFace(s.data));
    const f = nameFace(s.data);
    nameCell.replaceChildren(f);
    fit(f);
    titleEl.dataset.stop = s.id;
  }
  function rollCell(cell, next, dir, delay) {
    cell.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    while (cell.children.length > 1) cell.firstElementChild.remove();
    const old = cell.lastElementChild;
    cell.append(next);
    if (next.classList.contains('cr-face--name')) fit(next);
    if (!old) return;
    cell.classList.add('is-rolling');
    const opts = { duration: 680, delay, easing: SPRING, fill: 'both' };
    old.animate([
      { transform: 'translate3d(0, 0, 0)', opacity: 1 },
      { transform: `translate3d(0, ${-dir * 105}%, 0)`, opacity: 0 },
    ], opts).onfinish = () => old.remove();
    const arrive = next.animate([
      { transform: `translate3d(0, ${dir * 105}%, 0)`, opacity: 0 },
      { transform: 'translate3d(0, 0, 0)', opacity: 1 },
    ], opts);
    arrive.onfinish = () => {
      arrive.cancel(); // its end state is the resting state
      if (cell.children.length <= 1) cell.classList.remove('is-rolling');
    };
  }
  // Whole words, not letters: the mark first, the name a beat after, up when moving on along
  // the tape and down when going back.
  function rollTitle(s, dir) {
    if (reduceMotion || !titleEl.dataset.stop) {
      setTitle(s);
      return;
    }
    rollCell(iconCell, iconFace(s.data), dir || 1, 0);
    rollCell(nameCell, nameFace(s.data), dir || 1, 60);
    titleEl.dataset.stop = s.id;
  }
  const titleParts = () => [iconCell.lastElementChild || iconCell, nameCell.lastElementChild || nameCell];

  // While the title's parts are in flight (the tape has just set them going), the title rides
  // above the tape (careers.css .is-flying).
  let flyingCount = 0;
  function flying() {
    const anims = titleEl.getAnimations({ subtree: true });
    if (!anims.length) return;
    flyingCount++;
    main.classList.add('is-flying');
    const done = () => {
      flyingCount = Math.max(0, flyingCount - 1);
      if (!flyingCount) main.classList.remove('is-flying');
    };
    Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(done, done);
  }

  // ---------------------------------------------------------------- panels
  // One panel per team, made once and kept: its line, its role cards, the way on. The open
  // application has one panel of its own.
  const panels = new Map(); // key -> { el, lead, blurb, paused, list, cards: Map(id -> li), next }
  const cardRefs = new WeakMap();

  function pausedNote(cls) {
    const box = el('div', `cr-paused ${cls || ''}`.trim());
    box.setAttribute('role', 'status');
    box.append(icon('info', 18, 'cr-paused__icon'), el('p', 'cr-paused__text', 'Applications are paused for a short while. The roles are still open; please come back soon to apply.'));
    box.hidden = true;
    return box;
  }

  function buildNext() {
    const a = el('a', 'tl-next cr-next');
    a.dataset.arrive = '';
    a.append(el('span', 'tl-next__kicker'), el('span', 'cr-next__mark'), el('span', 'tl-next__year cr-next__name'), el('span', 'tl-next__title'));
    a.querySelector('.cr-next__mark').setAttribute('aria-hidden', 'true');
    return a;
  }

  function buildPanel(key) {
    const section = el('section', 'tl-panel cr-panel');
    section.id = `team-${key}`;
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', `tab-${key}`);
    section.hidden = true;
    const heading = el('h2', 'cr-panel__heading');
    const body = el('div', 'cr-panel__body');
    const lead = el('div', 'cr-panel__lead');
    lead.dataset.arrive = '';
    const blurb = el('p', 'cr-panel__blurb');
    const paused = pausedNote();
    lead.append(blurb, paused);
    const roles = el('ul', 'cr-roles');
    roles.setAttribute('role', 'list');
    body.append(lead, roles);
    const next = buildNext();
    section.append(heading, body, next);
    panelsEl.append(section);
    return { el: section, heading, lead, blurb, paused, list: roles, cards: new Map(), next };
  }

  function fact(name, text) {
    const li = el('li', 'cr-card__fact');
    li.append(icon(name, 15), el('span', '', text));
    return li;
  }

  function buildCard() {
    const li = el('li', 'cr-role');
    li.dataset.arrive = '';
    const card = el('article', 'cr-card');
    const eyebrow = el('p', 'cr-card__eyebrow');
    const team = el('span', 'cr-card__team');
    const tag = el('span', 'cr-card__tag', 'Featured');
    eyebrow.append(team, tag);
    const h = el('h3', 'cr-card__title');
    const link = el('a', 'cr-card__hit');
    link.setAttribute('aria-haspopup', 'dialog');
    h.append(link);
    const summary = el('p', 'cr-card__summary');
    const facts = el('ul', 'cr-card__facts');
    const go = icon('arrow', 18, 'cr-card__go');
    card.append(eyebrow, h, summary, facts, go);
    li.append(card);
    cardRefs.set(li, { eyebrow, team, tag, link, summary, facts });
    return li;
  }

  function fillCard(li, job) {
    const r = cardRefs.get(li);
    li.dataset.id = job.id;
    const teamName = clean(job.teamName);
    r.team.textContent = teamName;
    r.tag.hidden = !job.featured;
    r.eyebrow.hidden = !teamName && !job.featured;
    if (r.link.textContent !== job.title) r.link.textContent = job.title;
    r.link.href = `jobs/${job.slug}/`;
    r.link.dataset.id = job.id;
    r.link.dataset.slug = job.slug;
    const summary = clean(job.summary);
    r.summary.textContent = summary;
    r.summary.hidden = !summary;
    const facts = [];
    if (clean(job.location)) facts.push(fact('pin', clean(job.location)));
    if (EMPLOYMENT[job.employmentType]) facts.push(fact('briefcase', EMPLOYMENT[job.employmentType]));
    if (WORK_MODE[job.workMode]) facts.push(fact(job.workMode, WORK_MODE[job.workMode]));
    r.facts.replaceChildren(...facts);
    r.facts.hidden = !facts.length;
  }

  // Where the reader is: the first card (or the team's line) still showing below the pinned
  // tape, and how far down it sits, so a change above it can be taken back out of the scroll.
  // A line held in place beside the cards (sticky, from 960px) never moves, so it is no anchor.
  const barInner = main.querySelector('.tl-bar__inner');
  function anchorIn(p) {
    const readTop = Math.max(0, barInner.getBoundingClientRect().bottom);
    const lead = getComputedStyle(p.lead).position === 'sticky' ? null : p.lead;
    const items = [lead, ...p.cards.values(), p.next].filter((node) => node && !node.hidden);
    let partly = null;
    for (const node of items) {
      const r = node.getBoundingClientRect();
      if (!r.height || r.bottom <= readTop) continue;
      // The first thing wholly in view is what is being read; one cut off by the tape is
      // only the fallback.
      if (r.top >= readTop - 1) return { node, top: r.top };
      if (!partly) partly = { node, top: r.top };
    }
    return partly;
  }

  /**
   * The cards, brought up to date. On the open panel, cards that stay glide to their new
   * places, new ones rise in where they belong and closed ones fade where they stood (FLIP),
   * and the scroll is corrected so whatever is being read does not move. Anywhere else, and
   * under reduced motion, it simply changes.
   */
  function updateCards(p, jobs) {
    const live = p.el.classList.contains('is-active');
    const animate = live && !reduceMotion;
    const keep = new Set(jobs.map((j) => j.id));
    const first = new Map();
    let anchor = null;
    if (live) {
      for (const [id, li] of p.cards) first.set(id, li.getBoundingClientRect());
      anchor = anchorIn(p);
    }

    const ghosts = [];
    for (const [id, li] of [...p.cards]) {
      if (keep.has(id)) continue;
      p.cards.delete(id);
      li.remove();
      if (animate && first.get(id)) ghosts.push([li, first.get(id)]);
    }

    const fresh = [];
    let prev = null;
    for (const job of jobs) {
      let li = p.cards.get(job.id);
      if (!li) {
        li = buildCard();
        p.cards.set(job.id, li);
        fresh.push(li);
      }
      fillCard(li, job);
      const at = prev ? prev.nextElementSibling : p.list.firstElementChild;
      if (at !== li) p.list.insertBefore(li, at);
      prev = li;
    }
    // Already arrived: the panel is up, so a new card is placed as shown, not left waiting.
    if (live) for (const li of fresh) li.classList.add('is-in');

    // Hold the reader's place.
    if (anchor && anchor.node.isConnected) {
      const d = anchor.node.getBoundingClientRect().top - anchor.top;
      if (Math.abs(d) > 0.5) window.scrollBy(0, d);
    }
    if (!animate) return;

    // The leavers, laid back over the spot they left, fading.
    if (ghosts.length) {
      const lr = p.list.getBoundingClientRect();
      for (const [li, r] of ghosts) {
        li.classList.add('cr-role--ghost');
        li.setAttribute('aria-hidden', 'true');
        li.inert = true;
        li.style.cssText = `position:absolute;left:${(r.left - lr.left).toFixed(1)}px;top:${(r.top - lr.top).toFixed(1)}px;width:${r.width.toFixed(1)}px;height:${r.height.toFixed(1)}px;margin:0;pointer-events:none;`;
        p.list.append(li);
        const fade = li.animate([
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'scale(0.97)' },
        ], { duration: 320, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
        const done = () => li.remove();
        fade.finished.then(done, done);
      }
    }
    for (const [id, li] of p.cards) {
      const f = first.get(id);
      if (!f) continue;
      const l = li.getBoundingClientRect();
      const dx = f.left - l.left;
      const dy = f.top - l.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      li.animate([
        { transform: `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)` },
        { transform: 'none' },
      ], { duration: 560, easing: EASE_OUT });
    }
    for (const li of fresh) {
      li.animate([
        { opacity: 0, transform: 'translate3d(0, 12px, 0) scale(0.985)' },
        { opacity: 1, transform: 'none' },
      ], { duration: 620, delay: ghosts.length ? 160 : 60, easing: EASE_OUT, fill: 'backwards' });
    }
  }

  function fillTeamPanel(p, t, m) {
    p.heading.textContent = `${t.label}, ${rolesText(t.jobs.length)}`;
    p.blurb.textContent = t.blurb;
    p.blurb.hidden = !t.blurb;
    p.paused.hidden = !m.paused;
    p.el.classList.toggle('cr-panel--bare', !t.blurb && !m.paused);
    updateCards(p, t.jobs);
  }

  function fillNext(p, next) {
    p.next.hidden = !next;
    if (!next) return;
    p.next.href = `#${next.key}`;
    p.next.dataset.stop = next.key;
    const [kicker, mark, name, line] = p.next.children;
    if (next.kind === 'open') {
      kicker.textContent = 'Not sure where you fit?';
      line.textContent = 'Tell us what you do best';
    } else {
      kicker.textContent = 'Next team';
      line.textContent = rolesText(next.jobs.length);
    }
    mark.innerHTML = markOf(next, 36);
    name.textContent = next.label;
    p.next.setAttribute('aria-label', next.kind === 'open' ? 'Continue to the open application' : `Continue to ${next.label}, ${rolesText(next.jobs.length)}`);
  }

  // The open application: what it is, and the button that sends one.
  const openPanel = (() => {
    const section = el('section', 'tl-panel cr-panel cr-panel--open');
    section.id = `team-${OPEN_ID}`;
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', `tab-${OPEN_ID}`);
    section.hidden = true;
    const heading = el('h2', 'cr-panel__heading', 'Open application');
    const card = el('div', 'cr-open');
    card.dataset.arrive = '';
    const lead = el('p', 'cr-open__lead', 'No role that fits yet? Tell us what you do best and the teams you would like to work with.');
    const points = el('ol', 'cr-open__points');
    for (const line of [
      'Tell us about yourself, and the teams you would like to join.',
      'Share your resume and a few lines on why GridX.',
      'We keep open applications on file and write when something fits.',
    ]) points.append(el('li', '', line));
    const paused = pausedNote('cr-paused--open');
    paused.querySelector('.cr-paused__text').textContent = 'Applications are paused for a short while. Please come back soon.';
    const button = el('button', 'cr-pill', 'Send an open application');
    button.type = 'button';
    button.dataset.openApply = '';
    const mail = el('p', 'cr-open__mail');
    card.append(lead, points, paused, button, mail);
    section.append(heading, card);
    panelsEl.append(section);
    return { el: section, paused, button, mail };
  })();

  function mailLine(node, before, email, after = '') {
    const a = el('a', '', email);
    a.href = `mailto:${email}`;
    node.replaceChildren(document.createTextNode(before), a, document.createTextNode(after));
  }

  function fillOpenPanel(m) {
    openPanel.paused.hidden = !m.paused;
    setDisabled(openPanel.button, m.paused);
    mailLine(openPanel.mail, 'It takes about five minutes. Or write to us at ', m.email, '.');
  }

  function setDisabled(button, off) {
    if (off) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }

  // ---------------------------------------------------------------- the tape
  let tape = null;

  function stopsOf(m) {
    const specs = m.teams.map((t) => ({
      id: t.key,
      panel: panels.get(t.key).el,
      theme: rolesText(t.jobs.length),
      openable: true,
      data: t,
    }));
    if (m.openOk) specs.push({ id: OPEN_ID, panel: openPanel.el, theme: 'Tell us what you do best', openable: true, data: OPEN_STOP });
    return specs;
  }

  // The labels sit far enough apart that the one under the needle, at its full swell, never
  // touches its neighbours: measured pair by pair, with the journey's spacing as the least.
  function spacing(vw) {
    const base = vw < 760 ? 112 : Math.min(220, Math.max(150, vw * 0.15));
    const widths = [...labelsEl.querySelectorAll('.tl-stop:not([aria-hidden="true"])')].map((b) => b.offsetWidth);
    let need = 0;
    for (let i = 0; i + 1 < widths.length; i++) {
      const wide = Math.max(widths[i], widths[i + 1]);
      const narrow = Math.min(widths[i], widths[i + 1]);
      need = Math.max(need, (LENS / 2) * wide + 0.51 * narrow);
    }
    return Math.max(base, Math.ceil(need + 14));
  }

  function renderLabel(s, button) {
    const d = s.data;
    const mark = el('span', 'tl-stop__icon');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = markOf(d, 24);
    button.append(mark, el('span', 'tl-stop__name', d.label));
    button.dataset.stop = s.id;
    button.setAttribute('aria-label', d.kind === 'open' ? 'Open application' : `${d.label}, ${rolesText(d.jobs.length)}`);
  }
  const labelParts = (s, button) => [button.querySelector('.tl-stop__icon'), button.querySelector('.tl-stop__name')];

  const hairlinePx = () => parseFloat(getComputedStyle(main).getPropertyValue('--hairline')) || 58;

  function peekOf(s) {
    const d = s.data;
    if (d.kind === 'open') return { text: 'Not sure where you fit? Send an open application', label: 'Open the open application' };
    const titles = d.jobs.map((j) => j.title);
    const shown = titles.slice(0, 3);
    if (titles.length > 3) shown.push(`${titles.length - 3} more`);
    return { text: shown.join(' · '), label: `Open ${d.label}: ${rolesText(d.jobs.length)}` };
  }

  const anyDialogOpen = () => Boolean(document.querySelector('dialog[open]'));

  // Where the tape comes to rest on arrival when nothing is asked for: the team with the
  // featured role, else the first. A team the URL asks for (or the team of the role it
  // names) opens.
  let arriveAt = null;
  function restingStop(m) {
    const featured = m.teams.find((t) => t.jobs.some((j) => j.featured));
    return (featured || m.teams[0]).key;
  }

  function createTape(m) {
    main.classList.add('is-filming');
    tape = window.GridTape.create(main, {
      stops: stopsOf(m),
      label: {
        className: 'tl-stop',
        tabId: (s) => `tab-${s.id}`,
        controls: (s) => (s.panel ? s.panel.id : null),
        render: renderLabel,
        flipParts: labelParts,
        drop: 0, // the labels straddle the line, scaled about it: they stay centred on it
      },
      title: {
        el: titleEl,
        parts: titleParts,
        set: setTitle,
        roll: rollTitle,
        // Home again on the tape: each part where its piece of the label will be, centred
        // under the needle at the lens's full swell, scaled about the hairline.
        rest(s, i, { ir, width }) {
          const part = labelParts(s, s.el)[i] || s.el;
          const hair = hairlinePx();
          const cy = part.offsetTop + part.offsetHeight / 2;
          const cx = part.offsetLeft + part.offsetWidth / 2 - s.el.offsetWidth / 2;
          return { cx: ir.left + width / 2 + cx * LENS, cy: ir.top + hair + (cy - hair) * LENS, h: part.offsetHeight * LENS };
        },
      },
      peek: peekOf,
      arrivals: (s) => (s && s.panel ? [...s.panel.querySelectorAll('[data-arrive]')] : []),
      spacing,
      onLayout() {
        for (const f of nameCell.children) fit(f);
      },
      onOpened(s) {
        main.dataset.open = s.id;
        flying();
        // A team opened on arrival for a role's link has no hash yet: name it, in place, so
        // the address is the page as it stands once the sheet is closed.
        if (window.location.hash !== `#${s.id}`) {
          try {
            window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${s.id}`);
          } catch (_) { /* sandboxed */ }
        }
      },
      onClosed() {
        delete main.dataset.open;
        flying();
      },
      history: {
        key: 'careers',
        hash: (s) => `#${s.id}`,
        parse(hash) {
          if (!hash || hash.length < 2) return null;
          let key = '';
          try { key = decodeURIComponent(hash.slice(1)); } catch (_) { return null; }
          return KEY.test(key) ? key : null;
        },
      },
      hintKey: 'gridx-careers-hint',
      arrival(deep) {
        if (arriveAt && now.byKey.has(arriveAt)) return { id: arriveAt, open: true };
        if (arriveAt === OPEN_ID && now.openOk) return { id: OPEN_ID, open: true };
        if (deep) return { id: deep.id, open: true };
        return { id: restingStop(m), open: false };
      },
      // While a sheet is up the field gathers behind it (sheet.js); the tape takes the halo
      // back once that has let go. Nor does an empty page keep a halo on a tape it hides.
      handedOver: () => root.classList.contains('is-night') || root.classList.contains('lightbox-open')
        || anyDialogOpen() || Boolean(window.gridSheet && window.gridSheet.holdsField())
        || main.classList.contains('is-empty'),
      escapeBlocked: anyDialogOpen,
    });
  }

  // ---------------------------------------------------------------- the states
  function showNotice(kind, m) {
    noticeEl.replaceChildren();
    noticeEl.dataset.kind = kind;
    if (kind === 'empty') {
      noticeEl.append(el('p', 'cr-notice__text', m.openOk
        ? 'We are not hiring for a particular role at the moment, but we always like to hear from people who want to build with us. Send an open application and we will write when something fits.'
        : 'We are not hiring for a particular role at the moment. New roles appear here first, so do look in again.'));
      if (m.openOk) {
        const b = el('button', 'cr-pill', 'Send an open application');
        b.type = 'button';
        b.dataset.openApply = '';
        setDisabled(b, m.paused);
        noticeEl.append(b);
      }
      const mail = el('p', 'cr-notice__mail');
      mailLine(mail, m.openOk ? 'Or write to us at ' : 'You can also write to us at ', m.email, '.');
      noticeEl.append(mail);
    } else if (kind === 'failed') {
      noticeEl.append(
        el('p', 'cr-notice__title', 'We could not load the open roles.'),
        el('p', 'cr-notice__text', 'Please check your connection and try again.'),
      );
      const b = el('button', 'cr-ghost', 'Try again');
      b.type = 'button';
      b.dataset.retry = '';
      noticeEl.append(b);
      const mail = el('p', 'cr-notice__mail');
      mailLine(mail, 'Or write to us at ', FALLBACK_EMAIL, '.');
      noticeEl.append(mail);
    }
    noticeEl.hidden = false;
  }

  function hideNotice() {
    noticeEl.hidden = true;
    noticeEl.replaceChildren();
    delete noticeEl.dataset.kind;
  }

  function setIntro(st, m) {
    const empty = Boolean(st.data) && !m.teams.length;
    intro.kicker.textContent = empty ? 'Careers at GridX' : INTRO_KICKER;
    intro.title.textContent = empty ? 'No open roles right now.' : INTRO_TITLE;
    if (st.data && m.teams.length) {
      intro.count.textContent = `${rolesText(m.total)} ${m.teams.length === 1 ? 'in 1 team' : `across ${m.teams.length} teams`}`;
    } else {
      intro.count.textContent = '';
    }
    intro.count.hidden = Boolean(st.data) && !m.teams.length;
    // Quietly, under the count: paused applications, or a list that could not be refreshed.
    intro.status.replaceChildren();
    let say = '';
    if (st.data && m.paused) say = 'Applications are paused for a short while. Please come back soon to apply.';
    if (say) intro.status.append(document.createTextNode(say));
    if (st.data && st.error && !say) {
      intro.status.append(document.createTextNode('We could not check for newer roles just now. '));
      const b = el('button', 'cr-link', 'Try again');
      b.type = 'button';
      b.dataset.retry = '';
      intro.status.append(b);
    }
    intro.status.hidden = !intro.status.childNodes.length;
  }

  let placed = false;
  function placeEarly() {
    if (tape) return;
    window.GridTape.placeHorizon(main);
    placed = true;
  }

  // ---------------------------------------------------------------- one pass over the document
  function render(st) {
    const m = model(st.data);
    now = m;
    setIntro(st, m);
    main.classList.toggle('is-loading', !st.data && !st.error);
    main.classList.toggle('is-failed', !st.data && Boolean(st.error));

    if (!st.data) {
      if (st.error) showNotice('failed', m);
      else hideNotice();
      if (!tape) placeEarly();
      renderSheet();
      return;
    }

    const empty = !m.teams.length;
    const wasEmpty = main.classList.contains('is-empty');
    main.classList.toggle('is-empty', empty);
    if (empty) {
      showNotice('empty', m);
      if (tape) {
        if (tape.state.open != null) tape.requestClose();
        tape.syncHalo();
      } else {
        placeEarly();
      }
      renderSheet();
      return;
    }
    hideNotice();

    // Panels first, so every stop has its panel ready.
    for (const t of m.teams) {
      let p = panels.get(t.key);
      if (!p) {
        p = buildPanel(t.key);
        panels.set(t.key, p);
      }
      delete p.el.dataset.gone;
      fillTeamPanel(p, t, m);
    }
    const order = [...m.teams, ...(m.openOk ? [OPEN_STOP] : [])];
    m.teams.forEach((t, i) => fillNext(panels.get(t.key), order[i + 1] || null));
    fillOpenPanel(m);
    // A team with nothing open any more: its panel goes once the tape has let it go.
    for (const [key, p] of panels) {
      if (m.byKey.has(key) || p.el.dataset.gone) continue;
      p.el.dataset.gone = '1';
      const drop = () => {
        if (!p.el.dataset.gone) return;
        if (tape && (tape.state.open === key || tape.stopOf(key))) {
          window.setTimeout(drop, 400);
          return;
        }
        p.el.remove();
        panels.delete(key);
      };
      window.setTimeout(drop, 400);
    }

    if (!tape) {
      arriveAt = teamOfDeep();
      createTape(m);
    } else {
      tape.setStops(stopsOf(m));
      if (wasEmpty) {
        tape.layout();
        tape.syncHalo();
      }
      // The open team's own words, if Paddock changed them while it is open.
      const open = tape.state.open;
      const info = open != null ? m.byKey.get(open) : null;
      if (info) {
        const label = nameCell.lastElementChild;
        if (!label || label.textContent !== info.label) setTitle(tape.stopOf(open));
        if (themeEl.classList.contains('is-shown')) themeEl.textContent = rolesText(info.jobs.length);
      }
    }
    renderSheet();
  }

  // ---------------------------------------------------------------- a role, in its sheet
  const sheetEl = document.createElement('dialog');
  sheetEl.className = 'story story--role';
  sheetEl.id = 'role-sheet';
  sheetEl.setAttribute('aria-labelledby', 'rs-title');
  sheetEl.innerHTML = `
    <div class="story__grabber" aria-hidden="true"></div>
    <button class="story__close" type="button" aria-label="Close">${SVG(ICON.close, 18)}</button>
    <div class="story__scroll rs__scroll"><div class="rs__view" data-rs-view></div></div>
    <div class="apply__foot rs__foot" data-rs-foot>
      <div class="apply__bar">
        <button class="apply__secondary rs__secondary" type="button" data-rs-secondary></button>
        <button class="apply__primary rs__primary" type="button" data-rs-primary></button>
      </div>
      <p class="rs__hint" data-rs-hint role="status" aria-live="polite"></p>
    </div>`; // a constant: nothing interpolated but the close icon above
  document.body.append(sheetEl);
  const rs = {
    view: sheetEl.querySelector('[data-rs-view]'),
    scroll: sheetEl.querySelector('.rs__scroll'),
    foot: sheetEl.querySelector('[data-rs-foot]'),
    primary: sheetEl.querySelector('[data-rs-primary]'),
    secondary: sheetEl.querySelector('[data-rs-secondary]'),
    hint: sheetEl.querySelector('[data-rs-hint]'),
  };
  let shown = null;   // { ref, mode, sig, job } for the sheet as it is drawn
  let actions = { primary: null, secondary: null };
  let viewed = '';    // the role a role_view was last sent for, this opening
  let hintTimer = 0;

  const sheet = window.gridSheet && typeof window.gridSheet.create === 'function'
    ? window.gridSheet.create(sheetEl, {
      halo: { fill: 0.5 },
      onOpen() {
        root.classList.add('cr-sheet-open');
      },
      onClose() {
        root.classList.remove('cr-sheet-open');
        shown = null;
        viewed = '';
        rs.view.replaceChildren();
        setQuery({ role: null, job: null, apply: null });
      },
    })
    : null;

  /** The roles query in the address, changed in place: no new history entry, the tape's state kept. */
  function setQuery(changes) {
    try {
      const u = new URL(window.location.href);
      for (const [k, v] of Object.entries(changes)) {
        if (v == null) u.searchParams.delete(k);
        else u.searchParams.set(k, v);
      }
      const next = u.pathname + u.search + u.hash;
      if (next !== window.location.pathname + window.location.search + window.location.hash) {
        window.history.replaceState(window.history.state, '', next);
      }
    } catch (_) { /* sandboxed: the page still works */ }
  }

  /**
   * What a reference to a role comes to now: open (the role), closed or paused (a calm
   * notice), gone (no longer listed), or not known yet. Until Paddock itself has answered, a
   * role the build's copy does not have is waited for, never declared gone: it may be new.
   */
  function resolve(ref) {
    const st = careers.get();
    const key = ref.id || ref.slug;
    const job = key ? careers.findJob(key) : null;
    if (job) return { mode: 'role', job };
    const closed = key ? careers.findClosed(key) : null;
    if (!st.live) {
      if (!st.error) return { mode: 'loading' };
      return closed ? { mode: closed.state === 'paused' ? 'paused' : 'closed', closed } : { mode: 'failed' };
    }
    if (closed) return { mode: closed.state === 'paused' ? 'paused' : 'closed', closed };
    return { mode: 'gone' };
  }

  function sigOf(r, m) {
    const team = (key) => (m.byKey.get(key) || { jobs: [] }).jobs.map((j) => `${j.id}:${j.publicVersion || ''}:${j.updatedAt || ''}`).join(',');
    if (r.mode === 'role') return `role|${r.job.id}|${r.job.publicVersion || ''}|${r.job.updatedAt || ''}|${m.paused}|${m.openOk}`;
    if (r.mode === 'closed' || r.mode === 'paused') return `${r.mode}|${r.closed.id}|${team(r.closed.domain)}|${m.openOk}|${m.paused}|${m.email}`;
    if (r.mode === 'gone') return `gone|${m.teams.map((t) => team(t.key)).join(';')}|${m.openOk}|${m.paused}`;
    return r.mode;
  }

  function eyebrowFor(team, fallback) {
    const p = el('p', 'rs__eyebrow');
    if (team) {
      const mark = el('span', 'rs__mark');
      mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = markOf(team, 18);
      p.append(mark, el('span', '', team.label));
    } else {
      p.append(el('span', '', fallback || 'Careers at GridX'));
    }
    return p;
  }

  function section(title, inner) {
    if (!inner) return null;
    const s = el('section', 'role__section');
    s.append(el('h3', 'role__h2', title));
    for (const n of [].concat(inner)) s.append(n);
    return s;
  }
  const bullets = (items, cls = 'role__list') => {
    if (!items.length) return null;
    const ul = el('ul', cls);
    for (const i of items) ul.append(el('li', '', i));
    return ul;
  };

  function setFoot({ primary, secondary, hint = '' }) {
    rs.foot.hidden = !primary && !secondary;
    actions = { primary: primary ? primary.run : null, secondary: secondary ? secondary.run : null };
    rs.primary.hidden = !primary;
    if (primary) {
      rs.primary.replaceChildren(el('span', 'apply__label', primary.label));
      setDisabled(rs.primary, Boolean(primary.disabled));
    }
    rs.secondary.hidden = !secondary;
    if (secondary) {
      rs.secondary.replaceChildren();
      if (secondary.icon) rs.secondary.append(icon(secondary.icon, 18, 'rs__secondary-icon'));
      rs.secondary.append(el('span', 'rs__secondary-label', secondary.label));
      if (secondary.ariaLabel) rs.secondary.setAttribute('aria-label', secondary.ariaLabel);
      else rs.secondary.removeAttribute('aria-label');
    }
    window.clearTimeout(hintTimer);
    rs.hint.textContent = hint;
    rs.hint.hidden = !hint;
  }

  const roleUrl = (job) => `${window.location.origin}/jobs/${job.slug}/`;
  const canShare = () => coarse && typeof navigator.share === 'function';

  async function shareRole(job) {
    const url = roleUrl(job);
    if (canShare()) {
      try {
        await navigator.share({ title: `${job.title} at GridX`, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch (_) { ok = false; }
    rs.hint.hidden = false;
    rs.hint.textContent = ok ? 'Link copied. Paste it anywhere to share this role.' : `This role's own page: ${url}`;
    const label = rs.secondary.querySelector('.rs__secondary-label');
    if (ok && label) label.textContent = 'Copied';
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      if (label && label.isConnected) label.textContent = 'Copy link';
      rs.hint.textContent = '';
      rs.hint.hidden = true;
    }, 4000);
  }

  function applyFor(job) {
    if (!window.gridApply || now.paused) return;
    const fresh = careers.findJob(job.id) || job;
    window.gridApply.open({ job: fresh, source: { page: window.location.pathname }, returnTo: rs.primary });
  }

  function applyOpen(returnTo) {
    if (!window.gridApply || now.paused) return;
    window.gridApply.open({ open: true, source: { page: window.location.pathname }, returnTo: returnTo || document.activeElement });
  }

  /** The other open roles in a team (or anywhere), as rows that open in this same sheet. */
  function otherRoles(jobs, except) {
    const ul = el('ul', 'rs__others');
    for (const job of jobs.filter((j) => j.id !== except).slice(0, 6)) {
      const li = el('li');
      const b = el('button', 'rs__other');
      b.type = 'button';
      b.dataset.id = job.id;
      const facts = [clean(job.location), EMPLOYMENT[job.employmentType], WORK_MODE[job.workMode]].filter(Boolean).join(' · ');
      b.append(el('span', 'rs__other-title', job.title), el('span', 'rs__other-facts', facts), icon('arrow', 16, 'rs__other-go'));
      li.append(b);
      ul.append(li);
    }
    return ul.children.length ? ul : null;
  }

  function drawRole(job, m) {
    const team = m.byKey.get(job.domain) || null;
    const v = rs.view;
    v.append(eyebrowFor(team));
    const h = el('h2', 'rs__title', job.title);
    h.id = 'rs-title';
    h.tabIndex = -1;
    v.append(h);
    if (clean(job.summary)) v.append(el('p', 'rs__summary', clean(job.summary)));

    const facts = el('ul', 'role__facts rs__facts');
    facts.setAttribute('aria-label', 'About this role');
    const add = (name, text) => {
      const li = el('li', 'role__fact');
      li.append(icon(name, 16), el('span', '', text));
      facts.append(li);
    };
    if (clean(job.location)) add('pin', clean(job.location));
    if (EMPLOYMENT[job.employmentType]) add('briefcase', EMPLOYMENT[job.employmentType]);
    if (WORK_MODE[job.workMode]) add(job.workMode, WORK_MODE[job.workMode]);
    const exp = formatExperience(job.experience);
    if (exp) add('experience', exp);
    if (clean(job.teamName)) add('team', `${clean(job.teamName)} team`);
    const pay = formatPay(job.compensation);
    if (pay) add('pay', pay);
    if (facts.children.length) v.append(facts);

    if (m.paused) {
      const n = el('div', 'rs__notice');
      n.setAttribute('role', 'status');
      n.append(el('p', 'rs__notice-title', 'Applications are paused for a short while.'), el('p', 'rs__notice-text', 'This role is still open. Please come back soon to apply.'));
      v.append(n);
    }

    const about = [...paragraphs(job.description), ...paragraphs(job.aboutTeamAndRole)];
    const body = el('div', 'rs__body');
    for (const s of [
      section('About the team and the role', about.length ? about : null),
      section('What you will do', bullets(list(job.responsibilities))),
      section('Experience and qualifications', bullets(list(job.experienceAndQualifications))),
      section('Must-have skills', bullets(list(job.mustHaveCompetencies), 'role__skills')),
      section('Nice to have', bullets(list(job.niceToHave))),
    ]) if (s) body.append(s);
    if (body.children.length) v.append(body);

    const meta = el('ul', 'role__meta rs__meta');
    const metaItem = (k, val) => {
      const li = el('li');
      li.append(el('span', '', k), document.createTextNode(` ${val}`));
      meta.append(li);
    };
    if (job.openings > 1) metaItem('Openings', String(job.openings));
    if (formatDate(job.publishedAt)) metaItem('Posted', formatDate(job.publishedAt));
    if (formatDate(job.closesAt)) metaItem('Applications close', formatDate(job.closesAt));
    if (meta.children.length) v.append(meta);

    const resumeNote = job.resumeRequired === false ? 'A resume helps, but is not required.' : 'Have your resume ready, as a PDF or a Word file.';
    v.append(el('p', 'rs__note', `It takes about five minutes. ${resumeNote}`));

    const share = canShare();
    setFoot({
      primary: { label: 'Apply for this role', disabled: m.paused, run: () => applyFor(job) },
      secondary: { label: share ? 'Share' : 'Copy link', icon: share ? 'share' : 'link', ariaLabel: share ? 'Share this role' : 'Copy the link to this role', run: () => shareRole(job) },
    });
  }

  function drawClosed(r, m) {
    const c = r.closed || {};
    const team = c.domain ? m.byKey.get(c.domain) || null : null;
    const v = rs.view;
    v.append(eyebrowFor(team));
    const title = r.mode === 'paused' ? 'This role is paused for now.' : r.mode === 'closed' ? 'This role has closed.' : 'This role is no longer listed.';
    const h = el('h2', 'rs__title', title);
    h.id = 'rs-title';
    h.tabIndex = -1;
    v.append(h);
    const lede = el('p', 'rs__summary');
    if (r.mode === 'gone') {
      lede.textContent = 'It may have closed a while ago, or the link may be incomplete.';
    } else {
      lede.append(el('strong', '', c.title || 'This role'));
      lede.append(document.createTextNode(r.mode === 'paused'
        ? ' is not taking applications at the moment. Thank you for your interest.'
        : ' is no longer taking applications. Thank you for your interest.'));
    }
    v.append(lede);

    const pool = team ? team.jobs : m.teams.flatMap((t) => t.jobs);
    const rows = otherRoles(pool, c.id);
    if (rows) {
      v.append(el('h3', 'rs__sub', team ? `Still open in ${team.label}` : 'Open now'));
      v.append(rows);
    }
    const tail = el('p', 'rs__note');
    if (m.openOk && !m.paused) tail.textContent = 'Or send an open application, and we will write when something fits.';
    else mailLine(tail, 'You can still write to us at ', m.email, '.');
    v.append(tail);

    const toTeam = team ? { label: `All ${team.label} roles`, run: () => closeSheetTo(team.key) } : { label: 'See open roles', run: () => closeSheetTo(null) };
    if (m.openOk) {
      setFoot({ primary: { label: 'Send an open application', disabled: m.paused, run: () => applyOpen(rs.primary) }, secondary: toTeam });
    } else {
      setFoot({ primary: toTeam });
    }
  }

  function drawLoading() {
    const v = rs.view;
    v.append(eyebrowFor(null));
    const h = el('h2', 'rs__title', 'Finding this role');
    h.id = 'rs-title';
    h.tabIndex = -1;
    v.append(h);
    const skel = el('div', 'rs__skel');
    skel.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) skel.append(el('span'));
    v.append(skel);
    setFoot({});
  }

  function drawFailed() {
    const v = rs.view;
    v.append(eyebrowFor(null));
    const h = el('h2', 'rs__title', 'We could not load this role.');
    h.id = 'rs-title';
    h.tabIndex = -1;
    v.append(h);
    v.append(el('p', 'rs__summary', 'Please check your connection and try again.'));
    setFoot({ primary: { label: 'Try again', run: () => careers.refresh() }, secondary: { label: 'See open roles', run: () => closeSheetTo(null) } });
  }

  /** The sheet, drawn for what its role has come to; untouched when nothing it shows changed. */
  function renderSheet(force) {
    if (!shown) return;
    const m = now;
    const r = resolve(shown.ref);
    const sig = sigOf(r, m);
    if (!force && sig === shown.sig) return;
    const keepScroll = shown.mode === r.mode && r.mode === 'role' ? rs.scroll.scrollTop : 0;
    shown.sig = sig;
    shown.mode = r.mode;
    shown.job = r.job || null;
    rs.view.replaceChildren();
    rs.view.dataset.mode = r.mode;
    sheetEl.dataset.mode = r.mode;
    if (r.mode === 'role') drawRole(r.job, m);
    else if (r.mode === 'loading') drawLoading();
    else if (r.mode === 'failed') drawFailed();
    else drawClosed(r, m);
    rs.scroll.scrollTop = keepScroll;
    // The sheet's own entrance, once per change of what it shows.
    if (!reduceMotion && sheetEl.open) rs.view.animate([{ opacity: 0, transform: 'translate3d(0, 8px, 0)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE_OUT });

    if (r.mode === 'role') {
      setQuery({ role: r.job.slug, job: null });
      if (viewed !== r.job.slug) {
        viewed = r.job.slug;
        track('role_view', { slug: r.job.slug });
      }
      bringTeam(r.job.domain);
    } else if ((r.mode === 'closed' || r.mode === 'paused') && r.closed.domain && m.byKey.has(r.closed.domain)) {
      bringTeam(r.closed.domain);
    }
  }

  // The team a role belongs to opens behind its sheet, so closing the sheet lands among its
  // neighbours. Only from the overview: an open team is never switched out from under a reader.
  function bringTeam(key) {
    if (!tape || tape.state.open != null || !now.byKey.has(key)) return;
    if (main.classList.contains('is-filming') && arriveAt === key) return; // the film is on its way there
    tape.open(key, { history: 'replace' });
  }

  function closeSheetTo(key) {
    if (sheet) sheet.close();
    if (!tape || !key || !now.byKey.has(key)) return;
    if (tape.state.open == null) tape.open(key, { history: 'replace' });
    else if (tape.state.open !== key) tape.switchTo(key);
  }

  /**
   * Opens a role's sheet. ref: { id } or { slug } (a previous slug works too). Swaps in place
   * when the sheet is already up.
   */
  function openRole(ref, returnTo) {
    if (!sheet) return false;
    shown = { ref, mode: '', sig: '', job: null };
    renderSheet(true);
    if (!sheetEl.open) {
      sheet.open(returnTo || document.activeElement);
      rs.scroll.scrollTop = 0;
    }
    return true;
  }

  rs.primary.addEventListener('click', () => {
    if (rs.primary.getAttribute('aria-disabled') === 'true') return;
    if (actions.primary) actions.primary();
  });
  rs.secondary.addEventListener('click', () => {
    if (actions.secondary) actions.secondary();
  });
  rs.view.addEventListener('click', (e) => {
    const other = e.target.closest('.rs__other');
    if (!other) return;
    shown = { ref: { id: other.dataset.id }, mode: '', sig: '', job: null };
    renderSheet(true);
    rs.scroll.scrollTop = 0;
    const h = rs.view.querySelector('.rs__title');
    if (h) h.focus({ preventScroll: true });
  });

  // ---------------------------------------------------------------- the page's own clicks
  main.addEventListener('click', (e) => {
    const next = e.target.closest('.tl-next');
    if (next && tape) {
      e.preventDefault();
      if (tape.state.open == null) tape.open(next.dataset.stop);
      else tape.switchTo(next.dataset.stop);
      return;
    }
    const hit = e.target.closest('.cr-card__hit');
    if (hit) {
      // A modified click is the reader's: the role's own page, in a new tab or window.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0) return;
      if (openRole({ id: hit.dataset.id }, hit)) e.preventDefault();
      return;
    }
    const apply = e.target.closest('[data-open-apply]');
    if (apply) {
      if (apply.getAttribute('aria-disabled') === 'true') return;
      applyOpen(apply);
      return;
    }
    if (e.target.closest('[data-retry]')) {
      const b = e.target.closest('[data-retry]');
      b.setAttribute('aria-disabled', 'true');
      b.textContent = 'Trying again';
      careers.refresh().then(() => {
        if (b.isConnected) {
          b.removeAttribute('aria-disabled');
          b.textContent = 'Try again';
        }
      });
    }
  });

  // The field: whichever sheet let go of it, the next one up (or the tape) takes it back.
  document.addEventListener('gridx:sheet-field', (e) => {
    if (e.detail && e.detail.held) return;
    const applyEl = document.getElementById('apply-sheet');
    if (sheetEl.open && !(applyEl && applyEl.open)) {
      // The application closed over this sheet: wake this sheet's own gather (sheet.js
      // listens for its transitions to re-aim the field).
      sheetEl.dispatchEvent(new Event('transitionend'));
      return;
    }
    if (!anyDialogOpen() && tape) tape.syncHalo();
  });

  // Before there is a tape, the stand-ins follow the horizon the tape will lie on.
  window.addEventListener('resize', () => {
    if (!tape && placed) window.GridTape.placeHorizon(main);
  });

  // ---------------------------------------------------------------- deep links
  // ?role=<slug> (also a previous slug), ?job=<id> (the old site), ?apply=open.
  const params = new URLSearchParams(window.location.search);
  let deep = null;
  const roleParam = (params.get('role') || '').trim().toLowerCase();
  const jobParam = (params.get('job') || '').trim();
  if (params.has('role')) {
    deep = { kind: 'role', ref: { slug: roleParam.length >= 3 && roleParam.length <= 48 && SLUG.test(roleParam) ? roleParam : `~${roleParam.slice(0, 48)}` } };
  } else if (params.has('job')) {
    deep = { kind: 'role', ref: { id: /^[A-Za-z0-9_-]{1,80}$/.test(jobParam) ? jobParam : `~${jobParam.slice(0, 80)}` } };
  } else if (params.get('apply') === 'open') {
    deep = { kind: 'apply' };
  }

  function teamOfDeep() {
    if (!deep) return null;
    if (deep.kind === 'apply') return OPEN_ID;
    const key = deep.ref.id || deep.ref.slug;
    const job = careers.findJob(key);
    if (job) return job.domain;
    const closed = careers.findClosed(key);
    return closed && now.byKey.has(closed.domain) ? closed.domain : null;
  }

  let deepDone = false;
  function runDeep() {
    if (deepDone || !deep) return;
    deepDone = true;
    if (deep.kind === 'role') {
      openRole(deep.ref, null);
    } else if (deep.kind === 'apply') {
      setQuery({ apply: null });
      if (window.gridApply) window.gridApply.open({ open: true, source: { page: window.location.pathname } });
    }
  }

  // ---------------------------------------------------------------- start
  track('careers_view');

  const stateKey = (st) => `${st.version}|${st.source}|${st.error ? 1 : 0}|${st.data ? 1 : 0}`;
  const first = careers.get();
  let lastKey = stateKey(first);
  now = model(first.data);
  render(first);
  if (first.data || deep) runDeep();

  careers.subscribe((st) => {
    const key = stateKey(st);
    if (key === lastKey) return; // subscribe() answers at once with what render() just drew
    lastKey = key;
    render(st);
    if (!deepDone && deep) runDeep();
  });

  // For the checks and anyone curious: the page's own view of things.
  window.gridCareersPage = {
    get tape() { return tape; },
    openRole: (ref) => openRole(typeof ref === 'string' ? { slug: ref } : ref, null),
    model: () => now,
  };
})();
