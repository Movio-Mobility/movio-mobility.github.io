/*
 * The language picker in the top bar, and the one-time offer (tools/i18n.mjs writes the
 * markup into every page; assets/lang.css dresses it; assets/i18n.js remembers the choice).
 *
 * The footer's last line carries the same six (.credits__langs), and choosing there works the
 * same way.
 *
 * THE PICKER is a <details>: without this file it still opens and its six rows are plain
 * links. With it, it closes on a tap outside or Escape, closes when a row is chosen, and the
 * choice is remembered on this device before the link is followed. On a page kept in English
 * (a policy, careers) choosing a language does not reload the page: the choice is kept for
 * the rest of the site, the button takes the language's letter, and one line says, in that
 * language, that this page stays in English.
 *
 * THE HINT. A first visit to an English page, with nothing chosen yet: once the chrome has
 * settled, the button's letter turns slowly through अ অ ಅ అ and back to A, once ever, a quiet
 * way of saying the site speaks them. Not under reduced motion.
 *
 * THE OFFER. A reader whose device is not set to one of the five, who has chosen nothing and
 * whose connection is in a state with a language of its own, is offered it once: a small card
 * under the button, in that language. The state comes from Paddock (GET region, the same one
 * the dealer join sheet asks), once per browser, its answer kept as the language offered (or
 * "none"), never the state itself. The card leaves when answered, when the reader scrolls on,
 * or after a while; any answer is remembered.
 *
 * For the checks, only with ?check: &offer=<code> shows that offer at once, no Paddock asked.
 */
