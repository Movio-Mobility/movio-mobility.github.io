/*
 * Journey: the years, on the timeline tape.
 *
 * The tape itself (the film, dragging and flinging, the FLIP into the title, pinning, the peek
 * and the hint, the halo, history) is assets/tape.js, shared with careers. This file is the
 * story it runs over:
 *
 *   The years      One stop per year with a story, from the first to the reader's current
 *                  year, which always ends with who we are, the founders and our backers.
 *   The title      The big year over an open panel. Switching years rolls its digits like an
 *                  odometer while the tape glides over.
 *   The review     The current year opens with its photos as one drifting rectangle, its own
 *                  chapters folded away beneath until it is opened.
 *   Photos         Strips that a mouse can drag, arrows either side, and a lightbox.
 *   Founders       Hovering one, focusing one or pressing one brings the halo to their card.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const journey = document.querySelector('.journey');
  if (!journey || !window.GridTape) return;
  // The page arrives mid-film: say so before anything below reads a computed style.
  journey.classList.add('is-filming');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const title = journey.querySelector('.tl-title');
  const digits = journey.querySelector('.tl-title__digits');

  // The site's damped spring (site.css), so the title lands the way the island settles.
  const SPRING = getComputedStyle(root).getPropertyValue('--spring').trim() || 'cubic-bezier(0.32, 0.72, 0, 1)';

  // ---------------------------------------------------------------- the years
  // Every year with a story is an ordinary panel. The tape runs from the first of them to the
  // reader's current year, one stop each, and the current year always ends with who we are,
  // the founders and our backers: the yearless .tl-today block, moved in here. If the current
  // year already has chapters of its own, it opens with "This year in review" over its photos.
  //
  // So it all moves on by itself. Next January the year just gone becomes an ordinary year
  // with a "Continue to" at its end, and the new one starts as an empty panel holding the three
  // parts, until its first chapters are written.
  const panelsEl = journey.querySelector('.tl-panels');
  const todayBlock = journey.querySelector('.tl-today');
  const panels = [...journey.querySelectorAll('.tl-panel[data-year]')];
  const NOW = Math.max(new Date().getFullYear(), ...panels.map((p) => Number(p.dataset.year)));

  let current = panels.find((p) => Number(p.dataset.year) === NOW);
  if (!current) {
    current = document.createElement('section');
    current.className = 'tl-panel';
    current.id = String(NOW);
    current.dataset.year = String(NOW);
    current.setAttribute('role', 'tabpanel');
    current.setAttribute('aria-labelledby', `tab-${NOW}`);
    const heading = document.createElement('h2');
    heading.className = 'tl-panel__year';
    heading.innerHTML = `<span>${NOW}</span> <span class="tl-panel__theme"></span>`;
    current.append(heading);
    panelsEl.insertBefore(current, todayBlock || null);
    panels.push(current);
  }
  panels.sort((a, b) => Number(a.dataset.year) - Number(b.dataset.year));

  // This year's own chapters, then the review over their photos, then the three parts.
  const ownTitles = [...current.querySelectorAll('.chapter__title')].map((t) => t.textContent.trim());
  const reviewPhotos = [...current.querySelectorAll('.frame img')];
  if (reviewPhotos.length) {
    // The year's own chapters fold away under the review until it is opened.
    const heading = current.querySelector('.tl-panel__year');
    const review = buildReview(reviewPhotos, NOW);
    const fold = document.createElement('div');
    fold.className = 'review-fold';
    fold.id = `year-${NOW}-stories`;
    const foldInner = document.createElement('div');
    foldInner.className = 'review-fold__inner';
    for (const chapter of current.querySelectorAll(':scope > .chapter')) foldInner.append(chapter);
    fold.append(foldInner);
    current.insertBefore(review, heading ? heading.nextSibling : current.firstChild);
    review.after(fold);
    wireReview(review, fold);
  }
  // Who we are closes the current year. The founders, our backers and the way on stay out of
  // the panels, in .tl-always after them: on the page whenever the timeline is collapsed, and
  // after the current year's chapters when it is open. Only an older year hides them, so it
  // still ends on its "Continue to".
  const always = document.createElement('div');
  always.className = 'tl-always';
  if (todayBlock) {
    const heading = todayBlock.querySelector('.tl-today__heading');
    if (heading) heading.remove();
    for (const part of todayBlock.querySelectorAll(':scope > .chapter--team, :scope > .chapter--backers, :scope > .tl-end')) {
      always.append(part);
    }
    while (todayBlock.firstChild) current.append(todayBlock.firstChild);
    todayBlock.remove();
  }
  panelsEl.append(always);
  const alwaysParts = [...always.children];
  current.dataset.theme = 'Today';
  const currentTheme = current.querySelector('.tl-panel__theme');
  if (currentTheme) currentTheme.textContent = 'Today';
  current.dataset.peek = [...ownTitles, 'Who we are', 'Founders', 'Backers'].join(' · ');

  // Every year but the current one ends with the way on to the next.
  panels.forEach((panel, i) => {
    const next = panels[i + 1];
    let link = panel.querySelector(':scope > .tl-next');
    if (!next) {
      if (link) link.remove();
      return;
    }
    if (!link) {
      link = document.createElement('a');
      link.className = 'tl-next';
      link.innerHTML = '<span class="tl-next__kicker">Continue to</span> <span class="tl-next__year"></span> <span class="tl-next__title"></span>';
      panel.append(link);
    }
    const year = next.dataset.year;
    const first = next.querySelector('.chapter__title');
    link.href = `#${year}`;
    link.dataset.year = year;
    link.querySelector('.tl-next__year').textContent = year;
    link.querySelector('.tl-next__title').textContent = next === current && reviewPhotos.length
      ? 'This year in review'
      : (first ? first.textContent.trim() : '');
  });

  // The tape runs over these, one stop per year, in order (see the end of this file).
  const FIRST = Number(panels[0].dataset.year);
  const LAST = Number(panels[panels.length - 1].dataset.year);

  // ---------------------------------------------------------------- the title
  function face(ch) {
    const span = document.createElement('span');
    span.textContent = ch;
    return span;
  }

  function setTitle(year) {
    digits.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    digits.textContent = '';
    for (const ch of String(year)) {
      const cell = document.createElement('span');
      cell.className = 'tl-digit';
      cell.append(face(ch));
      digits.append(cell);
    }
    digits.dataset.year = String(year);
  }

  // An odometer: only the digits that change roll, rightmost first, up when going forward in
  // time and down when going back.
  function rollTitle(year, dir) {
    const from = digits.dataset.year || '';
    const to = String(year);
    if (reduceMotion || from.length !== to.length) {
      setTitle(year);
      if (!reduceMotion) digits.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease' });
      return;
    }
    const cells = [...digits.children];
    let k = 0;
    for (let i = to.length - 1; i >= 0; i--) {
      const cell = cells[i];
      cell.getAnimations({ subtree: true }).forEach((a) => a.cancel());
      while (cell.children.length > 1) cell.firstElementChild.remove();
      const old = cell.lastElementChild;
      if (old.textContent === to[i]) continue;
      const next = face(to[i]);
      cell.append(next);
      const opts = { duration: 680, delay: k++ * 60, easing: SPRING, fill: 'both' };
      old.animate([
        { transform: 'translate3d(0, 0, 0)', opacity: 1 },
        { transform: `translate3d(0, ${-dir * 105}%, 0)`, opacity: 0 },
      ], opts).onfinish = () => old.remove();
      const arrive = next.animate([
        { transform: `translate3d(0, ${dir * 105}%, 0)`, opacity: 0 },
        { transform: 'translate3d(0, 0, 0)', opacity: 1 },
      ], opts);
      arrive.onfinish = () => arrive.cancel(); // its end state is the resting state
    }
    digits.dataset.year = to;
  }

  // ---------------------------------------------------------------- this year in review
  // The current year opens with its photos as one rectangle of randomly sized tiles, drifting
  // sideways for ever under the words "This year in review". Built fresh on every visit.
  //
  // Each page is the rectangle's width and is cut by guillotine splits (always split the largest
  // tile, across its longer side, somewhere between 38% and 62%), so the tiles vary in size but
  // always fill the rectangle exactly. Photos go to the tiles whose shape suits them best. The
  // pages are laid out twice in a row, and the track slides left by exactly one copy before it
  // starts over, so the loop never shows a seam.
  function buildReview(imgs, year) {
    const review = document.createElement('div');
    review.className = 'review';
    const win = document.createElement('div');
    win.className = 'review__window';
    win.setAttribute('aria-hidden', 'true'); // the same photos follow, with their captions
    const track = document.createElement('div');
    track.className = 'review__track';
    win.append(track);
    const title = document.createElement('div');
    title.className = 'review__title';
    title.innerHTML = `<p class="review__kicker">${year}</p>`
      + '<h3 class="review__heading"><span>This year</span> <span>in review</span></h3>'
      + '<p class="review__cta"><span class="review__cta-text">See it unfold</span>'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></p>';
    // The whole rectangle is the button: it opens the year's stories beneath it.
    const toggle = document.createElement('button');
    toggle.className = 'review__toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', `Show ${year}'s stories`);
    review.append(win, title, toggle);
    review.photos = imgs.map((img) => ({
      src: img.getAttribute('src'),
      aspect: (Number(img.getAttribute('width')) || 4) / (Number(img.getAttribute('height')) || 3),
    }));
    return review;
  }

  // Opening unfolds the stories (a grid row easing from 0fr to 1fr, so it slides to their real
  // height) and they rise in as they come into view. Clipped while it moves, so nothing spills;
  // let go once it has settled, so the photo strips can run edge to edge again.
  function wireReview(review, fold) {
    const toggle = review.querySelector('.review__toggle');
    const text = review.querySelector('.review__cta-text');
    const year = current.dataset.year;
    toggle.setAttribute('aria-controls', fold.id);
    let settle = 0;
    toggle.addEventListener('click', () => {
      const open = !review.classList.contains('is-open');
      window.clearTimeout(settle);
      review.classList.toggle('is-open', open);
      fold.classList.toggle('is-open', open);
      fold.classList.remove('is-settled');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} ${year}'s stories`);
      text.textContent = open ? 'Fold it away' : 'See it unfold';
      if (open) {
        settle = window.setTimeout(() => {
          fold.classList.add('is-settled');
          updateStrips();
        }, reduceMotion ? 0 : 760);
      }
    });
  }

  function partition(count, aspect) {
    const tiles = [{ x: 0, y: 0, w: 1, h: 1 }];
    while (tiles.length < count) {
      let k = 0;
      for (let i = 1; i < tiles.length; i++) if (tiles[i].w * tiles[i].h > tiles[k].w * tiles[k].h) k = i;
      const t = tiles.splice(k, 1)[0];
      const at = 0.38 + Math.random() * 0.24;
      if (t.w * aspect >= t.h) {
        tiles.push({ x: t.x, y: t.y, w: t.w * at, h: t.h }, { x: t.x + t.w * at, y: t.y, w: t.w * (1 - at), h: t.h });
      } else {
        tiles.push({ x: t.x, y: t.y, w: t.w, h: t.h * at }, { x: t.x, y: t.y + t.h * at, w: t.w, h: t.h * (1 - at) });
      }
    }
    return tiles;
  }

  let reviewAspect = 0;
  function layoutReview() {
    const review = current.querySelector('.review');
    if (!review) return;
    const win = review.querySelector('.review__window');
    const W = win.clientWidth;
    const H = win.clientHeight;
    if (!W || !H) return; // its year is not on screen yet: done when it opens
    review.style.setProperty('--page-w', `${W}px`);
    const aspect = W / H;
    if (reviewAspect && Math.abs(aspect / reviewAspect - 1) < 0.25) return;
    reviewAspect = aspect;

    const photos = review.photos.slice();
    for (let i = photos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [photos[i], photos[j]] = [photos[j], photos[i]];
    }
    const pageCount = Math.max(1, Math.round(photos.length / 5));
    const pages = [];
    for (let p = 0; p < pageCount; p++) {
      const share = photos.slice(Math.floor((p * photos.length) / pageCount), Math.floor(((p + 1) * photos.length) / pageCount));
      const tiles = partition(share.length, aspect);
      // Widest photos to the widest tiles, tallest to the tallest.
      const byShape = (list, f) => list.slice().sort((a, b) => f(a) - f(b));
      const tilesSorted = byShape(tiles, (t) => (t.w * aspect) / t.h);
      const photosSorted = byShape(share, (ph) => ph.aspect);
      const page = document.createElement('div');
      page.className = 'review__page';
      tilesSorted.forEach((t, i) => {
        const tile = document.createElement('div');
        tile.className = 'review__tile';
        tile.style.cssText = `left:${(t.x * 100).toFixed(3)}%;top:${(t.y * 100).toFixed(3)}%;width:${(t.w * 100).toFixed(3)}%;height:${(t.h * 100).toFixed(3)}%`;
        const img = document.createElement('img');
        // Lazy: the review is built when its year opens, which on arrival is usually below the
        // fold, and its 26 photos (twice, for the loop) need not compete with the page above.
        img.loading = 'lazy';
        img.src = photosSorted[i].src;
        img.alt = '';
        img.decoding = 'async';
        tile.append(img);
        page.append(tile);
      });
      pages.push(page);
    }
    const track = review.querySelector('.review__track');
    track.textContent = '';
    for (const page of pages) track.append(page);
    for (const page of pages) track.append(page.cloneNode(true));
    review.style.setProperty('--review-dur', `${pages.length * 28}s`);

    // Drift only while it can be seen.
    if (!review.watched && 'IntersectionObserver' in window) {
      review.watched = true;
      new IntersectionObserver(([entry]) => {
        review.classList.toggle('is-paused', !entry.isIntersecting);
      }).observe(review);
    }
  }

  // ---------------------------------------------------------------- photos
  let swallowStripClick = false;

  for (const strip of journey.querySelectorAll('.strip')) {
    // A mouse can drag a strip the way a finger swipes it.
    let s = null;
    strip.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      s = { id: e.pointerId, x: e.clientX, left: strip.scrollLeft, moved: false };
    });
    strip.addEventListener('pointermove', (e) => {
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x;
      if (!s.moved && Math.abs(dx) > 5) {
        s.moved = true;
        strip.classList.add('is-grabbing');
        try { strip.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      }
      if (s.moved) strip.scrollLeft = s.left - dx;
    });
    const end = () => {
      if (!s) return;
      if (s.moved) {
        swallowStripClick = true;
        window.setTimeout(() => { swallowStripClick = false; }, 0);
        strip.classList.remove('is-grabbing'); // snapping comes back on and settles the strip
      }
      s = null;
    };
    strip.addEventListener('pointerup', end);
    strip.addEventListener('pointercancel', end);
    strip.addEventListener('dragstart', (e) => e.preventDefault());
  }

  // Arrows either side of each strip, for anyone who would rather click than swipe. Each one
  // steps exactly one photo, to the next snap position, and hides at its end of the strip.
  const stripUpdaters = [];
  function updateStrips() {
    for (const update of stripUpdaters) update();
  }

  function stepStrip(strip, dir) {
    const sr = strip.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(strip).scrollPaddingLeft) || 0;
    const offsets = [...strip.querySelectorAll('.frame')].map((f) => f.getBoundingClientRect().left - sr.left - pad);
    let by = null;
    if (dir > 0) by = offsets.find((o) => o > 4);
    else for (const o of offsets) if (o < -4) by = o;
    if (by != null) strip.scrollBy({ left: by, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  journey.querySelectorAll('.chapter__media').forEach((media, i) => {
    const strip = media.querySelector('.strip');
    if (!strip) return;
    if (!strip.id) strip.id = `photos-${i + 1}`;
    const make = (dir) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `strip-arrow strip-arrow--${dir < 0 ? 'prev' : 'next'}`;
      b.disabled = true;
      b.setAttribute('aria-label', dir < 0 ? 'Previous photo' : 'Next photo');
      b.setAttribute('aria-controls', strip.id);
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${dir < 0 ? 'm14 7-5 5 5 5' : 'm10 7 5 5-5 5'}"/></svg>`;
      b.addEventListener('click', () => stepStrip(strip, dir));
      media.append(b);
      return b;
    };
    const prev = make(-1);
    const next = make(1);
    const show = (b, other, on) => {
      if (b.disabled === !on) return;
      // An arrow that hides under keyboard focus hands it to the other one.
      if (!on && document.activeElement === b && !other.disabled) other.focus({ preventScroll: true });
      b.disabled = !on;
      b.classList.toggle('is-shown', on);
    };
    const update = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      show(prev, next, max > 4 && strip.scrollLeft > 4);
      show(next, prev, max > 4 && strip.scrollLeft < max - 4);
    };
    let queued = false;
    strip.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    }, { passive: true });
    stripUpdaters.push(update);
  });

  // Photos and portraits fade in as they arrive instead of painting in strips.
  for (const img of journey.querySelectorAll('.frame img, .founder img, .person img')) {
    const done = () => img.classList.add('is-loaded');
    if (img.complete && img.naturalWidth) done();
    else {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }
  }

  journey.addEventListener('click', (e) => {
    const next = e.target.closest('.tl-next');
    if (next) {
      e.preventDefault();
      tape.switchTo(Number(next.dataset.year));
      return;
    }
    // Back to the beginning: the tape glides back across every year and the story starts over.
    if (e.target.closest('[data-rewind]')) {
      e.preventDefault();
      if (tape.state.open) tape.switchTo(FIRST);
      else tape.open(FIRST);
      return;
    }
    const frame = e.target.closest('.frame');
    if (frame) {
      if (swallowStripClick || openLightbox(frame)) e.preventDefault();
    }
  });

  // ---------------------------------------------------------------- founders
  // Hovering a founder, or focusing one from the keyboard, brings the light to them; moving on
  // lets it drift apart. A finger gets the same while it is down and a beat after, so the
  // gather is seen before LinkedIn opens in its new tab. The tape eases the halo there and
  // back (its haloOverride, below, aims it at the card).
  let hoverCard = null;
  let letGoTimer = 0;
  function setHover(card) {
    window.clearTimeout(letGoTimer);
    if (hoverCard === card) return;
    hoverCard = card;
    tape.syncHalo();
  }
  for (const card of journey.querySelectorAll('.founder')) {
    card.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') setHover(card); });
    card.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && hoverCard === card) setHover(null);
    });
    card.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') setHover(card); });
    const lift = (e) => {
      if (e.pointerType !== 'touch' || hoverCard !== card) return;
      window.clearTimeout(letGoTimer);
      letGoTimer = window.setTimeout(() => {
        if (hoverCard === card) setHover(null);
      }, e.type === 'pointercancel' ? 0 : 900); // a cancel is the page scrolling: let go now
    };
    card.addEventListener('pointerup', lift);
    card.addEventListener('pointercancel', lift);
    card.addEventListener('focus', () => { if (card.matches(':focus-visible')) setHover(card); });
    card.addEventListener('blur', () => { if (hoverCard === card) setHover(null); });
  }

  // ---------------------------------------------------------------- lightbox
  const lb = document.querySelector('.lightbox');
  const lbImg = lb && lb.querySelector('.lightbox__img');
  const lbCap = lb && lb.querySelector('.lightbox__caption');
  const lbPrev = lb && lb.querySelector('.lightbox__prev');
  const lbNext = lb && lb.querySelector('.lightbox__next');
  let lightboxOpen = false;
  let lbFrames = [];
  let lbIndex = 0;
  let lbSwallow = false;

  function showPhoto(i, dir) {
    const frame = lbFrames[i];
    const thumb = frame.querySelector('img');
    lbIndex = i;
    lbImg.src = thumb.currentSrc || thumb.src; // already loaded: shows at once
    lbImg.alt = thumb.alt;
    lbCap.textContent = thumb.alt;
    lbPrev.disabled = i === 0;
    lbNext.disabled = i === lbFrames.length - 1;
    const full = frame.getAttribute('href');
    if (full && full !== lbImg.getAttribute('src')) {
      const big = new Image();
      big.src = full;
      (big.decode ? big.decode() : Promise.resolve())
        .then(() => { if (lightboxOpen && lbIndex === i) lbImg.src = full; })
        .catch(() => { /* keep the smaller one */ });
    }
    if (dir && !reduceMotion) {
      lbImg.animate([
        { opacity: 0, transform: `translate3d(${dir * 36}px, 0, 0)` },
        { opacity: 1, transform: 'none' },
      ], { duration: 360, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    }
  }

  // The photo grows out of its frame in the strip: scaled to cover the frame's box and clipped
  // to it, so the start of the move is exactly what was on screen.
  function zoom(frame, out) {
    const a = frame.getBoundingClientRect();
    const b = lbImg.getBoundingClientRect();
    if (!a.width || !b.width || !b.height) return null;
    const k = Math.max(a.width / b.width, a.height / b.height);
    const ix = Math.max(0, (b.width - a.width / k) / 2);
    const iy = Math.max(0, (b.height - a.height / k) / 2);
    const dx = a.left + a.width / 2 - (b.left + b.width / 2);
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    const inFrame = { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${k})`, clipPath: `inset(${iy}px ${ix}px round ${14 / k}px)` };
    const atRest = { transform: 'none', clipPath: 'inset(0px 0px round 14px)' };
    return lbImg.animate(out ? [atRest, inFrame] : [inFrame, atRest], {
      duration: out ? 420 : 560,
      easing: out ? 'cubic-bezier(0.3, 0, 0.2, 1)' : SPRING,
      fill: out ? 'forwards' : 'none',
    });
  }

  function openLightbox(frame) {
    if (!lb || typeof lb.showModal !== 'function' || lightboxOpen) return false;
    lbFrames = [...frame.closest('.strip').querySelectorAll('.frame')];
    showPhoto(lbFrames.indexOf(frame), 0);
    lb.showModal();
    lightboxOpen = true;
    root.classList.add('lightbox-open');
    requestAnimationFrame(() => lb.classList.add('is-open'));
    if (!reduceMotion) zoom(frame, false);
    return true;
  }

  function closeLightbox() {
    if (!lightboxOpen) return;
    const frame = lbFrames[lbIndex];
    const strip = frame.parentElement;
    // Bring the strip round to the photo you ended on, so it lands back where it belongs.
    const fr = frame.getBoundingClientRect();
    const sr = strip.getBoundingClientRect();
    if (fr.left < sr.left || fr.right > sr.right) {
      strip.scrollLeft += fr.left - sr.left - (parseFloat(getComputedStyle(strip).paddingLeft) || 0);
    }
    lb.classList.remove('is-open');
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      lb.close();
      lightboxOpen = false;
      root.classList.remove('lightbox-open');
      lbImg.getAnimations().forEach((a) => a.cancel());
      lbImg.removeAttribute('src');
    };
    const r = frame.getBoundingClientRect();
    const onScreen = r.bottom > 0 && r.top < window.innerHeight;
    const anim = !reduceMotion && onScreen ? zoom(frame, true) : null;
    if (anim) anim.finished.then(done, done);
    else done();
  }

  if (lb) {
    lb.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeLightbox();
    });
    lb.addEventListener('click', (e) => {
      if (lbSwallow) return;
      if (e.target.closest('.lightbox__prev')) showStep(-1);
      else if (e.target.closest('.lightbox__next')) showStep(1);
      else if (!e.target.closest('.lightbox__img')) closeLightbox();
    });
    lb.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        showStep(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        showStep(1);
      }
    });
    // Swipe sideways for the next photo, down to put it away.
    let sw = null;
    lb.addEventListener('pointerdown', (e) => { sw = { x: e.clientX, y: e.clientY }; });
    lb.addEventListener('pointerup', (e) => {
      if (!sw) return;
      const dx = e.clientX - sw.x;
      const dy = e.clientY - sw.y;
      sw = null;
      let handled = false;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        showStep(dx < 0 ? 1 : -1);
        handled = true;
      } else if (dy > 90 && dy > Math.abs(dx)) {
        closeLightbox();
        handled = true;
      }
      if (handled) {
        lbSwallow = true;
        window.setTimeout(() => { lbSwallow = false; }, 0);
      }
    });
  }

  function showStep(d) {
    const i = lbIndex + d;
    if (i < 0 || i >= lbFrames.length) return;
    showPhoto(i, d);
  }

  // ---------------------------------------------------------------- the tape
  // Created last, so everything its hooks reach for above is in place. It builds one label per
  // year, runs the arrival film (to today, or to the year a link names) and opens that year.
  const tape = window.GridTape.create(journey, {
    stops: panels.map((panel) => ({
      id: Number(panel.dataset.year),
      panel,
      theme: panel.dataset.theme || '',
      peek: panel.dataset.peek || '',
      openable: true,
    })),
    label: {
      className: 'tl-year',
      tabId: (s) => `tab-${s.id}`,
      controls: (s) => String(s.id),
      render(s, button) {
        button.dataset.year = String(s.id);
        const text = document.createElement('span');
        text.textContent = String(s.id);
        button.append(text);
      },
      flipParts: (s, button) => [button.firstElementChild],
    },
    title: {
      el: title,
      parts: () => [digits],
      set: (s) => setTitle(s.id),
      roll: (s, dir) => rollTitle(s.id, dir),
    },
    peek: (s) => ({
      text: s.id === LAST ? `Today · ${s.peek}` : s.peek,
      label: `Open ${s.id}: ${s.peek}`,
    }),
    // The current year's arrivals run on into .tl-always, which follows it; with no year open,
    // .tl-always is what arrives.
    arrivals: (s) => (s
      ? [...s.panel.querySelectorAll('.review, .chapter, .tl-next, .tl-end'), ...(s.panel === current ? alwaysParts : [])]
      : alwaysParts),
    onShowPanel(s) {
      always.hidden = s.panel !== current;
      updateStrips(); // the panel has a layout now, so its strips know whether they scroll
      if (s.panel === current) layoutReview();
    },
    // The timeline collapsed: no year is open, and the founders and our backers stay below it.
    onHidePanels() {
      always.hidden = false;
    },
    onLayout() {
      updateStrips();
      layoutReview();
    },
    history: {
      key: 'journey',
      hash: (s) => `#${s.id}`,
      parse: (hash) => {
        const m = /^#(\d{4})$/.exec(hash);
        return m ? Number(m[1]) : null;
      },
    },
    hintKey: 'gridx-journey-hint',
    // Arrival: the tape runs from the first year to today and today opens. A link to a year
    // runs to that year instead and opens it.
    arrival: (deep) => ({ id: deep ? deep.id : NOW, open: true }),
    haloOverride(depth) {
      if (hoverCard) {
        const r = hoverCard.getBoundingClientRect();
        if (r.bottom > 0 && r.top < window.innerHeight) {
          // A firm grip draws in most of the drifting field and tightens the rim into a clean
          // band of light. No fill: the photo is opaque, so sparks behind it would be wasted.
          // The ring sits a little outside the card, in the gap the other founders leave.
          return { left: r.left - 11, top: r.top - 11, width: r.width + 22, height: r.height + 22, radius: 26, depth, fill: 0, grip: 0.8, weight: 1 };
        }
      }
      return null;
    },
    escapeBlocked: () => lightboxOpen,
    // Only an older year hides .tl-always, so a control inside it can vanish too.
    focusHiddenSelector: '.tl-panel[hidden], .tl-always[hidden]',
  });
})();
