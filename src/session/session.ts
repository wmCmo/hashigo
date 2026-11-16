import {
  audibleTemplateIds,
  dueTracks,
  gradeTrack,
  localDate,
  newTracks,
  nowInHostOffset,
  snapshotTrack,
  ungradeTrack,
  type GradedReview,
  type QueuedTrack,
  type TrackSnapshot,
} from "../scheduler/index.js";
import { readSessionSettings, readSetting } from "./settings.js";
import { endOfDay, keptDay, LATE_NIGHT_ENDED_KEY, LATE_NIGHT_KEY, sinceForToday } from "./late-night.js";

import type { SqliteHandle } from "../db/browser.js";

export const DEFAULT_NEW_LIMIT = 10;

export type InterleavePolicy = "new-first" | "due-first" | "spread";

export const DEFAULT_INTERLEAVE: InterleavePolicy = "spread";

export const EXPECTED_SESSION_CARDS = 80;

export interface SessionOptions {
  readonly now?: string;
  readonly newLimit?: number;
  readonly dueLimit?: number;
  readonly interleave?: InterleavePolicy;
  readonly spreadOver?: number;
  readonly deckId?: string;
  readonly includeSubdecks?: boolean;
  readonly kinds?: readonly string[];
  readonly silent?: boolean;
}

export interface SessionItem {
  readonly trackId: number;
  readonly cardId: string;
  readonly kind: string;
  readonly origin: "due" | "new";
  readonly reask: boolean;
  readonly track: QueuedTrack;
}

export interface AnswerResult {
  readonly item: SessionItem;
  readonly graded: boolean;
  readonly review: GradedReview | null;
  readonly queuedReask: boolean;
  readonly undo: { readonly reviewId: number; readonly snapshot: TrackSnapshot } | null;
  readonly dismissedAt?: number;
}

export interface SessionProgress {
  readonly planned: number;
  readonly answered: number;
  readonly dueCount: number;
  readonly newCount: number;
  readonly reasksQueued: number;
  readonly reasksRemaining: number;
  readonly remaining: number;
  readonly done: boolean;

  readonly answeredToday: number;
  readonly missedToday: number;
  readonly plannedToday: number;
}

export class SessionCompleteError extends Error {
  constructor() {
    super("the session has no current item; check `done` before answering");
    this.name = "SessionCompleteError";
  }
}

export function interleaveTracks(
  due: readonly SessionItem[],
  fresh: readonly SessionItem[],
  policy: InterleavePolicy,
  spreadOver: number = EXPECTED_SESSION_CARDS,
): SessionItem[] {
  if (fresh.length === 0) return [...due];
  if (due.length === 0) return [...fresh];
  if (policy === "new-first") return [...fresh, ...due];
  if (policy === "due-first") return [...due, ...fresh];

  const total = due.length + fresh.length;
  const window = Math.min(total, Math.max(spreadOver, 2 * fresh.length));

  const slots = new Set<number>();
  for (let i = 0; i < fresh.length; i += 1) {
    slots.add(Math.floor(((i + 0.5) * window) / fresh.length));
  }
  const out: SessionItem[] = [];
  let d = 0;
  let f = 0;
  for (let position = 0; position < total; position += 1) {
    if (slots.has(position) && f < fresh.length) out.push(fresh[f++]!);
    else if (d < due.length) out.push(due[d++]!);
    else if (f < fresh.length) out.push(fresh[f++]!);
  }
  return out;
}

function toItem(track: QueuedTrack, origin: "due" | "new"): SessionItem {
  return {
    trackId: track.trackId,
    cardId: track.cardId,
    kind: track.kind,
    origin,
    reask: false,
    track,
  };
}

export class ReviewSession {
  private readonly db: SqliteHandle;
  private readonly plan: SessionItem[];
  private readonly reasks: SessionItem[] = [];
  private cursor = 0;
  private readonly today: string;

  private readonly through: boolean;
  private readonly since: string | null;

  constructor(
    db: SqliteHandle,
    plan: readonly SessionItem[],
    today: string,
    through = false,
    since: string | null = null,
  ) {
    this.db = db;
    this.plan = [...plan];
    this.today = today;
    this.through = through;
    this.since = since;
  }

  peek(offset: number): SessionItem | null {
    const at = this.cursor + offset;
    if (at < 0) return null;
    if (at < this.plan.length) return this.plan[at] ?? null;
    const tail = at - this.plan.length;
    return tail < this.reasks.length ? (this.reasks[tail] ?? null) : null;
  }

  current(): SessionItem | null {
    if (this.cursor < this.plan.length) return this.plan[this.cursor] ?? null;
    const tail = this.cursor - this.plan.length;
    return tail < this.reasks.length ? (this.reasks[tail] ?? null) : null;
  }

  get done(): boolean {
    return this.current() === null;
  }

  answer(
    remembered: boolean,
    options: { readonly at?: string; readonly durationMs?: number | null } = {},
  ): AnswerResult {
    const item = this.current();
    if (item === null) throw new SessionCompleteError();

    if (item.reask) {
      this.cursor += 1;
      return { item, graded: false, review: null, queuedReask: false, undo: null };
    }

    const snapshot = snapshotTrack(this.db, item.trackId);
    const at = options.at ?? this.lateNightStamp();
    const review = gradeTrack(this.db, {
      trackId: item.trackId,
      remembered: remembered ? 1 : 0,
      ...(at === undefined ? {} : { reviewedAt: at }),
      ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    });

    let queuedReask = false;
    if (!remembered) {
      this.reasks.push({ ...item, reask: true });
      queuedReask = true;
    }
    this.cursor += 1;
    return { item, graded: true, review, queuedReask, undo: { reviewId: review.reviewId, snapshot } };
  }

