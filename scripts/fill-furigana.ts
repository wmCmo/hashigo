/**
 * FILL THE MISSING FURIGANA FROM THE ACCENT PIPELINE — NOT FROM A MODEL.
 *
 * ─── WHY THIS IS A SEPARATE SCRIPT ──────────────────────────────────────────
 *
 * `scripts/fill-generations.ts` fills `ai`, `translate` and `speech`, and
 * deliberately refuses furigana. The reason is decision 8 applied to readings:
 * **a reading is the thing being drilled** on a `Reading = true` card, and
 * *a wrong accent drilled is worse than no accent*. Asking a language model to
 * guess one would be a guess where a measurement already exists.
 *
 * The measurement is this project's own. Of the 340 missing furigana whose input
 * is a real head word, **336 already have a reading in `accents`** — OpenJTalk,
 * cross-checked against UniDic, 33 adjudicated by hand against OJAD, and 57 left
 * disputed on purpose. So this needs no network, no key and no money; it is a
 * join this repo has been able to do since stage 6 and never did.
 *
 * ─── THE STORED FORM IS MOCHI'S BRACKETS, PER KANJI RUN ─────────────────────
 *
 * A furigana generation does NOT hold a reading. It holds the INPUT with a
 * `(reading)` inserted after each kanji run — which is why decision 37's
 * `readingOf()` has to unwrap it. Read off the real corpus:
 *
 *     "[試行"        ->  "[試行(しこう)"
 *     "あり得る"      ->  "あり得(え)る"
 *     "おろし金"      ->  "おろし金(がね)"
 *     "~に越したことはない" -> "~に越(こ)したことはない"
 *     "いたす"        ->  "いたす"            (all kana: unchanged)
 *
 * So the whole reading is never dumped after a mixed base. `あり得る` takes
 * `(え)` on the kanji alone, and getting that wrong would put `あり得る(ありえる)`
 * on 350 cards. **`alignFurigana` already does that split** — it is what
 * `src/render/ruby.ts` was built for, and 31.9% of bases in this corpus mix
 * kanji and kana. This calls it rather than writing a second aligner.
 *
 * ─── THE READING COMES FROM UniDic, AND THAT IS NOT DECISION 8 BEING BENT ──
 *
 * The two analysers disagree about ONE thing here, and it is not the accent:
 *
 *     広義   openjtalk  コーギ     <- PHONETIC. `ー` is a long vowel, not a kana.
 *     広義   unidic     コウギ     <- ORTHOGRAPHIC. What a dictionary prints.
 *
 * Measured across the whole table: **31.2% of OpenJTalk readings contain `ー`
 * against 0.2% of UniDic's.** OpenJTalk's output is a transcription for a
 * synthesiser, and `コーギ` as furigana over 広義 would be wrong on the card —
 * the reading is こうぎ. Recovering it needs the orthography back, and `ー` has
 * genuinely lost it (`コー` can be こう or こお).
 *
 * **Decision 8 says the UniDic cross-check "is stored but never RESOLVES — a
 * candidate for adjudication, never the answer". That is about the ACCENT
 * TYPE**, where a disagreement means a downstep in a different place and a wrong
 * one drilled is worse than none. A reading is a different fact: the two
 * analysers agree on it up to notation, and here UniDic is the one that has not
 * thrown the spelling away. Nothing about an accent is read from it.
 *
 * OpenJTalk is still used when it carries no `ー`, which makes it orthographic
 * too — and **anything still holding a `ー` after both is skipped**, rather than
 * expanded by a rule that would be right most of the time.
 *
 * ─── WHAT IT REFUSES TO WRITE ───────────────────────────────────────────────
 *
 * `alignFurigana` returns one of three kinds, and only two of them are written:
 *
 *   * `segmented` — one reading per kanji run, every kana run matched. WRITTEN.
 *   * `none` — the base already reads itself (all kana). WRITTEN UNCHANGED,
 *     which is exactly what the corpus holds for いたす and おっしゃる. It
 *     annotates nothing and costs nothing, and it clears a pending slot.
 *   * `whole` — the aligner could not place the reading and fell back to one
 *     reading over the whole base. **SKIPPED.** The corpus has no such row for a
 *     mixed base, and writing one would put a coarse annotation on the exact
 *     cards where the reading is the answer. The aligner's own `reason` is
 *     printed so the refusals can be read rather than counted.
 *
 *     npx vite-node scripts/fill-furigana.ts -- --dry
 *     npx vite-node scripts/fill-furigana.ts --
 */
import { generationIdentity, lookupGeneration } from "../src/blobs/generation.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { storeDescriptorText } from "../src/generate/index.js";
import { memoryDocument, renderSides } from "../src/render/index.js";
import { alignFurigana, rubyPlainText, toHiragana } from "../src/render/ruby.js";
import { prepareCard } from "../src/review/index.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined && !process.argv[index + 1]!.startsWith("--")
    ? process.argv[index + 1]!
    : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

interface Gap {
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly cardName: string;
}

