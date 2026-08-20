/**
 * Generator-typed FIELDS — the binding that made the app silent.
 *
 * Mochi keeps generated content in `component-cache`, keyed by the generator's
 * INPUT TEXT, and never in `fields[].value`. So all 19 generator-typed fields
 * across the 11 templates hold zero values, `<<Speech>>` resolves to the empty
 * string, and 3,456 単語 cards that own a clip render no `<audio>` at all.
 *
 * This module is the missing half: it turns a valueless generator field back
 * into a generation REQUEST, so the same on-demand `lookupGeneration` path the
 * inline `<speech>` tags use can find the blob that already exists.
 *
 * THREE THINGS HERE WERE MEASURED, NOT REASONED. Each one is a silent
 * whole-template failure if guessed wrong, and each was found by reconstructing
 * a key and checking it against the store over all 7,346 templated cards:
 *
 *   1. THE INPUT IS THE *RENDERED* TEXT, NOT THE STORED VALUE. 基本情報's cache
 *      key is `データ` where the field value is `{{データ}}` — cloze braces come
 *      off, wiki-links reduce to their display text, invisible marks go. Getting
 *      this wrong cost 基本情報 all 471 of its cards (0 hits) and moved the
 *      corpus-wide hit rate from 92.29% to 95.35%.
 *   2. ONLY SOME OPTIONS ARE PART OF THE KEY. Mochi's cache key carries
 *      `ai-task` / `gender` / `from` / `to` / `language`, and never
 *      `ai-custom-prompt` or `randomize`. Measured from the blob census: no blob
 *      in the corpus has a prompt in its `options`.
 *   3. THE PROMPT SUBSTITUTION TOLERATES SPACES. Polysemy's prompt is
 *      `Funny or weird sentence using << 言葉 >> in Japanese` — with spaces
 *      inside the marker. An anchored `<<(\w+)>>` finds nothing there.
 *
 * WHAT IS NOT HERE: no HTTP, no generation, no playback. This builds requests
 * and expands AST; `./store.ts` looks them up. Nothing in this file can start
 * audio, which is the point — see `src/render/reveal.ts`.
 */

import { FIELD_TYPE_BLOB_KIND, GENERATOR_FIELD_TYPES, type BlobKind } from "../schema/index.js";
import { renderPlainText } from "../text/index.js";
import {
  ELEMENTS,
  plainInterpolation,
  type Attribute,
  type ElementNode,
  type Inline,
  type Node,
  type Side,
} from "../template/index.js";

// ─── which field types generate ──────────────────────────────────────────────

/**
 * Re-exported, not redefined. `src/schema/index.ts` owns the table because
 * `src/template/resolve.ts` needs the same one to tell "pending" from "blank",
 * and two copies is how those two come to disagree.
 */
export { FIELD_TYPE_BLOB_KIND, GENERATOR_FIELD_TYPES } from "../schema/index.js";

/** Does this `template_fields.type` produce content rather than hold it? */
export function isGeneratorType(type: string | undefined): boolean {
  return type !== undefined && GENERATOR_FIELD_TYPES.has(type);
}

/** The element name a generator field expands to, for the renderer's benefit. */
const KIND_ELEMENT: Readonly<Record<BlobKind, string>> = {
  speech: "speech",
  ai: "ai",
  translate: "translate",
  furigana: "furigana",
  dictionary: "dictionary",
  image: "image",
  file: "ai",
};

// ─── the generation input ────────────────────────────────────────────────────

/**
 * `{{…}}` with its braces removed and its contents kept.
 *
 * Not a general cloze parser: `src/template/parse.ts` owns that. This is the
 * narrow transform Mochi applied before hashing, and the inner pattern excludes
 * braces so a nested form cannot swallow a neighbour.
 */
const CLOZE_BRACES = /\{\{(?:\d+::)?([^{}]*)\}\}/g;

/**
 * A stored field value -> the text the generator was actually given.
 *
 * `renderPlainText` is the same transform `cards.search_text` uses, so there is
 * one definition of "what this card says" rather than two that drift. Cloze
 * braces are stripped on top of it, which search does not need to do because a
 * brace is not a trigram anyone types.
 *
 * NFC and whitespace collapsing are deliberately NOT done here —
 * `normaliseSourceText` in `src/import/blobs.ts` owns those, and doing them
 * twice in two places is how two spellings of one key appear.
 */
export function generationInput(value: string): string {
  return renderPlainText(value).replace(CLOZE_BRACES, "$1");
}

// ─── building a request from a field ─────────────────────────────────────────

