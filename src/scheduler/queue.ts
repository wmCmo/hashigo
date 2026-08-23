/**
 * Stage 6 — what to review, and how much of it is left.
 *
 * The queue reader. It does not render anything, does not decide how new cards
 * interleave with due ones, and does not hold a session — those are stage 7's,
 * and two of them are Zach's taste rather than a measurement. What it does is
 * answer the four questions any review screen has to ask: what is due, what is
 * new, how many of each, and what is coming.
 *
 * DUE IS COMPARED BY LOCAL DATE, NOT BY INSTANT, and the SQL says so:
 * `substr(due_at, 1, 10) <= :today`. Two reasons, and the second is the one
 * that would have bitten.
 *
 *   * A due date is local midnight by construction (`./day.ts`), and the first
 *     ten characters of an RFC 3339 timestamp ARE its local date — that is what
 *     writing the offset out means. `loadHistory` in the backtest already reads
 *     `reviewed_at.slice(0, 10)` the same way.
 *   * Comparing instants across offsets needs `julianday()` on both sides, and
 *     comparing the raw strings lexically is WRONG the moment two offsets are in
 *     play: `2026-08-22T00:00:00+09:00` sorts after `2026-08-22T00:00:00Z`
 *     although it is nine hours earlier. Every due date in the corpus carries
 *     +09:00 today, so a lexical comparison would work until the first review
 *     taken abroad and then quietly misjudge a day's worth of cards.
 *
 * The cost of that is a scan of `card_tracks` instead of a seek on
 * `card_tracks_due`. MEASURED against the real 74 MB database, 13,392 tracks,
 * median of seven runs each — the reason this is a footnote and not a problem:
 *
 *     queueCounts               9.2 ms      one scan, five counts
 *     dueTracks, all 443 rows   3.1 ms
 *     dueTracks, limit 1        0.2 ms      what the review screen actually calls
 *     reviewForecast, 30 days   3.6 ms
 *     dueTracks, one deck      10.1 ms      the deck_ancestry subquery, 3x
 *
 * Node and better-sqlite3; the browser figure is not this one and is not yet
 * measured — `notes/archive/browser-feasibility.md` has the OPFS read numbers this would
 * sit on. The index stays right for anything that wants a date RANGE, which is
 * what `reviewForecast` would use if 3.6 ms ever mattered.
 *
 * NEW IS `due_at IS NULL AND reps = 0`, which is SPEC's rule ("derives `new?`
 * from an empty track rather than storing it") and describes 4,366 of the 13,392
 * imported tracks — 3,980 once archived cards are excluded — cards he has added
 * in Mochi and not yet studied.
 * They are returned SEPARATELY from due cards, deliberately: how many new cards
 * a session should introduce, and whether they come first or mixed in, changes
 * what studying feels like, and it is not a question this file can answer from
 * the data.
 */

import type { SqliteHandle } from "../db/browser.js";

import { localDate, localDayNumber } from "./day.js";
import { dailyOrderKey } from "./schedule.js";
import { nowInHostOffset } from "./tracks.js";

/** One row of the queue: a track, with everything the UI needs to name it. */
export interface QueuedTrack {
  readonly trackId: number;
  readonly cardId: string;
  readonly cardName: string;
  readonly templateId: string | null;
  readonly kind: string;
  readonly deckId: string;
  readonly deckPath: string;
  readonly dueAt: string | null;
  /** Whole days late. 0 when due today; negative is impossible in this queue. */
  readonly overdueDays: number;
  readonly scheduledDays: number | null;
  readonly reps: number;
  readonly lapses: number;
  /** The per-track leech flag — three parallel flags in the export. */
  readonly needsRereview: 0 | 1;
}

export interface QueueOptions {
  /**
   * The instant "now" is taken to be, RFC 3339 with an offset. Defaults to now
   * in the host's offset. Only its LOCAL DATE is used.
   */
  readonly now?: string;
  /** Restrict to one deck. */
  readonly deckId?: string;
  /** Include the deck's descendants. Default true — a deck means its subtree. */
  readonly includeSubdecks?: boolean;
  /** Restrict to `forward`, `reverse`, or a cloze kind. */
  readonly kinds?: readonly string[];
  /** Cap the rows returned. Counts are unaffected; `queueCounts` has no cap. */
  readonly limit?: number;
}