/** Every unresolved furigana slot, by identity. */
function sweep(db: Db): Gap[] {
  const cards = db.prepare("SELECT id, name FROM cards WHERE archived = 0").all() as {
    id: string;
    name: string;
  }[];
  const seen = new Set<string>();
  const gaps: Gap[] = [];
  for (const card of cards) {
    const prepared = prepareCard({ db, cardId: card.id, direction: "forward" });
    if (prepared === null) continue;
    const out = renderSides(prepared.sides, { document: memoryDocument() });
    for (const generation of out.generations) {
      const request = generation.request;
      if (request === null || request.kind !== "furigana") continue;
      if (String(request.text).trim() === "") continue;
      const identity = generationIdentity({
        kind: "furigana",
        text: request.text,
        voice: request.voice,
        lang: request.lang,
        options: request.options,
      });
      const key = JSON.stringify(identity);
      if (seen.has(key)) continue;
      seen.add(key);
      if (lookupGeneration(db, identity) !== null) continue;
      gaps.push({
        text: request.text,
        lang: request.lang,
        voice: request.voice,
        options: request.options,
        cardName: card.name,
      });
    }
  }
  return gaps;
}

/**
 * Mochi's stored form for one furigana generation.
 *
 * The join itself is `rubyPlainText` — `巡(めぐ)る`, "the projection a plain-text
 * export wants", which is the same projection Mochi stored. A first draft of
 * this file wrote that loop again; two serialisers for one format is how they
 * come to disagree about a corpus neither can re-derive.
 */
function bracketForm(base: string, reading: string): { text: string; kind: string; reason: string } {
  const alignment = alignFurigana(base, reading);
  if (alignment.kind === "none") return { text: base, kind: "none", reason: "" };
  if (alignment.kind === "whole") return { text: "", kind: "whole", reason: alignment.reason };
  return { text: rubyPlainText(alignment), kind: "segmented", reason: "" };
}

function main(): number {
  const dbFile = arg("db", "build/hashigo.db");
  const db = openDatabase(dbFile, { applySchema: false });
  // UniDic first — it keeps the orthography. See the header.
  const readingOf = db.prepare(
    `SELECT reading FROM accents
      WHERE text = ? AND reading IS NOT NULL AND reading <> ''
      ORDER BY CASE analyser WHEN 'unidic' THEN 0 WHEN 'openjtalk' THEN 1 ELSE 2 END
      LIMIT 1`,
  );
  const anyReading = db.prepare(
    "SELECT reading FROM accents WHERE text = ? AND reading IS NOT NULL AND reading <> ''",
  );

  console.log(`  sweeping ${dbFile} for missing furigana …`);
  const gaps = sweep(db);
  console.log(`\n  ${gaps.length} furigana slots unfilled\n`);

  let written = 0;
  let noReading = 0;
  let phonetic = 0;
  const refused: string[] = [];
  const samples: string[] = [];

  for (const gap of gaps) {
    const word = gap.text.trim();
    let row = readingOf.get(word) as { reading: string } | undefined;
    // A `ー` means the preferred row is still the synthesiser's transcription;
    // try any other analyser before giving up on the word.
    if (row !== undefined && row.reading.includes("ー")) {
      const clean = (anyReading.all(word) as { reading: string }[]).find(
        (candidate) => !candidate.reading.includes("ー"),
      );
      row = clean ?? row;
    }
    if (row === undefined) {
      noReading += 1;
      continue;
    }
    if (row.reading.includes("ー")) {
      // NOT EXPANDED. `コー` is こう far more often than こお, and "far more
      // often" is the shape of answer decision 8 refuses on a reading.
      phonetic += 1;
      continue;
    }
    // FURIGANA IS HIRAGANA in every row this corpus holds — `[試行(しこう)`,
    // `あり得(え)る`. The analysers answer in katakana. `toHiragana` is
    // length-preserving, which is what the aligner depends on.
    const built = bracketForm(gap.text, toHiragana(row.reading));
    if (built.kind === "whole") {
      refused.push(`${gap.text} + ${row.reading}: ${built.reason}`);
      continue;
    }
    if (samples.length < 12) samples.push(`${gap.text.padEnd(12)} ${row.reading.padEnd(14)} -> ${built.text}`);
    if (!flag("dry")) {
      storeDescriptorText(
        db,
        { kind: "furigana", text: gap.text, lang: gap.lang, voice: gap.voice, options: gap.options },
        built.text,
      );
    }
    written += 1;
  }

  console.log("  what it builds:");
  for (const sample of samples) console.log(`    ${sample}`);
  console.log(
    `\n  ${written} ${flag("dry") ? "would be written" : "written"} · ` +
      `${noReading} have no derived reading · ${phonetic} only phonetic (ー) · ` +
      `${refused.length} refused by the aligner`,
  );
  // PRINTED, not counted. A refusal is the aligner declining to guess, and the
  // reasons are the only way to tell "this needs a hand" from "this is a bug".
  for (const reason of refused.slice(0, 20)) console.log(`    ! ${reason}`);
  db.close();
  return 0;
}

process.exitCode = main();
