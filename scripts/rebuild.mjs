#!/usr/bin/env node
/**
 * THE SCHEMA-BUMP CHORE, AS ONE COMMAND THAT CANNOT MAKE THE QUIET MISTAKE.
 *
 * `SCHEMA_VERSION` refuses any version but its own, so a schema change means a full
 * rebuild rather than a migration. `CLAUDE.md` documents that as ten commands in a
 * required order and warns, in bold, that "this happened three times in one session"
 * — three separate times someone ran some of them.
 *
 * Ten ordered commands is not the problem. The problem is that skipping one FAILS
 * QUIETLY, and the worst of them is documented in as many words:
 *
 *   > Do not skip the second `load`. The UniDic cross-check is a separate file, and
 *   > without it `accent/cli.ts queue` reports 0 disputed instead of 57 — which
 *   > reads as "nothing left to adjudicate" rather than "the cross-check is missing".
 *
 * A zero that means "done" and a zero that means "never loaded" are the same zero.
 * Same shape for the last line: `rm build/hashigo.db` takes every locally-authored
 * field with it, so a rebuild that stops after the import leaves a database that
 * looks complete and has no 型 labels, no 読み rows, no かな主流 values.
 *
 * SO THIS SCRIPT'S REAL JOB IS THE LAST THIRD, NOT THE FIRST. Anyone can run ten
 * commands. What nobody can do reliably is notice the absence of something that
 * prints nothing. Every step is checked afterwards against an invariant that the
 * skipped step would violate, and a violated invariant is a hard failure with the
 * command that fixes it.
 *
 * TWO DELIBERATE SAFETY CHOICES:
 *
 * 1. **Prerequisites are checked BEFORE the database is deleted.** The derived
 *    `build/*.jsonl` files survive a rebuild — that is why four of the six accent
 *    steps are "the fast path" and Python is not needed. But if one of them is
 *    missing, finding out AFTER the wipe means the corpus is gone and the analyser
 *    has to be re-run. So: verify, then delete.
 * 2. **`--force` is required when the target database already exists.** The
 *    documented workflow opens with `rm`, so deletion is expected — but a 76 MB
 *    database with his local field edits in it should not evaporate because a path
 *    was mistyped.
 *
 * ON THE REFERENCE FIGURES. The expected counts below were measured on 2026-08-26.
 * They are printed for comparison and a difference is reported as INFO, never as a
 * failure — decision 16's one final import from Mochi will legitimately change every
 * one of them. Only the INVARIANTS fail the run, because those are the shape of the
 * mistake rather than the size of the corpus.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
}

const DB = opt("db", "build/hashigo.db");
const DRY = flag("dry");
const FORCE = flag("force");
const DASHBOARD = !flag("no-dashboard");

const EXPORTS = ["exports/日本語", "exports/English", "exports/基本情報"];

/**
 * Ordered. `needs` is checked before anything is deleted; `invariant` is checked
 * immediately after the step runs, and is the assertion that the step's absence
 * would break.
 */
