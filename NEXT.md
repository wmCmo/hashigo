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

## The agreed plan, in dependency order

Zach green-lit steps 1 → 2 → 3 → 3.5 → 4 on 2026-08-20, and asked for step 3.5
explicitly. **He has NOT yet green-lit the workflow itself** — he wanted to `/compact`
first. Ask before launching a multi-agent run.

### 1. Bind generated values to fields — BLOCKING, nothing else matters as much

Makes the audio he already owns actually play. Independent of every TTS decision.
Resolve **on demand**; emit a loud diagnostic count on a miss. Details in `CLAUDE.md`
under "THE APP IS SILENT".

### 2. The four voice gaps — all grep-verified, all in our own code

His Mochi pain point, rebuilt by us:

- no voice column on cards or decks, so no per-card override
- **no production API to drop or retarget a `blob_refs` row** — the `blob_refs_au`
  trigger exists and nothing calls it. This is literally "can't delete the audio I don't
  want".
- no sweep grace period, which would make free voice A/B destroy the losing candidate
- `resolveGeneration` takes a **synchronous** callback, so an HTTP call cannot be passed
  to it at all

Voice should resolve through the same three-state inheritance the reverse-review setting
uses (card → deck → workspace).

### 3. The derivation and `<<型>>`

`pyopenjtalk` will not build here (no cmake); **`pyopenjtalk-plus` 0.4.1.post9 installs
from a wheel** and exposes the same module name. Derivation rule, traps, and a validated
implementation are in `notes/pitch-accent-pipeline.md` §3.

`<<型>>` renders 平板 / 頭高 / 中高 / 尾高 next to the audio — **his idea**, and it is now
also the error-detection mechanism for the whole pipeline, because a wrong *label* is
visible where a wrong *contour* is silently absorbed. Materialise it in a new `accents`
table keyed by **text**, not card. **It must live on the reveal side** — a 平板 label on
the prompt side is the same class of error as autoplay.

### 3.5 Verification before regenerating at scale

- **Re-run the long-vowel test with KANA content.** The first attempt was invalidated,
  not passed: both arms used kanji content, so Google ignored both and they came back
  byte-identical. `シメー` vs `シメイ` is still unanswered and it affects most
  Sino-Japanese vocabulary.
- **Cross-check the derivation against a second licensed dictionary** (UniDic carries an
  accent field; there are standalone pitch-accent datasets). Two independent dictionaries
  agreeing beats one fork plus my recall — the 5-of-15 mismatch (紙, 髪, 心, 友達, 水) was
  measured against *recall*, which is not a citation.
- **OJAD only for the disagreements, and only through the UI.** Zach's instruction: use
  **Claude in Chrome**, driving OJAD's interface as a human would, and OJAD also offers a
  file download. Do **not** write a scraper — their terms permit educational and research
  use and ask people to refrain from bulk automated use, and it is publicly funded
  university infrastructure.

### 4. Regenerate 20 cards, listen, then decide about the other 8,372

`tools/accent_probe.py cards --limit 20 --go` exists and refuses more than 20. He wants
to start small; he has said so twice.

---

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
npm test          # 14 files, 542 passed, 1 skipped (gated FSRS refit). 32.7-87.7 s
                  # over five runs. A "Timeout calling onTaskUpdate" line is
                  # Vitest reporter RPC under load, not a failing test.
npm run typecheck # exit 0
npm run build     # VERIFIED 50 modules, 26 dist targets = 13 export subpaths x (.js + .d.ts)
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths   # exits 0, blobs.path 0
```
