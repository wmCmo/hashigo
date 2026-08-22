# DECISIONS — the 22 settled calls, with the reasoning they were made from

**This file is the WHY. `CLAUDE.md` is the WHAT, and it carries all 22 as a
one-line index that auto-loads every session.** Split out 2026-08-22 because the
reasoning had grown to 42% of an auto-loaded file — the decisions themselves are
about forty lines; their derivations are three hundred.

> [!IMPORTANT]
> **THE ONE-LINE INDEX IN `CLAUDE.md` IS STILL THE RECORD.** The guarantee that
> made everything live in one file is unchanged: if a decision is not in
> `CLAUDE.md`'s numbered index, it is not recorded. Four decisions once lived only
> in Zach's Obsidian planner and one of them (`型` placement, now decision 20) was
> reopened by an audit as an "open question" weeks after he had settled it. So when
> you settle something with him: **write the one-liner into `CLAUDE.md` first**,
> then the reasoning here. Never here only.
>
> Numbering is load-bearing — "decision 6" is cited about two dozen times across
> `src/`, `test/` and the notes. **Never renumber.** Add at the end.

Where this file and `notes/zach-in-his-own-words.md` disagree, **that file is
right**: it holds his verbatim reasoning and this quotes it.

---

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
   **The escape hatch was the dangerous case, and the guard is BUILT** — commit
   `0e04a10`, `LOCALLY_GRADED` in `src/import/reviews.ts`. (This paragraph said "needs
   a guard … cheap to build now" for a day after the guard shipped; corrected
   2026-08-22.) The bug it closes: `INSERT_TRACK`'s `ON CONFLICT … DO UPDATE` reverted
   a locally-graded track's `due_at`, `scheduled_days`, `reps`, `lapses`,
   `last_reviewed_at` and `scheduler` to Mochi's, while the `reviews` rows themselves
   survived — so the log and the track would silently DISAGREE, which is the worst
   shape for this bug because nothing looks lost. Harmless for the planned final
   import (no local grades exist before it), destructive for exactly the case he named:
   re-importing to recover from a bug, when local history exists.
   It PRESERVES rather than refuses, because the escape hatch has to actually work,
   and it reports the count (`tracksPreserved`, printed as "locally-graded track(s)
   LEFT ALONE") so a re-import that left tracks alone cannot read like one that
   rewrote them. **The three non-obvious implementation choices — why `CASE` per
   column rather than `DO UPDATE … WHERE`, and why Mochi still owns `dormant` and
   `needs_rereview` — are in the docstring at `src/import/reviews.ts:573`, and that
   is the only place they should live.** Pinned by `test/roundtrip.test.ts:550`, which
   fabricates the local grade rather than waiting for stage 7 and also asserts every
   OTHER track still upserts normally — a guard that froze the whole table would pass
   the narrow assertion and be a worse bug. **Teeth demonstrated 2026-08-22:**
   reverting one `CASE` to `excluded.due_at` turns **3** tests red. Today
   `SELECT count(*) FROM reviews WHERE source = 'local'` is still 0, so this changed
   no import that has ever run.

   *(This entry was 27 lines on 2026-08-22 because a session — mine — pasted the
   docstring into what was then an auto-loaded file. Trimmed the same day. The rule
   that falls out: if the reasoning is already next to the code, cite it, do not
   copy it.)*
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

23. **The review screen is direction A2 — A's terminal look with C's hand.** Settled
   2026-08-22 from three mockups built over the same four real cards (裸足 平板 · 捜査
   頭高 · 係数 中高 · 取り戻す 中高), with real audio out of the store. His words are in
   `notes/zach-in-his-own-words.md`; this is what they decide.

   **Chosen:** A — *"the closest to what im aiming at, it looks fun, it looks new (as in
   novel), it looks like we've put thoughts into it."* Dark, monospace, dense, the whole
   card on one scroll. **Rejected:** B, the light document (and its light theme
   generally); C as a whole, though its ergonomics were taken.

   **Four changes to A, each from a stated reason rather than taste:**

   * **Replay is C's round button, bottom RIGHT.** His only complaint about A, and the
     reason is a fact about him: *"im using my right hand, and my thumb would have to
     reach all the way."* A native `<audio controls>` puts play at the far LEFT of a
     full-width strip. C's own button is CENTRED — a compromise for either hand — so
     bottom-right is neither A's nor C's, it is what his hand asks for. 66×66, 16px
     from the right edge, 86px up from the bottom.
   * **The action bar is pinned to the bottom edge.** Measured, not assumed: in A the
     grade buttons landed at **y=894 on an 812px viewport** — below the fold. At ~100
     cards a day that is a scroll before every single grade.
   * **Keycap hints render only where a real pointer exists**, via
     `@media (hover: hover) and (pointer: fine)`. **NOT behind a tooltip.** He proposed
     tooltips as the mobile-friendly option; the opposite is true, and decision 19 is
     the reason in his own words — *"there is no hover on a phone, a long-press is
     deliberate."* A `title` tooltip has nothing to trigger it on a phone and a
     long-press opens the context menu instead, so tooltips would hide the hints on the
     device he reviews on and keep them on the laptop where they matter least. It is
     also what the dashboard already ratified against, where hover-only data was
     replaced precisely because it was unreachable. Verified under touch emulation:
     `hover:hover` false, `pointer:coarse` true, 5 touch points, keycaps computed
     `display:none`.
   * **`remembered` is on the RIGHT, deliberately.** Corpus-wide retention is 96.24%
     over 102,020 reviews (lifetime basis, new-card learning included — decision 6), so
     roughly 96 of every 100 taps are that one button. It belongs under the thumb that
     is already there. `forgot` takes the left, which is the deliberate reach.

   **Contrast is part of the decision, not polish.** A's own greys failed: side labels
   **2.21:1** and deck/meta **3.61:1** on `#111214`. Now 5.77:1 and 6.44:1. The low-pitch
   mora stays at 6.90:1 because it CARRIES the accent information — that measurement is
   also why B was rejected beyond the battery argument: its low mora sat at **3.66:1**,
   making the data he is trying to learn the least legible thing on the page.

   **What this does NOT settle**, and must not be read as settled: whether the head word
   stays pinned after reveal (it currently scrolls away), where a decision-13 "again
   later" card re-enters the session, and every remaining detail of type scale, spacing
   and motion. The DIRECTION is settled. The screen is not built — `build/mock/out/` is a
   mockup with no scheduler, no grading and no writes.

