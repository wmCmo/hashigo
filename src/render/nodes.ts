/**
 * Stage 4 — one renderer per AST node kind, and the contract the other stages
 * extend.
 *
 * WHY A TOTAL MAP RATHER THAN A SWITCH. `NodeRenderers<E>` is
 * `{ [K in Node["kind"]]: … }` — a mapped type over the whole union in
 * `src/template/ast.ts`. Adding a node kind there breaks the compile here until
 * a renderer exists for it, so "zero unrendered node types" is a property tsc
 * enforces rather than a number a test happens to print. The census in
 * `test/render.test.ts` is then a second, runtime check of the same thing over
 * the real 7,716 cards.
 *
 * ── THREE THINGS THE CORPUS DECIDED, ALL OF THEM COUNTER-INTUITIVE ──────────
 *
 * 1. A GENERATOR'S CHILDREN ARE ITS INPUT, NOT ITS OUTPUT, so most generators
 *    render NOTHING VISIBLE until stage 9 fills them. `#### {{<ai>Describe a
 *    word << 単語 >> using emojis only</ai>}}` must show emojis, not the
 *    sentence "Describe a word 引き換え using emojis only" — and the fact that
 *    the cloze wraps the generator proves it, because clozing a prompt is
 *    meaningless. Same for `<translate>` and for `<speech>`, whose child is TTS
 *    input: Polysemy side 2 writes `<< 言葉 >>` and then
 *    `<speech lang="jp"><< 言葉 >></speech>`, so rendering the child would print
 *    the word twice.
 *
 *    `<furigana>` is the exception, and it is the reason "hide the children" is
 *    not a rule: its generated part is only the READING, so the base text is
 *    visible and comes from the children. It renders as `<ruby>base<rt></rt>`
 *    with an empty `<rt>` for stage 9 to fill. `<pinyin>` is treated the same
 *    way (0 uses; named by tools/mochi.py, so it exists as a shape, not a
 *    guess).
 *
 * 2. AUDIO IS CREATED SILENT, WITH NO SOURCE, AND THE RENDERER HAS NO WAY TO
 *    START IT. SPEC: pitch-accent shadowing means he looks at the kanji, recalls
 *    the contour, says it aloud, and only THEN hears the clip. So there is no
 *    `autoplay`, no `loop`, `preload="none"`, and no call to `play()` anywhere in
 *    `src/render/` — grep for it; `test/render.test.ts` does. Playback belongs
 *    to a reveal listener the review UI registers (`ClozeMount.onReveal`), which
 *    is the only place that knows he has produced an answer.
 *
 *    The renderer also never sets `src`. It creates the element and records the
 *    store key; bytes arrive through `src/blobs/url.ts`, whose whole design is
 *    that the scope which mints an object URL is the scope that revokes it. A
 *    renderer that minted URLs would be a renderer that leaks them.
 *
 * 3. AN UNRESOLVABLE WIKI-LINK RENDERS AS TEXT, INCLUDING ITS BRACKETS. 18 of
 *    the 8,744 links point at decks that were never exported. `src/text` renders
 *    a display-less link as the empty string, which is right for a SEARCH INDEX
 *    (an 8-character id matches trigram queries that have nothing to do with the
 *    card) and wrong for a screen, where it would silently delete a word from
 *    the sentence. Here the authored form comes back verbatim — `[[pvtj9W17]]` —
 *    so a broken link looks broken.
 *
 * ── ZACH'S U+200E CONVENTION ────────────────────────────────────────────────
 * `[[引き|10PQotxm]]<U+200E>[[換え|C1p9g1mL]]` is one word written as two linked
 * cards. Every text node is passed through `stripInvisible` from `src/text`
 * (the single definition — there is no second copy of that character list), and
 * a text node that strips to nothing is not appended at all. The two anchors
 * therefore end up as immediately adjacent siblings with no node between them,
 * which is what makes them read as 引き換え. `serialise()` without `pretty`
 * preserves that; `pretty` does not, and says so.
 */

import type { BlobKind } from "../schema/index.js";
import {
  normaliseLanguageTag,
  plainText,
  walk,
  type ElementNode,
  type Node,
  type TableAlign,
} from "../template/index.js";
import { stripInvisible } from "../text/index.js";
import {
  attributeValue,
  cardHref,
  classifyMedia,
  dataSuffix,
  inertElementText,
  interpolationValue,
  sanitiseElement,
  sanitiseUrl,
  type MediaKind,
  type MediaReference,
} from "./sanitise.js";
import type { RenderDocument, RenderElement, RenderText } from "./dom.js";

