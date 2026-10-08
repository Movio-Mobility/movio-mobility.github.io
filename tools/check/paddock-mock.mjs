#!/usr/bin/env node
/*
 * Paddock, played by a script: every public route the website talks to, answering from the
 * fixtures in tools/check/fixtures, on the address assets/gridx-api.js uses on localhost
 * (http://localhost:3000). So a page, a check or the build can be run against "Paddock"
 * without Paddock, and made to see every answer the real one can give.
 *
 *   npm run mock                         listen on :3000 until stopped
 *   node tools/check/paddock-mock.mjs --port 3100 --quiet
 *   import { startMock } from './paddock-mock.mjs'; const mock = await startMock({ port });
 *
 * The routes and their shapes are Part 0 of the platform plan, the contract both repos
 * share. Everything lives under /api/public/website/:
 *
 *   GET  careers                      ETag, 304 on If-None-Match, Cache-Control, CORS on both
 *   GET  careers/og/<slug>.jpg        and careers/og/careers.jpg, a small committed JPEG
 *   GET  dealers                      as careers, with its own Cache-Control
 *   GET  dealers/photo/<id>-<w>.webp  w is 320, 640 or 1280; immutable when ?v= is current
 *   POST careers/apply                multipart. By the applicant's email:
 *                                       dup@...    409 duplicate (with appliedAt)
 *                                       closed@... 410 job_closed
 *                                       rate@...   429 with retryAfterSec
 *                                       bot@...    403 verification_failed
 *                                       slow@...   accepted, but the upload is read slowly and
 *                                                  the answer held back, to show progress
 *                                     honeypot (company_website) or under 3s: a fake 201
 *   POST careers/schedule             by token t: valid, booked, late, taken, expired;
 *                                     anything else is 404 invalid_link
 *   POST support                      by name: "Forbidden" 403, "Rate Limited" 429,
 *                                     "Unavailable" 503; honeypot: a fake 201; 400 with fields
 *   POST orders/track                 GX-COLLECT1 with 9876543210 (collect from a dealer),
 *                                     GX-SHIPPED1 with 9876543210 (on its way); else 404
 *   POST pageview, event, live        text/plain JSON (or application/json), always 204;
 *                                     events are checked against the allowlist, 20 at most
 *
 * And the controls a check drives it with:
 *
 *   POST /__mock/state   { modes: { careers: 'ok'|'error'|'slow'|'invalid'|'html', dealers: ...,
 *                                   apply|support|track|schedule: 'ok'|'down',
 *                                   beacons: 'ok'|'rate', cors: 'ok'|'deny',
 *                                   latencyMs, slowMs },
 *                          careers: <whole document>, dealers: <whole document>,
 *                          add:    { jobs: [...], dealers: [...] },
 *                          patch:  { jobs: [{ id, ...fields }], dealers: [{ id, ...fields }] },
 *                          remove: { jobs: [ids], dealers: [ids] },
 *                          close:  [job ids] }      (closed jobs move to recentlyClosed)
 *                        any change to a document gives it a new version, so a new ETag
 *   GET  /__mock/state   the modes and the current versions
 *   GET  /__mock/log     every request so far (?since=<seq> for the newer ones). Bodies are
 *                        logged as parsed JSON; an upload as its field names and file sizes
 *   POST /__mock/reset   fixtures, modes and log back to the start
 *
 * Photo and OG URLs in the fixtures name production (https://paddockgridx.app); they are
 * served pointing at this mock instead, so whatever follows them stays on this machine.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const PROD = 'https://paddockgridx.app';
const API = '/api/public/website';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAREERS_CACHE = 'public, max-age=30, stale-while-revalidate=60, stale-if-error=86400';
const DEALERS_CACHE = 'public, max-age=60, stale-while-revalidate=300';
const MAX_UPLOAD = 11 * 1024 * 1024; // the resume cap plus room for the other fields

const DEFAULT_MODES = {
  careers: 'ok',
  dealers: 'ok',
  apply: 'ok',
  schedule: 'ok',
  support: 'ok',
  track: 'ok',
  beacons: 'ok',
  cors: 'ok',
  latencyMs: 0,
  slowMs: 20000,
};

// The website's event allowlist (Part 0), as Paddock's eventCatalog.js has it: a name not
// listed is dropped, and so is a property not listed for that name.
const EVENTS = {
  store_view: [],
  order_sheet_open: ['sku'],
  order_submit: ['sku', 'intent', 'delivery'],
  payment_open: [],
  payment_success: [],
  payment_dismissed: [],
  payment_failed: [],
  configurator_step: ['step'],
  careers_view: [],
  role_view: ['slug'],
  apply_open: ['slug'],
  apply_submit: ['slug'],
  apply_success: [],
  contact_tap: ['channel', 'page', 'topic'],
  faq_open: ['id'],
  manual_download: ['id'],
  support_form_open: [],
  support_form_submit: [],
  track_lookup: ['result'],
  dealer_search: ['kind'],
  dealer_action: ['action', 'dealerId'],
};
const ENUMS = {
  intent: ['reserve', 'full'],
  delivery: ['dealership', 'ship'],
  channel: ['call', 'whatsapp', 'email'],
  result: ['found', 'not_found', 'error'],
  kind: ['city', 'pincode', 'near_me', 'text'],
  action: ['call', 'whatsapp', 'directions', 'share'],
};

const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ref = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;
const maskEmail = (email) => {
  const [user, host] = String(email).split('@');
  return `${user.slice(0, 1)}***@${host || ''}`;
};

function freshState() {
  return {
    careers: readFixture('careers.json'),
    dealers: readFixture('dealers.json'),
    modes: { ...DEFAULT_MODES },
    log: [],
    seq: 0,
    bookings: new Map(), // schedule token -> booked slot, for the tokens that can book
    takenRevealed: false,
  };
}

// ---------------------------------------------------------------- documents
/** A new version after a change: the same content always gets the same version. */
function revise(doc, prefix) {
  const { version, ...rest } = doc;
  doc.version = `${prefix}-${sha(JSON.stringify(rest)).slice(0, 10)}`;
}

