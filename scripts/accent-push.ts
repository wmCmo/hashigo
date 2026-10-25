/**
 * SEND ADJUDICATED `型` LABELS TO THE DEVICES — after an entry is added to
 * `src/accent/ojad.ts`.
 *
 *     npx vite-node scripts/accent-push.ts             # what it would send
 *     npx vite-node scripts/accent-push.ts -- --apply  # send it
 *
 * `accent/cli.ts ojad` + `write` fix `build/hashigo.db`, which no device reads:
 * since decision 41 each device's OPFS is the system of record, and a label only
 * reaches it through decision 33's mailbox. Zach, 2026-10-25, after 15 labels were
 * settled from jpdb.io.
 *
 * Same shape as `scripts/ojad-fill.ts`, for the same reasons:
 *
 *   1. Take what the devices hold: the seed (`build/app/hashigo-app.db`) with
 *      the freshest device payload merged in. That is the baseline, and the
 *      self-check's starting point.
 *   2. Apply every adjudication and re-materialise `型` there. Only cards whose
 *      WORD has an adjudication (or whose id has a card adjudication) are kept —
 *      a label he edited by hand on any other card is never sent back over.
 *   3. Send ONLY those `型` values from a slot of its own (`dev-accent-push`),
 *      each card's clock moved to now and its flags copied from the freshest
 *      payload. Values merge by their card's clock (e3254c5), so these win, and
 *      no other field of those cards is in the payload.
 *
 * The slot is CUMULATIVE, as `dev-ojad-fill` is: a later run keeps what earlier
 * runs sent. A self-check merges the payload into a fresh copy and refuses to send
 * unless every value lands and nothing else on those cards moved.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  applyOjadAdjudications,
  CARD_ADJUDICATIONS,
  cardAccentOverrides,
  DICTIONARY_ADJUDICATIONS,
  materialiseAccents,
  OJAD_ADJUDICATIONS,
} from "../src/accent/index.js";
import { openDatabase } from "../src/db/index.js";
import { mergeSync, type SyncPayload } from "../src/sync/index.js";

const SLOT = "dev-accent-push";
const FIELD = "型";
const SEED = "build/app/hashigo-app.db";
const apply = process.argv.includes("--apply");

if (existsSync(".env")) process.loadEnvFile(".env");
const base = (process.env["VITE_MAILBOX_URL"] ?? "").replace(/\/+$/, "");
const token = process.env["VITE_MAILBOX_TOKEN"] ?? "";
if (base === "" || token === "") {
  console.error("VITE_MAILBOX_URL and VITE_MAILBOX_TOKEN must be in .env");
  process.exit(2);
}
const headers = { Authorization: `Bearer ${token}` };

async function payloadOf(id: string): Promise<SyncPayload | null> {
  const response = await fetch(`${base}/sync/${encodeURIComponent(id)}`, { headers });
  if (!response.ok) return null;
  let bytes = Buffer.from(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return JSON.parse(bytes.toString("utf8")) as SyncPayload;
}

const listing = (await (await fetch(`${base}/sync/`, { headers })).json()) as { peers: { deviceId: string }[] };
let freshest: SyncPayload | null = null;
for (const { deviceId } of listing.peers) {
  if (deviceId.startsWith("dev-ojad") || deviceId === SLOT) continue;
  const payload = await payloadOf(deviceId);
  if (payload !== null && (freshest === null || payload.archive.createdAt > freshest.archive.createdAt)) freshest = payload;
}
if (freshest === null) throw new Error("no device payload in the mailbox");
console.log(`freshest payload: ${freshest.archive.createdAt}`);

const scratchDir = mkdtempSync(join(tmpdir(), "accent-push-"));
const scratch = join(scratchDir, "hashigo.db");
copyFileSync("build/hashigo.db", scratch);
const db = openDatabase(scratch, { applySchema: false });

const LABELS = `SELECT v.card_id AS cardId, v.field_id AS fieldId, v.value AS value, c.name AS name
                  FROM card_field_values v
                  JOIN cards c ON c.id = v.card_id
                  JOIN template_fields f ON f.id = v.field_id AND f.template_id = c.template_id
                 WHERE f.name = ?`;
type Label = { cardId: string; fieldId: string; value: string; name: string };

try {
  // ── 1-2. the devices' view, then the adjudications over it ───────────────
  // What a device shows is the SEED it booted from plus every payload since — not
  // `build/hashigo.db`, which `accent/cli.ts write` may already have corrected.
  const seedCopy = join(scratchDir, "seed.db");
  copyFileSync(SEED, seedCopy);
  const seed = openDatabase(seedCopy, { applySchema: false });
  let before: Map<string, Label>;
  try {
    mergeSync(seed, freshest);
    before = new Map((seed.prepare(LABELS).all(FIELD) as Label[]).map((l) => [`${l.cardId}|${l.fieldId}`, l]));
  } finally {
    seed.close();
  }
  mergeSync(db, freshest);
  applyOjadAdjudications(db);
  materialiseAccents(db, { cardOverrides: cardAccentOverrides() });
  const words = new Set([...OJAD_ADJUDICATIONS, ...DICTIONARY_ADJUDICATIONS].map((a) => a.word));
  const cardIds = new Set(CARD_ADJUDICATIONS.map((a) => a.cardId));
  const changed = (db.prepare(LABELS).all(FIELD) as Label[]).filter((l) => {
    const old = before.get(`${l.cardId}|${l.fieldId}`);
    return (old === undefined || old.value !== l.value) && (words.has(l.name) || cardIds.has(l.cardId));
  });
  for (const l of changed) console.log(`  ${l.name}: ${before.get(`${l.cardId}|${l.fieldId}`)?.value ?? "(none)"} → ${l.value}`);
  console.log(`${changed.length} label(s) differ from what the devices hold`);

  // ── 3. the payload: only 型 values, with a moved clock ───────────────────
  const now = new Date().toISOString();
  const previous = await payloadOf(SLOT);
  const flags = new Map(freshest.cardFlags.map((f) => [f.cardId, f]));
  const values = new Map<string, { cardId: string; fieldId: string; value: string }>();
  const clocks = new Map<string, string>();
  for (const v of previous?.archive.fieldValues ?? []) values.set(`${v.cardId}|${v.fieldId}`, v);
  for (const f of previous?.cardFlags ?? []) clocks.set(f.cardId, f.updatedAt);
  for (const l of changed) {
    values.set(`${l.cardId}|${l.fieldId}`, { cardId: l.cardId, fieldId: l.fieldId, value: l.value });
    clocks.set(l.cardId, now);
  }
  const fieldValues = [...values.values()];
  const cardFlags = [...clocks.entries()]
    .filter(([cardId]) => flags.has(cardId))
    .map(([cardId, updatedAt]) => ({ ...flags.get(cardId)!, updatedAt }));
  const payload: SyncPayload = {
    syncVersion: freshest.syncVersion,
    archive: {
      archiveVersion: freshest.archive.archiveVersion,
      schemaVersion: freshest.archive.schemaVersion,
      createdAt: now,
      reviews: [],
      trackState: [],
      localFields: [],
      localCards: [],
      templates: [],
      fieldValues,
      settings: [],
      cardState: [],
      counts: {
        reviews: 0,
        trackState: 0,
        localFields: 0,
        localCards: 0,
        templates: 0,
        fieldValues: fieldValues.length,
        settings: 0,
        cardState: 0,
      },
    },
    cardFlags,
    deckFlags: [],
    // `voicesCarried` left out: absent means this payload says nothing about voices.
    retiredClips: [],
  };

  // ── SELF-CHECK, as a device would merge it ───────────────────────────────
  const checkFile = join(scratchDir, "check.db");
  copyFileSync(SEED, checkFile);
  const check = openDatabase(checkFile, { applySchema: false });
  try {
    mergeSync(check, freshest);
    const ids = [...new Set(fieldValues.map((v) => v.cardId))];
    const snapshot = (): Map<string, string> =>
      new Map(
        (
          check
            .prepare(
              `SELECT card_id || '|' || field_id AS k, value FROM card_field_values
                WHERE card_id IN (${ids.map(() => "?").join(",") || "''"})`,
            )
            .all(...ids) as { k: string; value: string }[]
        ).map((r) => [r.k, r.value]),
      );
    const prior = snapshot();
    mergeSync(check, payload);
    const after = snapshot();
    const landed = fieldValues.filter((v) => after.get(`${v.cardId}|${v.fieldId}`) === v.value).length;
    const sent = new Set(fieldValues.map((v) => `${v.cardId}|${v.fieldId}`));
    const touched = [...prior].filter(([k, value]) => !sent.has(k) && after.get(k) !== value);
    console.log(`self-check: ${landed}/${fieldValues.length} landed · ${touched.length} other value(s) changed`);
    if (landed !== fieldValues.length || touched.length > 0) throw new Error("self-check failed — nothing sent");
  } finally {
    check.close();
  }

  if (!apply) {
    console.log(`DRY RUN — would send ${fieldValues.length} value(s) from ${SLOT}. Add --apply to send.`);
  } else if (changed.length === 0) {
    console.log("nothing new to send");
  } else {
    const response = await fetch(`${base}/sync/${SLOT}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log(`sent ${fieldValues.length} value(s) from ${SLOT}: ${response.status} ${await response.text()}`);
  }
} finally {
  db.close();
  rmSync(scratchDir, { recursive: true, force: true });
}
