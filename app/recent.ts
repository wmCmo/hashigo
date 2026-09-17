/**
 * WHAT Ctrl+K SHOWS BEFORE HE HAS TYPED ANYTHING.
 *
 * Zach, 2026-09-17, about Notion: *"when you hit your ctrl +k for the first time, it
 * would list pages that it thinks would relevant to you, even if you never search, how
 * does it do that? can we do it too?"*
 *
 * Notion is not predicting. It keeps an ACCESS LOG — every page you open writes a
 * visit — and an empty palette is that log, newest first. Recency of *your own
 * attention* is the strongest signal any of these apps have, and it needs no model.
 *
 * What the palette did instead was ask `browse` with an empty query, which falls
 * through to the deck listing: `ORDER BY c.name LIMIT 40`. Over the whole collection
 * that is not a neutral default, it is noise — the first ten rows of his real corpus:
 *
 *     ...にも程がある · ...は...に限る · 124652706 · 13458922 · 142796732 · 143710122
 *     · 149924640 · 158370089 · 169199604 · 190891495
 *
 * Eight of the first ten are cards whose name is an opaque number. The most valuable
 * slot in the search UI was spending itself on the alphabet.
 *
 * ── THE SIGNAL THAT LOOKS RIGHT AND IS NOT: `last_reviewed_at` ──
 *
 * "Recently reviewed" is the obvious first idea and it is measurably wrong here.
 * **All 103,110 imported reviews carry `time_unknown = 1`** and their timestamps are
 * midnight, so `card_tracks.last_reviewed_at` holds 307 distinct values across 7,716
 * cards and the newest days tie 16, 22, 69 and 52 rows deep. Ordering by it means
 * ordering the top of the list ARBITRARILY — the same defect as the alphabet, wearing
 * a better name. It also cost 182 ms as a correlated subquery, against 0.5 ms for the
 * ranking below. It is deliberately not used.
 *
 * ── THE THREE THAT ARE REAL ──
 *
 *   1. PINNED. 0 cards today, but the card menu already says pinning "keeps it near
 *      the top of a search", and this is the only place that promise can be kept
 *      before a query exists.
 *   2. OPENED HERE. `app/visits.ts`, a `localStorage` log of cards he deliberately
 *      opened — the Notion mechanism, and the only signal in the app with event
 *      resolution. Per device, like every other `localStorage` key; it is not in the
 *      sync payload and needs no schema change (decision 41).
 *   3. EDITED. `cards.updated_at` is Mochi's real per-card edit time and it SURVIVED
 *      the import — 787 distinct days, full timestamps, indexed (`cards_updated`).
 *      It reads as a Notion recents list already: 維持 · さることながら · persecute ·
 *      正答 · 群衆 · ford · さまよう · 繰り広げる.
 *
 * (3) is what makes the list good on a device that has never been used, which is the
 * case an access log alone cannot answer and the reason this is not purely a log.
 *
 * Lives here rather than in `db.worker.ts` for the reason `app/deck-scope.ts` gives:
 * `test/` cannot import the worker, so worker SQL that nobody can test is how the
 * archive shipped inverted. Same structural `ScopedDb`, both sides.
 */

import type { ScopedDb } from "./deck-scope.js";

/** A row in the browse-hit shape, before the worker maps it to the wire type. */
export interface SuggestRow {
  readonly id: string;
  readonly name: string;
  readonly deck: string | null;
  readonly archived: number;
  readonly pinned: number;
}

export interface SuggestOptions {
  /** From `scopeToSubtree` — so a deck-scoped palette suggests inside that deck. */
  readonly scopeSql: string;
  readonly scopeArgs: readonly string[];
  /** Card ids he opened here, NEWEST FIRST. See `app/visits.ts`. */
  readonly visited: readonly string[];
  readonly limit: number;
}

const COLUMNS = `c.id AS id, c.name AS name, c.archived AS archived, c.pinned AS pinned,
                 dp.path AS deck`;
const FROM = `FROM cards c LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id`;

function holes(count: number): string {
  return new Array(count).fill("?").join(", ");
}

