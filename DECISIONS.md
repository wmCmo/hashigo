# DECISIONS — why the app is the way it is

**This file is the WHY. `CLAUDE.md`'s numbered index is the WHAT, and it is the only
place a decision counts as recorded.** For each decision this keeps the rule, Zach's
words, the reason, and the measurement that settled it.

> [!IMPORTANT]
> **Consolidated 2026-11-11.** The previous text — every derivation, "found on the way"
> story, measurement log and long table — is kept word for word in
> [notes/archive/DECISIONS-before-consolidation-2026-11-11.md](notes/archive/DECISIONS-before-consolidation-2026-11-11.md),
> under the same numbers. If a comment cites "DECISIONS.md N" for a detail that is not
> here, it is there. Nothing was deleted from the record; superseded decisions keep
> their number here as a pointer to the one that replaced them.

**The rules for this file:**

* **Write the line into `CLAUDE.md` first**, then the reasoning here. Never here only:
  four decisions once lived only in his Obsidian planner, and one of them (`型`
  placement, decision 20) was reopened by an audit weeks after he had settled it.
* **Never renumber, only append.** Numbers are cited across `src/`, `test/` and the
  notes; `test/docs-integrity.test.ts` checks the shape and `test/docs-figures.test.ts`
  the citations.
* **Never run a Markdown formatter over this file** — it renumbered the list once and
  every gate passed.
* **Where this file and `notes/zach-in-his-own-words.md` disagree, that file is right.**
* **He changes his mind, and that is how the app improves** (2026-11-05: *"sometimes i
  change my mind about designs lol, otherwise our app wouldn't improve"*). When he does,
  amend the decision that stands and leave a pointer at the old one.
* **Keep his quotes.** They are the reason behind most of what is here.

---

## Decisions — the current design, and why

1. **FSRS-6**, max interval **365 days**, target retention **0.90**.
   Zach reopened the 365 on 2026-08-22 — *"365 days was a default number from mochi
   flashcards … but I didn't derive it"* — and it is now derived. A cap exists because
   the fit's opinion about long intervals is manufactured by the scheduler that trained
   it: observed retention RISES through the tail (94.35% → 96.40% → 98.16%), which memory
   does not do. A cap bounds how far that bias runs; it is not a claim about how long a
   memory lasts. **365 specifically, because the PLANNED support ends exactly there.**
   Priced: 365 costs **+33.3% more reviews a year** than no cap (17,314 vs 12,986), and
   365 → 454 would buy back 3.5/day for 89 days of extrapolation. He kept 365.
   0.90, not 0.95: 0.95 asks for 1.9-3.0x his sustained daily load, 0.90 reproduces it.
   Since decision 11 the 365 is the **centre of a ±5% band, not a ceiling** (issued
   maximum 383 days). `src/scheduler/policy.ts` holds the values; `BACKTEST.md` and
   `notes/max-interval-and-relearning.md` the measurements.
2. **Binary grades only** — remembered / forgot. Anki's four-button scale was
   considered and rejected, so there is no `grade` column and FSRS `w[15]`/`w[16]`
   are frozen, not fitted.
3. The six empty leaf decks **are dropped** by default: 45 decks become 39.
4. Blobs are **content-addressed**. No absolute path is ever stored in the
   database — the blob CLI's `paths` command is the acceptance check.
5. Stale pre-template `content` (3,159 cards, 79,175 chars) is **discarded** on
   import and **reported** so it stays recoverable from the export.
6. **Name the interval basis, or the number is not a fact.** Both intervals are tracked
   and named: `reviews.elapsed_days` (measured) and `reviews.scheduled_days` (planned).
   Anything plotted against an interval says which it used, and the rule generalises to
   every figure (29 AUTHORED math fragments vs 28 RESOLVED; 4,933 furigana skeleton runs
   vs 4,943 `<rt>` elements).
   **Second half (2026-08-23): check the basis is the one the sentence NEEDS.** A figure
   cited as SUPPORT for a claim must be the reading that supports it — 235 orphan rows
   were cited as evidence that moving a field orphans values, but 92 sit on cards with no
   template at all; only 132 could evidence a move.
   **Agreement is evidence only between methods that fail DIFFERENTLY.** 235 matching the
   importer's `orphanFieldValues` proved nothing (both counted the same way); 132 arriving
   by an `EXISTS`, a duplicating bare `JOIN` and a strict filter is a differential check.
   Limit: not every disagreement is a basis split — "8 templates" against 6 was a plain
   miscount.
7. **The generator's input is the RENDERED text, never the stored value.** It cost real
   work twice in one session: the audio cache key missed all 471 基本情報 cards (value
   `{{データ}}`, key `データ`), and the accent analyser mis-read 準備 as ジュン+ソナエ
   because U+200E sits inside the compound (3,016 such marks on 2,504 cards).
   `generationInput` and `accentKey` are both thin wrappers over `renderPlainText`.
8. **A cross-check analyser is stored but never RESOLVES.** UniDic agrees with the
   primary derivation on 97.31% of 3,007 comparable words, and is measurably wrong on
   some it could otherwise rescue — it reads 正義 as the personal name マサヨシ. A wrong
   accent drilled through spaced repetition is worse than no accent, so it is a
   candidate for adjudication, never the answer. See `accent_disagreements`.
9. **A field that exists HERE and not in any Mochi export is marked
   `template_fields.local = 1`.** `pruneFieldValues` cannot otherwise tell a field Mochi
   DELETED from one Mochi NEVER HAD, and it threw away all 3,454 materialised `型` labels
   the first time it met one. Measured end to end 2026-08-22: local field rows and their
   values survive a re-import; **an EDIT to a field Mochi owns does not** (12 of 12 head
   words reverted). `local = 1` protects a field we ADDED, not an edit to Mochi's —
   decision 16 made that finite. `scripts/reading-apply.ts` is idempotent for that reason.
10. **An explicit `読み` beats the head word as generator input, and renders as
   furigana.** Zach's `器（うつわ）` parentheses were a Mochi TTS workaround — Mochi read
   器 as キ, 革 as カク. `読み` (`local = 1`) is the input for BOTH speech and accent
   derivation, and renders as furigana because the furigana generator would otherwise
   mis-read the same kanji (his reason). The 13 parenthesis cards classify by script
   position — kanji-outside + kana-inside is a reading, kana-outside + kanji-inside is
   kana-primary, Latin inside is a gloss — with **one ratified exception**: `（おす）雄`
   is kana-primary like its twin `めす（雌）` (Zach, 2026-08-22). Final split 6 読み /
   6 かな主流 / 1 意味; the override lives in `scripts/reading-parse.ts`.
   `notes/kana-primary-words.md`. The field's name lives once, in `src/fields/yomi.ts`.
11. **Interval fuzz is ±5%, applied ONCE at grade time, keyed PER TRACK, AFTER the
   cap.** `INTERVAL_FUZZ` in `src/scheduler/policy.ts`, applied in `gradeMemory`, keyed on
   the track id. It matters because **42.9% of scheduled tracks (3,650 of 8,518) sat at
   exactly 365 days**, so a heavy day becomes a spike a year later. Measured by
   `scripts/fuzz-load.ts`:

   ```plaintext
   keying / form                    worst day    CV
   none                                   188   2.48
   per TRACK, two-sided ±5%, after cap     71   1.94   issued max 383d   <- CHOSEN
   per COHORT, by due date                295   2.84   WORSE than none
   downward-only, 10% width                73   1.91   issued max 365d
   Math.min(fuzzed, 365)                  113          1,892 of 3,650 back on one day
   ```

   The width is derived: the smallest whose worst day fits his sustained load is 4-6%
   depending on basis; ±4% gives 78, ±5% 71, ±6% 73. **After the cap is forced**: 99.2%
   of over-cap tracks want more than 384 days, so fuzz-before-cap clamps straight back
   onto 365 and is inert. **Ratified 2026-08-22: two-sided, after the cap, issued max
   383** — Zach chose it knowing downward-only-10% gave the same spread with 365 as an
   absolute ceiling. Accepted tension: 383 is 18 days past the planned support. (The
   older "383 < 454 observed" argument is withdrawn — 454 is an ELAPSED edge; decision 6.)
   Do not compute it when READING the queue (the due date would jitter), do not key it
   per cohort, and do not reorder it with the cap.
12. **New cards default to 10/day, and are a SETTING.** Mochi's default, and Zach wants
   the same. It is the dial that decides how fast the backlog moves. `newTracks` is
   returned separately from `dueTracks` so the session layer owns it.
13. **A forgotten card is SHOWN again at the end of the session, and NOT GRADED.**
   Decided 2026-08-22. Mochi does not do same-day relearning (98.5% of its 6,996 same-day
   reviews follow a PASS — new-card learning steps), and **0 of 103** same-day-after-
   failure reviews were ever remembered, so the corpus has no evidence either way.
   Grading a same-day re-ask would move the next interval by a flat **3.50× on a pass,
   0.173× on a second failure**, a multiplier calibrated on zero post-lapse observations.
   So: show it, do not grade it — the schedule stays put and it CREATES the data that
   could later justify grading. A session-local list; no review rows.
   `notes/max-interval-and-relearning.md` §2, `scripts/relearn-cost.ts`. Either button
   on a re-ask means "seen" — including one reached AHEAD with the arrows, which is
   dismissed rather than refused (2026-11-11: *"i can't click remember"*;
   `ReviewSession.answerAt`).
14. **No one-off respread of the existing due dates.** 3,650 tracks share an INTERVAL,
   not a due date: the heaviest future day was **188**, and he had already done more than
   188 on six separate days (peak **229**). Fuzz brings future plans down anyway. Zach:
   *"are we saying that, on some day, i have to review 3650 in a single day? if not then
   we don't have to touch it, no reason to."*
15. **New cards are 10 TRACKS a day, chosen at RANDOM; forward and reverse are not
   paired.** Zach: *"10 new tracks … 1 forward and 1 reverse counts as 2 tracks … both
   forward and reverse doesn't have to be studied on the same day because it's random
   from the cards i haven't learned."* The order lives in `newTracks`, keyed by
   `dailyOrderKey(localDay, trackId)` (a hash, never `Math.random()`, so re-reading the
   queue mid-session does not reshuffle), and the limit is applied AFTER it — a `LIMIT`
   on a sorted query has already chosen the sample, which is how the old code served the
   same ten tracks every day.
16. **ONE final import from Mochi, then never again — and it HAS happened (2026-09-08).**
   Zach: *"after our app is finish … ill do one last import, and that's it, there should
   be no import, unless the app breaks something and we have to re import."* The escape
   hatch is guarded: `LOCALLY_GRADED` in `src/import/reviews.ts` (commit `0e04a10`) stops a
   re-import reverting a locally graded track's schedule to Mochi's while its review rows
   survive — the log and the track would silently disagree. It PRESERVES rather than
   refuses, and reports `tracksPreserved`. The implementation reasons are in that file's
   docstring and live only there. Consequences after the import: decision 41.
17. **A local export/backup is required before he trusts the app** — and decision 16 is
   why. Zach: *"local backup? i thought everything is already on the local…? and why do
   we need to backup on day 1??"* OPFS is browser-owned storage (clearing site data or
   eviction takes it), and after the final import it is the only copy of his history.
   Built: `src/backup` archives only what `exports/` cannot rebuild — local reviews, track
   state, decision 9's local fields, settings (332,262 bytes against a 74 MB file) — as
   ROWS, because a binary copy only restores into its own schema version. Keyed on
   `(card_id, kind)`, never `track_id`. The screen half is built too: the non-dismissible
   "not persistent" banner and eviction detection. `src/backup/README.md`.
