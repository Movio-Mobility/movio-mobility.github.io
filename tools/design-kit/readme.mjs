/*
 * The kit's README.html: a contact sheet of every file, opened straight from the folder.
 * Each item shows its smallest file on the backdrop it is meant for (light particles on the
 * studio, ink on white, white on the night) and links every size.
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const href = (rel) => rel.split('/').map(encodeURIComponent).join('/');

function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

const smallest = (list) => [...list].sort((a, b) => a.width * a.height - b.width * b.height)[0];
const bySize = (a, b) => a.width * a.height - b.width * b.height;
const sizeLabel = (f) => (f.scale && f.group !== 'logo' && f.group !== 'backgrounds' ? `@${f.scale}x` : `${f.width}×${f.height}`);

function links(list) {
  return [...list].sort(bySize).map((f) => `<a href="${href(f.rel)}" title="${f.width}×${f.height}">${sizeLabel(f)}</a>`).join('');
}

function tile({ thumb, backdrop, title, meta = '', rows, wide = false }) {
  return `
    <figure class="tile${wide ? ' tile--wide' : ''}">
      <a class="tile__thumb ${backdrop}" href="${href(thumb.rel)}"><img loading="lazy" src="${href(thumb.rel)}" alt="${esc(title)}"></a>
      <figcaption>
        <div class="tile__title">${esc(title)}</div>
        ${meta ? `<div class="tile__meta">${esc(meta)}</div>` : ''}
        ${rows.map(([label, list]) => `<div class="tile__links"><span>${esc(label)}</span>${links(list)}</div>`).join('')}
      </figcaption>
    </figure>`;
}

const backdropFor = (tone) => (tone === 'ink' ? 'on-white' : tone === 'white' ? 'on-night' : 'on-studio');

const PARTICLE_SECTIONS = [
  ['boxes', 'Boxes', 'Rounded-rect outlines with the store card\'s corner, and panels with a faint dust fill. Seven ratios in four sizes.'],
  ['circles', 'Circles', 'Rings, dust-filled discs, and single-particle bullets: an in-focus spark and soft bokeh discs.'],
  ['chevrons', 'Chevrons', 'Thin and double chevrons in four directions, and process-step outlines (first, middle, last) that tile left to right.'],
  ['arrows', 'Long arrows', 'A shaft that gathers out of nothing at its tail, with an open head.'],
  ['lines', 'Lines and ribbon', 'Dividers that fade at both ends, and the opening\'s five-lane ribbon as a band across a slide.'],
  ['logo', 'Particle logo', 'The lockup and the X traced in particles, as an outline or a stippled fill.'],
];

export function readme(files, { formats, backgrounds, swatches }) {
  const groups = groupBy(files, (f) => f.group);
  const count = (g) => (groups.get(g) || []).length;
  const out = [];

  // ---------------------------------------------------------------- backgrounds
  const bg = groups.get('backgrounds') || [];
  if (bg.length) {
    const bySection = groupBy(bg, (f) => f.section);
    const tiles = backgrounds.filter((b) => bySection.has(b.id)).map((b) => {
      const list = bySection.get(b.id);
      const thumb = smallest(list.filter((f) => f.item === '16x9')) || smallest(list);
      const rows = formats.map((fmt) => [fmt.label, list.filter((f) => f.item === fmt.id)]).filter(([, l]) => l.length);
      return tile({ thumb, backdrop: 'on-none', title: b.title, meta: b.note, rows, wide: true });
    });
    out.push(section('backgrounds', '01', 'Backgrounds', `Full-bleed backgrounds for slides and pages: the studio and the night room, plain or with particles at rest. Every size of a format is the same picture. ${count('backgrounds')} files.`, tiles));
  }

  // ---------------------------------------------------------------- particles
  const parts = groups.get('particles') || [];
  if (parts.length) {
    const subs = PARTICLE_SECTIONS.map(([id, title, note]) => {
      const list = parts.filter((f) => f.section === id);
      if (!list.length) return '';
      const items = groupBy(list, (f) => f.item);
      const tiles = [...items.values()].map((files) => {
        const light = files.filter((f) => f.tone === 'light');
        const ink = files.filter((f) => f.tone === 'ink');
        return `
          <figure class="tile tile--pair">
            <div class="pair">
              <a class="tile__thumb on-studio" href="${href(smallest(light).rel)}"><img loading="lazy" src="${href(smallest(light).rel)}" alt=""></a>
              <a class="tile__thumb on-white" href="${href(smallest(ink).rel)}"><img loading="lazy" src="${href(smallest(ink).rel)}" alt=""></a>
            </div>
            <figcaption>
              <div class="tile__title">${esc(files[0].title)}</div>
              <div class="tile__links"><span>Light</span>${links(light)}</div>
              <div class="tile__links"><span>Ink</span>${links(ink)}</div>
            </figcaption>
          </figure>`;
      });
      return `<h3>${esc(title)}</h3><p class="note">${esc(note)}</p><div class="tiles">${tiles.join('')}</div>`;
    }).join('');
    out.push(section('particles', '02', 'Particle shapes', `Transparent PNGs that hold only the particles forming each shape. Use <b>Light</b> on the studio and night backgrounds and <b>Ink</b> on white pages. @1x is drawn for a 1920×1080 slide, so it drops in at its natural size; use @2x or @4x for 4K, print or close crops. Every file keeps a 16px (@1x) transparent margin for the glow. ${count('particles')} files.`, [subs], true));
  }

  // ---------------------------------------------------------------- logo
  const logos = groups.get('logo') || [];
  if (logos.length) {
    const tiles = [...groupBy(logos, (f) => `${f.section}|${f.tone}`).values()].map((list) => {
      const f = list[0];
      return tile({ thumb: smallest(list), backdrop: f.tone === 'white' ? 'on-night' : 'on-white', title: `${f.item}, ${f.tone}`, rows: [['Width', list]] });
    });
    out.push(section('logo', '03', 'Logo', 'The GridX lockup, the wordmark and the X mark in brand colour, black (as the site\'s top bar shows it) and white (as the footer does), plus the PowerPod lockup. There is no vector original, so the widest sizes are rebuilt with a sharpened edge from the 2048px master.', tiles));
  }

  // ---------------------------------------------------------------- pill
  const pills = groups.get('pill') || [];
  if (pills.length) {
    const subs = [['expanded', 'Expanded', 'The nav pill at its three sizes: desktop 44px, tablet 52px, phone 56px (icon over label). One file per active tab; the Journey version shows the fifth, context tab.'],
      ['compact', 'Compact', 'The collapsed circle showing the current page\'s icon.'],
      ['blank', 'Blank', 'The capsule alone at three widths, for your own labels.']].map(([id, title, note]) => {
      const list = pills.filter((f) => f.section === id);
      const tiles = [...groupBy(list, (f) => f.item).values()].map((l) => tile({ thumb: smallest(l), backdrop: 'on-studio', title: l[0].title, rows: [['Size', l]] }));
      return `<h3>${title}</h3><p class="note">${note}</p><div class="tiles">${tiles.join('')}</div>`;
    }).join('');
    out.push(section('pill', '04', 'Tab bar pill', 'Each file includes the pill\'s soft drop shadow, so it has a 32px (@1x) transparent margin.', [subs], true));
  }

  // ---------------------------------------------------------------- timeline
  const tl = groups.get('timeline') || [];
  if (tl.length) {
    const subs = [['journey', 'Journey 2018 to 2026', 'The journey page\'s tape: the hairline, one dot per year and the year labels. "All" shows every year equally; each "active" file puts the needle on one year, swelling its label the way the page does. Captions add each year\'s theme under the line.'],
      ['blank', 'Blank tapes', 'Three to eight evenly spaced nodes with no labels, for timelines of your own.'],
      ['needle', 'Needle', 'The needle on its own, to place over a blank tape.']].map(([id, title, note]) => {
      const list = tl.filter((f) => f.section === id);
      const tiles = [...groupBy(list, (f) => `${f.item}|${f.tone}`).values()].map((l) =>
        tile({ thumb: smallest(l), backdrop: backdropFor(l[0].tone === 'white' ? 'white' : 'light'), title: `${l[0].title}, ${l[0].tone}`, rows: [['Size', l]], wide: id !== 'needle' }));
      return `<h3>${title}</h3><p class="note">${note}</p><div class="tiles">${tiles.join('')}</div>`;
    }).join('');
    out.push(section('timeline', '05', 'Timeline', 'Ink for the studio and white pages, white for the night. 1920 and 1600 wide at @1x, with @2x for 4K slides.', [subs], true));
  }

  // ---------------------------------------------------------------- cards
  const cards = groups.get('cards') || [];
  if (cards.length) {
    const subs = [['cards', 'Glass cards', 'The store card\'s frosted glass: a soft white gradient, a bright top edge and a low shadow. Made to sit on the studio background.'],
      ['buttons', 'Buttons', 'Blank pill buttons: black and ink (the site\'s main actions), glass (on the studio) and dark glass (on the night).']].map(([id, title, note]) => {
      const list = cards.filter((f) => f.section === id);
      const tiles = [...groupBy(list, (f) => f.item).values()].map((l) =>
        tile({ thumb: smallest(l), backdrop: l[0].item.startsWith('dark') ? 'on-night' : 'on-studio', title: l[0].title, rows: [['Size', l]] }));
      return `<h3>${title}</h3><p class="note">${note}</p><div class="tiles">${tiles.join('')}</div>`;
    }).join('');
    out.push(section('cards', '06', 'Cards and buttons', '', [subs], true));
  }

  // ---------------------------------------------------------------- tokens
  const tok = groups.get('tokens') || [];
  if (tok.length) {
    const tiles = [...groupBy(tok, (f) => f.item).values()].map((l) => tile({ thumb: smallest(l), backdrop: 'on-none', title: l[0].title, rows: [['Size', l]], wide: true }));
    const chips = swatches.map((s) => `<div class="chip"><span style="background:${s.css}"></span><b>${esc(s.name)}</b><em>${esc(s.hex)}</em></div>`).join('');
    out.push(section('tokens', '07', 'Tokens and examples', 'Colour, type and parts on one sheet, the same values as JSON (07_tokens/gridx_tokens.json), and two example slides built only from this kit.', [`<div class="chips">${chips}</div><div class="tiles">${tiles.join('')}</div>`], true));
  }

  return page(out.join(''), files.length);
}

function section(id, number, title, intro, tiles, raw = false) {
  return `
  <section id="${id}">
    <p class="eyebrow">${number}</p>
    <h2>${esc(title)}</h2>
    ${intro ? `<p class="intro">${intro}</p>` : ''}
    ${raw ? tiles.join('') : `<div class="tiles">${tiles.join('')}</div>`}
  </section>`;
}

function page(body, total) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GridX design kit</title>
<style>
  @font-face {
    font-family: 'DM Sans';
    font-weight: 400 700;
    src: url("Particle%20Studio/fonts/dm-sans-latin.woff2") format('woff2'),
         url("https://fonts.gstatic.com/s/dmsans/v17/rP2Hp2ywxg089UriCZOIHTWEBlw.woff2") format('woff2');
  }
  :root { --ink: #141414; --quiet: rgb(20 20 20 / 0.52); --hair: rgb(20 20 20 / 0.12); }
  * { box-sizing: border-box; }
  html {
    background-color: #cfcfcd;
    background-image:
      radial-gradient(ellipse 26% 16% at 37% 30%, rgb(236 236 234 / 0.95), rgb(236 236 234 / 0) 70%),
      radial-gradient(ellipse 60% 8% at 74% 41%, rgb(236 236 234 / 0.9), rgb(236 236 234 / 0) 80%),
      linear-gradient(180deg, #aeaeac 0%, #bdbdbb 26%, #d6d6d4 37%, #cfcfcd 46%, #d3d3d1 70%, #d8d8d6 100%);
    background-attachment: fixed;
  }
  body {
    margin: 0;
    padding: 72px max(16px, 5vw) 120px;
    font-family: "DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
  }
  header { max-width: 980px; }
  header img { width: 200px; height: auto; filter: brightness(0); }
  h1 { margin: 36px 0 14px; font-size: clamp(2.4rem, 5vw, 4.4rem); font-weight: 500; letter-spacing: -0.03em; line-height: 1.02; }
  .lede a { color: var(--ink); font-weight: 600; text-underline-offset: 4px; text-decoration-color: rgb(20 20 20 / 0.35); }
  .lede { font-size: 1.2rem; line-height: 1.5; color: rgb(20 20 20 / 0.78); letter-spacing: -0.01em; margin: 0 0 28px; }
  .rules { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin: 0 0 18px; padding: 0; list-style: none; }
  .rules li {
    padding: 16px 18px; border-radius: 18px; font-size: 0.95rem; line-height: 1.45; color: rgb(20 20 20 / 0.78);
    background: linear-gradient(160deg, rgb(255 255 255 / 0.32), rgb(255 255 255 / 0.12));
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.5), inset 0 0 0 1px rgb(255 255 255 / 0.22);
  }
  .rules b { color: var(--ink); font-weight: 600; }
  nav.toc { display: flex; flex-wrap: wrap; gap: 6px; margin: 28px 0 0; }
  nav.toc a {
    padding: 9px 14px; border-radius: 999px; background: #000; color: rgb(255 255 255 / 0.75);
    font-size: 0.875rem; font-weight: 500; text-decoration: none;
  }
  nav.toc a:hover { color: #fff; }
  section { margin-top: 96px; }
  .eyebrow { margin: 0 0 8px; font-size: 0.72rem; font-weight: 500; letter-spacing: 0.09em; text-transform: uppercase; color: rgb(20 20 20 / 0.4); }
  h2 { margin: 0 0 12px; font-size: clamp(1.9rem, 2.2vw + 1rem, 3rem); font-weight: 600; letter-spacing: -0.03em; line-height: 1.05; }
  h3 { margin: 48px 0 6px; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.02em; }
  .intro { max-width: 860px; margin: 0 0 8px; font-size: 1.05rem; line-height: 1.55; color: rgb(20 20 20 / 0.78); }
  .note { max-width: 860px; margin: 0 0 18px; font-size: 0.95rem; line-height: 1.5; color: var(--quiet); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .tile {
    margin: 0; display: flex; flex-direction: column; border-radius: 18px; overflow: hidden;
    background: linear-gradient(160deg, rgb(255 255 255 / 0.3), rgb(255 255 255 / 0.1));
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.5), inset 0 0 0 1px rgb(255 255 255 / 0.2), 0 16px 36px -26px rgb(20 20 20 / 0.35);
  }
  .tile--wide { grid-column: span 2; }
  .tile__thumb { display: flex; align-items: center; justify-content: center; height: 150px; padding: 12px; overflow: hidden; }
  .tile--wide .tile__thumb { height: 220px; }
  .tile__thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .on-none { padding: 0; }
  .on-none img { width: 100%; height: 100%; object-fit: cover; max-height: none; }
  .on-studio { background: linear-gradient(180deg, #bdbdbb, #d6d6d4 40%, #cfcfcd); }
  .on-white { background: #fff; }
  .on-night { background: radial-gradient(120% 90% at 60% 40%, #4a4a4a, #383838); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; }
  .pair .tile__thumb { height: 130px; }
  figcaption { padding: 12px 14px 14px; }
  .tile__title { font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; }
  .tile__meta { margin-top: 4px; font-size: 0.85rem; line-height: 1.4; color: var(--quiet); }
  .tile__links { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin-top: 6px; font-size: 0.8rem; }
  .tile__links span { min-width: 3.2em; color: rgb(20 20 20 / 0.42); font-weight: 500; }
  .tile__links a { color: var(--ink); font-weight: 500; text-decoration: none; border-bottom: 1px solid rgb(20 20 20 / 0.25); font-variant-numeric: tabular-nums; }
  .tile__links a:hover { border-color: var(--ink); }
  .chips { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; margin: 18px 0 22px; }
  .chip { display: grid; grid-template-columns: 34px 1fr; column-gap: 10px; align-items: center; }
  .chip span { grid-row: span 2; width: 34px; height: 34px; border-radius: 10px; box-shadow: inset 0 0 0 1px rgb(20 20 20 / 0.1); }
  .chip b { font-size: 0.9rem; font-weight: 600; }
  .chip em { font-style: normal; font-size: 0.8rem; color: var(--quiet); font-variant-numeric: tabular-nums; }
  footer { margin-top: 96px; font-size: 0.85rem; color: var(--quiet); }
  @media (max-width: 640px) {
    .tile--wide { grid-column: auto; }
    .tile--wide .tile__thumb { height: 160px; }
  }
</style>
</head>
<body>
<header>
  <img src="03_logo/gridx_logo_lockup_color_512w.png" alt="GridX">
  <h1>Design kit</h1>
  <p class="lede">The website's look, as files for decks in Canva, PowerPoint, Google Slides and Docs. Start from a background, add particle shapes, the logo, the pill or the timeline, and set type in DM Sans. To turn any picture into particles or a monochrome mark, open <a href="Particle%20Studio/index.html">Particle Studio</a>.</p>
  <ul class="rules">
    <li><b>Type is DM Sans.</b> It is built into Canva and Google Slides and Docs. For PowerPoint, install it from fonts.google.com/specimen/DM+Sans. Headlines use weight 500, headings 600, and body text 500 in ink at 78%.</li>
    <li><b>@1x fits a 1920×1080 slide.</b> Particle shapes, pills and timelines are drawn at slide pixels, so @1x drops in at its natural size. Use @2x or @4x for 4K exports, print or close crops.</li>
    <li><b>Never stretch a particle PNG.</b> Stretching squashes the dots. Pick the nearest size or ratio instead: boxes come in seven ratios and four sizes.</li>
    <li><b>Light or Ink.</b> Light particles are light: they show on the studio and night backgrounds and vanish on white. Use Ink on white pages and Google Docs.</li>
  </ul>
  <nav class="toc">
    <a href="#backgrounds">Backgrounds</a><a href="#particles">Particle shapes</a><a href="#logo">Logo</a><a href="#pill">Tab bar pill</a><a href="#timeline">Timeline</a><a href="#cards">Cards and buttons</a><a href="#tokens">Tokens</a><a href="Particle%20Studio/index.html">Particle Studio</a>
  </nav>
</header>
${body}
<footer>${total} files. Generated from the website's source by tools/design-kit (npm run design-kit), so a fresh run picks up any change to the site.</footer>
</body>
</html>
`;
}
