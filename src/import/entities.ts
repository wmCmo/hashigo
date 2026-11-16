import {
  FIELD_TYPES,
  type FieldType,
  resolveReverseInheritance,
  type ReverseInheritance,
  type ReverseMode,
  isFieldType,
} from "../schema/index.js";
import {
  type MochiRecord,
  type WalkedCard,
  asDate,
  asRecord,
  asRecords,
  asText,
  isRecord,
  rfc3339,
  walkCards,
  walkDecks,
} from "./transit.js";

export interface DeckRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly reverse: ReverseMode;
  readonly target_retention: number | null;
  readonly default_template_id: string | null;
  readonly archived: 0 | 1;
  readonly pos: string;
}

export interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly reverse_permutation: string | null;
  readonly pos: string;
}

export interface TemplateFieldRow {
  readonly template_id: string;
  readonly id: string;
  readonly name: string;
  readonly type: FieldType;
  readonly source_field_id: string | null;
  readonly options: string;
  readonly pos: string;
}

export interface CardRow {
  readonly id: string;
  readonly deck_id: string;
  readonly template_id: string | null;
  readonly name: string;
  readonly content: string;
  readonly reverse: ReverseMode;
  readonly pinned: 0 | 1;
  readonly archived: 0 | 1;
  readonly needs_rereview: 0 | 1;
  readonly pos: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CardFieldValueRow {
  readonly card_id: string;
  readonly field_id: string;
  readonly value: string;
}

export interface MappingNotes {
  readonly templateIdCollisions: readonly string[];
  readonly templateIdConflicts: readonly string[];
  readonly reverseForcedCardIds: readonly string[];
  readonly orphanFieldValues: readonly string[];
  readonly orphanFieldValuesWithText: number;
  readonly orphanFieldValuesTemplateless: number;
  readonly unknownDeckCardIds: readonly string[];
  readonly unknownFieldTypes: readonly string[];
  readonly staleContentCardIds: readonly string[];
  readonly staleContentChars: number;
  readonly staleContentSample: readonly StaleContent[];
}

export interface StaleContent {
  readonly cardId: string;
  readonly templateId: string;
  readonly content: string;
}

export const STALE_CONTENT_SAMPLE_SIZE = 20;

export interface MappedExport {
  readonly decks: readonly DeckRow[];
  readonly templates: readonly TemplateRow[];
  readonly templateFields: readonly TemplateFieldRow[];
  readonly cards: readonly CardRow[];
  readonly cardFieldValues: readonly CardFieldValueRow[];
  readonly notes: MappingNotes;
}

export interface MapOptions {
  readonly dropEmptyLeafDecks?: boolean;
  readonly reverseDefault?: Extract<ReverseMode, "on" | "off">;
}

export function mapExport(root: MochiRecord, options: MapOptions = {}): MappedExport {
  return mapExports([root], options);
}

export function mapExports(
  roots: readonly MochiRecord[],
  options: MapOptions = {},
): MappedExport {
  const reverseDefault = options.reverseDefault ?? "off";

  const templates = new Map<string, TemplateRow>();
  const templateFields = new Map<string, TemplateFieldRow[]>();
  const decks = new Map<string, DeckRow>();
  const cards = new Map<string, CardRow>();
  const cardFieldValues: CardFieldValueRow[] = [];

  const templateIdCollisions: string[] = [];
  const templateIdConflicts: string[] = [];
  const reverseForcedCardIds: string[] = [];
  const orphanFieldValues: string[] = [];
  let orphanFieldValuesWithText = 0;
  let orphanFieldValuesTemplateless = 0;
  const unknownDeckCardIds: string[] = [];
  const unknownFieldTypes = new Set<string>();
  const staleContent: StaleContent[] = [];

  for (const root of roots) {
    for (const template of asRecords(root["templates"])) {
      const id = asText(template["id"]);
      if (!id) continue;
      const row = mapTemplate(id, template);
      const fields = mapTemplateFields(id, template, unknownFieldTypes);
      const previous = templates.get(id);
      if (previous) {
        templateIdCollisions.push(id);
        if (!sameTemplate(previous, templateFields.get(id) ?? [], row, fields)) {
          templateIdConflicts.push(id);
        }
      }
      templates.set(id, row);
      templateFields.set(id, fields);
    }
  }

  const walkedDecks = roots.flatMap((root) => walkDecks(root));
  const rawDecks = new Map<string, MochiRecord>();
  for (const { deck, nestedParentId } of walkedDecks) {
    const id = asText(deck["id"]);
    if (!id) continue;
    rawDecks.set(id, deck);
    const parentId = asText(deck["parent-id"]) || nestedParentId;
    decks.set(id, {
      id,
      parent_id: parentId && parentId !== id ? parentId : null,
      name: asText(deck["name"]),
      reverse: reverseFlag(deck["review-reverse?"]),
      target_retention: null,
      default_template_id: asText(deck["template-id"]) || null,
      archived: 0,
      pos: deckPos(deck["sort"]),
    });
  }

  const resolvedDeckReverse = resolveDeckReverse(decks, reverseDefault);

  const walkedCards = roots.flatMap((root) => walkCards(root));
  for (const walked of walkedCards) {
    const row = mapCard(walked, {
      decks,
      resolvedDeckReverse,
      reverseForcedCardIds,
      unknownDeckCardIds,
      staleContent,
    });
    if (!row) continue;
    cards.set(row.id, row);

    const templateFieldIds = new Set(
      (row.template_id ? templateFields.get(row.template_id) : undefined)?.map((f) => f.id),
    );
    for (const [fieldId, field] of Object.entries(asRecord(walked.card["fields"]))) {
      if (!fieldId) continue;
      const value = fieldValueText(isRecord(field) ? field["value"] : field);
      if (!row.template_id || !templateFieldIds.has(fieldId)) {
        orphanFieldValues.push(`${row.id}/${fieldId}`);
        if (value.trim() !== "") orphanFieldValuesWithText += 1;
        if (!row.template_id) orphanFieldValuesTemplateless += 1;
      }
      cardFieldValues.push({ card_id: row.id, field_id: fieldId, value });
    }
  }

  let deckRows = orderDecks([...decks.values()]);
  if (options.dropEmptyLeafDecks !== false) {
    const drop = new Set(emptyLeafDeckIds(deckRows, [...cards.values()]));
    deckRows = deckRows.filter((deck) => !drop.has(deck.id));
  }

  return {
    decks: deckRows,
    templates: [...templates.values()],
    templateFields: [...templateFields.values()].flat(),
    cards: [...cards.values()],
    cardFieldValues,
    notes: {
      templateIdCollisions,
      templateIdConflicts,
      reverseForcedCardIds,
      orphanFieldValues,
      orphanFieldValuesWithText,
      orphanFieldValuesTemplateless,
      unknownDeckCardIds,
      unknownFieldTypes: [...unknownFieldTypes],
      staleContentCardIds: staleContent.map((entry) => entry.cardId),
      staleContentChars: staleContent.reduce((n, entry) => n + [...entry.content].length, 0),
      staleContentSample: staleContent.slice(0, STALE_CONTENT_SAMPLE_SIZE),
    },
  };
}

function mapTemplate(id: string, template: MochiRecord): TemplateRow {
  return {
    id,
    name: asText(template["name"]),
    content: asText(template["content"]),
    reverse_permutation: null,
    pos: asText(template["pos"]),
  };
}

function mapTemplateFields(
  templateId: string,
  template: MochiRecord,
  unknownFieldTypes: Set<string>,
): TemplateFieldRow[] {
  const rows: TemplateFieldRow[] = [];
  for (const [fieldId, raw] of Object.entries(asRecord(template["fields"]))) {
    if (!isRecord(raw)) continue;
    const id = asText(raw["id"]) || fieldId;
    const typed = asText(raw["type"]);
    const declared = typed === "text" ? "plain" : typed;
    if (declared && !isFieldType(declared)) unknownFieldTypes.add(declared);
    const source = asText(raw["source"]);
    rows.push({
      template_id: templateId,
      id,
      name: asText(raw["name"]),
      type: declared && isFieldType(declared) ? declared : "plain",
      source_field_id: source && source !== id ? source : null,
      options: canonicalJson(normaliseOptions(asRecord(raw["options"]))),
      pos: asText(raw["pos"]),
    });
  }
  return orderTemplateFields(rows);
}

export function orderTemplateFields(rows: readonly TemplateFieldRow[]): TemplateFieldRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: TemplateFieldRow[] = [];
  const placed = new Set<string>();

