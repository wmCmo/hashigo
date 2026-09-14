/**
 * Stage 1 — review history onto review tracks.
 *
 * This is the most irreplaceable data in the project: 103,110 graded reviews
 * over four years, which cannot be regenerated and which SPEC.html leans on for
 * the scheduler backtest, the dashboard and the retention analysis. Everything
 * here is written to lose nothing.
 *
 * THE MAPPING. Mochi keeps three parallel review arrays on a card; the schema
 * keeps N independent tracks. The correspondence is exact:
 *
 *     reviews          -> card_tracks.kind = 'forward'
 *     reverse-reviews  -> card_tracks.kind = 'reverse'
 *     cloze/reviews    -> card_tracks.kind = 'cloze:<n>'
 *
 * A record is `{date, due, interval?, remembered?, duration?, rereview?}`.
 * Measured over the three reference exports (see the numbers on each rule):
 *
 *   * `interval` and `duration` are ABSENT on a card's first review — 5,248 of
 *     them forward, because there is no preceding interval and Mochi does not
 *     time the first sitting. Those reviews must be imported, not dropped:
 *     dropping them would lose the start of every single track. The one
 *     exception measured: 82 reverse tracks DO carry `interval` on record 0, so
 *     "first review" is not a safe proxy for "no interval". Test absence.
 *   * `duration` is present-but-null on 17 rows (key count 92,106, numeric
 *     92,089). `"duration" in record` is therefore the wrong test.
 *   * an EMPTY review array is encoded as the empty MAP, not as `[]`:
 *     `"~:cloze/reviews":{}` on all 22 cards in 日本語 that carry the key. So the
 *     decoded value is an object, `.map` throws and `.length` is undefined.
 *   * `interval` is Mochi's NEXT interval, not the preceding one: it equals
 *     due - date. It goes to `reviews.next_scheduled_days`. Reading Mochi's
 *     value as the preceding interval shifts the whole backtest by one review,
 *     which is the trap the column names below close.
 *
 * THE TWO INTERVALS, both written here, both describing the gap BEFORE a review
 * (schema.sql names them, and the word "interval" is no longer a column):
 *
 *   `elapsed_days`    MEASURED. The time between this review and the previous
 *                     review of the same track, computed from the timestamps
 *                     and nothing else. NULL only on a track's first review.
 *                     This is ground truth and it is what the backtest scores
 *                     against. Crucially it does NOT depend on Mochi having
 *                     recorded an interval, so the 8,934 rows carrying no
 *                     planned interval are still scorable.
 *   `scheduled_days`  PLANNED. What Mochi had asked for over that same gap:
 *                     the PRECEDING record's `interval`. NULL on a track's
 *                     first review and wherever the predecessor carried no
 *                     `interval`.
 *
 * The two disagree constantly — 22,226 reviews were taken more than 1.5 days
 * late and 240 early — so neither substitutes for the other and every consumer
 * must name which one it bucketed by. `review_interval_audit` re-derives both
 * from the raw rows and must return no rows after an import.
 *   * every `date` and `due` is a whole second, and every `date` in the corpus
 *     is 15:00:00Z. See the timestamp rule below.
 *
 * THE TIMESTAMP RULE (SPEC "Review timestamps — the one that cannot wait").
 * All 103,110 review dates carry 15:00:00Z, exactly midnight JST, because Mochi
 * truncates to the date. There is not one genuine time-of-day value in four
 * years of history and it is unrecoverable. So every imported row gets
 * time_unknown = 1. Midnight is written into reviewed_at because the local DATE
 * is real information and has to survive, but the flag is what stops
 * views.sql's local_hour — and therefore every time-of-day chart — from growing
 * a false spike at 00:00. Nothing here ever assigns midnight as if it were
 * observed.
 *
 * THE REVERSE INVARIANT (SPEC "Importer rule — do not orphan history"). A
 * card's reverse track only exists when reverse resolves to 'on', so a card
 * carrying reverse history that resolves to 'off' would silently lose it. Six
 * cards in the reference corpus are exactly that case — five in English
 * (Vocabulary: irksome, extol, expulsion, constraint, impend) and one in
 * 基本情報 (第15章) — because neither their deck nor the cards themselves set
 * review-reverse?, so they resolve to the workspace default 'off'. The importer
 * forces them to 'on' and `assertNoOrphanedReverseHistory` re-checks it against
 * the database afterwards. Without that, 7 review records go unreachable.
 *
 * Deliberately NOT done here: creating cloze tracks for cards that have cloze
 * groups but no cloze reviews. `cloze/indexes` is empty on all 7,716 cards and
 * finding cloze groups means parsing content, which is the template engine's
 * job at stage 3. Cloze tracks are created only where cloze review records
 * exist (none in this corpus).
 */