function recountCareers(c) {
  for (const d of c.domains) d.openCount = c.jobs.filter((j) => j.domain === d.key).length;
}

function recountDealers(d) {
  const cities = new Map();
  for (const x of d.dealers) {
    const key = `${x.city}|${x.state}`;
    if (!cities.has(key)) cities.set(key, { name: x.city, state: x.state, count: 0 });
    cities.get(key).count++;
  }
  d.cities = [...cities.values()];
}

function applyState(state, body) {
  let careers = false;
  let dealers = false;
  if (body.modes && typeof body.modes === 'object') Object.assign(state.modes, body.modes);
  if (body.careers && typeof body.careers === 'object') { state.careers = body.careers; careers = true; }
  if (body.dealers && typeof body.dealers === 'object') { state.dealers = body.dealers; dealers = true; }
  const lists = { jobs: () => state.careers.jobs, dealers: () => state.dealers.dealers };
  for (const [op, spec] of Object.entries({ add: body.add, patch: body.patch, remove: body.remove })) {
    if (!spec || typeof spec !== 'object') continue;
    for (const [name, items] of Object.entries(spec)) {
      if (!lists[name] || !Array.isArray(items)) continue;
      const list = lists[name]();
      for (const item of items) {
        if (op === 'add') list.push(item);
        else if (op === 'patch') {
          const hit = list.find((x) => x.id === item.id);
          if (hit) Object.assign(hit, item);
        } else {
          const i = list.findIndex((x) => x.id === item);
          if (i >= 0) list.splice(i, 1);
        }
      }
      if (name === 'jobs') careers = true;
      else dealers = true;
    }
  }
  if (Array.isArray(body.close)) {
    for (const id of body.close) {
      const i = state.careers.jobs.findIndex((j) => j.id === id);
      if (i < 0) continue;
      const [job] = state.careers.jobs.splice(i, 1);
      state.careers.recentlyClosed = state.careers.recentlyClosed || [];
      state.careers.recentlyClosed.unshift({
        id: job.id, slug: job.slug, previousSlugs: job.previousSlugs || [], title: job.title,
        domain: job.domain, state: 'closed', since: new Date().toISOString(),
      });
      careers = true;
    }
  }
  if (careers) { recountCareers(state.careers); revise(state.careers, 'c'); }
  if (dealers) { recountDealers(state.dealers); revise(state.dealers, 'd'); }
}

/** Production URLs in a document, pointed at this mock. */
const localise = (doc, base) => JSON.parse(JSON.stringify(doc).split(`${PROD}${API}/`).join(`${base}${API}/`));

