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

---
