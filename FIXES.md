# Fixes — what actually landed

> [!WARNING]
> **SNAPSHOT, 2026-08-19. Some claims below are superseded — see `NEXT.md` and
> `CLAUDE.md` for current state.** This is kept as the record of what was found and
> measured at the time, so it is not rewritten. Known stale in this file:
> - test count 306 (now 542) · target retention 0.95 (now **0.90**)
> - "blobs are one file per payload" and the 65x multiplier — payloads moved into
>   BLOB rows and the re-measured advantage is 13-40x
> - "there is still no renderer" — stage 4 landed 2026-08-20
> - §3's 7 unratified decisions: 3 have since been decided, 1 was informational,
>   2 remain open (the `orphanFieldValues` definition, and the OVERNIGHT §4 bundle)

**The test suite passes: `npx vitest run` → 10 files, 306 passed, 1 skipped (307), twice in a row, and the one skipped test passes too when its gate is opened.**

Written 2026-08-19 by the completeness critic, the last agent of the run. Every
number below I measured myself, from the raw export or from a database I imported
fresh into a scratch directory. I re-ran every pass condition rather than trusting a
pasted one. Where I am repeating someone else's figure without regenerating it, I say
so.

Six fixes were claimed. **Three are fully fixed, three are partial**, and the partial
ones share a single cause: each fix was verified against the file its author owned,
and the defects that survived all sit in the seams *between* files. That is the same
failure as last night in new clothing — not "nobody noticed", but "everybody noticed
and each correctly concluded it was not theirs".

---

## 0. The pass conditions, regenerated

```
$ npx vitest run
 Test Files  10 passed (10)
      Tests  306 passed | 1 skipped (307)
   Duration  39.42s

$ npx vitest run --reporter=json          # second run, stability check
files 80 passed suites 80 failed suites 0
tests 307 passed 306 failed 0 pending 1

$ HASHIGO_FSRS_FIT=1 npx vitest run test/backtest.test.ts
train rows 60163 · loss 0.150633 -> 0.143209 · 12 sweeps · 4081 evaluations · 27.7s
held-out log loss  refitted 0.190474 · stock 0.203801 over 25835 reviews
 ✓ test/backtest.test.ts (38 tests) 40193ms
   ✓ the 102,020-review backtest > refits from scratch and reproduces the committed parameters  27834ms
 Test Files  1 passed (1)
      Tests  38 passed (38)

$ npm run typecheck
=== TYPECHECK_EXIT=0 ===            # no diagnostics

$ npm run build
hashigo-build: VERIFIED 31 modules imported, 2 CLI(s) skipped, 2 .sql byte-identical,
               33 .js with types, 22 package.json entry points resolve
hashigo-build: OK — dist/ compiled, complete, and importable
=== BUILD_EXIT=0 ===
```

The single skip is the FSRS refit behind `HASHIGO_FSRS_FIT=1`. I ran it: it passes and
reproduces the committed parameter vector exactly. So the honest headline is **307 of
307**, not 306 with an asterisk.

**The Python oracle has not moved.**

```
$ PYTHONIOENCODING=utf-8 python tools/mochi.py exports/日本語 exports/English exports/基本情報
=== TOTAL
    cards 7,716 | reviews 102,020 | retention 96.24%
    wiki-links 8,690 | tombstones 8,958
    inline generators: {'speech': 287, 'translate': 106, 'image': 8, 'furigana': 19, 'ai': 125}
    tags after normalisation: 19
```

**A fresh import into a database nobody else has touched**, then queried with SQL I
wrote from `schema.sql` rather than through `src/dashboard/metrics.ts`:

```
$ npm run import -- --db <scratch>/critic.db exports/日本語 exports/English exports/基本情報
imported 日本語, English, 基本情報 in 28.8s

decks                              39      card_links                       8744
templates                          10        distinct from_card             4335
template_fields                    41      blobs                           37763
cards                            7716      blob_refs                       42569
card_field_values               22319      active days (JST)                1317
card_tracks                     13392      range        2022-06-28 -> 2026-08-18
reviews                        102020      timed reviews                   92089
  forward                       58937      study hours                      636.1
  reverse                       43083      tags rows                          20
retention                      96.24%      tags with cards                    19
lapses                           3832      card_tags                          66

reviews has elapsed_days         true      blobs.path non-NULL                 0
reviews has scheduled_days       true      >365d by elapsed_days    n=3009 96.88%
reviews has interval_days       false      >365d by scheduled_days          n=0
reviews has grade col           false
```

Every oracle figure lands. `interval_days` is gone and both intervals are named
(decision 6). There is no `grade` column (decision 2). `blobs.path` is NULL on all
37,763 rows (decision 4). 39 decks (decision 3).

---

## 1. The six fixes

### 1.1 build + packaging — **FIXED**

The build refuses to exit 0 on a package nobody can import, and the packaged artifact
genuinely works from an unrelated working directory. I tested the real consumer path,
not the in-repo one:

