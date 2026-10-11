#!/usr/bin/env python3
"""Transparent cut-outs for the accessory galleries, from the CAD renders.

    python3 tools/source/cutouts.py

  the adapter's three views      assets/productImages/adapter/web/adapter-{1,2,3}-{1400,700}.webp
      from assets/productImages/adapter/{1,2,3}.PNG, which share one framing, kept whole so
      the gallery never jumps between slides
  the dock holding a pod         assets/productImages/vehicleDock/web/vehicledock-1-{700,350}.webp
      from assets/productImages/store/vehicle-dock.png, recut at high resolution to the same
      portrait column as the store card's own cut-out (never touch that file itself)
  the dock on its own            assets/productImages/vehicleDock/web/vehicledock-2-{1400,700}.webp
      from assets/productImages/vehicleDock/Assem1.PNG
  the dock from above            assets/productImages/vehicleDock/web/vehicledock-3-{1400,700}.webp
      from assets/productImages/vehicleDock/TOP.PNG

The renders sit on a near-neutral light grey radial gradient (about 213 at the corners, 232 in
the middle), so the backdrop is removed deterministically rather than by a model: a pixel can
be backdrop when it is near grey (channels within a few steps of each other), bright, and
locally smooth (the gradient changes by almost nothing over five pixels, where the product is
all texture). That candidate mask is flooded from the picture's border, so a white slot or a
pale dot inside the product can never be eaten, and the local-smoothness test stops the flood
at the anti-aliased edge instead of leaking into the bright faces of the silver hardware.

Two passes clean up what the flood cannot reach:
  - a pocket of backdrop sealed off by the product (the gap between the dock's two cables)
    matches the backdrop's own brightness, well below the rendered whites, so any enclosed
    candidate region whose mean luminance is backdrop-like goes transparent too
  - the cut edge is pulled in two pixels (the flood stops just short of the product) and the
    alpha gets a ~1px Gaussian feather after the resize, so edges read drawn, not punched

The store render is different: a pure white page behind the dock-and-ghost-pod composition,
with a near-white backing plate behind the dock. On the store card (a white ground) that
plate disappears; on the particle field it would read as a sticker, so it goes too. A plain
threshold cannot take it, because its shaded strip (around 230) sits in the same band as
the ghosted pod's own brightest grey, so the cut is done in two registers: everywhere, pure
white (250 and up, which also opens the white showing through the pod's handle); and below
the dock's top edge, where the pod cannot be, a hysteresis flood from the plate's whites
down to 222, which takes the plate and its strip while the bolts beside it keep their
darker facets. The pod's soft ghosted edges are never touched.

Old exports these slides replace (adapter-4-*, vehicledock-4-*, the old vehicledock-1-1400)
are deleted, so the build's reference check can prove nothing points at them.
"""
import os
from pathlib import Path
from PIL import Image, ImageChops, ImageFilter

REPO = Path(__file__).resolve().parents[2]
IMAGES = REPO / 'assets/productImages'

# The backdrop test: channels within NEUTRAL of each other, luminance at least BRIGHT (the
# gradient never drops below 213), and a 5px window whose range stays within SMOOTH.
NEUTRAL = 8
BRIGHT = 200
SMOOTH = 6
# An enclosed candidate pocket at or below this mean luminance is backdrop showing through a
# gap; the rendered whites (slots, notches, dots) all sit above it.
POCKET_LUM = 233


def flood(cand, W, H, seeds):
    """Span fill over the candidate bytearray, from the given seed pixels."""
    bg = bytearray(W * H)
    stack = list(seeds)
    while stack:
        x, y = stack.pop()
        i = y * W + x
        if bg[i] or not cand[i]:
            continue
        x0 = x
        while x0 > 0 and cand[y * W + x0 - 1] and not bg[y * W + x0 - 1]:
            x0 -= 1
        x1 = x
        while x1 < W - 1 and cand[y * W + x1 + 1] and not bg[y * W + x1 + 1]:
            x1 += 1
        for xx in range(x0, x1 + 1):
            bg[y * W + xx] = 1
        for yy in (y - 1, y + 1):
            if 0 <= yy < H:
                xx = x0
                while xx <= x1:
                    j = yy * W + xx
                    if cand[j] and not bg[j]:
                        stack.append((xx, yy))
                        while xx <= x1 and cand[yy * W + xx]:
                            xx += 1
                    else:
                        xx += 1
    return bg


def backdrop_alpha(im):
    """The alpha that removes the studio gradient from one render."""
    W, H = im.size
    r, g, b = im.split()
    neut = ImageChops.lighter(
        ImageChops.lighter(ImageChops.difference(r, g), ImageChops.difference(g, b)),
        ImageChops.difference(r, b))
    lum = im.convert('L')
    contrast = ImageChops.difference(
        lum.filter(ImageFilter.MaxFilter(5)), lum.filter(ImageFilter.MinFilter(5)))
    nd, ld, cd = neut.tobytes(), lum.tobytes(), contrast.tobytes()

    cand = bytearray(W * H)
    for i in range(W * H):
        if nd[i] <= NEUTRAL and ld[i] >= BRIGHT and cd[i] <= SMOOTH:
            cand[i] = 1

    seeds = [(x, y) for x in range(W) for y in (0, H - 1)]
    seeds += [(x, y) for y in range(H) for x in (0, W - 1)]
    bg = flood(cand, W, H, seeds)

    # Enclosed pockets: candidate pixels the flood could not reach. A component as dim as the
    # backdrop is the backdrop, sealed off; anything brighter is a rendered white and stays.
    seen = bytearray(W * H)
    for start in range(W * H):
        if not cand[start] or bg[start] or seen[start]:
            continue
        comp = []
        lsum = 0
        stack = [start]
        while stack:
            j = stack.pop()
            if seen[j] or not cand[j] or bg[j]:
                continue
            seen[j] = 1
            comp.append(j)
            lsum += ld[j]
            x, y = j % W, j // W
            if x > 0:
                stack.append(j - 1)
            if x < W - 1:
                stack.append(j + 1)
            if y > 0:
                stack.append(j - W)
            if y < H - 1:
                stack.append(j + W)
        if lsum // len(comp) <= POCKET_LUM:
            for j in comp:
                bg[j] = 1

    alpha = Image.frombytes('L', (W, H), bytes(bytearray(0 if v else 255 for v in bg)))
    # Pulled in 2px: the smoothness test stops the flood just short of the product, and this
    # takes the sliver of gradient that would otherwise ride along the edge.
    return alpha.filter(ImageFilter.MinFilter(5))


