/*
 * Careers, at build time: a static page per open role, and the careers page's share card.
 *
 * tools/build.mjs loads the careers document (DATA there) and hands it here through two
 * small hooks, so everything careers-specific lives in this file:
 *
 *   prepareCareers(data, deps)   before any page is built:
 *     - fetches each role's share image (Paddock's ogImage, 1200x630) into
 *       dist/jobs/<slug>/og.jpg, and the careers card (og/careers.jpg) into
 *       dist/assets/og/careers.jpg; each must be a JPEG under 300 KB, and one that is not
 *       (or does not arrive) is left on Paddock, where the tags then point
 *     - points the document's ogImage at the site's own copies, so the published
 *       dist/careers/snapshot.json says what the pages say
 *     - registers the source transform for careers.html: its share tags, the whole
 *       document in place of a <!-- careers:data --> marker if the page carries one, and in
 *       place of <!-- careers:list --> the open roles by team as a plain list of links, which
 *       is what a reader without JavaScript gets
 *   writeCareers(ctx, deps)      after the root pages:
 *     - jobs/<slug>/index.html from tools/source/job.html, built like any page (minified,
 *       versioned, locked down) with the prefix '../../'
 *     - jobs/<previous slug>/index.html for every slug a role used to have: a redirect that
 *       still carries the share tags, so a link shared before the rename previews properly
 *     - the role URLs, for the sitemap
 *
 * No data (a plain build, or Paddock and the snapshot both down) is not a failure: there are
 * simply no role pages, careers.html still gets its card (pointing at Paddock), and the
 * browser fetches what is open (assets/careers-data.js).
 *
 *   CAREERS_OG=off   skip every image download (the checks use it with fixtures, whose
 *                    image URLs name production)
 *
 * Every value from Paddock goes into the page escaped, and "assets/" in it is written so
 * the build's asset versioning can never mistake a sentence for a file reference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIcons } from './source/icons.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, 'source/job.html');
const OG_MAX_BYTES = 300 * 1024;
const PADDOCK_OG = 'https://paddockgridx.app/api/public/website/careers/og/';
const OKHLA = {
  '@type': 'PostalAddress',
  streetAddress: 'D66, Pocket D, Okhla Phase 1',
  addressLocality: 'New Delhi',
  addressRegion: 'Delhi',
  postalCode: '110020',
  addressCountry: 'IN',
};

// ---------------------------------------------------------------- text
/** Text or an attribute value, escaped; "assets/" defused for the build's path rewriting. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    // The build versions any "assets/..." that does not follow a word, a slash, a dot or a
    // dash (HTML_PATH in build.mjs); in Paddock's words that would be a sentence, not a file.
    .replace(/(^|[^\w/.-])assets\//g, '$1assets&#47;');
}

/** JSON for a <script> data block: nothing in it can close the script or open a comment. */
export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim();
const list = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