```
$ cd <scratch> && node -e "import('file:///C:/DEV/WEB/hashigo/dist/...')"
  OK   index.js 2 exports          OK   blobs/index.js 21 exports
  OK   schema/index.js 29 exports  OK   dashboard/index.js 22 exports
  OK   text/index.js 7 exports     OK   scheduler/policy.js 7 exports
  OK   import/index.js 20 exports  OK   template/index.js 50 exports
                                   OK   db/index.js 5 exports
cwd C:\Users\Zach\AppData\Local\Temp\...\scratchpad
ok 9 fail 0
```

`npm pack` ships the SQL — the live risk, since `dist/` is gitignored and `.sql` is
not a file type npm has any reason to keep:

```
tarball files 135 size 292066
.sql  : ["dist/schema/schema.sql","dist/schema/views.sql"]
.db   : 0      .mp3  : 0      exports/: 0
```

No caveat. This one is done.

### 1.2 content-addressed blob store — **PARTIAL**

The headline is real and I reproduced all of it. Store from my own fresh import:

```
store files: 10818        (10,816 payloads + .gitignore + marker)
store bytes: 654917478
db bytes:     72773632
blobs with bytes NOT NULL 26947    (text generations, inline)
blobs with bytes NULL     10816    (media, external, content-addressed)
mime after sniff: text/plain 26940 · audio/mpeg 10805 · image/jpeg 9
                  application/json 7 · image/png 1 · application/octet-stream 1
```

`blobs.path` is NULL on every row, and the shipped acceptance check passes:

```
$ npx vite-node src/blobs/cli.ts -- --db <scratch>/critic.db paths
blobs.path non-NULL   0
columns swept         105 across 13 table(s)
NO absolute path and NO reference to exports/ anywhere in the database
=== PATHS_EXIT=0 ===
```

I did not trust their predicate. I wrote a sweep deliberately broader than the shipped
one — every table including the FTS shadow tables, every column regardless of declared
type, BLOB values decoded as utf8 *and* utf16le, JS regex instead of SQL LIKE, seven
patterns instead of their set:

```
tables 19 | columns swept 123 | non-null cells 1286470
      2 drive-forwardslash :: card_fts_data.block     (binary FTS index pages)
      4 drive-forwardslash :: templates.content       (see below)
```

Both are my own regex's false positives. The `templates.content` hits are Zach's own
dictionary links — `https:/` contains `s:/`:

```
itmYDz2N 言葉  -> "🀄[TAKOBOTO](https://takoboto.jp/?q=<< 言葉 >>)"
oiaISYb2 単語  -> "🀄[JPDB](https://jpdb.io/search?q=<< 単語 >>)"
Dq5TYgr9 漢字  -> "📗[Jisho](https://jisho.org/search/<< Kanji >>%20%23kanji"
Q37a0W3E New Vocab -> "🎬[YouGlish](https://youglish.com/pronounce/<< Vocab >>/engl"
```

**So there is no absolute path in the database.** Confirmed independently and more
broadly than the shipped check does it.

**Why PARTIAL: the acceptance gate still has a hole, and I demonstrated it
end-to-end.** `LOCATION_PATTERN` in `src/blobs/db.ts` anchors its POSIX branch at
string start (`^\/[^/\s]+\/`) with no `m` flag, so a POSIX absolute path that is not
the very first thing in the value is invisible to it. I probed the exported pattern
with twelve inputs:

```
--- SHOULD be flagged as a location
  ok     backslash drive                "C:\\Users\\Zach\\media\\x.mp3"
  ok     forwardslash drive             "C:/Users/Zach/media/x.mp3"
  ok     lowercase drive                "d:/media/x.mp3"
  ok     UNC                            "\\\\NAS\\media\\x.mp3"
  ok     file url drive                 "file:///D:/media/x.mp3"
  ok     file url posix                 "file:///home/zach/x.mp3"
  ok     posix abs at start             "/home/zach/media/x.mp3"
  ok     exports rel                    "exports/日本語/c7EiABp0.mp3"
  ok     exports abs                    "C:\\DEV\\WEB\\hashigo\\exports\\日本語\\..."
  MISS   posix abs EMBEDDED in json     "{\"path\":\"/home/zach/media/x.mp3\"}"
  MISS   posix abs after newline        "note\n/home/zach/media/x.mp3"
  ok     drive embedded in json         "{\"path\":\"C:/Users/Zach/x.mp3\"}"
--- should NOT be flagged
  ok     https jisho / https takoboto / single-backslash division 変動費率＝変動費 \ 売上
  ok     latex \times / bare word "exports." / 1/2 / 15:00:00Z
failures: 2
```

Then end-to-end, poisoning `VACUUM INTO` copies of my fresh database and running the
real acceptance command against each:

