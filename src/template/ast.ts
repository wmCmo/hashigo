/**
 * Stage 3 — the AST the two syntax surfaces parse into, the element taxonomy,
 * the sanitiser policy SPEC asks for, and the walkers the tests count with.
 *
 * One node union serves both surfaces. `section` and `field` can only be
 * produced by `parseTemplate` (surface 2, template bodies); everything else can
 * appear on either. Sharing the union means the resolver's output type is the
 * same `Side[]` whether the sides came from a template body or from a
 * template-less card's own `content`, which is what lets the renderer have one
 * code path.
 *
 * NO SOURCE OFFSETS. Nodes carry no positions. The renderer (stage 4) does not
 * need them and the editor (stage 10) re-parses on every keystroke anyway;
 * carrying them would double the size of every golden file for nothing.
 *
 * WHAT THE CORPUS FORCED (every number below measured over the three exports,
 * 7,716 cards and 11 template rows; the census in test/template.test.ts
 * re-derives all of them from the AST)
 *
 *   * A single newline is a LINE BREAK, not paragraph-internal whitespace.
 *     7,670 of 7,716 cards contain no blank line at all, and the dominant card
 *     shape is one fact per line (`路線 / [[路|..]][[線|..]] / 1. route… `).
 *     Collapsing single newlines the way CommonMark does would run the entire
 *     corpus together into unreadable prose.
 *   * `#` REQUIRES A FOLLOWING SPACE to be a heading. 37 lines start with `#`
 *     but only 15 are headings; the other 22 are `#DaysOfMonth`, `#駅について`,
 *     `#Law` — hashtags the author typed. Promoting them would invent 22
 *     headings and swallow their text.
 *   * `[[card-id]]` with no display text is a real link, 46 times, and all 46
 *     targets resolve to cards inside these exports. It is NOT part of SPEC's
 *     8,690, which counts only `[[display|card-id]]`, and stage 1's
 *     `card_links` misses all 46 (`src/import/links.ts` requires the pipe).
 *     Parsed here as a `wikiLink` with `display: null` and counted separately
 *     so the 8,690 oracle still holds.
 *   * MATH IS AN INLINE NODE, never a block, because the one `$$…$$` in the
 *     corpus lives inside a cloze: `{{$$(I + D - 1)\times　P$$}}`. A block-level
 *     display-math node could not be nested there. `display` says which
 *     delimiter was used.
 *   * `<component/>` is NOT an element. Its single occurrence is inside a code
 *     span — `` `<component/>` `` — which is why code spans must win over tags
 *     in the inline scanner.
 *   * Backslash escapes must not be processed inside math or code. The 28
 *     escapes in card text are `\d` ×12, `\t` ×8, `\f` ×1 (LaTeX `\div`
 *     `\times` `\frac` inside `$…$`), plus `\~` ×6 and one `\$`. The templates'
 *     only escapes are the two `\*` jisho wildcards inside a link URL.
 */

// ─── interpolation ───────────────────────────────────────────────────────────

/**
 * One piece of a string that may carry `<<Field>>` references.
 *
 * Attribute values and link URLs need this because of parser trap 3: the 数字
 * template's `<input value=<<NoComma>>>` puts a field inside an unquoted HTML
 * attribute, and the 漢字 template puts one inside a URL
 * (`https://jisho.org/search/\*<< Kanji >>\*`). Fields are interpolated before
 * markup is parsed, so after `resolveCard` every `Interpolation` is a single
 * `text` part; only `parseTemplate` produces `field` parts.
 */
export type InterpolationPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "field"; readonly name: string };

export type Interpolation = readonly InterpolationPart[];

/** A value with no field references. */
export function plainInterpolation(text: string): Interpolation {
  return text === "" ? [] : [{ kind: "text", text }];
}

/** True when nothing in the value came from a `<<Field>>`. */
export function isPlainInterpolation(value: Interpolation): boolean {
  return value.every((part) => part.kind === "text");
}

/** The value as text, with unresolved fields written back as `<<name>>`. */
export function interpolationText(value: Interpolation): string {
  return value.map((part) => (part.kind === "text" ? part.text : `<<${part.name}>>`)).join("");
}

/** Field names referenced by the value, in order, with duplicates kept. */
export function interpolationFields(value: Interpolation): string[] {
  return value.flatMap((part) => (part.kind === "field" ? [part.name] : []));
}

