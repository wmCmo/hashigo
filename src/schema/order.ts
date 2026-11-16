const DIGITS = "abcdefghijklmnopqrstuvwxyz";

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

export function moveWithin<T>(order: readonly T[], id: T, before: T | null): T[] {
  const from = order.indexOf(id);
  if (from === -1) return [...order];
  const without = order.filter((entry) => entry !== id);
  const at = before === null ? without.length : without.indexOf(before);
  if (at === -1) return [...order];
  without.splice(at, 0, id);
  return without;
}
