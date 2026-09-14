/**
 * The dashboard he can open every day.
 *
 * ─── WHY THIS EXISTS, AND WHY IT IS NOT "THE MOBILE ONE" ────────────────────
 *
 * Zach asked: *"do you think we should not include the 'scientific dashboard' in
 * our mobile app? what about just simple dashboard in mobile app and full suit
 * dashboard on laptop?"* — and the split is right, but **not by device.**
 *
 * He reviews on the laptop too (*"on my laptop i review when im home"*), and a
 * laptop tab runs the same sqlite-wasm in the same one worker, so the full report
 * is the same 81 seconds there. Device is not what makes it expensive. And the
 * numbers below are the ones worth a daily glance on EITHER machine — hiding them
 * from the laptop would be as wrong as putting the full report on the phone.
 *
 * So it splits by what the numbers are FOR. This is "how am I doing";
 * `./metrics.ts` is "what does four years of data say", one button away, on both
 * machines, behind the cost it charges.
 *
 * ─── THE FULL REPORT'S "OBVIOUS" REPAIR IS WRONG, AND IT WAS MEASURED ───────
 *
 * `NEXT.md` said to materialise `review_log` into a TEMP TABLE once per `collect`,
 * since the cost is ~14 passes each recomputing a date per row. **That was written
 * without trying it, and trying it falsified it:**
 *
 * ```
 * as shipped                        6,389 ms   458,141 chars
 * temp table shadows review_log    31,657 ms   458,141 chars   (+272 ms to build)
 * ```
 *
 * Byte-identical output, **five times slower**. SQLite was already flattening the
 * view and pushing date predicates down into indexed base-table scans; the temp
 * table threw every index away and left fourteen full scans. Per-row date
 * arithmetic was never the dominant cost.
 *
 * ─── WHAT MAKES THIS ONE FAST: `substr`, AND ONE WINDOW ─────────────────────
 *
 * Two things, both measured (621 ms -> 102 ms in Node, over the real corpus):
 *
 * **1. `substr(reviewed_at, 1, 10)` IS the local date.** `reviewed_at` is stored
 * as an offset-bearing ISO string (`2026-08-18T00:00:00+09:00`), so its first ten
 * characters are already the local calendar date — no `datetime()` round trip, and
 * `reviewed_at` is indexed (`reviews_when`) so a range on it is a seek rather than
 * a scan. Checked against `review_log`'s own expression across all 103,110 rows:
 * **0 disagreements**, and `test/glance.test.ts` pins that. It holds because the
 * importer keeps `tz_offset_minutes` equal to the offset in the string; if that
 * invariant ever breaks the test fails rather than the number quietly drifting.
 *
 * **2. One windowed query, everything derived in TypeScript.** Today, the last 30
 * days, the last 14 active days and the streak are all functions of "reviews per
 * day for the last 400 days", which is a single indexed range. Asking the database
 * four times for four overlapping slices of the same rows was the actual cost.
 *
 * It also skips `review_log` entirely. That view joins `card_tracks`, `cards` and
 * the recursive `deck_paths`, and not one of these numbers is per-deck.
 *
 * BROWSER-PORTABLE: `SqliteHandle`, no `node:` import. It runs in the OPFS worker.
 */

import { queueCounts, reviewForecast } from "../scheduler/queue.js";

import type { SqliteHandle } from "../db/browser.js";

export interface GlanceDay {
  readonly date: string;
  readonly reviews: number;
  readonly remembered: number;
}

export interface GlanceForecastDay {
  readonly date: string;
  readonly due: number;
}

export interface Glance {
  readonly today: {
    readonly date: string;
    readonly reviews: number;
    readonly remembered: number;
    readonly due: number;
    readonly fresh: number;
  };
  /**
   * Consecutive days with at least one review, counting back from today — or from
   * yesterday when nothing has been reviewed yet today.
   *
   * **Today is not required to be active**, and that is the honest reading: a
   * streak that shows 0 at breakfast because he has not started is a number that
   * punishes him for the time of day. It breaks only once a whole day is missed.
   */
  readonly streakDays: number;
  readonly last30: {
    readonly reviews: number;
    readonly retention: number | null;
    readonly activeDays: number;
  };
  readonly allTime: {
    readonly reviews: number;
    readonly retention: number | null;
    readonly firstDate: string | null;
    readonly lastDate: string | null;
  };
  readonly collection: {
    readonly cards: number;
    readonly tracks: number;
    readonly live: number;
  };
  /** The last 14 CALENDAR days, oldest first. A quiet day is a gap, and shows as one. */
  readonly recent: readonly GlanceDay[];
  /** The next 14 days of scheduled work, tomorrow first. */
  readonly forecast: readonly GlanceForecastDay[];
}

/**
 * How far back the windowed query reaches. The streak is the only thing that wants
 * depth, and a streak longer than this is one the number has stopped being
 * interesting for.
 */
const WINDOW_DAYS = 400;

