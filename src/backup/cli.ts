/**
 * `npx vite-node src/backup/cli.ts -- <command>`
 *
 *   export --db D --out F.json          write the archive (READ-ONLY on D)
 *   apply  --db D --in  F.json [--dry]  restore it (WRITES to D; idempotent)
 *
 * Decision 17's backup, from a terminal. The browser gets the same two functions
 * behind a one-tap button; this is how it gets tested and how a backup gets taken
 * before a rebuild.
 *
 * `apply` is the only WRITING command in this file and it runs in one transaction,
 * so a foreign-key surprise leaves the database as it was rather than half
 * restored. `--dry` runs the whole thing and rolls back, which is the honest way to
 * find out what an archive would do: the counts come from the real inserts, not
 * from a simulation of them.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { openDatabase } from "../db/index.js";
import { applyLocalArchive, exportLocalArchive, verifyLocalArchive } from "./archive.js";
import type { LocalArchive } from "./archive.js";

// Japanese field names and card ids go to a cp932 console otherwise. Every script
// here sets its own encoding rather than asking for an env prefix — PowerShell 5.1
// treats `VAR=value cmd` as a parser error. See CLAUDE.md "Environment".
process.stdout.setDefaultEncoding("utf8");

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
}

function doExport(): void {
  const db = openDatabase(arg("db"), { readOnly: true, applySchema: false });
  try {
    const archive = exportLocalArchive(db, new Date().toISOString());
    const out = arg("out");
    const json = `${JSON.stringify(archive, null, 1)}\n`;
    writeFileSync(out, json, "utf-8");
    process.stdout.write(
      `wrote ${out} — ${json.length} bytes, schema v${archive.schemaVersion}\n` +
        `  local reviews   ${archive.counts["reviews"]}\n` +
        `  track state     ${archive.counts["trackState"]}\n` +
        `  local fields    ${archive.counts["localFields"]}\n` +
        `  field values    ${archive.counts["fieldValues"]}\n` +
        `  settings        ${archive.counts["settings"]}\n`,
    );
    if (archive.counts["reviews"] === 0) {
      process.stdout.write(
        "\n  No local reviews yet, so this archive is only the local FIELDS and\n" +
          "  settings. That is still worth keeping — decision 9's 読み / かな主流 rows\n" +
          "  exist nowhere else — but the review history it will hold after decision\n" +
          "  16's final import is the reason this command exists.\n",
      );
    }
  } finally {
    db.close();
  }
}

function doApply(): void {
  const archive = JSON.parse(readFileSync(arg("in"), "utf-8")) as LocalArchive;
  verifyLocalArchive(archive);
  const dry = process.argv.includes("--dry");
  const db = openDatabase(arg("db"));
  try {
    if (archive.schemaVersion !== 0) {
      const here = (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      if (here !== archive.schemaVersion) {
        process.stdout.write(
          `  NOTE: archive is from schema v${archive.schemaVersion}, this database is ` +
            `v${here}.\n  Proceeding — the archive is rows plus stable keys, which is ` +
            `why it is not a file copy.\n\n`,
        );
      }
    }
    // One transaction: a foreign-key surprise must not leave a half restore.
    // `report` is captured OUTSIDE it so `--dry` can still print what the real
    // inserts did before the rollback — a dry run that tells you nothing is not a
    // dry run.
    let report: ReturnType<typeof applyLocalArchive> | null = null;
    try {
      db.transaction(() => {
        report = applyLocalArchive(db, archive);
        if (dry) throw new DryRun();
      })();
    } catch (cause) {
      if (!(cause instanceof DryRun)) throw cause;
    }
    printReport(report);
    if (dry) process.stdout.write("\n  --dry: rolled back. Nothing was written.\n");
  } finally {
    db.close();
  }
}

class DryRun extends Error {}

function printReport(report: ReturnType<typeof applyLocalArchive> | null): void {
  if (report === null) return;
  process.stdout.write(
    `  reviews        ${report.reviewsInserted} inserted, ${report.reviewsSkipped} already there\n` +
      `  track state    ${report.trackStateApplied} applied\n` +
      `  local fields   ${report.fieldsUpserted} upserted\n` +
      `  field values   ${report.fieldValuesUpserted} upserted\n` +
      `  settings       ${report.settingsUpserted} upserted\n`,
  );
  const orphans =
    report.reviewsOrphaned +
    report.trackStateOrphaned +
    report.fieldsOrphaned +
    report.fieldValuesOrphaned;
  if (orphans > 0) {
    process.stdout.write(
      `\n  ${orphans} row(s) had no home here and were SKIPPED, not written:\n` +
        `    reviews ${report.reviewsOrphaned} · track state ${report.trackStateOrphaned} · ` +
        `fields ${report.fieldsOrphaned} · values ${report.fieldValuesOrphaned}\n` +
        `  That is expected when restoring into a database rebuilt from a NEWER\n` +
        `  export — Mochi deletes cards, and this corpus carries 8,958 tombstones.\n` +
        `  It is a signal to look, not a failure.\n`,
    );
  }
  if (report.noop) {
    process.stdout.write("\n  ALREADY APPLIED — no review was added.\n");
  }
}

function main(): void {
  if (process.argv.includes("export")) doExport();
  else if (process.argv.includes("apply")) doApply();
  else {
    process.stdout.write(
      "usage:\n  export --db D --out F.json\n  apply  --db D --in F.json [--dry]\n",
    );
    process.exitCode = 1;
  }
}

main();
