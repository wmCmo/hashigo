import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Statement } from "better-sqlite3";

import {
  defaultStoreDatabase,
  openBlobStore,
  openBlobStoreDatabase,
  type BlobStore,
} from "../blobs/index.js";
import type { Db } from "../db/index.js";
import type { BlobKind } from "../schema/index.js";

import {
  generationIdentity,
  generationKey,
  lookupGeneration,
  type GenerationIdentity,
  type GenerationRequest,
} from "../blobs/generation.js";

export {
  GENERATION_KEY_SCHEME,
  LANGUAGE_ALIASES,
  LOCALE_ALIASES,
  canonicaliseOptions,
  generationIdentity,
  generationKey,
  lookupGeneration,
  normaliseLanguageTag,
  normaliseSourceText,
  type GenerationIdentity,
  type GenerationRequest,
} from "../blobs/generation.js";

export function contentAddress(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ComponentCacheKey {
  readonly text: string;
  readonly options: Readonly<Record<string, string>>;
}

const EDN_ENTRY = /:([A-Za-z0-9_?*!+-]+)\s+(?:"((?:[^"\\]|\\.)*)"|([^\s,}]+))/g;

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

export function sniffMime(bytes: Uint8Array): string {
  for (const candidate of MAGIC) {
    if (candidate.match(bytes)) return candidate.mime;
  }
  return "application/octet-stream";
}

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
           (hash, kind, mime, byte_size, source_text, voice, lang, options, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

const TEXT_MIME = "text/plain; charset=utf-8";
const JSON_MIME = "application/json";

export interface PutBlobArgs {
  readonly bytes: Uint8Array;
  readonly kind: BlobKind;
  readonly mime?: string;
  readonly identity?: Omit<GenerationIdentity, "kind">;
}

export interface PutBlobRecordArgs {
  readonly hash: string;
  readonly kind: BlobKind;
  readonly mime: string;
  readonly byteSize: number;
  readonly identity?: Omit<GenerationIdentity, "kind">;
}

export interface PutBlobResult {
  readonly hash: string;
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
  );
  return { hash, inserted: info.changes === 1 };
}

export function putBlob(db: Db, args: PutBlobArgs): PutBlobResult {
  return insertBlob(
    db,
    contentAddress(args.bytes),
    args.kind,
    args.mime ?? sniffMime(args.bytes),
    args.bytes.length,
    args.identity,
    Buffer.from(args.bytes),
  );
}

export function putBlobRecord(db: Db, args: PutBlobRecordArgs): PutBlobResult {
  return insertBlob(db, args.hash, args.kind, args.mime, args.byteSize, args.identity, null);
}

export interface BlobRef {
  readonly blobHash: string;
  readonly cardId: string;
  readonly fieldId?: string | null;
  readonly refKey: string;
}

export function addBlobRef(db: Db, ref: BlobRef): boolean {
  const info = statements(db).insertRef.run(
    ref.blobHash,
    ref.cardId,
    ref.fieldId ?? null,
    ref.refKey,
  );
  return info.changes === 1;
}