// ─── the names in the output ──────────────────────────────────────────────────

/**
 * Every class the renderer emits. Exported so stage 6/7 style against a constant
 * rather than a string literal that a rename would silently break.
 */
export const CLASS = {
  card: "hashigo-card",
  side: "hashigo-side",
  cloze: "hashigo-cloze",
  clozeMask: "hashigo-cloze-mask",
  clozeAnswer: "hashigo-cloze-answer",
  rule: "hashigo-rule",
  code: "hashigo-code",
  math: "hashigo-math",
  cardLink: "hashigo-card-link",
  link: "hashigo-link",
  image: "hashigo-image",
  audio: "hashigo-audio",
  video: "hashigo-video",
  file: "hashigo-file",
  generator: "hashigo-generator",
  reading: "hashigo-reading",
  draw: "hashigo-draw",
  input: "hashigo-input",
  section: "hashigo-section",
  missingField: "hashigo-missing-field",
  unknown: "hashigo-unknown",
} as const;

/** Every `data-` attribute the renderer emits. */
export const DATA = {
  side: "data-side",
  position: "data-position",
  empty: "data-empty",
  cloze: "data-cloze",
  clozeIndex: "data-cloze-index",
  state: "data-state",
  marker: "data-marker",
  language: "data-language",
  math: "data-math",
  cardId: "data-card-id",
  resolved: "data-resolved",
  mediaKind: "data-media-kind",
  mediaRef: "data-media-ref",
  mediaKey: "data-media-key",
  generator: "data-generator",
  widget: "data-widget",
  expect: "data-expect",
  field: "data-field",
  reason: "data-reason",
  align: "data-align",
  section: "data-section",
  inverted: "data-inverted",
  lang: "data-lang",
} as const;

/**
 * What a hidden cloze shows. Non-empty so an unstyled render still occupies
 * space; overridable by supplying a custom `cloze` renderer.
 */
export const CLOZE_MASK_TEXT = "[…]";

/** `data-state` on a cloze and on a generator awaiting stage 9. */
export type MountState = "hidden" | "revealed" | "pending";

// ─── mounts: what the renderer hands back ────────────────────────────────────

export interface RenderedSide<E extends RenderElement = RenderElement> {
  /** `Side.index` — the position in the AUTHORED template body. */
  readonly index: number;
  /** Where it sits in the order it is being shown in. */
  readonly position: number;
  readonly element: E;
  /** `isSideEmpty` — 単語's first side is empty whenever `Reading` is false. */
  readonly empty: boolean;
}

export interface ClozeMount<E extends RenderElement = RenderElement> {
  readonly element: E;
  readonly mask: E;
  readonly answer: E;
  /** The `{{n::…}}` index, or null for the unindexed form — the only one used. */
  readonly index: number | null;
  /** Position among all clozes in this render. */
  readonly ordinal: number;
  /** The AUTHORED side index this cloze is on. */
  readonly side: number;
  readonly revealed: boolean;
  reveal(): void;
  conceal(): void;
  /** Fires after the DOM has changed. Returns an unsubscribe. */
  onReveal(listener: (mount: ClozeMount<E>) => void): () => void;
}

export interface MediaMount<E extends RenderElement = RenderElement> {
  /** `<audio>` / `<img>` / `<video>`, or a `<span>` for an unknown extension. */
  readonly element: E;
  readonly kind: MediaKind;
  readonly reference: MediaReference;
  /** The `![alt](…)` text, used as the accessible label. */
  readonly alt: string;
  /** `attachment` = authored `![](…)`; `generator` = a `<speech>`/`<image>` slot. */
  readonly origin: "attachment" | "generator";
  readonly side: number;
  readonly ordinal: number;
}

/**
 * A generation request, in exactly the shape `GenerationRequest` in
 * `src/import/blobs.ts` takes — so stage 9 can pass one straight to
 * `resolveGeneration(db, request, generate)` with no adapter. The test asserts
 * that assignability at typecheck; only the TYPE is imported here, so nothing
 * from `src/import` (which reaches for `node:fs`) enters a browser bundle.
 */
export interface GenerationDescriptor {
  readonly kind: BlobKind;
  /** RAW resolved input text. Normalisation belongs to `generationIdentity`. */
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  /** Everything else the tag carried, minus `lang` and `voice`. */
  readonly options: Readonly<Record<string, string>>;
}

