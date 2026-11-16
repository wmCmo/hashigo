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
  newCard: boolean;
}

const cards: Card[] = [];
for (const id of IDS) {
  const loaded = loadCard(db, id);
  if (!loaded) continue;
  const rendered = renderLoadedCard(loaded, "forward");
  const bound = expandGeneratorFields(rendered.sides, {
    fields: loaded.template?.fields ?? [], values: loaded.values,
    resolveGenerated: storeTextResolver(db),
  });
  const out = renderSides(bound.sides, { document: memoryDocument() });

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
