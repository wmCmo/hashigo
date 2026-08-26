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
`tsc --noEmit` and cannot see a broken worker or sqlite-wasm URL. Re-run on this tree 2026-08-26: **`npm test` → 28 files / 823
passed / 1 skipped** (~97 s) · `npm run typecheck` → 0 · **`npm run app:check` → 0** ·
`npm run build` → OK, 77 modules, 27 export subpaths · `npm run spike:check` → 0 ·
`blobs … paths` → 0.

**`npm test` still exits 1 on a fully passing run — but the CAUSE was misdiagnosed for
months, and there is now one honest command.** It is not the reporter and not load:
birpc's RPC timeout is a hard-coded 60 s that vitest never overrides, `onTaskUpdate` is
an awaited call, and exactly the two files that run over 60 s throw exactly two errors,
every run. Cutting workers changed nothing; quieting the reporter changed nothing;
`--no-isolate` made it worse.

**`pool: "threads"` is NOT the fix, and it is recorded so nobody repeats it.** It
removes the RPC errors — and segfaults (exit 139, SIGSEGV) on the third run, because
`better-sqlite3` is a native addon and the suite loads it in six threads of one
process. Two green runs of it proved nothing, which is the lesson.

So: **`npm run gates`** decides the suite on its SUMMARY rather than its exit code —
a complete summary line and zero failures, or it fails. That is stricter where it
counts: a crash prints no summary and cannot pass, which is exactly what caught the
segfault. `npm test` alone must still not be chained on.

### THE SEVEN BUGS AN AUDIT FOUND IN `app/` — measured AND FIXED 2026-08-26

**ALL SEVEN ARE NOW FIXED** (2026-08-26). Kept in full rather than deleted, because
each one's SHAPE is the lesson and the list is the evidence for the structural finding
at the bottom. `git log` has the fix for each; the tests are named in the commits. Every line
below was re-measured against `build/hashigo.db` before being written here. **Three
were fixed** (the typing guard, the due-date timezone, and the gallery's misnamed sort
value — see `git log`); these are the ones left, and they are left because each needs a
decision about intended behaviour rather than a corrected predicate. Do not treat this
list as speculative: the numbers are real.

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
whole point of `app/deck-tree.ts`), so English shows "1258" and opens 0 cards, 日本語
shows "5947" and opens 3. Every deck with children is affected. Fixing it means a
recursive CTE over `decks.parent_id`, which `deck_paths` may already give cheaply.

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
| **1** | **Run the app on his phone** | The one thing that needs HIM. `npm run app:dev -- --host ::` plus a tunnel; the bind-address trap is in `app/README.md` |
| **2** | **Stage 11, sync** | The only STRUCTURAL blocker. He uses both devices — laptop to create, phone to review — and without sync they hold separate OPFS databases, so his stated workflow is impossible. Unspecified in shape. Decision 18: the TTS key never goes in the client |
| **3** | **The rest of stage 10** | Field editing SHIPS (`e`, from review or a preview, undoable). What it still owes is **template and field editing** (his #11) and **deck CRUD beyond archive/rename/create/delete** (his #14) |
| **4** | **Settings** (his #12) | Decision 12's new-card limit is called "a SETTING" and there is no surface for it. Recorded want, not an invisible gap |
| **5** | **The dashboard from the sidebar** (his #1) | The button exists and links out; he asked for it in the shell |
| — | Everything else in [notes/zach-wants.md](notes/zach-wants.md) | At least ten of the fourteen carry working code. That file is the WANT; this table is the state |

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
   1,234 cards**. That card (`oYjmEPwB`, `constraint`) is one of **8 per-card overrides**
   in the deck, with a live reverse track at 2 reps due **2023-03-03**. The bug and the
   fix are unaffected; what was wrong was citing a deck-level setting he had never turned
   on. The real support is `日本語/単語` and `日本語/漢字` — reverse on, all 5,357 cards.

   **AND 5,357 IS A SUBTOTAL, corrected by him again on 2026-08-23.** He asked whether his
   数字 deck exports in reverse; it does not (90 cards, 90 forward tracks, zero reverse
   tracks, zero reverse reviews), and checking it showed the figure had been quoted as if
   it were the whole corpus. **The total with reverse resolved ON is 5,676.** Only FOUR
   decks store it — 単語 3,702 · 漢字 1,655 · 言葉 146 · 文法 83 — four child decks inherit
   it (オノマトペ 41, 尊敬語 21, 謙譲語 17, ビジネス 2), and 9 cards carry a per-card
   override (8 in English/Vocabulary, 1 in 基本情報/第15章). Everything else resolves OFF,
   including 数字, 部首 and all of 基本情報. **`日本語` itself is `inherit` with no parent**,
   so the corpus default is off and reverse is opt-in per deck.
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