// ---------------------------------------------------------------- http plumbing
function corsHeaders(state, req) {
  const origin = req.headers.origin;
  // No Origin is the build (or curl): GET routes answer it, as Paddock's do.
  if (!origin || state.modes.cors === 'deny') return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Expose-Headers': 'ETag, Retry-After',
  };
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = body === undefined || body === null ? '' : (isBuf ? body : JSON.stringify(body));
  const h = { ...headers };
  if (payload.length && !h['Content-Type']) h['Content-Type'] = 'application/json; charset=utf-8';
  if (!h['Cache-Control']) h['Cache-Control'] = 'no-store';
  h['Content-Length'] = Buffer.byteLength(payload);
  res.writeHead(status, h);
  res.end(payload);
}

/** If-None-Match against one ETag: comma lists, weak validators and * all count. */
function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => bare(t) === bare(etag));
}

function cacheable(state, req, res, body, version, cacheControl) {
  const etag = `"${version}"`;
  const headers = { ...corsHeaders(state, req), ETag: etag, 'Cache-Control': cacheControl };
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    res.end();
    return 304;
  }
  send(res, 200, body, headers);
  return 200;
}

/**
 * The request body. onChunk sees each piece as it arrives and can return a delay, which
 * pauses reading: the client's upload then backs up behind it, as it would on a slow link.
 */
function readBody(req, { limit, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (limit && size > limit) {
        tooBig = true;
        return; // keep draining so the client sees the answer, not a reset
      }
      chunks.push(chunk);
      const wait = onChunk ? onChunk(chunk, size) : 0;
      if (wait > 0) {
        req.pause();
        setTimeout(() => req.resume(), wait);
      }
    });
    req.on('end', () => resolve({ buffer: Buffer.concat(chunks), size, tooBig }));
    req.on('error', reject);
  });
}

const parseJson = (buf) => {
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
};

// ---------------------------------------------------------------- careers/apply
const AVAILABILITY = new Set(['immediately', '1m', '2m', '3m', 'date']);
const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function resumeKind(name, buf) {
  const ext = (String(name).toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0];
  if (ext === '.pdf') return buf.subarray(0, 5).toString('latin1') === '%PDF-' ? 'pdf' : null;
  if (ext === '.doc') return buf.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) ? 'doc' : null;
  if (ext === '.docx') {
    const text = buf.toString('latin1');
    return buf.subarray(0, 2).toString('latin1') === 'PK' && text.includes('[Content_Types].xml') && text.includes('word/') ? 'docx' : null;
  }
  return null;
}