import type { Db } from "../db/index.js";
import {
  clozeTrack,
  resolveReverseInheritance,
  type ReverseInheritance,
  type ReverseMode,
  type TrackKind,
} from "../schema/index.js";

/**
 * Asia/Tokyo, minutes east of UTC. Japan has no DST, so this is constant for
 * the entire history — which is why every imported review can share one offset.
 * Matches the `timezone.default` seeded by schema.sql.
 */
export const JST_OFFSET_MINUTES = 540;

/** Only ever `'on'` or `'off'` — `'inherit'` has already been resolved away. */
export type ResolvedReverse = Exclude<ReverseMode, "inherit">;

/** Mochi's three review arrays, in the order they are imported. */
export const MOCHI_REVIEW_ARRAYS = [
  { key: "reviews", track: "forward" },
  { key: "reverse-reviews", track: "reverse" },
  { key: "cloze/reviews", track: "cloze" },
] as const;

/**
 * A decoded Transit instant. `tools/mochi.py` yields a datetime and a
 * TypeScript decoder may yield a `Date`, epoch milliseconds, or an ISO string
 * depending on how it handles `"~t<millis>"`; all three are accepted so this
 * module does not constrain the decoder that feeds it.
 */
export type MochiInstant = Date | number | string;

export interface MochiReviewRecord {
  readonly date?: MochiInstant | null;
  readonly due?: MochiInstant | null;
  /** Mochi's NEXT interval, in days, fractional. Absent on most first reviews. */
  readonly interval?: number | null;
  /** SECONDS, not milliseconds. Absent on first reviews, and null on 17 rows. */
  readonly duration?: number | null;
  readonly "remembered?"?: boolean | null;
  readonly "rereview?"?: unknown;
}

export interface MochiCard {
  readonly id: string;
  readonly "deck-id"?: string | null;
  /**
   * Two-state in Mochi, so "unset" and "deliberately off" are indistinguishable
   * — the reason the schema's flag is three-state. Present on 8 cards, always
   * `true`.
   */
  readonly "review-reverse?"?: unknown;
  readonly reviews?: readonly MochiReviewRecord[] | null;
  readonly "reverse-reviews"?: readonly MochiReviewRecord[] | null;
  readonly "cloze/reviews"?: readonly MochiReviewRecord[] | null;
  readonly "cloze/indexes"?: readonly unknown[] | null;
  /** Three parallel leech flags mirroring the three review arrays. */
  readonly "needs-rereview?"?: unknown;
  readonly "reverse/needs-rereview?"?: unknown;
  readonly "cloze/needs-rereview?"?: unknown;
}

export interface MochiDeck {
  readonly id: string;
  readonly "parent-id"?: string | null;
  readonly "review-reverse?"?: unknown;
}

