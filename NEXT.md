# Next session — start here

Written 2026-08-20 immediately before a `/compact`. Zach's instruction: *"assume that the
new session will know NOTHING about our conversation, don't trust the summary process, it
loses so much context."* So this file is the handoff, not the summary.

Read in this order: `CLAUDE.md` (auto-loads, and now carries the silent-audio problem and
the TTS findings) → this file → `STAGE4.md` → `notes/pitch-accent-pipeline.md`.

The Obsidian planner Zach maintains himself is at
`C:\DEV\obsidian\second-brain\PARA\1Projects\ハシゴ\Planner.md`. He edits it directly and
his notes there are in his own voice — preserve them, don't paraphrase them away.

---

## Progress, 2026-08-20 evening

Zach green-lit steps 1 -> 2 -> 3 -> 3.5 -> 4 and then said *"you can proceed til
the point when you need my decision"*. Steps **1, 2, 3 are DONE**, and 3.5 is
done except the OJAD leg. No multi-agent workflow was used — he never green-lit
one, and it was not needed.

| step | state | where |
|---|---|---|
| 1. bind generated values to fields | **DONE** | `src/generate`, 98.11% of 18,356 field slots playable |
| 2. the four voice gaps | **DONE** | schema v3, `src/generate/voice.ts`, `retargetBlobRef`, 7-day sweep grace |
| 3. derivation + `<<型>>` | **DONE** | schema v4, `src/accent`, 3,816 of 3,850 keys labelled |
| 3.5 long-vowel test | **DONE — answered** | `ー` and `い` behave the same; no conversion needed |
| 3.5 second dictionary | **DONE** | UniDic 2.3.0, 97.31% agreement on 3,007 comparable words |
| 3.5 OJAD | **PARTLY DONE** | 33 of 90 adjudicated; 57 left, ~51 of them not in OJAD at all |
| 4. regenerate 20 cards, listen | **DONE, then INVALIDATED** | he judged them accurate, but `cards` mode sent KANJI content so Google ignored the notation — he heard the unaided frontend. `--card-content kana` fixes it; worth re-running |

### Two things waiting on Zach specifically

1. **Step 4 is his ears.** The tooling refuses more than 20 cards by design. It
   also spends on his Google account, and the point of the step is that he
   listens — nobody else can do it.
2. **`<<型>>` is not on any template yet.** The storage, derivation, resolution
   and materialiser all exist and are tested, but no template has an
   `accent`-typed field, so `cli.ts write` has nothing to write to. Adding one
   is authoring: WHICH SIDE it goes on (the reveal side — a 平板 label on the
   prompt side is the same class of error as autoplay) is settled, but where on
   that side, and whether it reads `平板` or `平板 (0)`, is his taste. A locally
   added field is also dropped by the next re-import, which the importer does not
   yet know how to preserve — worth deciding together.

### Schema is at v7, and there is still no migration path

That is deliberate and stated in `src/schema/index.ts`: every database here
rebuilds from `exports/` in about fifteen seconds, and reviews still come from
the export. **A schema bump therefore means `rm build/hashigo.db` and re-import,
then regenerate `dashboard.html`** (its one-line `スキーマ v5` field is asserted
byte-identical by a test). This bit three times in one session; it is not a
surprise, it is the workflow.

Rebuilding the accent data after a re-import:

```bash
npx vite-node src/accent/cli.ts -- words --db build/hashigo.db --out build/head-words.txt
.venv-accent/Scripts/python tools/accent_derive.py --words build/head-words.txt --out build/accents.jsonl
npx vite-node src/accent/cli.ts -- load --db build/hashigo.db --in build/accents.jsonl
.venv-accent/Scripts/python tools/accent_crosscheck.py --derived build/accents.jsonl --out build/accent-disagreements.jsonl --emit-rows build/accents-unidic.jsonl
npx vite-node src/accent/cli.ts -- load --db build/hashigo.db --in build/accents-unidic.jsonl
npx vite-node src/accent/cli.ts -- ojad --db build/hashigo.db
```

### What is left in the accent queue, and why it is not a gap to close

57 words. **~51 of them are simply not in OJAD** — it holds ~9,000 nouns and
~3,500 用言, which does not reach his 上級 vocabulary (敵軍, 空前, 脆弱, 転嫁,
横柄) or his onomatopoeia (もやもや, ベタベタ, ニコニコ). Those keep the primary
derivation or stay `guarded`, which is the honest state.

**6 are genuinely ambiguous and must stay unlabelled.** `まく` has three
different accents across 巻く / 蒔く・撒く / 膜・幕. A single label would drill a
wrong contour on two thirds of its senses. Settling them needs the card's own
意味, which is a review-UI question — worth raising with Zach when the UI exists,
not before.

**One hypothesis to test, not to act on yet.** Where OJAD backed one analyser
against the other it backed UniDic 11 times and OpenJTalk 4, and the UniDic wins
cluster on Sino-Japanese compounds that should be 平板 where our probe rule
produced a nucleus. That is an inference from 15 words. It wants a larger OJAD
sample before `tools/accent.py` changes. `notes/accent-ojad-adjudication.md` §
"The pattern worth acting on".

The venv (`.venv-accent/`, gitignored, ~1.4 GB with UniDic) rebuilds with:

```bash
python -m venv .venv-accent
.venv-accent/Scripts/python -m pip install pyopenjtalk-plus fugashi unidic
```

`python -m unidic download` **fails on Windows** — it calls `fork`. Fetch
`https://cotonoha-dic.s3-ap-northeast-1.amazonaws.com/unidic.zip` directly and
unzip it into `.venv-accent/Lib/site-packages/unidic/dicdir/`, then create a
`mecabrc` there (any content; fugashi only checks it exists). UniDic 3.1.0a1's
URL is dead — 2.3.0 has the same `aType` field.

