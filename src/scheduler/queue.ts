import type { SqliteHandle } from "../db/browser.js";

import { dueAfter, dueBefore, dueOnOrBefore, liveTrack } from "./predicates.js";
import { localDate, localDayNumber } from "./day.js";
import { dailyOrderKey } from "./schedule.js";
import { nowInHostOffset } from "./tracks.js";
import { silentCardFilter } from "./silent.js";
import {
  DEFAULT_EXAM_TARGET,
  EXAM_TARGET_KEY,
  examTierLevels,
  hasExamTierKanji,
  isExamTarget,
  type ExamTarget,
} from "./kanken.js";

export interface QueuedTrack {
  readonly trackId: number;
  readonly cardId: string;
  readonly cardName: string;
  readonly templateId: string | null;
  readonly kind: string;
  readonly deckId: string;
  readonly deckPath: string;
  readonly dueAt: string | null;
  readonly overdueDays: number;
  readonly lastReviewedAt: string | null;
  readonly scheduledDays: number | null;
  readonly reps: number;
  readonly lapses: number;
  readonly needsRereview: 0 | 1;
}

export interface QueueOptions {
  readonly now?: string;
  readonly deckId?: string;
  readonly includeSubdecks?: boolean;
  readonly kinds?: readonly string[];
  readonly limit?: number;
  readonly silentExcept?: readonly string[];
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
       t.last_reviewed_at AS last_reviewed_at,
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
  last_reviewed_at: string | null;
  lapses: number;
  needs_rereview: number;
}

const LIVE = liveTrack();

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

function silentFilter(options: QueueOptions): Filter {
  if (options.silentExcept === undefined) return { sql: "", params: [] };
  return silentCardFilter(options.silentExcept);
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
    lastReviewedAt: row.last_reviewed_at,
    lapses: row.lapses,
    needsRereview: row.needs_rereview === 1 ? 1 : 0,
  };
}

export function dueTracks(db: SqliteHandle, options: QueueOptions = {}): QueuedTrack[] {
  const now = options.now ?? nowInHostOffset();
  const today = localDate(now);
  const deck = deckFilter(options);
  const kind = kindFilter(options);
  const silent = silentFilter(options);
  const cap = limitClause(options);
  const sql =
    `${COLUMNS} WHERE ${LIVE} AND t.due_at IS NOT NULL AND ${dueOnOrBefore()}` +
    `${deck.sql}${kind.sql}${silent.sql} ORDER BY t.due_at, t.id${cap.sql}`;
  const rows = db
    .prepare(sql)
    .all(today, ...deck.params, ...kind.params, ...silent.params, ...cap.params) as RawQueueRow[];
  const todayNumber = localDayNumber(now);
  return rows.map((row) => toQueued(row, todayNumber));
}

export const PRIORITY_FIELD = "優先";

