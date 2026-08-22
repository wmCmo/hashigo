# Overnight build — completeness report

> [!WARNING]
> **SNAPSHOT, 2026-08-19. Some claims below are superseded — see `NEXT.md` and
> `CLAUDE.md` for current state.** This is kept as the record of what was found and
> measured at the time, so it is not rewritten. Known stale in this file:
> - test count 242 (now 542)
> - "there is no renderer" — stage 4 landed 2026-08-20
> - target retention 0.95 wherever it appears (now **0.90**)

**The test suite is green.** `npm test` → 10 files, 242 passed, 1 skipped; `npm run
typecheck` → exit 0. I ran the suite three times end to end on a quiet tree and got
the same result each time, so the flakiness two agents reported was them watching
each other edit files mid-run, not a real defect.

Green tests are not the same as a working system. Below is what actually exists,
what is broken, and what needs your decision before stage 4 can start.

Written 2026-08-19 by the completeness critic. Every number here I measured myself,
from the raw export or from a database I imported fresh — not from another agent's
report. Where I am repeating someone else's measurement without re-running it, I
say so.

---

## 1. What actually works

| Claim | Command that proves it | Observed |
|---|---|---|
| Suite is green | `npm test` | `Test Files 10 passed (10)` · `Tests 242 passed \| 1 skipped (243)` · 38.55s |
| Types are clean | `npm run typecheck` | exit 0, no diagnostics |
| Python oracle still holds | `PYTHONIOENCODING=utf-8 python tools/mochi.py exports/日本語 exports/English exports/基本情報` | `cards 7,716 \| reviews 102,020 \| retention 96.24%` · `wiki-links 8,690 \| tombstones 8,958` · `tags after normalisation: 19` |
| A fresh import reproduces the oracle | `npm run import -- --db <new>.db exports/日本語 exports/English exports/基本情報` | 14.9s · `decks 45 / templates 10 / cards 7716 / reviews 102020 (58937 fwd, 43083 rev) / tags 19 / wiki-links 8690 / blobs 37763` · `retention 96.24%` · `integrity ok` |
| …and the numbers survive my own SQL, not theirs | direct `sqlite3` queries against that fresh DB | reviews 102,020 · passed 98,188 · lapses 3,832 · **96.24%** · 636.1 h over 92,089 timed · 1,317 JST active days · 2022-06-28→2026-08-18 · 5,674 cards studied · 234 archived |
| 2026 matches Mochi's screenshot | same, windowed to calendar 2026 JST | reviews 14,420 · **retention 95.10%** · **active days 211** · cards studied 5,182 |
| Tag corruption is really fixed | `select * from tags` on the fresh DB | 20 paths, zero containing U+200B/200C/200D/FEFF; 19 carry cards |
| MIME sniffing really works | see §5.8 | 10,805 of 10,816 media blobs stored as `audio/mpeg`, against 36 that claimed it |
| Japanese mid-string search really works | trigram `MATCH` over `card_fts` on the fresh DB | 15/15 random 4-char fragments taken from offset 3 of an unbroken CJK run retrieved their source card |

So: **stages 0, 1, 2, 3 and 5 are real.** The importer is lossless on everything it
imports, the dashboard is a genuine artefact you can open, the template parser
handles the corpus with zero unknown constructs, and the backtest is a serious
piece of work with an honest limitations section. That is a good night.

Everything below is the part nobody put in their summary.

---

## 2. What is INCOMPLETE or BROKEN

Ordered by how much it will hurt you.

### 2.1 The database is welded to a 657 MB directory you were told is not source

All 10,816 media blobs store an **absolute Windows path into `exports/`**:

```
speech  audio/mpeg  C:\DEV\WEB\hashigo\exports\日本語\c7EiABp0.mp3  31680
```

`exports/` is gitignored, is 657 MB, and `CLAUDE.md` calls it "NOT source —
reference data". Move the repo, rename a folder, or clean out the exports and every
audio file in Hashigo is gone. `--inline-blobs` exists as a flag; **it has never
been run over the full corpus**, so we do not know that it works at scale or how
large the resulting database is. Nothing in the suite covers relocation.

This is the single thing most likely to bite you in a week.

### 2.2 `npm run build` exits 0 and produces a package that cannot be imported

