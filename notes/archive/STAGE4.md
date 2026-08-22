# STAGE 4 — completeness critique

> [!WARNING]
> **SNAPSHOT, 2026-08-20. Some claims below are superseded — see `NEXT.md` and
> `CLAUDE.md` for current state.** This is kept as the record of what was found and
> measured at the time, so it is not rewritten. Known stale in this file:
> - test count and the silent-audio numbers still hold as of writing; the FIX has
>   been decided (resolve on demand) but NOT yet implemented — see `NEXT.md` step 1

**Can you look at your own cards rendered correctly? For 漢字 yes; for 単語 no — 45% of its
sides render blank and not one of its 3,456 audio clips is reachable, because all 19
generator-typed template fields hold zero values and `<<Speech>>` therefore interpolates to
nothing. That is the single biggest remaining defect, it is not a renderer bug, and the bytes
to fix it are already in your database.**

Everything below I ran myself. Numbers I measured more than once are given as ranges.
MEASURED and INFERRED are marked. Written 2026-08-20 by the completeness critic, against
`a0499b9` with a clean tree.

---

## 0. Gates — regenerated, not quoted

```
npm test                     14 files · 542 passed | 1 skipped · exit 0   (3 runs)
                             Duration 43.74 s and 31.71 s (run 2: exit captured, duration not)
                             RANGE 31.7-43.7 s. Do not quote 31.7 as typical.
npm run typecheck            exit 0, no output
npm run build                exit 0
  hashigo-build: VERIFIED 50 modules imported, 2 CLI(s) skipped, 2 .sql byte-identical,
                 52 .js with types, 26 package.json entry points resolve
npm run spike:check          exit 0
npx tsc -p spike/viewer      exit 0
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths     exit 0
  blobs.path non-NULL   0 · columns swept 105 across 13 table(s)
  NO absolute path and NO reference to exports/ anywhere in the database
  store sqlite:…hashigo.db.blobs.db · 5 columns across 2 tables
  NO location in any addressable column of the payload store
PYTHONIOENCODING=utf-8 python tools/mochi.py exports/日本語 exports/English exports/基本情報
  cards 7,716 | reviews 102,020 | retention 96.24% | wiki-links 8,690 | tombstones 8,958
  inline generators: {'speech': 287, 'translate': 106, 'image': 8, 'furigana': 19, 'ai': 125}
  tags after normalisation: 19
```

**Oracle, my own SQL** (`build/critic4/oracle.mjs`, better-sqlite3 only — no project metrics
code). My first two queries failed on invented column names: there is no `card_templates`
table (it is `templates`) and `tags` has no `parent_id` (it is `parent_path`). Corrected:

```
core        {"cards":7716,"decks":39,"templates":10}
reviews     {"reviews":102020,"ok":98188,"retention":96.24}
by kind     [{"kind":"forward","n":58937},{"kind":"reverse","n":43083}]
links       {"card_links":8744,"distinct_targets":2895}
tags        {"rows_in_tags":20,"leaf_tags":19}
blobs.path  {"non_null":0}
days        {"jstDays":1317,"hours":636.1}
searchText  {"cards":7716,"with_text":7716,"empty_text":18}
fts         {"fts_rows":7716}
archived    {"archived":234}
```

Every STATE number lands. **Nothing regressed.** The 20-vs-19 tag question is settled the way
the integrator settled it — 20 rows, 19 leaves, `Dialect` is a materialised ancestor.
`templates` is 10 rows in the database and 11 across the exports (`oiaISYb2` 単語 is defined
in both 日本語 and 基本情報); both figures are already documented and neither moved.

---

## 1. Does every card render with zero unrendered nodes and zero errors? — YES

**MEASURED.** `build/critic4/sweep.ts` — my own walk of the built tree, counting tag names and
marker classes directly. I did **not** read `result.census`, because a renderer can count a
construct it never emitted.

```
cards 7716 · cardsRendered 7716 · templateless 370 · sides 27352
throwFailures 0
reverseTagMismatchCards 0        (reverse renders the identical tag multiset, all 7,716)
hashigo-unknown 0 · hashigo-missing-field 0 · hashigo-section 0
mediaEls 95 · mediaOffenders 0
diagnostics 10316, ALL resolver-warning:
  content-ignored     3159      (locked decision 5 — exactly the CLAUDE.md figure)
  empty-side          7156
  side-break-in-value    1
```

**Node-type census, forward, my count not theirs:**

