# Zach's reasoning, in his own words

**THIS IS THE SOURCE, NOT A COPY.** `CLAUDE.md`'s numbered decisions were written
FROM these quotes and eight of them are attributed to it. If this file and a
decision ever disagree, **this one is right** — the direction is one-way.

**Moved out of the Obsidian planner 2026-08-22, at his instruction to reduce that
file to two sections.** Moving it into the repo is also the lesson of that same
day applied to itself: a thing recorded only in Obsidian is a thing no agent can
read, and four settled decisions sat invisible there until one was reopened as an
"open question". Now it is where the readers are.

**Do not paraphrase these.** A chat transcript is not a record — a `/compact` eats
it — and this is the only place his reasoning survives in his own voice.

> [!note] One consequence worth his eye
> This file is in git. `notes/open-sourcing.md` records that publishing the repo
> as-is publishes four years of his study record; this adds his own words to that
> set. Nothing new in kind — 43 commit messages already quote him — but it is one
> more thing to weigh if he ever squashes for a public repo.

His own words explaining WHY are not derivable from the code or from git.

- **Resolve generated values on demand**, not materialised.
  > Let's make it compute on demand, because we plan to update the audio later right?
  > and if i have a wrong typo in the cards when i make them, then we have to do
  > migration and stuff, the only thing that i worry is that computing it on run time
  > will be the same problem that drains my battery, but gemini said it's not that much.

  The battery worry was unfounded — a `sha256` of a short string plus one indexed
  lookup, 0.20–1.06 ms in a real browser. The Mochi drain was polling and sockets.

- **No particle in the audio.** 尾高 is 1.4% of my vocabulary — 55 words.
  > we don't have to attach a particle to the end to generate a different sound, i
  > already know how to pronounce them then it's L-H-L and L-H-H […] but maybe some
  > mark would be useful along with the audio → **that became `<<型>>`**

- **Regenerate small first, then decide.**
  > selecting a voice from the template applies it to every card, and once every card is
  > generated, it's very hard to delete the audio that you don't need … that's why it
  > ended up being female voice, when i wanted to practice with male voice

- **OJAD through the UI, never a scraper.**
  > for ojad, i think you can make claude on chrome prompt, because it's still using ui,
  > just like any human

- **Why ◎かな主流 is worth building:**
  > because my goal is that some day I want to achieve 漢字検定, I may have to learn how
  > to read them even if they are not primarily used, but I also need to know that I may
  > not want to write them in Kanji when I text with my friend or something […] if I do
  > not know the reading, I don't wanna make it my fault 100%

- **One browser per device.** *"i never use chrome on my phone anyway"* — Samsung
  Internet, forever.
- **All audio local, no lazy fetch.** *"700mb is nothing on my phone … i don't wanna
  wait while reviewing each card to download"*
- **Sleek, minimal, lightweight** — Monkeytype `terminal` + Notion. Explicitly not the
  vibe-coded Lovable/Claude look.
- **Binary grades**, FSRS-6, 365-day cap, retention 0.90.
- **Links render plainly, in place.** I overruled seven drafts of spec on this.
- Keys in `.env`, gitignored, never opened by Claude. Google's is `GOOGLE_TTS_SECRET`.

- **The review screen — choosing direction A, 2026-08-22.** Shown three mockups over
  the same real cards:
  > i think `a` is the closest to what im aiming at, it looks fun, it looks new (as in
  > novel), it looks like we've put thoughts into it, but the only thing that's hurting
  > is the replay button, i would prefer `c`'s replay button, because im using my right
  > hand, and my thumb would have to reach all the way

- **On the keycap hints** — he proposed hover tooltips and asked rather than asserted:
  > i think words hinting about which key to use is a good try, but you can actually
  > hide them behind tool tips, when you hover with mouse, that would be more friendly
  > for mobile you think?

  Answered with his OWN decision 19 (*"there is no hover on a phone"*): a tooltip needs
  the one input the phone lacks, so it would hide the hints on the device that matters
  and keep them where they are least needed. Built as a `(hover: hover) and
  (pointer: fine)` media query instead; he accepted the result — *"the mock up is
  amazing, i like it"*. **The diagnosis was his and it was right; only the mechanism
  changed.**

- **`spread`, and the `New Card` label, 2026-08-23.** Asked which interleave order
  he wanted:
  > im leaning towards choice 2, but on mochi flashcard, if the card is new, you get
  > the label `New Card`, and the label is per side, so for forward and reverse, they
  > could have its own `New Card` tag and it doesn't have to match

  Choice 2 was `spread`. Note "per side" means per DIRECTION here — see decision 25
  for why that distinction matters in a repo where "side" means something else.

- **On the division of labour**, same day:
  > I'll let you decide the best choice, this is `how`, and I'm trusting you on `how`

  He picks WHAT; the implementation is mine. The windowed spread is exactly that
  split: his policy, my window.

