/**
 * The blob store. The database holds addresses; this holds bytes.
 *
 * `address.ts`, `store.ts`, `sha256.ts`, `sqlite.ts` and `db.ts` are pure — no
 * `node:*`, no `better-sqlite3` — and are what the OPFS build imports. `sqlite.ts`
 * is the PRODUCTION backing in both halves: BLOB rows in a separate `blobs.db`,
 * because one-file-per-payload measured tens of times slower in a real browser --
 * 65× write / 20× read in `notes/browser-feasibility.md` §4, re-measured since at
 * 32×–37× write / 57×–95× read (see `sqlite.ts`'s header for the spread and why no
 * single multiplier is quotable). `node.ts` is the directory store, kept for
 * export and interop and no longer the default.
 *
 * Importing this barrel pulls in `node:fs` and `better-sqlite3` through
 * `node.ts`. A browser build must import the individual modules —
 * `./address.js`, `./store.js`, `./sqlite.js`, `./sha256.js`, `./db.js` — none of
 * which reach a platform.
 */

export {
  ADDRESS_PATTERN,
  SHARD_LENGTH,
  addressPath,
  assertAddress,
  isAddress,
  shardOf,
} from "./address.js";

export { Sha256, sha256Hex } from "./sha256.js";

export {
  BlobConflictError,
  BlobMissingError,
  MemoryBlobStore,
  type BlobStore,
  type BlobWriteResult,
} from "./store.js";

export {
  BATCH_FLUSH_BYTES,
  SQLITE_STORE_FORMAT,
  SQLITE_STORE_VERSION,
  STORE_PAGE_SIZE,
  SqliteBlobStore,
  openSqliteBlobStore,
  type Digest,
  type SqliteStoreOptions,
} from "./sqlite.js";

export {
  NodeBlobStore,
  STORE_FORMAT,
  STORE_MARKER,
  defaultStoreDatabase,
  defaultStoreRoot,
  openBlobStore,
  openBlobStoreDatabase,
  type OpenStoreDatabaseOptions,
  type OpenStoreOptions,
  type OpenedSqliteStore,
} from "./node.js";

export {
  LOCATION_PATTERN,
  LOCATION_SCAN_BYTES,
  auditBlobStore,
  blobRow,
  findLocations,
  readBlob,
  sweepUnreferenced,
  type BlobRow,
  type FindLocationsOptions,
  type LocationSweep,
  type StoreAudit,
  type SweepResult,
} from "./db.js";