export interface GeneratorMount<E extends RenderElement = RenderElement> {
  /** The container: a `<span>`, or a `<ruby>` for furigana/pinyin. */
  readonly element: E;
  /** The element name as authored: speech, ai, translate, furigana, image, pinyin. */
  readonly name: string;
  /** Null only for `pinyin`, which has no `blobs.kind` to file its output under. */
  readonly request: GenerationDescriptor | null;
  /** Where generated TEXT goes: the `<rt>` for furigana, else the container. */
  readonly output: E | null;
  /** The silent `<audio>` / empty `<img>` for speech and image generators. */
  readonly media: MediaMount<E> | null;
  /**
   * This generator was rendered INSIDE a cloze's answer, so whatever it produces
   * is hidden until that cloze is revealed.
   *
   * **It exists for exactly one decision and it is a safety one.** `furigana`
   * produces the READING, which on the 692 `Reading = true` cards is the answer
   * the exercise asks him to produce — so filling one that is not behind a mask
   * prints the answer on the question side. Measured over the real corpus, both
   * directions: **6,754 furigana mounts, 42 of them outside a cloze, and all 42
   * are on `produce` cards.** So the leak is real and this is the flag that stops
   * it, rather than a rule about templates that would have to be kept in step.
   */
  readonly inCloze: boolean;
  readonly side: number;
  readonly ordinal: number;
}

export interface WidgetMount<E extends RenderElement = RenderElement> {
  readonly element: E;
  readonly name: string;
  /** Sanitised, authored spelling preserved (`brushColor`, not `brushcolor`). */
  readonly attributes: Readonly<Record<string, string>>;
  /**
   * `<input value=…>` is the EXPECTED ANSWER, not a prefill — the 数字 template
   * reads a number aloud on side 1 and reveals the formatted one on side 2. So
   * the box renders empty and the answer arrives here. See the report: this is
   * an inference from one template, and stage 7 owns the checking.
   */
  readonly expected: string | null;
  readonly side: number;
  readonly ordinal: number;
}

export interface LinkMount<E extends RenderElement = RenderElement> {
  readonly element: E;
  /** `card` = a wiki-link into the collection; `external` = a markdown URL. */
  readonly kind: "card" | "external";
  /** The card id, or the sanitised href. */
  readonly target: string;
  readonly href: string;
  readonly side: number;
  readonly ordinal: number;
}

// ─── diagnostics ─────────────────────────────────────────────────────────────

export type RenderDiagnosticKind =
  /** An attribute the element's allowlist does not carry, or an invalid value. */
  | "attribute-dropped"
  /** One `style` declaration outside `STYLE_PROPERTIES`. */
  | "style-dropped"
  /** A URL whose scheme is not allowed; the anchor was dropped, the text kept. */
  | "url-blocked"
  /** A media reference that is not a store key (absolute URL, or a path). */
  | "media-blocked"
  /** `resolveCardLink` returned null; rendered as its authored text. */
  | "card-link-unresolved"
  /** An `element` node whose name is not in `ELEMENTS`; rendered inert. */
  | "element-unknown"
  /** An `unknown` node from the parser; rendered inert. */
  | "node-unknown"
  /** A `<<Field>>` the resolver could not name; rendered as its own text. */
  | "field-unresolved"
  /** A `ResolveWarning` from stage 3, carried through so one list explains a card. */
  | "resolver-warning";

export interface RenderDiagnostic {
  readonly kind: RenderDiagnosticKind;
  readonly detail: string;
  /** The authored side index, or -1 for a card-level diagnostic. */
  readonly side: number;
}

// ─── options ─────────────────────────────────────────────────────────────────

/** Where a wiki-link points. Return null from `resolveCardLink` for "no such card". */
export interface CardLinkTarget {
  /** Defaults to `#/card/<encoded id>`. */
  readonly href?: string;
  /** Display text for `[[id]]` and `[[|id]]`, which carry none of their own. */
  readonly name?: string | null;
}

/**
 * Called once per mount, immediately after the element has been built and
 * appended. Synchronous: the DOM is not attached to a document yet, so a hook
 * must not measure layout. This is where interaction is attached — the renderer
 * itself adds no listeners, because a listener implies a policy and every policy
 * here (what a tap means, when audio plays, what grading does) is stage 7's.
 */
export interface RenderHooks<E extends RenderElement = RenderElement> {
  side?(side: RenderedSide<E>): void;
  cloze?(mount: ClozeMount<E>): void;
  media?(mount: MediaMount<E>): void;
  generation?(mount: GeneratorMount<E>): void;
  widget?(mount: WidgetMount<E>): void;
  link?(mount: LinkMount<E>): void;
}

