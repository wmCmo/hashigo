/**
 * The blob store. The database holds addresses; this holds bytes.
 *
 * `address.ts` and `store.ts` are pure and are what the OPFS build will import.
 * `node.ts` is the filesystem implementation. `db.ts` joins the two halves.
 *
 * Importing this barrel pulls in `node:fs` through `node.ts`. A browser build
 * must import `./address.js` and `./store.js` directly.
 */

export {
  ADDRESS_PATTERN,
  SHARD_LENGTH,
  addressPath,
  assertAddress,
  isAddress,
  shardOf,
} from "./address.js";

export {
  BlobConflictError,
  BlobMissingError,
  MemoryBlobStore,
  type BlobStore,
  type BlobWriteResult,
} from "./store.js";

export {
  NodeBlobStore,
  STORE_FORMAT,
  STORE_MARKER,
  defaultStoreRoot,
  openBlobStore,
  type OpenStoreOptions,
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
  type LocationSweep,
  type StoreAudit,
  type SweepResult,
} from "./db.js";
