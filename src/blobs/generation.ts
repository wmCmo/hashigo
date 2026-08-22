/**
 * The generation cache key, and the normalisation that feeds it.
 *
 * WHY THIS IS ITS OWN FILE, AND WHY IT IS HERE. It used to live in
 * `src/import/blobs.ts` — 1,177 lines of Node I/O — and `src/generate/store.ts`
 * value-imported three functions out of it. That one import made the whole of
 * `src/generate` unloadable in a browser, which is where the review screen runs.
 * `test/browser-portable.test.ts` recorded it as `KNOWN_NODE_BOUND`.
 *
 * THE FIX WAS NOT THE ONE ON RECORD, AND THIS IS WORTH READING BEFORE BELIEVING
 * EITHER. `notes/browser-feasibility.md` §5 called `node:crypto` ->
 * `crypto.subtle` "the one genuinely invasive change", on the grounds that
 * `crypto.subtle.digest` is ASYNC and would therefore change the signature of
 * the key, the resolver, and everything above them. Two later sessions carried
 * that forward as the plan.
 *
 * It was obsolete. `src/blobs/sha256.ts` is a SYNCHRONOUS, dependency-free
 * SHA-256 that exists for exactly this reason and says so in its own header —
 * it is already the default digest of `SqliteBlobStore`, already runs in the
 * browser, and already agrees with `node:crypto` bit for bit on all 10,816
 * payloads of the real corpus. So the key stays synchronous, no signature
 * changes, and this file is a MOVE plus one changed line.
 *
 * `contentAddress` deliberately did NOT come along. It hashes payload bytes —
 * 625 MB on a full import — where `node:crypto`'s OpenSSL is roughly 5× faster,
 * and the importer is Node-only anyway. This file hashes a headword and an
 * options map, where 5× of nothing is nothing.
 *
 * ONE THING THAT MUST NOT MOVE WITHOUT A MEASUREMENT: the key's bytes. A digest
 * that differs from the old one by a single bit turns all 42,569 cached
 * generations into permanent misses and re-bills the corpus, silently, because
 * a miss is not an error. `test/blobs.test.ts` recomputes every key in the
 * corpus under both implementations and demands they agree.
 */

import type { SqliteHandle } from "../db/browser.js";
import type { BlobKind } from "../schema/index.js";

import { sha256Hex } from "./sha256.js";

// ─── identity ────────────────────────────────────────────────────────────────

/** Versioned so the key scheme can be changed deliberately, never by accident. */
export const GENERATION_KEY_SCHEME = "hashigo/blob-identity/1";

/** The columns of `blobs` that make up a generation's identity. */
export interface GenerationIdentity {
  readonly kind: BlobKind;
  /** Normalised generator input: `normaliseSourceText` output, never raw. */
  readonly sourceText: string;
  readonly voice: string | null;
  /** BCP-47. Never Mochi's "jp". */
  readonly lang: string | null;
  /**
   * Canonical JSON of every remaining option. `voice` and `lang` are excluded
   * because they have their own columns, so nothing is hashed twice.
   */
  readonly options: string;
}

/**
 * SPEC's sha256(normalised_text, voice, lang), widened to the full identity
 * tuple. NUL-separated so no field can bleed into the next.
 */