const STEPS = [
  {
    name: "import",
    cmd: `npm run import -- --db "${DB}" ${EXPORTS.map((d) => `"${d}"`).join(" ")}`,
    needs: EXPORTS.map((dir) => `${dir}/data.json`),
    invariant: (db) => {
      const cards = db.prepare("SELECT count(*) n FROM cards").get().n;
      const reviews = db.prepare("SELECT count(*) n FROM reviews").get().n;
      if (cards === 0) return "the import produced 0 cards";
      if (reviews === 0) return "the import produced 0 reviews";
      return null;
    },
    reference: (db) => [
      ["cards", db.prepare("SELECT count(*) n FROM cards").get().n, 7716],
      ["reviews", db.prepare("SELECT count(*) n FROM reviews").get().n, 102020],
    ],
  },
  {
    name: "accent: head words",
    cmd: `npm exec vite-node src/accent/cli.ts -- words --db "${DB}" --out build/head-words.txt`,
    invariant: () => (existsSync(resolve(ROOT, "build/head-words.txt")) ? null : "build/head-words.txt was not written"),
  },
  {
    name: "accent: load openjtalk",
    cmd: `npm exec vite-node src/accent/cli.ts -- load --db "${DB}" --in build/accents.jsonl`,
    needs: ["build/accents.jsonl"],
    invariant: (db) => {
      const n = db.prepare("SELECT count(*) n FROM accents WHERE analyser = 'openjtalk'").get().n;
      return n > 0 ? null : "no openjtalk rows landed";
    },
    reference: (db) => [
      ["accents openjtalk", db.prepare("SELECT count(*) n FROM accents WHERE analyser='openjtalk'").get().n, 3850],
    ],
  },
  {
    // THE ONE THE DOCS WARN ABOUT. Its absence makes `queue` report 0 disputed,
    // which reads as success.
    name: "accent: load unidic (the cross-check)",
    cmd: `npm exec vite-node src/accent/cli.ts -- load --db "${DB}" --in build/accents-unidic.jsonl`,
    needs: ["build/accents-unidic.jsonl"],
    invariant: (db) => {
      const n = db.prepare("SELECT count(*) n FROM accents WHERE analyser = 'unidic'").get().n;
      return n > 0
        ? null
        : "NO UNIDIC ROWS. This is the documented trap: `accent/cli.ts queue` will now " +
            "report 0 disputed instead of 57, which reads as 'nothing to adjudicate'";
    },
    reference: (db) => [
      ["accents unidic", db.prepare("SELECT count(*) n FROM accents WHERE analyser='unidic'").get().n, 3015],
    ],
  },
  {
    name: "accent: ojad adjudications",
    cmd: `npm exec vite-node src/accent/cli.ts -- ojad --db "${DB}"`,
    invariant: (db) => {
      const n = db.prepare("SELECT count(*) n FROM accents WHERE analyser = 'manual'").get().n;
      return n > 0 ? null : "no manual (OJAD) adjudications landed";
    },
    reference: (db) => [
      ["accents manual", db.prepare("SELECT count(*) n FROM accents WHERE analyser='manual'").get().n, 33],
    ],
  },
  {
    name: "local fields: 読み",
    cmd: `npm exec vite-node scripts/reading-apply.ts -- --db "${DB}" --apply`,
    invariant: (db) => {
      const n = db
        .prepare(
          "SELECT count(*) n FROM card_field_values v JOIN template_fields f " +
            "ON f.id = v.field_id AND f.template_id = (SELECT template_id FROM template_fields WHERE name = '読み' LIMIT 1) " +
            "WHERE f.name = '読み'",
        )
        .get().n;
      return n > 0 ? null : "no 読み values — the locally-authored readings did not land";
    },
  },
  {
    name: "local fields: 型 field + template bodies",
    cmd: `npm exec vite-node scripts/accent-field-apply.ts -- --db "${DB}" --apply`,
    invariant: (db) => {
      const n = db.prepare("SELECT count(*) n FROM template_fields WHERE name = '型'").get().n;
      return n > 0 ? null : "the 型 field was not declared on any template";
    },
  },
  {
    /**
     * 数字 keeps ONE number field and the comma becomes presentation — Zach's call,
     * 2026-09-07. The importer rewrites the values, `cards.name`, the field row and
     * the template body from the export, so every rebuild undoes all of it.
     *
     * Position is not delicate, unlike `reverse-dormant-apply`: this touches no
     * track, no due date and no review, so it moves NO dashboard figure.
     */
    name: "local: 数字 merges its two number fields",
    cmd: `npm exec vite-node scripts/number-field-apply.ts -- --db "${DB}" --apply`,
    invariant: (db) => {
      const row = db
        .prepare(
          "SELECT count(*) AS n FROM template_fields f " +
            "JOIN templates t ON t.id = f.template_id " +
            "WHERE t.name = '数字' AND f.type = 'number'",
        )
        .get();
      // Exactly one number field, and it must carry the display rule — otherwise
      // either the merge did not run or it ran and the comma never comes back.
      if (row.n !== 1) return `数字 has ${row.n} number field(s); expected exactly 1`;
      const primary = db
        .prepare(
          "SELECT f.options FROM template_fields f JOIN templates t ON t.id = f.template_id " +
            "WHERE t.name = '数字' AND f.id = 'name'",
        )
        .get();
      return String(primary?.options ?? "").includes('"group"')
        ? null
        : "数字's primary field has no `group` option, so every number renders unformatted";
    },
  },
  {
    name: "accent: write 型 labels",
    cmd: `npm exec vite-node src/accent/cli.ts -- write --db "${DB}"`,
    invariant: (db) => {
      const n = db
        .prepare(
          "SELECT count(*) n FROM card_field_values v " +
            "WHERE v.field_id IN (SELECT id FROM template_fields WHERE name = '型')",
        )
        .get().n;
      return n > 0
        ? null
        : "no 型 labels were written — every accent-bearing card would render without " +
            "the only thing that distinguishes 平板 from 尾高 (decision 27)";
    },
    reference: (db) => [
      [
        "型 labels",
        db
          .prepare(
            "SELECT count(*) n FROM card_field_values v WHERE v.field_id IN " +
              "(SELECT id FROM template_fields WHERE name = '型')",
          )
          .get().n,
        3830,
      ],
    ],
  },
  /**
   * DECISION 43'S ANNOTATIONS — MISSING FROM THIS SEQUENCE UNTIL 2026-09-25.
   *
   * A rebuild took all 3,719 `ojad` values and both `<ojad>` body insertions with
   * it, with every invariant above still green: this list ran `cli.ts ojad` (the
   * 33 hand adjudications, a different thing with a similar name) and none of
   * the three steps below. `src/template/ast.ts` even claimed the template step
   * was "part of the documented rebuild sequence". It was not, anywhere.
   *
   * The analyser's OUTPUT is the input here, the same fast path as
   * `accents.jsonl`: `build/sentence-marks.jsonl` survives the `rm` and Python
   * is only needed when the sentences themselves change. `marks` also declares
   * the field — with its role and source pointer since stage F.
   */
  {
    name: "accent: ojad per-mora annotations (declare + load)",
    cmd: `npm exec vite-node src/accent/cli.ts -- marks --db "${DB}" --in build/sentence-marks.jsonl`,
    invariant: (db) => {
      if (!existsSync(resolve(ROOT, "build/sentence-marks.jsonl"))) {
        return "build/sentence-marks.jsonl is missing — run tools/accent_sentence.py first";
      }
      const n = db
        .prepare(
          "SELECT count(*) n FROM card_field_values v JOIN template_fields f " +
            "ON f.id = v.field_id AND json_extract(f.options, '$.\"hashigo-role\"') = 'ojad' " +
            "WHERE v.value <> ''",
        )
        .get().n;
      return n > 0 ? null : "no ojad annotations were written — every example sentence renders bare";
    },
    reference: (db) => [
      [
        "ojad annotations",
        db
          .prepare(
            "SELECT count(DISTINCT v.card_id) n FROM card_field_values v JOIN template_fields f " +
              "ON f.id = v.field_id AND json_extract(f.options, '$.\"hashigo-role\"') = 'ojad' " +
              "WHERE v.value <> ''",
          )
          .get().n,
        3719,
      ],
    ],
  },
  {
    /**
     * Decision 29's switch, declared by ROLE (stage G). The mode still falls back
     * to name + type, so a rebuild without this renders correctly — but the role
     * is what survives a rename, and a rebuild that silently dropped it would put
     * the name back in charge with nothing to say so.
     */
    name: "local: 単語's Reading carries the reading-switch role",
    cmd: `npm exec vite-node scripts/reading-role-apply.ts -- --db "${DB}" --apply`,
    invariant: (db) => {
      const n = db
        .prepare(
          "SELECT count(*) n FROM template_fields f WHERE f.type = 'boolean' " +
            "AND json_extract(f.options, '$.\"hashigo-role\"') = 'reading-switch'",
        )
        .get().n;
      return n > 0 ? null : "no boolean carries the reading-switch role — decision 29 is bound by name again";
    },
  },
  {
    name: "local: <ojad> goes under the sentence in 単語 / 言葉",
    cmd: `npm exec vite-node scripts/ojad-template-apply.ts -- --db "${DB}" --apply`,
    invariant: (db) => {
      const bare = db
        .prepare(
          "SELECT name FROM templates WHERE name IN ('単語', '言葉') AND instr(content, '<ojad>') = 0",
        )
        .all();
      return bare.length === 0
        ? null
        : `${bare.map((row) => row.name).join(", ")} still has no <ojad> — the values exist and render nowhere`;
    },
  },
];

