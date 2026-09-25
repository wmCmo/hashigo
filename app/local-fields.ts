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
 * ─── ひとつだけの例外: パイプラインが書いた値を、パイプラインが直すとき ──────
 *
 * 2026-09-25、`型` の未決 56 件を辞書で裁定したら、彼が既に持っているラベルの
 * うち 20 枚あまりが変わった。挿入のみでは一枚も届かない。けれど「どちらが新しいか」
 * に時計が要るのは、端末側が彼の編集かもしれないからで — 端末の値が、裁定の前に
 * OpenJTalk が書いたラベルと一字一句同じなら、それは彼の編集ではない。
 *
 * だから `local_corrections (card_id, field_id, was, value)`: 端末の値が `was` と
 * 完全に一致するときだけ `value` に置き換える (compare-and-swap)。彼が `e` で
 * 直した値は `was` と一致しないので触られず、従来どおり `differs` に数えられる。
 * 上の安全性の議論は一行も緩めていない — 置き換えるのは、彼が書いたのではないと
 * 証明できる値だけ。
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

/** 端末の値が `was` のままなら `value` に置き換える。ファイル 4 の `local_corrections`。 */
export interface LocalCorrectionRow {
  readonly card_id: string;
  readonly field_id: string;
  readonly was: string;
  readonly value: string;
}

export interface MergeReport {
  /** Values this device did not have, now inserted. */
  readonly added: number;
  /** Values the device holds with DIFFERENT text. Left alone — see the header. */
  readonly differs: number;
  /** 端末の値が `was` のままだったので、裁定後の値に置き換えたもの。 */
  readonly corrected: number;
  /** Values whose card is not on this device. 8,958 tombstones make this real. */
  readonly unknownCards: number;
  /** Field definitions inserted. */
  readonly fields: number;
}

const SELECT_FIELDS = `SELECT template_id, id, name, type, source_field_id, options, pos
                         FROM local_fields`;
const SELECT_VALUES = `SELECT card_id, field_id, value FROM local_values`;
const SELECT_CORRECTIONS = `SELECT card_id, field_id, was, value FROM local_corrections`;
// 2026-09-25 より前のファイルにはこの表が無い。無ければ訂正は零件で、それが正しい。
const HAS_CORRECTIONS = `SELECT 1 AS n FROM sqlite_master
                          WHERE type = 'table' AND name = 'local_corrections'`;

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
  corrections: readonly LocalCorrectionRow[] = [],
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
  const swap = db.prepare(
    `UPDATE card_field_values SET value = ?
      WHERE card_id = ? AND field_id = ? AND value = ?`,
  );
  const changed = (result: unknown): number => Number((result as { changes?: number }).changes ?? 0);
  const correctionFor = new Map(corrections.map((c) => [`${c.card_id}|${c.field_id}`, c]));

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
  let corrected = 0;
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
    if (held === undefined || held.v === row.value) continue;
    // 訂正は、配られている値そのものへの訂正に限る。`value` が違う訂正は古い
    // ファイルの残りか作り手の誤りで、どちらにしてもこの行の答えではない。
    const fix = correctionFor.get(`${row.card_id}|${row.field_id}`);
    if (fix !== undefined && fix.value === row.value && held.v === fix.was) {
      corrected += changed(swap.run(fix.value, row.card_id, row.field_id, fix.was));
      continue;
    }
    differs += 1;
  }
  return { added, differs, corrected, unknownCards, fields: fieldCount };
}

/** Read the rows a seed file serves. Separate so the merge can be tested without one. */
export function readSeedFields(seed: FieldsDb): {
  fields: LocalFieldRow[];
  values: LocalValueRow[];
  corrections: LocalCorrectionRow[];
} {
  return {
    fields: seed.prepare(SELECT_FIELDS).all() as LocalFieldRow[],
    values: seed.prepare(SELECT_VALUES).all() as LocalValueRow[],
    corrections:
      seed.prepare(HAS_CORRECTIONS).get() === undefined
        ? []
        : (seed.prepare(SELECT_CORRECTIONS).all() as LocalCorrectionRow[]),
  };
}
