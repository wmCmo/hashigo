# src/review — the card mount

A card id in, a **live** card out: rendered, armed, revealable, audible. One call
for a path that is six calls in a specific order, two of which are silently lossy
if you skip them.

```ts
import { mountTrack } from "hashigo/review";
import { buildSession } from "hashigo/session";

const session = buildSession(db);
const item = session.current()!;

const mounted = mountTrack({ db, track: item, document: browserDocument(document), store });
container.appendChild(mounted.result.root);
mounted.loop.enter(0);                  // on screen. PLAYS NOTHING, by design.
// ... he looks at the kanji, recalls the contour, says it aloud ...
mounted.loop.side(0)?.reveal();         // THIS is what plays
session.answer(remembered);
```

## What is new here, and it is not the convenience

**This is the first thing in `src/` to drive `shadowingLoop`** — the reveal loop
that actually ships. That mattered more than it sounds:

* `spike/viewer/` put the no-autoplay question in front of a real browser and its
  panel came back green — but its own README says it hand-rolls `revealSide()` and
  `armSide()` rather than importing `shadowingLoop`, so that was evidence about
  **Chromium**, not about the shipping code.
* `test/reveal.test.ts` drives the real loop, hard, but builds its renders by hand.

So nothing had ever driven `loadCard → render → expand → renderSides →
audioController → shadowingLoop` over real cards and then asked *did anything
play?* Now `test/review.test.ts` does, and the answer is measured:

```plaintext
mount + enter, 120 単語 cards    238 clip mounts · 0 resolve calls · 0 play() calls
reveal, 40 単語 cards             40 cards played · 79 play() calls
```

**Those first figures read 120 and 39/39 until 2026-08-23**, and the difference was a
defect in this module found by a peer review, not by me: `mountCard` omitted
`resolveGenerated`, so `Audio` and `Translate` — which chain off `例文`, an `ai` field
with zero stored values — died at the first hop. **3,801 clips, 35.7% of the corpus
audio, never mounted**, and the card count was unchanged because every missing one was
the SECOND clip on a card that already had one: the 例文 sentence audio that side 3 of
単語 exists to drill. It now defaults ON, `MountOptions.resolveGenerated` can turn it off
deliberately, and `test/review.test.ts` asserts both arms (238 on, 120 off) so it cannot
regress. The old assertion was `expect(clips).toBeGreaterThan(100)`, which passed either
way — the fix was safe *and* unguarded.

**Zero on entry is the number that matters.** `stats.requested` counts `resolve`
calls, so it goes non-zero the moment anything tries to *find* a clip — strictly
earlier than anything being heard. Asserting on it is tighter than asserting on
playback.

Teeth demonstrated, with the exact mutation an integrator used on 2026-08-20:
putting `audio?.play(side.audio)` inside `enter()` turns **2** of these tests red
and prints the damage — *120 resolve calls, 119 play() calls* — alongside **9** in
`test/reveal.test.ts`. The pairing is deliberate: a test that only proved silence
would also pass on a module that never plays anything at all, so `reveal is what
plays` is asserted beside it.

39 of 40 rather than 40 is not a fault: the corpus has 35 never-generated and 159
unbuildable field slots, so a card whose clip was never made resolves to null and
the session continues. That is the designed behaviour, not a miss.

## The sharp edge — `loadRenderedCard` cannot reach the audio

**`loadRenderedCard` is the documented entry point** (it is the example in
`src/cards/README.md`) **and it is not sufficient for any card with speech.**
`expandGeneratorFields` needs the template's FIELDS and the card's VALUES;
`loadRenderedCard` returns neither, only the `RenderedCard`. Follow the example and
you get a card that renders perfectly and is **silent**, with no error anywhere, on
all 5,664 cards that carry speech.

So this module calls `loadCard`, keeps the loaded card, and then renders. Two steps
are load-bearing and each is a silent whole-corpus failure if dropped:

1. **`pendingGenerators: true`** — forced by `renderLoadedCard`, which is the
   reason that function exists. Without it the markers are substituted away and
   **99.5%** of the audio disappears: 6,855 speech mounts against 31.
2. **`expandGeneratorFields`** — without it the mounts exist but carry no
   `request`, so `cardAudioResolver` has nothing to address and every clip resolves
   to null.

`MountedCard.divergent` surfaces `expandGeneratorFields`'s own "one way this can go
quietly wrong" — a key option that cannot ride on the synthetic element, making the
renderer's descriptor hash to a different key than the request beside it. Zero over
the corpus, and exposed rather than dropped so a screen can assert on it.

## What it does not own

It does not own the CSS, the chrome, the session loop or the grading buttons —
those are the screen (decision 23, direction A2) and `hashigo/session`. It builds
DOM and hands back the loop; `enter()`, `reveal()`, `replay()` and `dispose()` are
the whole surface.

It also does not decide when to reveal. Binding a tap to a cloze is
`shadowingLoop`'s `bindClozes` (default on, and a no-op against a
`MemoryElement`), so a real screen gets tap-to-reveal for free and a test does not.

Browser-portable: typed against `RenderDocument`, so `browserDocument(document)`
drives a screen and `memoryDocument()` drives a test. Pinned by
`test/browser-portable.test.ts`.
