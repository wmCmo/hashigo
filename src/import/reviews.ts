import type { Db } from "../db/index.js";
import {
  clozeTrack,
  resolveReverseInheritance,
  type ReverseInheritance,
  type ReverseMode,
  type TrackKind,
} from "../schema/index.js";

export const JST_OFFSET_MINUTES = 540;

export type ResolvedReverse = Exclude<ReverseMode, "inherit">;

export const MOCHI_REVIEW_ARRAYS = [
  { key: "reviews", track: "forward" },
  { key: "reverse-reviews", track: "reverse" },
  { key: "cloze/reviews", track: "cloze" },
] as const;

export type MochiInstant = Date | number | string;

export interface MochiReviewRecord {
  readonly date?: MochiInstant | null;
  readonly due?: MochiInstant | null;
  readonly interval?: number | null;
  readonly duration?: number | null;
  readonly "remembered?"?: boolean | null;
  readonly "rereview?"?: unknown;
}

export interface MochiCard {
  readonly id: string;
  readonly "deck-id"?: string | null;
  readonly "review-reverse?"?: unknown;
  readonly reviews?: readonly MochiReviewRecord[] | null;
  readonly "reverse-reviews"?: readonly MochiReviewRecord[] | null;
  readonly "cloze/reviews"?: readonly MochiReviewRecord[] | null;
  readonly "cloze/indexes"?: readonly unknown[] | null;
  readonly "needs-rereview?"?: unknown;
  readonly "reverse/needs-rereview?"?: unknown;
  readonly "cloze/needs-rereview?"?: unknown;
}

export interface MochiDeck {
  readonly id: string;
  readonly "parent-id"?: string | null;
  readonly "review-reverse?"?: unknown;
}

export interface PlannedReview {
  readonly importKey: string;
  readonly reviewedAt: string;
  readonly tzOffsetMinutes: number;
  readonly timeUnknown: 0 | 1;
  readonly remembered: 0 | 1;
  readonly elapsedDays: number | null;
  readonly scheduledDays: number | null;
  readonly nextScheduledDays: number | null;
  readonly dueAt: string | null;
  readonly durationMs: number | null;
  readonly rereview: 0 | 1;
  readonly source: "mochi";
}

export interface PlannedTrack {
  readonly cardId: string;
  readonly kind: TrackKind;
  readonly dormant: 0 | 1;
  readonly needsRereview: 0 | 1;
  readonly dueAt: string | null;
  readonly scheduledDays: number | null;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewedAt: string | null;
  readonly scheduler: "mochi" | null;
  readonly reviews: readonly PlannedReview[];
}

export interface ReverseResolution {
  readonly cardValue: ReverseMode;
  readonly deckValue: ResolvedReverse;
  readonly reverse: ResolvedReverse;
  readonly forced: boolean;
}

export interface PlanOptions {
  readonly tzOffsetMinutes?: number;
  readonly timeKnown?: boolean;
}

export interface ImportOptions extends PlanOptions {
  readonly decks?: Iterable<MochiDeck>;
  readonly deckReverse?: ReadonlyMap<string, ResolvedReverse>;
  readonly workspaceReverseDefault?: ResolvedReverse;
  readonly enforceReverseInvariant?: boolean;
}

export interface ImportReviewsResult {
  readonly cards: number;
  readonly tracks: number;
  readonly tracksByKind: Readonly<Record<string, number>>;
  readonly tracksPreserved: number;
  readonly reviews: number;
  readonly reviewsByKind: Readonly<Record<string, number>>;
  readonly passed: number;
  readonly lapses: number;
  readonly retention: number | null;
  readonly reverseEnabled: number;
  readonly reverseForced: readonly string[];
  readonly reviewsWithoutScheduled: number;
  readonly reviewsWithoutElapsed: number;
  readonly reviewsElapsedOnly: number;
  readonly reviewsWithoutDuration: number;
  readonly reviewsTimeUnknown: number;
  readonly firstReviewedAt: string | null;
  readonly lastReviewedAt: string | null;
}

