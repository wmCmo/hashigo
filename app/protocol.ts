/**
 * The two halves of the app, and the line between them.
 *
 * This is NOT a spike protocol — `app/` is the shipping shell. But the split it
 * describes is the same one `spike/viewer/protocol.ts` arrived at, for reasons
 * that are properties of the platform rather than of that harness:
 *
 *   * **the WORKER owns both SQLite databases and every SQL statement**, because
 *     `opfs-sahpool` needs `createSyncAccessHandle`, which the platform restricts
 *     to dedicated workers. Hashigo sets no COOP/COEP headers on purpose, so
 *     there is no SharedArrayBuffer either — a synchronous handle simply cannot
 *     be reached from the page;
 *   * **the PAGE owns the DOM, the `BlobUrlScope` and therefore every object
 *     URL**, because the scope that mints a URL must be the scope that revokes it
 *     (`src/blobs/url.ts`, rule 1) and the worker cannot know when an `<audio>`
 *     element has finished with a clip.
 *
 * ─── THE MESSAGE LOG IS EVIDENCE FOR THE HARD RULE ──────────────────────────
 *
 * `PayloadRequest` is the only message that moves audio bytes, and on the page it
 * is sent from exactly one place: the `resolve` function handed to
 * `mountPrepared`. `audioController` calls that only from `play()`, which is
 * reachable only from `reveal()`, `play()` and `prompt()`. So a card sitting on
 * screen produces NO payload message at all, and on a `produce` card there is no
 * payload message until he reveals.
 *
 * That is worth stating as a property of the protocol rather than of the code,
 * because it means the claim is checkable from outside: open the devtools message
 * log, step onto a side, and count.
 */

import type { AudioAddress } from "../src/render/audio.js";
import type { BlobPayload } from "../src/blobs/url.js";
import type { PreparedCard } from "../src/review/index.js";
import type { SessionProgress } from "../src/session/index.js";

// ─── page → worker ───────────────────────────────────────────────────────────

/** Install the pool, import the bootstrap if OPFS has none, build a session. */
export interface OpenRequest {
  readonly kind: "open";
  readonly id: number;
  /** Re-import from the network even if OPFS already holds the database. */
  readonly reimport: boolean;
}

/**
 * The card the session is on, prepared for rendering.
 *
 * `offset` is his #9: a non-zero value LOOKS at a neighbour without moving the
 * cursor, writing a review, or changing what `answer()` would grade. Zero is the
 * current card, so one message serves both and they cannot drift apart.
 */
export interface NextRequest {
  readonly kind: "next";
  readonly id: number;
  readonly offset?: number;
}

/**
 * Bytes for one clip. **THE ONLY MESSAGE THAT MOVES A PAYLOAD**, and the page
 * sends it from one place — see this file's header.
 */
export interface PayloadRequest {
  readonly kind: "payload";
  readonly id: number;
  readonly cardId: string;
  readonly address: AudioAddress;
}

/** Grade the current item and advance. A decision-13 re-ask is not graded. */
export interface AnswerRequest {
  readonly kind: "answer";
  readonly id: number;
  readonly remembered: boolean;
  readonly durationMs: number | null;
}

/**
 * Flip `Reading` on one card, mid-session — decision 29's audit loop.
 *
 * *"i'll be like, damn, i didn't know this, ive been pronounced it has 平板 all
 * along, and then i'll just go ahead and edit the card to `Reading` -> true"*.
 * Without this the loop needs him to leave the app, which means it will not
 * happen.
 */
export interface ReadingRequest {
  readonly kind: "reading";
  readonly id: number;
  readonly cardId: string;
  readonly value: boolean;
}

/**
 * Throw away everything in OPFS and stop.
 *
 * **This is the route a SCHEMA BUMP needs** (`SCHEMA_VERSION` has moved eight
 * times and `applySchema` refuses any version but its own, so a bump means
 * re-import rather than migrate) and it is the only way to free the space: a
 * per-file `unlink()` frees NOTHING — it disassociates the name from its pool slot
 * and leaves the file, measured at 0.0 MiB of 639.0 MiB on Zach's own handset.
 * Only `removeVfs()` frees anything.
 *
 * It destroys local grades, so the page confirms first and the worker closes
 * cleanly rather than pulling the file out from under an open handle.
 */