  const place = (row: TemplateFieldRow, guard: Set<string>): void => {
    if (placed.has(row.id) || guard.has(row.id)) return;
    guard.add(row.id);
    const source = row.source_field_id ? byId.get(row.source_field_id) : undefined;
    if (source) place(source, guard);
    if (placed.has(row.id)) return;
    placed.add(row.id);
    out.push(row);
  };

  for (const row of rows) place(row, new Set());
  return out;
}

function mapCard(
  walked: WalkedCard,
  context: {
    readonly decks: Map<string, DeckRow>;
    readonly resolvedDeckReverse: Map<string, "on" | "off">;
    readonly reverseForcedCardIds: string[];
    readonly unknownDeckCardIds: string[];
    readonly staleContent: StaleContent[];
  },
): CardRow | null {
  const { card } = walked;
  const id = asText(card["id"]);
  const deckId = walked.deckId ?? "";
  if (!id || !deckId) return null;
  if (!context.decks.has(deckId)) context.unknownDeckCardIds.push(id);

  const created = asDate(card["created-at"]);
  const updated = asDate(card["updated-at"]);
  const createdAt = created ? rfc3339(created) : rfc3339(updated ?? new Date(0));

  let reverse = reverseFlag(card["review-reverse?"]);
  const hasReverseHistory = asRecords(card["reverse-reviews"]).length > 0;
  if (hasReverseHistory && reverse === "inherit") {
    if ((context.resolvedDeckReverse.get(deckId) ?? "off") !== "on") {
      reverse = "on";
      context.reverseForcedCardIds.push(id);
    }
  }

  const templateId = asText(card["template-id"]) || null;
  const rawContent = asText(card["content"]);
  const stale = templateId !== null && rawContent !== "";
  if (stale) {
    context.staleContent.push({ cardId: id, templateId, content: rawContent });
  }

  return {
    id,
    deck_id: deckId,
    template_id: templateId,
    name: asText(card["name"]),
    content: stale ? "" : rawContent,
    reverse,
    pinned: card["pinned?"] === true ? 1 : 0,
    archived: card["archived?"] === true ? 1 : 0,
    needs_rereview: card["needs-rereview?"] === true ? 1 : 0,
    pos: asText(card["pos"]),
    created_at: createdAt,
    updated_at: updated ? rfc3339(updated) : createdAt,
  };
}

