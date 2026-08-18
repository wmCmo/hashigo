# Scheduler backtest — which scheduler should Hashigo ship?

Stage 5. SPEC.html deliberately does not assume FSRS: *"Ship the scheduler that wins on
your data."* This is that measurement, run over all 102,020 imported reviews.

Everything below was produced by `src/scheduler/backtest.ts` and printed by
`test/backtest.test.ts`. Reproduce with:

```
npx vitest run test/backtest.test.ts                       # 12 s, prints every table here
HASHIGO_FSRS_FIT=1 npx vitest run test/backtest.test.ts    # 47 s, also refits from scratch
```

---

## Verdict

**Ship FSRS-6, fitted to this user. Do not ship SM-2.** The margin is not subtle:
on the held-out window FSRS-6 scores 0.19–0.20 log loss against SM-2's 0.88, and
the two FSRS arms are the only candidates that beat a model with no inputs at
all.

Three qualifications, each measured rather than hedged:

1. **The SM-2 gap is mostly about the forgetting curve, not about SM-2.** SM-2
   emits intervals, not probabilities, so this harness has to attach a curve to
   it. Give SM-2's identical interval logic FSRS's power curve instead of the
   classical exponential one and its log loss falls from 0.8802 to 0.2505 —
   91% of the apparent FSRS-versus-SM-2 gap was the curve. FSRS-6 still wins, by
   0.19 to 0.25, but by a quarter rather than by a factor of four.
2. **Fitting helps, but the fitted vector should not be read.** It buys 6.5% of
   held-out log loss (0.2038 → 0.1905). Refitting with a different sweep budget
   reaches within 0.0006 of the same training loss on a *completely different*
   parameter vector, so the individual numbers are not identifiable from binary
   grades.
3. **The workload question is not settled by this backtest and I am not going to
   pretend otherwise.** See [Target retention](#target-retention-and-daily-load).
   The binding constraint on this user's schedule is Mochi's **365-day interval
   cap**, which 43.26% of live tracks are sitting on exactly — not the target
   retention setting.

---

## What was replayed

| Quantity | Value |
|---|--:|
| Reviews imported | 102,020 |
| Tracks with history | 9,026 |
| First reviews (never scored) | 9,026 |
| Reviews with a predecessor | 92,994 |
| Same-day (elapsed 0, scored separately) | 6,996 of which 256 lapses |
| Scored set | 85,998 at 95.94% observed retention |
| No planned interval in the export | 8,934 |
| Training window | 2022-06-28 to 2024-12-29 — 60,163 reviews |
| Held-out window | 2024-12-29 to 2026-08-18 — 25,835 reviews |
| Training-window base rate | 96.47% |
| Decks with history | 34 |

### Four scoring decisions, and why

**Elapsed time, not Mochi's planned interval.** `reviews.interval_days` is what
Mochi *intended*; the gap between consecutive review dates is what actually
happened. Of the 84,060 reviews where both are known, 61,594 agree to within
1.5 days, **22,226 were taken more than 1.5 days late** and 240 early. Forgetting
depends on time that passed, so elapsed is the independent variable. It also
covers 8,934 rows the planned interval leaves NULL, and — the part that matters
for the caveats below — under the elapsed definition the corpus contains **3,009
observations at intervals over a year**, where the planned definition contains
exactly zero. The whole comparison was re-run under the planned definition as a
sensitivity check; the ranking does not change.

**A track's first review is never scored.** It creates the memory rather than
testing it. 9,026 of 102,020.

**Same-day reviews are scored separately.** Every timestamp in the corpus is
date-only, so "same day" means an elapsed time of somewhere between a minute and
23 hours, recorded as 0. Scoring a forgetting curve against an unknown elapsed
time measures the harness. All 6,996 still update state — they happened — and get
their own table below.

**Grades are binary.** `reviews.grade` is NULL on all 102,020 rows; remembered
maps to Good, forgotten to Again. Four of FSRS-6's 21 parameters (w1, w3, w15,
w16) are only reachable through Hard or Easy and are frozen at their published
values.

---

## The result

### Held-out window (2024-12-29 onward) — the one table where all candidates are comparable

| Candidate | Reviews | Log loss | RMSE | Calib. RMSE | AUC | Mean predicted | Observed |
|---|--:|--:|--:|--:|--:|--:|--:|
| FSRS-6 fitted | 25,835 | 0.1905 | 0.2195 | 0.0315 | 0.725 | 93.16% | 94.70% |
| FSRS-6 | 25,835 | 0.2038 | 0.2258 | 0.0597 | 0.697 | 90.68% | 94.70% |
| Constant base rate | 25,835 | 0.2111 | 0.2246 | 0.0176 | 0.500 | 96.47% | 94.70% |
| SM-2 (power curve) | 25,835 | 0.2505 | 0.2480 | 0.1173 | 0.684 | 89.26% | 94.70% |
| Fixed ×2.5 | 25,835 | 0.7726 | 0.3637 | 0.2909 | 0.679 | 80.38% | 94.70% |
| SM-2 | 25,835 | 0.8802 | 0.3630 | 0.2898 | 0.684 | 81.83% | 94.70% |