async function apply(state, req, res, log) {
  const ct = req.headers['content-type'] || '';
  if (!/^multipart\/form-data/i.test(ct)) return send(res, 400, { success: false, error: 'Send the form as multipart.', code: 'invalid' }, corsHeaders(state, req));
  let slow = false;
  const { buffer, size, tooBig } = await readBody(req, {
    limit: MAX_UPLOAD,
    // The email arrives before the file in the site's form, so the rest of a slow@
    // applicant's upload is read at about 300 KB/s.
    onChunk: (chunk) => {
      if (!slow && chunk.includes('slow@')) slow = true;
      return slow ? Math.ceil(chunk.length / 300) : 0;
    },
  });
  if (tooBig) {
    log.body = { size };
    return send(res, 413, { success: false, error: 'That file is too large. The limit is 10 MB.', code: 'resume_too_large' }, corsHeaders(state, req));
  }
  let form;
  try {
    form = await new Request('http://mock/', { method: 'POST', headers: { 'content-type': ct }, body: buffer }).formData();
  } catch {
    return send(res, 400, { success: false, error: 'That form could not be read.', code: 'invalid' }, corsHeaders(state, req));
  }
  const fields = {};
  let resume = null;
  for (const [k, v] of form.entries()) {
    if (typeof v === 'string') fields[k] = v;
    else if (k === 'resume') resume = v;
  }
  log.body = { ...fields, resume: resume ? { name: resume.name, size: resume.size, type: resume.type } : null };
  const h = corsHeaders(state, req);
  const email = String(fields.email || '').trim().toLowerCase();

  if (state.modes.apply === 'down') return send(res, 503, { success: false, error: 'Applications are not being accepted just now. Please try again shortly.', code: 'unavailable' }, h);
  // The quiet traps: a bot is thanked and nothing is kept.
  if (fields.company_website || (Number(fields.elapsedMs) > 0 && Number(fields.elapsedMs) < 4000)) {
    log.note = 'honeypot';
    return send(res, 201, { success: true, reference: ref('GXA'), emailMasked: maskEmail(email) }, h);
  }
  if (email.startsWith('bot@')) return send(res, 403, { success: false, error: 'We could not verify this application. Please try again.', code: 'verification_failed' }, h);
  if (email.startsWith('rate@')) return send(res, 429, { success: false, error: 'Too many applications from here. Please try again later.', code: 'rate_limited', retryAfterSec: 1800 }, { ...h, 'Retry-After': '1800' });

  const c = state.careers;
  const openAllowed = Boolean(c.openApplication && c.openApplication.enabled);
  if (c.applicationsPaused) return send(res, 503, { success: false, error: 'Applications are paused for a short while. Please try again later.', code: 'applications_paused' }, h);
  const kind = fields.kind === 'open' ? 'open' : fields.kind === 'role' ? 'role' : '';
  const job = kind === 'role' ? c.jobs.find((j) => j.id === fields.jobId) : null;
  const gone = kind === 'role' && !job ? (c.recentlyClosed || []).find((r) => r.id === fields.jobId) : null;
  if (gone && gone.state === 'paused') {
    return send(res, 410, { success: false, error: 'This role is not taking applications right now.', code: 'job_paused', openApplication: openAllowed }, h);
  }
  if (email.startsWith('closed@') || gone) {
    return send(res, 410, { success: false, error: 'This role has closed.', code: 'job_closed', openApplication: openAllowed }, h);
  }
  if (kind === 'open' && !openAllowed) return send(res, 410, { success: false, error: 'Open applications are closed right now.', code: 'open_closed' }, h);

  const bad = {};
  if (!kind) bad.kind = 'Choose a role or an open application.';
  if (kind === 'role' && !job) bad.jobId = 'That role is not open.';
  for (const k of ['firstName', 'lastName']) {
    const v = String(fields[k] || '').trim();
    if (!v || v.length > 80) bad[k] = 'Please enter your name.';
  }
  if (!isEmail(email)) bad.email = 'Please enter a valid email.';
  if (!/^\+?\d{8,15}$/.test(String(fields.phone || '').replace(/[\s-]/g, ''))) bad.phone = 'Please enter a valid phone number.';
  const why = String(fields.whyGridX || '').trim();
  if (why.length < 30 || why.length > 3000) bad.whyGridX = 'Tell us a little more: at least 30 characters.';
  if (fields.availability && !AVAILABILITY.has(fields.availability)) bad.availability = 'Choose when you could start.';
  if (fields.consent !== 'true') bad.consent = 'Please agree so we can consider your application.';
  let answers = {};
  if (fields.answers) {
    answers = parseJson(Buffer.from(fields.answers)) || null;
    if (!answers || typeof answers !== 'object') { bad.answers = 'Answers could not be read.'; answers = {}; }
  }
  for (const q of (job && job.screeningQuestions) || []) {
    if (q.required && (answers[q.id] === undefined || answers[q.id] === '' || (Array.isArray(answers[q.id]) && !answers[q.id].length))) {
      bad[`answers.${q.id}`] = 'Please answer this question.';
    }
  }
  const needResume = Boolean(job && job.resumeRequired !== false);
  if (needResume && !resume) bad.resume = 'Please attach your resume.';
  if (Object.keys(bad).length) return send(res, 400, { success: false, error: 'Some details need another look.', code: 'invalid', fields: fieldList(bad) }, h);

  if (resume) {
    const max = (c.apply && c.apply.maxResumeBytes) || 10485760;
    if (resume.size > max) return send(res, 413, { success: false, error: 'That file is too large. The limit is 10 MB.', code: 'resume_too_large' }, h);
    if (!resumeKind(resume.name, Buffer.from(await resume.arrayBuffer()))) {
      return send(res, 415, { success: false, error: 'Please attach a PDF or a Word document.', code: 'resume_type' }, h);
    }
  }
  if (email.startsWith('dup@')) {
    return send(res, 409, { success: false, error: 'You have already applied for this role.', code: 'duplicate', appliedAt: '2026-10-01T10:00:00.000Z' }, h);
  }
  if (slow) await sleep(1500); // the "server is working on it" phase, after the upload
  log.note = slow ? 'slow' : undefined;
  return send(res, 201, { success: true, reference: ref('GXA'), emailMasked: maskEmail(email) }, h);
}

/** Paddock's 400 shape: a list of { field, message }. */
function fieldList(bad) {
  return Object.entries(bad).map(([field, message]) => ({ field, message }));
}

