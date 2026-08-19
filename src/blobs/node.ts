/**
 * The Node/filesystem blob store: a directory that holds payloads at
 * `<root>/<shard>/<hash>`.
 *
 * WHY THE ROOT IS A CONSTRUCTOR ARGUMENT AND NOT A COLUMN. The root is the only
 * absolute path in the system and it exists for the lifetime of a process. Move
 * the directory, point a new store at it, and every row in `blobs` still
 * resolves, because a row never said where anything was. That is the property
 * `test/blobs.test.ts` proves by renaming the store out from under a database
 * and reading the same 10,816 addresses back.
 *
 * Durability. Writes land in `<root>/.tmp` and are renamed into place, so a
 * killed import leaves either a complete blob or a temp file, never a truncated
 * payload at a valid address. `sweepTemp()` clears the leftovers.
 *
 * Self-ignoring. Creating a store writes `<root>/.gitignore` containing `*`.
 * The corpus store is 657 MB of Azure-generated mp3 — the same reason
 * `exports/` is gitignored — and relying on the user to remember is how 657 MB
 * ends up in a commit.
 */

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

import { ADDRESS_PATTERN, addressPath, assertAddress, shardOf } from "./address.js";
import { BlobConflictError, BlobMissingError, type BlobStore, type BlobWriteResult } from "./store.js";

/** Marker file, so a wrong `--store` argument is caught rather than populated. */
export const STORE_MARKER = "STORE.json";
export const STORE_FORMAT = "hashigo/blob-store/1";
const TEMP_DIR = ".tmp";

export interface OpenStoreOptions {
  /** Create the root (and its marker) if absent. Default true. */
  readonly create?: boolean;
}

/**
 * Where a database's blobs live by default: `<db>.blobs` beside the database
 * file. Derived, never stored — a database that moves takes its store with it
 * only because the two are named together, and either can be overridden.
 */
export function defaultStoreRoot(databaseFile: string): string {
  const full = resolve(databaseFile);
  return join(dirname(full), `${basename(full)}.blobs`);
}

export class NodeBlobStore implements BlobStore {
  /** Absolute, resolved once, held in memory only. Never written to the database. */
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
    // 657 MB of generated audio, for the same reason exports/ is ignored.
    const ignore = join(this.root, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  }

  /** Filesystem path of a blob. DEBUG AND INTEROP ONLY — never persist this. */
  locate(hash: string): string {
    return join(this.root, shardOf(hash), assertAddress(hash));
  }

  has(hash: string): boolean {
    return existsSync(this.locate(hash));
  }

  size(hash: string): number | null {
    try {
      return statSync(this.locate(hash)).size;
    } catch {
      return null;
    }
  }

  read(hash: string): Uint8Array {
    try {
      return readFileSync(this.locate(hash));
    } catch {
      throw new BlobMissingError(hash, this.root);
    }
  }

  write(hash: string, bytes: Uint8Array): BlobWriteResult {
    assertAddress(hash);
    const target = this.locate(hash);
    const held = this.size(hash);
    if (held !== null) {
      // Same address, different length is a hash collision or a corrupted
      // store; either way silently continuing would be the worse answer.
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
      // A concurrent writer won the race with identical bytes: that is a
      // no-op, not a failure. Anything else is real.
      try {
        unlinkSync(temp);
      } catch {
        /* the rename may have consumed it */
      }
      if (!existsSync(target)) throw error;
      return { hash, written: false, bytes: bytes.length };
    }
    return { hash, written: true, bytes: bytes.length };
  }

  remove(hash: string): boolean {
    try {
      unlinkSync(this.locate(hash));
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
      // Skip .tmp, .gitignore and STORE.json without stat-ing them.
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
    try {
      return createHash("sha256").update(readFileSync(this.locate(hash))).digest("hex") === hash;
    } catch {
      return false;
    }
  }

  /** Store-relative location, the form that is safe to print or route. */
  relative(hash: string): string {
    return addressPath(hash);
  }

  /** Delete interrupted writes. Safe at any time: temp files are never read. */
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
        /* another process is mid-write */
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

/** Open (creating by default) the store rooted at `root`. */
export function openBlobStore(root: string, options: OpenStoreOptions = {}): NodeBlobStore {
  return new NodeBlobStore(root, options);
}
