# Next session — start here

Rewritten 2026-08-22, immediately before a `/compact`. Zach's standing instruction:
*"assume that the new session will know NOTHING about our conversation, don't trust the
summary process, it loses so much context."* So this is the handoff, not a summary.

**Read in this order:** `CLAUDE.md` (auto-loads; carries the current state and every
settled decision) → this file → whichever `notes/` file the task touches.

Zach keeps a planner at
`C:\DEV\obsidian\second-brain\PARA\1Projects\ハシゴ\Planner.md`. **As of 2026-08-23 it is
three short sections — what he has to decide, what is left before he can use the app, and
a wishlist he added himself.** Everything that was status, measurement, what-not-to-rebuild
or reasoning moved into this repo, because no agent reads Obsidian.

So: it is NOT in git — **an edit there is NOT revertible, so copy it first** — and if you
edit it, **do not grow it**. A thing that is not a decision of his, a blocker, or a wish
belongs here instead. It quotes no figures on purpose: the ones it used to carry went
stale, so it points at the repo rather than counting. **Do not renumber D2-D5** — this
file and `CLAUDE.md` cite them by number, and D1 is absent because it is decided. His verbatim
reasoning — the SOURCE that CLAUDE.md's decisions were written from — now lives at
`notes/zach-in-his-own-words.md`; preserve his wording there and don't paraphrase him away.

---

> [!important] **READ [notes/zach-wants.md](notes/zach-wants.md) BEFORE ANYTHING ELSE.**
> On 2026-08-23 an agent told him the app was "essentially finished". He answered with
> **fourteen things off the top of his head** — a Notion-style card gallery, Ctrl+K
> search, template editing, settings, undo, deck CRUD, mobile parity for every
> operation. **The six requests earlier that day were not the specification**; they were
> what came to mind the first time he saw it run. That file is what he wants, in his
> words, and it reorders everything below.
>
> **The recurring principle in it is not one of the fourteen:** every 操作 available on
> the desktop must be available on mobile. A keyboard shortcut is an accelerator, never
> the only route.
>
> **ALL FOURTEEN CARRY WORKING CODE as of 2026-08-26.** The last three — the dashboard
> from the sidebar (1), template and field editing (11), settings (12) — landed with
> pin (6, 7). What that does NOT mean is in `notes/zach-wants.md`: the dashboard costs
> 81 seconds in the worker and says so before running, and the template editor refuses
> two edits on purpose. **He has still never run any of it on his phone.**

## STATE RIGHT NOW — 2026-08-26, tree clean, THE APP RUNS

**There is an app.** `app/` is a page, an OPFS database, audio on the device and grades
landing on disk. Measured end to end in Chromium over the real corpus: **7,716 cards,
102,020 imported reviews, a 656-card plan (as of 2026-08-26; it was 531 on
2026-08-23 and GROWS DAILY as scheduled dates pass), reveal, grade, next.** Read
[app/README.md](app/README.md) before touching it — it carries three findings that only
came out of running it, and none of them was reachable by reasoning.

```bash
npx vite-node scripts/app-bootstrap.ts    # once
npm run app:dev -- --host 127.0.0.1       # local
npm run app:dev -- --host ::              # phone / tunnel
```

Gates: run **`npm run gates`** — one command, all seven, cheapest first, and a verdict
that means what it says. `app:build` is new and was covered by nothing: `app:check` is
`tsc --noEmit` and cannot see a broken worker or sqlite-wasm URL. Re-run on this tree 2026-08-26: **`npm test` → 36 files / 934
passed / 1 skipped** (~97 s) · `npm run typecheck` → 0 · **`npm run app:check` → 0** ·
`npm run build` → OK, 77 modules, 27 export subpaths · `npm run spike:check` → 0 ·
`blobs … paths` → 0.

**`npm test` EXITS 0 ON A PASSING RUN as of 2026-08-26**, and both commands now
decide it the same way. It is a wrapper (`scripts/test.mjs`) over the rule in
`scripts/test-verdict.mjs`, which `npm run gates` imports as well — that rule used to
be spelled out inside `gates.mjs` and nowhere else, so the two commands disagreed
about the same run and the honest answer was reachable only by knowing which one to
type. `npm run test:raw` is unwrapped vitest.

Raw vitest still exits 1, and the cause is unchanged: birpc's RPC timeout is a
hard-coded 60 s that vitest never overrides, `onTaskUpdate` is an awaited call, and
exactly the files that run over 60 s throw one error each, every run. Cutting workers
changes nothing; quieting the reporter changes nothing; `--no-isolate` makes it worse.

