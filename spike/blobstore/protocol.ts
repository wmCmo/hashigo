export interface RunRequest {
  readonly kind: "run";
  readonly id: number;
  readonly fresh: boolean;
  readonly persisted: boolean;
  readonly packUrl: string;
  readonly bootstrapUrl: string;
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