// ─── elements ────────────────────────────────────────────────────────────────

/**
 * What an element is for. The three roles get different treatment downstream:
 * `generator` elements are cache keys for stage 9, `widget` elements are
 * interactive and take no children, and `markup` elements are plain formatting
 * that the sanitiser polices.
 */
export type ElementRole = "generator" | "widget" | "markup";

export interface ElementSpec {
  readonly role: ElementRole;
  /** No children and no closing tag: `<input …>`, `<draw …/>`. */
  readonly void: boolean;
  /** Attribute names kept by the sanitiser. `"*"` keeps everything. */
  readonly attributes: readonly string[] | "*";
  /** Occurrences in the reference corpus: card text + template bodies. */
  readonly observed: number;
}

/**
 * The element allowlist, which doubles as the sanitiser policy SPEC asks for
 * ("Raw inline CSS — needs a sanitiser policy"). A tag whose name is not here
 * parses to an `unknown` node rather than being dropped or trusted.
 *
 * `observed` is the measured count over the three exports. The five entries at
 * 0 are here deliberately, not speculatively: `pinyin` is named by the
 * reference decoder (`tools/mochi.py`, GENERATOR), and `b`/`i`/`u`/`br` are the
 * inline HTML a `<span style>`-using author reaches for next — admitting them
 * as *known but empty* is what keeps a future card from parsing to `unknown`.
 */
export const ELEMENTS: Readonly<Record<string, ElementSpec>> = {
  // Generators — inline generation, 545 uses in card content (SPEC).
  speech: { role: "generator", void: false, attributes: ["lang", "voice", "gender"], observed: 289 },
  ai: { role: "generator", void: false, attributes: ["ai-task", "ai-custom-prompt", "randomize"], observed: 130 },
  translate: {
    role: "generator",
    void: false,
    attributes: ["from", "to", "ai-task", "ai-custom-prompt"],
    observed: 106,
  },
  furigana: { role: "generator", void: false, attributes: [], observed: 22 },
  image: { role: "generator", void: false, attributes: [], observed: 8 },
  pinyin: { role: "generator", void: false, attributes: [], observed: 0 },
  /**
   * `<ojad>` — OURS, and the first element in this list Mochi never had.
   *
   * Decision 43. It annotates an example sentence mora by mora, and it is a
   * `generator` in the same sense `pinyin` is: `nodes.ts` notes that pinyin
   * *"has no row in `BLOB_KINDS` and therefore no request; it still renders its
   * base text"*. `<ojad>` is filled from a `local = 1` field instead, so it asks
   * the blob store for nothing and costs no schema change — which matters,
   * because decision 41 made a schema bump answer for the live review history.
   *
   * `observed: 0` is honest rather than a placeholder: it counts occurrences in
   * the three Mochi exports, and this element cannot appear there. It enters
   * templates through `scripts/ojad-template-apply.ts`, which is part of the
   * documented rebuild sequence for exactly that reason.
   */
  ojad: { role: "generator", void: false, attributes: [], observed: 0 },

  // Widgets — interactive, childless.
  draw: {
    role: "widget",
    void: true,
    attributes: ["height", "brushColor", "brushRadius"],
    observed: 3,
  },
  input: { role: "widget", void: true, attributes: ["value", "placeholder"], observed: 1 },

  // Markup — the sanitiser's remit.
  span: { role: "markup", void: false, attributes: ["style"], observed: 1 },
  b: { role: "markup", void: false, attributes: [], observed: 0 },
  i: { role: "markup", void: false, attributes: [], observed: 0 },
  u: { role: "markup", void: false, attributes: [], observed: 0 },
  br: { role: "markup", void: true, attributes: [], observed: 0 },
};

export function isKnownElement(name: string): boolean {
  return Object.hasOwn(ELEMENTS, name);
}

export function elementSpec(name: string): ElementSpec | null {
  return Object.hasOwn(ELEMENTS, name) ? (ELEMENTS[name] as ElementSpec) : null;
}

/** Element names whose output is generated and content-addressed (stage 9). */
export const GENERATOR_ELEMENTS: readonly string[] = Object.entries(ELEMENTS)
  .filter(([, spec]) => spec.role === "generator")
  .map(([name]) => name);

