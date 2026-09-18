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
// The one definition of "live", from the module that owns it. Every figure on
// this screen is drawn with it, which is what lets the deck rows sum to the tile.
import { liveTrack } from "../scheduler/predicates.js";

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

/** One month of "tracks reaching their first review". `cumulative` includes it. */
export interface GlanceLearnedMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly learned: number;
  /** Every track learned on or before the end of this month. */
  readonly cumulative: number;
}

/**
 * One deck's share of the learned figure, rolled up over its whole subtree.
 *
 * `live` and `learned` mean exactly what they mean in `collection` — same
 * predicate, same definition — so the three depth-0 rows sum to the headline
 * pair. `test/glance.test.ts` pins that, because two figures on one screen that
 * nearly agree are worse than one figure.
 */
export interface GlanceDeck {
  readonly deckId: string;
  readonly path: string;
  readonly depth: number;
  readonly live: number;
  readonly learned: number;
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
    /**
     * Live tracks he has actually started — `reps > 0`.
     *
     * **NOT `live - fresh`, and the difference is not pedantry.** `fresh` is
     * `../scheduler/predicates.ts`'s `isNewTrack`, which is `due_at IS NULL AND
     * reps = 0` — a track seeded with a due date and no reps is SCHEDULED rather
     * than new, and falls in neither set. That set is empty on the corpus today
     * (measured 2026-09-18: 0 of 13,393) and is representable, so subtracting
     * would be right until the day it silently was not. Counting `reps > 0`
     * directly cannot drift, and makes `live - learned` the honest "to go".
     */
    readonly learned: number;
  };
  /** The last 14 CALENDAR days, oldest first. A quiet day is a gap, and shows as one. */
  readonly recent: readonly GlanceDay[];
  /** The next 14 days of scheduled work, tomorrow first. */
  readonly forecast: readonly GlanceForecastDay[];
  /**
   * The last `LEARNED_MONTHS` calendar months of first reviews, oldest first.
   *
   * A month in which he started nothing IS RETURNED, with 0 — the same rule as
   * `recent`, for the same reason: a quiet month is a fact about the year and a
   * chart that closes the gap hides it. `cumulative` is carried from the whole
   * history rather than from the window, so the last bar's cumulative equals
   * `collection.learned`.
   */
  readonly learnedByMonth: readonly GlanceLearnedMonth[];
  /** Every deck, tree order, rolled up over its subtree. */
  readonly decks: readonly GlanceDeck[];
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

/**
 * ONE scan for `live` and `learned`, not two — the same repair `queueCounts` made
 * when its dormant count was a second statement (15.5 ms for the pair, 7.9 for one).
 * Asking twice over the same join was paying twice for nothing: 14.2 ms -> 7.4.
 */
const COLLECTION = `
SELECT (SELECT count(*) FROM cards) AS cards,
       (SELECT count(*) FROM card_tracks) AS tracks,
       t.live    AS live,
       t.learned AS learned
  FROM (SELECT count(*) AS live,
               sum(CASE WHEN t.reps > 0 THEN 1 ELSE 0 END) AS learned
          FROM card_tracks t
          JOIN cards c ON c.id = t.card_id
         WHERE ${liveTrack()}) t`;

/** How many calendar months of first-reviews the chart carries. */
const LEARNED_MONTHS = 12;

/**
 * When each track was first reviewed, by month — "learned" as a rate.
 *
 * ─── IT IS RESTRICTED TO LIVE TRACKS, AND THE JOIN GOES AFTER THE GROUP BY ──
 *
 * The obvious query groups `reviews` by `track_id` and stops. That runs in 8 ms
 * and totals **9,085**, against a headline of 9,010 — the 75 tracks that are
 * dormant or sit on an archived card. Two numbers on one screen disagreeing by 75
 * for a reason neither of them states is the defect, so the restriction is not
 * optional; what IS optional is where it goes, and that was measured rather than
 * guessed:
 *
 *     join inside the CTE, per REVIEW    32.6 ms     103,110 rows joined
 *     join after it, per TRACK           12.8 ms       9,085 rows joined
 *
 * Identical output. `min()` collapses the reviews to one row per track first, so
 * filtering afterwards touches an eleventh of the rows for the same answer.
 * Real corpus, 2026-09-18, median of seven.
 *
 * All 42 months are returned and the window is taken in TypeScript, because the
 * cumulative total has to run from the first review in 2022 — a SQL window that
 * starts twelve months ago cannot know what came before it.
 */
