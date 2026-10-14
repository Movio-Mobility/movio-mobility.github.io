/*
 * "Join the GridX Dealership Network": the dealers page's join sheet.
 *
 * A would-be dealer answers four short questions and is handed to WhatsApp with the message
 * already written, which they send us themselves. Nothing they type leaves the page until
 * they press send in WhatsApp, and nothing is stored by GridX.
 *
 *   1. Where are you based?   their location, asked for with the reason first. Named on this
 *                             phone (gridDealers.placeNear over assets/data/india-towns.json,
 *                             fetched only once they allow it); the position itself goes
 *                             nowhere. Without it, Paddock's word on which state their
 *                             connection is in (GET region), asked for when the sheet opens.
 *   2. What is your name?
 *   3. Do you already run a dealership?   yes, or not yet
 *   4. What is your shop called?          only for yes
 *   5. Ready to send                      the exact message, and Open WhatsApp: a real link,
 *                                         the surest way to open WhatsApp, on iOS too
 *
 * The message is gridDealers.joinMessage (dealers-core.js), so tools/check/dealers-unit.mjs
 * tests every wording without a browser. The opener in the page is a WhatsApp link with a
 * short message, which is what anyone without a script, or without <dialog>, still gets.
 *
 * With ?check&join=<step> in the address the sheet opens at that step with made-up answers,
 * for Safari in the iOS Simulator, which cannot be scripted (tools/check/dealer-join.mjs).
 */
