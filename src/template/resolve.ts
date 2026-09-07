/**
 * Stage 3 — the resolver: a template plus a card's field values becomes an
 * ordered list of sides, each a block AST.
 *
 * WHERE SIDES COME FROM. A card with a template takes its sides from the
 * template body; a template-less card takes them from its own `content` (1,694
 * `---` separators across 1,140 cards do exactly that). Either way the split
 * happens on the AUTHORED body, before interpolation, so the side count is a
 * property of the template and never of the data — which is what makes
 * `templates.reverse_permutation` well defined. See `HorizontalRuleNode` in
 * ast.ts for the single card whose field value argues the other way.
 *
 * ORDER OF OPERATIONS, fixed by SPEC's trap 2 and implemented in this order:
 *
 *   1. mask   `<<Field>>` tokens out of the raw body           (parse.ts)
 *   2. split  the masked body into sides on `---`              (parse.ts)
 *   3. gate   `<<#Field>>` / `<<^Field>>` sections, per side   (here)
 *   4. fill   the surviving markers with field values          (here)
 *   5. parse  each resolved side as content                    (parse.ts)
 *
 * Steps 1 and 4 straddle the markup parse, which is the whole point of trap 3:
 * `<input value=<<NoComma>>>` only tokenises correctly if the field is already
 * text by the time any tag is looked at.
 *
 * FIELDS ARE ADDRESSED BY NAME, VALUES BY ID. `<<Kanji>>` names the field whose
 * `name` is `Kanji`, while `card_field_values` is keyed by field *id* — and the
 * primary field's id is the literal string `name`, so the two namespaces really
 * do collide in the corpus. The lookup here is name-first with an id fallback.
 *
 * WHAT `content` MEANS ON A TEMPLATED CARD — MEASURED, NOT ASSUMED. 3,159 of the
 * 7,716 cards have both a template and non-empty `content`, and it is tempting
 * to treat that content as a render cache and use it as an oracle. It is not
 * one: interpolating each card's own template and comparing gives 0 exact
 * matches out of 3,159, and 0 even ignoring all whitespace. The content is
 * stale text from before the card was templated — it still carries the
 * hand-written `<speech lang="en">…</speech>` tags the author later replaced
 * with fields, sometimes with a different language than the template now uses.
 * So the template wins, and `resolveCard` reports `content-ignored` rather than
 * silently discarding 3,159 cards' worth of authored text.
 */

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

// ─── inputs ──────────────────────────────────────────────────────────────────

/** A `template_fields` row, as much of it as the resolver needs. */
export interface TemplateFieldInput {
  readonly id: string;
  readonly name: string;
  /** `template_fields.type`. `boolean` and `number` change behaviour here. */
  readonly type?: string;
  /**
   * `template_fields.options`, decoded. `LoadedField` already carries it, so this
   * flows through for free — only `number` reads it, and only for `group`.
   */
  readonly options?: Readonly<Record<string, unknown>>;
}

/**
 * Thousands separators for a `number` field — Zach, 2026-09-07.
 *
 * *"i don't need two field of comma and number, we can just have no comma field,
 * and the template let me choose a display type of rendering comma"*. He is right
 * about where the line is: **a comma is presentation and the number is the data**,
 * and 数字 stored both because Mochi could not render one from the other.
 *
 * ─── WHY IT FORMATS AT SUBSTITUTION AND NOT IN THE RENDERER ─────────────────
 *
 * This is the lesson decision 20 taught, applied before it costs anything. A
 * resolved plain field is substituted to TEXT before the render, so nothing
 * downstream knows `平板` came from `型` — which is why `型`'s gating had to move
 * into the template. The same is true here: by the time the renderer sees
 * `124652706` it is a string like any other. The type is only known HERE.
 *
 * ─── AND IT KEEPS THE 89 EXISTING CLIPS RESOLVING ───────────────────────────
 *
 * Decision 7: a generator's input is the RENDERED text. 数字's `Voice` is a speech
 * field whose source is the primary field, and its 89 clips carry
 * `source_text = "124,652,706"` — the comma'd form. Formatting at substitution
 * means the generator still sees commas, so the generation key is unchanged and
 * nothing is re-billed. Stripping the commas from storage WITHOUT this would have
 * changed every key.
 *
 * `group` is opt-in per field rather than automatic for every `number`, because
 * "render 1999 as 1,999" is wrong for a year and this is a display choice he asked
 * to make in the template.
 */
export function groupDigits(value: string, separator: string): string {
  const trimmed = value.trim();
  // Digits only, optionally signed, optionally with a decimal part. Anything else
  // is returned untouched: a `number` field holding `n/a` must not be mangled, and
  // only the INTEGER part is grouped — `1234.5678` is `1,234.5678`, never
  // `1,234.567,8`.
  const match = /^([+-]?)(\d+)(\.\d+)?$/.exec(trimmed);
  if (match === null) return value;
  const [, sign = "", digits = "", fraction = ""] = match;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator) + fraction;
}

