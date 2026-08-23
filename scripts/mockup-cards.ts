/**
 * Stage-7 mockups, step 1 of 2: real cards out of the real database.
 *
 *   npx vite-node scripts/mockup-cards.ts     # -> build/mock/out/cards.json
 *   npx vite-node scripts/mockup-html.ts      # -> build/mock/out/*.html
 *
 * Then `npm run spike:dev -- --host ::` and open `/mock/`. This is the evidence
 * behind DECISION 23 (the review screen is direction A2), so it lives in `scripts/`
 * rather than in `build/`: the OUTPUT is disposable, the ability to regenerate it is
 * not. `build/` is gitignored, so a generator left there would vanish on clone and
 * decision 23 would cite a path nobody could rebuild.
 *
 * Everything on screen is real: sides from `src/render`, audio bytes out of the
 * 617.9 MiB store, accents from the `accents` table. Where a generator is still
 * pending in the corpus (furigana, ai) it is shown as a labelled chip rather than
 * faked, so nothing here reads as working that does not.
 *
 * THE HARD RULE IS HONOURED: no audio element gets a `src` until reveal, and
 * `play()` is reachable only from the reveal handler. Nothing plays on side entry.
 */
import { writeFileSync, mkdirSync } from "node:fs";

import { cardAudioResolver, loadCard, renderLoadedCard } from "../src/cards/index.js";
import { defaultStoreDatabase, openBlobStoreDatabase } from "../src/blobs/index.js";
import { openDatabase } from "../src/db/index.js";
import { expandGeneratorFields, storeTextResolver } from "../src/generate/index.js";
import { memoryDocument, renderSides, serialise } from "../src/render/index.js";

const DB = "build/hashigo.db";
const IDS = ["0CelS3QS", "055y76cd", "01HxiZut", "09d0Wez6"];

const db = openDatabase(DB, { readOnly: true, applySchema: false });
const opened = openBlobStoreDatabase(defaultStoreDatabase(DB), { mustExist: true });

interface Card {
  id: string; head: string; deck: string;
  sides: { index: number; empty: boolean; html: string }[];
  audio: string | null; audioKiB: number;
  accentType: string | null; accentPos: number | null; reading: string | null;
  pending: string[];
  /**
   * Decision 25's `New Card` label. DEMONSTRATIVE here: this mockup picks its four
   * cards for accent variety rather than from a real session, so there is no real
   * `origin` to read. Set on one card to show both states of the label. In the
   * app it is `SessionItem.origin === "new"`, which is per TRACK.
   */
  newCard: boolean;
}

const cards: Card[] = [];
for (const id of IDS) {
  const loaded = loadCard(db, id);
  if (!loaded) continue;
  const rendered = renderLoadedCard(loaded, "forward");
  // `resolveGenerated` is REQUIRED for Audio/Translate to exist at all — they
  // chain off 例文, an `ai` field with no stored value. Without it the mockups
  // rendered <<Translate>> and <<Audio>> as amber missing-field chips, and
  // decision 23 was approved with those chips on the card. See src/review/README.
  const bound = expandGeneratorFields(rendered.sides, {
    fields: loaded.template?.fields ?? [], values: loaded.values,
    resolveGenerated: storeTextResolver(db),
  });
  const out = renderSides(bound.sides, { document: memoryDocument() });

  // Reveal every cloze BEFORE serialising: the mockup drives reveal in CSS, and
  // `hidden=""` on the answer would otherwise win over any stylesheet.
  out.revealAll();

  const resolve = cardAudioResolver(db, id, { store: opened.store });
  const speech = out.generations.find((g) => g.name === "speech" && g.request !== null);
  let audio: string | null = null;
  let audioKiB = 0;
  if (speech) {
    const payload = resolve({ origin: "generator", request: speech.request! });
    if (payload) {
      audio = `data:${payload.mime};base64,${Buffer.from(payload.bytes).toString("base64")}`;
      audioKiB = Math.round(payload.bytes.length / 1024);
    }
  }
  const acc = db.prepare(
    `SELECT accent_type, reading, type FROM accents WHERE text = ? AND analyser = 'openjtalk' LIMIT 1`,
  ).get(loaded.name) as { accent_type: number; reading: string; type: string } | undefined;

  cards.push({
    // Demonstrative only — see the `newCard` doc comment above.
    newCard: cards.length === 3,
    id, head: loaded.name, deck: loaded.deckPath,
    sides: out.sides.map((s) => ({ index: s.index, empty: s.empty, html: serialise(s.element as never) })),
    audio, audioKiB,
    accentType: acc?.type ?? null, accentPos: acc?.accent_type ?? null, reading: acc?.reading ?? null,
    pending: [...new Set(out.generations.filter((g) => g.name !== "speech").map((g) => g.name))],
  });
}
db.close();

console.log(`built ${cards.length} cards; audio ${cards.map((c) => c.audioKiB + "KiB").join(" ")}`);
mkdirSync("build/mock/out", { recursive: true });
writeFileSync("build/mock/out/cards.json", JSON.stringify(cards, null, 1), "utf-8");
