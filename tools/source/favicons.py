#!/usr/bin/env python3
"""The site's icons: the GridX X on a dark tile, at every size a browser or a phone asks for.

    python3 tools/source/favicons.py            (npm run favicons)

  favicon.ico                         the browser tab: 16 (a standard screen), 32 (a sharp one,
                                      and the bookmarks bar) and 48 (Google's results, Windows'
                                      shortcuts), each drawn for its size. At the site's root,
                                      where every browser and crawler also looks unasked
  assets/icons/apple-touch-icon.png   an iPhone or iPad home screen, and Chrome's new tab tiles
  apple-touch-icon.png                (180); the same at the root, where iOS looks when a page
                                      names none
  assets/icons/icon-192.png           Android's home screen and Chrome's install sheet
  assets/icons/icon-512.png           Android's splash screen, and the largest anything shows
  assets/icons/icon-maskable-512.png  Android's adaptive icon: full bleed, the X in the safe zone
  assets/icons/site.webmanifest       names the Android icons

Every page links the three (tools/check/favicons.mjs checks they do, and that each resolves at
its size). The tab sizes are an ICO rather than an SVG on purpose: an SVG is drawn at whatever
size is asked, so it cannot be set on the pixels of a 16-pixel tab, and the ICO can.

The X is the logo's own (assets/gridX_logo.png), not a redrawing of it: each of its two pieces
is two curves and the straight lines between them, the curves fitted as cubic Beziers to the
edge of the 2048-pixel logo (left and right halves averaged, within 0.85 of a logo pixel
everywhere). The cream and the dark are the header pill's: the X of assets/gridX_logo_dark.png
on the pill's near black.

A 16-pixel tab cannot show the logo as it is. Scaled straight down the X is 6 pixels tall: its
two bars come out a pixel and a half thick and the gap between them half a pixel, so the two
pieces blur into one grey bar. Up to 48 pixels each size gets the same X with its heights set on
whole pixels instead (the tips, the bars and the gap; the curves and the width as drawn), and
the gap at least a whole pixel, so it is sharp at 1x and at 2x. The phone sizes, 180 and up,
are the logo's own proportions, scaled.

Every size is drawn sixteen times over and averaged down, so an edge's pixel is exactly as
covered as the shape covers it.
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / 'assets/icons'

INK = (238, 225, 210)    # the X of assets/gridX_logo_dark.png
TILE = (18, 18, 18)      # the header pill's near black, as it reads over the studio

# The X, in the logo's pixels: 630.4 wide, 248 tall, its top-left at (0, 0). Each piece is the
# region between two curves, mirrored left to right; the lower piece is the upper one upside down.
#   the tips' top edge    y = 0, from the outer curve to the inner one
#   the inner curve (B)   from the tip down to the bar's top edge, leaving the tip at a slant
#   the bar's top edge    y = BAR, across the middle
#   the outer curve (A)   from the tip down to the bar's bottom edge, leaving it straight down
#   the bar's bottom edge y = BOT
W, H = 631.0, 248.02
BAR, BOT = 51.0, 111.68
MID = H / 2  # the gap's centre: the gap runs from BOT to H - BOT
A = [(0.0, -9.97), (0.0, 121.12), (163.24, 111.68), (198.8, 111.68)]
B = [(82.44, 0.0), (99.63, 52.54), (152.81, 51.0), (206.16, 51.0)]


def bezier(p, n):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
                    u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]))
    return pts


def upper_piece(n=160):
    """The upper piece's outline, clockwise from its top-left tip, as a dense polygon."""
    a = [(x, y) for x, y in bezier(A, n * 4) if y >= 0]  # the outer curve below the tips' edge
    b = bezier(B, n)
    left = [a[0]] + b                                    # tip, along the top, down the inner curve
    right = [(W - x, y) for x, y in reversed(b)]         # across the bar's top, up the other inner curve
    right += [(W - a[0][0], 0.0)]                        # along the other tip
    right += [(W - x, y) for x, y in a]                  # down the other outer curve
    bottom = [(x, y) for x, y in reversed(a)]            # across the bar's bottom, up the first outer curve
    return left + right + bottom


UPPER = upper_piece()


def x_shapes(box, levels=None):
    """The X's two pieces as polygons, drawn into box = (left, top, width) in output pixels.

    levels, for the small sizes: the output y of the tips, the bar's top and the bar's bottom
    (the upper piece; the lower one mirrors them about the gap's centre), on whole pixels."""
    left, top, width = box
    s = width / W
    if levels is None:
        t0, t1, t2 = top, top + BAR * s, top + BOT * s
        mid = top + MID * s
    else:
        t0, t1, t2, mid = levels

    def y_of(y):
        if y <= BAR:
            return t0 + (t1 - t0) * y / BAR
        return t1 + (t2 - t1) * (y - BAR) / (BOT - BAR)

    upper = [(left + x * s, y_of(y)) for x, y in UPPER]
    lower = [(x, 2 * mid - y) for x, y in upper]
    return upper, lower


