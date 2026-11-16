import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { openDatabase } from "../src/db/index.js";
import { retiredHashes } from "../src/blobs/retire.js";
import { isKana, splitMoras } from "../src/accent/speech.js";
import { wordPronunciation, type Pronunciation } from "../src/review/index.js";
import { deltaPayload, mergeSync, SYNC_VERSION, type SyncPayload } from "../src/sync/index.js";
import { ARCHIVE_VERSION } from "../src/backup/index.js";

const SLOT = "dev-clip-redo";
const apply = process.argv.includes("--apply");
const say = new Map<string, string>();
process.argv.forEach((arg, i) => {
  if (arg !== "--say") return;
  const [word, kana] = (process.argv[i + 1] ?? "").split("=");
  if (!word || !kana) {
    console.error(`--say wants word=kana, got "${process.argv[i + 1] ?? ""}"`);
    process.exit(2);
  }
  say.set(word.trim(), kana.trim());
});
const named = new Set(
  process.argv.flatMap((arg, i) => (arg === "--word" && process.argv[i + 1] ? [process.argv[i + 1]!.trim()] : [])),
);
const only = new Set([...say.keys(), ...named]);
const doWords = process.argv.includes("--words") || only.size > 0;
const extraRetire = process.argv.flatMap((arg, i) =>
  arg === "--retire" && /^[0-9a-f]{64}$/.test(process.argv[i + 1] ?? "") ? [process.argv[i + 1] as string] : [],
);
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
const headers = { Authorization: `Bearer ${token}`, "User-Agent": "hashigo-clip-redo/1.0" };

interface Stored {
  readonly kind: string;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Record<string, string>;
  readonly audio?: string;
  readonly replaces?: string;
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

  const keys = (await json<{ keys: string[] }>("/generated/")).keys;
  const clips: Stored[] = [];
  const replacedInStore = new Set<string>();
  const live = new Set<string>();
  for (const key of keys) {
    const r = await json<Stored>(`/generated/${encodeURIComponent(key)}`).catch(() => null);
    if (r === null || r.options?.["probe"]) continue;
    if (typeof r.audio === "string") live.add(sha(r.audio));
    if (typeof r.replaces === "string") replacedInStore.add(r.replaces);
    if (r.kind === "speech" && (r.lang ?? "").startsWith("ja") && typeof r.audio === "string") clips.push(r);
  }

  const own = (await payloadOf(`/sync/${SLOT}`)) as SyncPayload | null;
  const alreadySent = new Set(own?.retiredClips ?? []);
  const owed = (made: readonly string[]): string[] => {
    const all = new Set([...alreadySent, ...replacedInStore, ...extraRetire, ...made]);
    for (const hash of live) all.delete(hash);
    return [...all].sort();
  };
  const unsent = owed([]).filter((h) => !alreadySent.has(h));
  console.log(`${SLOT} carries ${alreadySent.size} retired clip(s); ${unsent.length} more owed before this run`);

  interface Job {
    readonly label: string;
    readonly clip: Stored;
    readonly pronounce?: Pronunciation;
    readonly readings?: { base: string; alias: string }[];
    readonly old: string;
  }
  const jobs: Job[] = [];

  if (doWords) {
    const byName = new Map<string, string[]>();
    for (const r of db.prepare("SELECT id, name FROM cards WHERE archived = 0").all() as { id: string; name: string }[]) {
      byName.set(r.name.trim(), [...(byName.get(r.name.trim()) ?? []), r.id]);
    }
    const candidates: { clip: Stored; old: string }[] = clips.map((clip) => ({ clip, old: sha(clip.audio as string) }));
    const retiredNow = new Set(retiredHashes(db as never));
    for (const word of named) {
      if (clips.some((c) => c.text.trim() === word)) {
        console.log(`  --word ${word}: has a cloud clip too — left`);
        continue;
      }
      const rows = (byName.get(word) ?? []).flatMap(
        (id) =>
          db
            .prepare(
              `SELECT b.hash, b.source_text AS text, b.lang, b.voice, b.options FROM blob_refs r
                 JOIN blobs b ON b.hash = r.blob_hash
                WHERE r.card_id = ? AND b.kind = 'speech' AND trim(b.source_text) = ?`,
            )
            .all(id, word) as { hash: string; text: string; lang: string | null; voice: string | null; options: string }[],
      );
      const distinct = [...new Map(rows.filter((r) => !retiredNow.has(r.hash)).map((r) => [r.hash, r])).values()];
      if (distinct.length !== 1) {
        console.log(`  --word ${word}: ${distinct.length} imported head-word clips, want exactly 1 — left`);
        continue;
      }
      const row = distinct[0]!;
      const options = JSON.parse(row.options) as Record<string, string>;
      candidates.push({ clip: { kind: "speech", text: row.text, lang: row.lang, voice: row.voice, options }, old: row.hash });
    }
    let waiting = 0;
    let unlabelled = 0;
    for (const { clip, old } of candidates) {
      if (only.size > 0 && !only.has(clip.text.trim())) continue;
      const ids = byName.get(clip.text.trim());
      if (ids === undefined) continue;
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
        continue;
      }
      let pronounce = word.pronounce;
      const kana = say.get(clip.text.trim());
      if (kana !== undefined) {
        if (!isKana(kana) || splitMoras(kana).length !== splitMoras(pronounce.reading).length) {
          console.log(`  --say ${clip.text}=${kana}: not kana, or not ${splitMoras(pronounce.reading).length} morae like ${pronounce.reading} — left`);
          continue;
        }
        pronounce = { ...pronounce, reading: kana };
      }
      jobs.push({ label: `${clip.text} → ${pronounce.reading} (${pronounce.accent})`, clip, pronounce, old });
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
      jobs.push({
        label: `${w.text.slice(0, 24)}… — ${w.readings.map((r) => `${r.base}=${r.alias}`).join(", ")}`,
        clip,
        readings: w.readings,
        old: sha(clip.audio as string),
      });
    }
  }

  for (const job of jobs) console.log(`  ${job.label}`);
  if (!apply) {
    console.log(`DRY RUN — would redo ${jobs.length} clip(s) and retire their old versions from ${SLOT}. Add --apply.`);
    process.exit(0);
  }

  const retire: string[] = [];
  let same = 0;
  let failed = 0;
  for (const job of jobs) {
    const old = job.old;
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
  const retiredClips = owed(retire);
  if (retiredClips.every((h) => alreadySent.has(h))) {
    console.log(`${SLOT} already carries every retired clip — nothing to send`);
    process.exit(failed > 0 ? 1 : 0);
  }

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
    retiredClips,
  };

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