/** Paragraphs from plain text: a blank line starts a new one, a single newline is a break. */
function paragraphs(text, cls = '') {
  return clean(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p${cls ? ` class="${cls}"` : ''}>${p.split('\n').map(esc).join('<br>')}</p>`)
    .join('\n          ');
}

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
export const formatDate = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE.format(t) : '';
};
const isoDay = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
};

export const EMPLOYMENT = { 'full-time': 'Full time', 'part-time': 'Part time', internship: 'Internship', contract: 'Contract' };
export const WORK_MODE = { onsite: 'On site', hybrid: 'Hybrid', remote: 'Remote' };
const SCHEMA_EMPLOYMENT = { 'full-time': 'FULL_TIME', 'part-time': 'PART_TIME', internship: 'INTERN', contract: 'CONTRACTOR' };

/** "2 to 5 years", "Up to 1 year", "3 years or more", or '' for none. */
export function formatExperience(e) {
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

/** "₹12 to 18 lakh a year", "₹25,000 to ₹40,000 a month", "From ₹12 lakh a year". */
export function formatPay(c) {
  if (!c || typeof c !== 'object' || !Number.isFinite(c.min) || c.min <= 0) return '';
  const per = c.period === 'month' ? 'a month' : 'a year';
  const max = Number.isFinite(c.max) && c.max > c.min ? c.max : null;
  if (!max) return `From ₹${rupees(c.min)} ${per}`;
  const a = rupees(c.min);
  const b = rupees(max);
  const unit = (s) => (s.match(/ (lakh|crore)$/) || [''])[0];
  // One unit, said once: "₹12 to 18 lakh", not "₹12 lakh to ₹18 lakh".
  if (unit(a) && unit(a) === unit(b)) return `₹${a.slice(0, -unit(a).length)} to ${b} ${per}`;
  return `₹${a} to ₹${b} ${per}`;
}

// ---------------------------------------------------------------- icons
// The role page's fact icons: lucide's (ISC licence), drawn as the site draws its own.
const FACT_ICONS = {
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  briefcase: '<path d="M12 12h.01"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M22 13a18.15 18.15 0 0 1-20 0"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  onsite: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  hybrid: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  remote: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  experience: '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  team: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  pay: '<path d="M6 3h12"/><path d="M6 8h12"/><path d="m6 13 8.5 8"/><path d="M6 13h3"/><path d="M9 13c6.667 0 6.667-10 0-10"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
};
const svg = (paths, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

// ---------------------------------------------------------------- the share card and search
function roleUrl(siteOrigin, slug) {
  return `${siteOrigin}/jobs/${slug}/`;
}

export function describe(job) {
  const s = clean(job.summary) || clean(job.description) || clean(job.aboutTeamAndRole);
  const flat = s.replace(/\s+/g, ' ');
  if (flat.length <= 160) return flat;
  const cut = flat.slice(0, 157);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 120))}...`;
}

/** The share tags, the same for a role page and for its old slugs' redirects. */
function shareTags(job, { canonical, image }) {
  const title = `${job.title} at GridX`;
  const desc = describe(job);
  const alt = `${job.title}, a role at GridX`;
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="GridX">`,
    `<meta property="og:locale" content="en_IN">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    image ? `<meta property="og:image:type" content="image/jpeg">` : '',
    image ? `<meta property="og:image:width" content="1200">` : '',
    image ? `<meta property="og:image:height" content="630">` : '',
    image ? `<meta property="og:image:alt" content="${esc(alt)}">` : '',
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    image ? `<meta name="twitter:image" content="${esc(image)}">` : '',
    image ? `<meta name="twitter:image:alt" content="${esc(alt)}">` : '',
  ].filter(Boolean).map((l) => `  ${l}`).join('\n');
}

/** The description Google shows: plain text, section by section. */
function plainDescription(job) {
  const parts = [];
  if (clean(job.summary)) parts.push(clean(job.summary));
  if (clean(job.description)) parts.push(clean(job.description));
  if (clean(job.aboutTeamAndRole)) parts.push(clean(job.aboutTeamAndRole));
  const section = (title, items) => {
    if (items.length) parts.push(`${title}:\n${items.map((i) => `- ${i}`).join('\n')}`);
  };
  section('What you will do', list(job.responsibilities));
  section('Experience and qualifications', list(job.experienceAndQualifications));
  section('Must-have skills', list(job.mustHaveCompetencies));
  section('Nice to have', list(job.niceToHave));
  return parts.join('\n\n');
}

/** Where the role is, as schema.org wants it: Okhla when it is the office, else the city. */
function placeOf(job) {
  const loc = clean(job.location);
  if (!loc || /okhla|new delhi|^delhi\b/i.test(loc)) return { '@type': 'Place', address: OKHLA };
  const [city, ...rest] = loc.split(',').map((s) => s.trim()).filter(Boolean);
  const address = { '@type': 'PostalAddress', addressLocality: city, addressCountry: 'IN' };
  if (rest.length && !/^india$/i.test(rest[rest.length - 1])) address.addressRegion = rest[rest.length - 1];
  return { '@type': 'Place', address };
}

