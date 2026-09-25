/**
 * `npx vite-node src/accent/cli.ts -- <command>`
 *
 *   words --db D --out F        normalised head words, one per line
 *   load  --db D --in  F        JSONL from tools/accent_derive.py -> accents
 *   write --db D [--dry-run]    the resolved 型 label -> card_field_values
 *   show  --db D <word>...      what the resolved accent is, and on what basis
 *   respeak --db D [--dry] [--limit N] [--store DIR]
 *                               re-synthesise every head word on 単語 + 言葉 with
 *                               its accent notation, then adopt the new voice
 *
 * The three-step shape exists because the analyser is Python-only and the text
 * transform must not be. `words` is the seam: TypeScript decides what string an
 * accent is filed under, Python only analyses the strings it is handed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { openDatabase } from "../db/index.js";
import { accentKey, readingLooksUnanalysed } from "./key.js";
import {
  DICTIONARY_ADJUDICATIONS,
  OJAD_ADJUDICATIONS,
  applyOjadAdjudications,
  cardAccentOverrides,
} from "./ojad.js";
import { accentFor, loadAccents, materialiseAccents, type AccentRow } from "./store.js";
import { arg, flag } from "../cli/args.js";
import { respeakCommand } from "./respeak-cli.js";
import { declareField, extractSentences, loadMarks, type AnnotatedLine } from "./marks.js";

/**
 * The head words, by the SAME basis as the distribution table in
 * notes/pitch-accent-pipeline.md: `card_field_values.value` for the field whose
 * id is `name`, on templates 単語 and 言葉.
 *
 * Template-scoped on purpose. `name` is not unique across templates — it is also
 * 基本情報's Cue — and an unscoped query silently pulls in another template's
 * sentences. That mistake produced a count of 3,668 "misses" earlier in this
 * work when the real number was 189.
 *
 * BY DATA since stage G of fields-as-modules: the head word is whatever field the
 * template's `accent` field reads (`source_field_id`), which is how
 * `src/accent/store.ts` has always found it. Still template-scoped — by the
 * accent field's own template — so 基本情報's `name` stays out, and on this corpus
 * the answer is the same 単語/言葉 `name` fields the literal named.
 */
const HEAD_WORDS_SQL = `
  SELECT DISTINCT v.value
    FROM card_field_values v
    JOIN cards c ON c.id = v.card_id
    JOIN template_fields a ON a.template_id = c.template_id AND a.type = 'accent'
   WHERE v.field_id = a.source_field_id AND v.value <> ''`;

interface DerivedLine {
  value: string;
  ok: boolean;
  guarded?: boolean;
  basis: string;
  type: string | null;
  accent_type: number | null;
  phrases: [number, number][];
  reading: string;
  version: string;
  probe: string;
  reason?: string | null;
  /** Present on cross-check rows. Defaults to the primary analyser. */
  analyser?: string;
}


