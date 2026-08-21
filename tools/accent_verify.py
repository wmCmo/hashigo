"""Does the audio put the downstep where the derivation said it would?

    python tools/accent_verify.py build/accent-cards-notated --db build/hashigo.db

THE QUESTION THIS ANSWERS, and the one it does not. The blind test settled whether
the notated clips sound WORSE than the unaided ones: they do not (46% of clips
called fuzzy were notated, p = 0.709). That is a statement about quality. It says
nothing about whether the accent is CORRECT, which is the thing that matters —
a wrong accent drilled through spaced repetition is worse than no accent.

So: for each word, the derivation claims a downstep after mora N (or none, for
平板). This finds where the F0 actually falls and compares.

METHOD, with its limits stated because they are large:

  * the clip is `word + が`, so the expected span is (moras + 1) units
  * the voiced frames are split into that many equal slices, and the biggest
    drop between adjacent slice medians is taken as the observed downstep
  * 平板 expects NO large internal drop; a fall in the final slice is
    utterance-final declination and does not count as a nucleus

  LIMIT 1: mora timing is NOT uniform. A long vowel or a geminate takes more
  time than a light mora, so slicing by count misplaces the boundary. Expect
  +/- 1 mora of slop, which is why only the SIGN and rough position are checked,
  never the exact index.
  LIMIT 2: the tracker occasionally octave-jumps. Slice MEDIANS rather than
  extremes absorb most of that.
  LIMIT 3: 20 words is 20 words.

So a mismatch here is a POINTER at a word to listen to, not a verdict. A high
match rate is meaningful; a single miss is not.
"""
import math
import pathlib
import re
import sqlite3
import statistics
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from f0 import contour  # noqa: E402

WORD = re.compile(r"card-\d+-(.+?)\.\w+\.wav$")
SMALL = "ゃゅょぁぃぅぇぉャュョァィゥェォ"
DROP = 0.06  # 6% between adjacent slices ~ 1 semitone. Below this is drift.
OFFSET = 1   # slices; see the comment where it is applied. MEASURED, not chosen.

# Moras that do not take a normal mora's worth of time: the long-vowel mark, the
# geminate, and moraic n. Equal-width slicing is wrong exactly here.
SPECIAL = "ーっッんン"


def has_special_mora(kana):
    return any(ch in SPECIAL for ch in kana)


def mora_count(kana):
    return sum(1 for i, ch in enumerate(kana) if ch not in SMALL or i == 0)


def slices(values, count):
    """Median of each of `count` equal slices of the voiced span."""
    if len(values) < count * 2:
        return None
    out, size = [], len(values) / count
    for i in range(count):
        chunk = values[int(i * size): int((i + 1) * size)]
        if not chunk:
            return None
        out.append(statistics.median(chunk))
    return out


def observed_downstep(medians):
    """(index after which the biggest fall happens, its size). 1-based."""
    best_at, best = 0, 0.0
    for i in range(len(medians) - 1):
        fall = (medians[i] - medians[i + 1]) / medians[i]
        if fall > best:
            best, best_at = fall, i + 1
    return best_at, best


