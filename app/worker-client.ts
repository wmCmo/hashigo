/**
 * THE WORKER, AS A PROMISE-RETURNING CLIENT.
 *
 * Moved out of `main.ts` on 2026-09-25, when that file had reached 7,386 lines and
 * every feature in the app reached into it. Everything that talks to the database
 * goes through `ask`, which makes this the one import every extracted feature
 * module needs — so it had to come out first.
 *
 * ─── TWO MESSAGES ARE NOT REPLIES ───────────────────────────────────────────
 *
 * `log` and `fetching` arrive unasked — the boot log and the seed-download
 * readout (decision 45). They used to call straight into `main.ts`'s `line` and
 * `showFetchProgress`, which is a dependency pointing the wrong way for a module
 * everything imports. So the page SUBSCRIBES instead.
 *
 * AND THEY ARE BUFFERED until it does. The worker is created when this module is
 * first imported and starts logging at once; a `log` that arrived before `main.ts`
 * had registered its handler would otherwise vanish, and the boot log is what he
 * diagnosed three faults with in one week. Nothing is dropped: the buffer is
 * replayed in order the moment a handler is set.
 */

import type { AppMessage, AppRequest, ReplyFor } from "./protocol.js";

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

/**
 * Subscribe the page to the worker's unasked messages, and replay anything that
 * arrived first. Called once, at the top of `main.ts`.
 */
export function listenToWorker(handlers: {
  readonly log: (message: LogMessage) => void;
  readonly fetching: (message: FetchingMessage) => void;
}): void {
  onLog = handlers.log;
  onFetching = handlers.fetching;
  for (const message of early.splice(0)) deliver(message);
}

export function ask<K extends keyof ReplyFor>(
  request: Omit<Extract<AppRequest, { kind: K }>, "id">,
): Promise<ReplyFor[K]> {
  const id = nextId++;
  return new Promise<ReplyFor[K]>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (value: never) => void,
      reject,
    });
    worker.postMessage({ ...request, id } as AppRequest);
  });
}
