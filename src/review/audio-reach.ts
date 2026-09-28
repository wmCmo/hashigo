/**
 * どの音声が「届く」か — カードが実際に鳴らしうるクリップの集合と、どこからも届かない
 * クリップ。Zach, 2026-09-28: *"i just wanna know if we have any orphan audio"*, then
 * *"we have to prevent this to not let it happen again"*.
 *
 * ─── なぜ refcount ではなく到達性なのか ─────────────────────────────────────
 *
 * `blobs.refcount` は `blob_refs` の行数で、Mochi の添付ファイルの記録としては正しい。
 * だがカードが鳴らすのは添付ではなく「生成の身元」（文・声・言語）で引いたクリップで、
 * `storeGeneratedSpeech` は行を refcount 1 で書き、参照の行を持たない。だから文を
 * 編集して古いクリップが誰にも引かれなくなっても refcount は 1 のまま、
 * `sweepUnreferenced` の対象にならない。2026-09-28 の測定: どこからも届かない 967 行の
 * 全部が refcount > 0 だった。
 *
 * だから「届くか」は数えるのではなく辿る: 復習画面と同じ道（`prepareCard` →
 * `mountPrepared` → `audioAddress` → `audioHashCandidates`）で全カードを描き、候補に
 * 出たハッシュを集める。何も再生しない — 再生しない限り resolve は呼ばれない。
 *
 * ─── ノートPCのデータベースだけで数えてはいけない ────────────────────────────
 *
 * 端末で編集したカードの文は端末と同期の mailbox にしかない。`**Exponent**` の一枚は
 * ノートPCでは星なしの文で、そのクリップ（26a267…）はノートPC上では「届かない」が、
 * スマホでは今そのカードが鳴らしている音。だから呼び出し側（`scripts/audio-gc.ts`）は
 * ノートPC そのままと、全端末の同期を合わせた写しの両方でこれを走らせ、和を取る。
 */

import type { SqliteHandle } from "../db/browser.js";
import { audioHashCandidates } from "../cards/audio.js";
import { memoryDocument } from "../render/dom.js";
import { audioAddress } from "../render/audio.js";
import { RETIRED_KEY, retiredHashes } from "../blobs/retire.js";
import { mountPrepared, prepareCard } from "./mount.js";

export interface AudioReach {
  /** Hashes that are the FIRST candidate of at least one mount — what a card plays. */
  readonly plays: ReadonlySet<string>;
  /** Hashes that appear only as a later candidate — played where the first is missing. */
  readonly fallback: ReadonlySet<string>;
  readonly cards: number;
  readonly mounts: number;
  /** Mounts with no candidate at all: the "generate audio" cards. */
  readonly silentMounts: number;
}

/** Walk every card the way the review screen does and collect the clips it could play. */
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
    // Forward only: a reverse track permutes the SIDES, never the fields, so it
    // mounts exactly the same clips.
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
  /** Audio rows reached by nothing, outside every keep rule. Safe to archive and remove. */
  readonly doomed: readonly AudioRow[];
  readonly kept: {
    readonly reached: number;
    /** Retired with "redo a clip" — kept on purpose, so a redo stays reversible. */
    readonly retired: number;
    /** Made inside the grace period — a device may not have synced the card that uses it. */
    readonly recent: number;
  };
}

/** Every audio row (speech, or any audio attachment). */
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

/**
 * Decide what goes. A row survives if ANY reach reaches it (plays or fallback), if
 * it is retired, or if it was made within `graceDays` of `now`.
 *
 * The grace period is for the case the reaches cannot see: a device that edited a
 * card and has not synced yet. Its new clip exists here (the Worker made it and the
 * pull filed it) while no payload in the mailbox names the text it belongs to.
 */
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

/** The retired list, as a set — re-exported here so the planner's caller needs one import. */
export function retiredSet(db: SqliteHandle): Set<string> {
  return new Set(retiredHashes(db));
}

export { RETIRED_KEY };