export interface ResetRequest {
  readonly kind: "reset";
  readonly id: number;
}

export interface ResetMessage {
  readonly kind: "reset";
  readonly id: number;
  readonly removed: readonly string[];
  /** Local grades destroyed. Reported so the log says what it cost. */
  readonly localReviews: number;
}

/**
 * One operation on one card — his #7 and #14.
 *
 * `archive` sets `cards.archived`, which the queue, dashboard and backtest ALREADY
 * honour (234 imported cards prove it) — so it is one column over machinery that
 * works. `delete` is one statement over cascades that are already complete: every
 * foreign key at `cards` is `ON DELETE CASCADE` and the FTS triggers keep search
 * correct. `duplicate` copies the row and its field values, and opens fresh tracks.
 *
 * **Undo (his #13) is why this reports `undo`.** Every operation returns what it
 * would take to reverse it, so the page can stack it without re-deriving anything.
 */
/**
 * `pin` and `unpin` were the last two of his #6's list to have no verb.
 *
 * **`cards.pinned` has existed since schema v1 and nothing ever wrote it** — the
 * column, its CHECK, its partial index (`cards_pinned`) and the importer's
 * `card["pinned?"]` read were all already there. His export carries **0** pinned
 * cards, so every pin in this database from here on is one HE made in Hashigo.
 *
 * Which is worth knowing for one reason: `UPSERT_CARD` writes
 * `pinned = excluded.pinned`, so decision 16's final import overwrites a local pin
 * with Mochi's 0 — exactly as it overwrites a local archive. That is why the backup
 * now carries per-card collection state (`src/backup/archive.ts`).
 */
export type CardOp = "archive" | "unarchive" | "pin" | "unpin" | "delete" | "duplicate";

export interface CardOpRequest {
  readonly kind: "cardOp";
  readonly id: number;
  readonly op: CardOp;
  readonly cardId: string;
}

export interface CardOpMessage {
  readonly kind: "cardOp";
  readonly id: number;
  readonly op: CardOp;
  readonly cardId: string;
  /** `duplicate` returns the new card; everything else returns the same id. */
  readonly resultCardId: string;
  /** How to reverse it, or null when it cannot be reversed. */
  readonly undo: { readonly op: CardOp; readonly cardId: string } | null;
  /** Said plainly, for the status line and for the undo stack's label. */
  readonly describe: string;
  /**
   * True when this operation removed the card the session was showing, so the page
   * must advance instead of leaving a deleted card on screen.
   *
   * Deleting the current card used to hard-lock the review: the row was gone, the
   * track went with it (ON DELETE CASCADE), and every later grade threw invisibly.
   */
  readonly advanced: boolean;
}

/** Deck operations — his #14, and the answer to #8. */
/**
 * `move` is the one his #2 and #5 imply rather than name.
 *
 * *"why are templates not nesting like notion pages on the side bar"* and *"nesting
 * deck on the side bar should be togglable"* describe a tree he arranges, and a
 * tree with no reparent is a tree he can only build in the order he thought of it.
 * The worker guards it against cycles — see `deckOp`.
 */
export type DeckOp =
  | "archive"
  | "unarchive"
  | "rename"
  | "create"
  | "move"
  | "delete"
  | "restoreArchive";

/**
 * Undo the last grade — his request 13's first-named action.
 *
 * Carries NOTHING. The worker owns the stack of `AnswerResult`s it produced, because
 * an undo needs the session's cursor and its decision-13 re-ask queue as well as the
 * two database rows, and those live in the worker with the session. The page's undo
 * entry only has to say "the last thing was a grade".
 */
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
  /** `rename` and `create` only. */
  readonly name?: string;
  /** `create` and `move`; null makes a top-level deck. */
  readonly parentId?: string | null;
  /** `restoreArchive` only: the exact rows a previous archive/unarchive flipped. */
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
    /** `move` only: where it came from. `null` is a real value — top level. */
    readonly parentId?: string | null;
    /**
     * The cards this operation ACTUALLY CHANGED, for `restoreArchive`.
     *
     * An archive used to undo by running its inverse over the whole deck, which is
     * not an undo — it is a second, different write. 234 cards in the corpus are
     * archived individually, and one ctrl+Z after an accidental deck archive
     * un-archived every one of them with no way back.
     *
     * So the op records the exact rows whose `archived` flag it flipped, and the
     * undo restores only those. Cards that were already archived are never touched,
     * because they were never changed.
     */
    readonly cardIds?: readonly string[];
  } | null;
}

