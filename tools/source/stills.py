#!/usr/bin/env python3
"""The film's stills, from the studio renders and the page's own phone (npm run stills).

    python3 tools/source/stills.py

  the warranty beat ("5 years, covered.")   assets/productImages/Gen2/web/standing-resting-<w>.webp
      from assets/productImages/Gen2/6. standing resting.png: two Gen2 pods, one standing, one
      lying beside it
  the finale ("Made in India.")             assets/productImages/Gen2/web/perspective-front-<w>.webp
      from assets/productImages/Gen2/2. perspective_front.png: one pod, standing, seen from the
      front
  the finale's phone                        assets/app/phone-home-<w>.webp
      from tools/check/out/phone-home.png, which tools/source/phone-still.mjs renders from the
      film's CSS phone

Each is cropped to what it shows, with room below and to the sides for a soft shadow on the
ground it rests on, and written as WebP with its transparency kept, at full size and at half.

The renders have no floor, so on the film's grey everything would float, the pod lying on its side
on nothing. The shadow is drawn from each picture itself: along its lowest edge in each column,
which is where it meets the ground, a tight dark band for the contact and a wide faint one for the
light it takes from the floor around it, both blurred, and faded out before the picture's edges so
no edge of it is ever cut off square where the picture ends. The same ground and light for all
three: the pods' renders are about 2.7 pixels to the millimetre, and the phone's shadow is scaled
to its own pixels, so in the frame it is the same shadow.
"""
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

REPO = Path(__file__).resolve().parents[2]
GEN2 = REPO / 'assets/productImages/Gen2'

# The shadow, in the pods' renders' pixels (about 2.72 to the millimetre): the room around the
# picture, the two bands (how far each reaches above and below the lowest edge, its blur, its
# strength) and the fade before the edges.
ROOM = dict(side=110, top=6, bottom=140)
CONTACT = dict(up=4, down=8, blur=6, k=0.6)
AMBIENT = dict(up=34, down=46, blur=34, k=0.38)
FADE = 48
POD_PX_PER_MM = 1074 / 395


def shadowed(src, scale=1.0):
    """The picture on its ground: cropped to what it shows, with the shadow, scaled by `scale`
    for a picture drawn at a different number of pixels to the millimetre."""
    side, top, bottom = (round(ROOM[k] * scale) for k in ('side', 'top', 'bottom'))
    x0, y0, x1, y1 = src.getchannel('A').getbbox()
    pic = Image.new('RGBA', (x1 - x0 + 2 * side, y1 - y0 + top + bottom), (0, 0, 0, 0))
    pic.alpha_composite(src.crop((x0, y0, x1, y1)), (side, top))
    W, H = pic.size

    solid = pic.getchannel('A').point(lambda v: 255 if v > 128 else 0)
    bottoms = []
    for x in range(W):
        bb = solid.crop((x, 0, x + 1, H)).getbbox()
        bottoms.append(bb[3] - 1 if bb else None)

    def band(up, down, blur, k):
        layer = Image.new('L', (W, H), 0)
        draw = ImageDraw.Draw(layer)
        for x, y in enumerate(bottoms):
            if y is not None:
                draw.line([(x, y - up * scale), (x, y + down * scale)], fill=255)
        return layer.filter(ImageFilter.GaussianBlur(blur * scale)).point(lambda v: round(v * k))

    def edges():
        fade = FADE * scale

        def ramp(d):
            t = min(1.0, max(0.0, d / fade))
            return t * t * (3 - 2 * t)
        cols = Image.new('L', (W, 1))
        cols.putdata([round(255 * ramp(min(x, W - 1 - x))) for x in range(W)])
        rows = Image.new('L', (1, H))
        rows.putdata([round(255 * ramp(H - 1 - y)) for y in range(H)])
        return ImageChops.multiply(cols.resize((W, H)), rows.resize((W, H)))

    shadow = ImageChops.multiply(ImageChops.add(band(**CONTACT), band(**AMBIENT)), edges())
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out.putalpha(shadow)
    out.alpha_composite(pic)
    return out, (side, top, side + x1 - x0, top + y1 - y0)


def write(img, folder, name):
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob(f'{name}-*.webp'):
        old.unlink()
    for scale in (1, 2):
        w, h = img.width // scale, img.height // scale
        out = img if scale == 1 else img.resize((w, h), Image.LANCZOS)
        path = folder / f'{name}-{w}.webp'
        out.save(path, 'WEBP', quality=86, alpha_quality=100, method=6)
        print(f'{path.relative_to(REPO)}  {w}x{h}  {path.stat().st_size / 1024:.1f} KB')


def report(name, size, ink):
    """Where the thing itself sits in its picture, as fractions, for the page's layout."""
    W, H = size
    l, t, r, b = ink
    print(f'  {name}: ink {l / W:.4f} {t / H:.4f} {r / W:.4f} {b / H:.4f} of {W}x{H}')


# The warranty beat's two pods.
img, ink = shadowed(Image.open(GEN2 / '6. standing resting.png').convert('RGBA'))
write(img, GEN2 / 'web', 'standing-resting')
report('standing-resting', img.size, ink)

# The finale's pod.
img, ink = shadowed(Image.open(GEN2 / '2. perspective_front.png').convert('RGBA'))
write(img, GEN2 / 'web', 'perspective-front')
report('perspective-front', img.size, ink)

# The finale's phone, brought down to 700 pixels of phone (it is shown at most about 230 points
# tall, so this is sharp at 2.5x and more), with the shadow at its own scale.
phone = Image.open(REPO / 'tools/check/out/phone-home.png').convert('RGBA')
x0, y0, x1, y1 = phone.getchannel('A').getbbox()
k = 700 / (y1 - y0)
phone = phone.resize((round(phone.width * k), round(phone.height * k)), Image.LANCZOS)
img, ink = shadowed(phone, scale=(700 / 163.4) / POD_PX_PER_MM)
write(img, REPO / 'assets/app', 'phone-home')
report('phone-home', img.size, ink)
