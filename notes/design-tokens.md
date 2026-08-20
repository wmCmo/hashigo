# Hashigo visual design language

Brief, in Zach's words: *"i don't want my app to look like another vibe coded
lovable style of claude style feel, i want it to have sleek, minimal, light weight
feeling, just like when you use monkeytype you get it? or when you use notion, you
get that aesthetic feeling. you can look at monkey type repo … for the `terminal`
theme, it's amazing"*

Two labels are used throughout and they mean different things:

* **MEASURED** — read out of a real file, path and commit given. Not retyped from
  memory, not eyeballed off a screenshot.
* **PROPOSED** — my design work. Argued, and where it is a colour, the contrast
  ratio is computed, but it is a proposal and you can overrule any of it.

---

## 1. The palette

### 1.1 MEASURED — Monkeytype's `terminal` theme, verbatim

The theme is **not** a CSS file, which is why the obvious path 404s. Confirmed:
`frontend/static/themes/` on `master` holds 51 `.css` files and **none of them is
`terminal.css`**. Commit `e26630aa` (2026-01-20, *"refactor(theme): add theme
component, remove duplicate color definitions"*) deleted the per-theme colour CSS
and moved all 187 themes into a TypeScript constant. Only themes that need *extra*
CSS beyond the ten colours keep a file, flagged by `hasCss: true`. `terminal` does
not, so it has no file at all.

**Authoritative source** — `frontend/src/ts/constants/themes.ts`, line 2116,
key `terminal`, at commit `91bd24bb8513785c7364cbea29296ff7adafac41`:
<https://github.com/monkeytypegame/monkeytype/blob/91bd24bb8513785c7364cbea29296ff7adafac41/frontend/src/ts/constants/themes.ts#L2116>

```ts
  terminal: {
    bg: "#191a1b",
    caret: "#79a617",
    main: "#79a617",
    sub: "#48494b",
    subAlt: "#141516",
    text: "#e7eae0",
    error: "#a61717",
    errorExtra: "#731010",
    colorfulError: "#a61717",
    colorfulErrorExtra: "#731010",
  },
```

Those keys become CSS custom properties at runtime in
`frontend/src/ts/components/core/Theme.tsx`, which writes a `<style>` block —
this is the mapping from key name to property name, verbatim:

```css
:root {
    --bg-color: #191a1b;
    --main-color: #79a617;
    --caret-color: #79a617;
    --sub-color: #48494b;
    --sub-alt-color: #141516;
    --text-color: #e7eae0;
    --error-color: #a61717;
    --error-extra-color: #731010;
    --colorful-error-color: #a61717;
    --colorful-error-extra-color: #731010;
}
```

**Second candidate, corroborating, now deleted.** The pre-refactor file
`frontend/static/themes/terminal.css` at `e26630aa~1` contained exactly those ten
declarations and no others — same hexes, same order. So the two sources agree and
there is no third. Use the TS constant; the CSS file no longer exists on `master`.

| Monkeytype key | CSS property | Hex | What it actually paints |
| --- | --- | --- | --- |
| `bg` | `--bg-color` | `#191a1b` | page ground |
| `subAlt` | `--sub-alt-color` | `#141516` | button / panel fill (**darker** than the page) |
| `sub` | `--sub-color` | `#48494b` | untyped words, inactive labels, scrollbar |
| `text` | `--text-color` | `#e7eae0` | typed text, hovered link, focus ring |
| `main` | `--main-color` | `#79a617` | the single accent — active button, stats, caret |
| `caret` | `--caret-color` | `#79a617` | identical to `main` |
| `error` | `--error-color` | `#a61717` | mistyped letter |
| `errorExtra` | `--error-extra-color` | `#731010` | extra/overflow letters |
| `colorfulError` | `--colorful-error-color` | `#a61717` | identical to `error` |
| `colorfulErrorExtra` | `--colorful-error-extra-color` | `#731010` | identical to `errorExtra` |

Ten declared colours, **six distinct values**. Two of the six are one accent hue
repeated, two more are one red repeated. That is the whole theme.

### 1.2 MEASURED — contrast inside the terminal theme, and why it cannot be copied

Computed with the WCAG 2.x relative-luminance formula on the hexes above:

| Pair | Ratio | Verdict |
| --- | --- | --- |
| `text` on `bg` | **14.31:1** | AAA |
| `text` on `subAlt` | **15.01:1** | AAA |
| `main` on `bg` | **6.04:1** | AA |
| `bg` on `main` (active button) | **6.04:1** | AA |
| `sub` on `bg` | **1.93:1** | **fail** |
| `sub` on `subAlt` | **2.03:1** | **fail** |
| `error` on `bg` | **2.29:1** | **fail** |
| `errorExtra` on `bg` | **1.50:1** | **fail** |
| `subAlt` vs `bg` (surface separation) | **1.05:1** | — |

This is the single most important thing to understand before borrowing the palette.
Monkeytype's low-contrast values are **correct for Monkeytype and wrong for
Hashigo**. `sub` at 1.93:1 is the colour of *words you have not typed yet* — it is
supposed to recede into the background so the typed text pops; it is scenery, not
copy. `error` at 2.29:1 is one glyph you are already looking at, and it is
reinforced by position, not by colour alone.

Hashigo has no equivalent. Every grey in Hashigo carries a reading, an interval, a
count, or a **furigana** at half size. Take `sub` and `error` literally and the app
is unreadable. **What transfers is the structure — six values, one accent, deep
neutrals, elevation by fill — not the low-contrast greys.**

Note also `subAlt` (`#141516`) is **darker** than `bg` (`#191a1b`): raised elements
in the terminal theme go *down* in luminance, and the two surfaces are separated by
1.05:1 — a difference you can barely name but can definitely see. No border, no
shadow, no gradient. That trick does transfer.

### 1.3 PROPOSED — Hashigo, both themes

Same twelve token names already used by `SPEC.html`. Values are new. Every text
pair's ratio is in §3.3.

**Light** (bare `:root`, the complete palette):

| Token | Value | Provenance |
| --- | --- | --- |
| `--ground` | `#F2F3EF` | new — low-chroma yellow-green off-white, echoes `#e7eae0` |
| `--surface` | `#FFFFFF` | new |
| `--sunken` | `#E7EAE0` | **Monkeytype `text` verbatim**, used as a fill |
| `--ink` | `#191A1B` | **Monkeytype `bg` verbatim**, used as text |
| `--muted` | `#585D4E` | new |
| `--faint` | `#6C7160` | new |
| `--rule` | `#CFD4C2` | new |
| `--accent` | `#4A6B12` | same hue as `#79a617`, darkened for a light ground |
| `--accent-soft` | `#EAF0DA` | new |
| `--alert` | `#9C2B1F` | Monkeytype `error` hue, lifted off `#a61717` |
| `--alert-soft` | `#F7E7E4` | new |
| `--good` | `#4A6B12` | **identical to `--accent`** — see below |

**Dark** (redefined under both `@media` and `[data-theme="dark"]`):

| Token | Value | Provenance |
| --- | --- | --- |
| `--ground` | `#101112` | new — one step below Monkeytype's `bg`, for night |
| `--surface` | `#191A1B` | **Monkeytype `bg` verbatim** |
| `--sunken` | `#141516` | **Monkeytype `subAlt` verbatim** |
| `--ink` | `#E7EAE0` | **Monkeytype `text` verbatim** |
| `--muted` | `#9CA095` | new — replaces `sub` `#48494b`, which fails at 1.93:1 |
| `--faint` | `#838878` | new |
| `--rule` | `#31332E` | new |
| `--accent` | `#79A617` | **Monkeytype `main`/`caret` verbatim** |
| `--accent-soft` | `#202B0B` | new |
| `--alert` | `#E0705E` | new — replaces `error` `#a61717`, which fails at 2.29:1 |
| `--alert-soft` | `#2B1512` | new |
| `--good` | `#79A617` | **identical to `--accent`** |

Four of Monkeytype's six distinct values survive unchanged in the dark theme, and
two of them are reused in the light theme with their roles swapped. The two that do
not survive are the two that fail contrast.

**`--good` is the same value as `--accent`, deliberately.** The accent is already
green, and inventing a second, slightly different green for "remembered" produces
the classic two-greens-that-look-like-a-bug problem. Grades are binary (settled
decision 2), so there are exactly two grade colours: the accent green means
*remembered*, `--alert` red means *forgot*. The cost is a hard rule, stated once
here and enforced in review: **the accent may never be used decoratively.** Every
green pixel in the app is either the focus/active state or the word "remembered".
If green ever appears as a stripe, an icon tint, or a heading colour, the grade
loses its meaning.

Total hues in the app: **two** (yellow-green, red) plus a neutral ramp. Same count
as the terminal theme.

### 1.4 What changed for the light theme, and why it is not an inversion

Flipping the dark palette gives you `#79a617` on white at **3.42:1** — a
fluorescent olive that fails AA and looks like a highlighter. Naive inversion also
turns the deep, restful ground into a glare panel. Four specific changes:

1. **The accent was darkened, not inverted.** `#79A617` → `#4A6B12`: same hue angle
   (~78°), similar chroma, luminance dropped until it cleared AA on white
   (**6.17:1**). The colour still reads as the same green — it reads as ink of that
   green rather than light of it.
2. **The ground is off-white, not white; the surface is white.** In dark, `--ground`
   is *darker* than `--surface`. In light, `--ground` is *darker* (`#F2F3EF`) than
   `--surface` (`#FFFFFF`) too — the relation is preserved, so the card still sits
   above the page in both themes without changing any layout rule. Monkeytype's own
   `subAlt`-below-`bg` inversion was **not** carried over: a raised element darker
   than the page reads as a hole on a light ground.
3. **The neutral tint was kept, and it is not cream.** `#F2F3EF` and `#E7EAE0` sit
   at very low chroma on the yellow-green axis — the same axis as `#e7eae0`, which
   is where the terminal theme's warmth actually lives. Cream (the AI tell, §4) is
   yellow-*orange* at higher chroma. Different axis, and it matters: cream plus a
   green accent goes muddy, this does not.
4. **The reds went in opposite directions.** Dark needed `#a61717` *lifted* to
   `#E0705E` to clear AA on a near-black; light needed it *darkened* slightly to
   `#9C2B1F` to clear AA on white with room to spare (7.56:1). Neither is the other
   inverted.

---

## 2. Why it works — what Monkeytype and Notion have in common

Zach named two products that look nothing alike. What they share is a set of
decisions, and those are what transfer. MEASURED claims cite a file. Notion has no
public source, so **every Notion claim below is marked OBSERVED** — read off the
product, not out of a repo. Flag them if you disagree.

### 2.1 Type does the work that decoration would otherwise do

**MEASURED.** `frontend/src/styles/core.scss` line 3:

```scss
--font: "Roboto Mono", "Vazirharf", monospace;
```

That is not the font for code blocks. That is `body { font-family: var(--font) }`
(core.scss line 171) — the **entire Monkeytype UI is monospace**. Settings pages,
buttons, the leaderboard, all of it. One family, one axis of variation (size and
weight), and the tabular alignment of a monospace does the job that borders and
rules do elsewhere: numbers line up in columns without a table.

**OBSERVED, Notion:** the exact opposite face, the same discipline — one system
sans, and the visual hierarchy comes almost entirely from size, weight and vertical
space. Notion has essentially no decorative colour in the editing surface.

The common rule: **one family carries the whole interface, and hierarchy is built
from size, weight and space before any other tool is reached for.** Neither product
has a "heading colour", a "card border style", or a second display face.

### 2.2 Restraint is specific, not vague — here is the list of what is absent

**MEASURED**, from `core.scss` (409 lines total) and `buttons.scss`:

* **One radius token for the entire app.** `--roundness: 0.5rem` (core.scss line 2).
  Small things get exactly half of it: `--balloon-border-radius: calc(var(--roundness) / 2)`
  (line 33), and the focus ring uses the same half (line 159). So the whole product
  has **two** radii — 8px and 4px — derived from one number. Not a scale of six.
* **No shadows for elevation.** The only `box-shadow` in `core.scss` is the focus
  ring (below). Surfaces are separated by fill difference alone: `subAlt` against
  `bg` at 1.05:1.
* **No borders on controls.** `buttons.scss`: `border: none`, `background: var(--sub-alt-color)`.
  A button is a fill, full stop.
* **No gradients, no glass, no glow** in the base theme. (`core.scss` does define
  `--crt-*` `color-mix` glow variables, lines 7–30, but those exist for the opt-in
  CRT filter, not the default look.)

**OBSERVED, Notion:** same absences — flat fills, hairline dividers, one small
radius, and shadows reserved for things that genuinely float (popovers, drag
previews), never for a static block.

The rule: **a surface is a fill. A shadow means "this is temporarily above the
page", and nothing else.**

### 2.3 One accent, and it only marks the live thing

**MEASURED**, `buttons.scss`:

```scss
background: var(--sub-alt-color);   // default button
&.active { background: var(--main-color); color: var(--bg-color); }
&.danger { background: var(--error-color); color: var(--bg-color); }
```

So at any moment the accent colour appears on: the caret, the active/selected
button, and the live statistics. Everything else is neutral. The `.active` state
does not add a border, a shadow, a checkmark and a colour — it swaps the fill and
inverts the text. **One property changes.**

**OBSERVED, Notion:** the blue appears on the text cursor, the selected sidebar
row, and text selection. Not on headings, not on cards, not on icons.

### 2.4 Focus and state are signalled by inversion or by a ring, never by ornament

**MEASURED**, `core.scss` lines 155–159:

```scss
&:focus-visible {
  outline: none;
  box-shadow: 0 0 0 0.1rem var(--bg-color), 0 0 0 0.2rem var(--text-color);
  border-radius: calc(var(--roundness) / 2);
}
```

A two-ring shadow: an inner ring in the **background** colour to hold a gap, then
an outer ring in the text colour. It works on every surface without knowing which
surface it is on, and it is a hard-edged ring — no blur, no glow. Note it is on
`:focus-visible`, so it appears for keyboard and not for touch.

### 2.5 Motion is short, and only ever on colour

**MEASURED**, `core.scss` line 147 and `buttons.scss` line 30:

```scss
transition: color 0.125s, opacity 0.125s, background 0.125s;
```

**125 milliseconds**, and the property list is exhaustive: `color`, `background`,
`opacity`. Nothing transitions `transform`, `width`, `height`, or position. There is
no easing curve specified — the browser default. So things change *colour* smoothly
and change *place* instantly.

That is the whole motion system. Falsifiable and easy to check your work against:
if you write a `transform` transition, a `scale` on tap, a slide-in, or a duration
over ~150ms, you have left the aesthetic.

### 2.6 Density: generous line-height, tight everything else

**MEASURED**, `core.scss`: `line-height: 1.25` on the root (line 141), padding
driven by `--padding-inline: 2rem` and `--content-max-width: 1536px` (lines 59–60),
with content in a named grid so the measure is capped and the gutters are the same
everywhere. Button padding is `0.5em` — one value, in `em`, so it scales with type.

**OBSERVED, Notion:** looser line-height in prose, but the same idea — the page has
one measure, one gutter, and spacing comes from a handful of `em`-relative values,
not per-component numbers.

The rule: **whitespace is generous *around* content blocks and tight *inside*
controls.** The lightness comes from the gutters, not from padding every element.

### 2.7 Not found

I looked for `prefers-reduced-motion` in Monkeytype and it appears in three files
(`frontend/src/styles/media-queries.scss`, `frontend/src/styles/test.scss`,
`frontend/src/ts/utils/misc.ts`) — so it exists, but I did not read them, and
**Monkeytype is not a reference for how Hashigo should handle reduced motion.**
§5.5 states Hashigo's rule independently.

---

## 3. Mapping onto Hashigo's tokens

### 3.1 MEASURED — what exists today

Two files, two *different* token systems, which is worth knowing before adding a
third:

`SPEC.html` lines 5–56 — the twelve-token system the brief refers to, with the
three-state contract already correct (`:root`, then
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`, then
`:root[data-theme="dark"]`). Current values are a blue-grey scheme:
`--ground #F6F8FB`, `--surface #FFFFFF`, `--sunken #EEF2F8`, `--ink #141D2B`,
`--muted #56657A`, `--faint #7C8B9E`, `--rule #DCE3EC`, `--accent #2B4C8C`,
`--accent-soft #E7EDF8`, `--alert #A8432F`, `--alert-soft #FAECE8`,
`--good #2F6B4F`; fonts `--display` (sans), `--body` (**serif** — Charter / Iowan
Old Style / Georgia / Yu Mincho), `--mono`.

`dashboard.html` lines 15–78 — a **separate, differently-named** set:
`--page` (not `--ground`), `--surface`, `--ink`, `--ink-2`, `--ink-muted`, `--grid`,
`--axis`, `--border`, plus `--series-1/2`, `--heat-0..4`, `--ord-1..3`. Warm
near-neutral (`--page #f9f9f7`, `--surface #fcfcfb`) with a blue accent
(`--series-1 #2a78d6`). It also sets `color-scheme` per state and carries a comment
recording that `#6f6d68` is 5.03:1 on its surface and that one shared grey cannot
clear AA on both themes — so contrast reasoning is already a habit in this repo.

`spike/viewer/index.html` lines 299–307 — the cloze styling, self-labelled
*"PROVISIONAL, and the most provisional thing here"*: mask gets
`background: var(--mask); border-radius: 3px; padding: 0 0.35em`, and a revealed
cloze gets `border-bottom: 2px solid var(--accent)`. Also `ruby { ruby-position: over }`.

**PROPOSED:** the app adopts the `SPEC.html` twelve-token names with §1.3's values.
`dashboard.html`'s chart-specific tokens (`--series-*`, `--heat-*`, `--ord-*`,
`--grid`, `--axis`) stay as they are — they are a data-visualisation palette and
should not be forced onto a two-hue UI palette — but `--page` should be renamed
`--ground`, `--ink-muted` → `--muted`, `--border` → `--rule`, so there is one
vocabulary. That rename is a mechanical change to one generated file and its
generator, `src/dashboard/render.ts`.

### 3.2 PROPOSED — the full declaration

Three-state contract, complete light palette on bare `:root`, only redefinitions in
the two dark blocks, explicit `body` background from a token.

```css
:root {
  color-scheme: light;

  --ground:      #F2F3EF;
  --surface:     #FFFFFF;
  --sunken:      #E7EAE0;
  --ink:         #191A1B;
  --muted:       #585D4E;
  --faint:       #6C7160;
  --rule:        #CFD4C2;
  --accent:      #4A6B12;
  --accent-soft: #EAF0DA;
  --alert:       #9C2B1F;
  --alert-soft:  #F7E7E4;
  --good:        #4A6B12;   /* == --accent, on purpose. See §1.3. */

  /* One radius number; small things take half. Monkeytype's rule, measured. */
  --radius:      8px;
  --radius-sm:   4px;

  /* Colour only, 125ms. Never transform, never layout. */
  --t:           125ms;

  --display: ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text",
             "Segoe UI", Roboto, "Yu Gothic UI", "Hiragino Kaku Gothic ProN",
             Meiryo, "Noto Sans JP", sans-serif;
  --body:    ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text",
             "Segoe UI", Roboto, "Yu Gothic UI", "Hiragino Kaku Gothic ProN",
             Meiryo, "Noto Sans JP", sans-serif;
  --mono:    ui-monospace, "Cascadia Mono", "SF Mono", "Roboto Mono", Consolas,
             "Yu Gothic UI", Meiryo, "Noto Sans JP", monospace;
  /* The card face — the one place a slightly larger, calmer JP face earns its
     keep. Same stack, different size/tracking; NOT a different family. */
  --jp:      var(--display);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --ground:      #101112;
    --surface:     #191A1B;
    --sunken:      #141516;
    --ink:         #E7EAE0;
    --muted:       #9CA095;
    --faint:       #838878;
    --rule:        #31332E;
    --accent:      #79A617;
    --accent-soft: #202B0B;
    --alert:       #E0705E;
    --alert-soft:  #2B1512;
    --good:        #79A617;
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --ground:      #101112;
  --surface:     #191A1B;
  --sunken:      #141516;
  --ink:         #E7EAE0;
  --muted:       #9CA095;
  --faint:       #838878;
  --rule:        #31332E;
  --accent:      #79A617;
  --accent-soft: #202B0B;
  --alert:       #E0705E;
  --alert-soft:  #2B1512;
  --good:        #79A617;
}

html { background: var(--ground); }   /* overscroll on Android shows html, not body */
body {
  background: var(--ground);          /* explicit, from a token — required */
  color: var(--ink);
  font-family: var(--body);
  margin: 0;
  -webkit-text-size-adjust: 100%;
}
```

Note the radius, transition and font tokens are declared **only** on bare `:root`
and never redefined — they are not theme-dependent, and putting them in a dark block
would be the exact bug the contract warns about.

### 3.3 PROPOSED — contrast, every text pair

Computed with the WCAG 2.x formula. AA normal text = 4.5:1, AA large = 3:1
(large = ≥24px, or ≥18.66px bold), AAA normal = 7:1.

**Light**

| Foreground | Background | Ratio | Verdict |
| --- | --- | --- | --- |
| `--ink` | `--surface` | **17.43:1** | AAA |
| `--ink` | `--ground` | **15.64:1** | AAA |
| `--ink` | `--sunken` | **14.31:1** | AAA |
| `--muted` | `--surface` | **6.79:1** | AA |
| `--muted` | `--ground` | **6.10:1** | AA |
| `--muted` | `--sunken` | **5.58:1** | AA |
| `--faint` | `--surface` | **5.04:1** | AA |
| `--faint` | `--ground` | **4.52:1** | AA (barely) |
| `--faint` | `--sunken` | **4.14:1** | **large text only** |
| `--accent` | `--surface` | **6.17:1** | AA |
| `--accent` | `--ground` | **5.54:1** | AA |
| `--accent` | `--sunken` | **5.07:1** | AA |
| `--accent` | `--accent-soft` | **5.28:1** | AA |
| `--ink` | `--accent-soft` | **14.92:1** | AAA |
| `--alert` | `--surface` | **7.56:1** | AAA |
| `--alert` | `--ground` | **6.78:1** | AA |
| `--alert` | `--sunken` | **6.21:1** | AA |
| `--alert` | `--alert-soft` | **6.30:1** | AA |
| `--ink` | `--alert-soft` | **14.53:1** | AAA |
| `--surface` | `--accent` (text knocked out of an accent fill) | **6.17:1** | AA |
| `--surface` | `--muted` (text knocked out of the cloze mask) | **6.79:1** | AA |

**Dark**

| Foreground | Background | Ratio | Verdict |
| --- | --- | --- | --- |
| `--ink` | `--surface` | **14.31:1** | AAA |
| `--ink` | `--ground` | **15.52:1** | AAA |
| `--ink` | `--sunken` | **15.01:1** | AAA |
| `--muted` | `--surface` | **6.54:1** | AA |
| `--muted` | `--ground` | **7.09:1** | AAA |
| `--muted` | `--sunken` | **6.86:1** | AA |
| `--faint` | `--surface` | **4.78:1** | AA |
| `--faint` | `--ground` | **5.18:1** | AA |
| `--faint` | `--sunken` | **5.01:1** | AA |
| `--accent` | `--surface` | **6.04:1** | AA |
| `--accent` | `--ground` | **6.55:1** | AA |
| `--accent` | `--sunken` | **6.34:1** | AA |
| `--accent` | `--accent-soft` | **5.16:1** | AA |
| `--ink` | `--accent-soft` | **12.21:1** | AAA |
| `--alert` | `--surface` | **5.52:1** | AA |
| `--alert` | `--ground` | **5.98:1** | AA |
| `--alert` | `--sunken` | **5.79:1** | AA |
| `--alert` | `--alert-soft` | **5.46:1** | AA |
| `--ink` | `--alert-soft` | **14.15:1** | AAA |
| `--surface` | `--accent` (text knocked out of an accent fill) | **6.04:1** | AA |
| `--surface` | `--muted` (text knocked out of the cloze mask) | **6.54:1** | AA |

**Every text pair passes AA except one: `--faint` on `--sunken` in the light theme,
at 4.14:1, which is large-text-only.** That is the single exception in the system
and the rule that follows is: **`--faint` is not permitted on `--sunken`.** Since
`--sunken` is where wells, code blocks and masks live, and `--faint` is for
timestamps and hints, that combination should not occur anyway.

Non-text pairs, for reference (WCAG 1.4.11 asks 3:1 for *meaningful* non-text UI;
decorative dividers are exempt):

| Pair | Light | Dark |
| --- | --- | --- |
| `--rule` / `--surface` | 1.52:1 | 1.36:1 |
| `--rule` / `--ground` | 1.36:1 | 1.48:1 |
| `--sunken` / `--surface` | 1.22:1 | 1.05:1 |
| `--surface` / `--ground` | 1.11:1 | 1.08:1 |
| `--accent` (focus ring) / `--surface` | 6.17:1 | 6.04:1 |
| `--muted` (mask fill) / `--surface` | 6.79:1 | 6.54:1 |

`--rule` sits around 1.4:1 on purpose — it is a hairline, in the Notion register,
and the dark theme's 1.36:1 is *stronger* than Monkeytype's own 1.05:1 surface
separation. **The rule that follows: `--rule` is decorative only.** Anything a rule
would have to *mean* — focus, selection, the current row — is carried by `--accent`
at 6:1, or by an `--accent-soft` fill, never by a hairline.

### 3.4 PROPOSED — furigana is the demanding case, so size it first

Ruby is the reason this palette is conservative. Facts that drive it:

* The browser default for `rt` is **50%** of the parent. `spike/viewer/index.html`
  already sets `ruby-position: over`.
* At a 34px kanji, 50% is **17px** — *below* the 18.66px-bold / 24px threshold, so
  **AA normal (4.5:1) applies to furigana, not AA large.** Anyone reasoning "it's
  small so 3:1 is fine" has it exactly backwards; the small size is what makes 3:1
  illegal here.
* CJK glyphs at 17px are hairline-dense — a 4-stroke radical inside a 17px box has
  strokes about a device pixel wide. A ratio that is *technically* AA can still be
  mush. Treat ruby as needing **7:1**.

Rules:

1. **Ruby text uses `--ink` only.** `--ink` is 17.43:1 / 14.31:1 on `--surface`.
   Never `--muted` (6.5–6.8:1, legal but thin at 17px), and **never `--faint`**.
2. Set the size explicitly rather than inheriting 50%: `rt { font-size: 0.55em }`
   with a floor, e.g. `font-size: max(0.55em, 13px)`, so a small kanji cannot drag
   the reading below 13px.
3. Give ruby room: `ruby { line-height: 2.1 }` on the card face. Ruby that collides
   with the line above is the most common furigana defect and it is a leading, not
   a colour, problem.
4. `rt { font-weight: 400 }` — never bold. Bold at 17px fills the counters of dense
   kanji and *reduces* legibility even as it raises the measured ratio.
5. Do not letter-space ruby. `letter-spacing` on CJK breaks the mora-to-kanji
   alignment that makes furigana readable at all.

### 3.5 PROPOSED — fonts, given no CDN and a Japanese corpus

The CSP blocks external font hosts, so every face is a system stack or bundled.

**The single biggest change from `SPEC.html`: `--body` stops being a serif.**
Today it is `Charter, "Iowan Old Style", Georgia, "Yu Mincho", "Hiragino Mincho ProN", …`.
Two problems. First, a serif body is the opposite of both reference products.
Second and worse: **Yu Mincho and Hiragino Mincho do not exist on Android.** On his
phone the Latin falls to Georgia-or-whatever and the Japanese falls to Android's
default — so the pairing he sees is not the pairing that was designed. The serif is
fine for `SPEC.html` as a document; it is wrong for the app.

Proposed: `--display` and `--body` are **the same system sans stack** (see §3.2).
Weight and size separate them, per §2.1. Concretely: `--display` used at 600 weight
with `letter-spacing: -0.01em`; `--body` at 400 with normal tracking.

Stack notes, all of which matter:

* `ui-sans-serif` / `system-ui` first — resolves to Roboto on Android, Segoe UI
  Variable on Windows 11, SF on Apple. Zero bytes, correct on all three.
* Every stack ends in Japanese fallbacks **before** the generic:
  `"Yu Gothic UI"` (Windows), `"Hiragino Kaku Gothic ProN"` (Apple), `Meiryo`
  (older Windows), `"Noto Sans JP"` (Android / Linux). Order is
  most-specific-per-platform first; only one will ever resolve.
* **`lang="ja"` is load-bearing, not decoration.** Han unification means the same
  codepoint has different correct glyph shapes in Japanese and Chinese —
  直, 骨, 今, 却 among many. Without `lang="ja"` a browser that falls back to a CJK
  font may pick the Chinese forms and his kanji will be subtly, persistently wrong.
  `dashboard.html` already has `<html lang="ja">`; the app shell must too, and any
  card fragment rendered into a foreign-language page needs `lang="ja"` on the
  fragment.
* **Mono is a system stack, not Roboto Mono.** Monkeytype's monospace UI is its
  signature, but reproducing it means bundling a webfont. If Zach wants that
  character, bundle **Roboto Mono, Latin subset only** as a local `@font-face`
  (~15KB woff2, and it is Apache-2.0). Critically: **Roboto Mono contains no
  kanji**, so the JP fallbacks must come *after* it in the stack or every Japanese
  glyph in a mono context silently falls to the browser default. That is exactly the
  failure mode the brief warns about, and it is invisible in a Latin-only test.
* Use mono the way Monkeytype does — but sparingly, because Hashigo is not a typing
  test. Proposed scope for `--mono`: intervals, due counts, dates, review stats, the
  card id. Anything tabular or numeric. **Never** the card face and never furigana.

---

## 4. What to avoid — the AI-generated tell, item by item

Each row is a specific thing a builder can check their own diff against.

| The tell | Why it reads as generated | Hashigo instead |
| --- | --- | --- |
| Warm cream ground (`#FDF8F3`-ish) with a terracotta / burnt-orange accent | The single most-repeated palette of the era. Cream is yellow-orange at moderate chroma; it plus a warm accent goes muddy and dates the app instantly. | `--ground #F2F3EF` — very low chroma on the **yellow-green** axis, matched to `#e7eae0`. Not cream, not warm. Accent is green (`#4A6B12`), and there is no orange anywhere. |
| Near-black ground with a lone acid-green pop | The "hacker" preset. Reads as a theme applied on top of a design rather than as the design. | The dark theme's green **is** Monkeytype's `#79A617`, but it is load-bearing (focus, active, *remembered*) and never decorative. Same colour, opposite role. |
| Purple-to-blue gradient hero | There is no gradient in the reference products at all. | **Zero gradients anywhere.** Surfaces are flat fills. The largest thing on any screen is the card face, and it is `--surface`, one colour. |
| Inter or Space Grotesk as the default | Both are fine faces; both are the default choice of a generator, and both require a CDN or a bundle for no benefit over the system face. Space Grotesk additionally has **no kanji at all**. | `ui-sans-serif` / `system-ui` first (§3.5). Zero font bytes, native on Android, and the JP fallbacks are explicit. |
| Emoji as section markers (📊 Stats, 🎯 Goals) | Emoji render differently per platform, break the type rhythm, and inject a second unrelated colour palette into a two-hue design. | Section headings are `--display` at 600 weight, uppercase eyebrow in `--mono` at ~12px / `0.14em` tracking (the pattern `SPEC.html` already uses for `.kicker`). No icons in headings. Where an icon is genuinely needed it is an inline SVG stroked in `currentColor`. |
| Everything centred | Centred text has no left edge to return to, so nothing scans. It is the layout you get when no hierarchy was decided. | Everything is **left-aligned** (start-aligned) except two things: the kanji on the card face, and the grade buttons. Those two are centred because they are single focal objects, not text to read. |
| `rounded-lg` on every element | Uniform large radius flattens hierarchy — a page, a card, a button and a tag all look like the same kind of object. | **Two radii, from one token** (§3.2): `--radius: 8px` for cards and buttons, `--radius-sm: 4px` for tags, the cloze mask and the focus ring. Copied from Monkeytype's measured `--roundness` / `calc(--roundness / 2)`. |
| Accent bar down the side of a rounded card | Decoration pretending to be information. Also the reason the accent stops meaning anything. | Cards have **no** accent bar, no coloured header strip, no left border. Separation is `--surface` on `--ground` at 1.11:1 plus a `--rule` hairline where one is genuinely needed. |
| Soft drop shadows on static blocks | Implies elevation that is not real. | No shadow on anything that does not move. Shadow is reserved for popovers and sheets. The focus ring is a hard two-ring `box-shadow` (§2.4), which is not elevation. |
| Springy micro-animations, scale-on-tap, staggered fade-ins | Reads as a demo. On the review screen it is actively harmful (§5). | `--t: 125ms`, and **only** `color`, `background-color`, `opacity`, `border-color`. No `transform` transitions anywhere in the app. |
| Six-step grey scales, five accent tints, a full semantic colour set | Tokens invented before use. | Twelve tokens, **two hues**, and `--good` is literally the same value as `--accent` (§1.3). |

---

## 5. The review screen and the reveal

The exercise, from `CLAUDE.md`: look at the kanji, recall whether each mora is high
or low, **say it aloud**, and only then reveal the reading and listen. The reveal is
the interaction. Everything below serves the constraint that the pre-reveal state
must not let him answer by accident.

### 5.1 MEASURED — what the renderer already gives us

Three facts from `src/render/nodes.ts` and `src/render/reveal.ts` that constrain the
design, and one of them solves a hard problem for free:

* `CLOZE_MASK_TEXT = "[…]"` (`nodes.ts` line 148) — **a constant**. Every mask, on
  every card, is the same three characters regardless of what it hides. **Length is
  already not leaked**, at the renderer level, by construction. The design must not
  undo this — so the mask box must be a fixed width and must not size to its answer.
* The cloze is `<span class="hashigo-cloze"><span class="hashigo-cloze-mask">[…]</span><span class="hashigo-cloze-answer" hidden>…</span></span>`,
  with **both children present from the first paint** and reveal being *"a single
  attribute flip with no re-render"* (`nodes.ts` comment at the `cloze` renderer).
  `data-state` is `"hidden"` / `"revealed"` / `"pending"` (`MountState`, line 151).
  So a CSS transition on the mask is possible, but a *layout* animation is not —
  the answer's box already exists.
* `reveal.ts`: `RevealTrigger` is `"cloze" | "audio" | "none"`, and for a cloze side
  *"tapping any of them reveals the whole side"*. ARIA (`role`, `tabindex`,
  `aria-expanded`) is added **only once the cloze is actually interactive**
  (`REVEAL_ATTRIBUTES`, line 153), and *"a masked span is not focusable and does not
  announce itself"* until then.

That last point matters for the answer-leak question: a masked cloze is not in the
accessibility tree as its answer, so the reading is not reachable by a screen reader
or by tab-focus before reveal. Good. **It is still in the DOM, so it is reachable by
view-source and by "select all".** Not worth engineering against — the same
reasoning that settled decision 7 applies (a deliberate gesture is not a leak) —
but it should be written down rather than assumed away.

### 5.2 PROPOSED — the hidden state

A **solid filled block**, not an underline, not a blur, not a dashed outline.

* Fill: `--muted`. In dark that is `#9CA095` on `#191A1B` (**6.54:1**); in light,
  `#585D4E` on `#FFFFFF` (**6.79:1**). A mid-tone bar against the card is
  unmistakably an object, and it reads as *withheld* rather than as *empty*. This
  is the "reuse an existing text token as a fill" move from §2.3 — no new colour
  enters the palette to support the most important state in the app.
* The `[…]` glyphs stay, knocked out in `--surface` (6.79:1 / 6.54:1) — so you see
  a faint ellipsis inside a solid bar. It signals "content, hidden" where a blank
  bar could read as a redaction or a rendering failure.
* Fixed width. Set an explicit `min-width` in `ch` (about `3.5ch`) and
  `padding: 0 0.35em`, so the box is the same size on the 3,477 単語 cards and does
  not hint at whether the reading is 2 morae or 6. **Do not** let it size to the
  answer, and do not use `visibility: hidden` on the answer with the mask absolutely
  positioned over it — that reintroduces length leakage through the box width.
* `--radius-sm` (4px). The spike's provisional `3px` is close; standardise on the
  token.
* No blur filter. A CSS blur over Japanese text is *guessable* — stroke density and
  glyph count survive a blur, and a 2-mora reading blurs differently from a 5-mora
  one. Blur looks like hiding and is not hiding.
* Nothing else on the card changes state. No "tap to reveal" instruction text after
  the first few cards, no pulsing, no chevron. Which raises the affordance question.

### 5.3 PROPOSED — how it says "tappable" without hover

There is no hover on his phone, so the affordance has to be static and structural:

* **The whole side is the tap target**, not just the mask. `reveal.ts` already
  supports this — a gesture anywhere on a cloze side unmasks it. This is the single
  most important one-handed decision: a 17px-tall inline span is roughly a 24px tap
  target, far under Android's 48px, and chasing it with a thumb at night is
  miserable. Make the card face itself the button. The mask is then a *label* for
  what tapping does, and it does not need to be big.
* The mask still gets its own hit area for correctness — `padding: 0.25em 0.35em`
  and `display: inline-block` — but it is never the only way in.
* **`:active` is the only interaction feedback, and it is a colour change.** The
  mask goes to `--accent` fill on `:active` (touch-down). 125ms, `background-color`
  only. No `transform: scale()`, ever — see §4.
* Keyboard focus keeps the two-ring `box-shadow` pattern from §2.4, in `--accent`
  (6.17:1 / 6.04:1) with an inner ring in `--surface` to hold the gap. It appears on
  `:focus-visible` only, so touch never shows a lingering ring.
* One persistent, non-shouting hint at the bottom of the card area, in `--faint`
  `--mono` at ~12px: `TAP TO REVEAL`. It is a fixed part of the screen furniture,
  not an animated coach mark, and it lives outside the card so it never competes
  with the kanji. It can be turned off in settings and never reappear.

### 5.4 PROPOSED — the revealed state

The transition has one job: get out of the way so he can *listen*. Audio fires on
the reveal (`reveal()`), never on `enter()` — that is a settled correctness
requirement, not a design choice.

* **Mask out, answer in, by opacity, 125ms, no movement.** The answer's box already
  exists (§5.1) so nothing reflows; both children can cross-fade in place. Total
  visible change: one bar of `--muted` disappears, text in `--ink` appears where it
  was.
* **Nothing animates while the audio plays.** No waveform, no progress ring, no
  bouncing equaliser. He is comparing his own production to the recording; a moving
  object in peripheral vision competes for exactly the attention that comparison
  needs. A static, plain playback control — `--muted` icon, `--accent` on `:active`
  — and no other motion on screen.
* **Drop the spike's `border-bottom: 2px solid var(--accent)` on the revealed
  cloze.** It was self-labelled provisional and it costs more than it gives: green
  is the accent *and* the "remembered" grade (§1.3), so painting a green rule under
  the answer at the exact moment he is about to grade puts the grade colour on the
  card. If a revealed cloze needs marking at all — and it probably does not, since
  it just went from a grey bar to text — use an `--accent-soft` background tint
  behind the answer text (`--ink` on `--accent-soft` is 14.92:1 / 12.21:1), which is
  quiet and is not the grade.
* The reading is now the most important text on screen: `--ink`, `--display` weight
  400, generous leading, and its furigana follows §3.4.

### 5.5 PROPOSED — reduced motion, and grading

* `@media (prefers-reduced-motion: reduce)` sets `--t: 0ms` and removes the
  cross-fade entirely: mask hidden, answer shown, one frame. Because the whole
  motion system is one token and one property list (§3.2), honouring the preference
  is a two-line block, not an audit. Nothing in the app depends on a transition
  having run — the reveal is an attribute flip either way.
* This is also the honest default for the shadowing exercise. If the cross-fade ever
  competes with listening, the right answer is to delete it, not to tune it.
* **Grading lives in the thumb zone.** Two full-width-half buttons pinned to the
  bottom of the viewport, ≥56px tall, separated by a gap rather than a divider,
  above `env(safe-area-inset-bottom)`. Left = 忘れた (`--alert` fill, `--surface`
  text, 7.56:1 / 5.52:1); right = 覚えた (`--accent` fill, `--surface` text,
  6.17:1 / 6.04:1). Two buttons, because grades are binary (settled decision 2).
  They should be **absent or disabled until the side is revealed** — grading a card
  he has not answered is the one destructive misfire a one-handed thumb can make.

---

## Flags

* **Could not find a `terminal.css`.** It does not exist on `master` and its
  absence is expected, not a search failure — §1.1 shows the refactor commit that
  removed it and the TS constant that replaced it. The deleted file's contents are
  quoted for corroboration.
* **No Monkeytype claim in §2 is inferred; each cites a file and line.** Every
  **Notion** claim is marked OBSERVED — Notion has no public source and I read those
  off the product. Treat them as the weaker half of the argument.
* **`dashboard.html` uses different token names** than `SPEC.html` (`--page`,
  `--ink-muted`, `--border`). §3.1 proposes the rename; it is not done here, since
  this task was write-one-file.
* **`--faint` on `--sunken` (light) is 4.14:1 — the one text pair below AA.**
  Documented as a forbidden combination rather than fixed by moving `--faint`, which
  would collapse the distinction between `--faint` and `--muted`.
* **`spike/viewer/index.html`'s revealed-cloze `border-bottom` is recommended for
  deletion** (§5.4). It was already labelled provisional in that file.
* **Not verified on a real device.** Every ratio here is computed; none of it has
  been looked at on his Android phone at night, which is the only test that settles
  whether `--ground #101112` is restful or whether `--muted #9CA095` is thin at 17px
  ruby size. `PHONE-TEST.md` exists — this belongs in it.
