import type { AudioAddress } from "../src/render/audio.js";
import type { BlobPayload } from "../src/blobs/url.js";
import type { Backlink, FoundIn } from "../src/cards/index.js";
import type { DeriveResult, FillItem, FillReport } from "../src/accent/fill.js";
import type { AnnotatedLine } from "../src/accent/marks.js";
import type { PreparedCard, Pronunciation } from "../src/review/index.js";
import type { Glance } from "../src/dashboard/index.js";
import type { SessionProgress } from "../src/session/index.js";
import type { FieldOutput, FieldPrice, VoicePrice } from "./field-ops.js";

export interface OpenRequest {
  readonly kind: "open";
  readonly id: number;
  readonly reimport: boolean;
}

export interface NextRequest {
  readonly kind: "next";
  readonly id: number;
  readonly offset?: number;
}

export interface PayloadRequest {
  readonly kind: "payload";
  readonly id: number;
  readonly cardId: string;
  readonly address: AudioAddress;
}

export interface AnswerRequest {
  readonly kind: "answer";
  readonly id: number;
  readonly remembered: boolean;
  readonly durationMs: number | null;
  readonly offset: number;
}

export type AnswerRefusal = "already-answered" | "nothing-there";

export interface ReadingRequest {
  readonly kind: "reading";
  readonly id: number;
  readonly cardId: string;
  readonly value: boolean;
}

export interface ResetRequest {
  readonly kind: "reset";
  readonly id: number;
}

export interface ResetMessage {
  readonly kind: "reset";
  readonly id: number;
  readonly removed: readonly string[];
  readonly localReviews: number;
}

export type CardOp =
  | "archive"
  | "unarchive"
  | "pin"
  | "unpin"
  | "delete"
  | "duplicate"
  | "setTemplate";

export interface CardOpRequest {
  readonly kind: "cardOp";
  readonly templateId?: string | null;
  readonly id: number;
  readonly op: CardOp;
  readonly cardId: string;
}

export interface CardOpMessage {
  readonly kind: "cardOp";
  readonly id: number;
  readonly op: CardOp;
  readonly cardId: string;
  readonly resultCardId: string;
  readonly undo: {
    readonly op: CardOp;
    readonly cardId: string;
    readonly templateId?: string | null;
  } | null;
  readonly describe: string;
  readonly advanced: boolean;
}

export type DeckOp =
  | "archive"
  | "unarchive"
  | "rename"
  | "create"
  | "move"
  | "delete"
  | "restoreArchive";

export interface UngradeRequest {
  readonly kind: "ungrade";
  readonly id: number;
}

export interface UngradedMessage {
  readonly kind: "ungraded";
  readonly id: number;
  readonly describe: string;
  readonly cardId: string | null;
  readonly progress: SessionProgress;
}

export interface DeckOpRequest {
  readonly kind: "deckOp";
  readonly id: number;
  readonly op: DeckOp;
  readonly deckId: string;
  readonly name?: string;
  readonly parentId?: string | null;
  readonly cardIds?: readonly string[];
}

export interface DeckOpMessage {
  readonly kind: "deckOp";
  readonly id: number;
  readonly op: DeckOp;
  readonly deckId: string;
  readonly describe: string;
  readonly undo: {
    readonly op: DeckOp;
    readonly deckId: string;
    readonly name?: string;
    readonly parentId?: string | null;
    readonly cardIds?: readonly string[];
  } | null;
}

export interface CreateCardRequest {
  readonly kind: "createCard";
  readonly id: number;
  readonly deckId: string;
  readonly templateId: string | null;
  readonly name: string;
  readonly source?: { readonly cardId: string; readonly sentence: string };
  readonly values?: Readonly<Record<string, string>>;
  readonly allowDuplicate?: boolean;
}

export interface CreateTemplateRequest {
  readonly kind: "createTemplate";
  readonly id: number;
  readonly name: string;
}

export interface CreateTemplateMessage {
  readonly kind: "createTemplate";
  readonly id: number;
  readonly templateId: string;
}

