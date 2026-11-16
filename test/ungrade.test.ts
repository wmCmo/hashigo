import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/index.js";
import {
  gradeTrack,
  readTrack,
  snapshotTrack,
  ungradeTrack,
  type TrackSnapshot,
} from "../src/scheduler/index.js";
import { buildSession } from "../src/session/index.js";

const MEMORY = ":memory:";

function fixture(): { db: ReturnType<typeof openDatabase>; trackId: number } {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
  db.prepare("INSERT INTO cards (id, deck_id, name) VALUES ('c', 'd', '橋')").run();
  db.prepare("INSERT INTO cards (id, deck_id, name) VALUES ('c2', 'd', '箸')").run();
  const track = db
    .prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('c', 'forward') RETURNING id")
    .get() as { id: number };
  db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES ('c2', 'forward')").run();
  return { db, trackId: track.id };
}

function reviewCount(db: ReturnType<typeof openDatabase>, trackId: number): number {
  return (
    db.prepare("SELECT count(*) AS n FROM reviews WHERE track_id = ?").get(trackId) as { n: number }
  ).n;
}

describe("ungradeTrack", () => {
  it("puts the track back byte-for-byte and removes the review row", () => {
    const { db, trackId } = fixture();
    const before = snapshotTrack(db, trackId);

    const graded = gradeTrack(db, { trackId, remembered: 1 });
    const moved = snapshotTrack(db, trackId);
    expect(moved).not.toEqual(before);
    expect(moved.reps).toBe(before.reps + 1);
    expect(reviewCount(db, trackId)).toBe(1);

    ungradeTrack(db, { reviewId: graded.reviewId, snapshot: before });

    expect(snapshotTrack(db, trackId)).toEqual(before);
    expect(reviewCount(db, trackId)).toBe(0);
    expect(db.prepare("SELECT id FROM reviews WHERE id = ?").get(graded.reviewId)).toBeUndefined();
    db.close();
  });

  it("restores `lapses` after a FORGOT — the increment nothing else would undo", () => {
    const { db, trackId } = fixture();
    const before = snapshotTrack(db, trackId);

    const graded = gradeTrack(db, { trackId, remembered: 0 });
    expect(snapshotTrack(db, trackId).lapses).toBe(before.lapses + 1);

    ungradeTrack(db, { reviewId: graded.reviewId, snapshot: before });
    expect(snapshotTrack(db, trackId).lapses).toBe(before.lapses);
    db.close();
  });

  it("restores `scheduler_state`, which is the value that cannot be recomputed", () => {
    const { db, trackId } = fixture();
    gradeTrack(db, { trackId, remembered: 1 });

    const before = snapshotTrack(db, trackId);
    expect(before.schedulerState, "the setup grade must leave real memory").not.toBeNull();

    const graded = gradeTrack(db, { trackId, remembered: 0 });
    expect(snapshotTrack(db, trackId).schedulerState).not.toBe(before.schedulerState);

    ungradeTrack(db, { reviewId: graded.reviewId, snapshot: before });
    expect(snapshotTrack(db, trackId).schedulerState).toBe(before.schedulerState);
    db.close();
  });

  it("restores every one of the seven columns a grade moves, from a non-empty state", () => {
    const { db, trackId } = fixture();
    gradeTrack(db, { trackId, remembered: 1 });
    gradeTrack(db, { trackId, remembered: 0 });

    const before = snapshotTrack(db, trackId);
    expect(before.schedulerState).not.toBeNull();
    expect(before.dueAt).not.toBeNull();
    expect(before.lastReviewedAt).not.toBeNull();
    expect(before.reps).toBeGreaterThan(0);
    expect(before.lapses).toBeGreaterThan(0);

    const graded = gradeTrack(db, { trackId, remembered: 1 });
    ungradeTrack(db, { reviewId: graded.reviewId, snapshot: before });
    expect(snapshotTrack(db, trackId)).toEqual(before);
    db.close();
  });

  it("REFUSES to undo anything but the latest review on the track", () => {
    const { db, trackId } = fixture();
    const first = snapshotTrack(db, trackId);
    const one = gradeTrack(db, { trackId, remembered: 1 });
    gradeTrack(db, { trackId, remembered: 1 });

    expect(() => ungradeTrack(db, { reviewId: one.reviewId, snapshot: first })).toThrow(
      /not the latest/,
    );
    expect(reviewCount(db, trackId)).toBe(2);
    db.close();
  });

  it("refuses a snapshot belonging to a different track", () => {
    const { db, trackId } = fixture();
    const other = (
      db.prepare("SELECT id FROM card_tracks WHERE card_id = 'c2'").get() as { id: number }
    ).id;
    const graded = gradeTrack(db, { trackId, remembered: 1 });
    expect(() =>
      ungradeTrack(db, { reviewId: graded.reviewId, snapshot: snapshotTrack(db, other) }),
    ).toThrow(/snapshot is of track/);
    expect(reviewCount(db, trackId)).toBe(1);
    db.close();
  });

  it("refuses a review id that does not exist", () => {
    const { db, trackId } = fixture();
    expect(() =>
      ungradeTrack(db, { reviewId: 99999, snapshot: snapshotTrack(db, trackId) }),
    ).toThrow(/no review 99999/);
    db.close();
  });

  it("round-trips ten grades undone newest-first", () => {
    const { db, trackId } = fixture();
    const start = snapshotTrack(db, trackId);

    const stack: { reviewId: number; snapshot: TrackSnapshot }[] = [];
    for (let i = 0; i < 10; i += 1) {
      const snapshot = snapshotTrack(db, trackId);
      const graded = gradeTrack(db, { trackId, remembered: i % 3 === 0 ? 0 : 1 });
      stack.push({ reviewId: graded.reviewId, snapshot });
    }
    expect(reviewCount(db, trackId)).toBe(10);

    while (stack.length > 0) ungradeTrack(db, stack.pop()!);

    expect(snapshotTrack(db, trackId)).toEqual(start);
    expect(reviewCount(db, trackId)).toBe(0);
    db.close();
  });

  it("agrees with readTrack, which is what the rest of the app reads", () => {
    const { db, trackId } = fixture();
    const row = readTrack(db, trackId);
    const before = snapshotTrack(db, trackId);

    const graded = gradeTrack(db, { trackId, remembered: 1 });
    ungradeTrack(db, { reviewId: graded.reviewId, snapshot: before });

    const after = readTrack(db, trackId);
    expect(row).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!.dueAt).toBe(row!.dueAt);
    expect(after!.reps).toBe(row!.reps);
    expect(after!.lapses).toBe(row!.lapses);
    db.close();
  });
});

