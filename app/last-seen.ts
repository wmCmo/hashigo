const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export function lastSeenLabel(lastReviewedAt: string | null | undefined): string | null {
  if (typeof lastReviewedAt !== "string") return null;
  const date = lastReviewedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

export function lastSeenTitle(lastReviewedAt: string | null | undefined): string | null {
  const label = lastSeenLabel(lastReviewedAt);
  return label === null ? null : `last reviewed ${label}`;
}
