# Hashigo (梯子)

A local-first spaced-repetition app replacing [Mochi](https://mochi.cards) for one
user's Japanese study. Built because Mochi's developer stopped fixing reported bugs.

## Where this is — and where the numbers live

**The whole path from "what is due" to "these bytes" exists in `src/`. What does not
exist is the SCREEN.** Nothing mounts a card in a browser and nothing calls `play()`.

Built and tested against the real export: stages **0-6 and 8, plus 1.5** — schema,
importer, dashboard, template engine, renderer (`src/render`), scheduler backtest,
the scheduler itself (`src/scheduler`), search, the content-addressed blob store, the
browser database handle (`src/db/browser.ts`, sqlite-wasm on OPFS), `src/text`, the
field binding (`src/generate`), the card loader (`src/cards`) with its audio
resolver, and — as of 2026-08-22 — the **review session** (`src/session`) and the
**card mount** (`src/review`).

**`play()` IS NOW CALLED, and the shipping reveal loop has run over real cards for
the first time.** `src/review`'s `mountCard` drives the whole path — `loadCard` →
render → `expandGeneratorFields` → `renderSides` → `audioController` →
`shadowingLoop` — and `test/review.test.ts` measures the hard rule over it:

    mount + enter, 120 単語 cards   120 clip mounts · 0 resolve calls · 0 play() calls
    reveal, 40 単語 cards            39 cards played · 39 play() calls

That closes a real gap. `spike/viewer/` had proved Chromium does not autoplay, but
its own README says it hand-rolls its reveal sequencing rather than importing
`shadowingLoop`, so the green panel was evidence about the BROWSER and never about
the shipping code.

**What is left is the CHROME: CSS, the two buttons, and the app shell.** The
session, the mount, the audio and the loop all exist and are pinned. Design settled: decision
23, direction A2. Also missing: the app shell, editor and sync (stages 9, 10, 11).
`spike/viewer/` is a THROWAWAY harness, not that shell.

Three things that are built and do NOTHING, which is the opposite trap to rebuilding:

* **The audio is bound but nothing plays it.** Binding is not playback; `play()`
  belongs to stage 7. See `src/generate/README.md`.
* **`<<型>>` has never been written to a card.** `materialiseAccents` iterates
  `template_fields WHERE type = 'accent'` and there are **zero such rows**, so it has
  been a no-op reporting 0 every time it ran. The template body edit is Zach's.
* **No code path gets a database OUT.** Decision 17 is why that has to change before
  he trusts the app.

The accent pipeline is **DONE and VALIDATED** — do not redo it.
`notes/pitch-accent-pipeline.md` §7-§10 has every measurement, including the two that
read as failures and are not: `accent_verify.py` produces false misses on unvoiced
onsets, and the 20-card listening test measured GOOGLE rather than our derivation.

> [!important] Before you pick anything up
> **D1 IS DECIDED as of 2026-08-22, so stage 7 is no longer blocked on taste** — the
> review screen is **direction A2** and decision 23 is the specification. That was the
> last thing standing between the finished pipeline and a usable app.
>
> What exists is a MOCKUP (`build/mock/out/`, regenerate with the two commands below):
> no scheduler, no grading, no writes. Building the real screen means wiring
> `hashigo/scheduler` → `hashigo/cards` → `hashigo/render` behind that layout, and the
> hard rule still governs it — **audio fires on cloze reveal, never on side entry.**
>
> Decision 23 names three things it deliberately does NOT settle (the head word pinning
> after reveal, where a decision-13 re-ask re-enters the session, and type/spacing
> detail). Those are still his. D2-D5 remain in his Obsidian planner, which no agent
> reads.

**Every status figure lives in [NEXT.md](NEXT.md), not here** — the queue counts, the
gate results, what landed when, and the dependency-ordered list of what is left. That
split is deliberate: this file and that one carried the same numbers and went stale in
two places at once. If you want the state, read that file; if you change the state,
change it there.

**[SPEC.html](SPEC.html) is the authoritative design document** (build spec, **draft
8**). Every figure in it is measured from the real export in `exports/`, not
estimated. Published copy:
<https://claude.ai/code/artifact/c8416a42-779a-49da-81c1-54459067d94b> — to revise,
edit `SPEC.html` and republish **the same file path**, passing that URL as the `url`
argument, or a second artifact gets created instead of updating this one.

## The commands

```bash
npm test                # 20 files, 697 passed, 1 skipped (the FSRS refit, gated)
                        # 32.7-87.7 s over six runs.
                        # IT EXITS 1 ON A FULLY PASSING RUN. The "Timeout calling
                        # onTaskUpdate" lines are Vitest's reporter RPC under load,
                        # they count as `Errors`, and they set the exit code with
                        # `697 passed` printed directly above. So read the pass
                        # count -- not because the error line is noise, but because
                        # $LASTEXITCODE is WRONG. Anything chaining on this gate
                        # (CI, a hook, a `;`-joined line) reports a break that is
                        # not there. Measured on a clean tree with zero edits.
npm run typecheck       # exit 0
npm run build           # refuses to exit 0 unless dist/ actually imports (24 export subpaths)
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run dashboard -- --db build/hashigo.db --out dashboard.html   # English; --locale ja for the other
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths   # exits 1 on any location
npm run spike:check     # the browser contract; spike/ is excluded from tsconfig.json

# The scheduler. Read-only except `seed`, which writes state and moves no due date.
npx vite-node src/scheduler/cli.ts -- counts   --db build/hashigo.db
npx vite-node src/scheduler/cli.ts -- queue    --db build/hashigo.db --limit 20
npx vite-node src/scheduler/cli.ts -- forecast --db build/hashigo.db --days 14

# The card mount. `src/review` is the first thing in src/ to drive shadowingLoop,
# the reveal loop that SHIPS. See src/review/README.md for the sharp edge:
# `loadRenderedCard` cannot reach the audio, and fails silently on 5,664 cards.

# The session. READ-ONLY: there is no `grade` command, on purpose -- grading from
# a terminal would write real reviews with no card in front of you.
npx vite-node src/session/cli.ts -- plan --db build/hashigo.db --limit 14
npx vite-node src/session/cli.ts -- plan --db build/hashigo.db --order spread

# The accent pipeline. Python owns the analyser and NOTHING else -- see
# src/accent/README.md for why that boundary is a bug fix, not tidiness.
npx vite-node src/accent/cli.ts -- words --db build/hashigo.db --out build/head-words.txt
.venv-accent/Scripts/python tools/accent_derive.py --words build/head-words.txt --out build/accents.jsonl
npx vite-node src/accent/cli.ts -- load  --db build/hashigo.db --in build/accents.jsonl
npx vite-node src/accent/cli.ts -- ojad  --db build/hashigo.db     # 33 OJAD adjudications
npx vite-node src/accent/cli.ts -- queue --db build/hashigo.db     # 57 still disputed
python tools/f0.py build/longvowel/*.wav    # F0 in thirds
# THE DEV SERVER'S BIND ADDRESS IS A TRAP IN BOTH DIRECTIONS. Binding one address
# family REFUSES the other, and on Windows `localhost` resolves to ::1 FIRST.
#   --host 127.0.0.1   IPv4 loopback only. Fine for a local browser, and it is what
#                      to use when nothing external needs in. But a client that asks
#                      for `localhost` hits ::1, gets ECONNREFUSED, and whether it
#                      recovers is up to the client: PowerShell falls back to IPv4
#                      and succeeds, **ngrok does not and returns 502 Bad Gateway.**
#                      Measured 2026-08-22 -- this cost a round trip.
#   --host ::          Dual stack. Answers ::1, 127.0.0.1 and localhost, so a tunnel
#                      pointed at `localhost:5273` works. ALSO binds the LAN, which
#                      Vite prints as "Network:". Use it for phone/tunnel testing.
# Tunnelling also needs the hostname in `server.allowedHosts` (vite.config.ts), and
# `server.fs.allow` is narrowed on purpose -- with `[root]` the /@fs/ route served
# build/hashigo.db (74 MB) and the 617.9 MiB blob store to anyone who could reach it.
npm run spike:dev -- --host ::            # tunnel/phone: answers localhost AND 127.0.0.1
npm run spike:dev -- --host 127.0.0.1     # local only: nothing outside this machine
# The stage-7 mockups ride the same server at /mock/ (middleware, so no second tunnel):
npx vite-node scripts/mockup-cards.ts    # then mockup-html.ts -- regenerates /mock/
```

## A schema bump means RE-IMPORT, not migrate

`SCHEMA_VERSION` is **8** and `applySchema` refuses any other version outright.
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
not a surprise. The accent data also has to be reloaded. `NEXT.md` lists six commands; **four of them
are the fast path**, because the derived `.jsonl` files live in `build/` and survive the
rebuild — Python is only needed when the head words themselves change:

```bash
npx vite-node src/accent/cli.ts -- words --db build/hashigo.db --out build/head-words.txt
npx vite-node src/accent/cli.ts -- load  --db build/hashigo.db --in build/accents.jsonl
npx vite-node src/accent/cli.ts -- load  --db build/hashigo.db --in build/accents-unidic.jsonl
npx vite-node src/accent/cli.ts -- ojad  --db build/hashigo.db
npx vite-node scripts/reading-apply.ts -- --db build/hashigo.db --apply   # the 13 読み rows
```

**The last line is the LOCAL FIELDS, and it belongs to the rebuild, not to the accents.**
A rebuild starts from `rm build/hashigo.db`, so it takes every locally-authored field and
value with it — `読み`, `かな主流`, and the `型` field when it exists. The script is
idempotent and self-erasing: run twice and the second run says "ALREADY APPLIED".

**Do not skip the second `load`.** The UniDic cross-check is a separate file, and without
it `accent/cli.ts queue` reports **0 disputed instead of 57** — which reads as "nothing
left to adjudicate" rather than "the cross-check is missing". Verified on the v8 rebuild:
3,850 openjtalk + 3,015 unidic + 33 manual, `accent_resolved` 3,850, queue 57.

## Decisions that are settled — do not relitigate these

> [!IMPORTANT]
> **THIS INDEX IS THE ONLY PLACE A DECISION COUNTS AS RECORDED.** Zach also keeps a
> planner in Obsidian, and it holds his reasoning in his own words — but **no agent
> reads it.** Four decisions lived only there until 2026-08-22 and one (`型`
> placement, decision 20) was duly reopened by an audit as an "open question" weeks
> after he had settled it. Nobody was careless: the decision was invisible to the
> people who needed it. So if it is settled in conversation and it is not here, it
> is not settled. Write the line here first, then the reasoning anywhere else.
>
> **Read [DECISIONS.md](DECISIONS.md) before proposing anything that touches one.**
> It carries the full derivation, the measurements, and the tensions that were
> accepted rather than overlooked. This is the WHAT; that is the WHY. Numbering is
> cited across `src/`, `test/` and the notes — **never renumber, only append.**

1. **FSRS-6, max interval 365 days, target retention 0.90.** The 365 is DERIVED, not
   inherited from Mochi — and it is the centre of a ±5% band, not a ceiling (see 11).
2. **Binary grades only** — remembered / forgot. No `grade` column; `w[15]`/`w[16]` frozen.
3. **The six empty leaf decks are dropped** by default: 45 decks become 39.
4. **Blobs are content-addressed.** No absolute path is ever stored in the database.
5. **Stale pre-template `content` is discarded on import, and reported** (3,159 cards).
6. **Name the interval basis, or the number is not a fact** — `elapsed_days` (measured)
   vs `scheduled_days` (planned). Generalises well past intervals; cited most often.
7. **A generator's input is the RENDERED text, never the stored value.**
8. **The UniDic cross-check is stored but never RESOLVES** — a candidate for
   adjudication, never the answer. A wrong accent drilled is worse than no accent.
9. **A field that exists here and in no Mochi export is `template_fields.local = 1`.**
   It protects a field we ADDED; it cannot protect an EDIT to a field Mochi owns.
10. **An explicit `読み` beats the head word as generator input**, and renders as
    furigana. Final split 6 読み / 6 かな主流 / 1 意味, with `（おす）雄` a ratified override.
11. **Interval fuzz is ±5%, applied ONCE at grade time, keyed PER TRACK, AFTER the
    cap.** Two-sided, so **the issued maximum is 383 days**. Do not reorder it.
12. **New cards default to 10/day, and are a SETTING.**
13. **A forgotten card is SHOWN again at the end of the session, and NOT GRADED.**
14. **No one-off respread of the existing due dates.**
15. **New cards are 10 TRACKS a day, chosen at RANDOM; forward and reverse are not paired.**
16. **ONE final import from Mochi, then never again** — and the guard is BUILT
    (`0e04a10`): a re-import cannot revert a locally-graded track's schedule.
17. **A local export/backup is not day one, but is required before he trusts the app.**
18. **The TTS key NEVER goes in the client** — proxied through the stage-11 Worker.
19. **Links render PLAINLY, in place, on whatever side they are authored on.**
20. **`型` renders on side 2, immediately above `<<Speech>>`; `かな主流` on side 1,
    inside the `<<#Reading>>` gate.** The asymmetry is the exercise: `型` is the ANSWER.
21. **Fields are MOVABLE between templates, from the UI** — landing with stage 10.
22. **The 6 truly ambiguous words stay UNLABELLED** (`まく` is three different accents).
23. **The review screen is direction A2: A's terminal look, C's hand.** Dark, mono,
    dense, everything on one scroll; controls pinned to the bottom edge; round replay
    button bottom-RIGHT because he reviews one-handed with his RIGHT hand; keycap hints
    only where a real pointer exists, **never behind hover** (decision 19). Settled
    2026-08-22 — this closes **D1**, which was the last thing blocking the project.
24. **Agents COMMIT their own work, without asking.** Standing grant from Zach,
    2026-08-22: *"you don't have to wait for my instructions to commit, you know when to
    commit, make it clean and deliberate, no permission needed, commit is always
    revertible, and it's your job now."* This **supersedes** the old "commit only when
    the user asks" convention. Clean and deliberate: scoped commits with real messages,
    gates green first, never a commit that breaks a gate. He said COMMIT — there is no
    remote, and pushing is still not authorised.
25. **New cards carry a `New Card` label, and it is PER TRACK — not per card.**
    Mochi does it that way and Zach wants it kept: forward and reverse each get
    their own, and they need not match. `SessionItem.origin` already carries it at
    the right granularity. **Terminology trap:** he said the label is "per side",
    meaning per DIRECTION; in this repo "side" means the parts of a card (side 1-4
    of 単語), so read it as per TRACK or it lands in the wrong place.

**Five small calls an agent had made without authority were ratified 2026-08-22**
— the `---` horizontal rule, the CommonMark emphasis deviations, the dashboard's
zero JavaScript, the heatmap's 4 colour bins, and `tags` keeping 20 rows for 19
real tags. All five as recommended; the reasoning is in
[DECISIONS.md](DECISIONS.md).

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

## Zach's own words are in the repo now, not only in Obsidian

`notes/zach-in-his-own-words.md` holds the quotes the decisions below were written FROM,
moved out of his Obsidian planner on 2026-08-22 at his instruction. **If that file and a
decision here ever disagree, that file is right** — the direction is one-way: it is the
source, this quotes it. It is also the lesson of decision 20 applied to itself, since a
thing recorded only in Obsidian is a thing no agent can read.

`notes/open-sourcing.md` holds the deferred open-sourcing decision and what was already
checked for it, moved out of the same file for the same reason.

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
