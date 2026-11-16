export interface KeyTarget {
  readonly tagName?: string | undefined;
  readonly isContentEditable?: boolean | undefined;
}

export function isTypingTarget(target: KeyTarget | null | undefined): boolean {
  if (target === null || target === undefined) return false;
  if (target.isContentEditable === true) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function survivesTyping(key: string): boolean {
  return key === "Escape";
}
