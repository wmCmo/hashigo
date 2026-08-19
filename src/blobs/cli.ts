/**
 * Blob-store operator tool.
 *
 *   npx vite-node src/blobs/cli.ts -- --db build/hashigo.db audit
 *   npx vite-node src/blobs/cli.ts -- --db build/hashigo.db verify
 *   npx vite-node src/blobs/cli.ts -- --db build/hashigo.db paths
 *   npx vite-node src/blobs/cli.ts -- --db build/hashigo.db sweep --dry-run
 *   npx vite-node src/blobs/cli.ts -- --db build/hashigo.db --store D:/elsewhere audit
 *
 * Commands
 *   audit   Compare the database against the store. One stat per blob, no reads.
 *   verify  As audit, but REHASH every payload. 657 MB of I/O on this corpus.
 *   paths   The acceptance query: sweep every column of every table for a
 *           LOCATION -- a drive-letter path in either separator, a UNC share, a
 *           POSIX absolute path, a file:// URL, or "exports" with a separator
 *           against it. Exits 1 on any hit. This is the check that the database
 *           is not welded to one machine, and the predicate is
 *           `findLocations` in db.ts -- shared with the test, because when the
 *           two were separate copies both were blind to the same four shapes.
 *   sweep   Delete every blob at refcount 0, row and payload. --dry-run counts.
 *
 * `--store` exists because the store's location is NOT in the database. It
 * defaults to `<database>.blobs`, and pointing it somewhere else is how you
 * confirm a moved store still serves every reference.
 */

import { openDatabase } from "../db/index.js";

import { auditBlobStore, findLocations, sweepUnreferenced } from "./db.js";
import { defaultStoreRoot, openBlobStore } from "./node.js";

const USAGE = `usage: vite-node src/blobs/cli.ts -- --db <file> [--store <root>] [--dry-run]
                  audit | verify | paths | sweep`;

type Command = "audit" | "verify" | "paths" | "sweep";

function fail(message: string): never {
  process.stderr.write(`blobstore: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function parse(argv: readonly string[]): {
  readonly command: Command;
  readonly dbFile: string;
  readonly storeRoot: string | null;
  readonly dryRun: boolean;
} {
  let command: Command | null = null;
  let dbFile = "build/hashigo.db";
  let storeRoot: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--db":
        i += 1;
        dbFile = argv[i] ?? fail("--db needs a path");
        break;
      case "--store":
        i += 1;
        storeRoot = argv[i] ?? fail("--store needs a path");
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        if (arg.startsWith("-")) fail(`unknown flag ${arg}`);
        if (arg !== "audit" && arg !== "verify" && arg !== "paths" && arg !== "sweep") {
          fail(`unknown command ${arg}`);
        }
        command = arg;
    }
  }
  if (command === null) fail("no command given");
  return { command, dbFile, storeRoot, dryRun };
}

function main(): void {
  const cli = parse(process.argv.slice(2));
  const root = cli.storeRoot ?? defaultStoreRoot(cli.dbFile);
  const db = openDatabase(cli.dbFile, { applySchema: false });
  const out = (line: string): void => void process.stdout.write(`${line}\n`);

  try {
    if (cli.command === "paths") {
      const { offenders, columns, tables } = findLocations(db);
      const withPath = db
        .prepare("SELECT count(*) FROM blobs WHERE path IS NOT NULL")
        .pluck()
        .get() as number;
      out(`database   ${cli.dbFile}`);
      out(`blobs.path non-NULL   ${withPath}`);
      out(`columns swept         ${columns} across ${tables} table(s)`);
      out(
        offenders.length === 0
          ? "NO absolute path and NO reference to exports/ anywhere in the database"
          : `PATHS FOUND:\n  ${offenders.join("\n  ")}`,
      );
      if (offenders.length > 0 || withPath > 0) process.exitCode = 1;
      return;
    }

    const store = openBlobStore(root, { create: false });
    out(`database   ${cli.dbFile}`);
    out(`store      ${store.root}`);

    if (cli.command === "sweep") {
      const result = sweepUnreferenced(db, store, { dryRun: cli.dryRun });
      out(
        cli.dryRun
          ? `would reclaim ${result.bytesReclaimed} bytes from blobs at refcount 0`
          : `deleted ${result.rowsDeleted} row(s), removed ${result.payloadsRemoved} payload(s), ` +
              `reclaimed ${result.bytesReclaimed} bytes`,
      );
      return;
    }

    const started = Date.now();
    const audit = auditBlobStore(db, store, { verify: cli.command === "verify" });
    const seconds = (Date.now() - started) / 1000;
    out(`mode       ${cli.command === "verify" ? "rehashed every payload" : "stat only"}`);
    out("");
    for (const [label, value] of [
      ["blobs", audit.blobs],
      ["  inline (bytes in the row)", audit.inline],
      ["  present in the store", audit.present],
      ["  MISSING", audit.missing],
      ["    regenerable from provenance", audit.missingRegenerable],
      ["    lost (no identity tuple)", audit.missingLost],
      ["orphaned payloads in the store", audit.orphaned],
      ["size mismatches", audit.sizeMismatched],
      ["unreferenced (refcount 0)", audit.unreferenced],
    ] as const) {
      out(`${label.padEnd(34)}${String(value).padStart(8)}`);
    }
    if (audit.missingHashes.length > 0) out(`missing e.g. ${audit.missingHashes.join(" ")}`);
    if (audit.orphanedHashes.length > 0) out(`orphaned e.g. ${audit.orphanedHashes.join(" ")}`);
    out(`\nchecked in ${seconds.toFixed(1)}s`);
    if (audit.missing > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
