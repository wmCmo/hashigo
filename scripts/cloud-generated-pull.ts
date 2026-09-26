/**
 * FILE WHAT THE CLOUD GENERATED INTO THE LAPTOP DATABASE.
 *
 *     npx vite-node scripts/cloud-generated-pull.ts            # what it would file
 *     npx vite-node scripts/cloud-generated-pull.ts -- --apply # file it
 *
 * Since 2026-09-26 "generate audio" and "generate" on his devices go to the
 * Cloudflare Worker (`cloud/mailbox/src/generate.ts`), not the laptop. The laptop
 * endpoint wrote every generation straight into `build/hashigo.db`, which
 * decision 41 made the system of record and which every seed rebuild reads — so
 * a clip made on the phone survived the next rebuild. The Worker cannot reach
 * that file, so it keeps each generation in KV under `gen:<key>`, and this puts
 * them where the laptop version would have.
 *
 * Run it before `app-bootstrap` rebuilds the seed, or a clip made since the
 * last pull exists only on the device that asked for it and in KV.
 *
 * IDEMPOTENT: both writers are content-addressed (`storeGeneratedSpeech`,
 * `storeDescriptorText`) and `INSERT … DO NOTHING`, so a second run files
 * nothing new and says so. It deletes nothing from KV — the Worker also answers
 * repeat presses from there, and a cache is worth more than the few KB it costs.
 *
 * Reads `VITE_MAILBOX_URL` and `VITE_MAILBOX_TOKEN` from `.env` — the same two
 * lines the app is built with.
 */
import { existsSync } from "node:fs";

import { defaultStoreDatabase, openBlobStoreDatabase } from "../src/blobs/index.js";
import { openDatabase } from "../src/db/index.js";
import { storeDescriptorText, storeGeneratedSpeech } from "../src/generate/index.js";
import { retireBlob } from "../src/blobs/retire.js";
import type { BlobKind } from "../src/schema/index.js";

interface GeneratedRecord {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly audio?: string;
  readonly output?: string;
  /** A redo: the clip this one supersedes (`src/blobs/retire.ts`). */
  readonly replaces?: string;
}

const apply = process.argv.includes("--apply");
const dbIndex = process.argv.indexOf("--db");
const dbPath = dbIndex >= 0 ? (process.argv[dbIndex + 1] as string) : "build/hashigo.db";

if (existsSync(".env")) process.loadEnvFile(".env");
const base = (process.env["VITE_MAILBOX_URL"] ?? "").replace(/\/+$/, "");
const token = process.env["VITE_MAILBOX_TOKEN"] ?? "";
if (base === "" || token === "") {
  console.error("VITE_MAILBOX_URL and VITE_MAILBOX_TOKEN must be in .env");
  process.exit(2);
}
const headers = { Authorization: `Bearer ${token}` };

const listing = (await (await fetch(`${base}/generated/`, { headers })).json()) as { keys: string[] };
console.log(`${listing.keys.length} generation(s) in the cloud`);

const db = openDatabase(dbPath, { readOnly: !apply, applySchema: false });
const opened = apply ? openBlobStoreDatabase(defaultStoreDatabase(dbPath), { mustExist: true, create: false }) : null;
let filedSpeech = 0;
let filedText = 0;
let already = 0;
let retired = 0;
let gone = 0;
try {
  for (const key of listing.keys) {
    const response = await fetch(`${base}/generated/${encodeURIComponent(key)}`, { headers });
    if (response.status === 404) {
      // KV's listing lags a delete by up to a minute.
      gone += 1;
      continue;
    }
    const record = (await response.json()) as GeneratedRecord;
    const label = `${record.kind.padEnd(9)} ${record.text.replace(/\s+/g, " ").slice(0, 50)}`;
    if (record.kind === "speech" && record.audio !== undefined) {
      const bytes = Uint8Array.from(Buffer.from(record.audio, "base64"));
      if (!apply || opened === null) {
        console.log(`  would file  ${label}  (${record.voice}, ${bytes.length} bytes)`);
        continue;
      }
      // A REDO retires the clip it replaces first, the same rule the device
      // applied — or the laptop database keeps serving the misread clip into
      // every seed rebuild.
      if (record.replaces !== undefined && retireBlob(db, record.replaces)) retired += 1;
      const before = db.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number };
      storeGeneratedSpeech(
        db,
        opened.store,
        { text: record.text, lang: record.lang, voice: record.voice, options: record.options },
        bytes,
      );
      const after = db.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number };
      if (after.n > before.n) filedSpeech += 1;
      else already += 1;
      continue;
    }
    if (record.output !== undefined) {
      if (!apply) {
        console.log(`  would file  ${label}  → ${record.output.slice(0, 30)}`);
        continue;
      }
      const before = db.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number };
      storeDescriptorText(
        db,
        { kind: record.kind, text: record.text, lang: record.lang, voice: record.voice, options: record.options },
        record.output,
      );
      const after = db.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number };
      if (after.n > before.n) filedText += 1;
      else already += 1;
    }
  }
} finally {
  opened?.close();
  db.close();
}

if (apply) {
  console.log(
    `filed ${filedSpeech} clip(s) and ${filedText} text(s) · ${retired} replaced clip(s) retired · ` +
      `${already} already here · ${gone} gone`,
  );
} else {
  console.log("nothing written — pass --apply");
}
