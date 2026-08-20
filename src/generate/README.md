# `src/generate` — binding generated content to the fields that render it

This module exists because of one measured fact: **all 19 generator-typed
template fields in the corpus hold zero values.** Mochi keeps generated content
in `component-cache`, keyed by the generator's input text, and never in
`fields[].value`. So `<<Speech>>` resolved to the empty string, and the app was
silent while every layer around it was individually correct.

    generator-typed fields: speech 10, translate 5, ai 4  ->  0 have any value
    5,708 cards hold audio · 86 rendered an <audio> element
    単語: 3,477 cards, 3,456 with clips, rendered NONE

## The pipeline

```ts
const card  = resolveCard(row, template, { pendingGenerators: true });
const bound = expandGeneratorFields(card.sides, { fields, values, resolveGenerated });
const view  = renderResolvedCard({ ...card, sides: bound.sides }, { document });
const { diagnostics } = resolveFieldGenerations(db, bound.expanded, { cardId });
```

`pendingGenerators` is **opt-in and defaults to false**, because turning it on
changes what a card looks like: the marker stands, and an unexpanded render then
shows the literal text `<<Speech>>`. The `generator-pending` *warning* fires
either way — the debt is real whether or not this caller settles it.

## What is measured, not assumed

Three details each cause a silent whole-template failure if guessed. Each was
found by reconstructing a cache key and checking it against the store over all
7,346 templated cards (`build/step1/probe.ts`):

1. **The input is the rendered text, not the stored value.** 基本情報's cache key
   is `データ` where the field value is `{{データ}}`. Cloze braces come off,
   wiki-links reduce to display text, invisible marks go. Getting this wrong cost
   基本情報 all 471 of its cards and held the corpus at 92.29% instead of 95.35%.
2. **Only some options are part of the key** — `ai-task` / `gender` / `from` /
   `to` / `language`, never `ai-custom-prompt` or `randomize`. Not one of the
   42,569 blob identities carries a prompt.
3. **Prompt markers tolerate spaces.** Polysemy's prompt is
   `... using << 言葉 >> in Japanese`.

## The four buckets

A miss is never allowed to be quiet — miss-as-silence is the bug being fixed.
Over 18,356 field slots (one per generator field per card — **not** cards and
**not** blobs):

| bucket | slots | meaning |
|---|---|---|
| `exact` | 17,502 | the identity Mochi filed |
| `other-voice` | 507 | same text, different voice. Playable now; this is the regenerate-with-Neural2-C set |
| `mismatch` | 312 | the card has a clip of that kind and nothing matches its text |
| `missing` | 35 | never generated |

Plus 159 slots whose input cannot be resolved at all, so no request is built —
counted rather than hashed to a key nothing can match.

**`other-voice` is pain point #5 in the data.** It exists only where the
template's voice changed under clips that were already generated, which is
precisely the thing Mochi gave no way to fix.

## What is NOT here

No HTTP, no generation, no playback, no payload reads except the text a
downstream generator needs as input. `resolveFieldGeneration` returns an
*address*, so the caller decides whether to fetch — and the review UI must be
able to decide not to. Audio starts on a reveal and nowhere else; see
`src/render/reveal.ts` and the hard rule in `CLAUDE.md`.
