<p align="center">
  <img src="app/brand/mark.svg" width="88" height="88" alt="">
</p>

<h1 align="center">hashigo · はしご</h1>

<p align="center">
  A local-first flashcard app for Japanese, built around pitch accent.<br>
  One card, one word, one rung higher.
</p>

---

Hashigo replaces [Mochi](https://mochi.cards) for one person's Japanese study.
It was built because the bugs reported to Mochi stopped getting fixed. It holds
7,716 cards and 103,110 reviews imported from Mochi, and it has been the only place
those cards are reviewed since September 2026.

The database is SQLite running in your browser, stored on your device. Reviews work
with no network. Two devices stay in step through a small sync mailbox.

> **Status: in daily use by one person.** The code is public, but the app is not open
> to sign-ups and the repository has no licence yet, so all rights are reserved.
> Opening it to other people is a later decision; see
> [Publishing](#publishing).

## What it does

**Pitch accent is the point.** Every word card carries its 型 (平板, 頭高, 中高,
尾高), derived offline with OpenJTalk, cross-checked against UniDic and adjudicated
against OJAD where the two disagree. Example sentences are marked mora by mora: the
accent nucleus in one colour, devoiced vowels ringed. 平板 and 尾高 sound identical on a
bare word, so the label is the only place that distinction shows.

**Two ways to drill a word.** A card in *produce* mode shows the kanji: you say the
reading and the contour aloud, then reveal and listen. Audio never plays before you
reveal, because the clip would give the answer away. A card in *identify* mode plays
the word first and hides it: you name the word from its sound. Moving a card from
one mode to the other is a single field on the card.

**A reveal is a walk.** Each press uncovers one cloze, then the next side. `forgot`
is available from the first step; `remembered` waits until everything is on screen.

**Scheduling is FSRS-6.** Two grades, remembered and forgot. The longest interval is
365 days with ±5% fuzz, and retention is targeted at 90%. A forgotten card is shown
again at the end of the session without being graded twice. New cards are ten tracks
a day, and a word waits until its kanji has been studied.

**Practice tools on every clip.** Replay, loop, 0.75× and 1.25×, and record yourself
to compare against the clip. Kanji cards have a drawing canvas.

**Cards link to each other.** `[[links]]` between cards, backlinks, and a card that
remembers the sentence it was found in. `Ctrl+K` searches everything.

**Light and dark, phone and laptop.** The review controls sit at the bottom edge for
one-handed use, with the replay button under the right thumb.

## Running it

You need Node 22 or later. The app expects a Mochi export in `exports/`, which is not
in the repository.

```bash
npm install
npm run import -- --db build/hashigo.db exports/日本語 exports/English exports/基本情報
npm run app:bootstrap        # once: builds the files the app downloads on first open
npm run app:dev -- --host 127.0.0.1
```

Then open the address Vite prints. [`app/README.md`](app/README.md) covers the phone,
the tunnel, the cloud build and what each boot step is doing.

Every check the project relies on runs as one command:

```bash
npm run gates                # tests, both typechecks, both builds, the blob-path check
```

## How it is built

| layer | what |
|---|---|
| app | Vanilla TypeScript on Vite, no framework. `app/` |
| storage | SQLite (sqlite-wasm) in the browser's private file system (OPFS) |
| audio | Content-addressed blobs, fetched once and cached on the device |
| scheduler | FSRS-6. `src/scheduler` |
| templates | Mochi's template language, re-implemented and rendered to sides. `src/template`, `src/render` |
| accent | OpenJTalk + UniDic in Python, nothing else in Python. `tools/`, `src/accent` |
| sync | A per-device mailbox, merged locally: reviews union, schedules follow the last review. `src/sync` |
| hosting | A Cloudflare Worker behind a passphrase. `cloud/app` |
| landing page | `site/index.html`, on GitHub Pages at [wmcmo.github.io/hashigo](https://wmcmo.github.io/hashigo/) |

## Where to read next

| file | for |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Working rules for this repository, and the index of settled decisions |
| [`DECISIONS.md`](DECISIONS.md) | Why each decision was made, with the measurements behind it |
| [`NEXT.md`](NEXT.md) | Current figures and what is left, in dependency order |
| [`SPEC.html`](SPEC.html) | The build specification |
| [`design-system/`](design-system/README.md) | Colour, type, components and the mark |
| [`app/README.md`](app/README.md) | The app: running it, deploying it, what running it taught us |

## The name

はしご is a ladder. The mark is one: two rails leaning in, three rungs, and a loose top
rung in 瑠璃 (ruri, lapis blue). That top rung is the step not taken yet, and it is the
only blue on the review screen apart from the play button.

## Publishing

Hashigo will open to other people only after:

1. a month of daily use with almost no changes needed,
2. a friend starting from an empty database without help, and
3. a plan for cost, accounts, licensing and support.
