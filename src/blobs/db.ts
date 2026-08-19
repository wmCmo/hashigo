/**
 * Where the database's addresses meet the store's payloads.
 *
 * `blobs` says WHAT a blob is — its address, its sniffed mime, its size, and
 * (when it came from a generator) the identity tuple that produced it. It never
 * says WHERE the payload is. These functions are the join: give them a store
 * and they resolve, audit, or reclaim.
 *
 * THE SELF-HEAL THAT MOCHI NEVER HAD. Mochi's failure mode was a card pointing
 * at an attachment that no longer existed, with nothing able to notice or fix
 * it: 7,974 dangling cache pointers and 8,958 tombstones in the corpus, and a
 * manual re-sync as the only remedy. Here a missing payload is (a) detectable,
 * because `auditBlobStore` compares the two sides, and (b) usually repairable
 * without asking the user anything, because `source_text`/`voice`/`lang`/
 * `options` are on the row — 10,799 of the corpus's 10,816 media blobs carry
 * the provenance needed to regenerate themselves. The other 17 are files whose
 * cache entry Mochi had already lost.
 *
 * REFCOUNTS, NOT TOMBSTONES. `blob_refs` triggers maintain `blobs.refcount`, so
 * "is anything still using this?" is a column read rather than a graph walk.
 * `sweepUnreferenced` is the only thing that deletes a payload, and it deletes
 * only at zero. There is no deleted flag anywhere.
 */

import type { Db } from "../db/index.js";

import { assertAddress } from "./address.js";
import { BlobMissingError, type BlobStore } from "./store.js";

export interface BlobRow {
  readonly hash: string;
  readonly kind: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly refcount: number;
  /** True when the payload is in the row rather than the store. */
  readonly inline: boolean;
  /** Identity tuple, when this blob came from a generator. */
  readonly sourceText: string | null;
  readonly voice: string | null;
  readonly lang: string | null;
}

interface RawRow {
  hash: string;
  kind: string;
  mime: string;
  byte_size: number;
  refcount: number;
  inline: number;
  source_text: string | null;
  voice: string | null;
  lang: string | null;
}

const SELECT_ROW = `
  SELECT hash, kind, mime, byte_size, refcount,
         (bytes IS NOT NULL) AS inline, source_text, voice, lang
    FROM blobs`;

function shape(row: RawRow): BlobRow {
  return {
    hash: row.hash,
    kind: row.kind,
    mime: row.mime,
    byteSize: row.byte_size,
    refcount: row.refcount,
    inline: row.inline === 1,
    sourceText: row.source_text,
    voice: row.voice,
    lang: row.lang,
  };
}

/** The row, without its payload. Null when the address is unknown. */
export function blobRow(db: Db, hash: string): BlobRow | null {
  const row = db.prepare(`${SELECT_ROW} WHERE hash = ?`).get(assertAddress(hash)) as
    | RawRow
    | undefined;
  return row === undefined ? null : shape(row);
}

/**
 * The payload. Inline bytes if the row carries them, otherwise the store's copy
 * — which is looked up by hash, so it does not matter where the store is today.
 */
export function readBlob(db: Db, hash: string, store: BlobStore | null = null): Uint8Array {
  assertAddress(hash);
  const inline = db.prepare("SELECT bytes FROM blobs WHERE hash = ?").pluck().get(hash) as
    | Buffer
    | null
    | undefined;
  if (inline === undefined) throw new BlobMissingError(hash, "the database");
  if (inline !== null) return inline;
  if (store === null) {
    throw new BlobMissingError(hash, "no store was supplied and the row has no inline bytes");
  }
  return store.read(hash);
}

export interface StoreAudit {
  /** Rows in `blobs`. */
  readonly blobs: number;
  /** Rows whose payload is in the row itself. */
  readonly inline: number;
  /** Rows whose payload the store holds. */
  readonly present: number;
  /** Rows whose payload is nowhere. THIS IS THE NUMBER THAT MUST BE ZERO. */
  readonly missing: number;
  /** Missing payloads that carry enough provenance to be regenerated. */
  readonly missingRegenerable: number;
  /** Missing payloads with no identity tuple: genuinely lost. */
  readonly missingLost: number;
  /** Store payloads no row refers to — an interrupted import, or a swept row. */
  readonly orphaned: number;
  /** Rows at refcount 0: reclaimable by `sweepUnreferenced`. */
  readonly unreferenced: number;
  /** Store payloads whose size disagrees with the row. */
  readonly sizeMismatched: number;
  readonly missingHashes: readonly string[];
  readonly orphanedHashes: readonly string[];
}

