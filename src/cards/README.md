# src/cards — the card loader

The join between `hashigo/scheduler` (what to review) and `hashigo/render` (how
to draw it). A card id in, a renderable card out.

```ts
import { directionForTrackKind, loadRenderedCard } from "hashigo/cards";
import { dueTracks } from "hashigo/scheduler";

const [next] = dueTracks(db, { limit: 1 });
const card = loadRenderedCard(db, next.cardId, directionForTrackKind(next.kind));
```

Until now this existed only inside `spike/viewer/cards.worker.ts`, which is a
throwaway harness (`SPIKE.md`). `src/template` resolves a card against a
template and `src/render` turns the result into DOM, but neither has ever seen a
database, so nothing in `src/` could turn a track into something on a screen.

## It is an adapter, not a subsystem

Four small queries and two JSON columns decoded, at 0.30 ms a card. Everything
hard is already done and tested elsewhere. What it owns is the four ways that
assembly goes silently wrong — and three of the four were found by measuring or
by breaking it, not by reasoning about it.

**1. `pendingGenerators` is not optional here, and this module will not let you
turn it off.** All 19 generator-typed fields in the corpus store the empty string
— Mochi keeps generated content in `component-cache`, never in `fields[].value`
— so without the flag the marker is substituted away, the reference never reaches
the AST as a `field` node, and `expandGeneratorFields` has nothing to expand.
Measured over the corpus, forward, templated cards, counting
`GeneratorMount.name === "speech"`:

```plaintext
pendingGenerators: true    6,855 speech mounts over 5,664 cards
pendingGenerators: false      31 mounts
```

**99.5% of the audio, gone, and nothing raises an error** — the page renders and
is simply silent. So `renderLoadedCard` merges caller options UNDER its own and
a test asserts that passing `pendingGenerators: false` changes nothing. A caller
that genuinely wants the substituted form calls `renderCard` directly and has
said so deliberately.

That figure is not repeated from another file: `test/cards.test.ts` regenerates
it by driving `loadCard → renderLoadedCard → expandGeneratorFields → renderSides`
over all 7,716 cards and comparing against the hand-built assembly in
`test/generate.test.ts`, card for card and field for field.

**2. It carries what a render needs, and measurably nothing else.** A first
version also returned the inherited `reverse` and `voice`, joining
`card_reverse_resolved` and `card_voice_resolved` because both are one-line
joins. Measured over 200 real cards, that cost **23.42 ms/card**; the same
loader without them costs **0.30 ms**, a 78× difference:

```plaintext
card_reverse_resolved, on its own     4.33 ms/card
card_voice_resolved, on its own       0.01 ms/card
deck_paths, on its own                0.06 ms/card
the cards row alone                   0.01 ms/card
```

`deck_reverse_resolved` is `FROM decks d` with a correlated subquery per deck
over the recursive `deck_ancestry`, so joining it materialises the whole view
for every card. Preparing the statement once instead of per call moved 4.54 ms
to 4.33 — **the prepare was never the cost, the view was.** Neither field is on
the render path (the scheduler already chose the direction; `voice` belongs to
the audio resolver), so both moved to `cardContext`, one query away.

**3. `template_fields.options` is decoded here, and the type enforces it.**
`LoadedField extends TemplateFieldInput, GeneratorField` — a type-only import,
so no runtime dependency on the Node-bound `src/generate` enters this module.
That is not defensive; it caught a live bug. A first version carried `options`
as the raw JSON string and the corpus test cast it across. The cast compiled;
the run reported **340,576 divergent requests against an expected 0** and
`expanded` fell from 10,722 to 6,846 — while the headline mount count stayed
exactly right at 6,855, so the defect was invisible in the number anyone would
quote.

**4. The direction is resolved, not assumed.** A card's reverse is three-state
and the card beats the deck, walking up the tree; `cardContext` reads the view
rather than reimplementing the walk. A cloze track renders FORWARD — the cloze
index selects which deletion is hidden, which is not a side ordering.
`directionForTrackKind` is that rule in one place, because `kind === "reverse"`
and `kind.startsWith("reverse")` differ only on a string nobody has written yet.

## Browser-portable, and pinned as such

Typed against `SqliteHandle`, reaches no `node:` import, and listed in
`BROWSER_ENTRY_POINTS` in `test/browser-portable.test.ts`, which walks the whole
import graph. The review screen runs in an OPFS worker, so that is a requirement
rather than a nicety.

## The audio half — `./audio.ts`

`cardAudioResolver(db, cardId, { store })` is the `AudioResolver` that
`src/render/audio.ts` takes. That module owns everything about STARTING a sound
and deliberately never learns where bytes live; this is the injection, backed by
the real store.

```ts
const resolve = cardAudioResolver(db, cardId, { store });
const audio = audioController(rendered, { resolve });   // src/render/audio.ts
```

Measured end to end over 400 real cards: **373 speech mounts → 361 addressed →
361 payloads read → 16.2 MiB of `audio/mpeg`**, out of the 617.9 MiB store.

**The card id comes from the closure, not the address.** `AudioAddress`'s
attachment arm carries only `key`, and `blob_refs.ref_key` is a bare filename —
unique per card, not globally. Querying by key alone would be right on this
corpus by luck. A test asserts the same key against a different card resolves to
null.

**Two handles, and the split is not "speech versus the rest".** `readBlob` takes
the payload from `blobs.bytes` when the row carries it and from the store
otherwise. ai (15,958), translate (7,749), furigana (3,233) and dictionary (7)
are fully inline; **speech (10,791), file (15) and image (10) are not** — so a
caller that wants audio must pass a store, and one that wants furigana need not.

**A miss is `null`; anything else rethrows.** Null keeps a session alive over the
17 payloads Mochi lost and the 35 clips never generated. Rethrowing keeps a real
bug visible instead of making every card silent, which looks identical to "no
audio yet". Both halves are tested with a fake store.

## What it deliberately does not do

**It does not START audio.** Resolving bytes and playing them are different
jobs, and the second one has a correctness rule attached. That rule lives in
`src/render/reveal.ts` and `src/render/audio.ts`, and nothing here can reach it.

Its shape changed on 2026-08-23 and the short form is now misleading, so: `enter()`
never plays, on any card. On the 692 `Reading = true` cards playback comes only from
the reveal, because a clip on side entry gives away the contour before Zach has
produced it. On the other 3,177 the clip IS the question — he hears the word and
names the kanji — and it fires on entry through `prompt()`, which unmasks nothing.
Decision 29; `src/review/mode.ts` decides which.

**It does not generate anything.** Resolving finds a clip that already exists.
Where a card's text has changed and no clip matches it, the answer is null and
the element stays silent; creating the missing clip means a provider call and a
credential, and decision 18 says the TTS key never goes in the client.

**It does not hold a session or choose what comes next.** That is stage 7's, and
its shape is Zach's call.