/** One row destined for `reviews`. */
export interface PlannedReview {
  /** `mochi:<card id>:<track kind>:<array index>` — makes re-import idempotent. */
  readonly importKey: string;
  readonly reviewedAt: string;
  readonly tzOffsetMinutes: number;
  readonly timeUnknown: 0 | 1;
  /**
   * The WHOLE recall signal. Grades are binary by design, not because Mochi
   * happened to record only a boolean: Anki's four-button Again/Hard/Good/Easy
   * was considered and rejected, so there is no `grade` here and no column for
   * one in `reviews`. `gradeFor()` in src/schema/index.ts maps this to the only
   * two FSRS ratings the application can ever produce.
   */
  readonly remembered: 0 | 1;
  /**
   * MEASURED days since the previous review of this track, from the timestamps
   * alone. NULL only on a track's first review — never on account of Mochi
   * having omitted an `interval`.
   */
  readonly elapsedDays: number | null;
  /** PLANNED days for that same gap: the PRECEDING record's `interval`. */
  readonly scheduledDays: number | null;
  /** Mochi's own `interval` == due - date: what THIS review scheduled next. */
  readonly nextScheduledDays: number | null;
  readonly dueAt: string | null;
  readonly durationMs: number | null;
  readonly rereview: 0 | 1;
  readonly source: "mochi";
}

/** One row destined for `card_tracks`, with the reviews that belong to it. */
export interface PlannedTrack {
  readonly cardId: string;
  readonly kind: TrackKind;
  readonly dormant: 0 | 1;
  readonly needsRereview: 0 | 1;
  /** Mochi's schedule, carried as-is until stage 5 picks an algorithm. */
  readonly dueAt: string | null;
  /** `card_tracks.scheduled_days`: the interval the schedule currently PLANS. */
  readonly scheduledDays: number | null;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewedAt: string | null;
  readonly scheduler: "mochi" | null;
  readonly reviews: readonly PlannedReview[];
}

export interface ReverseResolution {
  /** What the card itself says: `'on'` or `'inherit'`, never `'off'` from Mochi. */
  readonly cardValue: ReverseMode;
  /** What the deck tree says, already resolved to two states. */
  readonly deckValue: ResolvedReverse;
  readonly reverse: ResolvedReverse;
  /** True when the reverse invariant overrode a resolution of `'off'`. */
  readonly forced: boolean;
}

export interface PlanOptions {
  /** Minutes east of UTC for the authoring wall clock. Default JST (+540). */
  readonly tzOffsetMinutes?: number;
  /**
   * Whether the imported timestamps carry a real time of day. Default false,
   * and there is no case in the reference corpus where it should be true —
   * the option exists so a future export format with real clock times does not
   * have to fight this module.
   */
  readonly timeKnown?: boolean;
}

export interface ImportOptions extends PlanOptions {
  /**
   * The export's deck tree, used to resolve `inherit` up the parents. Supply
   * this or `deckReverse`; with neither, the already-imported `decks` table is
   * read through the `deck_reverse_resolved` view.
   */
  readonly decks?: Iterable<MochiDeck>;
  /** Pre-resolved per-deck reverse, if the caller already has it. */
  readonly deckReverse?: ReadonlyMap<string, ResolvedReverse>;
  /** Bottom of the inherit chain. Default read from `settings`, else `'off'`. */
  readonly workspaceReverseDefault?: ResolvedReverse;
  /**
   * Force `cards.reverse = 'on'` for any card carrying reverse history that
   * would otherwise resolve to `'off'`. Default true, and turning it off means
   * accepting that 8 review records in the reference corpus are dropped, so it
   * exists only to make the failure demonstrable in a test: 7 real review
   * records become unreachable when it is off.
   */
  readonly enforceReverseInvariant?: boolean;
}

