/**
 * RETIRING A CLIP — discarded, but not deleted, and the clip itself untouched.
 *
 * Zach, 2026-09-26, on 日向's example sentence: *"the audio … read it as みゅー、、、
 * i need a way to discard that audio and regenerate it"*. A clip is found by its
 * generation identity through `lookupGeneration`. To stop a bad clip playing, the
 * lookup must stop returning it; to keep the operation reversible, its bytes must
 * stay.
 *
 * ─── WHY A LIST BESIDE THE CLIPS, NOT A MARK ON THEM ───────────────────────
 *
 * The first version renamed the retired row's voice, and the schema refused it:
 * `blobs_immutable` aborts any change to a blob's identity tuple, and
 * `schema.sql` states the rule it protects — *"Blobs are immutable and shared …
 * There is deliberately no deleted? flag anywhere in this schema"* (decision 4,
 * content addressing). That guard is right and stays.
 *
 * So retirement is a RECORD, not a mutation: a sorted JSON array of hashes in the
 * free key/value `settings` table (`clips.retired`), which `LOOKUP_SQL` in
 * `./generation.ts` excludes. The blob row, its bytes and its refcount never
 * change. No schema bump (decision 41), and unretiring is removing one entry.
 *
 * Spread everywhere the same way:
 *   * the device that redid the clip — `app/db.worker.ts`, straight away;
 *   * every other device — `src/sync/merge.ts`, as a UNION of both lists (the
 *     settings row alone would be overwritten wholesale by the backup apply);
 *   * the laptop's `build/hashigo.db` — `scripts/cloud-generated-pull.ts`, from
 *     the `replaces` the Worker records beside the new clip.
 */
import type { SqliteHandle } from "../db/browser.js";

/** The `settings` key holding the retired hashes. `./generation.ts` reads it too. */
export const RETIRED_KEY = "clips.retired";

const HASH = /^[0-9a-f]{64}$/;

/** Every retired clip on this database, sorted. */
export function retiredHashes(db: SqliteHandle): string[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(RETIRED_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((entry): entry is string => typeof entry === "string" && HASH.test(entry)))].sort()
      : [];
  } catch {
    return [];
  }
}

/** Replace the whole list. Kept sorted and unique so two devices write the same text. */
export function writeRetired(db: SqliteHandle, hashes: Iterable<string>): void {
  const list = [...new Set([...hashes].filter((hash) => HASH.test(hash)))].sort();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE settings.value IS NOT excluded.value`,
  ).run(RETIRED_KEY, JSON.stringify(list));
}

/** Retire one clip. Returns true when the list changed. */
export function retireBlob(db: SqliteHandle, hash: string): boolean {
  if (!HASH.test(hash)) return false;
  const current = retiredHashes(db);
  if (current.includes(hash)) return false;
  writeRetired(db, [...current, hash]);
  return true;
}

/** Undo a retirement — used when a redo came back byte-for-byte the same clip. */
export function unretireBlob(db: SqliteHandle, hash: string): boolean {
  const current = retiredHashes(db);
  if (!current.includes(hash)) return false;
  writeRetired(
    db,
    current.filter((entry) => entry !== hash),
  );
  return true;
}