| tag | n | tag | n | tag | n |
|---|--:|---|--:|---|--:|
| span | 41,358 | br | 13,070 | ol | 1,366 |
| p | 28,629 | blockquote | 5,099 | strong | 309 |
| section | 27,352 | li | 4,194 | code | 276 |
| a | 23,377 | rt / ruby | 3,502 / 3,502 | td / th | 10 / 5 |
| div | 7,716 | hr | 1,677 | tr / thead / tbody / table | 3 / 1 / 1 / 1 |
| h4 | 6,738 | canvas | 1,663 | ul | 5 |
| audio | 95 | img | 13 | em | 2 |
| | | input | 90 | | |

**Mount census by class:** `hashigo-cloze` 11,476 · `hashigo-generator` 10,403 (ai 6,778 ·
furigana 3,502 · speech 94 · translate 21 · image 8) · `hashigo-link` 15,589 ·
`hashigo-card-link` 7,788 · `hashigo-draw` 1,663 · `hashigo-input` 90 · `hashigo-math` 28 ·
`hashigo-audio` 95.

Authored-text projection (content + every field value), where the link oracle lives: **8,744
card links, 288 audio, 14 img, 0 failures.** Matches SPEC exactly.

**A number that does not reproduce.** `test/render.test.ts:928` says the sub-kind breakdown
reads *"7,368 empty sides and 2,948 ignored stale contents"*. Measured: **7,156 and 3,159.**
It is a comment, not an assertion, so the suite is green — but 3,159 is the figure in locked
decision 5, and a reader who trusts the comment now has two numbers for the same thing. This
is exactly the class of defect decision 6 was written for. ORPHAN below.

**A basis clash worth naming before it looks like a regression.** `tools/mochi.py` prints
`ai: 125, furigana: 19`; the render census says `ai 6,778, furigana 3,502`. Both are correct
on different bases: mochi.py counts authored occurrences in card *content*, while the render
counts *instantiated mounts*, and the generator tags live in the template bodies — 単語 has
one `<ai>` and one `<furigana>` each, times 3,477 cards. Verified by counting tags per
template body: 単語 {ai 1, furigana 1}, 漢字 {ai 1, draw 1}, New Vocab {ai 1}, 言葉 {ai 1},
敬語 {furigana 1, speech 1}, Polysemy {speech 1}, 数字 {input 1}.

---

## 2. Is the audio-on-reveal rule genuinely enforced? — YES, and I broke it three ways to prove it

**MEASURED.** I applied three mutations to the working tree, ran the full suite on each, and
restored. `md5sum` of both files matches the pre-experiment backup and `git status` is empty.
Two of my three mutations were designed to **evade the source-grep tests**, because a grep
test is not a behaviour test and the integrator only reported literal mutations.

| # | mutation | evades the greps? | result |
|---|---|---|---|
| 1 | `audio.play(media, "reveal")` inside `enter()` | no | **8 tests red**, exit 1. Corpus sweep: `expected [ …(450) ] to deeply equal []` — 450 violations, 90 cards, each reporting *bytes requested / URL minted / element played / src set* **on entry** |
| 2 | `enter()` calls `side.reveal("caller")` — no `play`, no `audio.` reference | **yes, all of them** | **9 tests red**, exit 1 — including `addressing > does nothing at all without an audio port`, which no grep could have caught |
| 3 | `context.attribute(element, "auto"+"pl"+"ay", "")` in `nodes.ts` | **yes** | **7 tests red across 3 files**, exit 1 — the two attribute-equality tests, both goldens, the 7,716-card media sweep, the ruby-in-cloze drill test, and `requests NO audio when a side is rendered and entered` |

I confirmed mutation 2's evasion before running it: with comments stripped, the `enter()` body
contains no `play`, does not match `/audio\s*[?.[]/`, and `audio.play(` still occurs exactly
twice in the file — every assertion in `source discipline > starts playback from exactly two
places` passes. It was still caught, nine times, by behaviour.

**This reconciles the integrator's two numbers precisely.** They reported 8 red for the
literal `autoplay`; I get 7 for the concatenated one. The difference is exactly the one grep
test. So the grep contributes one test of the eight and the behavioural tests contribute
seven — the rule survives without the grep. **The teeth are real and they are behavioural,
not textual.**

**Verified through the production loop, over the whole corpus** (`build/critic4/bridged.ts`,
which drives the real `shadowingLoop` from `src/render/reveal.ts`):

```
sidesEntered 26569 · playsOnEntry 0 · playsOnReveal 10739
```

Zero plays on entry over 26,569 side entries, both with and without the speech bridge
applied. The rule holds.