// ---------------------------------------------------------------- careers/schedule
// Four slots on one morning, 10:00 IST onwards, two hours apart; s3 is never free. For the
// "taken" token, s1 and s2 look free until someone tries to book one: then (as if another
// candidate got there first) the answer is 409 slot_taken, and from then on they show taken.
function slotsFor(state, token) {
  const base = Date.UTC(2026, 9, 14, 4, 30);
  const taken = new Set(['s3']);
  if (token === 'taken' && state.takenRevealed) { taken.add('s1'); taken.add('s2'); }
  return ['s1', 's2', 's3', 's4'].map((id, i) => ({
    id,
    startsAt: new Date(base + i * 2 * 3600000).toISOString(),
    endsAt: new Date(base + i * 2 * 3600000 + 45 * 60000).toISOString(),
    available: !taken.has(id),
  }));
}

async function schedule(state, req, res, log) {
  const h = corsHeaders(state, req);
  const body = parseJson((await readBody(req, { limit: 16384 })).buffer) || {};
  log.body = { ...body, t: body.t ? `${String(body.t).slice(0, 8)}...` : body.t };
  if (state.modes.schedule === 'down') return send(res, 503, { success: false, error: 'Scheduling is unavailable just now.', code: 'unavailable' }, h);
  const t = String(body.t || '');
  const known = ['valid', 'booked', 'late', 'taken', 'expired'];
  if (!known.includes(t)) return send(res, 404, { success: false, error: 'This link is not valid.', code: 'invalid_link' }, h);
  if (t === 'expired') return send(res, 410, { success: false, error: 'This link has expired.', code: 'expired' }, h);

  const slots = slotsFor(state, t);
  if ((t === 'booked' || t === 'late') && !state.bookings.has(t)) {
    state.bookings.set(t, { slotId: 's1', startsAt: slots[0].startsAt, endsAt: slots[0].endsAt, meetLink: 'https://meet.google.com/abc-defg-hij', calendarPending: false });
  }
  const booked = state.bookings.get(t) || null;
  const view = () => ({
    success: true,
    candidateFirstName: 'Asha',
    role: 'Embedded Firmware Engineer',
    round: { name: 'Technical interview', durationMin: 45, mode: 'meet', location: null },
    timeZone: 'Asia/Kolkata',
    expiresAt: '2026-10-13T18:29:59.000Z',
    slots: slotsFor(state, t),
    booked: state.bookings.get(t) || null,
    canReschedule: t !== 'late',
    canCancel: t !== 'late',
    changeDeadline: '2026-10-13T04:30:00.000Z',
  });

  switch (body.action) {
    case 'lookup':
      return send(res, 200, view(), h);
    case 'book':
    case 'reschedule': {
      if (t === 'late') return send(res, 422, { ...view(), success: false, error: 'It is too late to change this online. Please reply to the email.', code: 'too_late' }, h);
      if (body.action === 'book' && booked) return send(res, 410, { ...view(), success: false, error: 'You have already booked a time.', code: 'already_booked' }, h);
      if (t === 'taken' && !state.takenRevealed && (body.slotId === 's1' || body.slotId === 's2')) state.takenRevealed = true;
      const slot = slotsFor(state, t).find((s) => s.id === body.slotId);
      if (!slot || !slot.available) {
        return send(res, 409, { ...view(), success: false, error: 'Someone has just taken that time.', code: 'slot_taken' }, h);
      }
      state.bookings.set(t, { slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, meetLink: null, calendarPending: true });
      return send(res, 200, view(), h);
    }
    case 'cancel':
      if (t === 'late') return send(res, 422, { ...view(), success: false, error: 'It is too late to change this online. Please reply to the email.', code: 'too_late' }, h);
      state.bookings.delete(t);
      return send(res, 200, { ...view(), cancelled: true }, h);
    case 'request_other':
      return send(res, 200, { success: true, requested: true }, h);
    default:
      return send(res, 400, { success: false, error: 'Unknown action.', code: 'invalid' }, h);
  }
}

// ---------------------------------------------------------------- support
const TOPICS = new Set(['order', 'product', 'dealer', 'charging', 'other']);
const TIMES = new Set(['morning', 'afternoon', 'evening', 'any']);

