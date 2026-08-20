"""Derive an accent for every head word handed to us, as JSONL.

    npx vite-node src/accent/cli.ts -- words --db build/hashigo.db --out build/head-words.txt
    PYTHONIOENCODING=utf-8 .venv-accent/Scripts/python tools/accent_derive.py         --words build/head-words.txt --out build/accents.jsonl
    npx vite-node src/accent/cli.ts -- load --db build/hashigo.db --in build/accents.jsonl

WHY PYTHON NEITHER READS THE DATABASE NOR WRITES IT. The analyser only exists
here (OpenJTalk via pyopenjtalk-plus, which needs a prebuilt wheel), but the text
transform, the schema and its CHECK constraints live in TypeScript. This script
therefore analyses the strings it is HANDED and nothing else.

That boundary was not caution, it was a bug fix. An earlier version read the
values straight out of the database and mis-read his own vocabulary, because two
things in an authored value are invisible:

    [[参考|UQB66cP2]]にする   the wiki-link id was read aloud as ユーキュービーロク...
    準‎備 (U+200E inside)     read as ジュン + ソナエ, not ジュンビ
    面‎倒                    read as メン + タオセ, not メンドー

Those are wrong READINGS, not mora-count wobbles, and a wrong accent drilled
through spaced repetition is worse than no accent. `accentKey()` in
src/accent/key.ts is the one definition of the fix.
"""
import argparse
import json
import sys
from collections import Counter

sys.path.insert(0, "tools")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import accent  # noqa: E402

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--words", required=True,
                        help="one normalised key per line, from `cli.ts words`")
    parser.add_argument("--out", required=True)
    parser.add_argument("--probe", default="が")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    with open(args.words, encoding="utf-8") as handle:
        words = [line.strip() for line in handle if line.strip()]
    if args.limit:
        words = words[: args.limit]

    version = accent_version()
    tally: Counter[str] = Counter()
    # Keyed by the string, not by card: 橋 has one accent whichever card it
    # appears on, exactly as a blob has one address whatever references it.
    seen: dict[str, dict] = {}
    for value in words:
        if value in seen:
            continue
        result = accent.derive_value(value, args.probe)
        result["version"] = version
        result["probe"] = args.probe
        seen[value] = result
        if result["ok"]:
            tally[result["type"]] += 1
            tally[f"basis/{result['basis']}"] += 1
        elif result.get("guarded"):
            tally["GUARD"] += 1
        else:
            tally["REFUSED"] += 1

    with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
        for value in sorted(seen):
            handle.write(json.dumps(seen[value], ensure_ascii=False) + "\n")

    print(f"words {len(words)}  distinct {len(seen)}")
    for key in sorted(tally):
        print(f"  {key:22} {tally[key]}")
    # The invariant worth checking every run: the phrase morae must sum to the
    # reading's mora count. When they disagree the notation would be emitted
    # against a different string than the one that was analysed.
    mismatched = [
        r for r in seen.values()
        if r["ok"] and sum(p[0] for p in r["phrases"]) != len(accent.split_moras(r["reading"]))
    ]
    print(f"  mora-sum vs reading   {len(mismatched)} mismatched")
    for r in mismatched[:10]:
        print(f"    {r['value']} phrases={r['phrases']} reading={r['reading']}")
    print(f"wrote {args.out}")
    return 0


def accent_version() -> str:
    import importlib.metadata as md

    try:
        return f"pyopenjtalk-plus/{md.version('pyopenjtalk-plus')}"
    except Exception:  # noqa: BLE001
        return "pyopenjtalk-plus/unknown"


if __name__ == "__main__":
    raise SystemExit(main())
