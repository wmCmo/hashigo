/**
 * Position keys for the ordered rows — `template_fields.pos` and its siblings.
 *
 * `pos` is TEXT and Mochi writes a FRACTIONAL INDEX into it (`a`, `ab`, `ac`, `u`,
 * `z`, `zU`, `zj`, `zr` on 単語), so that inserting between two neighbours needs no
 * renumber. `src/backup/archive.ts` already carries the warning that `Number(pos)`
 * is NaN and a numeric read would restore every field unordered.
 *
 * ─── WHY REORDERING RENUMBERS INSTEAD OF INSERTING BETWEEN ──────────────────
 *
 * A general fractional index is the better data structure and the wrong amount of
 * code here. Producing a key strictly between two others is easy in the middle and
 * fiddly at the ends — there is no key before `a` unless the smallest digit is
 * reserved, and getting that wrong produces an ordering that is subtly wrong rather
 * than obviously broken. The thing being ordered is at most **11 rows** (単語, the
 * largest template), reordered only from one screen, one template at a time, inside
 * a transaction that already records every old value for the undo.
 *
 * So a move rewrites the whole template's keys, evenly spaced, and the correctness
 * argument is "the array is in the order the caller asked for" rather than an
 * invariant about string midpoints.
 *
 * ─── FIXED WIDTH, BECAUSE THE COLUMN SORTS AS TEXT ──────────────────────────
 *
 * `ORDER BY pos` is lexicographic. Variable-width base-26 breaks that at 27 rows:
 * `aa` sorts before `b`, so field 27 would jump to position 2. Fixed width makes
 * lexicographic order and numeric order the same thing, which is the property the
 * index `template_fields_pos` is relied on for.
 *
 * Letters rather than digits on purpose: `001` invites exactly the `Number(pos)`
 * read the archive warns about, and a key that cannot be mistaken for a number will
 * not be.
 */

const DIGITS = "abcdefghijklmnopqrstuvwxyz";

/**
 * `n` keys in ascending order, all the same length.
 *
 * ```
 * positionKeys(3)   ["a", "b", "c"]
 * positionKeys(27)  ["aa", "ab", … "ba"]   — width 2, so "aa" < "ab" < … < "ba"
 * ```
 */
export function positionKeys(n: number): string[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`positionKeys(${n})`);
  if (n === 0) return [];
  let width = 1;
  while (DIGITS.length ** width < n) width += 1;

  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) {
    let rest = i;
    let key = "";
    for (let place = 0; place < width; place += 1) {
      key = DIGITS[rest % DIGITS.length] + key;
      rest = Math.floor(rest / DIGITS.length);
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Move one id within an order, returning the whole new order.
 *
 * `before` is the id to land in FRONT of; `null` means the end. Returns the input
 * unchanged when the id is absent, or when the move is a no-op — a caller that
 * writes on every drag would otherwise fill the undo stack with nothing.
 */
export function moveWithin<T>(order: readonly T[], id: T, before: T | null): T[] {
  const from = order.indexOf(id);
  if (from === -1) return [...order];
  const without = order.filter((entry) => entry !== id);
  const at = before === null ? without.length : without.indexOf(before);
  if (at === -1) return [...order];
  without.splice(at, 0, id);
  return without;
}
