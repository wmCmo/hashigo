/**
 * PUT THE GENERATED TEXT INTO THE SEARCH INDEX.
 *
 * Zach, 2026-09-24: *"do you think if i search for 貫く at least 厳格 should come
 * up? because the example sentence contains the word"* — and then, when told it
 * could not: *"because in notion, searching for 貫く with 貫いている would have
 * worked, same with mochi or obsidian"*.
 *
 * ─── WHAT WAS MISSING ───────────────────────────────────────────────────────
 *
 * `cards.search_text` is built from `cards.content` plus the STORED field values
 * (`writeSearchText` in `src/import/index.ts`). A card's example sentence is not
 * stored: it is an `ai` generation, addressed by generation identity and living
 * in `blobs.bytes`. So the richest text on the card was never in the index.
 *
 * 厳格's entire indexed body was `厳格 / true / 厳格 / strict; severe; stern;
 * rigid; rigorous; tough` — while the card on screen reads *彼は仕事において非常
 * に厳格な態度を貫いている。*
 *
 * Measured 2026-09-24, on the real corpus:
 *
 *     ai            17,228 generations   1,168 KiB   none of it indexed
 *     translate      7,880 generations     401 KiB   none of it indexed
 *     cards that would gain text                      6,830 of 7,716
 *     mean search_text length                         75 characters
 *
 * Of 176 sampled cards whose example sentence was generated, the sentence was in
 * `search_text` on **2** of them.
 *
 * ─── WHY A REBUILD IS SAFE HERE, WHICH IS NOT OBVIOUS AFTER DECISION 41 ─────
 *
 * This rewrites a column on every card, and decision 41 made "touches every row"
 * a phrase worth stopping at. It is safe for one specific reason: `search_text`
 * is **derived and never authored** — the schema says so and
 * `src/schema/index.ts` repeats it. Recomputing it cannot lose anything a human
 * wrote, no review history is involved, and running this twice is a no-op. It is
 * not a schema change and needs no migration.
 *
 * What it DOES cost is the FTS index: `search_text` is in the `cards_fts_au`
 * trigger's `UPDATE OF` list, so every changed row rebuilds its FTS entry. That
 * is why the write is guarded by `IS NOT` — an unchanged card writes no page.
 *
 * ─── FURIGANA IS DELIBERATELY NOT INDEXED ───────────────────────────────────
 *
 * `ai` and `translate` carry prose. A `furigana` generation holds the INPUT with
 * Mochi's brackets still in it rather than a clean reading — decision 37 (b),
 * which is why `readingOf()` exists to unwrap it. Indexing that would put
 * bracket noise in the body for no gain; indexing READINGS properly is a
 * separate feature (search by reading) and a separate decision.
 *
 * ─── IT IS FIXED ON REBUILD, LIKE THE BLOBS ─────────────────────────────────
 *
 * A generation filled on demand later is not searchable until this runs again. A
 * generation is keyed by its own text and is NOT owned by a card — two cards with
 * the same prompt share one — so a fill has no card to update. That is the same
 * bargain Zach already accepted for blob delivery (*"Leave it — fixed on rebuild
 * only"*), and it is stated here rather than discovered.
 *
 *   npx vite-node scripts/search-text-rebuild.ts                 # what would change
 *   npx vite-node scripts/search-text-rebuild.ts -- --apply
 */
import { resolve } from "node:path";

import { openDatabase } from "../src/db/index.js";
import { buildSearchText } from "../src/schema/index.js";
import {
  fieldGenerationRequest,
  resolveDescriptorText,
  type FieldContext,
  type GeneratorField,
} from "../src/generate/index.js";

process.stdout.setDefaultEncoding("utf8");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dbAt = args.indexOf("--db");
const CARD_DB = resolve(dbAt === -1 ? "build/hashigo.db" : (args[dbAt + 1] as string));

/** Prose kinds only. See the header for why `furigana` is out. */
const INDEXED_KINDS = new Set(["ai", "translate"]);

const db = openDatabase(CARD_DB, { applySchema: false });

const cards = db
  .prepare(`SELECT id, content, template_id, search_text FROM cards ORDER BY id`)
  .all() as { id: string; content: string | null; template_id: string | null; search_text: string | null }[];