```
DETECTED   exit=1  drive-letter into settings.value
DETECTED   exit=1  posix-abs into settings.value
SLIPPED    exit=0  posix-abs EMBEDDED in template_fields.options JSON
DETECTED   exit=1  drive-letter EMBEDDED in template_fields.options JSON
SLIPPED    exit=0  posix-abs EMBEDDED in cards.content
```

Two of five poisonings pass the gate. On Windows today this is unreachable — Zach's
paths are drive-letter form and those are all caught. It becomes reachable the moment
anything runs on Android or OPFS, which is problem #3 and stage 0.5. A gate whose
whole job is paranoia should not have a shape it cannot see. The fix is one flag and
one anchor: `(^|[\s"'(=,:])\/[^/\s]+\/` , or add `m` and keep `^`. See ORPHAN 3.

Two good things I want to record because they are load-bearing and undersold: `blobs`
is genuinely immutable — my first poisoning attempt was rejected by a trigger,
`blobs are immutable: insert a new hash instead` — and the false-positive work is
real. The single-backslash branch correctly leaves Zach's own arithmetic
(`変動費率＝変動費 \ 売上`) and LaTeX `\times` alone, which a naive pattern would flag.

### 1.3 wiki-links + text rendering — **FIXED**

I counted the three link forms myself from the raw export, with my own regex, without
touching their code:

```
$ PYTHONIOENCODING=utf-8 python  (via tools/mochi.py over all three exports)
cards scanned    7716
piped [[d|id]]   8690
bare  [[id]]       46
empty [[|id]]       8
TOTAL links      8744
cards with >=1   4335
distinct targets 2895
targetless (NOT links, stay literal): 0
```

8,690 + 46 + 8 = 8,744, on 4,335 cards. The database agrees exactly:

```
card_links                               8744
unresolved                               18
empty display_text rows                   0
field_id IS NULL (in content)          1019
card_links_resolved by text_present    [{"text_present":0,"n":889},{"text_present":1,"n":7855}]
search_text containing ]]                 0
search_text with U+200E                   0
cards.content with U+200E                34
```

The 54 previously-dropped edges are back and the oracle's 8,690 is untouched (that
figure counts the piped form only, which is what `tools/mochi.py` measures — the two
numbers are not in conflict and CLAUDE.md documents 8,690 correctly).

The grammar really is unified — `src/schema/index.ts:208` is now a two-line alias, not
a second implementation:

```ts
export function buildSearchText(...parts: readonly (string | null | undefined)[]): string {
  return renderPlainTextParts(parts);
}
```

The two-character Japanese search fallback works. I compared `searchPlan()` against a
ground truth I computed with `instr()` myself:

```
query      len mode  plan-rows  LIKE-rows  agree
意味         2   like  3          3          yes
する         2   like  50         228        NO (plan-only 0, truth-only 178)
日本         2   like  1          1          yes
勉強         2   like  1          1          yes
漢字         2   like  1          1          yes
気持ち        3   fts   1          1          yes
とはない       4   fts   1          1          yes
食べる        3   fts   3          3          yes
```

The "NO" rows are not disagreements: **`plan-only` is 0 in every case** — no false
positives anywhere — and the plan carries `LIMIT ?` bound to 50. It is pagination, not
loss. Worth knowing that the LIKE path is `ORDER BY card_id`, i.e. arbitrary order
rather than relevance, and is a full scan; that is stage 8's problem and is documented
as such.

One curiosity I chased and cleared: two cards leave a literal `[[` in `search_text`.
They are unclosed brackets in Zach's own dictionary pastes, correctly left alone:

```
2KtTkHOX | "太る"  | "ht; to gain weight; to grow fat; to get [[stout"
3aOsyyNd | "立派"  | "ate; lawful\n4. undeniable (e.g. crime); [[indisputable; solid"
```

### 1.4 importer defaults + stale content — **FIXED**

```
  map       39 decks, 10 templates, 7716 cards, 22319 field values
  reviews   102020 reviews across 13392 tracks
  links     8744 wiki-links, 18 unresolved
  blobs     10887 live attachments, 8958 tombstones skipped
  verify    ok
reverse forced on for 6 card(s) ... J3R240Q0 rhX2sKTs 6bOaHfsA oYjmEPwB 9IsiWF95 izVJ06yd
dropped 6 empty leaf deck(s)
discarded stale pre-template content on 3159 card(s), 79175 chars — the template
  overrides it and Mochi never showed it; recover from the export by card id
  (report.notes.staleContentCardIds, 20 sampled with text)
integrity ok
```

39 decks by default (decision 3), 3,159 cards / 79,175 chars discarded *and reported
with recovery instructions* (decision 5), the six reverse-history cards named rather
than silently promoted. `cards.content` is non-empty on 364 cards after import, which
is the residue that is genuinely current rather than stale. All independently
confirmed. This one is done.

### 1.5 dashboard + scheduler consumers — **PARTIAL**

