const KEY = "hashigo.visits";

export const VISIT_LIMIT = 50;

export function readVisits(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, VISIT_LIMIT);
  } catch {
    return [];
  }
}

export function noteVisit(cardId: string): void {
  if (cardId === "") return;
  const next = [cardId, ...readVisits().filter((id) => id !== cardId)].slice(0, VISIT_LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
  }
}

export function clearVisits(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
  }
}
