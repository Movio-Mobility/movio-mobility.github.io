/*
 * The site's six languages: English at the root, Hindi, Marathi, Bengali, Kannada and Telugu
 * in folders of their own (/hi/store.html). Every page carries this, first in its head (the
 * build inlines it), and it does two things.
 *
 * 1. gridLang: the words scripts write. A script asks for its English and gets the page's
 *    language back: gridLang.t('Enter a 6 digit pincode.'). Values go in by name, and a count
 *    picks its form: gridLang.t('{n} hour|{n} hours', { n }). On an English page nothing is
 *    looked up at all; on a translated page the build puts that language's words in
 *    assets/i18n/<lang>.js, which gridLang.add() takes in before the first page script runs.
 *    No Intl anywhere in here, on purpose: assets/hours.js and assets/dealers-core.js also run
 *    at build time in a vm (tools/dealers.mjs), and the cards they write there must be
 *    byte for byte the cards the page writes.
 *
 * 2. The way in. A root page someone could read in their own language sends them there before
 *    anything is painted. Which language, in this order:
 *      - ?lang=<code>, which the language picker's English links carry (and remembers)
 *      - the language they chose before, on this device (localStorage gx-lang)
 *      - the language this tab was last reading in (sessionStorage), so a trip through a page
 *        kept in English (a policy, careers) comes back in theirs
 *      - only on arriving from elsewhere: the device's own language, when it is one of the
 *        five. Never on a click inside the site, so someone who picked English, even with
 *        storage blocked, is never bounced back.
 *    A page in a language folder is never left: a shared Hindi link opens in Hindi. The page
 *    being left sets window.gridLeaving, which the Meta Pixel, analytics.js and guard.js all
 *    read, so a visit is never counted twice; the referrer it came with is kept for the page
 *    it lands on. Not on 404.html (data-lang-stay), and not under ?check (the checks).
 */
