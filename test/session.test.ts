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

/**
 * Stage 7's session layer — the plan, and decision 13's re-ask.
 *
 * THREE HALVES, and the teeth are in the third.
 *
 *   1. `interleaveTracks`, pure. The property that matters is TOTALITY: every
 *      input appears exactly once. A mixer that drops a card loses a review, and
 *      an off-by-one in the `spread` slot arithmetic is exactly how that happens.
 *   2. The plan against the real 74 MB corpus: the counts, that the due and new
 *      halves are DISJOINT, and that two builds agree.
 *   3. The state machine on a synthetic database, where grading is safe. Decision
 *      13 is the whole point: a forgotten card comes back and is **not graded**.
 *      The strong assertion is not "graded is false" — it is that the database is
 *      byte-for-byte unchanged by answering a re-ask.
 */

const DB = "build/hashigo.db";
const HAS_CORPUS = existsSync(DB);

// ─── half one: the mixer, pure ───────────────────────────────────────────────

function item(id: number, origin: "due" | "new"): SessionItem {
  return {
    trackId: id,
    cardId: `c${id}`,
    kind: "forward",
    origin,
    reask: false,
    // The mixer never looks at `track`, so a minimal shape is honest here.
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
    // The property that protects a review from vanishing. Swept rather than
    // spot-checked, and note what it does NOT catch: totality survives
    // clustering, so this passed with the slot formula fully broken. The
    // `spread is EVEN` test below is what owns the formula. (An earlier version
    // of this comment claimed slot collisions occur when `fresh` is a large
    // fraction of the total; a 90,000-pair sweep says they never occur at all.)
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
    // THE POINT OF THE WINDOW, and the reason Zach's `spread` is usable at all.
    // Across the whole 453-card plan the new cards are so far apart he never
    // reaches them: he does ~69-78 reviews a day against a 443-card due queue.
    const out = interleaveTracks(due(443), fresh(10), "spread");
    const at = out.flatMap((i, n) => (i.origin === "new" ? [n] : []));
    expect(at).toHaveLength(10);
    expect(at.at(-1)).toBeLessThan(EXPECTED_SESSION_CARDS);

    // Evenly, inside that window: step is 80/10 = 8.
    const gaps = at.slice(1).map((p, n) => p - at[n]!);
    expect(new Set(gaps)).toEqual(new Set([8]));

    // And a warm-up: due cards come first, so the session does not open on a
    // word he has never seen. floor(0.5 * 80 / 10) = 4.
    expect(at[0]).toBe(4);
  });

  it("the window is what makes the ten reachable — measured against the naive spread", () => {
    // The comparison that justified windowing rather than spreading over the plan.
    const seenBy = (over: number, stop: number): number =>
      interleaveTracks(due(443), fresh(10), "spread", over)
        .slice(0, stop)
        .filter((i) => i.origin === "new").length;

    // Naive: the whole plan as the window.
    expect([50, 80, 100, 150].map((s) => seenBy(453, s))).toEqual([1, 2, 2, 3]);
    // Windowed, as shipped.
    expect([50, 80, 100, 150].map((s) => seenBy(80, s))).toEqual([6, 10, 10, 10]);
  });

  it("spread is EVEN: with due >= new, no two new cards are ever adjacent", () => {
    // Pins CLUSTERING, and nothing else — this comment claimed more until a peer
    // review checked it on 2026-08-23. Verified: dropping the `+ 0.5` leaves the
    // minimum gap at 2, so THIS TEST STAYS GREEN and three others go red instead.
    // What `+ 0.5` actually buys is the warm-up — first slot 4 rather than 0 — and
    // the assertions that own that are `expect(at[0]).toBe(4)` above and
    // `expect(plan[0]?.origin).toBe("due")` in the corpus test. What this test
    // catches is a regression to `slots.add(i)`, which clusters. Minimum gap 2, swept.
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
    // Recorded because it is the tightest true bound: exactly 2, reached at 2/2.
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

// ─── half two: the plan, against the real corpus ─────────────────────────────

describe.skipIf(!HAS_CORPUS)("the plan, over the real corpus", () => {
  // Fixed instant so the queue is a constant: the same date the scheduler tests
  // and CLAUDE.md quote, which is what makes this a checkable number here.
  const NOW = "2026-08-22T12:00:00+09:00";

  /**
   * WAS 443, AND THE SIX THAT LEFT ARE THE POINT.
   *
   * `scripts/reverse-dormant-apply.ts` marked six reverse tracks dormant on
   * 2026-09-07 — cards the importer's do-not-orphan rule had forced `reverse = 'on'`
   * on the strength of one or two stray reviews from years ago, which Zach never
   * asked for and which sorted to the FRONT of his queue because that single review
   * is old. Dormant retains the history and stops the scheduling, so `liveTrack`
   * drops them and the due count falls by exactly six.
   *
   * The figure therefore depends on a documented post-import step, not on the export
   * alone. That is why `scripts/rebuild.mjs` runs it and asserts it: a rebuild that
   * skips it puts this number back to 443 and puts those six cards back in front of
   * him.
   */
  const DUE_AT_NOW = 437;

  it("is the due queue plus ten new tracks, and states its basis", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const session = buildSession(db, { now: NOW });
      const p = session.progress();
      // Basis, because three counts are available (decision 6): TRACKS, not
      // cards, not reviews. See `DUE_AT_NOW` for why it is 437 and not 443.
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
    // Disjoint by construction (`due_at IS NOT NULL` against `IS NULL`), which is
    // exactly the kind of invariant that survives until someone widens a filter.
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const plan = buildSession(db, { now: NOW }).planned();
      const ids = plan.map((i) => i.trackId);
      expect(new Set(ids).size).toBe(ids.length);
      const cards = new Set(plan.map((i) => i.cardId));
      // Worth recording rather than asserting tightly: a card can contribute two
      // tracks (forward and reverse), so cards < tracks is expected, not a fault.
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
      // All reachable, none adjacent, and the session opens on a DUE card.
      expect(at.at(-1)).toBeLessThan(EXPECTED_SESSION_CARDS);
      expect(Math.min(...at.slice(1).map((p, n) => p - at[n]!))).toBeGreaterThan(1);
      expect(plan[0]?.origin).toBe("due");
    } finally {
      db.close();
    }
  });

  it("is DETERMINISTIC: two builds at the same instant give the same plan", () => {
    // No `Math.random()` anywhere in the path. This is what makes a session
    // resumable and is the same guarantee `dailyOrderKey` gives `newTracks`.
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

// ─── half three: the state machine, where grading is safe ────────────────────

/** `dueCount` due tracks (each with one Mochi review) and `newCount` unseen ones. */
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
    // One history row, so the lazy FSRS seed has something to replay — the
    // realistic case for this corpus, where 9,026 tracks arrive state-less.
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

      // It is NOT next. The two remaining fresh cards come first.
      expect(s.current()!.trackId).not.toBe(failed);
      expect(s.current()!.reask).toBe(false);
      s.answer(true, { at: AT });
      s.answer(true, { at: AT });

      // Now, and only now, the re-ask.
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
    // The strong form. "graded === false" would pass on a function that wrote a
    // review row and forgot to say so, so this asserts on the database: the
    // review count, the track's whole scheduling state, and `updated_at`.
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
    // Forced, not chosen: without it, failing the re-ask re-queues it forever.
    const { db } = fixture(1, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      s.answer(false, { at: AT }); // fresh -> queues a re-ask
      expect(s.progress().reasksQueued).toBe(1);
      s.answer(false, { at: AT }); // the re-ask, failed again -> NOT re-queued
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
      // Fail every third card, so some re-asks exist.
      while (!s.done) {
        const before = s.current()!;
        const r = s.answer(shown % 3 !== 0, { at: AT });
        if (r.graded) graded += 1;
        expect(r.item.trackId).toBe(before.trackId);
        shown += 1;
        expect(shown).toBeLessThan(50); // termination guard, not an assertion
      }
      const p = s.progress();
      expect(p.done).toBe(true);
      expect(p.answered).toBe(7);
      expect(p.reasksRemaining).toBe(0);
      // Exactly one review per FRESH card. Re-asks wrote nothing.
      expect(graded).toBe(7);
      expect(counts(db).local).toBe(7);
      expect(shown).toBe(7 + p.reasksQueued);
    } finally {
      db.close();
    }
  });

  it("reports a stable denominator: `planned` does not move as re-asks are added", () => {
    // A progress bar over a queue that re-read the database would jitter. The
    // plan is a snapshot, so `planned` is a constant and re-asks are their own
    // count — which is also how the screen can say "3 to see again" honestly.
    const { db } = fixture(3, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      expect(s.progress().planned).toBe(3);
      s.answer(false, { at: AT });
      expect(s.progress().planned).toBe(3);
      expect(s.progress().remaining).toBe(3); // 2 fresh + 1 re-ask
      s.answer(false, { at: AT });
      expect(s.progress().planned).toBe(3);
      expect(s.progress().reasksQueued).toBe(2);
    } finally {
      db.close();
    }
  });

  it("does NOT advance past a card whose grade threw — no silent skip", () => {
    // The property: `gradeTrack` is called BEFORE the cursor moves, so a track
    // that has gone dormant under a long session leaves the SAME card current.
    // NOTE what this test does NOT show: it recovers by un-dormanting the track,
    // which an app cannot do. There is no `skip()`, so in the real world this
    // hard-locks the session — see the note on `answer()`. If the cursor moved
    // first, the
    // card would be silently dropped from the session and its review lost — the
    // failure mode you would never notice, because the queue just gets shorter.
    const { db, dueIds } = fixture(2, 0);
    try {
      const s = buildSession(db, { now: AT, newLimit: 0 });
      const stuck = s.current()!.trackId;
      db.prepare("UPDATE card_tracks SET dormant = 1 WHERE id = ?").run(stuck);

      expect(() => s.answer(true, { at: AT })).toThrow();
      // Still here, still unanswered, and nothing was written.
      expect(s.current()?.trackId).toBe(stuck);
      expect(s.progress().answered).toBe(0);
      expect(counts(db).local).toBe(0);

      // And it recovers: un-dormant it and the same call succeeds.
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