(() => {
  'use strict';

  // Every word this page writes, in the page's language (assets/i18n.js).
  const t = window.gridLang ? window.gridLang.t : (src, vars) => { let out = String(src).replace(/^[a-z][\w-]*::/, ''); if (vars && typeof vars.n === 'number' && out.includes('|')) out = out.split('|')[vars.n === 1 ? 0 : 1]; return out.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)); };

  const sheetEl = document.getElementById('join-sheet');
  const opener = document.getElementById('join-open');
  const D = window.gridDealers;
  if (!sheetEl || !opener || !D || !window.gridSheet || typeof sheetEl.showModal !== 'function') return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const WHATSAPP = 'https://wa.me/919220199098?text=';
  const TOWNS_URL = (window.GRID_ROOT || '') + 'assets/data/india-towns.json';

  const form = document.getElementById('join-form');
  const scroller = sheetEl.querySelector('.join__scroll');
  const steps = [...sheetEl.querySelectorAll('.join__step')];
  const segs = [...sheetEl.querySelectorAll('.join__progress li')];
  const back = sheetEl.querySelector('.join__back');
  const primary = document.getElementById('join-primary');
  const whatsapp = document.getElementById('join-whatsapp');
  const skip = document.getElementById('join-skip');
  const found = document.getElementById('join-found');
  const foundText = document.getElementById('join-found-text');
  const note = document.getElementById('join-note');
  const messageEl = document.getElementById('join-message');
  const nameInput = document.getElementById('join-name');
  const shopInput = document.getElementById('join-shop');
  const choiceErr = document.getElementById('join-choice-err');
  const radios = [...form.querySelectorAll('input[name="dealership"]')];

  const track = (name, props) => {
    if (typeof window.gridTrack === 'function') window.gridTrack(name, props);
  };

  // ---------------------------------------------------------------- the answers
  // Kept while the page is open, so a sheet closed halfway opens again where it was left.
  // Reset once the message has gone to WhatsApp.
  const answers = { planning: null };
  let here = null;      // the town and state this phone is in, once found: { town, state }
  let region = null;    // the connection's state from Paddock, or null
  let located = 'ask';  // 'ask' | 'finding' | 'found' | 'off'
  let step = 'location';
  let advanceTimer = 0;

  const ORDER = ['location', 'name', 'dealership', 'shop', 'send'];
  const route = () => ORDER.filter((s) => s !== 'shop' || answers.planning === false);
  // Which of the four progress segments a step fills.
  const SEGMENT = { location: 0, name: 1, dealership: 2, shop: 2, send: 3 };

  const place = () => here || (region ? { town: null, state: region } : null);
  const placeText = (p) => (p.town ? (p.town === p.state ? p.town : `${p.town}, ${D.stateName ? D.stateName(p.state) : p.state}`) : (D.stateName ? D.stateName(p.state) : p.state));

  function message() {
    return D.joinMessage({
      name: nameInput.value,
      shop: shopInput.value,
      planning: answers.planning !== false,
      place: place(),
    });
  }

  // ---------------------------------------------------------------- drawing
  function render() {
    const at = SEGMENT[step];
    segs.forEach((seg, i) => {
      seg.dataset.state = i < at ? 'done' : (i === at ? 'current' : 'todo');
    });
    back.hidden = step === 'location';
    sheetEl.dataset.located = located;

    const sending = step === 'send';
    whatsapp.hidden = !sending;
    primary.hidden = sending;
    skip.hidden = !(step === 'location' && (located === 'ask' || located === 'finding'));

    if (step === 'location') {
      primary.textContent = located === 'ask' ? t('Share my location') : (located === 'finding' ? t('Finding you…') : t('Continue'));
      primary.setAttribute('aria-busy', String(located === 'finding'));
    } else {
      primary.textContent = t('Continue');
      primary.removeAttribute('aria-busy');
    }

    if (sending) {
      const text = message();
      messageEl.textContent = text;
      whatsapp.href = WHATSAPP + encodeURIComponent(text);
      whatsapp.setAttribute('aria-label', t('Open WhatsApp with this message'));
    }
  }

  /** Show a step. focus: 'field' puts the cursor in its field (a tap, so the keyboard comes
   * up), anything else focuses its title, which a screen reader then reads. */
  function show(next, { dir = 'fwd', focus = 'title' } = {}) {
    window.clearTimeout(advanceTimer);
    advanceTimer = 0;
    step = next;
    for (const el of steps) {
      const on = el.dataset.step === next;
      el.hidden = !on;
      if (on) el.dataset.dir = dir;
    }
    sheetEl.setAttribute('aria-labelledby', `join-title-${next}`);
    if (scroller) scroller.scrollTop = 0;
    render();
    const view = steps.find((el) => el.dataset.step === next);
    const field = view && view.querySelector('.field__input');
    if (focus === 'field' && field) field.focus({ preventScroll: true });
    else {
      const title = view && view.querySelector('.join__title');
      if (title) title.focus({ preventScroll: true });
    }
  }

  function forward(focus) {
    const r = route();
    const next = r[r.indexOf(step) + 1];
    if (next) show(next, { focus });
  }

  function backward() {
    const r = route();
    const prev = r[r.indexOf(step) - 1];
    if (prev) show(prev, { dir: 'back' });
  }

  // ---------------------------------------------------------------- where they are
  // The town list is fetched alongside the location, once they have said yes, and kept.
  let towns = null;
  const loadTowns = () => {
    if (!towns) {
      towns = fetch(TOWNS_URL, { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
    }
    return towns;
  };

  function settle(state, text) {
    located = state;
    note.textContent = text || '';
    render();
  }

  function locate() {
    if (!('geolocation' in navigator)) {
      settle('off', t('This browser cannot share a location. That is fine, you can carry on.'));
      return;
    }
    located = 'finding';
    note.textContent = '';
    render();
    const list = loadTowns();
    navigator.geolocation.getCurrentPosition((pos) => {
      const at = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      list.then((data) => {
        if (located !== 'finding') return;
        const p = data ? D.placeNear(data, at) : null;
        if (!p) {
          settle('off', t('We could not place you just now. That is fine, you can carry on.'));
          return;
        }
        here = p;
        foundText.textContent = p.town ? t('Near {place}', { place: placeText(p) }) : t('In {state}', { state: placeText(p) });
        found.hidden = false;
        settle('found', '');
        // On a short screen the place could land below the fold: bring it into view.
        found.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
        // A beat to read where they are, then on to the next question by itself.
        advanceTimer = window.setTimeout(() => {
          if (step === 'location' && sheetEl.open) forward('title');
        }, reduceMotion ? 600 : 1100);
      });
    }, (err) => {
      if (located !== 'finding') return;
      settle('off', err && err.code === 1
        ? t('Location is off for this site. That is fine, you can carry on.')
        : t('We could not find you just now. That is fine, you can carry on.'));
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
  }

  // The connection's state, asked for once per page: only the state, never stored.
  let asked = false;
  function askRegion() {
    if (asked || !window.gridxApi) return;
    asked = true;
    window.gridxApi.getJSON('/api/public/website/region', { timeoutMs: 4000 })
      .then((data) => {
        region = data && typeof data.state === 'string' && data.state.trim() ? data.state.trim().slice(0, 60) : null;
        if (step === 'send') render();
      })
      .catch(() => { region = null; });
  }

  // ---------------------------------------------------------------- the answers, checked
  const CHECK = {
    name: () => (nameInput.value.trim().length >= 2 ? '' : t('Please enter your name.')),
    shop: () => (shopInput.value.trim().length >= 2 ? '' : t('Please enter your shop\'s name.')),
  };

  function showError(input, msg) {
    const field = input.closest('.field');
    const err = document.getElementById(input.getAttribute('aria-describedby'));
    if (err) err.textContent = msg;
    if (field) field.classList.toggle('is-bad', Boolean(msg));
    if (msg) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  for (const [key, input] of [['name', nameInput], ['shop', shopInput]]) {
    // Corrected while typing once it has been called out, never called out mid-word.
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid')) showError(input, CHECK[key]());
    });
  }

  // ---------------------------------------------------------------- the one action
  function act() {
    if (step === 'location') {
      if (located === 'ask') locate();
      else if (located !== 'finding') forward('field');
      return;
    }
    if (step === 'name' || step === 'shop') {
      const input = step === 'name' ? nameInput : shopInput;
      const msg = CHECK[step]();
      showError(input, msg);
      if (msg) {
        input.focus({ preventScroll: true });
        return;
      }
      forward('title');
      return;
    }
    if (step === 'dealership') {
      if (answers.planning === null) {
        choiceErr.textContent = t('Choose one to carry on.');
        if (radios[0]) radios[0].focus();
        return;
      }
      forward('field');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    act();
  });

  skip.addEventListener('click', () => {
    located = 'off';
    note.textContent = '';
    forward('field');
  });

  back.addEventListener('click', backward);

  // A choice walks on by itself after a beat, so the tick visibly lands first. Arrow keys
  // move between the two without walking on; Enter does that.
  let viaPointer = false;
  form.addEventListener('pointerdown', (event) => {
    viaPointer = Boolean(event.target.closest('.join-opt'));
  });
  for (const radio of radios) {
    radio.addEventListener('change', () => {
      answers.planning = radio.value === 'no';
      choiceErr.textContent = '';
      render();
      if (!viaPointer) return;
      viaPointer = false;
      window.clearTimeout(advanceTimer);
      advanceTimer = window.setTimeout(() => {
        if (step === 'dealership' && sheetEl.open) forward('field');
      }, reduceMotion ? 120 : 420);
    });
  }

  // WhatsApp opens in its own tab or app; the sheet tidies itself away behind it, and the next
  // opening starts afresh (where they are is kept: it has not changed).
  let resetAfterClose = false;
  whatsapp.addEventListener('click', () => {
    window.setTimeout(() => {
      resetAfterClose = true;
      sheet.close();
    }, 200);
  });

  function reset() {
    answers.planning = null;
    for (const radio of radios) radio.checked = false;
    nameInput.value = '';
    shopInput.value = '';
    showError(nameInput, '');
    showError(shopInput, '');
    choiceErr.textContent = '';
    if (located !== 'found') {
      located = 'ask';
      note.textContent = '';
    }
    show('location');
  }

  // ---------------------------------------------------------------- the sheet
  // Android's back button closes it, as it would an app's sheet: an entry is pushed on open
  // and taken off again however it closes.
  let pushed = false;
  let keyboard = null;

  const sheet = window.gridSheet.create(sheetEl, {
    onOpen() {
      if (window.gridKeyboard) keyboard = window.gridKeyboard.watch({ shell: sheetEl, scope: sheetEl, scroller });
    },
    onClose() {
      if (keyboard) keyboard.stop();
      keyboard = null;
      window.clearTimeout(advanceTimer);
      if (pushed) {
        pushed = false;
        if (history.state && history.state.joinSheet) history.back();
      }
      if (resetAfterClose) {
        resetAfterClose = false;
        reset();
      }
    },
    // Never while the phone is still looking for a fix, so a stray swipe does not lose it.
    canSwipe: () => located !== 'finding',
  });

  window.addEventListener('popstate', () => {
    if (!pushed) return;
    pushed = false;
    if (sheet.isOpen()) sheet.close();
  });

  function openSheet(at) {
    askRegion();
    if (!sheet.isOpen()) {
      try {
        history.pushState({ ...(history.state || {}), joinSheet: true }, '');
        pushed = true;
      } catch (_) {
        pushed = false;
      }
    }
    sheet.open(opener);
    show(at || step, { focus: 'title' });
    track('dealer_join_open');
  }

  opener.addEventListener('click', (event) => {
    event.preventDefault();
    openSheet();
  });

  // ---------------------------------------------------------------- for the checks
  const params = new URLSearchParams(location.search);
  if (params.has('check') && params.has('join')) {
    const at = params.get('join');
    if (ORDER.includes(at)) {
      nameInput.value = 'Ramesh Kumar';
      shopInput.value = 'Shree Auto Works';
      answers.planning = params.get('planning') === '1';
      const yes = radios.find((r) => r.value === (answers.planning ? 'no' : 'yes'));
      if (yes) yes.checked = true;
      if (at !== 'location') {
        here = { town: 'Indore', state: 'Madhya Pradesh' };
        located = 'found';
        foundText.textContent = 'Near Indore, Madhya Pradesh';
        found.hidden = false;
      }
      window.addEventListener('load', () => openSheet(at));
    }
  }

  render();
})();
