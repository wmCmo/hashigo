import { openDatabase } from "../src/db/index.js";
import { YOMI_FIELD } from "../src/fields/yomi.js";
import { hasParenthesis, parseReading, type ParsedReading } from "../src/text/parenthesis.js";

const LOCAL_FIELDS = [
  {
    id: "local-yomi",
    name: YOMI_FIELD,
    type: "plain",
    pos: "ab",
  },
  {
    id: "local-kana-primary",
    name: "かな主流",
    type: "boolean",
    pos: "ac",
  },
] as const;

const TEMPLATES = ["単語", "言葉"] as const;

const dbIndex = process.argv.indexOf("--db");
const path = dbIndex >= 0 ? (process.argv[dbIndex + 1] as string) : "build/hashigo.db";
const apply = process.argv.includes("--apply");

const db = openDatabase(path, { readOnly: !apply, applySchema: false });
const out: string[] = [];

try {
  const templates = db
    .prepare(
      `SELECT id, name FROM templates WHERE name IN (${TEMPLATES.map(() => "?").join(", ")})`,
    )
    .all(...TEMPLATES) as { id: string; name: string }[];
  if (templates.length !== TEMPLATES.length) {
    throw new Error(
      `expected templates ${TEMPLATES.join(", ")}; found ${templates.map((t) => t.name).join(", ")}`,
    );
  }

  const existing = db.prepare(
    "SELECT id, name, type, local FROM template_fields WHERE template_id = ? AND id = ?",
  );
  const insertField = db.prepare(
    `INSERT INTO template_fields (template_id, id, name, type, source_field_id, options, pos, local)
     VALUES (?, ?, ?, ?, NULL, '{}', ?, 1)`,
  );

  let fieldsCreated = 0;
  let fieldsPresent = 0;
  for (const template of templates) {
    for (const field of LOCAL_FIELDS) {
      const row = existing.get(template.id, field.id) as
        | { id: string; name: string; type: string; local: number }
        | undefined;
      if (row !== undefined) {
        fieldsPresent += 1;
        if (row.local !== 1) {
          throw new Error(
            `${template.name}/${field.id} exists with local = ${row.local}. ` +
              `Refusing to continue: a local = 0 row here means pruneFieldValues will ` +
              `delete its values on the next import, silently.`,
          );
        }
        continue;
      }
      if (apply) insertField.run(template.id, field.id, field.name, field.type, field.pos);
      fieldsCreated += 1;
      out.push(`  + ${template.name}/${field.name} (${field.id}, ${field.type}, local = 1)`);
    }
  }

  const heads = db
    .prepare(
      `SELECT v.card_id, v.value, t.id AS template_id, t.name AS template
         FROM card_field_values v
         JOIN cards c ON c.id = v.card_id
         JOIN templates t ON t.id = c.template_id
        WHERE v.field_id = 'name' AND t.name IN (${TEMPLATES.map(() => "?").join(", ")})
        ORDER BY t.name, v.card_id`,
    )
    .all(...TEMPLATES) as {
    card_id: string;
    value: string;
    template_id: string;
    template: string;
  }[];

  const parsed: (ParsedReading & { templateId: string; template: string })[] = [];
  for (const row of heads) {
    if (!hasParenthesis(row.value)) continue;
    const reading = parseReading(row.card_id, row.value);
    if (reading === null) continue;
    parsed.push({ ...reading, templateId: row.template_id, template: row.template });
  }

  const undecidable = parsed.filter((p) => p.verdict === "?");
  if (undecidable.length > 0) {
    throw new Error(
      `${undecidable.length} head word(s) the rule does not decide: ` +
        `${undecidable.map((p) => `${p.cardId} ${p.before}`).join(", ")}. Writing nothing.`,
    );
  }

  const upsert = db.prepare(
    `INSERT INTO card_field_values (card_id, field_id, value) VALUES (?, ?, ?)
     ON CONFLICT (card_id, field_id) DO UPDATE SET value = excluded.value`,
  );
  const current = db.prepare(
    "SELECT value FROM card_field_values WHERE card_id = ? AND field_id = ?",
  );

  let headsChanged = 0;
  let headsAlready = 0;
  let valuesWritten = 0;
  const tally = new Map<string, number>();

  out.push("");
  out.push("| card | template | before | verdict | head | 読み | かな主流 |");
  out.push("|---|---|---|---|---|---|---|");
  for (const row of parsed) {
    tally.set(row.verdict, (tally.get(row.verdict) ?? 0) + 1);
    const headNow = (current.get(row.cardId, "name") as { value: string } | undefined)?.value;
    if (headNow === row.head) headsAlready += 1;
    else {
      if (apply) upsert.run(row.cardId, "name", row.head);
      headsChanged += 1;
    }

    if (row.yomi !== "") {
      if (apply) upsert.run(row.cardId, "local-yomi", row.yomi);
      valuesWritten += 1;
    }
    if (row.kanaPrimary === 1) {
      if (apply) upsert.run(row.cardId, "local-kana-primary", "true");
      valuesWritten += 1;
    }
    out.push(
      `| \`${row.cardId}\` | ${row.template} | \`${row.before}\` | ` +
        `${row.verdict}${row.overridden ? ` (override, rule said ${row.ruled})` : ""} | ` +
        `\`${row.head}\` | ${row.yomi ? `\`${row.yomi}\`` : "—"} | ` +
        `${row.kanaPrimary === 1 ? "true" : "—"} |`,
    );
  }

  const already = db
    .prepare(
      "SELECT count(*) AS n FROM card_field_values WHERE field_id IN ('local-yomi', 'local-kana-primary')",
    )
    .get() as { n: number };

  out.push("");
  if (parsed.length === 0) {
    out.push(
      already.n > 0
        ? `no head word carries a parenthesis, and ${already.n} local value(s) are present — ALREADY APPLIED, nothing to do.`
        : `no head word carries a parenthesis and no local values exist. Either this ran ` +
          `against the wrong database, or the scan is broken. Nothing written.`,
    );
  } else {
    out.push(
      `${parsed.length} rows · ` +
        [...tally].map(([verdict, n]) => `${verdict} ${n}`).join(" / "),
    );
  }
  out.push(
    `fields: ${fieldsCreated} created, ${fieldsPresent} already present ` +
      `(${LOCAL_FIELDS.length} × ${TEMPLATES.length} expected)`,
  );
  out.push(`head words: ${headsChanged} changed, ${headsAlready} already correct`);
  out.push(`values: ${valuesWritten} written`);
  out.push(
    apply
      ? "APPLIED. Re-run after any rebuild; an ordinary re-import reverts only the head words."
      : "DRY RUN — nothing written. Pass --apply.",
  );
} finally {
  process.stdout.write(out.join("\n") + "\n");
  db.close();
}
