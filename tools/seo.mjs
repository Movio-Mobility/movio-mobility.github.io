/*
 * What search engines and link scrapers read: every indexable page's share card (Open Graph
 * and Twitter tags) and its structured data (schema.org JSON-LD), injected at build time.
 *
 * The division of labour: the page's own head carries what a person could read in a tab, the
 * title, the description and the canonical, written by hand in the source. This module derives
 * everything else FROM those, so the head stays the single source and nothing here can say
 * something the page does not. The pictures are the committed cards from tools/source/og.py.
 *
 * Which pages: the eleven root pages keyed in PAGES below. careers.html and the job pages are
 * served by tools/careers.mjs (tools/check/careers-build.mjs pins their tags, so they are
 * never touched here), and 404.html, interview.html and better.html are noindex and stay bare.
 *
 * The structured data, page by page:
 *   index.html          Organization (the one full copy: every brand spelling in alternateName,
 *                       the legal name, the Okhla address, the support phone, the profiles in
 *                       sameAs) and WebSite, which is what lets Google show "GridXenergy" as
 *                       the site's name and tie GridX, GridXenergy and Grid Energy together.
 *   powerpod-gen2.html  Product with its pre-booking Offer, and the breadcrumb from the store.
 *   chargers, adapter,  Product per SKU with its price, from assets/catalogue.js run as the
 *   vehicle-dock        pages run it, so a price can never exist twice. The transform also
 *                       refuses to build if an offer's price is not printed on the page.
 *   store.html          ItemList of the four product pages (the store shows no prices).
 *   support.html        FAQPage, parsed out of the page's own static FAQ markup, so the
 *                       questions Google shows are exactly the ones a visitor reads.
 *   journey.html        AboutPage, pointing at the Organization.
 *   dealers.html        share card only; its dealer ItemList lives in tools/dealers.mjs.
 *
 * Honesty rule for the Gen2 offer: availability is PreOrder with availabilityStarts at the
 * launch instant (the same one assets/launch.js holds; tools/check/seo.mjs compares them).
 * When Gen2 ships, GEN2.availability flips to InStock here, in one place.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { esc, scriptJson } from './careers.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- the facts
// The profiles the site owns, for Organization.sameAs: the three the footer links, and the
// app's Play Store listing. One entity across all of them is what earns the knowledge panel.
export const SOCIAL = [
  'https://instagram.com/gridxenergy',
  'https://youtube.com/@gridxenergy',
  'https://linkedin.com/company/gridxenergy',
  'https://x.com/wearegridX',
  'https://play.google.com/store/apps/details?id=com.gridxapp',
];

// The office, as support.html prints it, and the support line.
export const OFFICE = {
  streetAddress: 'D66, First Floor, Pocket D, Okhla Phase 1',
  addressLocality: 'New Delhi',
  addressRegion: 'Delhi',
  postalCode: '110020',
  addressCountry: 'IN',
};
export const PHONE = '+919220199098';

// PowerPod Gen2: the price assets/powerpod-gen2.js prints, and the launch instant
// assets/launch.js holds (12 October 2026, 12:00 PM IST). When Gen2 ships, availability
// becomes 'InStock' and availabilityStarts goes.
export const GEN2 = {
  name: 'PowerPod Gen2',
  price: 24999,
  availability: 'PreOrder',
  availabilityStarts: '2026-10-12T12:00:00+05:30',
};

/** assets/catalogue.js run as a page runs it: the accessory SKUs, labels and prices. */
let catalogue = null;
export function loadCatalogue() {
  if (catalogue) return catalogue;
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'assets/catalogue.js'), 'utf8'), context, { filename: 'assets/catalogue.js' });
  catalogue = JSON.parse(JSON.stringify(context.window.gridCatalogue.ITEMS));
  return catalogue;
}
const sku = (id) => loadCatalogue().find((item) => item.sku === id);

// ---------------------------------------------------------------- small parts
const rupees = (n) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
const unescape = (s) => s.replace(/&#47;/g, '/').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The page's own head, read back so it stays the single source. */
function headOf(name, html) {
  const title = html.match(/<title>([^<]*)<\/title>/);
  const description = html.match(/<meta name="description" content="([^"]*)">/);
  const canonical = html.match(/<link rel="canonical" href="([^"]*)">/);
  if (!title || !description || !canonical) throw new Error(`${name}: no title, description or canonical to build the share card from`);
  return { title: unescape(title[1]), description: unescape(description[1]), canonical: canonical[1] };
}

/** The page with its scripts, styles and tags gone: the words a visitor can read. */
const visible = (html) => html
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');