**`pool: "threads"` is NOT the fix, and it is recorded so nobody repeats it.** It
removes the RPC errors — and segfaults (exit 139, SIGSEGV) on the third run, because
`better-sqlite3` is a native addon and the suite loads it in six threads of one
process. It passes twice first, so two green runs are not evidence.

So: **`npm run gates`** decides the suite on its SUMMARY rather than its exit code —
a complete summary line and zero failures, or it fails. That is stricter where it
counts: a crash prints no summary and cannot pass, which is exactly what caught the
segfault. `npm test` alone must still not be chained on.

### THE SEVEN BUGS AN AUDIT FOUND IN `app/` — measured AND FIXED 2026-08-26

**ALL SEVEN ARE FIXED.** Every figure below was measured against `build/hashigo.db`
before being written, and each entry describes the bug as it WAS — `git log` carries the
fix and names the test that pins it.

The list is kept rather than deleted because each one's shape is the lesson, and
together they are the evidence for the structural finding at the bottom: six of the
seven lived in `app/db.worker.ts`, the file that owns every write and the one `test/`
could not import.

**1. FIXED 2026-08-26. Archiving a deck archived only the deck's OWN cards, and reported success anyway.**
`app/db.worker.ts:488` — `UPDATE cards SET archived = ? WHERE deck_id = ?`, no descent
into sub-decks, then `describe = "archived <name> and its cards"`.

```plaintext
deck        own cards   subtree     so archiving it archives
日本語            3       5,947      3 of 5,947, and says it worked
English           0       1,258      NOTHING, and says it worked
単語          3,702       3,742      3,702 of 3,742
```

His #14 is deck CRUD and his #8 is "I think my whole 数字 deck is supposed to be
archived", so this is the exact operation he asked for. **The queue would also need to
honour the deck flag** — `src/scheduler/queue.ts` filters `c.archived = 0` on the CARD
only, and nothing reads `decks.archived` (`notes/zach-wants.md` says nothing reads or
writes it; the app now WRITES it, so that note is stale in one direction).

**2. FIXED 2026-08-26. Undo of a deck archive INVERTED rather than RESTORED, exposing 234 cards.**
`app/db.worker.ts:491` records `undo = {op: "unarchive", deckId}`, which runs
`UPDATE cards SET archived = 0 WHERE deck_id = ?` over every card in the deck. So one
ctrl+Z after an accidental deck archive erases every per-card archive decision in that
deck. **234 cards in the corpus are archived individually** and there is no in-app way
back — the undo stack holds one entry and it is the thing that did the damage. A
correct undo has to record the prior per-card state, not the inverse operation.

**3. FIXED 2026-08-26. Clicking a parent deck opened an EMPTY gallery.** `app/db.worker.ts:718` and `:730`
filter `c.deck_id = ?` exactly, and `:761` filters search hits by
`hit.deckId === request.deckId`. The sidebar badge is a SUBTREE total (that is the
whole point of `app/deck-tree.ts`), so English showed "1258" and opened 0 cards, and
日本語 showed "5947" and opened 3. Every deck with children was affected.
`app/deck-scope.ts` now resolves the subtree with a recursive CTE over
`decks.parent_id`, and a test requires it to agree with the page's own walk.

**4. FIXED. Deck-scoped search filtered AFTER the limit.** Same site, `:761` — `searchCards`
returns its top `limit` across the whole collection and the deck filter is applied to
that page, so searching inside a deck silently under-reports. It is not a wrong count
in a corner: with `limit: 300` over 7,716 cards, a query matching widely outside the
deck can return almost nothing inside it.

**5. FIXED. Undo now covers grading, `setField` AND `createCard` — all four actions his #13 names.** He asked
for *"ctrl+z ... whether create card, review card, remember card, forget card"*. There
are exactly two `pushUndo` call sites in `app/main.ts`, both in the card/deck op path:
grading, `setField` and `createCard` push nothing. Undoing a grade means deleting the
`reviews` row AND restoring the previous `card_tracks` schedule state — a partial undo
that leaves the schedule advanced is worse than none, which is presumably why it was
skipped. Worth saying plainly because the commit and the code comment both read as
though #13 is done.

