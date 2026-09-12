/**
 * Stand in for a second device, so stage 11 can be exercised end to end on one
 * machine.
 *
 *     npx vite-node scripts/sync-peer.ts -- --db build/hashigo.db --archive 数字
 *     npx vite-node scripts/sync-peer.ts -- --db build/hashigo.db --put http://127.0.0.1:5274
 *
 * The real second device is a phone, and the whole point of the mailbox is that
 * neither device can read the other's OPFS — so the only way to test the loop
 * without two handsets is to build a payload from a database on disk and drop it
 * in the mailbox. That is exactly what the phone does over the wire.
 *
 * It writes to the MAILBOX, never to a browser's database. Nothing here can
 * damage the app's OPFS copy; the worst it can do is leave a file in build/sync/.
 */
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
  // Exactly what `deckOp` does: the deck AND its cards, together.
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
