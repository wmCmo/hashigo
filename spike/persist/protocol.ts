/**
 * THROWAWAY (spike harness) — `spike/persist/`.
 *
 * The message shapes between the page and the persistence worker. The split is
 * the whole point of this spike: `navigator.storage.persist()` exists ONLY on
 * the main thread, and every SQLite handle exists ONLY in the worker. Neither
 * side can do the other's job, so the persistence verdict has to travel.
 */

/** What the page learned about persistence, on its way into the worker. */
export interface StorageVerdict {
  /** `navigator.storage.persisted()` before we asked. */
  readonly persistedBefore: boolean;
  /** What `navigator.storage.persist()` returned. */
  readonly granted: boolean;
  /** `navigator.storage.persisted()` after we asked. THE one that matters. */
  readonly persistedAfter: boolean;
  /** `navigator.storage.estimate()`, main thread. Bytes. */
  readonly usage: number;
  readonly quota: number;
  /** Set when any of the above threw. */
  readonly error?: string;
}

export interface OpenRequest {
  readonly kind: "open";
  readonly id: number;
  /** Re-import the bootstrap database even if OPFS already has one. */
  readonly reimport: boolean;
  /** The main thread's persistence verdict. The worker cannot obtain this. */
  readonly verdict: StorageVerdict;
}

/** Write ~700 MB of blobs, at the real corpus's size distribution. */
export interface FillRequest {
  readonly kind: "fill";
  readonly id: number;
  /** Stop after this many bytes. 0 = the whole 624.6 MiB distribution. */
  readonly limitBytes: number;
}

/** Hold the database open (and the pool's handles) until told to let go. */
export interface HoldRequest {
  readonly kind: "hold";
  readonly id: number;
  readonly hold: boolean;
}

/** `pauseVfs()` / `unpauseVfs()` — the documented multi-tab handover. */
export interface PauseRequest {
  readonly kind: "pause";
  readonly id: number;
  readonly paused: boolean;
}

/** Delete everything in OPFS: what an eviction does, on purpose. */
export interface EvictRequest {
  readonly kind: "evict";
  readonly id: number;
}

/** Recover from nothing: fetch, import, reopen, re-verify. Timed. */
export interface RecoverRequest {
  readonly kind: "recover";
  readonly id: number;
}

/** Ask the worker what it can see about storage. It cannot see much. */
export interface ProbeRequest {
  readonly kind: "probe";
  readonly id: number;
}

/**
 * One tiny write to the card database — the shape of "Zach graded a card".
 * The interesting case is running this while the origin is out of quota, since
 * that is how a bulk-fill failure turns into a lost review.
 */
export interface WriteRequest {
  readonly kind: "write";
  readonly id: number;
}

/**
 * Three-way test of whether `close()` actually releases the OPFS file. The
 * answer decides whether multi-tab handover is reachable at all.
 */
export interface HandlesRequest {
  readonly kind: "handles";
  readonly id: number;
}

/**
 * Retry the pool install the way `installPool()` cannot: with upstream's
 * `forceReinitIfPreviouslyFailed`. Settles whether a tab that once lost the
 * race is permanently poisoned or merely needs to ask again.
 */
export interface RetryRequest {
  readonly kind: "retry";
  readonly id: number;
}

export type PersistRequest =
  | OpenRequest
  | FillRequest
  | HoldRequest
  | PauseRequest
  | EvictRequest
  | RecoverRequest
  | ProbeRequest
  | WriteRequest
  | HandlesRequest
  | RetryRequest;

export type LogLevel = "info" | "step" | "good" | "bad" | "warn";

export interface LogMessage {
  readonly kind: "log";
  readonly level: LogLevel;
  readonly text: string;
}

/** Numbers the page shows in its big-text panel, so a phone can read them. */
export interface StatMessage {
  readonly kind: "stat";
  readonly key: string;
  readonly value: string;
  readonly level?: LogLevel;
}

export interface DoneMessage {
  readonly kind: "done";
  readonly id: number;
  readonly ok: boolean;
  readonly error?: string;
}

export type PersistMessage = LogMessage | StatMessage | DoneMessage;

/** Bytes → MiB, one decimal. Used on both sides, so it lives here. */
export function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Bytes → GiB, two decimals. */
export function gib(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
