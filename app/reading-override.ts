/**
 * A CARD'S OWN `読み`, FOR THE FURIGANA NOTHING ELSE CAN FILL.
 *
 * A furigana's reading is looked up in the generation cache by the text it
 * annotates, and every reading in that cache came from Mochi: `/generate/` makes
 * `ai`, `translate` and `speech` only. So a 単語 card created HERE — Zach, 2026-10-21,
 * turning his 漢検準2級 misses into `Reading = true` cards — rendered its kanji with
 * an empty reading behind the cloze, which on a produce card is the whole answer.
 *
 * Decision 10 already says an explicit `読み` beats the head word as a generator's
 * input and renders as furigana; this is that sentence applied to the one case it
 * had never reached. It is a FALLBACK, consulted only when the cache has nothing:
 * a card Mochi annotated keeps its annotation, so nothing that rendered before
 * renders differently now.
 *
 * Structural `ScopedDb` for `deck-scope.ts`'s reason — `test/` reaches it with
 * better-sqlite3 against a copy of the real corpus.
 */

import type { ScopedDb } from "./deck-scope.js";

/** The card's non-empty `読み`, trimmed, or null. Matched on the field NAME, as `redoInfo` does. */
export function readingOverride(db: ScopedDb, cardId: string): string | null {
  const row = db
    .prepare(
      `SELECT v.value AS value FROM card_field_values v
         JOIN cards c ON c.id = v.card_id
         JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
        WHERE v.card_id = ? AND trim(f.name) = '読み' AND trim(v.value) <> '' LIMIT 1`,
    )
    .all(cardId)[0] as { value: string } | undefined;
  return row === undefined ? null : row.value.trim();
}
