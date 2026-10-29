/**
 * MAKING A CARD — one transaction, its field values included.
 *
 * This lived in `app/db.worker.ts` and took a title only: every other field was
 * written afterwards through the editor, one blur at a time. Anything that made
 * cards in bulk (the 漢検 batches, five of them by 2026-10-29) drove that editor
 * and sometimes lost the race — the card was made and the fill never landed, so
 * 簿 existed with every field EMPTY. A card and its values are one fact; they
 * are written together here or not at all.
 *
 * It is here rather than in the worker so that a script with no browser
 * (`scripts/cards-add.ts`) makes a card through exactly the same code the app
 * does. BROWSER-PORTABLE: `SqliteHandle`, no `node:` import.
 *
 * ─── A SECOND CARD WITH THE SAME NAME IS REFUSED UNLESS ASKED FOR ───────────
 *
 * Nothing checked. Typing 功績 into the new-card form made a second 功績 beside
 * the first, and the only thing that stopped it in the batches was an agent
 * pulling every device's data first. The live data has 20 repeated names on one
 * template out of ~7,700 cards — 10 of them Mochi's "Untitled card", the rest a
 * word entered twice — so a repeat is almost always a mistake, and almost never
 * worth a dialog. `DuplicateCardError` carries the cards that already exist, so
 * the form can offer to open one; `allowDuplicate` is the "create anyway" for a
 * homograph that really is a second word.
 *
 * Archived cards count. An archived 篤 still exists and is linked to; making a
 * second one would split its backlinks.
 */

import type { SqliteHandle } from "../db/browser.js";
import { refreshSearchText } from "../generate/search-text.js";
import { ensureSourceField, sourceValue } from "./found-in.js";

/** Field types whose value is stored on the card. The rest live in the generation cache. */
export const EDITABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  "plain",
  "text",
  "boolean",
  "number",
  "accent",
]);

export interface NewCard {
  readonly deckId: string;
  /** Null makes a template-less card. */
  readonly templateId: string | null;
  readonly name: string;
  /**
   * Field values by FIELD ID, written in the same transaction. The head word
   * (`name`) is filled from `name` when it is not given here.
   */
  readonly values?: Readonly<Record<string, string>>;
  /** The card this one was found in, and the sentence — decision 55's `出典`. */
  readonly source?: { readonly cardId: string; readonly sentence: string };
}

export interface CreatedCard {
  readonly cardId: string;
  /** `forward`, plus `reverse` when the deck resolves to it. */
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

/**
 * A card id in Mochi's shape: eight characters of [0-9A-Za-z]. Uniform because
 * ids appear in wiki-links, the search index and the backup, and one format is
 * one thing to reason about. Unique in THIS database only — no Mochi id ever
 * arrives again (the final import has happened).
 */
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
  /** The two fields it starts with: the head (`name`) and the back. */
  readonly fieldIds: readonly [string, string];
}

/**
 * MAKE A TEMPLATE — the thing a user who never had Mochi cannot otherwise get.
 *
 * Every template here came from Mochi's export, and until 2026-10-30 the app
 * could edit one but not make one. A card with no template gets an empty body
 * that nothing can edit, so a new user could make cards that hold nothing.
 *
 * It starts as the smallest card that works: two plain fields and two sides,
 *
 *     << Front >>
 *     ---
 *     << Back >>
 *
 * which the template editor then grows. The front field's id is `name` because
 * that is the PRIMARY field on every template here — `createCard` writes the
 * title he types into it, so a new card on this template is not blank. Both
 * fields are `local = 1` (decision 9): Mochi never had them, and a re-import's
 * `pruneFieldValues` must not take their values.
 *
 * A name another template already has is refused: the new-card form and the
 * template list both pick by name, and two 単語 would be two things he cannot
 * tell apart.
 */
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

/** Cards on `templateId` already called `name`, archived or not. Empty for a blank name. */
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

/**
 * Make a card, its values, and OPEN ITS TRACKS — the half that is easy to forget.
 *
 * A card with no `card_tracks` row is invisible to the scheduler forever. So this
 * opens `forward` always and `reverse` when the deck resolves to it, through the
 * SAME view the importer and the loader use (`card_reverse_resolved`). `due_at`
 * is NULL and `reps` 0, which is what `newTracks` looks for: the card enters the
 * NEW queue under decision 12's limit rather than arriving overdue.
 *
 * Every value is checked BEFORE anything is written: a field that is not on the
 * card's template, or one whose content lives in the generation cache, throws and
 * the card is not made. `local = 1` marks it as made here (schema v9), which is
 * what the backup and sync carry.
 */
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
  // The template's PRIMARY field is `name` on every template here, and it is what
  // `<<単語>>` / `<<Kanji>>` resolve to — so the title goes there too, or the card
  // renders blank and has to be typed twice.
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

    // `出典` — the card he found this word in. In the same transaction, so a card
    // never exists without the reason he made it.
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

  // Indexed with its values from the start, so a card made in bulk is found the
  // same way an imported one is.
  refreshSearchText(db, [cardId]);
  return { cardId, tracks };
}