```
$ npm run build                       # exit 0
$ node -e "import('./dist/schema/index.js')"
THROWS: schema source schema.sql not found next to this module
        (.../dist/schema/schema.sql). The build must copy src/schema/*.sql
        alongside the emitted JS, or inline it.
```

`tsc` does not copy `.sql`. Three separate agents noticed this and each correctly
said "`package.json` is not my file", so it is still broken. It is a one-line copy
step. **A build script that exits 0 on a broken artefact is worse than no build
script**, because CI would go green on it.

### 2.3 54 wiki-links are silently dropped by the importer

`src/import/links.ts` only matches `[[display|card-id]]`. The corpus also contains:

* `[[card-id]]` — 46 occurrences, **all 46 resolve to real cards**
* `[[|card-id]]` — 8 occurrences, **all 8 resolve**

`card_links` holds 8,690 rows where 8,744 links resolve. The stage-3 agent found
this and reported it verbatim; nobody fixed it, and no test fails. Your `@` picker
and any backlink view will be missing 54 real edges.

### 2.4 There is no browser. At all.

SPEC locks the architecture as "Local-first PWA, one TypeScript codebase" with
"SQLite via OPFS". What exists is a Node library:

* no bundler, no `vite.config.*`, no `index.html`, no service worker, no manifest
* `src/db/open.ts`, `src/schema/index.ts`, `src/import/{index,transit,blobs}.ts`
  and `src/dashboard/{cli,metrics}.ts` all import `node:fs` or `better-sqlite3`
* every agent's "Not verified" section says "nothing browser/OPFS" — five times,
  independently, and it was nobody's assignment

Stages 4, 6, 7, 8, 9, 10 and 11 are all UI or runtime work that has to happen in a
browser. **The single largest untested assumption in the project is that this code
runs there**, and it is stage-0 scope that was skipped. `src/schema/schema.sql`
must load without `node:fs`; `better-sqlite3` has to become wa-sqlite/OPFS; blob
storage has to become OPFS rather than `C:\...`. Do this before stage 4, not after
stage 7.

### 2.5 The dashboard tells you something the backtest contradicts

`dashboard.html`, committed, renders:

```
> 365d   観測なし        (no observations)
```

`BACKTEST.md`, committed the same night, says there are **3,009 observations past a
year**. Both are "right" — the dashboard buckets by Mochi's *planned* interval, the
backtest by *elapsed* time — but only one of them is on screen, and it is the
misleading one. I measured retention under both definitions on the raw export:

| bucket | elapsed n | ret % | planned n | ret % |
|---|--:|--:|--:|--:|
| 0–1d | 13,495 | 96.67 | 7,087 | 95.41 |
| 1–7d | 22,899 | 97.73 | 21,236 | 98.15 |
| 7–30d | 19,759 | 96.88 | 19,876 | 96.69 |
| 30–60d | 10,065 | 94.22 | 10,393 | 94.50 |
| 60–180d | 14,424 | 93.34 | 14,070 | 93.24 |
| 180–365d | 9,343 | 94.35 | 11,398 | 95.15 |
| **> 365d** | **3,009** | **96.88** | **0** | — |

The `> 365d` row is the most decision-relevant number in the whole dashboard — it is
the direct evidence for "can I lengthen intervals past a year" — and the page says
you have no data. You have 3,009 reviews at 96.88%.

### 2.6 One number, three definitions, three consumers

`reviews.interval_days` is the *preceding planned* interval (importer's choice,
documented at `src/schema/schema.sql:227`). The backtest scores against *elapsed*.
The dashboard buckets by *planned*. This was flagged as unresolved by the stage-1
agent and by the stage-2 agent, and stage 5 measured it thoroughly (22,226 reviews
taken >1.5 days late, 240 early, 8,934 rows where planned is NULL but elapsed is
not) — but **nobody was authorised to settle it**, so it is still open and it
silently changes every retention-versus-interval figure you will look at. See §4.2.

### 2.7 Two-character Japanese search returns nothing

The trigram tokeniser needs 3 characters. Measured on the fresh DB, `MATCH` versus a
`LIKE` ground truth over the same bodies:

```
'意味'    (2)  LIKE 3    MATCH 0
'する'    (2)  LIKE 229  MATCH 0
'ない'    (2)  LIKE 77   MATCH 0
'気持ち'  (3)  LIKE 1    MATCH 1
'とはない' (4)  LIKE 1    MATCH 1
```