const COLUMNS = `
SELECT t.id             AS track_id,
       t.card_id        AS card_id,
       c.name           AS card_name,
       c.template_id    AS template_id,
       t.kind           AS kind,
       c.deck_id        AS deck_id,
       coalesce(dp.path, '(unknown)') AS deck_path,
       t.due_at         AS due_at,
       t.scheduled_days AS scheduled_days,
       t.reps           AS reps,
       t.lapses         AS lapses,
       t.needs_rereview AS needs_rereview
  FROM card_tracks t
  JOIN cards c ON c.id = t.card_id
  LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id`;

interface RawQueueRow {
  track_id: number;
  card_id: string;
  card_name: string;
  template_id: string | null;
  kind: string;
  deck_id: string;
  deck_path: string;
  due_at: string | null;
  scheduled_days: number | null;
  reps: number;
  lapses: number;
  needs_rereview: number;
}

/**
 * The clause every query here shares: a live card, a scheduled track.
 *
 * NEITHER HALF IS DECORATIVE, and I checked rather than assuming. Measured on
 * the real export at 2026-08-22:
 *
 *   * `c.archived = 0` removes 234 archived cards carrying 451 tracks — 386
 *     never reviewed, 65 with a due date, **33 of them due today or earlier**.
 *     Without this clause today's queue would be 476 rather than 443, a tenth of
 *     it cards he archived deliberately.
 *   * `t.dormant = 0` removes nothing today: zero tracks are dormant, because
 *     the importer only reaches dormant for a disabled reverse track that has
 *     history and the invariant holds across the corpus. It is here so that
 *     turning a card's reverse off stops scheduling it without destroying its
 *     history — SPEC: "No scheduling toggle should ever destroy four years."
 */
const LIVE = `t.dormant = 0 AND c.archived = 0`;

interface Filter {
  readonly sql: string;
  readonly params: unknown[];
}

function deckFilter(options: QueueOptions): Filter {
  if (options.deckId === undefined) return { sql: "", params: [] };
  if (options.includeSubdecks === false) {
    return { sql: ` AND c.deck_id = ?`, params: [options.deckId] };
  }
  return {
    sql: ` AND c.deck_id IN (SELECT deck_id FROM deck_ancestry WHERE ancestor_id = ?)`,
    params: [options.deckId],
  };
}

