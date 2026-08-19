# Hashigo (梯子)

A local-first spaced-repetition app replacing [Mochi](https://mochi.cards) for one
user's Japanese study. Built because Mochi's developer stopped fixing reported bugs.

**Read [SPEC.html](SPEC.html) first** — it is the authoritative design document
(build spec, **draft 7**). Every figure in it is measured from the real export in
`exports/`, not estimated. Published copy:
<https://claude.ai/code/artifact/c8416a42-779a-49da-81c1-54459067d94b>

**The published copy is one revision behind, checked 2026-08-20.** Its masthead
reads `draft 7`, but its "Answer leak in reverse mode" callout is still the old
`diagnosis` note prescribing deferred link rendering — the version Zach overruled
(decision 7 below). The file in this repo carries the overrule. **The file wins;
republish that same path to bring the URL forward** (same `url` argument, or a
second artifact gets created).

Stages 0, 1, 2, 3, 4, 5 and 8 exist and are tested against the real export:
schema, importer, dashboard, template engine, **renderer** (`src/render`),
scheduler backtest, **search** (`src/search`), plus the content-addressed blob
store, the browser database handle (`src/db/browser.ts`, sqlite-wasm on OPFS) and
`src/text`. What is still missing is the **review UI** — grading, the queue, and
the app shell that mounts a rendered card (stages 6, 7, 9, 10). `spike/viewer/` is
a THROWAWAY browser harness, not that shell. See `OVERNIGHT.md` for the gap list,
`SPIKE.md` for what the browser spike settled, and `notes/browser-feasibility.md`
for the OPFS measurements.

```bash
npm test                # 14 files, 542 passed, 1 skipped (the FSRS refit, gated)
                        # 32.7-46.8 s over four runs. RANGE, not best run.
npm run typecheck       # exit 0
npm run build           # refuses to exit 0 unless dist/ actually imports (13 entry points)
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run dashboard -- --db build/hashigo.db --out dashboard.html
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths   # exits 1 on any location
npm run spike:check     # the browser contract; spike/ is excluded from tsconfig.json
npm run spike:dev -- --host 127.0.0.1   # bind IPv4: a server on ::1 refuses 127.0.0.1
```

## Decisions that are settled — do not relitigate these

1. **FSRS-6**, max interval **365 days**, target retention **0.90**.
   `src/scheduler/policy.ts` holds them (`TARGET_RETENTION = 0.9`); `BACKTEST.md`
   holds the measurements. It was 0.95 until 2026-08-19 and this file said so for
   a day after the code stopped agreeing: 0.95 asks for 1.9-3.0x his sustained
   daily load, 0.90 reproduces it.
2. **Binary grades only** — remembered / forgot. Anki's four-button scale was
   considered and rejected, so there is no `grade` column and FSRS `w[15]`/`w[16]`
   are frozen, not fitted.
3. The six empty leaf decks **are dropped** by default: 45 decks become 39.
4. Blobs are **content-addressed**. No absolute path is ever stored in the
   database — the `paths` command above is the acceptance check.
5. Stale pre-template `content` (3,159 cards, 79,175 chars) is **discarded** on
   import and **reported** so it stays recoverable from the export.
6. Both intervals are tracked and named: `reviews.elapsed_days` (measured) and
   `reviews.scheduled_days` (planned). Anything plotted against an interval must
   say which basis it used. The rule generalises past intervals — the same class
   of defect has since appeared in a math count (29 AUTHORED fragments vs 28
   RESOLVED) and a furigana count (4,933 skeleton runs vs 4,943 `<rt>` elements).
   Name the basis or the number is not a fact.
7. **Links render PLAINLY, in place, on whatever side they are authored on.**
   Drafts 1-7 called the Jisho URL on 漢字's side 4 an answer leak and prescribed
   deferring link rendering in reverse mode. Zach overruled that on 2026-08-20:
   there is no hover on a phone, a long-press is deliberate, and he never checks a
   URL before answering. No direction-dependent deferral, no defanged `href`, no
   state for it. Deleting that machinery was the correct outcome.

## The hard rule: audio must never autoplay

**The audio in this corpus is for 高低アクセント (pitch accent) SHADOWING.** Zach
looks at the kanji, recalls whether each mora is high or low, SAYS IT ALOUD, and
only then reveals the reading and listens to compare. The template side order IS
that exercise, not a layout:

* **単語** — `Reading` is a BOOLEAN that switches the scaffolding. Side 1 shows
  `Reference` outright when true; side 2 hides it in a cloze when false, beside
  `{{<furigana><<単語>></furigana>}}` (also a cloze) and `<<Speech>>`. Side 3
  repeats it at sentence length with `例文` + `Audio`.
* **漢字** — `Kanji` -> `<draw>` canvas -> `Reading` -> `Meaning`. Draw from
  memory, THEN see the answer. No audio on this template.

So: **audio fires on the cloze reveal, never when a side appears.** Autoplay is
the default in most flashcard renderers and it does not degrade this exercise, it
deletes it — the contour is given away before he has produced it. This is a
correctness requirement. `src/render/reveal.ts`'s `enter()` therefore does nothing
but record that a side is on screen, playback is reachable from exactly two calls
(`reveal()` and `play()`), and media elements are created with no `src`, no
`autoplay`, no `loop` and `preload="none"`.

It is pinned by tests with demonstrated teeth (integrator, 2026-08-20): adding
`audio.play(...)` inside `enter()` turns 8 tests red including the 7,716-card
sweep (450 violations); adding an `autoplay` attribute in `src/render/nodes.ts`
turns 8 tests red across three files. If you change either file, re-run that
experiment rather than trusting a green suite.

## The four problems this exists to solve

1. Battery drain on phone → no polling, no sockets, precomputed renders
2. $60/yr → own API keys, real cost under $1/yr
3. Android sync crashes → own the sync layer
4. Attachment churn and manual re-syncing → content-addressed, refcounted blobs

## Repo layout

```
exports/          Extracted .mochi exports (~657 MB of mp3). NOT source — reference data.
  日本語/          5,947 cards · data.json is 21 MB
  English/        1,258 cards · data.json is 3.4 MB
  基本情報/         511 cards · data.json is 778 KB
tools/mochi.py    Mochi export reader. Transit decoder + the traps, documented.
SPEC.html         The design document.
```

## Working with the exports

**Never read `data.json` directly into context** — the largest is 21 MB. Always go
through a script. `tools/mochi.py` has the decoder and a summary CLI:

```bash
python tools/mochi.py exports/日本語 exports/English exports/基本情報
```

Expected output (a regression check — these numbers are known-correct):

```
cards 7,716 | reviews 102,020 | retention 96.24%
wiki-links 8,690 | tombstones 8,958
inline generators: {'speech': 287, 'translate': 106, 'image': 8, 'furigana': 19, 'ai': 125}
tags after normalisation: 19
```

The module docstring in `tools/mochi.py` lists the format traps that cost real time
to find — Transit's two different timestamp encodings, the double-counting deck
walker, `content` being empty on templated cards, zero-width spaces in tags. Read it
before writing anything that parses the export.

`exports/` is gitignored — 657 MB of generated audio — along with the blob store
(`*.blobs/`), every media extension, and `*.db`. `.gitattributes` pins LF so
`schema.sql` cannot land in the repo with two different hashes.

## Environment

- **Windows.** The console is **cp932** (Japanese locale), so any script printing
  Japanese needs both `PYTHONIOENCODING=utf-8` in the environment and
  `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` in the script.
  Without them you get `UnicodeEncodeError` on the first kanji.
- Python is `python` (3.13). `python3` is not on PATH — it hits the Microsoft Store
  alias and fails.
- The Bash tool's working directory does not reliably persist between calls. Use
  absolute paths, or `cd` in the same command.

## Conventions

- Deck, template, and field names are Japanese where the user wrote them Japanese.
  Do not translate or romanise them — `単語`, `漢字`, `例文`, `意味` are identifiers.
- Language codes normalise to BCP-47 (`ja-JP`), never Mochi's inline `jp`.
- Prefer measuring over assuming: this project has 102,020 graded reviews and 19,710
  existing AI generations, which double as labelled test sets. See the memory note
  on not inheriting Mochi's defaults.
