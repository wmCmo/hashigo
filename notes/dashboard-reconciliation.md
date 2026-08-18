# Reconciling the dashboard against Mochi's 2026 figures

Measured from `exports/` with `tools/mochi.py`, JST day bucketing (all review
timestamps are 15:00:00Z == midnight JST; there is no real time-of-day data).

| Figure | Mochi screenshot | Ours | Verdict |
|---|---|---|---|
| Active days | 211 | **211** | exact |
| Retention | 95% | **95.10%** | exact to displayed precision |
| Days elapsed | 231 | 230 | inclusive-count convention; Aug 18 is day 230 of 2026 |
| Reviews | 13,240 | 14,420 | **+8.2% — unexplained** |
| Cumulative cards | 5,250 | 5,182 | −68; ours = distinct cards studied during 2026 |

## The reviews gap is not an importer bug

The import is byte-exact against the export: 102,020 reviews total, which is the
oracle number. The 2026 window, the JST bucketing, and the track selection are all
confirmed correct by the active-days and retention figures agreeing exactly — any
wrong window or timezone would break those first.

Definitions tested and ruled out (all counts for 2026):

| Definition | Reviews | Active days | Why rejected |
|---|---|---|---|
| all reviews, all tracks | 14,420 | 211 | the +1,180 gap, but days/retention exact |
| exclude reviews with no `interval` | 13,207 | **210** | closest count, but breaks the day match |
| exclude reviews with no `duration` | 13,188 | — | same problem |
| exclude `rereview?` | 14,384 | 211 | only 36 such reviews in 2026 |
| exclude now-archived cards | 14,364 | 211 | only 234 archived cards exist |
| UTC day bucketing | 14,420 | 211 | identical — every review sits at 15:00Z |
| forward track only | 8,516 | 211 | far too low |
| any rolling window ending 2026-08-18 | no fit | — | nearest (13,249) has 192 active days |

Best remaining fit: **one review per card per day** — 13,258 reviews (+18), and
deduping cannot change the active-day count, so 211 survives. That would mean
Mochi's dashboard counts *cards touched* per day rather than grading events,
collapsing a card whose forward and reverse tracks were both reviewed in one
session. It is 0.14% off, not exact, so treat it as the leading hypothesis and
not a settled answer.

## What Hashigo should do

Do not tune our numbers to match Mochi's — Mochi's definition is undocumented and
we cannot close the last 18. Instead define each metric explicitly in the view SQL
and label it in the UI, so the number is always reproducible from the definition:

- **Reviews** = grading events, all tracks. State "all tracks" in the label.
- **Cards studied** = distinct cards with >= 1 grading event in the window.
- **Active day** = a day with >= 1 grading event, bucketed by the user's local
  timezone, not UTC.
- **Days** = inclusive of both endpoints (matches Mochi's 231, and is what a
  person means by "231 days").
- **Retention** = passed / total grading events in the window.

Expect the 2026 review count to read ~14,420 where Mochi said 13,240. That is a
definitional difference we have characterised, not a discrepancy to hide.