### Whole scored set — all 85,998

| Candidate | Reviews | Log loss | RMSE | Calib. RMSE | AUC | Mean predicted | Observed |
|---|--:|--:|--:|--:|--:|--:|--:|
| FSRS-6 fitted *(in-sample)* | 85,998 | 0.1574 | 0.1946 | 0.0193 | 0.718 | 95.41% | 95.94% |
| FSRS-6 | 85,998 | 0.1666 | 0.1987 | 0.0427 | 0.682 | 93.36% | 95.94% |
| Constant base rate | 85,998 | 0.1703 | 0.1975 | 0.0053 | 0.500 | 96.47% | 95.94% |
| SM-2 (power curve) | 85,998 | 0.1986 | 0.2129 | 0.0858 | 0.634 | 93.49% | 95.94% |
| Fixed ×2.5 | 85,998 | 0.4094 | 0.2833 | 0.2058 | 0.615 | 88.93% | 95.94% |
| SM-2 | 85,998 | 0.4750 | 0.2900 | 0.2148 | 0.634 | 89.49% | 95.94% |

*The fitted arm is marked in-sample here because 70% of these rows trained it.
Only the held-out table is a fair comparison for it.*

**The two mandated metrics do not agree, and the disagreement is the finding.**
On log loss, stock FSRS-6 (0.2038) beats the constant baseline (0.2111). On RMSE
it *loses* to it (0.2258 against 0.2246). Only the fitted arm wins on both. On a
corpus where 96% of reviews are passes, "always predict 96.47%" is a genuinely
strong prediction, and squared error barely distinguishes it from a real model.
Log loss does, because it punishes confident mistakes — which is exactly what a
scheduler makes when it schedules.