### The `.env` name mismatch, which will waste ten minutes otherwise

His `.env` calls the Google key **`GOOGLE_TTS_SECRET`**; `accent_probe.py`
defaults to `GOOGLE_TTS_API_KEY`. Pass `--google-key-env GOOGLE_TTS_SECRET`. The
probe reads secrets by NAME and never prints them, and the key now travels in the
`x-goog-api-key` header rather than the URL query string.

## What is already settled — do not reopen

Everything in `CLAUDE.md` "Decisions that are settled", plus, from 2026-08-20:

| | |
|---|---|
| TTS provider | **Google** |
| Voice | **`ja-JP-Neural2-C`** (male), chosen by ear, agrees with F0 |
| Notation | SSML `<phoneme alphabet="yomigana">`, **reading as element content, never kanji** |
| Particle in the audio | **No.** 尾高 is 1.4% of his vocabulary — 51 words — and `<<型>>` carries them |
| Annotate | the isolated word only, **never** the example sentence |
| Generated value resolution | **on demand**, with a loud miss diagnostic |
| `<<型>>` storage | **materialised**, `accents` table keyed by text |
| Regeneration scope | Japanese only (8,392 clips / 106,926 chars). English's 2,372 clips are untouched — pitch accent is meaningless there. **$0** on Neural2. |
| Browser | one per device; Samsung Internet on the phone, `persist()` granted, quota 133.96 GiB |
| Audio on the phone | all local, no lazy fetch |
| Visual direction | Monkeytype `terminal` + Notion; see `notes/design-tokens.md` |

## Two open items he has NOT decided

- The `orphanFieldValues` definition — 143 (cards with a template) vs 235 (all
  unreferenced values). `FIXES.md` §2.3, §3.6.
- The `OVERNIGHT.md` §4 bundle: sides being structural, the CommonMark emphasis
  deviations, the 4-bin heatmap, the JS-free dashboard, the 20-row `tags` table for 19
  real tags. All small, none blocking.

---

## Which docs are snapshots, and what is stale in them

Audited 2026-08-20. The point-in-time reports are **kept as the record** and bannered
rather than rewritten, because a rewritten report no longer tells you what was actually
found. Current state lives in `CLAUDE.md`, `SPEC.html` (draft 8), and this file.

| Doc | Snapshot | Superseded in it |
|---|---|---|
| `CLAUDE.md` | live | — current |
| `SPEC.html` | live, draft 8 | — current; carries its own retractions in place |
| `NEXT.md` | live | — this file |
| `notes/pitch-accent-pipeline.md` | live | — current |
| `notes/design-tokens.md` | live | — current (Notion claims marked OBSERVED, not measured) |
| `notes/dashboard-reconciliation.md` | live | — current |
| `BACKTEST.md` | mostly live | **corrected**: two passages said the settled target was 0.95 |
| `SPIKE.md` | 2026-08-19 | test count 352 (now 542); blob multiplier corrected in §2 already |
| `FIXES.md` | 2026-08-19 | retention 0.95, test count 306, "no renderer", one-file-per-blob, 65x |
| `OVERNIGHT.md` | 2026-08-19 | test count 242, "no renderer", retention 0.95 |
| `STAGE4.md` | 2026-08-20 | the fix is decided but not implemented |
| `notes/persistence.md` | 2026-08-19 | every desktop persistence figure — the phone contradicts two |
| `notes/browser-feasibility.md` | 2026-08-19 | 65x multiplier (really 13-40x), `reclaim()` 6.8 s (really 35-54 s) |

**The pattern worth noticing:** every stale item is a number that got *better-measured*
later, and in every case the earlier figure was somebody's most favourable observation.
Treat any single number in an older doc as a sample, not a fact.

## Working with him — the things that cost time to learn

11 memory files hold this; the index is at
`C:\Users\Zach\.claude\projects\C--DEV-WEB-hashigo\memory\MEMORY.md`. The four that
matter most day to day:

- **He reads every document end to end and acts on it.** So an inference stated as a
  measurement propagates into his decisions. Label MEASURED vs INFERRED, every time. Two
  of my confident claims have had to be retracted (target retention 0.95; "Azure has no
  accent notation") and both reached him first.
- **His interactive shell is PowerShell 5.1**, though the tool runs pwsh 7. `&&` is a
  parser error in anything handed to him — use `;`. He is often at `C:\Users\Zach`, not
  the repo.
- **Ask what a feature is FOR.** The entire purpose of the audio — pitch-accent
  shadowing — went unstated for the whole design phase because it was obvious to him. So
  did his U+200E convention, which is in a third of his corpus.
- **He gives good pushback and it is usually right.** He overruled seven drafts of spec
  on the "answer leak" and the machinery was correctly deleted rather than built.

## Verify, do not relay

Subagent reports have been wrong in decision-changing ways, and right in
decision-changing ways. Both times the check was one command. Re-run pass conditions,
regenerate output rather than trusting a paste, and treat a published number as *somebody's
fastest run* until proven otherwise — that has been true four times.

Current gates, and they should stay true:

```bash
npm test          # 16 files, 592 passed, 1 skipped (gated FSRS refit). 32.7-87.7 s
                  # over five runs. A "Timeout calling onTaskUpdate" line is
                  # Vitest reporter RPC under load, not a failing test.
npm run typecheck # exit 0
npm run build     # VERIFIED 53 modules, 28 dist targets = 14 export subpaths x (.js + .d.ts)
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths   # exits 0, blobs.path 0
```