- **Commit authority, handed over 2026-08-22** — the grant and its reason in one
  breath:
  > you don't have to wait for my instructions to commit, you know when to commit, make
  > it clean and deliberate, no permission needed, commit is always revertible, and it's
  > your job now […] this should be instruction for any agent from now on

  *"commit is always revertible"* is the whole argument, and it is worth keeping in his
  words: the grant is scoped to the operation that can be undone. He did not say push.

- **He is RIGHT-HANDED and reviews one-handed.** Stated in passing while rejecting a
  native `<audio controls>`, and it is a layout constraint for every screen after this
  one: primary actions belong bottom-RIGHT.

- **WHY THE ACCENT PIPELINE EXISTS AT ALL.** 2026-08-23, asked whether he knew what
  `型` was for before he would answer three design questions. Every prior note in this
  repo describes the pipeline's mechanics; none recorded its purpose, and the purpose
  changes what the field is allowed to be:

  > the true reason we need it is just because i didn't know 花 and 鼻 would be
  > pronounced differently when the particle is attached to them, that's the whole point
  > because by sound i can distinguish 配慮, from 勉強, that's easy, but without particle
  > for those two kanji word, there's no way to tell, yet natives pronounce them
  > perfectly, because the 型 rule is encoded into their brain, that's what im trying to
  > train myself for

  So `型` is **not a caption for what the audio just played.** For the 平板/尾高 class it
  carries a fact that is absent from the audio entirely — 2,148 of 3,830 labelled cards.
  Decision 27 is this quote turned into a build constraint.

- **The word is the unit, and nothing attaches to it.** Same day, asked whether the
  contour should render a trailing particle box so 平板 and 尾高 become visually distinct:

  > nope, don't add particle to my word, the word stays the word

  Consistent with the audio rule rather than a new preference — three particles get
  conflated, so displaying one privileges it. He accepted the consequence that the
  distinction then lives only in the label. Decision 27.

- **`言葉` displays as authored, and he corrected himself to get there.** 2026-08-23,
  asked whether `言葉`'s body should render `かな主流`. His first answer was that the deck
  is kana anyway — shown the 20 kanji-containing head words, he said:

  > which was wrong now that you showed me those cards i remember now

  and then ruled on the principle rather than the exception:

  > for 言葉 deck, it should display the way it's inputted

  **He also rejected something an agent had put in his mouth**, which is worth recording
  as a caution about how these questions get framed:

  > i never said on 言葉 deck you should hide kanji? i just said i never put kanji words
  > in the deck

  The agent had raised "hide kanji on 言葉" as a hypothetical and then treated it as a gap
  in HIS reasoning. It was never his position, and it is wrong on the merits: 14 of the 20
  are phrases (`気が付く`, `目をつける`) where the kanji is the correct spelling. Decision 28.

- **THE AUTOPLAY RULE WAS TOO ABSOLUTE, and here is the exercise it was missing.**
  2026-08-23. The repo had "audio never autoplays" as a correctness requirement on all
  7,716 cards. It is right for 692 of them. His own system does the opposite on the rest,
  on purpose:

  > for the card that is templated with 言葉, because showing the word or not doesn't
  > change the difficulty level … you know it's まるで, so in my mochi flashcard system,
  > the audio plays when you see the card
  >
  > oh, same with 単語 template when the `Reading` boolean is false, when you see the card
  > it plays the audio

  And the reason, which is the part no agent would have guessed:

  > some words that play the audio to me is the recall testing for listening, if you show
  > me 償却 i can read that word like instantly, because i can remember the radical rules,
  > but if you hide it behind the cloze, and play しょうきゃく, i would be like... what
  > しょう... and what きゃく、、、 and it would force me to remember, which is the trade
  > off between knowing the accent recall, because most of said cards are 平板 or 頭高
  > anyway? i pay for the ability to recognize the word without the kanji for the accent
  > drill, which btw, comes in the example sentence part anyway

  > my listening skill is far worse than my reading skill … that's why most of the cards
  > are like that

  **`Reading` is a STATE HE MOVES CARDS THROUGH, not a property** — and this is what makes
  `型`-on-entry mandatory in mode 2 rather than optional:

  > but that's also because i didn't know that 尾高 was a thing, so from now on, if it's
  > `Reading` is false, so the audio would play on the first side when enter the card, i
  > would see that it's 尾高, and i'll be like, damn, i didn't know this, ive been
  > pronounced it has 平板 all along, and then i'll just go ahead and edit the card to
  > `Reading` -> true

  Decision 29. Note what he was right and wrong about in his own argument: the
  平板/頭高 leg does not hold (mode 2 is 75.4%, mode 1 is 72.3% — the same), and the
  example-sentence leg is stronger than he claimed (97.6% coverage, and the sentence is
  the only AUDIBLE carrier of 平板-vs-尾高 because it has a particle).

