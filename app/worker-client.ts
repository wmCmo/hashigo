import type { AppMessage, AppRequest, ReplyFor } from "./protocol.js";
import { markEdited } from "./sync-client.js";

type LogMessage = Extract<AppMessage, { kind: "log" }>;
type FetchingMessage = Extract<AppMessage, { kind: "fetching" }>;

const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });

let nextId = 1;
const pending = new Map<
  number,
  { resolve: (value: never) => void; reject: (reason: Error) => void }
>();

let onLog: ((message: LogMessage) => void) | null = null;
let onFetching: ((message: FetchingMessage) => void) | null = null;
const early: (LogMessage | FetchingMessage)[] = [];

worker.onmessage = (event: MessageEvent<AppMessage>): void => {
  const message = event.data;
  if (message.kind === "log" || message.kind === "fetching") {
    deliver(message);
    return;
  }
  const waiting = pending.get(message.id);
  if (waiting === undefined) return;
  pending.delete(message.id);
  if (message.kind === "error") {
    waiting.reject(Object.assign(new Error(message.message), { stack: message.stack ?? undefined }));
    return;
  }
  (waiting.resolve as (value: AppMessage) => void)(message);
};

function deliver(message: LogMessage | FetchingMessage): void {
  const handler = message.kind === "log" ? onLog : onFetching;
  if (handler === null) {
    early.push(message);
    return;
  }
  (handler as (m: typeof message) => void)(message);
}

export function listenToWorker(handlers: {
  readonly log: (message: LogMessage) => void;
  readonly fetching: (message: FetchingMessage) => void;
}): void {
  onLog = handlers.log;
  onFetching = handlers.fetching;
  for (const message of early.splice(0)) deliver(message);
}

const READ_ONLY_OR_DELTA: ReadonlySet<string> = new Set([
  "open",
  "next",
  "payload",
  "generatedText",
  "fieldOutputs",
  "storeGeneration",
  "storeClip",
  "answer",
  "backup",
  "syncExport",
  "syncDelta",
  "syncMerge",
  "replan",
  "focus",
  "focusCounts",
  "preview",
  "backlinks",
  "redoInfo",
  "pronunciation",
  "cardGaps",
  "accentPlan",
  "decks",
  "browse",
  "template",
  "priceField",
  "glance",
  "dashboard",
  "settings",
]);

export function ask<K extends keyof ReplyFor>(
  request: Omit<Extract<AppRequest, { kind: K }>, "id">,
): Promise<ReplyFor[K]> {
  const id = nextId++;
  if (!READ_ONLY_OR_DELTA.has(request.kind)) markEdited();
  return new Promise<ReplyFor[K]>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (value: never) => void,
      reject,
    });
    worker.postMessage({ ...request, id } as AppRequest);
  });
}