async function support(state, req, res, log) {
  const h = corsHeaders(state, req);
  const body = parseJson((await readBody(req, { limit: 16384 })).buffer);
  log.body = body;
  if (!body || typeof body !== 'object') return send(res, 400, { success: false, error: 'That request could not be read.', code: 'invalid' }, h);
  if (state.modes.support === 'down' || body.name === 'Unavailable') {
    return send(res, 503, { success: false, error: 'We could not take your request just now. Please call or WhatsApp us.', code: 'unavailable' }, h);
  }
  if (body.company_website || (Number(body.elapsedMs) > 0 && Number(body.elapsedMs) < 3000)) {
    log.note = 'honeypot';
    return send(res, 201, { success: true, reference: ref('GXS') }, h);
  }
  if (body.name === 'Forbidden') return send(res, 403, { success: false, error: 'We could not verify this request. Please try again.', code: 'verification_failed' }, h);
  if (body.name === 'Rate Limited') {
    return send(res, 429, { success: false, error: 'Too many requests from here. Please try again later.', code: 'rate_limited', retryAfterSec: 3600 }, { ...h, 'Retry-After': '3600' });
  }
  const bad = {};
  if (body.kind !== 'callback' && body.kind !== 'message') bad.kind = 'Choose a callback or a message.';
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 80) bad.name = 'Please enter your name.';
  const digits = String(body.phone || '').replace(/\D/g, '');
  const mobile = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(mobile)) bad.phone = 'Please enter a 10 digit mobile number.';
  if (body.email && !isEmail(body.email)) bad.email = 'Please enter a valid email, or leave it empty.';
  if (!TOPICS.has(body.topic)) bad.topic = 'Choose what this is about.';
  const message = String(body.message || '').trim();
  if (message.length < 10 || message.length > 2000) bad.message = 'Please write at least 10 characters.';
  if (body.preferredTime && !TIMES.has(body.preferredTime)) bad.preferredTime = 'Choose a time.';
  if (body.consent !== true) bad.consent = 'Please agree so we can contact you.';
  if (Object.keys(bad).length) return send(res, 400, { success: false, error: 'Some details need another look.', code: 'invalid', fields: fieldList(bad) }, h);
  return send(res, 201, { success: true, reference: ref('GXS') }, h);
}

// ---------------------------------------------------------------- orders/track
const NOT_FOUND = { success: false, error: 'We could not find an order with those details.' };

function trackedOrder(reference) {
  const at = (d) => `2026-10-0${d}T06:30:00.000Z`;
  if (reference === 'GX-COLLECT1') {
    return {
      reference, headline: 'Ready for collection', summary: 'PowerPod Gen2 with the 6A charger', kind: 'powerpod',
      delivery: 'dealership', chargedInr: 5000, courier: null,
      steps: [
        { key: 'placed', label: 'Order placed', done: true, at: at(1) },
        { key: 'paid', label: 'Reservation paid', done: true, at: at(1) },
        { key: 'packed', label: 'Prepared', done: true, at: at(3) },
        { key: 'ready', label: 'Ready for collection', done: true, at: at(4) },
        { key: 'collected', label: 'Collected', done: false, at: null },
      ],
      collectFrom: {
        name: 'Okhla Swap Hub',
        address: 'D66, Pocket D, Okhla Phase 1, New Delhi 110020',
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=28.5355,77.273&query_place_id=ChIJokhla0001',
        phone: { display: '+91 98765 43201', e164: '+919876543201' },
        hoursNote: 'Open Monday to Saturday, 10 AM to 7 PM.',
      },
    };
  }
  if (reference === 'GX-SHIPPED1') {
    return {
      reference, headline: 'On its way', summary: 'Adapter and 6A Charger', kind: 'accessories',
      delivery: 'ship', chargedInr: 2759.86, courier: { partner: 'Delhivery', awb: '1234567890123' },
      steps: [
        { key: 'placed', label: 'Order placed', done: true, at: at(1) },
        { key: 'paid', label: 'Paid', done: true, at: at(1) },
        { key: 'packed', label: 'Packed', done: true, at: at(2) },
        { key: 'shipped', label: 'Shipped', done: true, at: at(3) },
        { key: 'delivered', label: 'Delivered', done: false, at: null },
      ],
      collectFrom: null,
    };
  }
  return null;
}

