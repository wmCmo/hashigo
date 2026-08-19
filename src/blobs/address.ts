/**
 * The address itself: lowercase hex sha256 of the payload bytes, and the
 * store-relative location derived from it.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a location is DERIVED, never stored.
 * The database holds `blobs.hash` and nothing else about where the bytes are.
 * Every reader recomputes the location from the hash plus whatever root it is
 * holding right now, which is why moving, renaming or re-mounting the store
 * cannot break a single reference. The previous design wrote
 * `C:\DEV\WEB\hashigo\exports\日本語\c7EiABp0.mp3` into 10,816 rows; that
 * database was welded to one machine, one drive letter and one gitignored
 * directory of reference data, and it could never have run on a phone.
 *
 * Layout is git's: one 2-hex-character shard directory, the full hash as the
 * file name.  256 directories, ~42 files each at the corpus's 10,816 blobs,
 * and no directory grows past a few thousand entries before the store would
 * need a hundred times more blobs than the corpus has.  The file name is the
 * WHOLE hash, not the remaining 62 characters, so a file carries its own
 * address even when it is copied out of the store by hand.
 *
 * No extension.  The type of a blob is `blobs.mime`, sniffed from the bytes
 * (only 41 of the corpus's 10,887 declared types were correct), and encoding
 * it in the file name would make the store's layout depend on a decision that
 * lives in the database.
 *
 * Pure: no filesystem, no database, no platform. The OPFS build uses this file
 * unchanged.
 */

/** Lowercase hex sha256. Nothing else is an address. */
export const ADDRESS_PATTERN = /^[0-9a-f]{64}$/;

/** Characters of the hash used as the shard directory name. */
export const SHARD_LENGTH = 2;

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/** Narrow to an address or throw. Called on every store operation. */
export function assertAddress(value: unknown): string {
  if (!isAddress(value)) {
    throw new TypeError(
      `not a content address: ${JSON.stringify(value)} ` +
        `(expected 64 lowercase hex characters of sha256)`,
    );
  }
  return value;
}

/** The shard directory a blob belongs in. */
export function shardOf(hash: string): string {
  return assertAddress(hash).slice(0, SHARD_LENGTH);
}

/**
 * Where this blob lives RELATIVE to a store root, POSIX-separated.
 *
 * Relative, and derived from the hash alone: this string is safe to log, safe
 * to put in a URL and safe to compare across machines. It is still never
 * written to the database, because the hash already determines it.
 */
export function addressPath(hash: string): string {
  return `${shardOf(hash)}/${hash}`;
}
