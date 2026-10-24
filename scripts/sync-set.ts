/**
 * SET A FIELD VALUE ON EVERY DEVICE — through sync, with a fresh card clock.
 *
 *     npx vite-node scripts/sync-set.ts -- --card <id> --field <id> --value <text> [--card … ] [--apply]
 *     npx vite-node scripts/sync-set.ts -- --card <id> --field <id> --from <deviceId> [--apply]
 *
 * For the case sync cannot settle on its own: two devices hold different values
 * for a card at the SAME clock. That happens to every edit made before e3254c5
 * (2026-10-22), when a field write did not move `cards.updated_at` — the merge
 * keeps the local copy on a tie, so each device keeps its own for ever. First
 * used 2026-10-24 for 憶測's `Reading` (four devices, equal clocks, two answers)
 * and three edits found only on one device by the full-value audit.
 *
 * `--from` copies the value a named device uploaded; `--value` gives it outright.
 * Dry by default. Before sending it merges the freshest device payload and then
 * this one into a scratch copy of `build/hashigo.db`, and refuses unless exactly
 * the named values changed — the payload is hand-built, so that is its test.
 *
 * The slot (`dev-manual-fix`) is CUMULATIVE: earlier entries are kept at the
 * clocks they were sent with, so a device that has not synced since still gets
 * them. A later edit of his carries a newer clock and wins over all of them.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { openDatabase } from "../src/db/index.js";
import { mergeSync, type SyncPayload } from "../src/sync/index.js";

const SLOT = "dev-manual-fix";
const args = process.argv.slice(2);
const apply = args.includes("--apply");

process.loadEnvFile(".env");
const base = (process.env["VITE_MAILBOX_URL"] ?? "").replace(/\/+$/, "");
const headers = { Authorization: `Bearer ${process.env["VITE_MAILBOX_TOKEN"] ?? ""}` };

async function payloadOf(id: string): Promise<SyncPayload | null> {
  const response = await fetch(`${base}/sync/${encodeURIComponent(id)}`, { headers });
  if (!response.ok) return null;
  let bytes = Buffer.from(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return JSON.parse(bytes.toString("utf8")) as SyncPayload;
}

// ── the requested values, in order: --card / --field / (--value | --from) ───
interface Want {
  cardId: string;
  fieldId: string;
  value?: string;
  from?: string;
}
const wants: Want[] = [];
for (let i = 0; i < args.length; i += 1) {
  const flag = args[i];
  const next = args[i + 1] ?? "";
  if (flag === "--card") wants.push({ cardId: next, fieldId: "" });
  else if (flag === "--field") wants.at(-1)!.fieldId = next;
  else if (flag === "--value") wants.at(-1)!.value = next;
  else if (flag === "--from") wants.at(-1)!.from = next;
}
if (wants.length === 0 || wants.some((w) => w.fieldId === "" || (w.value === undefined) === (w.from === undefined))) {
  console.error("each --card needs a --field and exactly one of --value / --from");
  process.exit(2);
}

const peers = (
  (await (await fetch(`${base}/sync/`, { headers })).json()) as { peers: { deviceId: string }[] }
).peers;
let freshest: SyncPayload | null = null;
for (const { deviceId } of peers) {
  if (!/^dev-[0-9a-f]{12}$/.test(deviceId)) continue; // real devices only, not tool slots
  const payload = await payloadOf(deviceId);
  if (payload !== null && (freshest === null || payload.archive.createdAt > freshest.archive.createdAt)) {
    freshest = payload;
  }
}
if (freshest === null) throw new Error("no device payload in the mailbox");

const now = new Date().toISOString();
const values = new Map<string, { cardId: string; fieldId: string; value: string }>();
const clocks = new Map<string, string>();
const previous = await payloadOf(SLOT);
for (const v of previous?.archive.fieldValues ?? []) values.set(`${v.cardId}|${v.fieldId}`, v);
for (const f of previous?.cardFlags ?? []) clocks.set(f.cardId, f.updatedAt);

const sources = new Map<string, SyncPayload>();
for (const want of wants) {
  let value = want.value;
  if (want.from !== undefined) {
    if (!sources.has(want.from)) sources.set(want.from, (await payloadOf(want.from))!);
    value = sources
      .get(want.from)!
      .archive.fieldValues.find((v) => v.cardId === want.cardId && v.fieldId === want.fieldId)?.value;
    if (value === undefined) throw new Error(`${want.from} carries no ${want.cardId}/${want.fieldId}`);
  }
  values.set(`${want.cardId}|${want.fieldId}`, { cardId: want.cardId, fieldId: want.fieldId, value: value! });
  clocks.set(want.cardId, now);
}

const flags = new Map(freshest.cardFlags.map((f) => [f.cardId, f]));
const fieldValues = [...values.values()];
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
  cardFlags: [...clocks.entries()]
    .filter(([cardId]) => flags.has(cardId))
    .map(([cardId, updatedAt]) => ({ ...flags.get(cardId)!, updatedAt })),
  deckFlags: [],
  // `voicesCarried` absent: this payload says nothing about voices.
  retiredClips: [],
};

// ── self-check: merge as a device would, and only the named values may move ─
const dir = mkdtempSync(join(tmpdir(), "sync-set-"));
const file = join(dir, "check.db");
copyFileSync("build/hashigo.db", file);
const db = openDatabase(file, { applySchema: false });
try {
  mergeSync(db, freshest);
  const cards = [...new Set(fieldValues.map((v) => v.cardId))];
  const snapshot = (): Map<string, string> =>
    new Map(
      (
        db
          .prepare(
            `SELECT card_id || '|' || field_id AS k, value FROM card_field_values
              WHERE card_id IN (${cards.map(() => "?").join(",")})`,
          )
          .all(...cards) as { k: string; value: string }[]
      ).map((r) => [r.k, r.value]),
    );
  const before = snapshot();
  mergeSync(db, payload);
  const after = snapshot();
  const named = new Set(values.keys());
  const landed = fieldValues.filter((v) => after.get(`${v.cardId}|${v.fieldId}`) === v.value).length;
  const touched = [...before].filter(([k, v]) => !named.has(k) && after.get(k) !== v);
  for (const want of wants) {
    const k = `${want.cardId}|${want.fieldId}`;
    console.log(`  ${k}: ${JSON.stringify(before.get(k) ?? null)} -> ${JSON.stringify(after.get(k) ?? null)}`);
  }
  console.log(`self-check: ${landed}/${fieldValues.length} landed · ${touched.length} other value(s) changed`);
  if (landed !== fieldValues.length || touched.length > 0) throw new Error("self-check failed — nothing sent");
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (!apply) {
  console.log(`DRY RUN — would send ${fieldValues.length} value(s) from ${SLOT}. Add --apply to send.`);
} else {
  const response = await fetch(`${base}/sync/${SLOT}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(`sent ${fieldValues.length} value(s) from ${SLOT}: ${response.status} ${await response.text()}`);
}
