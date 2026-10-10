/**
 * 差分の同期 — `src/sync/delta.ts`。2026-10-10。
 *
 * 守る性質は全体の同期と同じで、増やさない：採点は失われない（和集合）、状態は
 * 最後の採点が勝つ。加えて差分に固有の二つ：差分は「印より後」だけを運ぶ（小さい
 * ことが存在理由）、そして差分は採点以外を一切動かさない（旗・設定を空の配列で
 * 上書きしたら、それは差分ではなく破壊）。
 */
import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { gradeTrack } from "../src/scheduler/index.js";
import {
  deltaPayload,
  exportDelta,
  isDelta,
  maxLocalReviewId,
  mergeSync,
} from "../src/sync/index.js";

const EPOCH = "2020-01-01T00:00:00.000Z";
const NOW = "2026-10-10T12:00:00.000Z";

function device(cards = 3): { db: Db; trackIds: number[] } {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name, updated_at) VALUES ('d', '日本語', ?)").run(EPOCH);
  const trackIds: number[] = [];
  for (let i = 0; i < cards; i += 1) {
    const id = `c${i}`;
    db.prepare("INSERT INTO cards (id, deck_id, name, updated_at) VALUES (?, 'd', ?, ?)").run(id, `橋${i}`, EPOCH);
    const row = db
      .prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward') RETURNING id")
      .get(id) as { id: number };
    trackIds.push(row.id);
  }
  return { db, trackIds };
}

const grade = (d: { db: Db; trackIds: number[] }, index: number, at: string, remembered: 0 | 1 = 1): void => {
  gradeTrack(d.db, { trackId: d.trackIds[index] as number, remembered, reviewedAt: at });
};

const localReviews = (db: Db): number =>
  (db.prepare("SELECT count(*) AS n FROM reviews WHERE source = 'local'").get() as { n: number }).n;

const lastReviewed = (db: Db, cardId: string): unknown =>
  (db.prepare("SELECT last_reviewed_at AS at FROM card_tracks WHERE card_id = ?").get(cardId) as { at: unknown }).at;

describe("a delta carries only what came after the mark", () => {
  it("exports every new grade and the state of exactly the tracks they touched", () => {
    const tablet = device();
    grade(tablet, 0, "2026-10-09T21:00:00.000Z");
    grade(tablet, 1, "2026-10-09T21:00:10.000Z");
    const delta = exportDelta(tablet.db, 0);
    expect(delta.reviews.map((r) => r.cardId)).toEqual(["c0", "c1"]);
    expect(delta.trackState.map((t) => t.cardId).sort()).toEqual(["c0", "c1"]);
    expect(delta.mark).toBe(maxLocalReviewId(tablet.db));
    expect(isDelta(delta)).toBe(true);
  });

  it("after the mark, only the grades since — the whole point is that it is small", () => {
    const tablet = device();
    grade(tablet, 0, "2026-10-09T21:00:00.000Z");
    const first = exportDelta(tablet.db, 0);
    grade(tablet, 2, "2026-10-09T21:05:00.000Z");
    const second = exportDelta(tablet.db, first.mark);
    expect(second.reviews.map((r) => r.cardId)).toEqual(["c2"]);
    expect(second.trackState.map((t) => t.cardId)).toEqual(["c2"]);
    expect(second.mark).toBeGreaterThan(first.mark);
  });

  it("an empty delta keeps the mark where it was", () => {
    const tablet = device();
    grade(tablet, 0, "2026-10-09T21:00:00.000Z");
    const mark = maxLocalReviewId(tablet.db);
    const empty = exportDelta(tablet.db, mark);
    expect(empty.reviews).toHaveLength(0);
    expect(empty.mark).toBe(mark);
  });

  it("is a few KB for a session's tail, under keepalive's 64 KB body cap", () => {
    const tablet = device(40);
    for (let i = 0; i < 40; i += 1) grade(tablet, i, `2026-10-09T21:${String(i).padStart(2, "0")}:00.000Z`);
    const bytes = new TextEncoder().encode(JSON.stringify(exportDelta(tablet.db, 0))).length;
    // 40 枚 ＝ 二分の窓より十分大きい。全体の payload は ~2 MB。
    expect(bytes).toBeLessThan(64 * 1024);
  });
});

describe("merging a delta uses the full merge's rules, unchanged", () => {
  it("adds the tablet's grades to the phone and takes their schedule", () => {
    const tablet = device();
    const phone = device();
    grade(tablet, 0, "2026-10-09T21:00:00.000Z");
    mergeSync(phone.db, deltaPayload(exportDelta(tablet.db, 0), NOW));
    expect(localReviews(phone.db)).toBe(1);
    expect(lastReviewed(phone.db, "c0")).toBe(lastReviewed(tablet.db, "c0"));
  });

  it("is idempotent — a keepalive send that was ALSO retried merges once", () => {
    const tablet = device();
    const phone = device();
    grade(tablet, 0, "2026-10-09T21:00:00.000Z");
    const payload = deltaPayload(exportDelta(tablet.db, 0), NOW);
    mergeSync(phone.db, payload);
    mergeSync(phone.db, payload);
    expect(localReviews(phone.db)).toBe(1);
  });

  it("keeps the phone's schedule when the phone graded that track LATER — and keeps both grades", () => {
    const tablet = device();
    const phone = device();
    grade(tablet, 0, "2026-10-09T21:00:00.000Z");
    grade(phone, 0, "2026-10-10T08:00:00.000Z", 0);
    const phoneState = lastReviewed(phone.db, "c0");
    mergeSync(phone.db, deltaPayload(exportDelta(tablet.db, 0), NOW));
    expect(lastReviewed(phone.db, "c0")).toBe(phoneState);
    expect(localReviews(phone.db)).toBe(2);
  });

  it("moves NOTHING but grades — no flag, no setting is overwritten by an empty list", () => {
    const tablet = device();
    const phone = device();
    phone.db.prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE id = 'c1'").run(NOW);
    phone.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('target_retention.default', '0.92') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run();
    grade(tablet, 0, "2026-10-09T21:00:00.000Z");
    mergeSync(phone.db, deltaPayload(exportDelta(tablet.db, 0), NOW));
    expect(phone.db.prepare("SELECT archived FROM cards WHERE id = 'c1'").get()).toEqual({ archived: 1 });
    expect(
      phone.db.prepare("SELECT value FROM settings WHERE key = 'target_retention.default'").get(),
    ).toEqual({ value: "0.92" });
  });
});
