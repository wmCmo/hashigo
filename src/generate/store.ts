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
import { sha256Hex } from "../blobs/sha256.js";
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

/**
 * The text a RENDERED generator element resolves to, or null.
 *
 * `storeTextResolver` above takes a `FieldGenerationRequest` — the shape
 * `expandGeneratorFields` produces when it binds `<< 例文 >>` to a generator.
 * This takes a `GenerationDescriptor`, which is what the RENDERER computes from
 * the element it actually emitted, and that difference is the point:
 *
 *   · a field generator (`<< 例文 >>`) goes through the request shape;
 *   · an INLINE one (`{{<ai>Describe a word << 単語 >> using emojis only</ai>}}`,
 *     575 of them over 400 cards) never becomes a field request at all, so the
 *     request path cannot see it.
 *
 * Both end up as the same identity, so both resolve here. `fieldId`/`fieldName`
 * exist on the request only to name a diagnostic, so they are empty rather than
 * invented.
 */
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

/**
 * THE WRITE SIDE OF `resolveDescriptorText`, and the first one in this module.
 *
 * Zach, 2026-09-14, on a 疑念 card with no emoji line: *"i need way to regenerate
 * on the fly when something is missing, maybe some ui?"*
 *
 * Everything above this point reads. Generation itself has always been a Node
 * script (`scripts/generate-examples.ts`) run over `build/hashigo.db` — which is
 * fine for a batch and useless for the card in front of him. This is the one
 * function both surfaces need: given the descriptor the RENDERER computed and the
 * text an LLM returned, file it where the resolver will find it.
 *
 * ─── THE IDENTITY IS COMPUTED, NEVER PASSED IN ──────────────────────────────
 *
 * `generationIdentity` normalises the source text, drops `lang`/`voice` out of
 * the options bag and canonicalises what is left. Storing anything else files
 * the blob under a key nothing looks up — measured once already, in
 * `scripts/generate-examples.ts`: writing `options: "{}"` instead of the field's
 * own subset put all 67 sentences at `other-voice` rather than `exact`. They
 * rendered, under a near-miss. Passing the identity in as an argument would let
 * a caller make that mistake again; deriving it here makes the round trip
 * `resolve → store → resolve` closed by construction.
 *
 * ─── IDEMPOTENT, AND `refcount` STARTS AT 1 ─────────────────────────────────
 *
 * Decision 4: blobs are content-addressed, so the same text stores at the same
 * hash and a second call is `DO NOTHING`. The refcount is 1 rather than 0
 * because a blob at 0 is what `sweepUnreferenced` collects — and the thing
 * referencing this one is a rendered generator MOUNT, which has no row in
 * `blob_refs` to point at it (that table keys on a field, and 575 of these are
 * inline `<ai>` elements in a template body). A count of 1 with no ref row is
 * the honest encoding of "something holds this and it is not in the schema".
 *
 * Returns the content address it stored under, which is also the hash a caller
 * can hand to `blobs.hash` to confirm the round trip.
 */
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
    // `lookupGeneration` excludes `byte_size > 0` to keep Mochi's 10 zero-byte
    // failures from becoming permanent cache hits. Writing one here would create
    // a row that can never be read and can never be replaced.
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