**One thing the rule cannot protect, and it is the point of §3.** The rule is *"no clip starts
before the reveal"*. It is trivially satisfied by a card with no clip. On 単語 — 3,477 cards —
**there is no clip at all**, so the hard rule is green and the exercise is absent. A test that
pins silence-on-entry cannot notice silence-on-reveal. That gap is `playsOnReveal` per card,
and nothing asserts it is non-zero for the templates whose whole purpose is audio.

---

## 3. THE BIGGEST REMAINING DEFECT — the audio is in the database and unreachable from the render

This is documented today in exactly one place: the docstring of
`spike/viewer/speech-bridge.ts`, a file marked THROWAWAY. It is **not** in CLAUDE.md (which
describes `<<Speech>>` as part of the drill with no caveat), not in SPEC.html, not in
FIXES.md, not in OVERNIGHT.md, not in SPIKE.md, not in `src/render/README.md`. I re-measured
all of it independently and it is worse than the one-line version suggests.

### MEASURED, my own SQL

```
generator-typed template fields:  ai 4 · speech 10 · translate 5
rows in card_field_values for ANY of those 19 fields:  0
単語 Speech (6ov2HLxA) + Audio (efJTAfzT) values:      0
単語 例文 (1SNMVvMK, ai-typed) values:                  0
```

### MEASURED, my own render sweep (`build/critic4/audio-reach.ts`)

```
cards with a speech blob                  5708   (10,862 refs, 648 MB of mp3)
cards rendering ANY <audio> element          86
<audio> elements corpus-wide                 95   (94 from inline <speech>, 1 attachment)
cards with speech audio but NO element     5622
sides with a cloze AND a clip TOGETHER        0   <- the drill's shape exists nowhere
```

Per template — `withSpeech` is cards holding pitch-accent audio, `audio` is cards that render
an element for it:

| template | cards | withSpeech | audio | sides | blank sides | % blank |
|---|--:|--:|--:|--:|--:|--:|
| **単語** | 3,477 | 3,456 | **0** | 13,908 | **6,262** | **45.0** |
| 漢字 | 1,662 | 4 | 0 | 6,648 | 1 | 0.0 |
| New Vocab | 1,203 | 1,201 | 1 | 3,609 | 1 | 0.0 |
| 基本情報 | 471 | 470 | 0 | 942 | 471 | 50.0 |
| 言葉 | 392 | 391 | 0 | 1,176 | 392 | 33.3 |
| (no template) | 370 | 54 | 54 | 783 | 18 | 2.3 |
| 数字 | 90 | 89 | 0 | 180 | 0 | 0.0 |
| 敬語 | 21 | 21 | **21** | 42 | 0 | 0.0 |
| 文法 | 12 | 12 | 0 | 36 | 24 | 66.7 |
| Polysemy | 10 | 10 | **10** | 20 | 0 | 0.0 |
| Synonym | 8 | 0 | 0 | 8 | 0 | 0.0 |
| **corpus** | 7,716 | 5,708 | 86 | **27,352** | **7,169** | **26.2** |

**26.2% of every side you would page through renders completely blank** — no text, no widget,
no media, no cloze.

### The causal arithmetic, exact

The 単語 template body, verbatim from `templates.content`:

```
<< #Reading>>
<< Reference >>
<< /Reading >>
---
<< ^Reading >>
{{<< Reference >>}}
<< /Reading>>
{{<furigana><< 単語 >></furigana>}}
<< Speech >>
---
><< 例文 >>
<< Translate >>
<< Audio >>
---
<< 意味 >>
#### {{<ai>Describe a word << 単語 >> using emojis only</ai>}}
🀄[JPDB](…)  🎬[IKD](…)
```

`Reading` values across 3,477 cards: `true` 693 · `false` 906 · `''` 24 · **absent 1,854**.
`isTruthy` correctly treats `"false"` as false, so side 1 renders on 693 cards.

* **Side 1** blank on 3,477 − 693 = **2,784** cards — correct, that is the gate.
* **Side 2** is the drill: cloze + furigana render, `<<Speech>>` renders nothing. **The cloze
  is there and the clip is not.**
* **Side 3** is `例文` (ai) + `Translate` (translate) + `Audio` (speech) — *all three are
  generator fields*, so it is blank on **3,477 of 3,477** cards. The sentence-length
  shadowing side does not exist.
* **Side 4** renders 意味 and the two links; its cloze wraps the `<ai>` output and so reveals
  to an empty string.

2,784 + 3,477 + 1 = **6,262**, which is the measured blank count for 単語 to the card. The
account is complete; there is no unexplained residue.

