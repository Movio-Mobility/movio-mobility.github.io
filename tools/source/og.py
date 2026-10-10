#!/usr/bin/env python3
"""The share cards (Open Graph images), 1200 by 630, one per page (npm run og).

    python3 tools/source/og.py

  assets/og/home.jpg           index.html          the Gen2 pod
  assets/og/powerpod-gen2.jpg  powerpod-gen2.html  the Gen2 pod, front perspective
  assets/og/store.jpg          store.html          the lineup: adapter, Gen1, Gen2, dock
  assets/og/adapter.jpg        adapter.html        the portable charging adapter
  assets/og/vehicle-dock.jpg   vehicle-dock.html   the dock with a pod seated in it
  assets/og/brand.jpg          chargers (no cut-out render exists), journey, dealers,
                               support and both policies: the X mark alone

The look is the site's own studio: the light grey the pages stand in (site.css's gradient),
with the subject on a drawn shadow and the X from the logo as the mark, in the logo's own dark
ink. The X is drawn from the same fitted curves the favicons use (tools/source/favicons.py),
so every mark on every surface is the one shape. Renders with their background baked in (the
adapter's and the dock's gallery photographs, shot on the same grey) float as rounded gallery
cards instead, the way the pages show them.

tools/seo.mjs points each page's og:image at its card with a content hash, and
tools/check/seo.mjs holds every card to 1200 by 630 and under 300 KB. careers.jpg is never
written here: the build saves the careers card it downloads from Paddock to
dist/assets/og/careers.jpg, and a committed file of that name would overwrite it.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from favicons import x_shapes, W as X_W, H as X_H  # noqa: E402  (the X, as fitted curves)

REPO = HERE.parents[1]
OUT = REPO / 'assets/og'
IMAGES = REPO / 'assets/productImages'
SIZE = (1200, 630)
X_INK = (30, 30, 47)  # the X of assets/gridX_logo.png


def studio():
    """The site's grey studio, as site.css paints it: darker above, lighter below, with a soft
    high light left of centre."""
    stops = [(0.0, (174, 174, 172)), (0.26, (189, 189, 187)), (0.37, (214, 214, 212)),
             (0.46, (207, 207, 205)), (0.70, (211, 211, 209)), (1.0, (216, 216, 214))]
    img = Image.new('RGB', SIZE)
    px = img.load()
    for y in range(SIZE[1]):
        t = y / (SIZE[1] - 1)
        for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
            if t0 <= t <= t1:
                f = (t - t0) / (t1 - t0)
                row = tuple(round(c0[i] + (c1[i] - c0[i]) * f) for i in range(3))
                break
        for x in range(SIZE[0]):
            px[x, y] = row
    glow = Image.new('L', SIZE, 0)
    ImageDraw.Draw(glow).ellipse((444 - 310, 190 - 100, 444 + 310, 190 + 100), fill=200)
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    img = Image.composite(Image.new('RGB', SIZE, (236, 236, 234)), img, glow.point(lambda v: v * 0.55))
    return img


def xmark(width, ink=X_INK, ss=8):
    """The X at `width`, drawn from the favicons' fitted curves."""
    height = width * X_H / X_W
    big = Image.new('L', (round(width * ss), round(height * ss)), 0)
    d = ImageDraw.Draw(big)
    for poly in x_shapes((0, 0, width)):
        d.polygon([(x * ss, y * ss) for x, y in poly], fill=255)
    mask = big.resize((round(width), round(height)), Image.BOX)
    mark = Image.new('RGBA', mask.size, ink + (0,))
    mark.putalpha(mask)
    return mark


def render(path, height):
    """A cut-out render cropped to its ink and scaled to `height`."""
    img = Image.open(path).convert('RGBA')
    img = img.crop(img.getchannel('A').getbbox())
    return img.resize((round(img.width * height / img.height), height), Image.LANCZOS)


def ground(card, cx, base_y, width):
    """The shadow a subject stands on: a tight band at the contact, a wide soft one around."""
    for reach, drop, blur, dark in ((width * 0.5, 10, 8, 110), (width * 0.9, 26, 30, 60)):
        layer = Image.new('L', SIZE, 0)
        ImageDraw.Draw(layer).ellipse((cx - reach, base_y - drop, cx + reach, base_y + drop), fill=dark)
        card.paste((20, 20, 20), (0, 0), layer.filter(ImageFilter.GaussianBlur(blur)))


def place(card, img, cx, base_y):
    ground(card, cx, base_y, img.width)
    card.paste(img, (round(cx - img.width / 2), base_y - img.height), img)


def plate(card, path, width=720, radius=28):
    """A gallery photograph as the pages show it: rounded corners, floating on a soft shadow,
    set a little low so the mark in the corner has air."""
    img = Image.open(path).convert('RGB')
    img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    w, h = img.size
    x, y = round((SIZE[0] - w) / 2), round((SIZE[1] - h) / 2) + 16
    shadow = Image.new('L', SIZE, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x + 2, y + 16, x + w - 2, y + h + 14), radius, fill=95)
    card.paste((20, 20, 20), (0, 0), shadow.filter(ImageFilter.GaussianBlur(22)))
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius, fill=255)
    card.paste(img, (x, y), mask)


def brand_mark(card):
    mark = xmark(132)
    card.paste(mark, (64, 56), mark)


def save(card, name, quality=88):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    while True:
        card.save(path, 'JPEG', quality=quality, optimize=True, progressive=True)
        if path.stat().st_size < 280 * 1024 or quality <= 60:
            break
        quality -= 4
    print(f'{path.relative_to(REPO)}  {card.size[0]}x{card.size[1]}  q{quality}  {path.stat().st_size / 1024:.1f} KB')


def pod_card(src, name, height=470, base_y=565):
    card = studio()
    place(card, render(src, height), SIZE[0] / 2, base_y)
    brand_mark(card)
    save(card, name)


def plate_card(src, name, width=720):
    card = studio()
    plate(card, src, width)
    brand_mark(card)
    save(card, name)


# The pods, cut-out renders standing on the floor.
pod_card(IMAGES / 'store/gen2.webp', 'home.jpg')
pod_card(IMAGES / 'Gen2/web/perspective-front-586.webp', 'powerpod-gen2.jpg')

# The accessories, as their pages' gallery photographs.
plate_card(IMAGES / 'adapter/web/adapter-1-1400.webp', 'adapter.jpg')
plate_card(IMAGES / 'vehicleDock/web/vehicledock-2-1400.webp', 'vehicle-dock.jpg')

# The store lineup: the two pods flanked by the accessories, on one floor.
card = studio()
for src, height, cx in (
    (IMAGES / 'store/adapter.webp', 190, 310),
    (IMAGES / 'store/gen1.webp', 400, 520),
    (IMAGES / 'store/gen2.webp', 430, 740),
    (IMAGES / 'store/vehicle-dock.webp', 230, 965),
):
    place(card, render(src, height), cx, 565)
brand_mark(card)
save(card, 'store.jpg')

# The brand card: the X alone, centred.
card = studio()
mark = xmark(400)
card.paste(mark, (round((SIZE[0] - mark.width) / 2), round((SIZE[1] - mark.height) / 2)), mark)
save(card, 'brand.jpg')
