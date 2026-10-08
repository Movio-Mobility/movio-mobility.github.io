#!/usr/bin/env node
/*
 * assets/hours.js, on its own, in a Node vm context exactly as the build runs it.
 *   node tools/check/hours-unit.mjs
 *
 * Covers: the contract's shape (normalize), open and closed at fixed moments in India's time
 * whatever the machine's own zone, the wording on a card, the week's summary (Paddock's
 * words), schema.org specs, and that the support page's contact line (assets/contact.js, now
 * built on hours.js) says exactly what it said before, every minute of a week. The "before"
 * is tools/check/fixtures/contact.before.js, the file as it was, kept verbatim.
 *
 * Each check prints PASS or FAIL; exits 1 if any failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const HOURS_SRC = read('assets/hours.js');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
}
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : `, want ${JSON.stringify(want)}`}`);

const ctx = vm.createContext({});
vm.runInContext(HOURS_SRC, ctx, { filename: 'assets/hours.js' });
const H = ctx.gridHours;
check('hours.js runs in a bare vm context (no window, no DOM)', Boolean(H && H.status));

// A moment in India: 2026-10-05 is a Monday.
const IST = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const dayIndex = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(day);
  return Date.UTC(2026, 9, 5 + dayIndex, h, m) - 330 * 60000;
};

const SHOP = { mon: [['10:00', '19:00']], tue: [['10:00', '19:00']], wed: [['10:00', '19:00']], thu: [['10:00', '19:00']], fri: [['10:00', '19:00']], sat: [['10:00', '19:00']], sun: [] };
const LUNCH = { mon: [['10:00', '13:30'], ['15:00', '20:00']], tue: [['10:00', '13:30'], ['15:00', '20:00']], wed: [['10:00', '13:30'], ['15:00', '20:00']], thu: [['10:00', '13:30'], ['15:00', '20:00']], fri: [['10:00', '13:30'], ['15:00', '20:00']], sat: [['10:00', '13:30'], ['15:00', '20:00']], sun: [['11:00', '14:00']] };

// ---------------------------------------------------------------- normalize
eq('normalize: a valid week passes, every day present', H.normalize({ mon: [['10:00', '19:00']] }), { mon: [['10:00', '19:00']], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] });
eq('normalize: spells come back in order', H.normalize({ mon: [['15:00', '20:00'], ['10:00', '13:30']] }).mon, [['10:00', '13:30'], ['15:00', '20:00']]);
eq('normalize: 24:00 is a closing time', H.normalize({ fri: [['22:00', '24:00']] }).fri, [['22:00', '24:00']]);
eq('normalize: 24:00 is not an opening time', H.normalize({ fri: [['24:00', '24:00']] }), null);
eq('normalize: overlapping spells', H.normalize({ mon: [['10:00', '14:00'], ['13:00', '18:00']] }), null);
eq('normalize: four spells', H.normalize({ mon: [['01:00', '02:00'], ['03:00', '04:00'], ['05:00', '06:00'], ['07:00', '08:00']] }), null);
eq('normalize: closing before opening', H.normalize({ mon: [['19:00', '10:00']] }), null);
eq('normalize: a day that is not a day', H.normalize({ funday: [] }), null);
eq('normalize: a time that is not a time', H.normalize({ mon: [['9:00', '19:00']] }), null);
eq('normalize: not an object', H.normalize([['10:00', '19:00']]), null);

// ---------------------------------------------------------------- the card's line
const status = (hours, day, hhmm) => {
  const s = H.status(hours, IST(day, hhmm));
  return s && s.text;
};
eq('Monday noon: open', status(SHOP, 'mon', '12:00'), 'Open now · closes 7 PM');
eq('Monday 9:59: opens this morning', status(SHOP, 'mon', '09:59'), 'Closed · opens 10 AM');
eq('Monday 10:00 sharp: open', status(SHOP, 'mon', '10:00'), 'Open now · closes 7 PM');
eq('Monday 18:59: still open', status(SHOP, 'mon', '18:59'), 'Open now · closes 7 PM');
eq('Monday 19:00 sharp: closed until tomorrow', status(SHOP, 'mon', '19:00'), 'Closed · opens 10 AM tomorrow');
eq('Saturday evening: closed until Monday', status(SHOP, 'sat', '19:30'), 'Closed · opens 10 AM Mon');
eq('Sunday: opens tomorrow', status(SHOP, 'sun', '12:00'), 'Closed · opens 10 AM tomorrow');
eq('Lunch: open in the morning spell', status(LUNCH, 'mon', '13:00'), 'Open now · closes 1:30 PM');
eq('Lunch: closed over lunch, opens this afternoon', status(LUNCH, 'mon', '14:00'), 'Closed · opens 3 PM');
eq('Lunch: Sunday morning', status(LUNCH, 'sun', '11:30'), 'Open now · closes 2 PM');
eq('Lunch: Saturday night, opens Sunday', status(LUNCH, 'sat', '21:00'), 'Closed · opens 11 AM tomorrow');
const LATE = { ...SHOP, fri: [['18:00', '24:00']], sat: [['00:00', '02:00']] };
eq('Through midnight: closes the next morning, not at 12 AM', status(LATE, 'fri', '23:00'), 'Open now · closes 2 AM');
const ALWAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '24:00']]]));
eq('Never closes', status(ALWAYS, 'wed', '03:00'), 'Open 24 hours');
const ONCE = { mon: [['10:00', '12:00']], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
eq('Open one morning a week, after it: next week', status(ONCE, 'mon', '13:00'), 'Closed · opens 10 AM Mon');
eq('Never open', status({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, 'mon', '12:00'), 'Closed');
eq('No hours known', H.status(null, Date.now()), null);
eq('A Date works as well as epoch ms', H.status(SHOP, new Date(IST('mon', '12:00'))).text, 'Open now · closes 7 PM');
eq('clock', ['00:00', '00:30', '09:05', '12:00', '13:30', '23:59', '24:00'].map((t) => H.clock(t)), ['12 AM', '12:30 AM', '9:05 AM', '12 PM', '1:30 PM', '11:59 PM', '12 AM']);

// India's time on any machine: the same moment in other zones gives the same answer.
for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
  const code = `${HOURS_SRC}\nprocess.stdout.write(globalThis.gridHours.status(${JSON.stringify(SHOP)}, ${IST('mon', '09:30')}).text)`;
  const out = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  eq(`machine in ${tz}: still India's morning`, out, 'Closed · opens 10 AM');
}

// ---------------------------------------------------------------- the week
eq('summary: a six day week', H.summary(SHOP), 'Mon to Sat, 10 AM to 7 PM. Closed Sun.');
eq('summary: lunch and a short Sunday', H.summary(LUNCH), 'Mon to Sat, 10 AM to 1:30 PM and 3 PM to 8 PM. Sun, 11 AM to 2 PM.');
eq('summary: unknown', H.summary(null), null);
eq('summary: never open', H.summary({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }), 'Closed Mon to Sun.');

// The same words as Paddock's own summarizeHours, when that repository is beside this one.
const PADDOCK = path.resolve(REPO, '../App Builds/CentralLedgerOnGCP-paddockProduction/src/lib/website/dealers/dealerView.js');
if (fs.existsSync(PADDOCK)) {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(PADDOCK)).toString('base64')}`);
  for (const [name, hours] of Object.entries({ SHOP, LUNCH, ONCE, LATE })) {
    eq(`summary matches Paddock's summarizeHours (${name})`, H.summary(hours), mod.summarizeHours(hours));
  }
} else {
  console.log('skip  Paddock is not beside this repository; its summarizeHours was not compared');
}

eq('schema.org specs', JSON.parse(JSON.stringify(H.specs(LUNCH))), [
  { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], opens: '10:00', closes: '13:30' },
  { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], opens: '15:00', closes: '20:00' },
  { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Sunday'], opens: '11:00', closes: '14:00' },
]);
eq('schema.org specs: 24:00 is written 23:59', JSON.parse(JSON.stringify(H.specs({ fri: [['18:00', '24:00']] })))[0].closes, '23:59');

// ---------------------------------------------------------------- contact.js, before and after
// Each version runs in its own context with a stand-in page and clock; the clock is moved and
// the page "comes back into view", which makes the script redo its line.
function contactRunner(code, withHours) {
  let now = 0;
  class FixedDate extends Date {
    constructor(...a) {
      if (a.length) super(...a);
      else super(now);
    }
    static now() { return now; }
  }
  const classes = new Set();
  const status = {
    textContent: '',
    hidden: true,
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
  };
  const listeners = {};
  const document = {
    hidden: false,
    getElementById: (id) => (id === 'contact-status' ? status : null),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    createElement: () => { throw new Error('contact.js tried to fetch hours.js although it was loaded'); },
    head: {},
  };
  const sandbox = { document, Date: FixedDate, Intl, setTimeout: () => 0, clearTimeout: () => {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  if (withHours) vm.runInContext(HOURS_SRC, sandbox);
  vm.runInContext(code, sandbox);
  return (t) => {
    now = t;
    listeners.visibilitychange();
    return `${status.hidden ? 'hidden' : 'shown'}|${classes.has('is-open') ? 'open' : 'closed'}|${status.textContent}`;
  };
}

const before = contactRunner(read('tools/check/fixtures/contact.before.js'), false);
const after = contactRunner(read('assets/contact.js'), true);
const start = IST('mon', '00:00');
let differences = 0;
let firstDifference = '';
const seen = new Set();
// Every minute of a week, at its first second and its last.
for (let m = 0; m < 7 * 1440; m++) {
  for (const s of [0, 59]) {
    const t = start + m * 60000 + s * 1000;
    const a = before(t);
    const b = after(t);
    seen.add(a);
    if (a !== b) {
      differences++;
      if (!firstDifference) firstDifference = `${new Date(t).toISOString()}: before "${a}", after "${b}"`;
    }
  }
}
check('contact.js says exactly what it said before, every minute of a week (20160 moments)', differences === 0,
  differences ? `${differences} differ, first ${firstDifference}` : `${seen.size} distinct lines, all identical`);
check('contact.js lines cover open, today, tomorrow and Monday', [...seen].some((l) => l.endsWith('Open now, until 6 PM'))
  && [...seen].some((l) => l.endsWith('opens today at 11 AM')) && [...seen].some((l) => l.endsWith('opens tomorrow at 11 AM'))
  && [...seen].some((l) => l.endsWith('opens Monday at 11 AM')), [...seen].join(' / '));

console.log(failed ? `\n${failed} check(s) failed` : '\nall hours checks passed');
process.exitCode = failed ? 1 : 0;
