import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { dueInstant } from "../src/scheduler/index.js";
import {
  DEFAULT_INTERLEAVE,
  DEFAULT_NEW_LIMIT,
  EXPECTED_SESSION_CARDS,
  SessionCompleteError,
  buildSession,
  interleaveTracks,
  type SessionItem,
} from "../src/session/index.js";

const DB = "build/hashigo.db";
const HAS_CORPUS = existsSync(DB);

function item(id: number, origin: "due" | "new"): SessionItem {
  return {
    trackId: id,
    cardId: `c${id}`,
    kind: "forward",
    origin,
    reask: false,
    track: { trackId: id } as SessionItem["track"],
  };
}

const due = (n: number): SessionItem[] => Array.from({ length: n }, (_, i) => item(i + 1, "due"));
const fresh = (n: number): SessionItem[] =>
  Array.from({ length: n }, (_, i) => item(1000 + i, "new"));

describe("interleaveTracks", () => {
  it("defaults to `spread` — Zach's choice, 2026-08-23", () => {
    expect(DEFAULT_INTERLEAVE).toBe("spread");
  });

  it("still stacks new first when asked explicitly", () => {
    const out = interleaveTracks(due(3), fresh(2), "new-first");
    expect(out.map((i) => i.origin)).toEqual(["new", "new", "due", "due", "due"]);
  });

  it("puts due first when asked", () => {
    const out = interleaveTracks(due(3), fresh(2), "due-first");
    expect(out.map((i) => i.origin)).toEqual(["due", "due", "due", "new", "new"]);
  });

  it("is TOTAL for every policy and every shape — nothing dropped, nothing doubled", () => {
    for (const policy of ["new-first", "due-first", "spread"] as const) {
      for (let d = 0; d <= 12; d += 1) {
        for (let f = 0; f <= 12; f += 1) {
          const out = interleaveTracks(due(d), fresh(f), policy);
          const ids = out.map((i) => i.trackId);
          expect(out.length, `${policy} ${d}/${f} length`).toBe(d + f);
          expect(new Set(ids).size, `${policy} ${d}/${f} duplicates`).toBe(d + f);
          expect(out.filter((i) => i.origin === "new").length, `${policy} ${d}/${f} new`).toBe(f);
        }
      }
    }
  });

  it("spread lands all ten new cards inside the WINDOW, not across the whole plan", () => {
    const out = interleaveTracks(due(443), fresh(10), "spread");
    const at = out.flatMap((i, n) => (i.origin === "new" ? [n] : []));
    expect(at).toHaveLength(10);
    expect(at.at(-1)).toBeLessThan(EXPECTED_SESSION_CARDS);

    const gaps = at.slice(1).map((p, n) => p - at[n]!);
    expect(new Set(gaps)).toEqual(new Set([8]));

    expect(at[0]).toBe(4);
  });

  it("the window is what makes the ten reachable — measured against the naive spread", () => {
    const seenBy = (over: number, stop: number): number =>
      interleaveTracks(due(443), fresh(10), "spread", over)
        .slice(0, stop)
        .filter((i) => i.origin === "new").length;

    expect([50, 80, 100, 150].map((s) => seenBy(453, s))).toEqual([1, 2, 2, 3]);
    expect([50, 80, 100, 150].map((s) => seenBy(80, s))).toEqual([6, 10, 10, 10]);
  });

  it("spread is EVEN: with due >= new, no two new cards are ever adjacent", () => {
    let worstGap = Number.POSITIVE_INFINITY;
    for (let d = 1; d <= 60; d += 1) {
      for (let f = 1; f <= Math.min(d, 60); f += 1) {
        const out = interleaveTracks(due(d), fresh(f), "spread");
        const at = out.flatMap((i, n) => (i.origin === "new" ? [n] : []));
        expect(at, `${d}/${f} produced the wrong number of new items`).toHaveLength(f);
        for (let k = 1; k < at.length; k += 1) {
          const gap = at[k]! - at[k - 1]!;
          worstGap = Math.min(worstGap, gap);
          expect(gap, `${d}/${f} put two new cards adjacent at ${at[k - 1]}`).toBeGreaterThan(1);
        }
      }
    }
    expect(worstGap).toBe(2);
  });

  it("degenerates gracefully when one side is empty", () => {
    expect(interleaveTracks(due(3), [], "spread").map((i) => i.origin)).toEqual([
      "due",
      "due",
      "due",
    ]);
    expect(interleaveTracks([], fresh(2), "spread").map((i) => i.origin)).toEqual(["new", "new"]);
    expect(interleaveTracks([], [], "spread")).toEqual([]);
  });
});

