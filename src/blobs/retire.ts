import type { SqliteHandle } from "../db/browser.js";

export const RETIRED_KEY = "clips.retired";

const HASH = /^[0-9a-f]{64}$/;

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

export function writeRetired(db: SqliteHandle, hashes: Iterable<string>): void {
  const list = [...new Set([...hashes].filter((hash) => HASH.test(hash)))].sort();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE settings.value IS NOT excluded.value`,
  ).run(RETIRED_KEY, JSON.stringify(list));
}

export function retireBlob(db: SqliteHandle, hash: string): boolean {
  if (!HASH.test(hash)) return false;
  const current = retiredHashes(db);
  if (current.includes(hash)) return false;
  writeRetired(db, [...current, hash]);
  return true;
}

export function unretireBlob(db: SqliteHandle, hash: string): boolean {
  const current = retiredHashes(db);
  if (!current.includes(hash)) return false;
  writeRetired(
    db,
    current.filter((entry) => entry !== hash),
  );
  return true;
}