/**
 * Make a new card — his request 5's other half.
 *
 * **There is no id namespace and no collision question**, which is where an
 * earlier version of this spent effort it should not have. Zach never imports a
 * single card or deck: the import is WHOLESALE, and after decision 16's one final
 * import no Mochi data arrives here ever again. So a card id has to be unique in
 * this database and nothing more, which `cards.id UNIQUE` already enforces.
 */
export interface CreateCardRequest {
  readonly kind: "createCard";
  readonly id: number;
  readonly deckId: string;
  /** Null makes a template-less card, which 66 of his already are. */
  readonly templateId: string | null;
  readonly name: string;
}

export interface CreateCardMessage {
  readonly kind: "createCard";
  readonly id: number;
  readonly cardId: string;
  /** Tracks opened for it — `forward`, plus `reverse` when the deck says so. */
  readonly tracks: readonly string[];
  readonly card: PreparedCard | null;
}

/** Templates a new card can be given, with the deck list. */
export interface TemplateBrief {
  readonly id: string;
  readonly name: string;
  readonly fields: number;
}

/**
 * The deck tree, for the sidebar — his request 5, the browsing half.
 *
 * Sent once when the sidebar first opens. 39 decks, so there is no paging and no
 * lazy tree: the whole thing is smaller than one card's field values.
 */
export interface DecksRequest {
  readonly kind: "decks";
  readonly id: number;
}

export interface DeckBrief {
  readonly id: string;
  /** `親 / 子`, resolved — so the list reads without reconstructing the tree. */
  readonly path: string;
  readonly cards: number;
  /** Non-dormant, non-archived tracks due today or earlier. */
  readonly due: number;
  /** For his #2 and #5: the sidebar nests, and nesting needs the edges. */
  readonly parentId: string | null;
  readonly name: string;
  readonly archived: boolean;
}

export interface DecksMessage {
  readonly kind: "decks";
  readonly id: number;
  readonly decks: readonly DeckBrief[];
  readonly cards: number;
  /** For the new-card form. Sent with the decks, since both are tiny. */
  readonly templates: readonly TemplateBrief[];
}

/**
 * Cards matching a query, or the contents of a deck when the query is empty.
 *
 * `src/search` answers the query half and it already handles the thing a naive
 * implementation gets wrong: a 1-2 character query, which is the commonest search
 * unit in Japanese and which the trigram index CANNOT serve. It routes to a
 * ranked scan instead and says which path ran.
 */
export interface BrowseRequest {
  readonly kind: "browse";
  readonly id: number;
  readonly query: string;
  /** Restrict to one deck. Null browses everything. */
  readonly deckId: string | null;
  readonly limit: number;
}

export interface BrowseHit {
  readonly cardId: string;
  readonly name: string;
  readonly deckPath: string;
  /** Archived cards are SHOWN and marked, never hidden — see `SearchOptions`. */
  readonly archived: boolean;
  /** His #6. Pinned tiles sort to the front of the gallery, in every order. */
  readonly pinned: boolean;
  readonly snippet: string | null;
}

export interface BrowseMessage {
  readonly kind: "browse";
  readonly id: number;
  readonly hits: readonly BrowseHit[];
  /** Every match, not just this page. Exact, so the UI can say "50 of 228". */
  readonly total: number;
  /** `"fts"`, `"like"`, or null when nothing was searched (a deck listing). */
  readonly mode: string | null;
  readonly elapsedMs: number;
}

/**
 * Write ONE field value on one card — his request 3, and the whole of it.
 *
 * "edit each field of the card right away". `card_field_values` is the table, and
 * the app already writes it (the `Reading` toggle), so this generalises a path
 * that runs rather than opening a new one.
 *
 * The worker validates rather than trusting this: the field must be DECLARED on
 * the card's own template, and its type must be one whose stored value is the
 * content. See `setField` there.
 */
