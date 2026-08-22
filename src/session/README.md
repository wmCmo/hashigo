# src/session — the review session

Stage 7's state machine. The last module between the finished pipeline and the
screen: `hashigo/scheduler` says what is due, `hashigo/cards` turns a card id into
something renderable, and this decides **what is in front of you now**.

```ts
import { buildSession } from "hashigo/session";
import { mountTrack } from "hashigo/review";

const session = buildSession(db);              // 10 new + everything due
for (let item = session.current(); item !== null; item = session.current()) {
  const mounted = mountTrack({ db, track: item, document, store })!;
  container.replaceChildren(mounted.result.root);
  mounted.loop.enter(0);                       // on screen. SILENT, by design.
  // ... he says the contour aloud, taps, hears it, and answers ...
  session.answer(remembered);
  mounted.dispose();
}
```

**Use `hashigo/review`, not `loadRenderedCard`.** An earlier version of this example
used the latter and was quietly wrong: it cannot reach the audio, because
`expandGeneratorFields` needs the template fields and card values it does not
return. See `src/review/README.md`.

`src/scheduler`'s own header says it "does NOT hold a session, choose a
new-cards-per-day number, interleave new with due, or undo a grade". This owns the
first three. **It deliberately does not own undo** — see the last section.

No DOM, no rendering, no `node:` import: it is a state machine over track ids, so
it is testable without a browser and portable into the OPFS worker where the
review screen will run. Pinned by `test/browser-portable.test.ts`.

## The three decisions it implements

**Decision 13 — a forgotten card is shown again at the end of the session, and NOT
graded.** The second half is the load-bearing one. `answer()` on a re-ask writes no
review row and moves no due date, and that is enforced here rather than left to the
caller: `AnswerResult.graded` is `false` and `review` is `null`, and no flag can
override it. Grading a same-day re-ask would take FSRS-6's short-term branch and
move the next interval by a flat **3.50× on a pass, 0.173× on a second failure** —
a multiplier fitted on new-card second looks with **zero** post-lapse observations
in this corpus. So the re-ask creates the data that would later justify grading it,
and until then changes nothing.

**Decisions 12 and 15 — ten new TRACKS a day, at random, forward and reverse not
paired.** All of that already lives in `newTracks`, including the randomness, so
this passes `newLimit` and does not re-implement the order. `DEFAULT_NEW_LIMIT` is
10 because that is Mochi's default and what Zach wants kept.

## The order is `spread`, over a window

Interleaving was the one item `src/scheduler` flagged as Zach's taste, and **he
chose `spread` on 2026-08-23**: new cards mixed through the session rather than
stacked at the front, so he warms up on words he knows instead of on ten he has
never seen. For a shadowing drill that is the right call — a new card has no accent
to recall yet.

**The window is the half that makes his choice work.** Spread across the *whole*
plan, the new cards are so far apart he never reaches them: 443 due against a
sustained ~69–78 reviews a day (`BACKTEST.md` carries both bases) means he does not
finish a session. Measured over the real 453-card plan — new cards actually seen:

| stopping after card | 50 | 80 | 100 | 150 |
|---|---|---|---|---|
| spread over the whole plan | 1 | 2 | 2 | 3 |
| **spread over a window of 80** | **6** | **10** | **10** | **10** |

So slots are laid over `min(total, max(spreadOver, 2 × new))`.
`EXPECTED_SESSION_CARDS` is **80** because that sits just above both measured bases
for his sustained load (77.5 per *active* day; 69.2 on `BACKTEST.md`'s basis) — a
derived number, and a setting rather than a constant.

The `2 × new` floor is what stops two new cards landing adjacent: it forces a step
of at least 2 whenever `due ≥ new`. Swept over 90,000 `(due, new)` pairs, zero
violations. And the first new card lands at `floor(0.5 × window / new)` — card 4 of
80 with ten new — so the warm-up is real rather than nominal.

`new-first` and `due-first` are still available. **`due-first` is a defect rather
than a preference:** the ten new cards are never reached at all, and decision 12's
dial becomes inert.

## What fault injection found — two pieces of dead code, both mine

Worth reading before adding a guard to this module, because the reflex to add one
was wrong twice in a row.

**A `Set` of already-re-asked track ids.** It looked like the thing enforcing "one
re-ask per track", and the header said so. Deleting it left **all 17 tests green**.
The termination guarantee actually comes from one line: `answer()` returns early
for a re-ask, before the re-queue branch, and a track is in the plan exactly once
because `dueTracks` and `newTracks` are disjoint on `due_at IS NULL`. The Set could
never fire.

**A collision walk in the `spread` slot arithmetic** (`while (slots.has(slot))
slot += 1`). Removing it also changed nothing. Consecutive slots differ by
`window/n`, which the `2 × new` floor keeps at ≥ 1, so the floors strictly increase
and two new items cannot claim one slot. A sweep of **90,000 `(due, new)` pairs**
over 1..300 — re-run after the window landed — found **zero** collisions and zero
adjacent pairs.

Both were removed rather than kept as belt-and-braces. Code that reads as
load-bearing and is not is the trap this repo files under "built but NOT WIRED UP".

**And one thing the injections showed about the tests themselves:** the totality
test — every input appears exactly once — **passes with the slot formula completely
broken**, because totality survives clustering. `spread is EVEN` is what owns the
formula. If you change `interleaveTracks`, run both.

Injection results, for the record:

| broken | tests red |
|---|---|
| re-asks graded (decision 13's second half removed) | 2 |
| off-by-one dropping the last re-ask | 4 |
| the `reasked` Set deleted | **0 — it was dead** |
| the `spread` collision walk deleted | **0 — unreachable** |
| `+ 0.5` midpoint dropped | 1 |
| slots clustered at the front | 2 |

## What it deliberately does not do

**Undo, skip and bury are absent because no decision covers them.** Undo in
particular is not a UI affordance over this module: a graded review is a row in an
append-only table with a `BEFORE UPDATE` trigger, so undo is a schema question
before it is a session one. Do not add any of the three by inference.

It also does not re-read the database mid-session. The plan is a snapshot, which is
what makes `progress().planned` a stable denominator for a progress indicator — a
queue that re-queried would make the bar jitter — and means a card that becomes due
mid-session is tomorrow's, not a queue that grows while being worked.
