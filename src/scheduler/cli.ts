/**
 * `npx vite-node src/scheduler/cli.ts -- <command> --db <file>`
 *
 *   counts   --db D [--deck ID] [--now INSTANT]      due / overdue / new / scheduled
 *   queue    --db D [--deck ID] [--limit N]          what is due, most overdue first
 *   forecast --db D [--days N]                       復習予測, forward only
 *   seed     --db D [--dry-run]                      replay history into scheduler_state
 *
 * WHY A CLI FOR A STAGE THAT HAS NO UI. Stage 7 is the screen he lives in and it
 * does not exist yet, so without this the only way to find out what tomorrow's
 * session looks like is to read a test. `counts` and `queue` answer that in a
 * second, against the real database, and they are the same functions the review
 * screen will call — not a parallel query written for the terminal.
 *
 * `seed` is the one command that WRITES, and it writes only `scheduler_state`
 * and `scheduler`. It moves no due date, so it cannot change what is due
 * tomorrow; see the note on `seedTrackMemory`.
 */

import { openDatabase } from "../db/index.js";
import { PARAMETERS_ARE_PROVISIONAL, SCHEDULER_ALGORITHM, SCHEDULER_POLICY } from "./policy.js";
import { dueTracks, newTracks, queueCounts, reviewForecast } from "./queue.js";
import { nowInHostOffset } from "./tracks.js";
import { seedTrackMemory } from "./tracks.js";
import { arg } from "../cli/args.js";

// Japanese deck and card names go to a cp932 console otherwise. Every script in
// this repo sets its own encoding rather than asking the caller for an env
// prefix — his shell is PowerShell 5.1 and `VAR=value cmd` is a parser error
// there. See CLAUDE.md "Environment".
process.stdout.setDefaultEncoding("utf8");


/**
 * Display width, counting a CJK wide character as two columns.
 *
 * `padEnd` counts UTF-16 code units, so `日本語/数字` (6 units, 11 columns) throws
 * every column after it out by five. In a project whose deck names are Japanese
 * identifiers that is every row of this table.
 */
