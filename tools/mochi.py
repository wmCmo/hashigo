"""
Reader for Mochi `.mochi` exports (format version 2).

A `.mochi` file is a ZIP containing `data.json` (Transit-encoded JSON) plus flat
media files. This module decodes that format and is the reference implementation
the TypeScript importer should mirror.

Usage:
    python tools/mochi.py exports/日本語 exports/English exports/基本情報

    from tools.mochi import load, walk_cards
    data = load("exports/日本語")
    cards = walk_cards(data)

TRANSIT ENCODING (all discovered empirically — the docs don't cover it)
    "~:foo"            -> keyword, becomes the string "foo". Applies to map KEYS
                          and to VALUES (field types, ids, deck refs).
    {"~#list": [...]}  -> list
    {"~#set":  [...]}  -> set (decoded here as a list)
    "~t<millis>"       -> instant, epoch milliseconds
    {"~#dt": <millis>} -> instant, epoch milliseconds. NOTE: a *different*
                          encoding from "~t" for the same concept — both appear,
                          "~t" inside review records, "~#dt" on updated-at.
    "~~foo"            -> literal string starting with "~" (escape)

TRAPS (each of these cost real time to find)
  * walk_cards must dedupe. Cards live under decks[].cards[] AND a deck node can
    itself expose a top-level cards[]; a naive recursive walk counts every nested
    card exactly twice. Symptom: totals are exactly 2x correct.
  * Review timestamps are date-only. Every one of the 102,020 reviews in the
    reference corpus carries 15:00:00Z == midnight JST. There is no genuine
    time-of-day data. Do not present imported times as real.
  * `content` is "" on templated cards; the real text lives in fields[].value.
    Any scan that reads only `content` sees almost nothing.
  * Tags may carry a leading U+200B zero-width space, silently splitting a tag
    into two identical-looking entries. Always normalise (see normalise_tag).
  * Language codes are inconsistent: inline tags use lang="jp", field options
    use "ja-JP". Normalise to BCP-47 on import.
  * Attachment `type` is unreliable — some mp3s claim "text/xml" (Azure's SSML
    content-type leaked through). Sniff the bytes instead.
  * Generators appear in TWO places: as typed template fields (with a `source`
    pointer) and as inline tags inside card content. Both must be resolved.
  * An `ai` field's dependency may be named only inside its prompt text
    (ai-custom-prompt), not in `source`. Parse <<field>> out of prompts too, or
    the generation DAG is incomplete and runs in the wrong order.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import sys
import unicodedata
from collections import Counter

# ─── decoding ────────────────────────────────────────────────────────────────

_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍﻿"), None)


def _instant(millis) -> datetime.datetime:
    return datetime.datetime.fromtimestamp(millis / 1000, datetime.timezone.utc)


def untransit(o):
    """Recursively strip Transit encoding. See module docstring for the forms."""
    if isinstance(o, dict):
        if len(o) == 1:
            if "~#list" in o:
                return [untransit(x) for x in o["~#list"]]
            if "~#set" in o:
                return [untransit(x) for x in o["~#set"]]
            if "~#dt" in o:
                v = o["~#dt"]
                return _instant(v) if isinstance(v, (int, float)) else untransit(v)
        return {
            (k[2:] if isinstance(k, str) and k.startswith("~:") else k): untransit(v)
            for k, v in o.items()
        }
    if isinstance(o, list):
        return [untransit(x) for x in o]
    if isinstance(o, str):
        if o.startswith("~:"):
            return o[2:]
        if o.startswith("~t"):
            try:
                return _instant(int(o[2:]))
            except ValueError:
                return o[2:]
        if o.startswith("~~"):
            return o[1:]
    return o


def load(deck_dir: str) -> dict:
    """Load and decode `<deck_dir>/data.json` from an extracted .mochi export."""
    with open(os.path.join(deck_dir, "data.json"), encoding="utf-8") as fh:
        return untransit(json.load(fh))


def walk_cards(root: dict) -> list[dict]:
    """Every card in the export, exactly once, each tagged with `_deck` (path).

    Dedupes by object identity — see the double-count trap in the docstring.
    """
    out: list[dict] = []
    seen: set[int] = set()

    def visit(node, path):
        for deck in node.get("decks") or []:
            sub = path + [deck.get("name", "?")]
            for card in deck.get("cards") or []:
                if id(card) not in seen:
                    seen.add(id(card))
                    card["_deck"] = "/".join(sub)
                    out.append(card)
            visit(deck, sub)
        for card in node.get("cards") or []:
            if id(card) not in seen:
                seen.add(id(card))
                card["_deck"] = "/".join(path) or "(root)"
                out.append(card)

    visit(root, [])
    return out


def card_text(card: dict) -> str:
    """All authored text on a card: `content` plus every field value."""
    parts = [card.get("content") or ""]
    for value in (card.get("fields") or {}).values():
        if isinstance(value, dict) and isinstance(value.get("value"), str):
            parts.append(value["value"])
    return "\n".join(parts)


def review_tracks(card: dict) -> dict[str, list]:
    """Mochi's three parallel review arrays, as named tracks."""
    tracks = {}
    if card.get("reviews"):
        tracks["forward"] = card["reviews"]
    if card.get("reverse-reviews"):
        tracks["reverse"] = card["reverse-reviews"]
    if card.get("cloze/reviews"):
        tracks["cloze"] = card["cloze/reviews"]
    return tracks


