/**
 * Stage 6 — the scheduler, as the app uses it.
 *
 *     import { dueTracks, gradeTrack, queueCounts } from "hashigo/scheduler";
 *
 *     const counts = queueCounts(db);                       // 42 due, 4 overdue
 *     const [next] = dueTracks(db, { limit: 1 });
 *     gradeTrack(db, { trackId: next.trackId, remembered: 1 });
 *
 * That is the whole surface stage 7 needs. `hashigo/scheduler/backtest` is the
 * measurement harness and stays a separate subpath — nothing in a review session
 * should be able to reach a 54,000-line replay by accident.
 *
 * WHERE THIS STOPS, and it is worth being exact because "the scheduler is done"
 * is easy to over-read. It grades a track, advances its state, and answers what
 * is due. It does NOT hold a session, decide how many new cards a day is right,
 * interleave new with due, undo a grade, or play a sound. The first four are
 * stage 7's and at least two of them are Zach's taste rather than a measurement;
 * the last one is a correctness requirement that lives in `src/render/reveal.ts`
 * — audio fires on the cloze reveal, NEVER on side entry, and nothing here
 * touches it.
 *
 * THE ONE THING TO KNOW BEFORE READING THE CODE. 9,085 of the 13,393 imported
 * tracks have `scheduler = 'mochi'` and no state, because Mochi never exported
 * stability or difficulty. The first local grade of a track replays its whole
 * review log through FSRS-6 to recover them, then applies the grade — so
 * adopting this scheduler costs nothing in history, and a track keeps Mochi's
 * own due date until he actually reviews it here. `./tracks.ts` note 1 has the
 * reasoning, including why that is lazy rather than a migration.
 */

export {
  MS_PER_DAY,
  InstantFormatError,
  dueInstant,
  exactDaysBetween,
  formatInstant,
  localDate,
  localDayNumber,
  parseInstant,
  startOfLocalDayMs,
  wholeDaysBetween,
  type Instant,
} from "./day.js";

export {
  FUZZ_MAY_EXCEED_MAX_INTERVAL,
  INTERVAL_FUZZ,
  MAX_INTERVAL_DAYS,
  PARAMETERS_ARE_PROVISIONAL,
  SCHEDULER_ALGORITHM,
  SCHEDULER_PARAMETERS,
  SCHEDULER_POLICY,
  TARGET_RETENTION,
  UNREACHABLE_BY_DESIGN,
  UNREACHABLE_REASON,
  clampInterval,
} from "./policy.js";

export {
  SchedulerStateError,
  fuzzFactor,
  fuzzInterval,
  gradeMemory,
  intervalForMemory,
  parseMemory,
  retrievabilityOf,
  seedMemory,
  serialiseMemory,
  type GradeRequest,
  type GradeResult,
  type TrackMemory,
} from "./schedule.js";

export {
  dueAfter,
  dueBefore,
  dueOnOrBefore,
  isNewTrack,
  liveTrack,
} from "./predicates.js";

export {
  DormantTrackError,
  TrackNotFoundError,
  gradeTrack,
  nowInHostOffset,
  readTrack,
  seedTrackMemory,
  snapshotTrack,
  targetRetentionForCard,
  trackMemory,
  trackObservations,
  ungradeTrack,
  type GradeTrackInput,
  type GradedReview,
  type SeedReport,
  type TrackMemoryResult,
  type TrackSnapshot,
  type TrackRow,
} from "./tracks.js";

export {
  dueTracks,
  newTracks,
  EXAM_TIER_DECK,
  examTarget,
  PRIORITY_FIELD,
  priorityCardIds,
  queueCounts,
  reviewForecast,
  type ForecastDay,
  type QueueCounts,
  type QueueOptions,
  type QueuedTrack,
} from "./queue.js";

export { audibleTemplateIds, silentCardFilter, templateSpeaks } from "./silent.js";

export {
  DEFAULT_EXAM_TARGET,
  EXAM_TARGET_KEY,
  EXAM_TARGETS,
  KANKEN_LEVELS,
  KANKEN_VARIANTS,
  examTierLevels,
  hasExamTierKanji,
  isExamTarget,
  kankenLevel,
  type ExamTarget,
} from "./kanken.js";