/**
 * CSS properties a `style` attribute may keep. The corpus has exactly one
 * styled element — `<span style="color:yellow">` on card QnHb5aT2 — so the
 * policy is "colour and weight, nothing that can move or cover anything".
 * Anything else is dropped, which rules out `position`, `content`, `url(...)`
 * and every other lever a pasted-in style could pull.
 */
export const STYLE_PROPERTIES: readonly string[] = [
  "color",
  "background-color",
  "font-weight",
  "font-style",
  "text-decoration",
];

export interface SanitisedStyle {
  readonly declarations: readonly { readonly property: string; readonly value: string }[];
  readonly dropped: readonly string[];
}

/** Split a `style` attribute into the declarations the policy keeps and the rest. */
export function sanitiseStyle(css: string): SanitisedStyle {
  const declarations: { property: string; value: string }[] = [];
  const dropped: string[] = [];
  for (const chunk of css.split(";")) {
    const text = chunk.trim();
    if (text === "") continue;
    const colon = text.indexOf(":");
    const property = (colon < 0 ? text : text.slice(0, colon)).trim().toLowerCase();
    const value = colon < 0 ? "" : text.slice(colon + 1).trim();
    const safe =
      colon > 0 &&
      STYLE_PROPERTIES.includes(property) &&
      !/[(){}]|url|expression|\/\*/i.test(value);
    if (safe) declarations.push({ property, value });
    else dropped.push(text);
  }
  return { declarations, dropped };
}

/**
 * BCP-47 for a `lang` attribute. SPEC: "Same language, two spellings, one of
 * them not valid BCP-47". Measured over the inline tags alone, BOTH spellings
 * are already there — `lang="jp"` 264, `lang="ja-JP"` 15, `lang="en"` 6 — so
 * this is not, as SPEC frames it, a tidy split between the inline surface and
 * the field options. Two inline `<speech>` tags with the same Japanese text and
 * different spellings must hash to one cache key in stage 9.
 *
 * One inline tag carries `lang="่jp"`, with a stray Thai tone mark (U+0E48)
 * before the code, so this strips anything that is not an ASCII tag character
 * before mapping. `en` and `ja` are already valid BCP-47 and are left alone;
 * only `jp` is not a language subtag at all.
 */
export function normaliseLanguageTag(code: string): string {
  const cleaned = code.replace(/[^A-Za-z0-9-]/g, "");
  if (cleaned === "") return "";
  return cleaned.toLowerCase() === "jp" ? "ja-JP" : cleaned;
}

// ─── attributes ──────────────────────────────────────────────────────────────

export interface Attribute {
  readonly name: string;
  /** `null` for a valueless attribute (`<input disabled>`). */
  readonly value: Interpolation | null;
}

/** An attribute by name, case-insensitively. Mochi writes `brushColor`. */
export function findAttribute(node: ElementNode, name: string): Attribute | null {
  const wanted = name.toLowerCase();
  return node.attributes.find((attr) => attr.name.toLowerCase() === wanted) ?? null;
}

/** An attribute's text, or `null` if absent. Valueless attributes give `""`. */
export function attributeText(node: ElementNode, name: string): string | null {
  const attr = findAttribute(node, name);
  if (attr === null) return null;
  return attr.value === null ? "" : interpolationText(attr.value);
}

// ─── inline nodes ────────────────────────────────────────────────────────────

export interface TextNode {
  readonly kind: "text";
  readonly text: string;
}

/** A single newline inside a paragraph. `hard` = markdown's two-space break. */
export interface LineBreakNode {
  readonly kind: "lineBreak";
  readonly hard: boolean;
}

export interface StrongNode {
  readonly kind: "strong";
  readonly marker: "**" | "__";
  readonly children: readonly Inline[];
}

export interface EmphasisNode {
  readonly kind: "emphasis";
  readonly marker: "*" | "_";
  readonly children: readonly Inline[];
}

/** Verbatim: no escapes, no nested constructs. */
export interface CodeSpanNode {
  readonly kind: "code";
  readonly text: string;
}

/** LaTeX. `display` is `$$…$$`, otherwise `$…$`. Body is verbatim. */
export interface MathNode {
  readonly kind: "math";
  readonly text: string;
  readonly display: boolean;
}

/**
 * `[[display|card-id]]`, or `[[card-id]]` with `display: null` (46 uses).
 * An unresolved target renders as its display text — SPEC: "unresolved links
 * must render as plain text rather than being dropped" — so resolution is the
 * renderer's job and the node keeps the raw target either way.
 */
