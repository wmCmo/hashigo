/**
 * THE ARGUMENT READER THE CLIs SHARE.
 *
 * `arg()` was byte-identical in four of the six CLIs — `accent`, `backup`, `scheduler`
 * and `session`, verified by hashing the four bodies. Four copies of ten lines is not
 * expensive to maintain; it is expensive to CHANGE, because improving the error
 * message or the `--flag --flag` handling in one leaves three behind, and nothing
 * tells you which one you are reading.
 *
 * NODE-ONLY, and that is why it lives under `src/cli/` rather than in a general
 * utility module. It reads `process.argv` at call time, so importing it from anything
 * that runs in the browser worker would pull `process` into a bundle that has none.
 * `src/schema/index.ts` carries the same warning for the same reason, and paid for it
 * once already.
 */

/**
 * The value after `--name`, or `fallback`, or a throw.
 *
 * A following token that itself starts with `--` counts as MISSING rather than as the
 * value: `--db --limit 20` is a typo, and reading `--limit` as the database path turns
 * it into a confusing error much further away from the mistake.
 */
export function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
}

/** True when `--name` is present at all. Values are `arg`'s business. */
export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * `arg()` parsed as a positive integer, with the same missing-value rules.
 *
 * Rejects `0`, negatives and anything non-numeric rather than passing them into a
 * `LIMIT`, where a silent `NaN` becomes a query that returns nothing and looks empty.
 */
export function intArg(name: string, fallback?: number): number {
  const raw = arg(name, fallback === undefined ? undefined : String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, not ${JSON.stringify(raw)}`);
  }
  return value;
}