- **THREE THINGS HE HAS HAD TO REPEAT, with his own counts.** 2026-08-23, after a session
  asked him to make design decisions the template already answers. Recording the counts
  because the repetition is the signal — each one is an agent failing to read what exists:

  > and it should render conditionally from my template, please tell me you have read my
  > template and how it would render conditionally from a boolean? the template that i can
  > edit whenever i want... this is me telling agents in this repo for the 4th time to look
  > at my template

  > i will regenerate my audio after we finished the app, because i have to re import
  > anyway because everyday when i make this app i still review mochi, and if we use the
  > cards right now the review history would be outdated, frozen 6 days ago, and this is
  > my 5th time telling an agent about this

  > we can discuss about whether to open source it once we finish dev, this is my 3rd time
  > telling an agent about this

  **Also: he does not want jargon.** Same message: *"can you stop using words i don't
  understand? like decision 23's three referals, d2 d4 d5, b2, b3, b4 ... bro i know you
  are fluent in code language but don't use code language to me."* The `D2`/`B4`/decision-
  number scheme is an agent filing system. When talking TO him, name the thing — "the
  editor", "the cards where the audio plays" — and keep the numbers in the repo.

- **SIX REQUESTS ON SEEING THE APP RUN, 2026-08-23**, verbatim and numbered as he wrote
  them. He was low on tokens and said so — *"i now have limited token access, so i want to
  make my comments for you and we can resume this on wednesday"* — so these are a
  handover, not a conversation. **Resume from them on 2026-08-26.**

  > 1. i don't think review reverse is even on for the english deck
  > 2. on mochi flashcards, if you click on a link that links to another card, it doesn't
  >    navigate away, it opens kinda like a modal that pops up showing the rendered card
  >    that dims the background
  > 3. whether the card is in the review mode or the pop up mode, you can press `e` for
  >    edit to edit each field of the card right away
  > 4. i would need a progress bar at the top too
  > 5. and i would need a side bar to navigate, which is a space where we create cards,
  >    navigate the card gallery
  > 6. for every reversed track, i would need a label at the top that it's reversed

  **He picks what, I pick how** — that split is his (2026-08-23). Every one of the six is
  a WHAT. None of them settles a layout, a keybinding table or a data model, and none
  should be read as doing so.

  **(1) IS A CORRECTION AND HE IS RIGHT ABOUT THE DECK.** Measured: `English/Vocabulary`
  resolves `reverse: off` on **1,226 of its 1,234 cards**. What I reported to him as "a
  reverse New Vocab track" was real, but it was one of **8 per-card overrides** in that
  deck — card `oYjmEPwB` (`constraint`), whose reverse track is live with 2 reps and a due
  date of **2023-03-03**. So the bug it exposed is real and the fix stands; the FRAMING
  was wrong, because it implied his English deck reverses and it does not. The honest
  support is `日本語/単語` and `日本語/漢字`, where reverse is on for all 5,357 cards.
  **Worth showing him separately:** those 8 English overrides are cards he has probably
  forgotten exist.

  **(3) is the first thing he has ever asked for that is stage 10.** Note the scope in his
  own words — *"edit each field of the card right away"*, in review mode AND in the
  card-link popup. That is an editor, reachable from two places, and it lands before the
  card gallery he asks for in (5).

  **AND (2) NESTS, WHICH HE ADDED SEPARATELY AND LIKES:**

  > also, when you click another link that's on the pop up modal, it opens another layer on
  > the top, and you can keep going in mochi, and i kinda like that system

  So it is a STACK of layers, not one modal that replaces its contents. Measured on his
  corpus before anyone designs it, because "you can keep going" turns out not to be
  theoretical:

  ```plaintext
  8,744 card links from 4,335 distinct source cards
  deepest chain found (first 400 sources, acyclic)   9 cards
  MUTUAL two-way link pairs                          23
  ```

  **The 23 mutual pairs are the finding.** A links to B and B links back to A, so the
  stack can grow WITHOUT BOUND on his real data — any depth limit is a design choice, not
  something the corpus imposes. And every layer is a fully mounted card: its own audio
  controller and its own object-URL scope, which must be released when that layer closes
  and not before (`src/blobs/url.ts`, rule 1 — the scope that mints a URL revokes it).

  **ONE QUESTION FOR HIM, NOT FOR AN AGENT.** Mounting a card is what fires the audio on
  the cards where the sound is the question. If he opens a linked card in a layer and that
  card is one of those, **does its clip play?** Arguments both ways: it is a new card
  appearing, which is when the sound belongs; but he opened it to READ something while
  mid-review of a different card, and a clip firing under his thumb is a surprise. Nobody
  should guess this — it is the hard rule meeting the modal stack.

  **(6) is not decoration.** A reversed track shows the same card with the sides permuted,
  and on this corpus that changes which side is the question — the reason the review
  screen's prompt boundary had to become positional. If he cannot see which direction he
  is being asked, a card that looks familiar and reads backwards is indistinguishable from
  one he has genuinely forgotten.

---