export interface RenderSettings<E extends RenderElement = RenderElement> {
  readonly document: RenderDocument<E>;
  /**
   * Resolve a wiki-link target. Omit it and every link renders as an anchor to
   * `#/card/<id>`, which is what the corpus census does — existence is a
   * database question and this module does not open one.
   */
  readonly resolveCardLink?: (id: string) => CardLinkTarget | null;
  /** Replace individual node renderers. Merged over the defaults. */
  readonly renderers?: Partial<NodeRenderers<E>>;
  readonly hooks?: RenderHooks<E>;
}

// ─── the context a renderer is given ─────────────────────────────────────────

/**
 * What a node renderer may do. Implemented in `./index.ts`.
 *
 * Everything that writes to the DOM goes through here, which is what keeps the
 * sanitiser honest: there is no `innerHTML`, and `text()` is the only path from
 * a string to a character on screen.
 */
export interface RenderContext<E extends RenderElement = RenderElement> {
  readonly settings: RenderSettings<E>;
  /** The AUTHORED index of the side being rendered. */
  readonly side: number;
  /**
   * Mutable render frame, the one thing a renderer may read about its
   * surroundings. `headerCell` promotes a `tableCell` to `<th>`, `cellAlign`
   * carries the column alignment down. The alternative was for the table
   * renderer to reach into the child it had just appended, and the port
   * deliberately makes that impossible.
   */
  readonly frame: { headerCell: boolean; cellAlign: TableAlign };

  element(tag: string, className?: string): E;
  text(value: string): RenderText;
  /** Verbatim text: no invisible-mark stripping. Code spans and math only. */
  verbatim(value: string): RenderText;
  /** Append text, stripped; a value that strips to nothing appends nothing. */
  appendText(parent: E, value: string): void;
  attribute(parent: E, name: string, value: string): void;
  /** Render one node into `parent`, counting it. */
  node(parent: E, node: Node): void;
  /** Render many. */
  nodes(parent: E, nodes: readonly Node[]): void;

  /**
   * Render `run()` with everything it mounts marked `inCloze`.
   *
   * The cloze renderer builds its answer subtree BEFORE it calls `mountCloze`, so
   * "was this generator inside a cloze" cannot be answered afterwards by looking
   * at the mounts — the cloze does not exist yet when its children are made. A
   * depth counter around the children is the only place the question has an
   * answer. Nested clozes are counted, not toggled, so an inner one leaving does
   * not un-mask the outer.
   */
  withinCloze<T>(run: () => T): T;
  mountCloze(parts: { element: E; mask: E; answer: E; index: number | null }): ClozeMount<E>;
  mountMedia(parts: {
    element: E;
    kind: MediaKind;
    reference: MediaReference;
    alt: string;
    origin: "attachment" | "generator";
  }): MediaMount<E>;
  mountGenerator(parts: {
    element: E;
    name: string;
    request: GenerationDescriptor | null;
    output: E | null;
    media: MediaMount<E> | null;
  }): GeneratorMount<E>;
  mountWidget(parts: {
    element: E;
    name: string;
    attributes: Readonly<Record<string, string>>;
    expected: string | null;
  }): WidgetMount<E>;
  mountLink(parts: { element: E; kind: "card" | "external"; target: string; href: string }): LinkMount<E>;

  diagnose(kind: RenderDiagnosticKind, detail: string): void;
  /** Bump a census key. Node kinds are counted by `node()`; this is for extras. */
  count(key: string): void;
}

// ─── the registry ────────────────────────────────────────────────────────────

export type NodeRenderer<K extends Node["kind"], E extends RenderElement = RenderElement> = (
  node: Extract<Node, { kind: K }>,
  parent: E,
  context: RenderContext<E>,
) => void;

/** One renderer per node kind. Total by construction. */
export type NodeRenderers<E extends RenderElement = RenderElement> = {
  readonly [K in Node["kind"]]: NodeRenderer<K, E>;
};

// ─── generators ──────────────────────────────────────────────────────────────

/**
 * Element name -> `blobs.kind`, so a generator's output is filed where stage 9
 * and `lookupGeneration` will look for it. `pinyin` has no row in `BLOB_KINDS`
 * and therefore no request; it still renders its base text.
 */
const GENERATOR_KIND: Readonly<Record<string, BlobKind>> = {
  speech: "speech",
  ai: "ai",
  translate: "translate",
  furigana: "furigana",
  image: "image",
};

/** Generators whose output is ruby annotation over visible base text. */
const RUBY_GENERATORS: ReadonlySet<string> = new Set(["furigana", "pinyin"]);