**6. FIXED. Deleting the current review card hard-locked the session.** Confirmed by the audit;
the card is gone, the session cursor still points at it, and the failure is invisible.
`delete` is deliberately not undoable (the reviews go with it) and says so, which is
right — the lock is the bug, not the irreversibility.

**7. FIXED, all three.** Originally: duplicating a card drops its per-card `reverse`
override, so the copy loses its reverse track; the "card not found" preview layer is
appended but never pushed onto the layer stack, so one Escape destroys the whole stack;
and `app/env.d.ts` still claims `src/schema` cannot be imported in a browser, which has
been false since the source moved.

**The pattern worth naming:** six of these seven are in `app/db.worker.ts`, the file
that owns every write, and none of them could have been caught by `npm run app:check`.
`app/keys.ts`, `app/deck-tree.ts` and `app/review-boundary.ts` show the seam that makes
a rule testable — a self-contained module with no imports, reachable from `test/`
because the root `tsconfig.json` excludes `app/`. The worker's SQL has no such seam yet.

**The only real fix is for no single file to need 60 s of its own wall clock.**
`test/roundtrip.test.ts` needs 82 s and runs `importExports` over the full corpus five
times. Splitting it is the repair; it is deliberately NOT done, because moving tests
that share a `beforeAll` import between files is where coverage silently changes and
these are the oracle tests. Whoever does it should prove the pass count is unchanged.

### SINGLE SOURCE OF TRUTH AND ACID — 2026-08-26

Both were asked for directly, and both turned out to be narrower problems than they
sound. Recorded because the SHAPE of each is the thing worth reusing.

**ACID was already true; nothing was checking it.** `foreign_keys = ON` is set in all
three open paths and two of them verify the pragma read back — good practice that no
test exercised. Every genuine multi-statement write is already in a transaction; the
five "bare" ones a scan flags are upserts or run inside a caller's transaction.
`test/acid.test.ts` now pins all four properties, including `PRAGMA foreign_key_check`
and `integrity_check` over the real 74 MB database, which nothing had ever run.

**The one real ACID defect was in the PAGE, not the database.** `runUndo` popped its
entry BEFORE awaiting the undo, with no `catch`. Undo state lives in two stacks — the
page's and the worker's `answers` — and a failed undo left them off by one, so the NEXT
ctrl+Z undid a different grade than the one named on the button. Silently. It now peeks,
runs, and pops only on success.

**SSOT: one rule had THREE implementations and one of them disagreed.** `views.sql`
resolves `reverse` inheritance in SQL, and says beside the neighbouring voice view
exactly why that should be the only definition — *"so there is one definition of the
inheritance rather than a SQL one and a TypeScript one that drift"*. There were three.
`src/import/reviews.ts` walked PAST an explicit `off` looking for an `on` above it, so a
deck deliberately excepted under an enabled parent resolved `on` there and `off`
everywhere else. Unreachable from a Mochi export only by accident — `mochiDeckReverse`
never yields `off` — and reachable the moment request 14's deck CRUD writes one.
`resolveReverseInheritance` in `src/schema` is now the rule; both importers adapt to it;
and `test/reverse-inheritance.test.ts` pins the TypeScript against the SQL view for all
7,716 cards, because that half cannot be deduplicated away.

**Also unified:** the live-track and due-date SQL fragments (`src/scheduler/predicates.ts`
— the due comparison is the one that diverged into the 704-vs-646 bug), `arg()` (four
byte-identical copies, now `src/cli/args.ts`), and `findClose`/`findSectionClose` (two
byte-identical scanners for one grammar).

**What could NOT be deduplicated is pinned instead.** `app/deck-tree.ts` walks the deck
tree in TypeScript over an in-memory array; `app/deck-scope.ts` walks it in SQL. They
are on opposite sides of a `postMessage` boundary with different data shapes and neither
can call the other. A test now requires them to return the same subtree for every deck
in the corpus — the sidebar's badge comes from one and the gallery's contents from the
other, and them disagreeing was a real bug two commits earlier.

### The three landings, newest first

**1. `app/` — the shell (stage 9).** Its own top-level directory with its own Vite
config, port 5274 beside the spike's 5273. `spike/` is THROWAWAY and `src/` has to stay
importable from Node, so the app is neither; Zach handed that call over. The worker owns
both databases (opfs-sahpool is worker-only and there is no SharedArrayBuffer without
COOP/COEP, which this app deliberately does not set), the page owns the DOM and the
object URLs.

