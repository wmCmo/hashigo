/**
 * Stage 1 CLI — import extracted `.mochi` exports into a Hashigo database.
 *
 *   npm run import -- exports/日本語 exports/English exports/基本情報
 *   npm run import -- --db build/hashigo.db --no-blobs exports/English
 *   npm run import -- --json exports/日本語 > report.json
 *
 * Flags
 *   --db <file>              Database file. Default build/hashigo.db.
 *                            ":memory:" imports and throws it away, which is a
 *                            useful way to check an export decodes cleanly.
 *   --inline-blobs           Store media bytes IN the database. 657 MB of mp3,
 *                            so the default records the file path instead.
 *   --no-blobs               Skip media and cached generations entirely.
 *   --no-text-generations    Media only; do not import the cached ai /
 *                            translate / furigana text.
 *   --keep-empty-leaf-decks  Keep 副詞, 名詞, 形容動詞, 一段動詞, 形容詞, 五段動詞.
 *                            They are DROPPED by default (SPEC "Settled"), so
 *                            45 decks become 39. They hold no cards and no
 *                            children, so nothing else moves either way.
 *   --reverse-default on|off Where the three-state `inherit` bottoms out.
 *                            Written to `settings` so views.sql agrees.
 *   --json                   Emit the report as JSON on stdout and nothing else.
 *   --quiet                  No progress lines.
 *
 * Re-running is safe: every write is an upsert and the second run reports
 * `unchanged` for every row. Console note — this machine's console is cp932, so
 * Japanese deck names print through Node's UTF-16 console writer, not the code
 * page; do not pipe this through a tool that re-encodes stdout.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { openDatabase, type Db } from "../src/db/index.js";
import { importExportDirs, type ImportOptions, type ImportReport } from "../src/import/index.js";

interface Cli {
  readonly dirs: readonly string[];
  readonly dbFile: string;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly options: ImportOptions;
}

const USAGE = `usage: npm run import -- [--db <file>] [--no-blobs] [--inline-blobs]
                        [--no-text-generations] [--keep-empty-leaf-decks]
                        [--reverse-default on|off] [--json] [--quiet]
                        <export-dir>...`;

function parseArgs(argv: readonly string[]): Cli {
  const dirs: string[] = [];
  let dbFile = join("build", "hashigo.db");
  let json = false;
  let quiet = false;
  let blobs: false | { store?: "inline" | "path"; includeTextGenerations?: boolean } = {};
  let dropEmptyLeafDecks: boolean | undefined;
  let reverseDefault: "on" | "off" | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--db":
        i += 1;
        dbFile = argv[i] ?? fail("--db needs a path");
        break;
      case "--json":
        json = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--no-blobs":
        blobs = false;
        break;
      case "--inline-blobs":
        if (blobs !== false) blobs = { ...blobs, store: "inline" };
        break;
      case "--no-text-generations":
        if (blobs !== false) blobs = { ...blobs, includeTextGenerations: false };
        break;
      case "--keep-empty-leaf-decks":
        dropEmptyLeafDecks = false;
        break;
      case "--reverse-default": {
        i += 1;
        const value = argv[i];
        if (value !== "on" && value !== "off") fail("--reverse-default takes on or off");
        reverseDefault = value;
        break;
      }
      case "-h":
      case "--help":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        if (arg.startsWith("-")) fail(`unknown flag ${arg}`);
        dirs.push(arg);
    }
  }

  if (dirs.length === 0) fail("no export directories given");
  for (const dir of dirs) {
    if (!existsSync(join(dir, "data.json"))) {
      fail(`${dir} is not an extracted .mochi export (no data.json)`);
    }
  }

  return {
    dirs: dirs.map((dir) => resolve(dir)),
    dbFile,
    json,
    quiet,
    options: {
      ...(blobs === false ? { blobs: false as const } : { blobs }),
      ...(dropEmptyLeafDecks === undefined ? {} : { dropEmptyLeafDecks }),
      ...(reverseDefault === undefined ? {} : { reverseDefault }),
    },
  };
}

function fail(message: string): never {
  process.stderr.write(`import: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const log = (line: string): void => {
    if (!cli.quiet && !cli.json) process.stdout.write(`${line}\n`);
  };

  log(`database  ${cli.dbFile}`);
  const db: Db = openDatabase(cli.dbFile);
  try {
    const report = importExportDirs(db, cli.dirs, {
      ...cli.options,
      onPhase: (phase, detail) => log(`  ${phase.padEnd(10)}${detail}`),
    });

    if (cli.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`\n${summarise(db, report)}\n`);
    }
    if (report.integrity.length > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

/** What is actually in the database now, read back out of it rather than counted. */
function summarise(db: Db, report: ImportReport): string {
  const rows = (sql: string): number => db.prepare(sql).pluck().get() as number;
  const lines = [
    `imported ${report.sources.join(", ")} in ${(report.elapsedMs / 1000).toFixed(1)}s`,
    "",
    row("decks", rows("SELECT count(*) FROM decks")),
    row("templates", rows("SELECT count(*) FROM templates")),
    row("template fields", rows("SELECT count(*) FROM template_fields")),
    row("cards", rows("SELECT count(*) FROM cards")),
    row("field values", rows("SELECT count(*) FROM card_field_values")),
    row("tracks", rows("SELECT count(*) FROM card_tracks")),
    row("reviews", rows("SELECT count(*) FROM reviews")),
    row("  forward", rows("SELECT count(*) FROM review_log WHERE track_kind = 'forward'")),
    row("  reverse", rows("SELECT count(*) FROM review_log WHERE track_kind = 'reverse'")),
    row("tags", rows("SELECT count(*) FROM tag_usage WHERE cards_direct > 0")),
    row("card tags", rows("SELECT count(*) FROM card_tags")),
    row("wiki-links", rows("SELECT count(*) FROM card_links")),
    row("  unresolved", rows("SELECT count(*) FROM card_links_resolved WHERE resolved = 0")),
    // Real links into text this import discarded. See ImportLinksResult.
    row(
      "  in discarded content",
      rows("SELECT count(*) FROM card_links_resolved WHERE text_present = 0"),
    ),
    row("blobs", rows("SELECT count(*) FROM blobs")),
    row("blob refs", rows("SELECT count(*) FROM blob_refs")),
  ];

  const totals = db
    .prepare(
      `SELECT reviews, lapses, round(retention * 100, 2) AS retention_pct,
              round(hours, 1) AS hours, study_days, first_review_date, last_review_date,
              reviews_time_unknown
         FROM study_totals`,
    )
    .get() as Record<string, unknown> | undefined;
  if (totals !== undefined && totals["reviews"] !== null) {
    lines.push(
      "",
      `retention ${totals["retention_pct"]}%  (${totals["lapses"]} lapses)`,
      `study     ${totals["hours"]} h over ${totals["study_days"]} days, ` +
        `${totals["first_review_date"]} to ${totals["last_review_date"]}`,
      // SPEC: "Imported history must be flagged time-unknown, not silently
      // assigned midnight." Say so every run rather than hiding it in a column.
      `clock     ${totals["reviews_time_unknown"]} of ${totals["reviews"]} reviews are ` +
        `date-only (Mochi stored no time of day)`,
    );
  }

  if (report.notes.reverseForcedCardIds.length > 0) {
    lines.push(
      "",
      `reverse forced on for ${report.notes.reverseForcedCardIds.length} card(s) carrying ` +
        `reverse history their deck would not schedule: ` +
        report.notes.reverseForcedCardIds.join(" "),
    );
  }
  if (report.structure.emptyLeafDecksDropped.length > 0) {
    lines.push(`dropped ${report.structure.emptyLeafDecksDropped.length} empty leaf deck(s)`);
  }
  // Discarded rather than imported, so it is said out loud on every run. The
  // ids are in the JSON report and the text itself is still in the export.
  if (report.notes.staleContentCardIds.length > 0) {
    lines.push(
      `discarded stale pre-template content on ${report.notes.staleContentCardIds.length} ` +
        `card(s), ${report.notes.staleContentChars} chars — the template overrides it and ` +
        `Mochi never showed it; recover from the export by card id (report.notes.` +
        `staleContentCardIds, ${report.notes.staleContentSample.length} sampled with text)`,
    );
  }
  if (report.structure.fieldValuesRemoved > 0) {
    lines.push(`pruned ${report.structure.fieldValuesRemoved} field value(s) the export no longer has`);
  }
  lines.push(
    "",
    report.integrity.length === 0
      ? "integrity ok"
      : `INTEGRITY PROBLEMS:\n  ${report.integrity.join("\n  ")}`,
  );
  return lines.join("\n");
}

function row(label: string, value: number): string {
  return `${label.padEnd(16)}${String(value).padStart(9)}`;
}

main();
