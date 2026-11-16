import type { SqliteHandle } from "../db/browser.js";

export interface Backlink {
  readonly cardId: string;
  readonly name: string;
  readonly deckPath: string;
  readonly archived: boolean;
}

const SELECT_BACKLINKS = `
SELECT DISTINCT l.from_card_id AS card_id, c.name AS name, dp.path AS deck_path,
       c.archived AS archived
  FROM card_links l
  JOIN cards c ON c.id = l.from_card_id
  LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id
 WHERE l.to_card_id = ? AND l.from_card_id <> l.to_card_id
 ORDER BY c.name, l.from_card_id`;

interface Row {
  card_id: string;
  name: string | null;
  deck_path: string | null;
  archived: number;
}

export function backlinksOf(db: SqliteHandle, cardId: string): Backlink[] {
  const rows = db.prepare(SELECT_BACKLINKS).all(cardId) as readonly Row[];
  return rows.map((row) => ({
    cardId: row.card_id,
    name: row.name ?? "",
    deckPath: row.deck_path ?? "(unknown)",
    archived: row.archived === 1,
  }));
}
