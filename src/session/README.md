# src/session — the review session

Stage 7's state machine. The last module between the finished pipeline and the
screen: `hashigo/scheduler` says what is due, `hashigo/cards` turns a card id into
something renderable, and this decides **what is in front of you now**.

```ts
import { buildSession } from "hashigo/session";
import { directionForTrackKind, loadRenderedCard } from "hashigo/cards";

const session = buildSession(db);              // 10 new + everything due
for (let item = session.current(); item !== null; item = session.current()) {
  const card = loadRenderedCard(db, item.cardId, directionForTrackKind(item.kind));
  // ... draw it, wait for the human ...
  session.answer(remembered);
}
```

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

## The order is `new-first`, and that is an argument rather than a taste

Interleaving is the one item `src/scheduler` flags as still Zach's taste, so it is
a named, swappable policy — `new-first`, `due-first`, `spread`. The default is not
arbitrary:

* The due queue is **443** and his sustained load is ~69–78 reviews a day
  (`BACKTEST.md` carries both bases). **He does not clear it in one session.**
* Under `due-first` the ten new cards are therefore never reached — not "reached
  late", never — and decision 12's dial is inert. That is a defect, not a
  preference.
* Under `spread` across the whole queue he sees about `10 × (done / 443)` new
  cards, so stopping at 100 yields two. The same defect, smaller.
* Under `new-first` the ten happen, and the 3,980-track backlog moves at the rate
  the setting claims.

**The honest counter-argument, and why this is still his call:** ten unfamiliar
words first means ten cards with no accent to recall yet, which is a poor warm-up
for a shadowing exercise. `spread` is one option value away. What is not defensible
is `due-first`.

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
`total/n = 1 + due/n ≥ 1` whenever `due ≥ 1`, and `due === 0` takes an early
return, so the floors strictly increase and two new items cannot claim one slot. A
sweep of **90,000 `(due, new)` pairs** over 1..300 found **zero** collisions.

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