export interface WikiLinkNode {
  readonly kind: "wikiLink";
  readonly target: string;
  readonly display: string | null;
}

/**
 * `[text](url)`. The URL is an `Interpolation` because the 漢字 template puts a
 * field in it, and SPEC flags this node as an answer leak: side 4 carries
 * `[Jisho](https://jisho.org/search/<<Kanji>>)`, so in reverse mode the
 * renderer must defer link rendering to the answer side.
 */
export interface LinkNode {
  readonly kind: "link";
  readonly href: Interpolation;
  readonly children: readonly Inline[];
}

/** `![alt](src)`. Mochi also embeds audio this way (`![clip.mp3](uVQp0iMb.mp3)`). */
export interface ImageNode {
  readonly kind: "image";
  readonly src: Interpolation;
  readonly alt: string;
}

/**
 * `{{…}}`, or `{{n::…}}`. `index` is null for the unindexed form, which is the
 * only form in the corpus (`cloze/indexes` is empty on all 7,716 cards), and
 * maps to the single `cloze:0` review track.
 */
export interface ClozeNode {
  readonly kind: "cloze";
  readonly index: number | null;
  readonly children: readonly Inline[];
}

export interface ElementNode {
  readonly kind: "element";
  readonly name: string;
  readonly role: ElementRole;
  readonly attributes: readonly Attribute[];
  readonly children: readonly Inline[];
  /** Written `<x/>` rather than `<x>…</x>`. Always true for void elements. */
  readonly selfClosing: boolean;
}

/** `<<Field>>`. Surface 2 only: `<<` never appears in card text (measured 0). */
export interface FieldRefNode {
  readonly kind: "field";
  readonly name: string;
}

/**
 * Something the parser recognised as a construct but cannot name. The parser
 * never throws and never silently drops: an unparseable construct becomes one
 * of these, so "zero unknown constructs" is a measurable property of a parse
 * rather than a hope. All four reasons are 0 over the reference corpus.
 */
export type UnknownReason =
  /** A well-formed tag whose name is not in `ELEMENTS`. */
  | "unknown-element"
  /** An open tag with no matching close before the end of the block. */
  | "unclosed-element"
  /** A close tag with no open tag to match. */
  | "mismatched-close"
  /**
   * A `<<#Field>>` / `<<^Field>>` / `<</Field>>` marker that is not alone on its
   * own line, or a close with no matching open inside the same side.
   */
  | "stray-section-marker";

export interface UnknownNode {
  readonly kind: "unknown";
  readonly reason: UnknownReason;
  /** The source text, kept verbatim so nothing authored is ever lost. */
  readonly text: string;
}

export type Inline =
  | TextNode
  | LineBreakNode
  | StrongNode
  | EmphasisNode
  | CodeSpanNode
  | MathNode
  | WikiLinkNode
  | LinkNode
  | ImageNode
  | ClozeNode
  | ElementNode
  | FieldRefNode
  | UnknownNode;

// ─── block nodes ─────────────────────────────────────────────────────────────

export interface ParagraphNode {
  readonly kind: "paragraph";
  readonly children: readonly Inline[];
}

export interface HeadingNode {
  readonly kind: "heading";
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly children: readonly Inline[];
}

export interface BlockquoteNode {
  readonly kind: "blockquote";
  readonly children: readonly Block[];
}

export interface ListItemNode {
  readonly kind: "listItem";
  readonly children: readonly Block[];
}

/**
 * `start` is the first item's number: 21 of the corpus's 1,429 ordered lists
 * begin at something other than 1, because a plain line interrupts a list and
 * the numbering carries on afterwards.
 */
export interface ListNode {
  readonly kind: "list";
  readonly ordered: boolean;
  readonly start: number;
  readonly items: readonly ListItemNode[];
}

/**
 * A horizontal rule, and the marker it was written with.
 *
 * Parser trap 1 lives here. `___` is a rule within a side (255 uses); `---`
 * separates sides (1,694) and is consumed structurally by `splitMaskedSides`
 * before block parsing, so it normally never becomes a node at all.
 *
 * `marker: "---"` therefore means one specific thing: a `---` that arrived
 * INSIDE a side because a field value carried it. Exactly one card does this —
 * `EPp9rse6` in 基本情報/第8章 writes a four-step PCM answer into its `Cue`
 * field, separated by three `---` lines. Sides are a property of the authored
 * body, never of the data poured into it (a data-dependent side count would
 * make `templates.reverse_permutation` undefined), so those three render as
 * rules and the card keeps the two sides its template declares. Keeping the
 * marker means the distinction survives a round-trip back to markdown instead
 * of being quietly normalised into the other one.
 */
