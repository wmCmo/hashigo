import { addressPath, assertAddress } from "./address.js";

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
  readonly describe: string;
  has(hash: string): boolean;
  size(hash: string): number | null;
  read(hash: string): Uint8Array;
  write(hash: string, bytes: Uint8Array): BlobWriteResult;
  remove(hash: string): boolean;
  list(): IterableIterator<string>;
  verify(hash: string): boolean;
  batch?<T>(fn: () => T): T;
}

export class MemoryBlobStore implements BlobStore {
  readonly describe = "memory";
  readonly #held = new Map<string, Uint8Array>();
  readonly #digest: (bytes: Uint8Array) => string;

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

  locate(hash: string): string {
    return addressPath(hash);
  }
}