export function retargetBlobRef(
  db: Db,
  ref: Omit<BlobRef, "blobHash">,
  toBlobHash: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE blob_refs SET blob_hash = ?
        WHERE card_id = ? AND COALESCE(field_id, '') = COALESCE(?, '') AND ref_key = ?`,
    )
    .run(toBlobHash, ref.cardId, ref.fieldId ?? null, ref.refKey);
  return info.changes === 1;
}

export function removeBlobRef(db: Db, ref: Omit<BlobRef, "blobHash">): boolean {
  const info = db
    .prepare(
      `DELETE FROM blob_refs
        WHERE card_id = ? AND COALESCE(field_id, '') = COALESCE(?, '') AND ref_key = ?`,
    )
    .run(ref.cardId, ref.fieldId ?? null, ref.refKey);
  return info.changes === 1;
}

export function blobRefsForCard(db: Db, cardId: string): readonly BlobRef[] {
  return (
    db
      .prepare(
        `SELECT blob_hash, card_id, field_id, ref_key FROM blob_refs
          WHERE card_id = ? ORDER BY id`,
      )
      .all(cardId) as {
      blob_hash: string;
      card_id: string;
      field_id: string | null;
      ref_key: string;
    }[]
  ).map((row) => ({
    blobHash: row.blob_hash,
    cardId: row.card_id,
    fieldId: row.field_id,
    refKey: row.ref_key,
  }));
}

export interface ResolvedGeneration {
  readonly hash: string;
  readonly hit: boolean;
  readonly key: string;
}

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

export async function resolveGenerationAsync(
  db: Db,
  request: GenerationRequest,
  generate: (identity: GenerationIdentity) => Promise<{
    readonly bytes: Uint8Array;
    readonly mime?: string;
  }>,
): Promise<ResolvedGeneration> {
  const identity = generationIdentity(request);
  const key = generationKey(identity);
  const existing = lookupGeneration(db, identity);
  if (existing !== null) return { hash: existing, hit: true, key };

  const produced = await generate(identity);
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

export interface MochiMediaCard {
  readonly id?: unknown;
  readonly attachments?: unknown;
  readonly "component-cache"?: unknown;
}

export interface MochiMediaSource {
  readonly mediaDir: string;
  readonly cards: readonly MochiMediaCard[];
}

export type BlobPayloadStore = "content-addressed" | "inline" | "address-only";

export type LegacyPayloadStore = BlobPayloadStore | "path";

export interface ImportBlobsOptions {
  readonly store?: LegacyPayloadStore;
  readonly blobStore?: BlobStore;
  readonly storeDatabase?: string;
  readonly storeRoot?: string;
  readonly readMedia?: (mediaDir: string, fileName: string) => Uint8Array | null;
  readonly includeTextGenerations?: boolean;
  readonly onMediaProgress?: (done: number, total: number, bytes: number) => void;
}

export interface BlobImportReport {
  readonly payloadStore: BlobPayloadStore;
  readonly storeRoot: string | null;
  readonly storeFilesWritten: number;
  readonly storeFilesPresent: number;
  readonly storeBytesWritten: number;
  readonly storeSeconds: number;
  readonly storeMbPerSecond: number;
  readonly storeWarnings: readonly string[];
  readonly liveAttachments: number;
  readonly tombstonesSkipped: number;
  readonly filesMissing: number;
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
  readonly textPayloadsEmpty: number;
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
}

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

interface ResolvedStore {
  readonly store: BlobPayloadStore;
  readonly blobStore: BlobStore | null;
  readonly storeRoot: string | null;
  readonly storeWarnings: readonly string[];
  readonly close: () => void;
}

function resolvePayloadStore(db: Db, options: ImportBlobsOptions): ResolvedStore {
  const warnings: string[] = [];
  let requested: BlobPayloadStore;
  if (options.store === "path") {
    requested = "content-addressed";
    warnings.push(
      'store: "path" is gone -- payloads are content-addressed. No location is ' +
        "written to the database.",
    );
  } else {
    requested = options.store ?? "content-addressed";
  }

  const noop = (): void => {};

  if (requested !== "content-addressed") {
    return {
      store: requested,
      blobStore: null,
      storeRoot: null,
      storeWarnings: warnings,
      close: noop,
    };
  }

  if (options.blobStore !== undefined) {
    return {
      store: requested,
      blobStore: options.blobStore,
      storeRoot: options.blobStore.describe,
      storeWarnings: warnings,
      close: noop,
    };
  }

  if (options.storeRoot !== undefined) {
    const opened = openBlobStore(options.storeRoot);
    warnings.push(
      `storeRoot opens the legacy one-file-per-payload store. The default is a ` +
        `SQLite blob database, which measured tens of times faster to write on ` +
        `OPFS (32x-65x across the runs that measured both); see ` +
        `notes/archive/browser-feasibility.md §4 and spike/blobstore/README.md.`,
    );
    return {
      store: requested,
      blobStore: opened,
      storeRoot: opened.root,
      storeWarnings: warnings,
      close: noop,
    };
  }

  const file = options.storeDatabase ?? derivedStoreDatabase(db);
  if (file === null) {
    warnings.push(
      "no blob store: this database is in memory, so there is nowhere durable to " +
        "put 657 MB of payloads. Addresses, sizes, types and provenance are still " +
        "recorded; pass storeDatabase or blobStore to keep the bytes.",
    );
    return {
      store: "address-only",
      blobStore: null,
      storeRoot: null,
      storeWarnings: warnings,
      close: noop,
    };
  }
  const opened = openBlobStoreDatabase(file);
  return {
    store: requested,
    blobStore: opened.store,
    storeRoot: opened.store.describe,
    storeWarnings: warnings,
    close: opened.close,
  };
}

function derivedStoreDatabase(db: Db): string | null {
  const file = (db as { name?: unknown }).name;
  if (typeof file !== "string" || file === "" || file === ":memory:") return null;
  if (file.startsWith("file::memory:") || (db as { memory?: unknown }).memory === true) return null;
  return defaultStoreDatabase(file);
}

export function importBlobs(
  db: Db,
  sources: readonly MochiMediaSource[],
  options: ImportBlobsOptions = {},
): BlobImportReport {
  const readMedia = options.readMedia ?? defaultReadMedia;
  const includeText = options.includeTextGenerations !== false;
  const {
    store,
    blobStore,
    storeRoot,
    storeWarnings,
    close: closeStore,
  } = resolvePayloadStore(db, options);

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
          if (value["error"] !== undefined || value["status"] !== undefined) {
            cacheFailures += 1;
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

  const hashed = new Map<string, HashedFile>();
  const sniffedMimes = new Map<string, number>();
  let filesMissing = 0;
  let bytesHashed = 0;
  let emptyFiles = 0;
  let mimeCorrected = 0;
  let storeFilesWritten = 0;
  let storeFilesPresent = 0;
  let storeBytesWritten = 0;
  const storeStarted = Date.now();

  const hashAndCopy = (): void => {
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
        };
        hashed.set(slot, entry);
        if (blobStore !== null && store === "content-addressed") {
          const written = blobStore.write(entry.hash, bytes);
          if (written.written) {
            storeFilesWritten += 1;
            storeBytesWritten += written.bytes;
          } else {
            storeFilesPresent += 1;
          }
          options.onMediaProgress?.(
            storeFilesWritten + storeFilesPresent,
            live.length,
            storeBytesWritten,
          );
        }
      }
      bump(sniffedMimes, entry.mime);
      if (entry.mime !== attachment.declaredType) mimeCorrected += 1;
    }
  };

  let storeSeconds = 0;
  try {
    if (blobStore !== null && blobStore.batch !== undefined) blobStore.batch(hashAndCopy);
    else hashAndCopy();
    storeSeconds = (Date.now() - storeStarted) / 1000;
  } finally {
    closeStore();
  }

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
        result = putBlobRecord(db, {
          hash,
          kind,
          mime: entry.mime,
          byteSize: entry.size,
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
    payloadStore: store,
    storeRoot,
    storeFilesWritten,
    storeFilesPresent,
    storeBytesWritten,
    storeSeconds: Number(storeSeconds.toFixed(3)),
    storeMbPerSecond:
      storeSeconds > 0 ? Number((storeBytesWritten / 1024 / 1024 / storeSeconds).toFixed(1)) : 0,
    storeWarnings,
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