/** schema.org JobPosting, from the public job. */
export function jobPosting(job, { siteOrigin }) {
  const url = roleUrl(siteOrigin, job.slug);
  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: job.title,
    description: plainDescription(job),
    identifier: { '@type': 'PropertyValue', name: 'GridX', value: job.id },
    datePosted: isoDay(job.publishedAt) || isoDay(job.updatedAt) || undefined,
    validThrough: job.closesAt && Number.isFinite(Date.parse(job.closesAt)) ? new Date(Date.parse(job.closesAt)).toISOString() : undefined,
    employmentType: SCHEMA_EMPLOYMENT[job.employmentType] || 'FULL_TIME',
    hiringOrganization: {
      '@type': 'Organization',
      name: 'GridX',
      sameAs: siteOrigin,
      logo: `${siteOrigin}/assets/gridX_logo.png`,
    },
    url,
    directApply: true,
  };
  const remote = job.workMode === 'remote';
  if (remote) {
    ld.jobLocationType = 'TELECOMMUTE';
    ld.applicantLocationRequirements = { '@type': 'Country', name: 'India' };
    if (!/^remote\b/i.test(clean(job.location))) ld.jobLocation = placeOf(job);
  } else {
    ld.jobLocation = placeOf(job);
  }
  const c = job.compensation;
  if (c && Number.isFinite(c.min) && c.min > 0) {
    const value = { '@type': 'QuantitativeValue', unitText: c.period === 'month' ? 'MONTH' : 'YEAR' };
    if (Number.isFinite(c.max) && c.max > c.min) {
      value.minValue = c.min;
      value.maxValue = c.max;
    } else {
      value.value = c.min;
    }
    ld.baseSalary = { '@type': 'MonetaryAmount', currency: c.currency || 'INR', value };
  }
  const e = job.experience;
  if (e && Number.isFinite(e.min) && e.min > 0) {
    ld.experienceRequirements = { '@type': 'OccupationalExperienceRequirements', monthsOfExperience: e.min * 12 };
  }
  return JSON.parse(JSON.stringify(ld)); // drops the undefineds
}

// ---------------------------------------------------------------- the page
function fact(icon, text, extra = '') {
  return `<li class="role__fact${extra}">${svg(FACT_ICONS[icon])}<span>${esc(text)}</span></li>`;
}

function section(title, inner, cls = '') {
  if (!inner) return '';
  return `
        <section class="role__section${cls}">
          <h2 class="role__h2">${esc(title)}</h2>
          ${inner}
        </section>`;
}

