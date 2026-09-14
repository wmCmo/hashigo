# src/scheduler — stages 5 and 6

Two things live here and they answer different questions.

**Stage 5, the backtest** (`backtest.ts`, `algorithms/`) asked *which* scheduler.
It replayed all 102,020 imported reviews against SM-2, stock FSRS-6, FSRS-6
fitted to this user, and a fixed-multiplier baseline, scored by log loss and
RMSE, and it is finished. `BACKTEST.md` has the tables and the three
qualifications that matter more than the headline.

**Stage 6, the scheduler** (`policy.ts`, `schedule.ts`, `day.ts`, `tracks.ts`,
`queue.ts`) is what the app runs. It grades a track, advances its memory state,
and answers what is due.

```ts
import { dueTracks, gradeTrack, queueCounts } from "hashigo/scheduler";

queueCounts(db);                                     // 443 due, 328 overdue, 3,980 new
const [next] = dueTracks(db, { limit: 1 });
gradeTrack(db, { trackId: next.trackId, remembered: 1 });
```

```bash
npx vite-node src/scheduler/cli.ts -- counts   --db build/hashigo.db
npx vite-node src/scheduler/cli.ts -- queue    --db build/hashigo.db --limit 20
npx vite-node src/scheduler/cli.ts -- forecast --db build/hashigo.db --days 14
npx vite-node src/scheduler/cli.ts -- seed     --db build/hashigo.db   # writes state only
```

## The five files, and why they are five

| file | what it owns | needs a database? |
|---|---|---|
| `policy.ts` | the settled configuration — FSRS-6, 365 days, 0.90, ±5% fuzz, the fitted weights | no |
| `day.ts` | instants, local dates, whole-day arithmetic, due dates at local midnight | no |
| `schedule.ts` | grade → next memory state → next interval, including fuzz | no |
| `tracks.ts` | reading state, seeding from history, writing a review | yes |
| `queue.ts` | what is due, what is new, how much, what is coming | yes |

The split is not tidiness. Everything in the first three is a pure function of
its arguments, so the scheduling claims in `test/scheduler.test.ts` are checked
without a fixture, a database or a clock — and the unit question that is easy to
get wrong (see below) is visible in a signature rather than buried in SQL.
`tracks.ts` and `queue.ts` are typed against `SqliteHandle`, not better-sqlite3's
`Database`, because the review screen runs in the browser over OPFS. That is a
type-level guarantee only — **every test here runs on better-sqlite3, and nothing
in this directory is exercised against sqlite-wasm by any test.**

That sentence used to end "and no function in this directory has yet executed
against sqlite-wasm", which stopped being true once `app/` shipped: he grades on
his phone, `src/session` calls `gradeTrack`, and those reviews are in OPFS and
nowhere else. So the SQL here DOES run under sqlite-wasm — in production, on the
only copy of his recent history, with no test standing behind it.
`test/browser-portable.test.ts` pins that these modules carry no `node:` import,
which is necessary and not sufficient: it says the module can LOAD in a worker,
not that its SQL behaves the same there. This is the widest remaining gap in the
scheduler's coverage and it is stated here rather than implied.

## Five things worth knowing before changing anything here

**1. An imported Mochi track is SEEDED from its history, lazily.** 9,026 of the
13,392 tracks carry `scheduler = 'mochi'` and `scheduler_state = NULL` — Mochi
never exported stability or difficulty, so there is nothing to convert. The first
local grade of a track replays its whole review log through FSRS-6, then applies
the grade. Treating an imported track as a new card would throw away four years
of history one card at a time and would look exactly like the scheduler working.

Lazily rather than in one pass because he is **still reviewing ~100 cards/day in
Mochi** and will re-export repeatedly, and the importer overwrites `due_at`. An
ungraded track keeps the due date Mochi gave it, so on day one the queue is the
queue he already knows. `seedTrackMemory` does the eager pass and deliberately
moves no due date.

**2. The model is fed WHOLE LOCAL DAYS; `reviews.elapsed_days` stores the exact
fraction.** These are different numbers on purpose. Every observation the shipped
parameters were fitted on was date-only, so a fractional gap is a unit the fit
has never seen — and whole days are what make a same-day re-review reach FSRS's
short-term branch at all. Decision 6 in `CLAUDE.md`: name the basis or the number
is not a fact. `wholeDaysBetween` and `exactDaysBetween` are the two, and a test
grades the same card at 02:00 and at 20:00 of the same day and demands an
identical schedule.

**3. The planned interval comes from the previous REVIEW ROW, not from
`card_tracks.scheduled_days`.** `reviews[n].scheduled_days` must equal
`reviews[n-1].next_scheduled_days`, and `review_interval_audit` is the view that
checks it. Reading the track column would satisfy the audit only for as long as
that cache had never drifted; reading the row that defines the invariant
satisfies it by construction. A test drifts the cache deliberately and demands
the audit stay empty.

**4. Due dates are stored at local midnight, and that is the canonical form
rather than the protection.** `queue.ts` compares local DATES, which is what makes
"due today" mean the whole day. Midnight is what makes a due date this code
writes indistinguishable in shape from one the importer wrote. My first version
of that comment claimed midnight was what prevented the learn-ahead defect;
breaking `dueInstant` on purpose showed the queue test staying green, so the
claim was wrong and is corrected in the file.

**5. Interval fuzz is ±5%, keyed on the TRACK ID, applied AFTER the cap.** All
three of those are load-bearing and all three are measured (`scripts/fuzz-load.ts`,
which re-runs every number in `INTERVAL_FUZZ`'s comment).

* Keyed on anything coarser — the interval value, the due date — it TRANSLATES the
  clump instead of spreading it. Worst future day: 188 with no fuzz, 71 keyed per
  track, **295** keyed per due-date cohort. Getting the key wrong is worse than
  not doing it.
* After the cap, because 42.9% of live scheduled tracks sit on exactly 365 days
  and 99.2% of the tracks this scheduler would cap want more than 384 days —
  fuzz before the cap clamps every one of them straight back onto 365 and moves
  nothing. The price is that an issued interval can reach 383 days;
  `MAX_INTERVAL_DAYS` is a centre now, not a ceiling, and `cappedIntervalDays` on
  the result is the model's own pre-fuzz answer.
* At grade time, not read time. It is computed in `gradeMemory` and stored;
  nothing in `queue.ts` knows fuzz exists. Computed on read, a due date would
  jitter on every query.

It is deterministic — `hash32` over the track id, not `Math.random()` — so a
schedule can be diffed and tested, and two synced devices cannot disagree about
when a card is due.

## What stage 6 is NOT

It does not hold a session, decide how many new cards a day is right, interleave
new with due, undo a grade, or play a sound. The first four are stage 7's, and at
least two of them are Zach's taste rather than a measurement — `newTracks` is
returned separately from `dueTracks` for exactly that reason. The last one is a
correctness requirement that lives in `src/render/reveal.ts`: **audio fires on the
cloze reveal, never on side entry**, and nothing here touches it.
