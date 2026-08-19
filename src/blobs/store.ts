/**
 * The blob store contract: the thing that OWNS the bytes.
 *
 * The database owns addresses and references; this owns payloads. The split is
 * the whole point — `blobs.hash` means "ask the store for these bytes", and a
 * store is just a root plus `addressPath()`, so the same rows work against a
 * directory on this laptop, a different directory after the repo moves, and
 * OPFS on the phone. Nothing in the database changes when the store does.
 *
 * Three properties every implementation must hold, because the importer and the
 * generator both depend on them:
 *
 *   1. IDEMPOTENT WRITE. `write(hash, bytes)` on an address the store already
 *      holds is a no-op that reports `written: false`. This is what makes a
 *      657 MB import resumable: interrupt it, run it again, and it copies only
 *      what is missing.
 *   2. IMMUTABLE CONTENT. An address maps to one payload forever. A write that
 *      would change the bytes under an existing address is a bug in the caller,
 *      and `write` throws rather than silently rewriting.
 *   3. NO LOCATIONS OUT. Nothing here returns something a caller could
 *      reasonably persist. `locate()` exists for the Node implementation only,
 *      is documented as debug/interop, and is not on this interface.
 *
 * Pure interface plus an in-memory implementation: no `node:fs`, so the browser
 * build imports this file unchanged.
 */

import { addressPath, assertAddress } from "./address.js";

/** What a write did. `written: false` means the address was already held. */
export interface BlobWriteResult {
  readonly hash: string;
  readonly written: boolean;
  readonly bytes: number;
}

export class BlobMissingError extends Error {
  readonly hash: string;
  constructor(hash: string, where: string) {
    super(`blob ${hash} is not in the store at ${where}`);
    this.name = "BlobMissingError";
    this.hash = hash;
  }
}

export class BlobConflictError extends Error {
  readonly hash: string;
  constructor(hash: string, held: number, offered: number) {
    super(
      `blob ${hash} is already stored with ${held} bytes; refusing to overwrite ` +
        `with ${offered}. An address holds one payload forever.`,
    );
    this.name = "BlobConflictError";
    this.hash = hash;
  }
}

export interface BlobStore {
  /**
   * Human-readable name of where this store currently is. Diagnostics only —
   * writing it to the database is exactly the bug this module removes.
   */
  readonly describe: string;
  has(hash: string): boolean;
  /** Payload size in bytes, or null when the store does not hold it. */
  size(hash: string): number | null;
  /** Throws `BlobMissingError` rather than returning empty for an absent blob. */
  read(hash: string): Uint8Array;
  /** Idempotent. Throws `BlobConflictError` if the address is held with different bytes. */
  write(hash: string, bytes: Uint8Array): BlobWriteResult;
  /** True if a payload was removed. Refcounting lives in the database. */
  remove(hash: string): boolean;
  /** Every address the store holds, in no guaranteed order. */
  list(): IterableIterator<string>;
  /** Re-read the payload and confirm it hashes to the address it is filed under. */
  verify(hash: string): boolean;
}

/**
 * A store that keeps payloads in a Map. Used by tests that must not touch a
 * disk, and by any caller that wants blob semantics without durability.
 */
export class MemoryBlobStore implements BlobStore {
  readonly describe = "memory";
  readonly #held = new Map<string, Uint8Array>();
  readonly #digest: (bytes: Uint8Array) => string;

  /** `digest` is injected so this file stays free of `node:crypto`. */
  constructor(digest: (bytes: Uint8Array) => string) {
    this.#digest = digest;
  }

  has(hash: string): boolean {
    return this.#held.has(assertAddress(hash));
  }

  size(hash: string): number | null {
    return this.#held.get(assertAddress(hash))?.length ?? null;
  }

  read(hash: string): Uint8Array {
    const bytes = this.#held.get(assertAddress(hash));
    if (bytes === undefined) throw new BlobMissingError(hash, this.describe);
    return bytes;
  }

  write(hash: string, bytes: Uint8Array): BlobWriteResult {
    assertAddress(hash);
    const held = this.#held.get(hash);
    if (held !== undefined) {
      if (held.length !== bytes.length) throw new BlobConflictError(hash, held.length, bytes.length);
      return { hash, written: false, bytes: held.length };
    }
    this.#held.set(hash, Uint8Array.from(bytes));
    return { hash, written: true, bytes: bytes.length };
  }

  remove(hash: string): boolean {
    return this.#held.delete(assertAddress(hash));
  }

  list(): IterableIterator<string> {
    return this.#held.keys();
  }

  verify(hash: string): boolean {
    const bytes = this.#held.get(assertAddress(hash));
    return bytes !== undefined && this.#digest(bytes) === hash;
  }

  /** Store-relative location, for parity with the Node store's diagnostics. */
  locate(hash: string): string {
    return addressPath(hash);
  }
}
