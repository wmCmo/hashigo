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

    if (command === "sentences") {
      const report = extractSentences(db);
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
