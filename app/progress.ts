/**
 * THE DAY'S BAR, AS TWO WIDTHS.
 *
 * Zach, 2026-09-17: *"for missed/forgot card, we can actually make it visible on
 * the progress bar, but maybe as a red bar? so the bar can now tell the
 * proportion"*.
 *
 * ─── THE MISSED SEGMENT IS ANCHORED AT ZERO, NOT AT THE GROWING TIP ─────────
 *
 * Both segments start at the left edge and the missed one is drawn OVER the
 * filled one, so `missed` is a prefix of `done` rather than a slice cut out of
 * it. That makes both widths monotonic — each only ever grows — and it is the
 * reason this is two independent numbers rather than one number and a split
 * point.
 *
 * The alternative, painting the misses at the leading edge, puts a red tip on the
 * bar for as long as his last answer was a miss and takes it away again on the
 * next card. The bar would then be reporting the last grade, which the screen
 * already shows him, instead of the day's proportion, which is what he asked for.
 *
 * ─── IT CLAMPS, BECAUSE THE TWO NUMBERS CAN DISAGREE HONESTLY ───────────────
 *
 * `answeredToday` counts grades made ANYWHERE today, including a sync pull, while
 * `plannedToday` is built from this device's plan. A phone morning landing on the
 * laptop can legitimately make the numerator exceed the denominator for one
 * paint, and a bar over 100% wide overhangs the header. Same for `missed`, which
 * can never exceed `done` but is read from a column rather than derived from it.
 *
 * NO IMPORTS — the same rule as `./review-boundary.ts` and `./overdue.ts`: the
 * root `tsconfig.json` excludes `app/`, so an import-free module is reachable from
 * `test/` and one that touches the DOM is not.
 */

export interface DayTally {
  readonly answeredToday: number;
  readonly missedToday: number;
  readonly plannedToday: number;
}

export interface BarWidths {
  /** Percent of the track that is filled — everything answered today. */
  readonly donePercent: number;
  /** Percent that is the missed prefix. Never greater than `donePercent`. */
  readonly missedPercent: number;
  /** For `aria-valuenow` / `aria-valuemax`, clamped the same way. */
  readonly done: number;
  readonly missed: number;
  readonly planned: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));

export function barWidths(tally: DayTally): BarWidths {
  // 1 rather than 0: a day with nothing planned still has to divide by something,
  // and an empty bar is the right picture for it.
  const planned = Math.max(1, Math.floor(tally.plannedToday));
  const done = clamp(Math.floor(tally.answeredToday), 0, planned);
  const missed = clamp(Math.floor(tally.missedToday), 0, done);
  return {
    donePercent: (100 * done) / planned,
    missedPercent: (100 * missed) / planned,
    done,
    missed,
    planned,
  };
}

/**
 * What a screen reader is told, since the bar itself is 2px of colour.
 *
 * `aria-valuenow` alone says "12 of 40" and cannot say that three of the twelve
 * were misses — which is the only thing the red adds over the bar he already had.
 */
export function barValueText(widths: BarWidths): string {
  const base = `${widths.done} of ${widths.planned} answered today`;
  return widths.missed === 0 ? base : `${base}, ${widths.missed} missed`;
}
