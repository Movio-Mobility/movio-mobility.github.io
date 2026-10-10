/*
 * A role page: Apply, the docked Apply on phones, and the word if the role has closed.
 *
 * The page was built from Paddock's careers document at deploy time, and a role can close
 * (or pause) at any moment after that. careers-data.js asks Paddock again as soon as the page
 * loads and keeps asking while it is open; the moment Paddock no longer lists this role as
 * open, the Apply card gives way to a note saying so, with an open application offered in
 * its place when those are being taken. Until Paddock has actually answered, the page is
 * taken at its word: a snapshot is never what decides that a role has gone.
 *
 * Apply opens the shared sheet (apply-sheet.js) with the freshest copy of the role the page
 * holds. A link ending #apply opens it on arrival.
 *
 * Nothing here runs per frame: an IntersectionObserver says when the card's own button has
 * scrolled away (which is when the dock appears), and the rest is events.
 */
(() => {
  'use strict';

  const main = document.querySelector('main.role');
  if (!main) return;

  const jobId = main.dataset.jobId;
  const slug = main.dataset.slug;
  const status = main.querySelector('[data-role-status]');
  const dock = main.querySelector('[data-role-dock]');
  const inlineCta = main.querySelector('.role__apply [data-role-apply]');
  const back = main.querySelector('.role__back');
  const careers = window.gridCareers;

  const track = (name, props) => {
    try { if (typeof window.gridTrack === 'function') window.gridTrack(name, props); } catch (_) { /* never in the way */ }
  };
  track('role_view', { slug });

  /** The role as the page knows it now: Paddock's latest copy, else the one built in. */
  function job() {
    if (!careers) return null;
    return careers.findJob(jobId) || careers.findJob(slug);
  }

  function apply(returnTo) {
    if (!window.gridApply) return;
    const j = job();
    if (j) window.gridApply.open({ job: j, source: { page: location.pathname }, returnTo });
  }

  for (const b of main.querySelectorAll('[data-role-apply]')) {
    b.addEventListener('click', () => apply(b));
  }

  // ---------------------------------------------------------------- closed since the build
  let shownState = '';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function renderStatus(state) {
    const s = careers.roleState(jobId);
    const data = state.data || {};
    const paused = Boolean(data.applicationsPaused) && s === 'open';
    const key = paused ? 'all_paused' : s;
    if (key === shownState) return;
    shownState = key;

    const closed = s === 'closed' || s === 'paused' || s === 'gone';
    main.classList.toggle('is-closed', closed || paused);
    if (!closed && !paused) {
      status.hidden = true;
      status.textContent = '';
      return;
    }

    const openOk = Boolean(data.openApplication && data.openApplication.enabled);
    const email = 'info@gridxenergy.in';
    let title;
    let text;
    if (paused) {
      title = 'Applications are paused for a short while.';
      text = 'This role is still open. Please come back soon to apply.';
    } else if (s === 'paused') {
      title = 'This role is paused for now.';
      text = openOk
        ? 'It is not taking applications at the moment. You can still send an open application, and we will keep you in mind.'
        : `It is not taking applications at the moment. You can still send your resume over to ${email}.`;
    } else {
      title = 'This role has closed.';
      text = openOk
        ? 'Thank you for your interest. You can still send an open application, and we will write when something fits.'
        : `Thank you for your interest. You can still send your resume over to ${email}.`;
    }

    status.textContent = '';
    status.append(el('p', 'role__status-title', title), el('p', 'role__status-text', text));
    const actions = el('div', 'role__status-actions');
    if (openOk && !paused) {
      const b = el('button', 'role__cta', 'Send an open application');
      b.type = 'button';
      b.dataset.apply = 'open'; // apply-sheet.js opens the sheet for anything carrying this
      actions.append(b);
    }
    const all = el('a', 'role__ghost', 'See open roles');
    all.href = back ? back.href : '../../careers.html';
    actions.append(all);
    status.append(actions);
    status.hidden = false;
    if (dock) setDock(false);
  }

  if (careers && status) careers.subscribe(renderStatus);

  // ---------------------------------------------------------------- the dock
  function setDock(on) {
    if (!dock) return;
    const show = on && !main.classList.contains('is-closed');
    dock.classList.toggle('is-shown', show);
    dock.inert = !show;
  }

  if (dock && inlineCta && 'IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      // Shown once the card's button has gone off the top; not while it is still below.
      for (const e of entries) setDock(!e.isIntersecting && e.boundingClientRect.top < 0);
    }).observe(inlineCta);
  }

  // ---------------------------------------------------------------- #apply
  if (location.hash === '#apply') {
    const go = () => apply(inlineCta);
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go, { once: true });
  }
})();
