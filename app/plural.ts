/**
 * A count and its noun, agreeing: "1 card", "3,702 cards".
 *
 * Replaces the "(s)" the app used to print, which read wrong in the common case:
 * "1 device(s) have newer grades". A verb that has to agree too ("has" / "have")
 * is the caller's to pick; this only does the noun.
 */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
