/**
 * KEEP `card_links` IN STEP WITH THE TEXT — for cards written after the import.
 *
 * Zach, 2026-10-26, on 紺's card with nothing under it: *"is it just me or I don't
 * see it"*. 濃紺 links `[[紺|JGZk6vTL]]`, and the backlink list (`./backlinks.ts`)
 * printed nothing, because **only the importer ever wrote `card_links`**. Every
 * card made or edited in the app since — and every value a sync brought in —
 * kept its `[[…]]` in `card_field_values` and never got a row. 36 cards on that
 * date, and they are exactly the new 漢検 words, whose links all point at kanji.
 *
 * ONE RECONCILE, NOT A HOOK PER WRITER. Values are written from fourteen places
 * (the editor, local fields, sync's merge, the backup's apply, the accent tools
 * …), so a hook in each is a list that is already incomplete. This compares the
 * parse of every value holding `[[` with the stored FIELD-scoped rows, card by
 * card, and rewrites only the cards that differ — the same delete-then-insert as
 * `importLinks`, for its reason (an upsert by ordinal leaves a ghost tail).
 *
 * CONTENT-SCOPED ROWS (`field_id IS NULL`) ARE NEVER TOUCHED. They came from
 * Mochi's `content`, 889 of them point into text the importer discarded, and 66
 * of those are edges that exist nowhere else (`ImportLinksResult.inDiscardedContent`).
 * Nothing in the app writes `content`, so nothing here could rebuild them.
 *
 * BROWSER-PORTABLE: `SqliteHandle`, no `node:` import. The worker runs it.
 */
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
  /** Cards whose field-scoped rows were rewritten. 0 when the index was current. */
  readonly cards: number;
  /** Rows written for those cards. */
  readonly rows: number;
}

const key = (r: LinkRow): string =>
  [r.field_id, r.ordinal, r.to_card_id, r.display_text].join(String.fromCharCode(0));

/** Rewrite the field-scoped `card_links` of every card whose text says otherwise. */
export function reconcileCardLinks(db: SqliteHandle): ReconcileReport {
  // Values on cards that still exist: `from_card_id` is a foreign key, and an
  // orphaned value (a deleted card's) has no card to hang a row on.
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
