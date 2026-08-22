/**
 * A4 — parse the parenthesis workaround into a `読み` reading and a `かな主流`
 * flag.  READ-ONLY: this writes nothing.  It prints the before/after rows for
 * approval, because CLAUDE.md decision 10 settled the RULE and not the rows.
 *
 * The rule is decidable from script alone (decision 10):
 *
 *   kanji outside, kana inside   -> the parenthesis holds a READING     -> 読み
 *   kana outside, kanji inside   -> the parenthesis holds the KANJI     -> かな主流
 *   Latin inside                 -> the parenthesis holds a GLOSS       -> 意味
 *
 * Note the two are MIRRORS, and applying one to the other's cards is the exact
 * failure the workaround was hiding: putting a reading inside a head word is
 * what breaks TTS, and the brackets get spoken.
 *
 *   npx vite-node scripts/reading-parse.ts -- --db build/hashigo.db
 */
import { openDatabase } from "../src/db/index.js";

const KANJI = /[一-鿿㐀-䶿]/;
const KANA = /[ぁ-ゖァ-ヺー々]/;
const LATIN = /[A-Za-z]/;
// Both widths of both brackets, and a full-width space is a real separator here
// (`日向　(ひなた)`), so the outside is whatever is left after the match.
const PAREN = /[（(]([^）)]*)[）)]/;

type Verdict = "読み" | "かな主流" | "意味" | "?";

/**
 * THE ONE OVERRIDE, RATIFIED BY ZACH 2026-08-22.
 *
 * The rule below reads script POSITION, which is decidable and is what he
 * ratified.  It puts `（おす）雄` in 読み (kanji outside) while its twin
 * `めす（雌）` lands in かな主流 (kana outside) -- one pair, "male (animal,
 * plant)" and "female (animal, plant)", authored together and split only by
 * which side the bracket landed on.  Asked, he ruled おす kana-primary like its
 * twin.
 *
 * It is an OVERRIDE and not a rule change, deliberately: the rule stays
 * decidable for every other row, and this card is listed by id so it can never
 * silently generalise.  The head word (`雄`) and the reading (`おす`) come out
 * identical either way -- only the かな label differs.
 */
const OVERRIDES: ReadonlyMap<string, Verdict> = new Map([["Ufs9lMJR", "かな主流"]]);

function classify(inside: string, outside: string): Verdict {
  if (LATIN.test(inside)) return "意味";
  const insideKanji = KANJI.test(inside);
  const outsideKanji = KANJI.test(outside);
  if (outsideKanji && !insideKanji && KANA.test(inside)) return "読み";
  if (insideKanji && !outsideKanji) return "かな主流";
  return "?";
}

const dbIndex = process.argv.indexOf("--db");
const path = dbIndex >= 0 ? process.argv[dbIndex + 1] : "build/hashigo.db";
if (!path) throw new Error("--db is required");
const db = openDatabase(path, { readOnly: true });

const rows = db
  .prepare<
    [],
    { card_id: string; value: string; template: string }
  >(
    `SELECT v.card_id, v.value, t.name AS template
       FROM card_field_values v
       JOIN cards c ON c.id = v.card_id
       JOIN templates t ON t.id = c.template_id
      WHERE v.field_id = 'name'
        AND t.name IN ('単語', '言葉')
      ORDER BY t.name, v.card_id`,
  )
  .all();

const hits = rows.filter((r) => PAREN.test(r.value));

const out: string[] = [];
out.push(`basis: card_field_values.value for field_id = 'name' on 単語 and 言葉`);
out.push(`scanned ${rows.length} head words · ${hits.length} carry a parenthesis`);
out.push("");
out.push("| # | card | template | before | verdict | 単語/言葉 after | 読み | かな主流 |");
out.push("|--:|---|---|---|---|---|---|---|");

const tally = new Map<Verdict, number>();
hits.forEach((r, i) => {
  const m = PAREN.exec(r.value);
  const inside = (m?.[1] ?? "").trim();
  const outside = r.value.replace(PAREN, "").trim();
  const ruled = classify(inside, outside);
  const override = OVERRIDES.get(r.card_id);
  const verdict = override ?? ruled;
  tally.set(verdict, (tally.get(verdict) ?? 0) + 1);

  // The head word after the fix, per verdict:
  //   読み      -> the kanji is the head word; the kana moves to 読み
  //   かな主流  -> same, plus the かな flag; what changes is the LABEL, not the split
  //   意味      -> the word alone; the gloss belongs in 意味, not here
  //
  // KEY THIS ON SCRIPT, NOT ON BRACKET POSITION.  Doing it by position ("inside
  // is the kanji for かな主流") is wrong the moment a row is overridden: the
  // override exists precisely because `（おす）雄` puts the bracket on the other
  // side, and position-keying emitted head=おす, 読み=雄 -- backwards, and it
  // would have written a kana head word with a kanji reading.  Script is what
  // actually distinguishes the two, so ask that.
  const kanjiSide = KANJI.test(inside) ? inside : outside;
  const kanaSide = KANJI.test(inside) ? outside : inside;
  const head = verdict === "意味" ? outside : kanjiSide;
  const yomi = verdict === "意味" ? "" : kanaSide;
  const flag = verdict === "かな主流" ? "true" : "";
  out.push(
    `| ${i + 1} | \`${r.card_id}\` | ${r.template} | \`${r.value}\` | ` +
      `${verdict}${override ? ` (override, rule said ${ruled})` : ""} | ` +
      `\`${head}\` | ${yomi ? `\`${yomi}\`` : "—"} | ${flag || "—"} |`,
  );
});

// The override above is applied and labelled in the table, so a reader can see
// both what the rule said and what Zach ruled.  Nothing else needs a second look:
// the remaining 12 rows are decided by script position alone.
if (OVERRIDES.size > 0) {
  out.push("");
  out.push(`${OVERRIDES.size} ratified override(s) applied — see the note in this file.`);
}

out.push("");
for (const v of ["読み", "かな主流", "意味", "?"] as const) {
  out.push(`${v.padEnd(8)} ${tally.get(v) ?? 0}`);
}
const unclassified = tally.get("?") ?? 0;
out.push("");
out.push(
  unclassified === 0
    ? `ZERO unclassified — the rule decides every row from script alone, plus ${OVERRIDES.size} ratified override(s).`
    : `${unclassified} UNCLASSIFIED — the rule does not decide these. Do not write.`,
);
out.push("NOTHING WAS WRITTEN. This script is read-only by construction.");

process.stdout.write(out.join("\n") + "\n");
db.close();
