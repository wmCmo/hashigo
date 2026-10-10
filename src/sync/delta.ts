/**
 * 差分 — 前回送った後の採点だけを運ぶ、小さな payload。2026-10-10。
 *
 * Zach: *"so it's guaranteed that my last min of reviewing won't be synced from my
 * tablet"* — そして *"as long as we don't end up like mochi flashcards im fine"*。
 *
 * ─── なぜ要るか ─────────────────────────────────────────────────────────────
 *
 * 全体の payload は ~2 MB（gzip で ~350 KB）。採点のたびにそれを送るのは通信量
 * として重く、しかも閉じる瞬間には届かない：ページが閉じても走り切る `fetch`
 * （`keepalive`）は本文 64 KB までで、全体はその五倍以上ある。差分は数十件の
 * 採点とその軌道の状態だけ、数 KB で、`keepalive` に収まる。だからタブレットを
 * 閉じた直後の最後の一枚も届く。
 *
 * ─── マージの規則は増やさない ───────────────────────────────────────────────
 *
 * 受け取る側は差分を「review と trackState しか持たない普通の payload」に包んで
 * `mergeSync` に渡す（`deltaPayload`）。review は和集合、状態は最後の採点が勝つ —
 * 全体のマージと一字一句同じ規則が、同じコードで当たる。差分専用のマージを書けば
 * 二つの規則がいつか食い違う。
 *
 * ─── 印（mark）は端末内の reviews.id ─────────────────────────────────────────
 *
 * 「どこまで送ったか」は、その端末のローカルな行番号で数える。他の端末と比べる
 * ことは無い（mailbox は印を比べるだけで、意味は知らない）。時刻ではないのは、
 * 同じ瞬間の採点や時計のずれで取りこぼさないため。
 *
 * BROWSER-PORTABLE: `SqliteHandle` のみ。OPFS のワーカーで走る。
 */

import {
  ARCHIVE_VERSION,
  archivedReview,
  archivedTrackState,
  type ArchivedReview,
  type ArchivedTrackState,
} from "../backup/archive.js";
import type { SqliteHandle } from "../db/browser.js";
import { SYNC_VERSION, type SyncPayload } from "./merge.js";

export interface SyncDelta {
  readonly syncVersion: number;
  /** 差分であることの印。全体の payload と取り違えないため。 */
  readonly delta: 1;
  /** この差分に入っている最大の reviews.id（送った端末のローカル番号）。 */
  readonly mark: number;
  readonly reviews: readonly ArchivedReview[];
  /** 上の採点が触った軌道の、今の状態。 */
  readonly trackState: readonly ArchivedTrackState[];
}

const SELECT_NEW_REVIEWS = `
SELECT r.id AS id, t.card_id AS card_id, t.kind AS kind, r.reviewed_at, r.tz_offset_minutes,
       r.time_unknown, r.remembered, r.elapsed_days, r.scheduled_days,
       r.next_scheduled_days, r.due_at, r.duration_ms, r.rereview, r.source,
       r.import_key
  FROM reviews r JOIN card_tracks t ON t.id = r.track_id
 WHERE r.source = 'local' AND r.id > ?
 ORDER BY r.id`;

const SELECT_TRACK = `
SELECT t.card_id AS card_id, t.kind AS kind, t.due_at, t.scheduled_days, t.reps,
       t.lapses, t.last_reviewed_at, t.scheduler, t.scheduler_state
  FROM card_tracks t
 WHERE t.card_id = ? AND t.kind = ?`;

/** この端末の採点の最大 id。採点が一つも無ければ 0。 */
export function maxLocalReviewId(db: SqliteHandle): number {
  const row = db.prepare("SELECT max(id) AS m FROM reviews WHERE source = 'local'").get() as
    | { m: number | null }
    | undefined;
  return Number(row?.m ?? 0);
}

/** `after` より後の採点と、それが触った軌道の状態。 */
export function exportDelta(db: SqliteHandle, after: number): SyncDelta {
  const rows = db.prepare(SELECT_NEW_REVIEWS).all(after) as Record<string, unknown>[];
  const reviews = rows.map(archivedReview);
  const mark = rows.reduce((max, row) => Math.max(max, Number(row["id"])), after);
  const seen = new Set<string>();
  const trackState: ArchivedTrackState[] = [];
  const track = db.prepare(SELECT_TRACK);
  for (const review of reviews) {
    const key = `${review.cardId}\u0000${review.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = track.get(review.cardId, review.kind) as Record<string, unknown> | undefined;
    if (row !== undefined) trackState.push(archivedTrackState(row));
  }
  return { syncVersion: SYNC_VERSION, delta: 1, mark, reviews, trackState };
}

export function isDelta(value: unknown): value is SyncDelta {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { delta?: unknown }).delta === 1 &&
    Array.isArray((value as { reviews?: unknown }).reviews)
  );
}

/**
 * 差分を、review と状態しか持たない普通の payload に包む。
 *
 * 空の配列は「何も言わない」と読まれる：`cardFlags` が空なら旗は一つも動かず、
 * `settings` が空なら設定は一つも上書きされず、`retiredClips` が無ければ退役の
 * 和集合は手元のまま。`voicesCarried` を付けないのは、付けると「声の欄が無い ＝
 * 声なし」と読まれて誰かの設定を消すから。
 */
export function deltaPayload(delta: SyncDelta, createdAt: string): SyncPayload {
  return {
    syncVersion: delta.syncVersion,
    archive: {
      archiveVersion: ARCHIVE_VERSION,
      schemaVersion: 0,
      createdAt,
      reviews: delta.reviews,
      trackState: delta.trackState,
      localFields: [],
      templates: [],
      localCards: [],
      fieldValues: [],
      settings: [],
      cardState: [],
      counts: {
        reviews: delta.reviews.length,
        trackState: delta.trackState.length,
        localFields: 0,
        localCards: 0,
        templates: 0,
        fieldValues: 0,
        settings: 0,
        cardState: 0,
      },
    },
    cardFlags: [],
    deckFlags: [],
  };
}
