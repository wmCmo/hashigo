"""Annotate example SENTENCES per mora — accent head and devoicing — as JSONL.

    npx vite-node src/accent/cli.ts -- sentences --db build/hashigo.db --out build/sentences.txt
    .venv-accent/Scripts/python tools/accent_sentence.py --in build/sentences.txt --out build/sentence-accents.jsonl
    npx vite-node src/accent/cli.ts -- marks --db build/hashigo.db --in build/sentence-accents.jsonl

THE SAME BOUNDARY AS `accent_derive.py`, FOR THE SAME REASON. This reads the
strings it is HANDED and never the database: an earlier generation of that script
read authored values directly and mis-read his vocabulary, because a wiki-link id
and a U+200E are invisible in a value and audible in a reading. The cleaning that
produces `--in` lives in `src/accent/sentence.ts`, next to the schema.

─── WHAT COMES OUT OF THE LABELS, AND WHAT DOES NOT ─────────────────────────

OpenJTalk emits one HTS full-context label per phoneme. Three fields matter and
`tools/accent.py` already documents two of them:

    /A:a1+a2+a3     a2 = this mora's position in its accent phrase, 1-based
    /F:f1_f2#...@f5 f1 = morae in the phrase, f2 = accent position, f5 = phrase index
    /I:...@i3+      i3 = this breath group's index in the utterance

An accent phrase is keyed by (i3, f5) — NOT by "a2 reset to 1", which fails on
`に引き換え` where both phrases start at a2=1. A MORA is therefore keyed by
(i3, f5, a2), and that is what makes this alignment-free: phonemes group into
morae by their own label rather than by anyone counting kana.

DEVOICING IS ALREADY HERE AND NOBODY HAD NOTICED. A devoiced vowel is written as
an UPPERCASE phoneme:

    しました   sh i m a sh I t a      the second し
    学生です   g a k U s e e d e s U  both く and す

So the second half of what Zach asked for costs one `isupper()` and no new tool.

─── 平板 IS `f2 == f1`, NOT `f2 == 0` ───────────────────────────────────────

    鼻が (3, 3)  accent on the LAST mora -> 平板, no drop, no mark
    花が (3, 2)  accent strictly inside  -> 尾高, drops after な

Measured on this corpus, ZERO phrases in a sample of real sentences report f2=0,
so a naive `f2 > 0` test marks every flat phrase. It painted 21.1% of all morae;
the correct rule gives 13.9%. This is CLAUDE.md's *"2,065 phantom 尾高"* trap
arriving somewhere the probe particle cannot reach, because a sentence already
has a following word.
"""
import argparse
import json
import re
import sys
from collections import Counter

sys.path.insert(0, "tools")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import pyopenjtalk  # noqa: E402

PHONEME_RE = re.compile(r"\-([^\+]+)\+")
A_RE = re.compile(r"/A:(-?\d+)\+(\d+)\+")
F_RE = re.compile(r"/F:(\d+)_(\d+)#[^@]*@(\d+)_(\d+)")
I_RE = re.compile(r"/I:[^@]*@(\d+)\+")

DEVOICED_VOWELS = frozenset("AIUEO")
SMALL = "ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ"
READING_CHAR = re.compile(r"[ぁ-ゖァ-ヺー]")

PHRASE_MARK, HEAD_MARK, DEVOICED_MARK = "|", "*", "_"


def to_hiragana(text):
    out = []
    for ch in text:
        code = ord(ch)
        out.append(chr(code - 0x60) if 0x30A1 <= code <= 0x30F6 else ch)
    return "".join(out)


def split_morae(reading):
    out = []
    for ch in reading:
        if ch in SMALL and out:
            out[-1] += ch
        else:
            out.append(ch)
    return out