Three characters and up is exact. Two characters is the *commonest* search unit in
Japanese — 意味, 勉強, 漢字, 日本 — and it is unserved. `schema.sql` says "fall back
to a name LIKE scan for 1–2 character queries", but no such fallback is written, and
a name-only scan would miss all three of the `意味` hits, which are in bodies.
Stage 8 has to build the fallback over `body`, and that is a full table scan.

### 2.8 Smaller, but real

* **Append-only reviews are not.** `reviews_append_only` blocks `UPDATE`; `DELETE`
  is deliberately unguarded so that `ON DELETE CASCADE` from a card still works.
  Hard-deleting a card destroys its review history. Cards are archived rather than
  deleted today, so this is a loaded gun rather than a wound.
* **`card_field_values.field_id` has no foreign key** (intentional — a value must
  outlive a deleted field), so orphan rows are representable and nothing detects them.
* **The sanitiser is a policy object, not enforcement.** `ELEMENTS[].attributes` and
  `sanitiseStyle` exist; the parser keeps every attribute verbatim. The one real
  `<span style>` card (`QnHb5aT2`) passes straight through. Stage 4 must actually
  apply it.
* **`lang="่jp"`** — U+0E48 THAI CHARACTER MAI EK glued to `jp`, on one card.
  `normaliseLanguageTag` maps only the exact string `jp`, so this one falls through
  to "unknown language" and its TTS will fail. Inline tags measured: `jp` ×264,
  `ja-JP` ×15, `en` ×6, `่jp` ×1, plus `from="ja" to="en"` ×106.
* **3,159 templated cards carry 79,175 characters of hand-written `content` that the
  resolver discards** (emits a `content-ignored` warning). Stage 3 checked and 0 of
  3,159 match what the template renders — it is stale pre-template text. It is still
  79 KB of your own writing that Hashigo will never show you. Decide: discard,
  migrate into a field, or render below the template.
* **One blob remains `application/octet-stream`** after sniffing.
* **No CI, no `.gitattributes`** (SPEC.html throws a CRLF warning on every `git add`),
  **no `dashboard` npm script** — the CLI runs as
  `npx vite-node src/dashboard/cli.ts -- --db build/hashigo.db --out dashboard.html`.
* **`collect()` takes ~6 s** on the full corpus. Fine for a precomputed render,
  far too slow for an interactive filter, which is what stage 7 will want.

---

## 3. Everything committed, as reviewable history

`git log --oneline` (tree is clean, nothing uncommitted, branch `main`):

```
99a03ba stage 2: dashboard (verified)                           6 files  +3,210
a4b5409 stage 3: template engine (verified)                     9 files  +4,734
6b4a894 stage 5: scheduler backtest (verified)                  7 files  +3,705
e468a19 stage 1: importer + round-trip verification            11 files  +2,724 -12
7135a8a notes: reconcile 2026 dashboard figures                 1 file      +56
5e9a69e stage 1: importer — transit, entities, reviews, blobs   7 files  +3,743
a96f1ff stage 1: schema                                         6 files  +1,675
f417021 stage 0: project scaffold                              18 files  +3,700
```

Roughly 23,500 lines across 60 tracked files. Two stage-1 commits because the
importer landed in two passes. Commit order is not stage order — stage 5 was
committed before stage 3 and stage 2 — because the agents ran concurrently.

---

## 4. Design decisions that SPEC did not settle — these need you

Each of these was made overnight by an agent with no authority to make it. They are
all defensible; none of them is yours yet.

### 4.1 The importer keeps 45 decks where SPEC's "Settled" section says 39

**This one directly contradicts the spec.** SPEC/Settled: "The six empty leaf decks
are dropped — 副詞, 名詞, 形容動詞, 一段動詞, 形容詞, 五段動詞." The stage-1 agent kept
them, reasoning that stage 1's contract is "round-trip losslessly" and that a
lossless import can be filtered later while a filtered one cannot be un-filtered.
`--drop-empty-leaf-decks` gives you 39. Both are tested.

That is a good argument. It is still an agent overruling a settled spec decision,
and you should either accept it or flip the default.

### 4.2 `interval_days` means the *planned* preceding interval, not elapsed time

See §2.6. Consequences of choosing elapsed instead: the dashboard's interval tile
re-buckets (and its test is deliberately written as a canary that will fail),
8,934 currently-NULL rows become scorable, and the `> 365d` bucket gains 3,009
observations. The backtest measured that the *ranking* of schedulers is unchanged
under either definition, so this is a reporting decision, not an algorithm one.

