/**
 * A4 — parse the parenthesis workaround into a `読み` reading and a `かな主流`
 * flag.  READ-ONLY: this writes nothing.  It prints the before/after rows for
 * approval, because CLAUDE.md decision 10 settled the RULE and not the rows.
 *
 * The rule is decidable from script alone (decision 10):
 *
 *   kanji outside, kana inside   -> the parenthesis holds a READING     -> 読み
 *   kana outside, kanji inside   -> the parenthesis holds the KANJI     -> かな主流
 *   Latin inside                 -> the parenthesis holds a GLOSS       -> 意味
 *
 * Note the two are MIRRORS, and applying one to the other's cards is the exact
 * failure the workaround was hiding: putting a reading inside a head word is
 * what breaks TTS, and the brackets get spoken.
 *
 *   npx vite-node scripts/reading-parse.ts -- --db build/hashigo.db
 */
import { openDatabase } from "../src/db/index.js";
import {
  PARENTHESIS,
  READING_OVERRIDES,
  parseReading,
  type ReadingVerdict,
} from "../src/text/parenthesis.js";

// The rule lives in `src/text/parenthesis.ts` so that this read-only view and
// `scripts/reading-apply.ts`, which writes, cannot classify differently. They
// used to hold one copy each, which is one copy too many for a rule whose
// failure mode is writing a kana head word with a kanji reading.

const dbIndex = process.argv.indexOf("--db");
const path = dbIndex >= 0 ? process.argv[dbIndex + 1] : "build/hashigo.db";
if (!path) throw new Error("--db is required");
const db = openDatabase(path, { readOnly: true });

const rows = db
  .prepare<
    [],
    { card_id: string; value: string; template: string }
  >(
    `SELECT v.card_id, v.value, t.name AS template
       FROM card_field_values v
       JOIN cards c ON c.id = v.card_id
       JOIN templates t ON t.id = c.template_id
      WHERE v.field_id = 'name'
        AND t.name IN ('単語', '言葉')
      ORDER BY t.name, v.card_id`,
  )
  .all();

const hits = rows.filter((r) => PARENTHESIS.test(r.value));

const out: string[] = [];
out.push(`basis: card_field_values.value for field_id = 'name' on 単語 and 言葉`);
out.push(`scanned ${rows.length} head words · ${hits.length} carry a parenthesis`);
out.push("");
out.push("| # | card | template | before | verdict | 単語/言葉 after | 読み | かな主流 |");
out.push("|--:|---|---|---|---|---|---|---|");

const tally = new Map<ReadingVerdict, number>();
hits.forEach((r, i) => {
  const parsed = parseReading(r.card_id, r.value);
  if (parsed === null) return;
  tally.set(parsed.verdict, (tally.get(parsed.verdict) ?? 0) + 1);
  out.push(
    `| ${i + 1} | \`${r.card_id}\` | ${r.template} | \`${r.value}\` | ` +
      `${parsed.verdict}${parsed.overridden ? ` (override, rule said ${parsed.ruled})` : ""} | ` +
      `\`${parsed.head}\` | ${parsed.yomi ? `\`${parsed.yomi}\`` : "—"} | ` +
      `${parsed.kanaPrimary === 1 ? "true" : "—"} |`,
  );
});

// The override above is applied and labelled in the table, so a reader can see
// both what the rule said and what Zach ruled.  Nothing else needs a second look:
// the remaining 12 rows are decided by script position alone.
if (READING_OVERRIDES.size > 0) {
  out.push("");
  out.push(`${READING_OVERRIDES.size} ratified override(s) applied — see the note in this file.`);
}

out.push("");
for (const v of ["読み", "かな主流", "意味", "?"] as const) {
  out.push(`${v.padEnd(8)} ${tally.get(v) ?? 0}`);
}
const unclassified = tally.get("?") ?? 0;
out.push("");
out.push(
  unclassified === 0
    ? `ZERO unclassified — the rule decides every row from script alone, plus ${READING_OVERRIDES.size} ratified override(s).`
    : `${unclassified} UNCLASSIFIED — the rule does not decide these. Do not write.`,
);
out.push("NOTHING WAS WRITTEN. This script is read-only by construction.");

process.stdout.write(out.join("\n") + "\n");
db.close();
