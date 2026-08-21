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

### Table A — do these now, unsupervised. All decided, none need him.

| | what | why it is safe |
|---|---|---|
| **A1** | **Interval fuzz, ±5%** | fully specified in CLAUDE.md decision 11, including the width's derivation and the **two ways to build it wrong**. ~20 lines where the interval is finalised, plus tests. Read that decision before writing a line |
| **A2** | The `復習予測` forecast tile on the dashboard | `reviewForecast` in `src/scheduler` is its data source. SPEC deferred this tile until the scheduler existed; it now does |
| **A3** | Heatmap `<details>` table · dashboard tag count filters `cards_direct > 0` | two small fixes. The heatmap has 48 SVG `<title>` tooltips and no table, so 1,317 daily values are unreachable on a phone — there is no hover on touch |
| **A4** | `読み` field + parse the 13 parenthesis cards | decided (CLAUDE.md decision 10, `notes/kana-primary-words.md`). **Produce the 13 before/after rows and STOP** — do not write to `card_field_values` until he has seen them |
| **A5** | Dashboard in English | 369 Japanese strings. A `LABELS` table, English default. Deck/template/field names stay Japanese — they are identifiers. Regenerate `dashboard.html`; a test compares it byte-for-byte |

### Table B — do NOT start these without him

| | what | why |
|---|---|---|
| **B1** | **Stage 7 — Review UI** | it is the critical path AND the screen he lives in. His planner files it under "needs my taste", and an agent inventing his review interface produces work he will reject. The hard constraint if you ever do touch it: **audio fires on cloze reveal, NEVER on side entry** — `src/render/reveal.ts` and the autoplay section of CLAUDE.md |
| **B2** | Design tokens → `spike/viewer/` | 3 named fixes exist in `notes/design-tokens.md`, but he judges the result on his own phone. Propose, do not decide |
| **B3** | Nested-tag sidebar · Ctrl+K palette | query layers are done; the UI is taste |
| **B4** | Stage 10 Editor · Stage 11 Sync | both large, both unspecified in shape |

### The one stage-7 question still open

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
npm test          # 17 files, 625 passed, 1 skipped (gated FSRS refit). 32.7-87.7 s.
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

**A schema bump means RE-IMPORT, not migrate.** `SCHEMA_VERSION` is **7** and
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