export interface SetFieldRequest {
  readonly kind: "setField";
  readonly id: number;
  readonly cardId: string;
  readonly fieldId: string;
  /**
   * The new value, or NULL to remove the row entirely.
   *
   * Null exists for undo: restoring a field that had no row before means deleting
   * it, and writing an empty string instead would leave a row that renders the
   * same but is not the same — `<<#field>>` gates on presence.
   */
  readonly value: string | null;
}

export interface SetFieldMessage {
  readonly kind: "setField";
  readonly id: number;
  readonly cardId: string;
  readonly fieldId: string;
  readonly value: string | null;
  /** True when the row was created rather than updated. */
  readonly created: boolean;
  /**
   * What the field held BEFORE this write — null when there was no row.
   *
   * This is what makes an edit undoable, and it has to come from the worker: the
   * page's copy of a field value is whatever it last rendered, which is not
   * necessarily what is on disk.
   */
  readonly previous: string | null;
}

/**
 * One card BY ID, for a preview layer — his request 2.
 *
 * Deliberately separate from `next`, which is session-bound. A preview is not a
 * review (decision 30), so it takes no session state, advances nothing, and the
 * worker does not care whether the card is due, archived or even in the plan.
 */
export interface PreviewRequest {
  readonly kind: "preview";
  readonly id: number;
  readonly cardId: string;
}

export interface PreviewMessage {
  readonly kind: "preview";
  readonly id: number;
  /** Null when the link points at a card this database does not have. */
  readonly card: PreparedCard | null;
  readonly deckPath: string;
  readonly name: string;
  /** Same reason as `CardMessage` — a preview carries the same operations. */
  readonly pinned: boolean;
  readonly archived: boolean;
}

/**
 * His #11: *"where can i edit my template? there should be a modal for editing
 * template and fields"*.
 *
 * ─── RENAMING A FIELD IS A BODY EDIT, AND THAT DECIDES THIS WHOLE SHAPE ─────
 *
 * `src/template/resolve.ts` binds `<<Field>>` **by NAME**. So a rename that touches
 * only `template_fields` unbinds every marker in the body — silently, because an
 * unresolved `<<X>>` is an empty string and not an error. On 単語 that is decision
 * 29's `<<#Reading>>` gate: the entire mode split, off, with nothing to see.
 *
 * The rewrite therefore happens in the SAME transaction as the rename, over the
 * body and over every generator prompt beside it (`schema.sql`: 例文's only
 * dependency is named inside its own prompt text). `src/template/rename.ts` owns
 * the rewrite and a test round-trips it over every field of every real template.
 */
export interface TemplateFieldRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly sourceFieldId: string | null;
  readonly options: string;
  readonly pos: string;
  /** Decision 9: 1 = added here, and protected from `pruneFieldValues`. */
  readonly local: boolean;
  /** Values on cards. Shown because deleting a field does NOT delete them. */
  readonly values: number;
  /** How many times the body references it. A rename rewrites exactly these. */
  readonly references: number;
  /** Fields whose `source_field_id` is this one. A delete would unbind them. */
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

export type TemplateOp =
  | "rename"
  | "body"
  | "addField"
  | "renameField"
  | "deleteField"
  | "restoreField"
  | "orderFields";

export interface TemplateOpRequest {
  readonly kind: "templateOp";
  readonly id: number;
  readonly op: TemplateOp;
  readonly templateId: string;
  /** `rename` (template) and `addField` / `renameField` (the field's name). */
  readonly name?: string;
  /** `body` only. */
  readonly content?: string;
  /** Everything that acts on one field. */
  readonly fieldId?: string;
  /** `addField` only. Validated against the schema CHECK in the worker. */
  readonly fieldType?: string;
  /** `orderFields` only: every field id, in the order they should sit. */
  readonly order?: readonly string[];
  /** `restoreField` only: the row a delete removed, put back verbatim. */
  readonly field?: TemplateFieldRow;
}

export interface TemplateOpMessage {
  readonly kind: "templateOp";
  readonly id: number;
  readonly op: TemplateOp;
  readonly describe: string;
  /** The template as it now stands, so the editor repaints from the row. */
  readonly template: TemplateDetail | null;
  readonly undo: {
    readonly op: TemplateOp;
    readonly templateId: string;
    readonly name?: string;
    readonly content?: string;
    readonly fieldId?: string;
    readonly order?: readonly string[];
    readonly field?: TemplateFieldRow;
  } | null;
}