function generationDescriptor(
  node: ElementNode,
  attributes: readonly { readonly name: string; readonly value: string }[],
): GenerationDescriptor | null {
  const kind = GENERATOR_KIND[node.name];
  if (kind === undefined) return null;
  let lang: string | null = null;
  let voice: string | null = null;
  const options: Record<string, string> = {};
  for (const { name, value } of attributes) {
    const lower = name.toLowerCase();
    if (lower === "lang") lang = normaliseLanguageTag(value) || null;
    else if (lower === "voice") voice = value === "" ? null : value;
    else options[lower] = value;
  }
  return { kind, text: plainText(node.children), lang, voice, options };
}

// ─── media elements ──────────────────────────────────────────────────────────

const MEDIA_TAG: Readonly<Record<MediaKind, string>> = {
  audio: "audio",
  image: "img",
  video: "video",
  file: "span",
};

const MEDIA_CLASS: Readonly<Record<MediaKind, string>> = {
  audio: CLASS.audio,
  image: CLASS.image,
  video: CLASS.video,
  file: CLASS.file,
};

/**
 * Build a media element. NO `src`, NO `autoplay`, NO `loop`, `preload="none"`.
 *
 * `preload="none"` is not only about the shadowing rule — it is also the only
 * setting that is honest here, because there is nothing to preload until a
 * caller attaches a lease. And an `<img>` with no `src` makes no request and
 * shows no broken-image glyph, which is why the missing source is safe to render.
 */
/**
 * The reference a generator's media slot starts with: the right KIND, and no
 * source at all. A `<speech>` tag names no file — its bytes are addressed by the
 * generation identity, which stage 9 resolves — so `key` is null and stays null
 * until a caller attaches a lease.
 */
function pendingReference(kind: MediaKind): MediaReference {
  return { ref: "", key: null, kind, extension: "", refused: null };
}

function mediaElement<E extends RenderElement>(
  context: RenderContext<E>,
  kind: MediaKind,
  reference: MediaReference,
  alt: string,
): E {
  const element = context.element(MEDIA_TAG[kind], MEDIA_CLASS[kind]);
  context.attribute(element, DATA.mediaKind, kind);
  if (reference.ref !== "") context.attribute(element, DATA.mediaRef, reference.ref);
  if (reference.key !== null) context.attribute(element, DATA.mediaKey, reference.key);
  if (kind === "audio" || kind === "video") {
    context.attribute(element, "controls", "");
    context.attribute(element, "preload", "none");
  }
  if (kind === "image") context.attribute(element, "alt", alt);
  else if (alt !== "") context.attribute(element, "aria-label", alt);
  return element;
}

// ─── the default renderers ───────────────────────────────────────────────────

/**
 * A fresh registry. A function rather than a `const` because the registry is
 * generic in the element type, and a value cannot be.
 */
