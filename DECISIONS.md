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

   **A SECOND HALF, added 2026-08-23: check that the basis is the one the sentence
   NEEDS.** Naming it is not sufficient. Four disagreements between two sessions in
   one day were all two questions wearing one number — 692/693 (`Reading = true`
   declared on the card's own template vs raw rows), 15/28 (orphan 単語 `Reading`
   held by 言葉 vs by any template), 6,855/10,656 (speech mounts without
   `resolveGenerated` vs with), and 132/235 (orphans that are field-move evidence vs
   all orphans).

   **The first three were harmless and the fourth was not**, which is the whole
   addition. Both readings of the first three were true of *something*, so quoting
   either only cost precision. But 235 was cited as SUPPORT FOR A CLAIM — that
   moving a field orphans its values — and 92 of those 235 rows sit on cards with no
   template at all, so they cannot evidence a move. Only one reading supported the
   sentence. Worse, 235 reconciled exactly with the importer's own
   `orphanFieldValues`, and that match read as confirmation while being
   **coincidental to the claim**. A number that agrees with another figure is not
   thereby the right number for the argument it is standing in.

   **THE OTHER HALF OF THAT, because the rule is not "distrust agreement".** Whether
   agreement is evidence depends on whether the two routes share a FAILURE MODE.
   235 matching the importer's `orphanFieldValues` was worthless: both counted all
   orphans the same way, so they could not have disagreed, and the match said
   nothing about the claim it was cited for. But 132 arrived three ways with
   *different* failure modes — an `EXISTS` subquery that cannot duplicate, a bare
   `JOIN template_fields ON f.id = v.field_id` that DOES duplicate whenever a field
   id sits on several templates, and a strict one-template filter. All three give
   132. The bare join would have EXCEEDED the others had any of the 132 been
   ambiguous, so the agreement positively rules duplication out. **That is a
   differential check and it is sound evidence.**
   
   So: agreement between methods that fail the same way proves nothing; agreement
   between methods that fail differently is a measurement. Distinguishing the two is
   the skill the first half of this rule does not teach.

   **AND THE RULE'S LIMIT, worth naming so it is not over-applied.** A fifth
   disagreement in the same exchange was NOT a basis split: "8 templates" against 6
   was a plain miscount from not re-reading a table that had just been printed.
   Naming the basis would not have caught it, and neither would checking that the
   basis fits the sentence. Not every number disagreement is a basis question — this
   rule catches the ones where two honest counts exist, and nothing more.
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
   history and the OPFS database is the ONLY copy. `notes/archive/persistence.md:204` already
   prescribes the one-tap export.

   **THE MECHANISM LANDED 2026-08-23 — `src/backup`.** It archives only what `exports/`
   cannot rebuild (local reviews, the scheduling state of any track that has one,
   decision 9's local fields and their values, settings): **332,262 bytes** over the real
   corpus against a 74 MB file. Rows rather than the file, because a binary copy only
   restores into the schema version it came from and `applySchema` refuses any other — a
   bump would strand every older backup. Keyed on `(card_id, kind)`, never `track_id`.
   `src/backup/README.md` has the two defects testing found.

   **What is still missing is the SCREEN half**, and it belongs to the shell: the
   persistent banner when `persisted()` is false, the add-to-home-screen prompt beside
   it, and detecting an eviction that already happened. Nothing calls
   `exportLocalArchive` from a UI. So the decision is half-built, not done.
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

25. **New cards carry a `New Card` label, and it is PER TRACK — not per card.**
   Decided 2026-08-23, from how Mochi already does it: *"on mochi flashcard, if the
   card is new, you get the label `New Card`, and the label is per side, so for
   forward and reverse, they could have its own `New Card` tag and it doesn't have
   to match."*

   **A TERMINOLOGY TRAP, recorded because it would put the label in the wrong
   place.** He said "per side" and meant per DIRECTION. In this repo **"side" is a
   part of a card** — 単語 has four, and decision 20 is about which of them `型`
   renders on — while forward/reverse are **tracks** (`card_tracks.kind`). So this
   decision is per TRACK. Read it as "per side" in this repo's vocabulary and the
   label ends up on side 2 of every card instead of on the track being reviewed.

   **It is already at the right granularity and needs no new state.**
   `SessionItem.origin` is `"due" | "new"` and comes from which queue the track was
   read out of — `newTracks` selects `due_at IS NULL AND reps = 0`, which is a
   per-track predicate. So the label is a render of `origin === "new"`, not a new
   column, and it is automatically unmatched between a card's two tracks whenever
   only one of them is new. Measured on the live queue: the ten new tracks on
   2026-08-22 spanned ten DISTINCT cards, mixed forward and reverse — decision 15's
   claim that the two are not paired, holding in real data.

26. **`型` renders on SIDE 1 for `言葉` cards.** Decided 2026-08-23. Decision 20 settled
   `型` onto "side 2, immediately above `<<Speech>>`" and says outright that it was read
   off *the `単語` template Zach pasted 2026-08-21*. It does not transfer, and a peer
   review found why: **`言葉` has no side 2.** Its body is
   `{{<<言葉>>}}` / `___` / `<<型>>` / `<<Speech>>` / `---` / …, and `___` is a rule
   WITHIN a side while `---` is the side break (parser trap 1, `src/template/parse.ts`).
   So `言葉`'s first `---` comes after `<<Speech>>` and everything above it is side 1.

   Zach confirmed rather than corrected: side 1 is where it goes for those 376 cards.
   **Decision 20 is unchanged for `単語`** — this records that the placement is
   template-specific, so nobody "fixes" `言葉` to match a side that does not exist there.

27. **NO PARTICLE beside the word — in the audio OR the display.** Decided 2026-08-23:
   *"don't add particle to my word, the word stays the word."*

   The audio half was already settled (`no particle in the audio`, because three
   different particles get conflated and the probe particle is internal to the
   derivation and never spoken). This extends it to the SCREEN. It was asked as a
   design question — should the A2 contour show a trailing particle box so 平板 and
   尾高 are visually distinct? — and the answer is no, on the same grounds: choosing a
   particle to display privileges one, and **the card's unit is the WORD.**

   **WHY THIS IS WRITTEN DOWN AS A CONSTRAINT AND NOT A PREFERENCE.** 平板 and 尾高 are
   *identical inside the word*: both are L-H-H on a three-mora word, and the downstep
   lives on the following mora — 花が (L-H-H) against 鼻が (L-H-L). With no particle in
   the audio and none in the boxes, neither channel can express the difference. Measured
   over the labelled cards:

   ```plaintext
   頭高    775    audible bare, and the contour boxes show it  (hi lo lo)
   中高    907    audible bare, and the contour boxes show it  (hi hi hi lo)
   平板  2,092  ┐ indistinguishable from each other in BOTH channels
   尾高     56  ┘ -> 2,148 cards where `型` is the ONLY carrier
   ```

   So `型` is not a caption. On 2,148 of 3,830 labelled cards it is the sole thing on
   the card carrying the fact being trained, and a layout that drops it on a narrow
   screen deletes the exercise on 56% of them. That is the same shape of failure as
   autoplay: not a degradation, a deletion.

   **AND THIS IS THE POINT OF THE ACCENT PIPELINE, in his own words** — worth having in
   the repo because every earlier note described the pipeline's mechanics and none
   recorded what it is FOR:

   > *"the true reason we need it is just because i didn't know 花 and 鼻 would be
   > pronounced differently when the particle is attached to them, that's the whole
   > point ... by sound i can distinguish 配慮 from 勉強, that's easy, but without
   > particle for those two kanji word, there's no way to tell, yet natives pronounce
   > them perfectly, because the 型 rule is encoded into their brain, that's what im
   > trying to train myself for."*

   `配慮` is `accent_type = 1` in his own derivation — 頭高, the audible class. The class
   that motivates the project is the inaudible one, which is exactly why decision 8
   refuses to let the UniDic cross-check resolve on its own and why the labels were
   materialised rather than generated at render.

28. **`言葉` displays the way it was inputted, so `かな主流` renders nowhere.** Decided
   2026-08-23, closing the last of D3's three questions: *"for 言葉 deck, it should
   display the way it's inputted."*

   **The route is worth keeping, because two steps along it were wrong.** The question
   only became askable once a peer review established that the flag and the
   `<<#Reading>>` gate sit on DIFFERENT templates — all six flagged cards are `言葉`,
   while the marker was authored into `単語`.

   Zach's first answer was that everything in `言葉` is kana anyway, which would make the
   flag vacuous. **Measured, that is 94.9% true and not 100%:** of 391 `言葉` head words,
   371 contain no kanji and **20 do.** He corrected himself on seeing them — *"which was
   wrong now that you showed me those cards i remember now"* — and then ruled on the
   general principle rather than the special case, which is the better decision and the
   reason this entry is about DISPLAY rather than about `かな主流`.

   **The 20 split cleanly, and the split is why "hide kanji on `言葉`" is wrong:**

   ```plaintext
   6   single words whose kanji nobody writes   蟻 雄 搔く 茄子 灰汁 雌  <- the かな主流 six
   14  phrases where the kanji is normal        目をつける · 気が付く · 口をきく ·
                                                質がいい · つじつまが合わない · 一体 ·
                                                一から十まで · 目が点になる · 〜ない限り ·
                                                と来たら · 待ちきれない · ...
   ```

   So the flag does real discrimination — it separates the 6 from the 14 exactly — but it
   fires on 6 of 391 cards and says something the deck already implies. Not worth a badge.

   **"Hide the kanji on `言葉`" was an AGENT'S suggestion and he rejected it explicitly:**
   *"i never said on 言葉 deck you should hide kanji?"* Recorded as rejected so it is not
   re-proposed — it breaks all 14 phrase cards, where the kanji is the correct spelling.

   **The values stay stored.** Decision 9 carries them through a re-import; they render
   nothing. Six rows in the archive is not a cost worth a deletion nobody asked for.

29. **The hard rule is CONDITIONAL on `Reading`, and `型`'s gating with it.** Decided
   2026-08-23. **This amends the most heavily pinned invariant in the repo**, so the
   reasoning is here in full rather than summarised.

   **What the rule said.** "Audio fires on the cloze reveal, never when a side appears."
   Absolute, called a correctness requirement, pinned by 10 tests including a 7,716-card
   sweep. It was written from Zach's description of shadowing and it was right about the
   exercise it described — it was wrong that every card runs that exercise.

   **The two modes, and `boolean-default` is `false` so absent means mode 2:**

   ```plaintext
   Reading = true    692 単語    produce reading+accent   audio ON REVEAL   型 gated
   Reading ≠ true  3,177 cards   hear it, name the word   audio ON ENTRY    型 visible
                   (2,785 単語 + 392 言葉; 1,882 of those have Reading ABSENT)
   ```

   41.2% of the corpus autoplays; 9% is reveal-gated.

   **Mode 2 is a different exercise, not a laxer one, and the cloze is load-bearing:**

   > if you show me 償却 i can read that word like instantly, because i can remember the
   > radical rules, but if you hide it behind the cloze, and play しょうきゃく, i would be
   > like... what しょう... and what きゃく、、、 and it would force me to remember

   His listening lags his reading, so mode 2 makes the AUDIO the prompt and the KANJI the
   answer. That is why the default is `false`: *"my listening skill is far worse than my
   reading skill … that's why most of the cards are like that."*

   **`Reading` IS A STATE, NOT A PROPERTY — this is the part that constrains the UI.**
   Mode 2 doubles as the audit that finds accents he had wrong:

   > but that's also because i didn't know that 尾高 was a thing, so from now on, if it's
   > `Reading` is false, so the audio would play on the first side when enter the card, i
   > would see that it's 尾高, and i'll be like, damn, i didn't know this, ive been
   > pronounced it has 平板 all along, and then i'll just go ahead and edit the card to
   > `Reading` -> true

   So `型` MUST render on entry in mode 2 — gating it there breaks the audit loop, which
   is the reason the accent pipeline exists at all (decision 27). And **the review screen
   must be able to flip `Reading` on the current card**, or the loop requires leaving the
   app mid-session. Nothing in stages 7-10 covered a mid-review field toggle before this.

   **THE TRADE-OFF, MEASURED — and one leg of his own argument does not survive it.**
   He reasoned that mode-2 cards are mostly 平板/頭高 so little accent recall is lost:

   ```plaintext
                    平板+頭高     中高    尾高
   mode 2  (3,141)    75.4%       728      44
   mode 1    (689)    72.3%       179      12
   ```

   True at 75.4% — but mode 1 is 72.3%, statistically identical. The split is orthogonal
   to accent difficulty, so this is a fact about his corpus and not a discriminator. The
   real cost is the **772 mode-2 cards that are 中高 or 尾高.**

   **His other leg is STRONGER than he stated.** *"which btw, comes in the example
   sentence part anyway"* — 97.6% of mode-2 cards carry example-sentence audio (3,102 of
   3,177). And a sentence puts a particle after the word, so the sentence audio can carry
   the 平板-vs-尾高 downstep the isolated word physically cannot (decision 27). Sampled
   400 平板/尾高 mode-2 cards: **54.3%** have a clean particle immediately after the head
   word (裸足**で**海岸を…, 夜中**に**起きて…). So the three channels are complementary:

   ```plaintext
   isolated word audio    carries 頭高 / 中高      CANNOT carry 平板 vs 尾高
   型 label               carries all four
   example sentence       carries 平板 vs 尾高     when a particle follows (~54%)
   ```

   **IMPLEMENTATION NOTE, because the obvious approach breaks mode 1.** Making `enter()`
   play turns the 10 mode-1 tests red *for the right reason*, and the wrong repair is to
   relax them to "audio may play on entry". `src/render/reveal.ts` knows nothing about
   `Reading` and should stay that way: `enter()` keeps doing nothing, and the CALLER — the
   mount or the screen — decides whether to play. Then every assertion can name its mode
   and mode 1 stays exactly as hard as it is today.
   Consistent with decision 15 and with `newTracks`' own docstring, which corrected
   an earlier claim that the queue delivered forward/reverse pairs.