**2. `prepareCard` / `mountPrepared` — `src/review` cut at the process boundary.** The
six-call order still exists in exactly one place; the seam is where the worker ends.
`PreparedCard` is structured-cloneable and a test proves it with a REAL
`structuredClone` over 300 cards / 1,079 sides — not a JSON round trip, which would drop
a function silently and turn `loaded.values` from a Map into `{}`.

**3. Decision 29 is BUILT, and `enter()` never had to change.** The trap this file and
CLAUDE.md both warned about — "implementing mode 2 means making `enter()` play, which
turns the mode-1 tests red for the right reason, and the wrong repair is relaxing them"
— did not happen. `loop.enter()` still plays nothing on any card, ever;
`mounted.enter()` asks the mode-2 question through `side.prompt()`, which unmasks
nothing. `src/review/mode.ts` owns the policy and `src/render/reveal.ts` still contains
no reference to `Reading` (a test asserts that literally).

### P1 IS DONE — the last unmeasured number in the project

The per-grade OPFS write, over 60 consecutive grades, timed INSIDE the worker so the
figure excludes `postMessage`:

```plaintext
min 20.2 ms · p50 37.3 · p90 61.1 · max 81.5 · mean 38.9    Chromium, desktop
```

A 443-card day is about **17 seconds** of write time in total. **Basis:**
`performance.now()` around `ReviewSession.answer()` — gradeTrack's reads, the `reviews`
INSERT, the `card_tracks` UPDATE and sqlite-wasm's own prepare (`WasmDb` prepares ~6
statements per grade and finalizes none: that is **P2**). One 1,563 ms outlier on the
7th grade of a cold database, not reproduced in 83 further grades; treat it as first-run
warmup until something reproduces it. **NOT measured on the handset** — his phone wrote
the corpus 1.44× faster than this machine, so expect quicker rather than slower.

### What is left, in dependency order

Struck-through rows moved to
[notes/archive/next-history.md](notes/archive/next-history.md) on 2026-08-26 — they were
finished work sitting in a table headed "what is left", which is the one place a cold
session looks to decide what to pick up.

| | what | state |
|---|---|---|
| **1** | **Run the app on his phone** | **The route is BUILT and MEASURED as of 2026-09-07** — `npm run phone`, one command, `https://node.tailed819e.ts.net/`, fixed hostname, tailnet-only, 200 + verified TLS + SQLite magic on both databases. What is left is him opening it: his handset has been off the tailnet for 10 days, and nothing about touch, the IME into 数字's answer box, or Android audio is verified on the real device |
| **2** | **Stage 11, sync** | The only STRUCTURAL blocker. He uses both devices — laptop to create, phone to review — and without sync they hold separate OPFS databases, so his stated workflow is impossible. Unspecified in shape. Decision 18: the TTS key never goes in the client |
| **3** | **The full report is still 81 s** | The DAILY dashboard is 1.25 s and is what the sidebar opens (`src/dashboard/glance.ts`). The four-year report is a button inside it, behind a confirm that states the cost. Its "obvious" optimisation was tried and is **5x slower** — see below before reaching for it again |
| — | Everything in [notes/zach-wants.md](notes/zach-wants.md) | **All fourteen carry working code.** That file is the WANT; this table is the state |

**Cleared 2026-08-26, in the same pass**, and listed because each was on this table
or in the "what I have to fix" list an hour before:

* **The `<input>` widget was inert.** `attachInput` had existed since stage 4 and
  nothing called it — the identical defect to the drawing field, on all 90 数字
  cards. Enter now reveals and says whether it matched; it does NOT grade, because
  decision 2's binary grade is his and a typo is not the app's call.
* **A card he made in the app was in no backup.** Schema **v9** adds `cards.local`;
  `src/backup/archive.ts` now carries those cards with their values AND their
  tracks, and restores them before anything that has a foreign key to them.
* **`npm test` exits 0 on a passing run.** `scripts/test-verdict.mjs` owns the rule
  and `gates.mjs` imports it, so the two commands cannot disagree about one run any
  more.
* **`app/` has real tests over its riskiest rule.** `app/review-keys.ts` is the key
  table as a pure function, `test/app-keys.test.ts` enumerates the STATES, and three
  injected regressions each turn a test red.

### THE PART OF `app/` STILL COVERED BY NOTHING