/** A committed share card's address: absolute for the scrapers, versioned by its content. */
export function ogImageFor(file, origin) {
  const buf = fs.readFileSync(path.join(SRC, 'assets/og', file));
  return `${origin}/assets/og/${file}?v=${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10)}`;
}

const orgRef = (origin) => ({ '@type': 'Organization', '@id': `${origin}/#org`, name: 'GridX' });

function organization(origin) {
  return {
    '@type': 'Organization',
    '@id': `${origin}/#org`,
    name: 'GridXenergy',
    alternateName: ['GridX', 'Grid Energy'],
    legalName: 'Movio Technologies Private Limited',
    url: `${origin}/`,
    logo: `${origin}/assets/gridX_logo.png`,
    address: { '@type': 'PostalAddress', ...OFFICE },
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      telephone: PHONE,
      email: 'info@gridxenergy.in',
      areaServed: 'IN',
      availableLanguage: ['en', 'hi'],
    },
    sameAs: SOCIAL,
  };
}

function breadcrumbs(origin, pageUrl, title) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Store', item: `${origin}/store.html` },
      { '@type': 'ListItem', position: 2, name: title, item: pageUrl },
    ],
  };
}

/**
 * One Product with its Offer. The price is also demanded of the page itself, written the way
 * the pages write it (₹ and en-IN digit groups): a price that exists here but not in front of
 * the visitor is a drift, and it fails the build rather than shipping.
 */
function product(origin, page, { name, price, image, description, availability = 'InStock', availabilityStarts }, html) {
  if (!visible(html).includes(rupees(price))) {
    throw new Error(`${page}: the page does not show ${rupees(price)}, which the ${name} offer claims`);
  }
  const url = `${origin}/${page}`;
  return {
    '@type': 'Product',
    name,
    brand: { '@type': 'Brand', name: 'GridX' },
    image,
    description,
    url,
    offers: {
      '@type': 'Offer',
      url,
      price: String(price),
      priceCurrency: 'INR',
      availability: `https://schema.org/${availability}`,
      ...(availabilityStarts ? { availabilityStarts } : {}),
      itemCondition: 'https://schema.org/NewCondition',
      seller: orgRef(origin),
    },
  };
}

