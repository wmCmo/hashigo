# Hashigo (梯子)

A local-first spaced-repetition app replacing [Mochi](https://mochi.cards) for one
user's Japanese study. Built because Mochi's developer stopped fixing reported bugs.

> **This file is loaded into every session, so it is kept to what a session needs to
> act correctly.** It was trimmed on 2026-10-29 from 103 KB; the full previous text —
> every measurement, correction and quote it carried — is kept word for word in
> [notes/archive/CLAUDE-before-trim-2026-10-29.md](notes/archive/CLAUDE-before-trim-2026-10-29.md).
> The WHY of every decision is in [DECISIONS.md](DECISIONS.md); his words are in
> `notes/zach-in-his-own-words.md` (if that file and a decision disagree, that file is right).

## Where things are

**The app runs and he uses it daily**, on his laptop (reviews at home, ALL card creation)
and his phone (mostly reviews). `app/` is vanilla TypeScript on Vite: a SQLite database in
the browser's OPFS (sqlite-wasm, `src/db/browser.ts`), audio on the device, grades on disk,
devices synced through a mailbox (decision 33). Live at
<https://hashigo.titan-zp4.workers.dev> (Cloudflare Worker `cloud/app`, passphrase lock, R2
seed). `app/README.md` is the entry point for the app; `src/*/README.md` for each module.

- **Every status figure lives in [NEXT.md](NEXT.md), not here** — queue counts, gate
  results, what landed when, what is left. Change the state there.
- **[SPEC.html](SPEC.html) is the design document** (draft 8, figures measured from
  `exports/`). Published copy:
  <https://claude.ai/code/artifact/c8416a42-779a-49da-81c1-54459067d94b> — revise by editing
  `SPEC.html` and republishing **the same file path** with that URL as `url`.
- **[design-system/](design-system/README.md) is the design system** (decision 57). **Read
  its README before touching anything visual.** `app/style.css` applies it under older token
  NAMES (`--indigo` is ink, `--vermilion` is ruri — the stylesheet header maps them), so a
  palette or shape change goes into BOTH. Type sizes and spacing must be `--fs-*` /
  `--space-N` steps taken from `tokens.json` (`test/type-scale.test.ts`,
  `test/spacing-scale.test.ts` refuse raw values). Published copy:
  <https://claude.ai/artifact/Nd9wzUTDFdMP5aquZZGvJR> — to revise: copy `design-system/` to
  `<scratch>/project/`, republish with that URL as `url`, `root` = `<scratch>`,
  `file_path` = `<scratch>/project/design-system.json` (read the live index first, keep its
  keys, bump `lastChange`), `files` = each changed `project/<path>`. `file_path` is served
  RELATIVE TO `root`. Never write `tokens.css`, `manifest.json` or `api/`.
- **[site/index.html](site/index.html) is the landing page** (approved 2026-10-27).
  `.github/workflows/pages.yml` deploys `site/` to <https://wmcmo.github.io/hashigo/> on a
  push to `main` that touches it; `npm run site:dev` serves it on 127.0.0.1:5275. Check
  390 / 780 / 1280px, light and dark. Its `favicon.svg` is `app/brand/favicon.svg` with
  theme-following colours — change the mark in both.
- **The accent pipeline is DONE and VALIDATED — do not redo it.**
  `notes/pitch-accent-pipeline.md` §7-§10 has every measurement, including two that read as
  failures and are not (`accent_verify.py` false misses on unvoiced onsets; the listening
  test measured Google, not our derivation).
- **`build/mock/out/` is a spec for the LOOK, never for structure** — its `.head` divs are
  hand-authored; the real render produces none of them.

**Built and doing nothing — the opposite trap to rebuilding:** `かな主流` renders on zero
cards. All six `true` values are on 言葉, whose body has no marker; the marker is on 単語,
where no card carries the flag. Decision 28 settles it: 言葉 displays as inputted, the
values stay stored. Do not "fix" it.

## The commands

