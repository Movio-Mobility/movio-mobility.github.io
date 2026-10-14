/*
 * Opening hours, in India's time: one copy of the arithmetic for every page that says whether
 * someone is there right now (the support page's contact block, every dealer card), and for
 * the build, which prerenders the dealers page with it (tools/dealers.mjs runs this file in a
 * Node vm context, so it may lean on nothing but the language itself: no DOM, no Intl, no URL).
 *
 * THE CLOCK. India keeps one offset, UTC+5:30, all year and has done since 1945, so IST is the
 * UTC clock moved on 330 minutes. No time zone database is needed and none can be missing:
 * someone abroad, or on a phone set to another zone, is told about the shop's day, not theirs.
 * Public holidays are not known here, and the hours printed beside the line do not know
 * them either.
 *
 * THE SHAPE is the one Paddock publishes (lib/website/dealers/dealerView.js validateHours):
 *   { mon: [["10:00","13:30"], ["15:00","20:00"]], tue: [...], ..., sun: [] }
 * up to three spells a day, each opening before it closes, "24:00" allowed as a close, spells
 * in order and not overlapping. null means the hours are not known.
 *
 *   gridHours.normalize(hours)   the shape above, cleaned, or null when it does not fit
 *   gridHours.ist(now)           { day: 0..6 (0 = Monday), minutes } in India
 *   gridHours.state(hours, now)  { open: true, closesAt, ahead } (closesAt null: never closes)
 *                                { open: false, opensAt: { day, time, ahead } | null }
 *   gridHours.clock("19:30")     "7:30 PM"
 *   gridHours.status(hours, now) { open, text } as a dealer card says it:
 *                                "Open now · closes 7 PM", "Closed · opens 10 AM Mon"
 *   gridHours.summary(hours)     "Mon to Sat, 10 AM to 7 PM. Closed Sun." (Paddock's wording,
 *                                so its editor preview and the site agree)
 *   gridHours.specs(hours)       schema.org OpeningHoursSpecification groups, for the build
 *
 * IN OTHER LANGUAGES (assets/i18n.js, loaded first here and in the build's vm): every line is a
 * whole template, so a language can put the day and the time where it says them, and the time
 * is said the way people say it there: the part of the day and the hour ("शाम 7 बजे"), not
 * AM and PM. English is word for word what it always was, and specs() stays in English for
 * schema.org.
 */
