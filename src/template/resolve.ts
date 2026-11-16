import { GENERATOR_FIELD_TYPES } from "../schema/index.js";
import {
  type Block,
  type Side,
  isSideEmpty,
} from "./ast.js";
import {
  type FieldToken,
  type MaskedSource,
  maskFields,
  parseContent,
  parseMaskedSide,
  readSectionMarker,
  splitMaskedSides,
  markerFor,
  normaliseLineEndings,
  stripMarkers,
  substituteMarkers,
  findSectionClose,
} from "./parse.js";

export interface TemplateFieldInput {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export function groupDigits(value: string, separator: string): string {
  const trimmed = value.trim();
  const match = /^([+-]?)(\d+)(\.\d+)?$/.exec(trimmed);
  if (match === null) return value;
  const [, sign = "", digits = "", fraction = ""] = match;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator) + fraction;
}

function separatorFor(options: Readonly<Record<string, unknown>> | undefined): string | null {
  const group = options?.["group"];
  if (typeof group !== "string" || group === "" || group === "none") return null;
  if (group === "comma") return ",";
  if (group === "space") return " ";
  return group;
}

export interface TemplateInput {
  readonly id?: string;
  readonly content: string;
  readonly fields?: readonly TemplateFieldInput[];
  readonly reversePermutation?: readonly number[] | null;
}

export interface CardInput {
  readonly id?: string;
  readonly content?: string;
  readonly values?: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
}

export type Direction = "forward" | "reverse";

export type WarningKind =
  | "unknown-field"
  | "boolean-interpolated"
  | "stray-section-marker"
  | "side-break-in-value"
  | "content-ignored"
  | "invalid-permutation"
  | "empty-side"
  | "generator-pending";

export interface ResolveWarning {
  readonly kind: WarningKind;
  readonly detail: string;
}

export interface ResolveOptions {
  readonly pendingGenerators?: boolean;
}

export interface RenderedCard {
  readonly sides: readonly Side[];
  readonly source: "template" | "content";
  readonly warnings: readonly ResolveWarning[];
}

export function valueMap(
  values: CardInput["values"],
): ReadonlyMap<string, string> {
  if (values === undefined) return new Map();
  return values instanceof Map ? values : new Map(Object.entries(values));
}

export function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const text = value.trim();
  return text !== "" && text !== "false";
}

export function booleanValue(
  value: string | undefined,
  options: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (value !== undefined && value.trim() !== "") return isTruthy(value);
  return options?.["boolean-default"] === true;
}

interface Lookup {
  readonly value: (name: string) => string | undefined;
  readonly type: (name: string) => string | undefined;
  readonly known: (name: string) => boolean;
  readonly flag: (name: string) => boolean;
}

function lookupFor(template: TemplateInput, card: CardInput): Lookup {
  const byName = new Map<string, TemplateFieldInput>();
  for (const field of template.fields ?? []) {
    const name = field.name.trim();
    if (name !== "" && !byName.has(name)) byName.set(name, field);
  }
  const values = valueMap(card.values);
  const resolve = (name: string): TemplateFieldInput | undefined =>
    byName.get(name.trim()) ?? (template.fields ?? []).find((field) => field.id === name.trim());
  return {
    value: (name) => {
      const field = resolve(name);
      if (field === undefined) return undefined;
      const raw = values.get(field.id);
      if (raw === undefined || field.type !== "number") return raw;
      const separator = separatorFor(field.options);
      return separator === null ? raw : groupDigits(raw, separator);
    },
    type: (name) => resolve(name)?.type,
    known: (name) => resolve(name) !== undefined,
    flag: (name) => {
      const field = resolve(name);
      return field === undefined ? false : booleanValue(values.get(field.id), field.options);
    },
  };
}

const SIDE_BREAK_LINE = /^[ \t]*-{3,}[ \t]*$/m;

function gateSections(
  lines: readonly string[],
  tokens: readonly FieldToken[],
  lookup: Lookup,
  warnings: ResolveWarning[],
): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const marker = readSectionMarker(line, tokens);
    if (marker === null) {
      out.push(line);
      i += 1;
      continue;
    }
    if (marker.sigil === "/") {
      warnings.push({ kind: "stray-section-marker", detail: marker.source });
      i += 1;
      continue;
    }
    const close = findSectionClose(lines, i + 1, marker.name, tokens);
    if (close < 0) {
      warnings.push({ kind: "stray-section-marker", detail: marker.source });
      i += 1;
      continue;
    }
    const truthy = lookup.flag(marker.name);
    const keep = marker.sigil === "^" ? !truthy : truthy;
    if (keep) {
      out.push(...gateSections(lines.slice(i + 1, close), tokens, lookup, warnings));
    }
    i = close + 1;
  }
  return out;
}

