import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import Database from "better-sqlite3";

import { ADDRESS_PATTERN, addressPath, assertAddress, shardOf } from "./address.js";
import { SqliteBlobStore, type SqliteStoreOptions } from "./sqlite.js";
import { BlobConflictError, BlobMissingError, type BlobStore, type BlobWriteResult } from "./store.js";

export const STORE_MARKER = "STORE.json";
export const STORE_FORMAT = "hashigo/blob-store/1";
const TEMP_DIR = ".tmp";

export interface OpenStoreOptions {
  readonly create?: boolean;
}

export function defaultStoreRoot(databaseFile: string): string {
  const full = resolve(databaseFile);
  return join(dirname(full), `${basename(full)}.blobs`);
}

export class NodeBlobStore implements BlobStore {
  readonly root: string;
  readonly describe: string;
  readonly #shards = new Set<string>();
  #temp = 0;

  constructor(root: string, options: OpenStoreOptions = {}) {
    this.root = resolve(root);
    this.describe = this.root;
    if (options.create !== false) this.#initialise();
    else if (!existsSync(this.root)) throw new Error(`no blob store at ${this.root}`);
  }

  #initialise(): void {
    mkdirSync(this.root, { recursive: true });
    const marker = join(this.root, STORE_MARKER);
    if (!existsSync(marker)) {
      writeFileSync(
        marker,
        `${JSON.stringify(
          { format: STORE_FORMAT, layout: "<shard>/<sha256>", created: new Date().toISOString() },
          null,
          2,
        )}\n`,
      );
    }
    const ignore = join(this.root, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  }

  locate(hash: string): string {
    return join(this.root, shardOf(hash), assertAddress(hash));
  }

  has(hash: string): boolean {
    return existsSync(this.locate(hash));
  }

  size(hash: string): number | null {
    const target = this.locate(hash);
    try {
      return statSync(target).size;
    } catch {
      return null;
    }
  }

  read(hash: string): Uint8Array {
    const target = this.locate(hash);
    try {
      return readFileSync(target);
    } catch {
      throw new BlobMissingError(hash, this.root);
    }
  }

  write(hash: string, bytes: Uint8Array): BlobWriteResult {
    assertAddress(hash);
    const target = this.locate(hash);
    const held = this.size(hash);
    if (held !== null) {
      if (held !== bytes.length) throw new BlobConflictError(hash, held, bytes.length);
      return { hash, written: false, bytes: held };
    }
    this.#ensureShard(shardOf(hash));
    const temp = this.#tempPath(hash);
    const fd = openSync(temp, "w");
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, target);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
      }
      if (!existsSync(target)) throw error;
      return { hash, written: false, bytes: bytes.length };
    }
    return { hash, written: true, bytes: bytes.length };
  }

  remove(hash: string): boolean {
    const target = this.locate(hash);
    try {
      unlinkSync(target);
      return true;
    } catch {
      return false;
    }
  }

  *list(): IterableIterator<string> {
    let shards: string[];
    try {
      shards = readdirSync(this.root);
    } catch {
      return;
    }
    for (const shard of shards) {
      if (shard.length !== 2 || !/^[0-9a-f]{2}$/.test(shard)) continue;
      let names: string[];
      try {
        names = readdirSync(join(this.root, shard));
      } catch {
        continue;
      }
      for (const name of names) {
        if (ADDRESS_PATTERN.test(name) && name.startsWith(shard)) yield name;
      }
    }
  }

  verify(hash: string): boolean {
    const target = this.locate(hash);
    try {
      return createHash("sha256").update(readFileSync(target)).digest("hex") === hash;
    } catch {
      return false;
    }
  }

  relative(hash: string): string {
    return addressPath(hash);
  }

  sweepTemp(): number {
    const dir = join(this.root, TEMP_DIR);
    let removed = 0;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      try {
        rmSync(join(dir, name));
        removed += 1;
      } catch {
      }
    }
    return removed;
  }

  #ensureShard(shard: string): void {
    if (this.#shards.has(shard)) return;
    mkdirSync(join(this.root, shard), { recursive: true });
    this.#shards.add(shard);
  }

  #tempPath(hash: string): string {
    const dir = join(this.root, TEMP_DIR);
    if (!this.#shards.has(TEMP_DIR)) {
      mkdirSync(dir, { recursive: true });
      this.#shards.add(TEMP_DIR);
    }
    this.#temp += 1;
    return join(dir, `${hash}.${process.pid}.${this.#temp}.part`);
  }
}

export function openBlobStore(root: string, options: OpenStoreOptions = {}): NodeBlobStore {
  return new NodeBlobStore(root, options);
}

export function defaultStoreDatabase(databaseFile: string): string {
  const full = resolve(databaseFile);
  return join(dirname(full), `${basename(full)}.blobs.db`);
}

export interface OpenedSqliteStore {
  readonly store: SqliteBlobStore;
  readonly file: string;
  close(): void;
}

export interface OpenStoreDatabaseOptions extends SqliteStoreOptions {
  readonly mustExist?: boolean;
}

export function openBlobStoreDatabase(
  file: string,
  options: OpenStoreDatabaseOptions = {},
): OpenedSqliteStore {
  const full = resolve(file);
  if (options.mustExist === true && !existsSync(full)) {
    throw new Error(`no blob store database at ${full}`);
  }
  mkdirSync(dirname(full), { recursive: true });
  const db = new Database(full);
  try {
    const store = new SqliteBlobStore(db, {
      digest: (bytes) => createHash("sha256").update(bytes).digest("hex"),
      ...options,
    });
    return { store, file: full, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
