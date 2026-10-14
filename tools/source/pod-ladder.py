#!/usr/bin/env python3
"""The Gen2 page's pod stills at the sizes screens ask for (npm run pod-stills).

    python3 tools/source/pod-ladder.py

From the masters tools/source/pod-stills.mjs renders (assets/productImages/Gen2/pod-stand.png and
pod-bay.png, drawn at twice their largest size) to assets/productImages/Gen2/web/pod-<name>-<w>.avif
and .webp, one pair per height below. The page lists them all in a srcset and the browser takes the
smallest that covers the pod's box at the screen's density, with the page's 15% to spare.

The steps are about a third apart, so whatever a screen asks for it is sent at most a third more
than it can show. The smallest stand is a short phone's, the largest a 2560 x 1440 window at 2x;
the bay is the pod lying in the scooter, a sixth of the stand's size.

Every size comes straight down from the master, in premultiplied alpha, so the pod's edge never
picks up a dark fringe from the transparent pixels around it. AVIF for the browsers that take it
(4:4:4, so the display's green and the logo stay crisp), WebP for the rest, its transparency
lossless.
"""
import json
from pathlib import Path
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
GEN2 = REPO / 'assets/productImages/Gen2'
WEB = GEN2 / 'web'

HEIGHTS = {
    'stand': [360, 480, 640, 840, 1100, 1440, 1880, 2440],
    'bay': [120, 160, 220, 300, 400, 540],
}
AVIF = dict(quality=82, subsampling='4:4:4', speed=2)
WEBP = dict(quality=90, alpha_quality=100, method=6)


def main():
    meta_file = WEB / 'pod.json'
    meta = json.loads(meta_file.read_text())
    for name, heights in HEIGHTS.items():
        master = Image.open(GEN2 / f'pod-{name}.png').convert('RGBA')
        # Premultiplied, so averaging never pulls colour in from the transparent surround.
        pre = master.convert('RGBa')
        W, H = master.size
        for old in WEB.glob(f'pod-{name}-*.*'):
            old.unlink()
        sizes = []
        for h in heights:
            if h > H:
                raise SystemExit(f'{name}: {h} px is taller than the master ({H} px)')
            w = round(W * h / H)
            pic = pre.resize((w, h), Image.LANCZOS).convert('RGBA')
            pic.save(WEB / f'pod-{name}-{w}.avif', **AVIF)
            pic.save(WEB / f'pod-{name}-{w}.webp', **WEBP)
            a = (WEB / f'pod-{name}-{w}.avif').stat().st_size
            b = (WEB / f'pod-{name}-{w}.webp').stat().st_size
            sizes.append(dict(width=w, height=h, avif=a, webp=b))
            print(f'pod-{name}-{w}: {w} x {h}, AVIF {a / 1024:.1f} KB, WebP {b / 1024:.1f} KB')
        meta[name]['sizes'] = sizes
    meta_file.write_text(json.dumps(meta, indent=2) + '\n')


if __name__ == '__main__':
    main()
