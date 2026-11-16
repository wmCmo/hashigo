export interface OpenRequest {
  readonly kind: "open";
  readonly reimport: boolean;
  readonly id: number;
}

export interface BrowseRequest {
  readonly kind: "browse";
  readonly id: number;
  readonly deckId: string | null;
  readonly limit: number;
}

export interface CardRequest {
  readonly kind: "card";
  readonly id: number;
  readonly cardId: string | null;
  readonly deckId: string | null;
  readonly withAudio: boolean;
}

export interface PayloadRequest {
  readonly kind: "payload";
  readonly id: number;
  readonly hash: string;
}

export type ViewerRequest = OpenRequest | BrowseRequest | CardRequest | PayloadRequest;

export type LogLevel = "info" | "step" | "good" | "bad";

export interface LogMessage {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string;
}

export interface DeckBrief {
  readonly id: string;
  readonly path: string;
  readonly cards: number;
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

export interface FieldRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  readonly options: string;
  readonly pos: string;
}

export interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly reversePermutation: readonly number[] | null;
  readonly fields: readonly FieldRow[];
}

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
  readonly payloadPresent: boolean;
}

export interface CardBundle {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly deckId: string;
  readonly deckPath: string;
  readonly cardReverse: string;
  readonly deckReverse: string;
  readonly template: TemplateRow | null;
  readonly values: readonly (readonly [string, string])[];
  readonly attachments: readonly AttachmentRow[];
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
  readonly bytes: Uint8Array | null;
  readonly mime: string;
  readonly readMs: number;
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