/** `options.group`: `"comma"`, `"space"`, or any literal separator. */
function separatorFor(options: Readonly<Record<string, unknown>> | undefined): string | null {
  const group = options?.["group"];
  if (typeof group !== "string" || group === "" || group === "none") return null;
  if (group === "comma") return ",";
  if (group === "space") return " "; // a thin space, which is what typography wants
  return group;
}

/** A `templates` row. */
export interface TemplateInput {
  readonly id?: string;
  /** `templates.content` — the body, with `---` separating sides. */
  readonly content: string;
  readonly fields?: readonly TemplateFieldInput[];
  /** `templates.reverse_permutation`, decoded. Null = the authored order reversed. */
  readonly reversePermutation?: readonly number[] | null;
}

/** A `cards` row plus its `card_field_values`. */
export interface CardInput {
  readonly id?: string;
  /** `cards.content`. The source of sides when there is no template. */
  readonly content?: string;
  /** field id -> value text. */
  readonly values?: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
}

export type Direction = "forward" | "reverse";

export type WarningKind =
  /** `<<Foo>>` names no field on the template; the reference is left verbatim. */
  | "unknown-field"
  /** A boolean field interpolated as text. Gates are not values. */
  | "boolean-interpolated"
  /** A section marker that was not alone on its line, or never closed. */
  | "stray-section-marker"
  /** A field value carried a `---` line; it renders as a rule, not a new side. */
  | "side-break-in-value"
  /** A templated card also carries authored `content`, which is not rendered. */
  | "content-ignored"
  /** `reverse_permutation` was not a permutation of the side indices. */
  | "invalid-permutation"
  /** A side resolved to nothing visible. 単語's first side does this by design. */
  | "empty-side"
  /**
   * A generator-typed field with no stored value. NOT an error: Mochi keeps
   * generated content in `component-cache` keyed by input text, so all 19
   * generator-typed fields in the corpus are empty and every one of them is
   * this. The marker is left standing so the reference survives into the AST as
   * a `field` node, where `expandGeneratorFields` in `src/generate/fields.ts`
   * can turn it into a generation request. Substituting the empty string is what
   * made 3,456 単語 cards with a clip render no `<audio>` at all.
   */
  | "generator-pending";

export interface ResolveWarning {
  readonly kind: WarningKind;
  /** Field name, side index or offending text — whatever names the site. */
  readonly detail: string;
}

/** How to treat a generator-typed field that has no stored value. */
export interface ResolveOptions {
  /**
   * Keep the `<<Field>>` marker standing for a valueless GENERATOR field, so it
   * survives into the AST as a `field` node for `expandGeneratorFields` to turn
   * into a generation request.
   *
   * Default FALSE, and the default is the important half. Opting in changes what
   * a card looks like: an unexpanded render then shows the literal text
   * `<<Speech>>` on 18,515 field slots, which trades silence for visible junk.
   * So only a caller that will run the expansion may ask for it — the flag is
   * effectively "I am the generation pipeline".
   *
   * The `generator-pending` WARNING is emitted either way. The debt is real
   * whether or not this caller intends to settle it, and a silent default is
   * what hid the whole defect for eight drafts.
   */
  readonly pendingGenerators?: boolean;
}

export interface RenderedCard {
  /** Authored order, one entry per side the body declares. */
  readonly sides: readonly Side[];
  readonly source: "template" | "content";
  readonly warnings: readonly ResolveWarning[];
}

// ─── field values ────────────────────────────────────────────────────────────

/** `card_field_values` in either shape, as a map. */
export function valueMap(
  values: CardInput["values"],
): ReadonlyMap<string, string> {
  if (values === undefined) return new Map();
  return values instanceof Map ? values : new Map(Object.entries(values));
}

/**
 * Truthiness for `<<#Field>>`.
 *
 * `card_field_values.value` is TEXT and `src/import/entities.ts` writes booleans
 * as the strings `"true"` / `"false"`, so `"false"` has to be falsey or every
 * unchecked checkbox in the corpus reads as set. 1,599 of the 22,319 field
 * values are booleans.
 */
export function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const text = value.trim();
  return text !== "" && text !== "false";
}

interface Lookup {
  readonly value: (name: string) => string | undefined;
  readonly type: (name: string) => string | undefined;
  readonly known: (name: string) => boolean;
}

function lookupFor(template: TemplateInput, card: CardInput): Lookup {
  const byName = new Map<string, TemplateFieldInput>();
  for (const field of template.fields ?? []) {
    const name = field.name.trim();
    if (name !== "" && !byName.has(name)) byName.set(name, field);
  }
  const values = valueMap(card.values);
  const resolve = (name: string): TemplateFieldInput | undefined =>
    // Name first, then id: `<<Kanji>>` is a name, but the primary field's id is
    // the literal "name", so an id fallback must not shadow a real field.
    byName.get(name.trim()) ?? (template.fields ?? []).find((field) => field.id === name.trim());
  return {
    value: (name) => {
      const field = resolve(name);
      if (field === undefined) return undefined;
      const raw = values.get(field.id);
      if (raw === undefined || field.type !== "number") return raw;
      // ONE PLACE, so every interpolation path agrees: the body, a cloze, and a
      // generator's prompt input (decision 7). See `groupDigits`.
      const separator = separatorFor(field.options);
      return separator === null ? raw : groupDigits(raw, separator);
    },
    type: (name) => resolve(name)?.type,
    known: (name) => resolve(name) !== undefined,
  };
}