describe("ReviewSession.unanswer", () => {
  it("steps the cursor back and un-writes the grade", () => {
    const { db } = fixture();
    const session = buildSession(db);
    const item = session.current();
    expect(item, "the fixture must plan at least one card").not.toBeNull();
    const before = snapshotTrack(db, item!.trackId);
    const startAnswered = session.progress().answered;

    const result = session.answer(true);
    expect(result.graded).toBe(true);
    expect(result.undo).not.toBeNull();
    expect(session.progress().answered).toBe(startAnswered + 1);

    session.unanswer(result);
    expect(session.progress().answered).toBe(startAnswered);
    expect(session.current()?.trackId).toBe(item!.trackId);
    expect(snapshotTrack(db, item!.trackId)).toEqual(before);
    db.close();
  });

  it("pops the decision-13 re-ask that a FORGOT queued", () => {
    const { db } = fixture();
    const session = buildSession(db);

    const result = session.answer(false);
    expect(result.queuedReask).toBe(true);
    expect(session.progress().reasksQueued).toBe(1);

    session.unanswer(result);
    expect(session.progress().reasksQueued).toBe(0);
    db.close();
  });

  it("undoes a re-ask, which graded nothing and so restores nothing", () => {
    const { db } = fixture();
    const session = buildSession(db);
    session.answer(false);
    while (!session.done && session.current()?.reask !== true) session.answer(true);
    expect(session.current()?.reask).toBe(true);

    const before = (db.prepare("SELECT count(*) AS n FROM reviews").get() as { n: number }).n;
    const result = session.answer(true);
    expect(result.graded).toBe(false);
    expect(result.undo).toBeNull();
    expect((db.prepare("SELECT count(*) AS n FROM reviews").get() as { n: number }).n).toBe(before);

    session.unanswer(result);
    expect(session.current()?.reask).toBe(true);
    db.close();
  });

  it("refuses to rewind past the start of the session", () => {
    const { db } = fixture();
    const session = buildSession(db);
    const result = session.answer(true);
    session.unanswer(result);
    expect(() => session.unanswer(result)).toThrow(/nothing has been answered/);
    db.close();
  });

  it("writes the database BEFORE moving the cursor, so a refusal leaves them agreeing", () => {
    const { db } = fixture();
    const session = buildSession(db);
    const first = session.answer(true);
    session.answer(true);
    const answered = session.progress().answered;

    if (first.undo !== null) {
      const sameTrack =
        (db.prepare("SELECT track_id AS t FROM reviews ORDER BY id DESC LIMIT 1").get() as {
          t: number;
        }).t === first.undo.snapshot.trackId;
      if (sameTrack) {
        expect(() => session.unanswer(first)).toThrow();
        expect(session.progress().answered, "the cursor must not have moved").toBe(answered);
      }
    }
    db.close();
  });
});
