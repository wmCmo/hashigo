"""Compare two directories of clips for the SAME words, pair by pair.

    python tools/ab_clips.py build/accent-cards build/accent-cards-notated

WHY. Zach listened to both sets and said the notated one sounded "more fuzzy",
then added "maybe it's just me". A listener's impression of two dozen clips is
data, not noise — but it is also the kind of thing that can be an artefact of
loudness or duration rather than of the thing being tested. This measures the
handful of properties that would explain "fuzzy" without needing golden ears.

WHAT IT MEASURES, and why each one:

  duration      the notated arm reads KANA; if Google mis-segments it, the clip
                gets longer or shorter than the kanji arm. A large shift is the
                simplest explanation for "less concise".
  peak / RMS    loudness. Quieter audio is reliably described as less crisp, and
                it has nothing to do with pitch.
  voiced%       fraction of frames the pitch tracker calls voiced. A lower figure
                means more breath and less periodic phonation, which IS what
                "fuzzy" usually means acoustically.
  F0 range      max/min over the voiced span, in semitones. A FLATTER contour on
                the notated arm would mean the notation is suppressing Google's
                own prosody rather than steering it.

None of this replaces his ear. It says whether his ear noticed loudness,
duration, breathiness, or pitch — which are four different bugs.
"""
import math
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from f0 import contour, read_mono  # noqa: E402

WORD = re.compile(r"card-\d+-(.+?)\.\w+\.wav$")


def stats(path):
    samples, rate = read_mono(str(path))
    n = len(samples)
    if n == 0:
        return None
    peak = max(abs(s) for s in samples) / 32768
    rms = math.sqrt(sum(s * s for s in samples) / n) / 32768
    voiced = contour(str(path))
    # Frames the tracker considered at all, same framing as f0.contour.
    size = int(rate * 0.04)
    hop = int(rate * 0.01)
    frames = max(1, len(range(0, n - size, hop)))
    # ROBUST range, p10..p90, NOT max/min. An autocorrelation tracker
    # occasionally halves or doubles a frame, and min/max hands the whole
    # statistic to that one frame: several clips reported 22-28 semitones, which
    # is nearly two octaves and not something a human voice does in one word.
    # 12 st = exactly 2x, so those figures were octave errors, not prosody.
    span = 0.0
    if len(voiced) >= 8:
        ordered = sorted(voiced)
        lo = ordered[int(len(ordered) * 0.10)]
        hi = ordered[int(len(ordered) * 0.90)]
        span = 12 * math.log2(hi / lo) if lo > 0 else 0.0
    return {
        "seconds": n / rate,
        "peak": peak,
        "rms": rms,
        "voiced": len(voiced) / frames,
        "semitones": span,
    }


def main(left_dir, right_dir):
    left = {}
    for p in pathlib.Path(left_dir).glob("*.wav"):
        m = WORD.search(p.name)
        if m:
            left[m.group(1)] = p
    right = {}
    for p in pathlib.Path(right_dir).glob("*.wav"):
        m = WORD.search(p.name)
        if m:
            right[m.group(1)] = p

    shared = sorted(set(left) & set(right))
    print(f"{len(shared)} paired word(s). left={left_dir}  right={right_dir}")
    print("")
    print(f"{'word':12} {'sec L':>6} {'sec R':>6} {'Δ%':>6}  "
          f"{'rms L':>6} {'rms R':>6} {'Δ%':>6}  "
          f"{'vcd L':>6} {'vcd R':>6}  {'st L':>5} {'st R':>5}")

    agg = {k: [0.0, 0.0] for k in ("seconds", "rms", "voiced", "semitones")}
    counted = 0
    for word in shared:
        a, b = stats(left[word]), stats(right[word])
        if a is None or b is None:
            continue
        counted += 1
        for k in agg:
            agg[k][0] += a[k]
            agg[k][1] += b[k]
        d_sec = (b["seconds"] - a["seconds"]) / a["seconds"] * 100
        d_rms = (b["rms"] - a["rms"]) / a["rms"] * 100 if a["rms"] else 0.0
        print(f"{word:12} {a['seconds']:6.2f} {b['seconds']:6.2f} {d_sec:+6.1f}  "
              f"{a['rms']:6.3f} {b['rms']:6.3f} {d_rms:+6.1f}  "
              f"{a['voiced']:6.2f} {b['voiced']:6.2f}  "
              f"{a['semitones']:5.1f} {b['semitones']:5.1f}")

    if not counted:
        return
    print("")
    print("MEANS")
    for key, (l, r) in agg.items():
        l, r = l / counted, r / counted
        delta = (r - l) / l * 100 if l else 0.0
        print(f"  {key:10} left {l:8.3f}   right {r:8.3f}   {delta:+6.1f}%")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
