import type { SqliteHandle } from "../db/browser.js";
import { audioHashCandidates } from "../cards/audio.js";
import { memoryDocument } from "../render/dom.js";
import { audioAddress } from "../render/audio.js";
import { RETIRED_KEY, retiredHashes } from "../blobs/retire.js";
import { mountPrepared, prepareCard } from "./mount.js";

export interface AudioReach {
  readonly plays: ReadonlySet<string>;
  readonly fallback: ReadonlySet<string>;
  readonly cards: number;
  readonly mounts: number;
  readonly silentMounts: number;
}

export function audioReach(db: SqliteHandle): AudioReach {
  const plays = new Set<string>();
  const fallback = new Set<string>();
  let cards = 0;
  let mounts = 0;
  let silentMounts = 0;
  const ids = (db.prepare("SELECT id FROM cards ORDER BY id").all() as { id: string }[]).map(
    (row) => row.id,
  );
  for (const cardId of ids) {
    const prepared = prepareCard({ db, cardId, direction: "forward" });
    if (prepared === null) continue;
    cards += 1;
    const mounted = mountPrepared(prepared, { document: memoryDocument(), resolve: () => null });
    for (const mount of mounted.result.media) {
      const address = audioAddress(mounted.result, mount);
      if (address === null) continue;
      mounts += 1;
      const candidates = audioHashCandidates(db, cardId, address);
      if (candidates.length === 0) silentMounts += 1;
      candidates.forEach((hash, index) => (index === 0 ? plays : fallback).add(hash));
    }
  }
  for (const hash of plays) fallback.delete(hash);
  return { plays, fallback, cards, mounts, silentMounts };
}

export interface AudioRow {
  readonly hash: string;
  readonly byteSize: number;
  readonly voice: string | null;
  readonly createdAt: string;
}

export interface AudioGcPlan {
  readonly doomed: readonly AudioRow[];
  readonly kept: {
    readonly reached: number;
    readonly retired: number;
    readonly recent: number;
  };
}

export function audioRows(db: SqliteHandle): AudioRow[] {
  return (
    db
      .prepare(
        `SELECT hash, byte_size, voice, created_at FROM blobs
          WHERE kind = 'speech' OR mime LIKE 'audio/%' ORDER BY hash`,
      )
      .all() as { hash: string; byte_size: number; voice: string | null; created_at: string }[]
  ).map((row) => ({ hash: row.hash, byteSize: row.byte_size, voice: row.voice, createdAt: row.created_at }));
}

export function planAudioGc(
  rows: readonly AudioRow[],
  reaches: readonly AudioReach[],
  retired: ReadonlySet<string>,
  options: { readonly now: Date; readonly graceDays: number },
): AudioGcPlan {
  const cutoff = new Date(options.now.getTime() - options.graceDays * 86_400_000).toISOString();
  const doomed: AudioRow[] = [];
  let reached = 0;
  let keptRetired = 0;
  let recent = 0;
  for (const row of rows) {
    if (reaches.some((reach) => reach.plays.has(row.hash) || reach.fallback.has(row.hash))) {
      reached += 1;
    } else if (retired.has(row.hash)) {
      keptRetired += 1;
    } else if (row.createdAt > cutoff) {
      recent += 1;
    } else {
      doomed.push(row);
    }
  }
  return { doomed, kept: { reached, retired: keptRetired, recent } };
}

export function retiredSet(db: SqliteHandle): Set<string> {
  return new Set(retiredHashes(db));
}

export { RETIRED_KEY };
