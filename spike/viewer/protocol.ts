/**
 * THROWAWAY (spike harness) — messages between the viewer page and its worker.
 *
 * The split is the production one and the reason this harness is worth reading:
 *
 *   * the WORKER owns both SQLite databases, because `opfs-sahpool` refuses to
 *     install outside a dedicated worker (measured, spike/README.md), and it is
 *     the only place a payload is read out of the store;
 *   * the PAGE owns the DOM, the `BlobUrlScope` and therefore every object URL,
 *     because the scope that mints a URL must be the scope that revokes it
 *     (src/blobs/url.ts, rule 1), and the worker cannot know when an `<audio>`
 *     element is finished with a clip.
 *
 * NOTHING here fetches a payload as part of loading a card. `PayloadRequest` is
 * sent by exactly one code path in main.ts — the reveal handler — so the message
 * log itself is evidence for the hard rule: no clip is read out of the store
 * while a side is merely being looked at.
 */

// ─── page -> worker ──────────────────────────────────────────────────────────

export interface OpenRequest {
  readonly kind: "open";
  /** Re-import both databases into OPFS even if they are already there. */
  readonly reimport: boolean;
  readonly id: number;
}

/** The card list for a deck, or for a free-text name match. */
export interface BrowseRequest {
  readonly kind: "browse";
  readonly id: number;
  readonly deckId: string | null;
  readonly limit: number;
}

/** One card and everything needed to resolve, render and explain it. */
export interface CardRequest {
  readonly kind: "card";
  readonly id: number;
  /** A card id, or null with `deckId` set for "any card in this deck". */
  readonly cardId: string | null;
  readonly deckId: string | null;
  /** Prefer a card that has at least one audio attachment. */
  readonly withAudio: boolean;
}

/**
 * Bytes for one blob. THE ONLY MESSAGE THAT MOVES A PAYLOAD, and it is sent from
 * the reveal handler and nowhere else.
 */
export interface PayloadRequest {
  readonly kind: "payload";
  readonly id: number;
  readonly hash: string;
}

export type ViewerRequest = OpenRequest | BrowseRequest | CardRequest | PayloadRequest;

// ─── worker -> page ──────────────────────────────────────────────────────────

export type LogLevel = "info" | "step" | "good" | "bad";

export interface LogMessage {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string;
}

export interface DeckBrief {
  readonly id: string;
  /** `親 / 子` — the resolved path, so the select is readable. */
  readonly path: string;
  readonly cards: number;
  /** Cards in this deck with at least one speech blob referenced. */
  readonly withAudio: number;
}

export interface OpenedMessage {
  readonly kind: "opened";
  readonly id: number;
  readonly facts: readonly (readonly [string, string])[];
  readonly oracle: readonly (readonly [string, string])[];
  readonly decks: readonly DeckBrief[];
}

export interface CardBrief {
  readonly id: string;
  readonly name: string;
  readonly templateName: string | null;
  readonly audioBlobs: number;
}

export interface CardsMessage {
  readonly kind: "cards";
  readonly id: number;
  readonly cards: readonly CardBrief[];
}

/** A `template_fields` row, as much of it as the resolver and the bridge need. */
export interface FieldRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  /** `template_fields.options`, raw JSON. Read for `lang` / `voice` only. */
  readonly options: string;
  readonly pos: string;
}

export interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  /** Decoded `templates.reverse_permutation`. Null means "authored order reversed". */
  readonly reversePermutation: readonly number[] | null;
  readonly fields: readonly FieldRow[];
}

/**
 * One `blob_refs` row joined to its `blobs` row.
 *
 * `refKey` is the attachment filename for imported media and the generation
 * identity for a cached generation — the two shapes are not interchangeable and
 * the viewer prints which one it matched on.
 */
export interface AttachmentRow {
  readonly hash: string;
  readonly kind: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly sourceText: string | null;
  readonly voice: string | null;
  readonly lang: string | null;
  readonly refKey: string;
  readonly fieldId: string | null;
  /** True when the payload is reachable: inline in the row, or in this store. */
  readonly payloadPresent: boolean;
}

export interface CardBundle {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly deckId: string;
  readonly deckPath: string;
  /** `cards.reverse` and the deck's, unresolved — the direction toggle shows both. */
  readonly cardReverse: string;
  readonly deckReverse: string;
  readonly template: TemplateRow | null;
  readonly values: readonly (readonly [string, string])[];
  readonly attachments: readonly AttachmentRow[];
  /** `card_links` out of this card, with the target's name where it exists. */
  readonly links: readonly (readonly [string, string | null])[];
  readonly reviews: number;
}

export interface CardMessage {
  readonly kind: "card";
  readonly id: number;
  readonly card: CardBundle;
}

export interface PayloadMessage {
  readonly kind: "payload";
  readonly id: number;
  readonly hash: string;
  /** Transferred, not copied. Null when the store does not hold it. */
  readonly bytes: Uint8Array | null;
  /** `blobs.mime`, sniffed at import. Never Mochi's claim. */
  readonly mime: string;
  readonly readMs: number;
  /** Re-hashed in the worker: do these bytes still hash to `hash`? */
  readonly addressOk: boolean;
  readonly error?: string;
}

export interface FailMessage {
  readonly kind: "fail";
  readonly id: number;
  readonly error: string;
}

export type ViewerMessage =
  | LogMessage
  | OpenedMessage
  | CardsMessage
  | CardMessage
  | PayloadMessage
  | FailMessage;
