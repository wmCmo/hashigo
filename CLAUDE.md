# Hashigo (梯子)

A local-first spaced-repetition app replacing [Mochi](https://mochi.cards) for one
user's Japanese study. Built because Mochi's developer stopped fixing reported bugs.

## Where this is — and where the numbers live

**Everything from "what is due" to a live, audible card exists in `src/`. What does not
exist is the SHELL** — the page that hosts it, a writable database in the browser, and
the audio on the device. `play()` IS called: `src/review` mounts a card and drives
`shadowingLoop`, and `test/review.test.ts` measures it over real cards.

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
* **`型` renders BARE from the template, and the screen must gate it.** It is not inside
  a cloze, so rendering side 2 through `src/render` puts the accent on screen the moment
  the side appears — and decision 20's stated reason for keeping it off side 1 is that it
  "would hand him the thing he is meant to produce", which side-2-*entry* does too.
  **This is NOT an open decision: A2 already answers it.** In
  `build/mock/out/a2-terminal.html` the label sits inside `<div class="answer">`
  (`display:none` until `[data-state="revealed"]`), beside `.reading` and the `.contour`
  boxes, with only `.head` visible at prompt time. The mockup is hand-authored HTML that
  never went through the template engine, so the MOCKUP and the TEMPLATE disagree and the
  real screen has to reconcile them: **gate the accent field into the answer region, or
  wrap `<<型>>` in a cloze so the body says what A2 shows.** Implementation, not taste.
  (Side placement for `言葉` is settled — decision 26.)
* **The UI half of decision 17's backup.** The MECHANISM landed 2026-08-23
  (`src/backup`, 332,262 bytes over the real corpus) but nothing calls it from a
  screen: the persistent banner when `persisted()` is false, the "add to home
  screen" prompt beside it, and detecting an eviction that already happened all
  belong to the app shell.

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
npm test                # 23 files, 734 passed, 1 skipped (the FSRS refit, gated)
                        # 32.7-87.7 s over six runs.
                        # IT EXITS 1 ON A FULLY PASSING RUN. The "Timeout calling
                        # onTaskUpdate" lines are Vitest's reporter RPC under load,
                        # they count as `Errors`, and they set the exit code with
                        # `734 passed` printed directly above. So read the pass
                        # count -- not because the error line is noise, but because
                        # $LASTEXITCODE is WRONG. Anything chaining on this gate
                        # (CI, a hook, a `;`-joined line) reports a break that is
                        # not there. Measured on a clean tree with zero edits.
npm run typecheck       # exit 0
npm run build           # refuses to exit 0 unless dist/ actually imports (27 export subpaths)
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run dashboard -- --db build/hashigo.db --out dashboard.html   # English; --locale ja for the other
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths   # exits 1 on any location
npm run spike:check     # the browser contract; spike/ is excluded from tsconfig.json

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
npx vite-node scripts/accent-field-apply.ts -- --db build/hashigo.db --apply  # the 型 field + bodies
npx vite-node src/accent/cli.ts -- write --db build/hashigo.db            # 3,830 型 labels
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

## Three things he has already answered — DO NOT ASK AGAIN

He has repeated each of these to a different agent, and the count is his:

1. **READ THE TEMPLATE** (above) — asked four times.
2. **Audio regeneration happens AFTER the app is finished** — told to five agents.
   *"i will regenerate my audio after we finished the app, because i have to re import
   anyway because everyday when i make this app i still review mochi."* So do not propose
   regenerating clips, do not price it, do not treat `other-voice` clips or the missing
   ones as a task. **AND THE CONSEQUENCE AGENTS KEEP MISSING:** he is still reviewing in
   Mochi daily, so the review history in `build/hashigo.db` is FROZEN — the newest review
   is **2026-08-18**. Every due-queue figure in this repo (443 due, the 10 new, the
   forecast) is a snapshot of a stale history and **will change at the final import**
   (decision 16). Quote those numbers as "as of the 2026-08-18 export", never as current.
3. **Open-sourcing gets discussed AFTER development** — told to three agents. Not now.
   `notes/open-sourcing.md` holds what was already checked; leave it there.

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
trade-off, and the reason the tests must get STRICTER rather than looser. `src/render/reveal.ts`'s `enter()` therefore does nothing
but record that a side is on screen, playback is reachable from exactly two calls
(`reveal()` and `play()`), and media elements are created with no `src`, no
`autoplay`, no `loop` and `preload="none"`.

It is pinned by tests with demonstrated teeth, re-measured by a peer review 2026-08-23:
putting `audio.play(media, "reveal")` inside `enter()` turns **10** tests red — 8 in
`test/reveal.test.ts` and 2 in `test/review.test.ts`, including the 7,716-card sweep.
Adding an `autoplay` attribute in `src/render/nodes.ts` turns 8 red across three files.
If you change either file, re-run that experiment rather than trusting a green suite.

**AND THIS IS THE TRAP DECISION 29 CREATES.** Implementing mode 2 means making `enter()`
play on some cards, which turns those tests red *for the right reason*. The wrong fix is
to relax them to "audio may play on entry"; the right one is to make each assertion name
its mode, so mode 1 stays as hard as it is today. `src/render/reveal.ts` has no knowledge
of `Reading` — the condition belongs above it, in the mount or the screen, so that
`enter()` can keep doing nothing and the caller decides whether to play.

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