/** A `template_fields` row, as much of it as this module needs. */
export interface GeneratorField {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** `template_fields.source_field_id`. Null is legitimate — see the schema. */
  readonly sourceFieldId?: string | null;
  /** `template_fields.options`, decoded. */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** Everything a request needs that does not come from the field itself. */
export interface FieldContext {
  /** Every field on the template, so a source pointer and a prompt can resolve. */
  readonly fields: readonly GeneratorField[];
  /** field id -> stored value. Generator fields are absent or empty here. */
  readonly values: ReadonlyMap<string, string>;
  /**
   * The text an UPSTREAM generator produced, for the 3,467 cards where 単語's
   * `Audio` reads the sentence `例文` generated. Returns null when it is not
   * available, and the request is then unbuildable rather than wrong.
   */
  readonly resolveGenerated?: (request: FieldGenerationRequest) => string | null;
}

/** A request in the shape `generationIdentity` takes, plus its provenance. */
export interface FieldGenerationRequest {
  readonly kind: BlobKind;
  /** RAW input text. `generationIdentity` normalises; this must not. */
  readonly text: string;
  readonly voice: string | null;
  readonly lang: string | null;
  readonly options: Readonly<Record<string, string>>;
  /** Which field this is for, so a diagnostic can name it. */
  readonly fieldId: string;
  readonly fieldName: string;
}

/**
 * Options that are NOT part of Mochi's cache key.
 *
 * Measured, not assumed: across 42,569 blob identities not one carries
 * `ai-custom-prompt` or `randomize`. `lang` and `voice` are excluded because
 * `generationIdentity` gives them their own slots — leaving them in would hash
 * them twice.
 */
const NON_KEY_OPTIONS: ReadonlySet<string> = new Set([
  "ai-custom-prompt",
  "randomize",
  "lang",
  "voice",
]);

/** `<<Field>>`, `<< Field >>`. Polysemy's prompt really has the spaces. */
const PROMPT_MARKER = /<<\s*([^<>]+?)\s*>>/g;

function keyOptions(options: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    // `null` is not the same as absent to JSON but IS the same to Mochi: `New
    // Vocab`'s Pronunciation carries `"gender": null` and its blobs carry no
    // gender at all.
    if (NON_KEY_OPTIONS.has(name) || value === null || value === undefined) continue;
    out[name] = String(value);
  }
  return out;
}

const MAX_DEPTH = 4;

/**
 * The generation request for one generator-typed field, or null when its input
 * cannot be resolved.
 *
 * Null is a real answer and is counted, not swallowed: 159 of the corpus's
 * 18,356 field slots have no resolvable input — an empty source value, or an
 * upstream generation that is itself unavailable. A request built on empty text
 * would hash to a key nothing can ever match, so refusing to build one is what
 * keeps the miss diagnostic meaningful.
 */
export function fieldGenerationRequest(
  field: GeneratorField,
  context: FieldContext,
  depth = 0,
): FieldGenerationRequest | null {
  const kind = FIELD_TYPE_BLOB_KIND[field.type];
  if (kind === undefined) return null;
  const options = field.options ?? {};

  const text =
    field.type === "ai"
      ? promptText(options, context, depth)
      : sourceText(field, context, depth);
  if (text === null || text.trim() === "") return null;

  const voice = options["voice"];
  const lang = options["lang"];
  return {
    kind,
    text,
    voice: typeof voice === "string" && voice !== "" ? voice : null,
    lang: typeof lang === "string" && lang !== "" ? lang : null,
    options: keyOptions(options),
    fieldId: field.id,
    fieldName: field.name,
  };
}

/**
 * An `ai` field's input is its rendered PROMPT, not a source field.
 *
 * Four of the 19 fields have `source_field_id = NULL` for exactly this reason —
 * their dependency is named only inside the prompt text, which is why the schema
 * warns that a DAG built from `source_field_id` alone is incomplete.
 */
function promptText(
  options: Readonly<Record<string, unknown>>,
  context: FieldContext,
  depth: number,
): string | null {
  const prompt = options["ai-custom-prompt"];
  if (typeof prompt !== "string") return null;
  let resolved = true;
  const text = prompt.replace(PROMPT_MARKER, (_match, name: string) => {
    const dependency = context.fields.find((f) => f.name === name);
    const value = dependency === undefined ? null : fieldText(dependency, context, depth);
    if (value === null) {
      resolved = false;
      return "";
    }
    return value;
  });
  return resolved ? text : null;
}

/** A non-`ai` generator reads the field its `source_field_id` names. */
function sourceText(
  field: GeneratorField,
  context: FieldContext,
  depth: number,
): string | null {
  const sourceId = field.sourceFieldId ?? null;
  if (sourceId === null) return null;
  const source = context.fields.find((f) => f.id === sourceId);
  return source === undefined ? null : fieldText(source, context, depth);
}

/**
 * A field's text, following the generation DAG.
 *
 * 単語's `Audio` reads `例文`, which is itself an `ai` field with no value, so
 * the sentence has to come back out of the store before the speech request can
 * be built. Depth-limited because `source_field_id` is only guaranteed acyclic
 * by a CHECK against self-reference, not against a longer cycle.
 */
