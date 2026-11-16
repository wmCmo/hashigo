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
import { startsTag, tagEnd } from "./tag.js";
import { stripInvisible } from "../text/index.js";

const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";

export const FIELD_TOKEN = /<<[ \t]*([#^/]?)[ \t]*([^>]+?)[ \t]*>>/g;

export type FieldSigil = "" | "#" | "^" | "/";

export interface FieldToken {
  readonly sigil: FieldSigil;
  readonly name: string;
  readonly source: string;
}

export interface MaskedSource {
  readonly text: string;
  readonly tokens: readonly FieldToken[];
}

export function fieldRefs(text: string): FieldToken[] {
  return maskFields(text).tokens.filter((token) => token.sigil !== "/");
}

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

export function normaliseLineEndings(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

export function normaliseSource(source: string): string {
  return stripMarkers(normaliseLineEndings(source));
}

export function markerFor(index: number): string {
  return `${MARK_OPEN}${index}${MARK_CLOSE}`;
}

const MARKER_GLOBAL = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
const MARKER_ONLY = new RegExp(`^${MARK_OPEN}(\\d+)${MARK_CLOSE}$`);

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

export function readSectionMarker(line: string, tokens: readonly FieldToken[]): FieldToken | null {
  const match = MARKER_ONLY.exec(line.trim());
  if (match === null) return null;
  const token = tokens[Number(match[1])];
  return token !== undefined && token.sigil !== "" ? token : null;
}

const SIDE_BREAK = /^[ \t]*-{3,}[ \t]*$/;
const HORIZONTAL_RULE = /^[ \t]*_{3,}[ \t]*$/;

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

export function sideCount(body: string): number {
  return splitMaskedSides(maskFields(body).text).length;
}

export function parseTemplate(body: string): Side[] {
  const masked = maskFields(body);
  return splitMaskedSides(masked.text).map((text, index) => ({
    index,
    blocks: parseMaskedSide(text, masked.tokens),
  }));
}

export function parseContent(text: string): Side[] {
  return splitMaskedSides(normaliseSource(text)).map((side, index) => ({
    index,
    blocks: parseMaskedSide(side, []),
  }));
}

export function parseFieldValue(value: string): Block[] {
  return parseMaskedSide(normaliseSource(value), []);
}

export function parseMaskedSide(text: string, tokens: readonly FieldToken[]): Block[] {
  return parseBlocks(text.split("\n"), tokens);
}

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

    const paragraph: string[] = [];
    while (i < lines.length && !startsBlock(at(i), at(i + 1), tokens)) {
      paragraph.push(at(i));
      i += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n"), tokens) });
  }

  return blocks;
}

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

export function findSectionClose(
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

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!$|<>~"']/;

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
  const lineEnd = (from: number): number => {
    const at = text.indexOf("\n", from);
    return at < 0 ? text.length : at;
  };
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

    if (ch === "#" && startsTag(text, i)) {
      const end = tagEnd(text, i + 1);
      if (end > i + 1) {
        const source = text.slice(i, end);
        push({ kind: "tag", path: stripInvisible(source.slice(1)), source });
        i = end;
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

    if (rest === "**" || rest === "__") {
      const marker = rest as "**" | "__";
      const close = find(marker, i + 2);
      if (close > i + 2) {
        push({ kind: "strong", marker, children: parseInline(text.slice(i + 2, close), tokens) });
        i = close + 2;
        continue;
      }
    }

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
    target: text.slice(closeLabel + 2, closeTarget).replace(/\\([\\*_])/g, "$1"),
    end: closeTarget + 1,
  };
}

const WORD = /[\p{L}\p{N}_]/u;

function flanked(text: string, open: number, marker: string, limit: number): number {
  const before = text[open - 1] ?? " ";
  const after = text[open + 1] ?? " ";
  if (after === marker || /\s/.test(after)) return -1;
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

export function textOf(nodes: readonly Inline[]): string {
  return nodes
    .filter((node): node is TextNode => node.kind === "text")
    .map((node) => node.text)
    .join("");
}
