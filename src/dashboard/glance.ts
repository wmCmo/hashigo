import { queueCounts, reviewForecast } from "../scheduler/queue.js";
import { liveTrack } from "../scheduler/predicates.js";

import type { SqliteHandle } from "../db/browser.js";

export interface GlanceDay {
  readonly date: string;
  readonly reviews: number;
  readonly remembered: number;
  readonly firsts: number;
  readonly firstsRemembered: number;
}

export interface GlanceForecastDay {
  readonly date: string;
  readonly due: number;
}

export interface GlanceLearnedMonth {
  readonly month: string;
  readonly learned: number;
  readonly cumulative: number;
}

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
    readonly learned: number;
  };
  readonly recent: readonly GlanceDay[];
  readonly forecast: readonly GlanceForecastDay[];
  readonly learnedByMonth: readonly GlanceLearnedMonth[];
  readonly decks: readonly GlanceDeck[];
}

const WINDOW_DAYS = 400;

const PER_DAY = `
SELECT date, count(*) AS reviews,
       COALESCE(sum(remembered), 0) AS remembered,
       COALESCE(sum(first), 0) AS firsts,
       COALESCE(sum(first * remembered), 0) AS firsts_remembered
  FROM (
    SELECT substr(r.reviewed_at, 1, 10) AS date, r.remembered,
           -- A track's FIRST press: no earlier review of it. One seek on reviews_track,
           -- and only over the fortnight the chart shows (second bound): across the
           -- whole 400-day window it cost 151 -> 194 ms on the laptop, measured.
           CASE WHEN r.reviewed_at >= ? THEN NOT EXISTS (
             SELECT 1 FROM reviews p WHERE p.track_id = r.track_id AND p.reviewed_at < r.reviewed_at
           ) ELSE 0 END AS first
      FROM reviews r
     WHERE r.reviewed_at >= ?
  )
 GROUP BY date ORDER BY date`;

const ALL_TIME = `SELECT count(*) AS reviews, COALESCE(sum(remembered), 0) AS remembered FROM reviews`;

const SPAN = `SELECT min(reviewed_at) AS first_at, max(reviewed_at) AS last_at FROM reviews`;

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

const LEARNED_MONTHS = 12;

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

export function compareDeckPaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const order = compareNatural(left[i] as string, right[i] as string);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function compareNatural(a: string, b: string): number {
  const left = a.match(/\d+|\D+/g) ?? [];
  const right = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const x = left[i] as string;
    const y = right[i] as string;
    const numeric = /^\d/.test(x) && /^\d/.test(y);
    const order = numeric
      ? Number(x) - Number(y) || x.length - y.length
      : x < y
        ? -1
        : x > y
          ? 1
          : 0;
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

export function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`).getTime();
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

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
  readonly today?: string;
}

export function collectGlance(db: SqliteHandle, options: GlanceOptions = {}): Glance {
  const today =
    options.today ??
    (db.prepare("SELECT date('now','localtime') AS d").get() as { d: string }).d;

  const floor = shiftDate(today, -(WINDOW_DAYS + 1));
  const windowStart = shiftDate(today, -(WINDOW_DAYS - 1));
  const firstsFrom = shiftDate(today, -14);
  const days = (db.prepare(PER_DAY).all(firstsFrom, floor) as Record<string, unknown>[])
    .map((row) => ({
      date: String(row["date"]),
      reviews: Number(row["reviews"]),
      remembered: Number(row["remembered"]),
      firsts: Number(row["firsts"]),
      firstsRemembered: Number(row["firsts_remembered"]),
    }))
    .filter((day) => day.date >= windowStart && day.date <= today);

  const byDate = new Map(days.map((day) => [day.date, day]));
  const todayRow = byDate.get(today);

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

  const recent: GlanceDay[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const date = shiftDate(today, -i);
    recent.push(byDate.get(date) ?? { date, reviews: 0, remembered: 0, firsts: 0, firstsRemembered: 0 });
  }

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

  const learnedRows = db.prepare(LEARNED_BY_MONTH).all() as {
    month: string;
    learned: number;
  }[];
  const learnedByMonth: GlanceLearnedMonth[] = [];
  {
    const byMonth = new Map(
      learnedRows.map((row) => [String(row.month), Number(row.learned)]),
    );
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
  }))
  .sort((a, b) => compareDeckPaths(a.path, b.path));

  const counts = queueCounts(db);
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
