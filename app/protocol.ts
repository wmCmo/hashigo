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

/** The card the session is on, prepared for rendering. */
export interface NextRequest {
  readonly kind: "next";
  readonly id: number;
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

/** Decision 17's archive, as JSON text, for the page to hand to a download. */
export interface BackupRequest {
  readonly kind: "backup";
  readonly id: number;
}

export type AppRequest =
  | OpenRequest
  | NextRequest
  | PayloadRequest
  | AnswerRequest
  | ReadingRequest
  | BackupRequest;

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
  | LogMessage
  | OpenedMessage
  | CardMessage
  | PayloadMessage
  | AnsweredMessage
  | ReadingMessage
  | BackupMessage
  | ErrorMessage;

/** The reply kind each request expects. Keeps the page's typing honest. */
export interface ReplyFor {
  readonly open: OpenedMessage;
  readonly next: CardMessage;
  readonly payload: PayloadMessage;
  readonly answer: AnsweredMessage;
  readonly reading: ReadingMessage;
  readonly backup: BackupMessage;
}
