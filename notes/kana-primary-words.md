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
n = 3,858, matched against `[（(][^）)]*[）)]`.

| | cards | examples | what it needs |
|---|--:|---|---|
| **A. kana-primary word** | 6, all 言葉 | `かく(搔く)` `めす（雌）` `なす（茄子）` `あり(蟻)` `あく（灰汁）` `（おす）雄` | the ◎かな主流 flag |
| **B. kanji with an ambiguous READING** | 7, all 単語 | `器（うつわ）` `空く（すく）` `革（かわ）` `的（まと）` `主語（しゅご）` `日向　(ひなた)` | a reading hint — NOT a kana flag |
| C. an English gloss | 1 | `はたち (as in 20 years old)` | belongs in 意味 |

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

## Still to decide

* ~~Which side the label renders on~~ — **DECIDED**: side 1, inside `<<#Reading>>`.
  See the section above.
* **The exact label text.** `◎かな主流` as proposed, or shorter. Argument for shorter:
  it sits beside dense Japanese, the meaning is learned once, and `型` is also a pill —
  they should read as one family. `かな` or `◎かな`. Not in the accent colour: the accent
  is green and grades are binary, so every green pixel is focus or "remembered".
* **B's mechanism** — a `reading-hint` field, or lean on the existing `Reference` and
  furigana.
* Editing the 13 cards is authoring work: stage 10, or a one-off script.