export interface HorizontalRuleNode {
  readonly kind: "hrule";
  readonly marker: "---" | "___";
}

export interface CodeBlockNode {
  readonly kind: "codeBlock";
  readonly language: string | null;
  readonly text: string;
}

export type TableAlign = "left" | "center" | "right" | null;

export interface TableCellNode {
  readonly kind: "tableCell";
  readonly children: readonly Inline[];
}

export interface TableNode {
  readonly kind: "table";
  readonly align: readonly TableAlign[];
  readonly header: readonly TableCellNode[];
  readonly rows: readonly (readonly TableCellNode[])[];
}

/**
 * `<<#Field>>…<</Field>>`, or `<<^Field>>…<</Field>>` when `inverted`.
 *
 * Surface 2 only, and block-level: all 8 section markers in the corpus sit
 * alone on their own line (単語 lines 0/2/4/6). A marker anywhere else parses to
 * `unknown: "stray-section-marker"` rather than being guessed at.
 */
export interface SectionNode {
  readonly kind: "section";
  readonly name: string;
  readonly inverted: boolean;
  readonly children: readonly Block[];
}

export type Block =
  | ParagraphNode
  | HeadingNode
  | BlockquoteNode
  | ListNode
  | HorizontalRuleNode
  | CodeBlockNode
  | TableNode
  | SectionNode;

export type Node = Block | Inline | ListItemNode | TableCellNode;

// ─── sides ───────────────────────────────────────────────────────────────────

/**
 * One side of a card. SPEC: "a card is an ordered list of sides", up to four —
 * 単語 and 漢字 are four-side templates, 言葉 / 文法 / New Vocab three-side.
 */
export interface Side {
  /** 0-based, in authored order, before any reverse permutation. */
  readonly index: number;
  readonly blocks: readonly Block[];
}

export function side(index: number, blocks: readonly Block[]): Side {
  return { index, blocks };
}

// ─── walking ─────────────────────────────────────────────────────────────────

/** A node's children, whatever shape the node keeps them in. */
export function childrenOf(node: Node): readonly Node[] {
  switch (node.kind) {
    case "paragraph":
    case "heading":
    case "strong":
    case "emphasis":
    case "cloze":
    case "element":
    case "link":
    case "tableCell":
      return node.children;
    case "blockquote":
    case "listItem":
    case "section":
      return node.children;
    case "list":
      return node.items;
    case "table":
      return [...node.header, ...node.rows.flat()];
    default:
      return [];
  }
}

/** Depth-first, parents before children. */
export function walk(nodes: Iterable<Node>, visit: (node: Node) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(childrenOf(node), visit);
  }
}

/** Every node in every side, depth-first. */
export function walkSides(sides: Iterable<Side>, visit: (node: Node) => void): void {
  for (const s of sides) walk(s.blocks, visit);
}

/** Concatenated text of every `text` node, ignoring markup. */
export function plainText(nodes: Iterable<Node>): string {
  const parts: string[] = [];
  walk(nodes, (node) => {
    if (node.kind === "text") parts.push(node.text);
    else if (node.kind === "code" || node.kind === "math") parts.push(node.text);
    else if (node.kind === "lineBreak") parts.push("\n");
    else if (node.kind === "wikiLink") parts.push(node.display ?? node.target);
  });
  return parts.join("");
}

/** Every `unknown` node, in document order. */
export function collectUnknowns(sides: Iterable<Side>): UnknownNode[] {
  const out: UnknownNode[] = [];
  walkSides(sides, (node) => {
    if (node.kind === "unknown") out.push(node);
  });
  return out;
}

/**
 * Node kinds that put something on screen. Used by `isSideEmpty`, which the
 * review UI needs: 単語's first side is `<<#Reading>>…<</Reading>>` and resolves
 * to nothing at all whenever `Reading` is false, which is the default.
 */
const VISIBLE = new Set([
  "code",
  "math",
  "wikiLink",
  "link",
  "image",
  "element",
  "hrule",
  "table",
  "unknown",
  "field",
]);

