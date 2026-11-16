import type { SqliteHandle } from "../db/browser.js";
import {
  generationIdentity,
  generationKey,
  lookupGeneration,
  lookupGenerations,
} from "../blobs/generation.js";
import { sha256Hex } from "../blobs/sha256.js";
import type { BlobKind } from "../schema/index.js";
import type { FieldGenerationRequest } from "./fields.js";
import { cleanGenerated } from "./llm.js";

export type GenerationMatch = "exact" | "other-voice" | "missing" | "mismatch";

export interface ResolvedFieldGeneration {
  readonly request: FieldGenerationRequest;
  readonly match: GenerationMatch;
  readonly hash: string | null;
  readonly key: string;
}

export interface GenerationDiagnostics {
  readonly exact: number;
  readonly otherVoice: number;
  readonly missing: number;
  readonly mismatch: number;
}

const ANY_VOICE_SQL = `
  SELECT hash FROM blobs
   WHERE kind = ? AND source_text = ? AND byte_size > 0
   ORDER BY hash LIMIT 1`;

const ON_CARD_SQL = `
  SELECT 1 FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
   WHERE r.card_id = ? AND b.kind = ? AND b.byte_size > 0 LIMIT 1`;

export interface ResolveOptions {
  readonly acceptOtherVoice?: boolean;
  readonly cardId?: string;
}

export function resolveFieldGeneration(
  db: SqliteHandle,
  request: FieldGenerationRequest,
  options: ResolveOptions = {},
): ResolvedFieldGeneration {
  const identity = generationIdentity({
    kind: request.kind,
    text: request.text,
    voice: request.voice,
    lang: request.lang,
    options: request.options,
  });
  const key = generationKey(identity);

  const exact = lookupGeneration(db, identity);
  if (exact !== null) return { request, match: "exact", hash: exact, key };

  if (options.acceptOtherVoice !== false) {
    const row = db.prepare(ANY_VOICE_SQL).get(request.kind, identity.sourceText) as
      | { hash: string }
      | undefined;
    if (row !== undefined) {
      return { request, match: "other-voice", hash: row.hash, key };
    }
  }

  const hasClip =
    options.cardId === undefined
      ? undefined
      : db.prepare(ON_CARD_SQL).get(options.cardId, request.kind) !== undefined;
  return { request, match: hasClip === true ? "mismatch" : "missing", hash: null, key };
}

export function resolveFieldGenerations(
  db: SqliteHandle,
  requests: readonly FieldGenerationRequest[],
  options: ResolveOptions = {},
): {
  readonly resolved: readonly ResolvedFieldGeneration[];
  readonly diagnostics: GenerationDiagnostics;
} {
  const resolved = requests.map((request) => resolveFieldGeneration(db, request, options));
  let exact = 0;
  let otherVoice = 0;
  let missing = 0;
  let mismatch = 0;
  for (const r of resolved) {
    if (r.match === "exact") exact += 1;
    else if (r.match === "other-voice") otherVoice += 1;
    else if (r.match === "missing") missing += 1;
    else mismatch += 1;
  }
  return { resolved, diagnostics: { exact, otherVoice, missing, mismatch } };
}

const TEXT_KINDS: ReadonlySet<BlobKind> = new Set(["ai", "translate", "furigana", "dictionary"]);

export function storeTextResolver(
  db: SqliteHandle,
  options: ResolveOptions = {},
): (request: FieldGenerationRequest) => string | null {
  const read = db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
  const textOf = (hash: string): string | null => {
    const row = read.get(hash) as { bytes: Uint8Array | null } | undefined;
    return row?.bytes == null ? null : new TextDecoder().decode(row.bytes);
  };
  return (request) => {
    if (!TEXT_KINDS.has(request.kind)) return null;
    const found = resolveFieldGeneration(db, request, options);
    if (found.hash === null) return null;
    const raw = textOf(found.hash);
    if (raw === null) return null;
    const clean = cleanGenerated(request.text, raw);
    if (clean !== "") return clean;
    const identity = generationIdentity({
      kind: request.kind,
      text: request.text,
      voice: request.voice,
      lang: request.lang,
      options: request.options,
    });
    for (const hash of lookupGenerations(db, identity)) {
      const other = textOf(hash);
      const cleaned = other === null ? "" : cleanGenerated(request.text, other);
      if (cleaned !== "") return cleaned;
    }
    return null;
  };
}

export function resolveDescriptorText(
  db: SqliteHandle,
  descriptor: {
    readonly kind: BlobKind;
    readonly text: string;
    readonly lang: string | null;
    readonly voice: string | null;
    readonly options: Readonly<Record<string, string>>;
  },
  options: ResolveOptions = {},
): string | null {
  return storeTextResolver(db, options)({ ...descriptor, fieldId: "", fieldName: "" });
}

export function storeDescriptorText(
  db: SqliteHandle,
  descriptor: {
    readonly kind: BlobKind;
    readonly text: string;
    readonly lang: string | null;
    readonly voice: string | null;
    readonly options: Readonly<Record<string, string>>;
  },
  generated: string,
): string {
  if (!TEXT_KINDS.has(descriptor.kind)) {
    throw new Error(`${descriptor.kind} is not a text generation — nothing here may write audio`);
  }
  const identity = generationIdentity({
    kind: descriptor.kind,
    text: descriptor.text,
    voice: descriptor.voice,
    lang: descriptor.lang,
    options: descriptor.options,
  });
  const bytes = new TextEncoder().encode(generated);
  if (bytes.length === 0) {
    throw new Error("refusing to store an empty generation");
  }
  const hash = sha256Hex(bytes);
  db.prepare(
    `INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang, options,
                        bytes, refcount)
     VALUES (?, ?, 'text/plain; charset=utf-8', ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (hash) DO NOTHING`,
  ).run(
    hash,
    identity.kind,
    bytes.length,
    identity.sourceText,
    identity.voice,
    identity.lang,
    identity.options,
    bytes,
  );
  return hash;
}