function isTrue(value: unknown): boolean {
  return value === true;
}

function reviewRecords(value: unknown): readonly MochiReviewRecord[] {
  return Array.isArray(value) ? (value as readonly MochiReviewRecord[]) : [];
}

const MS_PER_DAY = 86_400_000;

function epochMs(value: MochiInstant): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError(`not a decodable instant: ${value}`);
  return parsed;
}

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, "0");
}

export function formatInstant(value: MochiInstant, offsetMinutes: number): string {
  const ms = epochMs(value);
  const local = new Date(ms + offsetMinutes * 60_000);
  const millis = local.getUTCMilliseconds();
  const sign = offsetMinutes < 0 ? "-" : "+";
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    (millis === 0 ? "" : `.${pad(millis, 3)}`) +
    `${sign}${pad(Math.trunc(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
  );
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function mochiCardReverse(card: MochiCard): ReverseMode {
  return isTrue(card["review-reverse?"]) ? "on" : "inherit";
}

export function mochiDeckReverse(deck: MochiDeck): ReverseMode {
  return isTrue(deck["review-reverse?"]) ? "on" : "inherit";
}

export function hasReverseHistory(card: MochiCard): boolean {
  return reviewRecords(card["reverse-reviews"]).length > 0;
}

export function resolveDeckReverse(
  deckId: string | null | undefined,
  decks: ReadonlyMap<string, MochiDeck>,
  workspaceDefault: ResolvedReverse = "off",
): ResolvedReverse {
  const nodes = new Map<string, ReverseInheritance>();
  for (const [id, deck] of decks) {
    nodes.set(id, {
      id,
      parentId: deck["parent-id"] ?? null,
      reverse: mochiDeckReverse(deck),
    });
  }
  return resolveReverseInheritance(nodes, deckId, workspaceDefault);
}

export function buildDeckReverseMap(
  decks: Iterable<MochiDeck>,
  workspaceDefault: ResolvedReverse = "off",
): ReadonlyMap<string, ResolvedReverse> {
  const byId = new Map<string, MochiDeck>();
  for (const deck of decks) byId.set(deck.id, deck);
  const resolved = new Map<string, ResolvedReverse>();
  for (const id of byId.keys()) resolved.set(id, resolveDeckReverse(id, byId, workspaceDefault));
  return resolved;
}

export function resolveCardReverse(
  card: MochiCard,
  deckValue: ResolvedReverse,
  enforceInvariant = true,
): ReverseResolution {
  const cardValue = mochiCardReverse(card);
  const inherited: ResolvedReverse = cardValue === "inherit" ? deckValue : cardValue;
  const mustBeOn = enforceInvariant && inherited !== "on" && hasReverseHistory(card);
  return {
    cardValue,
    deckValue,
    reverse: mustBeOn ? "on" : inherited,
    forced: mustBeOn,
  };
}

function trackKindFor(card: MochiCard, array: (typeof MOCHI_REVIEW_ARRAYS)[number]): TrackKind {
  if (array.track === "forward" || array.track === "reverse") return array.track;
  const first = (card["cloze/indexes"] ?? [])[0];
  return clozeTrack(typeof first === "number" && Number.isInteger(first) && first >= 0 ? first : 0);
}

function needsRereviewFor(card: MochiCard, track: "forward" | "reverse" | "cloze"): 0 | 1 {
  const key =
    track === "forward"
      ? "needs-rereview?"
      : track === "reverse"
        ? "reverse/needs-rereview?"
        : "cloze/needs-rereview?";
  return isTrue(card[key]) ? 1 : 0;
}

export function planCardTracks(
  card: MochiCard,
  reverse: ResolvedReverse,
  options: PlanOptions = {},
): readonly PlannedTrack[] {
  const offset = options.tzOffsetMinutes ?? JST_OFFSET_MINUTES;
  const timeUnknown: 0 | 1 = options.timeKnown === true ? 0 : 1;
  const tracks: PlannedTrack[] = [];

  for (const array of MOCHI_REVIEW_ARRAYS) {
    const records = reviewRecords(card[array.key]);
    const enabled = array.track === "forward" || (array.track === "reverse" && reverse === "on");
    if (!enabled && records.length === 0) continue;

    const kind = trackKindFor(card, array);

    const indexed = records.map((record, index) => ({ record, index }));
    indexed.sort((a, b) => {
      const at = a.record.date == null ? 0 : epochMs(a.record.date);
      const bt = b.record.date == null ? 0 : epochMs(b.record.date);
      return at === bt ? a.index - b.index : at - bt;
    });

    const reviews: PlannedReview[] = [];
    let previousNextInterval: number | null = null;
    let previousInstantMs: number | null = null;
    let lapses = 0;

    for (const { record, index } of indexed) {
      if (record.date == null) {
        throw new Error(
          `card ${card.id} ${array.key}[${index}] has no date; refusing to invent one`,
        );
      }
      const remembered: 0 | 1 = record["remembered?"] === true ? 1 : 0;
      if (remembered === 0) lapses += 1;
      const nextScheduledDays = finiteOrNull(record.interval);
      const durationSeconds = finiteOrNull(record.duration);

      const instantMs = epochMs(record.date);
      const elapsedDays =
        previousInstantMs === null ? null : (instantMs - previousInstantMs) / MS_PER_DAY;

      reviews.push({
        importKey: `mochi:${card.id}:${kind}:${index}`,
        reviewedAt: formatInstant(record.date, offset),
        tzOffsetMinutes: offset,
        timeUnknown,
        remembered,
        elapsedDays,
        scheduledDays: previousNextInterval,
        nextScheduledDays,
        dueAt: record.due == null ? null : formatInstant(record.due, offset),
        durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
        rereview: isTrue(record["rereview?"]) ? 1 : 0,
        source: "mochi",
      });
      previousNextInterval = nextScheduledDays;
      previousInstantMs = instantMs;
    }

    const last = reviews.at(-1) ?? null;
    tracks.push({
      cardId: card.id,
      kind,
      dormant: array.track === "reverse" && !enabled ? 1 : 0,
      needsRereview: needsRereviewFor(card, array.track),
      dueAt: last?.dueAt ?? null,
      scheduledDays: last?.nextScheduledDays ?? null,
      reps: reviews.length,
      lapses,
      lastReviewedAt: last?.reviewedAt ?? null,
      scheduler: last === null ? null : "mochi",
      reviews,
    });
  }

  return tracks;
}

const LOCALLY_GRADED = `EXISTS (
  SELECT 1 FROM reviews r WHERE r.track_id = card_tracks.id AND r.source = 'local'
)`;

const INSERT_TRACK = `
INSERT INTO card_tracks
  (card_id, kind, dormant, needs_rereview, due_at, scheduled_days, reps, lapses,
   last_reviewed_at, scheduler, scheduler_state)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
ON CONFLICT (card_id, kind) DO UPDATE SET
  dormant          = excluded.dormant,
  needs_rereview   = excluded.needs_rereview,
  due_at           = CASE WHEN ${LOCALLY_GRADED} THEN card_tracks.due_at
                          ELSE excluded.due_at END,
  scheduled_days   = CASE WHEN ${LOCALLY_GRADED} THEN card_tracks.scheduled_days
                          ELSE excluded.scheduled_days END,
  reps             = CASE WHEN ${LOCALLY_GRADED} THEN card_tracks.reps
                          ELSE excluded.reps END,
  lapses           = CASE WHEN ${LOCALLY_GRADED} THEN card_tracks.lapses
                          ELSE excluded.lapses END,
  last_reviewed_at = CASE WHEN ${LOCALLY_GRADED} THEN card_tracks.last_reviewed_at
                          ELSE excluded.last_reviewed_at END,
  scheduler        = CASE WHEN ${LOCALLY_GRADED} THEN card_tracks.scheduler
                          ELSE excluded.scheduler END,
  updated_at       = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
RETURNING id, ${LOCALLY_GRADED} AS preserved`;

const INSERT_REVIEW = `
INSERT INTO reviews
  (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered,
   elapsed_days, scheduled_days, next_scheduled_days, due_at, duration_ms,
   rereview, source, import_key)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (import_key) DO NOTHING`;

export function insertPlannedTracks(
  db: Db,
  plans: Iterable<PlannedTrack>,
): { tracks: number; reviews: number; tracksPreserved: number } {
  const insertTrack = db.prepare(INSERT_TRACK);
  const insertReview = db.prepare(INSERT_REVIEW);
  let tracks = 0;
  let reviews = 0;
  let tracksPreserved = 0;

  for (const plan of plans) {
    const row = insertTrack.get(
      plan.cardId,
      plan.kind,
      plan.dormant,
      plan.needsRereview,
      plan.dueAt,
      plan.scheduledDays,
      plan.reps,
      plan.lapses,
      plan.lastReviewedAt,
      plan.scheduler,
    ) as { id: number; preserved: number } | undefined;
    if (row === undefined) {
      throw new Error(`card_tracks upsert returned no id for ${plan.cardId} ${plan.kind}`);
    }
    tracks += 1;
    if (row.preserved === 1) tracksPreserved += 1;
    for (const review of plan.reviews) {
      const result = insertReview.run(
        row.id,
        review.reviewedAt,
        review.tzOffsetMinutes,
        review.timeUnknown,
        review.remembered,
        review.elapsedDays,
        review.scheduledDays,
        review.nextScheduledDays,
        review.dueAt,
        review.durationMs,
        review.rereview,
        review.source,
        review.importKey,
      );
      reviews += result.changes;
    }
  }

  return { tracks, reviews, tracksPreserved };
}

export function assertNoOrphanedReverseHistory(db: Db): void {
  const orphans = db
    .prepare(
      `SELECT t.card_id, t.kind, r.reverse, count(v.id) AS reviews
         FROM card_tracks t
         JOIN card_reverse_resolved r ON r.card_id = t.card_id
         LEFT JOIN reviews v ON v.track_id = t.id
        WHERE t.kind = 'reverse' AND r.reverse <> 'on'
        GROUP BY t.card_id, t.kind, r.reverse`,
    )
    .all() as { card_id: string; reverse: string; reviews: number }[];
  if (orphans.length > 0) {
    const detail = orphans
      .map((o) => `${o.card_id} (${o.reviews} reviews, resolves ${o.reverse})`)
      .join(", ");
    throw new Error(
      `${orphans.length} reverse track(s) would lose their history because the card ` +
        `does not resolve to reverse 'on': ${detail}`,
    );
  }
}

export function importReviews(
  db: Db,
  cards: Iterable<MochiCard>,
  options: ImportOptions = {},
): ImportReviewsResult {
  const enforce = options.enforceReverseInvariant !== false;
  const workspaceDefault =
    options.workspaceReverseDefault ?? readWorkspaceReverseDefault(db);
  const deckReverse =
    options.deckReverse ??
    (options.decks === undefined
      ? readDeckReverseFromDb(db)
      : buildDeckReverseMap(options.decks, workspaceDefault));

  const planOptions: PlanOptions = {
    tzOffsetMinutes: options.tzOffsetMinutes ?? JST_OFFSET_MINUTES,
    ...(options.timeKnown === undefined ? {} : { timeKnown: options.timeKnown }),
  };

  const forceReverseOn = db.prepare(
    `UPDATE cards SET reverse = 'on',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND reverse <> 'on'`,
  );
  const cardExists = db.prepare("SELECT 1 FROM cards WHERE id = ?").pluck();

  const tracksByKind: Record<string, number> = {};
  const reviewsByKind: Record<string, number> = {};
  const reverseForced: string[] = [];
  let cardCount = 0;
  let reverseEnabled = 0;
  const plans: PlannedTrack[] = [];

  for (const card of cards) {
    cardCount += 1;
    if (cardExists.get(card.id) === undefined) {
      throw new Error(
        `card ${card.id} is not in the database; import cards before their reviews ` +
          `rather than dropping ${countReviewRecords(card)} review record(s)`,
      );
    }
    const resolution = resolveCardReverse(
      card,
      deckReverse.get(card["deck-id"] ?? "") ?? workspaceDefault,
      enforce,
    );
    if (resolution.reverse === "on") reverseEnabled += 1;
    if (resolution.forced) {
      forceReverseOn.run(card.id);
      reverseForced.push(card.id);
    }
    for (const plan of planCardTracks(card, resolution.reverse, planOptions)) {
      plans.push(plan);
      tracksByKind[plan.kind] = (tracksByKind[plan.kind] ?? 0) + 1;
      reviewsByKind[plan.kind] = (reviewsByKind[plan.kind] ?? 0) + plan.reviews.length;
    }
  }

  const written = db.transaction(() => insertPlannedTracks(db, plans))();
  if (enforce) assertNoOrphanedReverseHistory(db);

  let passed = 0;
  let lapses = 0;
  let reviews = 0;
  let withoutScheduled = 0;
  let withoutElapsed = 0;
  let elapsedOnly = 0;
  let withoutDuration = 0;
  let timeUnknown = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const plan of plans) {
    for (const review of plan.reviews) {
      reviews += 1;
      if (review.remembered === 1) passed += 1;
      else lapses += 1;
      if (review.scheduledDays === null) withoutScheduled += 1;
      if (review.elapsedDays === null) withoutElapsed += 1;
      if (review.scheduledDays === null && review.elapsedDays !== null) elapsedOnly += 1;
      if (review.durationMs === null) withoutDuration += 1;
      if (review.timeUnknown === 1) timeUnknown += 1;
      if (first === null || review.reviewedAt < first) first = review.reviewedAt;
      if (last === null || review.reviewedAt > last) last = review.reviewedAt;
    }
  }

  return {
    cards: cardCount,
    tracks: written.tracks,
    tracksByKind,
    tracksPreserved: written.tracksPreserved,
    reviews: written.reviews,
    reviewsByKind,
    passed,
    lapses,
    retention: reviews === 0 ? null : passed / reviews,
    reverseEnabled,
    reverseForced,
    reviewsWithoutScheduled: withoutScheduled,
    reviewsWithoutElapsed: withoutElapsed,
    reviewsElapsedOnly: elapsedOnly,
    reviewsWithoutDuration: withoutDuration,
    reviewsTimeUnknown: timeUnknown,
    firstReviewedAt: first,
    lastReviewedAt: last,
  };
}

function countReviewRecords(card: MochiCard): number {
  let n = 0;
  for (const array of MOCHI_REVIEW_ARRAYS) n += reviewRecords(card[array.key]).length;
  return n;
}

function readWorkspaceReverseDefault(db: Db): ResolvedReverse {
  const value = db
    .prepare("SELECT value FROM settings WHERE key = 'reverse.default'")
    .pluck()
    .get() as string | undefined;
  return value === "on" ? "on" : "off";
}

function readDeckReverseFromDb(db: Db): ReadonlyMap<string, ResolvedReverse> {
  const rows = db.prepare("SELECT deck_id, reverse FROM deck_reverse_resolved").all() as {
    deck_id: string;
    reverse: string;
  }[];
  const map = new Map<string, ResolvedReverse>();
  for (const row of rows) map.set(row.deck_id, row.reverse === "on" ? "on" : "off");
  return map;
}
