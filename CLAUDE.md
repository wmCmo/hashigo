# Hashigo (梯子)

A local-first spaced-repetition app replacing [Mochi](https://mochi.cards) for one
user's Japanese study. Built because Mochi's developer stopped fixing reported bugs.

## Where this is — and where the numbers live

**THE APP RUNS.** As of 2026-08-23 there is a page (`app/`), a writable SQLite
database in OPFS, audio on the device and grades landing on disk — measured end to end
in Chromium over the real corpus: 7,716 cards, 103,110 imported reviews, a 531-card
plan, reveal, grade, next. `app/README.md` is the entry point; `npm run app:bootstrap`
then `npm run app:dev` is the whole way in.

**What is left is no longer the shell.** It is the editor and sync (stages 10, 11), an
on-device run of the app itself, and the two small things named at the end of
`app/README.md`. Everything from "what is due" to a live, audible, graded card exists
and is pinned.

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

**And the chrome exists too, as of 2026-08-23** — `app/` is decision 23's direction
A2 over the real pipeline, in its own top-level directory with its own Vite config
(port 5274, beside the spike's 5273). `spike/viewer/` remains a THROWAWAY harness and
is not that shell.

Three things running it found that reasoning had not, all three in `app/README.md`:
the prompt boundary has to be POSITIONAL (a reverse track printed the answer above the
question); exactly one clip per reveal, or 単語 sounds its word and its example sentence
at once; and a reverse identify track is silent on entry, which is CORRECT because the
clip is the answer there.

Things that are built and do NOTHING, which is the opposite trap to rebuilding
(the list grows; it is deliberately not numbered in the heading):

* **`かな主流` renders on ZERO cards — and the FIRST diagnosis of this was wrong.**
  Corrected by a peer review 2026-08-23, verified before recording. **All six
  `かな主流 = true` cards are on 言葉**, whose template declares no `Reading` field at
  all and whose body contains neither marker. The marker was authored into 単語, where
  no card carries the flag. So it is not "the gate fires for nobody" — the flag and the
  gate are on **different templates**. That kills the option this file used to offer
  ("those six want `Reading = true`"): you cannot set a field a template does not
  declare. `scripts/accent-field-apply.ts`'s own header had it right; this summary of it
  drifted. **And the follow-up guess is also dead:** all six carry ZERO undeclared values,
  so they did not migrate from 単語 — they are natively 言葉. So the question is just
  **"should 言葉's body render `かな主流`?"**, which is one line of template. Zach's call.
* **DONE 2026-08-23, kept here because the SHAPE is the lesson: `型` used to render
  BARE and leak on entry.** It was not inside a cloze, so side 2 put the accent on
  screen the moment the side appeared — and decision 20's stated reason for keeping it
  off side 1 is that it "would hand him the thing he is meant to produce", which
  side-2-*entry* does too. **Fixed in the TEMPLATE, not in code**
  (`scripts/accent-field-apply.ts`): `<<#型>>` guards it, `<<#Reading>>` clozes it in
  mode 1, `<<^Reading>>` leaves it plain in mode 2. In code it would have meant adding
  field provenance to the resolver, because a resolved plain field is substituted to
  TEXT before the render and nothing downstream knows `平板` came from `型`. Zach asked
  for exactly this: *"it should render conditionally from my template."*
* **The UI half of decision 17's backup — DONE 2026-08-23.** `app/` carries the
  non-dismissible banner when `persisted()` is false and the one-tap export, asking for
  persistence from the WINDOW because `navigator.storage.persist` is absent in a worker.
  **Eviction detection shipped too** (b308861), and was verified against a REAL wipe
  rather than reasoned about — the receipt lives in `localStorage`, not in the database,
  because a receipt inside the thing that went missing proves nothing. Seen working
  2026-08-26: *"The database was gone (receipt from ...), but it held 0 local reviews."*
  It cannot detect a full site-data clear, which takes the receipt too. The "add to home
  screen" prompt dropped in priority — persistence was granted on his handset in a
  plain browser tab, not installed.

The accent pipeline is **DONE and VALIDATED** — do not redo it.
`notes/pitch-accent-pipeline.md` §7-§10 has every measurement, including the two that
read as failures and are not: `accent_verify.py` produces false misses on unvoiced
onsets, and the 20-card listening test measured GOOGLE rather than our derivation.

> [!important] Before you pick anything up
> **D1 IS DECIDED as of 2026-08-22, so stage 7 is no longer blocked on taste** — the
> review screen is **direction A2** and decision 23 is the specification. That was the
> last thing standing between the finished pipeline and a usable app.
>
> **THE REAL SCREEN IS BUILT** — `app/`, 2026-08-23. `build/mock/out/` is still there
> and is still a spec for the LOOK and never for the structure: its `.head` /
> `.answer` divs are hand-authored by `scripts/mockup-html.ts` and `src/render`
> produces none of them. Do not read layout structure out of it; `app/README.md`
> explains what the real render forced instead.
>
> Decision 23 names three things it deliberately does NOT settle (the head word pinning
> after reveal, where a decision-13 re-ask re-enters the session, and type/spacing
> detail). Those are still his, and the app ships a plain reading of each rather than a
> decision. D2-D5 remain in his Obsidian planner, which no agent reads.

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
npm run gates           # ALL SEVEN GATES, one command, honest verdict. Start here.
                        # `npm run gates -- test` runs just one. app:build is in
                        # here and in nothing else: app:check is `tsc --noEmit` and
                        # cannot see a broken worker or wasm URL.
npm test                # 44 files, 1206 passed, 1 skipped (the FSRS refit, gated). ~54 s.
                        # MEASURED 2026-09-17, not arithmetic. The 1127 here before it
                        # was 1117 plus ten new tests, added up rather than run — and it
                        # missed 79 tests from the same day. Run the suite or leave it alone.
                        # EXITS 0 ON A PASSING RUN as of 2026-08-26. It is a wrapper
                        # (`scripts/test.mjs`) that reads the SUMMARY, which is
                        # STRICTER than the exit code, not looser: the run must have
                        # FINISHED (a summary line exists) and have zero failures. A
                        # crash prints no summary and cannot pass — that is what
                        # caught `pool: "threads"` segfaulting. `scripts/test-verdict.mjs`
                        # owns the rule and `npm run gates` imports the same one, so
                        # the two cannot disagree about the same run any more.
                        # Arguments pass through: `npm test -- test/glance.test.ts`.
                        # `npm run test:raw` is unwrapped vitest, for when the exit
                        # code itself is what you are investigating.
                        # WHY RAW VITEST EXITS 1: birpc's timeout is a hard-coded 60 s
                        # that vitest never overrides, `onTaskUpdate` is an AWAITED
                        # call, and exactly the files that run over 60 s throw one
                        # error each, every run. Not the reporter and not load —
                        # cutting workers and quieting the reporter change nothing,
                        # `--no-isolate` makes it worse.
                        # DO NOT SET `pool: "threads"`. It removes the errors and then
                        # SEGFAULTS (exit 139) — better-sqlite3 is a native addon and
                        # six threads in one process crash it. It passes twice first,
                        # so two green runs are not evidence. vitest.config.ts has the
                        # ten measured runs.
                        # WHY IT TAKES ~53 s, MEASURED PER FILE 2026-09-17. The suite
                        # does 236 s of work across 44 files at ~4.5x parallelism, and
                        # TWO files set the floor:
                        #   dashboard.test.ts  49.8 s  (2 full corpus imports)
                        #   roundtrip.test.ts  48.8 s  (9 full corpus imports)
                        # The other 42 files total ~138 s and finish entirely behind
                        # those two, so cores do not help: the wall clock is the longest
                        # single file plus change.
                        # THIS CORRECTS THE NOTE THAT USED TO BE HERE. It named
                        # roundtrip alone at 67 s and concluded that splitting it would
                        # buy ~24 s. It would buy roughly NOTHING — dashboard is the
                        # longer of the two now, and splitting the shorter one cannot
                        # move a floor the other file already sets. Both would have to
                        # stop re-importing 21 MB of Transit, which is a real change to
                        # how the oracle tests get their corpus, not a split.
                        # Still deliberately not done.
npm run typecheck       # exit 0
npm run app:check       # exit 0 — app/ has its OWN tsconfig and this is a REQUIRED gate
npm run build           # refuses to exit 0 unless dist/ actually imports (28 export subpaths)
npm run rebuild -- --force   # the schema-bump chore as ONE command, with invariants
                        # that fail loudly on the step everyone skips. See below.
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run dashboard -- --db build/hashigo.db --out dashboard.html   # English; --locale ja for the other
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths   # exits 1 on any location
npm run spike:check     # the browser contract; spike/ is excluded from tsconfig.json

# THE APP. This is the thing. `app/README.md` first -- it carries the three findings
# that only came out of RUNNING it, and P1's per-grade write measurement.
npm run app:bootstrap                     # once: build/app/*.db, the two files it fetches
npm run app:dev -- --host 127.0.0.1       # local only
npm run phone                             # THE PHONE: tunnel + server + the URL, one
                        # command. Reads the hostname back out of cloudflared and
                        # authorises it BEFORE starting Vite, because `allowedHosts`
                        # is read once at startup.
                        # A QUICK tunnel gets a new random name every run, and OPFS
                        # is keyed by ORIGIN — so that is a new empty database and a
                        # ~115 MB re-download every session. `.tunnel-named` holds a
                        # FIXED hostname and is what makes it survive; the provider
                        # is read off the suffix (.ts.net / .ngrok* / else cloudflared).
                        # HE HAS NO DOMAIN, so cloudflared named is out — that route
                        # needs a zone. ngrok free has a reserved static domain that
                        # BINDS but is at its 1 GB/month cap (403 ERR_NGROK_725), and
                        # one first load here is ~115 MB = 11% of the month.
                        # `tailscale serve` is free, fixed, uncapped and TAILNET-ONLY
                        # — the only one that does not put his study history on the
                        # open internet. See app/README.md.
                        # A LAN IP CANNOT SUBSTITUTE: plain HTTP is not a secure
                        # context and `navigator.storage` is absent there. Measured
                        # on his handset — notes/archive/PHONE-TEST.md.
npm run app:dev -- --host ::              # phone / tunnel, by hand (bind-address trap)
npm run app:check                         # tsc -p app/tsconfig.json
# The audio subset. DEFAULT 200 MiB = **98.2%** of the 5,708 speech-bearing cards,
# raised from 32 MiB (23.8%) on 2026-09-07 because the small budget existed for a
# METERED tunnel and `tailscale serve` is not metered.
# THE SELECTION RULE CHANGED THE SAME DAY, and that is the bigger half. It was "all
# speech, smallest first", which printed a true 90.0% that was the average of 100%
# and almost nothing: size is a proxy for "short utterance", so it covered the
# vocabulary decks completely and starved every deck whose clips are inherently
# long. Zach found it by opening a 数字 card that played SILENCE — 数字 was at 26%,
# 基本情報 at 0-12%. It now takes each card's CHEAPEST clip first, so no card gets a
# second before every card has a first: 90.0% -> 98.2% at the same budget, and
# 数字 26% -> 100%. scripts/app-bootstrap.ts carries both measurements.
# Coverage matters more than the number suggests — decision 29's mode 2 is 3,177
# cards where the AUDIO IS THE QUESTION, and 数字's `<input>` prompts on entry too.
npx vite-node scripts/app-bootstrap.ts -- --speech-bytes 650000000   # all of it

# The scheduler. Read-only except `seed`, which writes state and moves no due date.
npx vite-node src/scheduler/cli.ts -- counts   --db build/hashigo.db
npx vite-node src/scheduler/cli.ts -- queue    --db build/hashigo.db --limit 20
npx vite-node src/scheduler/cli.ts -- forecast --db build/hashigo.db --days 14

# Decision 17's backup. `export` is read-only; `apply` writes in one transaction and
# is idempotent, and `--dry` does the real inserts, reports, then rolls back.
npx vite-node src/backup/cli.ts -- export --db build/hashigo.db --out backup.json
npx vite-node src/backup/cli.ts -- apply  --db build/hashigo.db --in backup.json --dry

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

`SCHEMA_VERSION` is **9** and `applySchema` refuses any other version outright.
That is deliberate — every database here rebuilds from `exports/` in about
fifteen seconds and the reviews still come from the export — but it means a
schema change is a three-step chore, and skipping the third breaks a test:

> [!warning] **THE SECOND HALF OF THAT JUSTIFICATION EXPIRED ON 2026-09-13.**
> "The reviews still come from the export" was true while Mochi was the system of
> record. Decision 16's final import has now happened and Zach will not import
> again, so **a rebuild from `exports/` silently discards everything Hashigo has
> graded since** — 56 reviews on his current device and 43 on the other, as of
> that date, and growing daily.
>
> The three-step chore below is still correct for a DEVELOPMENT database. It is
> no longer a safe universal answer, and a schema change now has to say what
> happens to the live review history first: decision 17's backup
> (`src/backup/cli.ts`) and decision 33's sync payloads are the only things that
> carry it, and both are schema-versioned (`archive.schemaVersion`), so they are
> part of the migration rather than a free escape from it.

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
npx vite-node scripts/accent-field-apply.ts -- --db build/hashigo.db --apply  # the 型 field + bodies
npx vite-node src/accent/cli.ts -- write --db build/hashigo.db            # 3,830 型 labels
# LAST, AND AFTER THE DASHBOARD REGENERATE — see the warning below.
npx vite-node scripts/reverse-dormant-apply.ts -- --db build/hashigo.db --apply  # the 6 forced reverse tracks
```

> [!warning] **`reverse-dormant-apply` GOES LAST, AND `dashboard.html` MUST BE
> REGENERATED BEFORE IT — not after.** Learned by getting it wrong on 2026-09-07.
>
> The committed `dashboard.html` is the **importer's oracle**: `test/dashboard.test.ts`
> imports `exports/` into an in-memory database and compares byte-for-byte, because
> "Mochi's own dashboard is a known-correct answer, so agreement means the import is
> right". It is therefore a pure function of `exports/`.
>
> `reading-apply` and `accent-field-apply` may run in any order around it — head words
> and template bodies move no dashboard figure. **`reverse-dormant-apply` does**:
> `dormant` feeds deck progress, the backlog and the interval-cap ratio. Regenerating
> the dashboard after it turned two oracle tests red (backlog 108 → 102, overdue
> 76 → 70, the dormant column, cap denominator 8,956 → 8,955).
>
> So his working database and the committed dashboard differ by exactly six tracks,
> deliberately. The app's own dashboard reads his real database and shows the lower
> number. An oracle and a report, answering two different questions.

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
> **DO NOT RUN A MARKDOWN FORMATTER OVER THIS FILE OR `DECISIONS.md`.** It renumbers
> the list. On 2026-08-23 an Alt+Shift+F turned `20.` `21.` `22.` `23.` into `1.` `2.`
> `3.` `4.` and every entry after that into `1.`, because an ordered list interrupted by
> prose is several lists to a formatter. **It passed test, typecheck AND build** — it was
> caught by reading `git diff`, which is luck, not a control. There are now two defences:
> `.prettierignore`, and `test/docs-integrity.test.ts`, which fails on exactly that damage
> (proven: 2 tests red). Editing these by hand is fine; reflowing them mechanically is not.
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
    **IT HAS NOW HAPPENED. Zach, 2026-09-13: *"what we have now is already the
    final import, i won't import anymore (unless we genuinely lost everything
    here ofc)"*.** The 2026-09-08 import was it. `exports/` is a disaster-recovery
    copy from here on, not a source that will be consulted again — which
    **retires the justification for "a schema bump means RE-IMPORT"** (see that
    section) and makes `build/hashigo.db` plus each device's OPFS the system of
    record. Anything Hashigo accumulates from now on exists nowhere else.
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
26. **`型` renders on SIDE 1 for `言葉` cards.** Decision 20 says side 2 and derives it
    from the `単語` template Zach pasted; `言葉` has no side 2, because its first `---`
    comes after `<<Speech>>` and `___` is a rule WITHIN a side. Confirmed by Zach
    2026-08-23 for the 376 `言葉` cards: side 1 is where it goes. Decision 20 stands
    unchanged for `単語` — this says the placement does not transfer, not that it was wrong.
27. **NO PARTICLE beside the word — in the audio OR the display.** Zach, 2026-08-23:
    *"don't add particle to my word, the word stays the word."* This extends the existing
    audio rule (no particle spoken, because three different particles get conflated) to
    the review screen: the contour boxes show the word's own morae and nothing after them.
    **The consequence is a BUILD CONSTRAINT, and it is the reason this is written down.**
    平板 and 尾高 are identical inside the word — the downstep lives on the following mora
    (花が vs 鼻が) — so with no particle anywhere, **`型` is the SOLE carrier of that
    distinction on 2,092 平板 + 56 尾高 = 2,148 of 3,830 labelled cards.** 頭高 and 中高
    are audible bare and the boxes show them; 平板 vs 尾高 is neither audible nor drawable
    under this decision. So `型` is not a caption the layout may drop on a narrow screen —
    on those 2,148 cards it is the only thing on the card carrying the fact being trained.
    **This is the point of the whole accent pipeline, in Zach's words:** he did not know
    花 and 鼻 diverge once a particle attaches, and natives get it right because the 型 rule
    is encoded rather than heard. See `notes/zach-in-his-own-words.md`.
28. **`言葉` DISPLAYS THE WAY IT WAS INPUTTED, and `かな主流` therefore renders nowhere.**
    Zach, 2026-08-23: *"for 言葉 deck, it should display the way it's inputted."* This
    closes the last of D3's three questions. The head word shows as authored — `蟻` as
    `蟻`, `にんじん` as `にんじん` — so the flag changes no display and needs no home in
    the body. `scripts/accent-field-apply.ts` was right to decline to invent one.
    **The values STAY STORED** (decision 9 protects them from re-import); they simply
    render nothing. Deleting them was never authorised.
    **Do NOT turn this into "hide kanji on 言葉" — that was an agent's idea, not his,
    and it is wrong.** 20 of 391 `言葉` head words contain kanji, and they split cleanly:
    **6** are single words whose kanji nobody writes (`蟻` `雄` `搔く` `茄子` `灰汁` `雌`
    — exactly the `かな主流` six), and **14** are phrases where the kanji is entirely
    normal (`目をつける`, `気が付く`, `口をきく`, `一から十まで`, `〜ない限り` …). Any rule
    keyed on the DECK rather than on the flag breaks those 14.
29. **THE HARD RULE IS CONDITIONAL ON `Reading`, and `型`'s gating is conditional with
    it.** Zach, 2026-08-23. **This AMENDS the autoplay rule — read this before touching
    `src/render/reveal.ts` or its tests.** There are TWO card modes:

    | `Reading` | cards | the test | audio | `型` |
    |---|---|---|---|---|
    | **true** | 692 単語 | produce the reading + accent | **on reveal only** | behind the reveal — it is the ANSWER |
    | **not true** | 2,785 単語 + 392 言葉 = **3,177** | hear it, identify the word | **on side ENTRY** | visible on entry — it is the DISCOVERY SIGNAL |

    `boolean-default` is `false`, so the 1,882 cards with `Reading` absent are mode 2.
    That is **41.2% of the corpus autoplaying** and 9% reveal-gated.

    **WHY MODE 2 IS NOT A WEAKER VERSION OF MODE 1 — it is a different exercise, and the
    cloze is load-bearing in it.** *"if you show me 償却 i can read that word like
    instantly … but if you hide it behind the cloze, and play しょうきゃく, i would be
    like... what しょう... and what きゃく、、、 and it would force me to remember."* His
    listening is behind his reading, so the audio is the PROMPT and the kanji is the
    ANSWER. Mode 2 trades accent-production for word-recognition-from-sound, deliberately.

    **AND `Reading` IS A STATE HE MOVES CARDS THROUGH, not a property.** Mode 2 is the
    default *and* the audit: the `型` label surfaces an accent he had wrong, and he then
    promotes the card. *"i would see that it's 尾高, and i'll be like, damn, i didn't know
    this, ive been pronounced it has 平板 all along, and then i'll just go ahead and edit
    the card to `Reading` -> true."* **This is why `型` must be VISIBLE on entry in mode
    2** — gating it there breaks the audit loop, which is the whole reason the accent
    pipeline was built. It also means **the review screen needs to flip `Reading` on the
    current card** (see NEXT.md); without that the loop requires leaving the app.

    **The trade-off is measured, and one leg of his own argument does not hold.** He
    reasoned that mode-2 cards are mostly 平板/頭高 so little is lost: true at **75.4%**
    of mode 2 — but mode 1 is **72.3%**, statistically the same, so the split is
    orthogonal to accent difficulty and this is a fact about the corpus rather than a
    discriminator. The real cost is the **772 mode-2 cards that are 中高 or 尾高**.
    His OTHER leg is stronger than he stated: **97.6%** of mode-2 cards carry
    example-sentence audio, and a sentence puts a particle after the word, so it can
    carry the 平板-vs-尾高 downstep the isolated word physically cannot (decision 27).
    Sampled 400 平板/尾高 mode-2 cards: **54.3%** have a clean particle directly after the
    head word. So the three channels are complementary — isolated audio carries 頭高/中高,
    `型` carries all four, the sentence carries 平板-vs-尾高.

    **IF YOU IMPLEMENT THIS, THE TESTS GET STRICTER, NOT LOOSER.** Ten tests currently pin
    the absolute rule. They must pin BOTH arms — fires on entry for mode 2, and **NEVER**
    on entry for mode 1 — or someone relaxes them to "may play on entry" and the 692 lose
    the protection that is their entire exercise. Do not weaken the mode-1 assertions.

30. **A PREVIEWED CARD IS NOT A REVIEWED CARD — they are two different modes, and
    preview shows every side at once.** Zach, 2026-08-23: *"showing a preview card is not
    the same as put the card into a review mode, when you enter a review mode, everything
    goes as it is now, showing a previewed card lets you view every sides at once."* So
    the card-link modal (his request 2) renders **fully revealed, all sides, no masks, no
    grading, and nothing plays by itself** — a clip is one deliberate tap away, as it
    always is. **Review mode is UNCHANGED**, which also ratifies the progressive-sides
    reading the app already ships. See `DECISIONS.md` 30.

31. **PROCEED WITHOUT ASKING. Asking costs more than doing.** Zach, 2026-08-23:
    *"why do you have to wait for my goal every time, waiting for my go and asking me
    wastes more token than proceeding on your own"*. This EXTENDS decision 24 from
    committing to deciding. **The default is to act.** Ask only when the answer cannot
    be derived from his template, a measurement, or a decision already recorded here —
    and remember that his template answers most of it (see "READ THE TEMPLATE").
    A question that costs him a round trip to say "yes, obviously" was not worth asking.
    **What is still his:** taste about the screen he lives in, and anything that changes
    what he is DRILLED on. See `DECISIONS.md` 31 for the line.
32. **THE DESIGN BRIEF OF 2026-09-12 SUPERSEDES DECISION 23'S VISUAL DIRECTION.** Zach,
    handing over a brief written with another session: *"we are doing the design
    revolution, it turned out i didn't like what we have now."* What he disliked is not a
    detail — *"it lacks identity … it feels like the person couldn't decide the design and
    ended up with whatever is 'okay'"*. **Dark, mono, terminal is withdrawn.** In comes a
    ladder/torii mark, aizome indigo on paper, Fraunces for display, flat hairline-ruled
    square-cornered surfaces with no shadows, and a 520 ms climb animation.
    **DECISION 23 IS NOT DELETED AND NOTHING RENUMBERS.** Most of what it settled is about
    the HAND, not the look — bottom-pinned controls, the round replay bottom-RIGHT for his
    right thumb, keycap hints only where a pointer exists and never behind hover, one
    scroll — and **all of that survives**. The one collision is the replay button: the
    brief says square, decision 23 says round for a reason that is ergonomic, and **the
    hand wins.** **The brief's stack assumption is WRONG and changes nothing** — it guesses
    Next.js on Vercel; `app/` is vanilla TS on Vite, local-first, and the work reaches
    `app/style.css`, `app/index.html` and some new assets, nothing else.
    **TWO THINGS WERE STILL HIS, and decision 31's own line put them there:** the Japanese
    typeface (the brief is SILENT on it, and specifies a Latin-only stack — but 1,725
    distinct kanji are 100% of what is studied), and dark mode (the brief calls it open and
    says do not ship a guess; the app it replaces is dark and he reviews on his phone).
    **THE TYPEFACE IS SETTLED, 2026-09-13: `Zen Kaku Gothic New`.** He picked it over Zen
    Maru and over his system font, seeing all three on real cards — and the way the
    question finally got asked is the lesson. A preview of mine wrapped cards in the wrong
    class, so `--jp-display` never applied and the Japanese fell through to Windows' own
    font; he read that as *"why does this html look better than our actual app...? im not
    kidding, it actually looks good"*. A real signal wearing a bug's clothes: Zen Maru was
    the thing he did not like. `--jp-display` now leads with Zen Kaku, so the round/flat
    split between display and UI is gone.
    Both rendered side by side in `app/specimen.html` and `app/specimen-review.html`.
    **Two palette cells need a rule, measured:** `--muted` on `--paper-sunk` is 4.21:1,
    below AA for small text; `--vermilion` on `--paper` is 3.47:1, large-text-only — fine
    for the focus ring and the mark's top rung, wrong for small text. See `DECISIONS.md` 32.
33. **STAGE 11 SYNC IS DEVICE-TO-DEVICE OVER THE TAILNET, AND TWO OF ITS MERGE RULES
    ARE NOT LAST-WRITE-WINS.** Zach delegated it outright 2026-09-12 (*"任せます lol"*).
    **This supersedes one row of SPEC's locked Architecture table and amends another.**
    **No cloud.** SPEC says Workers + D1 + R2 because "two PCs need a rendezvous"; that
    rendezvous now exists and is measured — `tailscale serve`, fixed hostname, tailnet
    only, free, in daily use via `npm run phone`. It is also the choice already made for
    the same reason: tailscale beat cloudflared and ngrok because it is the one that does
    NOT put his study history on the open internet, and D1 + R2 is a larger version of
    what that rejected. **The cost is real and is the thing to reopen if it bites: both
    devices must be on the tailnet at once**, so a review on the train syncs when he gets
    home. **The merge rules** — reviews UNION (append-only, cannot conflict, so no merge
    can lose a grade); `card_tracks` state is **LAST REVIEW WINS, not last write** (the
    schedule is a function of the last grade, and flat LWW picks whoever WROTE last, so
    the log and the schedule would disagree — and recomputing is also wrong, because
    decision 11 fuzzes once at grade time and a replay re-fuzzes); `archived`/`pinned` are
    LWW on `cards.updated_at` with **every** card's flags in the payload, because the
    backup's additive `max(archived, ?)` can set a flag and never clear one, which would
    mean he could archive 数字 once and never undo it. **Built on decision 17's backup**,
    which already keys on `(card_id, kind)` — `reviews.id` and `card_tracks.id` are local
    integers both devices hand out. **BUILT: `src/sync/`, the merge engine, 10 tests over
    divergent databases. NOT BUILT: the transport.** Known gap, deferred on purpose:
    `card_field_values` has no clock, so field values merge at CARD level — the fix is a
    schema bump, and it waits for decision 16's final import rather than forcing a
    destructive re-seed.
    **THE TRANSPORT IS BUILT TOO, and it is a MAILBOX** — `syncMailbox()` in
    `vite.app.config.ts` stores one JSON file per device under `build/sync/` and has
    no opinion about any of them, because **the laptop's database is in the laptop
    BROWSER's OPFS and the Node process cannot read it either.** No device is
    privileged. **That relaxes the cost above: the two devices never have to be up
    together**, only each able to reach the server at some point.
    **`decks.archived` had to be added to the payload** — the backup carries only
    `cards.archived`, but `deckOp` archives a deck AND its cards, so card flags alone
    move half the change and the tree still shows the deck open. That was his case.
    **The sync indicator is part of the feature**: "never synced" is a state with its
    own look, and the dot differs by SHAPE as well as hue because `--good` and
    `--danger` are isoluminant. Measured end to end with `scripts/sync-peer.ts`
    standing in for a second device. See `DECISIONS.md` 33.

34. **A REVEAL IS A WALK, NOT A SWITCH — one cloze at a time, then the next side.**
    Zach, 2026-09-12: *"when you click reveal, it shows the whole thing, the next
    slide, and the third slide, and every cloze. the correct order should be, each
    cloze in that slide, once every clozes are shown, the next side and so on. for
    the reverse, the cloze are still in the same ascending order, just the side
    reverse."* **This REVERSES the "TOGETHER, PER SIDE" call that `src/render/reveal.ts`
    argued for in its own header** — that was an agent's call, not his, and one of
    its three reasons was simply wrong (単語 side 2's two clozes are the READING and
    the KANJI, not one fact twice). **PER SIDE still bounds it**: a step never
    crosses into the next side. **A side sounds its clip when its LAST cloze goes**,
    so the stepped path plays no earlier than the one-shot path did and decision 29
    is untouched — `enter()` still does nothing. **Reverse needs no code**: sides
    arrive already permuted and keyed by display position, clozes are in document
    order within a side. Measured, 40 real reverse cards: 40/40 permuted, 320 sides,
    every one ascending. **Grading does not wait for the end of the walk** —
    `revealed` turns true on the FIRST step and `moreToReveal` is a separate flag,
    because conflating them puts live-looking dead buttons on screen, which is the
    2026-09-07 *"it won't let me click remember"* defect. **AMENDED 2026-09-13 FOR
    `remembered` ALONE — decision 42:** that grade now waits for the last step, on
    his argument that it is not answerable before it. `forgot` is unchanged, and
    the button is taken OFF SCREEN rather than left up and inert, which is what
    keeps this from being the defect above. **It is also what makes the
    SECOND clip reachable at all**: the native `<audio>` is `display:none` in review
    and the round replay button was nailed at mount to "the first side with audio",
    so 単語's example-sentence clip could not be played by any gesture. The button
    follows the walk now. **The other half of that complaint is a BUDGET, not a bug,
    and is NOT fixed** — measured by walking real cards against the shipped seed,
    the sentence clip plays on **0.0%** of 単語 and 0.5% of 言葉, while the word clip
    plays on 99.2% / 97.8%. (An earlier figure here said "36 cards, 0.7%" and was
    measured against `blob_refs` mp3 rows — those are ATTACHMENT clips; a 単語 card's
    are `generator` mounts addressed by generation identity. Wrong table, wrong
    question.) `app-bootstrap` spends 200 MiB on each card's CHEAPEST clip first, on
    purpose. The two sets are DISJOINT: first clips 5,279 blobs / 212 MiB, later
    clips 4,359 blobs / **346 MiB**, both 558 MiB — so there is no cheap middle.
    **DONE 2026-09-12 after he reported it a third time, and "his call" was the
    wrong framing** — a rebuild alone could not have reached him: the freshness
    check was all about the CARD database and `seedReviews` does not move when only
    the audio does, so `ensureFile` skipped the file for ever, in green. The audio
    now has its own comparison on `blob_store_meta.created` (`audioIsStale()` in
    `app/seed-freshness.ts`; the arm that must NOT fire — an older manifest with no
    such field — is pinned, because firing it re-downloads 640 MB every boot).
    Seed rebuilt at `--speech-bytes 650000000`: 10,826 payloads, **5,710 of 5,710
    cards (100.0%)**, the card database left alone so local grades survived, and
    both clips on four consecutive 単語 cards reached `playing`.
    See `DECISIONS.md` 34.

35. **TYPE SIZE FOLLOWS THE CONTENT, NOT THE POSITION.** Zach, 2026-09-12, on a
    reverse 単語 track: *"i think it's correct that the 漢字 has the big text because
    it's short, but when it's reverse, why is 漢字 small and the definition big...?
    this is super ugly lol"*. The old rule keyed the display size on `.drill` — the
    QUESTION side — which on a forward track is the head word and so looked like
    typography, and on a reverse track is a six-synonym English definition at 40px
    **with the kanji in body text below it**. His own sentence gives the rule:
    *"because it's short"*. `sideScale()` in `app/review-boundary.ts` measures the
    side's rendered length in CODE POINTS and applies it to EVERY side in both
    directions: **≤28 display · ≤64 mid · above that body**. Reverse then needs no
    special case. **28 is measured**: every forward vocabulary prompt fits in 26
    characters and 90% of reverse prompts start at 28, so nothing sits on the line.
    **基本情報 is why this is a LENGTH rule and not a DIRECTION rule** — its FORWARD
    prompts run to 170 characters and had been rendering at 40px all along, so a
    rule keyed on direction would have left it broken and looked correct.
    `.drill` is still set; it just no longer decides size. See `DECISIONS.md` 35.

36. **ONE PLAY CONTROL PER CLIP, BESIDE THE CLIP.** Zach, 2026-09-12: *"we only
    have 1 play button, what if i have two audio like this and i wanna replay the
    first one or the second one"*. The round button bottom-right does not move
    (decision 23, his right thumb); it now means "again" for the clip the reveal
    last sounded. The answer to "which one" is not a picker — every clip already
    sits on the side that owns it, so a 34px square button in that line needs no
    label. **Not the native `<audio controls>`**: sourceless so inert, full-width
    with a seek bar, play at the far LEFT, and it cannot show playing/missing.
    **A LIVE BUG FELL OUT OF THE QUESTION** — `side.play()` unmasked
    unconditionally, so on a mode-2 card one press of replay (which decision 29
    deliberately allows BEFORE the reveal) took the clozes from `hidden,hidden` to
    `revealed,revealed` while `data-state` still read `prompt`. `play(mount,
    { unmask: false })` gives `prompt()`'s contract instead; `replay()` always
    passes it. See `DECISIONS.md` 36.
37. **FURIGANA IS FILLED, THROUGH `src/render/ruby.ts`, AND ONLY BEHIND A MASK.**
    Zach, 2026-09-12, over a head word wearing a floating em dash: *"why is the
    text coming out like that bro😭"*. Three faults, each hiding the next.
    **(a)** Nothing ever filled a furigana — excluded on purpose because the
    reading is the ANSWER on a `Reading = true` card — so every `<rt>` was empty
    and `ruby rt:empty::after` drew a dash over every head word in the corpus.
    The old note said the template "probably" wraps it in a cloze; measured, **42
    of 6,754 mounts are outside one and all 42 are on produce cards**. The guard
    is now `GeneratorMount.inCloze`, set by the renderer, and it is on **furigana
    alone** — a blanket rule would undo decision 34 (the example sentence is an
    `ai` generator with no cloze near it). **(b)** A furigana generation holds the
    INPUT with Mochi's brackets in it, not a reading; `readingOf()` unwraps it.
    **(c)** `src/render/ruby.ts` was never wired into the shipping render — the
    core emits ONE `<rt>` for the whole base, and **1,034 of 3,242 (31.9%)** bases
    mix kanji and kana, so a third would have misaligned. `mountPrepared` renders
    through `furiganaSupport` now: 120 cards, **120 annotated, 115 aligned run by
    run**. The dash is excluded on `pending` AND on `segmented` rubies — the
    latter would have been a new bug, since run-by-run alignment leaves the kana
    tail's `<rt>` empty by design. See `DECISIONS.md` 37.

38. **A KEYCAP HINT TAKES THE COLOUR OF WHAT IT SITS IN.** Zach, 2026-09-12:
    *"`space` is a little hard to read don't you think? is there any other place
    that suffers like this?"* `.kbd` was `var(--muted)`, a grey chosen against
    PAPER, inside buttons that fill solid indigo — **1.76:1 light, 1.05:1 dark**
    (the same luminance: gone, not dim), and `--muted` on `--indigo-deep` 2.31 /
    1.50. **`remembered` is a solid fill AT REST**, so its `j` failed permanently,
    not just on hover — worse than the case he screenshotted. The fix is
    `color: inherit`, because any fixed token is wrong for one of the two grounds;
    `opacity: 0.85` is a MEASURED floor (worst pairing 4.88:1 there, 4.43:1 at
    0.8). **Two more from the same sweep:** `.kbd-inline` had no rule at all, so it
    was ungated and rendering `⇧p` on his phone — decision 19 violated by an
    unstyled element; and `--line`, the hairline token, was a SURFACE under the
    `--muted` subtitles of `.menu-item` / `.link-item` at **4.04:1 light** (the
    deck path, which is how he tells two same-named cards apart) — moved to
    `--sunk`. **`test/contrast.test.ts` was blind to all of it** because it checks
    foregrounds against the three PAPER grounds only; it now pins filled-ground
    pairings in both themes plus two structural rules (the hints may not name a
    colour token; `--line` may not be a background outside three named
    exceptions). See `DECISIONS.md` 38.

39. **THE RESET ZEROES EVERY BOX; A CARD'S BLOCK ELEMENTS NEED A RULE BEHIND IT.**
    Zach, 2026-09-12: *"the definition padding is still weird"*. There was no list
    rule at all — `* { padding: 0 }` applied, and a list with no padding still
    renders markers `outside`, so `1.` and `2.` painted LEFT of the content box,
    into the card's padding, aligned with nothing. **1,424 field values are
    lists**, so that was most 意味 sides. `padding-left: 1.4em` (em, so it tracks
    decision 35's type scale) puts the marker in the column and the text on a
    hanging indent. **The same reset had eaten tables** — zero cell padding, no
    borders, run-together text, on the one card in the corpus that has one.
    `<pre>` is left alone: zero code fences exist. **The test reads the RENDERER**
    — every tag inside a `context.element(...)` call in `src/render/nodes.ts` must
    have a `.hashigo-side` rule, with a reason-per-entry exemption table — so a
    renderer that learns a new element fails until the stylesheet catches up.
    See `DECISIONS.md` 39.

40. **THE MOCKUP GAVE TWO THINGS: CONTROLS FOR THE DRILL, AND A DESKTOP.**
    Zach, 2026-09-12, over `hashigo-card-controls.html`: *"what about the rest of
    the aestheticness of the design that we don't have yet? i know you can't
    'see' …"* **The beauty gap was measurable and was not colour or type:
    `app/style.css` had NO width breakpoint above 640px**, so the review screen
    was a 720px column between a full-width header and footer — a phone layout
    stretched across the laptop he reviews on at home. `--rail-w` (0px until
    ≥1024px) drives a standing rail; the six `position: fixed` rules get
    DIFFERENT treatments and `.layer` deliberately keeps `inset: 0`, because a
    preview's scrim must cover the rail. `contain: layout` on a wrapper would
    need no enumeration and was rejected for getting that one certainly wrong.
    A test classifies every fixed rule, because hand-enumeration already failed —
    four of five entries in the first draft were wrong. `.ops`/`.shadowbar`/`.bar`
    inset to the card's own 688px text column, **derived from `main` by the test**
    rather than retyped. **Card ops moved behind `⋯`** (0 of 7,716 cards pinned,
    244 archived; `delete` did not earn a place beside his thumb) using the
    EXISTING `.layer-menu`, not the mockup's popover-plus-sheet — and an earlier
    draft misquoted him to justify the old row (*"i never state this rule?"*):
    what is recorded is *every 操作 on the desktop exists on mobile*, which a menu
    on both satisfies. **UNDO STAYS OUT of it.** **Loop, speed and record-and-
    compare** came from measuring the corpus: word clips p50 **1.63s**, sentence
    p50 **4.08s**, only 1.0% over ten seconds — so a scrub bar is a seek target
    smaller than the gesture, and a 2px hairline answers the only question a long
    clip raises. **0.5× is deliberately absent**: rate change is a phase vocoder
    and the stretch smears the DOWNSTEP, which is the fact being trained;
    `preservesPitch` is set explicitly for the same reason. **The take is
    ephemeral and never touches the audio path** — its own element, so it cannot
    set `drill` or appear in `card.loop.log` — and nothing sounds while the mic is
    open. Decision 29 is untouched structurally: re-measured, `play` inside
    `enter()` turns **25** tests red. See `DECISIONS.md` 40.

41. **THE FINAL IMPORT HAS HAPPENED, AND THAT RETIRES A JUSTIFICATION.** Zach,
    2026-09-13: *"what we have now is already the final import, i won't import
    anymore (unless we genuinely lost everything here ofc)"*. Decision 16 always
    said "one final import, then never again"; what was never recorded is WHICH,
    and plans since have assumed one more was coming. **The 2026-09-08 import was
    it.** The consequence is not about importing: "a schema bump means RE-IMPORT,
    not migrate" rests on *"the reviews still come from the export"*, and they no
    longer do — Hashigo's own grades (56 on his current device, 43 on the other)
    exist in OPFS and the sync mailbox and nowhere else. So `rm` + re-import has
    stopped being a lossless reset, and any schema change must answer for the
    live history first. Decision 17's backup and decision 33's payloads are the
    only things carrying it, and both stamp `archive.schemaVersion`, so they are
    PART of a migration rather than an escape from it. **It also makes the backup
    the weakest link in the project** — as of this date his history lives in two
    browsers' OPFS and three gitignored JSON files. See `DECISIONS.md` 41.

42. **`remembered` WAITS FOR THE END OF THE WALK; `forgot` DOES NOT.** Zach,
    2026-09-13: *"you don't know if you actually remember the card until you're
    at the last slide, so maybe we don't even need remembered button when we
    still have next button"*. The asymmetry is the argument: `forgot` is settled
    by ONE failure, `remembered` is a conjunction over every side and is not
    settled until the last is up. **This AMENDS decision 34's "grading does not
    wait for the end of the walk" — for `j` alone.** It is NOT the 2026-09-07
    *"it won't let me click remember"* defect returning: that was a live-looking
    button that did nothing, and this takes the button OFF SCREEN and makes the
    key SAY what is missing (`3 more to see — space, then j`). The two sentences
    it replaces were agents' claims about his cognition, never measured, and
    nothing in the schema records the step a grade was made at. **Cost, measured
    over 961 sampled tracks: 99.8% have >= 2 steps so the rule reaches nearly
    everything, mean 2.43 extra presses, 単語 median 4 steps** — real only if he
    was passing early, which is the practice he says he does not have. The
    layout invariant is the other half and finishes the same day's mistap fix:
    two equal halves, **left is always `forgot`, right is always proceed**
    (`next`, then `remembered`). See `DECISIONS.md` 42.

43. **THE EXAMPLE SENTENCE CARRIES ITS OWN PITCH ACCENT, PER MORA — `<ojad>`.**
    Zach, 2026-09-13: *"do you think it's possible that we can add field type
    called OJAD? … the head of the accent is some color … and the 平板 would have
    no color, and other color for the devoiced"*. **NOT a field type** —
    `template_fields.type` is a CHECK constraint and decision 41 made a schema
    bump expensive the same day. It is an ELEMENT (`ELEMENTS` in
    `src/template/ast.ts`, the parser's allowlist) filled from a `local = 1`
    `plain` field, which is the `型` pattern: zero schema change. `pinyin` had
    already proved a generator needs no `blobs.kind`.
    **DEVOICING WAS FREE** — OpenJTalk writes a devoiced vowel as an UPPERCASE
    phoneme in the labels `tools/accent.py` has parsed since stage 6
    (`sh i m a sh I t a`). **平板 IS `accent == morae`, NOT 0, and the first cut
    reproduced CLAUDE.md's own "2,065 phantom 尾高" trap at sentence scale**:
    marking the last mora painted 21.1% of morae, the correct rule 13.9%.
    The mirror of decision 27 is the payoff — in a sentence the particle is
    inside the accent phrase, so 平板 and 尾高 separate, and this shows him what
    the isolated word physically cannot.
    **Measured: 3,711 of 3,712 sentences annotated, 86,627 morae, 13.8% heads,
    5.7% devoiced.** `--vermilion` fails as a body-text mark in light (3.99:1)
    and is darkened to `#b33717`; blue is disqualified because it already means
    "touch this"; the two marks are ISOLUMINANT (1.04:1) so devoiced carries a
    ring as well, which is OJAD's own notation. `<ojad></ojad>` is EMPTY and
    follows the sentence — wrapping the field turned four tests red, because
    `例文` is an `ai` field and the wrapper displaced its speech mount.
    See `DECISIONS.md` 43.
44. **`---` IS HIS, AND THE QUESTION BOUNDARY FOLLOWS IT.** Zach, 2026-09-14, on a
    漢字 card whose `<draw>` canvas was up before he pressed anything: *"so it
    doesn't follow the `---`??? because i added that explicitly, i have my
    reasons."* The boundary used to be "the first non-empty side, **plus a following
    side that carries a widget AND NOTHING ELSE**" — which reached 漢字 and only
    漢字, on the stated ground that the canvas must be on screen while he draws from
    memory. **That ground was an agent's**: it arrived in the stage-9 shell commit
    (`16afee6`), was recorded in no decision, and is in none of the three findings
    that commit reports. `---` is a side break HE AUTHORED in `templates.content`,
    so a rule that folds an authored side into the previous one is overruling the
    template from code — the mistake READ THE TEMPLATE exists to stop, and the same
    shape as gating `型` in the resolver rather than in the body (decision 20). It
    also makes the alternative his and cheap: if the canvas belongs beside the
    kanji, that is **one deleted `---`**. **The cost is one press on 1,662 cards**
    (canvas · 読み · 意味), and **that press reveals no answer** — 漢字 has no cloze
    and no audio, so the step shows a blank canvas and nothing else. Drawing is
    unaffected: `src/render/draw.ts` was already written against the one-pixel
    canvas a hidden mount produces (`ResizeObserver`, plus `remeasure()` on stroke
    start). **One hint moved with it** — *"answer on the card"* asked whether a
    widget sat on a PROMPT side, which would have deleted the line from 漢字 the
    moment the canvas moved; it now asks whether the CARD has a surface (数字's
    `<input>`, 漢字's `<draw>`). **Unchanged: why the rule is positional at all** —
    reverse tracks permute side order, and the first version printed the answer
    above the question on the first card of the first real session.
    See `DECISIONS.md` 44.
45. **THE SEED FETCH GETS A SCREEN, AND THE LADDER CLIMBS ON IT.** Zach,
    2026-09-16, handing over `hashigo-sync-v3.html` — a running prototype with
    presets, a stall simulator and a slider per stage. *"i agree that loading
    animation would be perfect."* **IT IS THE SEED FETCH, NOT DECISION 33's
    SYNC**, and the rename had to happen before it could be built: `sync` here
    means the mailbox (~1 MB, backgrounded since 2026-09-14), while this is
    `ensureFile` — 74 MB of cards + 9 MB of text + up to 643 MB of audio, which
    cannot background because nothing can open until it lands. **The gate
    survives for a new reason**: there is no fast seed fetch, so `GATE_MS = 500`
    exists so a boot that fetches NOTHING never flashes a download UI (verified:
    30 samples, never shown). **CHANGE IS REASSURANCE, MOTION IS NOT** — his line
    — so the screen is mostly numbers and the bar encodes the phase (sweeping =
    indeterminate, filling = bytes). **Three corrections against the codebase:**
    the colour lerp moved to CSS, because his `[224,69,29] → [27,59,111]` are the
    LIGHT tokens and `#1B3B6F` on the dark ground is **1.60:1** — invisible on
    the only screen he uses; the geometry IS the shipped mark (`railX(77)` is
    `[18.09, 81.91]`, the `d` already in `index.html`, pinned by test); and the
    authored accent is held at `opacity: 0` while animating, or the static
    vermilion rung covers the moving one and **the beat never reads as empty**.
    Timing `drop 800 · beat 200 · fade 500 · hold 600`, phased so `t = 0` is the
    start of `hold` — a fetch inside one cycle shows the resting mark and no
    motion. `REWARD_STAGES` (`hold: 0`) starts on the drop from the same
    implementation, so deck completion is a one-line change. **The clock is
    `performance.now()` directly**, never a value anything else scales — a
    prototype that multiplied it by an unrelated speed ran 20× too fast. **No
    red** for the stall (decision 40's argument) and **no "use the local copy"**
    escape hatch (the local copy is the stale thing). **One deviation, deliberate:**
    the boot log is KEPT below the readout — it is what he diagnosed three faults
    with in one week. **NOT VERIFIED: reduced motion** — implemented, and
    `prefers-reduced-motion` cannot be emulated with the tools here.
    See `DECISIONS.md` 45.
46. **A LATE TRACK SAYS HOW LATE; A TRACK DUE TODAY SAYS NOTHING.** Zach,
    2026-09-17: *"it would be helpful to see that this track was due 5 days ago"* —
    he had been away and was catching up. A fourth chip on the deck line beside
    `new card` / `again · not graded` / `reversed`, last because it is the only one
    that changes daily. **The number is `QueuedTrack.overdueDays`, which already
    existed and counts in LOCAL DATES** — `Date.now() - due_at` is a different
    quantity (a card due at 23:00 yesterday is ONE day late and fourteen hours
    old), so the worker passes the scheduler's figure through and `app/overdue.ts`
    only chooses words. Decision 6. Fixed at PLAN time, so a session open past
    midnight shows yesterday's count. **Due today gets no chip** — 134 of his 1,166
    are, a card due today is the plan working, and chipping them all would stop the
    late ones standing out, which is the request. A new track has no due date and
    the worker sends 0, so 0 unambiguously means "not late". **The buckets are
    measured and his queue is BIMODAL**: 135 one day · **827 between 2 and 30** ·
    **nothing between 31 and 364** · 70 over a year, oldest **757 days** (数字,
    untouched since 2024-08). Days carry his case, years carry the tail, months are
    for a future that has not happened; months clamp at 11 because `364 / 30.44`
    rounds to 12 and "12 months" beside "1 year" meaning fewer days is the worse
    pair. A test sweeps 1-800 days for monotonicity. **QUIET, not a warning** — 827
    of 1,032 means nearly every card in a catch-up session carries one, so it keeps
    the chip shape and drops only the text to `--muted` (5.22:1 light, 6.66:1 dark,
    both above AA at 10px; dropping the BORDER to `--hair` measures 1.29:1 and is a
    missing chip, not a quiet one). No vermilion (decision 32) and no red: being
    behind is the thing he is currently fixing, which is decision 40's argument on
    the stall notice. See `DECISIONS.md` 46.

47. **AN EMPTY Ctrl+K SUGGESTS; IT DOES NOT LIST THE ALPHABET — AND NO SEARCH QUERY
    IS EVER RECORDED.** Zach, 2026-09-17: *"if i search something using ctrl+k, would
    it leave any search history? like notion … it would list pages that it thinks
    would relevant to you, even if you never search, how does it do that?"* **Notion
    is not predicting — it keeps an ACCESS LOG**, and an empty palette is that log.
    **The typed query is still stored nowhere** (`src/search`'s header already said it
    "does not remember history"); what exists now is a log of cards OPENED. The
    distinction is the point: a recents list is worth a trail of what he looked at, a
    list of half-typed strings is not. **The alphabet was the cost** — the palette's
    empty state fell through to `ORDER BY c.name`, whose real first ten are
    `...にも程がある · ...は...に限る` and **eight cards named by an opaque number**.
    **`last_reviewed_at` LOOKS like the signal and is unusable:** all 103,110 imported
    reviews are `time_unknown = 1`, so it holds **307 distinct values over 7,716
    cards** and ties 16/22/69/52 deep — an arbitrary order with a plausible name, at
    **182 ms** against **2.0 ms** for what shipped. Three tiers instead, separate
    queries because a single score would need invented weights: **pinned** (0 today,
    but the card menu already promises it), **opened here** (`app/visits.ts`, 50 ids in
    `localStorage`; **grading is not a visit** — a session would flush the log and the
    palette would just mirror the queue), then **edited** (`cards.updated_at` survived
    the import with real timestamps: 787 distinct days, and it reads as a recents list
    by itself — 維持 · さることながら · persecute · 正答 · 群衆). `localStorage` and not
    a table, because decision 41 made a schema bump expensive; deliberately not in
    decision 33's payload. **The gallery is excluded** (`suggest: false`) — an empty
    deck listing ordered by relevance would be a lie; the `@` picker is included.
    `app/recent.ts` over a structural `ScopedDb`, for `deck-scope.ts`'s reason.
    **AMENDED THE SAME DAY — THE EDITED TIER EXCLUDES ARCHIVED CARDS**, and the
    reason is that `cards.updated_at` is not only Mochi's edit time.
    `src/backup/archive.ts`'s `UPDATE_CARD_STATE` stamps `strftime('now')` on every
    card whose flags the archive holds, and the archive stores only NON-DEFAULT
    rows — exactly the archived and pinned ones. So decision 17's restore, the
    disaster path the backup exists for, moves all **244** archived cards to the top
    of "recently edited" on one millisecond. Not hypothetical: the first empty
    Ctrl+K after this shipped was **40 archived cards and nothing else**, on a device
    that had had a restore, and it reproduces from `export` + `apply` on a copy. The
    filter is the right rule anyway — an archived card is one he took OUT of
    rotation, and offering it before he types is a guess he has already answered;
    search still finds it the moment he does. Pinned and opened keep theirs: a pin is
    an explicit request and an open is something he just did. **NOT FIXED, and worth
    its own look: the restore stamping `now` at all.** The archive carries no
    per-card clock to restore instead, so that is a format change — and
    `cards.updated_at` is decision 33's LWW clock for `archived`/`pinned`, so moving
    it moves who wins a sync.
    See `DECISIONS.md` 47.

48. **THE DAY'S BAR SHOWS THE MISSES, IN RED — HIM ANSWERING A QUESTION DECISION
    32 LEFT OPEN.** Zach, 2026-09-17: *"for missed/forgot card, we can actually make
    it visible on the progress bar, but maybe as a red bar? so the bar can now tell
    the proportion"*. Decision 32 took the colours off grading and `app/style.css`
    has carried the caveat ever since — *"the one place the brief's palette
    discipline costs a semantic signal he has 103,110 reps of muscle memory for"*.
    He is putting the red back where it costs the brief nothing: a **2px summary**,
    not a control. **The buttons are unchanged.** `--danger` not `--vermilion`
    (decision 32 allows one vermilion per screen, and `--no` already resolves to
    `--danger`): fill 7.10:1 light / 5.03:1 dark against the track, miss 3.85 /
    3.76, and the two are within **1.34:1** of each other in dark so the boundary is
    carried by HUE — blue against orange, the one pair that survives every common
    colour-vision deficiency. **The red is a PREFIX anchored at zero**, painted over
    the fill, so both widths only ever grow; at the leading edge it would report his
    last grade rather than the day's proportion. **`missedToday` is counted from
    `reviews` in the SAME statement as `answeredToday`** — a tally on the session
    would zero on the reload `answeredToday` exists to survive, and the bar would
    contradict itself; a decision-13 re-ask writes no review so a miss counts once.
    **And the question he asked first: yes, `forgot` on a NEW card grades it, and it
    should** — `gradeMemory` calls FSRS `init`, a function of the grade alone:
    stability 0.212 / **1 day** for a miss against 3.281 / **3 days** for a hit, and
    with decision 2's binary grades that first grade IS the initial-stability
    signal. **86 of his 9,085 tracks** have a first review recorded as a miss. His
    instinct is literally right about `lapses` alone (Anki counts only a failure of
    a card already learned); **left alone on purpose** — nothing schedules on that
    column and nothing displays it, the dashboard's 失敗 comes from
    `sum(1 - remembered)` over `reviews`.
    **AND MOCHI'S MODEL, WHICH HE RAISED AND HIS OWN EXPORT MEASURES.** *"in mochi
    … until the card is added to your review deck it won't keep track of your
    grade, but i don't know which approach is the best"*. He is right about Mochi:
    miss rate by review number is **#1 0.95%** (9,085 tracks) · #2 3.37% · #3 3.11%
    · **2+ 4.04%** · overall 3.76%. A genuine first exposure should be the HARDEST
    review a card ever gets; his is **four times easier than average**, which is
    what a log looks like when the learning attempts are discarded and only the
    graduation is written. **HASHIGO ALREADY HAS THE BETTER HALF OF BOTH, which is
    why nothing changed**: decision 13's re-ask writes nothing whichever button he
    presses, so a track takes **exactly one review per session** and cannot loop —
    the answer to *"how many times is okay"* is ANY number, the first press counts
    and every press after it is free. What Mochi throws away is the one thing FSRS
    asks for there, since `w[0]`-`w[3]` ARE "initial stability for this first
    rating". **The one real difference left is TIMING, not bookkeeping** — a bombed
    new card returns tomorrow rather than in minutes, and the lever for that is
    decision 13's placement, which is his. See `DECISIONS.md` 48.

**Five small calls an agent had made without authority were ratified 2026-08-22**
— the `---` horizontal rule, the CommonMark emphasis deviations, the dashboard's
zero JavaScript, the heatmap's 4 colour bins, and `tags` keeping 20 rows for 19
real tags. All five as recommended; the reasoning is in
[DECISIONS.md](DECISIONS.md).

## READ THE TEMPLATE. It answers most questions about the screen.

> [!warning] **Zach has told agents to read his template FOUR times.** Stop asking him
> what the review screen shows in which case. `templates.content` is a column in this
> database, he edits it whenever he wants, and it already encodes the conditional. Run
> `SELECT content FROM templates WHERE name = '単語'` before asking anything about layout.

`<<#Reading>>` renders a block when the boolean is TRUE, `<<^Reading>>` when it is FALSE.
That is the whole mechanism. Rendered from the real corpus, both states of 単語:

```plaintext
Reading = TRUE (慈善)                     Reading = FALSE/absent (係数)
  side 1  "慈善"           0 clozes 0 audio   side 1  ""              0 clozes 0 audio
  side 2  "[…]慈善 平板"    1 cloze  1 audio   side 2  "[…]係数[…]係数 中高(3)"  2 clozes 1 audio
  side 3  example sentence  0 clozes 1 audio   side 3  example sentence 0 clozes 1 audio
  side 4  meaning + links   1 cloze  0 audio   side 4  meaning + links  1 cloze  0 audio
```

**IT IS ONE SCREEN, NOT TWO.** The only structural differences are that side 1 is EMPTY
when `Reading` is false (its whole body sits inside `<<#Reading>>`, so the screen starts
at side 2), and side 2 carries **two** clozes instead of one — `Reference` is masked as
well, because it was never shown. A session-7 agent invented "a second card layout Zach
must design"; that was wrong, and he corrected it. **There is no second design. Render
the template.**

**And this answers "does he get the meaning as a hint on a hidden-word card?" — NO.** On
side 2 of a `Reading = false` card the only things visible are the **accent label and the
audio**; the word and its reading are both behind clozes and `意味` is on side 4. Sound
plus `型`, nothing else. Do not ask him this; the template says it.

**The mockup's `.head` div is a HAND-AUTHORED ARTIFACT.** `build/mock/out/*.html` was
built by `scripts/mockup-html.ts`, not by the template engine, so its always-visible large
word does not exist in the real render. Do not treat the mockup as a spec for structure —
it is a spec for the LOOK (decision 23).

## Things he has already answered — DO NOT ASK AGAIN

He has repeated each of these to a different agent, and the count is his:

1. **READ THE TEMPLATE** (above) — asked four times.
2. **Audio regeneration happens AFTER the app is finished** — told to five agents.
   *"i will regenerate my audio after we finished the app, because i have to re import
   anyway because everyday when i make this app i still review mochi."* So do not propose
   regenerating clips, do not price it, do not treat `other-voice` clips or the missing
   ones as a task. **AND THE CONSEQUENCE AGENTS KEEP MISSING:** he is still reviewing in
   Mochi daily, so the review history in `build/hashigo.db` is FROZEN between imports —
   the newest review is **2026-09-05**, from the export he handed over on 2026-09-08.
   Every due-queue figure in this repo is a snapshot and **will change at the next
   import**. Quote them as "as of <date>", never as current. **TWO mechanisms move them
   and this file used to name only the first:** the frozen history, and the fact that
   DUE GROWS EVERY DAY as scheduled dates pass. The second is faster, and it is fast.
   Same database, no import and no grading in between: **443 → 646 (2026-08-26) →
   1,440 (2026-09-07)**. Twelve days roughly doubled it. A due figure more than a few
   days old is not stale, it is wrong.
   (The fixed-instant figure in `test/session.test.ts` moved 443 → 437 for an unrelated
   and deliberate reason — `scripts/reverse-dormant-apply.ts` — and then 437 → **70** on
   the 2026-09-08 re-import, because `NOW` there is a fixed 2026-08-22 that the new
   history now runs three weeks past. Both are documented at the constant.)

   **THE 2026-09-08 RE-IMPORT, MEASURED CARD BY CARD, because "the numbers moved" is
   not the same claim as "the importer still works":** 7,716 cards before and after;
   **one card deleted** (`Y9ai64M3`, 基本情報, 4 reviews), **one created** (`uCc5sSvs`,
   日本語, 群衆, 3 reviews), **zero cards changed deck, and zero surviving cards lost a
   single review**. Reviews 102,020 → 103,110. That last property is the one decision
   16's guard exists to protect, and it was observed rather than assumed.
3. **Open-sourcing gets discussed AFTER development** — told to three agents. Not now.
   `notes/open-sourcing.md` holds what was already checked; leave it there.
4. **HE USES IT ON BOTH — laptop AND phone** — told to two agents. *"on my laptop
   i review when im home, and i create card from my laptop; on my phone, mostly for
   reviews."* So the desktop is a FIRST-CLASS surface and not a test rig, card
   CREATION is a laptop activity, and the phone is review-heavy. **The consequence
   is the one that matters: without stage 11 sync, the two devices hold separate
   OPFS databases and his stated workflow is impossible** — a card made on the
   laptop never reaches the phone, a grade made on the phone never reaches the
   laptop. Sync is not "a large remaining piece"; it is the thing that makes the
   app usable as he uses it.
5. **THE IMPORT IS WHOLESALE — he never imports one card or one deck** — told to
   four agents. *"i never import one card or one deck, once we finish developing
   hashigo, ill delete the whole card and reimport again."* So a partial or
   incremental import is not a scenario, and neither is a Mochi id arriving beside
   locally-created data: **after decision 16's one final import, no Mochi id ever
   arrives here again.** An agent spent real effort on a namespacing scheme to make
   locally-created card ids collision-proof against Mochi's; that was solving a
   problem he does not have. A new id needs to be unique in THIS database, which
   `cards.id UNIQUE` already enforces, and nothing more.

## The hard rule: audio must never autoplay ON A `Reading = true` CARD

> [!warning] **AMENDED 2026-08-23 — decision 29. This rule used to be absolute and it
> is now CONDITIONAL on the `Reading` boolean.** It is still a correctness requirement,
> on the **692** `Reading = true` cards. On the other **3,177** (2,785 単語 with
> `Reading` false or absent, plus all 392 言葉) Zach's Mochi autoplays on entry, he wants
> that kept, and he has a reason that is not laziness — see decision 29. What follows
> describes MODE 1. Do not apply it to mode 2, and do not delete the mode-1 tests to
> make mode 2 pass.

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

So, **on a `Reading = true` card: audio fires on the cloze reveal, never when a side
appears.** Autoplay is the default in most flashcard renderers and it does not degrade
THAT exercise, it deletes it — the contour is given away before he has produced it. This
is a correctness requirement for those 692 cards.

**On a `Reading` false-or-absent card the exercise is the OTHER WAY ROUND and autoplay is
correct:** the word is masked, the audio is the PROMPT, and identifying the kanji from the
sound is the test — *"if you show me 償却 i can read that word like instantly … but if you
hide it behind the cloze, and play しょうきゃく … it would force me to remember."* `型` is
visible on entry there too, because it is how he discovers an accent he had wrong and then
promotes the card to `Reading = true`. Decision 29 carries the full split, the measured
trade-off, and the reason the tests must get STRICTER rather than looser.

`src/render/reveal.ts`'s `enter()` therefore does nothing but record that a side is on
screen — **that did not change, on any card** — and media elements are created with no
`src`, no `autoplay`, no `loop` and `preload="none"`. Playback is reachable from exactly
**three** named calls: `reveal()`, `play()`, and (since decision 29) `prompt()`, which
plays the mode-2 question and **unmasks nothing**.

It is pinned by tests with demonstrated teeth, re-measured by a peer review 2026-08-23:
putting `audio.play(media, "reveal")` inside `enter()` turns **10** tests red — 8 in
`test/reveal.test.ts` and 2 in `test/review.test.ts`, including the 7,716-card sweep.
Adding an `autoplay` attribute in `src/render/nodes.ts` turns 8 red across three files.
If you change either file, re-run that experiment rather than trusting a green suite.

### DECISION 29 IS BUILT as of 2026-08-23 — and `enter()` never had to change

The trap this section warned about was that implementing mode 2 means making `enter()`
play, turning the mode-1 tests red *for the right reason*, with the wrong repair being to
relax them. **Neither happened.** `enter()` still does nothing; mode 2 got its own verb.

```plaintext
loop.enter(pos)      plays NOTHING, on any card, ever. Byte-for-byte unchanged.
mounted.enter(pos)   plays the question when the card is `identify` AND the side
                     masks something. Calls side.prompt(), which does NOT unmask.
```

**`src/review/mode.ts` is where a card's mode is decided, and `src/render/reveal.ts`
still contains no reference to `Reading`** — a test asserts that literally. Three things
in that file stop it being one `if`, all measured:

* **`漢字` declares a field named `Reading` and it is `plain`, not boolean** — it holds
  the actual reading (コウ ×36, ショウ ×33) on 1,662 cards. Without the type check every
  one of them is misclassified on a name collision.
* **`identify` is NOT "everything that is not `produce`".** It is scoped to templates
  declaring an `accent` field — 単語 and 言葉. **敬語 (21) and New Vocab (1,203) show the
  head word UNMASKED beside its clip**; autoplay there is the original defect again. The
  default is `produce`, the silent one.
* **The prompt is per SIDE.** An identify card's sentence side (`例文` + `Audio`) masks
  nothing, so `promptsOnEntry` requires a cloze on the side.

Measured through the shipping loop over the real corpus:

```plaintext
mounted.enter, 60 produce cards      0 resolve calls · 0 play() calls
mounted.enter, 60 identify cards     60 asked · 60 play() calls · 120 clozes STILL MASKED
言葉, all 392                       391 asked · 377 played · 391 clozes still masked
corpus modes                        692 produce (drill) · 3,177 identify · 3,869 in the drill
```

**`型`'s gating is in the TEMPLATE, not in code** (`scripts/accent-field-apply.ts`), because
a resolved plain field is substituted to TEXT before the render — nothing downstream knows
`平板` came from `型`. Zach asked for exactly this: *"it should render conditionally from my
template."* The outer `<<#型>>` guard is load-bearing: an empty cloze reaches the page as
the LITERAL `{{}}`, and 3 of the 692 mode-1 cards have no derived accent.

**Six injections, all with teeth** (2026-08-23). `enter()` plays → **15** red across two
files. The mount prompts regardless of mode → **5**. `prompt()` unmasks → **2**. The
`Reading` lookup ignores the field type → **2**. `identify` unscoped → **3**.
`promptsOnEntry` drops the "something is masked" condition → **3**.

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
cards 7,716 | reviews 103,110 | retention 96.24%
wiki-links 8,690 | tombstones 8,983
inline generators: {'speech': 287, 'translate': 106, 'image': 8, 'furigana': 19, 'ai': 124}
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
* Prefer measuring over assuming: this project has 103,110 graded reviews and 56,810
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
