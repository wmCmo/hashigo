import { openDatabase } from "../src/db/index.js";
import { arg, flag } from "../src/cli/args.js";
import { OJAD_SCOPE } from "../src/accent/marks.js";

const TEMPLATES = OJAD_SCOPE.templates;

const SENTENCE_FIELDS = OJAD_SCOPE.sentenceFields;

function annotationLine(reference: string, line: string): string {
  const quote = line.slice(0, line.indexOf(reference)).trim() === ">" ? ">" : "";
  return `${quote}<ojad></ojad>`;
}

function references(name: string): string[] {
  return [`<< ${name} >>`, `<<${name}>>`, `<< ${name}>>`, `<<${name} >>`];
}

const db = openDatabase(arg("db"), { readOnly: !flag("apply") });
try {
  const templates = db
    .prepare("SELECT id, name, content FROM templates ORDER BY name")
    .all() as { id: string; name: string; content: string }[];

  let changed = 0;
  let already = 0;
  let absent = 0;
  let removed = 0;
  const update = db.prepare(
    `UPDATE templates
        SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`,
  );

  for (const template of templates) {
    if (!TEMPLATES.includes(template.name as (typeof TEMPLATES)[number])) {
      if (template.content.includes("<ojad>")) {
        const cleaned = template.content
          .split("\n")
          .filter((line) => !line.includes("<ojad>"))
          .join("\n");
        if (flag("apply")) update.run(cleaned, template.id);
        removed += 1;
        console.log(`  ${template.name.padEnd(12)} REMOVED — out of scope`);
      }
      continue;
    }
    const field = SENTENCE_FIELDS.find((name) =>
      references(name).some((reference) => template.content.includes(reference)),
    );
    if (field === undefined) continue;

    if (template.content.includes(`<ojad>`)) {
      already += 1;
      console.log(`  ${template.name.padEnd(12)} ALREADY APPLIED`);
      continue;
    }

    const reference = references(field).find((candidate) => template.content.includes(candidate));
    if (reference === undefined) {
      absent += 1;
      continue;
    }
    const lines = template.content.split("\n");
    const at = lines.findIndex((line) => line.includes(reference));
    if (at < 0) {
      absent += 1;
      continue;
    }
    lines.splice(at + 1, 0, annotationLine(reference, lines[at] ?? ""));
    const content = lines.join("\n");
    if (flag("apply")) update.run(content, template.id);
    changed += 1;
    console.log(`  ${template.name.padEnd(12)} ${reference} + <ojad></ojad> on the next line`);
  }

  console.log(
    `\n${flag("apply") ? "applied" : "would apply"}: ${changed} template(s)` +
      ` · ${already} already · ${absent} with no usable reference` +
      ` · ${removed} removed as out of scope`,
  );
  if (!flag("apply")) console.log("  nothing written — pass --apply");
} finally {
  db.close();
}
