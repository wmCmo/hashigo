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
import type { Backlink } from "../src/cards/index.js";
import type { PreparedCard } from "../src/review/index.js";
import type { Glance } from "../src/dashboard/index.js";
import type { SessionProgress } from "../src/session/index.js";
import type { FieldPrice, VoicePrice } from "./field-ops.js";

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

/** Grade the item and advance. A decision-13 re-ask is not graded. */
export interface AnswerRequest {
  readonly kind: "answer";
  readonly id: number;
  readonly remembered: boolean;
  readonly durationMs: number | null;
  /**
   * Which card, relative to the session cursor. Zero is the one the session is
   * on, and was the only possibility until 2026-09-12.
   *
   * NON-ZERO IS THE WHOLE POINT: the screen lets him arrow forward and grade what
   * he is reading, so the offset has to travel WITH the grade. Deriving it in the
   * worker is impossible and remembering it there would be a second copy of the
   * screen's state — which is exactly how a grade lands on the wrong card.
   * See `ReviewSession.answerAt`.
   */
  readonly offset: number;
}

/** Why a grade was refused. The screen turns each into a sentence. */
export type AnswerRefusal = "already-answered" | "re-ask" | "nothing-there";

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
export type CardOp =
  | "archive"
  | "unarchive"
  | "pin"
  | "unpin"
  | "delete"
  | "duplicate"
  /**
   * Move a card to another template — his feedback of 2026-09-07.
   *
   * Rides `cardOp` rather than getting its own message, because it needs exactly
   * what `cardOp` already provides: an undo entry and a refresh of every surface
   * showing the card. Its undo is itself, with the previous template id.
   *
   * ─── IT IS NOT A SMALL OPERATION, AND THE NUMBERS SAY SO ──────────────────
   *
   * `card_field_values` is keyed `(card_id, field_id)` and is deliberately NOT
   * foreign-keyed to `template_fields` — `schema.sql`: losing four years of
   * authored text is worse than an orphan row. So a template change never deletes
   * a value; it changes which ones are RENDERABLE.
   *
   * And field ids are almost entirely template-private. Measured over all ten
   * templates, only four ids exist in more than one:
   *
   * ```
   * name                   all 10 templates   (the head word)
   * local-yomi             単語 + 言葉          decision 9
   * local-kana-primary     単語 + 言葉          decision 9
   * local-accent           単語 + 言葉          decision 9
   * ```
   *
   * So 単語 <-> 言葉 carries FOUR values across and every other pair carries ONE.
   * That is not a reason to refuse it — 単語/言葉 is exactly the move decisions 26
   * and 28 are about — it is the reason the picker states the count per option
   * instead of just changing it.
   */
  | "setTemplate";