async function main(): Promise<number> {
  const command = process.argv[2];
  if (command === undefined || command.startsWith("--")) {
    console.error(
      "usage: cli.ts <words|load|ojad|write|show|queue|respeak|sentences|marks> --db <file> ...",
    );
    return 2;
  }
  const db = openDatabase(arg("db"), {
      readOnly:
        command === "words" ||
        command === "show" ||
        command === "queue" ||
        command === "sentences" ||
        (command === "respeak" && flag("dry")),
    });
  try {
    if (command === "words") {
      const rows = db.prepare(HEAD_WORDS_SQL).all() as { value: string }[];
      // Deduped AFTER normalisation, not before: 準‎備 and 準備 are one word and
      // deriving both would put two rows in `accents` for one string.
      const keys = [...new Set(rows.map((row) => accentKey(row.value)))].filter((k) => k !== "");
      keys.sort();
      writeFileSync(arg("out"), keys.join("\n") + "\n", "utf8");
      console.log(`${rows.length} values -> ${keys.length} distinct keys -> ${arg("out")}`);
      return 0;
    }

    if (command === "respeak") {
      return await respeakCommand(db);
    }

    if (command === "load") {
      const lines = readFileSync(arg("in"), "utf8").split("\n").filter((l) => l.trim() !== "");
      const rows: AccentRow[] = [];
      let unanalysed = 0;
      for (const line of lines) {
        const parsed = JSON.parse(line) as DerivedLine;
        // The analyser returns the kanji back when it does not know a word (嗤う
        // -> 嗤ウ) and the failure is otherwise SILENT: the mora count and the
        // accent type both come out plausible. Refuse those here.
        const bad = parsed.ok && readingLooksUnanalysed(parsed.reading);
        if (bad) unanalysed += 1;
        const guarded = !parsed.ok || bad;
        rows.push({
          text: parsed.value,
          analyser: parsed.analyser ?? "openjtalk",
          version: parsed.version,
          probe: parsed.probe,
          phrases: guarded ? [] : parsed.phrases,
          type: guarded ? null : (parsed.type as AccentRow["type"]),
          accentType: guarded ? null : parsed.accent_type,
          reading: parsed.reading === "" ? null : parsed.reading,
          basis: guarded ? "guarded" : (parsed.basis as AccentRow["basis"]),
          note: bad
            ? `analyser returned kanji in the reading: ${parsed.reading}`
            : (parsed.reason ?? null),
        });
      }
      const report = loadAccents(db, rows);
      console.log(
        `loaded ${report.inserted}: ${report.labelled} labelled, ${report.guarded} guarded ` +
          `(${unanalysed} of those because the reading came back unanalysed)`,
      );
      const total = Object.values(report.byType).reduce((a, b) => a + b, 0);
      for (const [type, count] of Object.entries(report.byType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type}  ${String(count).padStart(5)}  ${((count / total) * 100).toFixed(1)}%`);
      }
      return 0;
    }

    if (command === "queue") {
      // The adjudication queue, from the view rather than a report file so it
      // cannot go stale. Zach's instruction for settling these: OJAD, through
      // its own interface, driven the way a person would — not a scraper.
      const rows = db
        .prepare(
          `SELECT text, primary_type, primary_accent, primary_basis, primary_reading,
                  other_analyser, other_type, other_accent, other_reading, kind
             FROM accent_disagreements ORDER BY kind, text`,
        )
        .all() as Record<string, string | number | null>[];
      console.log(`${rows.length} word(s) need adjudication` + "\n");
      for (const row of rows) {
        console.log(
          `  ${String(row["text"]).padEnd(12)} ${String(row["kind"]).padEnd(16)}` +
            ` primary=${row["primary_type"] ?? "REFUSED"}(${row["primary_accent"] ?? "-"})` +
            ` ${String(row["primary_reading"] ?? "-").padEnd(10)}` +
            ` ${row["other_analyser"]}=${row["other_type"]}(${row["other_accent"]})` +
            ` ${row["other_reading"]}`,
        );
      }
      return 0;
    }

    if (command === "ojad") {
      // The hand-entered adjudications. They land as manual overrides, so they
      // beat both the primary derivation and the cross-check.
      const { applied } = applyOjadAdjudications(db);
      console.log(
        `applied ${applied} adjudication(s) as manual overrides ` +
          `(${OJAD_ADJUDICATIONS.length} from OJAD, ${DICTIONARY_ADJUDICATIONS.length} from a dictionary)`,
      );
      return 0;
    }

    if (command === "write") {
      const dryRun = process.argv.includes("--dry-run");
      const report = materialiseAccents(db, { dryRun, cardOverrides: cardAccentOverrides() });
      console.log(
        `${dryRun ? "would write" : "wrote"} ${report.written}, unchanged ${report.unchanged}, ` +
          `guarded ${report.guarded} (left EMPTY on purpose), underived ${report.underived}`,
      );
      for (const [type, count] of Object.entries(report.byType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type}  ${count}`);
      }
      return 0;
    }

    if (command === "show") {
      for (const word of process.argv.slice(3).filter((a) => !a.startsWith("--") && a !== arg("db"))) {
        const resolved = accentFor(db, word);
        if (resolved === null) {
          console.log(`${word}  (nothing derived — NOT the same as refused)`);
          continue;
        }
        console.log(
          `${word}  key=${resolved.text}  ${resolved.type ?? "REFUSED"}` +
            ` accent=${resolved.accentType ?? "-"} basis=${resolved.basis}` +
            ` reading=${resolved.reading ?? "-"} phrases=${JSON.stringify(resolved.phrases)}` +
            (resolved.note === null ? "" : `  note: ${resolved.note}`),
        );
      }
      return 0;
    }

    // ─── stage 12: the per-mora sentence annotation ─────────────────────────
    //
    // TWO commands and not one, because the analyser is Python and lives behind
    // a file — the same three-step shape as `words` / accent_derive / `load`,
    // for the same reason `src/accent/README.md` gives.
    if (command === "sentences") {
      const report = extractSentences(db);
      // Deduped: the same sentence is one pronunciation however many cards
      // carry it, and analysing it twice would cost time and prove nothing.
      const distinct = [...new Set(report.clean.map((row) => row.sentence))].sort();
      writeFileSync(arg("out"), distinct.join("\n") + "\n", "utf8");
      console.log(`${report.cards} card(s) with an 例文 field -> ${report.clean.length} sentence(s)`);
      console.log(`  ${distinct.length} distinct -> ${arg("out")}`);
      console.log(`  ${report.ungenerated} with no generation in the store`);
      console.log(`  ${report.overridden} rewritten by a reading override`);
      console.log(`  ${report.refused} refused: no Japanese, or latin woven in — see cleanSentence`);
      return 0;
    }

    if (command === "marks") {
      const lines = readFileSync(arg("in"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as AnnotatedLine);
      const declared = declareField(db);
      const report = loadMarks(db, lines, extractSentences(db).clean);
      console.log(`  field declared on ${declared} template(s)`);
      console.log(`  ${report.written} annotation(s) written · ${report.skipped} unchanged`);
      console.log(`  ${report.malformed} malformed (refused by parseAnnotation, not stored)`);
      console.log(`  ${report.unannotated} card(s) left with NO annotation — decision 8`);
      return 0;
    }

    console.error(`unknown command: ${command}`);
    return 2;
  } finally {
    db.close();
  }
}

process.exitCode = await main();