const bullets = (items) => (items.length ? `<ul class="role__list">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
const skills = (items) => (items.length ? `<ul class="role__skills">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');

export function roleHead(job, ctx) {
  const canonical = roleUrl(ctx.siteOrigin, job.slug);
  const snapshot = {
    scope: 'role',
    version: ctx.data.version,
    applicationsPaused: Boolean(ctx.data.applicationsPaused),
    org: ctx.data.org || null,
    domains: ctx.data.domains || [],
    jobs: [job],
    recentlyClosed: [],
    openApplication: ctx.data.openApplication || { enabled: false },
    apply: ctx.data.apply || null,
  };
  return [
    `<title>${esc(job.title)} | GridX Careers</title>`,
    `  <meta name="description" content="${esc(describe(job))}">`,
    `  <link rel="canonical" href="${esc(canonical)}">`,
    shareTags(job, { canonical, image: job.ogImage }),
    `  <script type="application/ld+json">${scriptJson(jobPosting(job, ctx))}</script>`,
    `  <script type="application/json" id="careers-snapshot">${scriptJson(snapshot)}</script>`,
  ].join('\n');
}

export function roleBody(job, ctx) {
  const domain = (ctx.data.domains || []).find((d) => d.key === job.domain) || null;
  const icons = ctx.icons;
  const domainIcon = icons ? icons.svg(domain ? domain.icon : '', { size: 18 }) : '';
  const facts = [];
  if (clean(job.location)) facts.push(fact('pin', job.location));
  if (EMPLOYMENT[job.employmentType]) facts.push(fact('briefcase', EMPLOYMENT[job.employmentType]));
  if (WORK_MODE[job.workMode]) facts.push(fact(job.workMode, WORK_MODE[job.workMode]));
  const exp = formatExperience(job.experience);
  if (exp) facts.push(fact('experience', exp));
  if (clean(job.teamName)) facts.push(fact('team', `${job.teamName} team`));
  const pay = formatPay(job.compensation);
  if (pay) facts.push(fact('pay', pay));

  const about = [paragraphs(job.description), paragraphs(job.aboutTeamAndRole)].filter(Boolean).join('\n          ');
  const sections = [
    section('About the team and the role', about),
    section('What you will do', bullets(list(job.responsibilities))),
    section('Experience and qualifications', bullets(list(job.experienceAndQualifications))),
    section('Must-have skills', skills(list(job.mustHaveCompetencies))),
    section('Nice to have', bullets(list(job.niceToHave))),
  ].join('');

  const meta = [];
  if (job.openings > 1) meta.push(`<li><span>Openings</span> ${esc(String(job.openings))}</li>`);
  if (formatDate(job.publishedAt)) meta.push(`<li><span>Posted</span> ${esc(formatDate(job.publishedAt))}</li>`);
  if (formatDate(job.closesAt)) meta.push(`<li><span>Applications close</span> ${esc(formatDate(job.closesAt))}</li>`);

  const email = (ctx.data.org && ctx.data.org.careersEmail) || 'careers@gridxenergy.in';
  const openOk = Boolean(ctx.data.openApplication && ctx.data.openApplication.enabled);
  const resumeNote = job.resumeRequired === false ? 'A resume helps, but is not required.' : 'Have your resume ready, as a PDF or a Word file.';

  return `
  <main class="role" data-job-id="${esc(job.id)}" data-slug="${esc(job.slug)}">
    <div class="role__inner">
      <a class="role__back" href="careers.html">${svg(FACT_ICONS.back, 16)}<span>All roles</span></a>

      <div class="role__layout">
        <header class="role__head">
          <p class="role__domain">${domainIcon}<span>${esc(domain ? domain.label : 'Careers')}</span></p>
          <h1 class="role__title">${esc(job.title)}</h1>
          ${clean(job.summary) ? `<p class="role__summary">${esc(clean(job.summary))}</p>` : ''}
          ${facts.length ? `<ul class="role__facts" aria-label="About this role">${facts.join('')}</ul>` : ''}
        </header>

        <div class="role__status" data-role-status role="status" hidden></div>

        <aside class="role__apply" aria-label="Apply">
          <div class="role__apply-card">
            <button class="role__cta" type="button" data-role-apply>Apply for this role</button>
            <p class="role__apply-note">It takes about five minutes. ${esc(resumeNote)}</p>
            <noscript><p class="role__apply-note">Applying needs JavaScript. You can also write to <a href="mailto:${esc(email)}">${esc(email)}</a>.</p></noscript>
            ${meta.length ? `<ul class="role__meta">${meta.join('')}</ul>` : ''}
          </div>
        </aside>

        <article class="role__body" aria-label="The role">${sections}
        </article>

        <aside class="role__more" aria-labelledby="role-more-title">
          <h2 class="role__h2" id="role-more-title">Not quite the role for you?</h2>
          ${openOk
    ? `<p class="role__more-text">Send an open application and tell us where you would fit. We keep every one on file and write when something opens up.</p>
          <button class="role__ghost" type="button" data-apply="open" data-role-open>Send an open application</button>`
    : '<p class="role__more-text">See what else is open, or write to us and tell us where you would fit.</p>'}
          <p class="role__more-mail">Questions about this role? <a href="mailto:${esc(email)}">${esc(email)}</a></p>
        </aside>
      </div>
    </div>

    <div class="role__dock" data-role-dock inert>
      <button class="role__cta role__cta--dock" type="button" data-role-apply>Apply for this role</button>
    </div>
  </main>`;
}

/**
 * A page for one of a role's old slugs (it lives at jobs/<old slug>/, so its links are
 * relative to that): the share card, then straight on to the current one.
 */
export function redirectPage(job, ctx) {
  const canonical = roleUrl(ctx.siteOrigin, job.slug);
  const to = `../${job.slug}/`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(job.title)} | GridX Careers</title>
  <meta name="robots" content="noindex">
  <meta name="description" content="${esc(describe(job))}">
  <link rel="canonical" href="${esc(canonical)}">
${shareTags(job, { canonical, image: job.ogImage })}
  <meta http-equiv="refresh" content="0; url=${esc(to)}">
  <script>location.replace(${scriptJson(to)} + location.search + location.hash);</script>
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:"DM Sans",system-ui,sans-serif;background:#cfcfcd;color:#141414}a{color:inherit}</style>
</head>
<body>
  <p>This role has moved: <a href="${esc(to)}">${esc(job.title)}</a></p>
</body>
</html>
`;
}

// ---------------------------------------------------------------- images
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JPEG, checked: the right magic, under the cap. Resolves { ok, bytes } or { ok: false, error }. */
export async function downloadJpeg(url, dest, { timeoutMs = 10000, attempts = 2 } = {}) {
  let error = '';
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(1200);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'gridx-site-build', Accept: 'image/jpeg' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (!res.ok) {
        error = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return { ok: false, error: 'not a JPEG' };
      if (buf.length > OG_MAX_BYTES) return { ok: false, error: `${Math.round(buf.length / 1024)} KB, over the 300 KB cap` };
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return { ok: true, bytes: buf.length };
    } catch (err) {
      error = err && err.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : String((err && err.message) || err);
    }
  }
  return { ok: false, error };
}

/** Run fn over items, at most n at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Where Paddock keeps the share cards, from the API address or from a role's own card. */
function ogBase(data) {
  const api = process.env.CAREERS_API || '';
  if (/^https?:\/\//.test(api)) return `${api.replace(/\/+$/, '')}/og/`;
  const any = data && data.jobs && data.jobs.find((j) => j.ogImage);
  if (any) {
    const m = /^(.*\/og\/)[^/]+\.jpg(\?.*)?$/.exec(any.ogImage);
    if (m) return m[1];
  }
  return PADDOCK_OG;
}

// ---------------------------------------------------------------- careers.html
function careersShareTags(siteOrigin, image) {
  const desc = 'Build the batteries and swap network that keep India\'s electric two-wheelers moving. See the open roles at GridX.';
  return [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="GridX">',
    '<meta property="og:locale" content="en_IN">',
    '<meta property="og:title" content="Careers at GridX">',
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(`${siteOrigin}/careers.html`)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:type" content="image/jpeg">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="Careers at GridX">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="Careers at GridX">',
    `<meta name="twitter:description" content="${esc(desc)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
  ].map((l) => `  ${l}`).join('\n');
}