/**
 * His #1: *"i want dashboard to be accessible from the side bar"*.
 *
 * ─── IT IS THE SAME RENDERER, RUN IN THE WORKER ─────────────────────────────
 *
 * `npm run dashboard` writes a standalone file with **zero JavaScript** — SPEC
 * problem #1 is battery, and a page that computes nothing after load costs nothing
 * to look at. That property is exactly what makes it embeddable: the reply is a
 * complete HTML document, and the page puts it in an `<iframe srcdoc>` where its
 * own stylesheet cannot touch the app's and vice versa.
 *
 * `src/dashboard/metrics.ts` was already a pinned browser entry point; the only
 * thing standing between it and this was its `Db` type, which named
 * better-sqlite3's handle instead of the shared `SqliteHandle` both implement.
 *
 * The `locale` is his: decision — English by default, `ja` byte-identical to a
 * committed golden file.
 */
export interface DashboardRequest {
  readonly kind: "dashboard";
  readonly id: number;
  readonly locale: string;
}

export interface DashboardMessage {
  readonly kind: "dashboard";
  readonly id: number;
  /** A complete document, zero JavaScript. */
  readonly html: string;
  readonly bytes: number;
  readonly elapsedMs: number;
}

/** Decision 17's archive, as JSON text, for the page to hand to a download. */
export interface BackupRequest {
  readonly kind: "backup";
  readonly id: number;
}

/**
 * His #12: *"i want to have a setting screen where i can adjust all the setting
 * that we have"* — and "all the settings we have" is a question with an answer,
 * not a wish. It is the `settings` table plus the two keys `src/session/settings.ts`
 * resolves, and this reply is the whole of it.
 *
 * It also carries the things he would go to a settings screen to FIND and which
 * are not rows — storage, audio coverage, versions. Those were reachable only from
 * the boot log, which scrolls away.
 */
export interface SettingsRequest {
  readonly kind: "settings";
  readonly id: number;
}

export interface SettingsMessage {
  readonly kind: "settings";
  readonly id: number;
  /** Every row in `settings`, verbatim. The screen decides what to show. */
  readonly values: Readonly<Record<string, string>>;
  /**
   * What the NEXT session will actually use, after defaults and validation.
   *
   * Sent beside the raw values on purpose: they can disagree, and when they do the
   * screen has to say so. A settings row that is quietly ignored is worse than one
   * that is refused — `readSessionSettings` reports what it rejected for exactly
   * this reason.
   */
  readonly resolved: {
    readonly newLimit: number;
    readonly interleave: string;
    readonly rejected: readonly { readonly key: string; readonly value: string }[];
  };
  /** Decision 17's other half: is this database allowed to survive? */
  readonly storage: {
    readonly persisted: boolean;
    readonly usageBytes: number | null;
    readonly quotaBytes: number | null;
  };
  /**
   * Audio coverage on THIS device. `app-bootstrap` ships a bounded subset (32 MiB
   * by default), and the number it prints at build time is not the number after a
   * re-import — so it is measured here rather than remembered.
   */
  readonly audio: {
    readonly cardsWithSpeech: number;
    readonly cardsThatCanPlay: number;
    readonly payloads: number;
  };
  readonly schemaVersion: number;
  readonly sqliteVersion: string;
  readonly localReviews: number;
}

/**
 * Write one setting.
 *
 * `previous` comes back so the page can push an undo — his #13 says *"whether
 * create card, review card, remember card, forget card, etc."*, and a settings
 * change is squarely in the "etc." A change with no way back is the one kind he
 * would have to fix by reasoning about what it used to be.
 */
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
  /** Null when the key did not exist — see `writeSetting`. */
  readonly previous: string | null;
  readonly describe: string;
}

export type AppRequest =
  | OpenRequest
  | NextRequest
  | PayloadRequest
  | AnswerRequest
  | ReadingRequest
  | BackupRequest
  | PreviewRequest
  | DecksRequest
  | BrowseRequest
  | CreateCardRequest
  | CardOpRequest
  | DeckOpRequest
  | UngradeRequest
  | SetFieldRequest
  | TemplateRequest
  | TemplateOpRequest
  | DashboardRequest
  | SettingsRequest
  | SetSettingRequest
  | ResetRequest;