if (DASHBOARD) {
  STEPS.push({
    name: "dashboard (regenerate — a test asserts it byte-identical)",
    cmd: `npm run dashboard -- --db "${DB}" --out dashboard.html`,
    invariant: () => (existsSync(resolve(ROOT, "dashboard.html")) ? null : "dashboard.html was not written"),
  });
}

/**
 * LAST, AND STRICTLY AFTER THE DASHBOARD — the ordering is the whole point.
 *
 * The committed `dashboard.html` is the IMPORTER'S ORACLE: `test/dashboard.test.ts`
 * imports `exports/` into an in-memory database and compares byte-for-byte, so the
 * page is a pure function of the export. Every other local step above is safe to run
 * before it because none of them moves a dashboard figure — head words and template
 * bodies do not appear in it.
 *
 * **This one does.** `dormant` feeds deck progress, the backlog and the interval-cap
 * ratio. Regenerating the dashboard after it turned two oracle tests red on
 * 2026-09-07 (backlog 108 -> 102, overdue 76 -> 70, the dormant column, and the cap
 * denominator 8,956 -> 8,955). So the working database and the committed page differ
 * by exactly these six tracks, deliberately.
 */
STEPS.push({
  name: "local: the 6 forced reverse tracks go dormant (AFTER the dashboard)",
  cmd: `npm exec vite-node scripts/reverse-dormant-apply.ts -- --db "${DB}" --apply`,
  /**
   * Checks the EFFECT, not the message — and as a property rather than a count.
   *
   * "Exactly 3 remain" would be wrong the first time he turns reverse on for a
   * fourth card in Mochi. The real property is that no card is scheduled in reverse
   * against its deck on the strength of one or two stray reviews: his three carry
   * 14 each, the six turned off carried 1 or 2.
   */
  invariant: (db) => {
    const stray = db
      .prepare(
        `SELECT count(*) AS n FROM cards c
           JOIN card_tracks t             ON t.card_id  = c.id AND t.kind = 'reverse'
           JOIN card_reverse_resolved cr  ON cr.card_id = c.id
           JOIN deck_reverse_resolved dr  ON dr.deck_id = c.deck_id
          WHERE t.dormant = 0 AND cr.reverse = 'on' AND dr.reverse <> 'on'
            AND (SELECT count(*) FROM reviews v WHERE v.track_id = t.id) <= 2`,
      )
      .get().n;
    return stray === 0
      ? null
      : `${stray} reverse track(s) are still scheduled against their deck on 1-2 stray ` +
        `reviews. The import rule forces \`cards.reverse = 'on'\` for any card carrying ` +
        `reverse history, and Zach turned those off on 2026-09-07 — a rebuild that ` +
        `leaves them on puts deeply overdue reverse cards back at the FRONT of his queue.`;
  },
});

