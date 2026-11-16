import { openDatabase } from "../db/index.js";
import { nowInHostOffset } from "../scheduler/index.js";
import { DEFAULT_NEW_LIMIT, buildSession, type InterleavePolicy } from "./index.js";
import { arg } from "../cli/args.js";

process.stdout.setDefaultEncoding("utf8");

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