async function track(state, req, res, log) {
  const h = corsHeaders(state, req);
  const body = parseJson((await readBody(req, { limit: 4096 })).buffer) || {};
  log.body = { reference: body.reference, phone: body.phone ? 'given' : 'missing' }; // as Paddock: never the number
  if (state.modes.track === 'down') return send(res, 503, { success: false, error: 'Could not look that up just now.' }, h);
  if (state.modes.track === 'rate') return send(res, 429, { success: false, error: 'Too many attempts. Please try again in a few minutes.', retryAfterSec: 600 }, { ...h, 'Retry-After': '600' });
  const reference = String(body.reference || '').trim().toUpperCase();
  const phone = String(body.phone || '').replace(/\D/g, '').slice(-10);
  const order = phone === '9876543210' ? trackedOrder(reference) : null;
  if (!order) return send(res, 404, NOT_FOUND, h);
  return send(res, 200, { success: true, order }, h);
}

// ---------------------------------------------------------------- beacons
function cleanEvent(raw) {
  if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(EVENTS, raw.name)) return null;
  const props = {};
  const given = raw.props && typeof raw.props === 'object' ? raw.props : {};
  for (const p of EVENTS[raw.name]) {
    const v = given[p];
    if (v === undefined) continue;
    if (ENUMS[p] && !ENUMS[p].includes(v)) continue;
    if (p === 'slug' && !(v === 'open' || (typeof v === 'string' && v.length >= 3 && v.length <= 48 && SLUG.test(v)))) continue;
    if (typeof v !== 'string' || v.length > 60) continue;
    props[p] = v;
  }
  return { name: raw.name, props };
}

async function beacon(state, req, res, log, kind) {
  const h = { ...corsHeaders(state, req), 'Cache-Control': 'no-store' };
  const { buffer, tooBig } = await readBody(req, { limit: kind === 'event' ? 8192 : 4096 });
  const ct = String(req.headers['content-type'] || '');
  log.contentType = ct;
  if (state.modes.beacons === 'rate') {
    res.writeHead(429, h);
    res.end();
    return;
  }
  const body = tooBig ? null : parseJson(buffer);
  if (!body || typeof body !== 'object') {
    log.note = tooBig ? 'oversize' : 'junk';
  } else if (kind === 'event') {
    const list = Array.isArray(body.events) ? body.events : [];
    const kept = list.slice(0, 20).map(cleanEvent);
    log.body = {
      sid: body.sid ? 'given' : undefined,
      accepted: kept.filter(Boolean),
      dropped: kept.filter((e) => !e).length + Math.max(0, list.length - 20),
    };
  } else {
    log.body = { ...body, sid: body.sid ? 'given' : undefined };
  }
  // Text, as the site sends it, is what keeps a beacon free of a preflight; JSON is accepted too.
  log.simple = /^text\/plain/i.test(ct);
  res.writeHead(204, h);
  res.end();
}

