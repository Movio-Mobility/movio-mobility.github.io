#!/usr/bin/env python3
"""The scooter on the app's home screen (assets/app/scooter.webp), from the app's own drawing.

    python3 tools/source/scooter.py [path to the app's assets/icons/bike.png]

The app ships the drawing at 160 x 374, white lines on transparent, and shows it 88 points wide.
The website shows it larger, at up to about 150 points, on screens up to 3x, so it is made 3x
here: scaled up smoothly, then the edges of the lines firmed, since soft edges are what an
upscaled line drawing gives away. The colour stays white; only the alpha is reshaped.
"""
import sys
from pathlib import Path
from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parents[2]
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    '/Users/vishrutvatsa/Developer/App Builds/gridxAppV3Sub-kunalmain2/assets/icons/bike.png')
OUT = REPO / 'assets/app/scooter.webp'
SCALE = 3

src = Image.open(SRC).convert('RGBA')
w, h = src.size
big = src.resize((w * SCALE, h * SCALE), Image.LANCZOS)
alpha = big.getchannel('A').filter(ImageFilter.GaussianBlur(0.8))


# Firm the line edges a little: the faint halo an upscale leaves round each stroke is dropped,
# and the rest is stretched back to the full range, so a stroke keeps its weight and stays
# unbroken along its thin diagonals, but its edge is a pixel wide rather than three.
def firm(v):
    t = v / 255
    lo, hi = 0.10, 0.80
    k = 0 if t <= lo else 1 if t >= hi else (t - lo) / (hi - lo)
    return round(255 * k)


alpha = alpha.point(firm)
out = Image.new('RGBA', big.size, (255, 255, 255, 0))
out.putalpha(alpha)
out.save(OUT, 'WEBP', quality=92, method=6)
print(f'{OUT.relative_to(REPO)}  {out.size[0]}x{out.size[1]}  {OUT.stat().st_size / 1024:.1f} KB')
