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

   **AMENDED 2026-09-28 — PUSHING IS NOW AUTHORISED, AND THE REMOTE EXISTS.** He asked
   for a private repo on the `wmCmo` GitHub account (*"use wmcmo gh account, not
   zach-ct"*), it is `https://github.com/wmCmo/hashigo`, and then: *"yeah push as you
   go"*. So a commit that passes the gates is pushed to `origin main` as part of making
   it — tags too, with `git push origin --tags`. **Still NOT authorised:** force-pushing,
   rewriting pushed history, and pushing from the `zach-ct` account. Before a push that
   adds a new tracked file, remember what `.gitignore` is for: `.env`, `build/`,
   `exports/` and the databases never go up.

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
   **AND THE FIRST NUMBER PUT HERE FOR IT WAS MEASURED AGAINST THE WRONG TABLE** —
   it said "5,044 cards carry two or more clips, 36 (0.7%) have all of them", from
   counting `blob_refs` rows whose `ref_key` ends `.mp3`. Those are the ATTACHMENT
   clips. The clips on a 単語 card are `generator` mounts addressed by GENERATION
   IDENTITY, and counting the other table answers a different question. Re-measured
   by walking real cards against the shipped seed, which is the only basis that
   proves anything:

   ```
   単語   396 of 400 sampled cards carry two clips
          the word clip     plays on 393  (99.2%)
          the sentence clip plays on   0  ( 0.0%)
   言葉   365 of 376
          the word clip     plays on 357  (97.8%)
          the sentence clip plays on   2  ( 0.5%)
   ```

   So it is not "rarely", it is **never**, and the corrected figure is worse than
   the wrong one. `scripts/app-bootstrap.ts` spends its 200 MiB taking each card's
   CHEAPEST clip first, deliberately, so that no card gets a second before every
   card has a first — and a card's second clip is the example sentence.

   **What it would cost, measured by proxying the blob store and recording what each
   side's clip actually resolves to, over all 5,536 clip-bearing cards:**

   ```
   first clips   5,279 blobs   212 MiB   <- what the 200 MiB seed buys
   later clips   4,359 blobs   346 MiB   <- disjoint: shares nothing with the first
   both          9,638 blobs   558 MiB
   ```

   The two sets do not overlap at all, so there is no cheap middle: hearing example
   sentences costs **+346 MiB**, a seed of ~558 MiB, and a one-time download of that
   size per origin.

   **DONE 2026-09-12, after he reported it a THIRD time — and "his call" was the
   wrong framing, because half the defect was ours.** Rebuilding at
   `--speech-bytes 650000000` would not have reached him on its own: the freshness
   check was entirely about the CARD database, `seedReviews` is deliberately a
   number local grading cannot move and a seed carrying three times the audio has
   exactly the same one, and `ensureFile` skips any file OPFS already holds — in
   green, saying *"already in OPFS — not re-fetching"*. Both devices would have
   played the old subset for ever. Offering him a download he could not actually
   take delivery of was not a decision to hand over.

   So the audio file got its own comparison, on `blob_store_meta.created` — one
   row, written fresh by the blob store's DDL on every bootstrap, so it changes
   exactly when the file does. `count(*)` over `blob_payloads` answers the same
   question by walking every overflow page of a 640 MB file. The rule is
   `audioIsStale()` in `app/seed-freshness.ts`, import-free so `test/` reaches it,
   and the arm that must NOT fire is pinned: an older manifest with no such field
   changes nothing, because treating it as a mismatch re-downloads 640 MB on every
   boot for ever. Replacing the store destroys nothing — content-addressed, opened
   `{ create: false }`, no grade or card in it.

   Measured end to end in the browser: the boot log said *"the audio here was built
   2026-09-08T01:58:28.378Z and the server is serving 2026-09-12T12:11:02.236Z —
   re-fetching it"*, fetched 640.7 MB, **left the card database alone so his 12
   local grades survived**, and came up on 10,826 payloads. Coverage **5,710 of
   5,710 cards (100.0%)**. On four consecutive 単語 cards both clips reached
   `data-audio-state="playing"` — the word AND the example sentence.

35. **TYPE SIZE FOLLOWS THE CONTENT, NOT THE POSITION.** Zach, 2026-09-12, with a
   screenshot of a reverse 単語 track: *"this ui is kinda funny, i think it's correct
   that the 漢字 has the big text because it's short, but when it's reverse, why is
   漢字 small and the definition big...? this is super ugly lol"*

   **The old rule was positional and it was never really a typographic decision.**
   `main.ts` marked the QUESTION side `.drill`; the stylesheet gave that side
   `clamp(26px, 7vw, 40px)`. On a forward track the question is the head word — one
   to three characters — so it LOOKED like "the head word is the biggest thing on
   the screen". It was "the first side is big", and a reverse track puts a
   six-synonym English definition there.

   **And the second half of his sentence is the sharper half:** it also made the
   kanji SMALL. On a reverse track the word sits on a later side, which was body
   text, so the one thing on the card that earns display type was the one thing not
   getting it.

   **His own sentence states the rule — *"because it's short"*.** So it is measured
   length, in CODE POINTS, applied to EVERY side in both directions; reverse then
   needs no special case at all. `sideScale()` in `app/review-boundary.ts`:
   **≤28 display · ≤64 mid · above that body.**

   **THE THRESHOLD IS MEASURED, not chosen to look principled.** Rendered
   `textContent` length of the question side over 1,200 cards in both directions:

   ```
                         p10   p50   p90   max
     単語      forward      2    12    18    26
     単語      reverse     28    60   155  1027
     漢字      forward      1     1     1     1
     漢字      reverse     54    75   100   147
     言葉      forward      8    11    14    16
     New Vocab forward      4     7    10    20
     New Vocab reverse     34    61   107   168
     基本情報   forward     26    41    72   170
   ```

   Every forward vocabulary prompt fits in 26 characters and 90% of reverse prompts
   start at 28, so **28 separates the two groups with nothing sitting on the line**.

   **基本情報 IS THE REASON THIS IS A LENGTH RULE AND NOT A DIRECTION RULE.** Its
   FORWARD prompts run to 170 characters and have been rendering at 40px all along —
   the same defect, in the direction the old rule assumed was safe. He had not
   complained about that deck; the rule that fixes reverse fixes it too. A rule keyed
   on `direction === "reverse"` would have left it broken and looked correct.

   **`mid` is not decoration.** Without it a 40-character definition drops straight
   from 40px to 17px beside a head word, and the two read as different cards.

   **`.drill` is still set** — which side is the question is a real fact and
   something will want it. It just no longer decides how big anything is.

   Verified on his own card (判断, reverse): definition 15px body · example sentence
   19px mid · 判断 26px display.

36. **ONE PLAY CONTROL PER CLIP, BESIDE THE CLIP — and the round button follows
   the walk.** Zach, 2026-09-12: *"we only have 1 play button, what if i have two
   audio like this and i wanna replay the first one or the second one... what's the
   best ui?"*

   **The round button bottom-right does not move.** Decision 23 put it there for his
   right thumb and that is unchanged; what changed is that it now means "again" for
   the clip the reveal last sounded, rather than being nailed at mount time to "the
   first side with audio" — which is what made 単語's example-sentence clip
   unreachable by any gesture at all.

   **The answer to "which one" is not a picker, it is to stop making the clip
   anonymous.** Every clip already sits on the side that owns it: the word clip on
   the side with the word, the sentence clip on the side with the sentence, sides
   separated by hairlines. A small square button in that line needs no label,
   because the line IS the label.

   **Why not just unhide the native `<audio controls>`** — it is in the DOM and the
   loop already arms it, so it would have been one CSS line: the renderer leaves
   media elements with no `src`, so the native control is inert until bytes are
   bound and a dead transport bar is worse than none; it is full-width with a seek
   bar and a volume slider and puts play at the FAR LEFT, the worst corner for the
   thumb decision 23 is built around; and it cannot show "playing" or "not on this
   device". The clip button is 34px, which is under the 44px touch target `.replay`
   meets — a deliberate trade, because it sits inside running text where a 44px box
   would push the lines of a card apart. The thumb-sized control for the common
   case is still the round one.

   **A BUG FELL OUT OF ASKING THE QUESTION, and it was live.** `ShadowingSide.play`
   unmasked the side unconditionally — *"sound implies revealed"*, which is right
   for an ANSWER clip and exactly backwards for a QUESTION one. Decision 29
   deliberately makes the replay button available BEFORE the reveal on the 3,177
   mode-2 cards, so he can hear the question again. Measured in the browser: on a
   mode-2 card, one press of replay took the side's clozes from `hidden,hidden` to
   `revealed,revealed` while `data-state` still read `prompt`. The kanji was on
   screen and the screen still thought it was asking. That is the defect the hard
   rule exists to prevent, arriving through the one control allowed past it.

   `play(mount, { unmask: false })` is the fix: a caller that knows the clip is
   still the question gets `prompt()`'s contract — sound, nothing unmasked — and it
   degrades to the ordinary path once the side IS revealed. `replay()` now always
   passes it, because "again" is the same act as last time and never a bigger one.
   The default is unchanged, so the armed native element still unmasks; only the
   two callers that know better opt out. `test/reveal.test.ts` had a test asserting
   the OLD behaviour ("treats a replay asked for before the reveal AS the reveal"),
   written before `prompt()` existed and justified by "otherwise there would be a
   second route to sound that left the clozes masked" — which is now the whole
   point of mode 2. It is rewritten, with the measurement in it.

37. **FURIGANA IS FILLED, THROUGH `src/render/ruby.ts`, AND ONLY BEHIND A MASK.**
   Zach, 2026-09-12, over a head word wearing a floating em dash: *"why is the text
   coming out like that bro😭"*

   **Three separate things were wrong and each hid the next.**

   **(a) Nothing ever filled a furigana.** `src/review/text.ts` excluded it on
   purpose — the reading is the ANSWER on a `Reading = true` card (decisions 20 and
   29) — and the note said the template "happens to wrap it in a cloze today, so
   filling it would probably be safe". The caution had a cost nobody priced: an
   unfilled `<rt>` is an EMPTY `<rt>`, and `ruby rt:empty::after` drew an em dash
   over every head word in the corpus. The mark meant "this word has no reading"
   and had never once been true.

   **And "probably" was wrong.** Measured, both directions: **6,754 furigana
   mounts, 42 outside a cloze, all 42 on `produce` cards** — 21 real cards where
   filling would have printed the answer on the question side. So the guard is
   structural: `GeneratorMount.inCloze`, recorded by the renderer while it builds
   the cloze's answer subtree, because the cloze does not exist yet when its
   children are made and the question has no answer afterwards. **The guard is on
   furigana ALONE** — applying it to all four kinds would be a neater sentence and
   would undo decision 34's fix, since 単語's example sentence is an `ai` generator
   in a `<blockquote>` with no cloze near it.

   **(b) A furigana generation does not hold a reading.** It holds the INPUT with
   Mochi's bracket annotation written into it: the value filed under `野菜` is
   `野菜(やさい)`. The first fill appended that straight into the `<rt>`, and the
   browser showed 野菜(やさい) sitting over 野菜. `readingOf()` unwraps it.

   **(c) `src/render/ruby.ts` WAS NOT WIRED INTO THE SHIPPING RENDER AT ALL** —
   built, tested, and dead on the only path that matters. The core renderer emits
   one base and ONE `<rt>`, which spreads the whole reading over the whole word:
   `めぐる` across `巡る`, `る` over `る`. **1,034 of 3,242 furigana generations
   (31.9%) have a base mixing kanji and kana**, so a third of every reading would
   have been visibly wrong the moment they started being filled. `mountPrepared`
   now renders through `furiganaSupport`, whose skeleton is one `<rt>` per base RUN
   — and it has to be built at render time, because the DOM port has five
   operations and `removeChild` is not one of them.

   Measured over 120 real 単語 cards: **120 annotated, 115 aligned run by run**, no
   bracket anywhere in an `<rt>`. On his own cards: 山頂 with さんちょう over it,
   見舞(みま)い with the reading over the kanji and the kana tail bare.

   **The em dash got two exclusions rather than a deletion.** Not on a `pending`
   ruby — that is "the fill has not come back yet" or "withheld on purpose", and
   neither is "no reading". Not on a `segmented` one either, and that one would
   have been a NEW bug: run-by-run alignment leaves the kana tail's `<rt>` empty
   BY DESIGN, so 見舞(みま)い would have grown a dash over the い.

38. **A KEYCAP HINT TAKES THE COLOUR OF WHAT IT SITS IN — and the contrast check
   had a hole the shape of a filled button.** Zach, 2026-09-12, over a screenshot
   of `reveal` under his cursor: *"`space` is a little hard to read don't you think?
   is there any other place that suffers like this?"*

   Yes, and one of them was worse than the one he found.

   **THE DEFECT.** `.kbd` was `var(--muted)` — a grey chosen against PAPER — and
   the buttons it sits in fill solid indigo on hover, on press, and in one case at
   rest. Measured in both themes:

   ```
   --muted on --indigo         1.76:1 light    1.05:1 dark
   --muted on --indigo-deep    2.31:1 light    1.50:1 dark
   ```

   **1.05:1 is the same luminance — not dim, gone.** And `remembered` is a solid
   fill AT REST (decision 32 made it the primary action), so its `j` hint failed
   permanently rather than only under a cursor. His screenshot happened to catch
   the hover case on `reveal`; the worse one was sitting beside it the whole time.

   **THE FIX IS `color: inherit`, NOT A BETTER GREY.** Any fixed token is wrong for
   at least one ground, because the hint lands on paper AND on indigo — so it takes
   the button's own label colour, and a control that starts filling in some future
   state cannot reintroduce this. The de-emphasis is `opacity`, and **0.85 is a
   measured floor**: the worst pairing (dark, filled) is 4.88:1 there and 4.43:1 at
   0.8, under AA for 11px text. Size and position carry the rest of the hierarchy.

   **TWO MORE, FOUND BY SWEEPING RATHER THAN BY LOOKING.**

   * **`.kbd-inline` had no rule at all.** Not de-emphasised, and — the part that
     matters — **not gated on a pointer**, so `pin ⇧p` / `undo ⌃z` were rendering
     on his phone, naming keys that device does not have. That is decision 19
     being violated by an element nobody had styled. Both forms are behind
     `(hover: hover) and (pointer: fine)` now, and verified hidden at 375px.
   * **`--line` was a SURFACE under text.** `.menu-item i` and `.link-item i` are
     `--muted` subtitles at ~12px on rows whose hover ground was the HAIRLINE
     token: **4.04:1 in light**. `.link-item i` is the deck path — how he tells
     蟻-as-単語 from 蟻-as-言葉 apart while picking a link. Moved to `--sunk`, the
     recessed-row ground every other hovered row already uses, which takes the
     same text to 4.76:1. `.link-item` gained an indigo edge so the hover signal
     does not depend on the fill alone.

   **WHY `test/contrast.test.ts` DID NOT CATCH ANY OF IT.** It checks every
   foreground token against the three PAPER grounds. That is the right check for a
   card and it is blind to an element that paints itself a non-paper background
   while its CHILDREN keep their own colour. It now also pins the pairings that
   occur on a filled ground, in both themes, plus two STRUCTURAL rules that stop
   the class rather than the instance: `.kbd`/`.kbd-inline` may not name a colour
   token at all, and `--line` may not be a background except for three exceptions
   named with their reason (two progress tracks, which carry no text, and the ⋯
   chip, which must stand out from a row whose own hover ground is `--sunk`).

39. **THE RESET ZEROES EVERY BOX; A CARD'S BLOCK ELEMENTS NEED A RULE BEHIND IT.**
   Zach, 2026-09-12, over a 意味 side reading `1. moving out (to)` /
   `2. transfer (to a new post)`: *"the definition padding is still weird"*.

   **There was no list rule at all.** `* { margin: 0; padding: 0 }` at the top of
   `app/style.css` is correct and deliberate — but a list with no padding still
   renders its markers `outside`, so the `1.` and `2.` painted to the LEFT of the
   content box, into the card's own 16px padding, aligned with nothing else on the
   card. The reset was right; what was missing is the rule it resets FOR.

   **It is not a corner: 1,424 field values in the corpus are lists**, which is
   most 意味 sides. `padding-left: 1.4em` puts the marker inside the column and the
   text on a hanging indent, so a definition that wraps on a phone lines up under
   itself rather than under its own number. In `em` so it tracks decision 35's type
   scale rather than fixing a pixel that is wrong at 40px and wrong again at 15px.
   The bottom margin matches `p` — a card is one flow, and a list that spaced
   differently from the paragraph above it read as a second card.

   **THE SAME RESET HAD EATEN TABLES.** Zero cell padding, no borders: run-together
   text. **One card in the corpus has a table**, which is exactly the kind of thing
   nobody finds until they are mid-review on it, and three lines is cheaper than
   that. `<pre>` is deliberately left alone — **zero code fences exist in the
   corpus**, and `.hashigo-code` already covers the inline form.

   **THE TEST READS THE RENDERER, NOT A LIST WRITTEN BY HAND.**
   `test/contrast.test.ts` now extracts every tag inside a `context.element(...)`
   call in `src/render/nodes.ts` and requires a `.hashigo-side` rule for each, with
   an exemption table where every entry names its reason (inline elements, grouping
   boxes that paint nothing, and the `hashigo-`-classed ones). A renderer that
   learns a new element fails this until the stylesheet catches up — which is the
   only moment anyone would think to look. Scoping that extraction to the CALL
   mattered: a first version matched `"image"` and `"inline"` out of an unrelated
   media-kind ternary and reported them as unstyled elements.

40. **THE MOCKUP'S TWO REAL CONTRIBUTIONS: CONTROLS FOR THE DRILL, AND A
   DESKTOP THAT WAS NEVER BUILT.** Zach handed over `hashigo-card-controls.html`
   on 2026-09-12 — *"i think this mock up has a very good design, should we
   incorporate everything into our design? or do you think there are things we
   could improve?"* — and then the question that mattered: *"what about the rest
   of the aestheticness of the design that we don't have yet? i know you can't
   'see', but i don't know how to let you understand that that session generated
   something more beautiful than what we have lol"*.

   **THE BEAUTY GAP WAS MEASURABLE, AND IT WAS NOT COLOUR OR TYPE.**
   `app/style.css` had **no width breakpoint above 640px** — every `@media` in
   the file was dark mode, reduced motion, pointer detection, or
   `max-width: 640px`/`520px`. So the review screen was a 720px column between a
   full-width sticky header and a full-width fixed footer: a phone layout
   stretched across a laptop, with several hundred pixels of empty paper down
   each side. He reviews on the laptop when he is home. Offered the choice, he
   picked **the composition** and neither of the other two candidates (the card
   as a bounded raised surface, more air).

   **ONE TOKEN DRIVES THE LAYOUT.** `--rail-w` is what the rail takes OUT of the
   page and is `0px` until ≥1024px; `--rail-width` is the sidebar's own 330px at
   every size, because it is the same element sliding or standing. `body {
   padding-left }` carries normal flow. **The six `position: fixed` rules do not
   all want the same treatment**, and that is the point: `.footer` offsets,
   `.say` offsets *and* re-centres (`left: 50%` is the viewport's middle and
   `max-width: 100%` its width), `.replay` needs nothing (anchored right),
   `.sidebar` IS the rail, `.sidebar-scrim` never shows there, and **`.layer`
   deliberately keeps `inset: 0`** — a preview's scrim must cover the rail, and a
   modal with a live deck list behind it is not modal.
   **`contain: layout` on a stage wrapper was the alternative** and it needs no
   enumeration at all: fixed descendants resolve against the stage. Rejected —
   it confines `.layer` too, with no opt-out, so it gets one of six certainly
   wrong. `test/contrast.test.ts` classifies every fixed rule instead, because
   **hand-enumeration already failed**: the first draft named `.banner` (not
   positioned at all), `.sidebar-scrim` and `#layers` as needing the offset and
   gave `.say` the wrong formula — four of five wrong before a line was written.

   **THE CONTROLS LINE UP WITH THE CARD, NOT THE WINDOW.** `.ops`, `.shadowbar`
   and `.bar` are flex rows of `flex: 1` children, right on a phone where the row
   IS the thumb target and wrong at 1110px — four buttons at 267px each under a
   720px card. Inset to the card's own text column (720 − 2 × 16 = 688px), with
   the grounds and hairlines still spanning the footer. The 688 is **read out of
   `main` by the test** rather than retyped, because two places holding one
   measure is how text and buttons drift a few pixels apart with no single change
   to blame.

   **CARD OPERATIONS MOVED BEHIND `⋯`, AND ONE RULE WAS MISQUOTED TO GET THERE.**
   An earlier draft justified the old always-visible row with "his standing rule",
   and he caught it: *"i never state this rule?"* What is recorded, in four places
   in `app/main.ts` and `app/index.html`, is **every 操作 on the desktop exists on
   mobile**, as a real button and not only a shortcut — which a menu on both
   surfaces satisfies. Measured first: **0 of 7,716 cards are pinned** (the column
   is imported from Mochi, so that is four years without pinning once — evidence
   about Mochi, not a prediction) and 244 archived, against a replay he presses
   every card. `delete` two buttons from `undo` in his right thumb's zone did not
   earn the room. **UNDO STAYS OUT of the menu** — it is the safety net, and the
   thing you reach for when something has already gone wrong does not belong
   behind two taps. The presentation is `openDeckMenu`'s existing modal
   `.layer-menu`, **not** the mockup's popover-plus-bottom-sheet: two new
   presentations to build and keep in step, and `⋯` on a card landing in a
   different kind of object from `⋯` on a deck. Side effect worth recording: at
   375px the row stopped wrapping to two lines, `--footer-h` 162px → 139px.

   **THE SHADOWING CONTROLS ARE THE OTHER HALF, AND THE CORPUS PICKED THEM.**
   1,200 speech blobs, MP3 frame headers parsed:

   | | n | p50 | p90 | max |
   |---|---|---|---|---|
   | isolated word (source ≤ 8 ch) | 551 | **1.63s** | 1.80s | 2.59s |
   | example sentence (> 8 ch) | 649 | **4.08s** | 6.10s | 25.44s |

   12 of 1,200 (1.0%) run past ten seconds. **A 1.63s clip is a thing you loop,
   not a thing you seek inside** — which killed the mockup's scrub bar (a seek
   target smaller than the gesture that would use it) and made the case for loop
   and rate. What the 1% needs is "is this still running", not "take me to 0:14",
   and a 2px hairline under the clip button answers that. He chose it over both a
   full scrub bar and nothing, shown all three side by side.

   **0.5× IS DELIBERATELY ABSENT AND IT IS THE ONE REAL RISK IN THIS CHANGE.**
   Rate change on an `<audio>` element is a phase vocoder: time stretched, pitch
   held — exactly what is wanted, since the accent IS the F0 contour and a rate
   that transposed it would be worthless. But the stretch smears rapid
   transitions, and **the downstep is a rapid transition**. It is the fact being
   trained (decision 27: on 2,148 cards `型` is the only thing carrying it).
   0.75× is mild; 0.5× is where artifacts land on the one feature that matters.
   `preservesPitch` is set EXPLICITLY rather than left to the default for the
   same reason — every current browser defaults it true, and a false one would
   drop 0.75× playback about 2.5 semitones.

   **THE TAKE IS EPHEMERAL, AND THAT IS A DECISION.** In memory, revoked when the
   card changes, so decision 17's backup and decision 33's sync have nothing to
   say and no schema moves. Keeping takes — to compare his July self against his
   September self — is a real feature and a separate decision. **It never touches
   the audio path**: playback goes through a private `<audio>`, never
   `audioController`, so it cannot set `drill`, retarget the round replay button,
   or appear in `card.loop.log` — the log the hard-rule tests read. It plays at
   the REFERENCE's rate, so the comparison is like for like rather than a
   comparison of tempo. Capture is `{ echoCancellation: true, noiseSuppression:
   false, autoGainControl: false }`: the last two are tuned for a phone call, and
   AGC flattening dynamics on a pitch exercise is the wrong processing. Stopping
   the recorder **stops the tracks**, or the phone's recording indicator stays on
   for the rest of the session — accurately, which is the problem. A **generation
   counter** exists because `MediaRecorder.stop()` finishes asynchronously:
   without it, leaving a card mid-recording lands the 転出 take on 償却.

   **NOTHING SOUNDS WHILE THE MICROPHONE IS OPEN.** He reviews on a phone, on its
   own speaker; a take recorded over a playing clip contains that clip, and
   comparing his contour against a mix of itself and his own voice is not weak
   feedback, it is confidently wrong feedback about the thing he is training.

   **DECISION 29 IS UNTOUCHED, STRUCTURALLY RATHER THAN CAREFULLY.** `l` and `s`
   write two numbers, `m` opens a microphone, and none of the four new keys can
   reach `audioController`. All of them work BEFORE the reveal, which is the
   point — setting the rate and arming the recorder belong to the half of the
   drill that happens while the answer is still hidden. Re-measured: putting
   `play` inside `enter()` turns **25** tests red across `test/reveal.test.ts` and
   `test/review.test.ts`. Browser-measured over a real mode-2 card: `s` → the
   element's `playbackRate` 0.75 and `preservesPitch` true, `l` → `loop` true,
   hairline filling, `data-state` still `prompt` and the clozes still `[…]転出`.

   **WHAT WAS REJECTED FROM THE MOCKUP**, each against something already
   recorded: one global player per card (decision 36 — the bug he reported that
   morning); `Reveal` as a switch (34); a fixed 27px centred prompt (35, and 39
   for the 1,424 list values); `--hair` as a hover ground (38 — measured at
   3.57:1, with its menu shortcut at 4.21:1, the cell decision 32 already
   flagged); keycap hints rendered unconditionally, including in its own mobile
   view (19); a Latin-only stack loaded from a Google Fonts `<link>` (the app
   self-hosts, and offline is the point); light-only; and grade keys `1`/`2`.

