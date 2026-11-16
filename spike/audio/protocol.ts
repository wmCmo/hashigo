export interface OpenRequest {
  readonly kind: "open";
  readonly id: number;
  readonly reimport: boolean;
}

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

export interface ClipPayload {
  readonly hash: string;
  readonly blobKind: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly sourceText: string | null;
  readonly voice: string | null;
  readonly lang: string | null;
  readonly declaredType: string;
  readonly fileName: string;
  readonly deck: string;
  readonly note: string;
  readonly bytes: Uint8Array;
  readonly readMs: number;
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