export interface CreateCardMessage {
  readonly kind: "createCard";
  readonly id: number;
  readonly cardId: string | null;
  readonly tracks: readonly string[];
  readonly card: PreparedCard | null;
  readonly duplicate: {
    readonly message: string;
    readonly existing: readonly { readonly cardId: string; readonly deckPath: string; readonly archived: boolean }[];
  } | null;
}

export interface TemplateBrief {
  readonly id: string;
  readonly name: string;
  readonly fields: number;
  readonly homeDeckId: string | null;
}

export interface DecksRequest {
  readonly kind: "decks";
  readonly id: number;
}

export interface DeckBrief {
  readonly id: string;
  readonly path: string;
  readonly cards: number;
  readonly due: number;
  readonly parentId: string | null;
  readonly name: string;
  readonly archived: boolean;
}

export interface DecksMessage {
  readonly kind: "decks";
  readonly id: number;
  readonly decks: readonly DeckBrief[];
  readonly cards: number;
  readonly templates: readonly TemplateBrief[];
}

export interface BrowseRequest {
  readonly kind: "browse";
  readonly id: number;
  readonly query: string;
  readonly deckId: string | null;
  readonly tagPath?: string | null;
  readonly limit: number;
  readonly suggest: boolean;
  readonly visited: readonly string[];
  readonly includeArchived?: boolean;
}

export interface BrowseHit {
  readonly cardId: string;
  readonly name: string;
  readonly deckPath: string;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly snippet: string | null;
  readonly gist: string | null;
}

export interface BrowseMessage {
  readonly kind: "browse";
  readonly id: number;
  readonly hits: readonly BrowseHit[];
  readonly total: number;
  readonly mode: string | null;
  readonly elapsedMs: number;
}

export interface SetFieldRequest {
  readonly kind: "setField";
  readonly id: number;
  readonly cardId: string;
  readonly fieldId: string;
  readonly value: string | null;
}

export interface SetFieldMessage {
  readonly kind: "setField";
  readonly id: number;
  readonly cardId: string;
  readonly fieldId: string;
  readonly value: string | null;
  readonly created: boolean;
  readonly previous: string | null;
  readonly cleared: readonly { readonly fieldId: string; readonly name: string; readonly previous: string | null }[];
}

export interface PreviewRequest {
  readonly kind: "preview";
  readonly id: number;
  readonly cardId: string;
}

export interface PreviewMessage {
  readonly kind: "preview";
  readonly id: number;
  readonly card: PreparedCard | null;
  readonly deckPath: string;
  readonly name: string;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly templates: readonly TemplateChoice[];
}

export interface BacklinksRequest {
  readonly kind: "backlinks";
  readonly id: number;
  readonly cardId: string;
}

export interface BacklinksMessage {
  readonly kind: "backlinks";
  readonly id: number;
  readonly cards: readonly Backlink[];
  readonly foundIn: FoundIn | null;
}

export interface TemplateFieldRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  readonly options: string;
  readonly pos: string;
  readonly local: boolean;
  readonly values: number;
  readonly references: number;
  readonly sides: readonly number[];
  readonly dependents: readonly string[];
}

export interface TemplateDetail {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly cards: number;
  readonly fields: readonly TemplateFieldRow[];
}

export interface TemplateRequest {
  readonly kind: "template";
  readonly id: number;
  readonly templateId: string;
}

export interface TemplateMessage {
  readonly kind: "template";
  readonly id: number;
  readonly template: TemplateDetail | null;
}

export interface TemplateChoice {
  readonly templateId: string;
  readonly name: string;
  readonly fields: number;
  readonly keeps: number;
  readonly hides: number;
  readonly current: boolean;
}

export type TemplateOp =
  | "rename"
  | "body"
  | "addField"
  | "renameField"
  | "deleteField"
  | "restoreField"
  | "orderFields"
  | "setFieldOptions"
  | "setFieldSource"
  | "setFieldType"
  | "setFieldKind";

export interface TemplateOpRequest {
  readonly kind: "templateOp";
  readonly id: number;
  readonly op: TemplateOp;
  readonly templateId: string;
  readonly name?: string;
  readonly content?: string;
  readonly fieldId?: string;
  readonly fieldType?: string;
  readonly order?: readonly string[];
  readonly field?: TemplateFieldRow;
  readonly options?: string;
  readonly sourceFieldId?: string | null;
}