30. **A previewed card is not a reviewed card.** Decided 2026-08-23, and it dissolved a
   question rather than answering it.

   The question put to him was: opening a card-link layer mounts a card, and mounting is
   what fires the audio on the 3,177 cards where the sound IS the question (decision 29) —
   so does a linked card opened mid-review play? Both answers looked defensible.

   **Neither was right, because the premise was.** His answer:

   > showing a preview card is not the same as put the card into a review mode, when you
   > enter a review mode, everything goes as it is now, showing a previewed card lets you
   > view every sides at once

   So there are two modes and only one of them is a drill:

   ```plaintext
   REVIEW    one card, sides PROGRESSIVE, clozes masked until the reveal, audio per
             decision 29, a grade at the end.        UNCHANGED — "everything goes as it is now"
   PREVIEW   every side at once, fully revealed, no masks, no grade, and nothing plays
             by itself. A clip stays one deliberate tap away, as it always is.
   ```

   **WHY THIS IS MORE THAN A UI DETAIL.** Decision 29's audio is a property of the
   EXERCISE, not of the card — so a card that is not being exercised has no reason to
   sound. That also means preview needs none of the machinery review needs: no
   prompt-on-entry, no drill-side boundary, no one-clip-per-reveal arbitration. It is
   `revealAll()` and every side visible, which is what `src/render` already does.

   **AND IT RATIFIES SOMETHING AN AGENT DECIDED WITHOUT AUTHORITY.** The review screen
   shows sides PROGRESSIVELY — the question side, then the rest on reveal — and that was
   my call, forced by measurement rather than by him: showing every side at once leaks the
   answer, because 単語's side 3 is the example SENTENCE and it is not clozed, so on an
   identify card it prints the very word he is being asked to name. *"when you enter a
   review mode, everything goes as it is now"* is him looking at that behaviour and
   keeping it. Recorded as ratified rather than left implicit.

   **The two modes share the editor.** His request 3 is *"whether the card is in the
   review mode or the pop up mode, you can press `e` for edit"* — so `e` is not a
   review-mode key, and the edit surface is reachable from both. That is the one thing the
   split does NOT separate.

