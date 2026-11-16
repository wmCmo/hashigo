export interface ScopedStatement {
  all(...params: readonly unknown[]): unknown[];
  run(...params: readonly unknown[]): unknown;
}
export interface ScopedDb {
  prepare(sql: string): ScopedStatement;
}

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

export function archiveSubtree(
  db: ScopedDb,
  rootId: string,
  to: 0 | 1,
): { deckIds: string[]; changed: string[] } {
  const deckIds = subtreeDeckIds(db, rootId);
  const marks = holes(deckIds.length);

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

export function scopeToSubtree(
  db: ScopedDb,
  deckId: string | null,
): { sql: string; args: string[] } {
  if (deckId === null) return { sql: "1 = 1", args: [] };
  const ids = subtreeDeckIds(db, deckId);
  return { sql: `c.deck_id IN (${holes(ids.length)})`, args: ids };
}

export function scopeToTag(tagPath: string): { sql: string; args: string[] } {
  return {
    sql:
      "c.id IN (SELECT ct.card_id FROM card_tags ct WHERE ct.tag_path = ? " +
      "OR substr(ct.tag_path, 1, length(?) + 1) = ? || '/')",
    args: [tagPath, tagPath, tagPath],
  };
}
