import { openDatabase } from "../db/index.js";
import { PARAMETERS_ARE_PROVISIONAL, SCHEDULER_ALGORITHM, SCHEDULER_POLICY } from "./policy.js";
import { dueTracks, newTracks, queueCounts, reviewForecast } from "./queue.js";
import { nowInHostOffset } from "./tracks.js";
import { seedTrackMemory } from "./tracks.js";
import { arg } from "../cli/args.js";

process.stdout.setDefaultEncoding("utf8");

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
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