def white_alpha(im, bright=250, neutral=3, erode=3, weak=222, seed=244):
    """The alpha for the store render: plain white removed everywhere (so the enclosed
    white in the pod's handle opens too), and below the dock's top edge, where the ghosted
    pod cannot be, the backing plate flooded away from its whites down to `weak`."""
    W, H = im.size
    r, g, b = im.split()
    neut = ImageChops.lighter(
        ImageChops.lighter(ImageChops.difference(r, g), ImageChops.difference(g, b)),
        ImageChops.difference(r, b))
    nd, ld = neut.tobytes(), im.convert('L').tobytes()

    # The dock's top edge: the first row with a long run of near-black.
    dock_top = H
    for y in range(H):
        dark = 0
        for x in range(0, W, 2):
            if ld[y * W + x] < 40:
                dark += 1
        if dark > W // 13:
            dock_top = y
            break

    cand = bytearray(W * H)
    seeds = []
    for i in range(W * H):
        if nd[i] > neutral:
            continue
        below = i // W >= dock_top - 4
        if ld[i] >= bright or (below and ld[i] >= weak):
            cand[i] = 1
        if ld[i] >= bright or (below and ld[i] >= seed):
            seeds.append((i % W, i // W))
    bg = flood(cand, W, H, seeds)
    alpha = Image.frombytes('L', (W, H), bytes(bytearray(0 if v else 255 for v in bg)))
    return alpha.filter(ImageFilter.MinFilter(erode))


def cut(path):
    im = Image.open(path).convert('RGB')
    out = im.convert('RGBA')
    out.putalpha(backdrop_alpha(im))
    return out


def padded_bbox(img, pad_share=0.07):
    """The alpha's bounding box, grown by a share of its longer side, kept on the canvas."""
    x0, y0, x1, y1 = img.getchannel('A').getbbox()
    pad = round(max(x1 - x0, y1 - y0) * pad_share)
    return (max(0, x0 - pad), max(0, y0 - pad),
            min(img.width, x1 + pad), min(img.height, y1 + pad))


def write(img, folder, name, widths, feather=0.8):
    folder.mkdir(parents=True, exist_ok=True)
    for w in widths:
        h = round(img.height * w / img.width)
        out = img.resize((w, h), Image.LANCZOS)
        a = out.getchannel('A').filter(ImageFilter.GaussianBlur(feather))
        out.putalpha(a)
        path = folder / f'{name}-{w}.webp'
        out.save(path, 'WEBP', quality=90, alpha_quality=100, method=6)
        print(f'{path.relative_to(REPO)}  {w}x{h}  {path.stat().st_size / 1024:.1f} KB')


# The adapter's three views share one canvas and one framing; kept whole, so the product
# never jumps as the gallery slides.
for n in (1, 2, 3):
    img = cut(IMAGES / 'adapter' / f'{n}.PNG')
    write(img, IMAGES / 'adapter/web', f'adapter-{n}', (1400, 700))

# Slide 1: the store page's look, the dock holding the ghosted pod, recut at high resolution
# from the same render and cropped to the store cut-out's portrait column (386:1030).
im = Image.open(IMAGES / 'store/vehicle-dock.png').convert('RGB')
pod = im.convert('RGBA')
pod.putalpha(white_alpha(im))
x0, y0, x1, y1 = pod.getchannel('A').getbbox()
aspect = 386 / 1030
want_w = round((y1 - y0) * aspect)
if want_w < x1 - x0:
    pad = round((x1 - x0) / aspect) - (y1 - y0)
    y0 -= pad // 2
    y1 += pad - pad // 2
else:
    pad = want_w - (x1 - x0)
    x0 -= pad // 2
    x1 += pad - pad // 2
write(pod.crop((x0, y0, x1, y1)), IMAGES / 'vehicleDock/web', 'vehicledock-1', (700, 350), feather=0.7)

# Slides 2 and 3: the dock alone, and from above, trimmed to what they show plus a little room.
img = cut(IMAGES / 'vehicleDock/Assem1.PNG')
write(img.crop(padded_bbox(img)), IMAGES / 'vehicleDock/web', 'vehicledock-2', (1400, 700))
img = cut(IMAGES / 'vehicleDock/TOP.PNG')
write(img.crop(padded_bbox(img)), IMAGES / 'vehicleDock/web', 'vehicledock-3', (1400, 700))

# The exports these slides replace. Removed here so the build's reference check can prove
# nothing points at them any more.
for stale in ('adapter/web/adapter-4-1400.webp', 'adapter/web/adapter-4-700.webp',
              'vehicleDock/web/vehicledock-1-1400.webp',
              'vehicleDock/web/vehicledock-4-1400.webp', 'vehicleDock/web/vehicledock-4-700.webp'):
    path = IMAGES / stale
    if path.exists():
        path.unlink()
        print(f'removed {path.relative_to(REPO)}')