31. **Proceed without asking.** Decided 2026-08-23, in the middle of being asked one
   question too many:

   > why do you have to wait for my goal every time, waiting for my go and asking me
   > wastes more token than proceeding on your own

   **This extends decision 24 from COMMITTING to DECIDING.** That one settled that an
   agent does not ask permission to commit; this settles that it does not ask permission
   to act. The default is to act.

   **The economics are the argument and they are not subtle.** A round trip costs him
   tokens to read the question, tokens to answer it, and tokens for the agent to re-state
   the plan before doing the thing — for an answer that is usually "yes, obviously". He
   raised this while on a weekly limit, which is the condition that makes the waste
   visible rather than merely annoying.

   **The line, because "never ask" would be the wrong lesson:**

   ```plaintext
   ACT      anything derivable from his TEMPLATE, from a MEASUREMENT, or from a
            decision already in this file. Implementation, structure, naming, tests,
            fixes to defects, and how a settled decision gets built.
   ASK      taste about the screen he lives in, and anything that changes WHAT HE IS
            DRILLED ON — because that is his study, not the app's behaviour.
   ```

   **The case that produced it is the model.** He asked whether his 数字 clip should play
   on the first side. His template puts `<< Voice >>` there as the only content of the
   side, and the side rendered blank and silent — so the template and a measurement both
   answered it, and asking him to confirm was pure cost. The right move was to fix it and
   say so.

   **The failure mode this replaces is not caution, it is deference wearing caution's
   clothes.** An agent that asks has not reduced the risk of being wrong; it has moved
   the work of being right onto him, and charged him for the move.