### 4.3 Sides are structural — a `---` inside a field value is a horizontal rule

Card `EPp9rse6` (基本情報/第8章) writes a four-step answer into its `Cue` field with
three `---` lines in it. Splitting sides after interpolation would give that card
five sides and make `templates.reverse_permutation` undefined over a
variable-length list. So interpolated `---` becomes an `hrule` plus a
`side-break-in-value` warning. Reasonable; unspecified.

### 4.4 The template wins over `content`, and `content` is reported rather than shown

See §2.8. 3,159 cards affected.

### 4.5 Emphasis parsing deviates from CommonMark on purpose

`**` is permissive about interior whitespace (so `**to build up **` bolds), single
`*`/`_` use tight flanking (so `\*` jisho wildcards and underscores in filenames
survive). A later fix extended the intraword `_` rule from ASCII `\w` to
`[\p{L}\p{N}_]`, which was a genuine Japanese bug: `路_線_図` was being italicised.

### 4.6 A `boolean` field interpolates to the empty string; an unresolved `<<Foo>>` stays a field node

Defensive only — no corpus template interpolates a boolean.

### 4.7 Blob storage defaults to `path`, not inline

See §2.1. Nobody chose this; it was the default that shipped.

### 4.8 The scheduler recommendation is FSRS-6 with a fitted vector, cap 730 days, target retention 0.90 untuned

`BACKTEST.md` recommends: ship FSRS-6; ship the fitted parameters marked
provisional and refit once real grades exist; keep max interval configurable and
raise it in steps (cap ~730d) rather than letting a model schedule 1,000 days off
censored data; per-deck target retention defaulting to 0.90, **explicitly not tuned
yet**. SPEC said the backtest would "produce a recommended default" — the backtest
declined, on the grounds that 5 of 17 free parameters land on clamp boundaries and
wildly different vectors score within 0.0006. It also states the win is small: 0.1905
log loss against a no-input baseline's 0.2111, and on RMSE *stock* FSRS-6 loses to
that baseline. **Nobody should expect switching away from Mochi to feel like a better
scheduler.** That is the correct call and it needs your sign-off.

### 4.9 Reverse review was forced on for six named cards

`J3R240Q0 rhX2sKTs 6bOaHfsA oYjmEPwB 9IsiWF95 izVJ06yd` carry reverse history their
deck would not schedule. SPEC mandates this ("do not orphan history"), so the rule
is right — but those six cards will now show up in reverse review and they did not
before.

### 4.10 Smaller ones, listed so they are not invisible

