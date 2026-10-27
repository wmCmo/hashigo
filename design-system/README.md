Hashigo (はしご, "ladder") is a flashcard app for studying Japanese, one card, one rung at a time. The interface is quiet and grey. The word under study is set huge in the middle of a card, and a single colour, ruri (瑠璃, lapis lazuli), appears only on what is live: the dot by the count and the disc that plays the audio. Everything else steps back so the kanji can be the loudest thing on the screen.

## Principles

1. **The word is the hero.** The headword takes `headword` (120px) and the centre of the card. Nothing else on the screen comes close in size, colour or weight.
2. **One ruri, two places.** `accent` belongs only to the live dot beside the `Counter` and the `PlayButton` disc, plus the focus ring. It is never a background and never decoration, and as text only through `accent-text` on an `accent` chip. If a third blue thing appears, one of them is wrong.
3. **Grey does the structure.** Hierarchy comes from the `ink` → `ink-2` → `ink-3` steps and from size, not from colour, boxes or lines.
4. **One card, one screen.** A screen has the chrome (menu and count), the word rail, one `FlashCard` and the `GradeBar`. Nothing else.

## Voice

- Lowercase for controls: "remembered", "forgot", "next · 2 more", "delete card".
- Sentence case for anything that reads as a sentence: translations, messages, settings.
- Use as few words as possible. A count needs no label ("248", not "248 cards remaining"), and the accessible name says the rest.
- Japanese stays Japanese. Deck, field and pattern names (単語, 平板, 頭高) are never romanised or translated in the UI.
- No exclamation marks, no emoji, no praise. Forgetting is information, not failure: "forgot" gets no red.

## Colour

Two themes, light and dark, with the same roles in each. Light is the first theme and the fallback.

| role | token | use |
|---|---|---|
| ground | `canvas` | Behind everything. The chrome and the rail sit straight on it. |
| surface | `card` | The flashcard, and the label colour on an `ink` fill. |
| pressed-in | `sunk` | The hidden cloze, chips, secondary buttons and tracks. |
| line | `hairline` | Rare dividers. Decorative only. |
| text | `ink`, `ink-strong`, `ink-2` | Words and body text, the counter numerals, then readings, translations and labels. |
| off | `ink-3` | Disabled controls, a missing clip, fading rail words. Never text a person must read. |
| live | `accent`, `on-accent`, `accent-text` | Ruri: the dot, the disc and focus. `accent-text` is for the rare time it must be read as text. |
| destroy | `danger` | Delete, and a forgotten-grade chip, always paired with its word. |

Every text token's note names the grounds it holds 4.5:1 on, in both themes. `ink-2` on `sunk` is the tightest pair (4.67:1 light, 4.84:1 dark). Ruri is deeper in light (`#1f5fe0`) and brighter in dark (`#5b8cff`), so it holds at least 4:1 on both grounds. Ruri and `danger` are blue against red, a pair that stays apart under red–green colour blindness.

## Type

Two families, both from Google Fonts:

- **`jp` — Noto Sans JP.** All Japanese: the headword (`headword`, `headword-md`, `headword-sm`), the `rail`, `example` sentences and the `reading`. Use it at regular weight. A heavy headword loses the calm.
- **`sans` — Hanken Grotesk** (falls back to Noto Sans JP for any kana mixed in). All Latin text: the `counter` (800, tight, tabular numerals), the `gloss` (700), `body`, `button`, `translation` and the uppercase `label`.

The contrast between the two families is part of the look: light, airy kanji against short, bold Latin. Keep the weights at the extremes. The headword is 400 and the gloss and count are 700–800, with nothing in between. Pick the headword style by length: 1–2 characters `headword`, 3–4 `headword-md`, 5 or more `headword-sm`. `FlashCard` does this for you.

Load the families with:

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600;700;800&family=Noto+Sans+JP:wght@400;500;700&display=swap">
```

## Space, shape, depth

- Spacing runs `space-1` (4px) to `space-8` (64px). The card pads `space-6` on the sides and `space-7` above the headword. The phone gutter is `space-4`.
- Corners: `radius-lg` (28px) for the card, `radius-full` for every control (buttons, chips, the disc, the dot), `radius-md` for menus and sheets, `radius-sm` for the cloze. There are no square controls.
- Depth: in light, the card lifts off `canvas` with `shadow-card`, a whisper of shadow. In dark it has no shadow and is set apart by tone alone (`card` on `canvas`). The play disc carries `shadow-accent`, its ruri glow plus a soft halo ring in dark, and the live dot carries `shadow-dot`. Nothing else casts a shadow.

## Layout

The review screen, top to bottom: `MenuButton` top-left and `Counter` top-right on `canvas`. Then the `WordRail`, `space-7` lower. Then the `FlashCard`, which fills the remaining height. Then the `GradeBar`. The `PlayButton` sits in the card's bottom-right corner, under the right thumb. Controls stay at the bottom edge and nothing important sits at the top except the count. On a wide screen, keep the card at most 480px wide and centred, and give the rest of the width to `canvas`.

## Motion

- The rail slides 280ms `cubic-bezier(.2,.7,.2,1)` when the card changes.
- A cloze fades 200ms on reveal. The disc presses to 92% on touch. Playing shows three bars in the disc.
- Nothing moves on its own, and **audio never starts on its own**: a clip plays when the disc is pressed or a reveal plays it. All of the above stops under `prefers-reduced-motion`.

## States and focus

- Keyboard focus is a solid 2px `focus` ring (the `accent`), offset 2px, on every control. It holds 3:1 on `canvas` and `card` in both themes.
- Disabled is `ink-3` text on `sunk`. A clip with no audio is an `ink-3` disc that does not respond.
- Keyboard hints (`kbd` on `Button`) are shown only on devices with a hover-capable pointer, never on touch.

## Iconography

There is no icon set, by design. The system draws only what it needs as inline SVG in `currentColor`, with 1.5px strokes and round caps: the three-line menu, whose last line is short, and the playing bars. The play disc carries no glyph in a component preview; where it is the only audio control on a screen (the app's replay button), it carries a play triangle in `on-accent`. Do not add icons where a lowercase word works. If one is ever needed, draw it in the same 1.5px round stroke on a 24px grid.

## Logo

The mark is a ladder: two rails leaning in, three rungs, and a loose top rung in `accent`. The top rung is the step not yet taken, the same "live" meaning ruri has everywhere else. Draw it from the files in the Logos group, never redraw it.

- `mark.svg`, the full three-rung construction, for 24px and up (the boot screen, an app icon).
- `favicon.svg`, the two-rung small construction, for anything under 24px (the header, the browser tab). Below 24px the three-rung version's rungs blur into each other.
- Strokes are round-capped. The rails and rungs are `ink`; only the top rung is `accent`. On a dark ground the rails follow `ink` (they turn light) and the rung follows the dark `accent`.
- Beside the mark, set the name as the wordmark: lowercase "hashigo" in `sans` at 800, tracked -0.03em, in `ink-strong`.
- The app icon is the one place the mark sits on a container: a rounded square of `card`.