/** A role's place in its team's list: Paddock's order, then featured first, then newest. */
export function byRoleOrder(a, b) {
  const s = (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
  if (s) return s;
  if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
  const t = (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
  if (t) return t;
  return String(a.title).localeCompare(String(b.title));
}

/**
 * The open roles by team, in the teams' order, each role a link to its own page: what
 * careers.html shows without JavaScript (careers.js takes it out and draws the timeline).
 * A role in a team the document does not list still shows, under its team's key.
 */
export function careersList(data) {
  const email = (data && data.org && data.org.careersEmail) || 'careers@gridxenergy.in';
  const mail = `<a href="mailto:${esc(email)}">${esc(email)}</a>`;
  const jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
  const domains = (data && Array.isArray(data.domains) ? data.domains : []).slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.label).localeCompare(String(b.label)));
  const known = new Set(domains.map((d) => d.key));
  const extra = [...new Set(jobs.map((j) => j.domain).filter((k) => k && !known.has(k)))]
    .map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]+/g, ' '), blurb: '' }));
  const teams = [...domains, ...extra]
    .map((d) => ({ d, roles: jobs.filter((j) => j.domain === d.key).sort(byRoleOrder) }))
    .filter((t) => t.roles.length);
  if (!teams.length) {
    const why = data ? 'There are no open roles right now.' : 'The open roles could not be listed here.';
    return `<div class="cr-static">
        <h2 class="cr-static__title">Careers at GridX</h2>
        <p class="cr-static__text">${why} Write to us at ${mail} and tell us where you would fit.</p>
      </div>`;
  }
  const facts = (j) => [clean(j.teamName), clean(j.location), EMPLOYMENT[j.employmentType], WORK_MODE[j.workMode]].filter(Boolean);
  const sections = teams.map(({ d, roles }) => `
        <section class="cr-static__team" id="${esc(d.key)}">
          <h3 class="cr-static__name">${esc(d.label)}</h3>
          ${clean(d.blurb) ? `<p class="cr-static__blurb">${esc(clean(d.blurb))}</p>` : ''}
          <ul class="cr-static__roles">${roles.map((j) => `
            <li><a class="cr-static__role" href="jobs/${esc(j.slug)}/">${esc(j.title)}</a> <span class="cr-static__facts">${esc(facts(j).join(' · '))}</span></li>`).join('')}
          </ul>
        </section>`).join('');
  return `<div class="cr-static">
        <h2 class="cr-static__title">Open roles</h2>${sections}
        <p class="cr-static__text">Not sure where you fit? Write to us at ${mail}.</p>
      </div>`;
}

/**
 * careers.html, as the build reads it: the share card goes where <!-- careers:og --> is, or
 * before </head> when the page has no marker and no og:image of its own; the whole careers
 * document goes where <!-- careers:data --> is, as the snapshot careers-data.js reads first;
 * and the plain list of roles (careersList) where <!-- careers:list --> is.
 */