41. **THE FINAL IMPORT HAS HAPPENED, AND THAT RETIRES A JUSTIFICATION.**
   Zach, 2026-09-13, asked whether to bump the schema now or fold it into
   decision 16's last Mochi import: *"what we have now is already the final
   import, i won't import anymore (unless we genuinely lost everything here
   ofc)"*.

   Decision 16 always said "one final import, then never again". What was not
   recorded is WHICH import, and every plan since has quietly assumed one more
   was coming — including, on the day he said this, my own recommendation to
   defer a schema change until it. **The 2026-09-08 import was it.**

   **THE CONSEQUENCE IS NOT ABOUT IMPORTING.** `CLAUDE.md`'s "A schema bump means
   RE-IMPORT, not migrate" rests on two clauses, and the second one just died:

   > every database here rebuilds from `exports/` in about fifteen seconds
   > **and the reviews still come from the export**

   They no longer do. Hashigo's own grades — 56 on his current device, 43 on the
   other, as of 2026-09-13 — exist in OPFS and in the sync mailbox and nowhere
   else. `exports/` cannot reproduce them. So "rm the database and re-import" has
   stopped being the free, lossless reset the architecture was built around, and
   a schema change now has to answer for the live history BEFORE it runs.

   **What still carries that history:** decision 17's backup and decision 33's
   sync payloads, both of which stamp `archive.schemaVersion` (currently 9). They
   are therefore part of any migration, not an escape from it — a restore across
   a version bump needs its own answer.

   **AND IT RAISES THE PRIORITY OF THE BACKUP.** Decision 17 called an export
   "not day one, but required before he trusts the app". As of this date the only
   copies of his Hashigo history are two browsers' OPFS and three JSON files
   under `build/`, which is gitignored. That is now the weakest link in the
   project and it is not the audio.

