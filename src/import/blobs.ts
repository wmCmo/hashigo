/**
 * Stage 1 — attachments and Mochi's `component-cache` into the content-addressed,
 * refcounted blob store.  This is the fix for the central bug SPEC.html diagnoses
 * under "Why your attachments keep breaking": Mochi keys its generation cache on
 * the whole concatenated card text, so a one-character typo fix bills a fresh
 * Azure call, writes a new mp3 and tombstones the old one.  Nothing reconciles
 * the leftovers.  Measured consequences in the reference corpus:
 *
 *   10,887  live attachments, all present on disk, `size` exact on every one
 *    8,958  tombstoned attachment records (deleted? true) -- NEVER imported
 *    7,974  cache entries pointing at a file with no attachment record at all:
 *           churn debris whose tombstone was itself lost.  Also never imported.
 *    5,667  cache entries pointing at a tombstoned file.  Same.
 *
 * WHAT THE ADDRESS IS, AND WHY IT IS THE BYTES
 *
 * schema.sql's header suggests hashing the identity tuple (kind, source_text,
 * voice, lang, options).  The corpus rules that out, twice over:
 *
 *   * 12 normalised generation keys resolve to live files whose BYTES DIFFER.
 *     Azure is not bit-reproducible: the same text and voice, generated twice,
 *     returns two different mp3s.  Tuple-addressing would force discarding 12
 *     real, still-referenced files.
 *   * 30 live files have no cache provenance at all (5 images plus 25 mp3s whose
 *     cache entry is gone).  Their tuple is (kind, NULL, NULL, NULL, '{}') --
 *     one address for all 30.
 *
 * So `blobs.hash = sha256(payload bytes)`.  That is a real content address: it is
 * verifiable by rehashing, it cannot collide across unrelated payloads, and it
 * deduplicates -- 10,887 files collapse to 10,816 blobs (71 byte-identical: 60
 * pairs, one triple, and one group of 10 discussed below).
 *
 * The generation cache is then the identity tuple *stored on* the blob row and
 * indexed by `blobs_kind_text (kind, source_text)`.  `generationKey()` computes
 * SPEC's sha256(normalised text, voice, lang) for callers that want the key
 * itself; `lookupGeneration()` is the cache-hit path and is what makes
 * regenerating identical input free.
 *
 * KNOWN COST OF HAVING NO CACHE TABLE.  The key -> blob relation is genuinely
 * many-to-many (10,834 keys, 10,848 edges, 10,816 blobs; 12 keys reach two
 * blobs, 39 blobs are reached by two or more keys) but a blob row holds exactly
 * one tuple.  49 of 10,848 edges are therefore unrepresentable and are dropped,
 * deterministically keeping the lexicographically smallest key per blob.  Effect
 * in production: 0.45% of cached inputs would miss and re-bill.  A
 * `generation_cache(key TEXT PRIMARY KEY, blob_hash)` table would remove that
 * entirely.  Nothing here modifies the schema.
 *
 * MIME IS SNIFFED, NEVER TRUSTED.  SPEC notes some mp3s claim "text/xml" --
 * Azure's SSML content-type leaking into Mochi's metadata.  It is worse than
 * that: only 41 of 10,887 declared types are correct.  4,979 say
 * application/octet-stream, 3,443 say text/xml and 2,424 say nothing at all,
 * while the bytes are 10,867 mp3, 9 jpeg, 1 png and 10 empty.
 *
 * ZERO-BYTE ATTACHMENTS.  10 live attachments (all in English, all claiming
 * text/xml) are 0 bytes: failed Azure calls Mochi recorded as live.  They are
 * imported, because the reference is live and dropping it would lose the fact,
 * but they all share sha256("") and so collapse into one blob with refcount 10 --
 * a small demonstration of the fix.  `lookupGeneration` refuses to return a
 * zero-byte blob, so those inputs regenerate on demand instead of serving
 * silence forever.
 *
 * LANGUAGE CODES.  Inline tags use lang="jp", field options use "ja-JP" (SPEC),
 * and the corpus also carries bare "ja"/"en" plus `:from "jp"` on dictionary
 * lookups -- where the invalid code demonstrably caused a 404 while `:from "ja"`
 * on the same word (握る) succeeded.  Voice locales normalise to a
 * region-qualified BCP-47 tag (jp -> ja-JP); translation language parameters
 * normalise only the invalid spelling (jp -> ja), because "ja" is already valid
 * BCP-47 and is what a translation API expects.
 *
 * TEXT NORMALISATION.  NFC, zero-width and format characters stripped,
 * whitespace runs collapsed, trimmed.  Measured, not assumed: raw / trim / NFC /
 * NFKC all yield exactly 10,834 keys and 12 collisions on this corpus, so NFKC
 * buys nothing -- and it rewrites 449 of the cached texts (full-width tilde and
 * friends), which is risk with no return.  The normalised text is the cache KEY
 * only; a generator must be handed the raw resolved text.
 *
 * The option map is part of the key.  Dropping `:gender` -- which 10,967 speech
 * entries carry, sometimes alongside a voice -- would merge keys that genuinely
 * produced different audio: collisions rise from 12 to 46.
 *
 * Node only, like src/db: the importer and the tests.  The browser/OPFS build
 * gets bytes from a different place, which is why every filesystem touch goes
 * through the injectable `readMedia` hook.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Statement } from "better-sqlite3";

import type { Db } from "../db/index.js";
import type { BlobKind } from "../schema/index.js";

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

/** Lowercase hex sha256 of the payload. This is `blobs.hash`. */
export function contentAddress(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * SPEC's sha256(normalised_text, voice, lang), widened to the full identity
 * tuple. NUL-separated so no field can bleed into the next.
 */
export function generationKey(identity: GenerationIdentity): string {
  return createHash("sha256")
    .update(
      [
        GENERATION_KEY_SCHEME,
        identity.kind,
        identity.sourceText,
        identity.voice ?? "",
        identity.lang ?? "",
        identity.options,
      ].join("\u0000"),
    )
    .digest("hex");
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
 * Normalise a language code. `locale: true` for a TTS locale (region-qualified,
 * jp -> ja-JP); `false` for a translation parameter (jp -> ja).
 */
export function normaliseLanguageTag(code: string, locale: boolean): string {
  const key = code.trim().toLowerCase();
  const table = locale ? LOCALE_ALIASES : LANGUAGE_ALIASES;
  return table[key] ?? canonicaliseTag(code);
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

// ─── Mochi's component-cache keys ────────────────────────────────────────────

/**
 * Mochi's cache key is `<source text> <edn options map>`, e.g.
 * `だけに {:lang "ja-JP", :voice "ja-JP-NanamiNeural"}`. 42 distinct option maps
 * appear across the three exports; `{}` is the commonest at 17,475.
 */
export interface ComponentCacheKey {
  readonly text: string;
  readonly options: Readonly<Record<string, string>>;
}

const EDN_ENTRY = /:([A-Za-z0-9_?*!+-]+)\s+(?:"((?:[^"\\]|\\.)*)"|([^\s,}]+))/g;

/** Parse `{:lang "ja-JP", :voice "…"}`. Unquoted values are tolerated. */
export function parseEdnOptions(edn: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of edn.matchAll(EDN_ENTRY)) {
    const key = match[1];
    if (key === undefined) continue;
    const quoted = match[2];
    out[key] = quoted === undefined ? (match[3] ?? "") : quoted.replace(/\\(.)/g, "$1");
  }
  return out;
}