export interface TemplateOpMessage {
  readonly kind: "templateOp";
  readonly id: number;
  readonly op: TemplateOp;
  readonly describe: string;
  readonly template: TemplateDetail | null;
  readonly undo: {
    readonly op: TemplateOp;
    readonly templateId: string;
    readonly name?: string;
    readonly content?: string;
    readonly fieldId?: string;
    readonly order?: readonly string[];
    readonly field?: TemplateFieldRow;
    readonly options?: string;
    readonly sourceFieldId?: string | null;
    readonly fieldType?: string;
  } | null;
}

export type VoiceTarget = "card" | "deck";

export interface VoiceRequest {
  readonly kind: "voice";
  readonly id: number;
  readonly target: VoiceTarget;
  readonly targetId: string;
  readonly voice: string | null;
  readonly dry: boolean;
}

export interface VoiceMessage {
  readonly kind: "voice";
  readonly id: number;
  readonly target: VoiceTarget;
  readonly targetId: string;
  readonly voice: string | null;
  readonly previous: string | null;
  readonly price: VoicePrice;
  readonly lines: readonly string[];
  readonly describe: string;
}

export interface PriceFieldRequest {
  readonly kind: "priceField";
  readonly id: number;
  readonly templateId: string;
  readonly fieldId: string;
  readonly options?: string;
  readonly sourceFieldId?: string | null;
}

export interface PriceFieldMessage {
  readonly kind: "priceField";
  readonly id: number;
  readonly price: FieldPrice;
  readonly lines: readonly string[];
  readonly ms: number;
}

export interface GlanceRequest {
  readonly kind: "glance";
  readonly id: number;
}

export interface GlanceMessage {
  readonly kind: "glance";
  readonly id: number;
  readonly glance: Glance;
  readonly elapsedMs: number;
}

export interface DashboardRequest {
  readonly kind: "dashboard";
  readonly id: number;
  readonly locale: string;
}

export interface DashboardMessage {
  readonly kind: "dashboard";
  readonly id: number;
  readonly html: string;
  readonly bytes: number;
  readonly elapsedMs: number;
}

export interface SyncExportRequest {
  readonly kind: "syncExport";
  readonly id: number;
  readonly indexOnly?: boolean;
}

export interface ReplanRequest {
  readonly kind: "replan";
  readonly id: number;
}

export interface ReplannedMessage {
  readonly kind: "replan";
  readonly id: number;
  readonly planned: number;
}

export interface FocusRequest {
  readonly kind: "focus";
  readonly id: number;
  readonly deckId: string | null;
  readonly silent: boolean;
}

export interface FocusedMessage {
  readonly kind: "focus";
  readonly id: number;
  readonly planned: number;
  readonly dueCount: number;
  readonly newCount: number;
}

export interface FocusCountsRequest {
  readonly kind: "focusCounts";
  readonly id: number;
  readonly deckId: string | null;
}

export interface FocusCount {
  readonly due: number;
  readonly fresh: number;
}

export interface FocusCountsMessage {
  readonly kind: "focusCounts";
  readonly id: number;
  readonly all: FocusCount;
  readonly silent: FocusCount;
}

export interface SyncMergeRequest {
  readonly kind: "syncMerge";
  readonly id: number;
  readonly payload: unknown;
}

export interface GeneratedTextRequest {
  readonly kind: "generatedText";
  readonly id: number;
  readonly cardId?: string;
  readonly slots: readonly {
    readonly kind: string;
    readonly text: string;
    readonly lang: string | null;
    readonly voice: string | null;
    readonly options: Readonly<Record<string, string>>;
  }[];
}

export interface GeneratedTextMessage {
  readonly kind: "generatedText";
  readonly id: number;
  readonly texts: readonly (string | null)[];
}

export interface StoreClipRequest {
  readonly kind: "storeClip";
  readonly id: number;
  readonly slot: {
    readonly text: string;
    readonly lang: string | null;
    readonly voice?: string | null;
    readonly options: Readonly<Record<string, string>>;
  };
  readonly audio: string;
  readonly retire?: string;
}

