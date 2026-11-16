import { NON_KEY_OPTIONS } from "../fields/identity.js";
import { FIELD_TYPE_BLOB_KIND, GENERATOR_FIELD_TYPES, type BlobKind } from "../schema/index.js";
import { groupDigits } from "../template/resolve.js";
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

export { FIELD_TYPE_BLOB_KIND, GENERATOR_FIELD_TYPES } from "../schema/index.js";

export function isGeneratorType(type: string | undefined): boolean {
  return type !== undefined && GENERATOR_FIELD_TYPES.has(type);
}

const KIND_ELEMENT: Readonly<Record<BlobKind, string>> = {
  speech: "speech",
  ai: "ai",
  translate: "translate",
  furigana: "furigana",
  dictionary: "dictionary",
  image: "image",
  file: "ai",
};

const CLOZE_BRACES = /\{\{(?:\d+::)?([^{}]*)\}\}/g;

export function generationInput(value: string): string {
  return renderPlainText(value).replace(CLOZE_BRACES, "$1");
}

export interface GeneratorField {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId?: string | null;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface FieldContext {
  readonly fields: readonly GeneratorField[];
  readonly values: ReadonlyMap<string, string>;
  readonly resolveGenerated?: (request: FieldGenerationRequest) => string | null;
  readonly voiceOverride?: string | null;
}

function sameLanguage(voice: string, lang: string | null): boolean {
  if (lang === null || lang === "") return false;
  return voice.slice(0, 2).toLowerCase() === lang.slice(0, 2).toLowerCase();
}

export interface FieldGenerationRequest {
  readonly kind: BlobKind;
  readonly text: string;
  readonly voice: string | null;
  readonly lang: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly fieldId: string;
  readonly fieldName: string;
}

export { NON_KEY_OPTIONS };

const PROMPT_MARKER = /<<\s*([^<>]+?)\s*>>/g;

function keyOptions(options: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    if (NON_KEY_OPTIONS.has(name) || value === null || value === undefined) continue;
    out[name] = String(value);
  }
  return out;
}

const MAX_DEPTH = 4;

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
  const fieldLang = typeof lang === "string" && lang !== "" ? lang : null;
  const override = context.voiceOverride ?? null;
  const overridden =
    field.type === "speech" && override !== null && override !== "" && sameLanguage(override, fieldLang);
  return {
    kind,
    text,
    voice: overridden ? override : typeof voice === "string" && voice !== "" ? voice : null,
    lang: fieldLang,
    options: keyOptions(options),
    fieldId: field.id,
    fieldName: field.name,
  };
}

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

function renderedValue(field: GeneratorField, stored: string): string {
  if (field.type !== "number") return stored;
  const group = field.options?.["group"];
  if (typeof group !== "string" || group === "" || group === "none") return stored;
  return groupDigits(stored, group === "comma" ? "," : group === "space" ? " " : group);
}

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

const INLINE_GENERATOR = /<(ai|translate)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
const INLINE_ATTRIBUTE = /([A-Za-z-]+)\s*=\s*"([^"]*)"/g;

function resolveInlineGenerators(stored: string, context: FieldContext): string | null {
  if (!stored.includes("<ai") && !stored.includes("<translate")) return stored;
  if (context.resolveGenerated === undefined) return null;
  let unresolved = false;
  const out = stored.replace(INLINE_GENERATOR, (_match, tag: string, attrs: string | undefined, inner: string) => {
    let lang: string | null = null;
    let voice: string | null = null;
    const options: Record<string, string> = {};
    for (const [, name, value] of (attrs ?? "").matchAll(INLINE_ATTRIBUTE)) {
      const lower = (name as string).toLowerCase();
      if (lower === "lang") lang = value === "" ? null : (value as string);
      else if (lower === "voice") voice = value === "" ? null : (value as string);
      else options[lower] = value as string;
    }
    const produced = context.resolveGenerated?.({
      kind: tag as BlobKind,
      text: inner.includes("<") ? renderPlainText(inner) : inner,
      voice,
      lang,
      options,
      fieldId: "",
      fieldName: "",
    });
    if (produced === null || produced === undefined || produced === "") {
      unresolved = true;
      return "";
    }
    return produced;
  });
  return unresolved ? null : out;
}

function fieldText(field: GeneratorField, context: FieldContext, depth: number): string | null {
  const raw = context.values.get(field.id);
  const stored = raw === undefined || raw === "" ? raw : resolveInlineGenerators(raw, context);
  if (stored === null) return null;
  if (stored !== undefined && stored !== "") return generationInput(renderedValue(field, stored));
  if (depth >= MAX_DEPTH || !isGeneratorType(field.type)) return null;
  if (context.resolveGenerated === undefined) return null;
  const request = fieldGenerationRequest(field, context, depth + 1);
  if (request === null) return null;
  const produced = context.resolveGenerated(request);
  return produced === null || produced === "" ? null : produced;
}

export function expandGeneratorFields(
  sides: readonly Side[],
  context: FieldContext,
): {
  readonly sides: readonly Side[];
  readonly expanded: readonly FieldGenerationRequest[];
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
