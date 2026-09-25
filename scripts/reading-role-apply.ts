/**
 * DECLARE DECISION 29'S SWITCH BY ROLE — stage G of fields-as-modules, last.
 *
 *     npx vite-node scripts/reading-role-apply.ts -- --db build/hashigo.db [--apply]
 *
 * `src/review/mode.ts` used to find the field that decides the produce/identify
 * split by NAME and TYPE (`Reading`, boolean). It now asks for the
 * `hashigo-role: reading-switch` role first and keeps the name+type test as the
 * fallback. This writes the role — on the one field the fallback already picks,
 * on each template that runs the accent drill (declares an `accent` field), so
 * the two answers cannot disagree on the day it lands.
 *
 * ─── WHY THIS ONE WENT LAST ─────────────────────────────────────────────────
 *
 * The moment the role and the name disagree, 693 cards change which exercise
 * they run — autoplay on entry and the accent given away before he has produced
 * it, which is the defect decision 29 exists to prevent. So the role goes onto
 * exactly the field the name picks, `test/review.test.ts` pins that the two
 * lookups agree on every template, and the census must not move.
 *
 * Idempotent and quiet: a template whose switch already carries the role is
 * reported and not touched, so a re-run does not bump `updated_at` and hand a
 * sync a false "newer" row.
 */
import { withRole, roleOf } from "../src/fields/index.js";
import { openDatabase } from "../src/db/index.js";
import { READING_FIELD } from "../src/review/index.js";

const dbIndex = process.argv.indexOf("--db");
const path = dbIndex >= 0 ? (process.argv[dbIndex + 1] as string) : "build/hashigo.db";
const apply = process.argv.includes("--apply");

const db = openDatabase(path, { readOnly: !apply, applySchema: false });
try {
  // Declaration-time name lookup, and ONLY here — after this runs, the mode
  // finds the field by the role this writes.
  const rows = db
    .prepare(
      `SELECT t.name AS template, f.template_id AS templateId, f.id AS id, f.options AS options
         FROM template_fields f JOIN templates t ON t.id = f.template_id
        WHERE f.type = 'boolean' AND trim(f.name) = ?
          AND EXISTS (SELECT 1 FROM template_fields a
                       WHERE a.template_id = f.template_id AND a.type = 'accent')
        ORDER BY t.name`,
    )
    .all(READING_FIELD) as { template: string; templateId: string; id: string; options: string | null }[];

  const update = db.prepare(
    `UPDATE template_fields SET options = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE template_id = ? AND id = ?`,
  );
  let written = 0;
  for (const row of rows) {
    let options: Record<string, unknown> = {};
    try {
      options = JSON.parse(row.options ?? "{}") as Record<string, unknown>;
    } catch {
      options = {};
    }
    if (roleOf({ options }) === "reading-switch") {
      console.log(`  ${row.template.padEnd(8)} ALREADY APPLIED`);
      continue;
    }
    const next = JSON.stringify(withRole(options, "reading-switch"));
    if (apply) update.run(next, row.templateId, row.id);
    written += 1;
    console.log(`  ${row.template.padEnd(8)} ${row.id}: ${row.options ?? "{}"} -> ${next}`);
  }
  console.log(
    `\n${apply ? "applied" : "would apply"}: ${written} template(s) · ${rows.length - written} already`,
  );
  if (!apply) console.log("  nothing written — pass --apply");
} finally {
  db.close();
}