describe.skipIf(!HAS_CORPUS)("the plan, over the real corpus", () => {
  const NOW = "2026-08-22T12:00:00+09:00";

  const DUE_AT_NOW = 70;

  it("is the due queue plus ten new tracks, and states its basis", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const session = buildSession(db, { now: NOW });
      const p = session.progress();
      expect(p.dueCount).toBe(DUE_AT_NOW);
      expect(p.newCount).toBe(DEFAULT_NEW_LIMIT);
      expect(p.planned).toBe(DUE_AT_NOW + DEFAULT_NEW_LIMIT);
      expect(p.answered).toBe(0);
      expect(p.remaining).toBe(DUE_AT_NOW + DEFAULT_NEW_LIMIT);
      expect(p.done).toBe(false);
    } finally {
      db.close();
    }
  });

  it("never puts the same track in the plan twice — due and new are disjoint", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const plan = buildSession(db, { now: NOW }).planned();
      const ids = plan.map((i) => i.trackId);
      expect(new Set(ids).size).toBe(ids.length);
      const cards = new Set(plan.map((i) => i.cardId));
      expect(cards.size).toBeLessThanOrEqual(ids.length);
    } finally {
      db.close();
    }
  });

  it("mixes the ten new tracks through the first 80 cards, warm-up first", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const plan = buildSession(db, { now: NOW }).planned();
      const at = plan.flatMap((i, n) => (i.origin === "new" ? [n] : []));
      expect(at).toHaveLength(10);
      expect(at.at(-1)).toBeLessThan(EXPECTED_SESSION_CARDS);
      expect(Math.min(...at.slice(1).map((p, n) => p - at[n]!))).toBeGreaterThan(1);
      expect(plan[0]?.origin).toBe("due");
    } finally {
      db.close();
    }
  });

  it("is DETERMINISTIC: two builds at the same instant give the same plan", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const a = buildSession(db, { now: NOW }).planned().map((i) => i.trackId);
      const b = buildSession(db, { now: NOW }).planned().map((i) => i.trackId);
      expect(a).toEqual(b);
      expect(a.length).toBe(DUE_AT_NOW + DEFAULT_NEW_LIMIT);
    } finally {
      db.close();
    }
  });

  it("newLimit 0 gives a due-only session, and dueLimit caps the other half", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      expect(buildSession(db, { now: NOW, newLimit: 0 }).progress()).toMatchObject({
        newCount: 0,
        dueCount: DUE_AT_NOW,
        planned: DUE_AT_NOW,
      });
      expect(buildSession(db, { now: NOW, dueLimit: 5 }).progress()).toMatchObject({
        newCount: 10,
        dueCount: 5,
        planned: 15,
      });
    } finally {
      db.close();
    }
  });
});

function fixture(dueCount: number, newCount: number): { db: Db; dueIds: number[]; newIds: number[] } {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', '日本語')").run();
  const dueIds: number[] = [];
  const newIds: number[] = [];

  for (let i = 0; i < dueCount; i += 1) {
    const card = `due${i}`;
    db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'd', ?)").run(card, `橋${i}`);
    const row = db
      .prepare(
        "INSERT INTO card_tracks (card_id, kind, scheduler) VALUES (?, 'forward', 'mochi') RETURNING id",
      )
      .get(card) as { id: number };
    const reviewedAt = "2026-08-01T09:00:00+09:00";
    const dueAt = dueInstant(reviewedAt, 5);
    db.prepare(
      `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered,
                            elapsed_days, scheduled_days, next_scheduled_days, due_at, source)
       VALUES (?, ?, 540, 1, 1, NULL, NULL, 5, ?, 'mochi')`,
    ).run(row.id, reviewedAt, dueAt);
    db.prepare(
      `UPDATE card_tracks SET reps = 1, lapses = 0, last_reviewed_at = ?, due_at = ?,
              scheduled_days = 5 WHERE id = ?`,
    ).run(reviewedAt, dueAt, row.id);
    dueIds.push(row.id);
  }

  for (let i = 0; i < newCount; i += 1) {
    const card = `new${i}`;
    db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'd', ?)").run(card, `箸${i}`);
    const row = db
      .prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward') RETURNING id")
      .get(card) as { id: number };
    newIds.push(row.id);
  }
  return { db, dueIds, newIds };
}

