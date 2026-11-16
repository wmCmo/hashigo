import type { SqliteHandle } from "../db/browser.js";
import { refreshSearchText } from "../generate/search-text.js";
import { refreshCardTags } from "./tags.js";
import { ensureSourceField, sourceValue } from "./found-in.js";

export const EDITABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  "plain",
  "boolean",
  "number",
  "accent",
]);

export interface NewCard {
  readonly deckId: string;
  readonly templateId: string | null;
  readonly name: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly source?: { readonly cardId: string; readonly sentence: string };
}

export interface CreatedCard {
  readonly cardId: string;
  readonly tracks: readonly string[];
}

export interface ExistingCard {
  readonly cardId: string;
  readonly deckPath: string;
  readonly archived: boolean;
}

export class DuplicateCardError extends Error {
  readonly existing: readonly ExistingCard[];
  constructor(name: string, templateName: string, existing: readonly ExistingCard[]) {
    const where = existing
      .map((card) => `${card.deckPath}${card.archived ? " (archived)" : ""}`)
      .join(", ");
    super(`${name} already exists on ${templateName} — in ${where}`);
    this.name = "DuplicateCardError";
    this.existing = existing;
  }
}

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function newCardId(db: SqliteHandle): string {
  const taken = db.prepare("SELECT 1 FROM cards WHERE id = ?");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let id = "";
    for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    if (taken.get(id) === undefined) return id;
  }
  throw new Error("could not find a free card id in 32 tries, which should be impossible");
}

function freshId(db: SqliteHandle, sql: string, prefix: string, ...scope: string[]): string {
  const taken = db.prepare(sql);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let id = prefix;
    for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    if (taken.get(...scope, id) === undefined) return id;
  }
  throw new Error("could not mint an id in 32 attempts, which should be impossible");
}

export interface CreatedTemplate {
  readonly templateId: string;
  readonly fieldIds: readonly [string, string];
}

export function createTemplate(db: SqliteHandle, name: string): CreatedTemplate {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("a template needs a name");
  if (db.prepare("SELECT 1 FROM templates WHERE name = ?").get(trimmed) !== undefined) {
    throw new Error(`there is already a template called ${trimmed}`);
  }
  const templateId = freshId(db, "SELECT 1 FROM templates WHERE id = ?", "");
  const backId = freshId(db, "SELECT 1 FROM template_fields WHERE template_id = ? AND id = ?", "local-", templateId);
  db.transaction(() => {
    db.prepare("INSERT INTO templates (id, name, content) VALUES (?, ?, ?)").run(
      templateId,
      trimmed,
      "<< Front >>\n---\n<< Back >>",
    );
    const field = db.prepare(
      `INSERT INTO template_fields (template_id, id, name, type, source_field_id, options, pos, local)
       VALUES (?, ?, ?, 'plain', NULL, '{}', ?, 1)`,
    );
    field.run(templateId, "name", "Front", "a");
    field.run(templateId, backId, "Back", "b");
  })();
  return { templateId, fieldIds: ["name", backId] };
}

export function cardsNamed(db: SqliteHandle, templateId: string | null, name: string): ExistingCard[] {
  if (templateId === null || name.trim() === "") return [];
  return (
    db
      .prepare(
        `SELECT c.id AS cardId, dp.path AS deckPath, c.archived AS archived
           FROM cards c JOIN deck_paths dp ON dp.deck_id = c.deck_id
          WHERE c.template_id = ? AND c.name = ?
          ORDER BY c.archived, c.id`,
      )
      .all(templateId, name.trim()) as { cardId: string; deckPath: string; archived: number }[]
  ).map((row) => ({ cardId: row.cardId, deckPath: row.deckPath, archived: row.archived === 1 }));
}

export function createCard(
  db: SqliteHandle,
  card: NewCard,
  options: { readonly allowDuplicate?: boolean } = {},
): CreatedCard {
  const name = card.name.trim();
  if (db.prepare("SELECT id FROM decks WHERE id = ?").get(card.deckId) === undefined) {
    throw new Error(`no deck ${card.deckId}`);
  }
  let fields: { id: string; name: string; type: string }[] = [];
  if (card.templateId !== null) {
    const template = db.prepare("SELECT name FROM templates WHERE id = ?").get(card.templateId) as
      | { name: string }
      | undefined;
    if (template === undefined) throw new Error(`no template ${card.templateId}`);
    if (options.allowDuplicate !== true) {
      const existing = cardsNamed(db, card.templateId, name);
      if (existing.length > 0) throw new DuplicateCardError(name, template.name, existing);
    }
    fields = db
      .prepare("SELECT id, name, type FROM template_fields WHERE template_id = ?")
      .all(card.templateId) as { id: string; name: string; type: string }[];
  }

  const values = new Map<string, string>(Object.entries(card.values ?? {}));
  if (values.size > 0 && card.templateId === null) {
    throw new Error("a card with no template has no fields to hold values");
  }
  for (const fieldId of values.keys()) {
    const field = fields.find((entry) => entry.id === fieldId);
    if (field === undefined) throw new Error(`no field ${fieldId} on this card's template`);
    if (!EDITABLE_FIELD_TYPES.has(field.type)) {
      throw new Error(`${field.name} is a ${field.type} field; its content is generated, not stored`);
    }
  }
  if (name !== "" && !values.has("name") && fields.some((entry) => entry.id === "name")) {
    values.set("name", name);
  }

  const cardId = newCardId(db);
  const tracks: string[] = [];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO cards (id, deck_id, template_id, name, content, archived, local)
       VALUES (?, ?, ?, ?, '', 0, 1)`,
    ).run(cardId, card.deckId, card.templateId, name);

    const insertValue = db.prepare(
      "INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)",
    );
    for (const [fieldId, value] of values) insertValue.run(cardId, fieldId, value);

    if (card.templateId !== null && card.source !== undefined) {
      const from = db.prepare("SELECT name FROM cards WHERE id = ?").get(card.source.cardId) as
        | { name: string }
        | undefined;
      if (from !== undefined) {
        const fieldId = ensureSourceField(db, card.templateId);
        db.prepare(
          `INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)
           ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`,
        ).run(cardId, fieldId, sourceValue(card.source.cardId, from.name, card.source.sentence));
      }
    }

    const reverse = db
      .prepare("SELECT reverse FROM card_reverse_resolved WHERE card_id = ?")
      .get(cardId) as { reverse: string } | undefined;
    const kinds = reverse?.reverse === "on" ? ["forward", "reverse"] : ["forward"];
    for (const kind of kinds) {
      db.prepare(
        `INSERT INTO card_tracks
           (card_id, kind, dormant, needs_rereview, due_at, scheduled_days, reps, lapses,
            last_reviewed_at, scheduler, scheduler_state)
         VALUES (?, ?, 0, 0, NULL, NULL, 0, 0, NULL, NULL, NULL)`,
      ).run(cardId, kind);
      tracks.push(kind);
    }
  })();

  refreshSearchText(db, [cardId]);
  refreshCardTags(db, [cardId]);
  return { cardId, tracks };
}
