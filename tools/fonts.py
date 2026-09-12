"""
Fetch and subset the webfonts `app/` self-hosts. Reproducible, so `app/fonts/`
need not live in git.

    python tools/fonts.py                 # the shipping faces
    python tools/fonts.py --candidates    # also the Japanese faces still being judged

WHY THIS FILE EXISTS RATHER THAN A DOCUMENTED COMMAND LINE
----------------------------------------------------------
Two traps, both of which fail SILENTLY and both of which are one flag:

1. `--layout-features='*'`. Fraunces' WONK axis is glyph SUBSTITUTION, delivered
   through the `rvrn` GSUB feature. pyftsubset's default feature set drops
   `rvrn`, so a subset built without this flag still reports four axes, still
   renders, and simply stops leaning the `h` — which looks like the CSS being
   wrong. Verified here: the emitted file is re-opened and `rvrn` asserted.

2. The Japanese faces are NOT subset by codepoint. The obvious optimisation is to
   subset to the 2,209 distinct codepoints in the corpus (it works: Zen Kaku
   falls 1,026 KB -> 271 KB). It is still wrong. `app/` has a card editor, so the
   next kanji he types is not necessarily one of those 2,209, and a missing glyph
   is TOFU on a study card — the one place in this app a silent blank is
   unacceptable. The whole face ships. 1 MB against the ~300 MB of audio the app
   already downloads is 0.3%, and it is cached after the first load.

The design brief's own subset command for Fraunces is reproduced verbatim below
and was verified byte-for-byte against this script's output.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "fonts"
CACHE = ROOT / "build" / "fonts-src"

GF = "https://github.com/google/fonts/raw/main"

# The display face. Locked by the brief: 'opsz' 144, 'wght' 650, 'SOFT' 100, 'WONK' 1.
# Latin only, because it never sets a Japanese glyph.
FRAUNCES = {
    "url": f"{GF}/ofl/fraunces/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf",
    "src": "fraunces.ttf",
    "out": "fraunces-latin.woff2",
    "unicodes": "U+0000-00FF,U+2010-2027",
}

# The Japanese faces. `ship` is what `app/style.css` references; the rest are the
# candidates the specimen renders side by side. See app/README.md.
JAPANESE = {
    "zenkaku-med": (f"{GF}/ofl/zenkakugothicnew/ZenKakuGothicNew-Medium.ttf", True),
    "zenmaru-med": (f"{GF}/ofl/zenmarugothic/ZenMaruGothic-Medium.ttf", True),
    "shippori-med": (f"{GF}/ofl/shipporimincho/ShipporiMincho-Medium.ttf", False),
    "notosansjp-var": (f"{GF}/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf", False),
}


def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 100_000:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetch {dest.name}")
    with urllib.request.urlopen(url, timeout=180) as response:
        body = response.read()
    # A 404 from GitHub is an HTML page served with status 200 by the raw
    # redirect, so check the sfnt magic rather than the status code.
    if body[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
        raise SystemExit(f"{url} did not return a font (first bytes {body[:4]!r})")
    dest.write_bytes(body)
    return dest


def subset(src: Path, out: Path, *, unicodes: str | None) -> None:
    args = [
        sys.executable, "-m", "fontTools.subset", str(src),
        "--flavor=woff2",
        # NOT optional. See the module docstring.
        "--layout-features=*",
        f"--output-file={out}",
    ]
    args.append(f"--unicodes={unicodes}" if unicodes else "--unicodes=*")
    subprocess.run(args, check=True, capture_output=True)


def check_rvrn(path: Path) -> bool:
    """WONK is a glyph substitution. If `rvrn` is gone the axis silently stops
    working, which reads as a CSS bug. Assert it rather than trusting the flag."""
    from fontTools.ttLib import TTFont

    font = TTFont(path)
    if "GSUB" not in font:
        return False
    tags = {r.FeatureTag for r in font["GSUB"].table.FeatureList.FeatureRecord}
    return "rvrn" in tags


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", action="store_true",
                        help="also build the Japanese faces still being judged")
    options = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)

    print("Fraunces (display, Latin only)")
    src = fetch(FRAUNCES["url"], CACHE / FRAUNCES["src"])
    out = OUT / FRAUNCES["out"]
    subset(src, out, unicodes=FRAUNCES["unicodes"])
    ok = check_rvrn(out)
    print(f"  {out.name:<24} {out.stat().st_size // 1024:>5} KB   rvrn/WONK {'kept' if ok else 'LOST'}")
    if not ok:
        raise SystemExit("the WONK axis lost its `rvrn` feature — --layout-features=* was dropped")

    print("\n日本語 (whole face, deliberately — see the docstring)")
    for name, (url, ship) in JAPANESE.items():
        if not ship and not options.candidates:
            continue
        src = fetch(url, CACHE / f"{name}.ttf")
        out = OUT / f"{name}.woff2"
        subset(src, out, unicodes=None)
        print(f"  {out.name:<24} {out.stat().st_size // 1024:>5} KB")

    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