/** The East Asian Wide and Fullwidth blocks, as codepoint ranges. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK punctuation
  [0x3041, 0x33ff], // kana, Hangul compat, CJK compat
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compat ideographs
  [0xfe30, 0xfe6f], // CJK compat forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
];

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
  }
  return width;
}

function padDisplay(text: string, columns: number): string {
  return text + " ".repeat(Math.max(0, columns - displayWidth(text)));
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function options(): { now: string; deckId?: string; limit?: number } {
  const now = arg("now", nowInHostOffset());
  const deck = process.argv.indexOf("--deck");
  const limit = process.argv.indexOf("--limit");
  return {
    now,
    ...(deck === -1 ? {} : { deckId: arg("deck") }),
    ...(limit === -1 ? {} : { limit: Number(arg("limit")) }),
  };
}

function main(): number {
  const command = process.argv[2];
  if (command === undefined || command.startsWith("--")) {
    console.error("usage: cli.ts <counts|queue|forecast|seed> --db <file> ...");
    return 2;
  }
  const db = openDatabase(arg("db"), { readOnly: command !== "seed", applySchema: false });
  try {
    const opts = options();
    if (command === "counts") {
      const counts = queueCounts(db, opts);
      const fresh = newTracks(db, { ...opts, limit: 1 });
      console.log(`as of ${counts.asOf}${opts.deckId === undefined ? "" : ` · deck ${opts.deckId}`}`);
      console.log(`  due        ${String(counts.due).padStart(6)}   of which ${counts.overdue} from before today`);
      console.log(`  new        ${String(counts.fresh).padStart(6)}   never reviewed${fresh.length === 0 ? "" : `, first is ${fresh[0]?.deckPath} ${fresh[0]?.cardName}`}`);
      console.log(`  scheduled  ${String(counts.scheduled).padStart(6)}   not yet due`);
      console.log(`  dormant    ${String(counts.dormant).padStart(6)}   retained, not scheduled`);
      console.log(
        `\n${SCHEDULER_POLICY.algorithm} · cap ${SCHEDULER_POLICY.maxIntervalDays}d · ` +
          `target ${SCHEDULER_POLICY.targetRetention}` +
          `${PARAMETERS_ARE_PROVISIONAL ? " · weights PROVISIONAL (refit when a year of real timestamps exists)" : ""}`,
      );
      return 0;
    }
    if (command === "queue") {
      const rows = dueTracks(db, { ...opts, limit: opts.limit ?? 20 });
      if (rows.length === 0) {
        console.log(`nothing due as of ${opts.now}`);
        return 0;
      }
      for (const row of rows) {
        const late = row.overdueDays === 0 ? "today" : `${row.overdueDays}d late`;
        console.log(
          `${row.dueAt?.slice(0, 10)}  ${late.padStart(10)}  ${row.kind.padEnd(7)}  ` +
            `${padDisplay(row.deckPath, 22)}  ${row.cardName}` +
            `${row.needsRereview === 1 ? "  [leech]" : ""}`,
        );
      }
      const counts = queueCounts(db, opts);
      console.log(`\n${rows.length} of ${counts.due} due · ${counts.fresh} new waiting`);
      return 0;
    }
    if (command === "forecast") {
      const days = Number(arg("days", "14"));
      const forecast = reviewForecast(db, { ...opts, days });
      const peak = Math.max(1, ...forecast.map((d) => d.count));
      for (const day of forecast) {
        const bar = "█".repeat(Math.round((day.count / peak) * 40));
        console.log(`${day.date}  ${String(day.count).padStart(4)}  ${bar}`);
      }
      const total = forecast.reduce((sum, day) => sum + day.count, 0);
      console.log(`\n${total} over ${days} days · ${(total / days).toFixed(1)}/day`);
      console.log(`today's ${queueCounts(db, opts).due} due are NOT in this forecast — see queueCounts`);
      return 0;
    }
    if (command === "seed") {
      if (flag("dry-run")) {
        // A dry run has to COMPUTE, or it is a sentence rather than a preview.
        // This used to print only the due count -- which it then said was
        // "unaffected either way", i.e. the one number that could not answer the
        // question being asked. Both in-repo precedents (`blobs sweep --dry-run`,
        // `accent materialise --dry-run`) do the real work and decline to write.
        const seedable = db
          .prepare(
            `SELECT count(*) AS n FROM card_tracks
              WHERE dormant = 0
                AND (scheduler IS NULL OR scheduler <> ? OR scheduler_state IS NULL)`,
          )
          .get(SCHEDULER_ALGORITHM) as { n: number };
        const withHistory = db
          .prepare(
            `SELECT count(*) AS n FROM card_tracks
              WHERE dormant = 0 AND reps > 0
                AND (scheduler IS NULL OR scheduler <> ? OR scheduler_state IS NULL)`,
          )
          .get(SCHEDULER_ALGORITHM) as { n: number };
        console.log(
          `--dry-run: ${seedable.n} live track(s) have no usable state; ` +
            `${withHistory.n} of them have review history to replay, ` +
            `${seedable.n - withHistory.n} are new cards and would stay unseeded`,
        );
        console.log("no due date would move — seeding is a statement about stability, not about when");
        return 0;
      }
      const report = seedTrackMemory(db);
      // The four live figures reconcile against `tracks`, which is why `dormant`
      // is printed rather than left as an unexplained remainder.
      console.log(
        `${report.seeded} seeded · ${report.alreadyStored} already had state · ` +
          `${report.withoutHistory} have no history (new cards) · ` +
          `${report.dormant} dormant (never considered) · ${report.tracks} tracks`,
      );
      console.log("no due date was moved — seeding is a statement about stability, not about when");
      return 0;
    }
    console.error(`unknown command: ${command}`);
    return 2;
  } finally {
    db.close();
  }
}

process.exit(main());