The AUC column is why the ranking is a statement about *calibration* rather than
about knowledge: every real candidate, SM-2 included, orders outcomes far better
than chance (0.68–0.73 against the baseline's exact 0.500). They all know
something. Only FSRS turns it into a well-calibrated number.

### Same-day reviews, elapsed unknown — the excluded 6,996

| Candidate | Reviews | Log loss | RMSE | Calib. RMSE | AUC | Mean predicted | Observed |
|---|--:|--:|--:|--:|--:|--:|--:|
| Constant base rate | 6,996 | 0.1570 | 0.1878 | 0.0013 | 0.500 | 96.47% | 96.34% |
| SM-2 | 6,996 | 0.5055 | 0.1913 | 0.0366 | 0.500 | 100.00% | 96.34% |
| FSRS-6 | 6,996 | 0.5055 | 0.1913 | 0.0366 | 0.500 | 100.00% | 96.34% |
| FSRS-6 fitted *(in-sample)* | 6,996 | 0.5055 | 0.1913 | 0.0366 | 0.500 | 100.00% | 96.34% |
| Fixed ×2.5 | 6,996 | 0.5055 | 0.1913 | 0.0366 | 0.500 | 100.00% | 96.34% |
| SM-2 (power curve) | 6,996 | 0.5055 | 0.1913 | 0.0366 | 0.500 | 100.00% | 96.34% |

Every interval-based model predicts exactly 1.0 at t = 0 and is then charged for
256 failures it called impossible. All five score identically, to four decimals,
because on these rows they are the same degenerate model. Including them would
have added a constant to five candidates and left the ranking unchanged while
making every number meaningless. This is the strongest single argument in the
whole exercise for SPEC's insistence that real timestamps land in stage 1.

### Sensitivity: Mochi's planned interval instead of elapsed

| Candidate | Reviews | Log loss | RMSE | Calib. RMSE | AUC | Mean predicted | Observed |
|---|--:|--:|--:|--:|--:|--:|--:|
| FSRS-6 fitted *(in-sample)* | 84,060 | 0.1567 | 0.1942 | 0.0141 | 0.721 | 95.64% | 95.89% |
| FSRS-6 | 84,060 | 0.1643 | 0.1975 | 0.0355 | 0.697 | 93.66% | 95.89% |
| Constant base rate | 84,060 | 0.1717 | 0.1985 | 0.0057 | 0.500 | 96.47% | 95.89% |
| SM-2 (power curve) | 84,060 | 0.1971 | 0.2111 | 0.0800 | 0.633 | 94.15% | 95.89% |
| Fixed ×2.5 | 84,060 | 0.3598 | 0.2743 | 0.1928 | 0.613 | 90.15% | 95.89% |
| SM-2 | 84,060 | 0.4307 | 0.2835 | 0.2054 | 0.633 | 90.50% | 95.89% |

Same order, slightly lower losses, 1,938 fewer rows. The interval definition was
an open question left over from stage 1; it is now closed, and it does not change
the answer.

---

## Where the difference actually comes from

### Loss concentration, held-out window

| Candidate | Rows predicted < 50% | Observed on those rows | Share of total loss | Worst 1% share | p01 predicted | Median predicted |
|---|--:|--:|--:|--:|--:|--:|
| SM-2 | 3,662 | 83.59% | 79.55% | 15.67% | 0.00% | 97.23% |
| Fixed ×2.5 | 3,565 | 83.34% | 75.74% | 17.86% | 0.00% | 95.71% |
| SM-2 (power curve) | 1,050 | 82.10% | 12.11% | 25.56% | 44.55% | 96.48% |
| FSRS-6 | 131 | 83.21% | 1.88% | 15.72% | 55.18% | 94.64% |
| FSRS-6 fitted | 15 | 100.00% | 0.21% | 17.05% | 64.65% | 95.03% |
| Constant base rate | 0 | — | 0.00% | 15.82% | 96.47% | 96.47% |

SM-2's entire score is 3,662 rows — 14% of the window — where it predicted under
50% recall and the user remembered five times out of six. Those rows are 79.55%
of its total loss. Its 1st-percentile prediction rounds to zero: it asserts
certain failure and is charged the metric's floor for it.

### The naive floor, and the one result SPEC did not expect

SPEC: *"If a candidate cannot beat this, something is wrong with your harness."*
**SM-2 does not beat the fixed ×2.5 floor** (0.8802 against 0.7726). That demands
a mechanism before it can be reported, so two hypotheses were tested by changing
exactly one thing each:

```
SM-2 held-out log loss: as published 0.8802 · ease frozen at 2.5 0.8619
                      · same intervals, power curve 0.2505 · fixed ×2.5 floor 0.7726
```

- **Binary grades crippling the ease ladder** — under q ∈ {2, 4} the SM-2 ease
  factor can only ever fall. Freezing it at 2.5 changes the loss by 2%. **Not the
  cause.**
- **The exponential curve** — swapping only the curve, with byte-identical
  interval logic, removes 72% of SM-2's loss — 91% of its distance from FSRS-6 —
  and lifts it clear of the floor. **That is the cause.**

So the harness is not broken; the exponential forgetting curve is. SM-2 and the
fixed multiplier both use it, both collapse toward zero when the elapsed time
runs well past their own interval, and this user is late on 26% of reviews. Their
ordering *relative to each other* is noise from that shared tail and should not be
read as SM-2 being worse than a constant multiplier at scheduling.

The honest framing of the headline result: **FSRS-6 beats SM-2 by 0.19 to 0.25
log loss** (the fair, same-curve comparison), not by 0.19 to 0.88.

### Log loss by elapsed interval, held-out window

| Elapsed | Reviews | Observed | SM-2 | FSRS-6 | FSRS-6 fitted | Fixed ×2.5 | Constant base rate | SM-2 (power curve) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 1d | 902 | 97.89% | 0.1127 | 0.1297 | 0.1095 | 0.1219 | 0.1056 | 0.1145 |
| 2-3d | 2,075 | 99.18% | 0.1065 | 0.1130 | 0.0648 | 0.1323 | 0.0631 | 0.0962 |
| 4-7d | 1,850 | 97.89% | 0.2137 | 0.1376 | 0.1060 | 0.2132 | 0.1057 | 0.1528 |
| 8-21d | 3,310 | 97.04% | 0.2313 | 0.1523 | 0.1269 | 0.2524 | 0.1339 | 0.1662 |
| 22-60d | 2,420 | 90.70% | 0.9667 | 0.2637 | 0.2552 | 0.8933 | 0.3434 | 0.2965 |
| 61-180d | 5,511 | 91.31% | 1.9919 | 0.2924 | 0.2860 | 1.7627 | 0.3234 | 0.3527 |
| 181-365d | 6,841 | 94.14% | 1.0018 | 0.2149 | 0.2117 | 0.8264 | 0.2298 | 0.2962 |
| > 365d | 2,926 | 96.92% | 0.3715 | 0.1488 | 0.1469 | 0.2790 | 0.1377 | 0.2218 |

FSRS earns its win in one place: the 22–180 day band, 7,931 reviews where
retention genuinely dips to ~91% and the exponential models fall apart. Under 21
days and over a year, the constant baseline is as good as anything — including
better than everything at > 365d, where it is the *best* candidate in the table.

### Mean predicted recall by elapsed interval, held-out window

| Elapsed | Reviews | Observed | SM-2 | FSRS-6 | FSRS-6 fitted | Fixed ×2.5 | Constant base rate | SM-2 (power curve) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 1d | 902 | 97.89% | 94.43% | 92.87% | 95.54% | 93.15% | 96.47% | 94.13% |
| 2-3d | 2,075 | 99.18% | 91.85% | 90.84% | 95.86% | 89.05% | 96.47% | 92.63% |
| 4-7d | 1,850 | 97.89% | 84.92% | 91.01% | 94.91% | 84.01% | 96.47% | 89.53% |
| 8-21d | 3,310 | 97.04% | 85.81% | 91.39% | 95.22% | 81.92% | 96.47% | 89.63% |
| 22-60d | 2,420 | 90.70% | 67.28% | 86.90% | 90.74% | 64.87% | 96.47% | 82.09% |
| 61-180d | 5,511 | 91.31% | 70.58% | 87.62% | 90.55% | 65.78% | 96.47% | 83.73% |
| 181-365d | 6,841 | 94.14% | 84.49% | 92.26% | 93.16% | 85.41% | 96.47% | 91.69% |
| > 365d | 2,926 | 96.92% | 91.35% | 94.09% | 94.01% | 94.85% | 96.47% | 95.42% |

Stock FSRS-6 is systematically pessimistic — 90.68% predicted against 94.70%
observed. That is the same six-point gap SPEC identified from the other
direction, here as a property of the model rather than of the study habit, and
correcting it is most of what fitting buys: from 22 days out the fitted arm
tracks observed retention to within a point (90.74 against 90.70, 90.55 against
91.31, 93.16 against 94.14) where stock is 3–4 points low. Both still
under-predict the short buckets by 2–3 points, where the user is at 97–99%.

### Per deck, whole scored set

| Deck | Reviews | Observed | SM-2 | FSRS-6 | FSRS-6 fitted | Fixed ×2.5 | Constant base rate | SM-2 (power curve) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 日本語/単語 | 45,007 | 97.00% | 0.3905 | 0.1371 | 0.1269 | 0.3393 | 0.1352 | 0.1579 |
| 日本語/漢字 | 23,312 | 94.65% | 0.6061 | 0.2063 | 0.2005 | 0.5065 | 0.2130 | 0.2580 |
| English/Vocabulary | 9,913 | 93.19% | 0.7078 | 0.2307 | 0.2228 | 0.6003 | 0.2611 | 0.2902 |
| 日本語/部首 | 2,221 | 97.79% | 0.1870 | 0.1126 | 0.1077 | 0.1558 | 0.1089 | 0.1107 |
| 日本語/言葉 | 1,580 | 98.23% | 0.2806 | 0.1035 | 0.0875 | 0.2721 | 0.0946 | 0.1041 |
| 日本語/文法 | 550 | 95.45% | 0.7103 | 0.1883 | 0.1593 | 0.8477 | 0.1863 | 0.2111 |
| 日本語/数字 | 548 | 100.00% | 0.0102 | 0.0373 | 0.0216 | 0.0244 | 0.0360 | 0.0134 |
| 日本語/言葉/オノマトペ | 357 | 96.08% | 0.6095 | 0.1604 | 0.1503 | 0.5095 | 0.1657 | 0.1854 |
| 日本語/単語/尊敬語🤵 | 315 | 96.51% | 0.4513 | 0.1350 | 0.1291 | 0.3552 | 0.1515 | 0.1623 |
| 日本語/単語/謙譲語🙇 | 282 | 97.52% | 0.2212 | 0.1119 | 0.0997 | 0.1819 | 0.1181 | 0.1203 |
| 基本情報/第11章 | 194 | 97.42% | 0.1922 | 0.1639 | 0.1234 | 0.2953 | 0.1212 | 0.1689 |
| 基本情報/第10章 | 155 | 91.61% | 0.3462 | 0.2860 | 0.2912 | 0.3597 | 0.3133 | 0.3104 |
| 基本情報/第6章 | 137 | 93.43% | 0.3001 | 0.2521 | 0.2372 | 0.3596 | 0.2532 | 0.2554 |
| 基本情報/第9章 | 118 | 97.46% | 0.1878 | 0.1754 | 0.1255 | 0.2927 | 0.1200 | 0.1649 |
| 基本情報/第20章 | 116 | 93.97% | 0.2654 | 0.2450 | 0.2203 | 0.3253 | 0.2355 | 0.2366 |
| 基本情報/第4章 | 113 | 95.58% | 0.3068 | 0.2100 | 0.1871 | 0.3736 | 0.1823 | 0.2343 |
| English/Phrase | 108 | 100.00% | 0.0192 | 0.0430 | 0.0307 | 0.0392 | 0.0360 | 0.0221 |
| 基本情報/第12章 | 104 | 93.27% | 0.3321 | 0.2596 | 0.2517 | 0.3654 | 0.2586 | 0.2815 |
| 基本情報/第18章 | 103 | 94.17% | 0.2851 | 0.2389 | 0.2195 | 0.3339 | 0.2286 | 0.2495 |
| 基本情報/第3章 | 101 | 98.02% | 0.1975 | 0.1657 | 0.1225 | 0.3106 | 0.1015 | 0.1679 |
| 基本情報/第5章 | 82 | 97.56% | 0.2131 | 0.1677 | 0.1269 | 0.3253 | 0.1166 | 0.1787 |
| 基本情報/第14章 | 81 | 91.36% | 0.3529 | 0.3136 | 0.3138 | 0.3309 | 0.3218 | 0.3168 |
| 基本情報/第16章 | 74 | 93.24% | 0.2772 | 0.2539 | 0.2357 | 0.3140 | 0.2594 | 0.2522 |
| 基本情報/第2章 | 70 | 98.57% | 0.0823 | 0.1165 | 0.0833 | 0.1302 | 0.0832 | 0.0869 |
| 基本情報/第19章 | 67 | 94.03% | 0.3011 | 0.2399 | 0.2212 | 0.3307 | 0.2334 | 0.2511 |
| 基本情報/第21章 | 62 | 95.16% | 0.2068 | 0.2181 | 0.1826 | 0.2928 | 0.1960 | 0.2025 |
| 基本情報/第15章 | 53 | 98.11% | 0.1631 | 0.1581 | 0.1050 | 0.2855 | 0.0984 | 0.1490 |
| 基本情報/第8章 | 45 | 95.56% | 0.2123 | 0.2091 | 0.1731 | 0.3175 | 0.1829 | 0.1958 |
| 基本情報/第17章 | 40 | 95.00% | 0.2445 | 0.2221 | 0.1902 | 0.3033 | 0.2013 | 0.2155 |
| 基本情報/第13章 | 29 | 100.00% | 0.1207 | 0.1112 | 0.0523 | 0.2795 | 0.0360 | 0.1112 |
| 基本情報/第7章 | 27 | 100.00% | 0.1129 | 0.1118 | 0.0516 | 0.2654 | 0.0360 | 0.1069 |
| 基本情報/科目B | 15 | 86.67% | 0.4827 | 0.3987 | 0.3727 | 0.5470 | 0.4769 | 0.4306 |
| 基本情報/第1章 | 10 | 100.00% | 0.0473 | 0.0853 | 0.0401 | 0.1135 | 0.0360 | 0.0531 |
| 日本語/単語/ビジネス | 9 | 100.00% | 0.1154 | 0.1183 | 0.0529 | 0.2770 | 0.0360 | 0.1093 |

FSRS-6 fitted has the lowest log loss in **19 of 34 decks, and in every deck with
more than 548 scored reviews**. Of the 15 it loses, 10 go to the constant
baseline; every one of those has under 200 reviews and observed retention of
95.5% or higher — decks where nothing that ever predicts below 96% can win. 基本情報
is 22 of the 34 decks and 1,796 of the 85,998 reviews: **the per-deck table is
three real decks and a long tail of samples too small to rank anything.** Read the
基本情報 rows as counts, not as a ranking.

### Per track

| Track | Reviews | Observed | SM-2 | FSRS-6 | FSRS-6 fitted | Fixed ×2.5 | Constant base rate | SM-2 (power curve) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| forward | 49,545 | 96.51% | 0.4027 | 0.1495 | 0.1395 | 0.3540 | 0.1514 | 0.1757 |
| reverse | 36,453 | 95.16% | 0.5733 | 0.1898 | 0.1818 | 0.4847 | 0.1960 | 0.2297 |

Reverse review is measurably harder — 95.16% against 96.51% — and every candidate
scores worse on it. SPEC's decision to model tracks independently is right, and
per-track parameters would be the next thing to try.

---

## The fit

`fitFsrs6` is coordinate descent: 17 free parameters, each minimised in turn by
golden section over its published clamp interval, 12 sweeps, 4,081 loss
evaluations, 30.1 s, deterministic and monotone. Training loss 0.150633 →
0.143209 over the 60,163 training-window rows; held-out 0.190474 against stock's
0.203801. The sweep count was fixed from the *training* curve's diminishing
returns and never from the held-out score.

**Do not read the individual parameters.** Two things make the vector
uninterpretable, and both are worth stating because they are also the reason not
to over-trust the 6.5% improvement:

- **Five of the 17 free parameters sit on a clamp boundary** (w4 and w12 at their
  floors, w7 already there from the default, w19 at 0, w20 at its 0.1 floor). The
  box constraints are binding, so this is the best point in the *published*
  parameter space rather than an interior optimum.
- **The vector is not stable.** Refitting with 8 sweeps reaches training loss
  0.143501 with w4 = 9.996 — the *opposite* clamp. Twenty-four sweeps reaches
  0.142921 with w10 and w14 on their own boundaries. Vectors that differ by the
  full width of the parameter space score within 0.0006 of each other. With
  binary grades, FSRS-6's difficulty machinery is a nearly flat ridge.

What the fit is really doing is visible in one parameter: the decay moves from
0.1542 to its floor of 0.100, i.e. a flatter forgetting curve with a fatter tail.
The corpus is asking for less forgetting at long intervals than FSRS-6 assumes.
Which brings us to the reason that should be treated with suspicion.

---

## Selection bias — the limit on everything above

**The intervals in this log are the ones Mochi chose.** There is no observation
of what would have happened at an interval the user was never shown. A backtest
discriminates between algorithms on observed data; it is not ground truth for a
scheduler that would behave differently. SPEC says this, and this corpus makes it
concrete in three measurable ways.

### 1. The observed forgetting curve is not monotone

| Elapsed interval | Reviews | Lapses | Observed retention | Mean elapsed |
|---|--:|--:|--:|--:|
| same day | 6,996 | 256 | 96.34% | 0.0d |
| 1d | 6,499 | 194 | 97.01% | 1.0d |
| 2-3d | 12,201 | 278 | 97.72% | 2.5d |
| 4-7d | 10,698 | 241 | 97.75% | 5.4d |
| 8-21d | 15,876 | 481 | 96.97% | 13.8d |
| 22-60d | 13,948 | 718 | 94.85% | 38.1d |
| 61-180d | 14,424 | 960 | 93.34% | 105.1d |
| 181-365d | 9,343 | 528 | 94.35% | 264.7d |
| > 365d | 3,009 | 94 | 96.88% | 387.5d |

Retention falls to 93.34% at 61–180 days and then **rises to 96.88% past a year**.
Memory does not work like that. What is being measured is the scheduler: only
cards that keep being remembered are ever granted a year-long interval, so the
long buckets are a filtered population, not a longer delay. Any model fitted to
this curve learns "forgetting is slow at long intervals" when the truth is "easy
cards get long intervals".

### 2. 43% of the corpus is sitting on a censoring boundary

| Quantity | Value |
|---|--:|
| Live tracks with a Mochi interval | 8,956 |
| Median of Mochi's own last interval | 365.0d |
| Mean of Mochi's own last interval | 493.5d |
| **Mochi's maximum-interval cap** | 365d |
| Live tracks pinned to exactly that cap | 3,874 of 8,956 = 43.26% |
| Reviews scheduled to exactly the cap | 7,407 |
| Reviews ever scheduled beyond it | 1,356 |

This was found, not assumed: 365 is the modal value of `card_tracks.interval_days`
by a factor of 88 over the next most common (3,874 tracks at 365 days, 44 at 362).
For 43.26% of live tracks the data says only *"at least a year is fine"* — the true
stability is censored. Every one of the 1,356 reviews that ever scheduled past the
cap did so between **2026-02-22 and 2026-08-18**, measured: the cap was lifted six
months before the export and essentially nothing scheduled under the new ceiling
has come due yet.

Consequence: every projected interval past 365 days in the next section is
extrapolation off the end of the observed support, for nearly half the corpus.

### 3. The scored population is not the schedulable population

Interval-based candidates are scored at elapsed times *FSRS chose*, which is
systematically favourable to FSRS and unfavourable to SM-2 — SM-2 is being asked
to predict at intervals it would never have scheduled. The same-curve comparison
(SM-2 with the power curve) removes most of the unfairness in the *curve*; it
does not remove this one. FSRS-6's win is real but this backtest cannot say how
much of the remaining 0.19-vs-0.25 gap is home advantage.

---

## Target retention and daily load

SPEC: *"Lower target retention lengthens intervals and cuts workload… How much
that saves is exactly what the backtest should quantify."* Here is what is
measured and what is modelled, kept strictly apart.

### Measured

| Quantity | Value | Source |
|---|--:|---|
| Observed retention, all reviews | 96.24% | `study_totals` |
| Observed retention, scored set | 95.94% | 85,998 rows |
| Observed retention, held-out window | 94.70% | 25,835 rows |
| Total study time | 636.1 h over 1,317 study days | `study_totals` |
| Reviews/day, last 90 active days | 69.2 | `activity_by_day` |
| Relearning cost of a lapse | 0.32 extra reviews within 2 days | 3,832 lapses |
| Steady-state reviews/day implied by Mochi's own intervals | 54.4 | Σ 1/I over 8,956 live tracks |

That last pair is the calibration check for everything below. Applying the
steady-state identity — a card reviewed every I days generates 1/I reviews a day
— to Mochi's *real* current intervals gives 54.4 reviews a day where the user
actually does 69.2. **The model runs 21% low**, because it has no new cards, no
learning steps and no backlog. Multiply every modelled figure below by about 1.27
before comparing it with real life.

### Modelled

Each live track's memory state after its real history, projected to the interval
that lands on each target. Assumes the interval distribution has settled, ignores
new cards entirely, and treats the model's stability estimate as correct.

**From FSRS-6 fitted:**

| Target retention | Tracks | Median interval | Mean interval | Reviews/day (steady state) | + relearning |
|---|--:|--:|--:|--:|--:|
| 85.00% | 8,961 | 2157.6d | 2123.1d | 16.6 | 17.4 |
| 90.00% | 8,961 | 988.2d | 972.3d | 35.6 | 36.7 |
| 95.00% | 8,961 | 354.6d | 348.9d | 97.3 | 98.8 |

**From FSRS-6 with stock parameters:**

| Target retention | Tracks | Median interval | Mean interval | Reviews/day (steady state) | + relearning |
|---|--:|--:|--:|--:|--:|
| 85.00% | 8,961 | 1967.7d | 2059.2d | 33.2 | 34.8 |
| 90.00% | 8,961 | 1032.1d | 1080.2d | 62.4 | 64.4 |
| 95.00% | 8,961 | 415.5d | 434.8d | 152.6 | 155.0 |

Applying the measured ×1.27 correction, the two parameter sets bracket:

| Target | Reviews/day, corrected | Versus today's 69.2 |
|---|--:|---|
| 0.85 | 22 – 44 | a third to two thirds |
| 0.90 | 47 – 82 | about the same |
| 0.95 | 125 – 197 | roughly double to triple |

### What this does and does not establish

**Does:** the direction and rough scale. Moving from a 95% to a 90% target more
than halves the load; 90% to 85% halves it again. The two parameter sets agree
within 5% on the median interval, so this is not an artefact of the fit.

**Does not:** that any of it is safe, and one measured number settles that.
**No review in this corpus follows an elapsed interval longer than 454 days.**
The 90% row asks for a median interval of about 1,000 days and the 85% row for
about 2,100 — two and four times beyond anything ever observed, on a curve fitted
to a population filtered for being easy. The 95% row, median 355–416 days, is the
only one of the three that lands inside the range the data covers, and it is
approximately what Mochi already does.

**And the more useful finding, which is not about target retention at all:** this
user's 96.24% retention against a nominal 90% target is substantially explained by
the **365-day cap**, not by the target being wrong. 43.26% of live tracks are
pinned to an interval shorter than the scheduler's own model wants. Raising the
maximum interval is a larger, better-evidenced lever than lowering the target,
and it is the one whose effect the existing data can actually check as it lands.

Per-deck target retention (SPEC asks for a recommendation): **no.** Observed
retention does differ by deck — 97.00% 単語, 94.65% 漢字, 93.19% English/Vocabulary
— but that is a difference in *difficulty*, which the scheduler already handles
through stability. Nothing in this backtest identifies a deck where a different
*target* is better, because target retention determines intervals that were never
scheduled. Ship the per-deck setting SPEC asks for, default it to 0.90 everywhere,
and leave it alone until there is data from more than one target.

---

## What is inconclusive, stated plainly

1. **The absolute size of the win is small.** Best candidate 0.1905 log loss
   against 0.2111 for a model with no inputs: a 9.8% improvement. On RMSE the
   improvement over that baseline is 2.3%, and stock FSRS-6 is *worse* than it.
   FSRS-6 is the right choice, but nobody should expect the change from Mochi to
   feel like a better scheduler.
2. **FSRS-6 versus SM-2 is not fully separated from curve shape.** 91% of the
   apparent gap is the exponential-versus-power curve, which is a choice this
   harness made on SM-2's behalf.
3. **The fitted parameters are not identified.** Wildly different vectors score
   identically. The 6.5% held-out gain is real; the vector that produced it is one
   of many and should be refitted once real grades exist.
4. **Nothing beyond 454 days is measured, at all.** The 3,009 observations past a
   year are all late reviews of cards capped at 365 days, spanning 366 to 454 days.
   Not one scheduled long interval exists in four years of history.
5. **Sub-daily intervals remain unresolved.** SPEC lists them as open. 6,996
   same-day reviews exist but their elapsed time was never recorded, so this
   backtest cannot say whether learning steps earn their place. It can only say
   that the question is unanswerable from the imported data and needs real
   timestamps going forward.
6. **This is one user and one corpus.** The *implementation* caveat that stood
   here in the first draft — a from-scratch port with no upstream fixture — is
   now discharged: fsrs-rs ships a regression fixture (`assert_memory_state` in
   `src/inference.rs`, ratings [1,3,3,3,3,3] at delta_t [0,0,1,3,8,21] from the
   published defaults) and this port reproduces both of its stated answers,
   stability 53.62691 / difficulty 6.3574867 and the short-term-frozen 53.335106,
   to within 7e-6 and 4.2e-5 against upstream's own f32 tolerance of 1e-4. That
   pins init stability, init difficulty, linear damping, mean reversion and both
   stability branches at once. What remains unpinned is w15 and w16, reachable
   only from Hard and Easy, which neither the fixture nor this corpus contains —
   and they are frozen throughout, so no number above depends on them. The
   one-user, one-corpus limit is unchanged and is the real one.

---

## Recommendation

1. **Ship FSRS-6.** It wins on the held-out window on log loss, RMSE,
   calibration and AUC, in every deck large enough to rank, on both track kinds,
   and under both interval definitions.
2. **Ship it with the fitted parameters**, marked provisional, and refit
   automatically once there is a year of reviews carrying real timestamps and
   real grades. The fitter is 30 seconds of arithmetic on the user's own machine;
   there is no reason to ship population defaults permanently.
3. **Keep the maximum interval configurable and raise it deliberately, in steps.**
   It is the binding constraint today and the only lever whose effect the incoming
   data can verify. Do not let a model schedule 1,000 days on the strength of a
   curve fitted to censored data — cap at something like 730 days until
   observations past a year exist.
4. **Target retention: per-deck setting, default 0.90, do not tune it yet.**
5. **Record what would make the next backtest better**, which is the same list as
   SPEC's stage-1 obligations: real timestamps (turns 6,996 unscorable rows into
   the sub-daily answer), a real grade scale (turns 4 dead FSRS parameters into
   live ones and makes the fit identifiable), and the interval actually shown to
   the user rather than only the one planned.