export interface CardOpRequest {
  readonly kind: "cardOp";
  /** `setTemplate` only. Null detaches the card from every template. */
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
  /** `duplicate` returns the new card; everything else returns the same id. */
  readonly resultCardId: string;
  /** How to reverse it, or null when it cannot be reversed. */
  readonly undo: {
    readonly op: CardOp;
    readonly cardId: string;
    /** `setTemplate` only: the template it came FROM. `null` is a real value. */
    readonly templateId?: string | null;
  } | null;
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
  /**
   * The deck that holds most of this template's live cards, or null for a template
   * with none. Measured 2026-09-24: 1,654 of his 1,744 漢字-template cards are in
   * `日本語/漢字`, and every template is lopsided the same way — so when he switches
   * a new card to 漢字, this is where it belongs. A card cannot be moved between
   * decks from its editor, so choosing the deck at creation is the only chance.
   */
  readonly homeDeckId: string | null;
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
  /**
   * Restrict to one tag and its descendants. Null means no tag scope.
   *
   * Sent when he taps a `#tag` in a card's text. It is a SCOPE and not a query,
   * so a query typed on top of it searches WITHIN the tag rather than replacing
   * it — which is the difference between a link and a seeded search box, and the
   * first cut of this was the second thing: 18 hits for `#Mathematics` where 9
   * carry the tag.
   */
  readonly tagPath?: string | null;
  readonly limit: number;
  /**
   * What an EMPTY query means, and the two callers disagree.
   *
   * The gallery is a deck listing, where `ORDER BY name` is the honest answer and a
   * relevance order would be a lie — that is `false`. Ctrl+K and the `@` picker are
   * asking "what am I likely to want", where the alphabet is noise (eight of the
   * first ten cards in the real corpus are named by an opaque number) — that is
   * `true`, and `app/recent.ts` answers it.
   */
  readonly suggest: boolean;
  /**
   * Cards he opened here, newest first, from `app/visits.ts`. The log lives in the
   * page's `localStorage` and the worker has none, so it travels on the request.
   * Ignored unless `suggest` is set and the query is empty.
   */
  readonly visited: readonly string[];
  /**
   * Archived cards in the result. Absent means TRUE, which is what Ctrl+K and the
   * `@` picker want — a search must still find a card he took out of rotation.
   *
   * The gallery sends its checkbox. It used to filter the page after the fact,
   * which cut the 300-card page AFTER the limit: a deck whose archived cards sort
   * first (日本語's 数字, named by numbers) showed a short page and a total that
   * still counted them. Asked here, the limit and the total are both of what he sees.
   */
  readonly includeArchived?: boolean;
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
  /** The first line of the card's `意味` / `Meaning`, or null — see `app/gist.ts`. */
  readonly gist: string | null;
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
  /**
   * Every template, with what a move would cost THIS card. Sent with the preview
   * because that is what the editor is opened from, and the editor is where the
   * picker lives.
   */
  readonly templates: readonly TemplateChoice[];
}

/**
 * WHAT LINKS HERE — Zach, 2026-09-14: *"i need to know which cards are linked
 * with this, so... list of back links?"*
 *
 * `card_links` is already indexed the right way round (`card_links_target`), so
 * this is the cheap direction of a join the importer built for the other one.
 *
 * SEPARATE FROM THE CARD FETCH, deliberately. **4,823 of 7,716 cards (62.5%) have
 * no backlinks at all**, and the review screen may not show these before the
 * reveal finishes anyway (see `paintBacklinks`) — so riding along with every card
 * mount would buy latency nobody spends. It is asked for once the answer is up,
 * and once when a preview opens.
 */
export interface BacklinksRequest {
  readonly kind: "backlinks";
  readonly id: number;
  readonly cardId: string;
}

export interface BacklinksMessage {
  readonly kind: "backlinks";
  readonly id: number;
  /**
   * Distinct SOURCE cards, by name. One card may link here twice — 876 pairs in
   * the corpus do, a compound naming the same component in two fields — and a
   * second identical row is a duplicate, not a second fact.
   */
  readonly cards: readonly Backlink[];
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
  /**
   * 1-based sides the body names it on. EMPTY means it renders nowhere, which is
   * a real state and not an error: `言葉`'s `かな主流` holds all six values and its
   * body never names them (decision 28), and `読み` is a generator input rather
   * than a display field (decision 10).
   */
  readonly sides: readonly number[];
  /**
   * Fields that consume this one. A delete would unbind them.
   *
   * BOTH kinds of dependency, which is new: `source_field_id`, and the `<<Field>>`
   * markers inside an `ai` field's prompt. The column alone could never see the
   * second, so nothing ever said that `単語` feeds `例文` — the one dependency
   * `schema.sql` warns about by name.
   */
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

/**
 * What moving ONE card to each template would cost, computed per card.
 *
 * The picker in the editor shows this instead of a bare list, because field ids
 * are template-private (see `CardOp`'s `setTemplate`) and "keeps 1 of 7" is the
 * fact that decides whether he wants the move.
 */
export interface TemplateChoice {
  readonly templateId: string;
  readonly name: string;
  readonly fields: number;
  /** Values on THIS card whose field id also exists on that template. */
  readonly keeps: number;
  /** Values on this card that would stop rendering. Retained, never deleted. */
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
  | "setFieldType";

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
  /**
   * `addField` (validated against the schema CHECK) and `setFieldType` (only a
   * conversion the registry calls FREE).
   */
  readonly fieldType?: string;
  /** `orderFields` only: every field id, in the order they should sit. */
  readonly order?: readonly string[];
  /** `restoreField` only: the row a delete removed, put back verbatim. */
  readonly field?: TemplateFieldRow;
  /**
   * `setFieldOptions` only: the WHOLE options JSON, not a patch. Whole so undo is
   * one write of the previous text and the column is never half-changed.
   */
  readonly options?: string;
  /** `setFieldSource` only. Null disconnects the field from any input. */
  readonly sourceFieldId?: string | null;
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
    readonly options?: string;
    readonly sourceFieldId?: string | null;
    readonly fieldType?: string;
  } | null;
}

