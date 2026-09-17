/**
 * WHICH OPTION KEYS ARE PART OF A GENERATION'S CACHE KEY.
 *
 * Moved here from `src/generate/fields.ts` so the field registry can DESCRIBE the
 * rule without becoming a second copy of it. `src/generate/fields.ts` still
 * re-exports the set and `keyOptions` is still the only thing that applies it —
 * the direction matters, and it is the one this repo keeps learning: two copies
 * of a cache rule is a permanent silent miss (`src/cards/audio.ts:152`).
 *
 * Measured, not assumed: across 42,569 blob identities not one carries
 * `ai-custom-prompt` or `randomize`. `lang` and `voice` are excluded because
 * `generationIdentity` gives them their own slots — leaving them in would hash
 * them twice.
 *
 * ─── AND WHY `hashigo-` IS IN HERE ──────────────────────────────────────────
 *
 * `keyOptions` stringifies EVERY key it is not told to skip. So a locally-added
 * key landing on a generator field — `hashigo-role` on the ojad field, say —
 * would change that field's identity and miss every clip it has, for ever, in
 * green. The prefix is excluded by RULE rather than by enumeration, so a second
 * local key cannot reintroduce the bug by being forgotten here.
 */

/** Keys this project adds. Never Mochi's, never part of a cache key. */
export const LOCAL_OPTION_PREFIX = "hashigo-";

/** Mochi's own keys that are not part of its cache key. */
const MOCHI_NON_KEY = ["ai-custom-prompt", "randomize", "lang", "voice"] as const;

/**
 * A Set whose `has` also answers true for any `hashigo-` key.
 *
 * A Set rather than a predicate because `keyOptions` already calls `.has` and the
 * call site should not have to change to stay correct.
 */
class NonKeyOptions extends Set<string> {
  override has(key: string): boolean {
    return key.startsWith(LOCAL_OPTION_PREFIX) || super.has(key);
  }
}

export const NON_KEY_OPTIONS: ReadonlySet<string> = new NonKeyOptions(MOCHI_NON_KEY);

/** The Mochi keys alone, for a test that wants the literal list. */
export const MOCHI_NON_KEY_OPTIONS: readonly string[] = MOCHI_NON_KEY;