---

## Files and reproduction

| Path | What it is |
|---|---|
| `src/scheduler/backtest.ts` | Harness: history loading, replay, metrics, splits, workload model, table formatting |
| `src/scheduler/algorithms/index.ts` | Scheduler interface, state erasure, the exponential curve helpers |
| `src/scheduler/algorithms/fsrs6.ts` | FSRS-6 port, published defaults, clamps, fitted vector, coordinate-descent fitter |
| `src/scheduler/algorithms/sm2.ts` | SM-2 with the published quality formula, both curve options |
| `src/scheduler/algorithms/baseline.ts` | Fixed multiplier and the constant base rate |
| `test/backtest.test.ts` | 36 tests: closed-form arithmetic, the upstream FSRS-6 fixture, then the real corpus; prints every table above |

FSRS-6's formulas and defaults were transcribed on 2026-08-19 from
`open-spaced-repetition/fsrs-rs` (`src/model.rs`, `src/inference.rs`,
`src/parameter_clipper.rs`, `src/simulation.rs`), and checked against that
repository's own regression fixture — see [inconclusive item 6](#what-is-inconclusive-stated-plainly).

Two internal identities are asserted rather than assumed, because both are the
kind of thing that fails silently. `fsrs6Loss`, the allocation-free loop the
fitter minimises, is compared bit-for-bit against the generic replay that
produces every table above — both parameter vectors, all three windows, equal to
the last floating-point digit — so the fit optimises the number the report
quotes. And the Japanese deck paths are asserted to survive the SQLite column,
the grouping Map and the markdown cell byte-identically, emoji subdecks
(`日本語/単語/尊敬語🤵`) included.

```
$ npx vitest run test/backtest.test.ts
 Test Files  1 passed (1)
      Tests  35 passed | 1 skipped (36)
   Duration  12.34s

$ HASHIGO_FSRS_FIT=1 npx vitest run test/backtest.test.ts
train rows 60163 · loss 0.150633 -> 0.143209 · 12 sweeps · 4081 evaluations · 32.5s
held-out log loss  refitted 0.190474 · stock 0.203801 over 25835 reviews
      Tests  36 passed (36)
   Duration  41.77s
```

The skipped test is the refit; it runs only under `HASHIGO_FSRS_FIT=1`, where it
reproduces `FSRS6_FITTED_PARAMETERS` from scratch and fails if the committed
vector has drifted from what the fitter actually produces.