function careersTransform(ctx) {
  return (name, html) => {
    if (name !== 'careers.html') return html;
    let out = html;
    const tags = careersShareTags(ctx.siteOrigin, ctx.careersImage);
    if (out.includes('<!-- careers:og -->')) out = out.replace('<!-- careers:og -->', () => tags.trimStart());
    else if (!/property="og:image"/.test(out)) out = out.replace(/\n?<\/head>/i, (m) => `\n${tags}${m}`);
    const data = ctx.data
      ? `<script type="application/json" id="careers-snapshot">${scriptJson(ctx.data)}</script>`
      : '';
    out = out.replace('<!-- careers:data -->', () => data); // a function: no $& in the roles' text is read as a pattern
    out = out.replace('<!-- careers:list -->', () => careersList(ctx.data));
    return out;
  };
}

// ---------------------------------------------------------------- the hooks
/**
 * Before the pages: images fetched, the document pointed at them, careers.html's transform
 * registered. Never throws over the network; a failure is a warning.
 *
 * @param {object|null} data  the validated careers document, or null
 * @param {{ out: string, registerSourceTransform: function, warn: function, siteOrigin: string }} deps
 */
export async function prepareCareers(data, { out, registerSourceTransform, warn, siteOrigin }) {
  const download = process.env.CAREERS_OG !== 'off' && Boolean(data || process.env.CAREERS_API);
  const base = ogBase(data);
  const ctx = { data, siteOrigin, careersImage: `${base}careers.jpg`, roles: [], images: { tried: 0, kept: 0 } };

  if (download) {
    const r = await downloadJpeg(`${base}careers.jpg`, path.join(out, 'assets/og/careers.jpg'));
    ctx.images.tried++;
    if (r.ok) {
      ctx.images.kept++;
      ctx.careersImage = `${siteOrigin}/assets/og/careers.jpg`;
    } else {
      warn(`careers: the careers share card did not download (${r.error}); careers.html points at Paddock's`);
    }
  }

  const jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
  await pool(jobs, 4, async (job) => {
    const version = job.publicVersion || 1;
    if (!job.ogImage) job.ogImage = `${base}${job.slug}.jpg?v=${version}`;
    if (!download) return;
    ctx.images.tried++;
    const r = await downloadJpeg(job.ogImage, path.join(out, 'jobs', job.slug, 'og.jpg'));
    if (r.ok) {
      ctx.images.kept++;
      job.ogImage = `${siteOrigin}/jobs/${job.slug}/og.jpg?v=${version}`;
    } else {
      warn(`careers: the share card for ${job.slug} did not download (${r.error}); its page points at Paddock's`);
    }
  });

  registerSourceTransform(careersTransform(ctx));
  return ctx;
}

/**
 * After the root pages: a page per role and a redirect per old slug, built by the build's
 * own buildPage. Returns the role URLs for the sitemap.
 *
 * @param {object} ctx  from prepareCareers
 * @param {{ out: string, buildId: string, buildPage: function }} deps
 */
export async function writeCareers(ctx, { out, buildId, buildPage }) {
  const urls = [];
  const jobs = ctx.data && Array.isArray(ctx.data.jobs) ? ctx.data.jobs : [];
  if (!jobs.length) {
    console.log(`careers: no role pages (${ctx.data ? 'nothing open' : 'no careers data'})`);
    return { urls };
  }
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const icons = loadIcons();
  const page = { ...ctx, icons };
  const current = new Set(jobs.map((j) => j.slug));
  let redirects = 0;

  for (const job of jobs) {
    const html = template
      .replace('<!-- role:head -->', () => roleHead(job, page))
      .replace('<!-- role:body -->', () => roleBody(job, page));
    const name = `jobs/${job.slug}/index.html`;
    const built = await buildPage(name, buildId, { html, prefix: '../../' });
    fs.mkdirSync(path.join(out, 'jobs', job.slug), { recursive: true });
    fs.writeFileSync(path.join(out, name), built);
    urls.push(roleUrl(ctx.siteOrigin, job.slug));

    for (const old of job.previousSlugs || []) {
      if (current.has(old) || old === job.slug) continue; // another role holds it now
      const oldName = `jobs/${old}/index.html`;
      const r = await buildPage(oldName, buildId, { html: redirectPage(job, page), prefix: '../../' });
      fs.mkdirSync(path.join(out, 'jobs', old), { recursive: true });
      fs.writeFileSync(path.join(out, oldName), r);
      redirects++;
    }
  }
  const img = ctx.images.tried ? `, share cards ${ctx.images.kept}/${ctx.images.tried} kept on the site` : '';
  console.log(`careers: ${jobs.length} role page${jobs.length === 1 ? '' : 's'}, ${redirects} redirect${redirects === 1 ? '' : 's'}${img}`);
  return { urls };
}
