import type { SqliteHandle } from "../db/browser.js";
import type { BlobKind } from "../schema/index.js";

import { sha256Hex } from "./sha256.js";

export const GENERATION_KEY_SCHEME = "hashigo/blob-identity/1";

export interface GenerationIdentity {
  readonly kind: BlobKind;
  readonly sourceText: string;
  readonly voice: string | null;
  readonly lang: string | null;
  readonly options: string;
}

export function generationKey(identity: GenerationIdentity): string {
  return sha256Hex(
    new TextEncoder().encode(
      [
        GENERATION_KEY_SCHEME,
        identity.kind,
        identity.sourceText,
        identity.voice ?? "",
        identity.lang ?? "",
        identity.options,
      ].join("\u0000"),
    ),
  );
}

const ZERO_WIDTH = /[\u200b\u200c\u200d\ufeff]/g;
const FORMAT_CHARS = /\p{Cf}/gu;

export function normaliseSourceText(text: string): string {
  return text
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(FORMAT_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const LOCALE_ALIASES: Readonly<Record<string, string>> = {
  jp: "ja-JP",
  ja: "ja-JP",
  "ja-jp": "ja-JP",
  en: "en-US",
  "en-us": "en-US",
};

export const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { jp: "ja" };

const LOCALE_OPTION_KEYS = new Set(["lang", "language"]);
const LANGUAGE_OPTION_KEYS = new Set(["from", "to"]);

function canonicaliseTag(code: string): string {
  const parts = code.trim().split("-");
  const head = parts[0];
  if (head === undefined || head === "") return code.trim();
  return [
    head.toLowerCase(),
    ...parts.slice(1).map((part) => (part.length === 2 ? part.toUpperCase() : part)),
  ].join("-");
}

function stripMarks(code: string): string {
  return code.normalize("NFKD").replace(/\p{M}/gu, "");
}

export function normaliseLanguageTag(code: string, locale: boolean): string {
  const cleaned = stripMarks(code.trim());
  const table = locale ? LOCALE_ALIASES : LANGUAGE_ALIASES;
  return table[cleaned.toLowerCase()] ?? canonicaliseTag(cleaned);
}

export function canonicaliseOptions(options: Readonly<Record<string, string>>): string {
  const out: Record<string, string> = {};
  for (const key of Object.keys(options).sort()) {
    const value = options[key];
    if (value === undefined) continue;
    out[key] = LOCALE_OPTION_KEYS.has(key)
      ? normaliseLanguageTag(value, true)
      : LANGUAGE_OPTION_KEYS.has(key)
        ? normaliseLanguageTag(value, false)
        : value;
  }
  return JSON.stringify(out);
}

export interface GenerationRequest {
  readonly kind: BlobKind;
  readonly text: string;
  readonly voice?: string | null;
  readonly lang?: string | null;
  readonly options?: Readonly<Record<string, string>>;
}

const LOOKUP_SQL = `
SELECT hash FROM blobs
 WHERE kind = ? AND source_text = ? AND voice IS ? AND lang IS ? AND options = ?
   AND byte_size > 0
   AND hash NOT IN (
     SELECT value FROM json_each(COALESCE((SELECT value FROM settings WHERE key = 'clips.retired'), '[]')))
 ORDER BY hash LIMIT 1`;

const LOOKUPS = new WeakMap<SqliteHandle, { get(...params: readonly unknown[]): unknown }>();

function lookupStatement(db: SqliteHandle): { get(...params: readonly unknown[]): unknown } {
  let cached = LOOKUPS.get(db);
  if (cached === undefined) {
    cached = db.prepare(LOOKUP_SQL);
    LOOKUPS.set(db, cached);
  }
  return cached;
}

export function generationIdentity(request: GenerationRequest): GenerationIdentity {
  const options: Record<string, string> = { ...(request.options ?? {}) };
  delete options["lang"];
  delete options["voice"];
  return {
    kind: request.kind,
    sourceText: normaliseSourceText(request.text),
    voice: request.voice ?? null,
    lang: request.lang == null ? null : normaliseLanguageTag(request.lang, true),
    options: canonicaliseOptions(options),
  };
}

export function lookupGeneration(
  db: SqliteHandle,
  identity: GenerationIdentity,
): string | null {
  const row = lookupStatement(db).get(
    identity.kind,
    identity.sourceText,
    identity.voice,
    identity.lang,
    identity.options,
  ) as { hash: string } | undefined;
  return row?.hash ?? null;
}

const LOOKUP_ALL_SQL = LOOKUP_SQL.replace(/\s+LIMIT 1$/, "");
const LOOKUPS_ALL = new WeakMap<SqliteHandle, { all(...params: readonly unknown[]): unknown[] }>();

export function lookupGenerations(db: SqliteHandle, identity: GenerationIdentity): string[] {
  let statement = LOOKUPS_ALL.get(db);
  if (statement === undefined) {
    statement = db.prepare(LOOKUP_ALL_SQL);
    LOOKUPS_ALL.set(db, statement);
  }
  const rows = statement.all(
    identity.kind,
    identity.sourceText,
    identity.voice,
    identity.lang,
    identity.options,
  ) as Array<{ hash: string }>;
  return rows.map((row) => row.hash);
}