def main(clip_dir, db_path):
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    resolved = {
        row["text"]: (row["type"], row["accent_type"], row["reading"])
        for row in db.execute(
            "SELECT text, type, accent_type, reading FROM accent_resolved WHERE type IS NOT NULL"
        )
    }
    db.close()

    rows, matched, checked = [], 0, 0
    for path in sorted(pathlib.Path(clip_dir).glob("*.wav")):
        m = WORD.search(path.name)
        if not m:
            continue
        word = m.group(1)
        if word not in resolved:
            rows.append((word, "-", "-", "-", "no derivation", False))
            continue
        kind, accent, reading = resolved[word]
        moras = mora_count(reading or "")
        if moras == 0:
            rows.append((word, kind, accent, "-", "no reading", False))
            continue

        voiced = contour(str(path))
        # word moras plus the appended particle
        medians = slices(voiced, moras + 1)
        if medians is None:
            rows.append((word, kind, accent, "-", "too few voiced frames", False))
            continue

        at, size = observed_downstep(medians)
        checked += 1
        special = has_special_mora(reading or "")

        if accent == 0:
            # 平板: no nucleus inside the word. A fall in the LAST slice is
            # utterance-final declination and is expected, not a downstep.
            internal = observed_downstep(medians[:-1])[1] if len(medians) > 2 else 0.0
            ok = internal < DROP
            note = f"internal fall {internal * 100:.0f}%"
        else:
            # THE OBSERVED FALL RUNS ONE SLICE LATE, SYSTEMATICALLY. Measured over
            # this set: every matching nucleus word came back at exactly
            # `accent + 1` -- 係数 4 vs 3, 捜査 2 vs 1, 取り戻す 5 vs 4, 使命 2 vs 1,
            # 覚える 4 vs 3, タンパク質 5 vs 4. Six for six is not noise.
            #
            # Two reasons, both real. The F0 fall in Japanese is realised late, over
            # the transition into the following mora rather than at the boundary;
            # and the slices are cut over VOICED frames, which excludes unvoiced
            # consonants and shifts every boundary rightward. So the honest
            # comparison subtracts the offset and then demands an EXACT hit, rather
            # than keeping a +/-1 tolerance that silently absorbs it.
            ok = size >= DROP and (at - OFFSET) == accent
            note = f"fall {size * 100:.0f}% after slice {at} (-{OFFSET} = {at - OFFSET}), wanted {accent}"
        matched += ok
        rows.append((word, kind, accent, "MATCH" if ok else "miss", note, special))

    print(f"{'word':12} {'型':6} {'want':>4} {'sp':>3}  {'result':6} note")
    for word, kind, accent, result, note, special in rows:
        print(f"{word:12} {str(kind):6} {str(accent):>4} {'*' if special else '':>3}  "
              f"{result:6} {note}")

    # Split the score, because the two cases fail for different reasons and one
    # combined percentage hides that.
    nucleus = [r for r in rows if r[2] not in ("-", 0) and r[3] in ("MATCH", "miss")]
    heiban = [r for r in rows if r[2] == 0 and r[3] in ("MATCH", "miss")]
    print("")
    for label, group in (("nucleus (頭高/中高/尾高)", nucleus), ("平板", heiban)):
        if not group:
            continue
        hit = sum(1 for r in group if r[3] == "MATCH")
        print(f"{label:24} {hit}/{len(group)}  ({hit / len(group) * 100:.0f}%)")

    # Does the 平板 failure track SPECIAL MORAS? Slicing by count assumes every
    # mora takes equal time, and a long vowel, a geminate or a moraic n breaks
    # that -- a long vowel is one continuous F0 glide cut in half, which reads as
    # a fall that is really within-vowel declination.
    if heiban:
        sp_miss = sum(1 for r in heiban if r[5] and r[3] == "miss")
        sp_all = sum(1 for r in heiban if r[5])
        pl_miss = sum(1 for r in heiban if not r[5] and r[3] == "miss")
        pl_all = sum(1 for r in heiban if not r[5])
        print("")
        print("平板 misses vs SPECIAL MORAS (long vowel / geminate / moraic n):")
        print(f"  with a special mora   {sp_miss}/{sp_all} missed")
        print(f"  all light moras       {pl_miss}/{pl_all} missed")
        print("  A clean split means the method is wrong on those words, NOT the accent:")
        print("  equal-width slices assume equal-duration moras, which is false for them.")
    print("")
    print("READ THIS AS A SMOKE TEST. 20 words, coarse slicing, and the misses are")
    print("words to LISTEN to rather than words that are wrong.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    db = "build/hashigo.db"
    if "--db" in sys.argv:
        db = sys.argv[sys.argv.index("--db") + 1]
    main(sys.argv[1], db)