// ─── worker → page ───────────────────────────────────────────────────────────

export type LogLevel = "info" | "step" | "good" | "bad";

/** Progress narration. Not a reply to anything, so it carries no `id`. */
export interface LogMessage {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string;
}

export interface OpenedMessage {
  readonly kind: "opened";
  readonly id: number;
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
  /** Files in the pool, so a diagnostic can say what is actually there. */
  readonly files: readonly string[];
  readonly cards: number;
  readonly reviews: number;
  /** Bytes imported this open, or 0 when OPFS already had the database. */
  readonly imported: number;
  readonly storeRows: number;
  /**
   * Was the CARD database already in OPFS when this open began?
   *
   * The half of eviction detection the worker can answer. The other half is a
   * receipt in `localStorage`, which only the page can read — see
   * `checkEviction` in `main.ts`. Reported separately from `imported`, which sums
   * both files and so cannot distinguish "the cards were there" from "the audio
   * was there".
   */
  readonly cardsWerePresent: boolean;
  /**
   * `reviews` where `source = 'local'` — grades made in Hashigo, and the only
   * thing in this database that `exports/` cannot rebuild (decision 17). It is
   * what an eviction would actually cost, so it is what the receipt records.
   */
  readonly localReviews: number;
  readonly progress: SessionProgress;
}

/** One card, ready for `mountPrepared`. `null` when the session is finished. */
export interface CardMessage {
  readonly kind: "card";
  readonly id: number;
  readonly card: PreparedCard | null;
  readonly deckPath: string;
  /** Decision 25's label, per TRACK. */
  readonly isNew: boolean;
  /** Decision 13: showing again, and it will not be graded. */
  readonly reask: boolean;
  /**
   * Collection state, so the screen's pin/archive controls can say which way they
   * go. A toggle that guesses its own starting state is a toggle that lies half
   * the time; the worker owns the row, so the worker says.
   */
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
  /** `due_at` the scheduler issued, when it graded. */
  readonly dueAt: string | null;
  readonly scheduledDays: number | null;
  readonly progress: SessionProgress;
  /** How long the write itself took, in ms. P1's second half. */
  readonly writeMs: number;
  /**
   * `WasmDb.openStatements` after the write — P2, and the only place it is
   * observable. `oo1.DB.close()` finalizes nothing (upstream passes the array
   * INDEX where it means the statement), so every `prepare()` a caller does not
   * finalize pins the OPFS file and eventually makes `pauseVfs()` throw. Reported
   * per grade so the growth rate is a measurement rather than an estimate.
   */
  readonly openStatements: number;
  /** Distinct SQL strings cached. Should PLATEAU; `openStatements` should follow. */
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

/** A reply that failed. Carries the `id` so the page can reject that promise. */
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
  | DecksMessage
  | BrowseMessage
  | SetFieldMessage
  | PreviewMessage
  | ResetMessage
  | LogMessage
  | OpenedMessage
  | CardMessage
  | PayloadMessage
  | AnsweredMessage
  | ReadingMessage
  | BackupMessage
  | SettingsMessage
  | SetSettingMessage
  | TemplateMessage
  | TemplateOpMessage
  | DashboardMessage
  | ErrorMessage;

/** The reply kind each request expects. Keeps the page's typing honest. */
export interface ReplyFor {
  readonly open: OpenedMessage;
  readonly next: CardMessage;
  readonly payload: PayloadMessage;
  readonly answer: AnsweredMessage;
  readonly reading: ReadingMessage;
  readonly backup: BackupMessage;
  readonly reset: ResetMessage;
  readonly preview: PreviewMessage;
  readonly setField: SetFieldMessage;
  readonly dashboard: DashboardMessage;
  readonly template: TemplateMessage;
  readonly templateOp: TemplateOpMessage;
  readonly settings: SettingsMessage;
  readonly setSetting: SetSettingMessage;
  readonly decks: DecksMessage;
  readonly browse: BrowseMessage;
  readonly createCard: CreateCardMessage;
  readonly cardOp: CardOpMessage;
  readonly deckOp: DeckOpMessage;
  readonly ungrade: UngradedMessage;
}
