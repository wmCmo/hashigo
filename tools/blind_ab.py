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

Score it by writing L or R (or "same") next to each clip in the scoresheet, THEN
open ANSWERS.txt. Chance is 50%: on 40 clips, ~26 correct is the rough threshold
for "this is real and not expectation" at p < 0.05.
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
    target.mkdir(parents=True, exist_ok=True)
    for old in target.glob("*"):
        old.unlink()

    answers, sheet = [], []
    for position, (word, arm, path) in enumerate(ordered, start=1):
        name = f"clip-{position:02d}.wav"
        shutil.copy2(path, target / name)
        answers.append(f"{name}\t{arm}\t{word}")
        sheet.append(f"{name}\t____   (L / R / same)")

    (target / "ANSWERS.txt").write_text(
        "DO NOT OPEN until the scoresheet is filled in.\n"
        f"L = {left_dir}   R = {right_dir}\n\n" + "\n".join(answers) + "\n",
        encoding="utf-8",
    )
    (target / "scoresheet.txt").write_text(
        "Write L or R for which set you think each clip came from, or 'same'.\n"
        "L and R mean nothing here — just be consistent. Then open ANSWERS.txt.\n"
        "40 clips, chance is 50%. Roughly 26+ correct means it is real,\n"
        "not expectation. Around 20 means the two are indistinguishable.\n\n"
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