export function isSideEmpty(s: Side): boolean {
  let visible = false;
  walk(s.blocks, (node) => {
    if (visible) return;
    if (node.kind === "text") visible = node.text.trim() !== "";
    else if (VISIBLE.has(node.kind)) visible = true;
  });
  return !visible;
}

// ─── census ──────────────────────────────────────────────────────────────────

/**
 * Count constructs in an AST. The keys are the acceptance criteria in SPEC's
 * two tables, so the test can compare a parse of the whole corpus against
 * figures measured independently by `tools/mochi.py`.
 *
 * Keys are node kinds, refined where SPEC's tables are:
 *   `wikiLink` / `:emptyDisplay` / `:bare`  `[[x|id]]` (SPEC's 8,690) vs
 *                                  `[[|id]]` (8) vs `[[id]]` (46)
 *   `listItem:ordered` / `:unordered`  SPEC counts items, not lists
 *   `quoteLine`                    SPEC counts `>` lines, not blockquotes
 *   `element:speech` …             per generator / widget / markup element
 *   `math:inline` / `math:display`
 *   `strong:**`, `emphasis:*`, …   per delimiter
 *   `hrule:___` / `hrule:---`      a rule in a side vs one from a field value
 *   `field` / `:href` / `:attribute`  a `<<Field>>` node, one inside a link URL,
 *                                  one inside an HTML attribute. SPEC's 73
 *                                  `<<Field>>` uses is 53 + 11 + 1 plain plus
 *                                  the 4 section markers and their 4 closes.
 *   `unknown:<reason>`             must be absent
 */
export function census(sides: Iterable<Side>): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string, by = 1): void => {
    counts.set(key, (counts.get(key) ?? 0) + by);
  };

  for (const s of sides) {
    bump("side");
    walk(s.blocks, (node) => {
      switch (node.kind) {
        case "wikiLink":
          // Three spellings, counted apart. SPEC's 8,690 is the first only, and
          // `src/import/links.ts` writes rows for the first only as well.
          bump(
            node.display === null
              ? "wikiLink:bare"
              : node.display === ""
                ? "wikiLink:emptyDisplay"
                : "wikiLink",
          );
          break;
        case "list":
          bump(node.ordered ? "list:ordered" : "list:unordered");
          bump(node.ordered ? "listItem:ordered" : "listItem:unordered", node.items.length);
          break;
        case "listItem":
          break; // counted with its list, so the two cannot disagree
        case "blockquote":
          bump("blockquote");
          bump("quoteLine", quoteLines(node));
          break;
        case "element":
          bump("element");
          bump(`element:${node.name}`);
          for (const attribute of node.attributes) {
            if (attribute.value !== null) {
              bump("field:attribute", interpolationFields(attribute.value).length);
            }
          }
          break;
        case "link":
          bump("link");
          bump("field:href", interpolationFields(node.href).length);
          break;
        case "math":
          bump(node.display ? "math:display" : "math:inline");
          break;
        case "strong":
        case "emphasis":
          bump(`${node.kind}:${node.marker}`);
          break;
        case "heading":
          bump("heading");
          bump(`heading:${node.level}`);
          break;
        case "hrule":
          bump("hrule");
          bump(`hrule:${node.marker}`);
          break;
        case "unknown":
          bump(`unknown:${node.reason}`);
          break;
        default:
          bump(node.kind);
      }
    });
  }
  return counts;
}

/**
 * Source `>` lines a blockquote came from: one per paragraph plus one per line
 * break inside it. `>a\n>b` is one paragraph with one break, so two lines.
 */
function quoteLines(node: BlockquoteNode): number {
  let lines = 0;
  for (const block of node.children) {
    if (block.kind !== "paragraph") continue;
    lines += 1;
    walk(block.children, (child) => {
      if (child.kind === "lineBreak") lines += 1;
    });
  }
  // A blockquote exists because at least one `>` line did, even when nothing
  // followed it: card RezUPwfG ends its content with a bare `>`, which is the
  // 45th of the 45 quoted lines SPEC's aggregate of 76 is built from.
  return Math.max(1, lines);
}

/** Sum a census over many parses. */
export function mergeCensus(
  into: Map<string, number>,
  from: ReadonlyMap<string, number>,
): Map<string, number> {
  for (const [key, value] of from) into.set(key, (into.get(key) ?? 0) + value);
  return into;
}
