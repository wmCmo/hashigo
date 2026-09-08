# Scheduler backtest — which scheduler should Hashigo ship?

Stage 5. SPEC.html deliberately does not assume FSRS: *"Ship the scheduler that wins on
your data."* This is that measurement, run over all 103,110 imported reviews.

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
   An earlier draft of this line said the binding constraint was Mochi's
   365-day cap. **That was stale and it is corrected below**: the cap was
   *lifted* on **2026-02-22**, 1,386 reviews have planned beyond a year since,
   and the longest plan in the corpus is 2,707 days falling due in 2033. What is
   actually true is narrower — **3,306 of the 3,417 live tracks sitting on
   exactly 365 days were last reviewed BEFORE the lift**, so they are parked on
   a stale plan rather than held down by a live ceiling. The limit on what this
   backtest can conclude comes from the *observed* side and is unchanged: no gap
   longer than **454 days** has ever actually elapsed.

### One number, and both artefacts now agree on it

`dashboard.html` used to render `> 365d 観測なし` while this document reported
thousands of observations past a year. Neither was wrong; neither named its
basis. The dashboard bucketed by the interval Mochi **planned**, this backtest
scores the time that actually **elapsed**, and the two disagree completely in
exactly that bucket. Both now use the schema's own column names —
`reviews.elapsed_days` and `reviews.scheduled_days` — and report:

| Basis | `> 365d` reviews | Retention |
|---|--:|--:|
| **elapsed** (measured, what this backtest scores) | **3,217** | **96.89%** |
| **scheduled** (planned, what the dashboard used to plot) | 0 | — |

The zero is a censoring artefact, not a fact about memory: `scheduled_days` is
the *preceding* review's plan, so a plan only appears there once the review it
scheduled has been taken, and not one of the 1,386 post-lift plans is due before
2027-03-17.

Two counts of that bucket appear in this document and they are not in conflict:
**3,217** is the whole corpus, **3,134** is the held-out window (`local_date >=
2024-12-29`) that the per-candidate tables are scored over. 3,217 − 3,134 = 83
reviews, all before the cutoff. `test/dashboard.test.ts` asserts that the
`> 365d` figure in `dashboard.html` and the one in this file are the same
number, and that no count in this file exceeds the whole-corpus one.

---

## What was replayed

| Quantity | Value |
|---|--:|
| Reviews imported | 103,110 |
| Tracks with history | 9,085 |
| First reviews (never scored) | 9,085 |
| Reviews with a predecessor | 94,025 |
| Same-day (elapsed 0, scored separately) | 7,050 of which 256 lapses |
| Scored set | 86,975 at 95.93% observed retention |
| No `scheduled_days` in the export | 8,988 |
| Training window | 2022-06-28 to 2024-12-29 — 60,163 reviews |
| Held-out window | 2024-12-29 to 2026-08-18 — 25,835 reviews |
| Training-window base rate | 96.43% |
| Decks with history | 34 |

### Four scoring decisions, and why

**Elapsed, not scheduled — and both are named columns now.**
`reviews.scheduled_days` is what the scheduler *intended*; `reviews.elapsed_days`
is the gap between consecutive review dates, which is what actually happened.
There used to be one column called `interval_days` that the importer wrote as
planned, this backtest read as elapsed and the dashboard bucketed as planned;
that name no longer exists in the schema, so a query that assumes the wrong one
now fails instead of returning a plausible wrong number. Of the 84,060 reviews where both are known, 61,594 agree to within
1.5 days, **22,226 were taken more than 1.5 days late** and 240 early. Forgetting
depends on time that passed, so elapsed is the independent variable. It also
covers 8,988 rows that `scheduled_days` leaves NULL, and — the part that matters
for the caveats below — under the elapsed definition the corpus contains **3,217
observations at intervals over a year**, where the scheduled basis contains
exactly zero. The whole comparison was re-run under the scheduled basis as a
sensitivity check; the ranking does not change.

The bucket boundaries are the same ones `review_log_bucketed` applies in
`views.sql`, as inclusive ceilings (`<= 365` is `180-365d`, anything more is
`> 365d`), so this table and the dashboard's are provably the same partition
rather than two that happen to agree. This table splits `same day` from `1d`
where the view merges them into `<= 1d`; that is the only difference, and
decision 3 below is why it exists.

**A track's first review is never scored.** It creates the memory rather than
testing it. 9,085 of 103,110.

**Same-day reviews are scored separately.** Every timestamp in the corpus is
date-only, so "same day" means an elapsed time of somewhere between a minute and
23 hours, recorded as 0. Scoring a forgetting curve against an unknown elapsed
time measures the harness. All 7,050 still update state — they happened — and get
their own table below.

