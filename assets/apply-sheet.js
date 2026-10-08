/*
 * The careers application: one sheet, for a role or for an open application.
 *
 * How a sheet behaves (open, close, Esc, the backdrop, a swipe, the field gathering behind
 * the glass) is sheet.js's; how a field looks is fields.css's; the careers document comes
 * from careers-data.js. This file owns what is inside the sheet, three views in one dialog:
 *
 *   1. intro   the role in brief (or what an open application is) and what we will ask
 *   2. form    the application itself
 *   3. done    the reference, and where the confirmation went
 *
 * USE, from any page that loads gridx-api.js, sheet.js, keyboard.js, careers-icons.js,
 * careers-data.js and this file (and links sheet.css, fields.css and apply-sheet.css):
 *
 *   gridApply.open({ job })                  a role: the job object, or its id or slug
 *   gridApply.open({ open: true })           an open application
 *   gridApply.open({ job, source: { page } })   page overrides location.pathname in the
 *                                            source sent with the application
 *   gridApply.open({ ..., returnTo })        where focus goes when the sheet closes
 *                                            (default: whatever had focus)
 *   gridApply.close(), gridApply.isOpen()
 *
 * Or with no script at all: any element carrying data-apply="<slug or id>" or
 * data-apply="open" opens the sheet when clicked. A page that drives the particle field
 * itself sets data-apply-halo="off" on <html>; otherwise the sheet gathers the field.
 *
 * WHAT IS SENT is exactly Paddock's contract for POST careers/apply (multipart), checked
 * here first the way Paddock checks it (applicationModel.js), so a mistake is pointed out
 * on the field before anything is uploaded. Paddock's own answer still wins: a 400 lands
 * on the fields it names, answers.<question id> included.
 *
 * WHAT IS KEPT. A draft of the form, per role (and one for an open application), in
 * sessionStorage, so a closed sheet or a reload loses nothing; the contact details are also
 * kept on their own so a second application starts filled in. Never the resume file, never
 * either consent, never the honeypot, and all of it dies with the tab. Nothing personal
 * ever goes to analytics: the events carry the role's slug and nothing else.
 *
 * The markup below is a constant with nothing interpolated into it. Everything that comes
 * from Paddock (a title, a question, the consent wording) goes in as text, never as markup.
 */
