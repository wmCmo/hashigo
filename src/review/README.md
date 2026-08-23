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
mounted.enter(0);                       // on screen — and see the two modes below
// ... he produces the contour, or names the word he just heard ...
mounted.loop.side(0)?.reveal();         // THIS is what compares
session.answer(remembered);
```

## Two modes, and `mounted.enter()` is the only thing that knows

**Decision 29, 2026-08-23 — this amends the invariant this module was built
around, so read it before changing anything here.** The hard rule used to be
stated over all 7,716 cards: audio fires on the cloze reveal, never on side
entry. That is exactly right for 692 of them and wrong for 3,177.

| | cards | the exercise | audio | `型` |
|---|---|---|---|---|
| `produce` | 692 単語 (`Reading` true) | see the kanji, recall the reading and the accent, say it, then reveal and hear it | on REVEAL | behind a cloze |
| `identify` | 3,177 (2,785 単語 + 392 言葉) | hear the clip, name the kanji | on ENTRY | plain |

*"my listening skill is far worse than my reading skill … that's why most of the
cards are like that."* `boolean-default` is `false`, so 1,882 単語 cards carry no
`Reading` row at all and land in `identify`.

**`identify` is not a laxer `produce`, it is the drill inverted** — the clip is
the question and the kanji is the answer. So the two calls are different methods
and are tested apart:

    loop.enter(pos)      plays NOTHING, on any card, ever. Unchanged by decision 29.
    mounted.enter(pos)   plays the question when the card is `identify` AND the side
                         masks something. Uses `side.prompt()`, which unmasks nothing.

**Use `mounted.enter()`.** `loop.enter()` on an identify card is silent, which
looks fine and deletes the exercise — the same shape of failure autoplay was, in
the other direction.

### `./mode.ts` — three things that keep it from being one `if`

1. **`漢字` declares a field called `Reading` and it is `plain`, not boolean** —
   it holds the actual reading (コウ on 36 cards, ショウ on 33) across 1,662 cards.
   The type check is load-bearing; without it every one of them is misclassified
   on a name collision.
2. **`identify` is not "everything that is not `produce`".** It is scoped to the
   templates that declare an `accent`-typed field — 単語 and 言葉. 敬語 (21 cards)
   and New Vocab (1,203) show the head word UNMASKED beside its clip: read it
   aloud, then hear it. Autoplay there hands him the pronunciation, which is the
   original defect wearing a new hat. The default is `produce`, the silent one, so
   a template added tomorrow cannot start autoplaying by omission.
3. **The prompt is per SIDE, not per card.** An identify card has a sentence side
   too (`例文` + `Audio`) and nothing on it is masked, so `promptsOnEntry` requires
   a cloze on the side. Measured over the real templates:

       単語 identify, side 2   2 clozes, 1 clip   the word is hidden → PROMPT
       単語 identify, side 3   0 clozes, 1 clip   例文 is visible    → no prompt
       言葉 identify, side 1   1 cloze,  1 clip   the word is hidden → PROMPT

### `型` is gated by the TEMPLATE, not by this module

The other half of decision 29 is data. `scripts/accent-field-apply.ts` writes
単語's side 2 as:

```plaintext
{{<furigana><< 単語 >></furigana>}}
<< #型 >>
<< #Reading >>
{{<< 型 >>}}          <- mode 1: the accent is the ANSWER, so it is masked
<< /Reading >>
<< ^Reading >>
<< 型 >>              <- mode 2: the accent is part of the QUESTION
<< /Reading >>
<< /型 >>
<< Speech >>
```

**Why the template and not the screen:** a resolved plain field is substituted to
TEXT before the render, so nothing downstream knows the characters `平板` came from
`型`. Gating it in code would mean adding field provenance to the resolver — the
most heavily tested module here — to express something the template already says.
Zach asked for it this way in his own words: *"it should render conditionally from
my template."*

**The outer `<<#型>>` is not decoration.** An empty cloze does not vanish: `{{}}`
reaches the page as the literal text `{{}}`. 689 of the 692 mode-1 cards have a
derived accent, so without the guard three cards show braces.

Measured over the real corpus after the edit, all four cases:

```plaintext
単語 mode 1 (慈善-like)     side 1  "あらかた" visible   side 2  2 clozes ([…]粗方 · […]平板)
単語 mode 2                 side 1  EMPTY              side 2  2 clozes, 平板 PLAIN
単語 mode 1, no 型 value     side 1  visible            side 2  1 cloze, no braces
言葉 (always mode 2)        side 1  1 cloze, 型 plain, clip present
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
loop.enter, 120 単語 cards        238 clip mounts · 0 resolve calls · 0 play() calls
reveal, 40 単語 cards              40 cards played · 79 play() calls

mounted.enter, 60 produce cards     0 resolve calls · 0 play() calls
mounted.enter, 60 identify cards    60 asked · 60 play() calls · 120 clozes STILL MASKED
言葉, all 392                      391 asked · 377 played · 391 clozes still masked
```

The identify rows are the ones added by decision 29, and the number that carries
the exercise is **120 clozes still masked** — playing on entry is easy to do the
wrong way, because `side.play()` also plays and it unmasks. The 391/377 gap is 14
cards whose clip the store cannot produce; on an identify card that is not a
missing extra, it is the QUESTION going missing, and the shell needs a fallback.

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
