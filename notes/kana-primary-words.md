# Kana-primary words, and the parenthesis workaround

Zach's own account of the problem, 2026-08-21:

> In japanese, there are words that has no kanji, that's why i have the `言葉`
> template, the `単語` is for words with Kanjis only. and also, for words that have
> kanji but is labeled as `Usually written using kana alone`, such as 蒔く, I usually
> use the 言葉 template, but […] if the word is 同音異義語, then there would be no way
> to tell, so my work around was to write like はえ (蠅), but this would break either
> the text to speech or the ai generation of example sentence because the parenthesis
> is in there.

And what he actually wants from it:

> because my goal is that some day I want to achieve 漢字検定, I may have to learn how
> to read them even if they are not primarily used, but I also need to know that I may
> not want to write them in Kanji when I text with my friend or something […] if I do
> not know the reading, I don't wanna make it my fault 100% because in real life they
> are not really written in Kanji, so we needa way to label them, maybe a new property
> with a check box that will show small label like ◎かな主流

## MEASURED: the workaround is 13 cards, and it is TWO problems

Basis: `card_field_values.value` for `field_id = 'name'` on templates 単語 and 言葉,
**n = 3,860** as re-measured 2026-08-22 by `scripts/reading-parse.ts`, matched against
`[（(][^）)]*[）)]`. (This line read 3,858; the hit count is 13 either way.)

| | cards | examples | what it needs |
|---|--:|---|---|
| **A. kana-primary word** | 5, all 言葉 | `かく(搔く)` `めす（雌）` `なす（茄子）` `あり(蟻)` `あく（灰汁）` | the かな flag |
| **B. kanji with an ambiguous READING** | 7 — 6 in 単語, 1 in 言葉 | `器（うつわ）` `空く（すく）` `革（かわ）` `的（まと）` `主語（しゅご）` `日向　(ひなた)` `（おす）雄` | a reading hint — NOT a kana flag |
| C. an English gloss | 1 | `はたち (as in 20 years old)` | belongs in 意味 |

**CORRECTED 2026-08-22.** This table read 6 / 7 / 1, which sums to 14 against a
measured 13. `（おす）雄` was counted in A and belongs in B: the decidable rule reads
SCRIPT POSITION, and that row puts the kanji outside. Re-measured by
`scripts/reading-parse.ts`, the split is **7 読み / 5 かな主流 / 1 意味, zero
unclassified** — which is what CLAUDE.md decision 10 says. Take the numbers from the
script, not from this table.

**These want opposite treatment and the workaround hides that.** In A the parenthesis
holds the KANJI and the head word is kana; in B it holds the READING and the head word
is kanji. Applying A's fix to B would put a reading inside the head word, which is
precisely what breaks TTS — the brackets get spoken.

Note also that 言葉's other 33 kanji-containing head words are **not** kana-primary
words at all: they are grammar patterns carrying placeholders (`～なり～なり`,
`...は...に限る`, `～んばかり`). An earlier count that called them candidates was wrong.

## A's fix does more than add a label

Putting the KANJI as the head word and flagging it kana-primary removes the
parenthesis, so both the TTS input and the AI prompt receive an unambiguous string —
which is the thing that was actually breaking.

**It also resolves accent ambiguity.** Of the 6 words neither analyser could label
(see `notes/accent-ojad-adjudication.md`), **4 are solved by writing the kanji**:

| word | OJAD entries | fixed by a kanji head word? |
|---|---|---|
| まく | 巻く 0 · 蒔く 1 · 撒く 1 · 膜 2 · 幕 2 | **yes** |
| どく | 退く 0 · 毒 2 | **yes** |
| いか | イカ 0 · 以下 1 | **yes** |
| やかん | 薬缶 0 · 夜間 1 | **yes** |
| 弾く | ひく 0 · はじく 2 | **no** — same kanji, two readings |
| だぶだぶ | だぶだぶ[な] 0 · だぶだぶ 1 | **no** — no kanji exists |

## VERIFIED: the label needs no new code

`かな主流` is a `boolean` field — the same type as `Reading` — and the template engine
already gates on it. Checked rather than assumed:

```
<<#かな主流>>
◎かな主流
<</かな主流>>
```

* `かな主流 = "true"` → the label renders
* `かな主流 = "false"` → nothing renders
* zero resolver warnings in either case