(() => {
  'use strict';

  if (window.gridApply) return;
  if (!window.gridSheet || typeof window.gridSheet.create !== 'function') return;

  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const APPLY_PATH = '/api/public/website/careers/apply';
  const DEFAULTS = {
    maxResumeBytes: 10485760,
    accept: ['.pdf', '.doc', '.docx'],
    recaptchaAction: 'careers_apply',
    recaptchaActionOpen: 'careers_open_application',
    consent: null,
    howHeard: [],
  };
  // Paddock's lists (applicationView.js AVAILABILITY, applicationModel.js INTEREST_TYPES).
  const AVAILABILITY = [
    ['immediately', 'Immediately'],
    ['1m', 'Within a month'],
    ['2m', 'Within two months'],
    ['3m', 'Within three months'],
    ['date', 'From a date'],
  ];
  const INTEREST_TYPES = [
    ['any', 'Any'],
    ['full-time', 'Full time'],
    ['internship', 'Internship'],
    ['part-time', 'Part time'],
    ['contract', 'Contract'],
  ];
  const EMPLOYMENT = { 'full-time': 'Full time', 'part-time': 'Part time', internship: 'Internship', contract: 'Contract' };
  const WORK_MODE = { onsite: 'On site', hybrid: 'Hybrid', remote: 'Remote' };
  const MAX_INTERESTS = 5;
  const TEXT_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'city', 'linkedinUrl', 'portfolioUrl', 'whyGridX'];
  const ME_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'city', 'linkedinUrl', 'portfolioUrl'];
  const DRAFT_PREFIX = 'gridx.apply.draft.';
  const ME_KEY = 'gridx.apply.me';

  const ICON = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M12 17v-5.5m-2.25 2.25L12 11.5l2.25 2.25"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 12.5 3.5 3.5 7.5-8"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    mode: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9.5 20v-5h5v5"/></svg>',
  };

  // ---------------------------------------------------------------- the markup
  const SHELL = `
    <div class="story__grabber" aria-hidden="true"></div>
    <button class="story__close" type="button" aria-label="Close">${ICON.close}</button>

    <form class="apply" novalidate>
      <div class="story__scroll apply__scroll">

        <section class="apply__view" data-view="intro">
          <p class="apply__eyebrow" data-ref="eyebrow"></p>
          <h2 class="apply__title" id="apply-intro-title" tabindex="-1" data-ref="introTitle"></h2>
          <p class="apply__lede" data-ref="introLede"></p>
          <ul class="apply__chips" data-ref="introChips"></ul>
          <div class="apply__notice" data-ref="introNotice" role="status" hidden></div>
          <div class="apply__ask">
            <h3 class="apply__sub">What we will ask</h3>
            <ul class="apply__steps" data-ref="introSteps"></ul>
            <p class="apply__note">It takes about five minutes. What you write is kept in this tab until you send it, so you can close this and come back.</p>
          </div>
        </section>

        <section class="apply__view" data-view="form" hidden>
          <p class="apply__eyebrow" data-ref="formEyebrow"></p>
          <h2 class="apply__title apply__title--form" id="apply-form-title" tabindex="-1" data-ref="formTitle"></h2>
          <div class="apply__notice" data-ref="formNotice" role="alert" tabindex="-1" hidden></div>

          <fieldset class="apply__group">
            <legend class="apply__sub">About you</legend>
            <div class="field-row">
              <div class="field">
                <label class="field__label" for="ap-firstName">First name</label>
                <input class="field__input" id="ap-firstName" name="firstName" type="text" maxlength="60"
                       autocomplete="given-name" autocapitalize="words" spellcheck="false"
                       aria-describedby="ap-firstName-err">
                <p class="field__err" id="ap-firstName-err"></p>
              </div>
              <div class="field">
                <label class="field__label" for="ap-lastName">Last name</label>
                <input class="field__input" id="ap-lastName" name="lastName" type="text" maxlength="60"
                       autocomplete="family-name" autocapitalize="words" spellcheck="false"
                       aria-describedby="ap-lastName-err">
                <p class="field__err" id="ap-lastName-err"></p>
              </div>
            </div>
            <div class="field">
              <label class="field__label" for="ap-email">Email</label>
              <input class="field__input" id="ap-email" name="email" type="email" maxlength="160"
                     inputmode="email" autocomplete="email" spellcheck="false" autocapitalize="off"
                     aria-describedby="ap-email-hint ap-email-err">
              <p class="field__hint" id="ap-email-hint">Your confirmation goes here.</p>
              <p class="field__err" id="ap-email-err"></p>
            </div>
            <div class="field">
              <label class="field__label" for="ap-phone">Phone</label>
              <input class="field__input" id="ap-phone" name="phone" type="tel" maxlength="20"
                     inputmode="tel" autocomplete="tel" placeholder="98765 43210"
                     aria-describedby="ap-phone-hint ap-phone-err">
              <p class="field__hint" id="ap-phone-hint">A 10 digit mobile number. Outside India, start with + and the country code.</p>
              <p class="field__err" id="ap-phone-err"></p>
            </div>
            <div class="field">
              <label class="field__label" for="ap-city">City you live in</label>
              <input class="field__input" id="ap-city" name="city" type="text" maxlength="60"
                     autocomplete="address-level2" autocapitalize="words"
                     aria-describedby="ap-city-err">
              <p class="field__err" id="ap-city-err"></p>
            </div>
            <div class="field">
              <label class="field__label" for="ap-linkedinUrl">LinkedIn <span class="field__opt">optional</span></label>
              <input class="field__input" id="ap-linkedinUrl" name="linkedinUrl" type="url" maxlength="300"
                     inputmode="url" autocomplete="url" spellcheck="false" autocapitalize="off"
                     placeholder="linkedin.com/in/your-name" aria-describedby="ap-linkedinUrl-err">
              <p class="field__err" id="ap-linkedinUrl-err"></p>
            </div>
            <div class="field">
              <label class="field__label" for="ap-portfolioUrl">Portfolio or GitHub <span class="field__opt">optional</span></label>
              <input class="field__input" id="ap-portfolioUrl" name="portfolioUrl" type="url" maxlength="300"
                     inputmode="url" spellcheck="false" autocapitalize="off"
                     placeholder="github.com/your-name" aria-describedby="ap-portfolioUrl-err">
              <p class="field__err" id="ap-portfolioUrl-err"></p>
            </div>
          </fieldset>

          <div class="apply__group">
            <h3 class="apply__sub" id="ap-resume-label">Resume <span class="field__opt" data-ref="resumeOpt" hidden>optional</span></h3>
            <div class="field" data-field="resume">
              <label class="file" data-ref="drop">
                <input class="file__input" id="ap-resume" type="file" accept=".pdf,.doc,.docx"
                       aria-labelledby="ap-resume-label" aria-describedby="ap-resume-note ap-resume-err">
                <span class="file__icon" aria-hidden="true">${ICON.file}</span>
                <span class="file__text">
                  <span class="file__title">Choose a file or drop it here</span>
                  <span class="file__note" id="ap-resume-note" data-ref="resumeNote">PDF or Word, up to 10 MB</span>
                </span>
              </label>
              <div class="file__chosen" data-ref="chosen" hidden>
                <span class="file__name" data-ref="fileName"></span>
                <span class="file__size" data-ref="fileSize"></span>
                <span class="file__actions">
                  <button class="file__action" type="button" data-ref="fileReplace">Replace</button>
                  <button class="file__action" type="button" data-ref="fileRemove">Remove</button>
                </span>
              </div>
              <p class="field__err" id="ap-resume-err" aria-live="polite"></p>
            </div>
          </div>

          <div class="apply__group">
            <div class="field">
              <label class="apply__sub apply__sub--label" for="ap-whyGridX">Why GridX?</label>
              <textarea class="field__input" id="ap-whyGridX" name="whyGridX" maxlength="3000" rows="5"
                        placeholder="What draws you to this work, and what would you bring to it?"
                        aria-describedby="ap-whyGridX-hint ap-whyGridX-err ap-whyGridX-count"></textarea>
              <div class="field__foot">
                <p class="field__hint" id="ap-whyGridX-hint">A few honest lines is plenty: at least 30 characters.</p>
                <p class="field__err" id="ap-whyGridX-err"></p>
                <p class="field__count" id="ap-whyGridX-count" data-ref="whyCount">0 / 3000</p>
              </div>
            </div>
          </div>

          <div class="apply__group">
            <fieldset class="choices field" data-field="availability" aria-describedby="ap-availability-err">
              <legend class="apply__sub">When could you start?</legend>
              <div class="choices__list" data-ref="availability"></div>
              <p class="field__err" id="ap-availability-err"></p>
            </fieldset>
            <div class="field apply__date" data-ref="dateWrap" hidden>
              <label class="field__label" for="ap-availableFrom">From</label>
              <input class="field__input" id="ap-availableFrom" name="availableFrom" type="date"
                     aria-describedby="ap-availableFrom-err">
              <p class="field__err" id="ap-availableFrom-err"></p>
            </div>
          </div>

          <div class="apply__group" data-ref="questionsGroup" hidden>
            <h3 class="apply__sub">About this role</h3>
            <div data-ref="questions"></div>
          </div>

          <div class="apply__group" data-ref="interestGroup" hidden>
            <fieldset class="choices field" data-field="interestDomains" aria-describedby="ap-interestDomains-hint ap-interestDomains-err">
              <legend class="apply__sub">Teams you would like to join</legend>
              <div class="choices__list" data-ref="interestDomains"></div>
              <p class="field__hint" id="ap-interestDomains-hint">Choose up to five.</p>
              <p class="field__err" id="ap-interestDomains-err"></p>
            </fieldset>
            <fieldset class="choices field" data-field="interestType">
              <legend class="field__label">Kind of role</legend>
              <div class="choices__list" data-ref="interestType"></div>
            </fieldset>
          </div>

          <div class="apply__group">
            <div class="field">
              <label class="field__label" for="ap-howHeard">How did you hear about us? <span class="field__opt">optional</span></label>
              <select class="field__input is-empty" id="ap-howHeard" name="howHeard"></select>
            </div>
          </div>

          <div class="apply__group apply__group--consent">
            <div class="field" data-field="consent">
              <label class="check">
                <input class="check__input" id="ap-consent" type="checkbox" aria-describedby="ap-consent-err">
                <span class="check__box" aria-hidden="true">${ICON.check}</span>
                <span class="check__label"><span data-ref="consentText"></span> <a data-ref="privacy" target="_blank" rel="noopener">Privacy policy</a></span>
              </label>
              <p class="field__err" id="ap-consent-err"></p>
            </div>
            <label class="check">
              <input class="check__input" id="ap-talentPool" type="checkbox">
              <span class="check__box" aria-hidden="true">${ICON.check}</span>
              <span class="check__label" data-ref="talentText"></span>
            </label>
          </div>

          <div class="apply__trap" aria-hidden="true">
            <label for="ap-company">Company website</label>
            <input id="ap-company" name="company_website" type="text" tabindex="-1" autocomplete="off">
          </div>
        </section>

        <section class="apply__view apply__done" data-view="done" hidden>
          <span class="apply__done-mark" aria-hidden="true">${ICON.check}</span>
          <h2 class="apply__title" id="apply-done-title" tabindex="-1">Application sent.</h2>
          <p class="apply__done-ref">Your reference <strong data-ref="doneRef"></strong></p>
          <p class="apply__done-line" data-ref="doneMail"></p>
          <p class="apply__done-line apply__done-line--quiet">We read every application ourselves. If your experience fits what we are building, we will write to you to arrange a first conversation.</p>
        </section>
      </div>

      <div class="apply__foot">
        <div class="apply__bar">
          <button class="apply__secondary" type="button" data-ref="cancel" hidden>Cancel</button>
          <button class="apply__primary" type="submit" data-ref="primary">
            <span class="apply__fill" aria-hidden="true"></span>
            <span class="apply__label" data-ref="primaryLabel">Continue</span>
          </button>
        </div>
        <p class="apply__hint" data-ref="hint" role="status" aria-live="polite"></p>
        <p class="apply__legal" data-ref="legal">Protected by reCAPTCHA: Google's <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> apply.</p>
      </div>
    </form>`;

  const sheetEl = document.createElement('dialog');
  sheetEl.className = 'story story--apply';
  sheetEl.id = 'apply-sheet';
  sheetEl.setAttribute('aria-labelledby', 'apply-intro-title');
  sheetEl.innerHTML = SHELL;
  document.body.appendChild(sheetEl);

  const form = sheetEl.querySelector('.apply');
  const scroller = sheetEl.querySelector('.apply__scroll');
  const views = Object.fromEntries([...sheetEl.querySelectorAll('[data-view]')].map((v) => [v.dataset.view, v]));
  const ref = Object.fromEntries([...sheetEl.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  const resumeInput = sheetEl.querySelector('#ap-resume');
  const honeypot = sheetEl.querySelector('#ap-company');
  const consentInput = sheetEl.querySelector('#ap-consent');
  const talentInput = sheetEl.querySelector('#ap-talentPool');
  const dateInput = sheetEl.querySelector('#ap-availableFrom');
  const howHeardInput = sheetEl.querySelector('#ap-howHeard');

  // ---------------------------------------------------------------- small helpers
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const icon = (svg) => {
    const span = el('span', 'apply__icon');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = svg; // a constant from ICON or gridIcons, never anything from the network
    return span;
  };
  const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const store = {
    get(key) {
      try { return JSON.parse(window.sessionStorage.getItem(key) || 'null'); } catch (_) { return null; }
    },
    set(key, value) {
      try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode: no draft */ }
    },
    remove(key) {
      try { window.sessionStorage.removeItem(key); } catch (_) { /* nothing kept */ }
    },
  };
  const track = (name, props) => {
    try { if (typeof window.gridTrack === 'function') window.gridTrack(name, props); } catch (_) { /* never in the way */ }
  };
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace(/\.0$/, '')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const count = (n) => (n < WORDS.length ? WORDS[n] : String(n));
  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const fmtDate = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(t);
  };
  const todayIst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(Date.now());

  // ---------------------------------------------------------------- where the visit came from
  // A campaign's utm_ tags, as analytics.js keeps them: from the first page in this tab that
  // carried any, under the same key and in the same shape (gridx.utm, {source, medium, ...},
  // cleaned the way Paddock cleans them), so an application sent three pages later still says
  // where the visit started. Written here only if analytics.js has not (it loads after this).
  // The outside site that sent the visitor is kept beside it, as a host and nothing more.
  const UTM_KEY = 'gridx.utm';
  const REF_KEY = 'gridx.apply.ref';
  const UTM_FIELDS = ['source', 'medium', 'campaign', 'content'];
  const utmValue = (raw) => {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase().replace(/[\s.]+/g, '_').slice(0, 60);
    return /^[a-z0-9][a-z0-9_+-]{0,59}$/.test(v) ? v : null;
  };
  function utmFrom(get) {
    const out = {};
    for (const f of UTM_FIELDS) {
      const v = utmValue(get(f));
      if (v) out[f] = v;
    }
    return Object.keys(out).length ? out : null;
  }
  (function rememberSource() {
    try {
      const kept = store.get(UTM_KEY);
      if (!(kept && utmFrom((f) => kept[f]))) {
        const params = new URLSearchParams(location.search);
        const utm = utmFrom((f) => params.get(`utm_${f}`));
        if (utm) store.set(UTM_KEY, utm);
      }
      if (!store.get(REF_KEY)) {
        const r = document.referrer ? new URL(document.referrer) : null;
        if (r && r.host !== location.host) store.set(REF_KEY, r.host.slice(0, 80));
      }
    } catch (_) { /* nothing to remember */ }
  }());

  function sourcePayload(page) {
    const kept = store.get(UTM_KEY);
    const utm = kept && typeof kept === 'object' ? utmFrom((f) => kept[f]) : null;
    const ref = store.get(REF_KEY);
    return { utm, page: String(page || location.pathname).slice(0, 120), referrerHost: typeof ref === 'string' ? ref : null };
  }

  // ---------------------------------------------------------------- the careers document
  const careers = () => window.gridCareers;
  const doc = () => (careers() && careers().get().data) || null;

  function config() {
    const d = doc();
    const apply = (d && d.apply) || {};
    return {
      ...DEFAULTS,
      ...apply,
      openApplication: Boolean(d && d.openApplication && d.openApplication.enabled),
      applicationsPaused: Boolean(d && d.applicationsPaused),
      careersEmail: (d && d.org && d.org.careersEmail) || 'careers@gridxenergy.in',
      domains: (d && Array.isArray(d.domains) ? d.domains.slice() : []).sort((a, b) => (a.order || 0) - (b.order || 0)),
      ready: Boolean(apply.consent && apply.consent.version),
    };
  }

  /** A role, from whatever the opener had: the freshest copy the page holds wins. */
  function resolveJob(input) {
    const c = careers();
    const known = c && input ? c.findJob(input) : null;
    if (known) return known;
    return input && typeof input === 'object' && input.id ? input : null;
  }

  // ---------------------------------------------------------------- the application in hand
  let app = { kind: 'role', job: null, key: '', page: '' };
  let view = 'intro';
  let busy = false;
  let sent = false;
  let startedAt = 0;
  let resumeFile = null;
  let questionSig = '';
  let controller = null;
  let keyboard = null;
  let saveTimer = 0;

  const draftKey = () => DRAFT_PREFIX + app.key;
  const trackSlug = () => (app.kind === 'open' ? 'open' : (app.job && app.job.slug) || 'open');

  // ---------------------------------------------------------------- fields
  // name -> { input(s), wrap, err, check }. check(value) returns '' or the message to show.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /** Paddock's normalizeApplicantPhone: +91 for a bare Indian mobile, else + and 8 to 15 digits. */
  function normalizePhone(raw) {
    const s = String(raw || '').trim();
    const digits = s.replace(/\D/g, '');
    if (/^[6-9]\d{9}$/.test(digits) && !s.startsWith('+')) return `+91${digits}`;
    if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
    if (/^91[6-9]\d{9}$/.test(digits) && !s.startsWith('+')) return `+${digits}`;
    if (s.startsWith('+') && /^\d{8,15}$/.test(digits)) return `+${digits}`;
    return null;
  }

  /** Paddock's normalizeLink: https only, a real host, no credentials. undefined = bad. */
  function normalizeLink(raw, host) {
    const s = String(raw || '').trim().slice(0, 300);
    if (!s) return null;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch (_) {
      return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password || !url.hostname.includes('.')) return undefined;
    if (host && !url.hostname.replace(/^www\./, '').endsWith(host)) return undefined;
    url.protocol = 'https:';
    return url.toString();
  }

  const fields = {};

  function registerText(name, check) {
    const input = form.querySelector(`[name="${name}"]`);
    const wrap = input.closest('.field');
    fields[name] = { input, wrap, err: wrap.querySelector('.field__err'), check, value: () => input.value };
  }

  registerText('firstName', (v) => (v.trim() ? '' : 'Enter your first name.'));
  registerText('lastName', (v) => (v.trim() ? '' : 'Enter your last name.'));
  registerText('email', (v) => (EMAIL_RE.test(v.trim()) ? '' : 'Enter a valid email address.'));
  registerText('phone', (v) => (normalizePhone(v) ? '' : 'Enter a phone number. Outside India, start with + and the country code.'));
  registerText('city', (v) => (v.trim().length >= 2 ? '' : 'Enter the city you live in.'));
  registerText('linkedinUrl', (v) => (normalizeLink(v, 'linkedin.com') === undefined ? 'That does not look like a LinkedIn link.' : ''));
  registerText('portfolioUrl', (v) => (normalizeLink(v) === undefined ? 'Enter a link that starts with https://' : ''));
  registerText('whyGridX', (v) => {
    const n = v.trim().length;
    if (n < 30) return n ? `Tell us a little more: ${30 - n} more character${30 - n === 1 ? '' : 's'} at least.` : 'Tell us a little about why GridX: at least 30 characters.';
    if (n > 3000) return 'Keep it under 3000 characters.';
    return '';
  });
  registerText('availableFrom', (v) => {
    if (checkedValue('availability') !== 'date') return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Choose the date you could start.';
    return v < todayIst() ? 'Choose a date from today on.' : '';
  });

  function checkedValue(name) {
    const hit = form.querySelector(`input[name="${name}"]:checked`);
    return hit ? hit.value : '';
  }
  function checkedValues(name) {
    return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  }

  const chipsField = (name) => {
    const wrap = form.querySelector(`[data-field="${name}"]`);
    return { wrap, err: wrap.querySelector('.field__err') };
  };
  fields.availability = { ...chipsField('availability'), check: () => (checkedValue('availability') ? '' : 'Choose when you could start.'), value: () => checkedValue('availability') };
  fields.interestDomains = {
    ...chipsField('interestDomains'),
    check: () => {
      if (app.kind !== 'open') return '';
      const n = checkedValues('interestDomains').length;
      if (!n) return 'Choose at least one team.';
      return n > MAX_INTERESTS ? `Choose up to ${MAX_INTERESTS}.` : '';
    },
    value: () => checkedValues('interestDomains'),
  };
  fields.consent = {
    ...chipsField('consent'),
    input: consentInput,
    check: () => (consentInput.checked ? '' : 'Please agree so we can consider your application.'),
    value: () => consentInput.checked,
  };
  fields.resume = {
    ...chipsField('resume'),
    input: resumeInput,
    check: () => (!resumeFile && resumeRequired() ? 'Attach your resume.' : ''),
    value: () => resumeFile,
  };

  function resumeRequired() {
    return app.kind === 'open' || !app.job || app.job.resumeRequired !== false;
  }

  function showError(name, message) {
    const f = fields[name];
    if (!f) return false;
    if (f.err) f.err.textContent = message || '';
    if (f.wrap) f.wrap.classList.toggle('is-bad', Boolean(message));
    const inputs = f.inputs || (f.input ? [f.input] : []);
    for (const i of inputs) {
      if (message) i.setAttribute('aria-invalid', 'true');
      else i.removeAttribute('aria-invalid');
    }
    return true;
  }

  // check() for the chips, the file and the consent read their own state, not a string.
  const messageFor = (name) => {
    const f = fields[name];
    if (!f || !f.check) return '';
    const v = f.value ? f.value() : '';
    return f.check(typeof v === 'string' ? v : '');
  };

  /** Every field checked, errors shown; the first bad one, or null. */
  function validateAll() {
    let first = null;
    for (const name of Object.keys(fields)) {
      if (!isLive(name)) { showError(name, ''); continue; }
      const msg = messageFor(name);
      showError(name, msg);
      if (msg && !first) first = name;
    }
    return first;
  }

  /** Whether a field is part of this application (open applications have no questions). */
  function isLive(name) {
    if (name.startsWith('answers.')) return app.kind === 'role';
    if (name === 'interestDomains') return app.kind === 'open';
    return true;
  }

  function focusField(name) {
    const f = fields[name];
    if (!f) return;
    const target = (f.inputs && f.inputs[0]) || f.input || (f.wrap && f.wrap.querySelector('input, textarea, select, button'));
    const block = f.wrap || target;
    if (block) block.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    if (target) target.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- chips
  function chip(type, name, value, label, extraClass) {
    const lab = el('label', `choice${extraClass ? ` ${extraClass}` : ''}`);
    const input = el('input', 'choice__input');
    input.type = type;
    input.name = name;
    input.value = value;
    const span = el('span', 'choice__label', label);
    lab.append(input, span);
    return lab;
  }

  for (const [value, label] of AVAILABILITY) ref.availability.append(chip('radio', 'availability', value, label));
  fields.availability.inputs = [...ref.availability.querySelectorAll('input')];
  for (const [value, label] of INTEREST_TYPES) ref.interestType.append(chip('radio', 'interestType', value, label));

  function renderDomains() {
    const { domains } = config();
    const picked = new Set(checkedValues('interestDomains'));
    ref.interestDomains.textContent = '';
    for (const d of domains) {
      const c = chip('checkbox', 'interestDomains', d.key, d.label);
      const span = c.querySelector('.choice__label');
      if (window.gridIcons) {
        const i = el('span', 'apply__chip-icon');
        i.setAttribute('aria-hidden', 'true');
        i.innerHTML = window.gridIcons.svg(d.icon, { size: 18 });
        span.prepend(i);
      }
      if (picked.has(d.key)) c.querySelector('input').checked = true;
      ref.interestDomains.append(c);
    }
    fields.interestDomains.inputs = [...ref.interestDomains.querySelectorAll('input')];
  }

  function renderHowHeard() {
    const { howHeard } = config();
    const current = howHeardInput.value;
    howHeardInput.textContent = '';
    const first = el('option', '', 'Choose one');
    first.value = '';
    howHeardInput.append(first);
    for (const h of howHeard) {
      const o = el('option', '', h);
      o.value = h;
      howHeardInput.append(o);
    }
    howHeardInput.value = howHeard.includes(current) ? current : '';
    howHeardInput.classList.toggle('is-empty', !howHeardInput.value);
  }

  function renderConsent() {
    const { consent } = config();
    ref.consentText.textContent = (consent && consent.text) || 'I agree that GridX may keep my application to consider me for this role.';
    ref.talentText.textContent = (consent && consent.talentPoolText) || 'Also keep my details for twelve months and tell me about other roles that fit.';
    const url = consent && consent.privacyUrl;
    ref.privacy.href = typeof url === 'string' && /^(https:\/\/|\/)/.test(url) ? url : 'https://gridxenergy.in/privacy_policy.html';
  }

  // ---------------------------------------------------------------- screening questions
  function clearQuestions() {
    for (const name of Object.keys(fields)) if (name.startsWith('answers.')) delete fields[name];
    ref.questions.textContent = '';
  }

  function questionMark(required) {
    const mark = el('span', required ? 'field__opt apply__req' : 'field__opt', required ? 'required' : 'optional');
    return mark;
  }

  function questionCheck(q, read) {
    return () => {
      const raw = read();
      const empty = raw === '' || raw === null || (Array.isArray(raw) && !raw.length);
      if (empty) return q.required ? 'Please answer this.' : '';
      switch (q.type) {
        case 'short_text':
        case 'long_text': {
          const max = q.maxLength || 2000;
          return raw.trim().length > max ? `Keep it under ${max} characters.` : '';
        }
        case 'yes_no': return raw === 'yes' || raw === 'no' ? '' : 'Choose yes or no.';
        case 'single_select': return q.options.includes(raw) ? '' : 'Choose one of the options.';
        case 'multi_select': return raw.some((o) => q.options.includes(o)) ? '' : 'Choose at least one.';
        case 'number': {
          const n = Number(String(raw).replace(/,/g, ''));
          return Number.isFinite(n) && Math.abs(n) <= 1e7 ? '' : 'Enter a number.';
        }
        case 'url': return normalizeLink(raw) ? '' : 'Enter a link that starts with https://';
        default: return '';
      }
    };
  }

  function buildQuestion(q) {
    const key = `answers.${q.id}`;
    const id = `ap-q-${safeId(q.id)}`;
    const errId = `${id}-err`;
    const helpId = `${id}-help`;
    const max = q.maxLength > 0 ? q.maxLength : 0;
    const err = el('p', 'field__err');
    err.id = errId;
    const help = q.help ? el('p', 'field__hint', q.help) : null;
    if (help) help.id = helpId;
    const describedBy = [help ? helpId : '', errId].filter(Boolean).join(' ');

    const choicesType = q.type === 'yes_no' || q.type === 'multi_select'
      || (q.type === 'single_select' && q.options.length <= 6 && q.options.every((o) => String(o).length <= 40));

    if (choicesType) {
      const set = el('fieldset', 'choices field apply__question');
      set.dataset.field = key;
      set.setAttribute('aria-describedby', describedBy);
      const legend = el('legend', 'field__label', q.label);
      legend.append(' ', questionMark(q.required));
      const list = el('div', 'choices__list');
      const name = `q-${safeId(q.id)}`;
      const opts = q.type === 'yes_no' ? [['yes', 'Yes'], ['no', 'No']] : q.options.map((o) => [o, o]);
      for (const [value, label] of opts) list.append(chip(q.type === 'multi_select' ? 'checkbox' : 'radio', name, value, label));
      set.append(legend, list);
      if (help) set.append(help);
      set.append(err);
      const inputs = [...list.querySelectorAll('input')];
      if (q.required && q.type !== 'multi_select') inputs.forEach((i) => i.setAttribute('aria-required', 'true'));
      const read = () => (q.type === 'multi_select' ? checkedValues(name) : checkedValue(name));
      fields[key] = { wrap: set, err, inputs, question: q, check: questionCheck(q, read), value: read, kind: 'choices', name };
      return set;
    }

    const wrap = el('div', 'field apply__question');
    wrap.dataset.field = key;
    const label = el('label', 'field__label', q.label);
    label.htmlFor = id;
    label.append(' ', questionMark(q.required));
    let input;
    if (q.type === 'single_select') {
      input = el('select', 'field__input is-empty');
      const first = el('option', '', 'Choose one');
      first.value = '';
      input.append(first);
      for (const o of q.options) {
        const opt = el('option', '', o);
        opt.value = o;
        input.append(opt);
      }
    } else if (q.type === 'long_text') {
      input = el('textarea', 'field__input');
      input.rows = 4;
      input.maxLength = max || 2000;
    } else {
      input = el('input', 'field__input');
      input.type = q.type === 'url' ? 'url' : 'text';
      if (q.type === 'number') input.inputMode = 'decimal';
      if (q.type === 'url') {
        input.inputMode = 'url';
        input.autocapitalize = 'off';
        input.spellcheck = false;
        input.placeholder = 'https://';
      }
      if (q.type === 'short_text') input.maxLength = max || 2000;
      if (q.type === 'url') input.maxLength = 300;
    }
    input.id = id;
    input.setAttribute('aria-describedby', describedBy + (max && (q.type === 'short_text' || q.type === 'long_text') ? ` ${id}-count` : ''));
    if (q.required) input.setAttribute('aria-required', 'true');
    wrap.append(label, input);
    const foot = el('div', 'field__foot');
    if (help) foot.append(help);
    foot.append(err);
    let count = null;
    if (max && (q.type === 'short_text' || q.type === 'long_text')) {
      count = el('p', 'field__count', `0 / ${max}`);
      count.id = `${id}-count`;
      foot.append(count);
    }
    wrap.append(foot);
    fields[key] = { input, wrap, err, question: q, check: questionCheck(q, () => input.value), value: () => input.value, count, max, kind: 'text' };
    return wrap;
  }

  function renderQuestions() {
    const qs = app.kind === 'role' && app.job && Array.isArray(app.job.screeningQuestions) ? app.job.screeningQuestions : [];
    const sig = JSON.stringify([app.kind, qs.map((q) => [q.id, q.type, q.label, q.options, q.required, q.maxLength])]);
    if (sig === questionSig) return;
    const keep = collectAnswers(true);
    questionSig = sig;
    clearQuestions();
    for (const q of qs) ref.questions.append(buildQuestion(q));
    ref.questionsGroup.hidden = !qs.length;
    restoreAnswers(keep);
  }

  /** The answers as Paddock wants them. raw: as typed, for a draft. */
  function collectAnswers(raw) {
    const out = {};
    for (const [name, f] of Object.entries(fields)) {
      if (!name.startsWith('answers.')) continue;
      const q = f.question;
      const v = f.value();
      if (v === '' || (Array.isArray(v) && !v.length)) continue;
      if (raw) { out[q.id] = v; continue; }
      if (q.type === 'number') out[q.id] = Number(String(v).replace(/,/g, ''));
      else if (q.type === 'url') out[q.id] = normalizeLink(v) || v;
      else if (q.type === 'short_text' || q.type === 'long_text') out[q.id] = v.trim();
      else out[q.id] = v;
    }
    return out;
  }

  function restoreAnswers(answers) {
    if (!answers) return;
    for (const [id, v] of Object.entries(answers)) {
      const f = fields[`answers.${id}`];
      if (!f) continue;
      if (f.kind === 'choices') {
        const want = new Set(Array.isArray(v) ? v : [v]);
        for (const i of f.inputs) i.checked = want.has(i.value);
      } else if (typeof v === 'string' || typeof v === 'number') {
        f.input.value = String(v);
        if (f.input.tagName === 'SELECT') f.input.classList.toggle('is-empty', !f.input.value);
      }
    }
    updateCounts();
  }

  // ---------------------------------------------------------------- counters
  function setCount(node, n, max) {
    if (!node) return;
    node.textContent = `${n} / ${max}`;
    node.classList.toggle('is-near', n >= max * 0.9 && n <= max);
    node.classList.toggle('is-over', n > max);
  }
  function updateCounts() {
    setCount(ref.whyCount, fields.whyGridX.input.value.length, 3000);
    for (const f of Object.values(fields)) if (f.count) setCount(f.count, f.input.value.length, f.max);
  }

  // ---------------------------------------------------------------- the resume
  async function sniff(file) {
    try {
      const buf = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
      const ascii = Array.from(buf, (b) => String.fromCharCode(b)).join('');
      if (ascii.includes('%PDF-')) return 'pdf';
      const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
      if (ole.every((b, i) => buf[i] === b)) return 'doc';
      if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
    } catch (_) {
      return null;
    }
    return null;
  }

  async function resumeProblem(file) {
    const { maxResumeBytes, accept } = config();
    const name = String(file.name || '').toLowerCase();
    const ext = (name.match(/\.[a-z0-9]+$/) || [''])[0];
    const allowed = (accept && accept.length ? accept : DEFAULTS.accept).map((a) => String(a).toLowerCase());
    if (!allowed.includes(ext)) return 'Choose a PDF or a Word document (.pdf, .doc or .docx).';
    if (!file.size) return 'That file is empty. Choose another.';
    if (file.size > maxResumeBytes) return `That file is ${fmtSize(file.size)}. The limit is ${fmtSize(maxResumeBytes)}.`;
    const kind = await sniff(file);
    const fits = (ext === '.pdf' && kind === 'pdf') || (ext === '.doc' && kind === 'doc') || (ext === '.docx' && kind === 'zip');
    return fits ? '' : `That file does not look like a real ${ext === '.pdf' ? 'PDF' : 'Word document'}. Try saving it again, or export it as a PDF.`;
  }

  let pickSeq = 0;
  async function takeFile(file) {
    if (!file) return;
    const seq = ++pickSeq;
    const problem = await resumeProblem(file);
    if (seq !== pickSeq) return; // a newer pick has already landed
    if (problem) {
      setResume(null);
      showError('resume', problem);
      return;
    }
    setResume(file);
    showError('resume', '');
    queueSave();
  }

  function setResume(file) {
    resumeFile = file || null;
    ref.drop.classList.toggle('has-file', Boolean(resumeFile));
    ref.chosen.hidden = !resumeFile;
    if (resumeFile) {
      ref.fileName.textContent = resumeFile.name;
      ref.fileSize.textContent = fmtSize(resumeFile.size);
    }
  }

  resumeInput.addEventListener('change', () => {
    const file = resumeInput.files && resumeInput.files[0];
    resumeInput.value = ''; // so choosing the same file again still counts as a choice
    takeFile(file);
  });
  ref.fileReplace.addEventListener('click', () => resumeInput.click());
  ref.fileRemove.addEventListener('click', () => {
    setResume(null);
    resumeInput.focus();
  });
  for (const type of ['dragenter', 'dragover']) {
    ref.drop.addEventListener(type, (event) => {
      if (!event.dataTransfer || ![...event.dataTransfer.types].includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      ref.drop.classList.add('is-dragover');
    });
  }
  for (const type of ['dragleave', 'dragend']) ref.drop.addEventListener(type, () => ref.drop.classList.remove('is-dragover'));
  ref.drop.addEventListener('drop', (event) => {
    event.preventDefault();
    ref.drop.classList.remove('is-dragover');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    takeFile(file);
  });
  // A file dropped beside the zone must not navigate the page away from a half-filled form.
  sheetEl.addEventListener('dragover', (event) => event.preventDefault());
  sheetEl.addEventListener('drop', (event) => event.preventDefault());

  // ---------------------------------------------------------------- drafts
  function snapshot() {
    const out = {};
    for (const k of TEXT_FIELDS) out[k] = fields[k].input.value;
    out.availability = checkedValue('availability');
    out.availableFrom = dateInput.value;
    out.howHeard = howHeardInput.value;
    out.answers = collectAnswers(true);
    out.interestDomains = checkedValues('interestDomains');
    out.interestType = checkedValue('interestType');
    return out;
  }

  function dirty() {
    if (resumeFile) return true;
    const s = snapshot();
    return TEXT_FIELDS.some((k) => s[k].trim()) || Boolean(s.availability) || Object.keys(s.answers).length > 0
      || (app.kind === 'open' && s.interestDomains.length > 0) || consentInput.checked;
  }

  function save() {
    saveTimer = 0;
    if (!app.key || sent) return;
    const s = snapshot();
    store.set(draftKey(), { ...s, savedAt: Date.now() });
    const me = {};
    for (const k of ME_FIELDS) me[k] = s[k];
    if (ME_FIELDS.some((k) => me[k].trim())) store.set(ME_KEY, me);
  }
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 300);
  };

  function fill(values) {
    const v = values || {};
    for (const k of TEXT_FIELDS) fields[k].input.value = typeof v[k] === 'string' ? v[k] : '';
    for (const i of fields.availability.inputs) i.checked = i.value === v.availability;
    dateInput.value = typeof v.availableFrom === 'string' ? v.availableFrom : '';
    howHeardInput.value = config().howHeard.includes(v.howHeard) ? v.howHeard : '';
    howHeardInput.classList.toggle('is-empty', !howHeardInput.value);
    const domains = new Set(Array.isArray(v.interestDomains) ? v.interestDomains : []);
    for (const i of ref.interestDomains.querySelectorAll('input')) i.checked = domains.has(i.value);
    const type = v.interestType || 'any';
    for (const i of ref.interestType.querySelectorAll('input')) i.checked = i.value === type;
    for (const [name, f] of Object.entries(fields)) {
      if (!name.startsWith('answers.')) continue;
      if (f.kind === 'choices') for (const i of f.inputs) i.checked = false;
      else {
        f.input.value = '';
        if (f.input.tagName === 'SELECT') f.input.classList.add('is-empty');
      }
    }
    restoreAnswers(v.answers);
    syncDate();
    updateCounts();
  }

  // ---------------------------------------------------------------- live corrections
  form.addEventListener('input', (event) => {
    const t = event.target;
    if (t === honeypot) return;
    if (t === fields.whyGridX.input || (t.classList && t.classList.contains('field__input'))) updateCounts();
    if (t.tagName === 'SELECT') t.classList.toggle('is-empty', !t.value);
    // Only correct an error already on screen; never scold mid-typing.
    const name = nameOf(t);
    if (name && fields[name] && fields[name].wrap && fields[name].wrap.classList.contains('is-bad')) showError(name, messageFor(name));
    queueSave();
  });
  form.addEventListener('change', (event) => {
    const t = event.target;
    if (t === resumeInput || t === honeypot) return;
    if (t.name === 'availability') syncDate();
    if (t.name === 'interestDomains') limitInterests(t);
    const name = nameOf(t);
    if (name && fields[name] && (t.type === 'radio' || t.type === 'checkbox')) showError(name, messageFor(name));
    queueSave();
  });
  form.addEventListener('focusout', (event) => {
    const t = event.target;
    const name = nameOf(t);
    if (!name || !fields[name] || !t.classList || !t.classList.contains('field__input')) return;
    if (t.value !== '') showError(name, messageFor(name));
  });

  /** Which registered field an input belongs to. */
  function nameOf(input) {
    if (!input) return '';
    if (input === consentInput) return 'consent';
    if (input.name === 'availability') return 'availability';
    if (input.name === 'interestDomains') return 'interestDomains';
    const holder = input.closest('[data-field]');
    if (holder) return holder.dataset.field;
    return input.name && fields[input.name] ? input.name : '';
  }

  function syncDate() {
    const on = checkedValue('availability') === 'date';
    ref.dateWrap.hidden = !on;
    dateInput.min = todayIst();
    if (!on) showError('availableFrom', '');
  }

  function limitInterests(changed) {
    const picked = checkedValues('interestDomains');
    if (picked.length > MAX_INTERESTS) {
      changed.checked = false;
      say(`Choose up to ${MAX_INTERESTS} teams.`, true);
    }
  }

  // ---------------------------------------------------------------- the foot
  function say(message, bad) {
    ref.hint.textContent = message || '';
    ref.hint.classList.toggle('is-bad', Boolean(bad));
  }

  function setPrimary(label, { disabled = false } = {}) {
    ref.primaryLabel.textContent = label;
    ref.primary.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function setProgress(fraction) {
    const f = Math.max(0, Math.min(1, fraction));
    ref.primary.style.setProperty('--progress', String(f));
  }

  // ---------------------------------------------------------------- notices
  /**
   * A message that needs more than the hint line: why this cannot be sent as it is, and what
   * to do instead (an action button, or none).
   */
  function notice(target, { title, text, action, onAction, quiet } = {}) {
    target.textContent = '';
    if (!title && !text) {
      target.hidden = true;
      return;
    }
    target.classList.toggle('is-quiet', Boolean(quiet));
    const head = el('p', 'apply__notice-title');
    head.append(icon(ICON.info), el('span', '', title));
    target.append(head);
    if (text) target.append(el('p', 'apply__notice-text', text));
    if (action) {
      const b = el('button', 'apply__notice-action', action);
      b.type = 'button';
      b.addEventListener('click', onAction);
      target.append(b);
    }
    target.hidden = false;
  }

  // ---------------------------------------------------------------- views
  function setView(next, { focus = true } = {}) {
    view = next;
    for (const [name, node] of Object.entries(views)) node.hidden = name !== next;
    sheetEl.dataset.view = next;
    const title = next === 'intro' ? 'apply-intro-title' : next === 'form' ? 'apply-form-title' : 'apply-done-title';
    sheetEl.setAttribute('aria-labelledby', title);
    scroller.scrollTop = 0;
    renderFoot();
    if (focus) {
      const h = document.getElementById(title);
      if (h) h.focus({ preventScroll: true });
    }
  }

  function renderFoot() {
    ref.cancel.hidden = !busy;
    ref.legal.hidden = view !== 'form';
    sheetEl.classList.toggle('is-busy', busy);
    if (busy) return;
    setProgress(0);
    if (view === 'intro') setPrimary('Continue', { disabled: Boolean(blocked()) });
    else if (view === 'form') setPrimary(app.kind === 'open' ? 'Send open application' : 'Send application');
    else setPrimary('Done');
  }

  /** Why this application cannot start at all, or ''. */
  function blocked() {
    const c = config();
    if (c.applicationsPaused) return 'all_paused';
    if (app.kind === 'open' && careers() && careers().get().live && !c.openApplication) return 'open_closed';
    if (app.kind === 'role') {
      const s = careers() ? careers().roleState(app.job) : 'unknown';
      if (s === 'closed' || s === 'paused' || s === 'gone') return s;
    }
    return '';
  }

  function chipItem(svg, text) {
    const li = el('li', 'apply__chip');
    li.append(icon(svg), el('span', '', text));
    return li;
  }

  function renderIntro() {
    const c = config();
    const job = app.job;
    ref.eyebrow.textContent = '';
    ref.introChips.textContent = '';
    ref.introSteps.textContent = '';
    if (app.kind === 'role' && job) {
      const d = careers() ? careers().domain(job.domain) : null;
      if (d && window.gridIcons) ref.eyebrow.append(icon(window.gridIcons.svg(d.icon, { size: 18 })));
      ref.eyebrow.append(el('span', '', d ? d.label : 'Careers at GridX'));
      ref.introTitle.textContent = job.title;
      ref.introLede.textContent = job.summary || '';
      ref.introLede.hidden = !job.summary;
      if (job.location) ref.introChips.append(chipItem(ICON.pin, job.location));
      if (EMPLOYMENT[job.employmentType]) ref.introChips.append(chipItem(ICON.clock, EMPLOYMENT[job.employmentType]));
      if (WORK_MODE[job.workMode]) ref.introChips.append(chipItem(ICON.mode, WORK_MODE[job.workMode]));
    } else {
      ref.eyebrow.append(el('span', '', 'Open application'));
      ref.introTitle.textContent = 'Tell us what you do best.';
      ref.introLede.textContent = 'No role that fits yet? Send us your details and the teams you would like to work with. We keep open applications on file and write when something fits.';
      ref.introLede.hidden = false;
    }
    ref.introChips.hidden = !ref.introChips.children.length;

    const steps = ['Your name, how to reach you and the city you live in'];
    steps.push(resumeRequired() ? `Your resume, as a PDF or a Word document up to ${fmtSize(c.maxResumeBytes)}` : 'Your resume, if you have one');
    steps.push('A few lines on why GridX, and when you could start');
    const qn = app.kind === 'role' && job && Array.isArray(job.screeningQuestions) ? job.screeningQuestions.length : 0;
    if (qn) steps.push(qn === 1 ? 'One question about this role' : `${capital(count(qn))} short questions about this role`);
    if (app.kind === 'open') steps.push('The teams you would like to join');
    for (const s of steps) ref.introSteps.append(el('li', '', s));

    const why = blocked();
    if (why === 'all_paused') {
      notice(ref.introNotice, { title: 'Applications are paused for a short while.', text: 'Please come back soon. Anything you have already written is kept in this tab.' });
    } else if (why === 'open_closed') {
      notice(ref.introNotice, { title: 'Open applications are closed right now.', text: `You can still write to ${c.careersEmail}.` });
    } else if (why) {
      notice(ref.introNotice, {
        title: why === 'paused' ? 'This role is not taking applications right now.' : 'This role has closed.',
        text: c.openApplication ? 'You can still send an open application, and we will keep you in mind for what comes next.' : `You can still write to ${c.careersEmail}.`,
        action: c.openApplication ? 'Send an open application' : '',
        onAction: () => switchToOpen({ toForm: false }),
      });
    } else {
      notice(ref.introNotice, {});
    }
  }

  function renderForm() {
    const job = app.job;
    ref.formEyebrow.textContent = '';
    if (app.kind === 'role' && job) {
      ref.formEyebrow.textContent = 'Applying for';
      ref.formTitle.textContent = job.title;
    } else {
      ref.formEyebrow.textContent = 'Open application';
      ref.formTitle.textContent = 'Your application';
    }
    ref.resumeOpt.hidden = resumeRequired();
    const { maxResumeBytes } = config();
    ref.resumeNote.textContent = `PDF or Word, up to ${fmtSize(maxResumeBytes)}`;
    ref.interestGroup.hidden = app.kind !== 'open';
    renderDomains();
    renderHowHeard();
    renderConsent();
    renderQuestions();
  }

  // ---------------------------------------------------------------- opening
  const sheet = window.gridSheet.create(sheetEl, {
    halo: root.dataset.applyHalo === 'off' ? false : { fill: 0.5 },
    // A half-filled application is closed on purpose (the close button, Esc), never by a
    // thumb that scrolled the wrong way.
    canSwipe: () => !busy && (view !== 'form' || !dirty()),
    onOpen() {
      if (window.gridKeyboard) keyboard = window.gridKeyboard.watch({ shell: sheetEl, scope: form, scroller });
    },
    onClose() {
      if (keyboard) keyboard.stop();
      keyboard = null;
      if (saveTimer) save();
      if (sent) reset();
    },
  });

  sheetEl.querySelector('.story__close').addEventListener('click', () => {
    if (busy && controller) controller.abort();
  });

  /**
   * @param {{ job?: object|string, open?: boolean, source?: { page?: string }|string, returnTo?: HTMLElement }} opts
   */
  function open(opts = {}) {
    const wantOpen = Boolean(opts.open) || opts.job === 'open';
    const job = wantOpen ? null : resolveJob(opts.job);
    if (!wantOpen && !job) {
      console.warn('[gridApply] no such role', opts.job);
      return false;
    }
    const kind = wantOpen ? 'open' : 'role';
    const key = kind === 'open' ? 'open' : `role:${job.id}`;
    const page = (opts.source && typeof opts.source === 'object' && opts.source.page) || (typeof opts.source === 'string' ? opts.source : '');
    const same = app.key === key && !sent;
    if (saveTimer) save();
    if (sent) reset();
    app = { kind, job, key, page };
    if (!same) {
      startedAt = Date.now();
      questionSig = '';
      clearQuestions();
      setResume(null);
      consentInput.checked = false;
      talentInput.checked = false;
      honeypot.value = '';
      for (const name of Object.keys(fields)) showError(name, '');
      renderForm();
      const draft = store.get(draftKey());
      fill(draft || store.get(ME_KEY));
      say('');
      notice(ref.formNotice, {});
    } else {
      renderForm();
    }
    renderIntro();
    setView(same && view === 'form' ? 'form' : 'intro', { focus: false });
    if (window.gridxApi && window.gridxApi.loadRecaptcha) window.gridxApi.loadRecaptcha();
    track('apply_open', { slug: trackSlug() });
    sheet.open(opts.returnTo || document.activeElement);
    return true;
  }

  function reset() {
    sent = false;
    busy = false;
    app = { kind: 'role', job: null, key: '', page: '' };
    questionSig = '';
    setResume(null);
    form.reset();
    clearQuestions();
    notice(ref.formNotice, {});
    say('');
    view = 'intro';
  }

  /** A closed role's application becomes an open one, keeping everything written so far. */
  function switchToOpen({ toForm = true } = {}) {
    const keepAnswers = snapshot();
    const job = app.job;
    if (saveTimer) save();
    app = { kind: 'open', job: null, key: 'open', page: app.page };
    questionSig = '';
    renderForm();
    fill({ ...keepAnswers, interestDomains: job && job.domain ? [job.domain] : keepAnswers.interestDomains, interestType: job && job.employmentType ? job.employmentType : 'any' });
    notice(ref.formNotice, {});
    renderIntro();
    say('');
    save();
    if (toForm) {
      setView('form', { focus: false });
      notice(ref.formNotice, {
        title: 'Now an open application.',
        text: 'Everything you wrote is still here. Check the teams you would like to join, then send it.',
        quiet: true,
      });
      requestAnimationFrame(() => focusField('interestDomains'));
    } else {
      setView('intro');
    }
  }

  // ---------------------------------------------------------------- sending
  function payload(token) {
    const fd = new FormData();
    const s = snapshot();
    fd.append('kind', app.kind);
    if (app.kind === 'role') fd.append('jobId', app.job.id);
    fd.append('firstName', s.firstName.trim());
    fd.append('lastName', s.lastName.trim());
    // The email goes before the file, so Paddock has it before the upload's long tail.
    fd.append('email', s.email.trim());
    fd.append('phone', normalizePhone(s.phone) || s.phone.trim());
    fd.append('city', s.city.trim());
    fd.append('linkedinUrl', normalizeLink(s.linkedinUrl, 'linkedin.com') || '');
    fd.append('portfolioUrl', normalizeLink(s.portfolioUrl) || '');
    fd.append('whyGridX', s.whyGridX.trim());
    fd.append('availability', s.availability);
    fd.append('availableFrom', s.availability === 'date' ? s.availableFrom : '');
    fd.append('answers', JSON.stringify(app.kind === 'role' ? collectAnswers(false) : {}));
    fd.append('howHeard', s.howHeard);
    fd.append('consent', consentInput.checked ? 'true' : 'false');
    fd.append('consentVersion', (config().consent && config().consent.version) || '');
    fd.append('talentPoolOptIn', talentInput.checked ? 'true' : 'false');
    if (app.kind === 'open') {
      fd.append('interestDomains', JSON.stringify(s.interestDomains));
      fd.append('interestType', s.interestType || 'any');
    }
    fd.append('source', JSON.stringify(sourcePayload(app.page)));
    fd.append('recaptchaToken', token || '');
    fd.append('company_website', honeypot.value);
    fd.append('elapsedMs', String(Date.now() - startedAt));
    if (resumeFile) fd.append('resume', resumeFile, resumeFile.name);
    return fd;
  }

  async function submit() {
    if (busy) return;
    const first = validateAll();
    if (first) {
      say('Please check the highlighted fields.', true);
      focusField(first);
      return;
    }
    const c = config();
    if (!c.ready) {
      say('Loading the form. One moment.');
      if (careers()) await careers().refresh();
      if (!config().ready) {
        say(window.gridxApi ? window.gridxApi.describeError((careers() && careers().get().error) || null) : 'Could not reach GridX. Check your connection and try again.', true);
        return;
      }
      renderConsent();
    }
    busy = true;
    say('');
    notice(ref.formNotice, {});
    setPrimary('Sending');
    setProgress(0.02);
    renderFoot();
    track('apply_submit', { slug: trackSlug() });
    controller = new AbortController();
    try {
      const action = app.kind === 'open' ? (c.recaptchaActionOpen || 'careers_open_application') : (c.recaptchaAction || 'careers_apply');
      const token = window.gridxApi.recaptchaToken ? await window.gridxApi.recaptchaToken(action) : null;
      if (controller.signal.aborted) throw Object.assign(new Error('Cancelled.'), { kind: 'aborted' });
      const result = await window.gridxApi.postForm(APPLY_PATH, payload(token), {
        signal: controller.signal,
        timeoutMs: 180000,
        onProgress(p) {
          if (p.phase === 'upload' && p.total) {
            const f = p.loaded / p.total;
            setProgress(0.04 + f * 0.9);
            setPrimary(`Sending ${Math.round(f * 100)}%`);
          } else if (p.phase === 'server') {
            setProgress(1);
            setPrimary('Almost there');
          }
        },
      });
      busy = false;
      controller = null;
      done(result);
    } catch (err) {
      busy = false;
      controller = null;
      failed(err);
    }
  }

  function done(result) {
    sent = true;
    store.remove(draftKey());
    ref.doneRef.textContent = String(result.reference || '');
    ref.doneMail.textContent = result.emailMasked
      ? `We have emailed a confirmation to ${result.emailMasked}.`
      : 'We have emailed you a confirmation.';
    track('apply_success');
    setView('done');
  }

  /** Paddock's per-field messages, as a list of [field, message], whichever shape they came in. */
  function serverFields(raw) {
    if (Array.isArray(raw)) return raw.filter((f) => f && f.field).map((f) => [String(f.field), String(f.message || '')]);
    if (raw && typeof raw === 'object') return Object.entries(raw).map(([k, v]) => [k, String(v || '')]);
    return [];
  }

  function failed(err) {
    const api = window.gridxApi;
    const describe = (e) => (api ? api.describeError(e) : 'Something went wrong. Please try again.');
    const body = err.body || {};
    const c = config();
    renderFoot();

    if (err.status === 400 && err.fields) {
      let first = null;
      const stray = [];
      for (const [name, message] of serverFields(err.fields)) {
        if (fields[name] && isLive(name)) {
          showError(name, message || 'Please check this.');
          if (!first) first = name;
        } else {
          stray.push(message);
        }
      }
      say(stray.length ? stray.join(' ') : (err.message || 'Please check the highlighted fields.'), true);
      if (first) focusField(first);
      // Consent wording that changed under the page: fetch the new words to agree to.
      if (fields.consent.wrap.classList.contains('is-bad') && careers()) {
        consentInput.checked = false;
        careers().refresh();
      }
      return;
    }
    if (err.status === 409 && err.code === 'duplicate') {
      const when = fmtDate(body.appliedAt);
      notice(ref.formNotice, {
        title: app.kind === 'open' ? 'You have already sent us an open application.' : 'You have already applied for this role.',
        text: `${when ? `We received it on ${when}. ` : ''}It is with us, and we will be in touch. If something has changed, write to ${c.careersEmail}.`,
      });
      revealNotice();
      return;
    }
    if (err.status === 410) {
      const openOk = typeof body.openApplication === 'boolean' ? body.openApplication : c.openApplication;
      const title = err.code === 'job_paused' ? 'This role stopped taking applications while you were writing.'
        : err.code === 'open_closed' ? 'Open applications are closed right now.'
          : 'This role closed while you were writing.';
      const canSwitch = app.kind === 'role' && openOk;
      notice(ref.formNotice, {
        title,
        text: canSwitch ? 'You can send what you have written as an open application instead. Nothing you wrote is lost.' : `Nothing you wrote is lost. You can still write to ${c.careersEmail}.`,
        action: canSwitch ? 'Send it as an open application' : '',
        onAction: () => switchToOpen({ toForm: true }),
      });
      revealNotice();
      if (careers()) careers().refresh();
      return;
    }
    if (err.status === 413 || err.status === 415 || err.code === 'resume_too_large' || err.code === 'resume_type') {
      showError('resume', err.message || describe(err));
      setResume(null);
      say('Please choose another file.', true);
      focusField('resume');
      return;
    }
    if (err.status === 503 && err.code === 'applications_paused') {
      notice(ref.formNotice, { title: 'Applications are paused for a short while.', text: 'Nothing you wrote is lost: it is kept in this tab. Please try again soon.' });
      revealNotice();
      return;
    }
    say(describe(err), true);
  }

  function revealNotice() {
    scroller.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    ref.formNotice.focus({ preventScroll: true });
    say('');
  }

  ref.cancel.addEventListener('click', () => {
    if (controller) controller.abort();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    if (view === 'intro') {
      if (blocked()) {
        say(blocked() === 'all_paused' ? 'Applications are paused for a short while.' : 'This one is not taking applications now.', true);
        return;
      }
      say('');
      setView('form');
      return;
    }
    if (view === 'form') {
      submit();
      return;
    }
    sheet.close();
  });

  // ---------------------------------------------------------------- the page
  // Anything carrying data-apply opens the sheet: "open", or a role's slug or id.
  document.addEventListener('click', (event) => {
    const hit = event.target.closest && event.target.closest('[data-apply]');
    if (!hit) return;
    event.preventDefault();
    const what = hit.dataset.apply;
    open(what === 'open' ? { open: true, returnTo: hit } : { job: what, returnTo: hit });
  });

  // The careers document changed under an open sheet (a role closed, the questions moved):
  // what the visitor reads is brought up to date, without touching what they wrote.
  if (careers()) {
    careers().subscribe(() => {
      if (!sheetEl.open || busy || sent) return;
      if (app.kind === 'role' && app.job) {
        const fresh = careers().findJob(app.job.id);
        if (fresh) app.job = fresh;
      }
      renderIntro();
      if (view === 'form') {
        renderQuestions();
        renderConsent();
      }
      if (view === 'intro') renderFoot();
    });
  }

  window.gridApply = {
    open,
    close: () => sheet.close(),
    isOpen: () => sheet.isOpen(),
  };
})();
