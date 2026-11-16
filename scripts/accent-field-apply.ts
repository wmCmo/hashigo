import { openDatabase } from "../src/db/index.js";

const dbIndex = process.argv.indexOf("--db");
const path = dbIndex >= 0 ? (process.argv[dbIndex + 1] as string) : "build/hashigo.db";
const apply = process.argv.includes("--apply");

process.stdout.setDefaultEncoding("utf8");

const ACCENT_FIELD = {
  id: "local-accent",
  name: "型",
  type: "accent",
  sourceFieldId: "name",
  pos: "ad",
} as const;

interface Edit {
  readonly template: string;
  readonly name: string;
  readonly label: string;
  readonly from: readonly string[];
  readonly to: string;
}

const KANA_GATE = ["<< #かな主流 >>", "◎かな主流", "<< /かな主流 >>"].join("\n");

const ACCENT_BLOCK = [
  "<< #型 >>",
  "<< #Reading >>",
  "{{<< 型 >>}}",
  "<< /Reading >>",
  "<< ^Reading >>",
  "<< 型 >>",
  "<< /Reading >>",
  "<< /型 >>",
].join("\n");

const EDITS: readonly Edit[] = [
  {
    template: "oiaISYb2",
    name: "単語",
    label: "型 above <<Speech>> (side 2), CLOZED when Reading is true",
    from: [
      "{{<furigana><< 単語 >></furigana>}}\n<< 型 >>\n<< Speech >>",
      "{{<furigana><< 単語 >></furigana>}}\n<< Speech >>",
    ],
    to: `{{<furigana><< 単語 >></furigana>}}\n${ACCENT_BLOCK}\n<< Speech >>`,
  },
  {
    template: "oiaISYb2",
    name: "単語",
    label: "かな主流 inside the <<#Reading>> gate (side 1)",
    from: ["<< #Reading>>\n<< Reference >>\n<< /Reading >>"],
    to: `<< #Reading>>\n<< Reference >>\n${KANA_GATE}\n<< /Reading >>`,
  },
  {
    template: "itmYDz2N",
    name: "言葉",
    label: "型 above <<Speech>> — always plain, 言葉 has no Reading switch",
    from: ["___\n<< Speech >>"],
    to: "___\n<< 型 >>\n<< Speech >>",
  },
];

function main(): number {
  const db = openDatabase(path, apply ? {} : { readOnly: true, applySchema: false });
  try {
    const templates = new Map(
      (db.prepare("SELECT id, name, content FROM templates").all() as {
        id: string;
        name: string;
        content: string;
      }[]).map((t) => [t.id, t]),
    );

    const fieldTargets = ["oiaISYb2", "itmYDz2N"];
    let fieldsNeeded = 0;
    for (const templateId of fieldTargets) {
      const present = db
        .prepare("SELECT 1 FROM template_fields WHERE template_id = ? AND id = ?")
        .get(templateId, ACCENT_FIELD.id);
      const t = templates.get(templateId);
      if (present === undefined) {
        fieldsNeeded += 1;
        console.log(`  field  ${t?.name ?? templateId}: CREATE ${ACCENT_FIELD.name} (type accent)`);
      } else {
        console.log(`  field  ${t?.name ?? templateId}: ${ACCENT_FIELD.name} already there`);
      }
    }

    const pending: Edit[] = [];
    const stranded: Edit[] = [];
    for (const edit of EDITS) {
      const t = templates.get(edit.template);
      if (t === undefined) {
        console.log(`  body   ${edit.name}: TEMPLATE MISSING — skipped`);
        continue;
      }
      if (t.content.includes(edit.to)) {
        console.log(`  body   ${edit.name}: ${edit.label} — already there`);
        continue;
      }
      if (!edit.from.some((anchor) => t.content.includes(anchor))) {
        stranded.push(edit);
        console.log(
          `  body   ${edit.name}: ${edit.label} — ANCHOR NOT FOUND, skipped.\n` +
            `         The body is not the shape this script was written against.\n` +
            `         Read it before forcing anything: SELECT content FROM templates WHERE id = '${edit.template}'`,
        );
        continue;
      }
      pending.push(edit);
      console.log(`  body   ${edit.name}: ${edit.label} — WILL INSERT`);
    }

    const kotoba = templates.get("itmYDz2N");
    if (kotoba !== undefined && !kotoba.content.includes("#Reading")) {
      console.log(
        "  note   言葉 has no <<#Reading>> gate, so decision 20's かな主流 placement\n" +
          "         has no home there. NOT invented. Its 6 values stay unrendered on 言葉.",
      );
    }

    if (fieldsNeeded === 0 && pending.length === 0) {
      if (stranded.length > 0) {
        console.log(
          `\nNOT APPLIED — ${stranded.length} edit(s) found no anchor and were skipped:` +
            `\n  ${stranded.map((e) => `${e.name}: ${e.label}`).join("\n  ")}` +
            `\nThe rest is already there. Read the body before forcing anything, and` +
            `\nnote that exit code 1 here means SKIPPED, not broken.`,
        );
        return 1;
      }
      console.log("\nALREADY APPLIED — nothing to do.");
      return 0;
    }

    if (!apply) {
      console.log("\nDRY RUN — nothing written. Pass --apply.");
      console.log("Then: npx vite-node src/accent/cli.ts -- write --db " + path);
      return 0;
    }

    db.transaction(() => {
      for (const templateId of fieldTargets) {
        db.prepare(
          `INSERT INTO template_fields
             (template_id, id, name, type, source_field_id, options, pos, local)
           VALUES (?, ?, ?, ?, ?, '{}', ?, 1)
           ON CONFLICT (template_id, id) DO UPDATE SET
             name = excluded.name, type = excluded.type,
             source_field_id = excluded.source_field_id, pos = excluded.pos, local = 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        ).run(
          templateId,
          ACCENT_FIELD.id,
          ACCENT_FIELD.name,
          ACCENT_FIELD.type,
          ACCENT_FIELD.sourceFieldId,
          ACCENT_FIELD.pos,
        );
      }
      for (const edit of pending) {
        const t = templates.get(edit.template);
        if (t === undefined) continue;
        const anchor = edit.from.find((candidate) => t.content.includes(candidate));
        if (anchor === undefined) continue;
        const next = t.content.replace(anchor, edit.to);
        db.prepare(
          `UPDATE templates SET content = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        ).run(next, edit.template);
        t.content = next;
      }
    })();

    console.log(`\nAPPLIED — ${fieldsNeeded} field row(s), ${pending.length} body edit(s).`);
    console.log("Now materialise the labels:");
    console.log(`  npx vite-node src/accent/cli.ts -- write --db ${path}`);
    return 0;
  } finally {
    db.close();
  }
}

process.exitCode = main();