### Why this is cheap to fix, MEASURED

The bytes are already yours. No Azure bill for the bulk of it.

1. **3,394 of 3,477 単語 cards (97.6%)** already have their word-level clip identifiable by an
   exact `blobs.source_text = ` the card's 単語 value, at `lang='ja-JP'`,
   `voice='ja-JP-NanamiNeural'`. A join, not a generation.
2. **The corpus already demonstrates the working form.** 敬語 and Polysemy author
   `<speech lang="jp"><<言葉>></speech>` *inline* and render audio on 100% of their cards
   (21/21 and 10/10). 単語 uses a speech *field* and renders silence on 3,477/3,477. The two
   forms mean the same thing to Mochi; only one survives the resolver.
3. **The bridge works, measured end to end.** Applying `bridgeSpeechFields` to the template
   bodies and re-rendering all 7,346 templated cards:

   | | today | bridged |
   |---|--:|--:|
   | `<audio>` elements | 32 | **10,750** |
   | cards with audio | 32 | **5,671** |
   | sides with cloze **and** clip | **0** | **3,868** |
   | speech cache hit / miss | 31 / 0 | **5,348 / 1,498** |
   | `hashigo-unknown` markers | 0 | 18 (on 4 cards, visibly, in `diagnostics`) |
   | plays on entry / on reveal | 0 / 32 | **0 / 10,739** |

   The hard rule holds through it. The 18 markers are the documented multi-line-blockquote
   failure on `uG94X2PY`, `uynG25Ps`, `RSzjH93d`, `1oehn26r` — loud, not silent, which is the
   argument for materialising values instead of rewriting bodies.

4. **Inline generators already resolve from cache at 84.6%.** For every `GeneratorMount` stage
   4 emits, I ran `lookupGeneration(generationIdentity(mount.request))`:

   ```
   kind        mounts    hit   miss  emptyText  hit%
   ai            6778   5547   1231          0   81.8
   furigana      3502   3133    359         10   89.7
   translate       21     16      5          0   76.2
   speech          94     94      0          0  100.0
   image            8      8      0          0  100.0
   TOTAL        10403   8798                     84.6
   ```

   The misses are genuine: no blob exists with source text
   `Describe a word あれこれ using emojis only`. So stage 9's inline half is ~1,595 real
   generations, not 10,403. **INFERRED:** at typical LLM prices that is cents, which supports
   the under-$1/yr claim rather than threatening it.

### One caching wrinkle nobody has named — MEASURED

`blobs` is content-addressed with a **single** `source_text` column, but identical bytes can
come from two different source texts. Card `GoTCSOI2` (あれこれ) and `RdWh5PbX` (ちなみに) both
reference blob `410893da…` (refcount 2, two different Mochi `ref_key`s): Mochi generated the
same emoji string for both words. The row records `ちなみに`, so `lookupGeneration` for
あれこれ **misses forever even though the bytes are present**.

```
ai blobs referenced by more than one card        697
blobs stored under more than one Mochi ref_key   676
blobs shared by more than one card (all kinds)   896
```

**INFERRED:** up to ~697 of the 1,231 ai misses are this, not real absences, so the true
"bytes already present" rate is above 84.6%. Stage 9 needs a decision: either a many-to-one
identity table, or accept re-generating a duplicate.

**Also explained by the same root cause, so NOT a defect:** 4,688 of 10,861 speech refs have a
`source_text` that appears in no field value of the owning card. **INFERRED** — those are the
sentence clips, whose source field (`例文`, ai-typed) has no value to match against.
Consistent with everything above; I did not prove it exhaustively.

---

## 4. Stage 8 search: 1–2 character Japanese queries — YES, exact, and genuinely ranked

**MEASURED**, `build/critic4/search-truth.ts`. Ground truth computed in JS from raw columns
(`stripInvisible(name)` + `\n` + body + `\n` + tags, ASCII-folded, `String.includes`) — never
by asking SQLite a second question. `searchIndexStatus`:
`{"cards":7716,"indexed":7716,"unrendered":0}`.