**Grades are binary, BY DESIGN — this is a decision, not a data limitation.**
Anki's four-button Again/Hard/Good/Easy was considered and **rejected**. There is
no `grade` column in the schema and there never will be; `remembered` maps to
Good (3) and forgotten to Again (1), and ratings 2 and 4 cannot occur in this
corpus or in any future one. Four of FSRS-6's 21 parameters (w1, w3, **w15**,
**w16**) are reachable only through Hard or Easy and are therefore **unreachable
by design**, frozen permanently at their published values rather than fitted. No
number in this document depends on them, and no amount of additional history
will ever inform them — nothing here is waiting for data.

The upside is worth stating rather than filing this under caveats: **the
scheduler is fitted on exactly the signal it receives in production**, so there
is no train/serve distribution shift. A model fitted on four-button history and
then fed binary grades would have one.

---

## The result

### Held-out window (2024-12-29 onward) — the one table where all candidates are comparable

| Candidate | Reviews | Log loss | RMSE | Calib. RMSE | AUC | Mean predicted | Observed |
|---|--:|--:|--:|--:|--:|--:|--:|
| FSRS-6 fitted | 26,140 | 0.1893 | 0.2186 | 0.0318 | 0.726 | 93.14% | 94.76% |
| FSRS-6 | 26,140 | 0.2030 | 0.2250 | 0.0604 | 0.697 | 90.64% | 94.76% |
| Constant base rate | 26,140 | 0.2091 | 0.2235 | 0.0167 | 0.500 | 96.43% | 94.76% |
| SM-2 (power curve) | 26,140 | 0.2496 | 0.2479 | 0.1189 | 0.686 | 89.11% | 94.76% |
| Fixed ×2.5 | 26,140 | 0.7745 | 0.3643 | 0.2925 | 0.681 | 80.21% | 94.76% |
| SM-2 | 26,140 | 0.8812 | 0.3644 | 0.2923 | 0.686 | 81.56% | 94.76% |

### Whole scored set — all 86,975

| Candidate | Reviews | Log loss | RMSE | Calib. RMSE | AUC | Mean predicted | Observed |
|---|--:|--:|--:|--:|--:|--:|--:|
| FSRS-6 fitted *(in-sample)* | 86,975 | 0.1578 | 0.1948 | 0.0194 | 0.717 | 95.39% | 95.93% |
| FSRS-6 | 86,975 | 0.1670 | 0.1990 | 0.0428 | 0.681 | 93.34% | 95.93% |
| Constant base rate | 86,975 | 0.1705 | 0.1977 | 0.0050 | 0.500 | 96.43% | 95.93% |
| SM-2 (power curve) | 86,975 | 0.1996 | 0.2134 | 0.0866 | 0.634 | 93.43% | 95.93% |
| Fixed ×2.5 | 86,975 | 0.4120 | 0.2842 | 0.2069 | 0.615 | 88.84% | 95.93% |
| SM-2 | 86,975 | 0.4779 | 0.2911 | 0.2161 | 0.634 | 89.39% | 95.93% |

*The fitted arm is marked in-sample here because 70% of these rows trained it.
Only the held-out table is a fair comparison for it.*

**The two mandated metrics do not agree, and the disagreement is the finding.**
On log loss, stock FSRS-6 (0.2038) beats the constant baseline (0.2111). On RMSE
it *loses* to it (0.2258 against 0.2246). Only the fitted arm wins on both. On a
corpus where 96% of reviews are passes, "always predict 96.43%" is a genuinely
strong prediction, and squared error barely distinguishes it from a real model.
Log loss does, because it punishes confident mistakes — which is exactly what a
scheduler makes when it schedules.

