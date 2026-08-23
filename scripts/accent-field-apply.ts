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
  /**
   * Anchors to try, in order — the first one present wins.
   *
   * A LIST rather than a string because this script has to be re-appliable from
   * two different starting states: a database freshly imported from Mochi (whose
   * body has never seen `型`) and one where an earlier run of this same script
   * already inserted the plain form. Both must land on the same `to`, and after
   * either one the `to` check reports "already there" — so a re-run says ALREADY
   * APPLIED rather than printing an alarming ANCHOR NOT FOUND for whichever path
   * was not taken.
   */
  readonly from: readonly string[];
  readonly to: string;
}

const KANA_GATE = ["<< #かな主流 >>", "◎かな主流", "<< /かな主流 >>"].join("\n");

/**
 * `型` on 単語 side 2, gated BOTH ways — decision 29.
 *
 * Two branches, because the two modes need it rendered differently and a template
 * cannot say "cloze this only sometimes" in one line:
 *
 *   `Reading` true   `{{<< 型 >>}}`   the accent is the ANSWER, so it stays MASKED
 *                                     until the reveal, alongside the reading.
 *   otherwise        `<< 型 >>`       the accent is part of the QUESTION, plain on
 *                                     screen while the word itself stays hidden.
 *
 * That asymmetry IS decision 20's reasoning applied honestly. Decision 20 kept `型`
 * off side 1 because showing it "would hand him the thing he is meant to produce" —
 * and side-2 ENTRY has exactly the same property, so the plain form was leaking the
 * answer on all 692 mode-1 cards. Decision 29 then established that on the other
 * 3,177 the leak is the POINT: he is auditing his own accents there, and hiding the
 * label removes the audit the whole pipeline exists to feed.
 *
 * **The outer `<<#型>>` is not decoration.** An empty cloze does NOT render as
 * nothing — measured before writing this, `{{}}` reaches the page as the LITERAL
 * TEXT `{{}}`. Only 689 of the 692 mode-1 cards have a derived accent, so without
 * the guard three cards would show braces. The plain branch needs no guard (an
 * absent value substitutes the empty string) and sits inside the same one anyway,
 * so the block reads as one thought.
 *
 * Markers are each ALONE ON THEIR OWN LINE. Inline section markers are measured to
 * fail — `stray-section-marker`, and the gate silently does not fire.
 */
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
      // A database where an earlier run inserted the plain form (D3, 2026-08-23).
      "{{<furigana><< 単語 >></furigana>}}\n<< 型 >>\n<< Speech >>",
      // A database freshly imported from Mochi, which has never seen `型`.
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
    // No branch here on purpose: 言葉 declares no `Reading` field at all, so every
    // one of its 392 cards is mode 2 and the label is always part of the question.
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
    // Anchors that matched NOTHING. Counted rather than merely printed, because
    // "ALREADY APPLIED — nothing to do" printed over the top of a skipped edit
    // reads as success, and that is the exact shape of failure this repo keeps
    // finding: a report that is true about what it looked at and silent about
    // what it did not.
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

    // `言葉` has no Reading gate. Said out loud rather than passed over.
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
        const anchor = edit.from.find((candidate) => t.content.includes(candidate));
        if (anchor === undefined) continue;
        const next = t.content.replace(anchor, edit.to);
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