32. **The design brief of 2026-09-12 SUPERSEDES decision 23's visual direction.** Zach
   handed over a brief written with another Claude session and said *"we are doing the
   design revolution, it turned out i didn't like what we have now"*. The brief's own
   status line — *"this document supersedes all prior visual direction in this project"*
   — is the authority; this entry records it so the index stays the only place a
   decision counts.

   **What he disliked, verbatim, is the part to keep in view:** it looks confusing, it
   does not encourage him to use the app, **it lacks identity**, *"it feels like the
   person couldn't decide the design and ended up with whatever is 'okay'"*. Decision 23
   is not being corrected on a detail. Its whole premise — dark, mono, terminal — is
   withdrawn.

   **Decision 23 is NOT deleted, and the numbering does not move.** It is cited across
   `src/`, `test/` and the notes, and most of what it settled is about the HAND, not the
   look: controls pinned to the bottom edge, the round replay button bottom-RIGHT because
   he reviews one-handed with his right hand, keycap hints only where a real pointer
   exists and never behind hover, everything on one scroll. **All of that survives.** What
   the brief replaces is the surface: dark ground, monospace, the yellow accent.

   **The one collision between them is the replay button, and the HAND wins.** The brief
   says `border-radius: 0` on buttons and inputs. The replay button is round by decision
   23 for a reason that is ergonomic rather than decorative. It stays round; every other
   control goes square.

   **What the brief settles, and is therefore no longer anyone's to re-propose:** the
   mark (an H built as a ladder in one-point perspective, top rung floating free and
   vermilion, also reading as a torii); the palette (aizome indigo `#1B3B6F`, vermilion
   `#E0451D`, paper `#ECEAE5`, and the rest); Fraunces at `'opsz' 144, 'wght' 650,
   'SOFT' 100, 'WONK' 1` with `+0.005em` tracking; the flat-paper, hairline-ruled,
   square-cornered, shadow-free UI language; and the climb animation at 520 ms,
   easeOutCubic, no overshoot. Its §7 lists seven things already rejected.

   **Three of the brief's claims were checked rather than taken on trust, 2026-09-12:**

   ```plaintext
   the mark's geometry   Every rung endpoint recomputed from the stated rail equation
                         xLeft(y) = 16 + (87-y)*0.20909. All four land exactly on the
                         published path data: 18.09/81.91, 22.27/77.73, 25.83/74.17,
                         31.47/68.53. The numbers are derived, as it says. Do not
                         "clean them up".
   the WONK trap         Real. Subset without `--layout-features='*'` and the emitted
                         woff2 still reports four axes and still renders — it simply
                         stops leaning the `h`, because WONK is delivered through the
                         `rvrn` GSUB feature and the default subsetter drops it.
                         `tools/fonts.py` asserts `rvrn` survives and fails loudly.
   "identical at rest"   Verified, not asserted. After a full climb the mark returns
                         byte-for-byte to the static SVG — every `d`, every stroke,
                         every opacity — with four rungs and no orphaned exit rung.
   ```

   **The stack assumption in the brief's §1 is WRONG, and it changes nothing.** It says
   *"TypeScript / Next.js, deployed on Vercel"* and asks to be corrected. `app/` is
   vanilla TypeScript on Vite, local-first, no server and no deploy — the whole point of
   the project (SPEC problem #3). **No restructuring follows from the brief**, which
   reaches `app/style.css` (268 rules), `app/index.html` and a handful of new assets and
   nothing else.

   **The brief is SILENT on Japanese type, which is the gap that matters most here.** It
   specifies Fraunces for display and `'Avenir Next', Avenir, 'Nunito Sans', 'Segoe UI'`
   for body — a Latin-only stack, and a Latin-only subset range (`U+0000-00FF`). Measured
   over the real corpus: **2,209 distinct codepoints, of which 1,725 are kanji**; kanji is
   5.9% of the corpus by character count and 100% of what is being studied. Under the
   brief as written every head word, every `型` label and every example sentence falls
   through to an unspecified system face. Its own rule — *"where it is silent, ask rather
   than invent"* — applies, and so does decision 31's line, which puts *taste about the
   screen he lives in* on his side. **Rendered side by side in `app/specimen.html`**; his
   call.

   **Dark mode is named OPEN by the brief and it is not a small open item here.** The
   brief says vermilion goes muddy on dark grounds and *"do not ship a guess"*. But the
   app it replaces is dark, and he reviews on his phone. Going light-only is a change he
   would feel on the first night. Also his.

   **THE APP ICON'S COLOURWAY IS NOT IN THE BRIEF, and Zach settled it in two
   passes, 2026-09-12.** §2 fixes the badge at `rx: 15` on a 64-unit square and
   "only the top rung is vermilion" — and says nothing about what colour the badge
   or the mark is there. He chose **ink on a light ground** (not the inverted
   indigo tile), and then, after seeing it installed on his home screen, moved the
   ground from `--paper` to **`--card` `#FBFAF7`**. That second call is measured
   rather than aesthetic: `--paper` is luminance **0.82** against white's 1.00, so
   18% darker. In the app it reads as paper because the whole screen is that
   colour and `--card` sits brighter on top — **paper is paper by RELATIONSHIP**.
   An icon has no relationship; it is one tile alone on a wallpaper, and reads
   grey. `--card` is 0.96, and is the honest token besides: an app tile is a
   raised surface, which is what `--card` means in this design.
   `tools/icons.mjs` keeps the other two reachable by flag so the comparison can
   be re-run rather than re-argued, and `test/pwa.test.ts` pins the shipped ground.

   **Two cells of the brief's palette need a rule attached, measured 2026-09-12:**
   `--muted` on `--paper-sunk` is **4.21:1** — below AA for small text, and `--muted` at
   11-12px is exactly where the captions live. `--vermilion` on `--paper` is **3.47:1**,
   large-text-only, so it is correct for the focus ring, the mark's top rung and big
   numerals, and wrong for any small vermilion text. Everything else clears AA and most
   clears AAA. **This is the same constraint the old stylesheet's header names** — every
   grey in this app carries a Japanese reading at some point — and it survives the
   change of ground.

33. **STAGE 11 SYNC IS DEVICE-TO-DEVICE OVER THE TAILNET, AND TWO OF ITS MERGE
   RULES ARE NOT LAST-WRITE-WINS.** Zach delegated this outright, 2026-09-12:
   *"任せます lol"*, after being given the choice between SPEC's locked Cloudflare
   answer and something smaller. **This supersedes one row of SPEC's locked
   Architecture table and amends another.** Both changes are recorded here because
   SPEC is the authoritative design document and this contradicts it in writing.

   **THE RENDEZVOUS: no cloud. SPEC says `Server — Workers + D1 + R2`, "Two PCs
   need a rendezvous; free tier, nothing to maintain".** That was written before
   the rendezvous existed. It does now:

   * **`tailscale serve` is already built, measured and in daily use** — fixed
     hostname, real TLS, tailnet-only, free, uncapped, verified 2026-09-07.
     `npm run phone` runs it. The laptop is the hub; the phone is the spoke.
   * **It is the choice already made, for the same reason.** `app/README.md`
     picked tailscale over cloudflared and ngrok because it "is the only one of
     the four that is not public, and that is the part worth more than the
     convenience: the other three put a server holding his entire study history
     on the open internet behind an unguessable name." **D1 + R2 would put that
     history on a third party's disk permanently**, which is a larger version of
     the thing that reasoning rejected. Choosing Cloudflare after it would be
     incoherent.
   * **Nothing to keep in step.** No D1 schema shadowing `SCHEMA_VERSION`, no R2
     lifecycle for 657 MB of audio, no account, no secret, no auth.

   **WHAT IT COSTS, said plainly: both devices must be on the tailnet at the same
   time.** A review on the train syncs when he gets home. For one user, two
   devices and an SRS that is acceptable — but it is the real constraint, and it
   is the reason to revisit: **if he ever wants to sync without the laptop being
   on, this decision is the thing to reopen**, not the merge engine, which knows
   nothing about transport. Decision 18's TTS proxy is unaffected — that is a
   separate tiny Worker holding a key, and audio regeneration is deferred anyway.

   **THE MERGE RULES. SPEC locks "bidirectional, field-level last-write-wins".
   That is right for most of the database and WRONG for the two things that matter
   most**, so `src/sync/merge.ts` states a rule per kind of data:

   ```plaintext
   reviews            UNION, deduped on (track, reviewed_at, source). Append-only
                      per track, so it cannot conflict — SPEC's own reasoning, and
                      why no merge can ever lose a grade.
   card_tracks state  LAST REVIEW WINS, not last write. The schedule is a FUNCTION
                      of the last grade. Flat LWW picks whichever device WROTE
                      last, which need not be the one that GRADED last — the log
                      and the schedule would then disagree and the due date would
                      be one the history does not explain. `last_reviewed_at` is
                      the honest clock.
                      RECOMPUTING from the merged log is also wrong: decision 11
                      fuzzes ONCE at grade time, so a replay re-fuzzes and moves
                      dates decision 14 says not to respread.
   archived / pinned  LWW on `cards.updated_at`, and the payload carries EVERY
                      card's flags rather than only the raised ones. The backup
                      exports `WHERE archived = 1 OR pinned = 1` and applies with
                      `max(archived, ?)` — deliberately additive, because a backup
                      must never clear a flag it does not know about. A MERGE
                      must: otherwise he can archive 数字 once and never undo it
                      from the other device. An unarchive is invisible as an
                      absence, so the row has to be present with its clock.
   everything else    Upsert, which `applyLocalArchive` already does.
   ```

   **IT IS BUILT ON DECISION 17's BACKUP RATHER THAN BESIDE IT**, because that
   module already solved the two hard problems: `reviews.id` and `card_tracks.id`
   are local INTEGER PRIMARY KEYs that two devices both hand out, so the archive
   keys every row on `(card_id, kind)`; and apply is idempotent, matched on
   `(track, reviewed_at, source)`. A second copy of that SQL would be a second
   place for the identity rules to drift.

   **ONE KNOWN GAP, recorded rather than papered over.** `schema.sql` says "sync
   is field-level last-write-wins, so the writer owns the clock" — but
   `card_field_values` is `(card_id, field_id, value)` and has NO clock. The
   finest timestamp in the database is `cards.updated_at`, which is CARD level. So
   editing `意味` on the laptop and `例文` on the phone, same card, before a sync,
   is a card-level conflict and one loses. Fixing it is a schema bump, and a bump
   means a full re-import — so it is deliberately deferred to decision 16's ONE
   final import, which is already a scheduled rebuild, rather than forcing a
   destructive re-seed now.

   **THE TRANSPORT IS A MAILBOX, AND IT RELAXES THE CONSTRAINT ABOVE.** Built the
   same day. `vite.app.config.ts`'s `syncMailbox()` stores one JSON file per
   device under `build/sync/` and has no opinion about any of them — **it cannot
   have one**, and that is the finding: the laptop's database lives in the laptop
   BROWSER's OPFS, so the Node process can read it no more than it can read the
   phone's. There is no privileged device and the server is not a peer.

   So **the two devices never have to be up together** — the phone drops its
   payload when it can reach the laptop, the laptop collects it whenever it next
   runs. The "both on the tailnet at once" cost recorded above is therefore
   WRONG, in the good direction; what is actually required is that each can reach
   the server at some point.

   **`decks.archived` had to be ADDED to the payload, and that was his case
   exactly.** Decision 17's archive carries `cards.archived` and no deck state —
   correct for a backup. But `deckOp` archives a deck AND its cards, so a payload
   with only card flags moves half the change: the cards go quiet and the tree
   still shows the deck open. Zach archived the 数字 DECK. "Reuse the backup
   payload" was nearly right and would have shipped a half-sync.

   **ONE BAD PEER MUST NOT STOP THE SYNC — found by accident, which is the best
   kind.** A hand-written test payload was left in the mailbox with `archive: {}`;
   the merge threw, the loop aborted, and the run never reached the push. A peer
   on an older build or a file caught half-written does the same. Each peer is now
   merged on its own and a failure is carried out in the result rather than thrown.

   **THE INDICATOR IS PART OF THE FEATURE, not decoration.** Zach asked for it
   after archiving 数字 twice: *"on desktop it's still not archived, can we add
   icon or any visual to show the sync status"*. The defect was that nothing
   failed — there was no sync and no way to tell. So "never synced" is a state
   with its own look, the dot differs by SHAPE as well as hue (hollow when never
   or stale, filled when synced) because `--good` and `--danger` are isoluminant,
   and a sync older than a day reads stale because his workflow is daily.

   **MEASURED END TO END, 2026-09-12**, with a second device stood in for by
   `scripts/sync-peer.ts`: a 959 KB payload, 7,716 card flags, 39 deck flags; the
   archive crossed, 90 cards and the deck flipped in the browser's OPFS database,
   the tree went from `70 · 90` to `90`, and a second sync of the same payload
   changed nothing.

34. **A REVEAL IS A WALK, NOT A SWITCH: one cloze at a time, then the next side.**
   Zach, 2026-09-12, on the shipped screen: *"when you click reveal, it shows the
   whole thing, the next slide, and the third slide, and every cloze. the correct
   order should be, each cloze in that slide, once every clozes are shown, the next
   side and so on. for the reverse, the cloze are still in the same ascending order,
   just the side reverse."*

   **THIS REVERSES A CALL THAT WAS RECORDED AND ARGUED FOR** — `src/render/reveal.ts`
   carried a header section titled "DO CLOZES ON A SIDE REVEAL INDIVIDUALLY OR
   TOGETHER? TOGETHER, PER SIDE" with three measured reasons. It was never a
   decision of his; it was an agent's, taken in his absence and written up
   persuasively, which is exactly the shape of thing this file exists to distinguish
   from the real ones. Re-examined against his instruction:

   * **"`cloze/indexes` is empty on all 7,716 cards, so nothing is index-grouped"**
     — true, and it never argued for a group. It says the AUTHOR named no groups,
     which leaves the order to the screen. Document order is the order he reads in.
   * **"単語 side 2's two clozes are the same fact written twice"** — this one was
     simply wrong. `{{<<Reference>>}}` is the READING; `{{<furigana><<単語>></furigana>}}`
     is the KANJI with the reading as ruby. On the 3,177 mode-2 cards, where the clip
     is the question, that is the exercise in two steps rather than one: hear
     しょうきゃく, confirm the reading, then meet 償却.
   * **"there is nowhere to record a partial reveal"** — correct, and it stays
     correct. Nothing about a step is graded or persisted; decision 2's binary grade
     is untouched. A step is a thing on screen, not a thing in the schema.

   **PER SIDE still bounds it.** A step never crosses into the next side — revealing
   side 3's cloze while side 2 is on screen leaks the answer to side 2. That was
   always the load-bearing half of the old rule and it survives intact.

   **THE UNITS, and the one place they are not one-per-cloze.** A hidden side's
   arrival and its FIRST cloze are one step. Splitting them would spend a whole
   press on a side whose every answer is still masked — a tap that changes nothing
   he can read. Every further cloze on that side is its own step.

   **A SIDE SOUNDS ITS CLIP WHEN ITS LAST CLOZE GOES**, not its first. So the
   stepped path plays no earlier than the one-shot path did, and decision 29's hard
   rule is untouched — `enter()` still does nothing, and the mode-1 tests still pin
   zero plays on entry.

   **REVERSE NEEDS NO CODE, AND THAT IS MEASURED RATHER THAN ASSERTED.** Sides
   arrive at the planner already permuted and keyed by display position; a side's
   clozes are in document order, which the permutation never touches. Over 40 real
   reverse cards: **40/40 permuted, 320 sides, every one ascending.**

   **GRADING DOES NOT WAIT FOR THE END OF THE WALK.** `revealed` (grade is
   meaningful) turns true on the FIRST step; `moreToReveal` (space has somewhere to
   go) is a separate flag. Conflating them would put the grade buttons on screen
   looking pressable and dead, which is exactly the defect he reported on 2026-09-07
   as *"it won't let me click remember"*.

   **AND IT IS WHAT MAKES THE SECOND CLIP REACHABLE AT ALL.** He reported in the
   same message: *"i still can't hear audio of example sentence"*. The native
   `<audio>` is `display:none` in review, the one visible affordance is the round
   replay button, and that button was nailed at mount time to "the first side with
   audio" — so 単語's example-sentence clip could not be played by any gesture, on
   any card. The button now follows the walk: it plays the clip the current step
   sounded. That also answers his 2026-09-12 question *"a single play button where
   we couldn't distinguish which audio to play shouldn't work right?"* without
   adding a second control — the step says which clip is current, so the button does.

   **THE OTHER HALF OF THAT COMPLAINT IS NOT A UI BUG AND IS NOT FIXED HERE.**
   Measured over the shipped seed: **5,044 cards carry two or more clips and 36 of
   them (0.7%) have all of them on the device.** `scripts/app-bootstrap.ts` spends
   its 200 MiB taking each card's CHEAPEST clip first, deliberately, so that no card
   gets a second before every card has a first — and a card's second clip is the
   example sentence. Covering every card's second clip costs **613 MiB** against the
   store's 619 MiB total: there is no cheap middle, because the sentence clips ARE
   the bulk of the store. So hearing example sentences is a re-bootstrap at
   `--speech-bytes 650000000` and a one-time ~620 MB download per origin, which is
   his call and not an agent's.

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