export function defaultRenderers<E extends RenderElement>(): NodeRenderers<E> {
  return {
    // ── blocks ──────────────────────────────────────────────────────────────
    paragraph(node, parent, context) {
      const element = context.element("p");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    heading(node, parent, context) {
      const element = context.element(`h${node.level}`);
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    blockquote(node, parent, context) {
      const element = context.element("blockquote");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    list(node, parent, context) {
      const element = context.element(node.ordered ? "ol" : "ul");
      // 21 of the corpus's ordered lists start at something other than 1,
      // because a plain line interrupted the list and the numbering carried on.
      if (node.ordered && node.start !== 1) {
        context.attribute(element, "start", String(node.start));
      }
      context.nodes(element, node.items);
      parent.appendChild(element);
    },

    listItem(node, parent, context) {
      const element = context.element("li");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    hrule(node, parent, context) {
      const element = context.element("hr", CLASS.rule);
      // `___` is a rule inside a side; `---` only ever reaches here from a field
      // value (card EPp9rse6). Keeping the marker keeps the distinction that
      // parser trap 1 exists to preserve.
      context.attribute(element, DATA.marker, node.marker);
      parent.appendChild(element);
    },

    codeBlock(node, parent, context) {
      const pre = context.element("pre", CLASS.code);
      const code = context.element("code");
      if (node.language !== null && node.language !== "") {
        context.attribute(code, DATA.language, node.language);
      }
      code.appendChild(context.verbatim(node.text));
      pre.appendChild(code);
      parent.appendChild(pre);
    },

    table(node, parent, context) {
      const table = context.element("table");
      const thead = context.element("thead");
      const headRow = context.element("tr");
      context.frame.headerCell = true;
      node.header.forEach((cell, column) => {
        context.frame.cellAlign = node.align[column] ?? null;
        context.node(headRow, cell);
      });
      context.frame.headerCell = false;
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = context.element("tbody");
      for (const row of node.rows) {
        const tr = context.element("tr");
        row.forEach((cell, column) => {
          context.frame.cellAlign = node.align[column] ?? null;
          context.node(tr, cell);
        });
        tbody.appendChild(tr);
      }
      context.frame.cellAlign = null;
      table.appendChild(tbody);
      parent.appendChild(table);
    },

    tableCell(node, parent, context) {
      const element = context.element(context.frame.headerCell ? "th" : "td");
      // `data-align` rather than an inline `style`: the only inline style this
      // renderer ever writes is one that came back out of `sanitiseStyle`.
      if (context.frame.cellAlign !== null) {
        context.attribute(element, DATA.align, context.frame.cellAlign);
      }
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    /**
     * `<<#Field>>…<</Field>>`. Never present in a RESOLVED card — `resolveCard`
     * gates sections textually, before parsing — so this renderer exists for the
     * template goldens and for anything that renders an unresolved template
     * body, such as the editor's preview. Rendered as a container rather than
     * dropped, because a template body with its sections deleted is not the
     * template.
     */
    section(node, parent, context) {
      const element = context.element("div", CLASS.section);
      context.attribute(element, DATA.section, node.name);
      if (node.inverted) context.attribute(element, DATA.inverted, "");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    // ── inlines ─────────────────────────────────────────────────────────────
    /**
     * A text node, minus its invisible marks.
     *
     * A node that strips to NOTHING is counted rather than appended, because the
     * census has to balance: 2,635 of the 59,605 text nodes the corpus's resolved
     * cards produce append no DOM at all, almost all of them the U+200E marks
     * Zach typed between adjacent links. An unexplained gap between "parsed" and
     * "rendered" is exactly the shape of a silent bug.
     */
    text(node, parent, context) {
      if (node.text === "") {
        context.count("text:empty");
        return;
      }
      if (stripInvisible(node.text) === "") {
        context.count("text:invisible");
        return;
      }
      context.appendText(parent, node.text);
    },

    lineBreak(_node, parent, context) {
      parent.appendChild(context.element("br"));
    },

    strong(node, parent, context) {
      const element = context.element("strong");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    emphasis(node, parent, context) {
      const element = context.element("em");
      context.nodes(element, node.children);
      parent.appendChild(element);
    },

    code(node, parent, context) {
      const element = context.element("code");
      element.appendChild(context.verbatim(node.text));
      parent.appendChild(element);
    },

    /**
     * LaTeX, kept verbatim in a marked span. No typesetter: KaTeX is 300 kB and
     * the corpus contains ONE formula, inside a cloze. A caller that wants it
     * typeset replaces this renderer — the extension point exists precisely so
     * that decision does not have to be made here.
     */
    math(node, parent, context) {
      const element = context.element("span", CLASS.math);
      context.attribute(element, DATA.math, node.display ? "display" : "inline");
      element.appendChild(context.verbatim(node.text));
      parent.appendChild(element);
    },

    wikiLink(node, parent, context) {
      const resolve = context.settings.resolveCardLink;
      const target = resolve === undefined ? {} : resolve(node.target);
      if (target === null) {
        // Unresolvable: the authored form, brackets and all. Never nothing.
        context.diagnose("card-link-unresolved", node.target);
        context.appendText(parent, wikiLinkSource(node.display, node.target));
        context.count("wikiLink:text");
        return;
      }
      const element = context.element("a", CLASS.cardLink);
      const href = target.href ?? cardHref(node.target);
      context.attribute(element, "href", href);
      context.attribute(element, DATA.cardId, node.target);
      const authored = node.display !== null && node.display !== "" ? node.display : null;
      const display = authored ?? target.name ?? "";
      // A resolvable link with no display text and no name would render as an
      // empty anchor — invisible and untappable — so fall back to the id.
      context.appendText(element, display === "" ? node.target : display);
      parent.appendChild(element);
      context.mountLink({ element, kind: "card", target: node.target, href });
    },

    /**
     * `[text](url)`.
     *
     * Rendered plainly, in place, on whatever side it was authored on. Drafts
     * 1–7 wanted the Jisho link on 漢字's side 4 deferred in reverse mode
     * because its URL contains the answer; Zach overruled that on 2026-08-20
     * (there is no hover on a phone, a long-press is deliberate, and he does not
     * check URLs before answering). There is deliberately NO direction-dependent
     * machinery here and no defanged href — only the scheme allowlist, which is
     * a different question.
     */
    link(node, parent, context) {
      const raw = interpolationValue(node.href);
      const { href, reason } = sanitiseUrl(raw);
      if (href === null) {
        context.diagnose("url-blocked", `${reason ?? "refused"}: ${raw}`);
        context.nodes(parent, node.children);
        context.count("link:text");
        return;
      }
      const element = context.element("a", CLASS.link);
      context.attribute(element, "href", href);
      context.attribute(element, "rel", "noopener noreferrer");
      context.attribute(element, "target", "_blank");
      context.nodes(element, node.children);
      parent.appendChild(element);
      context.mountLink({ element, kind: "external", target: href, href });
    },

    /**
     * `![alt](src)` — Mochi's only attachment syntax, used for images AND audio.
     * The extension picks the element; see `classifyMedia`.
     */
    image(node, parent, context) {
      const reference = classifyMedia(interpolationValue(node.src));
      const alt = attributeValue(stripInvisible(node.alt));
      if (reference.refused !== null) {
        // Not a store key. Nothing is fetched — an absolute URL would be a
        // network request from card content, which an offline-first app must not
        // make — so the alt text stands in and says what was there.
        context.diagnose("media-blocked", `${reference.refused}: ${reference.ref}`);
        context.appendText(parent, alt === "" ? reference.ref : alt);
        context.count("image:text");
        return;
      }
      const element = mediaElement(context, reference.kind, reference, alt);
      parent.appendChild(element);
      context.mountMedia({
        element,
        kind: reference.kind,
        reference,
        alt,
        origin: "attachment",
      });
    },

    /**
     * `{{…}}` — hidden until the review UI reveals it.
     *
     * Two children, both present from the first paint: a mask that shows, and an
     * answer that is `hidden`. Building both up front is what makes reveal a
     * single attribute flip with no re-render, and it is why the answer's DOM
     * exists (and can be measured) before it is shown.
     */
    cloze(node, parent, context) {
      const element = context.element("span", CLASS.cloze);
      const mask = context.element("span", CLASS.clozeMask);
      mask.appendChild(context.text(CLOZE_MASK_TEXT));
      const answer = context.element("span", CLASS.clozeAnswer);
      // Everything mounted in here is behind the mask, and `furigana` needs to
      // know: its output is the READING, which on a `Reading = true` card is the
      // answer. See `GeneratorMount.inCloze`.
      context.withinCloze(() => {
        context.nodes(answer, node.children);
      });
      element.appendChild(mask);
      element.appendChild(answer);
      parent.appendChild(element);
      context.mountCloze({ element, mask, answer, index: node.index });
    },

    element(node, parent, context) {
      renderElementNode(node, parent, context);
    },

    /**
     * An unresolved `<<Field>>`. The resolver leaves the reference standing
     * rather than deleting it, so a typo the author can see beats text that
     * silently vanishes; this renders exactly that.
     */
    field(node, parent, context) {
      context.diagnose("field-unresolved", node.name);
      const element = context.element("span", CLASS.missingField);
      context.attribute(element, DATA.field, node.name);
      element.appendChild(context.text(`<<${node.name}>>`));
      parent.appendChild(element);
    },

    /**
     * Something the parser could not name. Zero of these over the whole corpus,
     * and the renderer still has to have an answer: the source text, verbatim, in
     * a marked span. Nothing authored is ever dropped.
     */
    unknown(node, parent, context) {
      context.diagnose("node-unknown", `${node.reason}: ${node.text}`);
      const element = context.element("span", CLASS.unknown);
      context.attribute(element, DATA.reason, node.reason);
      element.appendChild(context.verbatim(node.text));
      parent.appendChild(element);
    },
  };
}

/** `[[display|id]]`, `[[|id]]` or `[[id]]`, reconstructed exactly. */
function wikiLinkSource(display: string | null, target: string): string {
  return display === null ? `[[${target}]]` : `[[${display}|${target}]]`;
}

// ─── elements ────────────────────────────────────────────────────────────────

function renderElementNode<E extends RenderElement>(
  node: ElementNode,
  parent: E,
  context: RenderContext<E>,
): void {
  const sanitised = sanitiseElement(node);
  for (const dropped of sanitised.dropped) {
    context.diagnose("attribute-dropped", `${node.name}/${dropped.name}: ${dropped.reason}`);
  }
  for (const declaration of sanitised.droppedStyle) {
    context.diagnose("style-dropped", `${node.name}: ${declaration}`);
  }

  if (sanitised.role === null) {
    // Rule 1: an unknown tag becomes visible text, never an element.
    context.diagnose("element-unknown", node.name);
    context.appendText(parent, inertElementText(node));
    if (!node.selfClosing) context.nodes(parent, node.children);
    context.count("element:inert");
    return;
  }

  context.count(`element:${node.name}`);
  if (sanitised.role === "generator") {
    renderGenerator(node, parent, context, sanitised.attributes);
    return;
  }
  if (sanitised.role === "widget") {
    renderWidget(node, parent, context, sanitised.attributes);
    return;
  }
  renderMarkup(node, parent, context, sanitised.attributes);
}

function renderGenerator<E extends RenderElement>(
  node: ElementNode,
  parent: E,
  context: RenderContext<E>,
  attributes: readonly { readonly name: string; readonly value: string }[],
): void {
  const request = generationDescriptor(node, attributes);
  const ruby = RUBY_GENERATORS.has(node.name);
  const element = context.element(ruby ? "ruby" : "span", `${CLASS.generator} hashigo-${node.name}`);
  context.attribute(element, DATA.generator, node.name);
  context.attribute(element, DATA.state, "pending" satisfies MountState);
  if (request?.lang != null) context.attribute(element, DATA.lang, request.lang);

  let output: E | null = null;
  let media: MediaMount<E> | null = null;

  if (ruby) {
    // The base text is authored and visible; only the reading is generated.
    context.nodes(element, node.children);
    output = context.element("rt", CLASS.reading);
    element.appendChild(output);
  } else if (node.name === "speech" || node.name === "image") {
    const kind: MediaKind = node.name === "speech" ? "audio" : "image";
    const label = plainText(node.children);
    const reference = pendingReference(kind);
    const slot = mediaElement(context, kind, reference, label);
    element.appendChild(slot);
    media = context.mountMedia({ element: slot, kind, reference, alt: label, origin: "generator" });
  } else {
    // ai / translate / dictionary: the children are the PROMPT. Nothing visible
    // until stage 9 writes the output into this element.
    output = element;
  }

  if (!ruby) {
    // Every generator except the ruby pair hides its children, because they are
    // the generation's INPUT. They are still COUNTED, node by node, under
    // `hidden:<kind>`: without this the corpus census shows 5 code spans and 3
    // wiki-links parsed and never rendered, with nothing to say why.
    walk(node.children, (child) => context.count(`hidden:${child.kind}`));
  }

  parent.appendChild(element);
  context.mountGenerator({ element, name: node.name, request, output, media });
}

function renderWidget<E extends RenderElement>(
  node: ElementNode,
  parent: E,
  context: RenderContext<E>,
  attributes: readonly { readonly name: string; readonly value: string }[],
): void {
  const kept: Record<string, string> = {};
  for (const { name, value } of attributes) kept[name] = value;

  if (node.name === "input") {
    const element = context.element("input", CLASS.input);
    context.attribute(element, DATA.widget, "input");
    context.attribute(element, "type", "text");
    context.attribute(element, "autocomplete", "off");
    context.attribute(element, "autocapitalize", "off");
    context.attribute(element, "spellcheck", "false");
    const expected = kept["value"] ?? null;
    const placeholder = kept["placeholder"];
    if (placeholder !== undefined) context.attribute(element, "placeholder", placeholder);
    if (expected !== null) {
      context.attribute(element, DATA.expect, expected);
      // All 90 uses in the corpus expect digits; a numeric keypad on a phone is
      // the difference between a two-tap answer and a four-tap one.
      if (expected !== "" && /^[0-9]+$/.test(expected)) {
        context.attribute(element, "inputmode", "numeric");
      }
    }
    parent.appendChild(element);
    context.mountWidget({ element, name: "input", attributes: kept, expected });
    return;
  }

  // `draw`, and anything else the allowlist calls a widget.
  const element =
    node.name === "draw"
      ? context.element("canvas", CLASS.draw)
      : context.element("span", `hashigo-${node.name}`);
  context.attribute(element, DATA.widget, node.name);
  for (const [name, value] of Object.entries(kept)) {
    context.attribute(element, `data-${dataSuffix(name)}`, value);
  }
  // No width/height/style: a canvas backing store has to be sized to
  // devicePixelRatio at mount time or the strokes blur, and only the widget code
  // knows the device. The authored `height="400px"` travels as data.
  parent.appendChild(element);
  context.mountWidget({ element, name: node.name, attributes: kept, expected: null });
}

function renderMarkup<E extends RenderElement>(
  node: ElementNode,
  parent: E,
  context: RenderContext<E>,
  attributes: readonly { readonly name: string; readonly value: string }[],
): void {
  const element = context.element(node.name);
  for (const { name, value } of attributes) context.attribute(element, name, value);
  if (!node.selfClosing) context.nodes(element, node.children);
  parent.appendChild(element);
}