18. **The TTS key NEVER goes in the client.** Zach: *"we have to find a way that will not
   leak my key."* The provider call is proxied through the Cloudflare Worker; the PWA
   holds no credential, because anything the page can read a reader can read. Scripts
   under `tools/` that need `.env` load it by name and print nothing from it.
19. **Links render PLAINLY, in place, on whatever side they are authored on.** Drafts 1-7
   called the Jisho URL on 漢字's side 4 an answer leak; Zach overruled that on
   2026-08-20 — there is no hover on a phone, a long-press is deliberate, and he never
   checks a URL before answering. No direction-dependent deferral, no defanged `href`.
20. **`型` renders on side 2, immediately above `<<Speech>>`. `かな主流` renders on side 1,
   inside the `<<#Reading>>` gate.** From the 単語 template Zach pasted 2026-08-21. `型` is
   the ANSWER — the accent he is trying to recall — so side 1 would hand it to him;
   `かな主流` is not an answer. (This lived only in his Obsidian planner, and an audit
   reopened it as an "open question" — why this index is the only record.) For 言葉 see
   26; for mode 2, 29.
21. **Fields are MOVABLE between templates, from the UI.** Add, delete and move.
   `template_fields.local = 1` (decision 9) makes a moved or added field survive; the
   editor is the template editor (see 61 for field kinds).
22. **The 6 truly ambiguous words stay UNLABELLED** as words: `まく` has three accents
   across 巻く / 撒く / 幕, so no single label is correct for the string. The derivation
   cannot see meaning, so they are settled per card by its `意味` (the adjudications
   `npx vite-node src/accent/cli.ts -- ojad` applies). `OJAD_AMBIGUOUS` in
   `src/accent/ojad.ts` holds the words, deliberately without labels. Same principle as
   decision 8.