const AT = "2026-08-22T20:00:00+09:00";

function counts(db: Db): { reviews: number; local: number } {
  return {
    reviews: (db.prepare("SELECT count(*) AS n FROM reviews").get() as { n: number }).n,
    local: (
      db.prepare("SELECT count(*) AS n FROM reviews WHERE source = 'local'").get() as { n: number }
    ).n,
  };
}

describe("the session state machine", () => {
  it("grades a remembered card, advances, and writes exactly one review", () => {
    const { db } = fixture(2, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      const first = s.current();
      expect(first).not.toBeNull();
      const before = counts(db);
      const result = s.answer(true, { at: AT });
      expect(result.graded).toBe(true);
      expect(result.review).not.toBeNull();
      expect(result.queuedReask).toBe(false);
      expect(counts(db).local).toBe(before.local + 1);
      expect(s.current()?.trackId).not.toBe(first?.trackId);
      expect(s.progress().answered).toBe(1);
    } finally {
      db.close();
    }
  });

  it("DECISION 13: a forgotten card comes back at the END, after every fresh card", () => {
    const { db } = fixture(3, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      const failed = s.current()!.trackId;
      const r = s.answer(false, { at: AT });
      expect(r.queuedReask).toBe(true);
      expect(s.progress().reasksQueued).toBe(1);

      expect(s.current()!.trackId).not.toBe(failed);
      expect(s.current()!.reask).toBe(false);
      s.answer(true, { at: AT });
      s.answer(true, { at: AT });

      const back = s.current();
      expect(back).not.toBeNull();
      expect(back!.trackId).toBe(failed);
      expect(back!.reask).toBe(true);
      expect(s.progress().answered).toBe(3);
    } finally {
      db.close();
    }
  });

  it("DECISION 13's other half: answering a re-ask changes NOTHING in the database", () => {
    const { db } = fixture(1, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      const trackId = s.current()!.trackId;
      s.answer(false, { at: AT });

      const snapshot = () =>
        JSON.stringify({
          counts: counts(db),
          track: db
            .prepare(
              `SELECT due_at, scheduled_days, reps, lapses, last_reviewed_at, scheduler,
                      scheduler_state, updated_at FROM card_tracks WHERE id = ?`,
            )
            .get(trackId),
        });

      const reask = s.current()!;
      expect(reask.reask).toBe(true);
      const before = snapshot();
      const result = s.answer(false, { at: AT });
      expect(result.graded).toBe(false);
      expect(result.review).toBeNull();
      expect(snapshot()).toBe(before);
      expect(s.done).toBe(true);
    } finally {
      db.close();
    }
  });

  it("re-asks a track ONCE, so a card he cannot recall cannot stall the session", () => {
    const { db } = fixture(1, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      s.answer(false, { at: AT });
      expect(s.progress().reasksQueued).toBe(1);
      s.answer(false, { at: AT });
      expect(s.progress().reasksQueued).toBe(1);
      expect(s.done).toBe(true);
      expect(() => s.answer(false, { at: AT })).toThrow(SessionCompleteError);
    } finally {
      db.close();
    }
  });

  it("walks a mixed session to completion with the right number of writes", () => {
    const { db } = fixture(4, 3);
    try {
      const s = buildSession(db, { now: AT });
      expect(s.progress()).toMatchObject({ planned: 7, dueCount: 4, newCount: 3 });

      let graded = 0;
      let shown = 0;
      while (!s.done) {
        const before = s.current()!;
        const r = s.answer(shown % 3 !== 0, { at: AT });
        if (r.graded) graded += 1;
        expect(r.item.trackId).toBe(before.trackId);
        shown += 1;
        expect(shown).toBeLessThan(50);
      }
      const p = s.progress();
      expect(p.done).toBe(true);
      expect(p.answered).toBe(7);
      expect(p.reasksRemaining).toBe(0);
      expect(graded).toBe(7);
      expect(counts(db).local).toBe(7);
      expect(shown).toBe(7 + p.reasksQueued);
    } finally {
      db.close();
    }
  });

  it("reports a stable denominator: `planned` does not move as re-asks are added", () => {
    const { db } = fixture(3, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      expect(s.progress().planned).toBe(3);
      s.answer(false, { at: AT });
      expect(s.progress().planned).toBe(3);
      expect(s.progress().remaining).toBe(3);
      s.answer(false, { at: AT });
      expect(s.progress().planned).toBe(3);
      expect(s.progress().reasksQueued).toBe(2);
    } finally {
      db.close();
    }
  });

  it("does NOT advance past a card whose grade threw — no silent skip", () => {
    const { db, dueIds } = fixture(2, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      const stuck = s.current()!.trackId;
      db.prepare("UPDATE card_tracks SET dormant = 1 WHERE id = ?").run(stuck);

      expect(() => s.answer(true, { at: AT })).toThrow();
      expect(s.current()?.trackId).toBe(stuck);
      expect(s.progress().answered).toBe(0);
      expect(counts(db).local).toBe(0);

      db.prepare("UPDATE card_tracks SET dormant = 0 WHERE id = ?").run(stuck);
      expect(s.answer(true, { at: AT }).graded).toBe(true);
      expect(s.current()?.trackId).toBe(dueIds.find((id) => id !== stuck));
      expect(counts(db).local).toBe(1);
    } finally {
      db.close();
    }
  });

  it("throws rather than returning null once finished", () => {
    const { db } = fixture(1, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      s.answer(true, { at: AT });
      expect(s.done).toBe(true);
      expect(s.current()).toBeNull();
      expect(() => s.answer(true, { at: AT })).toThrow(SessionCompleteError);
    } finally {
      db.close();
    }
  });
});