def normalise_tag(tag: str) -> str:
    """NFKC, strip zero-width/format chars, trim. Merges invisible duplicates."""
    tag = unicodedata.normalize("NFKC", tag).translate(_ZERO_WIDTH)
    tag = "".join(ch for ch in tag if unicodedata.category(ch) != "Cf")
    return "/".join(seg.strip() for seg in tag.strip().split("/") if seg.strip())


# ─── extraction helpers ──────────────────────────────────────────────────────

WIKI_LINK = re.compile(r"\[\[([^\]|]+)\|([^\]]+)\]\]")   # [[display|card-id]]
FIELD_REF = re.compile(r"<<\s*([#^/]?)\s*([^>]+?)\s*>>")  # <<Field>> <<#F>> <<^F>> <</F>>
GENERATOR = re.compile(r"<(speech|ai|translate|furigana|pinyin|image)\b([^>]*)>",
                       re.IGNORECASE)
CLOZE = re.compile(r"\{\{(?:(\d+)::)?(.+?)\}\}", re.DOTALL)


def wiki_links(text: str) -> list[tuple[str, str]]:
    """[(display, card_id), ...] — present on 56% of cards in the reference corpus."""
    return WIKI_LINK.findall(text)


def field_refs(text: str) -> list[str]:
    """Field names referenced anywhere in a template body or an AI prompt."""
    return [name for _sigil, name in FIELD_REF.findall(text)]


# ─── CLI: summarise one or more extracted exports ────────────────────────────

def _summarise(deck_dirs: list[str]) -> None:
    total = Counter()
    tags: Counter = Counter()
    gens: Counter = Counter()

    for deck_dir in deck_dirs:
        data = load(deck_dir)
        cards = walk_cards(data)
        reviews = [r for c in cards for t in review_tracks(c).values() for r in t]
        tombs = sum(
            1
            for c in cards
            for a in (c.get("attachments") or {}).values()
            if isinstance(a, dict) and a.get("deleted?")
        )
        links = sum(len(wiki_links(card_text(c))) for c in cards)

        for c in cards:
            for t in (c.get("tags") or []) + (c.get("manual-tags") or []):
                tags[normalise_tag(t)] += 1
            for name, _attrs in GENERATOR.findall(card_text(c)):
                gens[name.lower()] += 1

        passed = sum(1 for r in reviews if r.get("remembered?") is True)
        print(f"=== {deck_dir}")
        print(f"    cards {len(cards):>6,}   templates {len(data.get('templates') or []):>3}")
        print(f"    reviews {len(reviews):>6,}   retention "
              f"{100 * passed / len(reviews):.2f}%" if reviews else "    reviews 0")
        print(f"    wiki-links {links:>5,}   tombstoned attachments {tombs:,}")

        total["cards"] += len(cards)
        total["reviews"] += len(reviews)
        total["passed"] += passed
        total["links"] += links
        total["tombs"] += tombs

    print("\n=== TOTAL")
    print(f"    cards {total['cards']:,} | reviews {total['reviews']:,} "
          f"| retention {100 * total['passed'] / max(total['reviews'], 1):.2f}%")
    print(f"    wiki-links {total['links']:,} | tombstones {total['tombs']:,}")
    print(f"    inline generators: {dict(gens)}")
    print(f"    tags after normalisation: {len(tags)}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # console is cp932
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    _summarise(sys.argv[1:])