const fieldsByTemplate = new Map<string, GeneratorField[]>();
for (const row of db
  .prepare(`SELECT id, template_id, name, type, source_field_id, options, pos FROM template_fields ORDER BY pos`)
  .all() as {
  id: string;
  template_id: string;
  name: string;
  type: string;
  source_field_id: string | null;
  options: string | null;
}[]) {
  const list = fieldsByTemplate.get(row.template_id) ?? [];
  list.push({
    id: row.id,
    name: row.name,
    type: row.type,
    // The source pointer is what lets a `speech` or `translate` field find the
    // field it reads FROM. Dropping it made those requests unbuildable.
    sourceFieldId: row.source_field_id,
    options: row.options === null || row.options === "" ? {} : (JSON.parse(row.options) as Record<string, string>),
  } as GeneratorField);
  fieldsByTemplate.set(row.template_id, list);
}

/**
 * NON-LOCAL FIELDS ONLY, and this is the second thing the rebuild had to decide.
 *
 * `template_fields.local = 1` is decision 9's marker for a field this project
 * ADDED — and the derived accent annotations are exactly that: `型` on **7,660**
 * cards and `OJAD` on 7,438. Indexing them would put the literal string `平板` on
 * 7,660 cards and a mora-marked reading (`にんじんを|き*って|さ*らだに|いれま*し_た`)
 * on 7,438, so a search for `平板` would return a third of the collection and the
 * `*` / `|` marks would be indexed as content. They are derived annotations, not
 * things he wrote.
 *
 * It costs `読み` (24 cards) and `かな主流` (12), which are also `local = 1`. That
 * is accepted: a `読み` is a reading that the head word and the furigana already
 * carry, so no card becomes unfindable.
 *
 * ORDERED BY `pos`, so the concatenation is stable run to run — the write is
 * guarded by `IS NOT` and an unstable order would rewrite every FTS row each time.
 */
const valuesStmt = db.prepare(
  `SELECT v.field_id AS field_id, v.value AS value
     FROM card_field_values v
     JOIN template_fields tf ON tf.id = v.field_id
    WHERE v.card_id = ? AND tf.local = 0
    ORDER BY tf.pos, v.field_id`,
);
const update = db.prepare(`UPDATE cards SET search_text = ? WHERE id = ? AND search_text IS NOT ?`);

let changed = 0;
let gained = 0;
let generationsFound = 0;
const samples: string[] = [];

const work = db.transaction(() => {
  for (const card of cards) {
    const fields = card.template_id === null ? [] : (fieldsByTemplate.get(card.template_id) ?? []);
    const values = new Map<string, string>();
    for (const v of valuesStmt.all(card.id) as { field_id: string; value: string }[]) {
      values.set(v.field_id, v.value);
    }

    // `resolveGenerated` lets a CHAINED generator resolve — 単語's `Audio` reads
    // the sentence `例文` produced, on 3,467 cards. Without it those requests are
    // unbuildable and the chain's text is silently missing.
    const context: FieldContext = {
      fields,
      values,
      resolveGenerated: (request) => resolveDescriptorText(db, request),
    };

    const generated: string[] = [];
    for (const field of fields) {
      const request = fieldGenerationRequest(field, context);
      if (request === null || !INDEXED_KINDS.has(request.kind)) continue;
      const text = resolveDescriptorText(db, request);
      if (text === null || text.trim() === "") continue;
      generationsFound += 1;
      generated.push(text);
    }

    const next = buildSearchText(card.content, ...values.values(), ...generated);
    if (next === (card.search_text ?? "")) continue;
    changed += 1;
    if (generated.length > 0 && (card.search_text ?? "").length < next.length) {
      gained += 1;
      if (samples.length < 5) {
        samples.push(`  ${card.id}: +${next.length - (card.search_text ?? "").length} chars — ${generated[0]?.slice(0, 54)}`);
      }
    }
    if (APPLY) update.run(next, card.id, next);
  }
});

work();

console.log(`${CARD_DB}`);
console.log(`cards                       ${cards.length}`);
console.log(`generations resolved        ${generationsFound}`);
console.log(`search_text would change    ${changed}`);
console.log(`  of those, GAINED text     ${gained}`);
for (const s of samples) console.log(s);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
} else {
  console.log("\nwritten. The FTS index rebuilt for each changed row (the cards_fts_au trigger).");
  const check = db.prepare(`SELECT count(*) AS n FROM card_search_index WHERE search_text_populated = 0`).get() as {
    n: number;
  };
  console.log(`cards with an unmaintained index: ${check.n} (must be 0)`);
}

db.close();
