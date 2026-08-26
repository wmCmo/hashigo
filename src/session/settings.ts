/**
 * Decision 12's *"and are a SETTING"*, made true.
 *
 * `DEFAULT_NEW_LIMIT` has been a constant since the session was written, and every
 * caller either passed a number or took 10. Decision 12 says new cards per day *is
 * a setting*; until this file it was a default with a CLI flag in front of it, which
 * is a different thing — nothing persisted, so the app started every session on 10
 * whatever he had chosen last time.
 *
 * ─── WHY THESE TWO KEYS ARE NOT SEEDED BY `schema.sql` ──────────────────────
 *
 * They could be, and it would cost a `SCHEMA_VERSION` bump: `applySchema` refuses
 * any version but its own, so a seed change means `rm build/hashigo.db`, a
 * re-import, a dashboard regenerate and an accent reload — the three-step chore in
 * `CLAUDE.md` — for two rows whose absence has an exact, correct meaning.
 *
 * So they are resolved instead: **absent means the default**, and the default is
 * the constant the session already had. A database from before this file behaves
 * identically to one from after it, which is the property that makes skipping the
 * bump honest rather than lazy. `settings` is a key/value table with a `PRIMARY
 * KEY`, so writing a key it was not seeded with is an ordinary insert.
 *
 * They still reach the backup: `src/backup/archive.ts` archives `settings` whole,
 * by row, so a value he chose survives decision 16's final import even though the
 * import does not know these keys exist.
 *
 * ─── A BAD VALUE MUST NEVER BRICK THE SESSION ───────────────────────────────
 *
 * Every read here falls back rather than throwing. These rows are reachable from a
 * settings screen, from a restored archive, and from `sqlite3` — and the failure
 * mode of a strict read is an app that will not open until someone edits a database
 * by hand. A nonsense value is a wrong session for one day; a throw is no session
 * at all. `readSessionSettings` reports what it rejected so a caller can say so.
 */

import { DEFAULT_INTERLEAVE, DEFAULT_NEW_LIMIT, type InterleavePolicy } from "./session.js";

import type { SqliteHandle } from "../db/browser.js";

/**
 * The keys this module owns. Not in `SETTING_KEYS` (`src/schema`), which documents
 * itself as "keys seeded into `settings` by schema.sql" — these are deliberately
 * not seeded, and putting them in that list would make it wrong.
 */
export const SESSION_SETTING_KEYS = {
  /** Decision 12. `0` is legal and means "due cards only". */
  newLimit: "new.limit",
  /** Which end of the plan new cards land in. `spread` is Zach's, 2026-08-23. */
  interleave: "session.interleave",
} as const;

/** New cards per day cannot usefully exceed a day's attention. */
const MAX_NEW_LIMIT = 500;

const INTERLEAVE_VALUES: readonly InterleavePolicy[] = ["new-first", "due-first", "spread"];

export interface SessionSettings {
  readonly newLimit: number;
  readonly interleave: InterleavePolicy;
  /**
   * Keys whose stored value could not be used, with the raw text.
   *
   * Empty on every healthy database. It exists so a screen can say "new.limit is
   * 'ten', using 10" instead of silently substituting — a setting that quietly
   * ignores what it was told is worse than one that refuses.
   */
  readonly rejected: readonly { readonly key: string; readonly value: string }[];
}

/** One row, or null. Missing table included — a caller may hold any database. */
export function readSetting(db: SqliteHandle, key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Write one setting. Upsert, because these keys may not exist yet — see the header.
 *
 * Returns the value it replaced, which is what an undo needs. `null` means the key
 * was absent, and undoing to absent is not the same as undoing to the default: a
 * caller that wants the row gone has to delete it.
 */
export function writeSetting(db: SqliteHandle, key: string, value: string): string | null {
  const previous = readSetting(db, key);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET
       value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(key, value);
  return previous;
}

/** Resolve both session settings, substituting the default for anything unusable. */
export function readSessionSettings(db: SqliteHandle): SessionSettings {
  const rejected: { key: string; value: string }[] = [];

  const rawLimit = readSetting(db, SESSION_SETTING_KEYS.newLimit);
  let newLimit = DEFAULT_NEW_LIMIT;
  if (rawLimit !== null) {
    // `Number("")` is 0 and `Number(" 10 ")` is 10, so the empty string has to be
    // rejected explicitly or a cleared box silently means "no new cards".
    const parsed = rawLimit.trim() === "" ? Number.NaN : Number(rawLimit);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_NEW_LIMIT) newLimit = parsed;
    else rejected.push({ key: SESSION_SETTING_KEYS.newLimit, value: rawLimit });
  }

  const rawInterleave = readSetting(db, SESSION_SETTING_KEYS.interleave);
  let interleave = DEFAULT_INTERLEAVE;
  if (rawInterleave !== null) {
    if ((INTERLEAVE_VALUES as readonly string[]).includes(rawInterleave)) {
      interleave = rawInterleave as InterleavePolicy;
    } else {
      rejected.push({ key: SESSION_SETTING_KEYS.interleave, value: rawInterleave });
    }
  }

  return { newLimit, interleave, rejected };
}

export { INTERLEAVE_VALUES, MAX_NEW_LIMIT };
