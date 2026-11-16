import type { ScopedDb } from "./deck-scope.js";

export interface SuggestRow {
  readonly id: string;
  readonly name: string;
  readonly deck: string | null;
  readonly archived: number;
  readonly pinned: number;
}

export interface SuggestOptions {
  readonly scopeSql: string;
  readonly scopeArgs: readonly string[];
  readonly visited: readonly string[];
  readonly limit: number;
}

const COLUMNS = `c.id AS id, c.name AS name, c.archived AS archived, c.pinned AS pinned,
                 dp.path AS deck`;
const FROM = `FROM cards c LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id`;

function holes(count: number): string {
  return new Array(count).fill("?").join(", ");
}

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

  take(
    db
      .prepare(
        `SELECT ${COLUMNS} ${FROM}
          WHERE c.pinned = 1 AND ${scopeSql}
          ORDER BY c.updated_at DESC LIMIT ?`,
      )
      .all(...scopeArgs, limit) as SuggestRow[],
  );

  const visited = options.visited.slice(0, limit);
  if (visited.length > 0 && out.length < limit) {
    const rows = db
      .prepare(`SELECT ${COLUMNS} ${FROM} WHERE c.id IN (${holes(visited.length)}) AND ${scopeSql}`)
      .all(...visited, ...scopeArgs) as SuggestRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    take(visited.map((id) => byId.get(id)).filter((row): row is SuggestRow => row !== undefined));
  }

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