**THE TRAP, hit on the first attempt.** The section markers must each be **alone on
their own line**. Written as `<<#かな主流>>◎かな主流<</かな主流>>` on one line, the
resolver reports `stray-section-marker` and **the gate silently does not fire** — the
label rendered on both branches, which looks like the boolean being ignored rather than
like a syntax error. `isTruthy` and the boolean are fine; the line layout is the bug.

`template_fields.local = 1` (schema v7) means the field and its values survive a
re-import, so this does not become a chore after every fresh `.mochi`.

## The template, and the one thing that does not work

Zach's placement, from the 単語 template he pasted 2026-08-21: **`かな主流` on side 1,
inside the `<<#Reading>>` gate; `型` on side 2, immediately above `<<Speech>>`.**

Side 1 already shows `Reference` when `Reading` is true, so the reading is given there
anyway — the label is not a spoiler on that side, which is why it can sit on the prompt
without the objection that applies to `型`.

**HIS TEMPLATE AS WRITTEN DOES NOT WORK, and it fails silently.** He wrote:

```
<<#Reading>>
<<Reference>>
<<かな主流>>
<</Reading>>
```

`<<かな主流>>` interpolates a BOOLEAN. The resolver reports `boolean-interpolated` and
substitutes the empty string, so the label renders on **neither** branch — it looks like
the flag being ignored rather than like a syntax error. Verified by running his block
verbatim.

The working form, markers each alone on their own line:

```
<<#Reading>>
<<Reference>>
<<#かな主流>>
◎かな主流
<</かな主流>>
<</Reading>>
```

Verified nested inside the real template: `true` renders the label, `false` renders
nothing, and the only warning left is the expected `generator-pending`.

## DECIDED 2026-08-22 — the `読み` field

Zach identified the cause, and it reframes the whole thing:

> i needed to label them because in mochi flashcard, they would generate 器 as キ and
> 革 as カク, 的 as テキ, adding parenthesis help the TTS in mochi, but i don't know if
> we need this in hashigo, i want hashigo to solve this natively

**The parenthesis was a TTS workaround, not a display choice.** And `Reference` is not
where the reading lives — measured, it holds the kanji breakdown as wiki-links (`器` →
`[[器|E9hblUmS]]`), so the reading exists nowhere but inside the parentheses.

**Green-lit:**

* a **`読み` field**, `local = 1`, holding the intended reading
* when present it is the input for **both** speech generation and accent derivation,
  instead of the head word
* it **renders as furigana** — his reason, and it is the decisive one: *"otherwise
  furigana engine might also get confused about it, too"*. The furigana generator would
  mis-read 器 exactly as the TTS did.
* populated once by parsing the parenthesis with the rule above, with the 13 before/after
  rows shown for approval. No hand-editing.

This generalises past the 7: any kanji with several readings can carry the one meant.

## Still to decide

* ~~Which side the label renders on~~ — **DECIDED**: side 1, inside `<<#Reading>>`.
  See the section above.
* ~~The exact label text~~ — **DECIDED: `かな`**, and not in the accent colour.
* ~~B's mechanism~~ — **DECIDED: the `読み` field**, above.
* Editing the 13 cards is authoring work: stage 10, or a one-off script.
* ~~**ONE ROW WHERE THE RULE AND THE INTENT COME APART**~~ — **ANSWERED 2026-08-22:
  おす is kana-primary, like its twin.** `Ufs9lMJR` is an OVERRIDE on top of the rule,
  not an amendment to it — the rule still reads script position for every other row.
  Final split: **6 読み / 6 かな主流 / 1 意味.** The detail that makes this cheap: the
  head word (`雄`) and the `読み` (`おす`) come out identical either way, so the whole
  consequence is whether the かな label shows on that one card.

  The original framing, kept because the reasoning is the reusable part:
  `scripts/reading-parse.ts` (read-only, writes nothing) produces all 13 rows, and 12
  are unambiguous. The exception is `Ufs9lMJR` **`（おす）雄`**, whose 意味 is
  *"male (animal, plant)"*. Its twin `vim2i4A9` **`めす（雌）`** is *"female (animal,
  plant)"* — one pair, authored together. The rule reads script position, so the twin
  is **かな主流** (kana outside) and this one is **読み** (kanji outside), purely
  because of which side the bracket landed on. Not special-cased: a heuristic that
  overrides a ratified rule on a hunch is worse than one row he looks at. If he says
  it is kana-primary, the fix is one row, not a rule change.
