/**
 * THROWAWAY (spike harness) — but the shape here is the shape the PWA shell
 * needs, so it is written as if it mattered.
 *
 * The main thread owns the DOM and owns `navigator.storage.persist()`. The worker
 * owns the database and is the ONLY place a `sqlite3` object exists. Nothing
 * crosses that line except structured-cloneable messages.
 */

export interface RunRequest {
  readonly kind: "run";
  readonly id: number;
  /** Re-import the prebuilt database even if OPFS already holds one. */
  readonly reimport: boolean;
  /** `SCHEMA_VERSION` as vite.config.ts read it out of src/schema/index.ts. */
  readonly schemaVersionFromNode: number;
  /** Whether the page believes storage is persistent. Main-thread-only fact. */
  readonly persisted: boolean;
}

export interface QueryRequest {
  readonly kind: "query";
  readonly id: number;
  readonly sql: string;
}

/** Open databases in the pool until it refuses, to see how it refuses. */
export interface ExhaustRequest {
  readonly kind: "exhaust";
  readonly id: number;
}

export type SpikeRequest = RunRequest | QueryRequest | ExhaustRequest;

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
  readonly oracle: Record<string, string | number> | null;
  readonly error?: string;
}

export interface RowsMessage {
  readonly kind: "rows";
  readonly id: number;
  readonly rows: readonly unknown[];
  readonly error?: string;
}

export type SpikeMessage = LogMessage | DoneMessage | RowsMessage;