23. **The review screen's HAND: controls pinned to the bottom, the round replay button
   bottom-RIGHT, keycap hints only where a real pointer exists and never behind hover,
   one scroll.** Settled 2026-08-22 from three mockups. **Its LOOK (direction A2: dark,
   monospace, terminal — chosen as *"the closest to what im aiming at, it looks fun, it
   looks new (as in novel), it looks like we've put thoughts into it"*) was superseded
   by 32 and then 57; the hand was not.**
   * **Replay is a round button, bottom RIGHT** — *"im using my right hand, and my thumb
     would have to reach all the way."* A native `<audio controls>` puts play at the far
     LEFT; a centred button is a compromise for either hand. 66×66, 16px from the right
     edge.
   * **The action bar is pinned to the bottom edge.** Unpinned, the grade buttons landed
     at y=894 on an 812px viewport: a scroll before every grade.
   * **Keycap hints render only under `@media (hover: hover) and (pointer: fine)`, NOT
     behind a tooltip.** There is no hover on a phone and a long-press opens the context
     menu (decision 19), so a tooltip would hide the hints on the device he reviews on.
   * **`remembered` is on the RIGHT**: ~96 of every 100 taps are that button (retention
     96.24%), so it belongs under the thumb that is already there. See 42.
24. **Agents COMMIT their own work without asking — clean, scoped, gates green first —
   AND PUSH to `origin main`.** Zach, 2026-08-22:

   > you don't have to wait for my instructions to commit, you know when to commit, make
   > it clean and deliberate, no permission needed, commit is always revertible, and it's
   > your job now
   >
   > this should be instruction for any agent from now on

   "Clean and deliberate": one coherent change per commit; `npm run gates` green BEFORE
   the commit; messages in this repo's voice (lowercase `type(scope):`, what changed and
   why it was not obvious). **Pushing authorised 2026-09-28**: the remote is
   `https://github.com/wmCmo/hashigo` on the `wmCmo` account (*"use wmcmo gh account, not
   zach-ct"*), and *"yeah push as you go"* — tags too. `.env`, `build/`, `exports/` and
   the databases never go up. **Still NOT authorised:** force-pushing, rewriting pushed
   history, pushing as `zach-ct`, amending a commit not from the current run, and
   `git reset --hard` over uncommitted work.
25. **New cards carry a `New Card` label, PER TRACK — not per card.** Zach, 2026-08-23:
   *"on mochi flashcard, if the card is new, you get the label `New Card`, and the label is
   per side, so for forward and reverse, they could have its own `New Card` tag and it
   doesn't have to match."* **Terminology trap:** he said "per side" and meant per
   DIRECTION; in this repo a "side" is a part of a card and forward/reverse are tracks.
   The label renders `SessionItem.origin === "new"` — no new state.
26. **`型` renders on SIDE 1 for `言葉` cards.** Decided 2026-08-23. `言葉` has no side 2:
   its body is `{{<<言葉>>}}` / `___` / `<<型>>` / `<<Speech>>` / `---` / …, and `___` is a
   rule WITHIN a side while `---` is the side break (`src/template/parse.ts`). Zach
   confirmed. Decision 20 is unchanged for `単語` — placement is template-specific.
27. **NO PARTICLE beside the word — in the audio OR the display.** Zach, 2026-08-23:
   *"don't add particle to my word, the word stays the word."* The card's unit is the WORD,
   and choosing a particle to show privileges one. **So `型` is the only carrier on 2,148
   of 3,830 labelled cards and must never be dropped from a layout:** 平板 and 尾高 are
   identical inside the word (花が L-H-H against 鼻が L-H-L — the downstep lives on the
   following mora).

   ```plaintext
   頭高    775    audible bare, and the contour boxes show it
   中高    907    audible bare, and the contour boxes show it
   平板  2,092  ┐ indistinguishable in BOTH channels
   尾高     56  ┘ -> 2,148 cards where `型` is the ONLY carrier
   ```

   **What the accent pipeline is FOR, in his words:**

   > *"the true reason we need it is just because i didn't know 花 and 鼻 would be
   > pronounced differently when the particle is attached to them, that's the whole
   > point ... by sound i can distinguish 配慮 from 勉強, that's easy, but without
   > particle for those two kanji word, there's no way to tell, yet natives pronounce
   > them perfectly, because the 型 rule is encoded into their brain, that's what im
   > trying to train myself for."*
28. **`言葉` displays the way it was inputted, so `かな主流` renders nowhere.** Zach,
   2026-08-23: *"for 言葉 deck, it should display the way it's inputted."* The six
   flagged cards are all `言葉`, while the `<<#Reading>>` marker is on `単語`. Of 391 `言葉`
   head words 20 contain kanji — he had first said everything there is kana, then, shown
   them: *"which was wrong now that you showed me those cards i remember now"*. **6 single
   words whose kanji nobody writes** (蟻 雄 搔く
   茄子 灰汁 雌 — the かな主流 six) and **14 phrases where the kanji is the correct
   spelling** (目をつける, 気が付く, 一から十まで …). **"Hide the kanji on `言葉`" was an
   agent's suggestion and he rejected it:** *"i never said on 言葉 deck you should hide
   kanji?"* — it breaks all 14 phrase cards. The values stay stored and render nothing.
29. **The hard rule is CONDITIONAL on `Reading`, and `型`'s gating with it.** Decided
   2026-08-23, amending what had been an absolute rule ("audio fires on the cloze reveal,
   never when a side appears"). It was right about the exercise it described and wrong
   that every card runs that exercise. `boolean-default` is `false`, so absent means mode 2:

   ```plaintext
   Reading = true    692 単語    produce reading+accent   audio ON REVEAL   型 gated
   Reading ≠ true  3,177 cards   hear it, name the word   audio ON ENTRY    型 visible
                   (2,785 単語 + 392 言葉; 1,882 of those have Reading ABSENT)
   ```

   **Mode 2 is a different exercise, not a laxer one, and the cloze is load-bearing:**

   > if you show me 償却 i can read that word like instantly, because i can remember the
   > radical rules, but if you hide it behind the cloze, and play しょうきゃく, i would be
   > like... what しょう... and what きゃく、、、 and it would force me to remember

   *"my listening skill is far worse than my reading skill … that's why most of the cards
   are like that."* **`Reading` is a STATE, not a property** — mode 2 is how he finds an
   accent he had wrong:

   > i would see that it's 尾高, and i'll be like, damn, i didn't know this, ive been
   > pronounced it has 平板 all along, and then i'll just go ahead and edit the card to
   > `Reading` -> true

   So `型` MUST render on entry in mode 2, and the review screen must be able to flip
   `Reading` on the current card. What mode 2 gives up is accent recall on its 772 中高/尾高
   cards. His other leg — *"which btw, comes in the example sentence part anyway"* — is
   stronger than he stated: 97.6% of mode-2 cards carry an example-sentence clip, and ~54% of sampled
   平板/尾高 ones have a particle right after the word, so the sentence can carry the
   downstep the isolated word cannot.
   **Build it in the caller, never in `enter()`:** `src/render/reveal.ts` knows nothing
   about `Reading`; the mount decides whether to play, so every test names its mode and
   mode 1 stays exactly as hard. CLAUDE.md's hard-rule section has the mechanism.
30. **A PREVIEW is not a review: all sides at once, no masks, no grading, nothing plays
   by itself.** Zach, 2026-08-23:

   > showing a preview card is not the same as put the card into a review mode, when you
   > enter a review mode, everything goes as it is now, showing a previewed card lets you
   > view every sides at once

   Decision 29's audio is a property of the EXERCISE, not the card, so a card not being
   exercised has no reason to sound; a clip stays one tap away. This also ratified the
   review screen's progressive sides (showing every side at once leaks the answer: 単語's
   side 3 is the unclozed example sentence). `e` edits from both modes: *"whether the card
   is in the review mode or the pop up mode, you can press `e` for edit"*.
31. **PROCEED WITHOUT ASKING.** Zach, 2026-08-23:

   > why do you have to wait for my goal every time, waiting for my go and asking me
   > wastes more token than proceeding on your own

   Extends decision 24 from committing to deciding. The line:

   ```plaintext
   ACT      anything derivable from his TEMPLATE, from a MEASUREMENT, or from a
            decision already in this file. Implementation, structure, naming, tests,
            fixes to defects, and how a settled decision gets built.
   ASK      taste about the screen he lives in, and anything that changes WHAT HE IS
            DRILLED ON — because that is his study, not the app's behaviour.
   ```

   An agent that asks has not reduced the risk of being wrong; it has moved the work of
   being right onto him, and charged him for the move.
32. **SUPERSEDED BY 57 for the look.** The 2026-09-12 design brief replaced decision 23's
   dark terminal direction (Zach: *"we are doing the design revolution, it turned out i
   didn't like what we have now"* — it lacked identity, *"it feels like the person
   couldn't decide the design and ended up with whatever is 'okay'"*); 57 then replaced
   the brief's palette and type. **What still stands from 32:**
   * **The replay button stays round, because the hand wins** over any "square
     everything" rule (23).
   * **The Japanese typeface is his choice** (taste about the screen he lives in, 31) —
     now Noto Sans JP, by 57.
   * **Every grey in this app carries a Japanese reading at some point**, so contrast is
     part of a decision, not polish; a large-text-only colour never sets small text.
   * **The app icon is the ink mark on the `--card` ground, not `--paper`.** Paper reads
     as paper only beside a brighter card; a lone tile on a wallpaper reads grey (0.82
     luminance against 0.96). `tools/icons.mjs` keeps the alternatives behind flags and
     `test/pwa.test.ts` pins the shipped ground.
33. **Sync is device-to-device through a MAILBOX; two merge rules are not
   last-write-wins.** Zach delegated the design (*"任せます lol"*, 2026-09-12). The
   mailbox stores one payload per device and has no opinion about any of them — each
   device's database lives in its own browser's OPFS, so the server is never a peer and
   two devices never need to be up together. **The transport is the Cloudflare Worker**
   (`cloud/app` serves the mailbox); the original "tailnet, no cloud" choice lost its
   reason in 49. Merge rules (`src/sync/merge.ts`):

   ```plaintext
   reviews            UNION, deduped on (track, reviewed_at, source). Append-only,
                      so no merge can ever lose a grade.
   card_tracks state  LAST REVIEW WINS, not last write: the schedule is a function of
                      the last grade, and flat LWW can pick the device that WROTE last
                      rather than GRADED last. Never RECOMPUTE from the merged log —
                      fuzz is applied once (11), and a replay re-fuzzes.
   archived / pinned  LWW on `cards.updated_at`, with EVERY card's flags in the
                      payload (an unarchive is invisible as an absence) and
                      `decks.archived` too (a deck op archives a deck AND its cards).
   everything else    Upsert.
   ```

   Built on decision 17's archive (rows keyed on `(card_id, kind)`, idempotent apply)
   rather than beside it. **One bad peer must not stop the sync**: each peer merges on
   its own and a failure is reported, not thrown. **The sync indicator is part of the
   feature** — Zach: *"on desktop it's still not archived, can we add icon or any visual
   to show the sync status"*; "never synced" has its own look and the dot differs by
   SHAPE as well as hue. **Known gap:** `card_field_values` has no clock, so two devices
   editing different fields of one card before a sync is a card-level conflict. What
   travels when: grades as a delta (51), edits as a delta (64), the pull on the boot
   screen (50).
34. **A REVEAL IS A WALK: one cloze at a time, then the next side.** Zach, 2026-09-12:
   *"when you click reveal, it shows the whole thing, the next slide, and the third
   slide, and every cloze. the correct order should be, each cloze in that slide, once
   every clozes are shown, the next side and so on. for the reverse, the cloze are still
   in the same ascending order, just the side reverse."* It reversed an agent's
   "together, per side" rule that was never his.
   * **Per side still bounds it**: a step never crosses into the next side.
   * **A hidden side's arrival and its FIRST cloze are one step**; every further cloze is
     its own step.
   * **A side sounds its clip when its LAST cloze goes**, so the walk plays no earlier
     than the one-shot reveal did; `enter()` still plays nothing (29).
   * **Reverse needs no code**: sides arrive permuted, clozes stay in document order
     (40/40 real reverse cards, every side ascending).
   * A step is a thing on screen, never graded or stored. When grading may happen is
     decision 42.
   * The round replay button follows the walk (36). The example-sentence clip had been
     unplayable on every card (*"i still can't hear audio of example sentence"*, reported
     three times) — the seed took each card's cheapest clip first, and the
     audio file had no freshness check of its own. Since 2026-09-12 the seed carries all
     audio (`--speech-bytes 650000000`, 5,710 of 5,710 cards) and `audioIsStale()` in
     `app/seed-freshness.ts` re-fetches the audio when the server's is newer.
35. **Type size follows the CONTENT's length, not the position.** Zach, 2026-09-12, on a
   reverse 単語 track: *"this ui is kinda funny, i think it's correct that the 漢字 has the big text because it's
   short, but when it's reverse, why is 漢字 small and the definition big...? this is
   super ugly lol"*. His *"because it's short"* is the rule: `sideScale()` in
   `app/review-boundary.ts` measures CODE POINTS on EVERY side in both directions —
   **≤28 display · ≤64 mid · above, body.** 28 is measured: every forward vocabulary
   prompt fits in 26 and 90% of reverse prompts start at 28. 基本情報's FORWARD prompts
   run to 170 characters, so a rule keyed on `direction === "reverse"` would have left
   them at display size. `mid` stops a 40-character definition dropping from display
   straight to body beside a head word.
36. **One play control per clip, beside the clip; the bottom-right disc means "again"
   for the clip last sounded.** Zach, 2026-09-12: *"we only have 1 play button, what if i
   have two audio like this and i wanna replay the first one or the second one... what's
   the best ui?"* — and *"a single play button where we couldn't distinguish which audio
   to play shouldn't work right?"* The clip sits on the side that owns it, so the line is the label; no
   picker. The round button (23) stays. Not the native `<audio controls>`: inert without
   a `src`, full-width with play at the far LEFT, and it cannot show state. The 34px
   clip button is under the 44px target on purpose — it sits inside running text.
   **`replay()` never unmasks** (`play(mount, { unmask: false })`): before the fix one
   replay on a mode-2 card revealed the clozes while the screen still read `prompt` —
   the hard rule's defect arriving through the one control allowed past it.
37. **Furigana is filled through `src/render/ruby.ts`, and only behind a mask**
   (`GeneratorMount.inCloze`). Zach, 2026-09-12: *"why is the text coming out like that
   😭"* (an em dash over every head word: unfilled `<rt>`s). Of 6,754 furigana mounts, 42
   sit outside a cloze, all on `produce` cards, where filling would print the answer —
   so the guard is structural and on furigana ALONE (the example sentence is an `ai`
   generator with no cloze, and must still fill). A furigana generation holds the input
   with Mochi's bracket annotation (`野菜(やさい)`); `readingOf()` unwraps it. Rendering
   goes through `furiganaSupport` — one `<rt>` per base run — because 31.9% of bases mix
   kanji and kana. The "no reading" dash skips `pending` and `segmented` rubies.
38. **A keycap hint takes the colour of what it sits in** (`color: inherit`), de-emphasised
   by `opacity: 0.85` — a measured floor (4.88:1 on the worst filled ground; 0.8 gives
   4.43:1). Zach, 2026-09-12: *"`space` is a little hard to read don't you think? is there
   any other place that suffers like this?"* A fixed grey hit 1.05:1 on a filled button in
   dark. Both `.kbd` and `.kbd-inline` sit behind `(hover: hover) and (pointer: fine)`.
   `test/contrast.test.ts` pins filled-ground pairings and two structural rules: `.kbd`
   may name no colour token, and the hairline token may not be a background except for
   three named exceptions.
39. **Every block element a card renders needs a `.hashigo-side` rule.** Zach,
   2026-09-12: *"the definition padding is still weird"*. The reset (`* { margin: 0;
   padding: 0 }`) is deliberate, so lists (1,424 field values, most 意味 sides) need
   `padding-left: 1.4em` (in `em`, to follow decision 35) and tables need cell padding.
   `test/contrast.test.ts` reads every tag in a `context.element(...)` call in
   `src/render/nodes.ts` and requires a rule for each, with a reasoned exemption table.
40. **A desktop layout (`--rail-w` from 1024px) and the drill controls (loop, speed,
   record-and-compare).** From a mockup Zach handed over 2026-09-12: *"i think this mock
   up has a very good design, should we incorporate everything into our design? or do you
   think there are things we could improve?"*, then *"what about the rest of the
   aestheticness of the design that we don't have yet? i know you can't 'see', but i
   don't know how to let you understand that that session generated something more
   beautiful than what we have lol"*. The gap was measured: no width
   breakpoint above 640px, a phone layout stretched across a laptop. He picked the
   composition.
   * **Layout.** `--rail-w` is what the rail takes out of the page (`0px` below 1024px).
     The `position: fixed` rules each want different treatment — `.layer` deliberately
     keeps `inset: 0` so a preview's scrim covers the rail — and `test/contrast.test.ts`
     classifies every one, because hand-enumeration got four of five wrong. Controls
     inset to the card's text column, read out of `main` by the test.
   * **Card ops live behind `⋯`.** What is recorded is **every 操作 on the desktop exists
     on mobile**, as a real button (an agent once misquoted it; *"i never state this
     rule?"*). **Undo stays out of the menu** — it is the safety net.
   * **Loop and 0.75×; no 0.5×.** A median word clip is 1.63s — a thing you loop, not
     seek inside — so no scrub bar; a 2px progress hairline instead. Rate change is a
     phase vocoder and smears rapid transitions, and the downstep is one; `preservesPitch`
     is set explicitly.
   * **Record-and-compare: the take is ephemeral** (memory only, revoked on card change)
     and **never touches the audio path** (a private `<audio>`, never `audioController`,
     so it cannot retarget replay or enter the log the hard-rule tests read). It plays at
     the reference's rate. Capture has `noiseSuppression` and `autoGainControl` off;
     stopping the recorder stops the tracks; **nothing sounds while the mic is open.**
   * None of the new keys reaches `audioController`; decision 29 is untouched
     structurally (`play` inside `enter()` turns 25 tests red).
41. **The final import has happened (2026-09-08), so `rm` + re-import is no longer a
   lossless reset.** Zach, 2026-09-13: *"what we have now is already the final import, i
   won't import anymore (unless we genuinely lost everything here ofc)"*. Hashigo's own
   grades exist on the devices and in the sync mailbox and nowhere else; `exports/`
   cannot reproduce them. **Any schema change must answer for the live history BEFORE it
   runs** — decision 17's backup and decision 33's payloads carry it, and both stamp a
   schema version, so they are part of any migration, not an escape from it. Decision 16
   is the import rule; this is its consequence.
42. **`remembered` waits for the end of the walk; `forgot` does not.** Zach, 2026-09-13:
   *"you don't know if you actually remember the card until you're at the last slide, so
   maybe we don't even need remembered button when we still have next button"*. `forgot`
   is settled by a single failure; `remembered` is a conjunction over every side. So
   mid-walk the row is `forgot | next`, then `forgot | remembered`: **left is always
   `forgot`, right is always proceed.** `j` mid-walk answers with what is missing
   (`3 more to see — space, then j`). This amends 34's "grading does not wait" for
   `remembered` only; the button is taken OFF screen rather than left inert, which is why
   it is not the 2026-09-07 *"it won't let me click remember"* defect. Cost: 99.8% of
   tracks have ≥2 steps, 2.43 extra presses on average before a pass (単語 median 4).
   `test/app-keys.test.ts` asserts `f` and `j` mid-walk together — never "restore
   symmetry" by taking `forgot` down too.
43. **The example sentence carries its own pitch accent per mora — the `<ojad>`
   element**, filled from a `local = 1` field found by ROLE. Zach, 2026-09-13: *"do you
   think it's possible that we can add field type called OJAD? … we will feed in the
   example sentence, which will get turned into all ひらがな, and for each hiragana, if
   it's accented … then 開 would be in our red, and if it's devoiced like しま~し~た, then
   し would be blue, or gray … so that while reading the example sentence i can see hear
   how it's pronounced and confirm by looking at the field"*.
   * **An element, not a field type** — a new type is a CHECK-constraint schema bump, and
     41 made those expensive. `<ojad>` is one line in the parser's `ELEMENTS` allowlist,
     the `型` pattern. It is EMPTY and sits on its own line under the sentence (wrapping
     `<< 例文 >>` broke the `ai` mount); beside, never instead.
   * **平板 is `accent == morae`, not 0** — the naive rule painted 21.1% of morae red
     (every flat phrase); the correct one 13.9%. In a sentence the particle is inside the
     phrase, so 花が marks な and 鼻が marks nothing: **it shows what the word audio
     physically cannot** (the mirror of 27).
   * Devoicing is free: OpenJTalk writes a devoiced vowel as an UPPERCASE phoneme.
   * **Colour** (he asked *"blue, or gray? which one is easier to understand?"*): accent
     heads in a darkened red (`#b33717` light, 5.79:1 on card;
     vermilion as authored was large-text only), devoiced morae **grey with a ring** —
     blue reads as a link here, devoicing is a reduction, and the two marks are
     isoluminant (1.04:1), so they differ in shape too. (The palette was later repointed
     by 57.)
   * **A refused or malformed annotation paints NOTHING** (decision 8's display form).
     Not cross-checked. Coverage: 3,711 of 3,712 distinct sentences.
44. **`---` is his, and the question boundary follows it.** Zach, 2026-09-14, on a 漢字
   card showing its `<draw>` canvas before he pressed anything: *"so it doesn't follow
   the `---`? because i added that explicitly, i have my reasons."* An agent's rule had
   folded a widget-only side into the question; that reason was never his. A rule that
   decides an authored side belongs to the previous one overrules the template from code
   — and if the canvas belongs beside the kanji, that is one deleted `---`, his to make.
   Cost: 1,662 漢字 cards gain a step that reveals no answer. The "answer on the card"
   hint keys on whether the CARD has a surface (`<input>`, `<draw>`). The boundary is
   still the first VISIBLE side in display positions — reverse tracks permute sides, and
   `test/app-logic.test.ts` pins that regression.
45. **The seed fetch has its own screen with the climbing mark; no "use the local copy"
   escape.** Zach, 2026-09-16, from his prototype: *"i agree that loading animation would
   be perfect."* This is `ensureFile` in `app/db.worker.ts` (the card database, text and
   audio, hundreds of MB), not decision 33's sync.
   * **Change is reassurance, motion is not** (his line): a spinner looks the same healthy
     or hung, a byte counter going up is evidence. So the screen is mostly numbers and the
     bar encodes the phase (sweeping = indeterminate, filling = measured bytes). It grew
     from the per-file bar added after *"frozen on this page for like 5 mins"*.
   * `GATE_MS = 500`, so a boot that fetches nothing never flashes the screen.
   * Timing `drop 800 · beat 200 · fade 500 · hold 600`; the beat is load-bearing (without
     it the new rung is never seen to arrive), and the loop is phased so `t = 0` is the
     start of `hold`. The clock is `performance.now()` directly. The rung colours come
     from the tokens through `color-mix`, so dark mode works; the geometry is the shipped
     mark's, pinned.
   * **No red on the stall notice, and no "use the copy already on this device"**: the
     fetch runs because the seed changed, so the local copy is the stale thing — *a
     trapdoor, not a safety valve*. One deliberate deviation from his *"mark and
     wordmark, phase label, one progress bar, a numeric readout. Nothing else."*: the
     quiet boot log stays (he diagnosed three faults with it); reversible if he wants the
     purer screen.
46. **A late track says how late** (`QueuedTrack.overdueDays`, local dates); **a track due
   today says nothing.** Zach, 2026-09-17: *"it would actually be perfect if there's a
   label showing when this card was due in the past — like i didn't have time to review
   so now im like catching up, but it would be helpful to see that this track was due 5
   days ago or something"*. The number is the scheduler's in LOCAL DATES, not
   `Date.now() - due_at` (a card due at 23:00 yesterday is one day late; decision 6).
   Due today is the plan working, so no chip. Quiet, not a warning: in a catch-up
   session nearly every card is late, and being behind is what he is fixing — the chip
   keeps its shape with `--muted` text, no accent colour, no red. Days, then years
   ("due 2 years ago", exact date in `title`); months clamp at 11; a test requires the
   label to be monotonic from 1 to 800 days.
47. **An empty Ctrl+K suggests (pinned, opened here, recently edited — never archived); no
   search query is ever recorded.** Zach, 2026-09-17: *"if i search something using
   ctrl+k, would it leave any search history? like notion when you hit your ctrl +k for
   the first time, it would list pages that it thinks would relevant to you … can we do
   it too?"* Notion is not predicting; it keeps an access log. So:
   * **The typed query is never stored** — not in the database, not in `localStorage`.
     What is logged is CARDS OPENED (`app/visits.ts`, 50 ids, `localStorage`, per device,
     not synced, cleared by `?reset=1`). **Grading is not a visit.**
   * Three tiers as separate queries, in order: **pinned** → **opened here** →
     **edited** (`cards.updated_at`). Not `last_reviewed_at`: every imported review is
     timestamped midnight, so it orders the top of the list arbitrarily.
   * **The edited tier excludes archived cards** — an archived card is one he took out of
     rotation, and decision 17's restore stamps `updated_at = now` on every archived card.
   * The gallery is excluded (a listing, not a suggestion); the `@` link picker is in.
     Lives in `app/recent.ts` so `test/` can reach it.
48. **The day's bar shows the misses in red (a prefix, counted from `reviews`).** Zach,
   2026-09-17: *"for missed/forgot card, we can actually make it visible on the progress
   bar, but maybe as a red bar? so the bar can now tell the proportion"*. `--danger` on a
   2px summary, never on the grade buttons. **A prefix anchored at zero**, so each width
   only grows and it shows the day's proportion, not the last grade. **`missedToday` is
   counted from `reviews` in the same statement as `answeredToday`**, so it survives a
   reload; a decision-13 re-ask writes no review, so a miss counts once.
   **`forgot` on a new card grades it, and should.** He asked *"technically you can't
   forget things you haven't learned right?"* — FSRS's `init` is a function of the grade
   alone (a miss: stability 0.212, 1 day; a hit: 3.281, 3 days), so the first grade IS the
   initial-stability signal. His export shows what discarding it looks like: Mochi's
   review #1 misses 0.95% against 4.04% for later reviews — the easiest review in the
   history, because the learning attempts were thrown away. Decision 13 already makes
   flailing free: the first press counts, every later press in that session does not —
   the answer to his *"how many times is okay"* is any number. He had raised Mochi's model
   (*"in mochi flashcard, until the card is added to your review deck (from new card to
   due card) it won't keep track of your grade, but i don't know which approach is the
   best"*): Hashigo keeps the half of it that matters (decision 13) without discarding the
   one grade FSRS's `w[0]`-`w[3]` are fitted on.
   `lapses` counts a first-review miss too; nothing reads that column, so it is left alone.
49. **Privacy was never his requirement — decision 33's "no cloud" lost its reason.**
   Zach, 2026-09-24: *"uhm... i never said i don't want anyone to see my study history.
   im even thinking about making this app become usable for my friends"*. The rationale
   was an agent's, written while choosing between tunnels; `notes/zach-in-his-own-words.md`
   has no line about privacy. What survives of 33: the merge rules and the mailbox. **Friends
   using the app is a DIRECTION, not a decision**: don't take single-user shortcuts (one
   shared secret, one mailbox, his keys paying for every generation) blind.
50. **The app pulls on the boot screen, before the first card**; offline or unanswered,
   it opens with the local database. Zach, 2026-10-09: *"if I'm on a train and I want to
   review it it would take so much time without knowing how long it would take"* and
   *"when you open the app and it has not been synced it won't let you go through …
   what's the point of having the first waiting page if you have to go inside the app
   and tap the sync button again"*. Before the first card a merge can neither freeze the
   review screen (~8 s) nor move what is due under a held card, so `syncAtBoot` pulls
   there and then replans (the worker refuses `replan` once anything is graded).
   * **The push stays off the boot path**; `pushAfterBoot` sends after the first card,
     only when this device has grades the mailbox lacks (*"how much data does it
     consume?"*, 2026-09-29).
   * **Three exits, the local-first floor:** offline → straight in; listing unanswered in
     8 s → straight in; a stalled download → "open without syncing". Once a merge has
     started there is no exit (one transaction). Unlike the seed (45), the local copy
     here is a working database.
   * **The ETA comes from the last run on this device**; a part never measured makes the
     whole estimate null, never a short half-truth.
51. **Grades travel as a delta** (`src/sync/delta.ts`, small enough for `keepalive` on
   page hide). Zach, 2026-10-10: *"so it's guaranteed that my last min of reviewing won't
   be synced from my tablet"* — and the constraint, *"as long as we don't end up like
   mochi flashcards im fine"* (hot phone, bloated, always running). The delta is the
   grades after a per-device MARK (that device's own `reviews.id`) plus the current state
   of the tracks they touched — 3 grades = 1,816 bytes, under the 64 KB `keepalive` cap.
   Wrapped as a payload and merged by the same `mergeSync`. The push debounce has a
   maximum wait (`PUSH_MAX_WAIT_MS`, 2 min). **No timer, no polling, no socket**: sends
   happen on grading and on hide. Corrections are re-applied inside every merge
   (`reapplyCorrections`), because values merge without a clock. Edits: see 64.
52. **The gallery is read, not operated.** Zach, 2026-10-16, on a design review: *"i
   agree with you on every section accept for [the review loop]"*, and *"i would keep 5,
   6, it feels raw to me lol, and feel nerdy too"* — so the review screen and every
   developer-voiced line are his and stay as written.
   * **One `⋯` per tile** (`openTileMenu`): 300 tiles had put 300 red `delete`s on screen.
   * **A gist line**: the first sense of `意味` / `Meaning` (`app/gist.ts`); no guessed
     line for templates without one.
   * **Archived hidden by default**, filtered in the query, not after the limit.
   * **An address**: `#deck/<id>` and `#everything`; one history entry for the gallery,
     so Back means "back to review"; the URL follows `data-view`; layers get no address
     and Back closes a layer first.
   * Deck paths sort numbers as numbers and nothing else; counters say what they count
     (decision 6); a clip button is named `play this clip`, never by its ALT text (the
     masked answer).
53. **`優先` cards are picked first from the new pool, still ten a day**; then 日本語 words
   with a kanji at the exam target's levels. Zach, 2026-10-21, with the 漢検準2級 CBT on
   6 Feb 2027: *"make the priority feature, that from now on, the queue will select my
   priority first"*. Amends 15's "random" for these tiers; each tier is still shuffled
   by the daily key. Without it a given track had ~23% odds of surfacing before the exam.
   * **`優先` is a LOCAL BOOLEAN FIELD, not a column** (41 made schema bumps expensive),
     matched by name and type (`priorityCardIds` in `src/scheduler/queue.ts`), and it
     syncs. Priority picks WHICH ten, never how many.
   * **The level tier** uses `src/scheduler/kanken.ts`, every 常用漢字 at its FY2020 level
     from the 協会's own table (verified: per-level counts, all 57 kanji of the 2020
     change list). Scoped to 日本語 (seven 基本情報 sentences matched otherwise).
   * **The target is a setting, `queue.exam-target`** — *"in future, how do change the
     target priority? because i will level up"*: off / 3級 / 準2級 / 2級, pulling forward
     the level and the one below; absent or unusable means 準2級. No deploy to change it.
54. **A word waits for its kanji**: an unlearned 漢字 card's forward track takes the word's
   slot (`kanjiFirst`). Zach, 2026-10-25: *"no matter what the priority is, if the 単語
   cards are containing kanjis that i have not learned, it will swap out that word from
   the learning queue and let me learn the kanji first"*. Runs over 53's tiered order.
   Unlearned = a live card on the `漢字` template with no reviewed track; a kanji with no
   card, or an archived one, blocks nothing. The kanji's FORWARD track goes in, once
   however many words point at it. One review frees the word (from the next day's plan).
   Asked of the TEMPLATE, not the name; only tracks already in the query, so a scoped
   session never pulls in an outside card. Cost is pace, front-loaded (705 of 2,054 new
   word tracks were gated on 2026-10-25).
55. **A card remembers where it was found — `出典`** (role `source`, fixed field id
   `source`). Zach, 2026-10-26: *"whenever i see a new word inside an example sentence
   like 彼女は古いシャツを細く裂いて、包帯の代わりにした。 i see 包帯 so then i would create
   new card, but then i would have no way to tell myself that i created that card because
   of this one"*. The edge lives on the NEW card (`例文` is an `ai` field; a regeneration
   would lose a link inside it): `[[source|id]]` plus a COPY of the sentence. The link
   gives the backlink for free. The fixed id `source` means two devices creating the
   field write one row. Shown as "found in" only after the walk (before it, the sentence
   contains the answer). "new card from this" in the card's `⋯`; a selection is
   remembered as it is made, because on the phone `⋯` collapses it.
56. **Cards made in the app get `読み`, `型` and OJAD from a helper on the laptop**
   (`tools/accent_helper.py`, laptop only, EMPTY fields only). Zach, 2026-10-26: *"i
   have to fill them myself?"* and *"when i create a card it's almost always when im at
   my laptop, so can't it just use my laptop automatically?"* — he weighed the cloud and
   chose the laptop. Not the Worker: the pipeline is Python, OpenJTalk and two
   dictionaries, and a JS port would be a second, unvalidated pipeline. It serves the
   batch run's own functions on `127.0.0.1:47474` (loopback, CORS for the app's origins
   only); answers go through `loadAccents`' refusals, hand adjudications apply, UniDic
   never decides (8). **`読み`'s rule:** only on a head word with kanji, only when UniDic
   reads it as ONE token whose pronunciation equals OpenJTalk's, and then UniDic's
   WRITTEN kana. **A value present is his. Never on a phone** (127.0.0.1 is the phone);
   its cards fill when the laptop next opens the app. ~40 MB, ~0.1 ms a word.
57. **The Pinterest design system; the one colour is ruri (瑠璃).** Zach, 2026-10-27:
   *"i think every details make it looks super good for a flashcard app … build a design
   system around this … you might find documents about the decision that i have made
   about the design but you can ignore them, we'll start from scratch"*, then *"apply
   this design to the actual app"*. Its source is `design-system/` (*"so that next
   session picks it up"*) — **its README is the brand book; read it before anything
   visual.**
   * **What it is:** neutral grey grounds and three inks; ONE colour, used only on what is
     live — the replay disc, the mark's top rung, focus, the day's progress bar (48 needs a
     hue boundary beside its red) and card links; a raised card with 28px corners; pills
     and discs for controls. Noto Sans JP 400 for Japanese, Hanken Grotesk for Latin.
     Fraunces and Zen Maru retired.
   * **The colour is his: ruri over orange** — *"orange makes people think of claude
     lol"*. Five accents rendered on the same screen; it also measured best (≥4.6:1 on
     every light ground; blue against `--danger` red survives red-green colour blindness).
   * **Token names kept, values repointed:** `--indigo` resolves to ink, `--vermilion`
     to ruri. A change goes into `design-system/` AND `app/style.css`.
   * **The hero is script and length:** `heroLength()` — Japanese script, 1-4 code
     points, no cloze — sized against the card (`cqi`).
   * **Unchanged:** 23's hand, 29's audio gating, the walk (34/42), 48's red misses. No
     control changed state, place or behaviour. `--good` stays (the sync dot); red stays
     for errors and the open microphone. **Left as his:** the copy, the icons on labelled
     controls, the counter, the card's laptop width, the review screen's density.
   * The reference's greys failed contrast and were darkened; its word rail was NOT built
     (listing upcoming head words prints the answer on a mode-2 or reverse card).
58. **A mode-2 単語 card has a writing canvas on side 2** — `<draw height="240px">` under
   `<< Speech >>`, inside `<< ^Reading >>`. 2026-10-29. The 漢検 misses were
   word-specific: he wrote 波手 for 派手 while able to write both 波 and 派. A `問題` field
   with a third track kind was proposed; Zach saw it was the 漢字 card's reverse again.
   Mode 2 already asks for the whole word from its sound; it only lacked somewhere to
   write, so a half-recall survived the reveal. *"omg that sounds perfect, yes"*. Hear it,
   WRITE it, reveal. No new track; a word stays one card. It was edited live in the
   template editor, so it lives on the devices — `build/hashigo.db` lacks it.
59. **Every deploy is a release: `npm run release -- patch|minor`, then deploy.**
   2026-10-31; Zach: *"we need rules for future development too"*. The version had sat
   at 0.5.0 for ~100 commits, so the rule is enforced, not documented. What devices
   depend on is already versioned: `SCHEMA_VERSION`, `SYNC_VERSION`, `ARCHIVE_VERSION`.
   * **major** stays 0 until 1.0 (RELEASE.md: he could hand a friend the link and explain
     nothing); a bump must be asked for by name (`--one-point-oh`).
   * **minor / patch: see 65**, which replaced 59's "patch = fixes only".
   * `npm run release` bumps `package.json` and the lock, commits `release: vX.Y.Z`, and
     tags it with every commit subject since the last release — the changelog, kept by
     git. `npm run app:build:cloud` runs `scripts/release-check.ts` and refuses unless
     HEAD is that tag with a clean tree. Rules in `scripts/release-rules.ts`, pinned by
     `test/release.test.ts`. Never write a changelog by hand.
60. **A mode-2 単語 card shows its emoji on the question side**, unmasked, at the top of
   side 2 inside `<< ^Reading >>`; mode 1 keeps it behind side 4's cloze. Zach,
   2026-10-31: *"when i heard words like かんしゅう i genuinely don't know which one it is
   … if it's reading=false then the emoji is moved to the top"*. 観衆 / 慣習 / 監修 sound
   the same, and the sound is the prompt. The instruction text is unchanged, so every
   card keeps its emoji (decision 7). **Side 2, not side 1**: on side 1 it became the
   whole question, with the word and audio a press away (44). Sizing reads content only
   (`contentText`, no button labels) and counts graphemes, not code points.
61. **A field shows its KIND (type + role, `fieldKind`), and a derived kind is read-only in
   the editor.** 2026-11-05. Zach: *"the `type` wouldn't be plain text, but rather
   something like `ふりがな` … same with かな主流, the type doesn't even say boolean, and
   same with 型"*; of 読み, *"i never write there by hand"*; of 型, *"fully read only, if
   we really have problem, then we will add that, im following yagni principle"*.
   * `fieldKind()` (`src/fields/kinds.ts`) is the one answer for every screen. **Derived**
     — Reading (読み), Pitch accent (型), Accent marks (OJAD) — is the editor's whole
     read-only rule. No override; a wrong value is a script's fix (`scripts/sync-set.ts`).
   * 読み carries role `reading` (head word as input); a plain field named 読み with no
     role still counts (`effectiveRole`). Text ⇄ Reading is the one kind switch.
   * **Mochi's four unused types (Long text, Furigana, Dictionary, Image search) are
     DELETED** — *"what's the difference between plain text and long text tho?"* (none),
     then *"it's not even a spark joy lol, just delete them"* — from code and
     `schema.sql`'s CHECK, with no version bump (an existing table keeps the wider CHECK).
   * Zach: *"Filled for you, read-only, and Generated … are basically the same thing,
     what's the reason that we are dividing them?"* So generated fields read the same
     in the editor (`filled from 例文 — …`). **Editing a field empties the derived fields
     downstream of it** (`staleDerived`, through generators: 単語 → 例文 → OJAD) to `""`,
     never deleted (a deleted row does not travel), for the helper to refill. Until then:
     no label rather than a wrong one (8).
62. **A missing generated part is MADE when its card is shown — any card — and there is no
   "generate" button while it is being made.** 2026-11-05. Zach: *"when all the generated
   properties are loading, i want some skeleton are loading animation... something to let
   me know that it's not freezing, and it shows the generate button, so i might
   accidentally click them, i have to know which one
   is genuinely hasn't generated and which one is loading, i mean, generate button is
   probably useless, even, because if we can see the button it means something is not
   generated, and we might as well generate them right now"*. `autoFill` asks `cardGaps`
   for every card on screen and makes what is missing once. States: `pending` /
   `generating` pulse; `missing` (tried, still absent) carries "try again"; `ready`.
   Existing clips are never redone (CLAUDE.md's answered question 2 is about REgeneration).
   **A typed `#tag` becomes a tag** when the text lands (`src/cards/tags.ts`), add-only —
   *"the tagging is not working anymore"*: it never had for a new tag, since only the
   import wrote `tags`.
63. **An emoji line is emoji: the first run of emoji, nothing else** (`cleanGenerated` in
   `src/generate/llm.ts`). 2026-11-06, over a reversed 断片 card whose line read "Sure!
   Here is the word 断片 described using emojis: 🔪🧩": *"i want you to replace all the
   emoji section that contains text lol, like this one it just says the answer out right
   😭"*. 1,173 of 10,162 emoji generations carried letters. Keep the first run with
   its joiners; stripping only letters would double an explanation's emoji. **Cleaned on
   READ** in `storeTextResolver` (every device's stored copy, never rewritten) and by the
   Worker before it caches. A line that cleans to nothing is not there: a gap, made again.
64. **Edits travel as a delta too** (`src/sync/sent.ts`), diffed against a FINGERPRINT of
   what this device last sent. 2026-11-10: Zach saw every open download ≥5 MB and asked
   whether that was really a 差分. It was not: 51 made grades a delta and left every
   other write on the full payload (a 5.31 MB base, ~1 MB brotli, ~8 s to merge on the
   phone). The base is the right size for its job; the fix is not sending it for one card.
   * **The fingerprint**: one hash per card, template, field, deck, setting and retired
     clip; the delta's `edits` are the groups whose hash changed, merged through the same
     `mergeSync`. **A fingerprint, not a clock** — values have no clock, and a watermark
     trusts every writer to stamp; a hash needs nobody's cooperation.
   * **Merge guarantees unchanged**: no apply path deletes a row it was not sent. A card's
     values never travel without its flag row. `test/sync-edits.test.ts` asserts
     EQUIVALENCE with merging the full base, table by table.
   * The fingerprint lives in `localStorage` beside the mark (~208 KB); no fingerprint →
     the FULL payload. Re-taken after a merge only when nothing local is unsent. The
     mailbox dedupes a delta by its body. The sync button follows the same rule.
   * Full payload still when the delta passes 64 KB or the stack 512 KB; the hide-time
     `keepalive` send stays grades only.
   * **`SYNC_VERSION` 2**: a v1 device would read an edit delta as grades and lose it, so
     it refuses until reloaded; a v1 payload still merges (`OLDEST_SYNC_VERSION` 1).
   * One new card: 3.41 MB base → **784 B** (5.31 MB live → under 1 KB on the wire).
65. **A minor means "update every device" or a milestone; small features ship as
   patches.** 2026-11-11, amending 59. Zach: *"it feels like we are releasing minor version
   every other day lol"* — v0.6.0 to v0.9.0 in twelve days, because 59 defined a patch as
   "a deploy that ONLY fixes things".
   * **minor** — a change to `SCHEMA_VERSION` / `SYNC_VERSION` / `ARCHIVE_VERSION`
     (enforced: `release` refuses a patch for it), or a milestone: something he would tell
     a friend the app can now do, named in the tag message.
   * **patch** — every other deploy: fixes AND small features, one per deploy.

66. **An imported card's TEMPLATE travels in sync — set by a newer clock, healed where
   missing, never removed.** 2026-11-11. Zach, showing `dissident` on the tablet as plain
   `dissident --- a person who opposes official policy…` and on the laptop with audio, an
   example, an emoji hint and a YouGlish link: *"because this is how i see it on the
   screen, it has everything"*.
   * **The gap.** Only cards MADE in the app (`local = 1`) carried their template, in
     `archive.localCards`. An imported card moved with `setTemplate` sent its new field
     VALUES, which merge on the card clock, and not the switch. Measured in a merge of
     every device's payload that day: 47 imported cards held values for a template they
     were not on, 17 of them still template-less (dissident, dogmatic, obscene,
     substrate, vis-à-vis; すずらん, たまねぎ, 切る, 巡る, 果て, 汚い …; こだわる, たれ).
     The only card-row write the app makes that did not travel; archive, pin and voice did.
   * **Now** `CardFlags.templateId` rides on every card's flag row (present only when set;
     `templatesCarried` says absence means none — the shape `voice` already had), and
     `mergeSync` has its own rule: a set template the peer decided LATER is taken; a card
     with NO template here takes the peer's whatever the clocks say — the bug's own
     signature, and the clocks cannot settle it because the flags rule had already copied
     the laptop's clock to every device; and sync NEVER REMOVES a template, because a stale
     device's clock can be newer for an unrelated reason (a pin, a field edit's
     `touchCard`) and its "none" would undo his switch everywhere. The price, accepted:
     moving a card TO no template stays on the device where it was done.
   * `SYNC_VERSION` 3: a version-2 device would have merged the payload, ignored the
     template and never read it again. Version-1/2 payloads still merge and move no template.
   * **The repair is automatic** once the laptop — where the switches were made — sends a
     version-3 payload: every card's flag row changed, so its first send is a full one.

## Ratified 2026-08-22 — small calls an agent had made without authority

`OVERNIGHT.md` §4 (in `notes/archive/`) listed ten; five were settled by later
decisions, and Zach took the remaining five as recommended:

* **A `---` inside a field value stays a horizontal rule**, not a side break (only card
  `EPp9rse6`). His reasoning: *"it doesn't matter if I divide a card, I still have to
  remember all of them anyway, and If i fail one, i fail the whole card"* — the fix is
  splitting the CARD, which is authoring, not parsing.
* **The CommonMark emphasis deviations stay** — his corpus broke the standard rule
  (`\*` jisho wildcards, underscores in filenames, `路_線_図` italicised).
* **The dashboard keeps zero JavaScript** (battery), and no VALUE on it is hover-only:
  each heatmap year carries a `<details>` table, one row per active day.
* **The heatmap keeps 4 colour bins** — a 5-step ramp failed contrast.
* **`tags` keeps 20 rows for 19 real tags** (`Dialect` is a childless ancestor); any
  count filters `cards_direct > 0`.

`orphanFieldValues` reports **235** (143 on templated cards + 92 on cards with no
template; 137 carry real text), asserted in `test/transit.test.ts`. The values are
imported and stored; they simply have no field to render them.
