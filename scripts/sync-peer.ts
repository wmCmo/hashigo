import { writeFileSync } from "node:fs";

import { openDatabase } from "../src/db/index.js";
import { exportSync } from "../src/sync/index.js";

process.stdout.write("");

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const dbPath = arg("db") ?? "build/hashigo.db";
const archiveDeck = arg("archive");
const put = arg("put");
const deviceId = arg("as") ?? "dev-benchpeer";
const out = arg("out");

const db = openDatabase(dbPath, { applySchema: false });

if (archiveDeck !== undefined) {
  const deck = db
    .prepare("SELECT id, name FROM decks WHERE name = ?")
    .get(archiveDeck) as { id: string; name: string } | undefined;
  if (deck === undefined) throw new Error(`no deck named ${archiveDeck}`);
  const at = new Date().toISOString();
  db.prepare("UPDATE decks SET archived = 1, updated_at = ? WHERE id = ?").run(at, deck.id);
  const changed = db
    .prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE deck_id = ?")
    .run(at, deck.id);
  console.log(`archived deck ${deck.name} (${deck.id}) and ${changed.changes} card(s) at ${at}`);
}

const payload = exportSync(db, new Date().toISOString());
const json = JSON.stringify(payload);
console.log(
  `payload: ${payload.cardFlags.length} card flags, ${payload.deckFlags?.length ?? 0} deck flags, ` +
    `${payload.archive.reviews.length} local reviews, ${(json.length / 1024).toFixed(0)} KB`,
);

if (out !== undefined) {
  writeFileSync(out, json, "utf8");
  console.log(`wrote ${out}`);
}

if (put !== undefined) {
  const url = `${put.replace(/\/$/, "")}/sync/${deviceId}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: json,
  });
  console.log(`PUT ${url} -> ${response.status} ${await response.text()}`);
}

db.close();