/**
 * Pinned, then opened, then edited — deduped, in that order, up to `limit`.
 *
 * The three queries are separate on purpose. One `ORDER BY` over a computed score
 * would have to invent weights between "pinned" and "three days ago", and there is
 * nothing to derive those from; the order of the tiers IS the ranking and it is
 * readable. Three indexed reads are cheaper than the scoring query would be anyway.
 */
export function suggestCards(db: ScopedDb, options: SuggestOptions): SuggestRow[] {
  const { scopeSql, scopeArgs, limit } = options;
  const out: SuggestRow[] = [];
  const seen = new Set<string>();

  const take = (rows: SuggestRow[]): void => {
    for (const row of rows) {
      if (seen.has(row.id) || out.length >= limit) continue;
      seen.add(row.id);
      out.push(row);
    }
  };

  // `cards_pinned` is partial (`WHERE pinned = 1`), so this reads exactly the pinned
  // rows — the size of his attention, not of the corpus.
  take(
    db
      .prepare(
        `SELECT ${COLUMNS} ${FROM}
          WHERE c.pinned = 1 AND ${scopeSql}
          ORDER BY c.updated_at DESC LIMIT ?`,
      )
      .all(...scopeArgs, limit) as SuggestRow[],
  );

  // A visited id can be gone — deleted here, or never on this device at all, since the
  // log is per-device and the card database is not. The query drops it silently, which
  // is the whole error handling this needs.
  const visited = options.visited.slice(0, limit);
  if (visited.length > 0 && out.length < limit) {
    const rows = db
      .prepare(`SELECT ${COLUMNS} ${FROM} WHERE c.id IN (${holes(visited.length)}) AND ${scopeSql}`)
      .all(...visited, ...scopeArgs) as SuggestRow[];
    // SQL returns them in whatever order it likes; the LOG's order is the ranking.
    const byId = new Map(rows.map((row) => [row.id, row]));
    take(visited.map((id) => byId.get(id)).filter((row): row is SuggestRow => row !== undefined));
  }

  // ARCHIVED CARDS ARE EXCLUDED FROM THIS TIER ONLY, and the reason is measured.
  //
  // `cards.updated_at` is not only Mochi's edit time. `src/backup/archive.ts`'s
  // `UPDATE_CARD_STATE` stamps `strftime('now')` on every card whose flags the
  // archive carries — and the archive stores only NON-DEFAULT rows, which is
  // exactly the archived and pinned ones. So decision 17's restore moves all 244
  // archived cards to the top of "recently edited", in one block, on the same
  // millisecond.
  //
  // That is not a hypothetical. The Browser pane's device had had a restore, and
  // the first empty Ctrl+K after this shipped was FORTY archived cards and
  // nothing else. Reproduced on a copy: export, apply, and the top twelve by
  // `updated_at` are `369768579 · ある · 果‎物 · 払う · 雨 …`, the same nine names
  // in the same order the app showed.
  //
  // The narrow fix would be to stop the restore stamping `now`. That is the
  // deeper bug and it is NOT done here: the archive carries no per-card clock to
  // restore instead, so fixing it is a format change, and `cards.updated_at` is
  // decision 33's LWW clock for `archived`/`pinned` — moving it moves who wins a
  // sync. Worth its own look, not worth doing inside a search suggestion.
  //
  // This is the right rule regardless of the timestamp, which is why it belongs
  // here anyway: an archived card is one he took OUT of rotation, and offering it
  // before he has typed anything is a guess he has already answered. Search still
  // finds it the moment he types — the row even has its own `archived` label.
  // The other two tiers keep theirs: a PIN is an explicit request, and an OPEN is
  // something he just did.
  if (out.length < limit) {
    take(
      db
        .prepare(
          `SELECT ${COLUMNS} ${FROM}
            WHERE c.archived = 0 AND ${scopeSql}
            ORDER BY c.updated_at DESC LIMIT ?`,
        )
        .all(...scopeArgs, limit) as SuggestRow[],
    );
  }

  return out;
}