// ── prerequisites, BEFORE anything is destroyed ────────────────────────────────

const missing = [];
for (const step of STEPS) {
  for (const need of step.needs ?? []) {
    if (!existsSync(resolve(ROOT, need))) missing.push(`${need}  (needed by: ${step.name})`);
  }
}
if (missing.length > 0) {
  console.error("rebuild: REFUSING TO START — prerequisites are missing:\n");
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    "\nNothing has been deleted. The derived build/*.jsonl files normally survive a\n" +
      "rebuild; if one is genuinely gone, the analyser has to be re-run:\n" +
      "  .venv-accent/Scripts/python tools/accent_derive.py --words build/head-words.txt --out build/accents.jsonl",
  );
  process.exit(2);
}

const dbPath = resolve(ROOT, DB);
if (existsSync(dbPath) && !FORCE && !DRY) {
  console.error(`rebuild: ${DB} exists and would be DELETED.`);
  console.error("rebuild: that is the documented workflow, but not by accident. Re-run with --force.");
  console.error(`rebuild:   npm run rebuild -- --db ${DB} --force`);
  process.exit(2);
}

console.log(`rebuild: ${DRY ? "DRY RUN — " : ""}${STEPS.length} steps into ${DB}`);
if (DRY) {
  for (const [i, step] of STEPS.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${step.name}`);
    console.log(`      ${step.cmd}`);
  }
  console.log(`\nrebuild: would ${existsSync(dbPath) ? "DELETE and recreate" : "create"} ${DB}`);
  process.exit(0);
}

// ── run ───────────────────────────────────────────────────────────────────────

for (const suffix of ["", "-shm", "-wal"]) {
  const p = `${dbPath}${suffix}`;
  if (existsSync(p)) {
    rmSync(p);
    console.log(`rebuild: removed ${DB}${suffix}`);
  }
}

const notes = [];
for (const [i, step] of STEPS.entries()) {
  const label = `[${i + 1}/${STEPS.length}] ${step.name}`;
  console.log(`\n─── ${label}`);
  const started = Date.now();
  // One string + shell:true — `.cmd` cannot be spawned without a shell on Windows
  // (EINVAL, CVE-2024-27980), and an args ARRAY with shell:true earns DEP0190.
  const proc = spawnSync(step.cmd, { cwd: ROOT, encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] });
  if (proc.error) {
    console.error(`rebuild: step ${i + 1} (${step.name}) NEVER RAN — ${proc.error.code ?? ""} ${proc.error.message}`);
    process.exit(1);
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (proc.status !== 0) {
    console.error(`${proc.stdout ?? ""}${proc.stderr ?? ""}`);
    console.error(`rebuild: FAILED at step ${i + 1} (${step.name}) after ${secs}s`);
    process.exit(1);
  }
  const tail = (proc.stdout ?? "").trimEnd().split("\n").at(-1) ?? "";
  console.log(`    ok (${secs}s)  ${tail.slice(0, 120)}`);

  const db = new Database(dbPath, { readonly: true });
  try {
    const broken = step.invariant?.(db) ?? null;
    if (broken !== null) {
      console.error(`\nrebuild: STEP RAN BUT ITS INVARIANT FAILED — ${broken}`);
      console.error(`rebuild: the failing step was: ${step.cmd}`);
      process.exit(1);
    }
    for (const [name, actual, expected] of step.reference?.(db) ?? []) {
      notes.push({ name, actual, expected });
    }
  } finally {
    db.close();
  }
}

console.log(`\n${"═".repeat(64)}`);
console.log("  measured now            vs 2026-08-26 reference");
for (const n of notes) {
  const same = n.actual === n.expected;
  console.log(
    `  ${same ? "  " : "! "}${n.name.padEnd(20)} ${String(n.actual).padStart(8)}` +
      (same ? "   (unchanged)" : `   was ${n.expected}`),
  );
}
console.log("═".repeat(64));
if (notes.some((n) => n.actual !== n.expected)) {
  console.log(
    "rebuild: figures marked ! differ from the reference. The reference is the\n" +
      "         2026-08-26 export; decision 16's final import (2026-09-08) landed\n" +
      "         after it, so cards 7,716 and reviews 103,110 are the current pair\n" +
      "         and a ! on reviews alone is expected. Anything else, find out why.",
  );
}
console.log("rebuild: done — all invariants hold.");
