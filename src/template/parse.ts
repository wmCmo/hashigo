/**
 * Stage 3 — the parser for both syntax surfaces.
 *
 * Surface 1 is card content and field values; surface 2 is template bodies.
 * They share every construct except `<<Field>>` interpolation and its three
 * section forms, so they share one parser and one AST: `parseContent` is
 * `parseTemplate` with the field lexer switched off.
 *
 * THE THREE TRAPS, AND WHERE EACH IS HANDLED
 *
 *   1. `---` separates card SIDES, `___` is a rule WITHIN a side. They are
 *      handled at different levels and cannot be conflated: `splitMaskedSides`
 *      consumes every `---` line before the block parser runs, so `---` is
 *      structure and never a node, while `___` becomes an `hrule`. A `---` that
 *      reaches the block parser can only have come from an interpolated field
 *      value, and becomes `hrule` with `marker: "---"` — see the node's comment
 *      in ast.ts for the one card that does it and why sides stay structural.
 *
 *   2. Constructs nest and resolve inside-out. 単語 contains
 *      `{{<furigana><< 単語 >></furigana>}}` — cloze over ruby over field. The
 *      order SPEC fixes (fields, then tags, then cloze) is the order here:
 *      `maskFields` runs first over raw text, then the inline scanner builds
 *      `cloze > element > field`, so the tree nests outside-in and anything
 *      walking it bottom-up resolves inside-out.
 *
 *   3. Fields appear inside unquoted HTML attributes: 数字 has
 *      `<input value=<<NoComma>>>`, and 漢字 puts one inside a URL. Splitting
 *      the text at the field and parsing the halves as markup cannot work —
 *      `<input value=` is not a tag. So `maskFields` REPLACES each `<<…>>` with
 *      a one-character-delimited marker before any markup is looked at, and the
 *      markers become `field` nodes and `Interpolation` parts afterwards.
 *      Interpolation genuinely precedes parsing, as SPEC requires.
 *
 * THE MARKER IS SAFE, MEASURED NOT ASSUMED. U+E000 and U+E001 (private use)
 * appear zero times in the 7,716 cards' text and zero times in the 11 template
 * bodies. `maskFields` strips any that do arrive, so pasted-in text can never
 * forge a field reference.
 *
 * THE PARSER NEVER THROWS. Every malformed construct degrades: an unclosed
 * `[[`, `{{`, `` ` ``, `$` or `**` is literal text, and a well-formed tag with an
 * unknown name becomes an `unknown` node holding its source verbatim. That is
 * what makes "zero parse failures over 7,716 cards" measurable rather than
 * merely hoped for.
 */

import {
  type Attribute,
  type Block,
  type CodeBlockNode,
  type Inline,
  type Interpolation,
  type InterpolationPart,
  type ListItemNode,
  type Side,
  type TableAlign,
  type TableCellNode,
  type TextNode,
  elementSpec,
} from "./ast.js";

// ─── the field lexer ─────────────────────────────────────────────────────────

/** Marker delimiters, private use. Measured absent from the whole corpus. */
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";

/**
 * `<<Field>>`, `<<#Field>>`, `<<^Field>>`, `<</Field>>`.
 *
 * Whitespace around the sigil and the name is insignificant, which the real
 * templates rely on heavily and inconsistently: `<<Kanji>>`, `<< Kanji >>`,
 * `<< #Reading>>` and `<< /Reading >>` all occur, twice in the same body. Names
 * carry internal spaces (`<<Example Sentence>>`), so only the edges trim.
 *
 * Global, so callers must not share its `lastIndex`; every use below builds its
 * own copy.
 */