// ---------------------------------------------------------------- the server
export async function startMock({ port = 3000, quiet = false } = {}) {
  let state = freshState();
  const base = `http://localhost:${port}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const p = url.pathname;
    const entry = { seq: ++state.seq, at: new Date().toISOString(), method: req.method, path: p + url.search, origin: req.headers.origin || null };
    let logged = false;
    const finish = () => {
      if (logged || entry.unlogged) return;
      logged = true;
      // A client that gave up (the build's timeout, a cancelled upload) is logged as such.
      entry.status = res.writableFinished ? res.statusCode : 'aborted';
      state.log.push(entry);
      if (!quiet) console.log(`${entry.status} ${req.method} ${entry.path}${entry.note ? ` (${entry.note})` : ''}`);
    };
    res.on('finish', finish);
    res.on('close', finish);

    try {
      // Preflight, for every route: what the site sends with JSON, an upload with progress,
      // or a control call from a page.
      if (req.method === 'OPTIONS') {
        const h = corsHeaders(state, req);
        if (h['Access-Control-Allow-Origin']) {
          h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
          h['Access-Control-Allow-Headers'] = req.headers['access-control-request-headers'] || 'Content-Type';
          h['Access-Control-Max-Age'] = '600';
        }
        res.writeHead(204, h);
        res.end();
        return;
      }

      // The controls.
      if (p === '/__mock/reset' && req.method === 'POST') {
        const seq = state.seq;
        state = freshState();
        state.seq = seq;
        return send(res, 200, { ok: true }, corsHeaders(state, req));
      }
      if (p === '/__mock/state' && req.method === 'POST') {
        const body = parseJson((await readBody(req, { limit: 1 << 20 })).buffer);
        if (!body) return send(res, 400, { ok: false, error: 'JSON please' }, corsHeaders(state, req));
        applyState(state, body);
        return send(res, 200, { ok: true, modes: state.modes, careersVersion: state.careers.version, dealersVersion: state.dealers.version }, corsHeaders(state, req));
      }
      if (p === '/__mock/state' && req.method === 'GET') {
        return send(res, 200, { modes: state.modes, careersVersion: state.careers.version, dealersVersion: state.dealers.version }, corsHeaders(state, req));
      }
      if (p === '/__mock/log' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since')) || 0;
        // Not logged itself, so reading the log does not grow it.
        entry.unlogged = true;
        return send(res, 200, { entries: state.log.filter((e) => e.seq > since) }, corsHeaders(state, req));
      }

      if (!p.startsWith(`${API}/`)) return send(res, 404, { success: false, error: 'Not found' });
      const route = p.slice(API.length + 1);
      if (state.modes.latencyMs > 0) await sleep(state.modes.latencyMs);

      if (req.method === 'GET' && (route === 'careers' || route === 'dealers')) {
        const mode = state.modes[route];
        if (mode === 'slow') await sleep(state.modes.slowMs);
        if (mode === 'error') return send(res, 500, { success: false, error: 'Something went wrong.' }, corsHeaders(state, req));
        if (mode === 'invalid') return send(res, 200, { hello: 'world' }, corsHeaders(state, req));
        if (mode === 'html') return send(res, 200, Buffer.from('<!doctype html><title>Sign in to Wi-Fi</title>'), { ...corsHeaders(state, req), 'Content-Type': 'text/html' });
        const doc = route === 'careers' ? state.careers : state.dealers;
        entry.version = doc.version;
        return cacheable(state, req, res, localise(doc, base), doc.version, route === 'careers' ? CAREERS_CACHE : DEALERS_CACHE);
      }

      let m;
      if (req.method === 'GET' && (m = /^dealers\/photo\/([A-Za-z0-9_-]+)-(320|640|1280)\.webp$/.exec(route))) {
        const dealer = state.dealers.dealers.find((d) => d.id === m[1] && d.photo);
        if (!dealer) return send(res, 404, { success: false, error: 'Not found' }, corsHeaders(state, req));
        const current = new URL(dealer.photo.url).searchParams.get('v') || '';
        const fresh = url.searchParams.get('v') === current;
        const img = fs.readFileSync(path.join(FIXTURES, 'dealer.webp'));
        return send(res, 200, img, {
          ...corsHeaders(state, req),
          'Content-Type': 'image/webp',
          ETag: `"p-${m[1]}-${current}-${m[2]}"`,
          'Cache-Control': fresh ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
        });
      }
      if (req.method === 'GET' && (m = /^careers\/og\/([a-z0-9-]+)\.jpg$/.exec(route))) {
        const known = m[1] === 'careers' || state.careers.jobs.some((j) => j.slug === m[1]);
        if (!known) return send(res, 404, { success: false, error: 'Not found' }, corsHeaders(state, req));
        const img = fs.readFileSync(path.join(FIXTURES, 'og.jpg'));
        return send(res, 200, img, { ...corsHeaders(state, req), 'Content-Type': 'image/jpeg', ETag: `"og-${m[1]}-${state.careers.version}"`, 'Cache-Control': 'public, max-age=300' });
      }

      if (req.method === 'POST') {
        if (route === 'careers/apply') return await apply(state, req, res, entry);
        if (route === 'careers/schedule') return await schedule(state, req, res, entry);
        if (route === 'support') return await support(state, req, res, entry);
        if (route === 'orders/track') return await track(state, req, res, entry);
        if (route === 'pageview' || route === 'event' || route === 'live') return await beacon(state, req, res, entry, route);
      }
      return send(res, 404, { success: false, error: 'Not found' }, corsHeaders(state, req));
    } catch (err) {
      entry.note = `mock error: ${err.message}`;
      if (!res.headersSent) send(res, 500, { success: false, error: 'The mock failed.' });
      else res.end();
    }
  });

  // Both stacks: a browser may reach "localhost" over IPv6 or IPv4.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '::', ipv6Only: false }, resolve);
  });
  if (!quiet) console.log(`Paddock mock on ${base}${API}/ (controls at ${base}/__mock/state, /__mock/log, /__mock/reset)`);
  return {
    server,
    url: base,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  startMock({ port: Number(opt('port', 3000)), quiet: args.includes('--quiet') }).catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${opt('port', 3000)} is taken (is Paddock running?)` : err);
    process.exit(1);
  });
}
