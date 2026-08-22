# The maximum interval, and the same-day re-ask

Two questions Zach raised on 2026-08-22, both of which turned out to be answerable
from his own corpus rather than from convention. Regenerate every figure here with:

```bash
npx vite-node scripts/cap-derive.ts -- --db build/hashigo.db
npx vite-node scripts/same-day-relearn.ts -- --db build/hashigo.db
npx vite-node scripts/relearn-cost.ts
```

---

## 1. Was 365 days ever derived? No. And Mochi abandoned it.

> 365 days was a default number from mochi flashcards, and I just accepted it as a
> good number because it's a year, but I didn't derive it. Are we supposed to have a
> max date at all? if we have any, what should even be the number tho?
> — Zach, 2026-08-22

**He is right that it was never derived here.** And the number is weaker than that:
`BACKTEST.md` already measured that **Mochi lifted its own 365-day cap on 2026-02-22**
and has since planned intervals out to **2,707 days**. So 365 is not the source app's
number any more either. It is an inherited default from a version of Mochi that no
longer exists.

### THE CENSORING RESULT — this is the one that decides it

Of **3,009** reviews whose measured gap exceeded 365 days, the interval that had been
**planned** was ≤ 365 days for **all 3,009 of them**. Not one came from a longer plan.

```plaintext
Of the 3009 gaps longer than 365d, what interval was PLANNED?
  planned <= 365d (so: he was LATE)   3009
  planned  > 365d (real long plan)       0
  longest plan behind any of them      365d
```

So the "longest gap ever observed is 454 days" figure — quoted in `policy.ts`,
`CLAUDE.md` and `BACKTEST.md` as the justification for the cap — **is not evidence
about memory at 454 days.** It is Mochi's 365-day cap plus how late Zach runs. The
corpus contains **zero** observations of a card being *asked for* at any interval
beyond a year, and no amount of this history can produce one.

**Correct the inference, not the number.** The old reasoning was "365 is safe because
454 was observed". The honest version is: *every* cap above 365 is extrapolation, and
so is 365 itself the moment the model wants more. What differs between candidates is
only how much extrapolation, and what it buys.

### The evidence thins fast, and the tail is upside-down

| | reviews | share |
|---|--:|--:|
| gaps longer than 300d | 6,397 | 6.879% |
| gaps longer than 365d | 3,009 | 3.236% |
| gaps longer than 400d | 817 | 0.879% |
| gaps longer than 454d | **0** | 0.000% |

| bucket | reviews | retention | mean gap |
|---|--:|--:|--:|
| 181–365d | 9,343 | 94.35% | 264.7d |
| 366–400d | 2,192 | 96.40% | 375.6d |
| 401–454d | 817 | **98.16%** | 419.4d |

Retention **rises** monotonically through the tail. Memory does not do that. This is
`BACKTEST.md`'s selection bias, sharpened: only cards that keep being remembered are
ever granted a long interval, so the long buckets are a filtered population. Any model
fitted here learns *"forgetting is slow at long intervals"* when the truth is *"easy
cards get long intervals"*. The fitted decay confirms it — it ran to its floor (0.1542
→ 0.100), i.e. the fit wanted an even flatter tail than FSRS-6 permits.

**That is the real argument for having a cap at all**, and it is nothing to do with a
calendar year: the cap exists because the model's opinion about long intervals is
manufactured by the scheduler that produced the training data. A cap is a bound on how
far we let a biased extrapolation run.

### What the model wants, and what each cap costs

8,961 live tracks, seeded from their own history and asked for an interval at 0.90:

```plaintext
p50 988d · p75 1487d · p90 1870d · p99 2013d · max 2254d
```

The median is **988 days** — 2.7× the cap and 2.2× the longest gap ever measured.

| cap | tracks clipped | reviews/yr | vs no cap | extrapolation past any PLAN |
|---|--:|--:|--:|---|
| **365d** | 6,669 (74.4%) | 17,314 | +33.3% | none — inside every plan ever made |
| 400d | 6,575 (73.4%) | 16,735 | +28.9% | +35d (10% beyond) |
| 454d | 6,412 (71.6%) | 16,029 | +23.4% | +89d (24% beyond) |
| 500d | 6,256 (69.8%) | 15,560 | +19.8% | +135d (37% beyond) |
| 730d | 5,626 (62.8%) | 14,175 | +9.2% | +365d (100% beyond) |
| 1095d | 4,121 (46.0%) | 13,354 | +2.8% | +730d (200% beyond) |
| none | 0 | 12,986 | — | unbounded, out to 2,254d |

