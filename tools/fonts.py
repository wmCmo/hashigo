"""
Fetch and convert the webfonts `app/` self-hosts. Reproducible, so `app/fonts/`
can always be rebuilt from this file.

    python tools/fonts.py

DECISION 57 (2026-10-27) — the Pinterest system. The faces are:

    Noto Sans JP      400          every Japanese glyph: head words, sentences, UI
    Hanken Grotesk    400 600 700 800   Latin: the wordmark, counts, glosses, buttons

Fraunces (the old wordmark) and Zen Maru Gothic are retired. `zenkaku-med.woff2`
stays on disk because `scripts/ojad-preview.ts` still renders with it; nothing in
the app references it.

WHY THE GOOGLE FONTS CSS API AND NOT github.com/google/fonts
------------------------------------------------------------
The CSS API answers a plain User-Agent with ONE static TTF per weight, covering
the whole face — no unicode-range slicing, which is what a browser UA gets and
what would leave a card editor showing tofu for a kanji outside the slices it
happened to load. It is also reachable from sandboxes where GitHub's raw host is
not.

WHY THE JAPANESE FACE IS NOT SUBSET BY CODEPOINT
------------------------------------------------
The obvious optimisation is to subset to the ~2,200 distinct codepoints in the
corpus. It is still wrong. `app/` has a card editor, so the next kanji he types
is not necessarily one of those, and a missing glyph is TOFU on a study card —
the one place in this app a silent blank is unacceptable. The whole face ships:
~2.2 MB of woff2 against the ~300 MB of audio the app already downloads, cached
after the first load.

`--layout-features='*'` is kept on every conversion: pyftsubset's default
feature set drops features silently (it once cost Fraunces its WONK axis), and
Noto Sans JP's vertical and proportional forms live there too.
"""

from __future__ import annotations

import re
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "fonts"
CACHE = ROOT / "build" / "fonts-src"

CSS_API = "https://fonts.googleapis.com/css2?family={family}:wght@{weight}"

# (CSS family, weight, output file)
FACES = [
    ("Noto+Sans+JP", 400, "notosansjp-400.woff2"),
    ("Hanken+Grotesk", 400, "hanken-400.woff2"),
    ("Hanken+Grotesk", 600, "hanken-600.woff2"),
    ("Hanken+Grotesk", 700, "hanken-700.woff2"),
    ("Hanken+Grotesk", 800, "hanken-800.woff2"),
]


def get(url: str) -> bytes:
    # A plain UA is the point: see the docstring.
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def fetch(family: str, weight: int) -> Path:
    dest = CACHE / f"{family.replace('+', '')}-{weight}.ttf"
    if dest.exists() and dest.stat().st_size > 10_000:
        return dest
    css = get(CSS_API.format(family=family, weight=weight)).decode("utf-8")
    urls = re.findall(r"url\((https://[^)]+\.ttf)\)", css)
    if len(urls) != 1:
        raise SystemExit(f"{family} {weight}: expected one whole-face TTF, the API returned {len(urls)}")
    body = get(urls[0])
    if body[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
        raise SystemExit(f"{urls[0]} did not return a font (first bytes {body[:4]!r})")
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetch {dest.name}")
    dest.write_bytes(body)
    return dest


def convert(src: Path, out: Path) -> None:
    subprocess.run(
        [
            sys.executable, "-m", "fontTools.subset", str(src),
            "--flavor=woff2",
            "--layout-features=*",
            "--unicodes=*",
            f"--output-file={out}",
        ],
        check=True,
        capture_output=True,
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for family, weight, name in FACES:
        out = OUT / name
        convert(fetch(family, weight), out)
        print(f"  {out.name:<24} {out.stat().st_size // 1024:>5} KB")
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
