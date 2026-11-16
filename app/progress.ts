export interface DayTally {
  readonly answeredToday: number;
  readonly missedToday: number;
  readonly plannedToday: number;
}

export interface BarWidths {
  readonly donePercent: number;
  readonly missedPercent: number;
  readonly done: number;
  readonly missed: number;
  readonly planned: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));

export function barWidths(tally: DayTally): BarWidths {
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

export function barValueText(widths: BarWidths): string {
  const base = `${widths.done} of ${widths.planned} answered today`;
  return widths.missed === 0 ? base : `${base}, ${widths.missed} missed`;
}