const LEARNED_BY_MONTH = `
WITH firsts AS (
  SELECT track_id, substr(min(reviewed_at), 1, 7) AS month
    FROM reviews
   GROUP BY track_id
)
SELECT f.month AS month, count(*) AS learned
  FROM firsts f
  JOIN card_tracks t ON t.id = f.track_id
  JOIN cards c ON c.id = t.card_id
 WHERE ${liveTrack()}
 GROUP BY f.month ORDER BY f.month`;

/**
 * The same pair per deck, rolled up over each deck's whole subtree.
 *
 * **NOT `metrics.ts`'s `deckProgress`, although it is right there and returns a
 * superset of these columns.** That one reads the `deck_progress` VIEW, which
 * counts every track — dormant ones and tracks on archived cards included — so
 * its roots sum to 9,085 / 13,393 where this screen's headline says 9,010 /
 * 12,917. The full report is internally consistent because every figure in it is
 * drawn the same way; borrowing one row of it into a screen built on `liveTrack`
 * would have put two definitions of the same word on one panel. So this is the
 * headline query with a `GROUP BY`, and the roots sum to the headline.
 *
 * `deck_ancestry` supplies the rollup (every deck is its own ancestor at depth
 * 0), `deck_paths` the name and the depth. Both are views in the schema, so this
 * needs nothing from Node and runs in the OPFS worker like the rest of the file.
 * 11 ms, 39 rows, same database and method as above.
 */
const DECK_LEARNED = `
WITH per_deck AS (
  SELECT c.deck_id AS deck_id,
         count(*) AS live,
         sum(CASE WHEN t.reps > 0 THEN 1 ELSE 0 END) AS learned
    FROM card_tracks t
    JOIN cards c ON c.id = t.card_id
   WHERE ${liveTrack()}
   GROUP BY c.deck_id
)
SELECT an.ancestor_id            AS deck_id,
       dp.path                   AS path,
       dp.depth                  AS depth,
       COALESCE(sum(p.live), 0)    AS live,
       COALESCE(sum(p.learned), 0) AS learned
  FROM deck_ancestry an
  JOIN deck_paths dp ON dp.deck_id = an.ancestor_id
  LEFT JOIN per_deck p ON p.deck_id = an.deck_id
 GROUP BY an.ancestor_id, dp.path, dp.depth
 ORDER BY dp.path`;

/** `YYYY-MM-DD`, `days` away from `date`. Negative goes back. */
export function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`).getTime();
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM`, `months` away from `month`. Negative goes back.
 *
 * Month arithmetic on day 1 of the month and never on today's day-of-month:
 * `new Date(2026, 8, 31)` minus one month is 1 October, not September, and a
 * chart that loses a month every 31st is the classic version of this bug.
 */
export function shiftMonth(month: string, months: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + months;
  const at = new Date(Date.UTC(year, index, 1));
  return at.toISOString().slice(0, 7);
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
    learned: number;
  };

  // Every month, then the last twelve — the cumulative has to run from 2022.
  const learnedRows = db.prepare(LEARNED_BY_MONTH).all() as {
    month: string;
    learned: number;
  }[];
  const learnedByMonth: GlanceLearnedMonth[] = [];
  {
    const byMonth = new Map(
      learnedRows.map((row) => [String(row.month), Number(row.learned)]),
    );
    // Walk the WHOLE history accumulating, and keep only the tail. A running
    // total taken over the window alone would start at zero twelve months ago
    // and disagree with the tile by four years of work.
    const from = shiftMonth(today.slice(0, 7), -(LEARNED_MONTHS - 1));
    let cumulative = 0;
    for (const month of [...byMonth.keys()].sort()) {
      if (month >= from) break;
      cumulative += byMonth.get(month) ?? 0;
    }
    for (let i = LEARNED_MONTHS - 1; i >= 0; i -= 1) {
      const month = shiftMonth(today.slice(0, 7), -i);
      const learned = byMonth.get(month) ?? 0;
      cumulative += learned;
      learnedByMonth.push({ month, learned, cumulative });
    }
  }

  const decks = (
    db.prepare(DECK_LEARNED).all() as {
      deck_id: string;
      path: string;
      depth: number;
      live: number;
      learned: number;
    }[]
  ).map((row) => ({
    deckId: String(row.deck_id),
    path: String(row.path),
    depth: Number(row.depth),
    live: Number(row.live),
    learned: Number(row.learned),
  }));

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
      learned: Number(collection.learned),
    },
    recent,
    forecast,
    learnedByMonth,
    decks,
  };
}