describe("answerAt — grading out of order", () => {
  it("grades the card he is reading, not the one at the cursor", () => {
    const { db } = fixture(5, 0);
    const session = buildSession(db, { now: AT, newLimit: 0 });
    const target = session.peek(2);
    expect(target).not.toBeNull();

    const result = session.answerAt(2, true, { at: AT });
    expect("refused" in result).toBe(false);
    if ("refused" in result) return;
    expect(result.graded).toBe(true);
    expect(result.item.trackId).toBe(target?.trackId);

    const rows = db
      .prepare("SELECT track_id FROM reviews WHERE source = 'local'")
      .all() as { track_id: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.track_id).toBe(target?.trackId);
    db.close();
  });

  it("LOSES NOTHING — the card it displaced is still reached", () => {
    const { db } = fixture(5, 0);
    const session = buildSession(db, { now: AT, newLimit: 0 });
    const before = session.planned().map((i) => i.trackId);

    session.answerAt(3, true, { at: AT });

    const seen: number[] = [];
    let guard = 0;
    while (!session.done && guard < 50) {
      const item = session.current();
      if (item === null) break;
      seen.push(item.trackId);
      session.answerAt(0, true, { at: AT });
      guard += 1;
    }

    const graded = (
      db.prepare("SELECT track_id FROM reviews WHERE source = 'local'").all() as {
        track_id: number;
      }[]
    ).map((r) => r.track_id);
    expect([...graded].sort((a, b) => a - b)).toEqual([...before].sort((a, b) => a - b));
    expect(new Set(graded).size).toBe(before.length);
    db.close();
  });

  it("refuses a card already answered, rather than writing a second review", () => {
    const { db } = fixture(4, 0);
    const session = buildSession(db, { now: AT, newLimit: 0 });
    session.answerAt(0, true, { at: AT });
    const after = counts(db);

    const result = session.answerAt(-1, false, { at: AT });
    expect(result).toEqual({ refused: "already-answered" });
    expect(counts(db)).toEqual(after);
    db.close();
  });

  it("answers nothing past the end of the re-ask tail", () => {
    const { db } = fixture(2, 0);
    const session = buildSession(db, { now: AT, newLimit: 0 });
    session.answerAt(0, false, { at: AT });
    session.answerAt(0, true, { at: AT });

    const before = counts(db);
    expect(session.answerAt(1, true, { at: AT })).toEqual({ refused: "nothing-there" });
    expect(counts(db)).toEqual(before);
    db.close();
  });

  it("DISMISSES a re-ask ahead — no review, the next card comes up, undo puts it back", () => {
    const { db } = fixture(4, 0);
    const session = buildSession(db, { now: AT, newLimit: 0 });
    session.answerAt(0, false, { at: AT });
    session.answerAt(0, false, { at: AT });
    const reask = session.peek(2);
    const after = session.peek(3);
    expect(reask?.reask).toBe(true);
    const before = counts(db);

    for (const remembered of [true, false]) {
      const result = session.answerAt(2, remembered, { at: AT });
      if ("refused" in result) throw new Error(`refused: ${result.refused}`);
      expect(result.graded).toBe(false);
      expect(result.item.trackId).toBe(reask?.trackId);
      expect(counts(db)).toEqual(before);
      expect(session.peek(2)?.trackId).toBe(after?.trackId);
      expect(session.progress().reasksQueued).toBe(1);

      session.unanswer(result);
      expect(session.peek(2)?.trackId).toBe(reask?.trackId);
      expect(session.progress().reasksQueued).toBe(2);
    }
    db.close();
  });

  it("undo needs no special case, because the grade happened at the cursor", () => {
    const { db } = fixture(5, 0);
    const session = buildSession(db, { now: AT, newLimit: 0 });
    const before = counts(db);
    const target = session.peek(2);

    const result = session.answerAt(2, true, { at: AT });
    if ("refused" in result) throw new Error("expected a grade");
    expect(counts(db).reviews).toBe(before.reviews + 1);

    session.unanswer(result);
    expect(counts(db)).toEqual(before);
    expect(session.current()?.trackId).toBe(target?.trackId);
    db.close();
  });

  it("KEEPS GOING FORWARD — after grading at N, peek(N) is the card that followed it", () => {
    const { db } = fixture(6, 0);
    const session = buildSession(db, { now: AT, newLimit: 0 });
    const order = session.planned().map((i) => i.trackId);

    session.answerAt(2, true, { at: AT });
    expect(session.peek(2)?.trackId).toBe(order[3]);
    expect(session.peek(0)?.trackId).toBe(order[0]);
    expect(session.peek(1)?.trackId).toBe(order[1]);

    session.answerAt(2, false, { at: AT });
    expect(session.peek(2)?.trackId).toBe(order[4]);
    expect(session.peek(0)?.trackId).toBe(order[0]);
    expect(session.peek(1)?.trackId).toBe(order[1]);
    db.close();
  });

  it("answerAt(0) is answer() — one path, so the two cannot drift", () => {
    const { db } = fixture(3, 0);
    const session = buildSession(db, { now: AT, newLimit: 0 });
    const current = session.current();
    const result = session.answerAt(0, true, { at: AT });
    if ("refused" in result) throw new Error("expected a grade");
    expect(result.item.trackId).toBe(current?.trackId);
    db.close();
  });
});

