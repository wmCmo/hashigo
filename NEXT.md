# Next session — start here

Rewritten 2026-08-22, immediately before a `/compact`. Zach's standing instruction:
*"assume that the new session will know NOTHING about our conversation, don't trust the
summary process, it loses so much context."* So this is the handoff, not a summary.

**Read in this order:** `CLAUDE.md` (auto-loads; carries the current state and every
settled decision) → this file → whichever `notes/` file the task touches.

Zach keeps a planner at
`C:\DEV\obsidian\second-brain\PARA\1Projects\ハシゴ\Planner.md`. **As of 2026-08-22 it is
exactly two sections — what he has to decide, and what is left before he can use the app —
and nothing else.** He cut it to that himself: everything that was status, measurement,
what-not-to-rebuild or reasoning moved into this repo, because no agent reads Obsidian.

So: it is NOT in git, it holds no measurements, and if you edit it, **do not grow it**. A
thing that is not a decision of his or a blocker belongs here instead. His verbatim
reasoning — the SOURCE that CLAUDE.md's decisions were written from — now lives at
`notes/zach-in-his-own-words.md`; preserve his wording there and don't paraphrase him away.

---

## STATE RIGHT NOW — 2026-08-22, tree clean, everything committed

> [!warning] **`git status` FIRST, always — and if you change the state, change this
> heading in the SAME edit.** It has been wrong in both directions in one day: commit
> `0477240` fixed it claiming NOTHING IS COMMITTED while the body said the opposite, and
> `a4e00b3` fixed it claiming the tree was clean when a day's work was unstaged. It is a
> heading a cold session trusts before it has looked at anything.

**Twenty commits landed 2026-08-22** — the scheduler's interval fuzz, the forecast tile
and heatmap tables, the cap/relearning derivations, the ratifications, the
browser-portability split, schema **v8**, a correctness sweep, and the dashboard in
English. `git log --oneline -20` is the list; do not rebuild any of it.

Gates, and **re-run them rather than repeating these**: `npm test` → 20 files / 697 passed
/ 1 skipped · `npm run typecheck` → 0 · `npm run build` → OK, 24 export subpaths ·
`npm run spike:check` → clean. The suite also prints `Timeout calling "onTaskUpdate"` under
load — that is Vitest's reporter RPC, not a failing test. Read the pass count.

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
planner.** He rewrote that file on 2026-08-22 to exactly two sections: what he has to
decide (**D1–D5**) and what is left before he can use the app. **D1 — what the review
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
planner's **D1** is the blocker and it is a taste decision about the screen he lives in;
an agent that designs it produces work he rejects. That has been written down three
separate times on this project.

Two things that ARE safe and useful without him, if he wants something done:

* **Verify rather than extend.** Re-run the gates, re-run a fault injection against a test
  you doubt, or check a number in a doc against the code. Three of the last two sessions'
  reported claims turned out wrong, and each was one command away from being caught.

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
| ~~C1~~ | ~~The async cache key~~ | **DONE 2026-08-22, and it was NOT an async rewrite.** Three documents — `notes/browser-feasibility.md` §5, the `KNOWN_NODE_BOUND` comment, and two session handoffs — said `node:crypto` → `crypto.subtle` was "the one genuinely invasive change" because `digest` is async and the key, the resolver and everything above them would change signature. **That reasoning was obsolete.** `src/blobs/sha256.ts` is a synchronous, dependency-free SHA-256 written for exactly this, already the default digest of `SqliteBlobStore`, already agreeing with `node:crypto` bit for bit on all 10,816 payloads — and its own header says so. So the key MOVED to `src/blobs/generation.ts` with one line changed and **no signature altered**. `src/generate/index.ts` is now in `BROWSER_ENTRY_POINTS` and `KNOWN_NODE_BOUND` is empty. Pinned: 36,398 distinct corpus identities, 32,465 of them non-ASCII, **0 differing digests**, plus three real keys as literals |
| ~~C2~~ | ~~The audio resolver's second half — hash → bytes → `blob:` URL~~ | **DONE 2026-08-22.** `cardAudioResolver` in `src/cards/audio.ts` is the `AudioResolver` that `src/render/audio.ts` has always taken. Measured end to end over 400 real cards: **373 speech mounts → 361 addressed → 361 payloads read → 16.2 MiB of `audio/mpeg`** out of the store. Both facts honoured — the card id comes from the closure (a test proves the same `ref_key` against another card resolves to null), and the inline split is by PAYLOAD not by kind, since `file` and `image` are out-of-line too |

**So the whole path from "what is due" to "these bytes" now exists in `src/`.** What does
not exist is the SCREEN: nothing mounts a rendered card in a browser and nothing calls
`play()`. That is **B1, and it is Zach's.** The two runs needing his handset — the 625 MB
fill and the per-grade OPFS write — are still unmeasured.

### Table B — do NOT start these without him

| | what | why |
|---|---|---|
| **B1** | **Stage 7 — Review UI** | it is the critical path AND the screen he lives in. His planner files it under "needs my taste", and an agent inventing his review interface produces work he will reject. The hard constraint if you ever do touch it: **audio fires on cloze reveal, NEVER on side entry** — `src/render/reveal.ts` and the autoplay section of CLAUDE.md |
| **B2** | Design tokens → `spike/viewer/` | 3 named fixes exist in `notes/design-tokens.md`, but he judges the result on his own phone. Propose, do not decide |
| **B3** | Nested-tag sidebar · Ctrl+K palette | query layers are done; the UI is taste |
| **B4** | Stage 10 Editor · Stage 11 Sync | both large, both unspecified in shape |

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

**`<<型>>` has never been written to a card.** `materialiseAccents` iterates
`template_fields WHERE type = 'accent'`, and there are **zero such rows** — so it has been
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
  mid-stream resume and the on-device run.
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
| what a fresh session must know | `CLAUDE.md` — auto-loads, carries the settled decisions |
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
npm test          # 19 files, 672 passed, 1 skipped (gated FSRS refit). 33-88 s.
                  # A "Timeout calling onTaskUpdate" line is Vitest's reporter under
                  # load, not a failing test. Check the pass count.
npm run typecheck # exit 0
npm run build     # VERIFIED 67 modules, 48 dist targets = 24 export subpaths
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

Live and current: `CLAUDE.md`, `SPEC.html` (draft 8), this file, every `src/*/README.md`,
`notes/pitch-accent-pipeline.md`, `notes/accent-ojad-adjudication.md`,
`notes/kana-primary-words.md`, `notes/design-tokens.md`,
`notes/dashboard-reconciliation.md`, `BACKTEST.md`.

Bannered snapshots — kept as the record, not rewritten: `FIXES.md`, `OVERNIGHT.md`,
`STAGE4.md`, `SPIKE.md`, `PHONE-TEST.md`, `notes/persistence.md`,
`notes/browser-feasibility.md`. Every stale item in them is a number that got
better-measured later, and in each case the earlier figure was somebody's most favourable
observation. **Treat any single number in a bannered doc as a sample, not a fact.**