```
q       mode  chars  APItotal  JStruth  equal   topScore
日       like      1        42       42  true    1431.96
本       like      1        36       36  true    1431.96
語       like      1        29       29  true    1431.96
漢       like      1         3        3  true    1431.96
字       like      1        18       18  true    1431.96
の       like      1       387      387  true     431.92
を       like      1       380      380  true     435.88
食       like      1        12       12  true    1431.96
%       like      1         2        2  true      11.96
_       like      1        47       47  true     130.56
意味      like      2         3        3  true    1433.92
する      like      2       228      228  true    1431.92
ない      like      2        74       74  true     431.80
勉強      like      2         1        1  true     133.20
漢字      like      2         1        1  true    1433.92
日本      like      2         1        1  true     433.88
言葉      like      2         2        2  true    1433.92
文法      like      2         1        1  true    1433.92
例文      like      2         0        0  true          -
単語      like      2         2        2  true    1431.92
日本語     fts       3         0        0  true          -
勉強する    fts       4         0        0  true          -
TOTAL_MISMATCHES 0
```

**22 of 22 exact, including ten one-character queries and the two metacharacters.** The router
picks `like` at 1–2 chars and `fts` at 3+, and `mode` says which.

**The ranking is real, not merely non-`card_id`:**

```
する  n=228 monotoneDesc=true distinctScores= 81 seqOrdered=false nameHits=223 lastNameRank=222 firstBodyOnlyRank=223 nameBeforeBody=true
の    n=387 monotoneDesc=true distinctScores=157 seqOrdered=false nameHits=368 lastNameRank=367 firstBodyOnlyRank=368 nameBeforeBody=true
意味  n=  3 monotoneDesc=true distinctScores=  3 seqOrdered=false
   top5 for 意味: 意味|1433.9  意味合い|433.8  コンパイラの処理手順は「字句|130.2
```

Monotone descending on every query, 81 and 157 distinct score values, **every name hit ranks
above every body-only hit**, and the order is byte-identical across two runs. Pagination on a
one-character query is complete and non-duplicating — `の` 387 paged / 387 unique / 387 truth
/ 0 missed / 0 extra / 0 dupes; `日` 42/42/42/0/0/0. Snippets land on the match on every
sample I inspected.

**Two things stage 10 should know, MEASURED, and neither is a bug:**

* **Deck names are not searchable.** `card_search_index` is name + body + tags only, so
  `日本語` — the name of your 5,947-card deck — returns **0 hits**. Correct per the view,
  possibly surprising in Ctrl+K.
* **`例文` returns 0.** It is a field *name*, not content, and the field has no values (§3).
  Field names are not in the index either.

**No `node:` import in `src/search` or `src/render`** — verified by grep; the only matches are
comments and identifiers named `node`. The browser-safety claim holds.

---

## 5. What is broken or newly broken

**Regressions: none.** Suite, typecheck, build, `spike:check`, `tsc -p spike/viewer`, the
`paths` acceptance check and `tools/mochi.py` all reproduce, and every oracle number is
unmoved. I found no number in STATE that has drifted.

**Broken, and nobody has reported it — MEASURED.** `npm run build` produces a package in which
**6 of the 11 files in `src/render` cannot be imported by any specifier**. Probed from a
foreign cwd against a linked `dist/`:

```
OK    hashigo/render          29 exports
FAIL  hashigo/render/reveal   ERR_PACKAGE_PATH_NOT_EXPORTED
barrel has shadowingLoop: false | barrel has audioController: false

MISSING  reveal.ts   shadowingLoop, REVEAL_ATTRIBUTES
MISSING  audio.ts    audioController, audioAddress, AUDIO_DATA
MISSING  ruby.ts     furiganaSupport, alignFurigana, baseRuns, toHiragana, RUBY_DATA
MISSING  draw.ts     attachDraw, drawSettings, DRAW_DATA, DRAW_DEFAULTS
MISSING  input.ts    attachInput, checkAnswer
MISSING  math.ts     mathRenderers
in barrel  dom.ts · nodes.ts · sanitise.ts · index.ts
```

`hashigo/render/reveal` is the specifier **line 5 of `reveal.ts` documents as its own entry
point**. The compiled `dist/render/reveal.js` and `.d.ts` exist; only the export map is
missing. The build's "26 package.json entry points resolve" is satisfied because it checks
only the specifiers package.json lists, and none of these six are listed. **Everything stage 7
needs most — the shadowing loop, the audio controller, furigana alignment, the drawing canvas,
the input widget, math — is compiled and unreachable.** ORPHAN below.

**Half-done, and it is the browser evidence — MEASURED.** `src/render/reveal.ts` and
`src/render/audio.ts` are imported by **`test/reveal.test.ts` and nothing else in the
repository**. `spike/viewer/main.ts` imports `src/render/index.js` but not `reveal.js`; it
hand-rolls its own loop over `result.onReveal` and `cloze.reveal()`. So the Playwright runs,
the real mp3 decode and the phone testing all exercised a **throwaway** reveal loop. The
production `shadowingLoop` — which owns side grouping, media arming, the `src` gate,
conceal/replay and the event log — **has never executed in a browser.** It is pinned by 31
Node tests including a 7,716-card sweep, which is real evidence; it is not browser evidence,
and the card-viewer verifier was right to say so.

