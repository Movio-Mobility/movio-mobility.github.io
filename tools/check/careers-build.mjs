#!/usr/bin/env node
/*
 * The careers build, checked: role pages, their share cards and JobPosting, the old slugs'
 * redirects, the sitemap, careers.html's card, snapshot and plain list of roles, the
 * interview page's privacy, and a build with no careers data at all.
 *
 *   npm run check:careers-build
 *
 * Four real builds (tools/build.mjs, as CI runs it) into a scratch folder:
 *   mock      CAREERS_API at tools/check/paddock-mock.mjs: everything, images included
 *   fixture   CAREERS_FIXTURE with CAREERS_OG=off: pages, cards left on Paddock
 *   none      no careers variables: no role pages, and the build still passes
 *   down      the mock answering 500 and no snapshot: no role pages, and still passes
 * plus the pinned icon set (every name drawn) and the build module's own helpers.
 *
 * The scratch folder is under the system temp folder (CHECK_TMP to choose another) and is
 * removed afterwards unless --keep is given.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock } from './paddock-mock.mjs';
import { checkIcons } from '../source/icons.mjs';
import { esc, formatPay, formatExperience, jobPosting } from '../careers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FIXTURE = path.join(HERE, 'fixtures/careers.json');
const ORIGIN = 'https://gridxenergy.in';
const keep = process.argv.includes('--keep');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
}

const scratch = fs.mkdtempSync(path.join(process.env.CHECK_TMP || os.tmpdir(), 'gridx-careers-build-'));
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/** One build in a child process. Asynchronous, so the mock in this process can answer it. */
function build(name, env) {
  const out = path.join(scratch, name);
  const clean = { ...process.env };
  for (const k of ['CAREERS_API', 'CAREERS_FIXTURE', 'CAREERS_SNAPSHOT', 'CAREERS_OG', 'DEALERS_API', 'DEALERS_FIXTURE', 'DEALERS_SNAPSHOT', 'GITHUB_OUTPUT', 'GITHUB_ACTIONS', 'BUILD_OUT']) delete clean[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'tools/build.mjs'), '--out', out], { cwd: REPO, env: { ...clean, ...env } });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const timer = setTimeout(() => child.kill(), 240000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ out, status, log });
    });
  });
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const decode = (s) => s.replace(/&#47;/g, '/').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function meta(html, key) {
  const re = new RegExp(`<meta (?:property|name)="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" content="([^"]*)"`);
  const m = re.exec(html);
  return m ? decode(m[1]) : null;
}
const linkCanonical = (html) => {
  const m = /<link rel="canonical" href="([^"]*)"/.exec(html);
  return m ? decode(m[1]) : null;
};
const scriptsOf = (html, type) => [...html.matchAll(new RegExp(`<script type="${type.replace('+', '\\+')}"[^>]*>([\\s\\S]*?)</script>`, 'g'))].map((m) => m[1]);
const isJpeg = (file) => {
  if (!fs.existsSync(file)) return false;
  const b = fs.readFileSync(file);
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b.length < 300 * 1024;
};

/** Every inline script allowed by its hash, and every local reference shipped. */
function securedAndWhole(out, rel, html) {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  if (!csp) return 'no CSP';
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const h = `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`;
    if (!csp[1].includes(h)) return `an inline script is not in the CSP (${m[1].slice(0, 40)})`;
  }
  if (/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<script[\s\S]*?<\/script>/g, ''))) return 'an inline event handler';
  const dir = path.dirname(path.join(out, rel));
  for (const m of html.matchAll(/(?:src|href)="((?:\.\.\/)*assets\/[^"?#]+)/g)) {
    if (!fs.existsSync(path.resolve(dir, m[1]))) return `missing ${m[1]}`;
  }
  return '';
}

