/**
 * Stage 2 — write dashboard.html from an imported database.
 *
 *   npx vite-node src/dashboard/cli.ts -- --db build/hashigo.db --out dashboard.html
 *
 * vite-node rather than plain node for the same reason scripts/import.ts uses
 * it: every module in src/ imports with a ".js" specifier that resolves to a
 * ".ts" file, and node's type stripping does not do that resolution.
 *
 * Output on stdout is ASCII only. The Windows console this project runs on is
 * cp932, so printing deck paths here would mojibake the one thing you would
 * want to copy out of it; the Japanese lives in the HTML, which is UTF-8 with a
 * charset declaration.
 */

import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { openDatabase } from "../db/index.js";
import { collect } from "./metrics.js";
import type { Locale } from "./labels.js";
import { renderDashboard } from "./render.js";

interface Args {
  db: string;
  out: string;
  year: number;
  asOf: string | null;
  json: boolean;
  quiet: boolean;
  help: boolean;
  locale: Locale;
}

const USAGE = `
usage: vite-node src/dashboard/cli.ts -- [options]

  --db <path>     database to read (default build/hashigo.db)
  --out <path>    HTML to write (default dashboard.html); "-" writes stdout
  --year <n>      calendar year for the Mochi comparison tile (default 2026)
  --as-of <date>  YYYY-MM-DD "today" for the elapsed-day count
                  (default: the last review date in the log)
  --locale <l>    en (default) or ja. Deck, template and field names stay
                  Japanese in both — they are identifiers, not labels.
  --json          print the headline figures as JSON instead of a summary
  --quiet         write the file and say nothing
  --help
`.trim();

function parse(argv: readonly string[]): Args {
  const args: Args = {
    db: "build/hashigo.db",
    out: "dashboard.html",
    year: 2026,
    asOf: null,
    json: false,
    quiet: false,
    help: false,
    locale: "en",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--db":
        args.db = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--year":
        args.year = Number(next());
        break;
      case "--as-of":
        args.asOf = next();
        break;
      case "--locale": {
        const value = next();
        // Refused rather than silently defaulted: a typo in a locale flag would
        // otherwise write the wrong language and say nothing.
        if (value !== "en" && value !== "ja") {
          throw new Error(`--locale must be en or ja, got ${JSON.stringify(value)}`);
        }
        args.locale = value;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (flag !== undefined && flag !== "--") throw new Error(`unknown option ${flag}`);
    }
  }
  return args;
}

function main(argv: readonly string[]): void {
  const args = parse(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const dbPath = resolve(args.db);
  const db = openDatabase(dbPath, { readOnly: true, applySchema: false });
  try {
    const started = Date.now();
    const data = collect(db, {
      // basename only: provenance is useful, the absolute path is not — and
      // echoing it verbatim leaked a temp dir into a regenerated dashboard.
      source: basename(args.db),
      comparisonYear: args.year,
      asOf: args.asOf,
    });
    const html = renderDashboard(data, { locale: args.locale });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (args.out === "-") {
      process.stdout.write(html);
      return;
    }
    const outPath = resolve(args.out);
    writeFileSync(outPath, html, "utf8");

    if (args.quiet) return;
    const all = data.primary.totals;
    const year = data.comparison.totals;
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            out: outPath,
            bytes: Buffer.byteLength(html, "utf8"),
            elapsedSeconds: Number(elapsed),
            allTime: {
              reviews: all.reviews,
              retentionPct: all.retention === null ? null : Number((all.retention * 100).toFixed(2)),
              activeDays: all.activeDays,
              hours: Number(all.hours.toFixed(1)),
              timedReviews: all.timedReviews,
              medianSeconds: all.medianSeconds,
              meanSeconds: all.meanSeconds === null ? null : Number(all.meanSeconds.toFixed(1)),
              cardsStudied: all.cardsStudied,
              daysElapsed: all.daysElapsed,
            },
            [String(args.year)]: {
              reviews: year.reviews,
              retentionPct:
                year.retention === null ? null : Number((year.retention * 100).toFixed(2)),
              activeDays: year.activeDays,
              cardsStudied: year.cardsStudied,
              daysElapsed: year.daysElapsed,
              cardDays: year.cardDays,
            },
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    const lines = [
      `wrote ${outPath} (${Buffer.byteLength(html, "utf8")} bytes) in ${elapsed}s`,
      `all time  reviews ${all.reviews} | retention ${((all.retention ?? 0) * 100).toFixed(2)}% | ` +
        `active days ${all.activeDays} | ${all.hours.toFixed(1)} h over ${all.timedReviews} timed ` +
        `reviews | median ${all.medianSeconds}s mean ${(all.meanSeconds ?? 0).toFixed(1)}s | ` +
        `cards studied ${all.cardsStudied}`,
      `${args.year}      reviews ${year.reviews} | retention ${((year.retention ?? 0) * 100).toFixed(2)}% | ` +
        `active days ${year.activeDays} | cards studied ${year.cardsStudied} | ` +
        `days ${year.daysElapsed} | card-days ${year.cardDays}`,
      `forecast  ${data.forecast.horizonDays}d ahead ${data.forecast.days.reduce((n, d) => n + d.tracks, 0)} ` +
        `| backlog ${data.forecast.backlog} (${data.forecast.overdue} overdue) | new ${data.forecast.fresh} ` +
        `| plans: ${data.forecast.provenance.mochi} mochi / ${data.forecast.provenance.hashigo} hashigo`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    db.close();
  }
}

main(process.argv.slice(2));
