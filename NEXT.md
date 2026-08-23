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

## STATE RIGHT NOW — 2026-08-23, tree clean, THE APP RUNS

**There is an app.** `app/` is a page, an OPFS database, audio on the device and grades
landing on disk. Measured end to end in Chromium over the real corpus: **7,716 cards,
102,020 imported reviews, a 531-card plan, reveal, grade, next.** Read
[app/README.md](app/README.md) before touching it — it carries three findings that only
came out of running it, and none of them was reachable by reasoning.

```bash
npx vite-node scripts/app-bootstrap.ts    # once
npm run app:dev -- --host 127.0.0.1       # local
npm run app:dev -- --host ::              # phone / tunnel
```

Gates, all six re-run on this tree: **`npm test` → 24 files / 757 passed / 1 skipped**
(~90 s) · `npm run typecheck` → 0 · **`npm run app:check` → 0** · `npm run build` → OK,
77 modules, 27 export subpaths · `npm run spike:check` → 0 · `blobs … paths` → 0.

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

| | what | state |
|---|---|---|
| **1** | **Run the app on his phone** | The one thing that needs him. `npm run app:dev -- --host ::` plus a tunnel; the bind-address trap is in `app/README.md`. Everything below can wait for it |
| ~~2~~ | ~~P2 — the prepared-statement leak in `WasmDb`~~ | **DONE 2026-08-23, and the estimate was HALF the real number.** Measured in the running app — the only place `WasmDb` is observable — at **12.07 statements per graded card**, not ~6: 30 grades left 365 open, so a 443-card day would have left ~5,350, each pinning the OPFS file. Fixed by caching one statement per distinct SQL string in `WasmDb.prepare`, not by making dozens of callers finalize (`SqliteHandle` is shared with better-sqlite3, where a statement needs no finalizing at all). **After: 0 growth — flat at 16 open / 16 cached over 19 consecutive grades, write time unchanged (p50 35.0 ms against 37.3).** The logic is extracted as `StatementCache` and tested in Node, because the dangerous part is not the count: it is `pluck()`/`raw()` surviving a cache hit, which returns the wrong SHAPE silently. Four injections, all caught |
| ~~2~~ | ~~Eviction detection~~ | **DONE 2026-08-23**, and verified against a REAL wipe rather than reasoned about: 187 local grades, `removeEntry('.opfs-sahpool', {recursive:true})`, reload → *"THE DATABASE WAS GONE. A receipt from 2026-08-23T13:15 says it held 187 local review(s)."* A receipt in `localStorage` (not in the database — a receipt inside the thing that went missing proves nothing; and `localStorage` does not exist in a worker, which is why this half is the page's). **It cannot detect a full site-data clear**, which takes the receipt too; no store survives that, and the honest fallback is the boot log. `?reset=1` landed with it — the route a schema bump needs, and it uses `removeVfs()` because a per-file `unlink()` frees NOTHING (0.0 MiB of 639.0 MiB, measured on his handset) |
| **1a** | **HIS SIX REQUESTS, 2026-08-23** | Verbatim in `notes/zach-in-his-own-words.md`, and they REPLACE the ordering below for anything UI-shaped. Summary: (2) a card link opens a MODAL over a dimmed background, never a navigation — that is how Mochi does it, and it **NESTS**: a link inside a modal opens another layer on top, indefinitely, and he says he likes that. Measured before designing it — 8,744 links from 4,335 cards, deepest acyclic chain 9, and **23 MUTUAL pairs**, so the stack can grow without bound on his real data and any depth cap is a design choice. **One question is his alone:** a layer mounts a card, and mounting is what fires the audio on the sound-is-the-question cards — should a linked card opened mid-review play?; (3) `e` edits every field of the card, in review mode and in that modal; (4) a progress bar at the top; (5) a SIDEBAR for creating cards and browsing a card gallery; (6) a label at the top of every REVERSED track. Plus (1), his correction, handled below. **He was low on tokens and deferred to 2026-08-26 — do not start these before he is back, because (5) is a whole navigation shell and (3) is stage 10 arriving early** |
| **2** | **Stage 10, the editor** | His request (3) is the first concrete spec it has ever had, and it is smaller than the stage: EDIT EACH FIELD, from review mode and from the card-link modal, on `e`. The measured precedent for field MOVES is the 132 rows below | `app/` ships one editor-shaped thing — decision 29's `Reading` toggle — because the audit loop dies without it. The rest is unspecified in shape. The measured precedent for field moves is the **132 rows** below |
| **3** | **Stage 11, sync** | Unspecified in shape. Decision 18: the TTS key never goes in the client |
| — | ~~P1's second half~~ | **DONE**, above |
| — | ~~The app shell~~ | **DONE** — `app/` |
| — | ~~Decision 29's conditional audio~~ | **DONE** — `src/review/mode.ts` |
| — | ~~`型`'s gating~~ | **DONE** — in the TEMPLATE, `scripts/accent-field-apply.ts` |
| — | ~~Decision 17's UI~~ | **DONE** — banner, one-tap export, and eviction detection |

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

## The record below this line is HISTORY, kept for the reasoning

Everything from here down was written while the shell did not exist. The measurements
are still good and the traps are still live; the "what to do next" framing is not. Where
a section says something is missing, check the table above first.

**Twenty commits landed 2026-08-22** — the scheduler's interval fuzz, the forecast tile
and heatmap tables, the cap/relearning derivations, the ratifications, the
browser-portability split, schema **v8**, a correctness sweep, and the dashboard in
English. `git log --oneline -20` is the list; do not rebuild any of it.

Gates, **all five re-run 2026-08-22 and all five green**, not repeated from a paste:
`npm test` → 23 files / 734 passed / 1 skipped, ~75 s · `npm run typecheck` → 0 ·
`npm run build` → OK, **76 modules**, 54 dist targets, 27 export subpaths ·
`npm run spike:check` → 0 · `blobs … paths` → 0, "NO absolute path … anywhere".

> [!warning] **`npm test` EXITS 1 ON A FULLY PASSING RUN, and the exit code is the thing
> that lies.** Both this file and CLAUDE.md said "that is Vitest's reporter RPC, not a
> failing test — read the pass count", which is correct and incomplete: the two
> `Timeout calling "onTaskUpdate"` unhandled errors are counted as `Errors 2` and the
> process exits **1** with `734 passed | 1 skipped` right above it. So "read the pass
> count" is not merely advice about where to look — it is necessary because
> `$LASTEXITCODE` is wrong. Anything that chains on `npm test` succeeding (a CI step, a
> pre-commit hook, a `;`-joined PowerShell line that checks the code) will report a break
> that is not there. Measured on the clean tree at `fdbb00c` with zero edits applied.

**THE CARD LOADER LANDED 2026-08-22** — `src/cards`, a card id in, a renderable card out,
24th export subpath, browser-portable and pinned as such. It is what joins
`hashigo/scheduler` to `hashigo/render`, and until now it existed only inside
`spike/viewer/`. Two things in it were found by measuring rather than reasoning: joining
`card_reverse_resolved` cost **23.42 ms/card against 0.30** (those two fields moved to
`cardContext`), and carrying `template_fields.options` as raw JSON produced **340,576
divergent requests** while the headline mount count stayed exactly right — so the type now
forbids it. `src/cards/README.md` has both.

> [!IMPORTANT]
> **A DECISION THAT IS NOT IN `CLAUDE.md` IS NOT RECORDED.** Zach keeps a planner in
> Obsidian; no agent reads it. Four settled decisions lived only there until today and one
> (`型` placement, now decision 20) was reopened by an audit as an "open question" weeks
> after he had settled it. If you settle something with him, write it into CLAUDE.md's
> numbered list first. There are 22 decisions; read them before proposing anything.

**THE DECISION QUEUE IS NO LONGER EMPTY — it has five items, and they are HIS, in his
planner** — **four** of them now, D2-D5. **D1 IS DECIDED: see decision 23, the review
screen is direction A2**, and the planner was updated on 2026-08-23 to say so. Historical note, because the
sentence below is what this file said for most of 2026-08-22: **D1 — what the review
screen looks like — is the only thing blocking the project.** Do not open by asking him
to re-decide anything else; the four he cleared earlier that day are below, and every one
is a settled decision in `CLAUDE.md`. Do NOT reopen these; the last session that assumed
one was open wasted a round:

* **The cap stays 365** — and it is now DERIVED, not inherited (decision 1). He reopened
  it himself, correctly: *"365 days was a default number from mochi flashcards … but I
  didn't derive it."* Two things fell out. Mochi **lifted its own 365-day cap on
  2026-02-22** and now plans to 2,707 days, so 365 was not even the source app's number.
  And the reason on record here — *"the longest gap observed is 454 days"* — was **wrong**:
  all 3,009 gaps past a year came from a plan of ≤ 365 days, so 454 is Mochi's cap plus
  his lateness, on the ELAPSED basis, used to justify a bound on the PLANNED basis. That
  is decision 6 violated by decision 1's own rationale. Corrected in `policy.ts`,
  `CLAUDE.md` and `BACKTEST.md`. **If you see 454 used as evidence anywhere, it is stale.**
* **Fuzz stays two-sided ±5%, after the cap, issued max 383d** (decision 11). Ratified,
  with the alternative on the table. The tension is recorded, not hidden: 383 is 18 days
  past the planned support. Do not "fix" it — fuzz-before-cap is inert and
  `Math.min(fuzzed, 365)` puts 52% of at-cap tracks back on one day.
* **No respread** (decision 14). 3,650 tracks share an interval, not a due date: the
  worst future day is **188 on 2027-01-03**, and he has already done more than that on
  six days, peaking at 229.
* **A forgotten card is shown again at the end of the session and NOT graded**
  (decision 13). This closes stage 7's last open question, so **stage 7 is now fully
  specified on the scheduling side.** Grading it would move the interval 3.50× / 0.173×
  off a branch calibrated on new-card data with zero post-lapse observations.
* **`（おす）雄` is kana-primary**, one ratified override on decision 10's rule. Final
  split 6 読み / 6 かな主流 / 1 意味.

**Zach runs a parallel session as a reviewer.** He hands work to one session and has
another verify it. If you are the builder: run the gates yourself, break your own tests
to prove they have teeth, and separate figures you regenerated from figures you are
repeating. That is not ceremony — of the last two sessions' reported fault injections,
two of four found nothing on the first try, and one report's central dichotomy did not
survive a width sweep.

## IF YOU WERE JUST TOLD "PROCEED" — READ THIS BEFORE PICKING ANYTHING UP

**As of 2026-08-22 there is no unsupervised work left.** Tables A, B's prerequisites and
the whole critical path (C1, C2) are done, and every remaining item needs Zach: the review
screen's shape, the design tokens on his phone, the `型` template edit, the audio
regeneration, the two handset runs. The tables below are kept struck-through as the record
of what was done and why, not as a queue.

**So the correct response to a bare "proceed" is to say that, and to offer him the
choice** — not to invent a task, and not to start stage 7 on your own judgement. His
planner's **D1** WAS the blocker and it is a taste decision about the screen he lives in;
an agent that designs it produces work he rejects. That has been written down three
separate times on this project.

Two things that ARE safe and useful without him, if he wants something done:

* **Verify rather than extend.** Re-run the gates, re-run a fault injection against a test
  you doubt, or check a number in a doc against the code. Three of the last two sessions'
  reported claims turned out wrong, and each was one command away from being caught.

**That lane was run on 2026-08-22 and it was not empty — it found three stale claims, one
of them load-bearing.** Recorded here so the next session knows the sweep happened and what
shape the misses take, because all three were docs drifting behind code that had already
moved:

1. **BACKTEST.md's Recommendation §3 was still giving the WITHDRAWN 454-day argument as
   the reason for the 365-day cap** — the exact basis error decision 6 forbids, in the
   section of a "live and current" document that a reader trusts most. `policy.ts` had
   already been corrected; the Recommendation had not. Its second half
   (*"365 keeps every interval the app issues inside the range"*) had also become plainly
   false, because fuzz-after-cap issues up to **383**. Corrected in place, with the
   withdrawn wording quoted so the correction is auditable.
2. **CLAUDE.md decision 16 said the re-import guard "needs a guard … cheap to build now"**
   when it had shipped in `0e04a10` with a test at `test/roundtrip.test.ts:550`. A cold
   session reading that decision would have rebuilt a guard that exists — the exact
   failure mode the "Built but NOT WIRED UP" heading was added to prevent, in the opposite
   direction.
3. **This file's own second gate block** carried 19 files / 672 passed / 67 modules while
   its first block said 20 / 697. Two gate blocks in one file disagreeing means one of
   them is a paste.

**The generalisable bit: every one of the three was a doc that had been correct when
written.** Nobody pasted a wrong number. The code moved and the prose did not, and in case
1 the stale prose survived precisely because the *same file* had been carefully corrected
elsewhere — the "THE 454 IS CENSORED" note is 200 lines above the Recommendation that
contradicts it. Grepping the retracted claim (`grep -rn 454`) is what finds this class;
reading the file top to bottom is what misses it.

He has cleared every open decision that is not in his planner, so **do not open by asking
him to re-decide something** — check `CLAUDE.md` "Decisions that are settled" and
"Ratified 2026-08-22" first, because the answer is very likely already there.

**Stage 6 — the scheduler — landed 2026-08-22.** `src/scheduler` grades a track, advances
its FSRS-6 state and answers what is due. `src/scheduler/README.md` has the four things
worth knowing before changing it; CLAUDE.md has the three that would have been
whole-subsystem defects if guessed. Today's queue is **443 due, 328 of them overdue,
3,980 new** — `npx vite-node src/scheduler/cli.ts -- counts --db build/hashigo.db`.

### The composed audio pipeline is now pinned at corpus scale

`resolve -> expand -> render`, the exact path stage 7 walks per card, had no
corpus-scale test: the field-slot sweep never renders, and `test/render.test.ts`'s
7,716-card sweep never calls `expandGeneratorFields`. Now pinned in
`test/generate.test.ts`. Basis: forward direction, the cards that have a template,
counting `GeneratorMount.name === "speech"`.

    pendingGenerators: true   6,855 speech mounts over 5,664 cards · expanded 10,722
    pendingGenerators: false     31 mounts                        · expanded 0

**Three things worth knowing.** `pendingGenerators` is load-bearing — a caller that
forgets it loses **99.5%** of the audio and sees no error, since the markers are
substituted away and only inline `<speech>` elements survive. `divergent` is **0**, which
`expandGeneratorFields` calls "the ONE way this module can go quietly wrong" and only
claimed until now. And the lookup is by field NAME: swapping it to `f.id` turns this test
and one unit test red.

**A note on how nearly this went wrong.** A first pass reported `expanded: 0` on a real
card and I almost recorded that as a finding. It was an artifact of probing ONE arbitrary
card with `LIMIT 1` — exactly **10 of the 7,716** templated cards carry no field values at
all, and that was one of them. A count taken from a single row is not a measurement.

### Table A — do these now, unsupervised. All decided, none need him.

| | what | why it is safe |
|---|---|---|
| ~~A1~~ | ~~**Interval fuzz, ±5%**~~ | **DONE 2026-08-22.** `INTERVAL_FUZZ` in `src/scheduler/policy.ts`, applied in `gradeMemory`, keyed on the track id. Every figure in decision 11 was regenerated by `scripts/fuzz-load.ts` and came back. **One thing needs his eye:** the fuzz had to go on AFTER the cap, so an issued interval can now reach 383 days — decision 11 has the measurement that forces it and the conservative alternative if he disagrees |
| ~~A2~~ | ~~The `復習予測` forecast tile on the dashboard~~ | **DONE 2026-08-22.** Bars for 30 days, zero JavaScript, with the table twin the page's own convention requires. It states whose plans it is charting — **8,853 Mochi / 0 Hashigo** today — because having a scheduler did not reschedule anything, which was the original reason the tile was blank. A test reconciles it against `queueCounts` day for day: 108 due at 2026-08-18 plus bars of 39+86+95+115 is the 443 the scheduler CLI reports for 2026-08-22 |
| ~~**A3**~~ | ~~Heatmap `<details>` table~~ — **DONE 2026-08-22.** Each year strip now carries a per-day table: 176 + 362 + 348 + 220 + 211 = **1,317 rows, exactly `activeDays`**. Zero-review days get no row on purpose — their tooltip says 学習なし and carries no number. `dashboard.html` regenerated (345 KB → 460 KB) and a test asserts the per-year sums, proven against two injected faults |
| — | ~~dashboard tag count filters `cards_direct > 0`~~ — **NOT A TASK.** There is no tag count on the dashboard (0 occurrences of タグ in `dashboard.html`), and the only tag count in the code — the importer's `20 tag paths` phase line — already names its basis. `tag_usage` already exposes `cards_direct`, and `test/roundtrip.test.ts:361` already asserts the filtered count is **19** and names `Dialect` as the childless ancestor. The trap is real; it is pinned. It becomes live again only when **B3** builds a tag sidebar |
| ~~A4~~ | ~~`読み` field + parse the 13 parenthesis cards~~ | **APPLIED 2026-08-22.** Zach green-lit it directly — and corrected the record: **he never asked to see the rows first.** That gate was invented by an earlier session and written into this file as a promise made to him. Final split **6 読み / 6 かな主流 / 1 意味**, zero unclassified. `scripts/reading-apply.ts --apply` creates the two local fields and writes the rows; idempotent and self-erasing. **No schema bump was needed** — a `template_fields` row is data, not schema. **Re-run it after any REBUILD** (see decision 9): the fields and values survive an ordinary re-import, but the 12 head words revert, because `name` is Mochi's field |
| ~~A5~~ | ~~Dashboard in English~~ | **DONE 2026-08-22**, commit `e506ead`. `src/dashboard/labels.ts` holds the table; English is the default and `--locale ja` renders the other. The Japanese is what PROVES it: the suite renders `--locale ja` and compares byte-for-byte against `test/fixtures/dashboard/ja.golden.html`, captured before the strings moved. Do not delete the Japanese, and do not wholesale-regenerate that fixture — a re-baseline should be a visible one-line diff with a stated reason, in its own commit |

### The critical path from here, in order

Table A is exhausted apart from A4, which is blocked on a schema bump. What is
left between the loader and audible audio, none of it needing Zach:

| | what | why it is next |
|---|---|---|
| ~~C1~~ | ~~The async cache key~~ | **DONE 2026-08-22, and it was NOT an async rewrite.** Three documents — `notes/archive/browser-feasibility.md` §5, the `KNOWN_NODE_BOUND` comment, and two session handoffs — said `node:crypto` → `crypto.subtle` was "the one genuinely invasive change" because `digest` is async and the key, the resolver and everything above them would change signature. **That reasoning was obsolete.** `src/blobs/sha256.ts` is a synchronous, dependency-free SHA-256 written for exactly this, already the default digest of `SqliteBlobStore`, already agreeing with `node:crypto` bit for bit on all 10,816 payloads — and its own header says so. So the key MOVED to `src/blobs/generation.ts` with one line changed and **no signature altered**. `src/generate/index.ts` is now in `BROWSER_ENTRY_POINTS` and `KNOWN_NODE_BOUND` is empty. Pinned: 36,398 distinct corpus identities, 32,465 of them non-ASCII, **0 differing digests**, plus three real keys as literals |
| ~~C2~~ | ~~The audio resolver's second half — hash → bytes → `blob:` URL~~ | **DONE 2026-08-22.** `cardAudioResolver` in `src/cards/audio.ts` is the `AudioResolver` that `src/render/audio.ts` has always taken. Measured end to end over 400 real cards: **373 speech mounts → 361 addressed → 361 payloads read → 16.2 MiB of `audio/mpeg`** out of the store. Both facts honoured — the card id comes from the closure (a test proves the same `ref_key` against another card resolves to null), and the inline split is by PAYLOAD not by kind, since `file` and `image` are out-of-line too |

**So the whole path from "what is due" to "these bytes" now exists in `src/`** — and as
of 2026-08-23 so does everything above it: the session (`src/session`), the card mount
(`src/review`, which calls `play()` on the reveal over real cards) and decision 17's
backup (`src/backup`). **B1 is no longer Zach's and no longer the screen — it is the
SHELL**, and its shape is the one thing left. The two runs needing his handset — the
625 MB fill and the per-grade OPFS write — the FILL is now measured on device
(**181 MiB/s**, see "First on-device result"); the per-grade write is not.

### The session layer landed 2026-08-22 — so B1 is now only the screen

`src/session` is the state machine between `hashigo/scheduler` and the screen: it
builds the plan, interleaves new with due, and implements **decision 13** — a forgotten
card comes back at the end and is **NOT graded**. 25th export subpath, browser-portable
and pinned as such, 18 tests, read-only CLI at `src/session/cli.ts`.

Measured against the real corpus at 2026-08-22: **443 due + 10 new = a 453-card plan**,
deterministic (two builds at the same instant are identical), and due/new provably
disjoint.

**Two things in it were found by breaking it, not by reasoning**, and both were dead
code I had written myself — a `Set` meant to enforce "one re-ask per track" and a
collision walk in the `spread` slot arithmetic. Deleting either changed **zero** tests,
because termination actually comes from `answer()` returning early on a re-ask, and slot
collisions are provably impossible (90,000 pairs swept, zero found). Both removed.
`src/session/README.md` has the full injection table, including the uncomfortable one:
**the totality test passes with the slot formula completely broken**, so `spread is EVEN`
is the test that owns the formula.

**SETTLED 2026-08-23: the order is `spread`, over a window of 80.** Zach chose
`spread` — warm up on cards he knows rather than open on ten he has never seen, which
is the right call for a shadowing drill. The WINDOW is the implementation half and it
is not optional: spread across the whole 453-card plan he would see **two** of his ten
new cards before stopping, because 443 due against ~69-78 reviews a day means he never
finishes. Windowed to 80 he sees all ten, still never adjacent, with four due cards as
warm-up first.

    stopping after card             50    80   100   150
    spread over the whole plan       1     2     2     3
    spread over a window of 80       6    10    10    10

`EXPECTED_SESSION_CARDS = 80` is derived, not round: just above both measured bases for
his sustained load (77.5/active day, 69.2 on `BACKTEST.md`'s basis). It is a setting.
`due-first` remains available and remains a **defect** — the ten are never reached.

**Decision 25 landed with it:** new cards carry a `New Card` label and it is **per
TRACK**, from how Mochi does it. Watch the terminology — he said "per side" meaning per
DIRECTION, and "side" means something else in this repo (the parts of a card). It needs
no new state: `SessionItem.origin` is already per-track.

### `src/review` landed 2026-08-22 — `play()` is called, over real cards

`mountCard` is the whole path in one call: `loadCard` → `renderLoadedCard` →
`expandGeneratorFields` → `renderSides` → `audioController` → `shadowingLoop`. 26th
export subpath, browser-portable and pinned.

**It is the first thing in `src/` to drive `shadowingLoop`, the reveal loop that
ships**, and that closes a gap `spike/viewer/README.md` named itself: that harness
hand-rolls `revealSide()`/`armSide()`, so its green no-autoplay panel was evidence about
Chromium and never about the shipping code. Measured now, over the corpus:

    mount + enter, 120 単語 cards   120 clip mounts · 0 resolve calls · 0 play() calls
    reveal, 40 単語 cards            39 cards played · 39 play() calls

Teeth, with the exact mutation used on 2026-08-20: `audio?.play(side.audio)` inside
`enter()` turns **2** of the new tests red — printing *120 resolve calls, 119 play()
calls* — plus **9** in `test/reveal.test.ts`. 39 of 40 is not a miss: 35 slots in the
corpus were never generated and 159 are unbuildable, so some cards have no clip and the
session simply continues.

> [!warning] **A SHARP EDGE WORTH KNOWING BEFORE YOU WRITE THE SCREEN.**
> **`loadRenderedCard` cannot reach the audio, and it is the documented entry point** —
> it is the example in `src/cards/README.md`. `expandGeneratorFields` needs the template
> FIELDS and card VALUES, and `loadRenderedCard` returns neither. Follow that example and
> you get a card that renders perfectly and is **silent**, with no error, on all 5,664
> cards carrying speech. Use `hashigo/review`, which does it correctly, or replicate all
> six steps.

### `src/backup` landed 2026-08-23 — decision 17's mechanism, not its UI

**332,262 bytes** over the real corpus, against a 74 MB database and a 617.9 MiB blob
store. It archives exactly what `exports/` cannot rebuild: local reviews, the scheduling
state of any track that has one, decision 9's local fields and their values, and
settings. Everything else rebuilds in fifteen seconds.

**It archives ROWS, not the file**, because a binary SQLite copy is only restorable into
the schema version it came from and `applySchema` refuses any other — so a bump would
strand every older backup, and `SCHEMA_VERSION` has moved eight times.

**The key is `(card_id, kind)`, never `track_id`.** `card_tracks.id` is a rowid alias
handed out at insert time; after a rebuild it is whatever the insert order gives. It
would very probably come out identical, **which is worse than if it obviously did not** —
an id-keyed archive restores cleanly, reports success, and attaches his history to the
wrong cards. The test builds the destination with the cards inserted in the opposite
order so the ids genuinely swap; simulating an id-keyed resolve turns 3 tests red and
says `card_id: 'cardB'` where `cardA` was expected.

**Two defects found by testing, not reasoning**, both mine and both fixed:
`template_fields.pos` is a fractional-index TEXT (`'ab'`, `'ac'`) and `Number(pos)` was
writing NaN; and a single deleted card made the whole restore throw
`FOREIGN KEY constraint failed` — losing the archive at the one moment it is the only
copy — because `card_field_values` has an FK to `cards`. Orphans are now probed and
counted, never fatal. This corpus has **8,958 tombstones**, so it would have happened.

> [!warning] **The UI half of decision 17 is NOT built and belongs to the shell.**
> `notes/archive/persistence.md` prescribes a persistent, non-dismissible banner when
> `persisted()` is false, an "add to home screen" prompt beside it, and detection of an
> eviction that already happened. Nothing calls `exportLocalArchive` from a screen.

### FIRST ON-DEVICE RESULT — 2026-08-23, and it changes one prescribed UI element

Samsung Internet 30 / Chrome 143 / Android, over the ngrok HTTPS tunnel, at `/persist/`.
The first hardware data this project has had; every persistence figure before this was a
desktop profile.

```
persisted(): true          persist() granted: true       quota: 133.96 GiB
secure context: true       crossOriginIsolated: false    OPFS usage: 66.5 MiB
installed (display-mode): no (browser tab)
worker can request persistence: NO — persist is Window-only
sqlite 3.53.0, schema version 8
```

**The finding: persistence was granted in a PLAIN BROWSER TAB, not installed.** The
existing record says `persist()` granted and 133.96 GiB quota — but *installed and
standalone*. So "add Hashigo to your home screen" is not the precondition for durable
storage that `notes/archive/persistence.md` §1.5's table assumes it is, at least on this
device. And 66.5 MiB survived a reload with `persisted()` still true.

> [!warning] **DO NOT conclude that decision 17's banner can be skipped.** Chromium grants
> `persist()` off site engagement, and this origin had a day of repeated loads behind it
> (the mockups). **The real app's origin starts with zero engagement**, so a first launch
> may well be denied where this was granted. What is measured is that the DEVICE will
> grant it — not that it grants it immediately. The banner and the eviction detector are
> still worth building; what drops in priority is the "add to home screen" prompt, since
> install is demonstrably not required.

**Confirmed on hardware, previously desktop-only:** `navigator.storage.persist` is
`undefined` in a Worker and absent from `StorageManager.prototype`, so calling it throws.
`persisted()` and `estimate()` DO work there. **The shell must request persistence from
the Window**, not from the OPFS worker — an architectural constraint, not a detail.

#### The fill, on device — and the phone BEATS the desktop

Run the same day, same page, after `open the database`:

```
10,816 external blobs, 624.6 MiB total, largest 3,374,905 B, mean 60,551 B
INSERTED 10,816 blobs / 624.6 MiB in 3.4s = 181 MiB/s, 0.32 ms/blob
readback 10,816 rows / 624.6 MiB · 50 random reads avg 0.21 ms
usage 75.5 MiB -> 714.5 MiB · 0.52% of a 133.96 GiB quota
```

**181 MiB/s against 126 MiB/s for the SAME harness on desktop**
(`notes/archive/persistence.md`: 4.9 s / 126 MiB/s / 0.46 ms/blob). His phone is **1.44×
faster** than his own machine at writing the corpus into OPFS. Within the 25–248 MiB/s
band recorded across three desktop environments, but above every one of his own runs
(96 MiB/s cold, 111 warm on `/blobstore/`). Random reads land at 0.21 ms, inside the
0.13–1.06 ms desktop range.

**It scales linearly** — 2,000 rows at 548 ms, 4,000 at 1,104, 6,000 at 1,697, 8,000 at
2,289, 10,000 at 2,903. No degradation as the file grows, which is the thing a 625 MB
write could plausibly have failed at.

**And the corpus is intact in OPFS on the phone**: the oracle MATCHES — 7,716 cards,
102,020 reviews, 58,937 forward, 43,083 reverse, retention 96.24, 39 decks, 19 tags,
8,744 card_links — reattaching (not re-importing) in **32.7 ms**.

**CONFIRMED, not discovered:** `unlink()` returned **0.0 MiB of 639.0 MiB**. That is
byte-for-byte the desktop result already in `notes/archive/persistence.md` §2.5 —
`SAHPoolUtil.unlink()` disassociates the name from its pool slot and leaves the file, so
only `removeVfs()` frees anything. Now confirmed on hardware. **Anything that deletes
audio must not be built on `unlink()`.**

**So P1's first half is DONE.** What remains unmeasured is the **per-grade OPFS write** —
`gradeTrack`'s own cost (an INSERT into `reviews`, an UPDATE to `card_tracks`, the reads
before them, and `WasmDb`'s ~6 prepared statements per grade). That is a different
instrument and it does not exist yet.

**A transport trap found while setting this up**, worth keeping: `/blobstore/`'s
`readPack` STREAMS the 655 MB pack and writes into OPFS as it arrives, so over a tunnel it
measures ngrok with OPFS hidden inside. `/persist/`'s `fill` generates its bytes locally
at the real blob sizes, which is why it is the valid instrument over any transport.
Getting `/blobstore/` to produce a valid on-device number needs its write timing separated
from its fetch — small, not yet done.

### STARTING THE SHELL — read this first, most of it already exists

B1's remainder is the app shell, and the reason to write this down is that **the two
hardest parts are already solved in `spike/`**, which is labelled THROWAWAY and therefore
easy to skip past. Do not rebuild them; do not copy them wholesale either.

**Reuse the mechanism, not the code:**

| already works | where | what it gives the shell |
|---|---|---|
| a real SQLite database in a Worker, over OPFS | `spike/viewer/cards.worker.ts` | the worker holds BOTH databases and every SQL statement — the shape the shell needs, because OPFS sync access handles require a worker |
| `persist()` granted, manifest, service worker, installed | `spike/persist/` | 133.96 GiB quota, standalone. The PWA shell question is answered |
| the 625 MB transfer | `spike/blobstore/` | 10,816 payloads rehashed to their own address, audit clean. Missing mid-stream resume — and its OWN on-device run, which is NOT the same thing as the 2026-08-23 phone result: `/persist/` measured the write pattern at real blob sizes with locally-generated bytes, while this page writes the REAL payloads and rehashes them. The throughput question is answered; the real-payload + verify pass on device is not |
| a BOUNDED audio subset | `spike/viewer/make-viewer-db.ts` | 32 MiB instead of 617.9. **Start here** — the full transfer is a separate, measured step (P1), not a prerequisite |

**What is genuinely new** is smaller than it looks: hosting a page, mounting
`src/review`'s output inside the A2 chrome, wiring two buttons to `src/session`'s
`answer()`, and decision 17's banner. The pipeline underneath is done and pinned.

> [!warning] **Four traps, each of which has already cost someone time.**
>
> 1. **Do NOT copy `spike/viewer`'s reveal sequencing.** It hand-rolls
>    `revealSide()`/`armSide()` and its own README says so. `src/review` drives the loop
>    that SHIPS (`shadowingLoop`) and is measured over real cards. Use it.
> 2. **`loadRenderedCard` cannot reach the audio** — it is the documented entry point in
>    `src/cards/README.md` and it returns neither the template fields nor the card values
>    `expandGeneratorFields` needs. A card mounted that way renders perfectly and is
>    SILENT on all 5,664 cards with speech, with no error. Use `hashigo/review`.
> 3. **A LAN IP is not a secure context**, so OPFS and `persist()` behave differently
>    there than on `localhost` or over the tunnel. `notes/archive/persistence.md` §1.6
>    calls this "the single most expensive thing to discover late" and measured it.
> 4. **`npm run spike:dev -- --host ::`, never `--host 127.0.0.1`**, for anything reached
>    from the phone or a tunnel. IPv4-only binding makes ngrok return 502, because it
>    resolves `localhost` to `::1` and does not fall back. Cost a round trip on
>    2026-08-23.

**The one structural call, which Zach delegated** (*"this is `how`, and I'm trusting you
on `how`"*, 2026-08-23): where the app lives. `spike/` is throwaway and `src/` is the
library, so neither is right — it wants its own top-level directory with its own Vite
entry. That is a judgement, not a decision of his; make it and write down why.

### Table B — do NOT start these without him

| | what | why |
|---|---|---|
| ~~**B1**~~ | **Stage 7 — Review UI** — **UNBLOCKED 2026-08-22** | The taste question is answered: **decision 23**, direction A2. It is no longer "do not start without him" — it is the next thing to build, against a written spec. What exists is a MOCKUP in `build/mock/out/` (three directions plus the chosen A2), served at `/mock/` by `vite.config.ts` middleware; it has no scheduler, no grading and writes nothing. The build is wiring `hashigo/scheduler` → `hashigo/cards` → `hashigo/render` behind that layout. Two constraints, both non-negotiable: **audio fires on cloze reveal, NEVER on side entry** (`src/render/reveal.ts`, and the autoplay section of CLAUDE.md), and the keycap hints must stay behind `@media (hover: hover) and (pointer: fine)` rather than any hover affordance — decision 19 is why. Decision 23 lists what it does NOT settle; do not decide those for him |
| **B2** | Design tokens → `spike/viewer/` | 3 named fixes exist in `notes/design-tokens.md`, but he judges the result on his own phone. Propose, do not decide |
| **B3** | Nested-tag sidebar · Ctrl+K palette | query layers are done; the UI is taste |
| **B4** | Stage 10 Editor · Stage 11 Sync | both large, both unspecified in shape. **One stage-10 decision already has data behind it:** decision 21 makes fields MOVABLE between templates from the UI, and this corpus shows what Mochi's own version of that move does — it **orphans** the old values rather than migrating or clearing them. **The evidence is 132 rows, not the importer's 235**, and the difference matters: of 235 orphaned values, 143 are on a card that HAS a template (92 are on cards with no template at all, so nothing was moved off anything), and of those 143, **132** name a field declared on some OTHER template while 11 name a field on no template at all. Only the 132 is field-move evidence. It breaks into **27 distinct `holder ← source.field` pairs across 6 templates** and sums to exactly 132. **A TRAP if you re-derive this:** `template_fields.id` is NOT globally unique — 35 distinct ids over 47 rows, and `name` alone is on 10 templates — so joining `template_fields ON f.id = v.field_id` DUPLICATES rows and mis-attributes the source template. It is safe for the 132 only because every one of those has a field id on exactly one template; all **54** ambiguous orphan rows sit on cards with no `template_id` at all, i.e. inside the excluded 92. Filter on `(SELECT count(*) FROM template_fields WHERE id = v.field_id) = 1` or the attribution is fiction. 文法 holds orphans and sources none — a bare join says it sources 54, which is this artifact. **The shape is what matters, not the total: `意味` moves in BOTH directions** (10 単語 cards hold 言葉.意味, 7 言葉 cards hold 単語.意味), and so do `Reading`/`Reference` between 単語 and 漢字/New Vocab. So the editor is not facing "cards drift outward from 単語" — it is facing arbitrary pairwise moves, 27 combinations of which already exist. "What happens to the old value" is a decision with a measured precedent, not a blank. The SHELL (stage 9) is no longer in this table — see "Starting the shell" above; Zach handed the "how" over on 2026-08-23 |

### ~~The one stage-7 question still open~~ — CLOSED by decision 13

**Should a forgotten card come back before the session ends?** `clampInterval` already
floors a lapse at one day, so this is a session-buffer question, not a scheduling one.
The other one is **answered**: new cards default to **10/day and are a SETTING** (CLAUDE.md
decision 12), which is Mochi's default and what he wants kept. At 10/day the 3,980 waiting
take ~398 days, so it is the dial that decides how fast the backlog moves.

### Before you report back

He reviews what comes back and he re-runs the numbers. So: **run the gates yourself,
break your own tests to prove they have teeth, and say which figures you regenerated
versus which you are repeating.** Two of today's four reported fault injections found
nothing on the first try and had to be strengthened — that is the standard here, not a
formality. If a claim of yours turns out wrong, say so plainly; that has happened to
every session on this project including the ones that did good work.

## Built but NOT WIRED UP — the opposite trap

### D3 APPLIED 2026-08-23 — 型 is on the cards, かな主流 is not

`scripts/accent-field-apply.ts` created the `型` field (`type = 'accent'`,
`source_field_id = 'name'`) on 単語 and 言葉 and inserted `<< 型 >>` above `<< Speech >>`
in both bodies. `accent/cli.ts write` then **wrote 3,830 labels** — 平板 2,092 · 中高 907
· 頭高 775 · 尾高 56. That 尾高 share is 1.46%, which matches the 1.4% ratio the pipeline
pins, so the two agree. 15 guarded (ambiguous, left empty on purpose) and 13 underived.

**It was never Zach's edit to make.** `templates.content` is a column in this database;
an earlier session said "only he can do this, it is in his Mochi templates", confusing
"the template came from Mochi" with "the edit must happen there". Editing it in Mochi
would be worse: Mochi has no `型` field, so `<<型>>` would render unresolved **in his
daily reviews**, which he is still doing ~100 of a day.

**RE-RUN IT AFTER A REBUILD.** `templates.content` is Mochi's field, so decision 9's
`local = 1` cannot protect it — that flag protects a field we ADDED, never an EDIT to
something Mochi owns. It is idempotent and self-erasing; CLAUDE.md lists it in the
rebuild sequence beside `reading-apply.ts`.

Measured before writing, because an unresolved field renders as VISIBLE TEXT: a declared
field with no value substitutes the empty string, so the ~2,000 cards with no derived
accent render nothing rather than a literal `<<型>>`. A section gate also works and is
not needed. `かな主流` DOES need its gate — it is a boolean, and bare interpolation is
measured to fail.

> [!important] **ALL OF D3 IS ANSWERED as of 2026-08-23** — decisions 26, 27 and 28.
> One of the three was first diagnosed WRONG here, and the last one Zach answered by
> correcting his own first answer, so the route is recorded as well as the verdict.
> Corrected by a peer review 2026-08-23; verified before recording.
>
> **1. ANSWERED — `言葉` displays as inputted, so it renders nowhere (decision 28).** The
> diagnosis below was also not the reason first written here.
> This file used to say the six `かな主流 = true` cards "have `Reading` unset" so the gate
> fires for nobody. What is actually true: **all six are on 言葉**, which declares no
> `Reading` field at all and whose body contains neither marker, while the marker was
> authored into 単語 where no card carries the flag. **The flag and the gate are on
> different templates.** That removes one of the two options previously offered — you
> cannot set `Reading = true` on a card whose template has no such field.
>
> **AND THE OBVIOUS FOLLOW-UP HYPOTHESIS IS DEAD, checked card by card.** "Those six
> migrated from 単語 and were left on the wrong template" is the natural next guess, and it
> is wrong: all six (`NpDWVYgm`, `Ufs9lMJR`, `XVucJVhx`, `e6lbPHIS`, `f9UT7D6f`,
> `vim2i4A9`) carry **zero** undeclared field values. A card that moved templates leaves
> its old values behind — 15 言葉 cards carry an orphan 単語 `Reading`, and one of those is
> the 693rd row — but **none of the six is one of them.** They are natively 言葉, and the
> flag was authored there on purpose.
>
> **So the question is narrower than either of us first wrote it:** not "are these cards
> on the wrong template" but **"should 言葉's body render `かな主流`?"** That is answerable
> in one line of template. Killed explicitly rather than left implied, so nobody spends a
> session on the migration theory.
> (**The count is a BASIS SPLIT, not an error** — decision 6 applied to a field count.
> **693** rows carry `Reading = true`; **692** of them are on a card whose own template
> DECLARES the field, and only those can render. This sentence is about what renders, so
> **692 renderable / 693 rows** is the honest form. A first version of this note said "the
> review said 692; 693 is right", which was the wrong way round: for the question being
> asked, 692 was the better number.)
>
> **2. ANSWERED — and it was never a taste question.** `型` is on screen at SIDE ENTRY, before any reveal, on both templates. It is not
> inside a cloze. Decision 20 keeps it off side 1 because that "would hand him the thing
> he is meant to produce" — side-2-*entry* has the same property, so naming the side does
> not deliver what the decision wanted. **A2 ALREADY ANSWERS IT:** in
> `build/mock/out/a2-terminal.html` the label sits inside `<div class="answer">`, which is
> `display:none` until `[data-state="revealed"]`, beside `.reading` and the `.contour`
> boxes; only `.head` (the kanji) shows at prompt time. So the intent was settled by
> decision 23 and the gap is between the MOCKUP and the TEMPLATE — the mockup is
> hand-authored HTML that never went through `src/render`, while `<<型>>` in the body sits
> outside any cloze and renders bare. **The real screen must gate the accent field into
> the answer region** (or the body must wrap it in a cloze). Implementation, not taste.
>
> **3. ANSWERED — side 1 is correct.** `型` lands on SIDE 1 for the 376 言葉 cards,
> because `___` is a rule WITHIN a side and 言葉's first `---` comes after `<<Speech>>`.
> `DECISIONS.md` says side 2 and grounds it on the 単語 template, so the placement does
> not transfer. **Zach confirmed it rather than corrected it, 2026-08-23 — see decision
> 26.** Decision 20 stands unchanged for 単語.
>
> **4. ANSWERED, and it raised a build constraint — see decision 27.** Asked whether the
> A2 contour should render a trailing particle box, since 平板 and 尾高 are identical
> inside the word and differ only on the following mora (花が vs 鼻が). **No:** *"don't add
> particle to my word, the word stays the word."* The consequence is load-bearing rather
> than cosmetic: with no particle in the audio (already settled) and none in the boxes,
> **`型` is the SOLE carrier of 平板-vs-尾高 on 2,092 + 56 = 2,148 of 3,830 labelled
> cards.** 頭高 (775) and 中高 (907) are audible bare and the boxes draw them. So the
> layout may never drop the label to save space — on those 2,148 cards it is the whole
> exercise, the same shape of failure as autoplay.
>
> **NOTHING IS LEFT OF THE THREE.** `scripts/accent-field-apply.ts` declined to invent a
> home for `かな主流` on 言葉 and says so; decision 28 confirms that was correct — the
> field stays stored (decision 9) and renders nothing.
>
> **WHAT REPLACED THEM, AND THE FIRST ONE IS THE BIGGEST THING IN THIS FILE.**
>
> **A. THE HARD RULE IS NOW CONDITIONAL — decision 29, settled 2026-08-23.** Audio
> autoplays on entry for the **3,177** `Reading`-not-true cards and stays reveal-gated for
> the **692** `Reading = true` ones, and `型` follows the same switch — visible on entry
> where the audio plays, gated where he is recalling it, because that is how he spots an
> accent he had wrong.
>
> **CORRECTION, 2026-08-23 — I FIRST WROTE THAT THIS NEEDED A SECOND SCREEN DESIGN FROM
> ZACH. IT DOES NOT, AND HE CORRECTED IT.** *"i don't need to see screens with auto play
> audio, it should be the same, and it should render conditionally from my template."* The
> template already encodes the whole difference: side 1 is EMPTY when `Reading` is false
> (its body is inside `<<#Reading>>`, so the screen starts at side 2) and side 2 carries
> **two** clozes instead of one. **One screen, rendered from the template.** See the
> READ THE TEMPLATE section of `CLAUDE.md` for the rendered proof of both states.
> The mockup's always-visible `.head` is a hand-authored artifact of
> `scripts/mockup-html.ts`, not something the real render produces — the mockup is a spec
> for the LOOK, never for the structure. What IS still real work: the audio and `型`
> conditional (below), and the fact that no test yet covers the `Reading = false` arm.
>
> **B. THE REVIEW SCREEN MUST FLIP `Reading` ON THE CURRENT CARD.** New requirement out of
> decision 29 and not covered anywhere in stages 7-10. His loop is: hear the audio, see
> `型`, realise he had the accent wrong, and promote the card to `Reading = true` there and
> then. Without an in-review toggle that loop requires leaving the app mid-session, which
> means it will not happen. It is one boolean on one card, but it is the mechanism the
> whole accent pipeline feeds.
>
> **C. HIGHEST-VALUE CARDS TO AUDIT FIRST: the 56 尾高.** 尾高 is the category he did not
> know existed, so those are where the discovery loop pays out — **44 are in mode 2** (he
> will meet them as the queue surfaces them) and **12 are already mode 1**. Also worth
> knowing: 772 mode-2 cards are 中高 or 尾高, which is the measured cost of the mode-2
> trade-off (decision 29 has the table).
>
> **D. `言葉` HAS NEVER BEEN MOCKED UP.** A2's four
> cards are `裸足`, `捜査`, `係数` and `取り戻す` — all 単語/基本情報, no 言葉 among them.
> And `言葉` is structurally different: its side 1 is `{{<<言葉>>}}`, so **the head word
> itself is the cloze**, whereas 単語 shows the kanji and clozes the READING. With 型 in
> the answer region (A2) and the word masked, what the PROMPT side of a 言葉 card shows
> has never been drawn. 392 cards. Decision 23 settled the 単語 screen; it did not settle
> this one, and nobody should infer it.

### The older note, kept because the shape of the trap is the lesson

**`<<型>>` had never been written to a card.** `materialiseAccents` iterates
`template_fields WHERE type = 'accent'`, and there were **zero such rows** — so it had been
a no-op every time it has run, reporting 0 written, which reads as "nothing to do". The
3,850 derived accents sit in the `accents` table unused. It needs one field row per
template plus a `<<型>>` reference in the template body; the body edit is Zach's (**D3**).
`src/accent/README.md` has the detail.

Worth stating as its own heading because the section below is about not rebuilding what
exists — this is the mirror: something that exists, passes its tests, and does nothing.

## Already built — do NOT rebuild these

Moved out of Zach's planner 2026-08-22, because no agent reads that file and this is
exactly what an agent needs before it "finds a gap". A 33-agent audit produced 96 gaps and
**16 of the top 24 were refuted**; these are the refutations that keep mattering.

— do not rebuild

* **The 625 MB phone transfer** — `spike/blobstore` did it: 10,816 payloads /
  654,917,364 bytes, all rehashed to their own address, audit clean. Missing only
  mid-stream resume and its own on-device run. **Not superseded by the 2026-08-23 phone
  fill:** that measured the write pattern with generated bytes, this writes the REAL
  payloads and rehashes each one. Throughput is answered; real-payload verification on
  device is not.
* **A PWA shell** — `spike/persist/` has a working manifest + service worker, installed on
  your phone: `persist()` granted, 133.96 GiB quota, standalone.
* **The lazy FSRS seed being a phone cost** — measured at **52.6 ms** for the whole
  443-card day, with 100% of them taking the replay branch.
* ~~**A card loader / an audio resolver existing nowhere**~~ — both half-existed and ran in
  a real browser; **both are now real modules in `src/cards`** (B1, B3 above). The audit's
  refutation was right and it aged into "so finish it".
* **Stage 10 having no mutation layer** — 12 write statements already exist outside
  `src/import`, and `db.transaction()` exists on both handles.

### Biggest unmeasured surface — half of it is now measured

`src/db/browser.ts` had **733 lines and zero automated coverage**. Its SYNCHRONOUS half is
now covered — the part that stamps `user_version` and refuses to half-migrate, i.e. the
part that can brick a file. Nine tests, over the real DDL, via the `SqliteHandle` interface
that better-sqlite3 also satisfies. The best of them asserts the SOURCE declares no
`SCHEMA_VERSION` literal: two literals that AGREE in value pass an equality check, which is
exactly the state that module sat in for five schema versions.

**Still unmeasured, and honestly so:** the async half needs sqlite-wasm and OPFS, so
`openDatabaseBrowser`, `installPool` and the import/delete paths are exercised only by
`spike/persist` on your actual phone. Also unrun: the prepared-statement leak in `WasmDb`
(~6 per grade, ~2,700 in a 443-card session), whose own docstring says an unfinalized
statement makes `pauseVfs()` throw.

## Where things are written down

| I want… | read |
|---|---|
| **THE APP — how to run it, and the three things running it found** | [app/README.md](app/README.md) |
| **which exercise a card runs, and the two traps in deciding it** | `src/review/mode.ts` — decision 29 |
| **the session layer: the queue, and decision 13's re-ask** | `src/session/README.md` — including the two pieces of dead code injection found |
| **the card mount, and the first real-browser evidence for the shipping reveal loop** | `src/review/README.md` |
| **decision 17's backup: what it archives, and why not the database file** | `src/backup/README.md` |
| **the chosen review-screen direction, and why** | `DECISIONS.md` decision 23 — the mockup at `/mock/` is a spec for the LOOK only; the built screen is `app/` |
| what a fresh session must know | `CLAUDE.md` — auto-loads, and the 29 decisions as a one-line index |
| **why a decision is what it is** | `DECISIONS.md` — the full derivations, split out of CLAUDE.md 2026-08-22 |
| a point-in-time report, treated as a sample | `notes/archive/` — and its `README.md` first |
| what to do next, in dependency order | `NEXT.md` |
| the design document | `SPEC.html` (draft 8) |
| the accent pipeline, every measurement | `notes/pitch-accent-pipeline.md` |
| the OJAD adjudications and their traps | `notes/accent-ojad-adjudication.md` |
| ◎かな主流 and the 13 parenthesis cards | `notes/kana-primary-words.md` |
| the audio binding | `src/generate/README.md` |
| **the card loader and the audio resolver** | `src/cards/README.md` |
| the generation cache key, and why it never needed to be async | `src/blobs/generation.ts` |
| the accent module | `src/accent/README.md` |
| colours and type | `notes/design-tokens.md` |
| scheduler evidence | `BACKTEST.md` |
| the fuzz measurements, regenerated | `scripts/fuzz-load.ts` |
| **the cap and the same-day re-ask, in full** | `notes/max-interval-and-relearning.md` |
| where the cap should be, regenerated | `scripts/cap-derive.ts` |
| what Mochi did after a lapse | `scripts/same-day-relearn.ts` |
| what a same-day grade does to the schedule | `scripts/relearn-cost.ts` |
| the 13 parenthesis rows, regenerated | `scripts/reading-parse.ts` (read-only) |
| **why the browser could not load half the app** | `test/browser-portable.test.ts` — walks the import graph |
| the card loader and the audio resolver | `src/cards/README.md` |
| **Zach's reasoning, in his own words — the SOURCE for CLAUDE.md's decisions** | `notes/zach-in-his-own-words.md` |
| open-sourcing: what was checked, what is still open | `notes/open-sourcing.md` |
| the parenthesis rule, and the 13 rows it wrote | `src/text/parenthesis.ts` · `scripts/reading-apply.ts` |
| what the browser DB port is and is not tested for | `test/db-browser.test.ts` |

---

**Deliberately NOT acted on:** where OJAD picked a side it backed UniDic 11x to
OpenJTalk 4x, clustering on Sino-Japanese compounds that should be 平板 where our rule
produced a nucleus. That is an inference from 15 words. It wants a larger OJAD sample
before anything in `tools/accent.py` changes. Do not "fix" the derivation on this basis.

---

## The accent pipeline is DONE and VALIDATED — do not redo it

This consumed most of two days and it is finished. `notes/pitch-accent-pipeline.md` §7-§10
has every measurement.

* 3,850 distinct head words: 3,816 labelled, 34 refused. 平板 54.3% · 中高 · 頭高 ·
  **尾高 1.4%**, and that last number is pinned as a RATIO in a test because a decision
  rests on it.
* The notation is honoured only with **kana** element content — Google silently ignores it
  when the element contains kanji, returning plausible unaccented audio.
* **8 of 8** nucleus words put the downstep where the derivation asked.
* A blind A/B says the notation carries no audible penalty (46% of clips called fuzzy
  were the notated arm, p = 0.709).
* `tools/accent_verify.py` produces **false misses on words starting with an unvoiced
  consonant** — its output is a shortlist to listen to, never a verdict.

Rebuilding the accent data after a re-import:

```bash
npx vite-node src/accent/cli.ts -- words --db build/hashigo.db --out build/head-words.txt
.venv-accent/Scripts/python tools/accent_derive.py --words build/head-words.txt --out build/accents.jsonl
npx vite-node src/accent/cli.ts -- load --db build/hashigo.db --in build/accents.jsonl
.venv-accent/Scripts/python tools/accent_crosscheck.py --derived build/accents.jsonl --out build/accent-disagreements.jsonl --emit-rows build/accents-unidic.jsonl
npx vite-node src/accent/cli.ts -- load --db build/hashigo.db --in build/accents-unidic.jsonl
npx vite-node src/accent/cli.ts -- ojad --db build/hashigo.db
```

The venv (`.venv-accent/`, gitignored, ~1.4 GB with UniDic) rebuilds with
`python -m venv .venv-accent` then
`.venv-accent/Scripts/python -m pip install pyopenjtalk-plus fugashi unidic`.
**`python -m unidic download` fails on Windows** — it calls `fork`. Fetch
`https://cotonoha-dic.s3-ap-northeast-1.amazonaws.com/unidic.zip` directly, unzip into
`.venv-accent/Lib/site-packages/unidic/dicdir/`, and create an empty `mecabrc` there.
UniDic 3.1.0a1's URL is dead; 2.3.0 has the same `aType` field.

**57 words remain in the OJAD adjudication queue** (`cli.ts queue`), ~51 of which simply
are not in OJAD — it holds ~9,000 nouns and ~3,500 用言, which does not reach his 上級
vocabulary or his onomatopoeia. Those keep the primary derivation. That is the honest
state, not a gap.

---

## The gates, and the one chore that bites

```bash
npm test          # 24 files, 757 passed, 1 skipped (gated FSRS refit). 33-90 s.
                  # EXITS 1 ANYWAY when the "Timeout calling onTaskUpdate" reporter
                  # errors appear -- everything passes and the code is still 1.
                  # Check the pass count; do NOT trust $LASTEXITCODE here.
npm run typecheck # exit 0
npm run app:check # exit 0 — app/ has its own tsconfig; a REQUIRED gate, not optional
npm run build     # VERIFIED 77 modules, 54 dist targets = 27 export subpaths
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths   # exits 0
npm run spike:check
```

The stage-6 tests were checked by BREAKING the code rather than by being green:
dropping the lazy seed turns 2 red, computing due dates from the instant instead of
local midnight turns 2 red, feeding the model fractional elapsed days turns 1 red,
and taking the planned interval from `card_tracks.scheduled_days` turns 1 red. Two
of those four found nothing the first time and the tests were strengthened until they
did — including one comment in `day.ts` that the injection proved OVERCLAIMED. If you
change `src/scheduler`, re-run that experiment rather than trusting a green suite.

**A schema bump means RE-IMPORT, not migrate.** `SCHEMA_VERSION` is **8** and
`applySchema` refuses anything else. Three steps, and skipping the third fails a test:

```bash
rm build/hashigo.db
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run dashboard -- --db build/hashigo.db --out dashboard.html
```

`test/dashboard.test.ts` compares `dashboard.html` byte-for-byte, so a bump without a
regenerate fails there with a one-line diff. This happened four times in two days. Then
reload the accent data with the commands above.

---

## Working with him — what cost time to learn

Eleven memory files hold this; the index is at
`C:\Users\Zach\.claude\projects\C--DEV-WEB-hashigo\memory\MEMORY.md`. The five that
matter most day to day:

* **He reads every document end to end and acts on it.** An inference stated as a
  measurement propagates into his decisions. **Label MEASURED vs INFERRED, every time.**
  Retractions that reached him first: target retention 0.95, "Azure has no accent
  notation", "speech binding fails on 100% of slots", and a 6/8 accent score that was
  really 8/8.
* **His interactive shell is PowerShell 5.1.** `&&` is a parser error, and so is
  `VAR=value cmd`. Prefer fixing the root over translating the command: every Python tool
  here sets its own encoding so no documented command needs an env prefix.
* **Ask what a feature is FOR.** The entire purpose of the audio — pitch-accent shadowing
  — went unstated through the whole design phase because it was obvious to him. So did
  his U+200E convention, in a third of his corpus, and so did the fact that his
  `器（うつわ）` parentheses were a TTS workaround rather than a display choice.
* **His pushback is usually right, and it is usually a reframe.** He overruled seven spec
  drafts on the "answer leak". He spotted that display-as-furigana was not optional
  because the furigana generator would mis-read the same kanji. He noticed clips sounded
  "fuzzy" — wrong, but it produced the blind test that validated the notation.
* **He is still reviewing ~100 cards/day in Mochi** and will re-export repeatedly. Any
  repair that is needed once after an import is needed forever, which is why
  `template_fields.local` exists.

## Verify, do not relay

Subagent and tool output has been wrong in decision-changing ways, and right in
decision-changing ways, and the check was one command both times. Re-run pass conditions,
regenerate output rather than trusting a paste, and treat any single published number as
somebody's most favourable observation until proven otherwise — that has now been true
six times. **My own measurements have been wrong twice today**: a probe that measured
itself rather than the code, and a verifier whose tolerance hid a systematic offset.

## Which docs are snapshots

Live and current: `CLAUDE.md`, `DECISIONS.md`, `SPEC.html` (draft 8), this file, every `src/*/README.md`,
`notes/pitch-accent-pipeline.md`, `notes/accent-ojad-adjudication.md`,
`notes/kana-primary-words.md`, `notes/design-tokens.md`,
`notes/dashboard-reconciliation.md`, `BACKTEST.md`.

Bannered snapshots — **all seven moved to `notes/archive/` on 2026-08-22**, so a grep hit
labels itself by path: `FIXES.md`, `OVERNIGHT.md`, `STAGE4.md`, `SPIKE.md`,
`PHONE-TEST.md`, `persistence.md`, `browser-feasibility.md`. Nothing was deleted and
nothing in there should be edited — a snapshot that gets updated stops being a record of
what was believed at the time. `notes/archive/README.md` says which two claims in them
are known-wrong. Every stale item is a number that got better-measured later, and in each
case the earlier figure was somebody's most favourable observation. **Treat any single
number in an archived doc as a sample, not a fact.**

They are still cited by ~40 comments across `src/`, `test/` and `spike/` — by bare
filename, not by path, so the move broke no link (checked: zero markdown links pointed at
them).
