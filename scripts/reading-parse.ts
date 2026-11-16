import { openDatabase } from "../src/db/index.js";
import {
  PARENTHESIS,
  READING_OVERRIDES,
  parseReading,
  type ReadingVerdict,
} from "../src/text/parenthesis.js";

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