// ─── section gating ──────────────────────────────────────────────────────────

const SIDE_BREAK_LINE = /^[ \t]*-{3,}[ \t]*$/m;

/**
 * Drop the lines a `<<#Field>>` / `<<^Field>>` section excludes.
 *
 * Block-level, matching `parseTemplate`: a marker counts only when it is alone
 * on its line, which is true of all 8 markers in the corpus. Sections never
 * straddle a `---` in the real templates — 単語 opens and closes twice, both
 * times inside one side — and because sides are split first, one that tried to
 * would leave its opener unmatched and be reported rather than guessed at.
 */
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
    const truthy = isTruthy(lookup.value(marker.name));
    const keep = marker.sigil === "^" ? !truthy : truthy;
    if (keep) {
      out.push(...gateSections(lines.slice(i + 1, close), tokens, lookup, warnings));
    }
    i = close + 1;
  }
  return out;
}


// ─── resolving ───────────────────────────────────────────────────────────────

export interface ResolvedText {
  /** One entry per side the body declares, in authored order. */
  readonly texts: readonly string[];
  readonly warnings: readonly ResolveWarning[];
}

/**
 * The resolved TEXT of each side, before markup parsing.
 *
 * Public because stage 9 needs exactly this: a `speech` field's cache key is its
 * resolved text, and the inline `<speech>` tags in card content have to hash the
 * same way — SPEC, "one cache, two callers".
 */
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
        // Leave the marker standing so the reference survives as a `field` node
        // rather than as the literal text `<<Nope>>`, which would be re-lexed as
        // a `<Nope>` tag and reported as an unknown element. A typo the author
        // can see beats text that silently vanishes.
        warnings.push({ kind: "unknown-field", detail: token.name });
        return markerFor(index);
      }
      if (lookup.type(token.name) === "boolean") {
        // A checkbox gates `<<#Field>>`; it is not text. No template in the
        // corpus interpolates one, so this is defence, not behaviour.
        warnings.push({ kind: "boolean-interpolated", detail: token.name });
        return "";
      }
      // Markers are stripped from the value, not from the body: a value that
      // happened to contain one must not be able to forge a field reference.
      const value = stripMarkers(lookup.value(token.name) ?? "");
      if (value === "" && GENERATOR_FIELD_TYPES.has(lookup.type(token.name) ?? "")) {
        // This module cannot open a database, so it cannot resolve the
        // generation; what it CAN do is refuse to delete the evidence that one
        // is owed. The warning always fires; the marker only stands for a caller
        // that has said it will expand it.
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

/**
 * A card's sides, in authored order.
 *
 * Pass `template` as null for a template-less card; its `content` then supplies
 * the sides. 370 cards in the corpus are in that shape, 349 of them with a `---`.
 */
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
      // Tokens are still passed in: any marker left standing is an unresolved
      // reference, and stays a `field` node.
      blocks: parseMaskedSide(normaliseLineEndings(text), masked.tokens),
    }));
    source = "template";
  }

  for (const side of sides) {
    if (isSideEmpty(side)) warnings.push({ kind: "empty-side", detail: String(side.index) });
  }
  return { sides, source, warnings };
}

/** Just the blocks of one resolved side. Handy in tests. */
export function resolveSide(
  card: CardInput,
  template: TemplateInput,
  index: number,
  options: ResolveOptions = {},
): readonly Block[] {
  return resolveCard(card, template, options).sides[index]?.blocks ?? [];
}

// ─── direction ───────────────────────────────────────────────────────────────

/**
 * `templates.reverse_permutation`, which the schema stores as a JSON array of
 * 0-based side indices. Null, absent or malformed all mean "the authored order
 * reversed", which is SPEC's locked default and reproduces Mochi exactly.
 */
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

/** True when `permutation` is a rearrangement of exactly `0…count-1`. */
export function isPermutation(permutation: readonly number[], count: number): boolean {
  if (permutation.length !== count) return false;
  const seen = new Set(permutation);
  if (seen.size !== count) return false;
  return permutation.every((index) => index >= 0 && index < count);
}

/**
 * The order sides are shown in.
 *
 * SPEC, locked: "Forward is the authored order. Reverse is a declared
 * permutation, defaulting to the reversed list." The default is what makes
 * whole-card flip work for the four-side templates: side 4 of 単語 is 意味 plus
 * the emoji hint, so showing it first asks for production rather than
 * recognition, which is what a reverse track is for.
 */
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

/**
 * Reorder resolved sides for a direction. `Side.index` keeps the authored
 * position; the array order is the presentation order, so nothing has to be
 * renumbered and the renderer can still say which side of the template it is on.
 */
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

/** A rendered card in one direction, with a warning if the permutation is junk. */
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