export interface ImportReviewsResult {
  readonly cards: number;
  readonly tracks: number;
  readonly tracksByKind: Readonly<Record<string, number>>;
  /**
   * Tracks whose SCHEDULING state this import declined to overwrite because the
   * app had already graded them — see `INSERT_TRACK`. Zero on every import that
   * has ever run, and it must stay reported rather than inferred: a re-import
   * that quietly left 400 tracks alone is not the same event as one that
   * rewrote them, and "imported cleanly" must not mean "imported everything".
   */
  readonly tracksPreserved: number;
  readonly reviews: number;
  readonly reviewsByKind: Readonly<Record<string, number>>;
  readonly passed: number;
  readonly lapses: number;
  /** passed / reviews, or null when nothing was imported. */
  readonly retention: number | null;
  readonly reverseEnabled: number;
  /** Card ids whose reverse was forced on to keep their history. */
  readonly reverseForced: readonly string[];
  /** Rows with no PLANNED interval: a track's first review, plus every review
   *  whose predecessor carried no Mochi `interval`. */
  readonly reviewsWithoutScheduled: number;
  /** Rows with no MEASURED interval. Exactly the tracks' first reviews — there
   *  is no other way to lack a predecessor. */
  readonly reviewsWithoutElapsed: number;
  /**
   * The rows the two-column split rescues: no planned interval, but a measured
   * one derived from the timestamps. Under the old single `interval_days` these
   * were NULL and therefore unscorable and unbucketable; they are the reason
   * the `> 365d` retention bucket is empty under `scheduled` and holds 3,009
   * observations under `elapsed`.
   */
  readonly reviewsElapsedOnly: number;
  readonly reviewsWithoutDuration: number;
  readonly reviewsTimeUnknown: number;
  readonly firstReviewedAt: string | null;
  readonly lastReviewedAt: string | null;
}

// ─── the `{}` trap ───────────────────────────────────────────────────────────

/**
 * Strict `=== true`, and it matters: `cloze/needs-rereview?` is the empty MAP
 * `{}` on all 24 cards that carry it, not a boolean. `Boolean({})` is `true` in
 * JavaScript, so a truthiness test would flag 24 cards as leeches that Mochi
 * never flagged. `needs-rereview?` is likewise `false` on 7 of the 8 cards that
 * carry it, so presence is not truth either.
 */
function isTrue(value: unknown): boolean {
  return value === true;
}

/**
 * The same trap again, on the arrays themselves: an EMPTY review array is
 * encoded as the empty map, `"~:cloze/reviews":{}`, not as `[]` — which is how
 * all 22 cards carrying `cloze/reviews` in 日本語 store it. Decoded that is an
 * object, so `records.map` throws and `records.length` is undefined. Anything
 * that is not an array is treated as no records.
 */
function reviewRecords(value: unknown): readonly MochiReviewRecord[] {
  return Array.isArray(value) ? (value as readonly MochiReviewRecord[]) : [];
}

// ─── instants ────────────────────────────────────────────────────────────────

/**
 * Milliseconds in a day. `elapsed_days` is a REAL count of days, and dividing
 * by this is exactly what `julianday(a) - julianday(b)` computes in views.sql —
 * so the stored column and the view that audits it cannot drift apart.
 */
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

/**
 * RFC 3339 with the authoring offset, e.g. `2022-06-28T00:00:00+09:00`.
 *
 * The offset is kept rather than normalised to UTC because a 23:00 review in
 * Tokyo and a 23:00 review abroad are different facts about the day, and
 * because views.sql derives local_date by shifting reviewed_at by
 * tz_offset_minutes — the two have to agree. Fractional seconds are emitted
 * only when non-zero; no review date or due in the corpus needs them.
 */
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

// ─── three-state reverse resolution ──────────────────────────────────────────

/**
 * SPEC's importer rule: `review-reverse? = true` maps to `'on'`, and absent or
 * `false` maps to `'inherit'` — NOT to `'off'`. Mochi's boolean cannot express
 * a deliberate exception, so a `false` there is indistinguishable from unset
 * and must not be read as an intentional override; the deck has to win.
 */
export function mochiCardReverse(card: MochiCard): ReverseMode {
  return isTrue(card["review-reverse?"]) ? "on" : "inherit";
}

/** Decks read the same way. Four decks in 日本語 set it: 文法, 言葉, 漢字, 単語. */
export function mochiDeckReverse(deck: MochiDeck): ReverseMode {
  return isTrue(deck["review-reverse?"]) ? "on" : "inherit";
}

/** A non-empty `reverse-reviews` array — the history the invariant protects. */
export function hasReverseHistory(card: MochiCard): boolean {
  return reviewRecords(card["reverse-reviews"]).length > 0;
}

/**
 * Walk up the deck tree to the nearest ancestor with an explicit value,
 * bottoming out at the workspace default. Cycle-safe: a malformed export that
 * makes a deck its own ancestor stops rather than looping.
 */
