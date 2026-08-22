# Hashigo (梯子)

A local-first spaced-repetition app replacing [Mochi](https://mochi.cards) for one
user's Japanese study. Built because Mochi's developer stopped fixing reported bugs.

## Where this is, right now (2026-08-22)

**9 of 11 stages plus stage 1.5 are built and tested against the real export.** The
scheduler runs, the accent pipeline is validated, and as of 2026-08-22 **the whole path
from "what is due" to "these bytes" exists in `src/`** — `src/scheduler` says what to
study, `src/cards` turns a card id into a rendered card and resolves its audio out of the
617.9 MiB store. What does not exist is **the screen**: nothing mounts a card in a browser
and nothing calls `play()`. That is stage 7.

> [!warning] Two things to check before you touch anything
> 1. **`git status` — the tree is NOT clean.** A batch of built, green, uncommitted work
>    is sitting in it. `NEXT.md`'s "STATE RIGHT NOW" block lists exactly what.
> 2. **There is no unsupervised work left.** Table A in `NEXT.md` is empty and the
>    critical path is done. What remains is stage 7, and its shape is Zach's.

**Zach's decision queue is NOT empty — it has five items and they live in his planner**
(`C:\DEV\obsidian\second-brain\PARA\1Projects\ハシゴ\Planner.md`, which no agent reads;
it is two sections and nothing else). **D1 — what the review screen looks like — is the
only thing blocking the project.** Do not ask him to re-decide anything in the numbered
list below; decisions 1 and 11 carried a NOT-RATIFIED warning for part of 2026-08-22 and
**he ratified both that day**, so the warning is gone because it is answered, not because
it was dropped.

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

**WHAT STILL DOES NOT PLAY.** Binding is not playback. Nothing calls `play()`, because
that is the review UI (stage 7) and it does not exist. As of 2026-08-22 something DOES
mount a rendered card: `src/cards` is the loader — a card id in, a renderable card out —
and it regenerates the corpus figure through its own path (6,855 speech mounts over 5,664
cards, expanded 10,722, divergent 0) rather than repeating it. As of the same day `src/generate` also loads in a
browser: its cache key moved to `src/blobs/generation.ts` and now hashes through the
portable synchronous SHA-256, so `KNOWN_NODE_BOUND` is empty. **That fix was not the one
three documents predicted** — they called `crypto.subtle` "the one genuinely invasive
change" on the grounds that it is async; `src/blobs/sha256.ts` had already made that
false, and nothing changed signature. Pinned by 36,398 corpus identities hashing
identically under both digests. And the resolver's second half landed the same day:
`cardAudioResolver` in `src/cards/audio.ts` reads real payloads out of the 617.9 MiB
store — 361 of 373 speech mounts over a 400-card sample, 16.2 MiB of `audio/mpeg`. So the
whole path from "what is due" to "these bytes" now exists. What does not exist is the
SCREEN: nothing mounts a card in a browser and nothing calls `play()`, because that is
stage 7. `<<型>>` goes the other way from all of this —
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

Stages 0, 1, 2, 3, 4, 5, 6 and 8 exist and are tested against the real export:
schema, importer, dashboard, template engine, **renderer** (`src/render`),
scheduler backtest, **the scheduler itself** (`src/scheduler`), **search**
(`src/search`), plus the content-addressed blob store, the browser database handle
(`src/db/browser.ts`, sqlite-wasm on OPFS) and `src/text`. Stage 1.5 — the **field
binding** (`src/generate`) — landed 2026-08-20. What is still missing: the **review
UI** — a session, grading buttons, and the app shell that mounts a rendered card
(stages 7, 9, 10, 11). `spike/viewer/` is a THROWAWAY browser harness, not that
shell. See `OVERNIGHT.md` for the gap list, `SPIKE.md` for what the browser spike
settled, and `notes/browser-feasibility.md` for the OPFS measurements.

## The scheduler runs, as of 2026-08-22 — and the queue is 443 cards

`src/scheduler` is stage 6: `gradeTrack` writes a review and advances a track,
`dueTracks`/`newTracks`/`queueCounts`/`reviewForecast` answer what to study.
Measured against the real export at 2026-08-22, and pinned in
`test/scheduler.test.ts`:

    due          443    of which 328 from before today
    new        3,980    never reviewed (4,366 before the archived filter)
    scheduled  8,518    not yet due
    dormant        0

**Three implementation facts that are not obvious and cost thought.** Each is a
whole-subsystem defect if guessed, and `src/scheduler/README.md` has the reasoning:

* **An imported Mochi track is SEEDED from its history, lazily.** 9,026 of 13,392
  tracks have `scheduler = 'mochi'` and no state — Mochi never exported stability
  or difficulty. The first local grade replays that track's whole review log
  through FSRS-6 and then applies the grade. Lazily, so an ungraded track keeps
  Mochi's own due date and day one's queue is the queue he already knows.
* **The model is fed WHOLE LOCAL DAYS; `reviews.elapsed_days` keeps the exact
  fraction.** The fit only ever saw date-only observations, and whole days are
  what reach FSRS's short-term branch. A test grades the same card at 02:00 and
  20:00 of one day and demands an identical schedule — decision 6 below, as code.
* **The planned interval comes from the previous REVIEW ROW, never from
  `card_tracks.scheduled_days`.** That is what makes `review_interval_audit` pass
  by construction rather than only while the cache happens to be right.

It does NOT hold a session, choose a new-cards-per-day number, interleave new with
due, or undo a grade. Those are stage 7's and one of them is still his taste
(decision 12 settled the other: 10 new cards a day, as a setting).

**Interval fuzz is live** — ±5%, keyed per track, applied AFTER the cap, which means
an issued interval can reach 383 days. Decision 11 has the measurements and the one
consequence worth his eye. `scripts/fuzz-load.ts` regenerates every figure in it.

**復習予測 is no longer blank.** The dashboard's forecast tile landed with stage 6 and
states whose plans it charts: **8,853 Mochi / 0 Hashigo** on the day it shipped, because
having a scheduler rescheduled nothing. A test reconciles it against `queueCounts` day
for day — 108 due at the as-of date plus 39+86+95+115 is the 443 the scheduler CLI
reports four days later.

```bash
npm test                # 20 files, 697 passed, 1 skipped (the FSRS refit, gated)
                        # 32.7-87.7 s over six runs. Under load it can also emit
                        # "Timeout calling onTaskUpdate" — that is Vitest's reporter
                        # RPC, not a failure. Check the pass count, not the error line.
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
> **THIS LIST IS THE ONLY PLACE A DECISION COUNTS AS RECORDED.** Zach also keeps a planner
> in Obsidian, and it is genuinely useful — it holds his reasoning in his own words — but
> **no agent reads it.** Four decisions lived only there until 2026-08-22 and one of them
> (`型` placement, now decision 20) was duly reopened by an audit as an "open question"
> weeks after he had settled it. Nobody was careless: the decision was invisible to the
> people who needed it.
>
> So: if it is settled in conversation and it is not here, it is not settled. Write it
> here first, then anywhere else.

1. **FSRS-6**, max interval **365 days**, target retention **0.90**.
   **RE-RATIFIED 2026-08-22, and this time the 365 IS derived.** Zach reopened it —
   *"365 days was a default number from mochi flashcards … but I didn't derive it"* —
   and he was right twice over: Mochi itself **lifted that cap on 2026-02-22** and now
   plans out to 2,707 days, and the reason on record here was **wrong**. See decision
   11 and `notes/max-interval-and-relearning.md`. The derived reason a cap exists at
   all: the fit's opinion about long intervals is manufactured by the scheduler that
   trained it — observed retention RISES through the tail (94.35% → 96.40% → 98.16%),
   which memory does not do, and the fitted decay ran to its floor asking for flatter
   still. A cap bounds how far that bias runs; it is not a claim about how long a
   memory lasts. 365 specifically, because the PLANNED support ends exactly there.
   Priced, so nobody has to re-derive it: 365 costs **+33.3% more reviews a year**
   than no cap (17,314 vs 12,986, ~11.9/day), and 365 → 454 would buy back 3.5/day
   for 89 days of extrapolation. He kept 365.
   `src/scheduler/policy.ts` holds them (`TARGET_RETENTION = 0.9`); `BACKTEST.md`
   holds the measurements. Since 2026-08-22 the 365 is the **centre of a ±5% band,
   not a ceiling** — interval fuzz is applied after the cap, so an issued interval
   can reach 383 days. That is forced by measurement; decision 11 has the why. It was 0.95 until 2026-08-19 and this file said so for
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
   **MEASURED END TO END 2026-08-22, and the result is only three-quarters good.**
   The first local fields were finally created (`読み` and `かな主流`, ids
   `local-yomi` / `local-kana-primary`, on 単語 and 言葉) — before that day
   `template_fields` held **zero** rows with `local = 1`, so this whole mechanism
   was built, tested and never once exercised. Applying the 13 rows and then
   re-importing all three exports into the SAME database:

       local field rows      4 of 4 survive     template_fields is UPSERT-only; nothing deletes a field
       読み values          12 of 12 survive    pruneFieldValues exempts local = 1
       かな主流 values        6 of 6 survive     same clause
       head words           12 of 12 REVERT     `name` is MOCHI's field, and Mochi still holds 器（うつわ）

   **So `local = 1` protects a field we ADDED; it cannot protect an EDIT to a
   field Mochi owns.** The half-applied state is worse than either end — the card
   would carry `器（うつわ）` as its head AND `うつわ` as its 読み — so
   `scripts/reading-apply.ts` is idempotent and re-running it repairs it. Decision
   16 is what makes this finite: one final import, then never again, and the
   reverting stops.
10. **An explicit READING beats the head word as generator input.** Zach's
   `器（うつわ）` parentheses were a Mochi TTS workaround — Mochi read 器 as キ, 革 as
   カク, 的 as テキ. A `読み` field (`local = 1`) carries the intended reading, and
   when present it is the input for BOTH speech generation and accent derivation,
   and renders as furigana. His reason for the furigana part is the one that
   settles it: the furigana generator would otherwise mis-read the same kanji.
   The 13 parenthesis cards classify by a decidable rule — kanji-outside +
   kana-inside is a reading (7), kana-outside + kanji-inside is kana-primary (5),
   Latin inside is a gloss (1), zero unclassified. `notes/kana-primary-words.md`.
   **ONE RATIFIED EXCEPTION, 2026-08-22.** The rule reads script POSITION, so
   `（おす）雄` came out a reading while its twin `めす（雌）` came out kana-primary —
   one pair (*"male (animal, plant)"* / *"female (animal, plant)"*), authored
   together, split by which side the bracket landed on. Zach ruled **おす is
   kana-primary, like its twin.** So the final split is **6 読み / 6 かな主流 /
   1 意味**, and card `Ufs9lMJR` is an override, not a rule change: the head word
   and `読み` are identical either way, and only the かな label differs.
   `scripts/reading-parse.ts` carries the override with its reason.
11. **Interval fuzz is ±5%, applied ONCE at grade time, keyed PER TRACK.** Zach
   raised it; it was missing entirely. **BUILT 2026-08-22** — `INTERVAL_FUZZ` in
   `src/scheduler/policy.ts`, applied in `gradeMemory`, keyed on the track id by
   `gradeTrack`. It matters here more than in general because **42.9% of the live
   scheduled tracks — 3,650 of 8,518 — sit at exactly 365 days**, the cap, so any
   heavy study day becomes a spike a year later. Re-measured on the real export by
   `scripts/fuzz-load.ts`, and every figure below came back:

   ```plaintext
   keying                      worst day    CV
   none (today)                      188   2.48
   per TRACK                          71   1.94
   downward only at the cap          104   2.05
   per COHORT, by due date           295   2.84   <- WORSE than none
   per COHORT, by interval           180   2.49   <- no better than none
   ```

   The width was DERIVED, not copied from Anki: the smallest width whose worst day
   fits inside the realised sustained load is 4% on a per-active-day basis (77.5) and
   6% on `BACKTEST.md`'s 69.2 basis, so 5% sits between two defensible bases. The
   return flattens right there — ±4% gives 78, ±5% gives 71, ±6% gives 73.
   **Two ways to build it wrong.** Keying the shift per COHORT rather than per track
   translates the clump instead of spreading it and makes things worse — measured, by
   getting it wrong first. And computing it when READING the queue rather than at
   grade time makes the due date jitter on every query. It does not invalidate
   `BACKTEST.md`: that measured which scheduler ranks best, and the fuzzed value is
   what was planned, so it lands in `reviews.scheduled_days` and
   `review_interval_audit` still passes — pinned by a test.

   **THE ONE CONSEQUENCE THAT CHANGES DECISION 1: the fuzz goes on AFTER the cap, so
   an issued interval can reach 383 days.** `MAX_INTERVAL_DAYS` is now the centre of
   a ±5% band rather than a hard ceiling. That is forced, not preferred. Seeding every
   live track and asking the fitted model what it wants at 0.90: the **median raw
   interval is 988 days**, 6,669 of 8,961 tracks (74.4%) exceed the cap, and **6,617
   of those — 99.2% — want more than 384 days**, which is 365/0.95. Fuzz applied
   before the cap cannot pull a single one of them under 365; they clamp straight back
   onto it and the spike is untouched. Fuzz-before-cap is not the conservative choice,
   it is the inert one.
   **THE "383 < 454" ARGUMENT IS WITHDRAWN, 2026-08-22.** It said the overshoot stays
   inside observed support because the longest observed gap is 454 days. That mixes the
   two interval bases, which is exactly what decision 6 forbids: 454 is the ELAPSED
   edge, and `scripts/cap-derive.ts` measures that **all 3,009 gaps past a year came
   from a plan of <= 365 days — not one from a longer plan.** So 454 is Mochi's own cap
   plus how late Zach runs, not evidence about memory at 454 days. On the PLANNED basis,
   which is the one a cap constrains, 383 is 18 days past anything ever issued. Small,
   but an extrapolation.
   Zach's `Math.min(fuzzed, 365)` variant is measured and is the weakest of the three:
   it shoves every upward-fuzzed track back onto exactly the cap, so **1,892 of 3,650 —
   52% — land on one day again**, worst day 113 against downward-only-10%'s 73.
   **RATIFIED 2026-08-22: two-sided, after the cap. The issued maximum is 383 days.**
   Zach was shown the alternative and chose this. The alternative was real, not a straw
   man — the earlier dichotomy ("383, or accept a worst day of 104") was false, because
   downward-only had been tested at one width. Swept properly (`scripts/fuzz-load.ts`):

       two-sided +/-5%              worst 71   CV 1.94   issued max 383d   <- CHOSEN
       downward-only, 5% width      worst 104  CV 2.05   issued max 365d
       downward-only, 10% width     worst  73  CV 1.91   issued max 365d

   Downward-only at 10% would have given the same 36-day window and the same spread —
   73 against 71 — while leaving 365 an absolute ceiling, for about 2% more reviews.
   **He took the two-sided form knowing that.**

   **THE ONE TENSION, RECORDED BECAUSE IT WAS ACCEPTED AND NOT OVERLOOKED.** Decision 1
   keeps 365 because that is where the PLANNED support ends. Two-sided fuzz then issues
   up to 383, which is 18 days past it. That is a real extrapolation, just a small and
   deliberate one — 4.9% past the edge, on the 42.9% of tracks that sit at the cap. Do
   not "fix" it by reordering the fuzz and the cap: fuzz-before-cap is INERT (99.2% of
   over-cap tracks want more than 384 days and clamp straight back onto 365), and
   `Math.min(fuzzed, 365)` is worse still — it puts **1,892 of 3,650 at-cap tracks, 52%,
   back onto one day**, worst day 113. Both are measured.
12. **New cards default to 10/day and are a SETTING.** Mochi's default, and Zach wants
   the same. At 10/day the 3,980 waiting take ~398 days, so it is the dial that decides
   how fast the backlog moves. `newTracks` is already returned separately from
   `dueTracks` so the session layer owns this.
13. **A forgotten card is SHOWN again at the end of the session, and NOT GRADED.**
   Decided 2026-08-22, and it settles stage 7's last open question. Measured, because
   the intuition here was wrong twice: Mochi does **not** do same-day relearning — 98.5%
   of the 6,996 same-day reviews follow a PASS and 6,895 are the second time a card was
   ever seen, so those are new-card learning steps. Mochi's real lapse behaviour is
   next-day (504 retries, 83.3% recovered). And **0 of 103** same-day-after-failure
   reviews were ever remembered, so this corpus contains no evidence either way.
   Grading a same-day re-ask would take FSRS-6's short-term branch and move the next
   interval by a flat **3.50× on a pass, 0.173× on a second failure** — flat at every
   stability because w19 fitted to 0.000053, its floor — and that multiplier is
   calibrated on new-card second looks with **zero** post-lapse observations. So: show
   it, do not grade it. He gets the card back, the schedule stays put, nothing is fed to
   the model where it is guessing, and it CREATES the data that would later justify
   grading it. Implementation is a session-local list: no review rows, no scheduler
   change. `notes/max-interval-and-relearning.md` §2, `scripts/relearn-cost.ts`.
14. **NO one-off respread of the existing due dates.** Decided 2026-08-22, and the
   measurement is why: 3,650 tracks share an INTERVAL, not a due date. The heaviest
   single day in the entire future schedule is **188 on 2027-01-03**, and only 24 of
   1,194 scheduled days exceed his sustained 77.5/day. He has already done more than 188
   on **six** separate days, peaking at **229**. So the pile-up is a day he has survived
   six times, not a wall — and grade-time fuzz brings future plans down anyway. Not
   worth a migration that rewrites due dates Mochi set. His reasoning: *"are we saying
   that, on some day, i have to review 3650 in a single day? if not then we don't have
   to touch it, no reason to."* No, and correct.
15. **New cards are 10 TRACKS a day, chosen at RANDOM, and forward/reverse are not
   paired.** Decided 2026-08-22, and it is narrower than decision 12 alone. Zach:
   *"10 new tracks … 1 forward and 1 reverse counts as 2 tracks … both forward and
   reverse doesn't have to be studied on the same day because it's random from the cards
   i haven't learned."* Basis matters here (decision 6): 3,980 new **tracks** over 2,577
   distinct **cards**, so tracks means ~398 days to clear the backlog and cards would
   mean ~258.
   **BUILT 2026-08-22, and the bug it closed is worth knowing.** `newTracks` used to
   order by `c.pos, c.id, t.id` — authoring order — and push `limit` into SQL, with a
   docstring saying shuffling was "a choice the review screen can make later". That is
   false once a `LIMIT` exists: a limit applied to a sorted query has already CHOSEN the
   sample, so no shuffling by the session layer recovers it. Measured, the old path
   returned track ids `1, 2, 3, 8, 12, 20, 26, 28, 30, 34` — the front of the list — and
   **the same ten every day**, so the backlog would have been worked in authoring order
   forever. (It did NOT pair forward with reverse; an earlier version of this line said
   it did. Those ten span ten DISTINCT cards, because a card's two tracks are rarely both
   new. The pairing this decision rules out does not occur in the corpus. The missing
   randomness was the whole bug.) The order now lives in `newTracks` and the limit is
   applied after it, keyed by `dailyOrderKey(localDay, trackId)` — the `hash32` precedent
   `fuzzFactor` uses, never `Math.random()`, so one day gives one order and re-reading
   the queue mid-session does not reshuffle it. Costs 13.9 ms for a day's ten against
   0.2 ms when the LIMIT was in SQL; paid once a session.
16. **ONE final import from Mochi, then never again.** Decided 2026-08-22: *"after our
   app is finish … ill do one last import, and that's it, there should be no import,
   unless the app breaks something and we have to re import."*
   **The escape hatch is the dangerous case and it needs a guard.** `INSERT_TRACK`'s
   `ON CONFLICT … DO UPDATE` (`src/import/reviews.ts:569-583`) reverts a locally-graded
   track's due date, reps and lapses to Mochi's. That is harmless for the planned final
   import, because there are no local grades before it. It is destructive for exactly the
   case he named — re-importing to recover from a bug, when local history exists. So the
   importer must refuse, or preserve, a track carrying `reviews.source = 'local'`, rather
   than trusting that nobody re-imports. Today `SELECT count(*) FROM reviews WHERE
   source = 'local'` is 0, so this is cheap to build now and a data-loss bug later.
17. **A local export/backup is NOT day one — but it is required before he trusts the
   app, and decision 16 is why.** He pushed back correctly: *"local backup? i thought
   everything is already on the local…? and why do we need to backup on day 1??"* Day one
   does not need it. The reason it cannot be dropped: OPFS is browser-owned storage —
   clearing site data or a browser eviction takes it — and TODAY that is survivable
   because every review is reconstructible from `exports/`. After decision 16's final
   import, it is not: from the first local grade onward, `exports/` no longer receives his
   history and the OPFS database is the ONLY copy. `notes/persistence.md:204` already
   prescribes the one-tap export; measured 2026-08-22, **no code path gets a database
   out** of either half (0 matches for export/download in `src/` and `spike/`). Schedule
   it with the cutover, not with day one.
18. **The TTS key NEVER goes in the client.** Decided 2026-08-22: *"we have to find a way
   that will not leak my key."* So the provider call is proxied through the Cloudflare
   Worker that stage 11 needs anyway; the PWA holds no credential. This is free to decide
   now and a rewrite after stage 9 ships, and a client-side PWA cannot hold a key
   privately at all — anything the page can read, a reader can read.
   Correcting the record: `SETTING_KEYS` has four members and none is a credential, and
   nothing under `src/` has ever made a billable call — but `tools/accent_probe.py:48`
   reads `.env` and the 22 synthesis calls behind the TTS decision DID spend his quota.
   That script loads the file by NAME ONLY and prints nothing from it, which is the
   pattern to keep. An audit statement scoped to `src/` is not a statement about `tools/`.
19. **Links render PLAINLY, in place, on whatever side they are authored on.**
   Drafts 1-7 called the Jisho URL on 漢字's side 4 an answer leak and prescribed
   deferring link rendering in reverse mode. Zach overruled that on 2026-08-20:
   there is no hover on a phone, a long-press is deliberate, and he never checks a
   URL before answering. No direction-dependent deferral, no defanged `href`, no
   state for it. Deleting that machinery was the correct outcome.

20. **`型` renders on side 2, immediately above `<<Speech>>`. `かな主流` renders on side 1,
   inside the `<<#Reading>>` gate.** Both from the 単語 template Zach pasted 2026-08-21.
   The asymmetry is the exercise, not an inconsistency: `型` is the ANSWER — the accent
   pattern he is trying to recall — so putting it on side 1 would hand him the thing he is
   meant to produce. `かな主流` is not an answer, and side 1 already reveals `Reference`
   when `Reading` is true, so the label is not a spoiler there.
   **MIGRATED FROM THE PLANNER 2026-08-22, and its absence here caused a real failure.**
   This decision lived only in his Obsidian planner, which no agent reads. An audit
   flagged `型` placement as an open question; it was settled weeks earlier and nothing
   in the repo said so. A decision recorded only outside the repo is a decision agents
   will reopen — that is the lesson, not "someone should have checked".
21. **Fields are MOVABLE between templates, from the UI.** Add, delete and move, landing
   with stage 10. `template_fields.local = 1` (decision 9) already makes a moved or added
   field survive a re-import, so the storage half exists and what is missing is the editor.
   Also migrated from the planner.
22. **The 6 truly ambiguous words stay UNLABELLED.** `まく` has three different accents
   across 巻く / 撒く / 幕, so no single label is correct for the string. Resolving them
   needs the card's `意味` to disambiguate, which makes it a review-UI question rather
   than a pipeline one — the derivation cannot see meaning. `OJAD_AMBIGUOUS` in
   `src/accent/ojad.ts` holds them, deliberately without labels. This is the same
   principle as decision 8: a wrong accent drilled through spaced repetition is worse
   than no accent. Also migrated from the planner.

## Ratified 2026-08-22 — small calls an agent had made without authority

`OVERNIGHT.md` §4 listed ten of these; five were settled by later decisions. Zach
took the remaining five, all as recommended, so they are no longer open questions:

* **A `---` inside a field value stays a horizontal rule**, not a side break. Only
  card `EPp9rse6` does it. He wrote those five sides deliberately to partition ten
  clozes, and then reconsidered: *"it doesn't matter if I divide a card, I still
  have to remember all of them anyway, and If i fail one, i fail the whole card"* —
  so the better fix is splitting the CARD, which is authoring, not parsing.
* **The CommonMark emphasis deviations stay.** They exist because his corpus broke
  the standard rule: `\*` jisho wildcards, underscores in filenames, and `路_線_図`
  being italicised.
* **The dashboard keeps zero JavaScript** (SPEC problem #1, battery). But that is
  not a reason to leave data unreachable, and **as of 2026-08-22 nothing on the page
  is hover-only**: each activity-heatmap year strip carries a `<details>` table with
  one row per day that has reviews — 176 + 362 + 348 + 220 + 211 = **1,317 rows,
  exactly `activeDays`**. Zero-review days are the one thing with no row anywhere,
  because their tooltip says 学習なし and carries no number. Phrase it that way: "no
  *value* is hover-only" is true, "no *cell* is hover-only" is not.
* **The heatmap keeps 4 colour bins.** A 5-step ramp failed the contrast check, and
  contrast wins in an app where every grey carries a reading.
* **`tags` keeps 20 rows for 19 real tags** — `Dialect` is a childless ancestor so
  `Dialect/Kansai` has a parent. Any count filters `cards_direct > 0`. This was
  carried as a pending fix; **checked 2026-08-22, it is not one.** The dashboard has
  no tag count at all, the importer's phase line already says `20 tag paths` rather
  than `20 tags`, and `test/roundtrip.test.ts:361` already asserts the filtered count
  is 19 and names the ancestor. The trap goes live again the first time a tag
  sidebar counts rows.

`orphanFieldValues` reports **235** with the 137-real-text figure broken out and the
card ids listed — the same treatment the 3,159-card stale-`content` case gets. **BUILT
2026-08-22.** The old 143 definition was guarded by `row.template_id &&`, so it could
not see the 92 values on cards with no template — exactly the half a reader would not
think to look for. Now 235 = 143 + 92, of which **137 carry real text** and 98 are
empty strings; all three are asserted in `test/transit.test.ts` and printed by the
import. The values are IMPORTED and stored, they simply have no field to render them.

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
