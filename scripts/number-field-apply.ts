/**
 * 数字 keeps ONE number field, and the comma becomes presentation.
 *
 *   npx vite-node scripts/number-field-apply.ts -- --db build/hashigo.db           # dry run
 *   npx vite-node scripts/number-field-apply.ts -- --db build/hashigo.db --apply   # writes
 *
 * Zach, 2026-09-07: *"since we're here at the hashigo and not mochi, i don't need
 * two field of comma and number, we can just have no comma field, and the template
 * let me choose a display type of rendering comma, but when we do the reexport,
 * maybe we need some script to convert from mochi for the final time, because do you
 * agree that the conversion shouldn't live in the app because it's like we embedding
 * mochi identity into our app"*.
 *
 * **Agreed, and it is the rule the repo already runs on.** Decision 16 is one final
 * import and then never again; the "import is WHOLESALE" answer says no Mochi id
 * ever arrives here after it. So anything whose only job is to translate Mochi's
 * SHAPE is a migration — `scripts/`, idempotent, part of the rebuild chore — and not
 * a feature. The comma RENDERING is the other half and does live in the app forever
 * (`src/template/resolve.ts`, `groupDigits`); that is not Mochi identity, it is
 * Hashigo owning presentation instead of storing two copies of one number.
 *
 * ─── WHAT MOCHI FORCED, MEASURED ────────────────────────────────────────────
 *
 * ```
 * name        Number   text     source=-       the PRIMARY field: "124,652,706"
 * Y1dQeuFl    Voice    speech   source=name    89 clips, source_text = "124,652,706"
 * 8T6pdCKh    NoComma  number   source=-       "124652706"
 * ```
 *
 * Two fields holding one number, because Mochi could render neither from the other.
 * Checked over all 90 cards before writing anything: **`Number` is exactly
 * `comma(NoComma)` on 90 of 90, with zero missing values**, so `Number` carries no
 * information `NoComma` does not and the merge is lossless. This script re-verifies
 * that every run and REFUSES on a single mismatch — the check is the reason it is
 * safe, not a formality.
 *
 * ─── WHAT IT WRITES ─────────────────────────────────────────────────────────
 *
 * 1. `card_field_values` for `name`: the comma'd value becomes the bare digits.
 * 2. `cards.name`: the same, because it mirrors that field (0 mismatches today).
 * 3. `template_fields`: `name`'s type becomes `number` and its options gain
 *    `{"group":"comma"}` — the display rule.
 * 4. `templates.content`: `<input value=<<NoComma>>>` becomes `<<Number>>`, so the
 *    answer box expects the same field the card shows.
 * 5. `NoComma` is DELETED from `template_fields`. Its VALUES are left in place, by
 *    the same schema rule everything else here leans on: `card_field_values` is not
 *    foreign-keyed to `template_fields`, so they cost nothing, they stop rendering,
 *    and they are the undo if this turns out wrong.
 *
 * ─── THE TWO CONSEQUENCES, NEITHER HIDDEN ───────────────────────────────────
 *
 * **The gallery and Ctrl+K will show `124652706`, not `124,652,706`.** They read
 * `cards.name` as plain text and have no field type to format by. That is the honest
 * price of his own principle — the stored value is the number — and it is one option
 * flip away from being reverted if he dislikes it on screen.
 *
 * **THE 89 CLIPS BROKE, AND THE FIX IS IN `src/generate/fields.ts`.** This is worth
 * reading before touching either file, because the first version of this comment
 * asserted the opposite and was wrong.
 *
 * A speech clip is addressed by GENERATION IDENTITY, not by `blob_refs.ref_key` —
 * `src/cards/audio.ts`: "94 of the 95 `<audio>` elements are generator slots", so
 * 617.9 MiB of speech is keyed on the source TEXT. Decision 7 and that module's own
 * header both say the input is the RENDERED text. But `fieldText` read
 * `context.values.get(field.id)` — the STORED value — and for every field in the
 * corpus those two were the same string, so the difference had never mattered.
 *
 * This migration is what made them differ. Measured immediately after applying it:
 * **78 数字 cards asked on entry and played NOTHING**, because the clips carry
 * `source_text = "143,710,122"` and the stored value had become `143710122`.
 *
 * `fieldText` now formats a `number` field through the same `groupDigits` the
 * resolver uses, which makes decision 7 true rather than nearly true. Re-measured:
 * **78 asked, 77 played** — the 78th is the one 数字 card with no clip at all. The
 * blast radius is exactly the fields carrying a display rule: one, today.
 *
 * ─── RUN IT AFTER EVERY REBUILD, AND BEFORE THE DASHBOARD IS FINE ───────────
 *
 * The importer rewrites `card_field_values`, `cards.name`, `template_fields` and
 * `templates.content` from the export, so every import undoes all five writes.
 * Unlike `reverse-dormant-apply` this moves NO dashboard figure — it touches no
 * track, no due date and no review — so its position in the chore is not delicate.
 */

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

    // ── THE CHECK THAT MAKES IT SAFE ──
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
      // REFUSE. A mismatch means the two fields disagree, and picking one would
      // silently discard whichever he actually meant.
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

    // `<input value=<<NoComma>>>` -> the primary field, so the answer box and the
    // card show the same one. Matched on the field NAME, which is how the body
    // refers to it (`src/template/resolve.ts` binds by name).
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
        // The FIELD goes; the VALUES stay. See the header — they are the undo.
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
