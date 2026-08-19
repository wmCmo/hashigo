/**
 * The Node/filesystem blob store: a directory that holds payloads at
 * `<root>/<shard>/<hash>`.
 *
 * NO LONGER THE DEFAULT ANYWHERE. `sqlite.ts` is the production backing, in Node
 * and in the browser both, because `notes/browser-feasibility.md` §4 measured
 * one-file-per-payload at 322.1 s to write the corpus's 624.6 MiB in a browser
 * against 4.9 s for BLOB rows, and 10.60 ms against 0.54 ms per random read — a
 * gap since re-measured, on a second machine, at 19.30 ms against 0.52–0.60 ms
 * per payload written and 14.31 ms against 0.15–0.25 ms per read. The absolute
 * seconds move a lot between machines; the ordering never has. This
 * store is kept for three things it is still the right tool for, and is otherwise
 * opt-in (`--store-dir`, `openBlobStore`):
 *
 *   * EXPORT AND INTEROP. `<shard>/<hash>` files are what you hand to another
 *     program, copy to a NAS, or inspect with a media player. A BLOB row is not.
 *   * THE RELOCATION PROOF. `test/blobs.test.ts` renames a populated store out
 *     from under a database and reads all 10,816 addresses back. That test is the
 *     clearest possible statement that no row knows where the bytes are, and it
 *     needs a directory to rename.
 *   * A SECOND, INDEPENDENT IMPLEMENTATION OF THE SAME CONTRACT. Every rule in
 *     store.ts is asserted against both, so a rule that only the SQLite store
 *     happens to satisfy cannot pass for a property of the interface.
 *
 * It is also still fast on a PC — the 30 ms/file figure is an OPFS number, not an
 * NTFS one — so nothing about using it in Node is wrong. It simply must not be
 * what the phone runs.
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

import Database from "better-sqlite3";

import { ADDRESS_PATTERN, addressPath, assertAddress, shardOf } from "./address.js";
import { SqliteBlobStore, type SqliteStoreOptions } from "./sqlite.js";
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
    // assertAddress OUTSIDE the try, or the catch swallows it and a location
    // reported "not held" instead of "not an address". Found by running the
    // shared contract tests against both backings: the SQLite store rejected
    // `C:\\exports\\x.mp3` and this one quietly returned null. address.ts
    // says assertAddress is "called on every store operation"; this was the bug.
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
    const target = this.locate(hash);
    try {
      return createHash("sha256").update(readFileSync(target)).digest("hex") === hash;
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

/** Open (creating by default) the DIRECTORY store rooted at `root`. Opt-in. */
export function openBlobStore(root: string, options: OpenStoreOptions = {}): NodeBlobStore {
  return new NodeBlobStore(root, options);
}

// ---------------------------------------------------------------------------
// The production store, opened over a file. `sqlite.ts` holds the store itself;
// this is the twenty lines of better-sqlite3 that only Node can supply.
// ---------------------------------------------------------------------------

/**
 * Where a database's payloads live by default: `<db>.blobs.db` beside the card
 * database. Derived, never stored — the same rule as `defaultStoreRoot`, and
 * `.gitignore`'s `*.db` already covers it.
 *
 * Note the shape difference from the old default (`<db>.blobs`, a directory): a
 * store built by an earlier run is still openable with `--store-dir`, and nothing
 * migrates silently.
 */
export function defaultStoreDatabase(databaseFile: string): string {
  const full = resolve(databaseFile);
  return join(dirname(full), `${basename(full)}.blobs.db`);
}

/** A store plus the handle it borrows, because the store never closes one. */
export interface OpenedSqliteStore {
  readonly store: SqliteBlobStore;
  /** Absolute. Held in memory only, exactly like `NodeBlobStore.root`. */
  readonly file: string;
  close(): void;
}

export interface OpenStoreDatabaseOptions extends SqliteStoreOptions {
  /** Fail instead of creating the file. Default false (create). */
  readonly mustExist?: boolean;
}

/**
 * Open the SQLite blob store at `file`, creating it unless `mustExist`.
 *
 * The digest defaults to `node:crypto` here rather than to `sha256.ts`'s pure-TS
 * one: `verify` over the whole corpus is 625 MB of hashing, and OpenSSL does that
 * at ~2 GiB/s against ~170 MiB/s. The browser has no such option, which is why
 * the pure one is what `SqliteBlobStore` falls back to; the two agree bit for bit
 * and `test/blobs.test.ts` asserts it on real payloads.
 *
 * NOT WAL, deliberately. The store is single-writer and its big transactions
 * append pages beyond the original end of file, where a rollback journal has
 * almost nothing to record — WAL would instead write 625 MB to a sidecar and then
 * copy it back. It also keeps this identical to the browser, where WAL does not
 * work on `opfs-sahpool` at all (`src/db/browser.ts` (3)).
 */
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
