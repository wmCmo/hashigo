const DAYS_PER_MONTH = 30.44;
const DAYS_PER_YEAR = 365.25;

export function overdueLabel(days: number): string | null {
  if (!Number.isFinite(days) || days < 1) return null;
  const whole = Math.floor(days);
  if (whole === 1) return "due yesterday";
  if (whole <= 30) return `due ${whole} days ago`;
  if (whole < 365) {
    const months = Math.min(11, Math.max(1, Math.round(whole / DAYS_PER_MONTH)));
    return `due ${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.max(1, Math.round(whole / DAYS_PER_YEAR));
  return `due ${years} year${years === 1 ? "" : "s"} ago`;
}

export function dueDateOf(dueAt: string | null): string | null {
  if (dueAt === null) return null;
  const date = dueAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

export function overdueTitle(days: number, dueAt: string | null): string {
  const date = dueDateOf(dueAt);
  const whole = Math.max(0, Math.floor(days));
  return date === null ? `${whole} days late` : `due ${date} — ${whole} days late`;
}
