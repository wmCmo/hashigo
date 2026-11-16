import { resolve } from "node:path";

import { openDatabase } from "../src/db/index.js";
import { cardSearchText } from "../src/generate/index.js";

process.stdout.setDefaultEncoding("utf8");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dbAt = args.indexOf("--db");
const CARD_DB = resolve(dbAt === -1 ? "build/hashigo.db" : (args[dbAt + 1] as string));

const db = openDatabase(CARD_DB, { applySchema: false });

const cards = db.prepare(`SELECT id, search_text FROM cards ORDER BY id`).all() as {
  id: string;
  search_text: string | null;
}[];
const update = db.prepare(`UPDATE cards SET search_text = ? WHERE id = ? AND search_text IS NOT ?`);

let changed = 0;
let gained = 0;
const samples: string[] = [];

const work = db.transaction(() => {
  for (const card of cards) {
    const next = cardSearchText(db, card.id);
    if (next === null || next === (card.search_text ?? "")) continue;
    changed += 1;
    if (next.length > (card.search_text ?? "").length) {
      gained += 1;
      if (samples.length < 5) samples.push(`  ${card.id}: +${next.length - (card.search_text ?? "").length} chars`);
    }
    if (APPLY) update.run(next, card.id, next);
  }
});

work();

console.log(`${CARD_DB}`);
console.log(`cards                       ${cards.length}`);
console.log(`search_text would change    ${changed}`);
console.log(`  of those, GAINED text     ${gained}`);
for (const s of samples) console.log(s);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
} else {
  console.log("\nwritten. The FTS index rebuilt for each changed row (the cards_fts_au trigger).");
  const check = db.prepare(`SELECT count(*) AS n FROM card_search_index WHERE search_text_populated = 0`).get() as {
    n: number;
  };
  console.log(`cards with an unmaintained index: ${check.n} (must be 0)`);
}

db.close();