try {
  // ---------------------------------------------------------------- icons and helpers
  const icons = checkIcons();
  check('icons: every pinned name is drawn', icons.ok, icons.ok ? `${icons.names.length} names` : `missing ${icons.missing.join(', ')}; extra ${icons.extra.join(', ')}`);
  check('helpers: "assets/" in Paddock text is defused, URLs are not', esc('see assets/cv.pdf') === 'see assets&#47;cv.pdf' && esc('https://x.in/assets/a.jpg') === 'https://x.in/assets/a.jpg');
  check('helpers: pay and experience read naturally',
    formatPay({ min: 1200000, max: 1800000, period: 'year' }) === '₹12 to 18 lakh a year'
    && formatPay({ min: 25000, max: 40000, period: 'month' }) === '₹25,000 to ₹40,000 a month'
    && formatExperience({ min: 2, max: 5 }) === '2 to 5 years' && formatExperience({ min: 0, max: 1 }) === 'Up to 1 year',
    `${formatPay({ min: 1200000, max: 1800000, period: 'year' })}; ${formatPay({ min: 25000, max: 40000, period: 'month' })}`);
  const remoteLd = jobPosting(fixture.jobs.find((j) => j.workMode === 'remote'), { siteOrigin: ORIGIN });
  check('helpers: a remote role is TELECOMMUTE with India as the place to apply from',
    remoteLd.jobLocationType === 'TELECOMMUTE' && remoteLd.applicantLocationRequirements?.name === 'India' && !remoteLd.jobLocation);

  // ---------------------------------------------------------------- 1. with the mock
  const mock = await startMock({ port: 0 + (Number(process.env.MOCK_PORT) || 3141), quiet: true });
  const api = `${mock.url}/api/public/website/careers`;
  const a = await build('mock', { CAREERS_API: api, CAREERS_SNAPSHOT: `${mock.url}/no-snapshot.json` });
  check('mock build: exits 0', a.status === 0, a.status === 0 ? '' : a.log.slice(-800));
  check('mock build: reports its role pages', /careers: 5 role pages, 1 redirect, share cards 6\/6/.test(a.log), (a.log.match(/careers:.*$/m) || [''])[0]);

  const EMPLOYMENT = { 'full-time': 'FULL_TIME', 'part-time': 'PART_TIME', internship: 'INTERN', contract: 'CONTRACTOR' };
  for (const job of fixture.jobs) {
    const rel = `jobs/${job.slug}/index.html`;
    const html = read(path.join(a.out, rel));
    if (!html) {
      check(`role ${job.slug}: page exists`, false);
      continue;
    }
    const url = `${ORIGIN}/jobs/${job.slug}/`;
    const image = `${ORIGIN}/jobs/${job.slug}/og.jpg?v=${job.publicVersion}`;
    const head = html.includes(`<title>${job.title} | GridX Careers</title>`)
      && linkCanonical(html) === url
      && meta(html, 'description') && meta(html, 'og:title') === `${job.title} at GridX`
      && meta(html, 'og:url') === url && meta(html, 'og:image') === image && meta(html, 'twitter:image') === image
      && meta(html, 'twitter:card') === 'summary_large_image' && meta(html, 'og:image:width') === '1200';
    check(`role ${job.slug}: title, canonical, share tags`, head, head ? '' : `og:image ${meta(html, 'og:image')}`);
    check(`role ${job.slug}: share card on the site, a JPEG under 300 KB`, isJpeg(path.join(a.out, 'jobs', job.slug, 'og.jpg')));

    let ld = null;
    try { ld = JSON.parse(scriptsOf(html, 'application/ld+json')[0]); } catch (err) { ld = null; }
    const ldOk = ld && ld['@type'] === 'JobPosting' && ld.title === job.title && ld.directApply === true
      && ld.hiringOrganization?.name === 'GridX' && ld.hiringOrganization?.logo === `${ORIGIN}/assets/gridX_logo.png`
      && ld.employmentType === EMPLOYMENT[job.employmentType] && ld.datePosted === job.publishedAt.slice(0, 10)
      && typeof ld.description === 'string' && ld.description.includes(job.responsibilities[0])
      && (job.closesAt ? ld.validThrough === new Date(job.closesAt).toISOString() : !('validThrough' in ld))
      && (job.compensation ? ld.baseSalary?.value?.minValue === job.compensation.min && ld.baseSalary.currency === 'INR' : !('baseSalary' in ld))
      && (job.workMode === 'remote' ? ld.jobLocationType === 'TELECOMMUTE' : ld.jobLocation?.address?.['@type'] === 'PostalAddress');
    check(`role ${job.slug}: JobPosting parses and fits`, Boolean(ldOk), ld ? JSON.stringify({ type: ld.employmentType, loc: ld.jobLocation?.address?.addressLocality, pay: Boolean(ld.baseSalary), through: ld.validThrough }) : 'no JSON-LD');

    let snap = null;
    try { snap = JSON.parse(scriptsOf(html, 'application/json')[0]); } catch (err) { snap = null; }
    check(`role ${job.slug}: carries its slice of the careers document`, snap && snap.scope === 'role' && snap.jobs.length === 1 && snap.jobs[0].id === job.id && snap.apply?.consent?.version === fixture.apply.consent.version);

    const body = html.includes(`<h1 class="role__title">${job.title}</h1>`) && html.includes('data-role-apply')
      && html.includes('href="../../careers.html"') && html.includes('aria-current="true"')
      && job.responsibilities.every((r) => html.includes(r));
    check(`role ${job.slug}: prerendered with the site's chrome`, body);
    const whole = securedAndWhole(a.out, rel, html);
    check(`role ${job.slug}: CSP covers every inline script, every asset ships`, !whole, whole);
  }

  const old = read(path.join(a.out, 'jobs/firmware-engineer/index.html'));
  check('previous slug: redirects, with the share card and the new canonical',
    old.includes('<meta http-equiv="refresh" content="0; url=../embedded-firmware-engineer/">')
    && old.includes('location.replace("../embedded-firmware-engineer/"')
    && linkCanonical(old) === `${ORIGIN}/jobs/embedded-firmware-engineer/`
    && meta(old, 'og:image') === `${ORIGIN}/jobs/embedded-firmware-engineer/og.jpg?v=7`
    && old.includes('<meta name="robots" content="noindex">'));
  check('previous slug: its redirect is CSP clean', !securedAndWhole(a.out, 'jobs/firmware-engineer/index.html', old));

  const sitemap = read(path.join(a.out, 'sitemap.xml'));
  check('sitemap: every role page, no redirect, no interview page',
    fixture.jobs.every((j) => sitemap.includes(`<loc>${ORIGIN}/jobs/${j.slug}/</loc>`))
    && !sitemap.includes('/jobs/firmware-engineer/') && !sitemap.includes('interview'));

  const careers = read(path.join(a.out, 'careers.html'));
  check('careers.html: share card on the site', meta(careers, 'og:image') === `${ORIGIN}/assets/og/careers.jpg` && isJpeg(path.join(a.out, 'assets/og/careers.jpg')), meta(careers, 'og:image'));
  let pageSnap = null;
  try { pageSnap = JSON.parse(scriptsOf(careers, 'application/json')[0]); } catch (err) { pageSnap = null; }
  check('careers.html: carries the whole careers document for its first paint', pageSnap && pageSnap.version === fixture.version && pageSnap.jobs.length === fixture.jobs.length && !pageSnap.scope);
  check('careers.html: the plain list for reading without JavaScript, every role linking to its page',
    careers.includes('<div class="cr-static">') && fixture.jobs.every((j) => careers.includes(`href="jobs/${j.slug}/"`))
    && fixture.domains.every((d) => careers.includes(`id="${d.key}"`)) && !careers.includes('careers:list'));

  let snapshot = null;
  try { snapshot = JSON.parse(read(path.join(a.out, 'careers/snapshot.json'))); } catch (err) { snapshot = null; }
  check('careers/snapshot.json: as built, share cards on the site',
    snapshot && snapshot.version === fixture.version && snapshot.jobs.every((j) => j.ogImage === `${ORIGIN}/jobs/${j.slug}/og.jpg?v=${j.publicVersion}`));

  const sw = read(path.join(a.out, 'sw.js'));
  check('sw.js: never caches the interview page, either address', /NEVER_CACHED = new Set\(\['\/interview\.html', '\/interview'\]\)/.test(sw) && sw.includes('if (NEVER_CACHED.has(url.pathname)) return;'));

  const iv = read(path.join(a.out, 'interview.html'));
  const ivHead = iv.slice(0, iv.indexOf('</head>'));
  check('interview.html: noindex, no referrer at all, and only its own referrer rule',
    iv.includes('<meta name="robots" content="noindex, nofollow">') && iv.includes('<meta name="referrer" content="no-referrer">')
    && !iv.includes('strict-origin-when-cross-origin'));
  const tokenAt = ivHead.indexOf('gridx.interview.t');
  const firstSrc = ivHead.search(/<script src=|<link rel="stylesheet"/);
  check('interview.html: the token is moved before anything loads', tokenAt > 0 && (firstSrc < 0 || tokenAt < firstSrc));
  const ivWhole = securedAndWhole(a.out, 'interview.html', iv);
  check('interview.html: CSP covers every inline script', !ivWhole, ivWhole);

  await mock.close();

  // ---------------------------------------------------------------- 2. from the fixture
  const b = await build('fixture', { CAREERS_FIXTURE: FIXTURE, CAREERS_OG: 'off', CAREERS_SNAPSHOT: 'http://127.0.0.1:9/none.json' });
  check('fixture build: exits 0', b.status === 0, b.status === 0 ? '' : b.log.slice(-800));
  const fx = read(path.join(b.out, 'jobs/power-electronics-intern/index.html'));
  check('fixture build: role pages, cards left on Paddock',
    Boolean(fx) && meta(fx, 'og:image') === fixture.jobs[1].ogImage && !fs.existsSync(path.join(b.out, 'jobs/power-electronics-intern/og.jpg')),
    meta(fx, 'og:image'));
  check('fixture build: careers.html points at Paddock\'s card', meta(read(path.join(b.out, 'careers.html')), 'og:image') === 'https://paddockgridx.app/api/public/website/careers/og/careers.jpg');

  // ---------------------------------------------------------------- 3. no data at all
  const c = await build('none', {});
  check('no-data build: exits 0', c.status === 0, c.status === 0 ? '' : c.log.slice(-800));
  check('no-data build: no role pages, no roles in the sitemap', !fs.existsSync(path.join(c.out, 'jobs')) && !read(path.join(c.out, 'sitemap.xml')).includes('/jobs/'));
  check('no-data build: careers.html still has its card', meta(read(path.join(c.out, 'careers.html')), 'og:image') === 'https://paddockgridx.app/api/public/website/careers/og/careers.jpg');
  const bare = read(path.join(c.out, 'careers.html'));
  check('no-data build: no snapshot, and the plain list says where to write instead',
    !bare.includes('id="careers-snapshot"') && /could not be listed here/.test(bare) && bare.includes('mailto:info@gridxenergy.in'));

  // ---------------------------------------------------------------- 4. Paddock down
  const down = await startMock({ port: 3142, quiet: true });
  await fetch(`${down.url}/__mock/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modes: { careers: 'error' } }) });
  const d = await build('down', { CAREERS_API: `${down.url}/api/public/website/careers`, CAREERS_SNAPSHOT: `${down.url}/no-snapshot.json` });
  await down.close();
  check('Paddock down: exits 0, with no role pages and data_ok false',
    d.status === 0 && !fs.existsSync(path.join(d.out, 'jobs')) && /careers none/.test(d.log) && /data_ok false/.test(d.log),
    d.status === 0 ? (d.log.match(/^data:.*$/m) || [''])[0] : d.log.slice(-800));
} catch (err) {
  failed++;
  console.log(`FAIL  the check itself: ${err.stack || err}`);
} finally {
  if (!keep) fs.rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept ${scratch}`);
}

console.log(failed ? `\n${failed} careers build check(s) failed` : '\ncareers build: all checks pass');
process.exitCode = failed ? 1 : 0;
