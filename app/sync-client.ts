import { hashText } from "../src/sync/sent.js";
import { cloudHeaders, cloudUrl, IN_CLOUD } from "./cloud.js";

export const MAILBOX_IN_CLOUD = IN_CLOUD;
const mailboxUrl = cloudUrl;
const mailboxHeaders = cloudHeaders;

const DEVICE_KEY = "hashigo.sync.deviceId";
const LAST_KEY = "hashigo.sync.lastSyncedAt";

export type SyncState = "never" | "syncing" | "ok" | "failed" | "offline" | "behind";

export interface SyncStatus {
  readonly state: SyncState;
  readonly lastSyncedAt: string | null;
  readonly detail: string | null;
  readonly peers: number;
}

export interface SyncOutcome {
  readonly reviewsAdded: number;
  readonly flagsTaken: number;
  readonly trackStateTaken: number;
  readonly peersMerged: number;
  readonly pushedBytes: number;
  readonly failures: readonly string[];
}

export interface PeerRow {
  readonly deviceId: string;
  readonly bytes: number;
  readonly updatedAt: string;
  readonly sha?: string;
  readonly noPayload?: true;
  readonly delta?: { readonly bytes: number; readonly updatedAt: string; readonly sha?: string };
}

const MERGED_KEY = "hashigo.sync.merged";

