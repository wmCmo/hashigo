import type { SqliteHandle } from "../db/browser.js";
import { linkDisplayText, parseWikiLinks } from "../text/render.js";

interface ValueRow {
  card_id: string;
  field_id: string;
  value: string;
}

interface LinkRow {
  from_card_id: string;
  to_card_id: string;
  display_text: string;
  field_id: string;
  ordinal: number;
}

export interface ReconcileReport {
  readonly cards: number;
  readonly rows: number;
}

const key = (r: LinkRow): string =>
  [r.field_id, r.ordinal, r.to_card_id, r.display_text].join(String.fromCharCode(0));

export function reconcileCardLinks(db: SqliteHandle): ReconcileReport {
  const values = db
    .prepare(
      `SELECT v.card_id, v.field_id, v.value
         FROM card_field_values v JOIN cards c ON c.id = v.card_id
        WHERE instr(v.value, '[[') > 0`,
    )
    .all() as ValueRow[];
  let names: Map<string, string> | null = null;
  const resolveName = (id: string): string => {
    names ??= new Map(
      (db.prepare("SELECT id, name FROM cards").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]),
    );
    return names.get(id) ?? "";
  };

  const wanted = new Map<string, LinkRow[]>();
  for (const { card_id, field_id, value } of values) {
    let ordinal = 0;
    for (const link of parseWikiLinks(value)) {
      const rows = wanted.get(card_id) ?? [];
      rows.push({
        from_card_id: card_id,
        to_card_id: link.target,
        display_text: linkDisplayText(link, resolveName),
        field_id,
        ordinal: ordinal++,
      });
      wanted.set(card_id, rows);
    }
  }

  const stored = new Map<string, LinkRow[]>();
  for (const row of db
    .prepare(
      `SELECT from_card_id, to_card_id, display_text, field_id, ordinal
         FROM card_links WHERE field_id IS NOT NULL`,
    )
    .all() as LinkRow[]) {
    const rows = stored.get(row.from_card_id) ?? [];
    rows.push(row);
    stored.set(row.from_card_id, rows);
  }

  const differs = (cardId: string): boolean => {
    const a = (wanted.get(cardId) ?? []).map(key).sort();
    const b = (stored.get(cardId) ?? []).map(key).sort();
    return a.length !== b.length || a.some((k, i) => k !== b[i]);
  };
  const stale = [...new Set([...wanted.keys(), ...stored.keys()])].filter(differs);
  if (stale.length === 0) return { cards: 0, rows: 0 };

  const clear = db.prepare("DELETE FROM card_links WHERE from_card_id = ? AND field_id IS NOT NULL");
  const insert = db.prepare(
    `INSERT INTO card_links (from_card_id, to_card_id, display_text, field_id, ordinal)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let rows = 0;
  db.transaction(() => {
    for (const cardId of stale) {
      clear.run(cardId);
      for (const r of wanted.get(cardId) ?? []) {
        insert.run(r.from_card_id, r.to_card_id, r.display_text, r.field_id, r.ordinal);
        rows += 1;
      }
    }
  })();
  return { cards: stale.length, rows };
}