export interface RedoInfoRequest {
  readonly kind: "redoInfo";
  readonly id: number;
  readonly cardId: string;
  readonly request: {
    readonly text: string;
    readonly lang: string | null;
    readonly voice: string | null;
    readonly options: Readonly<Record<string, string>>;
  };
}

export interface RedoInfoMessage {
  readonly kind: "redoInfo";
  readonly id: number;
  readonly hash: string | null;
  readonly voice: string | null;
  readonly readings: readonly { readonly base: string; readonly alias: string }[];
  readonly pronounce: Pronunciation | null;
}

export interface PronunciationRequest {
  readonly kind: "pronunciation";
  readonly id: number;
  readonly cardId: string;
  readonly text: string;
}

export interface PronunciationMessage {
  readonly kind: "pronunciation";
  readonly id: number;
  readonly waiting: boolean;
  readonly pronounce: Pronunciation | null;
}

export interface UpcomingCardsRequest {
  readonly kind: "upcomingCards";
  readonly id: number;
  readonly days: number;
}

export interface UpcomingCardsMessage {
  readonly kind: "upcomingCards";
  readonly id: number;
  readonly cardIds: readonly string[];
}

export interface CardGapsRequest {
  readonly kind: "cardGaps";
  readonly id: number;
  readonly cardId: string;
}

export interface RecordFoundInRequest {
  readonly kind: "recordFoundIn";
  readonly id: number;
  readonly cardId: string;
  readonly sourceCardId: string;
  readonly sentence: string;
}

export interface RecordFoundInMessage {
  readonly kind: "recordFoundIn";
  readonly id: number;
  readonly outcome: "recorded" | "kept" | "unknown";
}

export interface FieldOutputsRequest {
  readonly kind: "fieldOutputs";
  readonly id: number;
  readonly cardId: string;
}

export interface FieldOutputsMessage {
  readonly kind: "fieldOutputs";
  readonly id: number;
  readonly outputs: readonly FieldOutput[];
}

export interface CardGapsMessage {
  readonly kind: "cardGaps";
  readonly id: number;
  readonly local: boolean;
  readonly gaps: readonly {
    readonly kind: string;
    readonly text: string;
    readonly lang: string | null;
    readonly voice: string | null;
    readonly options: Readonly<Record<string, string>>;
  }[];
}

export interface AccentPlanRequest {
  readonly kind: "accentPlan";
  readonly id: number;
  readonly cardIds?: readonly string[];
}

export interface AccentPlanMessage {
  readonly kind: "accentPlan";
  readonly id: number;
  readonly items: readonly FillItem[];
}

export interface AccentFillRequest {
  readonly kind: "accentFill";
  readonly id: number;
  readonly items: readonly FillItem[];
  readonly derived: readonly (readonly [string, DeriveResult])[];
  readonly lines: readonly AnnotatedLine[];
}

export interface AccentFillMessage {
  readonly kind: "accentFill";
  readonly id: number;
  readonly report: FillReport;
}

export interface StoreGenerationRequest {
  readonly kind: "storeGeneration";
  readonly id: number;
  readonly cardId?: string;
  readonly slot: {
    readonly kind: string;
    readonly text: string;
    readonly lang: string | null;
    readonly voice: string | null;
    readonly options: Readonly<Record<string, string>>;
  };
  readonly text: string;
}

export interface StoreClipMessage {
  readonly kind: "storeClip";
  readonly id: number;
  readonly hash: string | null;
  readonly same?: boolean;
}

export interface StoreGenerationMessage {
  readonly kind: "storeGeneration";
  readonly id: number;
  readonly hash: string | null;
}

export interface BackupRequest {
  readonly kind: "backup";
  readonly id: number;
}

export interface SettingsRequest {
  readonly kind: "settings";
  readonly id: number;
}