**Half-done: the corpus's own drill shape.** `cloze + clip on the same side` is 0 across 7,716
cards today. Until §3 is resolved, there is nothing for `reveal()`'s play-on-reveal branch to
fire on outside 31 cards on two minor templates.

---

## 6. Decisions agents made that you did not settle

Design was deliberately deferred to you, and these are all in shipped source with no decision
record. None is wrong; all are yours.

**Visual and interaction**

1. **The cloze mask is the literal string `[…]`** — `CLOZE_MASK_TEXT` in `nodes.ts`. 11,476 of
   them. Not a styled box, not a fixed-width blank: a three-character ellipsis that makes every
   masked answer the same width regardless of length. On the pitch-accent card the mask is what
   you look at while recalling.
2. **A reveal reveals the whole side at once.** 6,954 単語 sides carry two clozes
   (`{{<<Reference>>}}` and `{{<furigana>…}}`) and tapping either shows both. Reasoned in the
   header (binary grades have no way to record a half-reveal) but it is a study decision: you
   cannot check the kanji reading without also being shown the reference.
3. **`reveal()` starts the FIRST clip and defers the rest**; the second is one more tap away
   via `play()`. Two clips at once is unlistenable, but "first" means document order, which on
   a bridged 単語 card is the word and not the sentence.
4. **External links get `target="_blank" rel="noopener noreferrer"`** — 15,589 of them,
   including the four Jisho/Wanikani/JPDB links per 漢字 card. In an installed PWA that leaves
   the app. You overruled the answer-leak deferral on 2026-08-20; nobody asked you about
   `_blank`.
5. **Clozes get `role="button" tabindex="0" aria-expanded`, and Space/Enter activate with
   `preventDefault()`.** Sensible; unasked.
6. **`DRAW_DEFAULTS` = 300px / `#FF0000` / radius 4.** Latent only: 漢字 authors
   `<draw height="400px" brushColor="#FF0000" brushRadius="4"/>` explicitly on all 1,662 cards,
   so the defaults never show. `src/render/README.md` quotes `data-height="400px"` as the
   example while the default is 300px — worth aligning so nobody reads one as the other.
7. **`<canvas>` carries no `width`/`height`** by design — the widget must size it to
   `devicePixelRatio`. Until something does, strokes blur. That something does not exist.
8. **Math renders as `<span class="hashigo-math" data-math>` with the source as text** — 28
   nodes are *marked*, not typeset. Whether `$…$` should typeset is undecided.

**Search behaviour**

9. **Archived cards are included by default** (234 of them), greyable via `hit.archived`.
10. **`SCAN_WEIGHTS`** — exact title 1000, prefix 300, contains 120, tag 40, body 10 (+2 per
    extra occurrence, capped at 8), minus `min(len(name),200)/25`. That is a ranking *policy*:
    a short title beats a long one, and a tag beats four body occurrences.
11. **`DEFAULT_SEARCH_LIMIT` 50, `MAX_SEARCH_LIMIT` 500, `SNIPPET_RADIUS` 40 characters.**

**Structural**

12. **Card links route to `#/card/<encodeURIComponent(id)>`.** No router exists yet; this fixes
    the URL scheme.
13. **Reverse is a full reversal for all 10 templates** — every `templates.reverse_permutation`
    is NULL, so 43,083 reverse reviews of history will replay as side 4 → 3 → 2 → 1. On 漢字
    that shows Meaning + the Jisho links first, then the reading, then the blank canvas, then
    the kanji. It is SPEC's locked default and it is also the first thing you will want to
    change once you see it.

**Not a decision anyone made — there is no stylesheet at all.** `find` over the repo returns
**zero `.css` files**. The only CSS is inside `spike/viewer/index.html` (THROWAWAY) and
`dashboard.html`. The renderer emits `hashigo-*` classes that nothing in production styles.
Every visual choice above is therefore *still open* except the DOM structure that constrains
it.

---

## 7. What needs you personally

1. **The §3 decision, and it is the only one blocking the app being usable.** Two options, both
   already characterised: (a) **materialise generator-field values** at import or in stage 9 —
   no failure mode, 3,394 単語 clips resolvable by an exact `source_text` join today; or (b)
   **rewrite the template body** the way `speech-bridge.ts` does — works today, 5,671 cards
   recovered, but breaks loudly on 4 multi-line cards. The measurements favour (a).
