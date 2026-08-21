"""Score a blind listening sheet: does the impression track the arm?

    python tools/blind_score.py build/blind

WHY THIS SHAPE, and why the first one was wrong. The first scoresheet asked
"which set do you think this came from, L or R", and told the listener that L and
R meant nothing and to just be consistent. Those two instructions contradict each
other — you cannot identify a set you have not been told the character of — and it
made the task reverse-engineering my labels rather than listening.

What Zach actually reported was a QUALITY: the notated arm sounded "more fuzzy",
the kanji arm "more concise". So the right instrument asks for that quality, in
his words, per clip, with no reference to the arms at all. The correlation is then
mine to compute:

    of the clips marked FUZZY, what fraction came from the notated arm?

50% means the impression does not track the notation, and the first pass was
framing. Well above 50% means there is a real difference for the four gross
acoustic measures in `ab_clips.py` to have missed, and it is worth chasing with
formant analysis.

Mark each clip `crisp`, `fuzzy`, or `same` (or leave blank to skip). Case and
surrounding punctuation do not matter.
"""
import collections
import math
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

VERDICTS = ("crisp", "fuzzy", "same")


def parse_answers(path):
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("clip-"):
            continue
        parts = line.split("\t")
        if len(parts) >= 3:
            out[parts[0]] = (parts[1].strip(), parts[2].strip())
    return out


def parse_sheet(path):
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("clip-"):
            continue
        clip, _, rest = line.partition("\t")
        text = re.sub(r"[^a-z]", " ", rest.lower())
        found = [v for v in VERDICTS if v in text.split()]
        if len(found) == 1:
            out[clip.strip()] = found[0]
    return out


def binomial_tail(k, n, p=0.5):
    """P(X >= k) for X ~ Binomial(n, p). Exact, no dependencies."""
    if n == 0:
        return 1.0
    total = 0.0
    for i in range(k, n + 1):
        total += math.comb(n, i) * (p ** i) * ((1 - p) ** (n - i))
    return total


def main(directory):
    base = pathlib.Path(directory)
    answers = parse_answers(base / "ANSWERS.txt")
    sheet = parse_sheet(base / "scoresheet.txt")
    if not sheet:
        raise SystemExit(
            "no verdicts found in scoresheet.txt — mark clips crisp / fuzzy / same"
        )

    # L is the kanji arm (unaided Google), R is the notated arm.
    counts = collections.Counter()
    per_word = collections.defaultdict(dict)
    for clip, verdict in sheet.items():
        if clip not in answers:
            continue
        arm, word = answers[clip]
        counts[(arm, verdict)] += 1
        per_word[word][arm] = verdict

    print(f"scored {len(sheet)} of {len(answers)} clips")
    print("")
    print(f"{'':8} {'crisp':>7} {'fuzzy':>7} {'same':>7}")
    for arm, label in (("L", "kanji"), ("R", "notated")):
        row = [counts[(arm, v)] for v in VERDICTS]
        print(f"{label:8} {row[0]:>7} {row[1]:>7} {row[2]:>7}")

    fuzzy_total = counts[("L", "fuzzy")] + counts[("R", "fuzzy")]
    print("")
    if fuzzy_total == 0:
        print("nothing marked fuzzy — the impression did not survive the blind.")
    else:
        share = counts[("R", "fuzzy")] / fuzzy_total
        p = binomial_tail(counts[("R", "fuzzy")], fuzzy_total)
        print(f"of {fuzzy_total} clips marked FUZZY, {counts[('R', 'fuzzy')]} were the "
              f"notated arm — {share * 100:.0f}%")
        print(f"  one-sided binomial p = {p:.3f}"
              f"   ({'REAL, worth chasing' if p < 0.05 else 'not distinguishable from chance'})")

    # Where he split a pair, that word is the interesting one to look at.
    split = [w for w, arms in per_word.items()
             if len(arms) == 2 and arms.get("L") != arms.get("R")]
    if split:
        print("")
        print(f"{len(split)} word(s) where the two versions got DIFFERENT verdicts —")
        print("these are the ones to inspect, whichever way the statistics land:")
        for word in sorted(split):
            arms = per_word[word]
            print(f"  {word:12} kanji={arms.get('L', '-'):6} notated={arms.get('R', '-')}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