/**
 * Reviews per local day, over an indexed range of `reviewed_at`.
 *
 * The bound is a raw string comparison against an offset-bearing timestamp, which
 * is why the caller passes it with **a day of slack** and the exact filtering
 * happens on the date strings afterwards: with mixed offsets a raw `>=` could
 * cut one row at the boundary, and a day of slack is cheaper than being wrong.
 */
const PER_DAY = `
SELECT substr(reviewed_at, 1, 10) AS date, count(*) AS reviews,
       COALESCE(sum(remembered), 0) AS remembered
  FROM reviews
 WHERE reviewed_at >= ?
 GROUP BY date ORDER BY date`;

/** Two aggregates with no date arithmetic at all. */
const ALL_TIME = `SELECT count(*) AS reviews, COALESCE(sum(remembered), 0) AS remembered FROM reviews`;

/** `reviews_when` makes both of these a seek to one end of the index. */
const SPAN = `SELECT min(reviewed_at) AS first_at, max(reviewed_at) AS last_at FROM reviews`;

const COLLECTION = `
SELECT (SELECT count(*) FROM cards) AS cards,
       (SELECT count(*) FROM card_tracks) AS tracks,
       (SELECT count(*) FROM card_tracks t JOIN cards c ON c.id = t.card_id
         WHERE t.dormant = 0 AND c.archived = 0) AS live`;

/** `YYYY-MM-DD`, `days` away from `date`. Negative goes back. */
export function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`).getTime();
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

function ratio(remembered: number, reviews: number): number | null {
  return reviews === 0 ? null : remembered / reviews;
}

export interface GlanceOptions {
  /** Local date, `YYYY-MM-DD`. Defaults to the host's today. */
  readonly today?: string;
}

export function collectGlance(db: SqliteHandle, options: GlanceOptions = {}): Glance {
  const today =
    options.today ??
    (db.prepare("SELECT date('now','localtime') AS d").get() as { d: string }).d;

  // A day of slack on the bound, then the exact cut on the date strings — see
  // `PER_DAY`. The extra day costs one group and removes a class of off-by-one.
  const floor = shiftDate(today, -(WINDOW_DAYS + 1));
  const windowStart = shiftDate(today, -(WINDOW_DAYS - 1));
  const days = (db.prepare(PER_DAY).all(floor) as GlanceDay[])
    .map((row) => ({
      date: String(row.date),
      reviews: Number(row.reviews),
      remembered: Number(row.remembered),
    }))
    .filter((day) => day.date >= windowStart && day.date <= today);

  const byDate = new Map(days.map((day) => [day.date, day]));
  const todayRow = byDate.get(today);

  // Last 30 days, from the window rather than from a second query.
  const from30 = shiftDate(today, -29);
  let reviews30 = 0;
  let remembered30 = 0;
  let active30 = 0;
  for (const day of days) {
    if (day.date < from30) continue;
    reviews30 += day.reviews;
    remembered30 += day.remembered;
    active30 += 1;
  }

  // Fourteen CALENDAR days, not fourteen active ones: a gap he took off is a fact
  // about the fortnight, and a chart that closes the gap hides it.
  const recent: GlanceDay[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const date = shiftDate(today, -i);
    recent.push(byDate.get(date) ?? { date, reviews: 0, remembered: 0 });
  }

  // Count back from today when today is active, otherwise from yesterday — see
  // `Glance.streakDays`.
  let streakDays = 0;
  let cursor = byDate.has(today) ? today : shiftDate(today, -1);
  while (byDate.has(cursor)) {
    streakDays += 1;
    cursor = shiftDate(cursor, -1);
  }

  const allRow = db.prepare(ALL_TIME).get() as { reviews: number; remembered: number };
  const span = db.prepare(SPAN).get() as { first_at: string | null; last_at: string | null };
  const collection = db.prepare(COLLECTION).get() as {
    cards: number;
    tracks: number;
    live: number;
  };

  const counts = queueCounts(db);
  // `ForecastDay.count` is renamed to `due` here on purpose: this payload is read
  // by a screen, and "count" beside `reviews` and `remembered` is the one word
  // that could mean any of the three.
  const forecast = reviewForecast(db, { days: 14 }).map((day) => ({
    date: day.date,
    due: day.count,
  }));

  return {
    today: {
      date: today,
      reviews: todayRow?.reviews ?? 0,
      remembered: todayRow?.remembered ?? 0,
      due: counts.due,
      fresh: counts.fresh,
    },
    streakDays,
    last30: {
      reviews: reviews30,
      retention: ratio(remembered30, reviews30),
      activeDays: active30,
    },
    allTime: {
      reviews: Number(allRow.reviews),
      retention: ratio(Number(allRow.remembered), Number(allRow.reviews)),
      firstDate: span.first_at === null ? null : span.first_at.slice(0, 10),
      lastDate: span.last_at === null ? null : span.last_at.slice(0, 10),
    },
    collection: {
      cards: Number(collection.cards),
      tracks: Number(collection.tracks),
      live: Number(collection.live),
    },
    recent,
    forecast,
  };
}