/**
 * Compare both sides. Cheap: one table scan and one `stat` per blob, no reads.
 * Pass `verify: true` to rehash every payload instead, which is 657 MB of I/O
 * on the corpus and is what the acceptance test does once.
 */
export function auditBlobStore(
  db: Db,
  store: BlobStore,
  options: { readonly verify?: boolean; readonly sampleLimit?: number } = {},
): StoreAudit {
  const limit = options.sampleLimit ?? 20;
  const rows = db.prepare(SELECT_ROW).all() as RawRow[];
  const known = new Set<string>();
  let inline = 0;
  let present = 0;
  let missing = 0;
  let missingRegenerable = 0;
  let missingLost = 0;
  let unreferenced = 0;
  let sizeMismatched = 0;
  const missingHashes: string[] = [];

  for (const row of rows) {
    known.add(row.hash);
    if (row.refcount === 0) unreferenced += 1;
    if (row.inline === 1) {
      inline += 1;
      continue;
    }
    const size = store.size(row.hash);
    const ok = size !== null && (options.verify === true ? store.verify(row.hash) : true);
    if (!ok) {
      missing += 1;
      if (row.source_text !== null) missingRegenerable += 1;
      else missingLost += 1;
      if (missingHashes.length < limit) missingHashes.push(row.hash);
      continue;
    }
    present += 1;
    if (size !== row.byte_size) sizeMismatched += 1;
  }

  const orphanedHashes: string[] = [];
  let orphaned = 0;
  for (const hash of store.list()) {
    if (known.has(hash)) continue;
    orphaned += 1;
    if (orphanedHashes.length < limit) orphanedHashes.push(hash);
  }

  return {
    blobs: rows.length,
    inline,
    present,
    missing,
    missingRegenerable,
    missingLost,
    orphaned,
    unreferenced,
    sizeMismatched,
    missingHashes,
    orphanedHashes,
  };
}

export interface SweepResult {
  readonly rowsDeleted: number;
  readonly payloadsRemoved: number;
  readonly bytesReclaimed: number;
}

/**
 * Reclaim every blob nothing references: the row first (the schema's
 * `blobs_no_delete_while_referenced` trigger is the backstop), then the
 * payload. Deleting the row first means a crash between the two leaves an
 * orphaned payload, which `auditBlobStore` reports and a later sweep removes —
 * the failure mode is wasted disk, never a dangling reference.
 */
export function sweepUnreferenced(
  db: Db,
  store: BlobStore | null = null,
  options: { readonly dryRun?: boolean } = {},
): SweepResult {
  const doomed = db
    .prepare("SELECT hash, byte_size, (bytes IS NOT NULL) AS inline FROM blobs WHERE refcount = 0")
    .all() as { hash: string; byte_size: number; inline: number }[];
  if (options.dryRun === true) {
    return {
      rowsDeleted: 0,
      payloadsRemoved: 0,
      bytesReclaimed: doomed.reduce((sum, row) => sum + row.byte_size, 0),
    };
  }

  const remove = db.prepare("DELETE FROM blobs WHERE hash = ? AND refcount = 0");
  let rowsDeleted = 0;
  db.transaction(() => {
    for (const row of doomed) rowsDeleted += remove.run(row.hash).changes;
  })();

  let payloadsRemoved = 0;
  let bytesReclaimed = 0;
  if (store !== null) {
    for (const row of doomed) {
      if (row.inline === 1) continue;
      if (store.remove(row.hash)) {
        payloadsRemoved += 1;
        bytesReclaimed += row.byte_size;
      }
    }
  }
  return { rowsDeleted, payloadsRemoved, bytesReclaimed };
}

// ---------------------------------------------------------------------------
// The acceptance query: no LOCATION anywhere in the database.
// ---------------------------------------------------------------------------

