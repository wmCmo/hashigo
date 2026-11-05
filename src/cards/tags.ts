/**
 * A `#tag` TYPED ON A CARD BECOMES A TAG — Zach, 2026-11-05: *"the tagging is not
 * working anymore"*, over a 単語 card ending `#Fishing`.
 *
 * It never worked for a new tag. The `tags` table was filled once, by the Mochi
 * import (19 tags), and nothing in the app ever added to it; the renderer draws a
 * `#` as a chip only when the tag exists (`knownTagsFor`), so every tag he typed
 * here rendered as plain text and its scope found no cards. Mochi made a tag from
 * a typed `#`; this does the same.
 *
 * ─── ADD-ONLY, ON PURPOSE ────────────────────────────────────────────────────
 *
 * A tag is added when a card's text carries it; nothing is removed when the text
 * stops carrying it. The imported `card_tags` came from Mochi's tag ARRAYS, not
 * from the text, so a rule that dropped every tag the text does not show would
 * strip imported tags the text never had. A tag he deletes from the text stops
 * rendering (it is no longer in the text to render) and lingers only in the tag's
 * scope list — the smaller wrong.
 *
 * ─── EVERY DEVICE DERIVES IT ITSELF ──────────────────────────────────────────
 *
 * `tags` and `card_tags` are not in the sync payload; the card TEXT is. So this
 * runs wherever a card's text lands — an edit, a new card, a duplicate, a sync or
 * a restore — and each device builds the same tags from the same text.
 *
 * Browser-portable: `SqliteHandle`, no `node:` import.
 */

import type { SqliteHandle } from "../db/browser.js";
import { normaliseTagPath, tagPrefixes, tagRow } from "../import/tags.js";
import { parseContent } from "../template/index.js";
import { tagPathsOf } from "./link-names.js";

/** Every tag path a piece of card text carries, normalised as the importer does. */
export function tagsInText(text: string): string[] {
  const out = new Set<string>();
  for (const raw of tagPathsOf(parseContent(text))) {
    const path = normaliseTagPath(raw);
    if (path !== "") out.add(path);
  }
  return [...out];
}

/** Add the tags each card's text carries. Returns how many card-tag rows were new. */
export function refreshCardTags(db: SqliteHandle, cardIds: Iterable<string>): number {
  const values = db.prepare("SELECT value FROM card_field_values WHERE card_id = ?");
  const putTag = db.prepare(
    "INSERT INTO tags (path, parent_path, name) VALUES (?, ?, ?) ON CONFLICT (path) DO NOTHING",
  );
  const putCardTag = db.prepare(
    // `manual = 0`: Mochi's `tags` array is the DERIVED one (from the text), and
    // `manual-tags` the hand-set one — a tag read off the text is the former.
    "INSERT INTO card_tags (card_id, tag_path, manual) VALUES (?, ?, 0) ON CONFLICT DO NOTHING",
  );
  let added = 0;
  for (const cardId of new Set(cardIds)) {
    const paths = new Set<string>();
    for (const row of values.all(cardId) as { value: string }[]) {
      // Cheap guard: most values carry no `#` at all, and parsing is not free.
      if (!row.value.includes("#")) continue;
      for (const path of tagsInText(row.value)) paths.add(path);
    }
    for (const path of paths) {
      // Shallowest first: `tags.parent_path` is a foreign key onto `tags.path`.
      for (const prefix of tagPrefixes(path)) {
        const tag = tagRow(prefix);
        putTag.run(tag.path, tag.parent_path, tag.name);
      }
      added += Number((putCardTag.run(cardId, path) as { changes?: number }).changes ?? 0);
    }
  }
  return added;
}
