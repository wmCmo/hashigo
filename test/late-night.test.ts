import { describe, expect, it, vi } from "vitest";
import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { buildSession } from "../src/session/index.js";
import { writeSetting } from "../src/session/settings.js";
import {
  endOfDay,
  keptDay,
  LATE_NIGHT_ENDED_KEY,
  LATE_NIGHT_KEY,
  previousDate,
  sinceForToday,
  stampNow,
} from "../src/session/late-night.js";

describe("the late-night date arithmetic", () => {
  it("keeps yesterday, and only yesterday", () => {
    const now = "2026-11-16T01:00:00.000+09:00";
    expect(keptDay("2026-11-15", now)).toBe("2026-11-15");
    expect(keptDay("2026-11-16", now)).toBeNull();
    expect(keptDay("2026-11-13", now)).toBeNull();
    expect(keptDay("", now)).toBeNull();
    expect(keptDay(null, now)).toBeNull();
    expect(keptDay("yesterday", now)).toBeNull();
  });

  it("ends at 06:00 local, finished or not", () => {
    expect(keptDay("2026-11-15", "2026-11-16T05:59:59.999+09:00")).toBe("2026-11-15");
    expect(keptDay("2026-11-15", "2026-11-16T06:00:00.000+09:00")).toBeNull();
    expect(keptDay("2026-11-15", "2026-11-16T23:30:00.000+09:00")).toBeNull();
    expect(keptDay("2026-11-15", "2026-11-16T05:00:00.000Z")).toBe("2026-11-15");
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
      expect(p.dueCount).toBe(2);
      expect(p.newCount).toBe(9);
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
      expect(p.dueCount).toBe(1);
      expect(p.newCount).toBe(6);
      expect(p.answeredToday).toBe(4);
    } finally {
      db.close();
    }
  });

  it("is the new day's from 06:00, though the setting still holds yesterday", () => {
    const db = night();
    try {
      writeSetting(db, LATE_NIGHT_KEY, "2026-08-22");
      const p = buildSession(db, { now: "2026-08-23T06:00:00+09:00", interleave: "due-first" }).progress();
      expect(p.dueCount).toBe(2);
      expect(p.newCount).toBe(9);
      expect(p.answeredToday).toBe(1);
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

describe("the day after a late night", () => {
  it("counts only from when the mode ended — its own ten new cards, an empty bar", () => {
    const db = night();
    try {
      for (const card of ["x1", "x2", "x3"]) {
        db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'd', ?)").run(card, card);
        db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward')").run(card);
      }
      writeSetting(db, LATE_NIGHT_KEY, "");
      const before = buildSession(db, { now: AFTER_MIDNIGHT, interleave: "due-first" }).progress();
      expect(before.newCount).toBe(9);
      writeSetting(db, LATE_NIGHT_ENDED_KEY, "2026-08-23T00:20:00+09:00");
      const p = buildSession(db, { now: AFTER_MIDNIGHT, interleave: "due-first" }).progress();
      expect(p.newCount).toBe(10);
      expect(p.answeredToday).toBe(0);
      expect(p.dueCount).toBe(2);
    } finally {
      db.close();
    }
  });

  it("is a whole ordinary day once that date has passed", () => {
    expect(sinceForToday("2026-08-23T00:20:00+09:00", "2026-08-23")).toBe("2026-08-23T00:20:00+09:00");
    expect(sinceForToday("2026-08-23T00:20:00+09:00", "2026-08-24")).toBeNull();
    expect(sinceForToday("", "2026-08-24")).toBeNull();
  });

  it("stamps the moment in the form grades are written in", () => {
    expect(stampNow(new Date("2026-11-15T15:40:12.345Z"))).toMatch(/^2026-11-1[56]T\d{2}:40:12\.345[+-]\d{2}:\d{2}$/);
  });
});

describe("a grade made in late night", () => {
  it("is written at the kept day's last millisecond, and its interval counts from there", () => {
    const db = night();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 7, 23, 0, 30));
      writeSetting(db, LATE_NIGHT_KEY, "2026-08-22");
      const session = buildSession(db, { interleave: "due-first" });
      const result = session.answer(true);
      expect(result.graded).toBe(true);
      expect(result.review?.reviewedAt.startsWith("2026-08-22T23:59:59.999")).toBe(true);
      expect(result.review?.dueAt.startsWith("2026-08-22")).toBe(false);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it("is written at the real time from 06:00, even on a plan built before it", () => {
    const db = night();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 7, 23, 5, 50));
      writeSetting(db, LATE_NIGHT_KEY, "2026-08-22");
      const session = buildSession(db, { interleave: "due-first" });
      vi.setSystemTime(new Date(2026, 7, 23, 6, 10));
      const result = session.answer(true);
      expect(result.review?.reviewedAt.startsWith("2026-08-23T06:10")).toBe(true);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it("is written at the real time when the mode is off", () => {
    const db = night();
    try {
      const session = buildSession(db, { interleave: "due-first" });
      const result = session.answer(true);
      expect(result.review?.reviewedAt.includes("T23:59:59.999")).toBe(false);
    } finally {
      db.close();
    }
  });
});