function readMerged(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MERGED_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeMerged(merged: Record<string, string>): void {
  try {
    localStorage.setItem(MERGED_KEY, JSON.stringify(merged));
  } catch {
  }
}

const MERGED_DELTA_KEY = "hashigo.sync.mergedDelta";

function readMergedDelta(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MERGED_DELTA_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeMergedDelta(merged: Record<string, string>): void {
  try {
    localStorage.setItem(MERGED_DELTA_KEY, JSON.stringify(merged));
  } catch {
  }
}

const MERGED_ENTRIES_KEY = "hashigo.sync.mergedEntries";

function readMergedEntries(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MERGED_ENTRIES_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function writeMergedEntries(merged: Record<string, string[]>): void {
  try {
    localStorage.setItem(MERGED_ENTRIES_KEY, JSON.stringify(merged));
  } catch {
  }
}

const MARK_KEY = "hashigo.sync.mark";

export function readMark(): number | null {
  try {
    const held = localStorage.getItem(MARK_KEY);
    const value = held === null ? NaN : Number(held);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeMark(mark: number): void {
  try {
    localStorage.setItem(MARK_KEY, String(mark));
  } catch {
  }
}

const DIRTY_KEY = "hashigo.sync.fullDirty";

export function markEdited(): void {
  try {
    localStorage.setItem(DIRTY_KEY, String(Date.now()));
  } catch {
  }
  onDirty?.();
}

const SENT_KEY = "hashigo.sync.sent";

function readSent(): string | null {
  try {
    const held = localStorage.getItem(SENT_KEY);
    return held === null || held === "" ? null : held;
  } catch {
    return null;
  }
}

function writeSent(index: string | undefined): void {
  try {
    if (index === undefined) localStorage.removeItem(SENT_KEY);
    else localStorage.setItem(SENT_KEY, index);
  } catch {
    try {
      localStorage.removeItem(SENT_KEY);
    } catch {
    }
  }
}

let onDirty: (() => void) | null = null;

export function whenEdited(listener: () => void): void {
  onDirty = listener;
}

function readDirty(): string | null {
  try {
    return localStorage.getItem(DIRTY_KEY);
  } catch {
    return null;
  }
}

function clearDirty(seen: string | null): void {
  try {
    if (seen !== null && localStorage.getItem(DIRTY_KEY) === seen) localStorage.removeItem(DIRTY_KEY);
  } catch {
  }
}

export function forgetMergedPeers(): void {
  try {
    localStorage.removeItem(MERGED_KEY);
    localStorage.removeItem(MERGED_DELTA_KEY);
    localStorage.removeItem(MERGED_ENTRIES_KEY);
    localStorage.removeItem(MARK_KEY);
    localStorage.removeItem(SENT_KEY);
  } catch {
  }
}

async function uploadBody(json: string): Promise<{ body: BodyInit; headers: Record<string, string> }> {
  if (!MAILBOX_IN_CLOUD || typeof CompressionStream === "undefined") {
    return { body: json, headers: { "Content-Type": "application/json" } };
  }
  const gzipped = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  return {
    body: await new Response(gzipped).blob(),
    headers: { "Content-Type": "application/json", "X-Payload-Encoding": "gzip" },
  };
}

function newDeviceId(): string {
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `dev-${random}`;
}

export function deviceId(): string {
  try {
    const held = localStorage.getItem(DEVICE_KEY);
    if (held !== null && held !== "") return held;
    const made = newDeviceId();
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    return newDeviceId();
  }
}

function readLastSynced(): string | null {
  try {
    const held = localStorage.getItem(LAST_KEY);
    return held === null || held === "" ? null : held;
  } catch {
    return null;
  }
}

function writeLastSynced(at: string): void {
  try {
    localStorage.setItem(LAST_KEY, at);
  } catch {
  }
}

export function initialStatus(): SyncStatus {
  const last = readLastSynced();
  return {
    state: last === null ? "never" : "ok",
    lastSyncedAt: last,
    detail: null,
    peers: 0,
  };
}

async function reach(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(mailboxUrl(path), {
      ...init,
      headers: mailboxHeaders((init.headers as Record<string, string> | undefined) ?? {}),
    });
  } catch (cause) {
    if (cause instanceof TypeError) {
      throw new Error(
        MAILBOX_IN_CLOUD
          ? `could not reach the sync mailbox on Cloudflare. This device may be ` +
            `offline; sync again once it has internet.`
          : `could not reach the laptop. This device may be off the tailnet; ` +
            `open Tailscale, reconnect, then sync again.`,
      );
    }
    throw cause;
  }
}

async function mailboxJson(url: string): Promise<unknown> {
  return (await mailboxPayload(url)).payload;
}

async function mailboxPayload(
  url: string,
  options: { signal?: AbortSignal; onBytes?: (received: number) => void } = {},
): Promise<{ payload: unknown; sha: string | null }> {
  const response = await reach(url, {
    cache: "no-store",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (response.status === 401) {
    throw new Error(`the mailbox refused this device's key (401) — rebuild with the key in .env`);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const sha = response.headers.get("X-Payload-Sha");
  const body = await readText(response, options.onBytes);
  try {
    return { payload: JSON.parse(body) as unknown, sha };
  } catch {
    const looksLikePage = /^\s*<!doctype|^\s*<html/i.test(body);
    throw new Error(
      looksLikePage
        ? `${url} answered with a PAGE, not JSON — this server has no sync ` +
          `mailbox. A stale preview server holding the port does this: stop it ` +
          `and run npm run phone again.`
        : `${url} answered with something that is not JSON: ` +
          `"${body.slice(0, 40).replace(/\s+/g, " ")}…"`,
    );
  }
}

async function readText(response: Response, onBytes?: (received: number) => void): Promise<string> {
  if (onBytes === undefined || response.body == null) return await response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    onBytes(received);
  }
  return text + decoder.decode();
}

export type SyncStage = "checking" | "downloading" | "merging" | "sending";

export interface SyncProgress {
  readonly stage: SyncStage;
  readonly peer: number;
  readonly peers: number;
  readonly received: number;
  readonly total: number;
  readonly etaSeconds: number | null;
}

export interface SyncOptions {
  readonly onProgress?: (progress: SyncProgress) => void;
  readonly signal?: AbortSignal;
}

export interface SyncTiming {
  readonly mergeMsPerByte: number | null;
  readonly downBytesPerMs: number | null;
  readonly sendMs: number | null;
}

const TIMING_KEY = "hashigo.sync.timing";
const NO_TIMING: SyncTiming = { mergeMsPerByte: null, downBytesPerMs: null, sendMs: null };

export function readTiming(): SyncTiming {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TIMING_KEY) ?? "null");
    if (parsed === null || typeof parsed !== "object") return NO_TIMING;
    const t = parsed as Record<string, unknown>;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    return {
      mergeMsPerByte: num(t["mergeMsPerByte"]),
      downBytesPerMs: num(t["downBytesPerMs"]),
      sendMs: num(t["sendMs"]),
    };
  } catch {
    return NO_TIMING;
  }
}

function writeTiming(timing: SyncTiming): void {
  try {
    localStorage.setItem(TIMING_KEY, JSON.stringify(timing));
  } catch {
  }
}

export function syncEta(
  timing: SyncTiming,
  left: { readonly downloadBytes: number; readonly mergeBytes: number; readonly send: boolean },
  liveDownBytesPerMs: number | null = null,
): number | null {
  const down = liveDownBytesPerMs ?? timing.downBytesPerMs;
  let ms = 0;
  if (left.downloadBytes > 0) {
    if (down === null) return null;
    ms += left.downloadBytes / down;
  }
  if (left.mergeBytes > 0) {
    if (timing.mergeMsPerByte === null) return null;
    ms += left.mergeBytes * timing.mergeMsPerByte;
  }
  if (left.send) {
    if (timing.sendMs === null) return null;
    ms += timing.sendMs;
  }
  return ms / 1000;
}

export async function listPeers(signal?: AbortSignal): Promise<PeerRow[]> {
  const response = await mailboxPayload("/sync/", signal === undefined ? {} : { signal });
  return (response.payload as { peers: PeerRow[] }).peers;
}

export function versionOf(peer: PeerRow): string {
  return peer.sha ?? `t:${peer.updatedAt}|${peer.bytes}`;
}

export function changedPeers(peers: readonly PeerRow[]): PeerRow[] {
  const self = deviceId();
  return peers.filter((peer) => peer.deviceId !== self && (baseChanged(peer) || deltaChanged(peer)));
}

function baseChanged(peer: PeerRow): boolean {
  return peer.noPayload !== true && readMerged()[peer.deviceId] !== versionOf(peer);
}

function carriesEdits(entry: unknown): boolean {
  const edits = (entry as { edits?: unknown } | null)?.edits;
  return (
    edits !== null &&
    typeof edits === "object" &&
    Object.values(edits as Record<string, unknown>).some((list) => Array.isArray(list) && list.length > 0)
  );
}

function deltaChanged(peer: PeerRow): boolean {
  if (peer.delta === undefined) return false;
  return peer.delta.sha === undefined || readMergedDelta()[peer.deviceId] !== peer.delta.sha;
}

export interface SyncPorts {
  exportPayload(): Promise<{ json: string; bytes: number; mark?: number; index?: string }>;
  exportDelta?(
    after: number,
    sent?: string,
  ): Promise<{ json: string; bytes: number; mark: number; count: number; edits?: number; index?: string }>;
  exportIndex?(): Promise<string>;
  mergePayload(payload: unknown): Promise<{
    reviewsAdded: number;
    flagsTaken: number;
    trackStateTaken: number;
    markBefore?: number;
    markAfter?: number;
  }>;
}

function carryMark(result: { markBefore?: number; markAfter?: number }): void {
  const mark = readMark();
  if (
    mark !== null &&
    result.markBefore !== undefined &&
    result.markAfter !== undefined &&
    mark === result.markBefore
  ) {
    writeMark(result.markAfter);
  }
}

export async function syncNow(
  ports: SyncPorts,
  options: SyncOptions & { readonly listing?: readonly PeerRow[]; readonly push?: boolean } = {},
): Promise<SyncOutcome> {
  const self = deviceId();
  const { onProgress, signal } = options;
  const timing = readTiming();

  const peers = options.listing ?? (await listPeers(signal));
  const todo = changedPeers(peers).map((peer) => {
    const base = baseChanged(peer);
    const delta = deltaChanged(peer);
    return {
      peer,
      base,
      delta,
      bytes: (base ? peer.bytes : 0) + (delta ? (peer.delta?.bytes ?? 0) : 0),
    };
  });
  const total = todo.reduce((sum, item) => sum + item.bytes, 0);

  let reviewsAdded = 0;
  let flagsTaken = 0;
  let trackStateTaken = 0;
  let peersMerged = 0;

  let downloaded = 0;
  let mergedBytes = 0;
  let downMs = 0;
  let mergeMs = 0;
  let liveRate: number | null = null;
  const report = (stage: SyncStage, peer: number): void => {
    if (onProgress === undefined) return;
    onProgress({
      stage,
      peer,
      peers: todo.length,
      received: downloaded,
      total,
      etaSeconds: syncEta(
        timing,
        {
          downloadBytes: total - downloaded,
          mergeBytes: total - mergedBytes,
          send: options.push !== false,
        },
        liveRate,
      ),
    });
  };
  report("checking", 0);

  const failures: string[] = [];
  const merged = readMerged();
  const mergedDelta = readMergedDelta();
  const mergedEntries = readMergedEntries();
  const save = (): void => {
    writeMerged(merged);
    writeMergedDelta(mergedDelta);
    writeMergedEntries(mergedEntries);
  };
  let mergedEdits = false;
  const take = (result: Awaited<ReturnType<SyncPorts["mergePayload"]>>): void => {
    carryMark(result);
    reviewsAdded += result.reviewsAdded;
    flagsTaken += result.flagsTaken;
    trackStateTaken += result.trackStateTaken;
  };
  for (const [index, item] of todo.entries()) {
    const { peer } = item;
    const before = downloaded;
    const download = async (
      path: string,
      size: number,
    ): Promise<{ payload: unknown; sha: string | null }> => {
      const start = downloaded;
      const downFrom = performance.now();
      report("downloading", index + 1);
      const got = await mailboxPayload(path, {
        ...(signal === undefined ? {} : { signal }),
        onBytes: (received) => {
          downloaded = start + received;
          const elapsed = downMs + (performance.now() - downFrom);
          if (elapsed > 300) liveRate = downloaded / elapsed;
          report("downloading", index + 1);
        },
      });
      downloaded = start + size;
      downMs += performance.now() - downFrom;
      signal?.throwIfAborted();
      return got;
    };
    const merge = async (payload: unknown, size: number): Promise<void> => {
      report("merging", index + 1);
      const mergeFrom = performance.now();
      take(await ports.mergePayload(payload));
      mergeMs += performance.now() - mergeFrom;
      mergedBytes += size;
    };
    try {
      if (item.base) {
        const { payload, sha } = await download(`/sync/${peer.deviceId}`, peer.bytes);
        await merge(payload, peer.bytes);
        mergedEdits = true;
        if (sha !== null) merged[peer.deviceId] = sha;
        else if (peer.sha === undefined) merged[peer.deviceId] = versionOf(peer);
      }
      if (item.delta) {
        const size = peer.delta?.bytes ?? 0;
        const { payload, sha } = await download(`/sync/${peer.deviceId}/delta`, size);
        const entries = Array.isArray(payload) ? payload : [];
        report("merging", index + 1);
        const mergeFrom = performance.now();
        const seen = new Set(mergedEntries[peer.deviceId] ?? []);
        const names: string[] = [];
        for (const entry of entries) {
          const name = hashText(JSON.stringify(entry));
          names.push(name);
          if (seen.has(name)) continue;
          take(await ports.mergePayload(entry));
          if (carriesEdits(entry)) mergedEdits = true;
        }
        mergeMs += performance.now() - mergeFrom;
        mergedBytes += size;
        if (sha !== null) mergedDelta[peer.deviceId] = sha;
        mergedEntries[peer.deviceId] = names;
      }
      peersMerged += 1;
    } catch (error) {
      if (signal?.aborted === true) {
        save();
        throw error;
      }
      downloaded = before + item.bytes;
      mergedBytes = Math.max(mergedBytes, downloaded);
      failures.push(
        `${peer.deviceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  save();

  if (
    mergedEdits &&
    ports.exportIndex !== undefined &&
    readDirty() === null &&
    readSent() !== null
  ) {
    const index = await ports.exportIndex();
    if (readDirty() === null) writeSent(index);
  }

  let sendMs = timing.sendMs;
  let pushedBytes = 0;
  if (options.push !== false) {
    report("sending", 0);
    const sendFrom = performance.now();
    pushedBytes = (await pushSmallest(ports, self, false)).bytes;
    sendMs = performance.now() - sendFrom;
  }

  writeTiming({
    mergeMsPerByte: mergedBytes > 0 && mergeMs > 0 ? mergeMs / mergedBytes : timing.mergeMsPerByte,
    downBytesPerMs: downloaded > 0 ? downloaded / Math.max(1, downMs) : timing.downBytesPerMs,
    sendMs,
  });

  writeLastSynced(new Date().toISOString());
  return {
    reviewsAdded,
    flagsTaken,
    trackStateTaken,
    peersMerged,
    pushedBytes,
    failures,
  };
}

export async function peersNewerThan(lastSyncedAt: string | null): Promise<number> {
  const self = deviceId();
  const { peers } = (await mailboxJson("/sync/")) as { peers: PeerRow[] };
  const since = lastSyncedAt === null ? null : new Date(lastSyncedAt).getTime();
  let newer = 0;
  for (const peer of peers) {
    if (peer.deviceId === self) continue;
    if (since === null || Number.isNaN(since)) {
      newer += 1;
      continue;
    }
    const at = new Date(peer.updatedAt).getTime();
    if (!Number.isNaN(at) && at > since) newer += 1;
  }
  return newer;
}

export function sinceLabel(at: string | null, now: Date = new Date()): string {
  const ago = agoLabel(at, now);
  return ago === null ? "never synced" : `synced ${ago}`;
}

export function agoLabel(at: string | null, now: Date = new Date()): string | null {
  if (at === null) return null;
  const ms = now.getTime() - new Date(at).getTime();
  if (Number.isNaN(ms)) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function isStale(status: SyncStatus, now: Date = new Date()): boolean {
  if (status.state === "failed" || status.state === "never" || status.state === "behind") {
    return true;
  }
  if (status.lastSyncedAt === null) return true;
  const ms = now.getTime() - new Date(status.lastSyncedAt).getTime();
  return Number.isNaN(ms) || ms > 24 * 60 * 60 * 1000;
}

export async function pushNow(ports: SyncPorts): Promise<number> {
  return putFull(ports, deviceId());
}

async function putFull(ports: SyncPorts, self: string): Promise<number> {
  const dirty = readDirty();
  const mine = await ports.exportPayload();
  const body = await uploadBody(mine.json);
  const put = await reach(`/sync/${self}`, {
    method: "PUT",
    body: body.body,
    headers: {
      ...body.headers,
      ...(mine.mark === undefined ? {} : { "X-Covers-Mark": String(mine.mark) }),
    },
  });
  if (!put.ok) throw new Error(`the mailbox refused this device's payload (${put.status})`);
  if (mine.mark !== undefined) writeMark(mine.mark);
  writeSent(mine.index);
  clearDirty(dirty);
  writeLastPushed(new Date().toISOString());
  return mine.bytes;
}

const KEEPALIVE_MAX_BYTES = 60 * 1024;

const DELTA_MAX_BYTES = 64 * 1024;

export type PushKind = "delta" | "full" | "nothing";

export async function pushGradesNow(
  ports: SyncPorts,
  options: { readonly keepalive?: boolean } = {},
): Promise<PushKind> {
  return (await pushSmallest(ports, deviceId(), options.keepalive === true)).kind;
}

async function pushSmallest(
  ports: SyncPorts,
  self: string,
  onHide: boolean,
): Promise<{ readonly kind: PushKind; readonly bytes: number }> {
  const mark = readMark();
  const dirtySeen = readDirty();
  const nothing = { kind: "nothing", bytes: 0 } as const;
  const sent = dirtySeen !== null && !onHide ? readSent() : null;
  const full = async (): Promise<{ readonly kind: PushKind; readonly bytes: number }> => {
    if (onHide) return nothing;
    return { kind: "full", bytes: await putFull(ports, self) };
  };
  if (ports.exportDelta === undefined || mark === null || (dirtySeen !== null && !onHide && sent === null)) {
    return await full();
  }
  const delta = await ports.exportDelta(mark, sent ?? undefined);
  if (sent !== null && delta.index === undefined) return await full();
  const edits = delta.edits ?? 0;
  if (delta.count === 0 && edits === 0) {
    if (sent !== null) {
      writeSent(delta.index);
      clearDirty(dirtySeen);
    }
    return nothing;
  }
  if (!onHide && delta.bytes > DELTA_MAX_BYTES) return await full();
  const keepalive = onHide && delta.bytes <= KEEPALIVE_MAX_BYTES;
  if (onHide && !keepalive) return nothing;
  const response = await reach(`/sync/${self}/delta`, {
    method: "POST",
    body: delta.json,
    headers: { "Content-Type": "application/json" },
    ...(keepalive ? { keepalive: true } : {}),
  });
  if (response.status === 404 || response.status === 405 || response.status === 413) {
    return await full();
  }
  if (!response.ok) throw new Error(`the mailbox refused this device's grades (${response.status})`);
  writeMark(delta.mark);
  if (sent !== null) {
    writeSent(delta.index);
    clearDirty(dirtySeen);
  }
  writeLastPushed(new Date().toISOString());
  return { kind: "delta", bytes: delta.bytes };
}

const PUSHED_KEY = "hashigo.sync.pushed";

function writeLastPushed(at: string): void {
  try {
    localStorage.setItem(PUSHED_KEY, at);
  } catch {
  }
}

export function lastPushedAt(): string | null {
  try {
    return localStorage.getItem(PUSHED_KEY);
  } catch {
    return null;
  }
}