/**
 * A voice override on one card or one deck — stage E of fields-as-modules.
 *
 * ONE request for both the price and the write: `dry: true` measures and writes
 * nothing, `dry: false` writes. The worker computes the price either way, so the
 * reply to the write carries the same numbers the dialog showed. Undo is the same
 * request with `voice` set back to `previous`.
 *
 * `voice` must be a catalogue voice or null (inherit): an override exists to make
 * NEW clips, and only a voice this project can speak with can make one.
 */
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
  /** The override the row carried before — what undo writes back. */
  readonly previous: string | null;
  readonly price: VoicePrice;
  readonly lines: readonly string[];
  readonly describe: string;
}

/**
 * What a proposed field change would cost, before it is made.
 *
 * NOT a `TemplateOp`: it writes nothing, and a read on the undoable channel puts
 * a no-op on the undo stack. `app/field-ops.ts` carries the reasoning.
 */
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
  /** The price as sentences, for the confirm dialog. */
  readonly lines: readonly string[];
  readonly ms: number;
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
/**
 * The daily dashboard — his answer to his own question, refined.
 *
 * He asked whether the "scientific dashboard" belongs on mobile, and proposed
 * simple-on-phone / full-on-laptop. **The split is right and the axis is not
 * device**: he reviews on the laptop too, and a laptop tab runs the same
 * sqlite-wasm in the same one worker, so it is the same 81 seconds there.
 *
 * It splits by what the numbers are FOR. `src/dashboard/glance.ts` is "how am I
 * doing" and is fast on both machines; `src/dashboard/metrics.ts` is "what does four
 * years of data say" and stays one button away, behind the cost it charges.
 *
 * This returns NUMBERS, not HTML. The full report is a complete document with its
 * own white stylesheet and has to be an iframe; the glance is a dozen figures and
 * belongs in the app's own palette, on the phone especially.
 */
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
  /** A complete document, zero JavaScript. */
  readonly html: string;
  readonly bytes: number;
  readonly elapsedMs: number;
}

/**
 * Stage 11 — sync, and it is TWO messages rather than one because the transport
 * lives in the page and the database lives in here.
 *
 *   syncExport   the worker reads its database and hands back a payload
 *   syncMerge    a peer's payload comes in and is merged by `src/sync`'s rules
 *
 * The worker never speaks HTTP. Which device it is talking to, and how they met,
 * is the page's business — see `app/sync-client.ts` and decision 33.
 */
export interface SyncExportRequest {
  readonly kind: "syncExport";
  readonly id: number;
}

/**
 * 今日の計画を組み直す。起動時の同期が他の端末の採点を取り込んだ後、最初の
 * カードを出す前にだけ送る。計画は `open` で一度組まれるので、その後のマージは
 * 既に答えたカードを計画に残したままにする — 端末を跨いで同じカードを二度聞かれ
 * る、2026-09-14 の重複そのもの。採点が一つでも済んだセッションには送らない
 * （組み直すと手元のカードの下で due が動く）。
 */
export interface ReplanRequest {
  readonly kind: "replan";
  readonly id: number;
}

