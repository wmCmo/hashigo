/**
 * THE SQL FRAGMENTS THAT DECIDE WHAT IS LIVE AND WHAT IS DUE, IN ONE PLACE.
 *
 * These were written out by hand at every call site — `t.dormant = 0 AND c.archived
 * = 0` at 19 of them, the due comparison at about ten — and every one was correct.
 * That is not the same as safe. Correctness by re-derivation holds until the day
 * someone re-derives it differently, and on 2026-08-26 someone had:
 *
 *   src/scheduler/queue.ts   substr(t.due_at, 1, 10) <= date('now','localtime')
 *   app/db.worker.ts         date(t.due_at)          <= date('now','localtime')
 *
 * SQLite's `date()` converts a timestamp carrying an offset to UTC. Due dates are
 * stored as local midnight with the offset written out, so `date()` pulled every JST
 * due date one day earlier: the sidebar counted 704 due while the progress header
 * beside it counted 646, and the badges are the number he uses to decide whether a
 * deck is worth opening.
 *
 * WHY `substr` AND NOT SOMETHING THAT LOOKS MORE CAREFUL. The first ten characters of
 * an RFC 3339 timestamp ARE its local date — that is what writing the offset means —
 * and `./day.ts` constructs every due date as local midnight. The two obvious
 * alternatives are both worse: comparing instants needs `julianday()` on both sides,
 * and comparing the raw strings lexically breaks the moment two offsets are in play,
 * because `2026-08-22T00:00:00+09:00` sorts after `2026-08-22T00:00:00Z` while being
 * nine hours earlier. `queue.ts` has carried that reasoning for months; what it did
 * not have was a way to stop a second author reaching for `date()`.
 *
 * ALIASES ARE PARAMETERS because the call sites genuinely differ — `t`/`c` in the
 * queue, `c2` in a correlated subquery in the app's deck counts. A bare string
 * constant would have forced those sites to keep hand-writing it, which is the
 * problem rather than the fix.
 *
 * NOT EVERY `dormant = 0` IN THE CODEBASE SHOULD BECOME `liveTrack()`, and the ones
 * that should not are the reason this file documents rather than dictates. Seeding
 * (`SELECT_SEEDABLE`, and the `--dry-run` counts beside it) deliberately includes
 * archived tracks: seeding one is harmless and the state is there if the card is ever
 * unarchived. `queueCounts` filters `c.archived = 0` once at statement level and its
 * four `CASE` arms then say only `dormant = 0`, which is correct and not a copy.
 * Use these where the FULL meaning is intended; the point is that there is now
 * somewhere to point at, not that every string must be replaced.
 */

/**
 * A track the scheduler will consider: not dormant, and on a card not archived.
 *
 * Requires both tables in scope. `queueCounts` shows the other shape — filter the
 * card once in the WHERE and let the arms speak only about the track.
 */
export function liveTrack(track = "t", card = "c"): string {
  return `${track}.dormant = 0 AND ${card}.archived = 0`;
}

/**
 * Due on or before a local date, which the caller binds — `?` by default.
 *
 * Compare against a DATE (`YYYY-MM-DD`), not an instant: `date('now','localtime')`
 * from SQL, or `localDay()` from TypeScript.
 */
export function dueOnOrBefore(track = "t", param = "?"): string {
  return `substr(${track}.due_at, 1, 10) <= ${param}`;
}

/** Strictly before — the overdue half of the same comparison. */
export function dueBefore(track = "t", param = "?"): string {
  return `substr(${track}.due_at, 1, 10) < ${param}`;
}

/** Strictly after: scheduled, not yet due. */
export function dueAfter(track = "t", param = "?"): string {
  return `substr(${track}.due_at, 1, 10) > ${param}`;
}

/**
 * A track that has never been reviewed — SPEC's rule for "new".
 *
 * `due_at IS NULL AND reps = 0` rather than `reps = 0` alone: a track can be seeded
 * with a due date and no reps, and that is scheduled rather than new.
 */
export function isNewTrack(track = "t"): string {
  return `${track}.due_at IS NULL AND ${track}.reps = 0`;
}
