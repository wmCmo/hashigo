# `src/render` — stage 4, the renderer

Resolved sides in, DOM out. Nothing else: no grading, no queue, no blob fetching,
no playback. Those are stages 6, 7 and 9, and the mounts below are the seam.

```ts
import { resolveCard } from "../template/index.js";
import { browserDocument, renderResolvedCard } from "../render/index.js";

const result = renderResolvedCard(resolveCard(card, template), {
  document: browserDocument(window.document),
});
container.appendChild(result.root);
```

Under Node, swap `browserDocument(document)` for `memoryDocument()` and read the
tree back with `serialise(result.root)`.

## The four rules this module is shaped by

1. **Audio never starts by itself.** The corpus's audio exists for 高低アクセント
   shadowing: Zach reads the kanji, recalls whether each mora is high or low, says
   it aloud, and only then hears the clip. So media elements are created with
   `controls preload="none"`, **no `src`, no `autoplay`, no `loop`**. Playback
   belongs in a `ClozeMount.onReveal` listener that the review UI registers,
   because that is the only place that knows he has produced an answer.

   **CORRECTED 2026-08-22.** This paragraph used to say "there is no call to
   `play()` anywhere in this directory", which is false and dangerously so:
   `audio.ts:399` is `result = element.play()`. The rule is not that the call does
   not exist — it has to exist somewhere — it is **where the call is reachable
   from**. `index.ts:19` states it correctly, and that is the wording to trust:
   playback is reachable from exactly two entry points, `reveal()` and `play()`,
   and `reveal.ts`'s `enter()` does nothing but record that a side is on screen.
   Read as written, the old sentence invites a future reader to "fix" `audio.ts`
   by adding the call they were told was missing, or to conclude the invariant
   lives somewhere it does not.
2. **No string ever becomes markup.** `createTextNode` and `setAttribute` are the
   only two ways authored data reaches the DOM — see `dom.ts` for why a five-call
   port instead of an HTML string, and `sanitise.ts` for the policy on top.
3. **Nothing authored disappears.** An unknown element, an unknown node, an
   unresolved `<<Field>>` and an unresolvable `[[link]]` each render as visible
   text, and each also lands in `result.diagnostics`.
4. **Side order is the caller's.** `orderSides` in `src/template/resolve.ts` owns
   the reverse permutation. This module renders the array it is handed, in order,
   and records both the authored index (`data-side`) and the presentation position
   (`data-position`) on each `<section>`.

## Files

| file | what it owns |
|---|---|
| `dom.ts` | the five-operation DOM port, the real-`Document` adapter, `MemoryDocument`, and `serialise` |
| `sanitise.ts` | the sanitiser policy: elements, attributes, `style`, URL schemes, media references |
| `nodes.ts` | one renderer per AST node kind, the mount types, `CLASS`/`DATA` |
| `index.ts` | the driver, `RenderResult`, and the barrel |

## The contract

### Entry points

```ts
renderSides(sides: readonly Side[], settings: RenderSettings<E>): RenderResult<E>
renderResolvedCard(card: RenderedCard, settings: RenderSettings<E>): RenderResult<E>
```

`renderResolvedCard` takes stage 3's output directly and folds its
`ResolveWarning`s into `diagnostics`, so one list explains a card.

```ts
interface RenderSettings<E extends RenderElement = RenderElement> {
  readonly document: RenderDocument<E>;              // required
  readonly resolveCardLink?: (id: string) => CardLinkTarget | null;
  readonly renderers?: Partial<NodeRenderers<E>>;
  readonly hooks?: RenderHooks<E>;
}
```

`resolveCardLink` returning `null` means "no such card": the link renders as its
authored text, brackets included. Returning `{ href?, name? }` overrides the
default `#/card/<encoded id>` and supplies display text for the `[[id]]` and
`[[|id]]` forms.

### What comes back

```ts
interface RenderResult<E> {
  readonly root: E;                                  // <div class="hashigo-card">
  readonly sides: readonly RenderedSide<E>[];         // { index, position, element, empty }
  readonly clozes: readonly ClozeMount<E>[];
  readonly media: readonly MediaMount<E>[];
  readonly generations: readonly GeneratorMount<E>[];
  readonly widgets: readonly WidgetMount<E>[];
  readonly links: readonly LinkMount<E>[];
  readonly census: ReadonlyMap<string, number>;
  readonly diagnostics: readonly RenderDiagnostic[];
  revealAll(): void;
  concealAll(): void;
  onReveal(listener: (mount: ClozeMount<E>) => void): () => void;
}
```

### Contributing a node renderer

```ts
const result = renderSides(sides, {
  document,
  renderers: {
    math(node, parent, context) {              // node is narrowed to MathNode
      const element = context.element("math-typeset");
      context.appendText(element, node.text);
      parent.appendChild(element);
    },
  },
});
```

`NodeRenderers<E>` is a mapped type over `Node["kind"]`, so it is total by
construction: adding a node kind to `src/template/ast.ts` fails the compile here
until a renderer exists. Overrides are merged over the defaults, one key at a
time. Inside a renderer, use the `RenderContext`: `element`, `text`, `verbatim`,
`appendText`, `attribute`, `node`, `nodes`, the `mount*` factories, `diagnose`
and `count`. Do not touch `parent` except through `appendChild`.

### Hooking an interaction

The renderer attaches **no listeners** — a listener implies a policy, and every
policy here is stage 7's. Two ways in:

```ts
// at mount time, as the DOM is built
renderSides(sides, { document, hooks: {
  cloze: (mount) => mount.element.addEventListener("click", () => mount.reveal()),
  media: (mount) => attachMedia(mount.element, scope.claim(payload)),
}});

// or afterwards, over the collections
result.onReveal(() => {
  for (const mount of result.media) if (mount.kind === "audio") mount.element.play();
});
```

