import { existsSync } from "node:fs";

import { openDatabase } from "../db/index.js";

import { auditBlobStore, findLocations, sweepUnreferenced } from "./db.js";
import {
  defaultStoreDatabase,
  openBlobStore,
  openBlobStoreDatabase,
  type OpenedSqliteStore,
} from "./node.js";
import type { BlobStore } from "./store.js";

const USAGE = `usage: vite-node src/blobs/cli.ts -- --db <file>
                  [--store <blobs.db> | --store-dir <root>] [--dry-run]
                  audit | verify | paths | sweep | stats`;

type Command = "audit" | "verify" | "paths" | "sweep" | "stats";

const NL = String.fromCharCode(10);

function fail(message: string): never {
  process.stderr.write(`blobstore: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function parse(argv: readonly string[]): {
  readonly command: Command;
  readonly dbFile: string;
  readonly storeFile: string | null;
  readonly storeDir: string | null;
  readonly dryRun: boolean;
} {
  let command: Command | null = null;
  let dbFile = "build/hashigo.db";
  let storeFile: string | null = null;
  let storeDir: string | null = null;
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
        storeFile = argv[i] ?? fail("--store needs a path to a blob-store database");
        break;
      case "--store-dir":
        i += 1;
        storeDir = argv[i] ?? fail("--store-dir needs a path to a legacy store directory");
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
        if (
          arg !== "audit" &&
          arg !== "verify" &&
          arg !== "paths" &&
          arg !== "sweep" &&
          arg !== "stats"
        ) {
          fail(`unknown command ${arg}`);
        }
        command = arg;
    }
  }
  if (command === null) fail("no command given");
  if (storeFile !== null && storeDir !== null) {
    fail("--store and --store-dir name two different stores; pass one");
  }
  return { command, dbFile, storeFile, storeDir, dryRun };
}

function main(): void {
  const cli = parse(process.argv.slice(2));
  const db = openDatabase(cli.dbFile, { applySchema: false });
  const out = (line: string): void => void process.stdout.write(`${line}\n`);

  let opened: OpenedSqliteStore | null = null;
  if (cli.command !== "paths" && cli.storeDir === null) {
    const file = cli.storeFile ?? defaultStoreDatabase(cli.dbFile);
    try {
      opened = openBlobStoreDatabase(file, { mustExist: true, create: false });
    } catch (error) {
      db.close();
      fail(
        `${(error as Error).message}${NL}` +
          `  the payload store is not part of the database, so it may simply have moved:${NL}` +
          `    --store <elsewhere.db>      point at it wherever it is now${NL}` +
          `    --store-dir <root>          open a legacy one-file-per-payload store${NL}` +
          `  or rebuild it (idempotent, writes only what is missing):${NL}` +
          `    npm run import -- --db ${cli.dbFile} exports/*`,
      );
    }
  }

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

      const storeFile = cli.storeFile ?? defaultStoreDatabase(cli.dbFile);
      if (cli.storeDir === null && existsSync(storeFile)) {
        const storeDb = openDatabase(storeFile, { applySchema: false, readOnly: true });
        try {
          const sweep = findLocations(storeDb, { exclude: ["blob_payloads.bytes"] });
          out(`store      sqlite:${storeFile}`);
          out(`  columns swept       ${sweep.columns} across ${sweep.tables} table(s)`);
          out(
            sweep.offenders.length === 0
              ? "  NO location in any addressable column of the payload store"
              : `  PATHS FOUND IN THE STORE:${NL}    ${sweep.offenders.join(`${NL}    `)}`,
          );
          for (const row of sweep.excluded) {
            out(`  not a check (payload bytes, matches are audio): ${row}`);
          }
          if (sweep.offenders.length > 0) process.exitCode = 1;
        } finally {
          storeDb.close();
        }
      }
      if (offenders.length > 0 || withPath > 0) process.exitCode = 1;
      return;
    }

    const store: BlobStore =
      opened !== null ? opened.store : openBlobStore(cli.storeDir as string, { create: false });
    out(`database   ${cli.dbFile}`);
    out(`store      ${store.describe}`);

    if (cli.command === "stats") {
      if (opened === null) {
        out("stats is only available for the SQLite store (drop --store-dir)");
        process.exitCode = 2;
        return;
      }
      const stats = opened.store.stats();
      const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
      for (const [label, value] of [
        ["payloads", String(stats.payloads)],
        ["payload bytes", `${stats.bytes} (${mib(stats.bytes)})`],
        ["page size", String(stats.pageSize)],
        ["pages", String(stats.pageCount)],
        ["file bytes", `${stats.fileBytes} (${mib(stats.fileBytes)})`],
        ["overhead vs payloads", mib(stats.fileBytes - stats.bytes)],
        ["free pages", `${stats.freelistPages} (${mib(stats.freelistPages * stats.pageSize)})`],
        ["auto_vacuum", `${stats.autoVacuum} (0 none, 1 full, 2 incremental)`],
        ["journal_mode", stats.journalMode],
      ] as const) {
        out(`${label.padEnd(24)}${value.padStart(24)}`);
      }
      const problems = opened.store.checkIntegrity();
      out(`integrity_check         ${problems.length === 0 ? "ok" : problems.join("; ")}`);
      if (problems.length > 0) process.exitCode = 1;
      return;
    }

    if (cli.command === "sweep") {
      const result = sweepUnreferenced(db, store, { dryRun: cli.dryRun });
      out(
        cli.dryRun
          ? `would reclaim ${result.bytesReclaimed} bytes from blobs at refcount 0`
          : `deleted ${result.rowsDeleted} row(s), removed ${result.payloadsRemoved} payload(s), ` +
              `reclaimed ${result.bytesReclaimed} bytes`,
      );
      if (!cli.dryRun && opened !== null) {
        const pages = opened.store.reclaim();
        out(`returned ${pages} free page(s) to the filesystem`);
      }
      return;
    }

    const started = Date.now();
    const audit = auditBlobStore(db, store, { verify: cli.command === "verify" });
    const seconds = (Date.now() - started) / 1000;
    out(`mode       ${cli.command === "verify" ? "rehashed every payload" : "size only"}`);
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
    opened?.close();
    db.close();
  }
}

main();
