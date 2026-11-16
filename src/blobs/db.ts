import type { SqliteHandle } from "../db/browser.js";

import { assertAddress } from "./address.js";
import { BlobMissingError, type BlobStore } from "./store.js";

export interface BlobRow {
  readonly hash: string;
  readonly kind: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly refcount: number;
  readonly inline: boolean;
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

export function blobRow(db: SqliteHandle, hash: string): BlobRow | null {
  const row = db.prepare(`${SELECT_ROW} WHERE hash = ?`).get(assertAddress(hash)) as
    | RawRow
    | undefined;
  return row === undefined ? null : shape(row);
}

export function readBlob(
  db: SqliteHandle,
  hash: string,
  store: BlobStore | null = null,
): Uint8Array {
  assertAddress(hash);
  const inline = db.prepare("SELECT bytes FROM blobs WHERE hash = ?").pluck().get(hash) as
    | Uint8Array
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
  readonly blobs: number;
  readonly inline: number;
  readonly present: number;
  readonly missing: number;
  readonly missingRegenerable: number;
  readonly missingLost: number;
  readonly orphaned: number;
  readonly unreferenced: number;
  readonly sizeMismatched: number;
  readonly missingHashes: readonly string[];
  readonly orphanedHashes: readonly string[];
}

export function auditBlobStore(
  db: SqliteHandle,
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
  readonly heldByGrace: number;
  readonly bytesHeldByGrace: number;
}

export const SWEEP_GRACE_DAYS = 7;

export interface SweepOptions {
  readonly dryRun?: boolean;
  readonly graceDays?: number;
  readonly now?: string;
}

export function sweepUnreferenced(
  db: SqliteHandle,
  store: BlobStore | null = null,
  options: SweepOptions = {},
): SweepResult {
  const graceDays = options.graceDays ?? SWEEP_GRACE_DAYS;
  const candidates = db
    .prepare(
      `SELECT hash, byte_size, (bytes IS NOT NULL) AS inline, unreferenced_at
         FROM blobs WHERE refcount = 0`,
    )
    .all() as {
    hash: string;
    byte_size: number;
    inline: number;
    unreferenced_at: string | null;
  }[];

  const cutoff =
    graceDays <= 0
      ? null
      : new Date(
          (options.now === undefined ? Date.now() : Date.parse(options.now)) -
            graceDays * 86_400_000,
        ).toISOString();

  const doomed: typeof candidates = [];
  let heldByGrace = 0;
  let bytesHeldByGrace = 0;
  for (const row of candidates) {
    const held =
      cutoff !== null && row.unreferenced_at !== null && row.unreferenced_at > cutoff;
    if (held) {
      heldByGrace += 1;
      bytesHeldByGrace += row.byte_size;
    } else {
      doomed.push(row);
    }
  }
  if (options.dryRun === true) {
    return {
      rowsDeleted: 0,
      payloadsRemoved: 0,
      bytesReclaimed: doomed.reduce((sum, row) => sum + row.byte_size, 0),
      heldByGrace,
      bytesHeldByGrace,
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
    const removals = (): void => {
      for (const row of doomed) {
        if (row.inline === 1) continue;
        if (store.remove(row.hash)) {
          payloadsRemoved += 1;
          bytesReclaimed += row.byte_size;
        }
      }
    };
    if (store.batch === undefined) removals();
    else store.batch(removals);
  }
  return { rowsDeleted, payloadsRemoved, bytesReclaimed, heldByGrace, bytesHeldByGrace };
}

export const LOCATION_PATTERN =
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\\/\s]|(?:^|[\s"'(\[])\/[^/\s]+\/[^/\s]|file:\/\/|[\\/]exports|exports[\\/]/;

export const LOCATION_SCAN_BYTES = 4096;

export interface LocationSweep {
  readonly offenders: readonly string[];
  readonly columns: number;
  readonly tables: number;
  readonly excluded: readonly string[];
}

export interface FindLocationsOptions {
  readonly exclude?: readonly string[];
}

export function findLocations(
  db: SqliteHandle,
  options: FindLocationsOptions = {},
): LocationSweep {
  const exclude = new Set(options.exclude ?? []);
  db.function("hashigo_is_location", { deterministic: true }, (value: unknown) => {
    if (value === null || value === undefined) return 0;
    const text =
      typeof value === "string"
        ? value
        : value instanceof Uint8Array
          ?
            new TextDecoder("utf-8", { fatal: false }).decode(
              value.subarray(0, LOCATION_SCAN_BYTES),
            )
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
  const excluded: string[] = [];
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
      if (hits === 0) continue;
      const where = `${table}.${column.name}`;
      if (exclude.has(where)) excluded.push(`${where}: ${hits} row(s)`);
      else offenders.push(`${where}: ${hits} row(s)`);
    }
  }
  return { offenders, columns, tables: tables.length, excluded };
}
