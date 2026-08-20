"""F0 over the voiced span of a WAV, in thirds. No dependencies beyond stdlib.

    PYTHONIOENCODING=utf-8 python tools/f0.py build/longvowel/*.wav

WHY THIS EXISTS AS A FILE. The 22-call provider comparison that settled
Google-vs-Azure measured F0 this way, but the script was ad-hoc and was not
committed — so the single most decision-changing measurement in the project was
not reproducible. `notes/pitch-accent-pipeline.md` quotes numbers this file can
now regenerate.

METHOD, stated because a pitch tracker has choices and they matter:

  * frames of 40 ms, hopped 10 ms, Hann-windowed
  * per-frame F0 by AUTOCORRELATION over lags for 60-400 Hz, which covers a
    male and a female ja-JP voice without octave-jumping into formants
  * a frame is VOICED when its normalised autocorrelation peak clears 0.35 and
    its RMS clears 5% of the file's peak RMS. Both gates are needed: silence has
    no periodicity, and a breathy tail has periodicity but no energy.
  * the voiced frames are then split into equal THIRDS by count, not by time,
    so a long final vowel does not swallow the comparison.

A DOWNSTEP IS A FALL BETWEEN THIRDS, so the interesting figure is the shape
(early-high vs late-high), not the absolute Hz — which differ by voice.
"""
import math
import statistics
import struct
import sys
import wave


def read_mono(path):
    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    if width != 2:
        raise SystemExit(f"{path}: expected 16-bit PCM, got {width * 8}-bit")
    samples = struct.unpack(f"<{len(raw) // 2}h", raw)
    if channels > 1:
        samples = samples[::channels]
    return list(samples), rate


def frame_f0(frame, rate, lo=60.0, hi=400.0):
    """(f0, clarity) by autocorrelation, or (None, peak) when unvoiced."""
    n = len(frame)
    mean = sum(frame) / n
    signal = [s - mean for s in frame]
    energy = sum(s * s for s in signal)
    if energy <= 0:
        return None, 0.0
    min_lag = max(2, int(rate / hi))
    max_lag = min(n - 1, int(rate / lo))
    best_lag, best = 0, 0.0
    for lag in range(min_lag, max_lag + 1):
        total = 0.0
        for i in range(n - lag):
            total += signal[i] * signal[i + lag]
        norm = total / energy
        if norm > best:
            best, best_lag = norm, lag
    if best_lag == 0 or best < 0.35:
        return None, best
    return rate / best_lag, best


def contour(path, frame_ms=40, hop_ms=10):
    samples, rate = read_mono(path)
    size = int(rate * frame_ms / 1000)
    hop = int(rate * hop_ms / 1000)
    window = [0.5 - 0.5 * math.cos(2 * math.pi * i / (size - 1)) for i in range(size)]

    rms_values, frames = [], []
    for start in range(0, len(samples) - size, hop):
        chunk = samples[start : start + size]
        rms = math.sqrt(sum(s * s for s in chunk) / size)
        rms_values.append(rms)
        frames.append([c * w for c, w in zip(chunk, window)])
    if not frames:
        return []
    floor = max(rms_values) * 0.05

    voiced = []
    for frame, rms in zip(frames, rms_values):
        if rms < floor:
            continue
        f0, _ = frame_f0(frame, rate)
        if f0 is not None:
            voiced.append(f0)
    return voiced


def thirds(values):
    if len(values) < 6:
        return None
    size = len(values) // 3
    return [
        statistics.median(values[0:size]),
        statistics.median(values[size : 2 * size]),
        statistics.median(values[2 * size :]),
    ]


def main(paths):
    print(f"{'file':34} {'frames':>6}  {'1st':>6} {'2nd':>6} {'3rd':>6}  shape")
    for path in paths:
        values = contour(path)
        parts = thirds(values)
        name = path.replace("\\", "/").split("/")[-1]
        if parts is None:
            print(f"{name:34} {len(values):>6}  too few voiced frames to judge")
            continue
        first, second, third = parts
        # A fall of more than 8% between adjacent thirds is a downstep; below
        # that is drift. 8% is roughly 1.4 semitones -- smaller than any accent
        # distinction and larger than the tracker's own noise on these files.
        drop12 = (first - second) / first
        drop23 = (second - third) / second
        shape = []
        if drop12 > 0.08:
            shape.append("fall 1->2")
        if drop23 > 0.08:
            shape.append("fall 2->3")
        if not shape:
            shape.append("flat/rising")
        print(
            f"{name:34} {len(values):>6}  {first:6.1f} {second:6.1f} {third:6.1f}  "
            f"{', '.join(shape)}"
        )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