The `> 365d` reconciliation is real, and it is better than claimed because it is
*reproducible*. I regenerated the dashboard from my own fresh database:

```
$ npm run dashboard -- --db <scratch>/critic.db --out <scratch>/critic-dashboard.html
wrote critic-dashboard.html (338348 bytes) in 7.1s
all time  reviews 102020 | retention 96.24% | active days 1317 | 636.1 h over 92089 timed
2026      reviews 14420 | retention 95.10% | active days 211 | days 230 | card-days 13258
forecast tile: not built (needs the scheduler, stage 6)
```

338,348 bytes, the same as the committed file, and the diff against the committed
`dashboard.html` is **four lines total** — two provenance pairs, nothing else:

```
164c164   < <dd>build/hashigo.db</dd>          > <dd>C:/Users/Zach/AppData/.../critic.db</dd>
168c168   < <dd>2026-08-19T04:48:15.578Z</dd>  > <dd>2026-08-19T06:36:15.517Z</dd>
```

Both bases are on screen, and `観測なし` is gone:

```
$ grep '365' dashboard.html
<tr><td>180-365d</td><td>9,343</td><td>528</td><td>94.35%</td><td>264.7</td><td>11,398</td><td>95.15%</td><td>287.8</td>
<tr><td>&gt; 365d</td><td>3,009</td><td>94</td><td>96.88%</td><td>387.5</td><td>0</td><td>—</td><td>—</td>
$ grep -c '観測なし' dashboard.html
0
```

And the zero in the scheduled column is a censoring artefact, not a claim about
memory, exactly as both documents now say. My own SQL:

```
next_scheduled_days > 365                  1356
next_scheduled_days = 365 exactly          7407
max next_scheduled_days                    2707
earliest date of a >365 plan         2026-02-21
scheduled_days > 365                          0
max elapsed_days                            454
```

1,356 plans past a year exist, the longest is 2,707 days, the cap lifted on
2026-02-21, and none of them has come due — so `scheduled_days`, which is the
*preceding* plan, is legitimately empty above 365. The policy constants are Zach's:
`MAX_INTERVAL_DAYS = 365`, `TARGET_RETENTION = 0.95`, w[15]/w[16] frozen and
documented as unreachable by design.

**Why PARTIAL: two defects, and the first is the most consequential thing in this
report.** Both are in §2.1 and §2.2.

### 1.6 spec — **NOT LANDED** (correct work, never committed)

The content is right. I validated the file myself:

```
unclosed: none | mismatched: none
bytes 68882 | lines 1288 | CR bytes 0
  ':root {'                                     x1
  'prefers-color-scheme: dark'                  x1
  ':root:not([data-theme="light"])'              x1
  ':root[data-theme="dark"]'                     x1
```

Balanced, LF-only, all four theme blocks present exactly once. And the corrections are
real — draft 3 → draft 4, with every figure matching what I measured independently:

```
"11 rows" x2   "24,558" x2   "2026-02-2" x2   "2,707" x2   "8,744" x6
"7,771" x2     "enactment" x2   "337" x2   "10,887" x3   "1,356" x1   "3,159" x2
"45 decks to 39" — present, stated as the default
```

Spot-checked against my own measurements from the fresh database — `needs-rereview`
is 1 card / 17 tracks / 337 reviews, exactly as the new SPEC says and not the "1 card,
81 reviews" draft 3 claimed:

```
cards needs_rereview      1
tracks needs_rereview    17
reviews rereview=1      337
```

And the MIME correction is right — the old "harmless" line is replaced with the real
breakdown, 36 correct of 10,887.

**But `git status` says:**

```
 M SPEC.html
```

**223 insertions, 51 deletions, uncommitted.** The spec agent left it for the
integrator; the integrator made seven commits and did not include it. This is the same
"not my file" failure the run was supposed to eliminate, and it is the one that would
have silently lost the most work — the authoritative design document, corrected in
fourteen places, one `git checkout` away from gone.

I confirmed no test reads `SPEC.html` from disk (only comment references), and the
suite is green twice over *with this file in the working tree*. So committing it is
inert functionally and saves 223 lines of verified corrections. **I committed it**, in
its own commit, clearly attributed — see §6.

---

## 2. What is still broken, or newly broken

Ordered by how much it will cost you. The first two are new — nobody reported them.

### 2.1 Your scheduler will run at 0.90 while every artefact tells you 0.95

This is the one to fix before stage 6, and it is live in committed code right now.

```
policy.ts TARGET_RETENTION           0.95
settings target_retention.default    0.90
deck_target_retention_resolved       [{"target_retention":0.9,"n":39}]
```

`dashboard.html` draws `目標 95%` in seven places. SPEC.html draft 4 now says
"target retention 0.95" and calls it settled. `src/scheduler/policy.ts` exports
`0.95`. **And all 39 decks in the database resolve to 0.90**, because
`schema.sql` still seeds `('target_retention.default', '0.90')` and
`deck_target_retention_resolved` bottoms out there.

