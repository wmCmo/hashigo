import type { SqliteHandle } from "../db/browser.js";
import { ROLE_KEY } from "../fields/roles.js";
import { parseWikiLinks } from "../text/render.js";

export const SOURCE_FIELD_NAME = "出典";
export const SOURCE_FIELD_ID = "source";

export interface FoundIn {
  readonly cardId: string;
  readonly name: string;
  readonly deckPath: string;
  readonly sentence: string;
}

export function ensureSourceField(db: SqliteHandle, templateId: string): string {
  const fields = db
    .prepare("SELECT id, name, options FROM template_fields WHERE template_id = ?")
    .all(templateId) as { id: string; name: string; options: string }[];
  for (const field of fields) {
    try {
      if ((JSON.parse(field.options) as Record<string, unknown>)[ROLE_KEY] === "source") return field.id;
    } catch {
    }
  }
  const named = fields.find((field) => field.name.trim() === SOURCE_FIELD_NAME);
  if (named !== undefined) return named.id;
  db.prepare(
    `INSERT INTO template_fields (template_id, id, name, type, source_field_id, options, pos, local)
     VALUES (?, ?, ?, 'plain', NULL, ?, 'zz-source', 1)`,
  ).run(templateId, SOURCE_FIELD_ID, SOURCE_FIELD_NAME, JSON.stringify({ [ROLE_KEY]: "source" }));
  return SOURCE_FIELD_ID;
}

export function sourceValue(sourceCardId: string, sourceName: string, sentence: string): string {
  const label = sourceName.replace(/[[\]|]/g, "").trim();
  const link = `[[${label}|${sourceCardId}]]`;
  const said = sentence.replace(/\s+/g, " ").trim();
  return said === "" ? link : `${link}\n${said}`;
}

export function recordFoundIn(
  db: SqliteHandle,
  cardId: string,
  source: { readonly cardId: string; readonly sentence: string },
): "recorded" | "kept" | "unknown" {
  const card = db.prepare("SELECT template_id FROM cards WHERE id = ?").get(cardId) as
    | { template_id: string | null }
    | undefined;
  const from = db.prepare("SELECT name FROM cards WHERE id = ?").get(source.cardId) as
    | { name: string }
    | undefined;
  if (card === undefined || card.template_id === null || from === undefined) return "unknown";
  const fieldId = ensureSourceField(db, card.template_id);
  const held = db
    .prepare("SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?")
    .get(cardId, fieldId) as { value: string } | undefined;
  if (held !== undefined && held.value.trim() !== "") return "kept";
  db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`,
  ).run(cardId, fieldId, sourceValue(source.cardId, from.name, source.sentence));
  return "recorded";
}

export function foundInOf(db: SqliteHandle, cardId: string): FoundIn | null {
  const rows = db
    .prepare(
      `SELECT v.value AS value, f.options AS options, f.name AS name
         FROM card_field_values v
         JOIN cards c ON c.id = v.card_id
         JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
        WHERE v.card_id = ?`,
    )
    .all(cardId) as { value: string; options: string; name: string }[];
  const row =
    rows.find((r) => {
      try {
        return (JSON.parse(r.options) as Record<string, unknown>)[ROLE_KEY] === "source";
      } catch {
        return false;
      }
    }) ?? rows.find((r) => r.name.trim() === SOURCE_FIELD_NAME);
  if (row === undefined) return null;
  const link = parseWikiLinks(row.value)[0];
  if (link === undefined) return null;
  const target = db
    .prepare(
      `SELECT c.name AS name, coalesce(dp.path, '(unknown)') AS deck_path
         FROM cards c LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id WHERE c.id = ?`,
    )
    .get(link.target) as { name: string; deck_path: string } | undefined;
  const sentence = row.value.replace(link.raw, "").trim();
  return {
    cardId: link.target,
    name: target?.name ?? link.display,
    deckPath: target?.deck_path ?? "",
    sentence,
  };
}