* Dashboard `asOf` defaults to the last review date (230 days), not today (231, which
  is what Mochi's screenshot shows). Both spellings are asserted.
* The dashboard has **no JavaScript at all** — native SVG `<title>` for hover,
  `<details>` tables under 6 of 11 charts. Justified by SPEC problem #1 (battery),
  but it means the heatmap's 1,317 daily values are hover-only.
  **FIXED 2026-08-22** — each year strip now carries a `<details>` table, 1,317 rows
  across five years, still with zero JavaScript. Nothing on the page is hover-only
  except the zero-review cells, whose tooltip carries no number.
* Heatmap uses 4 quartile bins (a 5-bin ramp failed the contrast validator).
* `tags` holds 20 rows for 19 real tags — `Dialect` is a childless ancestor row so
  that `Dialect/Kansai` can satisfy `parent_path`. Any query counting tags must
  filter `cards_direct > 0`.
* Templates are inserted before decks (FK from `decks.default_template_id`).
* `vite-node` runs the CLIs, because Node 24 strips types but will not resolve a
  `.js` specifier to a `.ts` file.

---

## 5. Where the data contradicts SPEC.html

**SPEC is authoritative on design; the export is authoritative on fact.** I measured
every one of these myself against `exports/`. I have not edited SPEC.html — apply
these deliberately.

### 5.1 There are 10 templates, not 11

`oiaISYb2` (単語) is defined byte-identically in both 日本語 and 基本情報. Eleven rows
across three files, ten distinct templates. The importer must upsert by id.

### 5.2 There are zero cloze reviews, not "22 cards"

SPEC's card-fields table lists `cloze/reviews | 22 cards | keep → track cloze:n`.
Measured: the key is present on **24** cards and is **empty on all 24**. Combined
with `cloze/indexes` being empty on all 7,716 (which SPEC does say), the cloze track
has *no observations whatsoever*. Build the abstraction, as SPEC argues — but know
there is nothing to test it against.

### 5.3 `needs-rereview?` is per-track, and it is 17 cards / 337 reviews, not 1 / 81

| flag | key present | actually true |
|---|--:|--:|
| `needs-rereview?` | 8 | **1** |
| `reverse/needs-rereview?` | 24 | **16** |
| `cloze/needs-rereview?` | 24 | **0** |
| reviews with `rereview?` true | 352 records carry the key | **337** |

SPEC says "1 card, 81 reviews". The card-level count of 1 is right; SPEC misses the
reverse track entirely (16 more cards) and the review count is 337, not 81. This
matters for the leech policy SPEC lists as Open — you have four times the sample you
thought.

### 5.4 Speech generations are 24,558, not 19,710

The field-types table lists 19,710 for both the `speech` row and the `ai` row — the
AI figure is copy-pasted onto the speech row. Measured breakdown of the 56,767
`component-cache` entries (**that total is exactly right**):

```
ai 19,710 · speech 24,558 · translate 9,216 · furigana 3,255 · image-search 18 · dictionary 10
```

`furigana 3,255`, `dictionary 10`, `image-search 18` are all exactly as SPEC says.

### 5.5 The wiki-link and reference numbers are two different sets, and SPEC reads as one

* `references` array: **7,771 entries, 8 unresolved, 7 distinct targets** — SPEC's
  "7,763 of 7,771 resolve" is correct, and it is about this array.
* Parsed `[[display|card-id]]` in text: **8,690 occurrences, 18 unresolved, 15
  distinct targets** — SPEC's "8,690 wiki-links" is correct, and it is about this.

They differ by 97 pairs in one direction and 1 in the other. SPEC presents both
figures in one paragraph as though the 8 unresolved belong to the 8,690.

And one of those 8 unresolved references is **not** "a deck you didn't export": it is
the literal string `enactment`, from card `gN7K9IpR`, which writes
`[[**enactment**|zeeUDLTL]]`. Mochi's own reference extractor mis-parsed the bold
marker and stored the display text as a card id. Seven of the eight are genuine
unexported targets; one is a Mochi bug.

### 5.6 The tag counts in the card-fields table and the tag section disagree

SPEC's table says "20 distinct, 62 cards". SPEC's tag section says "23 tags into 19".
Measured: **23 raw distinct → 19 after normalisation**, on **62 cards**, **69
(card,tag) pairs** in the export, landing as 66 `card_tags` rows (three pairs collapse
when a card carried both `Mathematics` and `␣Mathematics`) and 20 `tags` rows (the
childless `Dialect` ancestor). All correct behaviour; the table's "20 distinct" is
the stale figure.

### 5.7 `<span style>` is one use on one card; LaTeX is 18 cards, not 19

SPEC counts "2" for `<span style>` — that is the open and close tag of a single
element. My independent counts of surface 1, against SPEC's table:

| construct | SPEC | measured |
|---|---|---|
| `[[d\|id]]` | 8,690 / 4,323 cards | **8,690 / 4,323** ✓ |
| `---` | 1,694 / 1,140 | **1,694 / 1,140** ✓ |
| `{{cloze}}` | 1,087 / 550 | **1,087 / 550** ✓ (1,086 outside code spans) |
| `**bold**` | 315 / 292 | **315 / 292** ✓ (314 outside a wiki-link display) |
| `` `code` `` | 294 / 228 | **294 / 228** ✓ |
| `___` | 255 / 249 | **255 / 249** ✓ |
| `$…$` | 29 / 19 cards | 29 uses / **18 cards** |
| `<span style>` | 2 | **1 use, 1 card** |
| `<draw>` | in "long tail 14" | 2 |
| markdown images | in "long tail 14" | 7 |
| ordered list items | 4,314 / 1,392 | **not reproducible** — see below |

The ordered-list figure depends entirely on the counting rule. `^\d+\.` on raw text
gives 4,314; normalising bare `\r` line endings first gives 4,318 (40 lists were
pasted from a dictionary as `1. …\r\n\r2. …`, and CommonMark treats a bare `\r` as a
line ending while Python's `re.M` does not); allowing indented/nested items gives
4,538. SPEC should state which rule it used. Everything else in the table reproduces
exactly, which is a real credit to whoever measured it.

### 5.8 "Harmless" is wrong: 99.7% of your audio is mislabelled

SPEC: *"several mp3 attachments carry `"type": "text/xml"` … Harmless, but the
importer should sniff."* Measured over the 10,887 live attachments:

```
text/xml                  3,443
application/octet-stream  4,979
"" (empty string)         2,424
audio/mpeg                   36   <- the only correct ones
image/jpeg                    4
image/png                     1
```

**36 of 10,887 files carry a correct type.** A browser handed `text/xml` in an
`<audio>` element will not play it. This was never harmless — it was invisible only
because Mochi's own player ignores the field. After sniffing: 10,805 `audio/mpeg`,
9 `image/jpeg`, 1 `image/png`, 1 unresolved `application/octet-stream`. The importer
gets this right; the spec's assessment of the risk does not.

### 5.9 Mochi's 365-day cap was lifted on 2026-02-21

The stage-5 report states flatly "Mochi caps intervals at 365 days". The data is more
specific and more useful:

* the maximum planned interval in the corpus is **2,707 days**, matching SPEC's own
  "max 2,707 d" exactly
* **7,407** review records sit at exactly 365 days; the next most common value has 44
* **1,356** records exceed 365 days, and **every single one was written on or after
  2026-02-21** (range 2026-02-21 → 2026-08-17, due 2027–2033)

So a 365-day cap was in force from 2022-06 until 2026-02-21 and was then raised or
removed. Six months of post-cap scheduling exists; none of it has come due. Phrase it
with the date, because "Mochi caps at 365" implies a constraint that is no longer
operating.

### 5.10 SPEC's interval statistics are all *planned* intervals; elapsed looks nothing like them

SPEC's over-studying table reproduces exactly — median 24.7d, p75 123d, p90 358d,
max 2,707d, and "7.6% / 7,090 reviews at ≤ 1 day". Every figure is Mochi's `interval`
field, which is the interval chosen *after* each review. The distribution of time
that actually *elapsed* between consecutive reviews of a track:

```
planned:  median 24.7   p75 123    p90 358    max 2,707
elapsed:  median 15     p75  74    p90 210    max   454
```

And the sub-daily figure: 7,090 reviews were *scheduled* ≤1 day out (7.62% of the
93,076 records carrying an interval — 6.95% of all 102,020), but **13,495 reviews
were actually taken within a day of the previous one**, of which 6,996 were the same
day. The "learning steps" question SPEC lists as Open is about twice the size it
looks.

### 5.11 `tools/mochi.py`'s own docstring overstates a trap

> `content` is `""` on templated cards; the real text lives in `fields[].value`.

Measured: **3,159 of 7,346 templated cards have non-empty `content`** (79,175
characters total). The warning is directionally right — a scan reading only `content`
misses most of the corpus — but the literal claim is false, and it is why §2.8's
79 KB of orphaned text went unnoticed until stage 3.

### 5.12 Confirmed exactly as SPEC states

For balance, all of these I checked and they are right: 7,716 cards · 102,020 reviews
(58,937/43,083) · 96.24% · 1,317 active days · 636.1 h over 92,089 timed reviews ·
3,832 lapses · 10,887 live attachments · 8,958 tombstones · 56,767 component-cache
entries · 234 archived · `pinned?` present on 828 cards and set on **0** · 3,769 of
5,947 日本語 cards carry a reverse track · every review timestamp is exactly
`15:00:00Z` with **no** exceptions · `cloze/indexes` empty on all 7,716.

---

## 6. What each remaining stage now needs

### Blocked on you providing something

| Stage | Needs from you |
|---|---|
| **9 · Generation** | **Azure Speech API key** (region + key). **An LLM API key** and a choice of model for `<ai>` fields. **A translation key**, or a decision to route `<translate>` through the same LLM and drop the separate service. |
| **11 · Sync** | **A Cloudflare account** with Workers, D1 and R2 enabled, plus an API token. |

Nothing else is blocked on credentials. Note that SPEC's cost model says all of this
lands under $1/yr and Azure TTS is free at your volume (~58K chars/yr against a
500K/mo free tier), so the keys are a signup exercise, not a spend decision.

### Blocked on a decision, not a key

* **Stage 6 · Scheduler** needs §4.2 (interval definition) settled and §4.8 signed
  off before the winning algorithm is wired to tracks.
* **Stage 4 · Renderer** needs the sanitiser enforced (§2.8) and the browser shell
  to exist (§2.4).

### Ready to build, in dependency order

1. **Stage 0.5 (unlisted, do it first) — the browser shell.** Bundler, PWA manifest,
   service worker, OPFS-backed SQLite, and `schema.sql` loading without `node:fs`.
   Everything below is blocked on it and nobody has proved any of it works. Also
   fixes §2.2 on the way past.
2. **Stage 4 · Renderer.** AST → DOM for all 21 node types, whitelist enforced,
   cloze reveal, `<furigana>` ruby, `<draw>` canvas with its `height`/`brushColor`/
   `brushRadius` attributes, `<input>` typed answer. Note SPEC's answer-leak warning:
   side 4 of 単語 carries `https://jisho.org/search/<<Kanji>>`, so link URLs must not
   render on the question side in reverse mode.
3. **Stage 6 · Scheduler.** FSRS-6 over tracks. The port is already verified against
   `fsrs-rs`'s own regression fixture. Add the max-interval setting (§4.8) and the
   per-deck target retention setting.
4. **Stage 7 · Review UI** plus the deferred 復習予測 forecast tile.
5. **Stage 8 · Search.** Schema is done. The work is the 1–2 character fallback
   (§2.7) and the picker UI.
6. **Stage 9 · Generation.** Beyond the keys: the DAG resolver must pull `<<field>>`
   references out of AI *prompt strings* (SPEC is explicit, and `例文` has
   `source: null` for exactly this reason). Stage 3 found where the existing output
   lives — `component-cache`, keyed `kind → "<resolved source text> {:options}"` —
   so **seed the cache from the import rather than regenerating 56,767 entries**.
   Also: `resolveSideTexts` does not normalise line endings, so the same text with
   `\r\n` versus `\n` hashes to two different cache keys (47 field values contain
   `\r`); and `jp` versus `ja-JP` versus `่jp` must collapse *before* hashing or you
   will re-bill Azure for audio you already have. Furigana goes local (kuromoji /
   MeCab+UniDic) per SPEC, which needs a dictionary bundled.
   **You already have a 56,767-entry labelled test set** for prompt quality — SPEC's
   Open item "run the real emoji-gloss prompt over twenty words" can be run over
   19,710.
7. **Stage 10 · Editor.** Needs 4 and 8. Fix §2.3 first or the `@` picker inherits
   the missing 54 links.
8. **Stage 11 · Sync.** Last, per SPEC, and correctly so.

### Still Open in SPEC and still open now

* **Leech policy.** SPEC says "only one card currently carries the flag, so there is
  nothing to preserve". §5.3 corrects that: 17 cards and 337 reviews. Still needs a
  designed rule.
* **LLM choice.** Unchanged; now with a 19,710-example test set.
* **Sub-daily intervals.** The backtest could not answer it — 6,996 same-day reviews
  have no recorded elapsed time, and all five candidate models score identically
  (0.5055) on them. It is unanswerable until real timestamps accumulate. §5.10 says
  the question is about twice as large as SPEC estimated.

---

## 7. Things I could not verify

* **Anything in a browser.** No bundler exists, so "this code will run in a PWA" is
  asserted by everyone and demonstrated by no one.
* **`--inline-blobs` at full scale.** Never run over 657 MB, by me or anyone.
* **Rendered appearance of `dashboard.html`.** I verified it structurally and
  numerically; I did not open it in a browser. The stage-2 agent did, at 1200px in
  both themes, and fixed three layout defects.
* **The template renderer's output**, because there is no renderer, and because
  `content` on templated cards turns out to be stale rather than a render cache —
  so there is nothing in the export to diff a render against. The parser is verified
  against its contract and against injected mutations, not against Mochi's output.
* **`w[15]`/`w[16]` in the FSRS port** (hard penalty, easy bonus). Neither the
  upstream fixture nor this corpus contains a Hard or Easy rating. They are frozen
  throughout, so no published number depends on them.
* **All timings** are Windows plus better-sqlite3 on this machine.
* **Whether Mochi's 13,240 is reachable.** Fourteen definitions were tried; 13,258
  (one review per card per day) is the closest and is 18 off. Do not tune to it.
