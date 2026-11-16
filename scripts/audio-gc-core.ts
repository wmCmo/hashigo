import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";

import { openBlobStoreDatabase, type BlobStore } from "../src/blobs/index.js";
import { openDatabase } from "../src/db/index.js";
import {
  audioReach,
  audioRows,
  planAudioGc,
  retiredSet,
  type AudioGcPlan,
  type AudioReach,
  type AudioRow,
} from "../src/review/audio-reach.js";
import { mergeSync, type SyncPayload } from "../src/sync/index.js";

export const ROOT = resolve(import.meta.dirname, "..");

export interface AudioAudit {
  readonly rows: readonly AudioRow[];
  readonly plan: AudioGcPlan;
  readonly doomedBytes: number;
  readonly rowless: readonly string[];
  readonly rowlessBytes: number;
  readonly reachLaptop: AudioReach;
  readonly reachMerged: AudioReach;
  readonly reachedOnlyOnDevices: number;
  readonly sources: readonly string[];
  readonly store: BlobStore;
}

async function payloads(): Promise<{ from: string; payload: SyncPayload }[]> {
  const found: { from: string; payload: SyncPayload }[] = [];
  const local = resolve(ROOT, "build/sync");
  if (existsSync(local)) {
    for (const name of readdirSync(local).filter((file) => file.endsWith(".json")).sort()) {
      found.push({ from: `build/sync/${name}`, payload: JSON.parse(readFileSync(resolve(local, name), "utf8")) });
    }
  }
  process.loadEnvFile(resolve(ROOT, ".env"));
  const base = (process.env["VITE_MAILBOX_URL"] ?? "").replace(/\/+$/, "");
  const token = process.env["VITE_MAILBOX_TOKEN"] ?? "";
  if (base === "" || token === "") {
    throw new Error("no VITE_MAILBOX_URL / VITE_MAILBOX_TOKEN in .env — cannot see the devices, so nothing can be judged unreached");
  }
  const headers = { Authorization: `Bearer ${token}` };
  const list = await fetch(`${base}/sync/`, { headers });
  if (!list.ok) throw new Error(`mailbox list answered ${list.status}`);
  const { peers } = (await list.json()) as { peers: { deviceId: string; updatedAt: string }[] };
  for (const peer of peers) {
    const response = await fetch(`${base}/sync/${encodeURIComponent(peer.deviceId)}`, { headers });
    if (!response.ok) throw new Error(`mailbox payload ${peer.deviceId} answered ${response.status}`);
    found.push({
      from: `cloud ${peer.deviceId} (${peer.updatedAt.slice(0, 16)})`,
      payload: (await response.json()) as SyncPayload,
    });
  }
  return found;
}

export async function measureAudio(options: {
  readonly db: string;
  readonly storeDb: string;
  readonly graceDays: number;
  readonly now?: Date;
}): Promise<AudioAudit> {
  const scratch = resolve(ROOT, "build/audio-gc");
  mkdirSync(scratch, { recursive: true });
  const merged = resolve(scratch, `merged-${Date.now()}.db`);
  {
    const source = new Database(options.db, { readonly: true });
    await source.backup(merged);
    source.close();
  }
  const sources: string[] = [];
  let reachMerged: AudioReach;
  let retiredMerged: Set<string>;
  try {
    const mergedDb = openDatabase(merged, { applySchema: false });
    try {
      for (const source of await payloads()) {
        mergeSync(mergedDb, source.payload);
        sources.push(source.from);
      }
      reachMerged = audioReach(mergedDb);
      retiredMerged = retiredSet(mergedDb);
    } finally {
      mergedDb.close();
    }
  } finally {
    rmSync(merged, { force: true });
  }

  const laptop = openDatabase(options.db, { readOnly: true, applySchema: false });
  let rows: AudioRow[];
  let reachLaptop: AudioReach;
  let rowHashes: Set<string>;
  let plan: AudioGcPlan;
  try {
    reachLaptop = audioReach(laptop);
    rows = audioRows(laptop);
    const retired = new Set([...retiredSet(laptop), ...retiredMerged]);
    plan = planAudioGc(rows, [reachLaptop, reachMerged], retired, {
      now: options.now ?? new Date(),
      graceDays: options.graceDays,
    });
    rowHashes = new Set(
      (laptop.prepare("SELECT hash FROM blobs").all() as { hash: string }[]).map((row) => row.hash),
    );
  } finally {
    laptop.close();
  }

  const store = openBlobStoreDatabase(options.storeDb, { mustExist: true }).store;
  const rowless = [...store.list()].filter((hash) => !rowHashes.has(hash));
  const reached = (reach: AudioReach, hash: string): boolean => reach.plays.has(hash) || reach.fallback.has(hash);
  return {
    rows,
    plan,
    doomedBytes: plan.doomed.reduce((n, row) => n + row.byteSize, 0),
    rowless,
    rowlessBytes: rowless.reduce((n, hash) => n + (store.size(hash) ?? 0), 0),
    reachLaptop,
    reachMerged,
    reachedOnlyOnDevices: rows.filter((row) => !reached(reachLaptop, row.hash) && reached(reachMerged, row.hash)).length,
    sources,
    store,
  };
}

export const mib = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MiB`;
