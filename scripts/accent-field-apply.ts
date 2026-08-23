/**
 * D3 — WRITE the `型` field and render it, and render `かな主流` too.
 *
 *   npx vite-node scripts/accent-field-apply.ts -- --db build/hashigo.db            # dry run
 *   npx vite-node scripts/accent-field-apply.ts -- --db build/hashigo.db --apply    # writes
 *
 * Then materialise the labels, which is a separate existing command:
 *
 *   npx vite-node src/accent/cli.ts -- write --db build/hashigo.db
 *
 * Zach chose "both" on 2026-08-23. Decision 20 settled the placement long before:
 * **`型` on side 2 immediately above `<<Speech>>`, `かな主流` on side 1 inside the
 * `<<#Reading>>` gate.** This is the writing half; nothing here is a new decision.
 *
 * ─── WHY THIS IS NOT AN EDIT IN MOCHI ────────────────────────────────────────
 *
 * `templates.content` is a column in THIS database, so the template body is ours
 * to change — an earlier session said "only Zach can do this, it is in his Mochi
 * templates", which confused "the template came from Mochi" with "the edit must
 * happen there". It does not.
 *
 * Editing it in Mochi would be actively worse. Mochi has no `型` field, so
 * `<<型>>` in the Mochi template renders as an unresolved field **in his daily
 * reviews** — he is still doing ~100 cards a day there. That degrades the tool he
 * is actually using in order to fix one he is not using yet.
 *
 * ─── SO IT MUST BE RE-APPLIED, AND THAT IS NOT A DEFECT ──────────────────────
 *
 * `templates.content` is Mochi's field, so decision 9's `local = 1` cannot protect
 * it — that flag protects a field we ADDED, never an EDIT to something Mochi owns.
 * A schema bump means `rm build/hashigo.db` and a re-import from zero, and the
 * final import (decision 16) would overwrite the body too. So this belongs in the
 * documented rebuild sequence beside `scripts/reading-apply.ts`, and it is
 * idempotent and self-erasing for exactly that reason: run it twice and the second
 * run says ALREADY APPLIED.
 *
 * ─── TWO FORMS, AND ONLY ONE OF THEM IS OBVIOUS ──────────────────────────────
 *
 * `型` is interpolated BARE. Measured before writing it: a declared field with no
 * value substitutes the empty string, so a card whose head word has no derived
 * accent renders nothing — no literal `<<型>>`, no diagnostics. Only 3,850 head
 * words have an accent, so that mattered. A section gate around it also works and
 * is not needed.
 *
 * `かな主流` is GATED, and its markers are each ALONE ON THEIR OWN LINE. It is a
 * `boolean`, and `notes/kana-primary-words.md` measured both failure modes: bare
 * `<<かな主流>>` reports `boolean-interpolated` and substitutes empty, so the label
 * renders on NEITHER branch; and written on one line the resolver reports
 * `stray-section-marker` and the gate silently does not fire, so the label renders
 * on BOTH. Neither looks like a syntax error — they look like the flag being
 * ignored.
 *
 * `言葉` HAS NO `<<#Reading>>` GATE, so decision 20's `かな主流` placement has no
 * home there and this script does not invent one. It is reported, not silently
 * skipped.
 */

import { openDatabase } from "../src/db/index.js";

const dbIndex = process.argv.indexOf("--db");
const path = dbIndex >= 0 ? (process.argv[dbIndex + 1] as string) : "build/hashigo.db";
const apply = process.argv.includes("--apply");

process.stdout.setDefaultEncoding("utf8");

/** The accent field, one row per template that has a head word to derive from. */
const ACCENT_FIELD = {
  id: "local-accent",
  name: "型",
  type: "accent",
  /**
   * MUST be set or `materialiseAccents` skips the field entirely — "no source
   * pointer means nothing to derive from". `name` is right rather than
   * `local-yomi`: the `accents` table is keyed on the head-word text, because
   * `accent/cli.ts words` selected `field_id = 'name'` when it built the list.
   */
  sourceFieldId: "name",
  /** A fractional index, after 読み ('ab') and かな主流 ('ac'). */
  pos: "ad",
} as const;

interface Edit {
  readonly template: string;
  readonly name: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

const KANA_GATE = ["<< #かな主流 >>", "◎かな主流", "<< /かな主流 >>"].join("\n");

const EDITS: readonly Edit[] = [
  {
    template: "oiaISYb2",
    name: "単語",
    label: "型 above <<Speech>> (side 2)",
    from: "{{<furigana><< 単語 >></furigana>}}\n<< Speech >>",
    to: "{{<furigana><< 単語 >></furigana>}}\n<< 型 >>\n<< Speech >>",
  },
  {
    template: "oiaISYb2",
    name: "単語",
    label: "かな主流 inside the <<#Reading>> gate (side 1)",
    from: "<< #Reading>>\n<< Reference >>\n<< /Reading >>",
    to: `<< #Reading>>\n<< Reference >>\n${KANA_GATE}\n<< /Reading >>`,
  },
  {
    template: "itmYDz2N",
    name: "言葉",
    label: "型 above <<Speech>>",
    from: "___\n<< Speech >>",
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

    // ── 1. the field rows ────────────────────────────────────────────────────
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

    // ── 2. the body edits ────────────────────────────────────────────────────
    const pending: Edit[] = [];
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
      if (!t.content.includes(edit.from)) {
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

    // `言葉` has no Reading gate. Said out loud rather than passed over.
    const kotoba = templates.get("itmYDz2N");
    if (kotoba !== undefined && !kotoba.content.includes("#Reading")) {
      console.log(
        "  note   言葉 has no <<#Reading>> gate, so decision 20's かな主流 placement\n" +
          "         has no home there. NOT invented. Its 6 values stay unrendered on 言葉.",
      );
    }

    if (fieldsNeeded === 0 && pending.length === 0) {
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
        // options is NOT NULL DEFAULT '{}', so passing NULL is a constraint error
        // rather than an "absent" — every existing local field carries '{}'.
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
        const next = t.content.replace(edit.from, edit.to);
        db.prepare(
          `UPDATE templates SET content = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        ).run(next, edit.template);
        t.content = next; // two edits touch 単語; the second must see the first
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