```bash
npm run gates           # ALL SIX GATES, one command, honest verdict. Start here.
                        # `npm run gates -- test` runs one. app:build is ONLY in here:
                        # app:check is `tsc --noEmit` and cannot see a broken worker or
                        # wasm URL. (spike:check was dropped 2026-10-27 — an injected
                        # contract break turned `typecheck` red with 667 errors; see
                        # `test/db-contract.types.ts`.)
npm test                # 68 files, 1592 passed, 1 skipped (the FSRS refit, gated). ~55-100 s.
                        # MEASURED, never added up — run the suite or leave the line alone
                        # (`test/docs-figures.test.ts` checks it). A wrapper
                        # (`scripts/test.mjs`) that reads vitest's SUMMARY: the run must
                        # finish and have zero failures. Raw vitest (`npm run test:raw`)
                        # exits 1 on a passing run because birpc's hard-coded 60 s timeout
                        # fires once per file slower than 60 s — the wrapper reads past it.
                        # DO NOT SET `pool: "threads"`: better-sqlite3 is a native addon and
                        # it SEGFAULTS (exit 139) after passing twice. The floor is
                        # dashboard.test.ts and roundtrip.test.ts, which re-import the
                        # whole corpus; splitting one would not move it.
npm run typecheck       # exit 0
npm run app:check       # exit 0 — app/ has its OWN tsconfig and this is a REQUIRED gate
npm run build           # refuses to exit 0 unless dist/ actually imports (29 export subpaths)
npm run rebuild -- --force   # the schema-bump chore as ONE command, with invariants
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run dashboard -- --db build/hashigo.db --out dashboard.html   # --locale ja for the other
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths   # exits 1 on any absolute path

# THE APP. app/README.md first.
npm run app:bootstrap                     # once: build/app/*.db, the seed the app fetches
npx vite-node scripts/app-bootstrap.ts -- --speech-bytes 650000000   # the seed with ALL audio
                        # Default 200 MiB takes each card's CHEAPEST clip first, so no card
                        # gets a second before every card has a first (98.2% coverage).
npm run app:dev -- --host 127.0.0.1       # local only
npm run app:build:cloud                   # then, in cloud/app/: npx wrangler@4 deploy
                        # Deploy when Zach asks. Confirm via Settings → versions
                        # (`app v0.5.0 · <commit>`). A running app picks a deploy up on its
                        # own (`app/update-check.ts`).
npm run accent:helper                     # decision 56's helper on 127.0.0.1:47474
                        # (starts at login from a Startup-folder shortcut on his laptop)
npm run phone                             # dev server to the phone through a fixed tunnel
                        # Historical; the phone uses the cloud app now. OPFS is keyed by
                        # ORIGIN, so a new address is a new empty database and a full
                        # re-download. A LAN IP cannot substitute: plain HTTP is not a
                        # secure context and `navigator.storage` is absent there.

# The scheduler. Read-only except `seed`.
npx vite-node src/scheduler/cli.ts -- counts   --db build/hashigo.db
npx vite-node src/scheduler/cli.ts -- queue    --db build/hashigo.db --limit 20
npx vite-node src/scheduler/cli.ts -- forecast --db build/hashigo.db --days 14
# The session. READ-ONLY on purpose: no `grade` command — grading from a terminal would
# write real reviews with no card in front of him.
npx vite-node src/session/cli.ts -- plan --db build/hashigo.db --limit 14
# Decision 17's backup. `export` is read-only; `apply` is one transaction, idempotent;
# `--dry` does the real inserts, reports, then rolls back.
npx vite-node src/backup/cli.ts -- export --db build/hashigo.db --out backup.json
npx vite-node src/backup/cli.ts -- apply  --db build/hashigo.db --in backup.json --dry

# The accent pipeline. Python owns the analyser and NOTHING else (src/accent/README.md).
npx vite-node src/accent/cli.ts -- words --db build/hashigo.db --out build/head-words.txt
.venv-accent/Scripts/python tools/accent_derive.py --words build/head-words.txt --out build/accents.jsonl
npx vite-node src/accent/cli.ts -- load  --db build/hashigo.db --in build/accents.jsonl
npx vite-node src/accent/cli.ts -- ojad  --db build/hashigo.db     # apply the hand adjudications
npx vite-node src/accent/cli.ts -- queue --db build/hashigo.db     # 15 listed (2026-10-25)
npx vite-node scripts/accent-push.ts -- --apply   # after `ojad` + `write`: send changed 型 labels
# The live data is on the DEVICES, not in build/hashigo.db. These read the mailbox, run
# the same code, self-check the merge, and send only their values from their own sync
# slot. Dry by default.
npx vite-node scripts/ojad-fill.ts -- --apply      # OJAD for cards made in the app
npx vite-node scripts/cards-add.ts -- --in cards.jsonl --apply
                        # NEW CARDS without a browser (one JSON per line: deck, template,
                        # name, values by field name). Same code as the app's form:
                        # values in one transaction, a repeated name refused. Run the
                        # kanji first; their ids print, and the next run sees them.
npx vite-node scripts/sync-set.ts -- --card <id> --field <id> --from <deviceId> --apply
                        # settle a value two devices hold at the SAME clock
```

