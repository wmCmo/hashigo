/**
 * Stage 6 — instants, and the day the review queue runs on.
 *
 * THE QUEUE IS DAY-GRAINED, AND THAT IS NOT AN APPROXIMATION. Three facts in
 * this project already agree on it, and this module is where they meet:
 *
 *   * Every one of the 102,020 imported reviews carries a date and no time
 *     (SPEC "Review timestamps"), so the FSRS-6 fit that ships — see
 *     `SCHEDULER_PARAMETERS` — was fitted on elapsed times measured in WHOLE
 *     DAYS. Feeding production a fractional gap would feed the model a unit it
 *     was never fitted on.
 *   * Mochi's own `due` values are local midnight: the importer stores them as
 *     `formatInstant(record.due, +540)`, i.e. `2026-08-22T00:00:00+09:00`. A
 *     due date this module computes is the same shape as one the importer wrote,
 *     so the queue cannot tell an imported track from a locally graded one.
 *   * `clampInterval` in `./policy.ts` already floors at one day, saying so:
 *     "the review queue is a day-grained thing".
 *
 * WHAT MIDNIGHT ACTUALLY BUYS, stated carefully because my first version of this
 * comment overclaimed and the fault injection said so. It is the CANONICAL FORM,
 * not the protection. A card graded at 23:40 with a one-day interval gets
 * `2026-08-23T00:00:00+09:00`, byte-identical in shape to the 9,026 due dates
 * the importer wrote from Mochi, so nothing downstream can tell an imported
 * track from a locally graded one.
 *
 * The protection against the classic learn-ahead defect — a card falling due at
 * 23:40 tomorrow and missing the session it was scheduled for — is a DIFFERENT
 * mechanism, one file over: `queue.ts` compares local DATES, so a due date at
 * any hour of its day is due that whole day. Measured by breaking this function
 * to return `instant + N days` and running the suite: the two due-date tests go
 * red and the queue test stays green, because the queue was never relying on the
 * hour. Both properties are worth having; only one of them is this function's.
 *
 * OFFSETS ARE KEPT, NEVER NORMALISED, for the reason schema.sql gives: a 23:00
 * review in Tokyo and a 23:00 review abroad are different facts. A due date is
 * computed in the offset of the review that scheduled it, and `localDayNumber`
 * reads the offset out of the string rather than taking it on the side, so a
 * timestamp cannot be interpreted in an offset it does not carry.
 *
 * There is no dependency here on `src/import` even though `formatInstant` there
 * emits the same shape — the importer pulls in the Transit decoder, and this
 * module ships to the browser. `test/scheduler.test.ts` asserts the two agree
 * character for character instead, which is the check that would catch a drift.
 */

/** Milliseconds in a day. Same constant, same reason, as the importer's. */
export const MS_PER_DAY = 86_400_000;

/** A moment, plus the offset it was written in. */
export interface Instant {
  /** Milliseconds since the Unix epoch, UTC. */
  readonly ms: number;
  /** Minutes east of UTC. +540 is JST; 0 is a `Z` timestamp. */
  readonly offsetMinutes: number;
}

/** Thrown rather than guessing. A timestamp with no offset is not an instant. */
export class InstantFormatError extends Error {
  constructor(value: string, why: string) {
    super(`not a usable instant: ${JSON.stringify(value)} — ${why}`);
    this.name = "InstantFormatError";
  }
}

const OFFSET = /(?:(Z)|([+-])(\d{2}):?(\d{2}))$/;

/**
 * Parse an RFC 3339 instant, keeping its offset.
 *
 * Refuses a naked local time (`2026-08-22T09:00:00`): JavaScript would read it
 * in the host's zone, which is exactly the kind of invented fact this project
 * throws on elsewhere.
 */
export function parseInstant(value: string): Instant {
  const match = OFFSET.exec(value);
  if (match === null) {
    throw new InstantFormatError(value, "no UTC offset, and one is not assumable");
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new InstantFormatError(value, "not RFC 3339");
  if (match[1] === "Z") return { ms, offsetMinutes: 0 };
  const sign = match[2] === "-" ? -1 : 1;
  const hours = Number(match[3]);
  const minutes = Number(match[4]);
  return { ms, offsetMinutes: sign * (hours * 60 + minutes) };
}

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, "0");
}

/**
 * RFC 3339, with the offset written out — the same shape (and the same code,
 * character for character) as `formatInstant` in `src/import/reviews.ts`.
 * Fractional seconds only when non-zero.
 */
export function formatInstant(ms: number, offsetMinutes: number): string {
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

/** `2026-08-22` — the local date, in the instant's own offset. */
export function localDate(value: string | Instant): string {
  const instant = typeof value === "string" ? parseInstant(value) : value;
  return new Date(instant.ms + instant.offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Days since the epoch, in the instant's own offset. The integer that makes
 * "how many days apart are these two reviews" a subtraction rather than a
 * calendar problem.
 */
export function localDayNumber(value: string | Instant): number {
  const instant = typeof value === "string" ? parseInstant(value) : value;
  return Math.floor((instant.ms + instant.offsetMinutes * 60_000) / MS_PER_DAY);
}

/** Local midnight of the day an instant falls in, as epoch milliseconds. */
export function startOfLocalDayMs(value: string | Instant): number {
  const instant = typeof value === "string" ? parseInstant(value) : value;
  return localDayNumber(instant) * MS_PER_DAY - instant.offsetMinutes * 60_000;
}

/**
 * WHOLE local days between two instants — the unit the model is fed.
 *
 * Same local date is 0, which is what reaches FSRS-6's short-term branch, and
 * which is the honest answer for a same-day re-review: "somewhere under a day",
 * not a fraction the fit has never seen. Negative if `to` precedes `from`;
 * callers that cannot accept that say so themselves.
 */
export function wholeDaysBetween(from: string | Instant, to: string | Instant): number {
  return localDayNumber(to) - localDayNumber(from);
}

/**
 * EXACT elapsed days between two instants, fractional — `reviews.elapsed_days`.
 *
 * This is the MEASURED column, and it is deliberately a different number from
 * `wholeDaysBetween`: the same subtraction `review_gaps` recomputes as a
 * `julianday` delta, so the stored value stays checkable against the view that
 * audits it. Decision 6 in CLAUDE.md — name the basis or the number is not a
 * fact — applies to these two functions more literally than anywhere else in
 * the codebase.
 */
export function exactDaysBetween(from: string | Instant, to: string | Instant): number {
  const a = typeof from === "string" ? parseInstant(from) : from;
  const b = typeof to === "string" ? parseInstant(to) : to;
  return (b.ms - a.ms) / MS_PER_DAY;
}

/**
 * The due instant for an interval of `intervalDays` whole days after
 * `reviewedAt`: local midnight, in the reviewing offset.
 *
 * `intervalDays` must already be a whole number — `gradeTrack` rounds, and
 * rounding in two places is how the planned interval and the due date drift
 * apart. Japan has no DST, so midnight plus N days is exactly N*MS_PER_DAY;
 * under an offset that does change, the offset of the review that scheduled it
 * is the one that applies, which is the same rule the importer used.
 */
export function dueInstant(reviewedAt: string | Instant, intervalDays: number): string {
  if (!Number.isInteger(intervalDays)) {
    throw new RangeError(`dueInstant needs whole days, got ${intervalDays}`);
  }
  const instant = typeof reviewedAt === "string" ? parseInstant(reviewedAt) : reviewedAt;
  return formatInstant(
    startOfLocalDayMs(instant) + intervalDays * MS_PER_DAY,
    instant.offsetMinutes,
  );
}