function kindFilter(options: QueueOptions): Filter {
  const kinds = options.kinds;
  if (kinds === undefined || kinds.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND t.kind IN (${kinds.map(() => "?").join(", ")})`,
    params: [...kinds],
  };
}

function limitClause(options: QueueOptions): Filter {
  const limit = options.limit;
  if (limit === undefined) return { sql: "", params: [] };
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`limit must be a non-negative integer, got ${limit}`);
  }
  return { sql: ` LIMIT ?`, params: [limit] };
}

function toQueued(row: RawQueueRow, today: number): QueuedTrack {
  return {
    trackId: row.track_id,
    cardId: row.card_id,
    cardName: row.card_name,
    templateId: row.template_id,
    kind: row.kind,
    deckId: row.deck_id,
    deckPath: row.deck_path,
    dueAt: row.due_at,
    overdueDays: row.due_at === null ? 0 : today - localDayNumber(row.due_at),
    scheduledDays: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    needsRereview: row.needs_rereview === 1 ? 1 : 0,
  };
}

/**
 * Everything due on or before `now`'s local date, most overdue first.
 *
 * Ordering: `due_at` ascending, then `t.id`, so the queue is deterministic and
 * the oldest debt is paid first. `t.id` rather than the card's `pos` because two
 * tracks of the same card must not tie — the forward and reverse of one card
 * both being due is the commonest case in this corpus.
 */
export function dueTracks(db: SqliteHandle, options: QueueOptions = {}): QueuedTrack[] {
  const now = options.now ?? nowInHostOffset();
  const today = localDate(now);
  const deck = deckFilter(options);
  const kind = kindFilter(options);
  const cap = limitClause(options);
  const sql =
    `${COLUMNS} WHERE ${LIVE} AND t.due_at IS NOT NULL AND substr(t.due_at, 1, 10) <= ?` +
    `${deck.sql}${kind.sql} ORDER BY t.due_at, t.id${cap.sql}`;
  const rows = db.prepare(sql).all(today, ...deck.params, ...kind.params, ...cap.params) as
    RawQueueRow[];
  const todayNumber = localDayNumber(now);
  return rows.map((row) => toQueued(row, todayNumber));
}

/**
 * Tracks that have never been reviewed — SPEC's `new?`, derived rather than
 * stored. Returned in a RANDOM but STABLE order, and `limit` is applied to that
 * order rather than in SQL.
 *
 * DECISION 15, AND THE TRAP IT CLOSES. Zach wants 10 new TRACKS a day, picked at
 * random, with a card's forward and reverse not paired: "both forward and reverse
 * doesn't have to be studied on the same day because it's random from the cards i
 * haven't learned".
 *
 * This used to order by `c.pos, c.id, t.id` — authoring order — and its docstring
 * said shuffling was "a choice the review screen can make later". **That is false
 * the moment a `limit` exists.** A `LIMIT 10` on a sorted query has already chosen
 * WHICH ten; the caller can only permute what it was handed. Taking the first ten
 * of an authored list and shuffling them is not taking ten at random from 3,980.
 *
 * WHAT THE OLD BEHAVIOUR ACTUALLY DID, measured rather than reasoned: it returned
 * track ids `1, 2, 3, 8, 12, 20, 26, 28, 30, 34` — the literal front of the list —
 * and **the same ten every single day**, so the backlog would have been worked in
 * authoring order forever. An earlier version of this comment also claimed it
 * delivered "~5 cards as forward/reverse pairs". That was wrong: measured, those
 * ten tracks span ten DISTINCT cards, because a card's two tracks are rarely both
 * new. The pairing risk decision 15 rules out does not occur in this corpus; the
 * no-randomness defect is the whole of the real bug.
 *
 * So the order is decided HERE, and the limit is applied after it. The key is
 * `dailyOrderKey(localDay, trackId)`, not `Math.random()`: one day gives one
 * order, so re-reading the queue mid-session does not reshuffle it, and a new day
 * deals a new hand. Same reasoning as interval fuzz being keyed rather than
 * random.
 *
 * THE COST, MEASURED, because the limit no longer reaches the database. Against
 * the real 74 MB corpus, 3,980 unlearned tracks, Node and better-sqlite3, median
 * of seven runs:
 *
 *     unlimited (3,980 rows)   14.8 ms
 *     limit 10                 13.9 ms
 *     limit 1                  12.2 ms      was 0.2 ms when LIMIT was in SQL
 *
 * The limit barely matters now, which is the point: the whole set is read and
 * ordered either way. 13.9 ms once per session for a day's new cards is paid
 * where it does not matter. If it ever does, the fix is a keyed order expression
 * in SQL — but that means reimplementing `hash32` in two dialects and keeping
 * them identical, which is a worse trade than 14 ms.
 */
export function newTracks(db: SqliteHandle, options: QueueOptions = {}): QueuedTrack[] {
  const now = options.now ?? nowInHostOffset();
  const deck = deckFilter(options);
  const kind = kindFilter(options);
  const sql =
    `${COLUMNS} WHERE ${LIVE} AND t.due_at IS NULL AND t.reps = 0` +
    `${deck.sql}${kind.sql} ORDER BY t.id`;
  const rows = db.prepare(sql).all(...deck.params, ...kind.params) as RawQueueRow[];
  const todayNumber = localDayNumber(now);
  const shuffled = rows
    .map((row) => ({ row, key: dailyOrderKey(todayNumber, row.track_id) }))
    // `key` collisions are possible over 32 bits; `track_id` breaks the tie so
    // the order is total and reproducible rather than dependent on sort stability.
    .sort((a, b) => a.key - b.key || a.row.track_id - b.row.track_id);
  const limited =
    options.limit === undefined ? shuffled : shuffled.slice(0, Math.max(0, options.limit));
  return limited.map(({ row }) => toQueued(row, todayNumber));
}

export interface QueueCounts {
  /** Due on or before today's local date. */
  readonly due: number;
  /** Of those, due strictly before today — the backlog. */
  readonly overdue: number;
  /** Never reviewed. */
  readonly fresh: number;
  /** Scheduled, not yet due. */
  readonly scheduled: number;
  /** Retained but not scheduled. Reported rather than hidden. */
  readonly dormant: number;
  /** The local date the counts were taken against. */
  readonly asOf: string;
}

// Positional parameters throughout, and `?` for today three times rather than a
// named `:today` once: better-sqlite3 refuses to mix named and anonymous
// parameters in one statement, and the deck and kind filters below are built
// positionally. One binding style is worth three repeated arguments.
//
// ONE SCAN, including the dormant count. `dormant` used to be a second
// statement, and the pair measured 15.5 ms median against the real database
// where this measures 7.9 — the count is a `CASE` over the same rows, so asking
// twice was paying twice for nothing.
const COUNTS = `
SELECT sum(CASE WHEN t.dormant = 0 AND t.due_at IS NOT NULL
                 AND substr(t.due_at, 1, 10) <= ? THEN 1 ELSE 0 END)   AS due,
       sum(CASE WHEN t.dormant = 0 AND t.due_at IS NOT NULL
                 AND substr(t.due_at, 1, 10) <  ? THEN 1 ELSE 0 END)   AS overdue,
       sum(CASE WHEN t.dormant = 0 AND t.due_at IS NULL AND t.reps = 0
                THEN 1 ELSE 0 END)                                     AS fresh,
       sum(CASE WHEN t.dormant = 0 AND t.due_at IS NOT NULL
                 AND substr(t.due_at, 1, 10) >  ? THEN 1 ELSE 0 END)   AS scheduled,
       sum(CASE WHEN t.dormant = 1 THEN 1 ELSE 0 END)                  AS dormant
  FROM card_tracks t
  JOIN cards c ON c.id = t.card_id
 WHERE c.archived = 0`;

/**
 * The numbers the review screen and the dashboard both want. One scan.
 *
 * `due + overdue` is not a total — overdue is a SUBSET of due, named separately
 * because "42 due" and "42 due, 38 of them from before today" are different
 * facts about a morning, and the second is the one that says he took a week off.
 */
export function queueCounts(db: SqliteHandle, options: QueueOptions = {}): QueueCounts {
  const now = options.now ?? nowInHostOffset();
  const today = localDate(now);
  const deck = deckFilter(options);
  const kind = kindFilter(options);
  const row = db
    .prepare(`${COUNTS}${deck.sql}${kind.sql}`)
    .get(today, today, today, ...deck.params, ...kind.params) as {
    due: number | null;
    overdue: number | null;
    fresh: number | null;
    scheduled: number | null;
    dormant: number | null;
  };
  return {
    due: row.due ?? 0,
    overdue: row.overdue ?? 0,
    fresh: row.fresh ?? 0,
    scheduled: row.scheduled ?? 0,
    dormant: row.dormant ?? 0,
    asOf: today,
  };
}

export interface ForecastDay {
  /** Local date, `2026-08-22`. */
  readonly date: string;
  /** Tracks falling due that day. */
  readonly count: number;
}

const FORECAST = `
SELECT substr(t.due_at, 1, 10) AS date, count(*) AS count
  FROM card_tracks t
  JOIN cards c ON c.id = t.card_id
 WHERE t.dormant = 0 AND c.archived = 0
   AND t.due_at IS NOT NULL
   AND substr(t.due_at, 1, 10) > ?
   AND substr(t.due_at, 1, 10) <= ?`;

/**
 * 復習予測 — the one dashboard tile SPEC defers until the scheduler exists.
 *
 * Everything due on or before today is already in `queueCounts().due` and is
 * deliberately NOT folded in here: a forecast that silently includes a backlog
 * of 3,000 overdue cards on its first bar is a chart about the past.
 *
 * A day with nothing due IS RETURNED, with count 0. A bar chart that omits its
 * empty days compresses a quiet fortnight into a dense one and shows a workload
 * that does not exist.
 */
export function reviewForecast(
  db: SqliteHandle,
  options: QueueOptions & { readonly days?: number } = {},
): ForecastDay[] {
  const days = options.days ?? 30;
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`days must be a positive integer, got ${days}`);
  }
  const now = options.now ?? nowInHostOffset();
  const today = localDate(now);
  const todayNumber = localDayNumber(now);
  const deck = deckFilter(options);
  const kind = kindFilter(options);

  const dates: string[] = [];
  for (let i = 1; i <= days; i += 1) {
    dates.push(new Date((todayNumber + i) * 86_400_000).toISOString().slice(0, 10));
  }
  const until = dates[dates.length - 1] as string;

  const rows = db
    .prepare(`${FORECAST}${deck.sql}${kind.sql} GROUP BY date`)
    .all(today, until, ...deck.params, ...kind.params) as { date: string; count: number }[];
  const counts = new Map(rows.map((row) => [row.date, row.count]));
  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}