export function reverseFlag(raw: unknown): ReverseMode {
  return raw === true ? "on" : "inherit";
}

export function resolveDeckReverse(
  decks: ReadonlyMap<string, DeckRow>,
  fallback: "on" | "off" = "off",
): Map<string, "on" | "off"> {
  const nodes = new Map<string, ReverseInheritance>();
  for (const deck of decks.values()) {
    nodes.set(deck.id, { id: deck.id, parentId: deck.parent_id ?? null, reverse: deck.reverse });
  }
  const resolved = new Map<string, "on" | "off">();
  for (const id of decks.keys()) {
    resolved.set(id, resolveReverseInheritance(nodes, id, fallback));
  }
  return resolved;
}

export function orderDecks(rows: readonly DeckRow[]): DeckRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: DeckRow[] = [];
  const placed = new Set<string>();

  const place = (row: DeckRow, guard: Set<string>): void => {
    if (placed.has(row.id) || guard.has(row.id)) return;
    guard.add(row.id);
    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    if (parent) place(parent, guard);
    if (placed.has(row.id)) return;
    placed.add(row.id);
    out.push(row);
  };

  for (const row of rows) place(row, new Set());
  return out;
}

export function emptyLeafDeckIds(
  decks: readonly DeckRow[],
  cards: readonly CardRow[],
): string[] {
  const withCards = new Set(cards.map((card) => card.deck_id));
  const withChildren = new Set(
    decks.map((deck) => deck.parent_id).filter((id): id is string => id !== null),
  );
  return decks
    .filter((deck) => !withCards.has(deck.id) && !withChildren.has(deck.id))
    .map((deck) => deck.id);
}

export function fieldValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return "";
}

export function deckPos(sort: unknown): string {
  if (typeof sort !== "number" || !Number.isFinite(sort)) return "";
  const rounded = Math.trunc(sort);
  return rounded < 0 ? "" : String(rounded).padStart(6, "0");
}

export function normaliseLang(code: string): string {
  const trimmed = code.trim();
  if (trimmed === "") return trimmed;
  const alias = LANG_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  const [language, region, ...rest] = trimmed.split("-");
  const head = (language ?? "").toLowerCase();
  if (region === undefined) return head;
  return [head, region.toUpperCase(), ...rest].join("-");
}

const LANG_ALIASES: Readonly<Record<string, string>> = {
  jp: "ja-JP",
  jpn: "ja-JP",
  "ja-jp": "ja-JP",
  en: "en",
  ja: "ja",
};

const LANG_OPTION_KEYS = new Set(["lang", "from", "to"]);

function normaliseOptions(options: MochiRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    out[key] =
      LANG_OPTION_KEYS.has(key) && typeof value === "string" ? normaliseLang(value) : value;
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

function sameTemplate(
  a: TemplateRow,
  aFields: readonly TemplateFieldRow[],
  b: TemplateRow,
  bFields: readonly TemplateFieldRow[],
): boolean {
  return (
    canonicalJson(a) === canonicalJson(b) &&
    canonicalJson([...aFields].sort(byFieldId)) === canonicalJson([...bFields].sort(byFieldId))
  );
}

function byFieldId(a: TemplateFieldRow, b: TemplateFieldRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export { FIELD_TYPES };
