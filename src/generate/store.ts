/**
 * Resolving a field's generation against the store — ON DEMAND.
 *
 * Zach's decision, 2026-08-20: resolve on demand rather than materialising the
 * result into `card_field_values`. Audio changes when the provider changes, and
 * a typo fix must not need a migration. The cost is one `sha256` of a short
 * string plus one indexed lookup, measured at 0.20-1.06 ms in a real browser.
 *
 * MISS-AS-SILENCE IS THE BUG THIS FIXES, so a miss is never allowed to be
 * quiet. Every resolution lands in one of four buckets and the counts are part
 * of the return value, the same way the renderer reports its 10,316 resolver
 * warnings rather than rendering oddly and saying nothing:
 *
 *   exact       the identity Mochi filed. 17,502 of 18,356 slots (95.35%).
 *   other-voice same kind, same text, DIFFERENT voice or options. 507 slots.
 *               Playable today; this is also exactly the regenerate-with-
 *               Neural2-C set, because it exists only where the template voice
 *               changed under clips that were already generated.
 *   missing     the text has no blob under any voice, and the card has no clip
 *               of that kind either. 35 slots — genuinely never generated.
 *   mismatch    the card HAS a clip of that kind but nothing matches the text.
 *               312 slots, and the honest label for "this needs looking at".
 *
 * All four figures are over the 7,346 templated cards of the reference export,
 * from `build/step1/probe.ts`. The basis is FIELD SLOTS — one per generator
 * field per card — not cards and not blobs; three different numbers.
 */

import type { SqliteHandle } from "../db/browser.js";
// `src/blobs/generation.ts`, NOT `src/import/blobs.ts`. That one import is what
// made this whole module unloadable in a browser, and the review screen runs in
// one — see the header of the module it now points at.
import {
  generationIdentity,
  generationKey,
  lookupGeneration,
} from "../blobs/generation.js";
import type { BlobKind } from "../schema/index.js";
import type { FieldGenerationRequest } from "./fields.js";

export type GenerationMatch = "exact" | "other-voice" | "missing" | "mismatch";

export interface ResolvedFieldGeneration {
  readonly request: FieldGenerationRequest;
  readonly match: GenerationMatch;
  /** The blob address, or null for `missing` / `mismatch`. */
  readonly hash: string | null;
  /** `generationKey(identity)` — SPEC's cache key, for logs and for tests. */
  readonly key: string;
}

export interface GenerationDiagnostics {
  readonly exact: number;
  readonly otherVoice: number;
  readonly missing: number;
  readonly mismatch: number;
}

/**
 * The voice-agnostic fallback.
 *
 * `byte_size > 0` for the same reason `lookupGeneration` has it: Mochi left 10
 * failed generations behind as live zero-byte attachments, and a broken file
 * must not become a permanent hit. `ORDER BY hash` because 12 keys in the corpus
 * have two blobs under them, from Azure's non-determinism — an arbitrary answer
 * is fine, a NON-DETERMINISTIC one is not.
 */
const ANY_VOICE_SQL = `
  SELECT hash FROM blobs
   WHERE kind = ? AND source_text = ? AND byte_size > 0
   ORDER BY hash LIMIT 1`;

/** Does this card reference any blob of this kind at all? */
const ON_CARD_SQL = `
  SELECT 1 FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
   WHERE r.card_id = ? AND b.kind = ? AND b.byte_size > 0 LIMIT 1`;

export interface ResolveOptions {
  /**
   * Accept a blob of the same text under a different voice. Default true: the
   * clip is playable and dropping it would reintroduce the silence. Pass false
   * to measure how much of the corpus is on the CURRENT template voice.
   */
  readonly acceptOtherVoice?: boolean;
  /**
   * The card, so a miss can be classified. Without it every miss reports
   * `missing`, which understates `mismatch` — the bucket that means "look at
   * this". Optional rather than required because a card id is not needed to
   * play audio, only to explain its absence.
   */
  readonly cardId?: string;
}

/**
 * Resolve one field generation. Never generates, never fetches, never plays.
 *
 * Returning a hash rather than bytes is deliberate: the caller decides whether
 * to read the payload, and the review UI must be able to decide NOT to — see
 * `src/render/reveal.ts` for why nothing here may reach an `<audio>` element.
 */
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

/** Resolve several, and tally them. The tally is the diagnostic. */
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

/**
 * A `resolveGenerated` implementation for `FieldContext`: the TEXT an upstream
 * generator produced, read back out of the store.
 *
 * Only the text kinds have a payload worth reading — a speech blob's bytes are
 * an mp3 and nothing downstream can use them as input. Returning null for those
 * is correct rather than defensive.
 */
const TEXT_KINDS: ReadonlySet<BlobKind> = new Set(["ai", "translate", "furigana", "dictionary"]);

export function storeTextResolver(
  db: SqliteHandle,
  options: ResolveOptions = {},
): (request: FieldGenerationRequest) => string | null {
  const read = db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
  return (request) => {
    if (!TEXT_KINDS.has(request.kind)) return null;
    const found = resolveFieldGeneration(db, request, options);
    if (found.hash === null) return null;
    const row = read.get(found.hash) as { bytes: Uint8Array | null } | undefined;
    if (row?.bytes == null) return null;
    return new TextDecoder().decode(row.bytes);
  };
}
