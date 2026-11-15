/**
 * Late night — Zach, 2026-11-15: *"for any day that I don't have time before
 * midnight, I can turn on that mode and then it won't reset at midnight … once I
 * finish reviewing, it just resets just like normal."* `src/session/late-night.ts`.
 */
import { describe, expect, it } from "vitest";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { buildSession } from "../src/session/index.js";
import { writeSetting } from "../src/session/settings.js";
import { endOfDay, keptDay, LATE_NIGHT_KEY, previousDate } from "../src/session/late-night.js";

describe("the late-night date arithmetic", () => {
  it("keeps yesterday, and only yesterday", () => {
    expect(keptDay("2026-11-15", "2026-11-16")).toBe("2026-11-15");
    expect(keptDay("2026-11-16", "2026-11-16")).toBeNull(); // midnight has not come
    expect(keptDay("2026-11-13", "2026-11-16")).toBeNull(); // left on for days
    expect(keptDay("", "2026-11-16")).toBeNull(); // off
    expect(keptDay(null, "2026-11-16")).toBeNull();
    expect(keptDay("yesterday", "2026-11-16")).toBeNull();
  });

  it("steps back over month and year ends", () => {
    expect(previousDate("2026-12-01")).toBe("2026-11-30");
    expect(previousDate("2027-01-01")).toBe("2026-12-31");
    expect(previousDate("2028-03-01")).toBe("2028-02-29");
  });

  it("ends the day in the offset of now", () => {
    expect(endOfDay("2026-11-15", "2026-11-16T00:30:00.000+09:00")).toBe("2026-11-15T23:59:59.999+09:00");
    expect(endOfDay("2026-11-15", "2026-11-15T15:30:00.000Z")).toBe("2026-11-15T23:59:59.999Z");
  });
});

/**
 * One track due on the 22nd, one due at midnight on the 23rd, and five new
 * tracks; on the 22nd he met three new tracks before midnight and one after.
 */
function night(): Db {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
  const track = (card: string): number => {
    db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'd', ?)").run(card, card);
    return (
      db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward') RETURNING id").get(card) as {
        id: number;
      }
    ).id;
  };
  const review = (id: number, at: string): void => {
    db.prepare(
      `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered,
                            elapsed_days, scheduled_days, next_scheduled_days, due_at, source)
       VALUES (?, ?, 540, 0, 1, NULL, NULL, 30, '2026-09-30T00:00:00+09:00', 'local')`,
    ).run(id, at);
    db.prepare(
      `UPDATE card_tracks SET reps = 1, lapses = 0, last_reviewed_at = ?,
              due_at = '2026-09-30T00:00:00+09:00', scheduled_days = 30 WHERE id = ?`,
    ).run(at, id);
  };
  const due = (card: string, dueAt: string): void => {
    const id = track(card);
    db.prepare(
      `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered,
                            elapsed_days, scheduled_days, next_scheduled_days, due_at, source)
       VALUES (?, '2026-08-01T09:00:00+09:00', 540, 1, 1, NULL, NULL, 5, ?, 'mochi')`,
    ).run(id, dueAt);
    db.prepare(
      `UPDATE card_tracks SET reps = 1, lapses = 0, last_reviewed_at = '2026-08-01T09:00:00+09:00',
              due_at = ?, scheduled_days = 5 WHERE id = ?`,
    ).run(dueAt, id);
  };
  due("yesterday", "2026-08-22T00:00:00+09:00");
  due("today", "2026-08-23T00:00:00+09:00");
  const met = ["m1", "m2", "m3", "m4"].map(track);
  review(met[0] as number, "2026-08-22T21:00:00+09:00");
  review(met[1] as number, "2026-08-22T21:05:00+09:00");
  review(met[2] as number, "2026-08-22T21:10:00+09:00");
  review(met[3] as number, "2026-08-23T00:10:00+09:00");
  for (const card of ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"]) track(card);
  return db;
}

const AFTER_MIDNIGHT = "2026-08-23T00:30:00+09:00";

describe("a session built past midnight", () => {
  it("is the new day's when the mode is off", () => {
    const db = night();
    try {
      const p = buildSession(db, { now: AFTER_MIDNIGHT, interleave: "due-first" }).progress();
      expect(p.dueCount).toBe(2); // both due tracks
      expect(p.newCount).toBe(9); // 10 a day, 1 met today
      expect(p.answeredToday).toBe(1);
    } finally {
      db.close();
    }
  });

  it("is yesterday's when the mode is on for yesterday — due, new and the count", () => {
    const db = night();
    try {
      writeSetting(db, LATE_NIGHT_KEY, "2026-08-22");
      const p = buildSession(db, { now: AFTER_MIDNIGHT, interleave: "due-first" }).progress();
      expect(p.dueCount).toBe(1); // the track due at midnight waits for its own day
      expect(p.newCount).toBe(6); // 10 for the 22nd, 4 already met — 3 before midnight, 1 after
      expect(p.answeredToday).toBe(4); // the 00:10 grade counts toward the kept day
    } finally {
      db.close();
    }
  });

  it("changes nothing when it is set for today, or switched off", () => {
    const db = night();
    try {
      writeSetting(db, LATE_NIGHT_KEY, "2026-08-23");
      expect(buildSession(db, { now: AFTER_MIDNIGHT }).progress().dueCount).toBe(2);
      writeSetting(db, LATE_NIGHT_KEY, "");
      expect(buildSession(db, { now: AFTER_MIDNIGHT }).progress().dueCount).toBe(2);
    } finally {
      db.close();
    }
  });
});