export interface SettingsMessage {
  readonly kind: "settings";
  readonly id: number;
  readonly values: Readonly<Record<string, string>>;
  readonly resolved: {
    readonly newLimit: number;
    readonly interleave: string;
    readonly examTarget: string;
    readonly rejected: readonly { readonly key: string; readonly value: string }[];
  };
  readonly storage: {
    readonly persisted: boolean;
    readonly usageBytes: number | null;
    readonly quotaBytes: number | null;
  };
  readonly audio: {
    readonly cardsWithSpeech: number;
    readonly cardsThatCanPlay: number;
    readonly payloads: number;
  };
  readonly schemaVersion: number;
  readonly sqliteVersion: string;
  readonly localReviews: number;
}

export interface SetSettingRequest {
  readonly kind: "setSetting";
  readonly id: number;
  readonly key: string;
  readonly value: string;
}

export interface SetSettingMessage {
  readonly kind: "setSetting";
  readonly id: number;
  readonly key: string;
  readonly value: string;
  readonly previous: string | null;
  readonly describe: string;
}

export type AppRequest =
  | OpenRequest
  | NextRequest
  | PayloadRequest
  | AnswerRequest
  | ReadingRequest
  | GeneratedTextRequest
  | BackupRequest
  | SyncExportRequest
  | SyncMergeRequest
  | ReplanRequest
  | FocusRequest
  | FocusCountsRequest
  | SyncDeltaRequest
  | PreviewRequest
  | BacklinksRequest
  | StoreGenerationRequest
  | StoreClipRequest
  | RedoInfoRequest
  | PronunciationRequest
  | CardGapsRequest
  | UpcomingCardsRequest
  | RecordFoundInRequest
  | FieldOutputsRequest
  | AccentPlanRequest
  | AccentFillRequest
  | DecksRequest
  | BrowseRequest
  | CreateCardRequest
  | CreateTemplateRequest
  | CardOpRequest
  | DeckOpRequest
  | UngradeRequest
  | SetFieldRequest
  | TemplateRequest
  | TemplateOpRequest
  | PriceFieldRequest
  | VoiceRequest
  | GlanceRequest
  | DashboardRequest
  | SettingsRequest
  | SetSettingRequest
  | ResetRequest;

export type LogLevel = "info" | "step" | "good" | "bad";

export interface LogMessage {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string;
}

export interface FetchingMessage {
  readonly kind: "fetching";
  readonly url: string;
  readonly index: number;
  readonly of: number;
  readonly received: number;
  readonly total: number | null;
  readonly done: boolean;
}

export interface OpenedMessage {
  readonly kind: "opened";
  readonly id: number;
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
  readonly files: readonly string[];
  readonly cards: number;
  readonly reviews: number;
  readonly imported: number;
  readonly storeRows: number;
  readonly cardsWerePresent: boolean;
  readonly localReviews: number;
  readonly progress: SessionProgress;
}

export interface CardMessage {
  readonly kind: "card";
  readonly id: number;
  readonly card: PreparedCard | null;
  readonly deckPath: string;
  readonly isNew: boolean;
  readonly reask: boolean;
  readonly overdueDays: number;
  readonly dueAt: string | null;
  readonly lastReviewedAt: string | null;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly progress: SessionProgress;
}

export interface PayloadMessage {
  readonly kind: "payload";
  readonly id: number;
  readonly payload: BlobPayload | null;
}

export interface AnsweredMessage {
  readonly kind: "answered";
  readonly id: number;
  readonly graded: boolean;
  readonly queuedReask: boolean;
  readonly refused: AnswerRefusal | null;
  readonly dueAt: string | null;
  readonly scheduledDays: number | null;
  readonly progress: SessionProgress;
  readonly writeMs: number;
  readonly openStatements: number;
  readonly cachedStatements: number;
}

export interface ReadingMessage {
  readonly kind: "reading";
  readonly id: number;
  readonly cardId: string;
  readonly value: boolean;
}

export interface BackupMessage {
  readonly kind: "backup";
  readonly id: number;
  readonly json: string;
  readonly bytes: number;
  readonly counts: Readonly<Record<string, number>>;
}

export interface SyncExportMessage {
  readonly kind: "syncExport";
  readonly id: number;
  readonly json: string;
  readonly bytes: number;
  readonly mark: number;
  readonly index: string;
}