export function resolveDeckReverse(
  deckId: string | null | undefined,
  decks: ReadonlyMap<string, MochiDeck>,
  workspaceDefault: ResolvedReverse = "off",
): ResolvedReverse {
  // An ADAPTER now, and this is the one that used to disagree: it walked PAST an
  // explicit `off` looking for an `on` above it, so a deck deliberately excepted
  // under an enabled parent resolved `on` here and `off` in `entities.ts` and in
  // `deck_reverse_resolved`. Unreachable from a Mochi export — `mochiDeckReverse`
  // never yields `off` — and reachable the moment deck CRUD writes one.
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

/** Every deck's resolved reverse, for handing to `importReviews`. */
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

/**
 * Card explicit beats deck; `inherit` takes the deck's answer. Then the
 * invariant: reverse history forces `'on'`, because the alternative is throwing
 * the history away.
 */
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

// ─── planning ────────────────────────────────────────────────────────────────

function trackKindFor(card: MochiCard, array: (typeof MOCHI_REVIEW_ARRAYS)[number]): TrackKind {
  if (array.track === "forward" || array.track === "reverse") return array.track;
  // Mochi keeps ONE cloze/reviews array however many indexed groups a card has,
  // so all of them share a track until the indexed-cloze authoring UI exists.
  // `cloze/indexes` is [] on all 7,716 cards, hence cloze:0 throughout.
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

/**
 * Turn one Mochi card into its tracks and their reviews.
 *
 * `reverse` is the already-resolved two-state value. A forward track is always
 * planned, even with zero reviews — SPEC derives `new?` from an empty track
 * ("due_at IS NULL AND reps = 0 means new"), and views.sql counts new_tracks,
 * both of which need the track to exist. A reverse track is planned whenever
 * reverse is `'on'`, again including the 1,898 cards enabled but never
 * reverse-reviewed yet. A cloze track is planned only where cloze review
 * records exist.
 */
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
    // Forward always exists; reverse exists when enabled, including for the
    // 1,898 cards enabled but not yet reverse-reviewed. A cloze track is NOT
    // created speculatively: finding a card's cloze groups means parsing content
    // (stage 3), and `cloze/indexes` is empty on all 7,716 cards, so a cloze
    // track only appears where cloze review records do.
    const enabled = array.track === "forward" || (array.track === "reverse" && reverse === "on");
    // `records.length > 0` is the second net under the reverse invariant: even
    // if resolution says off, a non-empty array is never dropped on the floor.
    // It comes in dormant instead — retained, not scheduled — which is what
    // SPEC asks of a reverse track that is switched off.
    if (!enabled && records.length === 0) continue;

    const kind = trackKindFor(card, array);

    // Sorted by timestamp so the preceding-interval chain and reps/lapses are
    // chronological even if an export were not. Every array in the reference
    // corpus already is (0 negative gaps across 94,025 consecutive pairs), and
    // the sort is stable, so the import_key below still names the ORIGINAL
    // array position and re-importing stays idempotent.
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

      // MEASURED. Derived from the two timestamps and nothing else, which is
      // what makes it available on the 8,934 rows Mochi left without a planned
      // interval. `indexed` is already sorted ascending, so this is never
      // negative; an exact tie yields 0, the honest answer for the 6,996
      // same-day reviews rather than NULL or a guess. The same subtraction is
      // recomputed by review_gaps/review_interval_audit as julianday deltas
      // over the stored rows, so the stored copy is checkable rather than
      // trusted.
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
        // PLANNED, and NULL on the first review of a track and on any review
        // whose predecessor carried no `interval` — 8,934 such rows. Guessing
        // would put fiction into a variable half the project buckets by. Those
        // rows keep a real elapsedDays above, which is the point of storing
        // both.
        scheduledDays: previousNextInterval,
        nextScheduledDays,
        dueAt: record.due == null ? null : formatInstant(record.due, offset),
        // Mochi's `duration` is seconds; the column is milliseconds.
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
      // Dormant means retained but not scheduled, and only a disabled reverse
      // track with history can reach it. With the invariant enforced no
      // imported track is dormant; with it disabled, this is where the six
      // affected cards' history goes rather than nowhere. Cloze tracks are
      // never dormant -- they exist only because their records do.
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

// ─── writing ─────────────────────────────────────────────────────────────────

/**
 * A RE-IMPORT MUST NOT REVERT A TRACK THIS APP HAS GRADED.
 *
 * Zach's decision 16 is "one last import when the app is finished, then never
 * again -- unless the app breaks something and we have to re-import". The escape
 * hatch is the destructive case: it fires precisely when local grades exist, and
 * the unguarded upsert reverted `due_at`, `scheduled_days`, `reps`, `lapses`,
 * `last_reviewed_at` and `scheduler` to Mochi's values -- silently losing every
 * local review's effect on the schedule while the `reviews` rows themselves
 * survived, so the log and the track would disagree.
 *
 * WHY CASE PER COLUMN AND NOT `DO UPDATE ... WHERE`. SQLite accepts a WHERE on
 * the conflict clause, but when it excludes the row the `RETURNING` yields
 * nothing -- and the caller throws on a missing id, because a track with no id
 * cannot receive its reviews. Guarding each assignment keeps the row, keeps the
 * id, and keeps the import idempotent.
 *
 * WHAT MOCHI STILL OWNS: `dormant` and `needs_rereview`. Those are card
 * CONFIGURATION -- whether a reverse track should exist at all -- not scheduling
 * state, and letting a locally-graded track ignore a reverse mode he turned off
 * in Mochi would orphan history the app then refuses to schedule
 * (`assertNoOrphanedReverseHistory` below is the invariant that would fail).
 *
 * Today `SELECT count(*) FROM reviews WHERE source = 'local'` is 0, so this
 * changes nothing about any import that has ever run. It is cheap now and a
 * data-loss bug the first time stage 7 writes a grade.
 */
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

// import_key makes this idempotent. DO NOTHING rather than DO UPDATE because
// reviews is append-only and its BEFORE UPDATE trigger would abort the import.
//
// There is no `grade` column to write. Binary is the design (see PlannedReview.
// remembered), so a 1-4 rating is not a thing this INSERT can ever grow.
const INSERT_REVIEW = `
INSERT INTO reviews
  (track_id, reviewed_at, tz_offset_minutes, time_unknown, remembered,
   elapsed_days, scheduled_days, next_scheduled_days, due_at, duration_ms,
   rereview, source, import_key)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (import_key) DO NOTHING`;

/**
 * Write planned tracks and their reviews. Caller owns the transaction; the
 * cards must already exist, because `card_tracks.card_id` is a foreign key.
 */
export function insertPlannedTracks(
  db: Db,
  plans: Iterable<PlannedTrack>,
): { tracks: number; reviews: number; tracksPreserved: number } {
  const insertTrack = db.prepare(INSERT_TRACK);
  const insertReview = db.prepare(INSERT_REVIEW);
  let tracks = 0;
  let reviews = 0;
  // Counted, not silent: this project's rule is that anything a write DECLINED
  // to do has to be reportable, or "imported cleanly" reads as "imported
  // everything".
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

/**
 * The invariant, re-checked against what is actually in the database rather
 * than against what this module believes it did. Any reverse track whose card
 * does not resolve to reverse `'on'` is history that the app will never
 * schedule and the review UI will never show — SPEC calls it orphaned, and it
 * is a failed import, not a warning.
 */
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

/**
 * Import every card's review history. Cards and decks must already be in the
 * database. Runs in one transaction: a half-imported review log is not a state
 * this function can produce.
 */
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

/** Uses views.sql's own resolution so the importer cannot disagree with it. */
function readDeckReverseFromDb(db: Db): ReadonlyMap<string, ResolvedReverse> {
  const rows = db.prepare("SELECT deck_id, reverse FROM deck_reverse_resolved").all() as {
    deck_id: string;
    reverse: string;
  }[];
  const map = new Map<string, ResolvedReverse>();
  for (const row of rows) map.set(row.deck_id, row.reverse === "on" ? "on" : "off");
  return map;
}