Worth naming precisely, because "app/ is tested now" would be false. Four modules of
pure logic are pinned — `keys.ts`, `review-keys.ts`, `review-boundary.ts`,
`deck-tree.ts` — and they are the rules whose failure is SILENT. What remains
untested is everything that needs a DOM: the painting, the worker RPC, the layer
stack, the undo stack, and every SQL statement in `db.worker.ts` (the file six of the
seven audited bugs lived in). Testing those needs a DOM environment — a new
dependency and a bigger decision than one session should make alone. The SEAM is what
this pass established: a pure rule in its own import-free module, tested from Node,
called from `main.ts`. Every future rule can follow it.

### WHERE THE DASHBOARD'S 81 SECONDS GO — measured 2026-08-26, not yet fixed

`collect` over the real corpus, timed per metric under better-sqlite3 in Node
(`build/probe-dash5.ts`, throwaway). Multiply by roughly 8 for sqlite-wasm on OPFS:

```plaintext
totals            all 1,269 ms   2026   886 ms
retentionByIntervalBothBases  620          380
activityByDay                 356          213
activityByMonth               372          224
retentionByDeck               137           84
longIntervalOutlook           567
activityByYear                265
deckProgress                   21
                              ────────────────
                              ~5.4 s of the measured 10.3 s total
```

**There is no hot query to fix.** `review_log` itself is 56 ms for all 102,020 rows,
and `deck_paths` — the recursive view it joins — costs 45 ms. The cost is roughly
**fourteen full passes**, each recomputing `date(datetime(reviewed_at, printf('%+d
minutes', tz_offset_minutes)))` per row, and `collect` runs the whole set TWICE (all
time, then calendar 2026).

### THE REPAIR THIS FILE RECOMMENDED IS WRONG. It was tried, 2026-08-26.

The paragraph that used to sit here said to materialise `review_log` into a TEMP
TABLE once per `collect` and point the metrics at it. **That was reasoned, not
measured, and measuring it falsified it:**

```plaintext
as shipped                        6,389 ms   458,141 chars
temp table shadows review_log    31,657 ms   458,141 chars   (+272 ms to build it)
```

Byte-identical output and **five times slower**. SQLite was already flattening the
view and pushing the date predicates down into indexed scans of `reviews`;
materialising it threw every index away and left fourteen full scans of a temp
table. The per-row date arithmetic was never the dominant cost, so removing it
bought nothing and cost the indexes.

It is left here rather than deleted because the reasoning was plausible and would
be re-derived by the next person to look at this. **The full report has no known
cheap repair.** What worked instead was not making it faster: see below.

### WHAT DID WORK — the daily dashboard, 81 s -> 1.25 s

Zach asked whether the "scientific dashboard" belongs on mobile at all, and
proposed simple-on-phone / full-on-laptop. The split is right; **the axis is not
device** — he reviews on the laptop too, and a laptop tab runs the same sqlite-wasm
in the same one worker, so the full report costs the same 81 seconds there.

`src/dashboard/glance.ts` is the split done by what the numbers are FOR. Two things
make it fast, both measured over the real corpus (621 ms -> 87 ms in Node,
7,174 ms -> **1,253 ms** in the worker):

1. **`substr(reviewed_at, 1, 10)` IS the local date.** `reviewed_at` is stored with
   its offset, so its first ten characters are already the local calendar date — no
   `datetime()` round trip, and `reviewed_at` carries an index (`reviews_when`), so
   a range on it is a seek. Checked against `review_log`'s own expression across all
   102,020 rows: **0 disagreements**, pinned by `test/glance.test.ts` including a
   non-Tokyo-offset case, because the corpus is entirely +09:00 and could not tell
   "the rule holds" from "every row shares one offset".
2. **One windowed query; today, the last 30 days, the last 14 and the streak are all
   derived from it in TypeScript.** Asking the database four times for four
   overlapping slices of the same rows was the actual cost.

It also skips `review_log` entirely, which joins `card_tracks`, `cards` and the
recursive `deck_paths` — and not one of these numbers is per-deck.

**Do NOT reach for a cache for the full report.** A dashboard that can go stale is a
dashboard that quietly reports yesterday, and the number he would act on is
today's.

### Three things RUNNING it found, which reasoning had not

Recorded here as well as in `app/README.md`, because the shape of each is reusable:

