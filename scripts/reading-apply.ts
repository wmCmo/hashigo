/**
 * A4 — WRITE the parenthesis fix: create the two local fields, then apply the 13
 * rows. Green-lit by Zach 2026-08-22.
 *
 *   npx vite-node scripts/reading-apply.ts -- --db build/hashigo.db            # dry run
 *   npx vite-node scripts/reading-apply.ts -- --db build/hashigo.db --apply    # writes
 *
 * `scripts/reading-parse.ts` prints the rows and stays read-only; this is the
 * writing half. Both classify through `src/text/parenthesis.ts`, so there is one
 * rule and not two that agree today.
 *
 * ─── RUN IT AFTER EVERY REBUILD, AND WHY THAT IS NOT A DEFECT ───────────────
 *
 * A schema bump means `rm build/hashigo.db` and import from zero, which takes
 * every locally-authored field and value with it. So this belongs in the
 * documented rebuild sequence beside the accent reload, and CLAUDE.md now lists
 * it there.
 *
 * An ORDINARY re-import — Mochi export into the existing database, which is what
 * Zach actually does while he is still reviewing ~100 cards/day there — does NOT
 * need it, and that is decision 9 working exactly as designed. Verified in code
 * and then verified again by running it:
 *
 *   * `template_fields` is UPSERT-only. Nothing in `src/import` ever deletes a
 *     field row, so a local field survives untouched.
 *   * `pruneFieldValues` deletes a card's values that the export no longer
 *     carries — `AND NOT EXISTS (… WHERE f.id = card_field_values.field_id AND
 *     f.local = 1)`. Local fields are exempt by that clause.
 *
 * The one thing an ordinary re-import DOES overwrite is `card_field_values` for
 * `name`, because Mochi still holds `器（うつわ）`. So the head word reverts and
 * the `読み` value survives — a half-applied state. This script is idempotent and
 * re-applying fixes it, which is why it reports what it changed rather than
 * saying "done".
 *
 * ─── WHAT IT COSTS, MEASURED ───────────────────────────────────────────────
 *
 * Changing a head word changes the generation cache key, so the existing clip
 * stops resolving. Measured before writing: **12 of the 13 have a speech clip
 * filed under the bracketed text.** Those are not working clips being thrown
 * away — they are the clips with the brackets read aloud, which is the bug this
 * fixes. New audio needs a provider call and Zach's key, so it is not this
 * script's job (decision 18: the key never goes in the client).
 *
 * ─── ONE THING IT DOES NOT DO, AND THE IMPACT IS MEASURED ──────────────────
 *
 * It does not recompute `cards.search_text`, so those 13 rows still hold the
 * bracketed spelling. That is the same gap `materialiseAccents` has and it is a
 * PARKED design question, not an oversight: `search_text` is
 * `renderPlainTextParts([content, ...values in EXPORT order])` and that order is
 * not recoverable from the database — rebuilding all 7,716 from the DB reproduces
 * 6,145 and differs on 1,571. Guessing an order here to fix 13 rows would put
 * fiction into the search index.
 *
 * The practical impact today is nil, and that is checkable rather than hopeful:
 * the stale text is a SUPERSET of the new one. `器（うつわ）` contains both `器`
 * and `うつわ`, so every query that should match still matches. What is missing
 * is only the ability to NOT match on the brackets.
 */
import { openDatabase } from "../src/db/index.js";
import { YOMI_FIELD } from "../src/fields/yomi.js";
import { hasParenthesis, parseReading, type ParsedReading } from "../src/text/parenthesis.js";

/**
 * The two fields decision 10 needs, on the two templates that carry head words.
 *
 * `local = 1` is the whole point: `pruneFieldValues` cannot otherwise tell a
 * field Mochi DELETED from one Mochi NEVER HAD, and without it every re-import
 * silently discards these values.
 *
 * The ids are deliberately NOT Mochi-shaped. Mochi ids are 8 alphanumeric
 * characters; a hyphenated `local-` prefix cannot collide with one, and it is
 * visible as local in any query output without a join.
 */
const LOCAL_FIELDS = [
  {
    id: "local-yomi",
    name: YOMI_FIELD,
    type: "plain",
    // After the head word (`pos = 'a'`) and before everything else, because it
    // is a property OF the head word. Mochi's own pos values are short sort
    // keys, not indices, so this slots in without renumbering anything.
    pos: "ab",
  },
  {
    id: "local-kana-primary",
    name: "かな主流",
    // A flag, not a value. Decision 20 renders it inside the `<<#Reading>>`
    // gate on side 1, which is a boolean gate.
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

  // ─── 1. the fields ─────────────────────────────────────────────────────────
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

  // ─── 2. the rows ───────────────────────────────────────────────────────────
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

    // A 意味 row gets no 読み: the gloss belongs in the meaning field, and
    // writing an empty 読み would make `<<#Reading>>` look answered.
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

  // THE SCRIPT IS SELF-ERASING, and the report has to say so rather than print a
  // bare zero. Once applied, no head word carries a bracket any more, so the scan
  // finds nothing — which looks identical to "the query is broken". Distinguish
  // the two by asking whether the values are already there.
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