2. **Your taste on the viewer.** All thirteen items in §6, plus the entire stylesheet.
   `spike/viewer/` is the place to look at it; the numbers say the DOM is right and nobody has
   decided what it should look like.
3. **Your phone, for two things no agent can do.** Touch on the `<draw>` canvas across 1,662
   漢字 cards — pointer events, `devicePixelRatio` sizing, palm rejection, whether a 400px
   surface is enough to write a kanji with a fingertip. And a press on the **native `<audio>`
   play button**: `reveal.ts` records that a click at the centre of the native control did
   **not** reach the host element in Chromium 151, so `click` is belt-and-braces and the `play`
   event is the load-bearing listener. Unverified on Samsung Internet.
4. **Whether reverse order (§6.13) is what you want**, now that you can see what it does to
   漢字 and to 単語.
5. **Whether 700 MB of audio lives on the phone or is fetched lazily.** Raised undecided in
   `SPIKE.md` and still undecided; §3 makes it live, because 5,671 cards are about to start
   asking for clips.

---

## 8. Can stage 7 (review UI) proceed? — YES, with three assumptions and one blocker it must not paper over

**Proceed.** Stage 4 is complete against its own contract: 7,716 cards, 27,352 sides, zero
unrendered nodes, zero errors, zero media that can start itself, both directions, and a mount
surface that is total by construction. Stage 8 answers 1-character Japanese queries exactly
and in real rank order. Nothing is missing that stage 7 needs to *build*.

**What it should assume**

* **Use `shadowingLoop` from `src/render/reveal.ts`. Do not hand-roll a reveal loop.** One
  already exists, it is the thing 31 tests and a 7,716-card sweep pin, and the viewer's
  hand-rolled copy is why the browser evidence does not cover the real thing. Being the first
  caller in a browser is stage 7's job.
* **You will have to fix the export map first** (§5) or import by relative path and accept that
  the package is wrong.
* **Register playback in an `onReveal` listener and nowhere else.** The renderer will never
  call `play()`; `enter()` is guaranteed silent; media elements arrive with no `src`,
  `preload="none"`, and no `autoplay`/`loop`. If you change `reveal.ts` or `nodes.ts`, re-run
  one of the three mutations in §2 rather than trusting a green suite.
* **Blobs: `MediaMount.reference.key` is exactly `blob_refs.ref_key`.** Resolve to bytes
  yourself and attach through `src/blobs/url.ts` — one `BlobUrlScope` per presentation,
  `releaseAll()` on card change. The renderer mints no object URL, by design.
* **Bring your own stylesheet.** There is none. Style `CLASS`/`DATA`, never literals.
* **Size the canvas yourself** at `devicePixelRatio`; the renderer sets no width/height.
* **A quarter of the sides you queue are blank today.** Until §3 lands, stage 7 needs an answer
  for a side with nothing on it — skip it, show it, or fail loudly. Silently paging through
  7,169 empty sides is the worst of the three.

**The one thing stage 7 must not paper over.** It would be very easy to build a review UI that
looks finished on 漢字, ship it, and never notice that 単語 — 45% of the collection and the
entire reason the audio exists — is silent. A test that asserts *plays on reveal is non-zero*
for 単語 would catch that. Nothing asserts it today, because today the correct answer is zero.

---

## ORPHAN — defects outside my files

I own `STAGE4.md` only. I checked `git status` before and after every experiment; the tree was
clean at both ends and I changed no tracked file.

> [!note]
> **ALL THREE ORPHANS APPLIED 2026-08-22.** Orphan 1's six subpaths are in `package.json`
> (23 export subpaths, verified by the build). Orphan 2's figures are corrected in the
> comment. Orphan 3 turned out **not to be a defect** — 400px is the AUTHORED value and
> 300px is the default, two numbers for two things; the README now says which is which.
> Also, while adding the subpaths: the `autoplay`/`.play(` source check covered a
> HARDCODED four of the ten files in `src/render`, so `ruby.ts`, `draw.ts`, `input.ts` and
> `math.ts` were escaping the project's most safety-critical invariant. It is now derived
> from the directory with `audio.ts`/`reveal.ts` named as the two allowed exceptions, and
> the count is asserted so neither list can drift. Verified by injecting `autoplay` into
> `ruby.ts` — previously green, now red.

