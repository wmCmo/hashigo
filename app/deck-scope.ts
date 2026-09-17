/**
 * WHAT "THIS DECK" MEANS, AND WHAT AN ARCHIVE UNDOES TO.
 *
 * The sidebar shows SUBTREE totals — that is what `app/deck-tree.ts` computes — so
 * every operation on a deck has to mean the same thing the number beside it means, or
 * the UI describes one deck and acts on another. It did:
 *
 *   archiving 日本語   touched 3 of the 5,947 cards under it, and reported
 *                      "archived 日本語 and its cards"
 *   archiving English  touched 0 of 1,258, same report
 *   clicking 日本語    opened a gallery of 3 beside a badge reading 5,947
 *
 * And the undo was worse than the bug. It recorded the INVERSE operation, so one
 * ctrl+Z after an accidental deck archive ran `archived = 0` over the whole deck and
 * erased every per-card archive decision in it. **234 cards in the corpus are archived
 * individually**, and there was no way back: the undo stack held one entry and it was
 * the thing that did the damage.
 *
 * So `archiveSubtree` returns the rows it ACTUALLY CHANGED and `restoreArchive` puts
 * back exactly those. A card already archived by hand is never touched, because it was
 * never changed.
 *
 * ── WHY THIS FILE EXISTS RATHER THAN THE SAME SQL INSIDE `db.worker.ts` ──
 *
 * `test/` cannot import the worker: it opens with `/// <reference lib="webworker" />`
 * and touches `self` at load. So the most destructive write in the app lived where no
 * test could reach it, which is how it shipped inverted.
 *
 * The functions take a structural `ScopedDb` — the three methods both `BrowserDb`
 * (sqlite-wasm) and `better-sqlite3` already have — so the worker calls them against
 * OPFS and `test/app-deck-scope.test.ts` calls them against the real 74 MB corpus in
 * Node. Same code, both sides. No imports here, for the same reason as `keys.ts` and
 * `deck-tree.ts`: it has to compile under the root `tsconfig.json`, which excludes
 * `app/`.
 */

/** The slice of a SQLite handle these need. Satisfied by BrowserDb and better-sqlite3. */
export interface ScopedStatement {
  all(...params: readonly unknown[]): unknown[];
  run(...params: readonly unknown[]): unknown;
}
export interface ScopedDb {
  prepare(sql: string): ScopedStatement;
}

/**
 * A deck and every deck beneath it.
 *
 * Recursive over `parent_id` rather than a `deck_paths` prefix match: a path prefix is
 * a string operation on names the user can edit, and `単語` is a prefix of `単語帳`.
 * There are 45 decks, so the walk is free.
 *
 * `UNION`, not `UNION ALL` — that is the cycle guard, the same hazard `app/deck-tree.ts`
 * guards in the page. Nothing can reparent a deck today; request 14's deck CRUD will.
 */
export function subtreeDeckIds(db: ScopedDb, rootId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM decks WHERE id = ?
         UNION
         SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
       )
       SELECT id FROM sub`,
    )
    .all(rootId) as { id: string }[];
  return rows.map((row) => row.id);
}

function holes(count: number): string {
  return new Array(count).fill("?").join(", ");
}

/**
 * Archive (or unarchive) a deck, its subdecks, and their cards.
 *
 * Returns the card ids whose `archived` flag this actually flipped — hand that to
 * `restoreArchive` to undo it. The caller must run this inside a transaction; it is
 * left out here so the worker can wrap the whole operation including its own bookkeeping.
 */
export function archiveSubtree(
  db: ScopedDb,
  rootId: string,
  to: 0 | 1,
): { deckIds: string[]; changed: string[] } {
  const deckIds = subtreeDeckIds(db, rootId);
  const marks = holes(deckIds.length);

  // Captured BEFORE the write, and only where the value differs. This is the whole
  // difference between an undo and a second, different write.
  const changed = (
    db
      .prepare(`SELECT id FROM cards WHERE deck_id IN (${marks}) AND archived = ?`)
      .all(...deckIds, to === 1 ? 0 : 1) as { id: string }[]
  ).map((row) => row.id);

  db.prepare(`UPDATE decks SET archived = ? WHERE id IN (${marks})`).run(to, ...deckIds);
  if (changed.length > 0) {
    db.prepare(`UPDATE cards SET archived = ? WHERE id IN (${holes(changed.length)})`).run(
      to,
      ...changed,
    );
  }
  return { deckIds, changed };
}

/**
 * Put back exactly what `archiveSubtree` changed, and nothing else.
 *
 * Flips per row rather than assigning a constant, so one call restores correctly
 * whichever direction the original operation ran in.
 */
export function restoreArchive(db: ScopedDb, rootId: string, cardIds: readonly string[]): void {
  if (cardIds.length > 0) {
    db.prepare(
      `UPDATE cards SET archived = CASE archived WHEN 1 THEN 0 ELSE 1 END
        WHERE id IN (${holes(cardIds.length)})`,
    ).run(...cardIds);
  }
  const deckIds = subtreeDeckIds(db, rootId);
  db.prepare(
    `UPDATE decks SET archived = CASE archived WHEN 1 THEN 0 ELSE 1 END
      WHERE id IN (${holes(deckIds.length)})`,
  ).run(...deckIds);
}

/**
 * The SQL fragment and parameters that scope a card query to a deck's subtree.
 *
 * `null` means the whole collection, which is what "everything" in the sidebar sends.
 */
export function scopeToSubtree(
  db: ScopedDb,
  deckId: string | null,
): { sql: string; args: string[] } {
  if (deckId === null) return { sql: "1 = 1", args: [] };
  const ids = subtreeDeckIds(db, deckId);
  return { sql: `c.deck_id IN (${holes(ids.length)})`, args: ids };
}

/**
 * The same fragment, for a TAG rather than a deck.
 *
 * Zach, 2026-09-18, wanting `#Mathematics` in a card's text to be tappable. What
 * a tap should then show is the tag's cards, and the first cut showed a SEARCH
 * for the word instead: 18 hits where 9 carry the tag, because the other 9 merely
 * say "mathematics" somewhere. A link that lands next to the answer is not a link.
 *
 * DESCENDANTS COUNT, and that is the whole reason this is a prefix and not an `=`.
 * `tags.path` is a materialised path — SPEC's "store the full path string and
 * index every prefix, and arbitrary nesting depth falls out with no schema
 * change" — so `Dialect` has to reach the 2 cards tagged `Dialect/Kansai`, which
 * are the only cards `Dialect` has. As a synthesised ancestor it carries none of
 * its own (`src/import/tags.ts`: it exists because `parent_path` is a foreign key
 * onto `path`), so an `=` would open an empty gallery on a tag the sidebar shows.
 *
 * NO `LIKE`, AND THAT IS THE SECOND THING THIS GOT WRONG. The first cut matched
 * the prefix with `LIKE ? ESCAPE '\'`, which needs a backslash to survive being
 * written to disk — it did not, the clause reached SQLite as `ESCAPE ''`, and
 * every tag tap died on *"ESCAPE expression must be a single character"*. A
 * `substr` comparison needs no escaping, admits no wildcard, and is exact: a tag
 * called `a_b` cannot quietly match `axb`. `test/app-deck-scope.test.ts` pins it.
 */
export function scopeToTag(tagPath: string): { sql: string; args: string[] } {
  return {
    sql:
      "c.id IN (SELECT ct.card_id FROM card_tags ct WHERE ct.tag_path = ? " +
      "OR substr(ct.tag_path, 1, length(?) + 1) = ? || '/')",
    args: [tagPath, tagPath, tagPath],
  };
}