(() => {
  'use strict';

  const L = window.gridLang;
  const root = document.querySelector('.lang');
  if (!L || !root) return;

  const pick = root.querySelector('.lang__pick');
  const face = root.querySelector('.lang__face');
  const params = new URLSearchParams(location.search);
  const checking = params.has('check');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const here = L.code;
  const translatedPage = L.translated(location.pathname.replace(/^\/(hi|mr|bn|kn|te)(?=\/|$)/, '') || '/');

  const read = (store, key) => {
    try { return window[store].getItem(key); } catch (_) { return null; }
  };
  const write = (store, key, value) => {
    try { window[store].setItem(key, value); } catch (_) { /* blocked: the links still carry the choice */ }
  };
  const letterOf = (code) => (L.langs.find((l) => l.code === code) || L.langs[0]).letter;

  // ---------------------------------------------------------------- the picker
  function close() {
    if (pick && pick.open) pick.open = false;
  }
  if (pick) {
    document.addEventListener('pointerdown', (event) => {
      if (pick.open && !pick.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && pick.open) {
        close();
        pick.querySelector('.lang__btn').focus();
      }
    });
    pick.addEventListener('toggle', () => {
      if (pick.open) {
        showNote();
        hideOffer(false);
      }
    });
  }

  /** On a page kept in English: the line for the language chosen, if one is. */
  function showNote(code) {
    const want = code || L.chosen() || read('sessionStorage', 'gx-lang-tab');
    for (const note of root.querySelectorAll('[data-lang-note]')) note.hidden = note.dataset.langNote !== want;
  }

  // The footer's row of the six (tools/i18n.mjs footerLangsMarkup), the page's last line.
  const footer = document.querySelector('.credits__langs');
  const footnote = footer && footer.querySelector('[data-lang-footnote]');

  function choose(event) {
    const link = event.target.closest('[data-lang-to]');
    if (!link) return;
    const code = link.dataset.langTo;
    L.choose(code);
    write('localStorage', 'gx-lang-offer', 'answered');
    if (translatedPage) return; // the link is this page in that language: followed as it is
    // A page kept in English stays as it is; the choice is kept for every page that has the
    // language, and both lists say which one is chosen.
    event.preventDefault();
    showNote(code);
    for (const row of document.querySelectorAll('.lang__row, .credits__lang')) {
      if (row.dataset.langTo === code) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    if (face) face.textContent = letterOf(code === 'en' ? 'en' : code);
    if (footnote) {
      const said = root.querySelector(`[data-lang-note="${code}"]`);
      footnote.textContent = said ? said.textContent : '';
      footnote.lang = code;
      footnote.hidden = !said;
    }
    if (code === 'en' || link.closest('.credits__langs')) close();
  }
  root.addEventListener('click', choose);
  if (footer) footer.addEventListener('click', choose);
  if (!translatedPage) showNote();

  // ---------------------------------------------------------------- the hint
  function hint() {
    if (!face || reduceMotion || here !== 'en' || L.chosen() || read('localStorage', 'gx-lang-hint')) return;
    write('localStorage', 'gx-lang-hint', '1');
    const letters = ['अ', 'অ', 'ಅ', 'అ', 'A'];
    let i = 0;
    const step = () => {
      face.classList.add('is-swapping');
      window.setTimeout(() => {
        face.textContent = letters[i++];
        face.classList.remove('is-swapping');
        if (i < letters.length) window.setTimeout(step, 900);
      }, 600);
    };
    step();
  }

  // ---------------------------------------------------------------- the offer
  // Each state with a language of its own, as Paddock names it. Every other state is offered
  // nothing, on purpose: Hindi is not the language of Chennai or Kochi.
  const STATE_LANG = {
    Maharashtra: 'mr',
    'West Bengal': 'bn',
    Tripura: 'bn',
    Karnataka: 'kn',
    Telangana: 'te',
    'Andhra Pradesh': 'te',
    'Uttar Pradesh': 'hi',
    Bihar: 'hi',
    'Madhya Pradesh': 'hi',
    Rajasthan: 'hi',
    Haryana: 'hi',
    Delhi: 'hi',
    Uttarakhand: 'hi',
    'Himachal Pradesh': 'hi',
    Jharkhand: 'hi',
    Chhattisgarh: 'hi',
    Chandigarh: 'hi',
  };
  let shown = null;
  let leaveTimer = 0;

  function hideOffer(remember = true) {
    if (!shown) return;
    const card = shown;
    shown = null;
    window.clearTimeout(leaveTimer);
    window.removeEventListener('scroll', onScroll);
    if (remember) write('localStorage', 'gx-lang-offer', 'answered');
    if (reduceMotion) card.hidden = true;
    else {
      card.classList.add('is-leaving');
      window.setTimeout(() => { card.hidden = true; card.classList.remove('is-leaving'); }, 320);
    }
  }
  let scrolledFrom = 0;
  function onScroll() {
    if (Math.abs(window.scrollY - scrolledFrom) > window.innerHeight * 0.4) hideOffer();
  }

  function offer(code) {
    const card = root.querySelector(`[data-lang-offer="${code}"]`);
    if (!card || (pick && pick.open)) return;
    card.hidden = false;
    shown = card;
    scrolledFrom = window.scrollY;
    window.addEventListener('scroll', onScroll, { passive: true });
    leaveTimer = window.setTimeout(() => hideOffer(), 20000);
    const stay = card.querySelector('[data-lang-stay]');
    if (stay) {
      stay.addEventListener('click', () => {
        L.choose('en');
        hideOffer();
      }, { once: true });
    }
  }

  function maybeOffer() {
    if (here !== 'en' || !translatedPage) return;
    if (checking) {
      const forced = params.get('offer');
      if (forced && STATE_LANG && Object.values(STATE_LANG).includes(forced)) offer(forced);
      return;
    }
    if (L.chosen() || read('sessionStorage', 'gx-lang-tab') || L.deviceLang() || read('localStorage', 'gx-lang-offer')) return;
    const api = window.gridxApi;
    if (!api || typeof api.getJSON !== 'function') return;
    // Asked once per browser, whatever it answers, so a busy network never spends the
    // region budget the dealer join sheet relies on.
    write('localStorage', 'gx-lang-offer', 'none');
    api.getJSON('/api/public/website/region', { timeoutMs: 4000 })
      .then((data) => {
        const code = data && STATE_LANG[data.state];
        if (!code) return;
        write('localStorage', 'gx-lang-offer', code);
        offer(code);
      })
      .catch(() => {});
  }

  // After the page has settled: on home once the chrome is in and the headline has had its
  // moment, elsewhere once the page is idle.
  function settled(fn, delay) {
    const go = () => {
      const idle = window.GridPerf && window.GridPerf.idle;
      if (idle) idle(fn, delay);
      else window.setTimeout(fn, delay);
    };
    if (document.documentElement.classList.contains('skip-intro')) {
      if (document.readyState === 'complete') go();
      else window.addEventListener('load', go, { once: true });
      return;
    }
    const watch = new MutationObserver(() => {
      if (!document.documentElement.classList.contains('chrome-in')) return;
      watch.disconnect();
      window.setTimeout(go, 2600);
    });
    if (document.documentElement.classList.contains('chrome-in')) window.setTimeout(go, 2600);
    else watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  settled(() => {
    hint();
    maybeOffer();
  }, 1200);

  // On a page kept in English, both lists say which language was chosen before.
  if (!translatedPage) {
    const chosen = L.chosen();
    if (chosen && chosen !== 'en') {
      if (face) face.textContent = letterOf(chosen);
      for (const row of document.querySelectorAll('.lang__row, .credits__lang')) {
        if (row.dataset.langTo === chosen) row.setAttribute('aria-current', 'true');
        else row.removeAttribute('aria-current');
      }
    }
  }
})();