24. **Agents commit their own work, without asking.** A standing grant, 2026-08-22:

   > you don't have to wait for my instructions to commit, you know when to commit, make
   > it clean and deliberate, no permission needed, commit is always revertible, and it's
   > your job now
   >
   > this should be instruction for any agent from now on

   **This supersedes the previous convention**, which was "commit or push only when the
   user asks" and which had left ten paths of finished, gate-green work sitting in the
   working tree across a whole session.

   **What "clean and deliberate" has to mean, since it is the only constraint he gave:**

   * **Scoped commits.** One coherent change each — not one blob for a session, and not
     one commit per file. Where a reorganisation and a correction land in the same file,
     ordering them (structure first, then facts) beats splitting a file by hunk and
     leaving a broken intermediate state.
   * **Gates green BEFORE the commit, not after.** `npm test`, `npm run typecheck`,
     `npm run build`, `npm run spike:check`. Note that `npm test` **exits 1 on a fully
     passing run** (reporter RPC — see the commands section), so read the pass count.
   * **Messages in this repo's voice** — lowercase `type(scope):`, saying what changed
     and why it was not obvious. `git log --oneline -20` is the reference.
   * **The `NEXT.md` state heading is part of the commit**, not a follow-up. Its own
     warning says to change it in the same edit that changes the state; a multi-commit
     sequence should therefore set it true in the LAST commit of the run.

   **What is still NOT authorised, because he did not say it.** Pushing — moot today,
   since `git remote -v` is empty and this repo is purely local, but it stops being moot
   the day it is not. Force-pushing, history rewriting, amending a commit that is not
   from the current run, and `git reset --hard` over work that was never committed.
   Reverting is the safe direction and it is the reason he gave for trusting this at all.

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
