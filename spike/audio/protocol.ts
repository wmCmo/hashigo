/**
 * THROWAWAY (spike harness). Messages between the page and the blob worker.
 *
 * The split is the production one: the worker owns both SQLite databases (OPFS
 * demands a dedicated worker) and the page owns the DOM and the audio elements.
 * Payload bytes cross once, as a transferred ArrayBuffer, and the object URL is
 * minted on the side that consumes it — which is a rule this spike measures
 * rather than assumes (`workerUrl` below exists to test the other way round).
 */

export interface OpenRequest {
  readonly kind: "open";
  readonly id: number;
  /** Re-import both databases into OPFS even if they are already there. */
  readonly reimport: boolean;
}

/** Mint an object URL INSIDE the worker and hand back the string. */
export interface WorkerUrlRequest {
  readonly kind: "workerUrl";
  readonly id: number;
  readonly hash: string;
}

export type AudioSpikeRequest = OpenRequest | WorkerUrlRequest;

export type LogLevel = "info" | "step" | "good" | "bad";

export interface LogMessage {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string;
}

/** One clip: the `blobs` row, the payload, and what Mochi claimed it was. */
export interface ClipPayload {
  readonly hash: string;
  readonly blobKind: string;
  /** `blobs.mime` — sniffed from the bytes at import. */
  readonly mime: string;
  readonly byteSize: number;
  readonly sourceText: string | null;
  readonly voice: string | null;
  readonly lang: string | null;
  /** THROWAWAY: what the Mochi export declared. Not a production column. */
  readonly declaredType: string;
  readonly fileName: string;
  readonly deck: string;
  readonly note: string;
  /** The payload, read through the blob store, transferred not copied. */
  readonly bytes: Uint8Array;
  /** How long `readBlob()` took out of the OPFS-backed store. */
  readonly readMs: number;
  /** Re-hashed in the worker with src/blobs/sha256.ts: does it match `hash`? */
  readonly addressOk: boolean;
}

export interface OpenedMessage {
  readonly kind: "opened";
  readonly id: number;
  readonly facts: readonly [string, string][];
  readonly clips: readonly ClipPayload[];
}

export interface WorkerUrlMessage {
  readonly kind: "workerUrl";
  readonly id: number;
  readonly url: string | null;
  readonly error?: string;
}

export interface FailMessage {
  readonly kind: "fail";
  readonly id: number;
  readonly error: string;
}

export type AudioSpikeMessage = LogMessage | OpenedMessage | WorkerUrlMessage | FailMessage;
