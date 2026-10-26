/**
 * `出典` — WHERE A CARD WAS FOUND. Zach, 2026-10-26:
 *
 * *"whenever i see a new word inside an example sentence like 彼女は古いシャツを
 * 細く裂いて、包帯の代わりにした。 i see 包帯 so then i would create new card, but
 * then i would have no way to tell myself that i created that card because of
 * this one"*.
 *
 * ─── A FIELD ON THE NEW CARD, NOT A LINK INSIDE THE OLD SENTENCE ────────────
 *
 * The sentence is usually `例文`, an `ai` field: generated text, not text he
 * typed, so there is no durable place in it to put `[[包帯]]` — a regeneration
 * would lose it. So the NEW card carries the edge: its `出典` value is
 *
 *     [[恒久|7gYJYvlm]]
 *     彼女は古いシャツを細く裂いて、包帯の代わりにした。
 *
 * a link to the card it came from, then a copy of the sentence, kept because the
 * generated one can change under it. The link makes the OTHER direction free:
 * `card_links` (kept current by `./link-index.ts`) puts 包帯 in the old card's
 * "links here" list with no second mechanism.
 *
 * ─── ONE FIELD ID ON EVERY TEMPLATE ─────────────────────────────────────────
 *
 * `source`, not a random `newFieldId`. Two devices that each create the field
 * then write the SAME row, and the sync's upsert keyed `(template_id, id)` makes
 * them one. Random ids would give a template two fields both named `出典`, and
 * the resolver binds the first by name, so the second would be unreachable.
 *
 * It is `local = 1` (decision 9) and carries the `source` role, so code finds it
 * by role rather than by a name he might rename.
 *
 * BROWSER-PORTABLE: `SqliteHandle`, no `node:` import.
 */
import type { SqliteHandle } from "../db/browser.js";
import { ROLE_KEY } from "../fields/roles.js";
import { parseWikiLinks } from "../text/render.js";

export const SOURCE_FIELD_NAME = "出典";
export const SOURCE_FIELD_ID = "source";

/** The card a card was found in, as the screen shows it. */
export interface FoundIn {
  readonly cardId: string;
  readonly name: string;
  readonly deckPath: string;
  /** The sentence it was found in, as copied at creation. Empty when none was. */
  readonly sentence: string;
}

/**
 * The template's `出典` field id, creating it if the template has none. Found by
 * ROLE first, so a field he renamed is still the one used.
 */
export function ensureSourceField(db: SqliteHandle, templateId: string): string {
  const fields = db
    .prepare("SELECT id, name, options FROM template_fields WHERE template_id = ?")
    .all(templateId) as { id: string; name: string; options: string }[];
  for (const field of fields) {
    try {
      if ((JSON.parse(field.options) as Record<string, unknown>)[ROLE_KEY] === "source") return field.id;
    } catch {
      // A malformed options column is someone else's problem; it is not this role.
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

/**
 * The value: a link line, then the sentence. Brackets and pipes in the NAME would
 * break the link syntax, so they go — the display text is a label, the id is
 * what resolves.
 */
export function sourceValue(sourceCardId: string, sourceName: string, sentence: string): string {
  const label = sourceName.replace(/[[\]|]/g, "").trim();
  const link = `[[${label}|${sourceCardId}]]`;
  const said = sentence.replace(/\s+/g, " ").trim();
  return said === "" ? link : `${link}\n${said}`;
}

/** Where `cardId` was found, or null. Read from the field carrying the `source` role. */
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
  // A source card he has since deleted: the sentence is still worth showing, and
  // the name he saw is in the link's display text.
  const sentence = row.value.replace(link.raw, "").trim();
  return {
    cardId: link.target,
    name: target?.name ?? link.display,
    deckPath: target?.deck_path ?? "",
    sentence,
  };
}