BACKTEST.md knows. Line 651, in its own recommendation section:

> `settings.target_retention.default` in `schema.sql` still seeds `0.90`, FSRS's own
> default — that row belongs to the schema and has not been changed here.

Two agents saw it and both deferred to file ownership. The cost is not cosmetic —
BACKTEST.md's own workload table puts 0.90 at intervals of 47–82 days and 0.95 at
125–197 days. **Whichever consumer reads `settings` rather than `policy.ts` will
schedule roughly two to three times as much review as the documents promise**, and it
will look like the scheduler working correctly. `src/dashboard/render.ts` already
imports from `policy.ts`; nothing yet reads the settings row, which is exactly why it
has stayed invisible.

Note it is *not* a one-line change with no consequences: `test/schema.test.ts:607`
asserts `{ deck_id: "日本語", target_retention: 0.9 }` against the resolver view, and
`test/dashboard.test.ts:378` has a comment reasoning from "FSRS's 0.90 default". Both
have to move with the seed. That is why I did not change it myself — see ORPHAN 1.

### 2.2 `dashboard.html` writes whatever `--db` you gave it into the page

The dashboard echoes its `--db` argument verbatim into the `データ元` field:

```
src/dashboard/render.ts:1019
  `<div><dt>データ元</dt><dd>${esc(data.source)}</dd></div>` +
```

The committed `dashboard.html` is clean only because it happened to be generated with
a relative path. Mine was not:

```
=== absolute paths in MY generated dashboard ===
C:/Users/Zach/AppData/Local/Temp/claude/C--DEV-WEB-hashigo/c7614086-0685-45e6-8d48-
=== ...in the COMMITTED dashboard ===
(none)
```

Locked decision 4 says no absolute paths in the database, and the database is clean.
But the dashboard is the *published* artefact — it is the thing SPEC problem #1 exists
to precompute and the thing you would send someone — and `npx vite-node
src/blobs/cli.ts -- paths` sweeps the database only. **Nothing sweeps the rendered
output.** One absolute `--db` and the page carries your home directory.

Cheap fix, two parts: render `basename(source)` (or a bare label), and extend the
acceptance check to sweep generated artefacts as well as tables. See ORPHAN 2.

### 2.3 137 field values of your own writing that no template will ever render

A second, smaller stale-content pool, and unlike the 3,159-card one it is neither
reported nor recoverable-by-design. My SQL against the fresh database:

```
orphans, cards WITH a template (mapper definition)   143
orphans, cards with NULL template (mapper ignores)    92
total unreferenced field values                      235
  ...of those, value is empty string                  98
  ...of those, value is NON-empty (real text)        137
```

`src/import/entities.ts:314` **does** compute this — `orphanFieldValues` — and
`test/transit.test.ts:390` asserts the count is 143. But the mapper's definition skips
the 370 cards with a NULL `template_id`, and more importantly the number is **never
printed by the CLI and never surfaced in the import report's notes**. It is computed,
asserted in a unit test, and dropped on the floor. The 3,159-card `content` case got a
warning line, a `staleContentCardIds` list and 20 sampled texts. This case, which is
137 field values of real text, got nothing. It should get the same treatment: one CLI
line and the ids.

### 2.4 `lang="่jp"` still falls through — latent until stage 9

OVERNIGHT.md §2.8 flagged this; it is unfixed. The exported function, probed directly:

```
"jp"      -> "ja-JP"
"ja-JP"   -> "ja-JP"
"en"      -> "en-US"
"่jp"     -> "่jp"          <- unchanged
"JP"      -> "ja-JP"
"ja"      -> "ja-JP"
"jp-JP"   -> "jp-JP"        <- also unchanged
```

And the input is real. Counted from the raw export with codepoints, so there is no
doubt what it is:

```
inline lang= values:
  'jp'      x 264   U+006A U+0070
  'ja-JP'   x  15   U+006A U+0061 U+002D U+004A U+0050
  'en'      x   6   U+0065 U+006E
  '่jp'     x   1   U+0E48 U+006A U+0070          <- THAI CHARACTER MAI EK
inline from/to pairs: {'ja->en': 106}
```

Good news I can add: **it is not in the database today.** Every `blobs.lang` value is
well formed —

```
distinct blobs.lang: [{"lang":null,"n":26999},{"lang":"ja-JP","n":8392},{"lang":"en-US","n":2372}]
non-BCP47-shaped lang values: []
```

— because the importer normalises template-field options and cache keys, and inline
generators are not materialised until stage 9. So this is a landmine, not a wound. It
detonates the first time stage 9 resolves inline `<speech>`: one card gets a TTS
request for an unknown locale, and because the malformed tag is part of the cache key
it will also never hit the existing cache. Strip combining marks before the alias
lookup (`.normalize("NFKD").replace(/\p{M}/gu, "")`) and it is covered.

