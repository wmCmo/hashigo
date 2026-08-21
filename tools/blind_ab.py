"""Build a BLIND A/B listening set from two directories of paired clips.

    python tools/blind_ab.py build/accent-cards build/accent-cards-notated build/blind

WHY BLIND. Zach compared the two sets knowing which was which and reported the
notated arm sounded "more fuzzy", then said "maybe it's just me". Four gross
acoustic measures say the arms are near-identical — loudness -0.2%, duration
+1.5%, voiced fraction -0.5%, robust F0 range +6.1%, with no correlation to the
long-vowel notation. So either the difference is in something those measures miss
(vowel quality, articulation), or it is expectation.

A blind test separates those two for the cost of listening to 40 short clips, and
it is the only way to find out which question to spend effort on. Guessing wrong
here means either chasing an artefact of expectation, or dismissing a real defect
in the notation.

HOW IT WORKS. Every clip is copied under an opaque name. The key is written to a
SEPARATE file so it can be left unopened until after the scoring. Ordering is
seeded, so the same inputs always produce the same set — the run is reproducible
without a clock or a random source.

    build/blind/clip-01.wav ... clip-40.wav   listen to these
    build/blind/ANSWERS.txt                   do NOT open until scored
    build/blind/scoresheet.txt                write your guesses here

Mark each clip `crisp`, `fuzzy` or `same` — the QUALITY, in the listener's own
words — then run `tools/blind_score.py`, which does the correlation.

THE FIRST VERSION ASKED THE WRONG QUESTION. It said "write L or R for which set
you think this came from" while ALSO saying L and R meant nothing and to just be
consistent. Those two instructions contradict each other: you cannot identify a
set whose character you have not been told. It turned the task into
reverse-engineering the labels instead of listening. Ask for the perception;
compute the correlation in code.

DO NOT REGENERATE OVER A SHEET SOMEONE IS FILLING IN. This script clears its
output directory, and I overwrote a partly-scored sheet exactly once by not
checking first.
"""
import hashlib
import pathlib
import re
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

WORD = re.compile(r"card-\d+-(.+?)\.\w+\.wav$")


def collect(directory):
    out = {}
    for path in pathlib.Path(directory).glob("*.wav"):
        match = WORD.search(path.name)
        if match:
            out[match.group(1)] = path
    return out


def main(left_dir, right_dir, out_dir):
    left, right = collect(left_dir), collect(right_dir)
    shared = sorted(set(left) & set(right))
    if not shared:
        raise SystemExit("no paired words found")

    # Deterministic order from a hash, with no clock and no RNG.
    #
    # A fixed STRIDE was the first attempt and it was wrong: the entry list
    # alternates L,R by construction, and any odd stride preserves that parity,
    # so the output came out L,R,L,R,... perfectly — a pattern learnable by the
    # sixth clip, which would have measured pattern-spotting instead of hearing.
    # Sorting by a content hash scatters both the arm and the word.
    entries = []
    for word in shared:
        entries.append((word, "L", left[word]))
        entries.append((word, "R", right[word]))
    ordered = sorted(
        entries,
        key=lambda e: hashlib.sha256(f"hashigo-blind-1{e[0]}{e[1]}".encode("utf-8")).hexdigest(),
    )
    # A word's two versions must not land adjacent — that comparison is trivially
    # easy and answers a different question. Nudge any collision forward.
    for i in range(len(ordered) - 1):
        if ordered[i][0] == ordered[i + 1][0]:
            for j in range(i + 2, len(ordered)):
                if ordered[j][0] != ordered[i][0] and (
                    j + 1 >= len(ordered) or ordered[j + 1][0] != ordered[i][0]
                ):
                    ordered[i + 1], ordered[j] = ordered[j], ordered[i + 1]
                    break

    target = pathlib.Path(out_dir)
    # Refuse to clobber a sheet someone has started. I did this once, to a sheet
    # being filled in at that moment, and lost answers.
    existing = target / "scoresheet.txt"
    if existing.is_file():
        marked = [
            line for line in existing.read_text(encoding="utf-8").splitlines()
            if line.startswith("clip-") and "crisp / fuzzy / same" not in line
        ]
        if marked:
            raise SystemExit(
                f"{existing} already has {len(marked)} scored clip(s).\n"
                f"Refusing to overwrite. Move it aside first if you really want a new set."
            )
    target.mkdir(parents=True, exist_ok=True)
    for stale in target.glob("*"):
        stale.unlink()

    answers, sheet = [], []
    for position, (word, arm, path) in enumerate(ordered, start=1):
        name = f"clip-{position:02d}.wav"
        shutil.copy2(path, target / name)
        answers.append(f"{name}\t{arm}\t{word}")
        sheet.append(f"{name}\t____   (crisp / fuzzy / same)")

    (target / "ANSWERS.txt").write_text(
        "DO NOT OPEN until the scoresheet is filled in.\n"
        f"L = {left_dir}   R = {right_dir}\n\n" + "\n".join(answers) + "\n",
        encoding="utf-8",
    )
    (target / "scoresheet.txt").write_text(
        "Mark each clip in YOUR words: crisp / fuzzy / same.\n\n"
        "Do NOT guess which set it came from — the scorer works that out. You\n"
        "noticed a quality, so record the quality. `same` is a real answer and the\n"
        "most useful one if the two genuinely sound alike.\n\n"
        "Replacing the bracket with one word is the expected format:\n"
        "    clip-01.wav\t____   (fuzzy)\n\n"
        f"When done:  python tools/blind_score.py {out_dir}\n\n"
        + "\n".join(sheet) + "\n",
        encoding="utf-8",
    )
    print(f"{len(ordered)} clips -> {target}")
    print(f"  listen to clip-01..clip-{len(ordered):02d}.wav")
    print("  fill in scoresheet.txt, THEN open ANSWERS.txt")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
