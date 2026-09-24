/**
 * ONE CARD'S SEARCHABLE TEXT, AND THE ONE PLACE IT IS COMPUTED.
 *
 * Zach, 2026-09-24, after being told a filled generation would wait for a rebuild:
 * *"meaning, if i create a new card, it won't be indexed?"* Checking the answer
 * turned up a worse fault than the one he asked about.
 *
 * ─── WHAT WAS TRUE BEFORE THIS FILE ─────────────────────────────────────────
 *
 * `card_search_index` (the view both the FTS triggers and the short-query scan
 * read) takes `cards.search_text` when it is set and falls back to the raw fields
 * when it is NULL. Nothing in the app ever wrote `search_text`. So, measured on a
 * copy of the real database:
 *
 *   * **a card created in the app WAS findable** — NULL, so the fallback indexed
 *     what he typed. Only its generated sentence was missing.
 *   * **an EDITED card was NOT.** Every imported card has `search_text` set, the
 *     view prefers it, and an edit left it untouched: after changing 厳格's 意味
 *     to contain `qqplmk`, a search for `qqplmk` found nothing and a search for
 *     the OLD `rigorous` still returned 厳格. True of all 7,716 imported cards, and
 *     of any card a sync or a restore rewrote — `src/backup/archive.ts` writes
 *     field values the same way.
 *
 * The schema said this would happen, in so many words: *"a writer that edits
 * card_field_values without recomputing search_text leaves the index behind.
 * Every write path must go through renderPlainTextParts()"*. None did.
 *
 * ─── WHAT GOES IN ───────────────────────────────────────────────────────────
 *
 * `cards.content`, every NON-local stored value in template order, and the
 * resolved text of the card's `ai` and `translate` generators. The reasons for
 * each exclusion are in `scripts/search-text-rebuild.ts`, which now calls this
 * rather than carrying its own copy: two definitions of "a card's searchable
 * text" would drift, and a drift here shows up as a card that renders one way and
 * is found another.
 *
 * BROWSER-PORTABLE: `SqliteHandle`, and `renderPlainTextParts` from `src/text`
 * rather than `buildSearchText` from `src/schema`, which reads its SQL with
 * `node:fs` at load and cannot enter the worker.
 */
import type { SqliteHandle } from "../db/browser.js";
import { renderPlainTextParts } from "../text/render.js";

import { fieldGenerationRequest, type FieldContext, type GeneratorField } from "./fields.js";
import { resolveDescriptorText } from "./store.js";

/** Prose only. `furigana` holds its input with Mochi's brackets — decision 37 (b). */
const INDEXED_KINDS: ReadonlySet<string> = new Set(["ai", "translate"]);

const CARD = `SELECT content, template_id FROM cards WHERE id = ?`;

const FIELDS = `
SELECT id, name, type, source_field_id, options
  FROM template_fields WHERE template_id = ? ORDER BY pos`;

/**
 * Non-local values only, in template order. `local = 1` is decision 9's mark for
 * a field this project added, and the derived accent annotations are those:
 * indexing `型` would put `平板` on 7,660 cards.
 */
const VALUES = `
SELECT v.field_id AS field_id, v.value AS value
  FROM card_field_values v
  JOIN template_fields tf ON tf.id = v.field_id
 WHERE v.card_id = ? AND tf.local = 0
 ORDER BY tf.pos, v.field_id`;

/** Guarded: an unchanged card writes no page and rebuilds no FTS row. */
const WRITE = `UPDATE cards SET search_text = ? WHERE id = ? AND search_text IS NOT ?`;

function decode(options: string | null): Record<string, unknown> {
  if (options === null || options === "") return {};
  try {
    return JSON.parse(options) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** What the index should hold for this card, or null when there is no such card. */
export function cardSearchText(db: SqliteHandle, cardId: string): string | null {
  const card = db.prepare(CARD).get(cardId) as
    | { content: string | null; template_id: string | null }
    | undefined;
  if (card === undefined) return null;

  const fields: GeneratorField[] =
    card.template_id === null
      ? []
      : (
          db.prepare(FIELDS).all(card.template_id) as {
            id: string;
            name: string;
            type: string;
            source_field_id: string | null;
            options: string | null;
          }[]
        ).map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type,
          sourceFieldId: row.source_field_id,
          options: decode(row.options),
        }));

  const values = new Map<string, string>();
  for (const row of db.prepare(VALUES).all(cardId) as { field_id: string; value: string }[]) {
    values.set(row.field_id, row.value);
  }

  // `resolveGenerated` lets a CHAINED generator resolve — 単語's `Audio` reads the
  // sentence `例文` produced.
  const context: FieldContext = {
    fields,
    values,
    resolveGenerated: (request) => resolveDescriptorText(db, request),
  };
  const generated: string[] = [];
  for (const field of fields) {
    const request = fieldGenerationRequest(field, context);
    if (request === null || !INDEXED_KINDS.has(request.kind)) continue;
    const text = resolveDescriptorText(db, request);
    if (text !== null && text.trim() !== "") generated.push(text);
  }

  return renderPlainTextParts([card.content, ...values.values(), ...generated]);
}

/**
 * Recompute and store. Returns how many rows actually changed.
 *
 * Call it after ANY write that changes what a card says — a field edit, a new
 * card, a duplicate, a generation filled from the card, a sync or restore. The
 * `cards_fts_au` trigger fires on `search_text`, so the FTS row follows.
 */
export function refreshSearchText(db: SqliteHandle, cardIds: Iterable<string>): number {
  const write = db.prepare(WRITE);
  let changed = 0;
  for (const cardId of new Set(cardIds)) {
    const text = cardSearchText(db, cardId);
    if (text === null) continue;
    changed += write.run(text, cardId, text).changes;
  }
  return changed;
}