That second snippet is the pitch-accent drill: **the review UI plays the clip on
reveal. The renderer will not.**

### Blobs and generations

* `MediaMount.reference.key` is exactly `blob_refs.ref_key` — the bare filename,
  with Mochi's `@media/` prefix already stripped. Resolve it to bytes yourself and
  attach through `src/blobs/url.ts`'s `BlobUrlScope` / `attachMedia`; the renderer
  never mints an object URL, because the scope that mints one must be the scope
  that revokes it.
* `GeneratorMount.request` is assignable to `GenerationRequest` in
  `src/import/blobs.ts`, so stage 9 can pass it straight to `resolveGeneration`.
  `request.text` is RAW — `generationIdentity` normalises it, and normalises `lang`
  again with the import-side rules (which map `en` → `en-US`, where the
  template-side normaliser leaves `en` alone). Do not pre-normalise.
* `GeneratorMount.output` is where generated TEXT goes: the `<rt>` for
  furigana/pinyin, the container itself for ai/translate/dictionary.
  `GeneratorMount.media` is the silent `<audio>`/`<img>` for speech/image.
* **A generator's children are its INPUT.** `<ai>Describe …</ai>` renders empty
  with `data-state="pending"`; rendering the prompt would print the prompt on the
  card. `<furigana>` is the exception: its base text is authored and visible, and
  only the reading is generated.

### What the sanitiser will and will not let through

| | allowed | otherwise |
|---|---|---|
| elements | exactly `ELEMENTS` in `src/template/ast.ts` — speech, ai, translate, furigana, image, pinyin, draw, input, span, b, i, u, br | rendered as inert visible text, `diagnostics: element-unknown` |
| attributes | exactly `ELEMENTS[name].attributes` | dropped, `attribute-dropped` |
| `on*`, `src`, `href`, `srcdoc`, `formaction` | never, on any element | dropped |
| `style` | `color`, `background-color`, `font-weight`, `font-style`, `text-decoration`; no parens, `url`, `expression` or comments in the value | that declaration dropped, `style-dropped` |
| URL schemes | `http`, `https`, `mailto`, after C0/tab/LF/CR are stripped the way a browser strips them | anchor dropped, link text kept, `url-blocked` |
| relative and protocol-relative URLs | no — this is a hash-routed offline app | as above |
| media references | `@media/<file>` and bare `<file>` | absolute URLs and paths refused, alt text rendered, `media-blocked` |
| card-link hrefs | minted here as `#/card/<encodeURIComponent(id)>` | never taken from content |
| `innerHTML`, `<script>`, `<iframe>`, event handlers | not representable — there is no string-to-markup path | — |

Wiki-links render **plainly, in place, on whatever side they were authored on**.
There is no direction-dependent deferral and no defanged `href`; drafts 1–7 asked
for both and Zach overruled it on 2026-08-20.

### The output shapes

```
<div class="hashigo-card">
  <section class="hashigo-side" data-side="0" data-position="0" [data-empty=""]>
    <p> <h1..h6> <blockquote> <ol start> <ul> <li> <hr class="hashigo-rule" data-marker="___|---">
    <pre class="hashigo-code"><code [data-language]>
    <table><thead><tr><th [data-align]> … <tbody><tr><td [data-align]>
    <strong> <em> <code> <br>
    <span class="hashigo-math" data-math="inline|display">
    <a class="hashigo-card-link" href="#/card/ID" data-card-id="ID">
    <a class="hashigo-link" href rel="noopener noreferrer" target="_blank">
    <audio|img|video class="hashigo-audio|image|video" data-media-kind data-media-ref
                     data-media-key controls preload="none">      <!-- never src -->
    <span class="hashigo-cloze" data-cloze="N" [data-cloze-index] data-state="hidden|revealed">
      <span class="hashigo-cloze-mask">[…]</span>
      <span class="hashigo-cloze-answer" hidden="">…</span>
    </span>
    <span class="hashigo-generator hashigo-NAME" data-generator data-state="pending" [data-lang]>
    <ruby class="hashigo-generator hashigo-furigana" …>base<rt class="hashigo-reading"></rt></ruby>
    <canvas class="hashigo-draw" data-widget="draw" data-height data-brush-color data-brush-radius>
    <input class="hashigo-input" data-widget="input" type="text" data-expect [inputmode]>
    <div class="hashigo-section" data-section [data-inverted]>       <!-- unresolved templates only -->
    <span class="hashigo-missing-field" data-field>
    <span class="hashigo-unknown" data-reason>
```

Every class and `data-` name is exported as `CLASS` and `DATA`. Style against
those, not against literals.

Two things the renderer deliberately leaves to the stylesheet:

* **`<canvas>` carries no `width`/`height`.** A drawing surface has to be sized to
  `devicePixelRatio` at mount time or the strokes blur, and only the widget code
  knows the device. `data-height="400px"` is the authored request — 漢字 writes that
  on all 1,662 cards. It is not the DEFAULT: `DRAW_DEFAULTS.height` is `300px`, used
  only when nothing is authored. STAGE4.md ORPHAN 3 called these "two numbers for one
  thing"; they are two numbers for two things, and saying which is which is the fix.
* **Adjacent card links are DOM-adjacent, with no node between them** — that is
  what makes `[[引き|…]]<U+200E>[[換え|…]]` read as 引き換え, measured at a 0.000 px
  gap in Chrome. Whether a compound may break across lines is a
  `word-break`/`line-break` decision, and it belongs in the stylesheet.