(function (root) {
  'use strict';

  // The picker's rows, in its order. letter: the first letter of each alphabet, the button's face.
  var LANGS = [
    { code: 'en', name: 'English', gloss: 'English', letter: 'A', hreflang: 'en-IN' },
    { code: 'hi', name: 'हिंदी', gloss: 'Hindi', letter: 'अ', hreflang: 'hi-IN' },
    { code: 'mr', name: 'मराठी', gloss: 'Marathi', letter: 'अ', hreflang: 'mr-IN' },
    { code: 'bn', name: 'বাংলা', gloss: 'Bengali', letter: 'অ', hreflang: 'bn-IN' },
    { code: 'kn', name: 'ಕನ್ನಡ', gloss: 'Kannada', letter: 'ಅ', hreflang: 'kn-IN' },
    { code: 'te', name: 'తెలుగు', gloss: 'Telugu', letter: 'అ', hreflang: 'te-IN' },
  ];
  var CODES = ['en', 'hi', 'mr', 'bn', 'kn', 'te'];
  // The pages that exist in every language, by name ('' is home). The rest are English only.
  var TRANSLATED = ['', 'index', 'store', 'powerpod-gen2', 'adapter', 'chargers', 'vehicle-dock',
    'dealers', 'support', 'journey', '404', 'better'];
  // CLDR's "one": Hindi, Bengali and Kannada say it of 0 and 1, Marathi, Telugu and English of 1.
  var ZERO_IS_ONE = { hi: true, bn: true, kn: true };

  var doc = typeof document !== 'undefined' ? document : null;
  var here = doc && /^(hi|mr|bn|kn|te)$/.test(doc.documentElement.lang) ? doc.documentElement.lang : 'en';
  var words = {};
  var has = Object.prototype.hasOwnProperty;

  function plural(n, code) {
    var c = code || here;
    var whole = Math.floor(Math.abs(n)) === Math.abs(n);
    if (n === 1) return 'one';
    if (ZERO_IS_ONE[c] && whole && n === 0) return 'one';
    return 'other';
  }

  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, function (m, name) {
      return has.call(vars, name) && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : m;
    });
  }

  /**
   * The page's words for an English source. "ctx::Home" names a second meaning of the same
   * English; "{n} hour|{n} hours" carries its English plural, used when vars.n is a number.
   */
  function t(src, vars) {
    var n = vars && typeof vars.n === 'number' ? vars.n : null;
    var out;
    if (here !== 'en' && has.call(words, src)) {
      var hit = words[src];
      out = typeof hit === 'string' ? hit : (hit[plural(n === null ? 2 : n)] || hit.other || hit.one);
    } else {
      out = src.replace(/^[a-z][\w-]*::/, '');
      if (n !== null && out.indexOf('|') > 0) {
        var forms = out.split('|');
        if (forms.length === 2) out = forms[n === 1 ? 0 : 1];
      }
    }
    return fill(out, vars);
  }

  /**
   * Markup back into a translated sentence: its <0>...</0> placeholders become pairs[0]'s
   * opening and closing tags, so a link can sit wherever the language puts it.
   * tags(t('Message us on <0>WhatsApp</0>.'), [['<a href="...">', '</a>']])
   */
  function tags(text, pairs) {
    return String(text).replace(/<(\/?)(\d+)>/g, function (m, close, k) {
      var pair = pairs[Number(k)];
      return pair ? pair[close ? 1 : 0] : '';
    });
  }

  /** "29999" -> "29,999", "1234567" -> "12,34,567": Indian grouping, Western digits, everywhere. */
  function num(value) {
    var s = String(Math.round(Number(value) || 0));
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    if (s.length > 3) {
      var head = s.slice(0, -3);
      s = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
    }
    return (neg ? '-' : '') + s;
  }

  /** The page's own address in another language: /store.html -> /hi/store.html, /hi/ -> /. */
  function pathIn(code, path) {
    var p = (path || (typeof location !== 'undefined' ? location.pathname : '/')).replace(/^\/(hi|mr|bn|kn|te)(?=\/|$)/, '') || '/';
    return code === 'en' ? p : '/' + code + (p === '/' ? '/' : p);
  }

  /** Whether the page at this root path exists in every language. */
  function translated(path) {
    var name = String(path || '/').replace(/^\/+|\/+$/g, '').replace(/\.html$/i, '').toLowerCase();
    return TRANSLATED.indexOf(name) >= 0;
  }

  function stored(store, key) {
    try {
      var v = root[store] && root[store].getItem(key);
      return CODES.indexOf(v) >= 0 ? v : null;
    } catch (e) {
      return null;
    }
  }
  function keep(store, key, value) {
    try {
      if (root[store]) root[store].setItem(key, value);
    } catch (e) { /* private mode, blocked storage: the link itself still carries the choice */ }
  }

  /** The visitor chose: remembered on this device and in this tab. */
  function choose(code) {
    if (CODES.indexOf(code) < 0) return;
    keep('localStorage', 'gx-lang', code);
    keep('sessionStorage', 'gx-lang-tab', code);
  }

  /** The first of the device's languages that is one of ours, or null when English comes first. */
  function deviceLang() {
    var list = (root.navigator && (root.navigator.languages || [root.navigator.language])) || [];
    for (var i = 0; i < list.length; i++) {
      var code = String(list[i] || '').toLowerCase().split(/[-_]/)[0];
      if (code === 'en') return null;
      if (CODES.indexOf(code) > 0) return code;
    }
    return null;
  }

  root.gridLang = {
    code: here,
    langs: LANGS,
    codes: CODES,
    t: t,
    tags: tags,
    num: num,
    plural: plural,
    pathIn: pathIn,
    translated: translated,
    choose: choose,
    deviceLang: deviceLang,
    chosen: function () { return stored('localStorage', 'gx-lang'); },
    add: function (more) {
      for (var k in more) if (has.call(more, k)) words[k] = more[k];
    },
    // For the build's vm, which has no page to read the language from (tools/dealers.mjs).
    use: function (code) {
      if (CODES.indexOf(code) < 0) return;
      here = code;
      root.gridLang.code = code;
    },
  };

  // ---------------------------------------------------------------- the way in
  if (!doc || typeof location === 'undefined') return;
  if (here !== 'en') {
    keep('sessionStorage', 'gx-lang-tab', here);
    return;
  }
  var search = location.search;
  if (/[?&]check\b/.test(search) || doc.documentElement.hasAttribute('data-lang-stay')) return;

  var asked = /[?&]lang=(en|hi|mr|bn|kn|te)(?=&|$)/.exec(search);
  var want;
  if (asked) {
    want = asked[1];
    choose(want);
    // The choice is made; the address goes back to the page's own, here or where it is sent.
    search = search.replace(/([?&])lang=[a-z]{2}(&|$)/, function (m, a, b) { return b ? a : ''; }).replace(/[?&]$/, '');
    if ((want === 'en' || !translated(location.pathname)) && root.history && history.replaceState) {
      try { history.replaceState(history.state, '', location.pathname + search + location.hash); } catch (e) { /* the address keeps its ?lang */ }
    }
  } else {
    var entry = true;
    try { entry = !doc.referrer || new URL(doc.referrer).origin !== location.origin; } catch (e) { entry = true; }
    want = stored('localStorage', 'gx-lang') || stored('sessionStorage', 'gx-lang-tab') || (entry ? deviceLang() : null);
  }
  if (!want || want === 'en' || !translated(location.pathname)) return;

  root.gridLeaving = true;
  try {
    var from = doc.referrer;
    if (from && new URL(from).origin !== location.origin) root.sessionStorage.setItem('gx-ref', from);
  } catch (e) { /* the landing page reads its own referrer, this page */ }
  location.replace(pathIn(want) + search + location.hash);
})(typeof window !== 'undefined' ? window : globalThis);
