/**
 * REDO CLIPS THE WORKER MADE WRONG, AND RETIRE THE OLD ONES ON EVERY DEVICE.
 *
 * Zach, 2026-11-13. 数隻's word clip said かずせき — the automatic fill sent the
 * voice plain text, never the reading or the accent (decision 67) — and a Whisper
 * audit of the 191 cloud-made sentence clips found three misreads he confirmed by
 * ear: *"only 1, 2, 6 are wrong"* — 港 (こう for みなと), 日向 (ひゅうが for ひなた),
 * 何乗 (なんのり for なんじょう).
 *
 *     npx vite-node scripts/clip-redo.ts                          # dry: lists, makes nothing
 *     npx vite-node scripts/clip-redo.ts -- --words --apply       # every cloud word clip, from 読み + 型
 *     npx vite-node scripts/clip-redo.ts -- --sentences scripts/clip-redo-sentences.json --apply
 *
 * ─── HOW A REDO REACHES EVERY DEVICE ────────────────────────────────────────
 *
 * The in-app redo's own path, done in bulk:
 *   1. the Worker makes the clip again under the SAME key (`force`), with how to
 *      say it (`pronounce` for a word, `readings` for a sentence) and `replaces`
 *      the old clip's hash — overwriting what it serves;
 *   2. one small payload from this script's own slot carries ONLY the old hashes
 *      in `retiredClips`, which every merge takes as a union (`src/blobs/retire.ts`);
 *   3. each device retires the old clip, finds the gap, and its auto-fill fetches
 *      the new one from the Worker's cache — nothing synthesised twice.
 * A clip Google gives back byte-identical is NOT retired (the in-app redo's
 * `same` rule): retiring it would leave the card mute.
 *
 * ─── WHAT IT TOUCHES ────────────────────────────────────────────────────────
 *
 * Only clips the Worker made (the cloud store), never the imported corpus, and
 * for words only the head word's clip on a card with 型 that `wordPronunciation`
 * can say — a word still waiting for its 読み is listed and left alone. The
 * payload is self-checked against a fresh merge before anything is sent.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { openDatabase } from "../src/db/index.js";
import { retiredHashes } from "../src/blobs/retire.js";
import { wordPronunciation, type Pronunciation } from "../src/review/index.js";
import { deltaPayload, mergeSync, SYNC_VERSION, type SyncPayload } from "../src/sync/index.js";
import { ARCHIVE_VERSION } from "../src/backup/index.js";

const SLOT = "dev-clip-redo";
const apply = process.argv.includes("--apply");
const doWords = process.argv.includes("--words");
const sentencesFile = (() => {
  const at = process.argv.indexOf("--sentences");
  return at === -1 ? null : (process.argv[at + 1] ?? null);
})();

if (existsSync(".env")) process.loadEnvFile(".env");
const base = (process.env["VITE_MAILBOX_URL"] ?? "").replace(/\/+$/, "");
const token = process.env["VITE_MAILBOX_TOKEN"] ?? "";
if (base === "" || token === "") {
  console.error("VITE_MAILBOX_URL and VITE_MAILBOX_TOKEN must be in .env");
  process.exit(2);
}
// A User-Agent, or Cloudflare answers 1010 to a script.
const headers = { Authorization: `Bearer ${token}`, "User-Agent": "hashigo-clip-redo/1.0" };

interface Stored {
  readonly kind: string;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Record<string, string>;
  readonly audio?: string;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as T;
}

async function payloadOf(path: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) return null;
  let bytes = Buffer.from(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return JSON.parse(bytes.toString("utf8"));
}

const sha = (b64: string): string => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");

// ── every device's view, merged into a scratch copy (read-only) ────────────
const scratchDir = mkdtempSync(join(tmpdir(), "clip-redo-"));
const scratch = join(scratchDir, "hashigo.db");
copyFileSync("build/hashigo.db", scratch);
const db = openDatabase(scratch, { applySchema: false });

try {
  const listing = await json<{ peers: { deviceId: string }[] }>("/sync/");
  const bases: SyncPayload[] = [];
  for (const { deviceId } of listing.peers) {
    const p = (await payloadOf(`/sync/${encodeURIComponent(deviceId)}`)) as SyncPayload | null;
    if (p !== null) bases.push(p);
  }
  bases.sort((a, b) => a.archive.createdAt.localeCompare(b.archive.createdAt));
  for (const p of bases) mergeSync(db, p);
  for (const { deviceId } of listing.peers) {
    const entries = (await payloadOf(`/sync/${encodeURIComponent(deviceId)}/delta`)) as unknown[] | null;
    for (const entry of entries ?? []) mergeSync(db, deltaPayload(entry as never, new Date().toISOString()));
  }
  console.log(`merged ${bases.length} device slot(s)`);

  // ── what the Worker made ───────────────────────────────────────────────────
  const keys = (await json<{ keys: string[] }>("/generated/")).keys;
  const clips: Stored[] = [];
  for (const key of keys) {
    const r = await json<Stored>(`/generated/${encodeURIComponent(key)}`).catch(() => null);
    if (r !== null && r.kind === "speech" && (r.lang ?? "").startsWith("ja") && typeof r.audio === "string") clips.push(r);
  }

  interface Job {
    readonly label: string;
    readonly clip: Stored;
    readonly pronounce?: Pronunciation;
    readonly readings?: { base: string; alias: string }[];
  }
  const jobs: Job[] = [];

  if (doWords) {
    const byName = new Map<string, string[]>();
    for (const r of db.prepare("SELECT id, name FROM cards WHERE archived = 0").all() as { id: string; name: string }[]) {
      byName.set(r.name.trim(), [...(byName.get(r.name.trim()) ?? []), r.id]);
    }
    let waiting = 0;
    let unlabelled = 0;
    for (const clip of clips) {
      const ids = byName.get(clip.text.trim());
      if (ids === undefined) continue;
      // The same word on two cards with different 型 would be one clip with two
      // answers — say so and leave it.
      const said = ids.map((id) => wordPronunciation(db as never, id, clip.text)).filter((w) => w !== null);
      if (said.length === 0) continue;
      if (said.some((w) => w.waiting)) {
        waiting += 1;
        console.log(`  waiting for 読み: ${clip.text}`);
        continue;
      }
      const distinct = new Set(said.map((w) => JSON.stringify(w)));
      if (distinct.size > 1) {
        console.log(`  two cards disagree, left alone: ${clip.text} ${[...distinct].join(" / ")}`);
        continue;
      }
      const word = said[0] as { waiting: false; pronounce?: Pronunciation };
      if (word.pronounce === undefined) {
        unlabelled += 1;
        continue; // no 型 to speak it with: the reading alone is not what this redo fixes
      }
      jobs.push({ label: `${clip.text} → ${word.pronounce.reading} (${word.pronounce.accent})`, clip, pronounce: word.pronounce });
    }
    console.log(`words: ${jobs.length} to redo · ${waiting} waiting for 読み · ${unlabelled} with no usable 型 (left)`);
  }

  if (sentencesFile !== null) {
    const wanted = JSON.parse(readFileSync(sentencesFile, "utf8")) as { text: string; readings: { base: string; alias: string }[] }[];
    for (const w of wanted) {
      const clip = clips.find((c) => c.text === w.text);
      if (clip === undefined) {
        console.log(`  no cloud clip for: ${w.text}`);
        continue;
      }
      jobs.push({ label: `${w.text.slice(0, 24)}… — ${w.readings.map((r) => `${r.base}=${r.alias}`).join(", ")}`, clip, readings: w.readings });
    }
  }

  for (const job of jobs) console.log(`  ${job.label}`);
  if (!apply) {
    console.log(`DRY RUN — would redo ${jobs.length} clip(s) and retire their old versions from ${SLOT}. Add --apply.`);
    process.exit(0);
  }

  // ── 1. the Worker makes each again, under the same key ─────────────────────
  const retire: string[] = [];
  let same = 0;
  let failed = 0;
  for (const job of jobs) {
    const old = sha(job.clip.audio as string);
    const body = {
      kind: "speech",
      text: job.clip.text,
      lang: job.clip.lang,
      voice: job.clip.voice,
      options: job.clip.options,
      force: true,
      replaces: old,
      ...(job.pronounce === undefined ? {} : { pronounce: job.pronounce }),
      ...(job.readings === undefined ? {} : { readings: job.readings }),
    };
    const reply = await json<{ hash?: string; audio?: string }>("/generate/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((e: Error) => {
      console.log(`  FAILED ${job.label}: ${e.message}`);
      return null;
    });
    if (reply === null || typeof reply.audio !== "string") {
      failed += 1;
      continue;
    }
    if (sha(reply.audio) === old) {
      same += 1;
      console.log(`  same bytes back, kept: ${job.label}`);
      continue;
    }
    retire.push(old);
  }
  console.log(`made ${retire.length} · same ${same} · failed ${failed}`);
  if (retire.length === 0) process.exit(failed > 0 ? 1 : 0);

  // ── 2. one payload that says only "these clips are retired" ────────────────
  const now = new Date().toISOString();
  const payload: SyncPayload = {
    syncVersion: SYNC_VERSION,
    archive: {
      archiveVersion: ARCHIVE_VERSION,
      schemaVersion: bases.at(-1)?.archive.schemaVersion ?? 0,
      createdAt: now,
      reviews: [],
      trackState: [],
      localFields: [],
      localCards: [],
      templates: [],
      fieldValues: [],
      settings: [],
      cardState: [],
      counts: { reviews: 0, trackState: 0, localFields: 0, localCards: 0, templates: 0, fieldValues: 0, settings: 0, cardState: 0 },
    },
    cardFlags: [],
    deckFlags: [],
    // No `voicesCarried`, no `templatesCarried`: this payload says nothing about either.
    retiredClips: [...new Set(retire)].sort(),
  };

  // ── self-check: merged into a fresh copy, it retires exactly these ─────────
  const checkFile = join(scratchDir, "check.db");
  copyFileSync(scratch, checkFile);
  const check = openDatabase(checkFile, { applySchema: false });
  try {
    const before = new Set(retiredHashes(check as never));
    const cards = JSON.stringify(check.prepare("SELECT id, template_id, archived, pinned, updated_at FROM cards ORDER BY id").all());
    mergeSync(check, payload);
    const after = new Set(retiredHashes(check as never));
    const added = [...after].filter((h) => !before.has(h));
    const missing = payload.retiredClips?.filter((h) => !after.has(h)) ?? [];
    const cardsAfter = JSON.stringify(check.prepare("SELECT id, template_id, archived, pinned, updated_at FROM cards ORDER BY id").all());
    console.log(`self-check: ${added.length} newly retired · ${missing.length} missing · cards changed: ${cards !== cardsAfter}`);
    if (missing.length > 0 || cards !== cardsAfter) throw new Error("self-check failed — nothing sent");
  } finally {
    check.close();
  }

  const put = await fetch(`${base}/sync/${SLOT}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(`sent ${payload.retiredClips?.length} retired clip(s) from ${SLOT}: ${put.status} ${await put.text()}`);
} finally {
  db.close();
  rmSync(scratchDir, { recursive: true, force: true });
}
