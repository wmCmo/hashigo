# Hashigo (梯子)

A local-first spaced-repetition app replacing [Mochi](https://mochi.cards) for one
user's Japanese study. Built because Mochi's developer stopped fixing reported bugs.

**Read [SPEC.html](SPEC.html) first** — it is the authoritative design document
(build spec, **draft 8**). Every figure in it is measured from the real export in
`exports/`, not estimated. Published copy:
<https://claude.ai/code/artifact/c8416a42-779a-49da-81c1-54459067d94b>

The published copy is current as of draft 8 (2026-08-20). To revise: edit
`SPEC.html` and republish **the same file path**, passing that URL as the `url`
argument, or a second artifact gets created instead of updating this one.

## The audio is BOUND — but nothing plays it yet

**FIXED 2026-08-20 in `src/generate`.** All 19 generator-typed template fields hold
**zero values** — Mochi keeps generated content in `component-cache` keyed by input text,
never in `fields[].value` — so `<<Speech>>` resolved to the empty string and the renderer,
correct on all 7,716 cards, rendered silence. `src/generate` reconstructs the cache key
from the field and resolves it **on demand** (Zach's decision: audio changes when the
provider changes, and a typo fix must not need a migration).

Measured over 18,356 **field slots** — one per generator field per card, which is neither
a card count nor a blob count:

    exact        17,502   the identity Mochi filed
    other-voice     507   same text, DIFFERENT voice - playable now
    mismatch        312   card has a clip of that kind, nothing matches its text
    missing          35   never generated
    unbuildable     159   no resolvable input, so no key is invented
    -> 98.11% playable · 単語 Speech 3,278 exact + 124 other-voice

`other-voice` is **pain point #5 in the data**: it exists only where the template voice
changed under clips already generated. It is also the regenerate-with-Neural2-C set.

**Three things there were measured, not reasoned**, each a silent whole-template failure
if guessed: the generation input is the **rendered** text, not the stored value (基本情報's
key is `データ` where the value is `{{データ}}` — worth 471 cards); only `ai-task` /
`gender` / `from` / `to` / `language` are part of the key, never `ai-custom-prompt`; and
prompt markers carry spaces (`<< 言葉 >>`). See `src/generate/README.md`.

**WHAT STILL DOES NOT PLAY.** Binding is not playback. Nothing mounts a rendered card and
nothing calls `play()`, because that is the review UI (stage 7) and it does not exist. The
audio is now findable, not audible. `<<型>>` goes the other way from all of this —
materialise it, in a new `accents` table keyed by text rather than card.

See `src/generate/README.md`, `STAGE4.md` §3 and `notes/pitch-accent-pipeline.md`.

**The notation DEMONSTRABLY works, as of 2026-08-22.** **8 of 8** nucleus words put the
downstep where the derivation asked, once a measured +1 slice offset is removed (the F0
fall is realised late, and slices are cut over voiced frames). The two that first looked
like misses were the INSTRUMENT: re-synthesised at both candidate accents, Zach picked
the derived one both times. Both begin with an unvoiced consonant, and slices are cut
over voiced frames — so `accent_verify.py` produces false misses on unvoiced onsets and
its output is a shortlist to listen to, never a verdict. The 平板 "misses"
are the instrument, not the accents: 0 of 3 all-light-mora words missed against 7 of 9
with a long vowel, geminate or moraic n, which equal-width slicing cannot handle. And a
BLIND A/B says the notation carries no audible quality penalty — 46% of clips called
fuzzy were the notated arm, p = 0.709. `notes/pitch-accent-pipeline.md` §10;
`tools/accent_verify.py`, `tools/ab_clips.py`, `tools/blind_ab.py`.

**The 20-card listening test measured GOOGLE, not us.** Zach judged the clips accurate
and they were — but `cards` mode sent the kanji headword as element content, so Google
ignored the notation and he heard its unaided frontend. That is twenty more data points
saying his existing clips are fine; it says nothing about our derivation, which is still
unvalidated against audio. When a request carries notation the notation IS the answer —
Google renders whatever it is handed. `notes/pitch-accent-pipeline.md` §9.

Stages 0, 1, 2, 3, 4, 5 and 8 exist and are tested against the real export:
schema, importer, dashboard, template engine, **renderer** (`src/render`),
scheduler backtest, **search** (`src/search`), plus the content-addressed blob
store, the browser database handle (`src/db/browser.ts`, sqlite-wasm on OPFS) and
`src/text`. Stage 1.5 — the **field binding** (`src/generate`) — landed 2026-08-20. What is still
missing: the scheduler implementation, and the **review UI** — grading, the queue, and the app shell that
mounts a rendered card (stages 6, 7, 9, 10). `spike/viewer/` is a THROWAWAY browser
harness, not that shell. See `OVERNIGHT.md` for the gap list,
`SPIKE.md` for what the browser spike settled, and `notes/browser-feasibility.md`
for the OPFS measurements.

```bash
npm test                # 16 files, 592 passed, 1 skipped (the FSRS refit, gated)
                        # 32.7-87.7 s over five runs. Under load it can also emit
                        # "Timeout calling onTaskUpdate" — that is Vitest's reporter
                        # RPC, not a failure. Check the pass count, not the error line.
npm run typecheck       # exit 0
npm run build           # refuses to exit 0 unless dist/ actually imports (14 export subpaths)
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run dashboard -- --db build/hashigo.db --out dashboard.html
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths   # exits 1 on any location
npm run spike:check     # the browser contract; spike/ is excluded from tsconfig.json

# The accent pipeline. Python owns the analyser and NOTHING else -- see
# src/accent/README.md for why that boundary is a bug fix, not tidiness.
npx vite-node src/accent/cli.ts -- words --db build/hashigo.db --out build/head-words.txt
.venv-accent/Scripts/python tools/accent_derive.py --words build/head-words.txt --out build/accents.jsonl
npx vite-node src/accent/cli.ts -- load  --db build/hashigo.db --in build/accents.jsonl
npx vite-node src/accent/cli.ts -- ojad  --db build/hashigo.db     # 33 OJAD adjudications
npx vite-node src/accent/cli.ts -- queue --db build/hashigo.db     # 57 still disputed
python tools/f0.py build/longvowel/*.wav    # F0 in thirds
npm run spike:dev -- --host 127.0.0.1   # bind IPv4: a server on ::1 refuses 127.0.0.1
```

## A schema bump means RE-IMPORT, not migrate

`SCHEMA_VERSION` is **7** and `applySchema` refuses any other version outright.
That is deliberate — every database here rebuilds from `exports/` in about
fifteen seconds and the reviews still come from the export — but it means a
schema change is a three-step chore, and skipping the third breaks a test:

```bash
rm build/hashigo.db
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run dashboard -- --db build/hashigo.db --out dashboard.html   # asserts byte-identical
```

The dashboard prints the schema version, and `test/dashboard.test.ts` compares
the committed file byte-for-byte, so a bump without a regenerate fails there with
a one-line diff. This happened three times in one session. It is the workflow,
not a surprise. The accent data also has to be reloaded — `NEXT.md` has the four
commands.

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
7. **The generator's input is the RENDERED text, never the stored value.** This
   cost real work twice, in two different subsystems, in one session: the audio
   cache key missed all 471 基本情報 cards because the value is `{{データ}}` and
   the key is `データ`, and the accent analyser mis-READ 準備 as ジュン+ソナエ and
   面倒 as メン+タオセ because U+200E sits inside those compounds. 3,016 of those
   marks are on 2,504 cards. `generationInput` and `accentKey` are the two
   definitions and they are both thin wrappers over `renderPlainText`.
8. **A cross-check analyser is stored but never RESOLVES.** UniDic agrees with
   the primary derivation on 97.31% of 3,007 comparable words, and it is
   measurably wrong on some of the words it could otherwise rescue — it reads 正義
   as the personal name マサヨシ. A wrong accent drilled through spaced repetition
   is worse than no accent, so it is a candidate for adjudication, never the
   answer. See `accent_disagreements`.
9. **A field that exists HERE and not in any Mochi export is marked
   `template_fields.local = 1`.** `pruneFieldValues` cannot otherwise tell a field
   Mochi DELETED from one Mochi NEVER HAD, and it threw away all 3,454
   materialised `型` labels the first time it met one. This matters because
   re-importing is not a one-off — Zach still reviews ~100 cards/day in Mochi, so
   every fresh export brings history worth having, and a repair that is needed
   once after an import is needed forever.
10. **Links render PLAINLY, in place, on whatever side they are authored on.**
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

```plaintext
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

```plaintext
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

* **Windows, and Zach's interactive shell is PowerShell 5.1.** So
  **`VAR=value cmd` is a parser error** in anything handed to him — it is bash
  syntax, PowerShell needs `$env:VAR="value"; cmd`. `&&` is also a parser error in
  5.1; use `;`. This has now cost him two failed commands, so:
  **every script that prints Japanese sets its own encoding**, in the script, and
  no documented command line carries an env prefix. The console is **cp932**
  (Japanese locale), so `sys.stdout.reconfigure(encoding="utf-8",
  errors="replace")` at the top of the file is what makes that work — asking the
  caller for `PYTHONIOENCODING` pushes a bash-ism onto a PowerShell user.
  (Point-in-time reports under `notes/`, `FIXES.md`, `STAGE4.md` etc. still show
  the old prefix inside quoted transcripts. Those are records of what was run, not
  instructions.)
* Python is `python` (3.13). `python3` is not on PATH — it hits the Microsoft Store
  alias and fails.
* The Bash tool's working directory does not reliably persist between calls. Use
  absolute paths, or `cd` in the same command.

## Conventions

* Deck, template, and field names are Japanese where the user wrote them Japanese.
  Do not translate or romanise them — `単語`, `漢字`, `例文`, `意味` are identifiers.
* Language codes normalise to BCP-47 (`ja-JP`), never Mochi's inline `jp`.
* Prefer measuring over assuming: this project has 102,020 graded reviews and 56,767
  `component-cache` entries (ai 19,710 · speech 24,558 · translate 9,216 · furigana
  3,255 · image-search 18 · dictionary 10), which double as labelled test sets. See the
  memory note on not inheriting Mochi's defaults.

## TTS: settled by measurement, 2026-08-20

**Provider: Google. Voice: `ja-JP-Neural2-C` (male).** Zach picked it by ear and it
agrees with an F0 measurement. He had been shadowing a female voice for four years only
because Mochi locks the voice at template level — which is a fifth pain point this
project exists to fix: per-card voice override, cheap regeneration, cheap deletion.

Measured with 22 synthesis calls, F0 over the voiced span in thirds
(`tools/accent_probe.py`, `notes/pitch-accent-pipeline.md`):

* **Google honours `<phoneme alphabet="yomigana">` on Neural2** — `^` opens an accent
  phrase, `!` marks the downstep. Three notations over the same text produce three
  correct, distinct contours.
* **Azure does NOT**, on a current neural voice. Microsoft really does document `'` as
  "Accent position" (`jj127901`) — so SPEC's earlier claim that it has no notation was
  wrong and is corrected — but all three contours come out near-identical and 頭高
  starts at the LOWEST pitch of the three. The 2012 reference cannot speak for a 2026
  neural voice.
* **THE SILENT TRAP: Google ignores the notation when the element contains kanji.** It
  works with kana content and fails with no error at all — the audio returns unaccented
  and sounds plausible. Every request must carry the READING as element content, never
  the headword.
* **Voice fidelity varies within Google.** `Chirp3-HD` changes its output per notation
  but its contours do not match the patterns — newer and better-sounding, and wrong for
  this purpose. Voice choice is a correctness decision here, not an aesthetic one.
* **Azure's own frontend was right all along.** Its unaided predictions land all four
  minimal pairs, so the 7,403 existing Nanami clips are most likely fine. The case for
  moving is override control and the male voice, NOT broken audio.

Annotate the **isolated word** only, never the example sentence: isolated words are the
hard case (no context to disambiguate 箸 from 橋), sentences give the frontend context and
it handles them well, and annotating them would require getting every accent-phrase
boundary right — a heuristic measured to fail *silently* on `に引き換え`.

**No particle in the audio** (Zach's decision). Three different particles get conflated;
`notes/pitch-accent-pipeline.md` keeps them apart. The probe particle is internal to the
derivation and never spoken — OpenJTalk returns the mora count rather than `0` for 平板,
so bare 尾高 and bare 平板 are indistinguishable without it. The naive `if accent > 0`
rule fires on **100%** of his bare words and would drill **2,065 phantom 尾高**.