export interface SyncDeltaRequest {
  readonly kind: "syncDelta";
  readonly id: number;
  readonly after: number;
  readonly sent?: string;
}

export interface SyncDeltaMessage {
  readonly kind: "syncDelta";
  readonly id: number;
  readonly json: string;
  readonly bytes: number;
  readonly mark: number;
  readonly count: number;
  readonly edits: number;
  readonly index?: string;
}

export interface SyncMergeMessage {
  readonly kind: "syncMerge";
  readonly id: number;
  readonly reviewsAdded: number;
  readonly flagsTaken: number;
  readonly trackStateTaken: number;
  readonly orphaned: number;
  readonly markBefore: number;
  readonly markAfter: number;
}

export interface ErrorMessage {
  readonly kind: "error";
  readonly id: number;
  readonly message: string;
  readonly stack: string | null;
}

export type AppMessage =
  | CardOpMessage
  | DeckOpMessage
  | UngradedMessage
  | CreateCardMessage
  | CreateTemplateMessage
  | DecksMessage
  | BrowseMessage
  | SetFieldMessage
  | PreviewMessage
  | BacklinksMessage
  | StoreGenerationMessage
  | StoreClipMessage
  | RedoInfoMessage
  | PronunciationMessage
  | CardGapsMessage
  | RecordFoundInMessage
  | FieldOutputsMessage
  | UpcomingCardsMessage
  | AccentPlanMessage
  | AccentFillMessage
  | ResetMessage
  | LogMessage
  | FetchingMessage
  | OpenedMessage
  | CardMessage
  | PayloadMessage
  | AnsweredMessage
  | ReadingMessage
  | GeneratedTextMessage
  | BackupMessage
  | SyncExportMessage
  | SyncMergeMessage
  | ReplannedMessage
  | FocusedMessage
  | FocusCountsMessage
  | SyncDeltaMessage
  | SettingsMessage
  | SetSettingMessage
  | TemplateMessage
  | TemplateOpMessage
  | PriceFieldMessage
  | VoiceMessage
  | GlanceMessage
  | DashboardMessage
  | ErrorMessage;

export interface ReplyFor {
  readonly open: OpenedMessage;
  readonly next: CardMessage;
  readonly payload: PayloadMessage;
  readonly answer: AnsweredMessage;
  readonly reading: ReadingMessage;
  readonly backup: BackupMessage;
  readonly generatedText: GeneratedTextMessage;
  readonly syncExport: SyncExportMessage;
  readonly syncMerge: SyncMergeMessage;
  readonly replan: ReplannedMessage;
  readonly focus: FocusedMessage;
  readonly focusCounts: FocusCountsMessage;
  readonly syncDelta: SyncDeltaMessage;
  readonly reset: ResetMessage;
  readonly preview: PreviewMessage;
  readonly backlinks: BacklinksMessage;
  readonly storeGeneration: StoreGenerationMessage;
  readonly storeClip: StoreClipMessage;
  readonly redoInfo: RedoInfoMessage;
  readonly pronunciation: PronunciationMessage;
  readonly cardGaps: CardGapsMessage;
  readonly upcomingCards: UpcomingCardsMessage;
  readonly recordFoundIn: RecordFoundInMessage;
  readonly fieldOutputs: FieldOutputsMessage;
  readonly accentPlan: AccentPlanMessage;
  readonly accentFill: AccentFillMessage;
  readonly setField: SetFieldMessage;
  readonly glance: GlanceMessage;
  readonly dashboard: DashboardMessage;
  readonly template: TemplateMessage;
  readonly templateOp: TemplateOpMessage;
  readonly priceField: PriceFieldMessage;
  readonly voice: VoiceMessage;
  readonly settings: SettingsMessage;
  readonly setSetting: SetSettingMessage;
  readonly decks: DecksMessage;
  readonly browse: BrowseMessage;
  readonly createCard: CreateCardMessage;
  readonly createTemplate: CreateTemplateMessage;
  readonly cardOp: CardOpMessage;
  readonly deckOp: DeckOpMessage;
  readonly ungrade: UngradedMessage;
}