Reviews/yr is the load consequence: a track on interval *i* contributes 365/*i* reviews
a year, so a **lower** cap means **more** reviews. The 365-day cap costs **+33.3% of
annual reviews** against no cap — 4,328 extra reviews a year, about **11.9 a day**.

**The shape of the trade is worth seeing: it is not linear.** Going 365 → 454 saves
1,285 reviews/yr (3.5/day) for 89 days of extrapolation. Going 454 → 1095 saves
another 2,675 for 641 more days. The cheap part of the saving is at the near end.

### 365 is defensible, but for a different reason than the one on record

`policy.ts` says the cap exists "so that no interval the app issues leaves the range
the fit was measured on". After the censoring result, the range the fit was measured on
**ends at 365 planned days** — so 365 is the only candidate that claim survives for.
Every longer cap needs a different justification, and the honest one would be a
tolerance for extrapolation rather than an appeal to evidence.

**Unresolved, and it is Zach's:** whether to keep 365 on that basis, or accept some
extrapolation to buy back reviews. Nothing here recommends a number; it removes a bad
reason for one and prices the alternatives.

### His `Math.min` proposal, measured

> how about we just max the cap at 365 days? so like if the schedule sets at 383, it
> does the Math.max(schedule, 365)?

He means `min`. It works, but it is the weakest of the three schemes, and for a reason
worth seeing: everything fuzzed *upward* is shoved back onto exactly the cap, which
re-forms the clump the fuzz existed to break.

```plaintext
                                       worst   CV    of 3650 at the cap, still land on it
no fuzz                                  188   2.48   3650
two-sided ±5% (in the code now)           71   1.94     92
two-sided ±5%, then min(·, 365)          113   0.99   1892   <- half the cohort back on one day
downward-only, 10% width                  73   1.91     51
```

**1,892 of 3,650 — 52% — end up back on exactly 365 days.** That is the fuzz factor
being roughly symmetric: every track it shifted up gets clamped to the same value.
Downward-only at 10% leaves 51 there, and keeps 365 an absolute ceiling as well.

(Its CV of 0.99 is much the best in the table and that is not a mistake — clamping
compresses the whole distribution. But CV is not what the fuzz is for. The worst single
day is, and on that measure it is 113 against 73.)

---

## 2. Should a forgotten card come back before the session ends?

> i'm not averse to reviewing the forgotten card that day at the end of the session
> […] And then we'll come to a question whether reviewing at the end of the session
> would affect the scheduler, and what happens if we also can't get it right the
> second time. I don't know how mochi or anki are doing this.
> — Zach, 2026-08-22

### What Mochi actually does — and it is NOT same-day relearning

There are 6,996 reviews that follow another review of the same track on the same local
day, so it looked at first like Mochi already did this. It does not. **98.5% of them
follow a PASS, not a failure**, and **6,895 of 6,996 sit at position 2 in the track's
history** — the second time that card was ever seen.

```plaintext
same-day reviews by position in the track's history:
  n = 2   6895      n = 3    17      n = 4     9
  n = 5     10      6-10     31      11+      34
```

That is Mochi's **new-card learning step**, not a lapse mechanism. Mochi's actual
behaviour after a lapse is **next day**:

| gap after a lapse | reviews | remembered |
|---|--:|--:|
| same day (0d) | 103 | **0 — 0.0%** |
| 1d | 504 | 420 — 83.3% |
| 2d | 300 | 259 — 86.3% |
| 3d | 168 | 142 — 84.5% |

**THE NUMBER THAT MATTERS: 0 of 103.** In 102,020 reviews there is not one instance of
a card being failed and then passed the same day. The 103 same-day-after-failure rows
are all further failures — Zach grinding a card he was stuck on (one card took 16
attempts in a single day), not a designed step.

So *neither* Mochi *nor* his history says anything about whether a same-day re-ask
works. Anki does default to a 10-minute relearning step, so the idea is not exotic —
but Anki fits its model on data that contains those reviews. Ours does not.

### What it would do to the schedule — exactly, not approximately

FSRS-6 has a separate **short-term branch** for `delta_t == 0` (`stabilityShortTerm`,
driven by w17/w18/w19), and decision 6 means the model is fed **whole local days** — so
a same-day re-ask arrives as a 0-day observation and takes that branch by construction.
From one lapsed state, with the shipped fitted parameters:

| | S = 10d card | S = 120d card | S = 900d card | change |
|---|--:|--:|--:|--:|
| A. no same-day re-ask | 1.6d | 4.1d | 7.3d | — |
| B. re-asked, **PASSED** | 5.6d | 14.5d | 25.7d | **+250.4%** |
| C. re-asked, **FAILED again** | 0.3d | 0.7d | 1.3d | **−82.7%** |

**The multiplier is identical at every stability**, which is not a coincidence: w19
fitted to **0.000053**, essentially its floor of 0, so `lastS^(-w19)` is 1 and the
branch is a flat multiplier. Analytically, with w17 = 1.503450 and w18 = 0.834068:

* pass (grade 3): `exp(1.503 × 0.834)` = **3.50×**
* fail (grade 1): `exp(1.503 × −1.166)` = **0.173×**

### The catch, and it is the same shape as the cap question

w17/w18/w19 are fitted, not frozen — but look at *what they were fitted on*. 6,895 of
the 6,996 same-day observations are **new-card second looks**, and the 103 post-lapse
ones are **all failures**. So the model's confident "a same-day pass is worth 3.5× the
interval" is calibrated on new cards and extrapolated onto lapsed ones, with **zero
supporting observations**.

That is the same defect as `454d`: a model with a strong opinion exactly where the data
is silent.

### Recommendation: show it again, don't grade it

This gives him what he actually asked for at zero cost:

* he wants the card back — he gets it back, at the end of the session
* **the schedule stays at arm A**, so no 3.5× lengthening of a card he just failed, and
  no −83% punishment for missing it twice
* nothing is fed to the model in a region where it has no observations
* it is also the cheapest thing to build: a session-local list, no new review rows, no
  scheduler change at all

And it is reversible in the useful direction. If he later wants the re-ask graded, the
observations will exist by then to fit w17/w18/w19 on **post-lapse** same-day data
instead of on new-card learning steps. Grading it now forecloses that; showing it
without grading creates the very data that would justify grading it.

**Not decided — Zach's call.** The alternative (grade it) is defensible if he wants the
model to react to a recovery, and the numbers above are what he would be buying.
