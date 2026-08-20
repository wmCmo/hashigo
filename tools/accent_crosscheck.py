"""Cross-check the OpenJTalk derivation against UniDic — a SECOND dictionary.

    .venv-accent/Scripts/python tools/accent_crosscheck.py \
        --derived build/accents.jsonl --out build/accent-disagreements.jsonl

WHY THIS EXISTS. The step-3 derivation rests on one analyser plus my recall, and
"5 of 15 mismatched against what I remembered" is not a citation. UniDic is an
independent, properly licensed dictionary (2.3.0) whose `aType` field is the
accent nucleus position directly — not derived, looked up. Two dictionaries
agreeing is evidence; one dictionary plus a language model's memory is not.

WHAT IS COMPARABLE, AND WHAT IS NOT. `aType` is a property of a MORPHEME. For a
single-token word it is directly comparable to our accent_type. For a
multi-token word UniDic expresses the answer through the compound-accent rules
(`aConType` / `aModType`) instead, and combining those correctly is its own
project — so multi-token words are reported as NOT COMPARABLE rather than as
agreement or disagreement. Counting them either way would be a number without a
basis.

`aType` is also sometimes a list (`0,1`) or `*`, both of which mean the
dictionary declines to commit. Those are not disagreements either.
"""
import argparse
import json
import sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import fugashi  # noqa: E402

TYPE_OF = {0: "平板"}


def type_for(accent: int, moras: int) -> str:
    """Our own naming, applied to UniDic's number, so the two are comparable.

    Same rule as tools/accent.py: 0 (or past the end) is 平板, 1 is 頭高, the
    last mora is 尾高, anything between is 中高.
    """
    if accent == 0 or accent > moras:
        return "平板"
    if accent == 1:
        return "頭高"
    if accent == moras:
        return "尾高"
    return "中高"


SMALL = "ゃゅょぁぃぅぇぉャュョァィゥェォ"


def mora_count(kana: str) -> int:
    return sum(1 for i, ch in enumerate(kana) if ch not in SMALL or i == 0)


def unidic_accent(tagger, text):
    """`(aType, moras, tokens)` for `text`, or None when not comparable."""
    tokens = list(tagger(text))
    if len(tokens) != 1:
        return None, None, len(tokens)
    feature = tokens[0].feature
    raw = getattr(feature, "aType", None)
    kana = getattr(feature, "kana", None) or ""
    if raw is None or raw in ("*", ""):
        return None, kana, 1
    # A comma-separated list means the dictionary declines to commit to one.
    if "," in str(raw):
        return None, kana, 1
    try:
        return int(raw), kana, 1
    except (TypeError, ValueError):
        return None, kana, 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--derived", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--emit-rows", default=None,
                        help="JSONL of UniDic answers, for `cli.ts load --analyser unidic`")
    args = parser.parse_args()

    tagger = fugashi.Tagger()
    all_answers = []
    tally = Counter()
    disagreements = []
    resolvable = []

    with open(args.derived, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            word = row["value"]
            accent, kana, tokens = unidic_accent(tagger, word)

            if accent is None:
                tally["not-comparable/multi-token" if (tokens or 0) > 1
                      else "not-comparable/no-atype"] += 1
                # A word OUR rule refused and UniDic also cannot settle is a real
                # manual-review item; one only WE refused may be recoverable.
                continue

            moras = mora_count(kana) if kana else 0
            unidic_type = type_for(accent, moras) if moras else None
            if unidic_type is not None:
                all_answers.append((word, accent, kana, moras))

            if not row["ok"]:
                tally["ours-refused/unidic-has-answer"] += 1
                resolvable.append({
                    "word": word, "unidic_accent": accent, "unidic_moras": moras,
                    "unidic_type": unidic_type, "unidic_kana": kana,
                    "our_reason": row.get("reason"),
                })
                continue

            ours = row["accent_type"]
            if unidic_type is None:
                tally["not-comparable/no-kana"] += 1
            elif ours == accent:
                tally["agree/exact"] += 1
            elif row["type"] == unidic_type:
                # Same TYPE, different position number. Happens where the mora
                # counts differ (long vowels, small kana) and the label is still
                # the thing shown to the user, so it is reported apart from a
                # real disagreement rather than lumped in with it.
                tally["agree/type-only"] += 1
            else:
                tally["DISAGREE"] += 1
                disagreements.append({
                    "word": word,
                    "ours_type": row["type"], "ours_accent": ours,
                    "ours_reading": row["reading"], "ours_phrases": row["phrases"],
                    "unidic_type": unidic_type, "unidic_accent": accent,
                    "unidic_kana": kana, "unidic_moras": moras,
                })

    with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
        for row in disagreements:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(args.out.replace(".jsonl", "-recoverable.jsonl"), "w",
              encoding="utf-8", newline="\n") as handle:
        for row in resolvable:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    total = sum(tally.values())
    print(f"cross-checked {total} keys against UniDic 2.3.0")
    for key in sorted(tally):
        print(f"  {key:34} {tally[key]:5}  {tally[key] / total * 100:5.1f}%")
    comparable = tally["agree/exact"] + tally["agree/type-only"] + tally["DISAGREE"]
    if comparable:
        agree = tally["agree/exact"] + tally["agree/type-only"]
        print(f"  -> of {comparable} COMPARABLE words, {agree} agree "
              f"({agree / comparable * 100:.2f}%), {tally['DISAGREE']} disagree")
    # Also emit every UniDic answer in the same JSONL shape the loader takes, so
    # the cross-check lands in `accents` as analyser='unidic' and the
    # `accent_disagreements` view can be queried instead of a report file going
    # stale on disk.
    if args.emit_rows:
        with open(args.emit_rows, "w", encoding="utf-8", newline="\n") as handle:
            for word, accent, kana, moras in all_answers:
                handle.write(json.dumps({
                    "value": word,
                    "ok": True,
                    "basis": "bare",          # looked up, not probed
                    "type": type_for(accent, moras) if moras else None,
                    "accent_type": accent,
                    "phrases": [[moras, accent]] if moras else [],
                    "reading": kana,
                    "version": "unidic/2.3.0",
                    "probe": "",
                    "analyser": "unidic",
                    "reason": None,
                }, ensure_ascii=False) + "\n")
        print(f"wrote {args.emit_rows} ({len(all_answers)} UniDic answers)")

    print(f"wrote {args.out} and its -recoverable sibling")

    print("\nfirst disagreements:")
    for row in disagreements[:20]:
        print(f"  {row['word']:10} ours={row['ours_type']}({row['ours_accent']})"
              f" {row['ours_reading']:10} unidic={row['unidic_type']}({row['unidic_accent']})"
              f" {row['unidic_kana']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