def rounded_square(size, radius, n=24):
    """A square with round corners, as a polygon."""
    import math
    pts = []
    for cx, cy, a0 in ((size - radius, radius, -90), (size - radius, size - radius, 0),
                       (radius, size - radius, 90), (radius, radius, 180)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return pts


def draw(size, tile, shapes, ss=16):
    """One icon: the tile (a polygon, or 'full' for the whole square, or None) and the X, drawn
    ss times over and averaged down."""
    big = size * ss
    tile_mask = Image.new('L', (big, big), 0)
    if tile == 'full':
        tile_mask.paste(255, (0, 0, big, big))
    elif tile:
        ImageDraw.Draw(tile_mask).polygon([(x * ss, y * ss) for x, y in tile], fill=255)
    ink_mask = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(ink_mask)
    for poly in shapes:
        d.polygon([(x * ss, y * ss) for x, y in poly], fill=255)
    tile_mask = tile_mask.resize((size, size), Image.BOX)
    ink_mask = ink_mask.resize((size, size), Image.BOX)
    out = Image.new('RGBA', (size, size), TILE + (0,))
    tp, ip, op = tile_mask.load(), ink_mask.load(), out.load()
    for y in range(size):
        for x in range(size):
            ta, ia = tp[x, y] / 255, ip[x, y] / 255
            a = ia + ta * (1 - ia)  # the X over the tile
            if a <= 0:
                continue
            rgb = tuple(round((INK[i] * ia + TILE[i] * ta * (1 - ia)) / a) for i in range(3))
            op[x, y] = rgb + (round(a * 255),)
    return out


# The small sizes, each set on its own pixels: the tile's corner radius, the X's left edge and
# width, and its levels (the tips, the bar's top, the bar's bottom, the gap's centre), all in
# output pixels. Bars and gap on whole pixels; the tips rise from the bar by about as much as
# the bar is thick, as in the logo.
SMALL = {
    16: dict(radius=3.5, left=1.5, width=13, levels=(4, 5, 7, 7.5)),     # bars 2, gap 1
    32: dict(radius=7, left=4, width=24, levels=(10, 12, 15, 16)),       # bars 3, gap 2, centred
    48: dict(radius=10.5, left=6, width=36, levels=(16, 19, 23, 24)),    # bars 4, gap 2, centred
}


def small(size):
    spec = SMALL[size]
    shapes = x_shapes((spec['left'], 0, spec['width']), spec['levels'])
    return draw(size, rounded_square(size, spec['radius']), shapes)


def large(size, share, tile):
    """The logo's own proportions: the X `share` of the width, centred, on a round-cornered tile
    ('round'), or on the whole square ('full') for the icons a phone rounds or masks itself."""
    width = size * share
    height = width * H / W
    shapes = x_shapes(((size - width) / 2, (size - height) / 2, width))
    ss = 16 if size <= 200 else 8
    return draw(size, 'full' if tile == 'full' else rounded_square(size, size * 0.22), shapes, ss)


def save_png(im, rel):
    path = REPO / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, optimize=True)
    return path


def version(path):
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tab = {size: small(size) for size in SMALL}
    # favicon.ico: the three tab sizes, each its own drawing (never one scaled from another).
    tab[48].save(REPO / 'favicon.ico', format='ICO', sizes=[(16, 16), (32, 32), (48, 48)],
                 append_images=[tab[16], tab[32]])

    # A phone's home screen: iOS and Android round or mask these themselves, so the tile is the
    # whole square. The X at 62% of the width, as the app's own icon has it; inside Android's
    # safe zone (the middle circle, 80% across) with room to spare at 58%.
    touch = large(180, 0.62, 'full')
    save_png(touch, 'assets/icons/apple-touch-icon.png')
    save_png(touch, 'apple-touch-icon.png')
    written = {}
    for name, im in (('icon-192.png', large(192, 0.62, 'round')),
                     ('icon-512.png', large(512, 0.62, 'round')),
                     ('icon-maskable-512.png', large(512, 0.58, 'full'))):
        written[name] = save_png(im, f'assets/icons/{name}')

    # The manifest names them with their versions, as the build versions everything else, so a
    # new drawing is never hidden behind an old one in a phone's cache.
    manifest = {
        'name': 'GridXenergy',
        'short_name': 'GridX',
        'start_url': '/',
        'display': 'browser',
        'background_color': '#%02x%02x%02x' % TILE,
        'theme_color': '#c4c4c2',
        'icons': [
            {'src': f'icon-192.png?v={version(written["icon-192.png"])}', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
            {'src': f'icon-512.png?v={version(written["icon-512.png"])}', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
            {'src': f'icon-maskable-512.png?v={version(written["icon-maskable-512.png"])}', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
        ],
    }
    (OUT / 'site.webmanifest').write_text(json.dumps(manifest, indent=2) + '\n')
    for rel in ('favicon.ico', 'apple-touch-icon.png', 'assets/icons/apple-touch-icon.png',
                *(f'assets/icons/{n}' for n in written), 'assets/icons/site.webmanifest'):
        print(f'{rel:40s} {(REPO / rel).stat().st_size:7d} bytes')


if __name__ == '__main__':
    main()