/**
 * Split the key on its trailing balanced `{…}`. A backward brace scan rather
 * than a regex, because the source text itself contains braces — `{{…}}` cloze
 * appears 1,087 times in the corpus — and a greedy match would eat it.
 */
export function splitComponentCacheKey(key: string): ComponentCacheKey {
  if (!key.endsWith("}")) return { text: key, options: {} };
  let depth = 0;
  let quoted = false;
  for (let i = key.length - 1; i >= 0; i -= 1) {
    const ch = key[i];
    if (ch === '"' && key[i - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (ch === "}") {
      depth += 1;
    } else if (ch === "{") {
      depth -= 1;
      if (depth === 0) {
        if (i === 0 || key[i - 1] !== " ") return { text: key, options: {} };
        return { text: key.slice(0, i - 1), options: parseEdnOptions(key.slice(i)) };
      }
    }
  }
  return { text: key, options: {} };
}

// ─── mime sniffing ───────────────────────────────────────────────────────────

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

const MAGIC: readonly { readonly mime: string; readonly match: (b: Uint8Array) => boolean }[] = [
  { mime: "image/jpeg", match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/png",
    match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { mime: "image/gif", match: (b) => ascii(b, 0, 4) === "GIF8" },
  { mime: "image/webp", match: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  { mime: "audio/wav", match: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE" },
  { mime: "audio/ogg", match: (b) => ascii(b, 0, 4) === "OggS" },
  { mime: "audio/flac", match: (b) => ascii(b, 0, 4) === "fLaC" },
  { mime: "audio/mp4", match: (b) => ascii(b, 4, 8) === "ftyp" },
  // ID3v2 container, or a bare MPEG audio frame: 11 sync bits set, and neither
  // the version nor the layer field on its reserved value. Every mp3 in the
  // corpus is the bare form — fff3e4c4 (8,398), fff3c8c4 (2,085), fff344c4
  // (383), fff384c4 (1) — which is why the JPEG test comes first: ffd8ff also
  // starts 0xff.
  {
    mime: "audio/mpeg",
    match: (b) =>
      ascii(b, 0, 3) === "ID3" ||
      (b.length > 1 &&
        b[0] === 0xff &&
        ((b[1] ?? 0) & 0xe0) === 0xe0 &&
        ((b[1] ?? 0) & 0x18) !== 0x08 &&
        ((b[1] ?? 0) & 0x06) !== 0x00),
  },
  { mime: "image/svg+xml", match: (b) => /^\s*<svg[\s>]/i.test(ascii(b, 0, 64)) },
  { mime: "text/xml", match: (b) => /^\s*<\?xml[\s?]/i.test(ascii(b, 0, 64)) },
];

/**
 * The real type, from the bytes. `blobs.mime` is never the record's `type`: only
 * 41 of 10,887 declared types in the corpus are right.
 */
export function sniffMime(bytes: Uint8Array): string {
  for (const candidate of MAGIC) {
    if (candidate.match(bytes)) return candidate.mime;
  }
  return "application/octet-stream";
}

// ─── prepared statements ─────────────────────────────────────────────────────

/**
 * One compile per database. `putBlob` and `addBlobRef` are called ~43,000 times
 * by a full import, and `db.prepare` compiles on every call.
 */
interface Statements {
  readonly insertBlob: Statement;
  readonly insertRef: Statement;
  readonly lookup: Statement;
}

const STATEMENTS = new WeakMap<Db, Statements>();

function statements(db: Db): Statements {
  let cached = STATEMENTS.get(db);
  if (cached === undefined) {
    cached = {
      insertBlob: db.prepare(
        `INSERT OR IGNORE INTO blobs
           (hash, kind, mime, byte_size, source_text, voice, lang, options, bytes, path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertRef: db.prepare(
        `INSERT OR IGNORE INTO blob_refs (blob_hash, card_id, field_id, ref_key)
         VALUES (?, ?, ?, ?)`,
      ),
      lookup: db.prepare(
        `SELECT hash FROM blobs
          WHERE kind = ? AND source_text = ? AND voice IS ? AND lang IS ? AND options = ?
            AND byte_size > 0
          ORDER BY hash LIMIT 1`,
      ),
    };
    STATEMENTS.set(db, cached);
  }
  return cached;
}

// ─── writing blobs ───────────────────────────────────────────────────────────

const TEXT_MIME = "text/plain; charset=utf-8";
const JSON_MIME = "application/json";

export interface PutBlobArgs {
  readonly bytes: Uint8Array;
  readonly kind: BlobKind;
  /** Sniffed when omitted. Pass it only for payloads this module created. */
  readonly mime?: string;
  readonly identity?: Omit<GenerationIdentity, "kind">;
}

/**
 * A blob whose payload lives outside the database. `hash` and `byteSize` MUST be
 * the real payload's — `contentAddress(bytes)` and `bytes.length` — because
 * nothing downstream can recompute them from a row that holds no bytes. This
 * exists so a 657 MB import does not have to keep every file in memory, or read
 * all of it twice, to write a correct address.
 */
export interface PutBlobRecordArgs {
  readonly hash: string;
  readonly kind: BlobKind;
  readonly mime: string;
  readonly byteSize: number;
  /** Where the bytes are. */
  readonly path: string;
  readonly identity?: Omit<GenerationIdentity, "kind">;
}

export interface PutBlobResult {
  readonly hash: string;
  /** False when this address was already present — i.e. a deduplication. */
  readonly inserted: boolean;
}

function insertBlob(
  db: Db,
  hash: string,
  kind: BlobKind,
  mime: string,
  byteSize: number,
  identity: Omit<GenerationIdentity, "kind"> | undefined,
  bytes: Buffer | null,
  path: string | null,
): PutBlobResult {
  const info = statements(db).insertBlob.run(
    hash,
    kind,
    mime,
    byteSize,
    identity?.sourceText ?? null,
    identity?.voice ?? null,
    identity?.lang ?? null,
    identity?.options ?? "{}",
    bytes,
    path,
  );
  return { hash, inserted: info.changes === 1 };
}

/**
 * Insert a blob at its content address, payload inline, or recognise that it is
 * already there. Never updates: `blobs_immutable` would abort, correctly.
 */
export function putBlob(db: Db, args: PutBlobArgs): PutBlobResult {
  return insertBlob(
    db,
    contentAddress(args.bytes),
    args.kind,
    args.mime ?? sniffMime(args.bytes),
    args.bytes.length,
    args.identity,
    Buffer.from(args.bytes),
    null,
  );
}

/** As `putBlob`, but the payload stays on disk / in OPFS and only its address,
 *  size and location are recorded. */
export function putBlobRecord(db: Db, args: PutBlobRecordArgs): PutBlobResult {
  return insertBlob(
    db,
    args.hash,
    args.kind,
    args.mime,
    args.byteSize,
    args.identity,
    null,
    args.path,
  );
}

export interface BlobRef {
  readonly blobHash: string;
  readonly cardId: string;
  /** NULL = card content rather than a named field. */
  readonly fieldId?: string | null;
  /** Attachment filename for imported media; the generation key for cached text. */
  readonly refKey: string;
}

/**
 * Add a reference; refcount is maintained by trigger. Idempotent: re-importing
 * the same export does not inflate refcounts, because the unique index on
 * (card_id, field_id, ref_key) absorbs the repeat.
 */
export function addBlobRef(db: Db, ref: BlobRef): boolean {
  const info = statements(db).insertRef.run(
    ref.blobHash,
    ref.cardId,
    ref.fieldId ?? null,
    ref.refKey,
  );
  return info.changes === 1;
}

// ─── the cache-hit path ──────────────────────────────────────────────────────

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
export function lookupGeneration(db: Db, identity: GenerationIdentity): string | null {
  const row = statements(db).lookup.get(
      identity.kind,
      identity.sourceText,
      identity.voice,
      identity.lang,
      identity.options,
    ) as { hash: string } | undefined;
  return row?.hash ?? null;
}

export interface ResolvedGeneration {
  readonly hash: string;
  /** True when nothing was generated: the point of the whole exercise. */
  readonly hit: boolean;
  /** SPEC's sha256(normalised text, voice, lang) for this input. */
  readonly key: string;
}

/**
 * Resolve a generation request against the store, calling `generate` only on a
 * miss. Two identical requests therefore yield one blob, one address and one
 * billed call — including when they spell the language differently.
 */
export function resolveGeneration(
  db: Db,
  request: GenerationRequest,
  generate: (identity: GenerationIdentity) => {
    readonly bytes: Uint8Array;
    readonly mime?: string;
  },
): ResolvedGeneration {
  const identity = generationIdentity(request);
  const key = generationKey(identity);
  const existing = lookupGeneration(db, identity);
  if (existing !== null) return { hash: existing, hit: true, key };

  const produced = generate(identity);
  const { hash } = putBlob(db, {
    bytes: produced.bytes,
    kind: identity.kind,
    ...(produced.mime === undefined ? {} : { mime: produced.mime }),
    identity: {
      sourceText: identity.sourceText,
      voice: identity.voice,
      lang: identity.lang,
      options: identity.options,
    },
  });
  return { hash, hit: false, key };
}

// ─── importing an export's media ─────────────────────────────────────────────

/** One card, as `walk_cards` in tools/mochi.py yields it. */
export interface MochiMediaCard {
  readonly id?: unknown;
  readonly attachments?: unknown;
  readonly "component-cache"?: unknown;
}

export interface MochiMediaSource {
  /** The extracted .mochi root: data.json plus flat media files. */
  readonly mediaDir: string;
  /** Cards from a DEDUPED walk. A naive recursive walk doubles every count. */
  readonly cards: readonly MochiMediaCard[];
}

export interface ImportBlobsOptions {
  /**
   * Media payloads: `path` records where the bytes are, `inline` copies them
   * into the row. Default `path` — the corpus is 657 MB of mp3.
   */
  readonly store?: "inline" | "path";
  /** Where `store: "path"` says the bytes live. Default: the source file. */
  readonly pathFor?: (hash: string, sourcePath: string) => string;
  /** Injected so the OPFS build can supply bytes without a filesystem. */
  readonly readMedia?: (mediaDir: string, fileName: string) => Uint8Array | null;
  /**
   * Also import the cached text generations (ai / translate / furigana) and
   * dictionary results, so those do not re-bill either. Default true.
   */
  readonly includeTextGenerations?: boolean;
}

/** Every claim this importer makes about what it did. */
export interface BlobImportReport {
  readonly liveAttachments: number;
  readonly tombstonesSkipped: number;
  readonly filesMissing: number;
  /** Live attachment records that resolved to a distinct file. */
  readonly distinctFiles: number;
  readonly emptyFiles: number;
  readonly mediaBlobs: number;
  readonly mediaRefs: number;
  readonly dedupedFiles: number;
  readonly bytesHashed: number;
  readonly declaredTypes: Readonly<Record<string, number>>;
  readonly sniffedMimes: Readonly<Record<string, number>>;
  readonly mimeCorrected: number;
  readonly cachePointers: number;
  readonly cachePointersLive: number;
  readonly cachePointersTombstoned: number;
  readonly cachePointersDangling: number;
  readonly cacheTextOnly: number;
  readonly cacheFailures: number;
  /**
   * A SUBSET of cacheTextOnly: 78 cached generations whose output is the empty
   * string. Not imported — an empty result is a failed generation, and because
   * the address is the bytes it would otherwise share sha256("") with the 10
   * zero-byte mp3s and file text under kind 'speech'.
   */
  readonly textPayloadsEmpty: number;
  /**
   * Cache leaves this importer cannot use: an unknown generator bucket, or a
   * value that is not a map. All 133 in the corpus are the literal string
   * "loading" -- an in-flight generation frozen into the export.
   */
  readonly cacheUnusable: number;
  readonly generationKeys: number;
  readonly generationEdges: number;
  readonly generationEdgesDropped: number;
  readonly blobsWithoutProvenance: number;
  readonly textBlobs: number;
  readonly textRefs: number;
  readonly refsSkippedUnknownCard: number;
}

interface LiveAttachment {
  readonly cardId: string;
  readonly mediaDir: string;
  readonly fileName: string;
  readonly declaredType: string;
}

interface CachePointer {
  readonly cardId: string;
  readonly mediaDir: string;
  readonly fileName: string;
  readonly identity: GenerationIdentity;
  readonly key: string;
}

interface TextGeneration {
  readonly cardId: string;
  readonly identity: GenerationIdentity;
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
}

interface HashedFile {
  readonly hash: string;
  readonly mime: string;
  readonly size: number;
  readonly mediaDir: string;
  readonly fileName: string;
  readonly sourcePath: string;
}

/** Mochi's generator buckets inside component-cache, mapped onto BLOB_KINDS. */
const CACHE_KIND_TO_BLOB_KIND: Readonly<Record<string, BlobKind>> = {
  speech: "speech",
  ai: "ai",
  translate: "translate",
  furigana: "furigana",
  dictionary: "dictionary",
  "image-search": "image",
};

const SLOT = "\u0000";

function slotOf(mediaDir: string, fileName: string): string {
  return `${mediaDir}${SLOT}${fileName}`;
}

function defaultReadMedia(mediaDir: string, fileName: string): Uint8Array | null {
  try {
    return readFileSync(join(mediaDir, fileName));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function identityFor(
  cacheKind: string,
  rawKey: string,
): { readonly identity: GenerationIdentity; readonly key: string } | null {
  const kind = CACHE_KIND_TO_BLOB_KIND[cacheKind];
  if (kind === undefined) return null;
  const { text, options } = splitComponentCacheKey(rawKey);
  const identity = generationIdentity({
    kind,
    text,
    voice: options["voice"] ?? null,
    lang: options["lang"] ?? null,
    options,
  });
  return { identity, key: generationKey(identity) };
}

/**
 * Read every live attachment and cache entry across `sources` into the blob
 * store, skipping tombstones.
 *
 * Cards must already exist: `blob_refs.card_id` is a foreign key, and a
 * reference to a card that was never imported is exactly the dangling state this
 * store exists to make impossible. Such refs are counted, not forced.
 */
export function importBlobs(
  db: Db,
  sources: readonly MochiMediaSource[],
  options: ImportBlobsOptions = {},
): BlobImportReport {
  const store = options.store ?? "path";
  const readMedia = options.readMedia ?? defaultReadMedia;
  const pathFor = options.pathFor ?? ((_hash, sourcePath) => sourcePath);
  const includeText = options.includeTextGenerations !== false;

  // ── phase 1: scan the records. No I/O, no writes.
  const live: LiveAttachment[] = [];
  const liveSlots = new Set<string>();
  const tombstoneSlots = new Set<string>();
  const pointers: CachePointer[] = [];
  const texts: TextGeneration[] = [];
  const declaredTypes = new Map<string, number>();
  let tombstonesSkipped = 0;
  let cachePointers = 0;
  let cacheTextOnly = 0;
  let cacheFailures = 0;
  let textPayloadsEmpty = 0;
  let cacheUnusable = 0;

  for (const source of sources) {
    for (const card of source.cards) {
      const cardId = typeof card.id === "string" ? card.id : null;
      if (cardId === null) continue;

      const attachments = card.attachments;
      if (isRecord(attachments)) {
        for (const [fileName, record] of Object.entries(attachments)) {
          if (!isRecord(record)) continue;
          // THE SKIP THAT MATTERS: 8,958 tombstones are Mochi's regeneration
          // debris, not content. Importing them would import the bug.
          if (record["deleted?"] === true) {
            tombstonesSkipped += 1;
            tombstoneSlots.add(slotOf(source.mediaDir, fileName));
            continue;
          }
          const declaredType = typeof record["type"] === "string" ? record["type"] : "";
          bump(declaredTypes, declaredType);
          live.push({ cardId, mediaDir: source.mediaDir, fileName, declaredType });
          liveSlots.add(slotOf(source.mediaDir, fileName));
        }
      }

      const cache = card["component-cache"];
      if (!isRecord(cache)) continue;
      for (const [cacheKind, entries] of Object.entries(cache)) {
        if (!isRecord(entries)) continue;
        for (const [rawKey, value] of Object.entries(entries)) {
          // 133 leaves in the corpus are the bare string "loading" -- Mochi's
          // in-flight placeholder, frozen into the export. Caching one would
          // permanently serve the word "loading" in place of the generation.
          if (!isRecord(value)) {
            cacheUnusable += 1;
            continue;
          }
          const resolved = identityFor(cacheKind, rawKey);
          if (resolved === null) {
            cacheUnusable += 1;
            continue;
          }

          const attachment = value["attachment"];
          if (typeof attachment === "string" && attachment !== "") {
            cachePointers += 1;
            pointers.push({
              cardId,
              mediaDir: source.mediaDir,
              fileName: attachment,
              identity: resolved.identity,
              key: resolved.key,
            });
            continue;
          }
          // `attachment: null` on 20,813 entries. A trap: those are TEXT
          // generations, not broken media pointers.
          if (value["error"] !== undefined || value["status"] !== undefined) {
            cacheFailures += 1; // never cache a failure
            continue;
          }
          const text = value["text"];
          const results = value["results"];
          let payload: { readonly bytes: Uint8Array; readonly mime: string } | null = null;
          if (typeof text === "string") {
            cacheTextOnly += 1;
            payload = { bytes: Buffer.from(text, "utf8"), mime: TEXT_MIME };
          } else if (Array.isArray(results)) {
            cacheTextOnly += 1;
            payload = {
              bytes: Buffer.from(JSON.stringify({ term: value["term"], results }), "utf8"),
              mime: JSON_MIME,
            };
          } else {
            cacheUnusable += 1;
            continue;
          }
          if (payload.bytes.length === 0) {
            textPayloadsEmpty += 1;
            continue;
          }
          if (includeText) {
            texts.push({
              cardId,
              identity: resolved.identity,
              key: resolved.key,
              bytes: payload.bytes,
              mime: payload.mime,
            });
          }
        }
      }
    }
  }

  // ── phase 2: hash the bytes, once per live file. Outside any transaction:
  // 657 MB of reads should not hold a write lock.
  const hashed = new Map<string, HashedFile>();
  const sniffedMimes = new Map<string, number>();
  let filesMissing = 0;
  let bytesHashed = 0;
  let emptyFiles = 0;
  let mimeCorrected = 0;

  for (const attachment of live) {
    const slot = slotOf(attachment.mediaDir, attachment.fileName);
    let entry = hashed.get(slot);
    if (entry === undefined) {
      const bytes = readMedia(attachment.mediaDir, attachment.fileName);
      if (bytes === null) {
        filesMissing += 1;
        continue;
      }
      bytesHashed += bytes.length;
      if (bytes.length === 0) emptyFiles += 1;
      entry = {
        hash: contentAddress(bytes),
        mime: sniffMime(bytes),
        size: bytes.length,
        mediaDir: attachment.mediaDir,
        fileName: attachment.fileName,
        sourcePath: join(attachment.mediaDir, attachment.fileName),
      };
      hashed.set(slot, entry);
    }
    bump(sniffedMimes, entry.mime);
    if (entry.mime !== attachment.declaredType) mimeCorrected += 1;
  }

  // ── phase 3: decide one identity per blob. The key -> blob relation is
  // many-to-many and a blob row holds one tuple, so keep the lexicographically
  // smallest key per blob and count what that costs.
  const provenance = new Map<string, CachePointer>();
  const keys = new Set<string>();
  const edges = new Set<string>();
  const byHash = new Map<string, HashedFile>();
  let cachePointersLive = 0;
  let cachePointersTombstoned = 0;
  let cachePointersDangling = 0;

  for (const entry of hashed.values()) {
    if (!byHash.has(entry.hash)) byHash.set(entry.hash, entry);
  }

  for (const pointer of pointers) {
    const slot = slotOf(pointer.mediaDir, pointer.fileName);
    if (!liveSlots.has(slot)) {
      if (tombstoneSlots.has(slot)) cachePointersTombstoned += 1;
      else cachePointersDangling += 1;
      continue;
    }
    cachePointersLive += 1;
    const entry = hashed.get(slot);
    if (entry === undefined) continue;
    keys.add(pointer.key);
    edges.add(`${pointer.key}${SLOT}${entry.hash}`);
    const held = provenance.get(entry.hash);
    if (held === undefined || pointer.key < held.key) provenance.set(entry.hash, pointer);
  }

  // ── phase 4: write. One transaction.
  const cardExists = db.prepare("SELECT 1 FROM cards WHERE id = ?").pluck();
  const known = new Map<string, boolean>();
  const hasCard = (cardId: string): boolean => {
    let seen = known.get(cardId);
    if (seen === undefined) {
      seen = cardExists.get(cardId) === 1;
      known.set(cardId, seen);
    }
    return seen;
  };

  let mediaBlobs = 0;
  let mediaRefs = 0;
  let textBlobs = 0;
  let textRefs = 0;
  let refsSkippedUnknownCard = 0;

  db.transaction(() => {
    for (const [hash, entry] of byHash) {
      const pointer = provenance.get(hash);
      const kind: BlobKind =
        pointer?.identity.kind ?? (entry.mime.startsWith("image/") ? "image" : "file");
      const identity =
        pointer === undefined
          ? undefined
          : {
              sourceText: pointer.identity.sourceText,
              voice: pointer.identity.voice,
              lang: pointer.identity.lang,
              options: pointer.identity.options,
            };
      let result: PutBlobResult;
      if (store === "inline") {
        const bytes = readMedia(entry.mediaDir, entry.fileName);
        if (bytes === null) continue;
        result = putBlob(db, {
          bytes,
          kind,
          mime: entry.mime,
          ...(identity === undefined ? {} : { identity }),
        });
      } else {
        // The address was computed from the real bytes in phase 2 and the bytes
        // were then released; re-reading 657 MB to recompute it would be waste.
        result = putBlobRecord(db, {
          hash,
          kind,
          mime: entry.mime,
          byteSize: entry.size,
          path: pathFor(hash, entry.sourcePath),
          ...(identity === undefined ? {} : { identity }),
        });
      }
      if (result.inserted) mediaBlobs += 1;
    }

    for (const attachment of live) {
      const entry = hashed.get(slotOf(attachment.mediaDir, attachment.fileName));
      if (entry === undefined) continue;
      if (!hasCard(attachment.cardId)) {
        refsSkippedUnknownCard += 1;
        continue;
      }
      if (
        addBlobRef(db, {
          blobHash: entry.hash,
          cardId: attachment.cardId,
          refKey: attachment.fileName,
        })
      ) {
        mediaRefs += 1;
      }
    }

    for (const text of texts) {
      const result = putBlob(db, {
        bytes: text.bytes,
        kind: text.identity.kind,
        mime: text.mime,
        identity: {
          sourceText: text.identity.sourceText,
          voice: text.identity.voice,
          lang: text.identity.lang,
          options: text.identity.options,
        },
      });
      if (result.inserted) textBlobs += 1;
      if (!hasCard(text.cardId)) {
        refsSkippedUnknownCard += 1;
        continue;
      }
      if (addBlobRef(db, { blobHash: result.hash, cardId: text.cardId, refKey: text.key })) {
        textRefs += 1;
      }
    }
  })();

  return {
    liveAttachments: live.length,
    tombstonesSkipped,
    filesMissing,
    emptyFiles,
    mediaBlobs,
    mediaRefs,
    distinctFiles: hashed.size,
    dedupedFiles: hashed.size - byHash.size,
    bytesHashed,
    declaredTypes: Object.fromEntries(declaredTypes),
    sniffedMimes: Object.fromEntries(sniffedMimes),
    mimeCorrected,
    cachePointers,
    cachePointersLive,
    cachePointersTombstoned,
    cachePointersDangling,
    cacheTextOnly,
    cacheFailures,
    textPayloadsEmpty,
    cacheUnusable,
    generationKeys: keys.size,
    generationEdges: edges.size,
    generationEdgesDropped: edges.size - provenance.size,
    blobsWithoutProvenance: byHash.size - provenance.size,
    textBlobs,
    textRefs,
    refsSkippedUnknownCard,
  };
}