42. **`remembered` WAITS FOR THE END OF THE WALK; `forgot` DOES NOT.**
   Zach, 2026-09-13, one message after asking for the button reorder: *"you
   don't know if you actually remember the card until you're at the last slide,
   so maybe we don't even need remembered button when we still have next
   button"*.

   **THE ARGUMENT IS AN ASYMMETRY, AND IT IS SOUND.** The two grades are not
   two halves of one question that unlocks at one moment. `forgot` is settled
   by a SINGLE failure — the first cloze that contradicts him ends it, and no
   later side can un-fail it. `remembered` is a CONJUNCTION over every side of
   the card, and a conjunction is not settled until its last term is up.
   Offering it mid-walk asks a question that has no answer yet.

   **THIS AMENDS DECISION 34, WHICH SAID GRADING DOES NOT WAIT FOR THE END OF
   THE WALK.** That clause stands for `forgot` and is withdrawn for
   `remembered`. Decision 34's reasoning was not wrong about the danger it was
   avoiding — it was avoiding the 2026-09-07 defect, *"it won't let me click
   remember"*, where the grade buttons sat on screen looking pressable and did
   nothing. **The repair here is the opposite shape, and that is why it is not
   that defect returning:** the button is taken OFF SCREEN rather than left up
   and inert, and `j` answers with what is missing (`3 more to see — space,
   then j`) rather than with silence. Nothing on screen claims to be pressable
   and refuses.

   **The sentence this replaces was an agent's, not his, and was never
   measured.** `app/style.css` carried *"he is allowed to answer before the
   walk is finished and usually will"* and `app/review-keys.ts` carried *"he
   knows whether he remembered the moment the reading appears"*. Both are
   claims about HIS cognition, written by a session that could not observe it,
   and he has now contradicted them directly. Nothing in the schema records at
   which step a review was graded, so there is no data on either side — which
   is itself the finding: the old rule was an assumption wearing the voice of a
   decision.

   **WHAT IT COSTS, MEASURED.** 961 tracks sampled every 13th from the
   unarchived corpus, reduced exactly as `app/main.ts` reduces a mounted card
   before calling `revealSteps`:

       steps in the walk    0:1   1:1   2:165   3:263   4:482   5:47   6:1   8:1
       >= 2 steps (so the rule bites)      959/961 = 99.8%
       extra presses before a pass, mean        2.43
       単語 n=522 median 4 · 漢字 n=235 median 2 · New Vocab n=92 median 3
       言葉 n=54 median 3 · 基本情報 n=47 median 2 · 数字 n=7 median 2

   So this is not a corner case: it reaches essentially every track, and on 単語
   — the accent drill, the reason the project exists — it is a median of three
   presses between the first reveal and a pass. **That cost is only real if he
   was passing early**, which is the practice he has just said he does not
   have. If he ever wants the shortcut back, 2.43 is the number it is worth.

   **A one-step card never enters `revealing` at all** (`prompt` straight to
   `revealed`), so it is untouched — 2 of 961.

   **THE LAYOUT INVARIANT IS THE OTHER HALF, and it finishes the mistap fix
   from earlier the same day.** With `remembered` absent mid-walk the row is two
   equal halves in both states:

       revealing    forgot | next
       revealed     forgot | remembered

   measured at the pane width as `forgot 12–483 | next 493–985` then `forgot
   12–494 | remembered 504–985`. **The left half is always `forgot` and the
   right half is always proceed**, so his thumb learns one map instead of
   tracking a row that reshuffles under it. It also retires the old three-across
   constraint that forced `next` to shrink to its text so `remembered` would not
   wrap at 375px.

   `f` mid-walk and `j` mid-walk are asserted TOGETHER in
   `test/app-keys.test.ts`, because the failure mode is a later session
   "restoring symmetry" and taking `forgot` down with it — which WOULD be the
   2026-09-07 defect.