**The dev server's bind address is a trap both ways.** `--host 127.0.0.1` refuses `::1`,
and on Windows `localhost` resolves to `::1` first (ngrok then returns 502). `--host ::`
answers both and also binds the LAN. `server.fs.allow` is narrowed on purpose: with
`[root]`, `/@fs/` served the 74 MB database to anyone who could reach it.

## A schema bump means RE-IMPORT — and that is no longer lossless

`SCHEMA_VERSION` is **9** and `applySchema` refuses any other version.

> [!warning] **A rebuild from `exports/` discards everything graded in Hashigo since the
> final import (decisions 16, 41).** The devices' OPFS and the sync payloads are the system
> of record now. The chore below is right for a DEVELOPMENT database only; a real schema
> change must say first what happens to the live history (decision 17's backup and
> decision 33's payloads carry it, and both are schema-versioned).

```bash
rm build/hashigo.db
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run dashboard -- --db build/hashigo.db --out dashboard.html   # asserts byte-identical
npx vite-node src/accent/cli.ts -- words --db build/hashigo.db --out build/head-words.txt
npx vite-node src/accent/cli.ts -- load  --db build/hashigo.db --in build/accents.jsonl
npx vite-node src/accent/cli.ts -- load  --db build/hashigo.db --in build/accents-unidic.jsonl
npx vite-node src/accent/cli.ts -- ojad  --db build/hashigo.db
npx vite-node scripts/reading-apply.ts -- --db build/hashigo.db --apply      # the 読み rows
npx vite-node scripts/accent-field-apply.ts -- --db build/hashigo.db --apply # the 型 field + bodies
npx vite-node src/accent/cli.ts -- write --db build/hashigo.db               # 型 labels
npx vite-node src/accent/cli.ts -- marks --db build/hashigo.db --in build/sentence-marks.jsonl
npx vite-node scripts/ojad-template-apply.ts -- --db build/hashigo.db --apply
npx vite-node scripts/reading-role-apply.ts -- --db build/hashigo.db --apply
npx vite-node scripts/reverse-dormant-apply.ts -- --db build/hashigo.db --apply  # LAST
```

- **`dashboard.html` is the importer's oracle** — a pure function of `exports/`, compared
  byte-for-byte by `test/dashboard.test.ts`. Regenerate it BEFORE `reverse-dormant-apply`,
  never after: that script moves dashboard figures and turned two oracle tests red when run
  first (2026-09-07). His working database and the oracle differ by those six tracks, on
  purpose.
- **Do not skip the second `load`** (UniDic): without it `queue` reports 0 disputed, which
  reads as "nothing left" rather than "the cross-check is missing".
- The local-field scripts are idempotent; a second run says "ALREADY APPLIED".

## Decisions that are settled — do not relitigate these

> [!IMPORTANT]
> **This index is the only place a decision counts as recorded.** His Obsidian planner holds
> reasoning no agent reads — a decision there and not here is not settled. Write the line
> here first, then the WHY in DECISIONS.md. **Read DECISIONS.md before proposing anything
> that touches one.** Numbering is cited across `src/`, `test/` and the notes: **never
> renumber, only append.** **Never run a Markdown formatter over this file or
> DECISIONS.md** — it renumbered the list once and passed every gate;
> `test/docs-integrity.test.ts` now fails on it.

1. **FSRS-6, max interval 365 days, target retention 0.90.** The 365 is derived, the centre
   of a ±5% band (see 11). See `DECISIONS.md` 1.
2. **Binary grades only** — remembered / forgot. No `grade` column; `w[15]`/`w[16]` frozen.
3. **The six empty leaf decks are dropped**: 45 decks become 39.
4. **Blobs are content-addressed.** No absolute path is ever stored in the database.
5. **Stale pre-template `content` is discarded on import, and reported** (3,159 cards).
6. **Name the interval basis, or the number is not a fact** — `elapsed_days` (measured) vs
   `scheduled_days` (planned). Generalises: every figure names its basis.
7. **A generator's input is the RENDERED text, never the stored value.**
8. **The UniDic cross-check is stored but never RESOLVES** — a candidate for adjudication,
   never the answer. A wrong accent drilled is worse than no accent.
9. **A field that exists here and in no Mochi export is `template_fields.local = 1`.**
10. **An explicit `読み` beats the head word as generator input, and renders as furigana.**
    Its name lives once, in `src/fields/yomi.ts`.
11. **Interval fuzz is ±5%, applied ONCE at grade time, keyed PER TRACK, AFTER the cap.**
    So the issued maximum is 383 days. Do not reorder it.
12. **New cards default to 10/day, and are a SETTING.**
13. **A forgotten card is SHOWN again at the end of the session, and NOT GRADED.**
14. **No one-off respread of the existing due dates.**
15. **New cards are 10 TRACKS a day, chosen at RANDOM; forward and reverse are not paired.**
16. **ONE final import from Mochi, then never again — and it HAS happened (2026-09-08).**
    `exports/` is disaster recovery only; `build/hashigo.db` plus each device's OPFS are the
    system of record. The guard (`0e04a10`) stops a re-import reverting local schedules.
17. **A local export/backup is required before he trusts the app** — built, with the
    non-dismissible "not persistent" banner and eviction detection.
18. **The TTS key NEVER goes in the client** — proxied through the Worker.
19. **Links render PLAINLY, in place, on whatever side they are authored on.**
20. **`型` renders on side 2 above `<<Speech>>`; `かな主流` on side 1 inside `<<#Reading>>`.**
    `型` is the ANSWER on a produce card.
21. **Fields are MOVABLE between templates, from the UI.**
22. **The 6 truly ambiguous words stay UNLABELLED** as words (`まく` is three accents);
    per-card adjudications settle them by the card's `意味`.
23. **The review screen's HAND: controls pinned to the bottom, the round replay button
    bottom-RIGHT (he reviews one-handed, right thumb), keycap hints only where a real
    pointer exists and never behind hover, one scroll.** The look was superseded (32, 57);
    the hand was not.
24. **Agents COMMIT their own work without asking — clean, scoped, gates green first —
    AND PUSH to `origin main`** (`https://github.com/wmCmo/hashigo`, PUBLIC, the `wmCmo`
    account, never `zach-ct`). Force-pushing and rewriting pushed history are not authorised.
25. **New cards carry a `New Card` label PER TRACK** (he said "per side", meaning per
    direction — in this repo "side" means a part of a card).
26. **`型` renders on SIDE 1 for `言葉` cards** — 言葉 has no side 2.
27. **NO PARTICLE beside the word — in the audio OR the display.** So on 平板 and 尾高 cards
    (2,148 of 3,830) `型` is the ONLY carrier of that distinction: never drop it from a
    layout. See `DECISIONS.md` 27 and his words on 花 / 鼻.
28. **`言葉` displays the way it was inputted; `かな主流` renders nowhere** (values stay
    stored). Do NOT turn this into "hide kanji on 言葉" — 14 of the 20 kanji 言葉 are normal
    phrases.
29. **THE AUTOPLAY RULE IS CONDITIONAL ON `Reading`** — see the hard-rule section below. Mode
    1 (`Reading = true`, 692 単語): audio on reveal only, `型` behind the reveal. Mode 2
    (false/absent, 3,177): audio on entry, `型` visible on entry — it is how he discovers an
    accent he had wrong and promotes the card. Tests pin BOTH arms; never weaken mode 1.
30. **A PREVIEW is not a review: all sides at once, no masks, no grading, nothing plays by
    itself.**
31. **PROCEED WITHOUT ASKING.** Ask only when the answer cannot be derived from his
    template, a measurement or a decision here. Still his: taste about the screen he lives
    in, and anything that changes what he is DRILLED on.
32. **The 2026-09-12 design brief replaced decision 23's look** (itself replaced by 57). The
    Japanese typeface is his choice; the replay button stays round because the hand wins.
33. **Sync is device-to-device through a MAILBOX; two merge rules are not last-write-wins.**
    Reviews UNION (append-only — no merge can lose a grade); `card_tracks` is LAST REVIEW
    wins (never recompute — fuzz is applied once); `archived`/`pinned` are LWW on
    `cards.updated_at` with every card's flags in the payload. `src/sync/`.
34. **A reveal is a WALK: one cloze at a time, then the next side**; a side sounds its clip
    when its last cloze goes. Reverse needs no code. `enter()` still plays nothing.
35. **Type size follows the CONTENT's length, not the position** — `sideScale()` measures
    code points: ≤28 display · ≤64 mid · above, body. Both directions, no special case.
36. **One play control per clip, beside the clip**; the bottom-right disc means "again"
    for the clip last sounded. `replay()` never unmasks.
37. **Furigana is filled through `src/render/ruby.ts`, and only behind a mask**
    (`GeneratorMount.inCloze`).
38. **A keycap hint takes the colour of what it sits in** (`color: inherit`).
39. **Every block element a card renders needs a `.hashigo-side` rule** — the CSS reset
    zeroes everything; a test reads the renderer's tag list.
40. **A desktop layout (`--rail-w` from 1024px) and the drill controls (loop, speed,
    record-and-compare).** No 0.5× (a vocoder smears the downstep); the recorded take never
    touches the audio path; card ops live behind `⋯`. A test classifies every
    `position: fixed` rule.
41. **The final import has happened, so `rm` + re-import is no longer a lossless reset.**
    Any schema change must answer for the live history first.
42. **`remembered` waits for the end of the walk; `forgot` does not.** Left is always
    `forgot`, right is always proceed (`next`, then `remembered`).
43. **The example sentence carries its own pitch accent per mora — the `<ojad>` element**,
    filled from a `local = 1` field found by ROLE. 平板 is `accent == morae`, not 0.
44. **`---` is his, and the question boundary follows it** — never fold an authored side.
45. **The seed fetch has its own screen with the climbing mark**; no "use the local copy"
    escape (the local copy is the stale thing).
46. **A late track says how late** (`QueuedTrack.overdueDays`, local dates); a track due
    today says nothing. Quiet, not a warning.
47. **An empty Ctrl+K suggests (pinned, opened here, recently edited — never archived); no
    search query is ever recorded.**
48. **The day's bar shows the misses in red** (a prefix, counted from `reviews`). `forgot`
    on a new card grades it, and should — it sets the first gap.
49. **Privacy was never his requirement** — decision 33's "no cloud" lost its reason.
    Friends using the app is a DIRECTION: don't take single-user shortcuts blind.
50. **The app pulls on the boot screen, before the first card**; offline or unanswered, it
    opens with the local database. The push stays off the boot path.
51. **Grades travel as a delta** (`src/sync/delta.ts`, small enough for `keepalive` on page
    hide); the full payload only after an edit. No timer, no polling.
52. **The gallery is read, not operated** — one `⋯` per tile, a gist line, archived hidden
    by default, and an address (`#deck/<id>`).
53. **`優先` cards are picked first from the new pool, still ten a day**; then 日本語 words
    with a kanji at the exam target's levels (`queue.exam-target`, default 準2級).
54. **A word waits for its kanji**: an unlearned 漢字 card's forward track takes the word's
    slot (`kanjiFirst`). One review frees the word.
55. **A card remembers where it was found — `出典`** (role `source`, fixed field id
    `source`): `[[source|id]]` plus a copy of the sentence. Shown as "found in" after the
    walk; the link gives the backlink for free.
56. **Cards made in the app get `読み`, `型` and OJAD from a helper on the laptop**
    (`tools/accent_helper.py`, laptop only, EMPTY fields only, the batch run's own rules).
57. **The Pinterest design system; the one colour is ruri (瑠璃).** Grey grounds, three inks,
    ruri only on the replay disc, the mark's top rung, focus, the progress bar and card
    links. Token names kept, values repointed. Decision 23's hand unchanged.
58. **A mode-2 単語 card has a writing canvas on side 2** (`<draw>` under `<< Speech >>`,
    inside `<< ^Reading >>`, 240px). Hear it, WRITE it, reveal. No 問題 track: a word
    stays one card, and its forward/reverse schedules are untouched.

## READ THE TEMPLATE. It answers most questions about the screen.

> [!warning] **He has told agents to read his template FOUR times.** Run
> `SELECT content FROM templates WHERE name = '単語'` before asking anything about layout.

`<<#Reading>>` renders when the boolean is TRUE, `<<^Reading>>` when it is FALSE. Both
states of 単語, rendered from the real corpus:

```plaintext
Reading = TRUE (慈善)                     Reading = FALSE/absent (係数)
  side 1  "慈善"           0 clozes 0 audio   side 1  ""              0 clozes 0 audio
  side 2  "[…]慈善 平板"    1 cloze  1 audio   side 2  "[…]係数[…]係数 中高(3)"  2 clozes 1 audio
  side 3  example sentence  0 clozes 1 audio   side 3  example sentence 0 clozes 1 audio
  side 4  meaning + links   1 cloze  0 audio   side 4  meaning + links  1 cloze  0 audio
```

**It is ONE screen, not two** — there is no second layout to design. On side 2 of a
`Reading = false` card only the accent label and the audio are visible; the meaning is on
side 4. Do not ask him whether the meaning is a hint; the template says it is not.

## Things he has already answered — DO NOT ASK AGAIN

1. **READ THE TEMPLATE** — asked four times.
2. **Audio regeneration happens AFTER the app is finished** — told to five agents. Do not
   propose, price or plan regenerating clips.
3. **Open-sourcing is discussed AFTER development** — told to three. `notes/open-sourcing.md`.
4. **He uses BOTH laptop and phone** — laptop for home reviews and ALL card creation, phone
   mostly for reviews. The desktop is a first-class surface; sync is what makes it usable.
5. **The import is WHOLESALE, and the final one has happened** — never a partial import, and
   no Mochi id ever arrives again. A new card id needs to be unique in THIS database only.

Due-queue figures in this repo are snapshots: due grows every day as dates pass. Quote them
"as of <date>", never as current.

## The hard rule: audio must never autoplay ON A `Reading = true` CARD

> [!warning] **AMENDED 2026-08-23 — decision 29. CONDITIONAL on `Reading`, no longer
> absolute.** It is a correctness requirement on the **692** `Reading = true` cards. On the
> other **3,177** (単語 with `Reading` false/absent, all 言葉) autoplay on entry is correct
> and wanted. Do not apply mode 1 to mode 2, and do not delete mode-1 tests to make mode 2
> pass.

The audio is for 高低アクセント SHADOWING. On a mode-1 card he looks at the kanji, recalls
each mora high or low, SAYS IT ALOUD, then reveals and listens to compare — autoplay would
give the contour away before he produced it. On a mode-2 card the word is masked and the
audio IS the prompt: *"if you show me 償却 i can read that word like instantly … but if you
hide it behind the cloze, and play しょうきゃく … it would force me to remember."*

**How it is built** (`src/render/reveal.ts`, `src/review/mode.ts`):

```plaintext
loop.enter(pos)      plays NOTHING, on any card, ever.
mounted.enter(pos)   plays the question when the card is `identify` AND the side masks
                     something — via side.prompt(), which does NOT unmask.
```

- Media elements are created with no `src`, no `autoplay`, `preload="none"`. Playback is
  reachable only from `reveal()`, `play()` and `prompt()`.
- `src/review/mode.ts` decides a card's mode; `reveal.ts` contains no reference to
  `Reading` (a test asserts it). 漢字's `Reading` is a PLAIN field holding a reading — the
  type check is load-bearing. `identify` is scoped to templates with an `accent` field
  (単語, 言葉); 敬語 and New Vocab show the word unmasked and must stay silent.
- `型`'s gating is in the TEMPLATE (`scripts/accent-field-apply.ts`), not in code, because a
  resolved field is plain text by render time. The outer `<<#型>>` guard is load-bearing.
- Pinned by tests with teeth: `play` inside `enter()` turns 15+ red. **If you change
  `reveal.ts` or `nodes.ts`, re-run that injection rather than trusting a green suite.**

## The four problems this exists to solve

1. Battery drain on phone → no polling, no sockets, precomputed renders
2. $60/yr → own API keys, real cost under $1/yr
3. Android sync crashes → own the sync layer
4. Attachment churn and manual re-syncing → content-addressed, refcounted blobs

## Repo layout and the exports

```plaintext
app/              the app (vanilla TS + Vite). app/README.md first.
src/              the library: db, import, render, scheduler, session, review, sync, accent …
cloud/app/        the Worker serving the live app; cloud/mailbox/ the sync + generation routes
tools/            Python: the accent analyser, the helper, mochi.py
design-system/    decision 57's system; site/ the landing page
exports/          Mochi exports (~657 MB of mp3), gitignored. Disaster recovery only.
```

**Never read `data.json` into context** (the largest is 21 MB) — go through
`tools/mochi.py`, whose docstring lists the export's traps. Regression check:

```bash
python tools/mochi.py exports/日本語 exports/English exports/基本情報
# cards 7,716 | reviews 103,110 | retention 96.24% | wiki-links 8,690 | tags after normalisation: 19
```

## Environment

- **Windows; his shell is PowerShell 5.1.** `VAR=value cmd` and `&&` are parser errors in
  anything handed to him — use `$env:VAR="value"; cmd` and `;`. The console is cp932, so
  every script that prints Japanese sets its own UTF-8 encoding.
- Python is `python` (3.13); `python3` hits the Microsoft Store alias. The accent analyser's
  venv is `.venv-accent`.
- The Bash tool's working directory does not reliably persist — use absolute paths.
- Other sessions may work in this same checkout at the same time; check
  `git branch --show-current` and `git status` before committing.

## Conventions

- Deck, template and field names are identifiers: `単語`, `漢字`, `例文`, `意味` are never
  translated or romanised.
- Language codes are BCP-47 (`ja-JP`), never Mochi's `jp`.
- Prefer measuring over assuming. 103,110 graded reviews and 56,810 component-cache entries
  double as labelled test sets.

## TTS: settled by measurement, 2026-08-20

**Google, `ja-JP-Neural2-C` (male)** — his pick by ear, agreeing with an F0 measurement.
- Google honours `<phoneme alphabet="yomigana">` on Neural2 (`^` opens a phrase, `!` the
  downstep). **It silently ignores the notation when the element contains kanji** — every
  request must carry the READING as element content.
- Azure does not honour its notation on current neural voices; `Chirp3-HD` changes but
  matches the wrong contours. Voice choice is a correctness decision.
- Annotate the **isolated word** only, never the example sentence.
- **No particle in the audio.** The derivation's probe particle is internal: OpenJTalk
  returns the mora count, not 0, for 平板, so the naive `if accent > 0` rule would drill
  2,065 phantom 尾高.