export interface ReplannedMessage {
  readonly kind: "replan";
  readonly id: number;
  readonly planned: number;
}

/**
 * 今日の計画を一つのデッキ、または音の出ないカードだけに絞って組み直す — Zach,
 * 2026-10-16: 外で声を出せない時のために。`deckId: null` かつ `silent: false` で
 * 元の全体の計画に戻る。書き込みは無い。取り消しの山は新しい計画と共に空になる
 * （前の計画の採点は、前の計画の上でしか戻せない）。
 */
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

/** デッキの画面のボタンに出す数。組むだけで、今の計画は動かさない。 */
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
  /** A peer's payload, as it came off the wire. */
  readonly payload: unknown;
}

/**
 * Resolve the text for a card's EMPTY generator slots.
 *
 * The renderer leaves `ai` / `translate` / `dictionary` slots empty by contract —
 * their children are the PROMPT, not the output — and the page has no database to
 * look the output up in. Until 2026-09-12 nothing filled them and every example
 * sentence in the corpus was invisible; see `src/review/text.ts`.
 *
 * One message per CARD carries every slot rather than one message per slot: a
 * 単語 card has two or three, and a round trip each would be three round trips
 * per card at review speed.
 */
export interface GeneratedTextRequest {
  readonly kind: "generatedText";
  readonly id: number;
  /**
   * The card the slots are on, when there is one. Only a `furigana` slot the cache
   * cannot fill uses it — for the card's own `読み` (`app/reading-override.ts`).
   */
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
  /** Same order as the request's slots. Null where nothing is stored. */
  readonly texts: readonly (string | null)[];
}

/**
 * CACHE ONE GENERATION THE SERVER JUST MADE — Zach, 2026-09-14.
 *
 * The laptop's `/generate/` endpoint owns the API key and writes the result into
 * `build/hashigo.db` (see `vite.generate.ts` for why that write is the one that
 * matters). This is the SECOND write: the same text into this device's own OPFS,
 * so the card is still right the next time he opens it rather than only for as
 * long as this mount lives.
 *
 * It carries no card id and no field id. A generation is addressed by its
 * identity — kind, source text, voice, lang, options — and that is deliberately
 * all this says, because it is exactly what `resolveDescriptorText` will look it
 * up by. A cache keyed on anything the resolver does not consult is a cache that
 * misses.
 */
/**
 * FILE A CLIP THE LAPTOP JUST SYNTHESISED, into THIS device's own store.
 *
 * The sibling of `storeGeneration` and for the same reason — `vite.generate.ts`
 * has already written it into `build/hashigo.db`, the copy that survives a seed
 * rebuild; this is the device's copy so the card plays now.
 *
 * `audio` is base64 because a request crosses `postMessage` as structured clone
 * and arrives here having already been base64 over HTTP. Decoding once, in the
 * worker that owns both handles, keeps the bytes off the page entirely.
 *
 * The descriptor carries NO voice: `storeGeneratedSpeech` files everything under
 * `FILL_VOICE`, because the row has to say who actually spoke. See
 * `src/cards/audio.ts`.
 */
export interface StoreClipRequest {
  readonly kind: "storeClip";
  readonly id: number;
  readonly slot: {
    readonly text: string;
    readonly lang: string | null;
    /**
     * WHO ACTUALLY SPOKE, as the laptop reported it — not what the card asked for.
     *
     * Omitted means `FILL_VOICE`, which is what this used to assume for every
     * clip. That assumption was safe only while the endpoint could ONLY
     * synthesise; now that it can answer from a cached clip in the card's own
     * voice, filing those bytes as `ja-JP-Neural2-C` would stamp a provenance
     * they do not have — the exact lie `src/generate/speech.ts` refuses to write
     * for the opposite case, and the thing that would quietly corrupt its
     * 7,409-clip voice survey.
     *
     * It also resolves BETTER: filed under the asked voice, the device's first
     * lookup hits instead of falling through to the fill.
     */
    readonly voice?: string | null;
    readonly options: Readonly<Record<string, string>>;
  };
  /** base64 mp3. */
  readonly audio: string;
  /**
   * REDO (2026-09-26): the clip this one replaces, retired before the new one is
   * filed so the card stops finding it. See `src/blobs/retire.ts`.
   */
  readonly retire?: string;
}