/**
 * What a location looks like, as one regex, in one place.
 *
 * THIS PREDICATE USED TO BE A PAIR OF COPY-PASTED SQL `LIKE` CHAINS — one in
 * `src/blobs/cli.ts`, one in `test/blobs.test.ts` — and it caught four of the
 * eight shapes a Windows path can take. Probed directly, it missed:
 *
 *   C:/Users/Zach/media/x.mp3      drive letter with FORWARD slashes
 *   \\NAS\media\x.mp3             UNC share
 *   file:///D:/media/x.mp3         file URL, drive form
 *   file:///home/zach/x.mp3        file URL, POSIX form
 *
 * The forward-slash form is the one that mattered: it is what this CLI's own
 * `--store C:/elsewhere` usage line takes, what `path.posix` produces, and what
 * a hand-edited config would most likely contain. A check that green-lights the
 * shape its own documentation uses is not a check.
 *
 * THE HARD PART IS THE FALSE POSITIVES, WHICH IS WHY THIS IS NOT `%:/%`.
 * `https://jisho.org/search/...` and `https://takoboto.jp/` are all over the
 * corpus, and `s:/` inside `https:/` is a drive letter as far as a naive
 * pattern is concerned. A drive letter is a SINGLE letter with a non-letter (or
 * nothing) in front of it, which needs a lookbehind — so this is a JS regex
 * registered as a SQL function rather than a `LIKE` chain. SQLite cannot
 * express it, and pretending otherwise is what produced the half-blind version.
 *
 * `exports` counts only with a separator against it. Card `BE2i4rWu` in the
 * English deck defines *tariff* as "a tax or duty to be paid on a particular
 * class of imports or exports." — the user's own writing, and the one place the
 * bare word occurs in the corpus.
 */
export const LOCATION_PATTERN =
  // A regex LITERAL, not a built string: the escaping is hard enough once.
  //   [A-Za-z]:[\/]     C:\… and C:/…, with a lookbehind so `https://` is not
  //                     a drive called `s`. This is the branch the LIKE chain
  //                     could not express and therefore did not have.
  //   \\\\[^\\/\s]      \\server\share. TWO backslashes, so the single `\` the
  //                     基本情報 formula cards use for division — 変動費率＝変動費 \ 売上,
  //                     and LaTeX \times — is not a path. Getting this wrong
  //                     flags 45 rows of the user's own arithmetic.
  //   \/[^/\s]+\/[^/\s]  /home/zach/... at a BOUNDARY, not only at ^.
  //                     An embedded POSIX path slipped the anchored
  //                     version. Boundary still excludes https://host/p
  //                     (that / follows a colon) and the division rows.
  //   file:\/\/         both file:// forms.
  //   exports           only with a separator against it.
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\\/\s]|(?:^|[\s"'(\[])\/[^/\s]+\/[^/\s]|file:\/\/|[\\/]exports|exports[\\/]/;

/** Bytes of a BLOB-typed value decoded and scanned. A path is short and early. */
export const LOCATION_SCAN_BYTES = 4096;

export interface LocationSweep {
  /** `table.column: n row(s)` for every column holding a location. Empty is the pass. */
  readonly offenders: readonly string[];
  readonly columns: number;
  readonly tables: number;
}

/**
 * Sweep every column of every real table for a location.
 *
 * BLOB-typed columns are included, capped at `LOCATION_SCAN_BYTES` — the older
 * version skipped them by declared type, which left `blobs.bytes` (26,947
 * inline payloads, all of them text generations) unswept. The cap is what keeps
 * `--inline-blobs` from decoding 657 MB of mp3 as text; it is a real limit and
 * is stated rather than hidden.
 *
 * FTS shadow tables are skipped. They are a derived copy of `cards`, which is
 * swept directly, and their internal columns hold tokeniser state rather than
 * text.
 */
export function findLocations(db: Db): LocationSweep {
  db.function("hashigo_is_location", { deterministic: true }, (value: unknown) => {
    if (value === null || value === undefined) return 0;
    const text =
      typeof value === "string"
        ? value
        : Buffer.isBuffer(value)
          ? value.subarray(0, LOCATION_SCAN_BYTES).toString("utf8")
          : String(value);
    return LOCATION_PATTERN.test(text) ? 1 : 0;
  });

  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql LIKE 'CREATE TABLE%'`,
      )
      .pluck()
      .all() as string[]
  ).filter((name) => !name.includes("_fts"));

  const offenders: string[] = [];
  let columns = 0;
  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
      name: string;
      type: string;
    }[];
    for (const column of cols) {
      columns += 1;
      const quoted = `"${column.name.replace(/"/g, '""')}"`;
      const scanned = /BLOB/i.test(column.type)
        ? `substr(${quoted}, 1, ${LOCATION_SCAN_BYTES})`
        : quoted;
      const hits = db
        .prepare(
          `SELECT count(*) FROM ${JSON.stringify(table)}
            WHERE ${quoted} IS NOT NULL AND hashigo_is_location(${scanned}) = 1`,
        )
        .pluck()
        .get() as number;
      if (hits > 0) offenders.push(`${table}.${column.name}: ${hits} row(s)`);
    }
  }
  return { offenders, columns, tables: tables.length };
}
