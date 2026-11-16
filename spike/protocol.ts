export interface RunRequest {
  readonly kind: "run";
  readonly id: number;
  readonly reimport: boolean;
  readonly schemaVersionFromNode: number;
  readonly persisted: boolean;
}

export interface QueryRequest {
  readonly kind: "query";
  readonly id: number;
  readonly sql: string;
}

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