### 2.5 `src/db/open.ts` still asserts something the browser work disproved

`src/db/open.ts:10` says WAL "is the mode the OPFS build will use too". Line 62 sets
it. `notes/browser-feasibility.md:58`, under a heading literally called **"Load-bearing
correction to `src/db/open.ts`"**, shows that a WAL-mode file fails to load on OPFS:

```
SQLite3Error: SQLITE_CANTOPEN: sqlite3 result code 14: unable to open database file
```

and that the identical file with `journal_mode=delete` loads and queries fine. The
note was written; the comment it corrects was not touched. Zero cost today — there is
no browser — but it is a false statement sitting in the file whoever does stage 0.5
will read first, and it will cost them the same afternoon it cost the note's author.

### 2.6 Still open from OVERNIGHT.md, deliberately or otherwise

* **Append-only reviews still are not.** `schema.sql:338` is
  `CREATE TRIGGER reviews_append_only BEFORE UPDATE ON reviews` — UPDATE only. DELETE
  stays unguarded so `ON DELETE CASCADE` from a card works, so hard-deleting a card
  still destroys its review history. Cards are archived (234 of them) rather than
  deleted, so this remains a loaded gun rather than a wound. Unchanged, and I think
  correctly so, but it is still a gun.
* **The sanitiser is still a policy object, not enforcement.** `ELEMENTS[].attributes`
  and `sanitiseStyle` exist in `src/template/ast.ts`; nothing applies them. Stage 4
  work, correctly deferred, but do not let stage 4 assume it is done because the
  policy exists.
* **No CI.** `ls .github/workflows` → nothing. Everything in §0 is a command someone
  has to remember to type. Given that `npm run build` now *can* fail honestly, this is
  the cheapest remaining safety net in the project.
* **`collect()` is still ~7 s** (7.1 s measured on the full corpus above). Fine for a
  precomputed render, still too slow for the interactive filtering stage 7 wants.
* `.gitattributes` exists and `npm run dashboard` exists — both OVERNIGHT items, both
  genuinely fixed.

### 2.7 Nothing regressed

I looked for this specifically, since a fix run is where regressions come from. The
oracle is unmoved, the suite is up (242 → 306 passing), typecheck is clean, the build
is stricter than it was, and every number in the fresh import matches the export.
**No figure moved that a fix did not deliberately move**, and the two that did move
are documented: `card_links` 8,690 → 8,744 (the 54 recovered edges) and `decks` 45 →
39 (the settled default).

---

## 3. Decisions agents made that you did not settle

These are all defensible. None of them is yours yet.

1. **`BlobStore` is a synchronous interface.** `read(hash): Uint8Array`, not a
   Promise. That is a clean contract and it is why the store is relocatable — but in a
   browser, synchronous file access exists *only* inside a dedicated Worker
   (`createSyncAccessHandle`). The sync signature therefore forecloses a main-thread
   blob store permanently. It happens to align with `opfs-sahpool`, which is
   worker-only anyway, so this is probably the right call — but it is an architectural
   commitment made by a type signature, not by you.
2. **Blobs are one file per payload, and the browser note says that is the wrong
   shape.** `notes/browser-feasibility.md` §4 measured the same 624.6 MiB both ways in
   a real browser: 10,816 individual OPFS files took **322.1 s** to write and 10.60 ms
   per random read; BLOB rows in one OPFS SQLite file took **4.9 s** and 0.54 ms.
   65× write, 20× read. The note explicitly asked for this decision to be made "now,
   because `src/blobs/` is being written this session". It was not made; the per-file
   store shipped. The good news is the contract in §3.1 makes it swappable, and the
   note's recommendation of a separate `blobs.db` is concrete. **Decide before stage 4.**
3. **Target retention 0.95 vs 0.90.** Not a design question — the design *is* settled
   at 0.95. It is §2.1's split. But note the second half of BACKTEST.md's finding,
   which does need you: 0.95 "roughly ratifies what you already do" and **will not
   meaningfully reduce your ~69 reviews a day**. If workload reduction is what you
   want from this project, target retention is the only lever and 0.95 is not it.
4. **3,796 tracks are parked on a 365-day plan set before Mochi lifted its cap**
   (BACKTEST.md). Capping at 365 keeps them where they are. They are not a bug, but
   they are why the corpus has no long-interval observations, and working through them
   is what will eventually produce some. Worth knowing that "cap at 365" and "get
   evidence about intervals past 365" are in tension.
5. **The LIKE search path orders by `card_id`, not relevance**, and caps at 50. For
   `する` that means 50 arbitrary cards out of 228 matches. Defensible as a stage-8
   placeholder; it is not a ranked search and should not be shipped to the picker as
   though it were.
6. **`orphanFieldValues` counts only cards that have a template** (143), not all
   unreferenced values (235). A definition chosen in passing; §2.3.
