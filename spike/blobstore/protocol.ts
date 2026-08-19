/**
 * THROWAWAY (spike harness). Messages between the page and the worker.
 *
 * Same split as `spike/protocol.ts`: the main thread owns the DOM and
 * `navigator.storage.persist()`, the worker owns every database handle and is the
 * only place a `sqlite3` object or a `BlobStore` exists.
 */

export interface RunRequest {
  readonly kind: "run";
  readonly id: number;
  /** Wipe `/blobs.db` and write the whole corpus again. */
  readonly fresh: boolean;
  /** Whether the page believes storage is persistent. Main-thread-only fact. */
  readonly persisted: boolean;
  /** Where the corpus pack is, as the page resolved it. */
  readonly packUrl: string;
  /** Where the prebuilt card database is, for the audit half. */
  readonly bootstrapUrl: string;
  /** Attempt `VACUUM` on the ~660 MB OPFS file. Slow, and may fail loudly. */
  readonly vacuum: boolean;
}

export type SpikeRequest = RunRequest;

export type LogLevel = "info" | "step" | "good" | "bad";

export interface LogMessage {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string;
}

export interface DoneMessage {
  readonly kind: "done";
  readonly id: number;
  readonly ok: boolean;
  readonly summary: Record<string, string | number> | null;
  readonly error?: string;
}

export type SpikeMessage = LogMessage | DoneMessage;
