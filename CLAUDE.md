# Hashigo (梯子)

A spaced-repetition app for Zach's Japanese study, replacing Mochi. He uses it every day:
the laptop for home reviews and all card creation, the phone mostly for reviews.

Live at <https://hashigo.titan-zp4.workers.dev> (Cloudflare Worker in `cloud/app/`).
Repo: <https://github.com/wmCmo/hashigo>, pushed as the `wmCmo` account.

## How it works

- `app/` is vanilla TypeScript on Vite. Each device keeps a SQLite database in the
  browser's OPFS (sqlite-wasm) and syncs with the others through a mailbox in the Worker
  (`cloud/mailbox/`). Reviews merge as a union; card schedules take the last review.
- `src/` is the library: `db`, `schema`, `import`, `render`, `review`, `scheduler` (FSRS-6),
  `session`, `sync`, `generate` (TTS and example sentences, proxied through the Worker),
  `accent` (pitch accent), `cards`, `fields`, `template`, `search`, `backup`, `blobs`.
- `tools/` is Python: the pitch-accent analyser and the laptop helper
  (`npm run accent:helper`) that fills 読み, 型 and OJAD on new cards.
- `design-system/` is the look. `app/style.css` applies it under older token names, and
  type sizes and spacing must come from `design-system/tokens.json` (tests refuse raw values).
- `DECISIONS.md` says why the app is the way it is, by number. Read the entry when you
  touch one; add a new one when Zach decides something.

## Commands

```bash
npm run gates                 # all six checks; run once before each commit
npm run gates -- --quick      # skips the two slow corpus re-imports when nothing reaches them
npm run app:dev -- --host ::  # local dev server (127.0.0.1 refuses ::1, which localhost hits)
npm run release -- patch      # every deploy is a release; `-- minor "..."` when SCHEMA/SYNC/ARCHIVE_VERSION moved
git push origin HEAD:main; git push origin vX.Y.Z
npm run app:build:cloud       # then in cloud/app/: npx wrangler@4 deploy
```

Commit, push and deploy finished work without asking. Confirm a deploy by reading the live
version. A running app picks up a deploy by itself and never reloads under a card.

## Facts the code can't tell you

- **The live data is on the devices**, not in `build/hashigo.db` or `exports/`. The Mochi
  import happened once and never again; rebuilding from `exports/` throws away every grade
  made since. Scripts that change live data go through the mailbox (`scripts/cards-add.ts`,
  `scripts/ojad-fill.ts`) and are dry until `--apply`.
- **Audio must not autoplay on a `Reading = true` 単語 card**: he says the accent aloud
  before hearing it. On every other 単語 and 言葉 card the audio plays on entry and is the
  prompt. Tests pin both.
- Google TTS ignores the yomigana accent notation when the element contains kanji, so
  requests carry the reading. No particle is ever added after the word.
- Don't set vitest `pool: "threads"`: better-sqlite3 segfaults. Use `npm test`, not raw
  vitest, which exits 1 on a passing run.
- Zach's shell is PowerShell 5.1: give him `$env:X="y"; cmd`, not `X=y cmd` or `&&`.
  Scripts that print Japanese set UTF-8 themselves (the console is cp932).
- Python is `python`; the accent venv is `.venv-accent`. Never read an export's `data.json`
  into context; `tools/mochi.py` reads it.
- Other sessions may share this checkout: check `git status` before committing.