7. Everything in OVERNIGHT.md §4 that was not touched this run — sides being
   structural (§4.3), the emphasis deviations from CommonMark (§4.5), booleans
   interpolating to empty (§4.6), the dashboard's `asOf` defaulting to the last review
   date, the JS-free dashboard, the 4-bin heatmap, the 20-row `tags` table for 19 real
   tags — **still stands and still needs you.** This run fixed defects; it did not
   ratify those choices.

---

## 4. What I could not verify

* **Anything in a browser, by me.** I ran no browser this session. §5 is my reading of
  another agent's note plus my own check of the code it describes; the measurements in
  it are theirs, not mine.
* **`--inline-blobs` at full scale.** Still never run over the 657 MB corpus, by me or
  anyone. The flag exists; the 26,947 inline payloads in my database are all text
  generations, not audio.
* **The rendered appearance of `dashboard.html` or `SPEC.html`.** I verified both
  structurally, numerically and byte-for-byte. I did not open either in a browser this
  session. The stage-2 agent and the spec agent each report doing so.
* **The template renderer's output**, because there is still no renderer, and because
  the export contains nothing to diff a render against — `content` on templated cards
  is stale pre-template text, not a render cache.
* **`w[15]`/`w[16]`.** Frozen by design, unreachable by design, so nothing depends on
  them. Not a gap; the intended end state.
* **Whether the refit is stable across seeds.** I ran the fitter once. It reproduced
  the committed vector, which is the assertion — but "5 of 17 free parameters land on
  clamp boundaries and wildly different vectors score within 0.0006" is BACKTEST.md's
  own caveat and I did not attempt to break it.
* **Multi-tab, Android, Safari, iOS, real `persist()`, real audio playback** — the
  browser note is explicit that none of these were tested and I did not test them
  either.
* **All timings** are Windows, better-sqlite3, this machine, warm cache.

---

## 5. The browser question, honestly

**This is your next decision and it is in much better shape than OVERNIGHT.md left
it — but nothing has actually been built.**

What is true today, measured by me:

```
$ ls vite.config.* index.html public/ manifest*.json sw.js
(none of vite.config/index.html/public/manifest/sw present)

$ node -e "deps"
deps    {"better-sqlite3":"^12.6.0"}
devDeps @types/better-sqlite3, @types/node, typescript, vite-node, vitest

$ grep -rl "from \"node:|better-sqlite3" src --include=*.ts
9 of 33 src .ts files import node:* or better-sqlite3:
  blobs/node.ts · dashboard/{cli,metrics}.ts · db/{index,open}.ts
  import/{blobs,index,transit}.ts · schema/index.ts
```

No bundler, no `index.html`, no service worker, no manifest, no PWA dependency of any
kind. `src/schema/index.ts:16` still opens with `import { readFileSync } from
"node:fs"`. **Stage 0.5 has not been started.**

What changed is the risk, not the progress. `notes/browser-feasibility.md` is 479
lines of real measurement from a real browser by an investigation agent, and it retires
most of the unknowns OVERNIGHT.md §2.4 was worried about. Its findings, which are its
measurements and not mine:

* `@sqlite.org/sqlite-wasm` 3.53.0 ships `ENABLE_FTS5`; `schema.sql` and `views.sql`
  load **unmodified** — 19 tables, 21 views, 14 triggers, including the trigram
  `card_fts`.
* The `opfs-sahpool` VFS needs **no COOP/COEP headers** — confirmed empirically with
  `crossOriginIsolated=false`. Hashigo can be plain static files. That was the single
  biggest deployment constraint and it is gone.
* The full oracle reproduced *inside the browser* from an OPFS-backed database, and
  survived a page reload with no re-import.
* 77% of `src/` (10,164 of 13,203 lines) already has zero Node imports.
* Estimate: **17 hours ≈ 2 working days**, of which items 1–4 (bundle, `schema.sql` as
  bundled text, `openDatabaseBrowser()`, non-WAL bootstrap) are the true go/no-go at
  **8 hours**.

Three things temper that, and two of them are the note's own words:

1. **It is an estimate for work not yet begun.** Every component was observed working
   *in isolation*; no bundler was ever run, and `sqlite-wasm` is known to need care
   with Vite over the `.wasm` asset and the worker. The 8-hour go/no-go is credible
   and it is still 8 unbudgeted hours.
2. **The blob decision is upstream of stage 4 and has not been made** (§3.2). The note
   says plainly: "Do not let stage 4 proceed on the assumption that blobs are files."
   Stage 4 is currently next in the build order.
3. **The note carries one stale figure** — it reports `decks 45 | tags 20` from the
   schema-v1 snapshot it used, taken before the 39-deck default landed. The oracle
   figures in it are correct; that one line predates fix 1.4. Nothing depends on it,
   but do not read 45 as current.

