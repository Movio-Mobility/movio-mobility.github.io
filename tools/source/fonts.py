#!/usr/bin/env python3
"""The type for the site's Indian languages: Noto Sans, in four scripts.

    python3 -m pip install fonttools==4.55.3 brotli==1.1.0     (once)
    python3 tools/source/fonts.py                              (npm run fonts)

  assets/fonts/noto-devanagari.woff2   Hindi and Marathi
  assets/fonts/noto-bengali.woff2      Bengali
  assets/fonts/noto-kannada.woff2      Kannada
  assets/fonts/noto-telugu.woff2       Telugu
  assets/fonts/noto-names-*.woff2      the language picker's names and letters only, a few KB
                                       each, so opening the picker never pulls four full fonts

Noto Sans, Google's family drawn for every script, chosen over Anek (2026-10-14) for its
weight: with the site's whole range of weights it is about 60% lighter (Devanagari 247 KB to
Anek's 650), it shapes every conjunct cleanly, and it is the face Android phones already read
these scripts in. DM Sans keeps drawing every Latin letter, brand name and digit
(assets/lang.css gives each face a unicode-range of its script alone). SIL Open Font License
1.1, from google/fonts at a pinned commit; the downloads are checked against their hashes, so
a changed upstream file stops the script rather than slipping into the site.

Each font is instanced at its regular width (wdth 100) with the weight axis kept from 300 to
800, the range the site sets, and subset to the letters, marks and signs its languages write
(not the native digits: the site writes Western ones everywhere) plus what shaping needs (the
dandas, ZWNJ and ZWJ, the dotted circle), with every OpenType layout feature kept: conjuncts,
half forms, reph and the matras all come from those. Hinting is dropped.
"""
import hashlib
import io
import sys
import urllib.request
from pathlib import Path

try:
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
    from fontTools import subset
except ImportError:
    sys.exit('fonttools is needed: python3 -m pip install fonttools==4.55.3 brotli==1.1.0')

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OUT = REPO / 'assets/fonts'
CACHE = HERE / '.fonts-cache'
COMMIT = 'e9678a5385322c63730122ba464765baad83cfd8'

# name: (path in google/fonts, sha256 prefix, its unicode block, the picker's text)
FONTS = {
    'devanagari': ('ofl/notosansdevanagari/NotoSansDevanagari[wdth,wght].ttf', '14ec4af41f274822',
                   [(0x0901, 0x0939), (0x093C, 0x094D), (0x0950, 0x0950), (0x0958, 0x0965), (0x0970, 0x0970), (0x0972, 0x0972)],
                   'हिंदी मराठी अ'),
    'bengali': ('ofl/notosansbengali/NotoSansBengali[wdth,wght].ttf', 'dcd42978094e584a', [(0x0980, 0x09E5)], 'বাংলা অ'),
    'kannada': ('ofl/notosanskannada/NotoSansKannada[wdth,wght].ttf', 'cca4f3b3a8cb12fb', [(0x0C80, 0x0CE5)], 'ಕನ್ನಡ ಅ'),
    'telugu': ('ofl/notosanstelugu/NotoSansTelugu[wdth,wght].ttf', 'e618af7bf999df19', [(0x0C00, 0x0C65)], 'తెలుగు అ'),
}
SHARED = [0x0964, 0x0965, 0x200C, 0x200D, 0x25CC]


def fetch(rel, want):
    CACHE.mkdir(exist_ok=True)
    local = CACHE / Path(rel).name
    if not local.exists():
        url = f'https://github.com/google/fonts/raw/{COMMIT}/{rel.replace("[", "%5B").replace("]", "%5D")}'
        print(f'  fetching {url}')
        with urllib.request.urlopen(url, timeout=60) as res:
            local.write_bytes(res.read())
    got = hashlib.sha256(local.read_bytes()).hexdigest()
    if not got.startswith(want):
        sys.exit(f'{local.name}: sha256 {got[:16]} is not the pinned {want}; check the upstream change before using it')
    return local


def subset_font(font, unicodes=None, text=None):
    options = subset.Options()
    options.layout_features = ['*']
    options.flavor = 'woff2'
    options.hinting = False
    options.desubroutinize = True
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6]  # keep the copyright and license notices
    options.notdef_outline = True
    s = subset.Subsetter(options)
    s.populate(unicodes=unicodes or [], text=text or '')
    s.subset(font)
    return font


def instance(src, axes):
    """The font at those axis values, read back whole (the instancer leaves gvar half loaded)."""
    buf = io.BytesIO()
    instancer.instantiateVariableFont(TTFont(src), axes).save(buf)
    buf.seek(0)
    return TTFont(buf)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (rel, sha, ranges, names) in FONTS.items():
        src = fetch(rel, sha)
        unicodes = [c for lo, hi in ranges for c in range(lo, hi + 1)] + SHARED
        full = instance(src, {'wdth': 100, 'wght': (300, 800)})
        subset_font(full, unicodes=unicodes)
        dest = OUT / f'noto-{name}.woff2'
        full.save(dest)
        small = instance(src, {'wdth': 100, 'wght': 560})
        subset_font(small, text=names)
        small_dest = OUT / f'noto-names-{name}.woff2'
        small.save(small_dest)
        print(f'  {dest.relative_to(REPO)}  {dest.stat().st_size / 1024:.1f} KB   names {small_dest.stat().st_size / 1024:.1f} KB')


if __name__ == '__main__':
    main()