export const FIELD_TOKEN = /<<[ \t]*([#^/]?)[ \t]*([^>]+?)[ \t]*>>/g;

export type FieldSigil = "" | "#" | "^" | "/";

export interface FieldToken {
  readonly sigil: FieldSigil;
  readonly name: string;
  /** The exact source text, so an unresolved reference can be echoed back. */
  readonly source: string;
}

export interface MaskedSource {
  /** The source with every field token replaced by a marker. */
  readonly text: string;
  readonly tokens: readonly FieldToken[];
}

/**
 * Every `<<Field>>` reference in a string, section markers excluded.
 *
 * Also the hook SPEC's generation DAG needs: 例文 is an `ai` field whose
 * `source` is null because its only dependency is named inside its prompt
 * ("Example sentence using `<<単語>>` in Japanese"), so stage 9 must run this
 * over `options.ai-custom-prompt` too or it builds an incomplete graph.
 */
export function fieldRefs(text: string): FieldToken[] {
  return maskFields(text).tokens.filter((token) => token.sigil !== "/");
}

/**
 * Replace each field token with `\uE000<index>\uE001`.
 *
 * Pre-existing marker characters are removed rather than escaped: they cannot
 * occur in authored text, and removing them means no input can forge a field.
 */
export function maskFields(source: string): MaskedSource {
  const tokens: FieldToken[] = [];
  const text = normaliseSource(source).replace(
    new RegExp(FIELD_TOKEN.source, "g"),
    (whole: string, sigil: string, name: string) => {
      const index = tokens.length;
      tokens.push({ sigil: sigil as FieldSigil, name, source: whole });
      return markerFor(index);
    },
  );
  return { text, tokens };
}

export function stripMarkers(source: string): string {
  return source.includes(MARK_OPEN) || source.includes(MARK_CLOSE)
    ? source.replaceAll(MARK_OPEN, "").replaceAll(MARK_CLOSE, "")
    : source;
}

/**
 * Normalise line endings, then strip markers. Every entry point starts here.
 *
 * A BARE \r IS A LINE ENDING, and the corpus is full of them: 31 cards write
 * their numbered senses as `1. ...\r\n\r2. ...`, pasted out of a dictionary.
 * CommonMark says a line ending is \n, a \r not followed by \n, or \r\n, and
 * JavaScript's /m agrees — but Python's re.M does not, which is why SPEC's table
 * records 4,314 ordered-list items where the correct figure is 4,318.
 * Normalising first lets the block scanner split on \n alone and still be right.
 */
export function normaliseLineEndings(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/** Line endings normalised and markers stripped. Every entry point starts here. */
export function normaliseSource(source: string): string {
  return stripMarkers(normaliseLineEndings(source));
}

/** Wrap a token index the way `maskFields` does. The resolver needs this. */
export function markerFor(index: number): string {
  return `${MARK_OPEN}${index}${MARK_CLOSE}`;
}

const MARKER_GLOBAL = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
const MARKER_ONLY = new RegExp(`^${MARK_OPEN}(\\d+)${MARK_CLOSE}$`);

/** Split masked text into literal runs and field references. */
export function splitMarkers(text: string, tokens: readonly FieldToken[]): Interpolation {
  const parts: InterpolationPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER_GLOBAL)) {
    const at = match.index;
    if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
    const token = tokens[Number(match[1])];
    parts.push(
      token !== undefined && token.sigil === ""
        ? { kind: "field", name: token.name }
        : { kind: "text", text: token?.source ?? "" },
    );
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/**
 * Replace every marker with whatever `replace` returns for its token, in one
 * pass. One pass matters: text substituted in is never re-scanned, so a field
 * value that happens to contain a marker character cannot forge a reference.
 */
export function substituteMarkers(
  text: string,
  tokens: readonly FieldToken[],
  replace: (token: FieldToken, index: number) => string,
): string {
  return text.replace(new RegExp(MARKER_GLOBAL.source, "g"), (whole, index: string) => {
    const token = tokens[Number(index)];
    return token === undefined ? whole : replace(token, Number(index));
  });
}

/**
 * The section marker a line consists of, and nothing else.
 *
 * Sections are block-level here because all 8 markers in the corpus sit alone on
 * their own line (単語 lines 0, 2, 4 and 6). A marker anywhere else becomes
 * `unknown: "stray-section-marker"` rather than a guess about how far it reaches.
 */
export function readSectionMarker(line: string, tokens: readonly FieldToken[]): FieldToken | null {
  const match = MARKER_ONLY.exec(line.trim());
  if (match === null) return null;
  const token = tokens[Number(match[1])];
  return token !== undefined && token.sigil !== "" ? token : null;
}

// ─── sides ───────────────────────────────────────────────────────────────────

/** `---` on its own line. Parser trap 1: this is the SIDE separator. */
const SIDE_BREAK = /^[ \t]*-{3,}[ \t]*$/;
/** `___` on its own line. Parser trap 1: this is a rule inside one side. */
const HORIZONTAL_RULE = /^[ \t]*_{3,}[ \t]*$/;

/**
 * Split a body into sides. Runs on the MASKED text, i.e. before interpolation
 * and before any markup parsing, so sides are a property of the authored body
 * and never of the data poured into it.
 */
export function splitMaskedSides(masked: string): string[] {
  const sides: string[] = [];
  let current: string[] = [];
  for (const line of masked.split("\n")) {
    if (SIDE_BREAK.test(line)) {
      sides.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  sides.push(current.join("\n"));
  return sides;
}

/** How many sides a body declares. 単語 and 漢字 both answer 4. */
export function sideCount(body: string): number {
  return splitMaskedSides(maskFields(body).text).length;
}

// ─── public entry points ─────────────────────────────────────────────────────

/** Parse a template body (surface 2). Produces `field` and `section` nodes. */
export function parseTemplate(body: string): Side[] {
  const masked = maskFields(body);
  return splitMaskedSides(masked.text).map((text, index) => ({
    index,
    blocks: parseMaskedSide(text, masked.tokens),
  }));
}

/**
 * Parse card content (surface 1), sides and all. The field lexer stays off: `<<`
 * appears zero times in the 7,716 cards' text, so switching it on would invent a
 * feature the data does not use and change what a literal `<<x>>` means.
 */
export function parseContent(text: string): Side[] {
  return splitMaskedSides(normaliseSource(text)).map((side, index) => ({
    index,
    blocks: parseMaskedSide(side, []),
  }));
}

/**
 * Parse one field value (surface 1). Not sides: a field value is poured into a
 * side that already exists, so a `---` inside it is a rule, not structure.
 */
export function parseFieldValue(value: string): Block[] {
  return parseMaskedSide(normaliseSource(value), []);
}

/** One side's blocks. `text` must already be masked and side-split. */
export function parseMaskedSide(text: string, tokens: readonly FieldToken[]): Block[] {
  return parseBlocks(text.split("\n"), tokens);
}

// ─── block level ─────────────────────────────────────────────────────────────

const HEADING = /^[ \t]*(#{1,6})[ \t]+(.*)$/;
const QUOTE = /^[ \t]*>/;
const ORDERED_ITEM = /^[ \t]*(\d{1,9})\.[ \t]+(.*)$/;
const BULLET_ITEM = /^[ \t]*[-*+][ \t]+(.*)$/;
const FENCE = /^[ \t]*(`{3,})[ \t]*([^`\s]*)[ \t]*$/;
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/;
const TABLE_DELIMITER = /^[ \t]*\|[ \t:|-]*-[ \t:|-]*\|[ \t]*$/;

function parseBlocks(lines: readonly string[], tokens: readonly FieldToken[]): Block[] {
  const blocks: Block[] = [];
  const at = (index: number): string => lines[index] ?? "";
  let i = 0;

  while (i < lines.length) {
    const line = at(i);

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (SIDE_BREAK.test(line) || HORIZONTAL_RULE.test(line)) {
      blocks.push({ kind: "hrule", marker: SIDE_BREAK.test(line) ? "---" : "___" });
      i += 1;
      continue;
    }

    const marker = readSectionMarker(line, tokens);
    if (marker !== null) {
      const close = marker.sigil === "/" ? -1 : findSectionClose(lines, i + 1, marker.name, tokens);
      if (close < 0) {
        blocks.push({
          kind: "paragraph",
          children: [{ kind: "unknown", reason: "stray-section-marker", text: marker.source }],
        });
        i += 1;
        continue;
      }
      blocks.push({
        kind: "section",
        name: marker.name,
        inverted: marker.sigil === "^",
        children: parseBlocks(lines.slice(i + 1, close), tokens),
      });
      i = close + 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const [block, next] = readFence(lines, i, (fence[1] as string).length, fence[2] ?? "");
      blocks.push(block);
      i = next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? "", tokens),
      });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(at(i))) {
        inner.push(at(i).replace(/^[ \t]*>[ \t]?/, ""));
        i += 1;
      }
      blocks.push({ kind: "blockquote", children: parseBlocks(inner, tokens) });
      continue;
    }

    const ordered = ORDERED_ITEM.exec(line);
    if (ordered !== null) {
      const list = readList(lines, i, ORDERED_ITEM, 2, tokens);
      blocks.push({ kind: "list", ordered: true, start: Number(ordered[1]), items: list.items });
      i = list.next;
      continue;
    }

    if (BULLET_ITEM.test(line)) {
      const list = readList(lines, i, BULLET_ITEM, 1, tokens);
      blocks.push({ kind: "list", ordered: false, start: 1, items: list.items });
      i = list.next;
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_DELIMITER.test(at(i + 1))) {
      const header = tableCells(line, tokens);
      const align = tableAlign(at(i + 1));
      i += 2;
      const rows: TableCellNode[][] = [];
      while (i < lines.length && TABLE_ROW.test(at(i)) && !TABLE_DELIMITER.test(at(i))) {
        rows.push(tableCells(at(i), tokens));
        i += 1;
      }
      blocks.push({ kind: "table", align, header, rows });
      continue;
    }

    // A paragraph runs to the next line that opens some other block. Blank
    // lines barely exist in this corpus — 7,670 of 7,716 cards have none — so
    // this is the common case by a wide margin.
    const paragraph: string[] = [];
    while (i < lines.length && !startsBlock(at(i), at(i + 1), tokens)) {
      paragraph.push(at(i));
      i += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n"), tokens) });
  }

  return blocks;
}

/**
 * Items of one list, absorbing blank lines BETWEEN items.
 *
 * CommonMark ends a list only at a block of a different kind, so a blank line
 * between two items makes the list loose rather than making two lists. It is not
 * a hypothetical: 31 cards write their senses `1. ...\r\n\r2. ...`, whose
 * normalised form has exactly that blank line in it.
 */
function readList(
  lines: readonly string[],
  start: number,
  pattern: RegExp,
  textGroup: number,
  tokens: readonly FieldToken[],
): { readonly items: ListItemNode[]; readonly next: number } {
  const items: ListItemNode[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const item = pattern.exec(line);
    if (item !== null) {
      items.push(listItem(item[textGroup] ?? "", tokens));
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      let ahead = i;
      while (ahead < lines.length && (lines[ahead] ?? "").trim() === "") ahead += 1;
      if (ahead < lines.length && pattern.test(lines[ahead] ?? "")) {
        i = ahead;
        continue;
      }
    }
    break;
  }
  return { items, next: i };
}

function listItem(text: string, tokens: readonly FieldToken[]): ListItemNode {
  return { kind: "listItem", children: [{ kind: "paragraph", children: parseInline(text, tokens) }] };
}

function startsBlock(line: string, next: string, tokens: readonly FieldToken[]): boolean {
  if (line.trim() === "") return true;
  if (SIDE_BREAK.test(line) || HORIZONTAL_RULE.test(line)) return true;
  if (FENCE.test(line) || HEADING.test(line) || QUOTE.test(line)) return true;
  if (ORDERED_ITEM.test(line) || BULLET_ITEM.test(line)) return true;
  if (TABLE_ROW.test(line) && TABLE_DELIMITER.test(next)) return true;
  return readSectionMarker(line, tokens) !== null;
}

/** Index of the `<</name>>` line closing a section, honouring nesting. */
function findSectionClose(
  lines: readonly string[],
  from: number,
  name: string,
  tokens: readonly FieldToken[],
): number {
  let depth = 0;
  for (let i = from; i < lines.length; i += 1) {
    const marker = readSectionMarker(lines[i] ?? "", tokens);
    if (marker === null || marker.name !== name) continue;
    if (marker.sigil !== "/") depth += 1;
    else if (depth === 0) return i;
    else depth -= 1;
  }
  return -1;
}

function readFence(
  lines: readonly string[],
  start: number,
  width: number,
  language: string,
): [CodeBlockNode, number] {
  const body: string[] = [];
  let i = start + 1;
  for (; i < lines.length; i += 1) {
    const close = FENCE.exec(lines[i] ?? "");
    if (close !== null && (close[1] as string).length >= width && (close[2] ?? "") === "") {
      i += 1;
      break;
    }
    body.push(lines[i] ?? "");
  }
  return [
    { kind: "codeBlock", language: language === "" ? null : language, text: body.join("\n") },
    i,
  ];
}

function tableCells(line: string, tokens: readonly FieldToken[]): TableCellNode[] {
  return splitRow(line).map(
    (cell): TableCellNode => ({ kind: "tableCell", children: parseInline(cell.trim(), tokens) }),
  );
}

function tableAlign(line: string): TableAlign[] {
  return splitRow(line).map((cell) => {
    const spec = cell.trim();
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (left) return "left";
    if (right) return "right";
    return null;
  });
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

// ─── inline level ────────────────────────────────────────────────────────────

/** Characters a backslash may escape. Never applied inside code or math. */
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!$|<>~"']/;

/**
 * Parse one block's inline content.
 *
 * Delimiter search is line-scoped for every paired construct. That is measured,
 * not lazy: cloze bodies never cross a line (0 of 1,087), `{{`/`}}` counts
 * balance on every card, and confining the search means an unclosed delimiter
 * costs one literal character instead of swallowing the rest of the card.
 */
export function parseInline(text: string, tokens: readonly FieldToken[]): Inline[] {
  const out: Inline[] = [];
  let pending = "";
  let i = 0;

  const flush = (): void => {
    if (pending !== "") {
      out.push({ kind: "text", text: pending });
      pending = "";
    }
  };
  const push = (node: Inline): void => {
    flush();
    out.push(node);
  };
  /** End of the source line containing `from`. */
  const lineEnd = (from: number): number => {
    const at = text.indexOf("\n", from);
    return at < 0 ? text.length : at;
  };
  /** First `needle` at or after `from`, but not past the end of that line. */
  const find = (needle: string, from: number): number => {
    const at = text.indexOf(needle, from);
    return at < 0 || at >= lineEnd(from) ? -1 : at;
  };

  while (i < text.length) {
    const ch = text[i] as string;
    const rest = text.slice(i, i + 2);

    if (ch === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      pending += text[i + 1] as string;
      i += 2;
      continue;
    }

    if (ch === "\n") {
      // Two or more trailing spaces are markdown's hard break; the Polysemy
      // template ends a field line with exactly that.
      const hard = /[ \t]{2,}$/.test(pending);
      if (hard) pending = pending.replace(/[ \t]+$/, "");
      push({ kind: "lineBreak", hard });
      i += 1;
      continue;
    }

    if (ch === MARK_OPEN) {
      const end = text.indexOf(MARK_CLOSE, i + 1);
      const token = end < 0 ? undefined : tokens[Number(text.slice(i + 1, end))];
      if (token === undefined) {
        i = end < 0 ? i + 1 : end + 1;
        continue;
      }
      push(
        token.sigil === ""
          ? { kind: "field", name: token.name }
          : { kind: "unknown", reason: "stray-section-marker", text: token.source },
      );
      i = end + 1;
      continue;
    }

    // Code first: the corpus's only `<component/>` sits inside a code span, so a
    // tag scanner running earlier would invent an element out of it.
    if (ch === "`") {
      const close = find("`", i + 1);
      if (close > i + 1) {
        push({ kind: "code", text: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (rest === "$$") {
      const close = find("$$", i + 2);
      if (close > i + 2) {
        push({ kind: "math", text: text.slice(i + 2, close), display: true });
        i = close + 2;
        continue;
      }
    }

    if (ch === "$" && rest !== "$$") {
      const close = find("$", i + 1);
      // A body that opens with whitespace is a currency amount, not maths.
      if (close > i + 1 && !/^\s/.test(text.slice(i + 1, close))) {
        push({ kind: "math", text: text.slice(i + 1, close), display: false });
        i = close + 1;
        continue;
      }
    }

    if (rest === "{{") {
      const close = find("}}", i + 2);
      if (close > i + 2) {
        const body = text.slice(i + 2, close);
        const indexed = /^(\d+)::(.*)$/.exec(body);
        push({
          kind: "cloze",
          index: indexed === null ? null : Number(indexed[1]),
          children: parseInline(indexed === null ? body : (indexed[2] as string), tokens),
        });
        i = close + 2;
        continue;
      }
    }

    if (rest === "[[") {
      const close = find("]]", i + 2);
      if (close > i + 2) {
        const body = text.slice(i + 2, close);
        const pipe = body.indexOf("|");
        push(
          pipe < 0
            ? { kind: "wikiLink", target: body, display: null }
            : { kind: "wikiLink", display: body.slice(0, pipe), target: body.slice(pipe + 1) },
        );
        i = close + 2;
        continue;
      }
    }

    if (rest === "![") {
      const parsed = readBracketed(text, i + 1, lineEnd(i));
      if (parsed !== null) {
        push({ kind: "image", alt: parsed.label, src: splitMarkers(parsed.target, tokens) });
        i = parsed.end;
        continue;
      }
    }

    if (ch === "[") {
      const parsed = readBracketed(text, i, lineEnd(i));
      if (parsed !== null) {
        push({
          kind: "link",
          href: splitMarkers(parsed.target, tokens),
          children: parseInline(parsed.label, tokens),
        });
        i = parsed.end;
        continue;
      }
    }

    // `**` is permissive about interior whitespace on purpose. Two of the 315
    // occurrences are `**to build up **` and `**restrict **`; CommonMark's
    // right-flanking rule leaves both as literal asterisks, but the author
    // plainly meant bold, and 315 is the figure SPEC's table records.
    if (rest === "**" || rest === "__") {
      const marker = rest as "**" | "__";
      const close = find(marker, i + 2);
      if (close > i + 2) {
        push({ kind: "strong", marker, children: parseInline(text.slice(i + 2, close), tokens) });
        i = close + 2;
        continue;
      }
    }

    // Single `*` and `_` DO require tight flanking. Loosening them would eat the
    // `\*` jisho wildcards and every underscore in an attachment filename.
    if (ch === "*" || ch === "_") {
      const close = flanked(text, i, ch, lineEnd(i));
      if (close > 0) {
        push({
          kind: "emphasis",
          marker: ch,
          children: parseInline(text.slice(i + 1, close), tokens),
        });
        i = close + 1;
        continue;
      }
    }

    if (ch === "<") {
      const tag = readTag(text, i, tokens);
      if (tag !== null) {
        push(tag.node);
        i = tag.end;
        continue;
      }
    }

    pending += ch;
    i += 1;
  }

  flush();
  return out;
}

interface Bracketed {
  readonly label: string;
  readonly target: string;
  readonly end: number;
}

/** `[label](target)` with `[` at `open`, confined to one line. */
function readBracketed(text: string, open: number, limit: number): Bracketed | null {
  const closeLabel = text.indexOf("]", open + 1);
  if (closeLabel < 0 || closeLabel > limit) return null;
  if (text[closeLabel + 1] !== "(") return null;
  const closeTarget = text.indexOf(")", closeLabel + 2);
  if (closeTarget < 0 || closeTarget > limit) return null;
  const label = text.slice(open + 1, closeLabel);
  if (label.includes("[")) return null;
  return {
    label,
    // `[Words with Kanji](https://jisho.org/search/\*<< Kanji >>\*)` — those
    // escapes are the author's jisho wildcards, so they resolve to bare `*`.
    target: text.slice(closeLabel + 2, closeTarget).replace(/\\([\\*_])/g, "$1"),
    end: closeTarget + 1,
  };
}

/**
 * A word character, for the intraword-`_` rule. UNICODE-AWARE ON PURPOSE:
 * JavaScript's `\w` is `[A-Za-z0-9_]`, so an ASCII-only test would forbid
 * `a_b_c` from emphasising while happily emphasising `路_線_図` — the corpus is
 * 7,716 mostly-Japanese cards, and CommonMark's flanking rule is defined over
 * Unicode classes, not ASCII. `\p{L}` also covers kana and kanji, so an
 * underscore between two Japanese words is as literal as one between two
 * English words.
 */
const WORD = /[\p{L}\p{N}_]/u;

/** Closing index of a tightly flanked `*x*` / `_x_`, or -1. */
function flanked(text: string, open: number, marker: string, limit: number): number {
  const before = text[open - 1] ?? " ";
  const after = text[open + 1] ?? " ";
  if (after === marker || /\s/.test(after)) return -1;
  // Intraword `_` is a filename, not emphasis: `Copilot_Audio_20260122.mp3`.
  if (marker === "_" && WORD.test(before)) return -1;
  for (let i = open + 1; i < limit; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] !== marker) continue;
    if (/\s/.test(text[i - 1] ?? " ")) return -1;
    if (marker === "_" && WORD.test(text[i + 1] ?? " ")) return -1;
    return i;
  }
  return -1;
}

// ─── tags ────────────────────────────────────────────────────────────────────

/**
 * A tag, anchored at the start of the slice it is given.
 *
 * The attribute alternation accepts unquoted values — parser trap 3,
 * `<input value=<<NoComma>>>`, whose value is a bare marker — and the marker
 * characters fall inside the unquoted class, so nothing special is needed here.
 * A `<` that does not match this is literal text, which is what keeps `1 < 2`
 * and stray angle brackets out of the `unknown` bucket.
 */
const TAG =
  /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;

const ATTRIBUTE =
  /([A-Za-z_:][A-Za-z0-9_:.-]*)(?:[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

interface ParsedTag {
  readonly node: Inline;
  readonly end: number;
}

interface TagMatch {
  readonly whole: string;
  readonly closing: boolean;
  readonly name: string;
  readonly attrs: string;
  readonly selfClosing: boolean;
}

function matchTag(text: string, at: number): TagMatch | null {
  const match = TAG.exec(text.slice(at));
  if (match === null) return null;
  return {
    whole: match[0],
    closing: match[1] === "/",
    name: (match[2] as string).toLowerCase(),
    attrs: match[3] ?? "",
    selfClosing: match[4] === "/",
  };
}

function readTag(text: string, start: number, tokens: readonly FieldToken[]): ParsedTag | null {
  const tag = matchTag(text, start);
  if (tag === null) return null;
  const after = start + tag.whole.length;

  if (tag.closing) {
    return { node: { kind: "unknown", reason: "mismatched-close", text: tag.whole }, end: after };
  }

  const spec = elementSpec(tag.name);
  if (spec === null) {
    return { node: { kind: "unknown", reason: "unknown-element", text: tag.whole }, end: after };
  }

  const attributes = readAttributes(tag.attrs, tokens);
  if (spec.void || tag.selfClosing) {
    return {
      node: {
        kind: "element",
        name: tag.name,
        role: spec.role,
        attributes,
        children: [],
        selfClosing: true,
      },
      end: after,
    };
  }

  const close = findCloseTag(text, after, tag.name);
  if (close === null) {
    return { node: { kind: "unknown", reason: "unclosed-element", text: tag.whole }, end: after };
  }
  return {
    node: {
      kind: "element",
      name: tag.name,
      role: spec.role,
      attributes,
      children: parseInline(text.slice(after, close.at), tokens),
      selfClosing: false,
    },
    end: close.at + close.length,
  };
}

function readAttributes(raw: string, tokens: readonly FieldToken[]): Attribute[] {
  const out: Attribute[] = [];
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? match[4];
    out.push({
      name: match[1] as string,
      value: value === undefined ? null : splitMarkers(value, tokens),
    });
  }
  return out;
}

/** Where the `</name>` matching an already-consumed open tag starts, and how long it is. */
function findCloseTag(
  text: string,
  from: number,
  name: string,
): { readonly at: number; readonly length: number } | null {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const at = text.indexOf("<", i);
    if (at < 0) return null;
    const tag = matchTag(text, at);
    if (tag === null) {
      i = at + 1;
      continue;
    }
    if (tag.name === name) {
      if (tag.closing) {
        if (depth === 0) return { at, length: tag.whole.length };
        depth -= 1;
      } else if (!tag.selfClosing) {
        depth += 1;
      }
    }
    i = at + tag.whole.length;
  }
  return null;
}

/** Text of a `text`-only inline run. Convenience for tests and the resolver. */
export function textOf(nodes: readonly Inline[]): string {
  return nodes
    .filter((node): node is TextNode => node.kind === "text")
    .map((node) => node.text)
    .join("");
}