export function priorityCardIds(db: SqliteHandle): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT v.card_id AS card_id
         FROM card_field_values v
         JOIN cards c ON c.id = v.card_id
         JOIN template_fields f ON f.id = v.field_id AND f.template_id = c.template_id
        WHERE trim(f.name) = ? AND f.type = 'boolean' AND lower(trim(v.value)) = 'true'`,
    )
    .all(PRIORITY_FIELD) as { card_id: string }[];
  return new Set(rows.map((row) => row.card_id));
}

export const EXAM_TIER_DECK = "日本語";

export function examTarget(db: SqliteHandle): ExamTarget {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(EXAM_TARGET_KEY) as
      | { value?: string }
      | undefined;
    const value = row?.value?.trim() ?? "";
    return isExamTarget(value) ? value : DEFAULT_EXAM_TARGET;
  } catch {
    return DEFAULT_EXAM_TARGET;
  }
}

function examTier(row: RawQueueRow, levels: ReadonlySet<string>): boolean {
  if (levels.size === 0) return false;
  const inDeck = row.deck_path === EXAM_TIER_DECK || row.deck_path.startsWith(`${EXAM_TIER_DECK}/`);
  return inDeck && hasExamTierKanji(row.card_name, levels);
}

export const KANJI_TEMPLATE = "漢字";

function kanjiLearnedState(db: SqliteHandle): { learned: Map<string, boolean>; cards: Set<string> } {
  const rows = db
    .prepare(
      `SELECT c.id AS id, c.name AS name, max(t.reps > 0) AS learned
         FROM cards c
         JOIN templates tp ON tp.id = c.template_id
         JOIN card_tracks t ON t.card_id = c.id
        WHERE trim(tp.name) = ? AND c.archived = 0
        GROUP BY c.id`,
    )
    .all(KANJI_TEMPLATE) as { id: string; name: string; learned: number }[];
  const learned = new Map<string, boolean>();
  for (const row of rows) learned.set(row.name, learned.get(row.name) === true || row.learned === 1);
  return { learned, cards: new Set(rows.map((row) => row.id)) };
}

function kanjiFirst<T extends { row: RawQueueRow }>(ordered: readonly T[], db: SqliteHandle): T[] {
  const { learned, cards } = kanjiLearnedState(db);
  const substitute = new Map<string, T>();
  for (const entry of ordered) {
    const { row } = entry;
    if (!cards.has(row.card_id) || learned.get(row.card_name) !== false) continue;
    const held = substitute.get(row.card_name);
    if (held === undefined || (held.row.kind !== "forward" && row.kind === "forward")) substitute.set(row.card_name, entry);
  }
  if (substitute.size === 0) return [...ordered];
  const out: T[] = [];
  const emitted = new Set<number>();
  const emit = (entry: T): void => {
    if (emitted.has(entry.row.track_id)) return;
    emitted.add(entry.row.track_id);
    out.push(entry);
  };
  for (const entry of ordered) {
    const { row } = entry;
    const inDeck = row.deck_path === EXAM_TIER_DECK || row.deck_path.startsWith(`${EXAM_TIER_DECK}/`);
    const isKanjiCard = cards.has(row.card_id);
    const gates = inDeck && !isKanjiCard ? [...row.card_name].flatMap((ch) => substitute.get(ch) ?? []) : [];
    if (gates.length === 0) {
      emit(entry);
      continue;
    }
    for (const gate of gates) emit(gate);
  }
  return out;
}

export function newTracks(db: SqliteHandle, options: QueueOptions = {}): QueuedTrack[] {
  const now = options.now ?? nowInHostOffset();
  const deck = deckFilter(options);
  const kind = kindFilter(options);
  const silent = silentFilter(options);
  const sql =
    `${COLUMNS} WHERE ${LIVE} AND t.due_at IS NULL AND t.reps = 0` +
    `${deck.sql}${kind.sql}${silent.sql} ORDER BY t.id`;
  const rows = db
    .prepare(sql)
    .all(...deck.params, ...kind.params, ...silent.params) as RawQueueRow[];
  const todayNumber = localDayNumber(now);
  const priority = priorityCardIds(db);
  const levels = examTierLevels(examTarget(db));
  const shuffled = rows
    .map((row) => ({
      row,
      tier: priority.has(row.card_id) && row.kind === "forward" ? 0 : examTier(row, levels) ? 1 : 2,
      key: dailyOrderKey(todayNumber, row.track_id),
    }))
    .sort((a, b) => a.tier - b.tier || a.key - b.key || a.row.track_id - b.row.track_id);
  const ordered = kanjiFirst(shuffled, db);
  const limited =
    options.limit === undefined ? ordered : ordered.slice(0, Math.max(0, options.limit));
  return limited.map(({ row }) => toQueued(row, todayNumber));
}

export interface QueueCounts {
  readonly due: number;
  readonly overdue: number;
  readonly fresh: number;
  readonly scheduled: number;
  readonly dormant: number;
  readonly asOf: string;
}

const COUNTS = `
SELECT sum(CASE WHEN t.dormant = 0 AND t.due_at IS NOT NULL
                 AND ${dueOnOrBefore()} THEN 1 ELSE 0 END)   AS due,
       sum(CASE WHEN t.dormant = 0 AND t.due_at IS NOT NULL
                 AND ${dueBefore()} THEN 1 ELSE 0 END)   AS overdue,
       sum(CASE WHEN t.dormant = 0 AND t.due_at IS NULL AND t.reps = 0
                THEN 1 ELSE 0 END)                                     AS fresh,
       sum(CASE WHEN t.dormant = 0 AND t.due_at IS NOT NULL
                 AND ${dueAfter()} THEN 1 ELSE 0 END)   AS scheduled,
       sum(CASE WHEN t.dormant = 1 THEN 1 ELSE 0 END)                  AS dormant
  FROM card_tracks t
  JOIN cards c ON c.id = t.card_id
 WHERE c.archived = 0`;

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
  readonly date: string;
  readonly count: number;
}

const FORECAST = `
SELECT substr(t.due_at, 1, 10) AS date, count(*) AS count
  FROM card_tracks t
  JOIN cards c ON c.id = t.card_id
 WHERE t.dormant = 0 AND c.archived = 0
   AND t.due_at IS NOT NULL
   AND ${dueAfter()}
   AND ${dueOnOrBefore()}`;

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
