/**
 * Stage 11's merge, over two databases that diverged.
 *
 * THE PROPERTY THAT MATTERS IS THAT A GRADE CANNOT BE LOST. That is the whole
 * reason the review log is append-only per track, and it is the thing Zach would
 * discover weeks later and could never reconstruct. Every other rule here is
 * about the two devices AGREEING; this one is about his history surviving.
 *
 * The second property is CONVERGENCE: merge both ways and the two databases hold
 * the same reviews, the same schedule and the same flags. A merge that is not
 * symmetric is a merge that needs a "primary" device, which is the thing sync
 * exists to remove.
 */
import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { gradeTrack } from "../src/scheduler/index.js";
import { exportSync, mergeSync, SYNC_VERSION } from "../src/sync/index.js";

/** Two cards, one forward track each, no history — the smallest divergence. */
function device(cards = 3): { db: Db; trackIds: number[] } {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
  const trackIds: number[] = [];
  for (let i = 0; i < cards; i += 1) {
    const id = `c${i}`;
    db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'd', ?)").run(id, `橋${i}`);
    const row = db
      .prepare(
        "INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward') RETURNING id",
      )
      .get(id) as { id: number };
    trackIds.push(row.id);
  }
  return { db, trackIds };
}

const reviewsOf = (db: Db): { card: string; at: string; remembered: number }[] =>
  db
    .prepare(
      `SELECT t.card_id AS card, r.reviewed_at AS at, r.remembered
         FROM reviews r JOIN card_tracks t ON t.id = r.track_id
        WHERE r.source = 'local' ORDER BY t.card_id, r.reviewed_at`,
    )
    .all() as { card: string; at: string; remembered: number }[];

const stateOf = (db: Db, cardId: string): Record<string, unknown> =>
  db
    .prepare(
      `SELECT due_at, reps, lapses, last_reviewed_at FROM card_tracks
        WHERE card_id = ? AND kind = 'forward'`,
    )
    .get(cardId) as Record<string, unknown>;

const flagsOf = (db: Db, cardId: string): { archived: number; pinned: number } =>
  db.prepare("SELECT archived, pinned FROM cards WHERE id = ?").get(cardId) as {
    archived: number;
    pinned: number;
  };

const NOW = "2026-09-12T12:00:00.000Z";

describe("a grade can never be lost by a merge", () => {
  it("unions grades made on BOTH devices while they were apart", () => {
    const laptop = device();
    const phone = device();

    // Different cards, same session window — the ordinary case.
    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(phone.db, {
      trackId: phone.trackIds[1] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T10:00:00.000Z",
    });

    mergeSync(laptop.db, exportSync(phone.db, NOW));
    mergeSync(phone.db, exportSync(laptop.db, NOW));

    // Both devices hold both grades, and they agree.
    expect(reviewsOf(laptop.db)).toHaveLength(2);
    expect(reviewsOf(laptop.db)).toEqual(reviewsOf(phone.db));
    laptop.db.close();
    phone.db.close();
  });

  it("keeps BOTH grades when the same track was graded on both devices", () => {
    const laptop = device();
    const phone = device();

    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(phone.db, {
      trackId: phone.trackIds[0] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T11:00:00.000Z",
    });

    mergeSync(laptop.db, exportSync(phone.db, NOW));

    // Two rows for one track. Neither device's history was discarded, which is
    // the append-only guarantee doing its job.
    const rows = reviewsOf(laptop.db).filter((r) => r.card === "c0");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.remembered)).toEqual([1, 0]);
    laptop.db.close();
    phone.db.close();
  });

  it("is idempotent — merging the same payload twice changes nothing", () => {
    const laptop = device();
    const phone = device();
    gradeTrack(phone.db, {
      trackId: phone.trackIds[2] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T10:00:00.000Z",
    });

    const payload = exportSync(phone.db, NOW);
    mergeSync(laptop.db, payload);
    const once = reviewsOf(laptop.db);
    mergeSync(laptop.db, payload);
    expect(reviewsOf(laptop.db)).toEqual(once);
    laptop.db.close();
    phone.db.close();
  });
});

