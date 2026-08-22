# Next session — start here

Rewritten 2026-08-22, immediately before a `/compact`. Zach's standing instruction:
*"assume that the new session will know NOTHING about our conversation, don't trust the
summary process, it loses so much context."* So this is the handoff, not a summary.

**Read in this order:** `CLAUDE.md` (auto-loads; carries the current state and every
settled decision) → this file → whichever `notes/` file the task touches.

Zach also keeps his own planner at
`C:\DEV\obsidian\second-brain\PARA\1Projects\ハシゴ\Planner.md`. It is his decision queue
in his own voice, it is NOT in git, and it deliberately holds no measurements — those
live here. Preserve his wording if you edit it; don't paraphrase him away.

---

## STATE RIGHT NOW — 2026-08-22, everything is COMMITTED

**The tree is clean. Fourteen commits landed 2026-08-22** — the scheduler's interval fuzz,
the forecast tile and heatmap tables, the cap/relearning derivations, the ratifications,
the browser-portability split, schema **v8**, a correctness sweep, and the dashboard in
English. `git log --oneline -14` is the list; do not rebuild any of it.

Gates, and **re-run them rather than repeating these**: `npm test` → 19 files / 674 passed
/ 1 skipped · `npm run typecheck` → 0 · `npm run build` → OK, 23 export subpaths ·
`npm run spike:check` → clean.

> [!IMPORTANT]
> **A DECISION THAT IS NOT IN `CLAUDE.md` IS NOT RECORDED.** Zach keeps a planner in
> Obsidian; no agent reads it. Four settled decisions lived only there until today and one
> (`型` placement, now decision 20) was reopened by an audit as an "open question" weeks
> after he had settled it. If you settle something with him, write it into CLAUDE.md's
> numbered list first. There are 22 decisions; read them before proposing anything.

**THE DECISION QUEUE IS EMPTY. Zach cleared all four questions on 2026-08-22** and every
one is now written into `CLAUDE.md` as a settled decision. Do NOT reopen these; the last
session that assumed one was open wasted a round:

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

## IF YOU WERE JUST TOLD "PROCEED", START AT TABLE A

Zach is reviewing in a parallel session and will read whatever you produce. He has
cleared every open decision, so **do not open by asking him to decide something** —
check `CLAUDE.md` "Decisions that are settled" and "Ratified 2026-08-22" first, because
the answer is very likely already there.

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

### Table A — do these now, unsupervised. All decided, none need him.### Table A — do these now, unsupervised. All decided, none need him.

| | what | why it is safe |
|---|---|---|
| ~~A1~~ | ~~**Interval fuzz, ±5%**~~ | **DONE 2026-08-22.** `INTERVAL_FUZZ` in `src/scheduler/policy.ts`, applied in `gradeMemory`, keyed on the track id. Every figure in decision 11 was regenerated by `scripts/fuzz-load.ts` and came back. **One thing needs his eye:** the fuzz had to go on AFTER the cap, so an issued interval can now reach 383 days — decision 11 has the measurement that forces it and the conservative alternative if he disagrees |
| ~~A2~~ | ~~The `復習予測` forecast tile on the dashboard~~ | **DONE 2026-08-22.** Bars for 30 days, zero JavaScript, with the table twin the page's own convention requires. It states whose plans it is charting — **8,853 Mochi / 0 Hashigo** today — because having a scheduler did not reschedule anything, which was the original reason the tile was blank. A test reconciles it against `queueCounts` day for day: 108 due at 2026-08-18 plus bars of 39+86+95+115 is the 443 the scheduler CLI reports for 2026-08-22 |
| ~~**A3**~~ | ~~Heatmap `<details>` table~~ — **DONE 2026-08-22.** Each year strip now carries a per-day table: 176 + 362 + 348 + 220 + 211 = **1,317 rows, exactly `activeDays`**. Zero-review days get no row on purpose — their tooltip says 学習なし and carries no number. `dashboard.html` regenerated (345 KB → 460 KB) and a test asserts the per-year sums, proven against two injected faults |
| — | ~~dashboard tag count filters `cards_direct > 0`~~ — **NOT A TASK.** There is no tag count on the dashboard (0 occurrences of タグ in `dashboard.html`), and the only tag count in the code — the importer's `20 tag paths` phase line — already names its basis. `tag_usage` already exposes `cards_direct`, and `test/roundtrip.test.ts:361` already asserts the filtered count is **19** and names `Dialect` as the childless ancestor. The trap is real; it is pinned. It becomes live again only when **B3** builds a tag sidebar |
| **A4** | `読み` field + parse the 13 parenthesis cards | **ROWS PRODUCED 2026-08-22, nothing written.** `npx vite-node scripts/reading-parse.ts -- --db build/hashigo.db` prints all 13 before/after rows: **7 読み / 5 かな主流 / 1 意味, zero unclassified**, matching decision 10 exactly. Read-only by construction (`readOnly: true`). **ANSWERED** — `（おす）雄` is kana-primary (one ratified override, decision 10), so the final split is **6 読み / 6 かな主流 / 1 意味**. What still blocks the WRITE is that no `読み` field exists yet: `template_fields` has 0 rows with `local = 1`, so this needs the field created first — a schema bump, hence re-import and dashboard regen |
| **A5** | Dashboard in English | 369 Japanese strings. A `LABELS` table, English default. Deck/template/field names stay Japanese — they are identifiers. Regenerate `dashboard.html`; a test compares it byte-for-byte |

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
npm run build     # VERIFIED 63 modules, 32 dist targets = 16 export subpaths
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