/**
 * What a redo needs to know about one clip on one card: which stored clip the
 * card plays now, and how to read the card's word so Google does not misread it
 * again (`<sub>` in `src/accent/speech.ts`).
 */
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
  /** The clip the card plays now, or null when it has none on this device. */
  readonly hash: string | null;
  /** The voice that made it, for the confirm dialog. */
  readonly voice: string | null;
  readonly readings: readonly { readonly base: string; readonly alias: string }[];
}

/**
 * What this card still needs generated — `cardGaps` in `src/review/gaps.ts`.
 * Asked by the page's auto-fill (`autoFill` in `main.ts`), only ever for a card
 * created HERE: the 785 clips Mochi never made are his to fill, not a screen's.
 */
export interface CardGapsRequest {
  readonly kind: "cardGaps";
  readonly id: number;
  readonly cardId: string;
}

export interface CardGapsMessage {
  readonly kind: "cardGaps";
  readonly id: number;
  /** `cards.local` — made in this app (or a duplicate of one), not imported from Mochi. */
  readonly local: boolean;
  readonly gaps: readonly {
    readonly kind: string;
    readonly text: string;
    readonly lang: string | null;
    readonly voice: string | null;
    readonly options: Readonly<Record<string, string>>;
  }[];
}

export interface StoreGenerationRequest {
  readonly kind: "storeGeneration";
  readonly id: number;
  /**
   * The card the fill was made FROM, so its search text can be refreshed at once.
   * Optional because a generation is keyed by its text and could in principle be
   * filled with no card in view; the review screen always has one.
   */
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
  /** The content address it landed at. Null when the worker declined to store it. */
  readonly hash: string | null;
  /** A redo that came back byte-for-byte the clip it was meant to replace. */
  readonly same?: boolean;
}