def analyse(text):
    """[[(kana, head, devoiced)] per phrase], or (None, why)."""
    morae, order = {}, []
    for label in pyopenjtalk.extract_fullcontext(text):
        phoneme = PHONEME_RE.search(label)
        a, f, i = A_RE.search(label), F_RE.search(label), I_RE.search(label)
        if not (phoneme and a and f and i):
            continue
        name = phoneme.group(1)
        if name in ("sil", "pau"):
            continue
        mora_pos, phrase_morae, accent = int(a.group(2)), int(f.group(1)), int(f.group(2))
        key = (int(i.group(1)), int(f.group(3)), mora_pos)
        if key not in morae:
            morae[key] = {
                "phrase": (int(i.group(1)), int(f.group(3))),
                # See the header: `accent == morae` is 平板, which carries NO mark.
                "head": mora_pos == accent and 0 < accent < phrase_morae,
                "devoiced": False,
            }
            order.append(key)
        if name in DEVOICED_VOWELS:
            morae[key]["devoiced"] = True

    labelled = [morae[key] for key in order]
    kana = split_morae("".join(READING_CHAR.findall(pyopenjtalk.g2p(text, kana=True))))
    # THE ONE INVARIANT THAT MATTERS. The labels decide the marks and the kana
    # decides what is shown; if they disagree by one, every mark after that point
    # is on the WRONG kana and the card looks perfectly fine. Refuse instead.
    if len(kana) != len(labelled):
        return None, f"{len(kana)} kana morae vs {len(labelled)} from labels"

    phrases, current, last = [], [], None
    for index, mora in enumerate(labelled):
        if last is not None and mora["phrase"] != last:
            phrases.append(current)
            current = []
        current.append((to_hiragana(kana[index]), mora["head"], mora["devoiced"]))
        last = mora["phrase"]
    if current:
        phrases.append(current)
    return phrases, None


def notation(phrases):
    return PHRASE_MARK.join(
        "".join(
            kana + (HEAD_MARK if head else "") + (DEVOICED_MARK if devoiced else "")
            for kana, head, devoiced in phrase
        )
        for phrase in phrases
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="source", required=True,
                        help="one cleaned sentence per line, from `cli.ts sentences`")
    parser.add_argument("--out", required=True)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    with open(args.source, encoding="utf-8") as handle:
        sentences = [line.rstrip("\n") for line in handle if line.strip()]
    if args.limit:
        sentences = sentences[: args.limit]

    tally = Counter()
    seen = {}
    # Keyed by the SENTENCE, not by card: the same example sentence has the same
    # pronunciation wherever it appears, exactly as a blob has one address
    # whatever references it.
    for sentence in sentences:
        if sentence in seen:
            continue
        phrases, why = analyse(sentence)
        if phrases is None:
            seen[sentence] = {"text": sentence, "ok": False, "why": why}
            tally["REFUSED"] += 1
            continue
        marks = notation(phrases)
        flat = [m for phrase in phrases for m in phrase]
        seen[sentence] = {
            "text": sentence,
            "ok": True,
            "marks": marks,
            "morae": len(flat),
            "phrases": len(phrases),
            "heads": sum(1 for m in flat if m[1]),
            "devoiced": sum(1 for m in flat if m[2]),
        }
        tally["ok"] += 1
        tally["morae"] += len(flat)
        tally["heads"] += sum(1 for m in flat if m[1])
        tally["devoiced"] += sum(1 for m in flat if m[2])

    with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
        for sentence in sorted(seen):
            handle.write(json.dumps(seen[sentence], ensure_ascii=False) + "\n")

    print(f"sentences {len(sentences)}  distinct {len(seen)}")
    for key in ("ok", "REFUSED", "morae", "heads", "devoiced"):
        print(f"  {key:10} {tally[key]}")
    if tally["morae"]:
        print(f"  heads    {100 * tally['heads'] / tally['morae']:.1f}% of morae")
        print(f"  devoiced {100 * tally['devoiced'] / tally['morae']:.1f}% of morae")
    for record in list(seen.values()):
        if not record["ok"]:
            print(f"    ! {record['text'][:40]}  —  {record['why']}")
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