export interface ResolvedText {
  readonly texts: readonly string[];
  readonly warnings: readonly ResolveWarning[];
}

export function resolveSideTexts(
  card: CardInput,
  template: TemplateInput,
  options: ResolveOptions = {},
): ResolvedText {
  const warnings: ResolveWarning[] = [];
  const texts = resolveTexts(
    maskFields(template.content),
    lookupFor(template, card),
    warnings,
    options,
  );
  return { texts, warnings };
}

function resolveTexts(
  masked: MaskedSource,
  lookup: Lookup,
  warnings: ResolveWarning[],
  options: ResolveOptions = {},
): string[] {
  return splitMaskedSides(masked.text).map((side) => {
    const gated = gateSections(side.split("\n"), masked.tokens, lookup, warnings);
    return substituteMarkers(gated.join("\n"), masked.tokens, (token, index) => {
      if (token.sigil !== "") {
        warnings.push({ kind: "stray-section-marker", detail: token.source });
        return "";
      }
      if (!lookup.known(token.name)) {
        warnings.push({ kind: "unknown-field", detail: token.name });
        return markerFor(index);
      }
      if (lookup.type(token.name) === "boolean") {
        warnings.push({ kind: "boolean-interpolated", detail: token.name });
        return "";
      }
      const value = stripMarkers(lookup.value(token.name) ?? "");
      if (value === "" && GENERATOR_FIELD_TYPES.has(lookup.type(token.name) ?? "")) {
        warnings.push({ kind: "generator-pending", detail: token.name });
        if (options.pendingGenerators === true) return markerFor(index);
      }
      if (SIDE_BREAK_LINE.test(value)) {
        warnings.push({ kind: "side-break-in-value", detail: token.name });
      }
      return value;
    });
  });
}

export function resolveCard(
  card: CardInput,
  template?: TemplateInput | null,
  options: ResolveOptions = {},
): RenderedCard {
  const warnings: ResolveWarning[] = [];
  const content = card.content ?? "";

  let sides: Side[];
  let source: RenderedCard["source"];
  if (template === undefined || template === null) {
    sides = parseContent(content);
    source = "content";
  } else {
    if (content.trim() !== "") {
      warnings.push({ kind: "content-ignored", detail: card.id ?? "" });
    }
    const masked = maskFields(template.content);
    const lookup = lookupFor(template, card);
    sides = resolveTexts(masked, lookup, warnings, options).map((text, index) => ({
      index,
      blocks: parseMaskedSide(normaliseLineEndings(text), masked.tokens),
    }));
    source = "template";
  }

  for (const side of sides) {
    if (isSideEmpty(side)) warnings.push({ kind: "empty-side", detail: String(side.index) });
  }
  return { sides, source, warnings };
}

export function resolveSide(
  card: CardInput,
  template: TemplateInput,
  index: number,
  options: ResolveOptions = {},
): readonly Block[] {
  return resolveCard(card, template, options).sides[index]?.blocks ?? [];
}

export function parseReversePermutation(json: string | null | undefined): number[] | null {
  if (json === null || json === undefined || json.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    const indices = parsed.filter((entry): entry is number => Number.isInteger(entry));
    return indices.length === parsed.length ? indices : null;
  } catch {
    return null;
  }
}

export function isPermutation(permutation: readonly number[], count: number): boolean {
  if (permutation.length !== count) return false;
  const seen = new Set(permutation);
  if (seen.size !== count) return false;
  return permutation.every((index) => index >= 0 && index < count);
}

export function sideOrder(
  count: number,
  direction: Direction,
  permutation?: readonly number[] | null,
): number[] {
  const authored = Array.from({ length: count }, (_, index) => index);
  if (direction === "forward") return authored;
  if (permutation != null && isPermutation(permutation, count)) return [...permutation];
  return authored.reverse();
}

export function orderSides(
  sides: readonly Side[],
  direction: Direction,
  permutation?: readonly number[] | null,
): Side[] {
  const order = sideOrder(sides.length, direction, permutation);
  return order.flatMap((index) => {
    const side = sides[index];
    return side === undefined ? [] : [side];
  });
}

export function renderCard(
  card: CardInput,
  template: TemplateInput | null | undefined,
  direction: Direction,
  options: ResolveOptions = {},
): RenderedCard {
  const rendered = resolveCard(card, template, options);
  const permutation = template?.reversePermutation ?? null;
  const warnings = [...rendered.warnings];
  if (
    direction === "reverse" &&
    permutation !== null &&
    !isPermutation(permutation, rendered.sides.length)
  ) {
    warnings.push({ kind: "invalid-permutation", detail: JSON.stringify(permutation) });
  }
  return {
    sides: orderSides(rendered.sides, direction, permutation),
    source: rendered.source,
    warnings,
  };
}