describe("scheduler state follows the LAST REVIEW, not the last write", () => {
  it("the later grade's schedule wins, whichever device merged first", () => {
    const laptop = device();
    const phone = device();

    // The phone graded LATER. The laptop is the one running the merge, so a
    // naive last-write-wins would keep the laptop's state — the log and the
    // schedule would then disagree.
    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(phone.db, {
      trackId: phone.trackIds[0] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T11:00:00.000Z",
    });

    const phoneState = stateOf(phone.db, "c0");
    const report = mergeSync(laptop.db, exportSync(phone.db, NOW));

    expect(report.trackStateTaken).toBeGreaterThan(0);
    expect(stateOf(laptop.db, "c0")["last_reviewed_at"]).toBe(phoneState["last_reviewed_at"]);
    expect(stateOf(laptop.db, "c0")["due_at"]).toBe(phoneState["due_at"]);
    laptop.db.close();
    phone.db.close();
  });

  it("keeps the LOCAL schedule when this device graded later", () => {
    const laptop = device();
    const phone = device();

    gradeTrack(phone.db, {
      trackId: phone.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T11:00:00.000Z",
    });
    const before = stateOf(laptop.db, "c0");

    const report = mergeSync(laptop.db, exportSync(phone.db, NOW));

    expect(report.trackStateKept).toBeGreaterThan(0);
    expect(stateOf(laptop.db, "c0")).toEqual(before);
    // …and the phone's grade is still in the log. Kept state, kept history.
    expect(reviewsOf(laptop.db).filter((r) => r.card === "c0")).toHaveLength(2);
    laptop.db.close();
    phone.db.close();
  });

  it("converges: both devices end on the same schedule", () => {
    const laptop = device();
    const phone = device();
    gradeTrack(laptop.db, {
      trackId: laptop.trackIds[0] as number,
      remembered: 1,
      reviewedAt: "2026-09-12T09:00:00.000Z",
    });
    gradeTrack(phone.db, {
      trackId: phone.trackIds[0] as number,
      remembered: 0,
      reviewedAt: "2026-09-12T11:00:00.000Z",
    });

    // Exchange both ways, as a real sync does.
    const fromPhone = exportSync(phone.db, NOW);
    const fromLaptop = exportSync(laptop.db, NOW);
    mergeSync(laptop.db, fromPhone);
    mergeSync(phone.db, fromLaptop);

    expect(stateOf(laptop.db, "c0")).toEqual(stateOf(phone.db, "c0"));
    expect(reviewsOf(laptop.db)).toEqual(reviewsOf(phone.db));
    laptop.db.close();
    phone.db.close();
  });
});

describe("collection flags merge by clock, and CAN clear", () => {
  it("an archive made on one device reaches the other", () => {
    const laptop = device();
    const phone = device();
    phone.db
      .prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE id = 'c1'")
      .run("2026-09-12T10:00:00.000Z");

    mergeSync(laptop.db, exportSync(phone.db, NOW));
    expect(flagsOf(laptop.db, "c1").archived).toBe(1);
    laptop.db.close();
    phone.db.close();
  });

  it("AN UNARCHIVE REACHES THE OTHER TOO — the case a backup cannot express", () => {
    // `applyLocalArchive` is additive by design: it uses `max(archived, ?)` and
    // only exports raised flags, so on its own it can set a flag and never clear
    // one. Merged with that alone, Zach could archive 数字 once and never undo it.
    const laptop = device();
    const phone = device();
    for (const db of [laptop.db, phone.db]) {
      db.prepare("UPDATE cards SET archived = 1, updated_at = ? WHERE id = 'c1'").run(
        "2026-09-12T09:00:00.000Z",
      );
    }
    // Later, on the phone, he changes his mind.
    phone.db
      .prepare("UPDATE cards SET archived = 0, updated_at = ? WHERE id = 'c1'")
      .run("2026-09-12T11:00:00.000Z");

    const report = mergeSync(laptop.db, exportSync(phone.db, NOW));
    expect(report.flagsTaken).toBeGreaterThan(0);
    expect(flagsOf(laptop.db, "c1").archived).toBe(0);
    laptop.db.close();
    phone.db.close();
  });

  it("the older clock loses, whichever direction it came from", () => {
    const laptop = device();
    const phone = device();
    laptop.db
      .prepare("UPDATE cards SET pinned = 1, updated_at = ? WHERE id = 'c2'")
      .run("2026-09-12T11:00:00.000Z");
    phone.db
      .prepare("UPDATE cards SET pinned = 0, updated_at = ? WHERE id = 'c2'")
      .run("2026-09-12T09:00:00.000Z");

    mergeSync(laptop.db, exportSync(phone.db, NOW));
    expect(flagsOf(laptop.db, "c2").pinned).toBe(1);
    laptop.db.close();
    phone.db.close();
  });
});

describe("the payload refuses what it cannot merge", () => {
  it("rejects a version it does not speak, rather than merging across it", () => {
    const laptop = device();
    const phone = device();
    const payload = { ...exportSync(phone.db, NOW), syncVersion: SYNC_VERSION + 1 };
    expect(() => mergeSync(laptop.db, payload)).toThrow(/version/);
    laptop.db.close();
    phone.db.close();
  });
});
