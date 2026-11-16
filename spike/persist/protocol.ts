export interface StorageVerdict {
  readonly persistedBefore: boolean;
  readonly granted: boolean;
  readonly persistedAfter: boolean;
  readonly usage: number;
  readonly quota: number;
  readonly error?: string;
}

export interface OpenRequest {
  readonly kind: "open";
  readonly id: number;
  readonly reimport: boolean;
  readonly verdict: StorageVerdict;
}

export interface FillRequest {
  readonly kind: "fill";
  readonly id: number;
  readonly limitBytes: number;
}

export interface HoldRequest {
  readonly kind: "hold";
  readonly id: number;
  readonly hold: boolean;
}

export interface PauseRequest {
  readonly kind: "pause";
  readonly id: number;
  readonly paused: boolean;
}

export interface EvictRequest {
  readonly kind: "evict";
  readonly id: number;
}

export interface RecoverRequest {
  readonly kind: "recover";
  readonly id: number;
}

export interface ProbeRequest {
  readonly kind: "probe";
  readonly id: number;
}

export interface WriteRequest {
  readonly kind: "write";
  readonly id: number;
}

export interface HandlesRequest {
  readonly kind: "handles";
  readonly id: number;
}

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

export function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function gib(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