function fieldText(field: GeneratorField, context: FieldContext, depth: number): string | null {
  const stored = context.values.get(field.id);
  if (stored !== undefined && stored !== "") return generationInput(stored);
  if (depth >= MAX_DEPTH || !isGeneratorType(field.type)) return null;
  if (context.resolveGenerated === undefined) return null;
  const request = fieldGenerationRequest(field, context, depth + 1);
  if (request === null) return null;
  const produced = context.resolveGenerated(request);
  return produced === null || produced === "" ? null : produced;
}

// ─── expanding the AST ───────────────────────────────────────────────────────

/**
 * A `field` node for a valueless generator field -> a synthetic generator
 * ELEMENT node, so the renderer's existing `<speech>` path renders it.
 *
 * Built as an AST node, never as a string. Splicing `<speech>…</speech>` into
 * resolved text would put a field value through the lexer, and a value
 * containing `<` could then forge markup — the one thing `src/render/dom.ts`
 * exists to make impossible. This route cannot: the input text becomes a `text`
 * node, and `sanitiseElement` still vets the attributes.
 *
 * Reusing the element path is also what keeps the no-autoplay guarantee intact
 * for free. The `<audio>` these produce is the same one `renderGenerator`
 * builds: no `src`, no `autoplay`, `preload="none"`.
 */
export function expandGeneratorFields(
  sides: readonly Side[],
  context: FieldContext,
): {
  readonly sides: readonly Side[];
  readonly expanded: readonly FieldGenerationRequest[];
  /**
   * Key options the element allowlist will not carry, as `field/option`.
   *
   * These are the ONE way this module can go quietly wrong: an option that is
   * part of the identity but cannot ride on the synthetic element makes the
   * renderer's own `GenerationDescriptor` hash to a different key than the
   * request beside it, and the two would disagree with nothing to show for it.
   * Zero over the reference corpus — no field carries `language`, the only key
   * option no generator element allows — and pinned by a test that says so.
   */
  readonly divergent: readonly string[];
} {
  const expanded: FieldGenerationRequest[] = [];
  const divergent: string[] = [];
  const byName = new Map(context.fields.map((f) => [f.name, f]));

  const rewrite = (node: Node): Node => {
    if (node.kind === "field") {
      const field = byName.get(node.name);
      if (field === undefined || !isGeneratorType(field.type)) return node;
      const request = fieldGenerationRequest(field, context);
      if (request === null) return node;
      expanded.push(request);
      const built = generatorElement(request);
      for (const name of built.dropped) divergent.push(`${request.fieldName}/${name}`);
      return built.element;
    }
    return mapChildren(node, rewrite);
  };

  const out = sides.map((s) => ({
    index: s.index,
    blocks: s.blocks.map((b) => rewrite(b) as (typeof s.blocks)[number]),
  }));
  return { sides: out, expanded, divergent };
}

/**
 * The synthetic node. `role: "generator"` matches what `parse.ts` assigns.
 *
 * Attributes are filtered through the SAME allowlist the sanitiser applies, so
 * the element carries exactly what survives and produces no `attribute-dropped`
 * diagnostic. A dropped one would read as a defect in the card rather than as a
 * deliberate omission here — so anything genuinely lost is returned instead.
 */
function generatorElement(request: FieldGenerationRequest): {
  readonly element: ElementNode;
  readonly dropped: readonly string[];
} {
  const name = KIND_ELEMENT[request.kind];
  const allowed = ELEMENTS[name]?.attributes ?? [];
  const permits = (attribute: string): boolean =>
    allowed === "*" || allowed.some((a) => a.toLowerCase() === attribute);

  const attributes: Attribute[] = [];
  const dropped: string[] = [];
  const put = (attribute: string, value: string): void => {
    if (permits(attribute)) attributes.push({ name: attribute, value: plainInterpolation(value) });
    else dropped.push(attribute);
  };
  if (request.lang !== null) put("lang", request.lang);
  if (request.voice !== null) put("voice", request.voice);
  for (const [option, value] of Object.entries(request.options)) put(option, value);

  return {
    element: {
      kind: "element",
      name,
      role: "generator",
      attributes,
      children: [{ kind: "text", text: request.text }] as readonly Inline[],
      selfClosing: false,
    },
    dropped,
  };
}

/**
 * Rebuild a node with its children mapped. Returns the node itself when nothing
 * changed, so an untouched card's AST is reference-identical and a caller can
 * tell expansion happened without diffing.
 */
function mapChildren(node: Node, map: (child: Node) => Node): Node {
  const record = node as unknown as Record<string, unknown>;
  const children = record["children"];
  if (!Array.isArray(children)) return node;
  let changed = false;
  const mapped = (children as readonly Node[]).map((child) => {
    const next = map(child);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? ({ ...node, children: mapped } as Node) : node;
}