The AUC column is why the ranking is a statement about *calibration* rather than
about knowledge: every real candidate, SM-2 included, orders outcomes far better
than chance (0.68–0.73 against the baseline's exact 0.500). They all know
something. Only FSRS turns it into a well-calibrated number.

### Same-day reviews, elapsed unknown — the excluded 7,050

| Candidate | Reviews | Log loss | RMSE | Calib. RMSE | AUC | Mean predicted | Observed |
|---|--:|--:|--:|--:|--:|--:|--:|
| Constant base rate | 7,050 | 0.1560 | 0.1871 | 0.0006 | 0.500 | 96.43% | 96.37% |
| SM-2 | 7,050 | 0.5017 | 0.1906 | 0.0363 | 0.500 | 100.00% | 96.37% |
| FSRS-6 | 7,050 | 0.5017 | 0.1906 | 0.0363 | 0.500 | 100.00% | 96.37% |
| FSRS-6 fitted *(in-sample)* | 7,050 | 0.5017 | 0.1906 | 0.0363 | 0.500 | 100.00% | 96.37% |
| Fixed ×2.5 | 7,050 | 0.5017 | 0.1906 | 0.0363 | 0.500 | 100.00% | 96.37% |
| SM-2 (power curve) | 7,050 | 0.5017 | 0.1906 | 0.0363 | 0.500 | 100.00% | 96.37% |

Every interval-based model predicts exactly 1.0 at t = 0 and is then charged for
256 failures it called impossible. All five score identically, to four decimals,
because on these rows they are the same degenerate model. Including them would
have added a constant to five candidates and left the ranking unchanged while
making every number meaningless. This is the strongest single argument in the
whole exercise for SPEC's insistence that real timestamps land in stage 1.

### Sensitivity: the `scheduled` basis instead of `elapsed`

| Candidate | Reviews | Log loss | RMSE | Calib. RMSE | AUC | Mean predicted | Observed |
|---|--:|--:|--:|--:|--:|--:|--:|
| FSRS-6 fitted *(in-sample)* | 85,037 | 0.1571 | 0.1944 | 0.0142 | 0.720 | 95.61% | 95.89% |
| FSRS-6 | 85,037 | 0.1648 | 0.1978 | 0.0358 | 0.696 | 93.64% | 95.89% |
| Constant base rate | 85,037 | 0.1719 | 0.1987 | 0.0055 | 0.500 | 96.43% | 95.89% |
| SM-2 (power curve) | 85,037 | 0.1981 | 0.2117 | 0.0809 | 0.633 | 94.09% | 95.89% |
| Fixed ×2.5 | 85,037 | 0.3629 | 0.2753 | 0.1941 | 0.613 | 90.06% | 95.89% |
| SM-2 | 85,037 | 0.4340 | 0.2847 | 0.2069 | 0.633 | 90.39% | 95.89% |

Same order, slightly lower losses, 1,938 fewer rows. The interval basis was an
open question left over from stage 1. It is now closed twice over: the schema
carries `elapsed_days` and `scheduled_days` as separate named columns, and every
consumer states which it used. Scoring is on `elapsed`, and the choice does not
change the ranking — only the `> 365d` bucket, where it is the difference between
3,217 observations and none.

---

## Where the difference actually comes from

### Loss concentration, held-out window

| Candidate | Rows predicted < 50% | Observed on those rows | Share of total loss | Worst 1% share | p01 predicted | Median predicted |
|---|--:|--:|--:|--:|--:|--:|
| SM-2 | 3,758 | 83.95% | 79.72% | 15.65% | 0.00% | 96.96% |
| Fixed ×2.5 | 3,632 | 83.51% | 75.89% | 17.81% | 0.00% | 95.39% |
| SM-2 (power curve) | 1,054 | 82.26% | 12.09% | 25.53% | 44.48% | 96.18% |
| FSRS-6 | 131 | 83.21% | 1.86% | 15.78% | 55.22% | 94.56% |
| FSRS-6 fitted | 15 | 100.00% | 0.21% | 17.12% | 64.71% | 95.00% |
| Constant base rate | 0 | — | 0.00% | 15.92% | 96.43% | 96.43% |

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
| 1d | 912 | 97.81% | 0.1150 | 0.1319 | 0.1117 | 0.1242 | 0.1086 | 0.1168 |
| 2-3d | 2,109 | 99.10% | 0.1096 | 0.1151 | 0.0676 | 0.1343 | 0.0660 | 0.0990 |
| 4-7d | 1,917 | 97.86% | 0.2175 | 0.1398 | 0.1073 | 0.2165 | 0.1068 | 0.1549 |
| 8-21d | 3,412 | 97.07% | 0.2418 | 0.1523 | 0.1269 | 0.2582 | 0.1330 | 0.1692 |
| 22-60d | 2,499 | 91.12% | 0.9553 | 0.2570 | 0.2465 | 0.8769 | 0.3292 | 0.2930 |
| 61-180d | 5,182 | 91.10% | 2.0732 | 0.2973 | 0.2908 | 1.8441 | 0.3296 | 0.3564 |
| 181-365d | 7,005 | 94.13% | 1.0174 | 0.2158 | 0.2123 | 0.8413 | 0.2298 | 0.2969 |
| > 365d | 3,104 | 96.91% | 0.3861 | 0.1481 | 0.1464 | 0.2938 | 0.1383 | 0.2180 |

FSRS earns its win in one place: the 22–180 day band, 7,931 reviews where
retention genuinely dips to ~91% and the exponential models fall apart. Under 21
days and over a year, the constant baseline is as good as anything — including
better than everything at > 365d, where it is the *best* candidate in the table.

### Mean predicted recall by elapsed interval, held-out window

| Elapsed | Reviews | Observed | SM-2 | FSRS-6 | FSRS-6 fitted | Fixed ×2.5 | Constant base rate | SM-2 (power curve) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 1d | 912 | 97.81% | 94.38% | 92.74% | 95.42% | 93.12% | 96.43% | 94.08% |
| 2-3d | 2,109 | 99.10% | 91.80% | 90.80% | 95.85% | 89.02% | 96.43% | 92.59% |
| 4-7d | 1,917 | 97.86% | 84.58% | 90.89% | 94.85% | 83.73% | 96.43% | 89.33% |
| 8-21d | 3,412 | 97.07% | 85.19% | 91.30% | 95.14% | 81.54% | 96.43% | 89.35% |
| 22-60d | 2,499 | 91.12% | 67.40% | 86.94% | 90.82% | 65.48% | 96.43% | 82.06% |
| 61-180d | 5,182 | 91.10% | 69.06% | 87.18% | 90.26% | 63.91% | 96.43% | 82.88% |
| 181-365d | 7,005 | 94.13% | 84.33% | 92.27% | 93.16% | 85.27% | 96.43% | 91.61% |
| > 365d | 3,104 | 96.91% | 91.03% | 94.10% | 94.03% | 94.43% | 96.43% | 95.28% |

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
| 日本語/単語 | 45,491 | 96.99% | 0.3933 | 0.1375 | 0.1273 | 0.3419 | 0.1355 | 0.1590 |
| 日本語/漢字 | 23,610 | 94.65% | 0.6069 | 0.2064 | 0.2005 | 0.5074 | 0.2128 | 0.2580 |
| English/Vocabulary | 10,025 | 93.18% | 0.7149 | 0.2316 | 0.2235 | 0.6071 | 0.2613 | 0.2927 |
| 日本語/部首 | 2,228 | 97.80% | 0.1869 | 0.1124 | 0.1076 | 0.1555 | 0.1088 | 0.1105 |
| 日本語/言葉 | 1,600 | 98.25% | 0.2785 | 0.1034 | 0.0872 | 0.2703 | 0.0940 | 0.1039 |
| 日本語/文法 | 561 | 95.54% | 0.7246 | 0.1877 | 0.1578 | 0.8513 | 0.1833 | 0.2112 |
| 日本語/数字 | 548 | 100.00% | 0.0102 | 0.0373 | 0.0216 | 0.0244 | 0.0363 | 0.0134 |
| 日本語/言葉/オノマトペ | 363 | 95.87% | 0.6132 | 0.1646 | 0.1552 | 0.5128 | 0.1726 | 0.1887 |
| 日本語/単語/尊敬語🤵 | 318 | 96.54% | 0.4673 | 0.1345 | 0.1285 | 0.3714 | 0.1504 | 0.1628 |
| 日本語/単語/謙譲語🙇 | 284 | 97.54% | 0.2204 | 0.1116 | 0.0994 | 0.1812 | 0.1176 | 0.1200 |
| 基本情報/第11章 | 197 | 97.46% | 0.1947 | 0.1631 | 0.1226 | 0.3009 | 0.1200 | 0.1698 |
| 基本情報/第10章 | 158 | 91.77% | 0.3486 | 0.2828 | 0.2873 | 0.3583 | 0.3076 | 0.3091 |
| 基本情報/第6章 | 141 | 93.62% | 0.2986 | 0.2481 | 0.2325 | 0.3570 | 0.2468 | 0.2527 |
| 基本情報/第20章 | 119 | 94.12% | 0.2659 | 0.2420 | 0.2165 | 0.3211 | 0.2303 | 0.2353 |
| 基本情報/第9章 | 119 | 97.48% | 0.1878 | 0.1749 | 0.1250 | 0.2939 | 0.1194 | 0.1648 |
| 基本情報/第4章 | 115 | 95.65% | 0.3074 | 0.2082 | 0.1852 | 0.3764 | 0.1797 | 0.2340 |
| English/Phrase | 108 | 100.00% | 0.0192 | 0.0430 | 0.0307 | 0.0392 | 0.0363 | 0.0221 |
| 基本情報/第12章 | 107 | 92.52% | 0.3386 | 0.2751 | 0.2701 | 0.3680 | 0.2828 | 0.2919 |
| 基本情報/第18章 | 104 | 94.23% | 0.2837 | 0.2375 | 0.2180 | 0.3314 | 0.2265 | 0.2483 |
| 基本情報/第3章 | 102 | 98.04% | 0.1971 | 0.1651 | 0.1221 | 0.3112 | 0.1010 | 0.1676 |
| 基本情報/第5章 | 83 | 97.59% | 0.2148 | 0.1670 | 0.1263 | 0.3318 | 0.1158 | 0.1793 |
| 基本情報/第14章 | 82 | 91.46% | 0.3495 | 0.3111 | 0.3107 | 0.3272 | 0.3178 | 0.3139 |
| 基本情報/第16章 | 75 | 93.33% | 0.2783 | 0.2522 | 0.2336 | 0.3139 | 0.2561 | 0.2519 |
| 基本情報/第2章 | 71 | 98.59% | 0.0821 | 0.1164 | 0.0831 | 0.1287 | 0.0828 | 0.0868 |
| 基本情報/第19章 | 68 | 94.12% | 0.3000 | 0.2379 | 0.2190 | 0.3283 | 0.2303 | 0.2500 |
| 基本情報/第21章 | 64 | 93.75% | 0.2267 | 0.2485 | 0.2191 | 0.3182 | 0.2424 | 0.2264 |
| 基本情報/第15章 | 54 | 98.15% | 0.1661 | 0.1571 | 0.1044 | 0.2852 | 0.0974 | 0.1502 |
| 基本情報/第8章 | 46 | 95.65% | 0.2237 | 0.2072 | 0.1709 | 0.3170 | 0.1797 | 0.1984 |
| 基本情報/第17章 | 44 | 95.45% | 0.2485 | 0.2115 | 0.1791 | 0.3156 | 0.1862 | 0.2138 |
| 基本情報/第13章 | 27 | 100.00% | 0.1235 | 0.1104 | 0.0527 | 0.2856 | 0.0363 | 0.1130 |
| 基本情報/第7章 | 27 | 100.00% | 0.1129 | 0.1118 | 0.0516 | 0.2654 | 0.0363 | 0.1069 |
| 基本情報/科目B | 17 | 88.24% | 0.4432 | 0.3637 | 0.3358 | 0.5152 | 0.4242 | 0.3953 |
| 基本情報/第1章 | 10 | 100.00% | 0.0473 | 0.0853 | 0.0401 | 0.1135 | 0.0363 | 0.0531 |
| 日本語/単語/ビジネス | 9 | 100.00% | 0.1154 | 0.1183 | 0.0529 | 0.2770 | 0.0363 | 0.1093 |

FSRS-6 fitted has the lowest log loss in **20 of 34 decks, and in every deck with
more than 548 scored reviews**. Of the 14 it loses, 10 go to the constant
baseline; every one of those has under 200 reviews and observed retention of
95.5% or higher — decks where nothing that ever predicts below 96% can win. 基本情報
is 22 of the 34 decks and 1,830 of the 86,975 reviews: **the per-deck table is
three real decks and a long tail of samples too small to rank anything.** Read the
基本情報 rows as counts, not as a ranking.

### Per track

| Track | Reviews | Observed | SM-2 | FSRS-6 | FSRS-6 fitted | Fixed ×2.5 | Constant base rate | SM-2 (power curve) |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| forward | 50,041 | 96.51% | 0.4047 | 0.1497 | 0.1396 | 0.3558 | 0.1514 | 0.1763 |
| reverse | 36,934 | 95.14% | 0.5770 | 0.1906 | 0.1825 | 0.4882 | 0.1965 | 0.2310 |

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
| same day | 7,050 | 256 | 96.37% | 0.0d |
| 1d | 6,509 | 195 | 97.00% | 1.0d |
| 2-3d | 12,235 | 280 | 97.71% | 2.5d |
| 4-7d | 10,765 | 243 | 97.74% | 5.4d |
| 8-21d | 15,978 | 483 | 96.98% | 13.8d |
| 22-60d | 14,078 | 721 | 94.88% | 38.1d |
| 61-180d | 14,505 | 966 | 93.34% | 105.0d |
| 181-365d | 9,688 | 552 | 94.30% | 268.0d |
| > 365d | 3,217 | 100 | 96.89% | 386.2d |

Retention falls to 93.34% at 61–180 days and then **rises to 96.89% past a year**.
Memory does not work like that. What is being measured is the scheduler: only
cards that keep being remembered are ever granted a year-long interval, so the
long buckets are a filtered population, not a longer delay. Any model fitted to
this curve learns "forgetting is slow at long intervals" when the truth is "easy
cards get long intervals".

### 2. 38% of the corpus is parked on a cap that no longer applies

| Quantity | Value |
|---|--:|
| Live tracks with a Mochi plan | 9,010 |
| Median of Mochi's own last plan | 365.0d |
| Mean of Mochi's own last plan | 493.5d |
| Mochi's maximum-interval cap, while it applied | 365d |
| **The date it was lifted** | **2026-02-22** |
| Live tracks whose plan is exactly 365d | 3,417 of 9,010 = 37.92% |
| …of which last reviewed BEFORE the lift (**stale**) | **3,306** |
| …of which re-scheduled to 365d since the lift | 111 |
| Reviews scheduled to exactly 365d | 7,440 |
| Reviews ever scheduled beyond it | 1,386 |
| Longest interval ever planned | **2,707d**, due 2033-10-17 |
| **Longest interval ever actually elapsed** | **454d** |
| …of those 3,217 over-a-year gaps, how many came from a plan **over** 365d | **0** |

This was found, not assumed: 365 is the modal value of `card_tracks.scheduled_days`
by a factor of 88 over the next most common (3,417 tracks at 365 days, 44 at 362).

**THE 454 IS CENSORED, AND THE NEW ROW ABOVE IS WHY** (measured 2026-08-22,
`scripts/cap-derive.ts`). Every one of the 3,217 gaps past a year came from a plan of
<= 365 days; not one came from a longer plan. So 454 days is Mochi's cap plus this
user's lateness, and it is **not** an observation about memory at 454 days. Wherever
this document or `policy.ts` treated 454 as the edge of observed support, the honest
edge on the PLANNED basis is **365** — name the basis (decision 6) or the boundary is
wrong. `notes/max-interval-and-relearning.md` carries the consequence for the cap.

**But the cap is not operating any more, and an earlier draft of this section
implied it was.** Measured on local (JST) dates: not one review planned beyond
365 days before 2026-02-22, and 1,386 have since, ranging up to 2,707 days and
falling due between 2027-03-17 and 2033-10-17. (Bucket those same rows by UTC
and the lift reads 2026-02-21 — every timestamp carries `+09:00`, so `date()`
normalises a day early. The rest of this project counts local dates, so
2026-02-22 is the one to quote.)

So the honest version of the censoring claim is narrower and more specific:
**3,306 live tracks are sitting on a 365-day plan chosen by the old, capped
scheduler and have not been reviewed since it was lifted.** For those the data
still says only *"at least a year is fine"* and the true stability is censored.
The other 111 tracks at 365 days were scheduled there after the lift, by a
scheduler free to choose more — for them 365 is a measurement, not a ceiling.

Consequence, and it is unchanged by the lift because it comes from the observed
side rather than the planned one: **no gap longer than 454 days has ever
elapsed**, whatever Mochi has been planning since February. **But do not read 454
as the point where extrapolation starts** — an earlier draft of this sentence did,
and that is the basis error above: on the PLANNED basis, which is the one a cap
constrains, the support ends at **365**, so anything past 365 is already
extrapolation and 454 is not a boundary about memory at all. Hashigo's own
maximum interval is set to 365 days (see [Recommendation](#recommendation)) — but
note that this does NOT mean every issued interval sits at or under it: interval fuzz
is applied after the cap, so the issued maximum is **383 days**.

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

| Quantity | Value |
|---|--:|
| Live tracks with a Mochi interval | 9,010 |
| Median of Mochi's own last interval | 365.0d |
| Mean of Mochi's own last interval | 490.1d |
| Steady-state reviews/day implied by Mochi's intervals | 55.5 |
| Reviews/day actually done, last 90 active days | 68.5 |
| Measured relearning cost | 0.32 extra reviews per lapse |
| **Mochi's maximum-interval cap** | 365d |
| Live tracks pinned to exactly that cap | 3,417 of 9,010 = 37.92% |
| Reviews scheduled to exactly the cap | 7,440 |
| Reviews ever scheduled beyond it | 1,386 |

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
user's 96.24% realised retention is substantially explained by the intervals he
was actually given, not by the target setting being wrong. 3,306 live tracks are
still sitting on the old 365-day plan, shorter than the scheduler's own model
wants for them. Working through that backlog is a larger, better-evidenced lever
than moving the target, and it is the one whose effect the incoming data can
check as it lands.

**SUPERSEDED 2026-08-20 — the target is 0.90, not 0.95.** When this was written the
settled target was 0.95, and the argument below was that 0.95 is the only row landing
inside the observed range (median 355–416 days against a 454-day ceiling on anything ever
observed — but see "THE 454 IS CENSORED" above: that ceiling is Mochi's own 365-day cap
plus this user's lateness, so on the PLANNED basis the edge is 365 and this parenthesis
overstates the support it claims
observed). That reasoning was sound but incomplete: it ignored the interaction with
`MAX_INTERVAL_DAYS`. Measured under the 365-day cap that actually ships
(`scripts/capped-load.ts`), 0.95 asks for **130–204 reviews/day against a realised 69.2**,
while 0.90 asks for 62–97 — and the cap keeps 0.90's median interval at 365 days, i.e.
inside the observed range after all. So the extrapolation risk this paragraph worried
about is removed by the cap, and 0.95's real cost is a doubling of daily load. See
`src/scheduler/policy.ts`, which documents that the two constants are not independent.

Per-deck target retention (SPEC asks for a recommendation): **no.** Observed
retention does differ by deck — 97.00% 単語, 94.65% 漢字, 93.19% English/Vocabulary
— but that is a difference in *difficulty*, which the scheduler already handles
through stability. Nothing in this backtest identifies a deck where a different
*target* is better, because target retention determines intervals that were never
scheduled. Ship the per-deck setting SPEC asks for, default it to the global
target (**0.90** since 2026-08-20; this document said 0.95), and leave it alone until
there is data from more than one target.

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
4. **Nothing beyond 454 days is measured, at all.** The 3,217 observations past a
   year are all late reviews of cards capped at 365 days, spanning 366 to 454 days.
   Not one *deliberately* scheduled long interval has come due: the 1,386 plans
   written since the cap lifted on 2026-02-22 all fall due from 2027-03-17
   onward. Hashigo's 365-day maximum keeps the app inside this range on purpose.
5. **Sub-daily intervals remain unresolved.** SPEC lists them as open. 7,050
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
   stability branches at once. w15 and w16 are not pinned and never will be —
   they are reachable only from Hard and Easy, which this application does not
   have and will not add, so they are **unreachable by design** rather than
   untested. They are frozen throughout and no number above depends on them; this
   is a closed question, not an open one. The one-user, one-corpus limit is
   unchanged and is the real one.

---

## Recommendation

**These are settled — Zach has decided them, and `src/scheduler/policy.ts` is
where the code reads them from.** The measurement below is what each one has to
live with.

| Setting | Value | Where |
|---|---|---|
| Algorithm | **FSRS-6**, fitted to this user | `SCHEDULER_ALGORITHM` |
| Maximum interval | **365 days** | `MAX_INTERVAL_DAYS` |
| Target retention | **0.90** | `TARGET_RETENTION` |
| Grades | **binary only** — remembered / forgot, mapped Again=1 / Good=3 | `BINARY_GRADE` |
| w15, w16 | **frozen, unreachable by design** | `UNREACHABLE_BY_DESIGN` |

1. **Ship FSRS-6.** It wins on the held-out window on log loss, RMSE,
   calibration and AUC, in every deck large enough to rank, on both track kinds,
   and under both interval bases. Ship it knowing the size of the win: **0.1905
   against a constant-base-rate model's 0.2111, about 10%** — not the factor of
   four the raw SM-2 row suggests, because 91% of SM-2's gap is its exponential
   forgetting curve rather than its interval logic. On RMSE, stock FSRS-6 is
   *worse* than that no-input baseline. Nobody should expect the change from
   Mochi to feel like a better scheduler.
2. **Ship it with the fitted parameters**, marked provisional, and refit
   automatically once there is a year of reviews carrying real timestamps and
   real grades. The fitter is 30 seconds of arithmetic on the user's own machine;
   there is no reason to ship population defaults permanently.
3. **Maximum interval: 365 days. SETTLED**, and re-ratified 2026-08-22. Keep it
   configurable, and raise it deliberately in steps if ever — but the shipping value
   is one year.

   **THE REASON THIS SECTION USED TO GIVE WAS WITHDRAWN ON 2026-08-22 AND IS
   CORRECTED HERE.** It read: *"the longest gap ever actually elapsed is 454 days,
   so 365 keeps every interval the app issues inside the range the fit was measured
   on."* Both halves are wrong, and each is wrong in a way this document has a rule
   against:

   * **454 is the ELAPSED edge, used to bound a PLANNED quantity** — decision 6's
     exact prohibition, and the same basis error corrected under "THE 454 IS
     CENSORED" above and in `policy.ts`. `scripts/cap-derive.ts` measures that all
     3,217 gaps past a year came from a plan of ≤ 365 days, **not one from a longer
     plan**, so 454 is Mochi's own cap plus this user's lateness. On the planned
     basis the edge is **365**.
   * **"every interval the app issues" is no longer true.** Interval fuzz is applied
     AFTER the cap (`INTERVAL_FUZZ = 0.05` in `policy.ts`, `fuzzInterval` in
     `schedule.ts`), so the issued maximum is **383 days** — 18 past the planned
     support. That is a deliberate, measured extrapolation, not an oversight:
     fuzz-before-cap is inert because 99.2% of over-cap tracks want more than 384
     days and clamp straight back on, and `Math.min(fuzzed, 365)` puts 52% of
     at-cap tracks back onto one day. CLAUDE.md decision 11 carries the sweep.

   **The derived reason a cap exists at all** is not about how long a memory lasts.
   It is that the fit's opinion about long intervals is manufactured by the
   scheduler that trained it: observed retention *rises* through the tail
   (94.35% → 96.40% → 98.16%), which memory does not do, and the fitted decay ran
   to its floor asking for flatter still. A cap bounds how far that bias runs. 365
   specifically, because that is where the planned support ends. Priced, so nobody
   re-derives it: 365 costs **+33.3% more reviews a year** than no cap (17,314 vs
   12,986), and 365 → 454 would buy back ~3.5 reviews/day for 89 days of
   extrapolation. Do not let a model schedule 1,000 days on the strength of a curve
   fitted to a population filtered for being easy.

   Separately, this leaves **3,306 tracks parked on a 365-day plan set before
   Mochi's cap was lifted**. They are not a scheduling problem — they are simply
   due when they are due — but they are the reason the corpus has no long-interval
   observations, and working through them is what will eventually produce some.
4. **Target retention: 0.90, per-deck override available. SETTLED by Zach on
   2026-08-19** — the date `policy.ts`, `schema.sql` and `CLAUDE.md` all carry;
   the banner in [Target retention](#target-retention-and-daily-load) says
   2026-08-20, which is when that section was corrected rather than when the
   decision was taken. This table said **0.95** until 2026-08-22 and it was stale: the reasoning that
   picked 0.95 — that realised retention is 96.24%, so a 0.95 target "roughly
   ratifies what you already do" — is a false inference, and the correction is
   two sections up under [Target retention](#target-retention-and-daily-load).
   Realised retention says where the OLD scheduler landed, not what the new one
   will schedule: Mochi reaches 96.24% using intervals FSRS considers too long
   for 95%, so adopting FSRS at 0.95 means SHORTENING intervals. Measured under
   the 365-day cap against a realised 69.2 reviews/day, **0.95 asks for 130–204
   reviews/day and 0.90 asks for 62–97** — 0.90 reproduces the load he has
   sustained for four years. `settings.target_retention.default` in `schema.sql`
   seeds `0.90` and `TARGET_RETENTION` holds `0.90`; all three now agree, which
   they did not for three days.
5. **Record what would make the next backtest better.** Two of the three items
   this list used to carry are still live: **real timestamps** (turns 7,050
   unscorable rows into the sub-daily answer) and **both intervals recorded at
   review time** (`elapsed_days` and `scheduled_days` are now separate columns,
   so this one is already done going forward). The third — "a real grade scale,
   which would turn 4 dead FSRS parameters into live ones" — is **struck**: a
   four-button scale was considered and rejected, so w1/w3/w15/w16 stay
   unreachable permanently and that is the intended end state, not a gap. The
   compensation is that the fit and production see identical signal.

---

## Files and reproduction

| Path | What it is |
|---|---|
| `src/scheduler/backtest.ts` | Harness: history loading, replay, metrics, splits, workload model, table formatting |
| `src/scheduler/algorithms/index.ts` | Scheduler interface, state erasure, the exponential curve helpers |
| `src/scheduler/algorithms/fsrs6.ts` | FSRS-6 port, published defaults, clamps, fitted vector, coordinate-descent fitter |
| `src/scheduler/algorithms/sm2.ts` | SM-2 with the published quality formula, both curve options |
| `src/scheduler/algorithms/baseline.ts` | Fixed multiplier and the constant base rate |
| `src/scheduler/policy.ts` | The settled decisions: FSRS-6, max interval 365d, target retention 0.90, the fitted weights (provisional), binary grades, w15/w16 frozen |
| `src/scheduler/schedule.ts` | Stage 6: grade -> next memory state -> next interval. Pure |
| `src/scheduler/day.ts` | Stage 6: local dates, whole-day arithmetic, due dates at local midnight |
| `src/scheduler/tracks.ts` | Stage 6: seeding from history, writing a review, advancing a track |
| `src/scheduler/queue.ts` | Stage 6: what is due, what is new, the 復習予測 forecast |
| `test/scheduler.test.ts` | 33 tests: the day arithmetic, the scheduling arithmetic, then the database path against the real export |
| `test/backtest.test.ts` | 38 tests: closed-form arithmetic, the upstream FSRS-6 fixture, then the real corpus; prints every table above, and asserts this document agrees with `dashboard.html` bucket for bucket |

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
      Tests  37 passed | 1 skipped (38)
   Duration  13.40s

$ HASHIGO_FSRS_FIT=1 npx vitest run test/backtest.test.ts
train rows 60163 · loss 0.150633 -> 0.143209 · 12 sweeps · 4081 evaluations · 32.5s
held-out log loss  refitted 0.190474 · stock 0.203801 over 25835 reviews
      Tests  38 passed (38)
   Duration  41.77s
```

The skipped test is the refit; it runs only under `HASHIGO_FSRS_FIT=1`, where it
reproduces `FSRS6_FITTED_PARAMETERS` from scratch and fails if the committed
vector has drifted from what the fitter actually produces.