**ORPHAN 1 — `package.json` (and `scripts/build.mjs`'s verify list): six `src/render` modules
are unreachable from the published package.** Full evidence in §5. The compiled files exist in
`dist/`; only the export map is missing. `hashigo/render/reveal` — the specifier `reveal.ts:5`
documents — throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The fix is six subpath entries
(`./render/reveal`, `./render/audio`, `./render/ruby`, `./render/draw`, `./render/input`,
`./render/math`) plus the matching additions to the build verifier's count. I did not apply it:
it changes the package's public surface and the verifier's asserted entry-point count, which is
a decision about the API rather than a typo, and a critic quietly widening the public API while
writing the critique is the wrong shape. It is small, it is fully specified above, and it
should land before stage 7 writes its first import.

**ORPHAN 2 — `test/render.test.ts:928`: a comment states diagnostic figures that do not
reproduce.** It says *"7,368 empty sides and 2,948 ignored stale contents"*. Measured
independently: **7,156 empty-side and 3,159 content-ignored**, and 3,159 is the number in
CLAUDE.md's locked decision 5. One-line fix; the assertion above it is correct and green.

**ORPHAN 3 — `src/render/README.md` quotes `data-height="400px"` as the example while
`DRAW_DEFAULTS.height` is `300px`.** Cosmetic and currently latent (漢字 authors 400px on all
1,662 cards), but two numbers for one thing.

**Not an orphan, deliberately.** `blobs.source_text` collapsing two generation identities onto
one content address (§3) is a real design wrinkle, but it is stage 9's model to decide, not a
bug in anyone's current file.

---

## COULD NOT VERIFY

* **Anything in a browser.** I ran no browser at all this session. Every §2 result is Node +
  `MemoryDocument`. The claim that `shadowingLoop` behaves in Chromium the way it behaves in
  `MemoryDocument` is **untested by me and untested by anyone** (§5).
* **Touch, the canvas, and the native `<audio>` control on a phone.** No agent can.
* **The visual result of the 18 `hashigo-unknown` markers on the 4 bridge-failure cards.** I
  counted them; I did not look at them.
* **Whether `ai`, `translate` and `furigana` *fields* could be bridged like `speech`.** Only
  `speech` is in `BRIDGEABLE`. The 単語 `例文` field is `ai`-typed and is what makes side 3
  blank on 3,477 cards, so this is the second half of §3 and I did not measure it.
* **Suite duration for my run 2.** I captured its exit code (0) and not its duration, so my
  range 31.7–43.7 s rests on two observations, not three.
* **The exhaustive cause of the 4,688 speech refs whose `source_text` matches no field value on
  the owning card.** The sentence-clip explanation is consistent and I did not prove it case by
  case.
* **Whether ~697 of the 1,231 ai cache misses are identity collapse rather than genuine
  absence.** I proved the mechanism on one pair (`GoTCSOI2` / `RdWh5PbX`) and counted the
  population; I did not attribute each miss.

---

## Reproduce

```bash
npm test                                   # 3 runs: 542 passed | 1 skipped, exit 0
npm run typecheck && npm run build && npm run spike:check && npx tsc -p spike/viewer
npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths
PYTHONIOENCODING=utf-8 python tools/mochi.py exports/日本語 exports/English exports/基本情報

node  build/critic4/oracle.mjs build/hashigo.db      # my oracle SQL
npx vite-node build/critic4/sweep.ts                 # §1 corpus sweep + node census
npx vite-node build/critic4/search-truth.ts          # §4 search vs JS ground truth
npx vite-node build/critic4/audio-reach.ts           # §3 audio reachability
npx vite-node build/critic4/empty.ts                 # §3 blank sides per template
npx vite-node build/critic4/gen-hits.ts              # §3 generation cache-hit rate
npx vite-node build/critic4/bridged.ts               # §3 bridge + hard rule via shadowingLoop
npx vite-node build/critic4/see.ts -- 4jcJn1Gr sqgqrYD4 gARDCdEz   # one card, both directions
node  build/critic4/cwdtest/probe.mjs                # §5 package entry points
node  build/critic4/cwdtest/probe2.mjs               # §5 barrel reachability
```

**Files I created — all THROWAWAY, all under gitignored `build/`:** `build/critic4/`
(`oracle.mjs`, `sweep.ts`, `search-truth.ts`, `audio-reach.ts`, `empty.ts`, `gen-hits.ts`,
`bridged.ts`, `see.ts`, `cwdtest/probe.mjs`, `cwdtest/probe2.mjs`, and the two `.bak` copies
used to restore `reveal.ts` / `nodes.ts` after the §2 mutations).

**PRODUCTION file I created: this one, `STAGE4.md`.** No other tracked file was modified.