/** support.html's FAQ, read out of the page's own markup so it can never say anything else. */
export function faqJsonLd(html) {
  const items = [];
  const blocks = html.split('<li class="faq__item');
  for (const block of blocks.slice(1)) {
    const q = block.match(/<button[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/);
    const a = block.match(/<div class="faq__a">([\s\S]*?)<\/div>/);
    if (!q || !a) continue;
    items.push({
      '@type': 'Question',
      name: visible(q[1]).trim(),
      acceptedAnswer: { '@type': 'Answer', text: visible(a[1]).trim() },
    });
  }
  if (items.length < 10) throw new Error(`support.html: only ${items.length} FAQ items found in the markup`);
  return { '@type': 'FAQPage', mainEntity: items };
}

// ---------------------------------------------------------------- the pages
// Each indexable page: its card from tools/source/og.py, and its structured data built from
// the page itself. careers.html, the job pages and the noindex pages are not here on purpose.
const PAGES = {
  'index.html': {
    image: 'home.jpg',
    alt: 'The GridX PowerPod Gen2 portable battery',
    data: (origin) => [organization(origin), {
      '@type': 'WebSite',
      '@id': `${origin}/#website`,
      name: 'GridXenergy',
      alternateName: 'GridX',
      url: `${origin}/`,
      publisher: { '@id': `${origin}/#org` },
    }],
  },
  'store.html': {
    image: 'store.jpg',
    alt: 'The GridX lineup: PowerPod batteries, the charging adapter and the vehicle dock',
    data: (origin) => [{
      '@type': 'ItemList',
      name: 'GridX products',
      itemListElement: ['powerpod-gen2.html', 'chargers.html', 'adapter.html', 'vehicle-dock.html']
        .map((page, i) => ({ '@type': 'ListItem', position: i + 1, url: `${origin}/${page}` })),
    }],
  },
  'powerpod-gen2.html': {
    image: 'powerpod-gen2.jpg',
    alt: 'The GridX PowerPod Gen2 portable battery',
    data: (origin, html, head) => [
      breadcrumbs(origin, head.canonical, 'PowerPod Gen2'),
      product(origin, 'powerpod-gen2.html', {
        ...GEN2,
        image: [ogImageFor('powerpod-gen2.jpg', origin), `${origin}/assets/productImages/store/gen2.webp`],
        description: head.description,
      }, html),
    ],
  },
  'chargers.html': {
    image: 'brand.jpg',
    alt: 'The GridX mark',
    data: (origin, html, head) => [
      breadcrumbs(origin, head.canonical, 'Chargers'),
      ...['chg6a', 'chg10a'].map((id) => product(origin, 'chargers.html', {
        name: sku(id).label,
        price: sku(id).price,
        image: ogImageFor('brand.jpg', origin),
        description: head.description,
      }, html)),
    ],
  },
  'adapter.html': {
    image: 'adapter.jpg',
    alt: 'The GridX portable charging adapter',
    data: (origin, html, head) => [
      breadcrumbs(origin, head.canonical, 'Portable Charging Adapter'),
      product(origin, 'adapter.html', {
        name: sku('adapter').label,
        price: sku('adapter').price,
        image: ogImageFor('adapter.jpg', origin),
        description: head.description,
      }, html),
    ],
  },
  'vehicle-dock.html': {
    image: 'vehicle-dock.jpg',
    alt: 'A GridX PowerPod seated in the vehicle dock',
    data: (origin, html, head) => [
      breadcrumbs(origin, head.canonical, 'Vehicle Dock'),
      product(origin, 'vehicle-dock.html', {
        name: sku('dock').label,
        price: sku('dock').price,
        image: ogImageFor('vehicle-dock.jpg', origin),
        description: head.description,
      }, html),
    ],
  },
  'journey.html': {
    image: 'brand.jpg',
    alt: 'The GridX mark',
    data: (origin, html, head) => [{
      '@type': 'AboutPage',
      name: head.title,
      url: head.canonical,
      about: orgRef(origin),
    }],
  },
  'dealers.html': { image: 'brand.jpg', alt: 'The GridX mark' },
  'support.html': {
    image: 'brand.jpg',
    alt: 'The GridX mark',
    data: (origin, html) => [faqJsonLd(html)],
  },
  'privacy_policy.html': { image: 'brand.jpg', alt: 'The GridX mark' },
  'subscription_policy.html': { image: 'brand.jpg', alt: 'The GridX mark' },
};

/** The share card tags, in the shape tools/careers.mjs shareTags writes them. */
export function ogTags(name, origin, html) {
  const head = headOf(name, html);
  const page = PAGES[name];
  const image = ogImageFor(page.image, origin);
  const short = name === 'index.html' ? head.title : head.title.replace(/\s*\|.*$/, '');
  return [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="GridX">',
    '<meta property="og:locale" content="en_IN">',
    `<meta property="og:title" content="${esc(short)}">`,
    `<meta property="og:description" content="${esc(head.description)}">`,
    `<meta property="og:url" content="${esc(head.canonical)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:type" content="image/jpeg">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${esc(page.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(short)}">`,
    `<meta name="twitter:description" content="${esc(head.description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    `<meta name="twitter:image:alt" content="${esc(page.alt)}">`,
  ].join('\n  ');
}

/** Everything this module adds to one page, or '' for a page it leaves alone. */
export function headFor(name, origin, html) {
  const page = PAGES[name];
  if (!page) return '';
  let block = `<!-- The share card and the structured data (tools/seo.mjs). -->\n  ${ogTags(name, origin, html)}`;
  if (page.data) {
    const graph = { '@context': 'https://schema.org', '@graph': page.data(origin, html, headOf(name, html)) };
    block += `\n  <script type="application/ld+json">${scriptJson(graph)}</script>`;
  }
  return block;
}

/** The source transform build.mjs registers: the block goes in just before </head>. */
export function seoTransform({ siteOrigin }) {
  return (name, html) => {
    const block = headFor(name, siteOrigin, html);
    if (!block) return html;
    return html.replace(/\n?( *)<\/head>/i, (m) => `\n  ${block}${m}`);
  };
}

// ---------------------------------------------------------------- the sitemap's dates
const lastmods = new Map();
let gitUsable = null;

/** The page's last change, from git, as an ISO date; '' when git cannot say (then the sitemap
 * leaves lastmod out rather than stamp the build's own date on everything). */
export function lastmodOf(rel) {
  if (lastmods.has(rel)) return lastmods.get(rel);
  if (gitUsable === null) {
    try {
      gitUsable = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: SRC, encoding: 'utf8' }).trim() === 'false';
    } catch {
      gitUsable = false;
    }
  }
  let when = '';
  if (gitUsable) {
    try {
      when = execFileSync('git', ['log', '-1', '--format=%cI', '--', rel], { cwd: SRC, encoding: 'utf8' }).trim().slice(0, 10);
    } catch {
      when = '';
    }
  }
  lastmods.set(rel, when);
  return when;
}