export interface StoreGenerationMessage {
  readonly kind: "storeGeneration";
  readonly id: number;
  /** The content address it landed at. Null when the worker declined to store it. */
  readonly hash: string | null;
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
   * Audio coverage on THIS device. `app-bootstrap` ships a bounded subset (200 MiB
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
  | CardGapsRequest
  | DecksRequest
  | BrowseRequest
  | CreateCardRequest
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

// ─── worker → page ───────────────────────────────────────────────────────────

export type LogLevel = "info" | "step" | "good" | "bad";

/** Progress narration. Not a reply to anything, so it carries no `id`. */
export interface LogMessage {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string;
}

/**
 * Bytes arriving during the first-run download. Not a reply, so no `id`.
 *
 * WHY THIS EXISTS. The seed is ~300 MB (73 MB of cards, 224 MB of audio) and the
 * page showed one line — `fetching /hashigo-app.db` — for as long as it took.
 * Zach, on 5G on 2026-09-08: *"frozen on this page for like 5 mins"*. It was not
 * frozen; it was working, silently, which is indistinguishable from hung. A
 * download with no progress is a download the user kills.
 *
 * `total` is null when the server sends no `Content-Length` — then the page shows
 * bytes-so-far and an indeterminate bar rather than inventing a percentage.
 */
export interface FetchingMessage {
  readonly kind: "fetching";
  /** The URL being read, for the label. */
  readonly url: string;
  /** 1-based, so the page can say "file 2 of 2" without knowing the plan. */
  readonly index: number;
  readonly of: number;
  readonly received: number;
  readonly total: number | null;
  /** True on the last message for this file, so the page can tick it off. */
  readonly done: boolean;
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
   * WHOLE DAYS LATE, the scheduler's own figure — `QueuedTrack.overdueDays`,
   * counted in local dates. 0 when the track was due today, and 0 on a new one.
   *
   * Zach, 2026-09-17: *"it would be helpful to see that this track was due 5
   * days ago"*. Passed through rather than derived on the page, because
   * `Date.now() - due` is a different quantity: a card due at 23:00 yesterday is
   * one day late and fourteen hours old. See `./overdue.ts`.
   *
   * Fixed when the session was PLANNED, which is the boot. A session running
   * past midnight shows yesterday's count for the rest of its life — worth
   * knowing, not worth a clock on the page.
   */
  readonly overdueDays: number;
  /** `due_at` as the scheduler issued it, RFC 3339 with his offset. For the title. */
  readonly dueAt: string | null;
  /**
   * WHEN HE LAST SAW THIS TRACK — `card_tracks.last_reviewed_at`, or null on a
   * new one.
   *
   * Zach, 2026-09-23: *"it would be great if we can see when we reviewed this
   * track last time, so we can see like oh wow it's been 8 months since i last
   * reviewed this track, but i think just a plain date would be better"*.
   *
   * **A DATE, NEVER A TIME, and that is measured rather than stylistic.** All
   * 103,110 imported reviews carry `time_unknown = 1` and the corpus holds
   * exactly ONE distinct time-of-day; Mochi truncated to the date and the
   * importer writes local midnight. Rendering "3:42pm" would be inventing a
   * fact. See `./last-seen.ts`, which is the only place that formats it.
   *
   * It is a DIFFERENT quantity from `overdueDays` and both are worth showing: a
   * track on a one-year interval that came due three days ago is `due 3 days ago`
   * and was last seen a year back.
   */
  readonly lastReviewedAt: string | null;
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
  /**
   * Set when NOTHING was graded because the target could not be. Null on every
   * successful grade. It is reported rather than thrown because every refusal
   * here is a thing he did, not a fault — and a silent no-op is what made the
   * look-ahead read as a frozen app in the first place.
   */
  readonly refused: AnswerRefusal | null;
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

export interface SyncExportMessage {
  readonly kind: "syncExport";
  readonly id: number;
  /** The payload, already JSON text — the page only has to POST it. */
  readonly json: string;
  readonly bytes: number;
  /** この書き出しに入っている最大の reviews.id（`src/sync/delta.ts` の印）。 */
  readonly mark: number;
}

/** 印より後の採点だけを書き出す。`src/sync/delta.ts`。 */
export interface SyncDeltaRequest {
  readonly kind: "syncDelta";
  readonly id: number;
  readonly after: number;
}

export interface SyncDeltaMessage {
  readonly kind: "syncDelta";
  readonly id: number;
  readonly json: string;
  readonly bytes: number;
  /** この差分の最大の reviews.id。空なら `after` のまま。 */
  readonly mark: number;
  readonly count: number;
}

export interface SyncMergeMessage {
  readonly kind: "syncMerge";
  readonly id: number;
  /** Local grades this merge brought in from the peer. The number he cares about. */
  readonly reviewsAdded: number;
  /** Cards whose archived/pinned the peer won, by clock. */
  readonly flagsTaken: number;
  /** Tracks whose schedule the peer won, by last review. */
  readonly trackStateTaken: number;
  /** Rows the peer had for cards this device does not hold. */
  readonly orphaned: number;
  /**
   * マージ前後の最大 reviews.id。前が送った印と同じなら、入ってきた分は送り残し
   * ではない（持ち主の端末にある）ので、印を後ろへ運んでよい。
   */
  readonly markBefore: number;
  readonly markAfter: number;
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
  | BacklinksMessage
  | StoreGenerationMessage
  | StoreClipMessage
  | RedoInfoMessage
  | CardGapsMessage
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

/** The reply kind each request expects. Keeps the page's typing honest. */
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
  readonly cardGaps: CardGapsMessage;
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
  readonly cardOp: CardOpMessage;
  readonly deckOp: DeckOpMessage;
  readonly ungrade: UngradedMessage;
}