43. **THE EXAMPLE SENTENCE CARRIES ITS OWN PITCH ACCENT, PER MORA — `<ojad>`.**
   Zach, 2026-09-13: *"do you think it's possible that we can add field type
   called OJAD? … we will feed in the example sentence, which will get turned
   into all ひらがな, and for each hiragana, if it's accented … then 開 would be
   in our red, and if it's devoiced like しま~し~た, then し would be blue, or
   gray … so that while reading the example sentence i can see hear how it's
   pronounced and confirm by looking at the field"*.

   **IT IS NOT A FIELD TYPE, AND THAT IS THE ONLY PART OF HIS REQUEST THAT
   CHANGED.** `template_fields.type` is a CHECK constraint, so adding `'ojad'`
   is a schema bump — and decision 41, recorded the SAME DAY, made those
   expensive: the final import has happened, so `rm` + re-import is no longer a
   lossless reset. The escape was already in the codebase and documented:
   `nodes.ts` says of a generator that has existed since stage 4, *"`pinyin` has
   no row in `BLOB_KINDS` and therefore no request; it still renders its base
   text."* A generator element needs a renderer and nothing else. So `<ojad>` is
   an ELEMENT (one line in `ELEMENTS`, the parser's allowlist, not the schema)
   filled from a `local = 1` field of type `plain` — the `型` pattern, which the
   schema's own comment says was chosen in stage 1 to avoid *"a migration over
   7,716 cards"*. Zero schema change.

   ─── WHAT THE ANALYSER GIVES, INCLUDING ONE THING NOBODY HAD NOTICED ───────

   **DEVOICING IS FREE.** OpenJTalk writes a devoiced vowel as an UPPERCASE
   phoneme, in the same full-context labels `tools/accent.py` has been parsing
   for accent since stage 6:

       しました   sh i m a sh I t a      the second し
       学生です   g a k U s e e d e s U  both く and す

   So the second half of his request cost one `isupper()`. No new tool, no new
   model, no extra call.

   **SENTENCE ACCENT PHRASES WORK, on the boundary rule already validated.** A
   mora is keyed by `(i3, f5, a2)` — breath group, accent phrase, mora position
   — so phonemes group into morae by their own label and nobody counts kana.
   `に引き換え`, the case that breaks the naive "a2 reset to 1" test, comes out
   correctly as (1,1)(4,4).

   ─── 平板 IS `accent == morae`, AND THIS TRAP HAS NOW BITTEN TWICE ─────────

   `CLAUDE.md` has recorded since stage 6 that *"the naive `if accent > 0` rule
   fires on 100% of his bare words and would drill 2,065 phantom 尾高"*. The
   first cut of this feature reproduced it exactly, at sentence scale, and it
   looked entirely plausible on screen:

       鼻が (3, 3)  accent on the LAST mora -> 平板, no drop, NO MARK
       花が (3, 2)  accent strictly inside  -> 尾高, drops after な
       私は (4, 4)  -> 平板

   ZERO phrases in real sentences report `accent = 0`, so marking the last mora
   painted **21.1%** of all morae — every flat phrase red. The correct rule gives
   **13.9%**. The probe particle that solves this for bare words cannot be used
   here, because a sentence already has a following word.

   **The upside is the mirror of decision 27 and is the reason this is worth
   having.** 平板 and 尾高 are physically indistinguishable inside a bare word,
   which is why `型` is their sole carrier on 2,148 cards. In a SENTENCE the
   particle is already inside the accent phrase, so the two separate — 花が marks
   な, 鼻が marks nothing. **This field shows him something the word audio
   physically cannot.**

   ─── MEASURED OVER THE REAL CORPUS ────────────────────────────────────────

       3,740 cards with an 例文 field -> 3,719 sentences, 3,712 distinct
          11  no generation in the store
          10  refused: no Japanese, or latin woven in
       3,711 / 3,712 annotated (99.97%)
         1   refused — 彼は青いＹシャツを着ています。 (fullwidth latin)
       86,627 morae · 13.8% accent heads · 5.7% devoiced

   **An earlier figure in this session said ~10% of 例文 were dirty. That was
   measured over `blobs` and was wrong for this purpose** — it counted stale
   generations no live card references. Through `fieldGenerationRequest` +
   `resolveDescriptorText`, which is how the SCREEN resolves the field (decision
   7), it is 10 of 3,719. The same correction killed a `LIKE` join over
   `source_text` that reported 17,499 sentences for ~5,700 cards, because the
   prompt embeds the head word and a short word is a substring of many prompts.

   ─── COLOUR: RED FAILS AS AUTHORED, AND BLUE IS TAKEN ─────────────────────

   He asked *"blue, or gray? which one is easier to understand?"*

   `--vermilion` is **3.99:1** on `--card` in light — a LARGE-TEXT colour, and an
   example sentence is body text. Walked down at the same hue to `#b33717`:
   5.79 / 5.03 / 4.58 on card, paper and sunk. Dark keeps `#f05a2e`, which
   already clears AA on all three. Same fix and same reason as decision 32
   darkening `--muted`.

   **Blue is disqualified by meaning, not contrast.** `--indigo` is this app's
   word for *you can touch this* — links, buttons, the cloze underline, the
   wordmark, the `remembered` fill. A blue kana inside a sentence reads as a
   link. **Gray also matches the fact**: devoicing is a REDUCTION, and `--muted`
   means de-emphasised everywhere else here. 6.01:1 light, 6.03:1 dark.

   **A RING AS WELL AS THE COLOUR, because the two marks are ISOLUMINANT.**
   `#b33717` against `#636059` is **1.04:1** in light and 1.27:1 in dark — the
   trap decision 33 hit with `--good`/`--danger`, where the sync dot had to
   differ in SHAPE as well as hue. Red-against-neutral is an easier
   discrimination than that green-against-red was, so this is belt and braces
   rather than a rescue — and a ring is OJAD's own devoicing mark, so it costs
   him no new convention.

   ─── `<ojad></ojad>` IS EMPTY, AND THE FIRST DESIGN WAS WRONG ─────────────

   It wrapped the field — `<ojad><< 例文 >></ojad>` — so the element could read
   the sentence as its own base. **Four tests went red at once.** `例文` is an
   `ai` field, so by render time `expandGeneratorFields` has rewritten the
   reference into an `<ai>` element: the children are a nested generator rather
   than text, the wrapper matched nothing, and it displaced the speech mount that
   reads the same field. `test/cards.test.ts`'s corpus mount census caught it,
   which is the census it exists for.

   So the element is empty and sits on its own line under the sentence, carrying
   the sentence's blockquote marker. The sentence renders exactly as it always
   has. That is also closer to what he asked for — *"confirm by looking at the
   field"*, beside, never instead.

   ─── WHAT IT WILL NOT DO ──────────────────────────────────────────────────

   **A refused or malformed annotation paints NOTHING** — decision 8, *"a wrong
   accent drilled is worse than no accent"*, in its display form. `parseAnnotation`
   is strict and runs on his phone, so the load path parses every value BEFORE
   storing it; a card whose sentence the analyser refused simply has no reading
   line, which is visibly different from one that came out flat.

   **It is not cross-checked.** Head words have three sources and 57 still
   disputed; there is no adjudication path for 3,712 sentences. The audio is an
   independent engine, so a disagreement is visible to him — which is the same
   error-detector argument §4 of `notes/pitch-accent-pipeline.md` makes for the
   `型` label. The F0-versus-prediction sweep over his 4,359 sentence clips
   remains the measurement that would put a number on it, and has not been run.

44. **`---` IS HIS, AND THE QUESTION BOUNDARY FOLLOWS IT — THE WIDGET EXCEPTION
    IS WITHDRAWN.** Zach, 2026-09-14, on a 漢字 card showing its `<draw>` canvas
    before he had pressed anything: *"so it doesn't follow the `---`??? because i
    added that explicitly, i have my reasons."*

    ─── WHAT THE RULE USED TO BE ─────────────────────────────────────────────

    `promptPositions` took the question to be **"the first non-empty side, plus a
    following side that carries a widget AND NOTHING ELSE"**. That reached 漢字 and
    only 漢字 — `<<Kanji>>` / `<draw>` / `<<Reading>>` / `<<Meaning>>` — and the
    stated reason was that the canvas *"has to be on screen while he draws the
    kanji from memory"*.

    **That reason was never his.** It arrived in the stage-9 shell commit
    (`16afee6`, 2026-08-23), among the three findings that commit message records,
    and it is in none of them. It was recorded in no decision, and it rested on an
    agent's guess about what the exercise needs — the exact shape this index's own
    warning was written about.

    ─── WHY HE IS RIGHT, IN THE REPO'S OWN TERMS ─────────────────────────────

    `---` is a side break he authored in `templates.content`, a column he edits
    whenever he wants. A rule that decides an authored side is really part of the
    previous one is **overruling the template from code**, which is the same class
    of mistake as gating `型` in the resolver instead of in the body (decision 20)
    — and CLAUDE.md's READ THE TEMPLATE section exists because agents have got
    that wrong four times.

    It also makes the fix his and cheap: if the canvas belongs beside the kanji,
    that is **one deleted `---`**, and he does not need an agent to make it.

    ─── THE COST, MEASURED ───────────────────────────────────────────────────

    The canvas becomes step 1 of the walk on **1,662** 漢字 cards, so a kanji card
    is three presses instead of two (canvas · 読み · 意味), and decision 42 means
    `remembered` waits for the last of them.

    **The extra press reveals no answer.** 漢字 declares no cloze and carries no
    audio, so the step puts a blank canvas on screen and nothing else — the one
    kind of step that cannot leak. Nothing about the drawing breaks either:
    `src/render/draw.ts` was already written against the one-pixel canvas a hidden
    mount produces, with `ResizeObserver` as the primary repair and `remeasure()`
    on stroke start as the second net.

    **One hint had to move with it.** `main.ts` picked *"answer on the card, then
    reveal"* by asking whether a widget was on a PROMPT side. Keyed that way the
    line vanishes from 漢字 the moment the canvas moves behind a press — on the
    1,662 cards whose whole exercise is to answer on the card. It now asks whether
    the CARD has a surface at all, which is 数字's `<input>` and 漢字's `<draw>`.

    **What did NOT change is the reason the rule is positional.** Reverse tracks
    permute side order, and "every side up to the first that hides or sounds
    something" printed the answer above the question on the first card of the first
    real session. The boundary is still the first VISIBLE side, still measured in
    display positions, and `test/app-logic.test.ts` still pins that regression.

45. **THE SEED FETCH GETS A SCREEN, AND THE LADDER CLIMBS ON IT.** Zach,
    2026-09-16, handing over `hashigo-sync-v3.html` — a running prototype with
    presets for a fast / typical / post-rebuild fetch, a stall simulator, and a
    slider per animation stage. *"i agree that loading animation would be
    perfect."* The numbers here are his, read off that file.

    ─── IT IS THE SEED FETCH, NOT DECISION 33's SYNC ─────────────────────────

    His draft called it "the sync screen", and the name had to change before the
    design could be built. **In this repo `sync` means decision 33** — the
    mailbox, device-to-device, ~1 MB of JSON, pushing in the background since
    2026-09-14. This is the other thing entirely: `ensureFile` in
    `app/db.worker.ts`, which is 74 MB of cards + 9 MB of text + up to 643 MB of
    audio, and which cannot run in the background because there is nothing to
    open until it lands.

    Every premise moved with the name. **The gate survives for a different
    reason than the draft gave.** "Most syncs are fast" is false of this; there
    is no fast seed fetch. Either every file is already in OPFS and nothing is
    fetched at all, or it is hundreds of megabytes. `GATE_MS = 500` exists so a
    boot that fetches NOTHING never flashes a full-screen download UI — measured:
    30 samples on such a boot, never shown once.

    ─── CHANGE IS REASSURANCE, MOTION IS NOT ─────────────────────────────────

    His line, and the strongest thing in the design. A spinner looks identical
    whether the transfer is healthy or hung, so after ninety seconds it reads as
    frozen; a byte counter going up is evidence. So the screen is mostly numbers,
    the bar ENCODES the phase (sweeping = indeterminate, filling = measurable
    bytes), and the climb is deliberately slow enough to read as breathing.

    It was also half-built already. `showFetchProgress` has carried a real
    per-file bar since 2026-09-08, after *"frozen on this page for like 5 mins"*.
    This adds the mark, the phases and the stall notice to that rather than
    replacing it.

    ─── THREE THINGS CORRECTED AGAINST THE CODEBASE ──────────────────────────

    * **The colour lerp moved from JavaScript to CSS.** The prototype interpolates
      `[224,69,29] → [27,59,111]` — the LIGHT `--vermilion` and `--indigo`. Dark
      overrides both, and measured against the dark ground `#1B3B6F` is
      **1.60:1**: the landed rungs would be invisible on the only screen he
      reviews on. `rungMix` returns a 0..1 position and `color-mix` reads the
      tokens. Verified in both themes — dark resolves to `#7fa4e1` (7.00:1) and
      `#f05a2e`.
    * **The geometry is the SHIPPED mark.** `railX(77)` is `[18.09, 81.91]`,
      which is the `d` attribute already authored in `app/index.html`, to the
      digit. All four slots are pinned, so changing the mark and forgetting the
      animation fails rather than drifting into a resting form that differs
      subtly from the static logo.
    * **The authored accent is held at `opacity: 0` while animating.** Otherwise
      the static vermilion rung sits on top of the moving one and **the beat
      never reads as empty** — which is the entire point of the beat.

    ─── THE TIMING, AND WHY IT IS SLOW ───────────────────────────────────────

    `drop 800 · beat 200 · fade 500 · hold 600`, cycle 2100 ms. An earlier version
    used 520/260, correct for a one-shot reward and too urgent for an idle loop:
    with `easeOutCubic` peak velocity is 3× average, so 520 ms puts the accent
    near 96 px/s inside a 62 px mark and 800 ms puts it near 63 px/s.

    **The beat is load-bearing** — without it the new accent fades in under cover
    of the drop and is never seen to arrive, which was the defect in his first
    version. **The loop is PHASED so `t = 0` is the start of `hold`**, so a fetch
    that clears the gate but ends inside one cycle shows the complete mark and no
    motion at all. `REWARD_STAGES` with `hold: 0` makes the offset equal the
    cycle, so deck completion — if it ever ships — starts on the drop from the
    same implementation.

    **The clock is `performance.now()` directly, never a value anything else
    scales.** In one of his prototypes it was multiplied by an unrelated speed and
    ran 20× too fast. Measured: the drop took ~750 ms of wall clock while the
    transfer ran at 472 MB/s.

    ─── NO RED, AND NO ESCAPE HATCH ──────────────────────────────────────────

    The stall notice is a recessed panel and plain language. `--vermilion` means
    *the next rung* — it is the reward colour, and spending it on an error state
    poisons it, the same argument as delete having no colour of its own
    (decision 40). And an earlier draft's *"use the copy already on this device"*
    button is CUT, on his reasoning: the fetch runs because the seed changed, so
    the local copy is by definition the stale thing. It is not a safety valve, it
    is a trapdoor.

    ─── ONE DEVIATION FROM HIS SPEC, DELIBERATE ──────────────────────────────

    He wrote *"mark and wordmark, phase label, one progress bar, a numeric
    readout. Nothing else."* **The boot log is kept**, quiet, below the readout.
    It is the instrument he used to diagnose three separate faults in one week —
    a stale server, a missing route, and the audio budget — and deleting it would
    have cost him those. Reversible if he wants the purer screen.

    **NOT VERIFIED: reduced motion.** The still path is implemented and
    `restFrame` is covered by tests, but `prefers-reduced-motion` cannot be
    emulated with the tools available here, so nobody has watched it.

46. **A LATE TRACK SAYS HOW LATE, ON THE DECK LINE, AND A TRACK DUE TODAY SAYS
    NOTHING.** Zach, 2026-09-17: *"it would actually be perfect if there's a label
    showing when this card was due in the past — like i didn't have time to review
    so now im like catching up, but it would be helpful to see that this track was
    due 5 days ago or something"*. A fourth chip beside `new card`, `again · not
    graded` and `reversed`, last in the row because it is the only one that
    changes every day.

    **THE NUMBER IS THE SCHEDULER'S AND IS NOT A SUBTRACTION.**
    `QueuedTrack.overdueDays` already existed, documented "whole days late, 0 when
    due today", and it counts in **local dates** — `QueueOptions.now` says *"only
    its local date is used"*. `Date.now() - due_at` is a different quantity: a card
    due at 23:00 yesterday is ONE DAY late and fourteen hours old, and the label
    says days. Decision 6 again — name the basis or the number is not a fact. So
    the worker passes the figure through and `app/overdue.ts` only chooses words.
    The figure is fixed when the session is PLANNED, so a session left open past
    midnight shows yesterday's count; that is worth knowing and is not worth a
    clock on the page.

    **DUE TODAY GETS NO CHIP, and that is the request rather than a shortcut.**
    134 of his 1,166 due tracks are due today. A card due today is not late, it is
    the plan working, and chipping all 134 would stop the late ones standing out —
    which is the whole thing he asked for. A new track has no due date at all and
    the worker sends 0, which is why 0 can mean "not late" without ambiguity.

    **THE BUCKETS ARE MEASURED, AND HIS QUEUE IS BIMODAL.** As of 2026-09-17, over
    1,166 due tracks: 134 due today · 135 one day · **827 between 2 and 30** ·
    **nothing at all between 31 and 364** · 70 over a year, the oldest **757 days**
    (数字, untouched since 2024-08). So days carry the case he described and years
    carry the tail, and the months arm is for a future that has not happened yet.
    `757 days` is a true number nobody reads as a duration, so that arm says "due 2
    years ago" and the `title` carries `due 2026-09-01 — 16 days late` for the
    pointer that has one. Months clamp at 11: `364 / 30.44` rounds to 12, and "due
    12 months ago" beside a "due 1 year ago" meaning FEWER days is the worse pair.
    A test sweeps every day from 1 to 800 and requires the label to be monotonic.

    **QUIET, AND NOT A WARNING.** 827 of the 1,032 late tracks are 2-30 days late,
    so a catch-up session puts a chip on nearly every card and one that shouts on
    80% of a session is one he stops reading. It keeps the chip SHAPE — the row has
    to read as one thing, `.reversetag`'s own reason — and drops only the text to
    `--muted`: **5.22:1 light, 6.66:1 dark**, both above AA at 10px. Dropping the
    BORDER to `--hair` instead measures **1.29:1**, which is not a quiet chip but a
    missing one. No `--vermilion` (decision 32 allows one per screen and it is the
    mark's top rung) and no `--danger`: being behind is the thing he is currently
    FIXING, which is decision 40's argument against red on the stall notice.

47. **AN EMPTY Ctrl+K SUGGESTS; IT DOES NOT LIST THE ALPHABET. AND THE APP KEEPS NO
    SEARCH-QUERY HISTORY.** Zach, 2026-09-17: *"if i search something using ctrl+k,
    would it leave any search history? like notion when you hit your ctrl +k for the
    first time, it would list pages that it thinks would relevant to you, even if you
    never search, how does it do that? can we do it too?"* Two questions, and the
    answer to the first is the mechanism behind the second.

    **NOTION IS NOT PREDICTING. It keeps an access log**, and an empty palette is that
    log, newest first. Recency of his own attention is the strongest signal any of
    these apps has and it needs no model — but it is a TRAIL, which is exactly what he
    asked whether we leave.

    **THE QUERY IS STILL NOT RECORDED, AND THAT DOES NOT CHANGE.** `src/search`'s own
    header says it "does not remember history"; nothing writes the typed string to the
    database, to `localStorage`, or anywhere else, and the palette is rebuilt from
    scratch on every open. What was added is a log of CARDS OPENED, not of things
    typed. The distinction is the whole reason this is written down: a recents list is
    worth a trail of what he looked at, and a list of half-typed search strings is not
    worth one.

    **WHAT THE ALPHABET WAS COSTING.** The palette asked `browse` with an empty query,
    which falls through to the deck listing — `ORDER BY c.name LIMIT 40`. Over the
    whole collection that is not a neutral default, it is noise. The real first ten:

        ...にも程がある · ...は...に限る · 124652706 · 13458922 · 142796732
        · 143710122 · 149924640 · 158370089 · 169199604 · 190891495

    **Eight of the first ten are cards whose name is an opaque number.** The most
    valuable slot in the search UI was spending itself on sort order.

    **THE SIGNAL THAT LOOKS RIGHT AND IS NOT: `last_reviewed_at`.** "Recently
    reviewed" is the obvious first idea and it is measurably unusable. **All 103,110
    imported reviews carry `time_unknown = 1`** and their timestamps are midnight, so
    `card_tracks.last_reviewed_at` holds **307 distinct values across 7,716 cards** and
    the newest days tie **16, 22, 69 and 52** rows deep. Ordering by it orders the top
    of the list ARBITRARILY — the same defect as the alphabet wearing a better name.
    It also measured **182 ms** as a correlated subquery against **2.0 ms** for the
    ranking below, per call, on every open. Deliberately not used.

    **THE THREE TIERS, and they are separate queries on purpose.** One `ORDER BY` over
    a computed score would have to invent weights between "pinned" and "three days
    ago", and there is nothing here to derive those from; the order of the tiers IS
    the ranking and it is readable.

    1. **PINNED.** 0 cards today, but the card menu already promises pinning "keeps it
       near the top of a search", and before a query exists this is the only place
       that promise can be kept. Above the visit log: pinning is a deliberate act,
       opening is a trace.
    2. **OPENED HERE** — `app/visits.ts`, 50 card ids in `localStorage`, newest first.
       **Grading is NOT a visit**: a session grades dozens, so logging reviews would
       push every deliberate open off the list within one sitting and the palette
       would just mirror the queue, which he can already see. Notion logs the page you
       navigated to, not the feed that scrolled past. Two funnels cover every
       deliberate open — `openPreview` and `openEditorById` — and only after the card
       comes back, because a dead link kept at the top for fifty opens is worse than
       no entry.
    3. **EDITED** — `cards.updated_at`, which is Mochi's real per-card edit time and
       **SURVIVED the import**: 787 distinct days, full timestamps, already indexed
       (`cards_updated`). It reads as a recents list on its own — 維持 ·
       さることながら · persecute · 正答 · 群衆 · ford · さまよう · 繰り広げる — and it
       is what makes the palette useful on a device whose log is empty, which is the
       case an access log alone cannot answer.

    **`localStorage`, NOT THE DATABASE**, for the reason the theme, the playback rate,
    the deck tree's open rows, the device id and the eviction receipt are there: it is
    a per-device convenience, and a table for it is a schema bump, which **decision
    41** made expensive the same way it made every other one expensive. It is
    deliberately NOT in decision 33's sync payload — "what I looked at on my phone" is
    not something the laptop needs, and the `updated_at` tier already syncs for free.
    `?reset=1` clears it: a re-seed happens to restore the same card ids, so the log
    would still resolve, but "delete Hashigo's local database" leaving behind a record
    of what he opened is the surprising reading of that sentence.

    **THE GALLERY IS EXCLUDED, and the `suggest` flag exists to say so.** An empty
    gallery is "the cards in this deck", which is a listing; the worker's own comment
    has always said that imposing a relevance order on it "would be a lie". The `@`
    link picker IS included — a bare `@` is the palette's question in eight rows, and
    the alphabet spends all eight on numeric names.

    Lives in `app/recent.ts` over a structural `ScopedDb` rather than inside
    `db.worker.ts`, for the reason `app/deck-scope.ts` gives: `test/` cannot import the
    worker, and worker SQL nobody can test is how the deck archive shipped inverted.

    ─── AMENDED THE SAME DAY: THE EDITED TIER EXCLUDES ARCHIVED CARDS ───

    **`cards.updated_at` is not only Mochi's edit time**, and the tier above was
    written as though it were. `src/backup/archive.ts`'s `UPDATE_CARD_STATE` sets
    `updated_at = strftime('now')` on every card whose flags the archive carries —
    and the archive stores only NON-DEFAULT rows, which is exactly the archived and
    pinned ones. So **decision 17's restore, the disaster path the whole backup
    exists for, moves all 244 archived cards to the top of "recently edited" on a
    single millisecond.**

    **Found by opening the palette, not by reading it.** The Browser pane's device
    had had a restore, and the first empty Ctrl+K after this shipped was **40
    archived cards and nothing else** — `369768579 · ある · 果‎物 · 払う · 雨 · 葉 ·
    毛 · frailty · reversal …`. Reproduced on a copy of the corpus: `backup export`
    then `backup apply`, and the top twelve by `updated_at` are those same names in
    that same order. `test/app-recent.test.ts` now runs the restore's own statement
    and requires the suggestions to survive it.

    **The filter is the right rule independently of the timestamp**, which is why it
    lives here rather than being a workaround: an archived card is one he took OUT of
    rotation, and offering it before he has typed anything is a guess he has already
    answered. Search finds it the moment he types — the row carries its own
    `archived` label. **The other two tiers keep theirs**: a PIN is an explicit
    request, and an OPEN is something he just did.

    **NOT FIXED, and it deserves its own look: the restore stamping `now` at all.**
    Two reasons it is not a one-line change. The archive carries no per-card clock to
    restore instead — only templates got `updatedAt` — so preserving the real time is
    a FORMAT change. And `cards.updated_at` is **decision 33's LWW clock** for
    `archived` and `pinned`, so a restore that stamps `now` also makes the restoring
    device win every flag conflict against every peer, including peers holding newer
    truth. That is a sync question, not a search question.

48. **THE DAY'S BAR SHOWS THE MISSES, IN RED — AND THAT IS ZACH ANSWERING A
    QUESTION DECISION 32 LEFT OPEN.** Zach, 2026-09-17: *"for missed/forgot card,
    we can actually make it visible on the progress bar, but maybe as a red bar?
    so the bar can now tell the proportion"*.

    **Decision 32 took the colours off grading** — `remembered` was green and
    `forgot` was red, the brief adds no hues beyond indigo and vermilion, and the
    pair became weight-and-position instead. `app/style.css` has carried the
    caveat in as many words ever since: *"FLAGGED FOR ZACH: this is the one place
    the brief's palette discipline costs a semantic signal he has 103,110 reps of
    muscle memory for"*. He is putting the red back, unprompted, and he is putting
    it where it costs the brief nothing — on a **2px summary**, not on a control.
    **The buttons are unchanged**; they keep weight and position and gain no hue.

    `--danger`, not `--vermilion`: decision 32 allows one vermilion per screen and
    it is the mark's top rung, while `--danger` is already what `--no` resolves to,
    so the bar says the same red as every other "no" in the app. Measured against
    the track: fill 7.10:1 light / 5.03:1 dark, miss 3.85:1 / 3.76:1. **The two
    segments are within 1.34:1 of each other in dark**, so the boundary is carried
    by HUE — which is the safe direction, blue against orange being the one pair
    that survives every common colour-vision deficiency.

    **THE RED IS A PREFIX, ANCHORED AT ZERO, NOT A TIP.** Both segments start at
    the left edge and the miss is painted OVER the fill, so each width only ever
    grows and the boundary never walks backwards mid-session. Painting the misses
    at the leading edge instead would put a red tip on the bar for exactly as long
    as his last answer was a miss — the bar reporting the last grade, which the
    screen already shows him, instead of the day's proportion, which is what he
    asked for.

    **`missedToday` IS COUNTED FROM `reviews`, IN THE SAME STATEMENT AS
    `answeredToday`.** That is the load-bearing part. A tally kept on the session
    would zero on the reload `answeredToday` exists to survive — Zach graded one
    card, refreshed, and read `0/715` as a lost review — and the bar would then
    show a red segment that had vanished while the fill beside it stayed. Two
    queries would be two answers to one question; the bar is the one place that
    difference would show. A decision-13 re-ask writes no review, so a missed card
    counts ONCE and showing it again does not count it twice. Both pinned.

    **AND THE QUESTION HE ASKED FIRST, ANSWERED: yes, `forgot` on a NEW card
    grades it, and it should.** *"technically you can't forget things you haven't
    learned right?"* — `gradeMemory` sees `memory === null` and calls FSRS's
    `init`, which is **a function of the grade alone**: stability 0.212 and a
    **1-day** interval for a miss against 3.281 and **3 days** for a hit. With
    decision 2's binary grades and no separate learning step, that first grade IS
    the initial-stability signal — remove it and a new card he did not know gets 3
    days anyway. It is not hypothetical either: **86 of his 9,085 tracks** have a
    first-ever review recorded as a miss.
    **The one place his instinct is literally right is `lapses`**, which
    `card_tracks` increments on any miss including the first, where Anki's
    definition counts only a failure of a card already learned. **Left alone, on
    purpose**: nothing schedules on that column and nothing displays it — the
    dashboard's 失敗 figures all come from `sum(1 - remembered)` over `reviews` —
    so changing it would alter a stored number on the system of record for no
    observable gain. Recorded here so the next reader does not have to re-derive
    it.

    ─── AND MOCHI'S MODEL, WHICH HE RAISED AND HIS OWN EXPORT MEASURES ───

    Zach, same day: *"in mochi flashcard, until the card is added to your review
    deck (from new card to due card) it won't keep track of your grade, but i
    don't know which approach is the best"*. **He is right about Mochi, and the
    evidence is in his own corpus** — miss rate by review number:

        review #1   9,085 tracks    0.95% miss   <- the EASIEST review in the history
        review #2   9,073 tracks    3.37% miss
        review #3   9,072 tracks    3.11% miss
        reviews 2+  94,025 rows     4.04% miss
        overall     103,110 rows    3.76% miss

    A genuine first exposure should be the HARDEST review a card ever gets. His
    is four times easier than average, which is what a log looks like when the
    learning attempts are discarded and only the graduation is written.

    **HASHIGO ALREADY HAS THE BETTER HALF OF BOTH, WHICH IS WHY NOTHING CHANGED.**
    What Mochi's rule protects is real — flailing at a new card should not be
    recorded as five failures. **Decision 13 already gives exactly that**: the
    re-ask writes nothing whichever button he presses (`answer()` returns
    `graded: false` before it reaches `gradeTrack`), so a track takes **exactly
    one review per session**, and it cannot loop — a track is in the plan once and
    the re-ask branch returns before the queue push. So the answer to *"how many
    times is okay"* is **any number**: the first press counts, every press after it
    in that session is free.
    What Mochi throws away is the one thing FSRS asks for at that moment. `w[0]`
    through `w[3]` ARE "initial stability for this first rating" — discard the
    first grade and every new card starts at the same stability whether he knew it
    or not.

    **The one real difference left is TIMING, not bookkeeping**: a bombed new card
    returns tomorrow (1 day), where Anki would re-drill it in minutes at a learning
    step. The re-ask is that same idea at SESSION scope instead. If it ever feels
    too far away, the lever is decision 13's placement, not the grading — and that
    one is his.

49. **PRIVACY WAS NEVER HIS REQUIREMENT, AND DECISION 33's "NO CLOUD" LOSES ITS
    REASON.** Zach, 2026-09-24, after being told a cloud mailbox would reverse the
    choice that kept his study history off the open internet: *"uhm... i never said
    i don't want anyone to see my study history. im even thinking about making this
    app become usable for my friends"*.

    **Checked before recording, and he is right.** The rationale enters in
    `app/README.md`, written by an agent choosing between tunnels, and decision 33
    (which he delegated outright — *"任せます lol"*) inherited it as "the choice
    already made, for the same reason". `notes/zach-in-his-own-words.md` has no
    line about privacy, private data or the open internet. It was an agent's
    preference recorded in the voice of a requirement — the decision-44 shape again.

    **What survives of decision 33:** the MERGE RULES (reviews union, last review
    wins, LWW flags) and the mailbox that has no opinion about its files — none of
    it cares where the mailbox lives. **What falls:** "no cloud" as a principle.
    The tailnet is now just the transport that happens to be running, and SPEC's
    original `Workers + D1 + R2` row is back on the table on its merits
    (availability without the laptop, an off-machine copy for decision 41).

    **"Usable for my friends" is a DIRECTION he is considering, not a decision.**
    Recorded so the next architecture choice is made knowing it: a single-user
    shortcut (one shared secret, one mailbox, his API keys paying for every
    generation) is cheap now and expensive to unpick later. It is also adjacent to
    open-sourcing, which is still deferred until after development.

50. **THE APP PULLS ON THE BOOT SCREEN, BEFORE THE FIRST CARD — AND SAYS HOW LONG.**
    Zach, 2026-10-09: *"if I'm on a train and I want to review it it would take so
    much time without knowing how long it would take"*, then his own better answer:
    *"when you open the app and it has not been synced it won't let you go through
    … what's the point of having the first waiting page if you have to go inside
    the app and tap the sync button again"*.

    **Why the pull was manual, and why that reason does not reach the boot
    screen.** `sidebar.ts` kept the pull off every automatic path for two reasons
    (2026-09-14): a merge freezes the review screen ~8 s, and a merge moves what is
    due under a card he is holding. Before the first card neither can happen. So
    `syncAtBoot` pulls there, and then sends `replan` — the session is built ONCE at
    `open`, so a merge after it left already-answered cards in the plan, which is the
    2026-09-14 duplicate exactly. Measured on a fresh device against the local
    mailbox: plan 1,832 at open, **1,331 after the merge** of 610 grades. The worker
    refuses `replan` once anything is graded.

    **The PUSH stays off the boot path** (`push: false`) — nothing about sending
    needs to happen before he reviews. `pushAfterBoot` sends after the first card,
    and only when this device has grades the mailbox does not (*"how much data does
    it consume?"*, 2026-09-29). Merged-in grades are stored `source = 'local'` too,
    so the count is carried across a merge (`carryPushedCount`) or every merging boot
    would upload ~350 KB for nothing.

    **"Won't let you through" has three exits, and they are the local-first
    floor, not a softening.** `navigator.onLine` false → straight in. The listing
    unanswered in 8 s or unreachable → straight in, and the boot log says so. A
    download with no bytes for `STALL_AFTER_MS` → "open without syncing". Once a
    MERGE has started there is no exit: it is one worker transaction, and leaving
    the screen saves no time because the worker answers nothing until it commits.
    Decision 45 refused an escape for the SEED because the local copy is the stale
    thing; for sync the local copy is a working database, and locking him out of it
    on a dead train is the failure this app exists to not have.

    **The ETA comes from the LAST run on this device**, not from the live rate
    `readout` uses for the seed — that waits 15 s for a stable sample, and a sync
    is mostly merge, which has no bytes. `hashigo.sync.timing` holds merge ms per
    byte, download bytes per ms and send ms; a part never measured makes the whole
    estimate null ("first sync timed on this device"), never a short half-truth.
    Seen working: "about 5 s left" on the second run.

    **A defect fell out of measuring it.** Of the six slots in the cloud mailbox,
    four (last written 26-28 Sep) predate `X-Payload-Sha`, and the skip rule said
    "no sha → always download". So EVERY sync re-fetched and re-merged ~7.4 MB of
    payloads unchanged for a month — likely most of the wait he was asking about.
    `versionOf()` names a hashless payload by `updatedAt|bytes`.

51. **GRADES TRAVEL AS A DELTA; THE FULL PAYLOAD TRAVELS ONLY AFTER AN EDIT.**
    Zach, 2026-10-10, after his phone showed him the exact card order his tablet
    had shown the night before: *"so it's guaranteed that my last min of reviewing
    won't be synced from my tablet"* — and the constraint, *"as long as we don't
    end up like mochi flashcards im fine"* (hot phone, bloated, always running).

    **Two faults, measured in the code before anything was built.** The push
    debounce reset on EVERY grade, so a steady session sent nothing until he
    stopped for 30 s (fixed first: `PUSH_MAX_WAIT_MS`, 2 min). And the
    last-chance send on `visibilitychange` was a ~350 KB upload from a tab Android
    is freezing — `keepalive`, the one `fetch` mode that outlives the page, caps
    the body at 64 KB.

    **The delta** (`src/sync/delta.ts`) is the grades after a per-device MARK —
    that device's own `reviews.id`, never compared across devices — plus the
    current state of the tracks they touched. Measured: 3 grades = **1,816 bytes**;
    40 grades stay under 64 KB by test. Sent with `keepalive` on hide, it arrived
    while the page navigated away (local Worker, two origins standing in for two
    devices; the second pulled 613 = 610 + 3 on boot and its queue dropped them).

    **One merge, not two.** A delta is wrapped as a payload carrying only reviews
    and track state (`deltaPayload`) and goes through the same `mergeSync`. Empty
    lists say nothing — no flag, setting or template moves (pinned by test).

    **Full payload when, and only when, it is needed:** no mark yet (a delta needs
    a full payload under it), or an edit happened. Edits are detected at the one
    channel to the worker (`worker-client.ts`'s `ask`) by an ALLOWLIST of read-only
    request kinds, so a new kind defaults to "send everything". A full PUT names
    the mark it covers (`X-Covers-Mark`) and the mailbox drops the deltas under it.
    A merge that brings in another device's grades carries the mark forward when
    nothing was unsent, or the next delta would re-send hundreds of foreign grades.

    **Battery is the reason, not an afterthought.** Still no timer, no polling, no
    socket: sends happen on grading and on hide, nothing happens on an idle device,
    and each send is a few KB instead of ~350 KB.

    **Found on the way, fixed in its own commit:** 22 `型` values the 2026-09-25
    dictionary pass corrected were being carried BACK by five of six mailbox
    slots, because field values merge with no clock and the corrections applied
    only at boot. `reapplyCorrections` now runs inside every merge's transaction.

52. **THE GALLERY IS READ, NOT OPERATED — AND IT HAS AN ADDRESS.** Zach,
    2026-10-16, agreeing to a design review of the live app (sections: wording
    kept, everything else taken): *"i agree with you on every section accept for
    [the review loop]"*, and on the wording, *"i would keep 5, 6, it feels raw to
    me lol, and feel nerdy too"*. So the review screen, the seed screen's log and
    every developer-voiced note are **his and stay as written**; what changed is
    the browsing half.

    **A tile's six buttons became one `⋯`** (`openTileMenu` in `app/gallery.ts`),
    in the review card menu's shape and sentences. A 300-card deck had put 300 red
    `delete`s on screen — the loudest element in the gallery was the operation
    that takes four years of review history. Decision 40's reasoning, applied to
    the second surface it never reached; "every 操作 on the desktop exists on
    mobile" is still met.

    **The space went to the MEANING.** A tile's second line is the first sense of
    `意味` / `Meaning` (`app/gist.ts`), plain fields only: **6,689 of 7,348 cards**
    carry one. Templates with none get no second line rather than a guessed one.

    **Archived starts HIDDEN, and the filter moved into the query.** It had been
    applied to the page AFTER the 300-row limit, so 日本語 opened on archived 数字
    tiles named by numbers and the total still counted them. Decision 47 made the
    same call for the empty Ctrl+K.

    **`#deck/<id>` and `#everything`.** One history entry whatever happens inside
    the gallery (opening pushes, switching decks replaces), so Back — his phone's
    system gesture — means "back to review" instead of leaving the app. **The URL
    follows `data-view`**, watched by one observer, because three different things
    leave the gallery and only one of them is Back. Layers get no address on
    purpose: they are dismissed, not visited. **Known gap:** Back with a preview
    open over the gallery leaves the gallery under the preview.

    **Smaller, same review:** deck paths sort with numbers as numbers (`第2章`
    before `第10章`) and **nothing else moved** — a Japanese collator was tried and
    reordered kanji decks by reading; the sidebar's `744 · 5950` and the header's
    `31/914` say what they count in a tooltip and the accessible name (decision 6);
    the 14-day chart has a key for its 0.85 tone; a clip button's name is `play
    this clip`, because its old name was the clip's ALT TEXT — the masked answer,
    readable by hover and by any screen reader before the reveal; a preview's
    `delete` moved to the far end from ✕; and a backticked identifier in a note
    renders as `<code>`, because in the UI face `` `inherit` `` read as `ìnherit``.

53. **`優先` CARDS ARE PICKED FIRST FROM THE NEW POOL — STILL TEN A DAY.** Zach,
    2026-10-21, with the 漢検準2級 CBT on 6 Feb 2027: *"make the priority feature,
    that from now on, the queue will select my priority first"*. **This amends
    decision 15's "chosen at RANDOM"** for the cards he flags; everything else is
    still the daily keyed shuffle, and priority cards are shuffled among
    themselves the same way.

    **Why it was needed, measured.** `newTracks` reshuffles the whole unlearned
    pool every day and takes ten, so one track has a ~10/N chance a day. With
    3,736 tracks waiting that is ~374 days on average, and ~23% odds that a given
    track surfaces in the ~96 days before the exam — the cards his tutor session
    hands over are exactly the ones he needs before then.

    **A LOCAL BOOLEAN FIELD named `優先`, not a column.** Decision 41 made a schema
    bump expensive, and a `local = 1` field travels in decision 33's payload with
    its values, as `かな主流` does — flagged on the laptop is flagged on the phone.
    Matched by NAME and TYPE (`priorityCardIds` in `src/scheduler/queue.ts`), so
    any template that declares the field takes part. Priority picks WHICH ten,
    never how many: with 772 overdue, load was not the thing to add.

    **THE SECOND TIER, BUILT THE SAME DAY: 日本語 words with a 3級 or 準2級 kanji.**
    Order is `優先` → this → the rest, random within each. The table is
    `src/scheduler/kanken.ts`, every 常用漢字 at its FY2020 level, parsed from the
    協会's own 級別漢字表 (2020年度～新配当対応版) and identical to mimneko/kanji-data
    (CC0). Verified rather than trusted: per-level counts equal the 協会's running
    totals; all 57 kanji in the 2020 change list sit at their new level (two other
    open datasets are pre-2020 and fail exactly there); 叱填頬剥 are folded onto the
    常用漢字表's 𠮟塡頰剝. Measured on the 2026-09-08 laptop copy: **501 of 3,907**
    unlearned tracks, ~50 days at ten a day. The 日本語 scope is not decoration:
    seven 基本情報 sentences matched on a stray 準2級 character. **What it cannot
    see:** a word of ≤4級 kanji with a 高校 reading is still a 準2級 question; `優先`
    is the lever for those.

    **THE TARGET IS A SETTING, `queue.exam-target`** — Zach, the same day: *"in
    future, how do change the target priority? because i will level up"*. Settings
    → "漢検 target": off / 3級 / 準2級 / 2級. A target pulls forward the level it
    adds and the one below (準2級 = 3級 + 準2級, 2級 = 準2級 + 2級); `off` keeps
    `優先` and drops the level tier. Absent or unusable means 準2級, what shipped —
    the queue never throws on a bad row, and the screen names the rejected value.
    It syncs like every setting, and changing it needs no deploy.

54. **A WORD WAITS FOR ITS KANJI — the unlearned kanji takes the word's slot.**
    Zach, 2026-10-25: *"no matter what the priority is, if the 単語 cards are
    containing kanjis that i have not learned, it will swap out that word from the
    learning queue and let me learn the kanji first"*. **This sits above decision
    53's tiers**: the swap runs over the tiered order, so a `優先` word with an
    unlearned kanji puts the KANJI in the front slot instead.

    **Unlearned** = the kanji has a live card on the `漢字` template and no track of
    any such card has been reviewed (彼 and 私 have two cards; either counts). A
    kanji with no card blocks nothing, since there is nothing to learn first, and
    neither does an archived one. One review of the kanji, in either direction,
    makes the word eligible again — at the earliest on the next day's plan.

    **What is swapped in** is the kanji's FORWARD track (kanji → reading, the
    direction that teaches it), once, however many words point at it; its reverse
    stays in the random pool, unpaired per decision 15. Still ten a day. Scoped to
    日本語 for decision 53's reason, and a "kanji card" is asked of the TEMPLATE, not
    the name, so a 単語 card named `疎` is gated by the kanji 疎 rather than mistaken
    for it. The swap only uses tracks already in the query, so a deck-scoped or
    audio-only session cannot pull in a card from outside its scope; there the word
    stays rather than leaving the session empty.

    **Measured on the merged devices, 2026-10-25:** 386 kanji unlearned, gating
    **705 of 2,054** new 日本語 word tracks; 199 word tracks contain a kanji with no
    card at all. Today's ten went from 7 gated words to 7 kanji and 3 free words.
    **The cost is pace, and it is front-loaded:** the 準2級 tier is mostly words
    whose kanji he has not met, so the first weeks of new cards will be largely
    kanji before the words they unlock come through.