**My recommendation, and it agrees with both OVERNIGHT.md §6 and the note: do stage
0.5 before stage 4, in the order 2 → 3 → 4 (bundle `schema.sql` as text, then
`openDatabaseBrowser()`, then the non-WAL bootstrap).** At that point the real
database is running in a browser and everything after it is ordinary work. Do it
knowing the blob-shape decision (§3.2) has to be made on the way in, not after, and
fix §2.5's comment while you are in `src/db/open.ts`.

---

## 6. ORPHANS — defects outside the files I own

Per the no-orphans rule. Two I fixed, three I could not fix without editing another
agent's primary file. **None is silently noted; each has the exact change written out.**

### Fixed by me

**ORPHAN A — `SPEC.html` was uncommitted.** 223 insertions / 51 deletions of verified
corrections sitting in the working tree after seven commits that did not include it.
I validated it (balanced HTML, LF-only, theme blocks intact, every figure matching my
own measurements, no test reads it from disk, suite green twice with it in place) and
**committed it** in its own commit so the authorship is unambiguous. This is a rescue,
not a review — I did not edit a byte of it.

**ORPHAN B — `FIXES.md` did not exist.** Written and committed. That is my file.

### Not fixed — each needs a file I do not own

**ORPHAN 1 — `src/schema/schema.sql:36`, the target-retention split (§2.1). HIGHEST
PRIORITY.**
`('target_retention.default', '0.90')` contradicts `policy.ts`, `dashboard.html` and
SPEC.html draft 4, all of which say 0.95, and it is what all 39 decks actually resolve
to. I did not change it because it is **not** an isolated one-liner: `schema.sql` is
the schema agent's primary file, the build asserts `dist/*.sql` is byte-identical to
`src/*.sql`, and two tests encode 0.90 —
`test/schema.test.ts:607` (`{ deck_id: "日本語", target_retention: 0.9 }`) and a
reasoning comment at `test/dashboard.test.ts:378`. The change is: seed `'0.95'`, move
both tests, and re-run the dashboard byte-identity test. Roughly fifteen minutes by
someone who owns those files, and it is the difference between 47–82 day and 125–197
day intervals in production.

**ORPHAN 2 — `src/dashboard/render.ts:1019`, absolute path in the published page
(§2.2).** Render `basename(data.source)` instead of `data.source`, and extend the
`paths` acceptance check to sweep generated artefacts, not only database columns.
`render.ts` is the dashboard agent's primary file and the committed `dashboard.html`
is byte-asserted by `test/dashboard.test.ts`, so changing the rendered string requires
regenerating the committed artefact in the same commit — which is exactly why I did
not do it in passing.

**ORPHAN 3 — `src/blobs/db.ts`, `LOCATION_PATTERN` misses embedded POSIX paths
(§1.2).** The branch `^\/[^/\s]+\/` needs either the `m` flag or a boundary class:
`(^|[\s"'(=,:])\/[^/\s]+\/`. Demonstrated end-to-end above — two of five poisoned
databases pass the gate. Unreachable on Windows, reachable the moment anything is
POSIX. `db.ts` is the blob agent's primary file and the pattern is shared with
`test/blobs.test.ts`, so the fix belongs with a test case for each of the twelve shapes
I probed.

**ORPHAN 4 — `src/import/blobs.ts:212`, `normaliseLanguageTag` drops `่jp` (§2.4).**
Strip combining marks before the alias lookup:
`.normalize("NFKD").replace(/\p{M}/gu, "")`. Latent until stage 9; will cause one
unnecessary Azure request and one permanent cache miss when it fires.

**ORPHAN 5 — two documentation statements that are now false.**
`src/db/open.ts:10` claims WAL is what the OPFS build will use, which
`notes/browser-feasibility.md:58` disproves with a pasted error (§2.5).
And `notes/browser-feasibility.md` reports `decks 45 | tags 20`, taken before the
39-deck default landed (§5). Both are comments in other agents' files; both cost a
reader time rather than costing the program correctness.

**ORPHAN 6 — no CI (§2.6).** Nobody owns this, which is why it does not exist. Every
gate in §0 is a command someone must remember. One workflow running
`npm run typecheck && npm run build && npx vitest run` would have caught last night's
broken build without needing three agents to notice it.

---

## 7. Files I created or modified

| Path | What |
|---|---|
| `C:\DEV\WEB\hashigo\FIXES.md` | This report. Created, committed. |
| `C:\DEV\WEB\hashigo\SPEC.html` | **Not authored by me.** Rescued from the uncommitted working tree and committed unmodified — see ORPHAN A. |

Verification scripts I wrote (throwaway, under gitignored `build/`, not part of the
project):
`build/critic/{oracle,sweep,pattern,poison,links,search,plansql,final,orph,orph2,inline,lang,langdb,tr,settings,leftbracket,probe}.mjs`

No file in `src/`, `test/`, `scripts/` or `tools/` was modified by me.
