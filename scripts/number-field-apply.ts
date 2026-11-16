import { openDatabase } from "../src/db/index.js";
import { groupDigits } from "../src/template/index.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};
const apply = args.includes("--apply");
const dbPath = flag("db", "build/hashigo.db");
const templateName = flag("template", "数字");

const out: string[] = [];
const db = openDatabase(dbPath, { readOnly: !apply, applySchema: false });

try {
  const template = db
    .prepare("SELECT id, name, content FROM templates WHERE name = ?")
    .get(templateName) as { id: string; name: string; content: string } | undefined;
  if (template === undefined) throw new Error(`no template named ${templateName}`);

  const fields = db
    .prepare("SELECT id, name, type, options FROM template_fields WHERE template_id = ?")
    .all(template.id) as { id: string; name: string; type: string; options: string }[];
  const primary = fields.find((f) => f.id === "name");
  const noComma = fields.find((f) => f.type === "number" && f.id !== "name");

  if (primary === undefined) throw new Error(`${templateName} has no primary field`);

  const already =
    primary.type === "number" && String(primary.options).includes('"group"') && noComma === undefined;
  if (already) {
    out.push(`ALREADY APPLIED — ${primary.name} is a grouped number and the second field is gone.`);
  } else if (noComma === undefined) {
    out.push(
      `${templateName} has no second number field to merge. Either this ran twice ` +
        `with a half-finished state, or the template is not the one this was written ` +
        `for — look before forcing it.`,
    );
  } else {
    out.push(`template ${templateName}: primary=${primary.name} (${primary.type}), second=${noComma.name}`);

    const rows = db
      .prepare(
        `SELECT c.id,
                max(CASE WHEN v.field_id = 'name' THEN v.value END) AS comma_,
                max(CASE WHEN v.field_id = ?      THEN v.value END) AS bare
           FROM cards c LEFT JOIN card_field_values v ON v.card_id = c.id
          WHERE c.template_id = ? GROUP BY c.id`,
      )
      .all(noComma.id, template.id) as {
      id: string;
      comma_: string | null;
      bare: string | null;
    }[];

    const bad: string[] = [];
    for (const row of rows) {
      if (row.bare === null || row.bare === "" || row.comma_ === null) {
        bad.push(`${row.id} missing a value (${JSON.stringify(row.comma_)} / ${JSON.stringify(row.bare)})`);
      } else if (groupDigits(row.bare, ",") !== row.comma_) {
        bad.push(`${row.id} ${JSON.stringify(row.comma_)} != comma(${JSON.stringify(row.bare)})`);
      }
    }
    out.push(`cards: ${rows.length} · lossless on ${rows.length - bad.length}`);
    if (bad.length > 0) {
      out.push("", `REFUSING — ${bad.length} card(s) are not losslessly mergeable:`);
      for (const line of bad.slice(0, 10)) out.push(`  ${line}`);
      throw new Error(`${bad.length} card(s) would lose data`);
    }

    const options = ((): string => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(primary.options || "{}") as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      return JSON.stringify({ ...parsed, group: "comma" });
    })();

    const body = template.content.split(`<<${noComma.name}>>`).join(`<<${primary.name}>>`);
    const bodyChanged = body !== template.content;

    if (apply) {
      db.transaction(() => {
        const set = db.prepare(
          "UPDATE card_field_values SET value = ? WHERE card_id = ? AND field_id = 'name'",
        );
        const rename = db.prepare("UPDATE cards SET name = ? WHERE id = ?");
        for (const row of rows) {
          set.run(row.bare, row.id);
          rename.run(row.bare, row.id);
        }
        db.prepare(
          "UPDATE template_fields SET type = 'number', options = ? WHERE template_id = ? AND id = 'name'",
        ).run(options, template.id);
        db.prepare("UPDATE templates SET content = ? WHERE id = ?").run(body, template.id);
        db.prepare("DELETE FROM template_fields WHERE template_id = ? AND id = ?").run(
          template.id,
          noComma.id,
        );
      })();
    }

    out.push(`  values rewritten to bare digits : ${rows.length}`);
    out.push(`  cards.name rewritten            : ${rows.length}`);
    out.push(`  ${primary.name} -> number, options ${options}`);
    out.push(`  body ${bodyChanged ? "rewritten" : "UNCHANGED — it did not reference the second field"}`);
    out.push(`  ${noComma.name} field deleted (its ${rows.length} values are KEPT)`);
    out.push("");
    out.push(
      apply
        ? "APPLIED. Re-run after every rebuild: the importer rewrites all five from the export."
        : "DRY RUN — nothing written. Pass --apply.",
    );
  }
} finally {
  process.stdout.write(out.join("\n") + "\n");
  db.close();
}
