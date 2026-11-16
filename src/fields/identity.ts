export const LOCAL_OPTION_PREFIX = "hashigo-";

const MOCHI_NON_KEY = ["ai-custom-prompt", "randomize", "lang", "voice"] as const;

class NonKeyOptions extends Set<string> {
  override has(key: string): boolean {
    return key.startsWith(LOCAL_OPTION_PREFIX) || super.has(key);
  }
}

export const NON_KEY_OPTIONS: ReadonlySet<string> = new NonKeyOptions(MOCHI_NON_KEY);

export const MOCHI_NON_KEY_OPTIONS: readonly string[] = MOCHI_NON_KEY;
