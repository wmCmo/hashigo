"""
THROWAWAY (spike harness) — step 1 of 3 for the audio spike.

Reads the DECLARED attachment types out of the real Mochi exports and picks a
small, deliberately mixed sample of real clips for the browser page to play.

Why this step exists at all: the declared `type` on an attachment is only in the
export. The importer sniffs the bytes and writes the *sniffed* mime to
`blobs.mime`, and it keeps no record of what Mochi claimed — which is correct for
production and useless for the question "what does <audio> do with the declared
type?". So the declared type comes from here, joined to the database by content
address.

Nothing is read into a shell; the whole 21 MB data.json stays inside the process.
Output is one small JSON manifest under build/ (gitignored).

    PYTHONIOENCODING=utf-8 python spike/audio/pick-clips.py \
        --out build/spike/audio-clips.json \
        exports/日本語 exports/English exports/基本情報
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "tools"))

import mochi  # noqa: E402  (path juggling above is deliberate)


def live_attachments(deck_dir: str) -> list[dict]:
    """Every non-tombstoned attachment: (deck, file_name, declared_type, card)."""
    data = mochi.load(deck_dir)
    out: list[dict] = []
    for card in mochi.walk_cards(data):
        card_id = card.get("id")
        if not isinstance(card_id, str):
            continue
        for file_name, record in (card.get("attachments") or {}).items():
            if not isinstance(record, dict):
                continue
            if record.get("deleted?") is True:
                continue  # 8,958 tombstones: Mochi's regeneration debris
            out.append(
                {
                    "deck": os.path.basename(deck_dir.rstrip("/\\")),
                    "dir": deck_dir,
                    "file_name": file_name,
                    "declared_type": record.get("type") if isinstance(record.get("type"), str) else "",
                    "card_id": card_id,
                }
            )
    return out


def measure(entry: dict) -> dict | None:
    """sha256 + size. The sha256 IS the blob address, so this is the join key."""
    path = os.path.join(entry["dir"], entry["file_name"])
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as handle:
        payload = handle.read()
    digest = hashlib.sha256(payload).hexdigest()
    head = payload[:4].hex()
    return {
        **{k: v for k, v in entry.items() if k != "dir"},
        "hash": digest,
        "size": len(payload),
        "first4": head,
    }


# (declared type, deck substring, how many, want zero bytes?, note)
WANTED: list[tuple[str, str, int, bool, str]] = [
    ("text/xml", "日本語", 6, False, "the 3,443-file lie: Azure's SSML content-type on an mp3"),
    ("application/octet-stream", "日本語", 3, False, "the 4,979-file shrug"),
    ("", "日本語", 3, False, "the 2,424 attachments that declared nothing at all"),
    ("audio/mpeg", "", 2, False, "one of the 41 declarations that were actually right"),
    ("text/xml", "English", 2, True, "0 bytes: a failed Azure call Mochi recorded as live"),
    ("image/jpeg", "", 1, False, "not audio at all — the negative control for <audio>"),
    ("", "", 1, False, "a jpeg or an mp3 that declared nothing"),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("decks", nargs="+")
    parser.add_argument("--out", required=True)
    parser.add_argument("--big", type=int, default=1, help="how many of the largest clips to add")
    args = parser.parse_args()

    everything: list[dict] = []
    for deck in args.decks:
        found = live_attachments(deck)
        print(f"{deck}: {len(found):,} live attachments")
        everything.extend(found)

    declared = Counter(entry["declared_type"] for entry in everything)
    print(f"\nlive attachments total {len(everything):,}")
    print("declared types, as Mochi recorded them:")
    for value, count in declared.most_common():
        print(f"  {value or '(nothing)':<26} {count:>6,}")

    picked: list[dict] = []
    seen: set[str] = set()

    def take(candidates: list[dict], limit: int, note: str) -> None:
        for entry in candidates:
            if len(picked) and limit <= 0:
                return
            if limit <= 0:
                return
            measured = measure(entry)
            if measured is None or measured["hash"] in seen:
                continue
            measured["note"] = note
            picked.append(measured)
            seen.add(measured["hash"])
            limit -= 1

    for declared_type, deck_hint, count, want_zero, note in WANTED:
        pool = [
            entry
            for entry in everything
            if entry["declared_type"] == declared_type and deck_hint in entry["deck"]
        ]
        pool.sort(key=lambda entry: entry["file_name"])
        if want_zero:
            pool = [
                entry
                for entry in pool
                if os.path.getsize(os.path.join(entry["dir"], entry["file_name"])) == 0
            ]
        elif declared_type == "image/jpeg" or note.startswith("a jpeg"):
            pool = [entry for entry in pool if not entry["file_name"].lower().endswith(".mp3")]
        else:
            pool = [
                entry
                for entry in pool
                if entry["file_name"].lower().endswith(".mp3")
                and os.path.getsize(os.path.join(entry["dir"], entry["file_name"])) > 0
            ]
        take(pool, count, note)

    if args.big > 0:
        biggest = sorted(
            (entry for entry in everything if entry["file_name"].lower().endswith(".mp3")),
            key=lambda entry: -os.path.getsize(os.path.join(entry["dir"], entry["file_name"])),
        )
        take(biggest, args.big, "the largest mp3 in the corpus — a long clip, not a word")

    total = sum(entry["size"] for entry in picked)
    print(f"\npicked {len(picked)} clips, {total:,} bytes")
    for entry in picked:
        print(
            f"  {entry['deck']:<8} {entry['file_name']:<16} "
            f"declared {entry['declared_type'] or '(nothing)':<26} "
            f"{entry['size']:>9,} B  magic {entry['first4']}  {entry['hash'][:12]}"
        )

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "declaredTypeCounts": dict(declared.most_common()),
                "liveAttachments": len(everything),
                "clips": picked,
            },
            handle,
            ensure_ascii=False,
            indent=1,
        )
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
