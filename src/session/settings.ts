import { DEFAULT_INTERLEAVE, DEFAULT_NEW_LIMIT, type InterleavePolicy } from "./session.js";

import type { SqliteHandle } from "../db/browser.js";
import {
  DEFAULT_EXAM_TARGET,
  EXAM_TARGET_KEY,
  isExamTarget,
  type ExamTarget,
} from "../scheduler/kanken.js";

export const SESSION_SETTING_KEYS = {
  newLimit: "new.limit",
  interleave: "session.interleave",
  examTarget: EXAM_TARGET_KEY,
} as const;

const MAX_NEW_LIMIT = 500;

const INTERLEAVE_VALUES: readonly InterleavePolicy[] = ["new-first", "due-first", "spread"];

export interface SessionSettings {
  readonly newLimit: number;
  readonly interleave: InterleavePolicy;
  readonly examTarget: ExamTarget;
  readonly rejected: readonly { readonly key: string; readonly value: string }[];
}

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

export function readSessionSettings(db: SqliteHandle): SessionSettings {
  const rejected: { key: string; value: string }[] = [];

  const rawLimit = readSetting(db, SESSION_SETTING_KEYS.newLimit);
  let newLimit = DEFAULT_NEW_LIMIT;
  if (rawLimit !== null) {
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

  const rawTarget = readSetting(db, SESSION_SETTING_KEYS.examTarget);
  let examTarget = DEFAULT_EXAM_TARGET;
  if (rawTarget !== null) {
    if (isExamTarget(rawTarget.trim())) examTarget = rawTarget.trim() as ExamTarget;
    else rejected.push({ key: SESSION_SETTING_KEYS.examTarget, value: rawTarget });
  }

  return { newLimit, interleave, examTarget, rejected };
}

export { INTERLEAVE_VALUES, MAX_NEW_LIMIT };