1. **The prompt boundary has to be POSITIONAL.** A first version took "every side up to
   the first one that hides or sounds something", and **the first card the real session
   served killed it**: a REVERSE track, order permuted to Meaning → Example → Vocab, whose
   Example side carries audio — so the rule pulled it into the question and the sentence
   *"time constraints make it impossible to do everything"* printed the answer above it.
   Reverse tracks are why the rule cannot be clever.

   **CORRECTED 2026-08-23, by Zach, and the correction is worth more than the finding.**
   I first wrote this as "a reverse *New Vocab* track", which implied his English deck
   reverses. It does not: `English/Vocabulary` resolves `reverse: off` on **1,226 of its
   1,234 cards**. That card (`oYjmEPwB`, `constraint`) has a live reverse track at 2 reps
   due **2023-03-03**. The bug and the fix are unaffected; what was wrong was citing a
   deck-level setting he had never turned on. The real support is `日本語/単語` and
   `日本語/漢字` — reverse on, all 5,357 cards.

   **AND 5,357 IS A SUBTOTAL, corrected by him again on 2026-08-23.** He asked whether his
   数字 deck exports in reverse; it does not (90 cards, 90 forward tracks, zero reverse
   tracks, zero reverse reviews), and checking it showed the figure had been quoted as if
   it were the whole corpus. **The total with reverse resolved ON is 5,676.** Only FOUR
   decks store it — 単語 3,702 · 漢字 1,655 · 言葉 146 · 文法 83 — four child decks inherit
   it (オノマトペ 41, 尊敬語 21, 謙譲語 17, ビジネス 2), and 9 cards carry
   `cards.reverse = 'on'` (8 in English/Vocabulary, 1 in 基本情報/第15章). Everything else
   resolves OFF, including 数字, 部首 and all of 基本情報. **`日本語` itself is `inherit`
   with no parent**, so the corpus default is off and reverse is opt-in per deck.

   **AND THOSE 9 ARE NOT 9 CHOICES OF HIS — corrected 2026-09-07**, when he said "im
   pretty sure this deck isn't reversed" and asked for `exports/English/data.json` to be
   read. He was right about the deck and this file was wrong about the cards: in the
   database all 9 read `cards.reverse = 'on'` and look alike, because **that column is
   where the importer's do-not-orphan rule lands**. Only the EXPORT keeps them apart —
   **3 carry `review-reverse? = True` (his, 14 reverse reviews each, most recent
   2026-02-14) and 5 carry no setting at all** (1-2 reverse reviews, newest 2026-05-07,
   the rest 2023-2024). A stray tap in Mochi, not a decision.

   The rule is right at corpus scale — it exists so 43,083 reverse reviews are never
   orphaned, and the database confirms it left no debt: **zero** cards anywhere carry a
   reverse track while resolving off. What it costs is five reverse tracks he never asked
   for, whose one old review makes them deeply overdue, so they sort to the FRONT of the
   queue: the first four cards the app served on 2026-08-26 were `constraint`, `extol`,
   one other, `irksome` — three of the five, each labelled REVERSED.

   **If they are unwanted the narrow fix is `dormant = 1` on those five tracks**, which
   retains the history and stops the scheduling (SPEC: no scheduling toggle may destroy
   four years of history). Do NOT put a review-count threshold on the import rule.
   It changes what he is DRILLED on, so it is his call (decision 31).
2. **Exactly one clip per reveal, or 単語 plays two at once.**
   `audioController.play()` defers extras only WITHIN one call. `ShadowingSide.reveal()`
   gained `{silent}` — unmask without sound, the safe direction.
3. **A reverse identify track is SILENT on entry, and that is CORRECT.** The clip is the
   ANSWER there. `promptsOnEntry` already had it right because it asks about the SIDE,
   not the card; the HINT was what lied. Pinned as a differential: same 40 cards,
   **40/40 forward ask, 40/40 reverse silent**.

> [!warning] **`git status` FIRST, always — and if you change the state, change this
> heading in the SAME edit.** It has been wrong in both directions in one day. It is a
> heading a cold session trusts before it has looked at anything.

---

## The record below this line MOVED, 2026-08-26

Everything that used to sit here — the reasoning, the landed-work notes, the superseded
"what to do next" framing — is now **[notes/archive/next-history.md](notes/archive/next-history.md)**,
byte-identical. It was 803 of this file's 1,057 lines.

It moved because this file opens by telling a cold session to read it in full, and three
quarters of that reading was a record rather than a state. The measurements in it are
still good and the traps in it are still live; it is filed under a path that says it is
a snapshot, which is what `notes/archive/README.md` exists to warn about.

**Read it when you want to know WHY something is the way it is.** Read the half above
when you want to know what is true now.