export function generationKey(identity: GenerationIdentity): string {
  // `TextEncoder`, not `createHash().update(string)`. Node's `update` defaults
  // to utf8 and this produces the same bytes — but "the same bytes" is a claim
  // about 3,850 Japanese head words, not about ASCII, so it is asserted over the
  // real corpus rather than reasoned about. A digest that differs here by one
  // bit is not an error anyone sees: it is 42,569 permanent cache misses and a
  // re-billed corpus.
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

// ─── normalisation ───────────────────────────────────────────────────────────

const ZERO_WIDTH = /[\u200b\u200c\u200d\ufeff]/g;
const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * The cache key's text. NFC, zero-width/format characters stripped, whitespace
 * collapsed, trimmed. Deliberately NOT NFKC — see the header.
 */
export function normaliseSourceText(text: string): string {
  return text
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(FORMAT_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Voice-locale spellings observed in the corpus, mapped to BCP-47. */
export const LOCALE_ALIASES: Readonly<Record<string, string>> = {
  jp: "ja-JP",
  ja: "ja-JP",
  "ja-jp": "ja-JP",
  en: "en-US",
  "en-us": "en-US",
};

/** Translation/dictionary language parameters: only the invalid code is wrong. */
export const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { jp: "ja" };

/** Option keys holding a voice locale, versus those holding a bare language. */
const LOCALE_OPTION_KEYS = new Set(["lang", "language"]);
const LANGUAGE_OPTION_KEYS = new Set(["from", "to"]);

/** `ll` / `ll-RR` casing, so `JA-jp` and `ja-JP` are one tag. */
function canonicaliseTag(code: string): string {
  const parts = code.trim().split("-");
  const head = parts[0];
  if (head === undefined || head === "") return code.trim();
  return [
    head.toLowerCase(),
    ...parts.slice(1).map((part) => (part.length === 2 ? part.toUpperCase() : part)),
  ].join("-");
}

/**
 * Strip combining marks so a stray one cannot hide a tag from the alias table.
 *
 * The corpus contains `lang="่jp"` on exactly one inline generator — U+0E48 THAI
 * CHARACTER MAI EK, a nonspacing mark, in front of `jp`. It is a typo of Zach's,
 * counted from the raw export with codepoints, and it defeated the lookup: the
 * key was `"่jp"`, not `"jp"`, so the tag fell through unchanged. That is latent
 * today because inline generators are not materialised until stage 9 — every
 * `blobs.lang` in the database is well formed — and it costs two things the day
 * it fires: one TTS request for a locale no provider knows, and a permanent
 * cache miss, because the malformed tag is part of the address.
 *
 * NFKD first so a precomposed mark decomposes into one this can see. Nothing in
 * a legitimate BCP-47 tag is a mark, so no valid input changes.
 */
function stripMarks(code: string): string {
  return code.normalize("NFKD").replace(/\p{M}/gu, "");
}

/**
 * Normalise a language code. `locale: true` for a TTS locale (region-qualified,
 * jp -> ja-JP); `false` for a translation parameter (jp -> ja).
 */
export function normaliseLanguageTag(code: string, locale: boolean): string {
  const cleaned = stripMarks(code.trim());
  const table = locale ? LOCALE_ALIASES : LANGUAGE_ALIASES;
  return table[cleaned.toLowerCase()] ?? canonicaliseTag(cleaned);
}

/**
 * Canonical JSON: keys sorted, no whitespace. Part of the hash, so two orderings
 * of the same options must not produce two addresses.
 */
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

/** A generation request as a caller states it, before normalisation. */
export interface GenerationRequest {
  readonly kind: BlobKind;
  /** Raw resolved text. Normalised here; hand the RAW text to the generator. */
  readonly text: string;
  readonly voice?: string | null;
  /** Any spelling: "jp", "ja", "ja-JP". */
  readonly lang?: string | null;
  readonly options?: Readonly<Record<string, string>>;
}


// ─── the cache lookup ────────────────────────────────────────────────────────

const LOOKUP_SQL = `
SELECT hash FROM blobs
 WHERE kind = ? AND source_text = ? AND voice IS ? AND lang IS ? AND options = ?
   AND byte_size > 0
 ORDER BY hash LIMIT 1`;

/**
 * Prepared once per handle. `resolveFieldGenerations` walks 18,356 field slots,
 * so re-preparing per call is 18,356 compiles of one statement; a WeakMap keeps
 * it to one and lets the handle be collected with it. Same shape the importer's
 * own `statements()` uses.
 */
const LOOKUPS = new WeakMap<SqliteHandle, { get(...params: readonly unknown[]): unknown }>();

function lookupStatement(db: SqliteHandle): { get(...params: readonly unknown[]): unknown } {
  let cached = LOOKUPS.get(db);
  if (cached === undefined) {
    cached = db.prepare(LOOKUP_SQL);
    LOOKUPS.set(db, cached);
  }
  return cached;
}

/** Normalise a request into the identity tuple that addresses the cache. */
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

/**
 * The cache lookup. Returns the content address of an existing blob for exactly
 * this input, or null.
 *
 * `byte_size > 0` excludes the 10 failed generations Mochi left behind as live
 * zero-byte attachments: a broken file must not become a permanent cache hit.
 * `ORDER BY hash` makes the answer deterministic where Azure's non-determinism
 * left two blobs under one key (12 such keys in the corpus).
 */
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

