# Hashigo (梯子)

A local-first spaced-repetition app replacing [Mochi](https://mochi.cards) for one
user's Japanese study. Built because Mochi's developer stopped fixing reported bugs.

**Read [SPEC.html](SPEC.html) first** — it is the authoritative design document
(build spec, draft 3). Every figure in it is measured from the real export in
`exports/`, not estimated. Published copy:
<https://claude.ai/code/artifact/c8416a42-779a-49da-81c1-54459067d94b>

Nothing is implemented yet. Stage 1 of the build order in SPEC.html is next:
schema + importer.

## The four problems this exists to solve

1. Battery drain on phone → no polling, no sockets, precomputed renders
2. $60/yr → own API keys, real cost under $1/yr
3. Android sync crashes → own the sync layer
4. Attachment churn and manual re-syncing → content-addressed, refcounted blobs

## Repo layout

```
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

```
cards 7,716 | reviews 102,020 | retention 96.24%
wiki-links 8,690 | tombstones 8,958
inline generators: {'speech': 287, 'translate': 106, 'image': 8, 'furigana': 19, 'ai': 125}
tags after normalisation: 19
```

The module docstring in `tools/mochi.py` lists the format traps that cost real time
to find — Transit's two different timestamp encodings, the double-counting deck
walker, `content` being empty on templated cards, zero-width spaces in tags. Read it
before writing anything that parses the export.

`exports/` should not be committed — 657 MB of generated audio. Add it to
`.gitignore` when the repo is initialised.

## Environment

- **Windows.** The console is **cp932** (Japanese locale), so any script printing
  Japanese needs both `PYTHONIOENCODING=utf-8` in the environment and
  `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` in the script.
  Without them you get `UnicodeEncodeError` on the first kanji.
- Python is `python` (3.13). `python3` is not on PATH — it hits the Microsoft Store
  alias and fails.
- The Bash tool's working directory does not reliably persist between calls. Use
  absolute paths, or `cd` in the same command.

## Conventions

- Deck, template, and field names are Japanese where the user wrote them Japanese.
  Do not translate or romanise them — `単語`, `漢字`, `例文`, `意味` are identifiers.
- Language codes normalise to BCP-47 (`ja-JP`), never Mochi's inline `jp`.
- Prefer measuring over assuming: this project has 102,020 graded reviews and 19,710
  existing AI generations, which double as labelled test sets. See the memory note
  on not inheriting Mochi's defaults.
