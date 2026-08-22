# Open-sourcing Hashigo — what was checked, and what is still a decision

**Status: DEFERRED ON PURPOSE. The decision costs nothing to delay; one part of it
gets more expensive every commit.** Moved out of Zach's Obsidian planner
2026-08-22, because the planner is a decision queue and this is a knowledge base.
No agent reads that file, and this is the kind of thing a future session needs.

His words, kept verbatim from the planner — the reasoning is his, the formatting
is the only thing that changed.

* **Open-sourcing this.** Deferred on purpose — the decision costs nothing to delay.
  What I checked when it came up: no Mochi code, assets or logo are in the repo
  (`tools/mochi.py` is OUR reader for THEIR format, and a format description is fact,
  not expression), and their data is not shipped — `exports/`, `*.blobs/`, `*.db` are
  gitignored. Reimplementing an SRS app is not a legal problem; FSRS is MIT and SM-2 is
  a paper.
  * **Read Mochi's ToS first** when I circle back. Copyright law broadly permits reverse
    engineering for interoperability (EU Software Directive art. 6; US *Sega v.
    Accolade*), but a ToS is a CONTRACT and that is a separate question. Ten minutes,
    free, and it decides everything else.
  * **The generated content is arguably theirs**, not mine: 24,558 clips, 19,710 AI
    sentences and 9,216 translations were produced through MOCHI's API accounts. Moot
    while gitignored, and another argument for regenerating on my own Google key.
  * `package.json` says `UNLICENSED`, which affirmatively means nobody may use it. Has
    to change.
  * **The one thing that is not free to defer:** git history. 67 commits in, 58
    committed files reference my study data and 43 commit messages quote me. Publishing
    as-is publishes four years of my study record; the alternative is a fresh repo with
    a squashed initial commit, which loses the commit archaeology — and here that
    archaeology IS the design record. Neither gets more expensive by waiting; only the
    amount I would squash grows.
  * **The only irreversible mistake available** is committing `exports/`, the blob
    store, or `.env`. All gitignored today. Keep it that way and nothing is foreclosed.
  * Practical, not legal: many of the 636 tests are gated on `exports/` existing, so a
    stranger's CI would skip them. A small synthetic corpus would be needed for the
    suite to mean anything to a contributor.