(function (root) {
  'use strict';

  const lang = root.gridLang || null;
  const t = lang ? lang.t : (src, vars) => { let out = String(src).replace(/^[a-z][\w-]*::/, ''); if (vars && typeof vars.n === 'number' && out.includes('|')) out = out.split('|')[vars.n === 1 ? 0 : 1]; return out.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)); };
  const english = () => !lang || lang.code === 'en';

  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const LONG = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const IST_OFFSET_MIN = 330;
  const DAY_MIN = 1440;
  const OPENS = /^([01]\d|2[0-3]):[0-5]\d$/;
  const CLOSES = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;

  const toMin = (t) => (t === '24:00' ? DAY_MIN : Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** The contract's shape, cleaned: every day present, spells in order. null if it does not fit. */
  function normalize(hours) {
    if (!isObj(hours)) return null;
    const out = {};
    for (const key of Object.keys(hours)) {
      if (!DAYS.includes(key)) return null;
    }
    for (const day of DAYS) {
      const spells = hours[day] === undefined ? [] : hours[day];
      if (!Array.isArray(spells) || spells.length > 3) return null;
      const clean = [];
      for (const s of spells) {
        if (!Array.isArray(s) || s.length !== 2) return null;
        const [a, b] = s;
        if (typeof a !== 'string' || typeof b !== 'string' || !OPENS.test(a) || !CLOSES.test(b)) return null;
        if (toMin(a) >= toMin(b)) return null;
        clean.push([a, b]);
      }
      clean.sort((x, y) => toMin(x[0]) - toMin(y[0]));
      for (let i = 1; i < clean.length; i++) {
        if (toMin(clean[i][0]) < toMin(clean[i - 1][1])) return null;
      }
      out[day] = clean;
    }
    return out;
  }

  /** India's weekday (0 = Monday) and minutes since its midnight, for a Date or epoch ms. */
  function ist(now) {
    const ms = typeof now === 'number' ? now : now.getTime();
    const t = new Date(ms + IST_OFFSET_MIN * 60000);
    return { day: (t.getUTCDay() + 6) % 7, minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
  }

  const spellsOf = (hours, dayIndex) => (hours[DAYS[((dayIndex % 7) + 7) % 7]] || []);

  /**
   * Open or closed at `now`. Open: when it closes (closesAt), and how many days ahead that is,
   * following a spell that runs to midnight into the next day's 00:00 spell, so a shop open
   * through the night is not said to close at 12 AM; closesAt is null if it never closes.
   * Closed: the next opening, at most a week ahead, or null if it never opens.
   */
  function state(hours, now) {
    if (!hours) return null;
    const { day, minutes } = ist(now);
    for (const [a, b] of spellsOf(hours, day)) {
      if (minutes < toMin(a) || minutes >= toMin(b)) continue;
      let close = b;
      let ahead = 0;
      while (close === '24:00' && ahead < 7) {
        const next = spellsOf(hours, day + ahead + 1)[0];
        if (!next || next[0] !== '00:00') break;
        close = next[1];
        ahead++;
      }
      return { open: true, closesAt: close === '24:00' && ahead >= 7 ? null : close, ahead };
    }
    for (let ahead = 0; ahead <= 7; ahead++) {
      const next = spellsOf(hours, day + ahead).find(([a]) => ahead > 0 || toMin(a) > minutes);
      if (next) return { open: false, opensAt: { day: DAYS[(day + ahead) % 7], time: next[0], ahead } };
    }
    return { open: false, opensAt: null };
  }

  /** A day as the page's language writes it: "Mon" (or "Monday" with long). */
  function dayName(d, long) {
    if (english()) return long ? LONG[d] : SHORT[d];
    const said = long
      ? { mon: t('day::Monday'), tue: t('day::Tuesday'), wed: t('day::Wednesday'), thu: t('day::Thursday'), fri: t('day::Friday'), sat: t('day::Saturday'), sun: t('day::Sunday') }
      : { mon: t('day::Mon'), tue: t('day::Tue'), wed: t('day::Wed'), thu: t('day::Thu'), fri: t('day::Fri'), sat: t('day::Sat'), sun: t('day::Sun') };
    return said[d];
  }

  /**
   * "10:00" → "10 AM", "13:30" → "1:30 PM", "24:00" → "12 AM". Minutes are accepted too.
   * In another language, the part of the day and the hour on a 12 hour clock: "सुबह 10 बजे".
   */
  function clock(time) {
    const m = typeof time === 'number' ? time : toMin(time);
    const h = Math.floor(m / 60) % 24;
    const mm = m % 60;
    const hour = `${((h + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`;
    if (english()) return `${hour} ${h < 12 ? 'AM' : 'PM'}`;
    const part = h >= 4 && h < 12 ? t('clock::morning {time}', { time: hour })
      : h >= 12 && h < 16 ? t('clock::afternoon {time}', { time: hour })
        : h >= 16 && h < 20 ? t('clock::evening {time}', { time: hour })
          : t('clock::night {time}', { time: hour });
    return part;
  }

  /** The live line on a dealer card. null when the hours are not known. */
  function status(hours, now) {
    const s = state(hours, now);
    if (!s) return null;
    if (s.open) {
      return { open: true, text: s.closesAt === null ? t('Open 24 hours') : t('Open now · closes {time}', { time: clock(s.closesAt) }) };
    }
    if (!s.opensAt) return { open: false, text: t('Closed') };
    const { ahead, day, time } = s.opensAt;
    const at = clock(time);
    const text = ahead === 0 ? t('Closed · opens {time}', { time: at })
      : ahead === 1 ? t('Closed · opens {time} tomorrow', { time: at })
        : t('Closed · opens {time} {day}', { time: at, day: dayName(day) });
    return { open: false, text };
  }

  /** Paddock's summarizeHours, word for word: "Mon to Sat, 10 AM to 7 PM. Closed Sun." */
  function summary(hours) {
    if (!hours) return null;
    const key = (d) => (hours[d] || []).map(([a, b]) => `${a}-${b}`).join(',');
    const groups = [];
    for (const d of DAYS) {
      const k = key(d);
      const last = groups[groups.length - 1];
      if (last && last.k === k) last.days.push(d);
      else groups.push({ k, days: [d] });
    }
    const span = (days) => (days.length === 1 ? dayName(days[0]) : t('{from} to {to}', { from: dayName(days[0]), to: dayName(days[days.length - 1]) }));
    const spells = (d) => (hours[d] || []).map(([a, b]) => t('{from} to {to}', { from: clock(a), to: clock(b) }));
    const both = (list) => list.reduce((a, b) => t('{first} and {second}', { first: a, second: b }));
    const open = groups.filter((g) => g.k);
    const closed = groups.filter((g) => !g.k);
    let out = open.map((g) => t('{days}, {hours}', { days: span(g.days), hours: both(spells(g.days[0])) })).join('. ');
    if (closed.length) out += `${out ? '. ' : ''}${t('Closed {days}', { days: closed.map((g) => span(g.days)).join(', ') })}`;
    return out ? `${out}.` : null;
  }

  /** schema.org openingHoursSpecification: one entry per distinct spell, with its days. */
  function specs(hours) {
    if (!hours) return [];
    const bySpell = new Map();
    for (const d of DAYS) {
      for (const [a, b] of hours[d] || []) {
        const k = `${a}-${b}`;
        if (!bySpell.has(k)) bySpell.set(k, { opens: a, closes: b === '24:00' ? '23:59' : b, days: [] });
        bySpell.get(k).days.push(LONG[d]);
      }
    }
    return [...bySpell.values()].map((s) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: s.days,
      opens: s.opens,
      closes: s.closes,
    }));
  }

  root.gridHours = { DAYS, SHORT, LONG, dayName, normalize, ist, state, clock, status, summary, specs, toMin };
})(typeof window !== 'undefined' ? window : globalThis);
