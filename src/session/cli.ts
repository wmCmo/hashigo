/**
 * `npx vite-node src/session/cli.ts -- plan --db build/hashigo.db`
 *
 *   plan --db D [--new N] [--due N] [--order new-first|due-first|spread]
 *               [--now INSTANT] [--deck ID] [--limit N]
 *
 * READ-ONLY, and deliberately so: there is no `grade` command. Grading from a
 * terminal would write real review rows into his real database with no card in
 * front of him, which is the one thing this CLI must not make easy. `buildSession`
 * itself only reads; `answer()` is the writer and is not reachable from here.
 *
 * WHY A CLI FOR A MODULE WHOSE UI DOES NOT EXIST YET. Same reason
 * `src/scheduler/cli.ts` has one: the review screen is stage 7 and it is not
 * built, so without this the only way to see what tomorrow's session actually
 * looks like — the ORDER, not just the counts — is to read a test. This calls the
 * same `buildSession` the screen will call, not a parallel query written for the
 * terminal.
 */

import { openDatabase } from "../db/index.js";
import { nowInHostOffset } from "../scheduler/index.js";
import { DEFAULT_NEW_LIMIT, buildSession, type InterleavePolicy } from "./index.js";

// Japanese card names go to a cp932 console otherwise. Every script here sets its
// own encoding rather than asking for an env prefix: his shell is PowerShell 5.1,
// where `VAR=value cmd` is a parser error. See CLAUDE.md "Environment".
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

const ORDERS = new Set<string>(["new-first", "due-first", "spread"]);

function main(): void {
  const command = process.argv.find((a) => !a.startsWith("--") && a === "plan");
  if (command === undefined) {
    process.stdout.write("usage: plan --db <file> [--new N] [--due N] [--order P]\n");
    process.exitCode = 1;
    return;
  }

  const order = arg("order", "new-first");
  if (!ORDERS.has(order)) {
    throw new Error(`--order must be one of ${[...ORDERS].join(", ")}`);
  }
  const now = arg("now", nowInHostOffset());
  const newLimit = Number(arg("new", String(DEFAULT_NEW_LIMIT)));
  const dueRaw = arg("due", "");
  const limit = Number(arg("limit", "25"));

  const db = openDatabase(arg("db"), { readOnly: true, applySchema: false });
  try {
    const session = buildSession(db, {
      now,
      newLimit,
      interleave: order as InterleavePolicy,
      ...(dueRaw === "" ? {} : { dueLimit: Number(dueRaw) }),
      ...(process.argv.includes("--deck") ? { deckId: arg("deck") } : {}),
    });
    const p = session.progress();
    const plan = session.planned();

    process.stdout.write(
      `session for ${now.slice(0, 10)} · order ${order}\n` +
        `  due ${p.dueCount}  new ${p.newCount}  planned ${p.planned}\n\n`,
    );

    // The Japanese card name goes LAST and is never padded. `padEnd` counts
    // UTF-16 units, so a CJK name throws every column after it out by its own
    // width — putting it at the end of the line sidesteps the whole problem
    // without reimplementing an East Asian width table here.
    process.stdout.write("  #     track  origin  kind      card\n");
    for (const [i, item] of plan.slice(0, Math.max(0, limit)).entries()) {
      process.stdout.write(
        `  ${String(i + 1).padStart(4)}  ${String(item.trackId).padStart(6)}  ` +
          `${item.origin.padEnd(6)}  ${item.kind.padEnd(8)}  ${item.track.cardName}\n`,
      );
    }
    if (plan.length > limit) {
      process.stdout.write(`  … ${plan.length - limit} more\n`);
    }
    process.stdout.write(
      "\n  Re-asks (decision 13) do not appear here: a forgotten card is queued\n" +
        "  at answer time, and this command never answers anything.\n",
    );
  } finally {
    db.close();
  }
}

main();
