/**
 * WHAT LINKS HERE — the backward direction of `card_links`.
 *
 * Zach, 2026-09-14: *"i need to know which cards are linked with this, so... list
 * of back links?"*
 *
 * The importer writes `card_links` to answer "what does this card point at", and
 * gave it `card_links_target` so the question could be asked the other way round.
 * This is that index finally being read. 8,744 links across 4,335 cards;
 * **2,893 cards (37.5%) are the target of at least one**, which means the other
 * 62.5% get nothing and the caller must be able to say so cheaply.
 *
 * ─── THE SHAPE OF THE ANSWER, MEASURED ──────────────────────────────────────
 *
 * Distinct source cards per target: **p50 2 · p90 7 · p99 20 · max 45**. The five
 * heaviest targets are 人 (45 rows, 37 cards), 手 41, 物 41, 大 39, 出 38 — every
 * one a single kanji, which is where morphological decomposition is exactly what
 * he wants to see. **91.4% of linked cards have six sources or fewer**, which is
 * where `app/main.ts` puts its cap.
 *
 * ─── FOUR THINGS THE QUERY DOES ON PURPOSE ──────────────────────────────────
 *
 *   * **`DISTINCT`.** 876 (source, target) pairs occur twice — a compound naming
 *     the same component in two different fields. 人's 45 rows are 37 cards. A
 *     second identical row is a duplicate in a list, not a second fact.
 *   * **`from_card_id <> to_card_id`.** Exactly one card in the corpus links to
 *     itself. "This card links here" is a row that says nothing.
 *   * **an INNER join to `cards`** — for the NAME and the archived flag, not as a
 *     filter, and the asymmetry is worth knowing. `to_card_id` carries no foreign
 *     key by design (`schema.sql`: 8 targets point at decks that were never
 *     exported), so a FORWARD link can dangle and `src/render` has to cope. The
 *     backward direction cannot: `from_card_id` is
 *     `REFERENCES cards (id) ON DELETE CASCADE`, so deleting a card takes its
 *     outgoing links with it and a source row always resolves. (Asserted the
 *     other way round first, in this very comment. The fixture that was meant to
 *     prove it would not insert.)
 *   * **archived sources are RETURNED AND FLAGGED**, never dropped — 264 of them.
 *     That is the rule search already follows (`SearchOptions`), and for the same
 *     reason: a card he archived is still a card he wrote.
 *
 * BROWSER-PORTABLE, like everything else under `src/cards` — `SqliteHandle`, no
 * `node:` import. The review screen runs in an OPFS worker.
 */
import type { SqliteHandle } from "../db/browser.js";

/** One card that links to the card being asked about. */
export interface Backlink {
  readonly cardId: string;
  /** The source card's own name — NOT the link's display text. See below. */
  readonly name: string;
  /** How he tells 蟻-as-単語 from 蟻-as-言葉 apart. */
  readonly deckPath: string;
  readonly archived: boolean;
}

/**
 * THE SOURCE CARD'S NAME, NOT `display_text`, and that is the one judgement call
 * in this file.
 *
 * `app/links.ts` measured the corpus: **8,210 of 8,744 links (94%) display the
 * TARGET's name**, so `display_text` on a backlink row would print the card he is
 * already looking at, 94% of the time. The remaining 6% are inflections pointing
 * at a dictionary form (`[[越|4nKAg2kH]]` → 越す), where the display text is a
 * fragment of a word rather than a card he can go to. Either way the useful
 * identity is the source card, which is also what makes the row clickable.
 */
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

/**
 * Every card that links to `cardId`, by name.
 *
 * Ordered by name and then by id: `ORDER BY c.name` alone leaves same-named cards
 * in whatever order the scan produced, and two 蟻 rows that swap places between
 * two openings of the same card look like the list changed when it did not.
 */
export function backlinksOf(db: SqliteHandle, cardId: string): Backlink[] {
  const rows = db.prepare(SELECT_BACKLINKS).all(cardId) as readonly Row[];
  return rows.map((row) => ({
    cardId: row.card_id,
    name: row.name ?? "",
    // `loadCard` uses the same fallback for the same reason: a deck that is not in
    // `deck_paths` is a broken tree, and printing nothing hides it.
    deckPath: row.deck_path ?? "(unknown)",
    archived: row.archived === 1,
  }));
}