55. **A CARD REMEMBERS WHERE IT WAS FOUND — `出典`.** Zach, 2026-10-26: *"whenever
    i see a new word inside an example sentence like 彼女は古いシャツを細く裂いて、
    包帯の代わりにした。 i see 包帯 so then i would create new card, but then i would
    have no way to tell myself that i created that card because of this one"*. He
    took the proposal as offered (*"sounds perfect"*).

    **THE EDGE LIVES ON THE NEW CARD.** The sentence is usually `例文`, an `ai`
    field, so there is no durable place inside it for `[[包帯]]` — a regeneration
    would lose it. The new card's `出典` holds `[[恒久|id]]` and, on the next line,
    a COPY of the sentence, for the same reason. The link alone gives the other
    direction: the source lists the new card under "links here" (decision 52's
    backlinks, kept current since 2026-10-26 by `src/cards/link-index.ts`).

    **THE FIELD:** `local = 1`, `plain`, role `source`, created on first use by
    `ensureSourceField`. Its id is the FIXED string `source` on every template, not
    a random `newFieldId`: two devices that each create it write the same row and
    sync's upsert makes them one, where random ids would leave two fields named
    `出典` and the resolver would bind only the first. Found by role, so renaming it
    is safe. No template body references it; the screen shows it as "found in" at
    the head of the backlink block, which appears only after the walk — the sentence
    contains the word, so before then it is the answer.

    **THE ACTION:** "new card from this" in the review card's `⋯` menu and `new
    card` on a preview. A selection inside a card is REMEMBERED as it is made,
    because on his phone tapping `⋯` collapses it first; it is used only while its
    nodes are still in that card. Furigana and the `<ojad>` line are stripped, and
    the sentence is the generated span holding the selection. Nothing selected
    still works: the name is empty and the link is still recorded.

    **Mochi-era cards have no record.** Offered: suggest pairs where a card's word
    appears in an older card's example sentence, for him to confirm. Not built.

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
