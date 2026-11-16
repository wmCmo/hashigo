import type { SqliteHandle } from "../db/browser.js";
import type { GeneratorField } from "../generate/fields.js";
import type {
  CardInput,
  Direction,
  RenderedCard,
  ResolveOptions,
  TemplateFieldInput,
  TemplateInput,
} from "../template/index.js";
import { renderCard } from "../template/index.js";

export interface LoadedField extends TemplateFieldInput, GeneratorField {
  readonly type: string;
  readonly sourceFieldId: string | null;
  readonly options: Readonly<Record<string, unknown>>;
  readonly pos: string;
  readonly local: 0 | 1;
}

export function decodeFieldOptions(raw: string): Readonly<Record<string, unknown>> {
  if (raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export interface LoadedTemplate extends TemplateInput {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly LoadedField[];
  readonly reversePermutation: readonly number[] | null;
}

export interface LoadedCard {
  readonly id: string;
  readonly name: string;
  readonly deckId: string;
  readonly deckPath: string;
  readonly templateId: string | null;
  readonly template: LoadedTemplate | null;
  readonly values: ReadonlyMap<string, string>;
  readonly content: string;
  readonly archived: 0 | 1;
}

export interface CardContext {
  readonly reverse: string;
  readonly voice: string | null;
}

const SELECT_CONTEXT = `
SELECT rr.reverse AS reverse, vr.voice AS voice
  FROM cards c
  LEFT JOIN card_reverse_resolved rr ON rr.card_id = c.id
  LEFT JOIN card_voice_resolved vr   ON vr.card_id = c.id
 WHERE c.id = ?`;

export function cardContext(db: SqliteHandle, cardId: string): CardContext | null {
  const row = db.prepare(SELECT_CONTEXT).get(cardId) as
    | { reverse: string | null; voice: string | null }
    | undefined;
  if (row === undefined) return null;
  return { reverse: row.reverse ?? "off", voice: row.voice };
}

const SELECT_CARD = `
SELECT c.id            AS id,
       c.name          AS name,
       c.content       AS content,
       c.deck_id       AS deck_id,
       c.template_id   AS template_id,
       c.archived      AS archived,
       coalesce(dp.path, '(unknown)') AS deck_path
  FROM cards c
  LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id
 WHERE c.id = ?`;

const SELECT_TEMPLATE = `
SELECT id, name, content, reverse_permutation AS reverse_permutation
  FROM templates WHERE id = ?`;

const SELECT_FIELDS = `
SELECT id, name, type, source_field_id, options, pos, local
  FROM template_fields WHERE template_id = ? ORDER BY pos, id`;

const SELECT_VALUES = `
SELECT field_id, value FROM card_field_values WHERE card_id = ?`;

interface RawCard {
  id: string;
  name: string;
  content: string;
  deck_id: string;
  template_id: string | null;
  archived: number;
  deck_path: string;
}

export function decodeReversePermutation(raw: string | null): readonly number[] | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const numbers = parsed.filter((value): value is number => Number.isInteger(value));
  return numbers.length === parsed.length ? numbers : null;
}

export function loadCard(db: SqliteHandle, cardId: string): LoadedCard | null {
  const row = db.prepare(SELECT_CARD).get(cardId) as RawCard | undefined;
  if (row === undefined) return null;

  let template: LoadedTemplate | null = null;
  if (row.template_id !== null) {
    const raw = db.prepare(SELECT_TEMPLATE).get(row.template_id) as
      | { id: string; name: string; content: string; reverse_permutation: string | null }
      | undefined;
    if (raw !== undefined) {
      const fields = (
        db.prepare(SELECT_FIELDS).all(row.template_id) as {
          id: string;
          name: string;
          type: string;
          source_field_id: string | null;
          options: string;
          pos: string;
          local: number;
        }[]
      ).map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
        sourceFieldId: field.source_field_id,
        options: decodeFieldOptions(field.options),
        pos: field.pos,
        local: (field.local === 1 ? 1 : 0) as 0 | 1,
      }));
      template = {
        id: raw.id,
        name: raw.name,
        content: raw.content,
        fields,
        reversePermutation: decodeReversePermutation(raw.reverse_permutation),
      };
    }
  }

  const values = new Map<string, string>();
  for (const value of db.prepare(SELECT_VALUES).all(cardId) as {
    field_id: string;
    value: string;
  }[]) {
    values.set(value.field_id, value.value);
  }

  return {
    id: row.id,
    name: row.name,
    deckId: row.deck_id,
    deckPath: row.deck_path,
    templateId: row.template_id,
    template,
    values,
    content: row.content,
    archived: (row.archived === 1 ? 1 : 0) as 0 | 1,
  };
}

export function cardInputFor(loaded: LoadedCard): CardInput {
  return { id: loaded.id, content: loaded.content, values: loaded.values };
}

export function renderLoadedCard(
  loaded: LoadedCard,
  direction: Direction,
  options: ResolveOptions = {},
): RenderedCard {
  return renderCard(cardInputFor(loaded), loaded.template, direction, {
    ...options,
    pendingGenerators: true,
  });
}

export function loadRenderedCard(
  db: SqliteHandle,
  cardId: string,
  direction: Direction,
  options: ResolveOptions = {},
): RenderedCard | null {
  const loaded = loadCard(db, cardId);
  return loaded === null ? null : renderLoadedCard(loaded, direction, options);
}

export function directionForTrackKind(kind: string): Direction {
  return kind === "reverse" ? "reverse" : "forward";
}