  answerAt(
    offset: number,
    remembered: boolean,
    options: { readonly at?: string; readonly durationMs?: number | null } = {},
  ): AnswerResult | { readonly refused: "already-answered" | "nothing-there" } {
    if (offset === 0) return this.answer(remembered, options);
    if (offset < 0) return { refused: "already-answered" };

    const at = this.cursor + offset;
    if (at >= this.plan.length) {
      const tail = at - this.plan.length;
      const item = this.reasks[tail];
      if (item === undefined) return { refused: "nothing-there" };
      this.reasks.splice(tail, 1);
      return { item, graded: false, review: null, queuedReask: false, undo: null, dismissedAt: tail };
    }
    if (this.cursor >= this.plan.length) return { refused: "nothing-there" };

    const [there] = this.plan.splice(at, 1) as [SessionItem];
    this.plan.splice(this.cursor, 0, there);

    return this.answer(remembered, options);
  }

  unanswer(result: AnswerResult): void {
    if (result.dismissedAt !== undefined) {
      this.reasks.splice(result.dismissedAt, 0, result.item);
      return;
    }
    if (this.cursor === 0) throw new Error("nothing has been answered in this session");

    if (result.undo !== null) ungradeTrack(this.db, result.undo);

    if (result.queuedReask) {
      const popped = this.reasks.pop();
      if (popped === undefined) throw new Error("queuedReask was true but no re-ask is queued");
    }
    this.cursor -= 1;
  }

  skipCurrent(): boolean {
    if (this.current() === null) return false;
    this.cursor += 1;
    return true;
  }

  private lateNightStamp(): string | undefined {
    if (readSetting(this.db, LATE_NIGHT_KEY) !== this.today) return undefined;
    const now = nowInHostOffset();
    return localDate(now) > this.today ? endOfDay(this.today, now) : undefined;
  }

  private countAnsweredToday(): { answered: number; missed: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN remembered = 0 THEN 1 ELSE 0 END) AS missed
           FROM reviews
          WHERE reviewed_at >= ? AND substr(reviewed_at, 1, 10) ${this.through ? ">=" : "="} ?
            AND reviewed_at > ?`,
      )
      .get(this.today, this.today, this.since ?? "") as { n: number; missed: number | null } | undefined;
    return { answered: row?.n ?? 0, missed: row?.missed ?? 0 };
  }

  progress(): SessionProgress {
    const answeredFresh = Math.min(this.cursor, this.plan.length);
    const reasksShown = Math.max(0, this.cursor - this.plan.length);
    const today = this.countAnsweredToday();
    const answeredToday = today.answered;
    return {
      planned: this.plan.length,
      answered: answeredFresh,
      answeredToday,
      missedToday: today.missed,
      plannedToday: answeredToday + (this.plan.length - answeredFresh),
      dueCount: this.plan.filter((i) => i.origin === "due").length,
      newCount: this.plan.filter((i) => i.origin === "new").length,
      reasksQueued: this.reasks.length,
      reasksRemaining: this.reasks.length - reasksShown,
      remaining: this.plan.length - answeredFresh + (this.reasks.length - reasksShown),
      done: this.done,
    };
  }

  planned(): readonly SessionItem[] {
    return this.plan;
  }
}

export function newTracksStartedOn(
  db: SqliteHandle,
  today: string,
  through = false,
  since: string | null = null,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT r.track_id) AS n
         FROM reviews r
        WHERE r.reviewed_at >= ? AND substr(r.reviewed_at, 1, 10) ${through ? ">=" : "="} ?
          AND r.reviewed_at > ?
          AND NOT EXISTS (SELECT 1 FROM reviews p
                           WHERE p.track_id = r.track_id AND p.reviewed_at < ?)`,
    )
    .get(today, today, since ?? "", today) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function buildSession(db: SqliteHandle, options: SessionOptions = {}): ReviewSession {
  const realNow = options.now ?? nowInHostOffset();
  const kept = keptDay(readSetting(db, LATE_NIGHT_KEY), localDate(realNow));
  const now = kept === null ? realNow : endOfDay(kept, realNow);
  const since = kept === null ? sinceForToday(readSetting(db, LATE_NIGHT_ENDED_KEY), localDate(now)) : null;
  const stored = readSessionSettings(db);
  const newLimit =
    options.newLimit ?? Math.max(0, stored.newLimit - newTracksStartedOn(db, localDate(now), kept !== null, since));
  const shared = {
    now,
    ...(options.deckId === undefined ? {} : { deckId: options.deckId }),
    ...(options.includeSubdecks === undefined
      ? {}
      : { includeSubdecks: options.includeSubdecks }),
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    ...(options.silent === true ? { silentExcept: audibleTemplateIds(db) } : {}),
  };

  const due = dueTracks(db, {
    ...shared,
    ...(options.dueLimit === undefined ? {} : { limit: options.dueLimit }),
  }).map((t) => toItem(t, "due"));

  const fresh =
    newLimit <= 0 ? [] : newTracks(db, { ...shared, limit: newLimit }).map((t) => toItem(t, "new"));

  const plan = interleaveTracks(
    due,
    fresh,
    options.interleave ?? stored.interleave,
    options.spreadOver ?? EXPECTED_SESSION_CARDS,
  );
  return new ReviewSession(db, plan, localDate(now), kept !== null, since);
}