describe("the day's tally, not the session's", () => {
  it("a rebuilt session shows the SAME fraction — the reload he reported", () => {
    const { db } = fixture(4, 0);
    try {
      const before = buildSession(db, { now: AT, newLimit: 0 });
      expect(before.progress()).toMatchObject({ answeredToday: 0, plannedToday: 4 });

      before.answer(true, { at: AT });
      const onScreen = before.progress();
      expect(onScreen).toMatchObject({ answeredToday: 1, plannedToday: 4 });
      expect(onScreen.answered).toBe(1);
      expect(onScreen.planned).toBe(4);

      const after = buildSession(db, { now: AT, newLimit: 0 });
      expect(after.progress().planned).toBe(3);
      expect(after.progress().answered).toBe(0);
      expect(`${after.progress().answeredToday}/${after.progress().plannedToday}`).toBe(
        `${onScreen.answeredToday}/${onScreen.plannedToday}`,
      );
    } finally {
      db.close();
    }
  });

  it("counts grades made EARLIER today, including ones this device did not make", () => {
    const { db, dueIds } = fixture(3, 0);
    try {
      db.prepare(
        `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown,
                              elapsed_days, scheduled_days, remembered, source)
         VALUES (?, ?, 540, 0, 5, 5, 1, 'local')`,
      ).run(dueIds[0], "2026-08-22T08:15:00+09:00");

      expect(buildSession(db, { now: AT, newLimit: 0 }).progress().answeredToday).toBe(1);
    } finally {
      db.close();
    }
  });

  it("ignores yesterday, and reads the date in the row's OWN offset", () => {
    const { db, dueIds } = fixture(3, 0);
    try {
      const rows = [
        ["2026-08-21T23:59:00+09:00", 0],
        ["2026-08-23T00:01:00+09:00", 0],
        ["2026-08-22T23:00:00-05:00", 1],
      ] as const;
      for (const [at] of rows) {
        db.prepare(
          `INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, time_unknown,
                                elapsed_days, scheduled_days, remembered, source)
           VALUES (?, ?, 540, 0, 5, 5, 1, 'local')`,
        ).run(dueIds[0], at);
      }
      const wanted = rows.reduce((n, [, counts]) => n + counts, 0);
      expect(buildSession(db, { now: AT, newLimit: 0 }).progress().answeredToday).toBe(wanted);
    } finally {
      db.close();
    }
  });

  it("a re-ask moves NEITHER number — the bar cannot go backwards on a forget", () => {
    const { db } = fixture(3, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      s.answer(false, { at: AT });
      const afterForget = s.progress();
      expect(afterForget).toMatchObject({ answeredToday: 1, plannedToday: 3, reasksQueued: 1 });

      s.answer(true, { at: AT });
      s.answer(true, { at: AT });
      expect(s.current()?.reask).toBe(true);
      const beforeReask = s.progress().answeredToday;
      s.answer(true, { at: AT });
      expect(s.progress().answeredToday).toBe(beforeReask);
      expect(s.progress().plannedToday).toBe(3);
    } finally {
      db.close();
    }
  });

  it("counts the misses from the SAME rows as the day's tally", () => {
    const { db } = fixture(4, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      expect(s.progress()).toMatchObject({ answeredToday: 0, missedToday: 0 });

      s.answer(false, { at: AT });
      expect(s.progress()).toMatchObject({ answeredToday: 1, missedToday: 1 });
      s.answer(true, { at: AT });
      expect(s.progress()).toMatchObject({ answeredToday: 2, missedToday: 1 });

      const reloaded = buildSession(db, { now: AT, newLimit: 0 }).progress();
      expect(reloaded).toMatchObject({ answeredToday: 2, missedToday: 1 });
    } finally {
      db.close();
    }
  });

  it("counts a missed card ONCE, not again when decision 13 re-asks it", () => {
    const { db } = fixture(3, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      s.answer(false, { at: AT });
      s.answer(true, { at: AT });
      s.answer(true, { at: AT });
      expect(s.current()?.reask).toBe(true);
      const before = s.progress().missedToday;
      s.answer(false, { at: AT });
      expect(s.progress().missedToday).toBe(before);
    } finally {
      db.close();
    }
  });

  it("undo puts the fraction back exactly", () => {
    const { db } = fixture(3, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      const before = s.progress();
      const result = s.answerAt(0, true, { at: AT });
      if ("refused" in result) throw new Error("expected a grade");
      expect(s.progress()).toMatchObject({ answeredToday: 1, plannedToday: 3 });
      s.unanswer(result);
      expect(s.progress().answeredToday).toBe(before.answeredToday);
      expect(s.progress().plannedToday).toBe(before.plannedToday);
    } finally {
      db.close();
    }
  });

  it("a skip shrinks the day rather than filling it — the card has left", () => {
    const { db } = fixture(3, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      expect(s.progress().plannedToday).toBe(3);
      s.skipCurrent();
      expect(s.progress()).toMatchObject({ answeredToday: 0, plannedToday: 2 });
    } finally {
      db.close();
    }
  });
});
