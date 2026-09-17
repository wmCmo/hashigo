/**
 * TAKING THE LOCALLY-AUTHORED FIELDS INTO THE CARD DATABASE.
 *
 * Zach, 2026-09-17, over a 風潮 card on his phone: *"somehow ojad field is not
 * here..."*. It had been fixed on the laptop an hour earlier and could not cross,
 * because **the card database is re-fetched only when `seedReviews` differs** and
 * authoring a field value moves that by exactly zero. That is the audio bug of
 * 2026-09-12 one file over: a seed that changed for a reason the freshness check
 * cannot see, skipped in green, for ever.
 *
 * So the local fields get their own seed file with its own identity
 * (`field_meta.created`), and this merges it in. `ojad`, `型`, `読み`, `かな主流`
 * — everything `template_fields.local = 1`, which is decision 9's definition of
 * "exists here and in no Mochi export" and so exactly the set with no other way
 * across.
 *
 * ─── INSERT-ONLY, AND THAT IS THE WHOLE SAFETY ARGUMENT ─────────────────────
 *
 * `ON CONFLICT DO NOTHING` on both tables, because **this device authors values
 * too**: `setField` is the card editor, and `flipReading` is decision 29's audit
 * loop — the `Reading → true` button he presses constantly. Overwriting would
 * take those back silently, on a boot that looked like a download.
 *
 * (`Reading` is `local = 0` — Mochi owns it — so it is not in this file at all.
 * That is belt as well as braces. `型` is `local = 1` and he CAN edit it here.)
 *
 * ─── WHAT INSERT-ONLY DOES NOT SOLVE, SAID OUT LOUD RATHER THAN HIDDEN ──────
 *
 * A value that CHANGED on the laptop does not cross. That is not an oversight and
 * it is not fixable here: the device may hold his edit of the same row, and
 * choosing between them needs a clock. `card_field_values` has none — decision 33
 * named that gap and deferred it to a schema bump. So `differs` is counted and
 * REPORTED; a value stuck on the device must not look like one in agreement.
 *
 * ─── AND WHY THERE IS NO COUNT SHORTCUT ─────────────────────────────────────
 *
 * The first cut skipped the whole step when the device already held as many rows
 * as the file serves. That is exactly the state a device reaches after one
 * successful merge — and it is also, by coincidence, the state this device was
 * in while MISSING nine of the served rows and holding nine others the file does
 * not have. 7,567 = 7,567, and the nine were invisible. Counting rows cannot see
 * content. Conflicting inserts cost one statement each; being unable to answer
 * the question cost a rebuild to find out.
 *
 * ─── WHY THIS FILE AND NOT THE SAME SQL IN `db.worker.ts` ───────────────────
 *
 * `test/` cannot import the worker — it opens with a webworker reference and
 * touches `self` at load. `app/deck-scope.ts` exists for this reason and says why:
 * worker SQL nobody can test is how the deck archive shipped INVERTED. Structural
 * `FieldsDb`, so the worker runs it against OPFS and the test runs it against the
 * real corpus in Node. No imports, so the root `tsconfig.json`'s `app/` exclusion
 * cannot hide it from `test/`.
 */

/** The slice of a SQLite handle this needs. Satisfied by BrowserDb and better-sqlite3. */
export interface FieldsStatement {
  all(...params: readonly unknown[]): unknown[];
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): { changes?: number } | unknown;
}
export interface FieldsDb {
  prepare(sql: string): FieldsStatement;
}

export interface LocalFieldRow {
  readonly template_id: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly source_field_id: string | null;
  readonly options: string | null;
  readonly pos: number;
}

export interface LocalValueRow {
  readonly card_id: string;
  readonly field_id: string;
  readonly value: string;
}

export interface MergeReport {
  /** Values this device did not have, now inserted. */
  readonly added: number;
  /** Values the device holds with DIFFERENT text. Left alone — see the header. */
  readonly differs: number;
  /** Values whose card is not on this device. 8,958 tombstones make this real. */
  readonly unknownCards: number;
  /** Field definitions inserted. */
  readonly fields: number;
}

const SELECT_FIELDS = `SELECT template_id, id, name, type, source_field_id, options, pos
                         FROM local_fields`;
const SELECT_VALUES = `SELECT card_id, field_id, value FROM local_values`;

/** How many local-field values this device already holds. For the boot log. */
export const COUNT_HELD = `SELECT count(*) AS n FROM card_field_values v
                             JOIN cards c ON c.id = v.card_id
                             JOIN template_fields f ON f.template_id = c.template_id
                                                   AND f.id = v.field_id
                            WHERE f.local = 1`;

/**
 * Merge one seed file's local fields into the card database.
 *
 * `served` and `values` come from the seed file; `db` is the card database. The
 * caller owns the transaction — the worker wraps both tables in one so a boot
 * that dies half way leaves nothing partial.
 */
export function mergeLocalFields(
  db: FieldsDb,
  fields: readonly LocalFieldRow[],
  values: readonly LocalValueRow[],
): MergeReport {
  // THE FIELD DEFINITIONS FIRST. A value whose field the template does not
  // declare renders nothing at all — which is how `ojad` itself would arrive on
  // a device that had never seen the field.
  const putField = db.prepare(
    `INSERT INTO template_fields
       (template_id, id, name, type, source_field_id, options, pos, local)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (template_id, id) DO NOTHING`,
  );
  const putValue = db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value)
     VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO NOTHING`,
  );
  const knownCard = db.prepare("SELECT 1 AS n FROM cards WHERE id = ? LIMIT 1");
  const heldValue = db.prepare(
    "SELECT value AS v FROM card_field_values WHERE card_id = ? AND field_id = ?",
  );
  const changed = (result: unknown): number => Number((result as { changes?: number }).changes ?? 0);

  let fieldCount = 0;
  for (const row of fields) {
    fieldCount += changed(
      putField.run(
        row.template_id,
        row.id,
        row.name,
        row.type,
        row.source_field_id ?? null,
        row.options ?? null,
        row.pos,
      ),
    );
  }

  let added = 0;
  let differs = 0;
  let unknownCards = 0;
  for (const row of values) {
    // ASKED, not caught. `card_field_values` has a foreign key to `cards`, so a
    // value for a card this device does not hold would throw and take the whole
    // transaction — and every other value — with it.
    if (knownCard.get(row.card_id) === undefined) {
      unknownCards += 1;
      continue;
    }
    if (changed(putValue.run(row.card_id, row.field_id, row.value)) > 0) {
      added += 1;
      continue;
    }
    const held = heldValue.get(row.card_id, row.field_id) as { v: string } | undefined;
    if (held !== undefined && held.v !== row.value) differs += 1;
  }
  return { added, differs, unknownCards, fields: fieldCount };
}

/** Read the rows a seed file serves. Separate so the merge can be tested without one. */
export function readSeedFields(seed: FieldsDb): {
  fields: LocalFieldRow[];
  values: LocalValueRow[];
} {
  return {
    fields: seed.prepare(SELECT_FIELDS).all() as LocalFieldRow[],
    values: seed.prepare(SELECT_VALUES).all() as LocalValueRow[],
  };
}
