/**
 * Stage 11's transport, page side. Decision 33.
 *
 * ─── WHAT IT TALKS TO ───────────────────────────────────────────────────────
 *
 * A MAILBOX, not a peer. `vite.app.config.ts`'s `syncMailbox()` stores one JSON
 * file per device and has no opinion about any of them — it cannot have one,
 * because each device's database lives in its own browser's OPFS and that Node
 * process can read neither. Every merge happens here, in a browser, against that
 * browser's own database.
 *
 * The useful consequence: THE TWO DEVICES NEVER HAVE TO BE UP TOGETHER. The
 * phone drops its payload when it can reach the laptop; the laptop collects it
 * whenever it next runs. Decision 33 as first written said both had to be on the
 * tailnet at once — the mailbox makes that wrong, in the good direction.
 *
 * ─── THE DEVICE ID, AND WHY IT IS NOT A RANDOM PER-TAB VALUE ────────────────
 *
 * It lives in `localStorage` and is generated once. That matters: it is the name
 * of this device's slot in the mailbox, so a fresh id every load would fill the
 * mailbox with one file per visit and every device would merge its own stale
 * payload back into itself. It is stored beside the eviction receipt, in
 * `localStorage` rather than the database, for the same reason that receipt is —
 * a name kept inside the thing that can go missing tells you nothing afterwards.
 */

import { cloudHeaders, cloudUrl, IN_CLOUD } from "./cloud.js";

// Where the mailbox is — the laptop or Cloudflare — lives in `./cloud.ts`, shared
// with generation. `MAILBOX_IN_CLOUD` keeps its name for existing callers.
export const MAILBOX_IN_CLOUD = IN_CLOUD;
const mailboxUrl = cloudUrl;
const mailboxHeaders = cloudHeaders;

const DEVICE_KEY = "hashigo.sync.deviceId";
const LAST_KEY = "hashigo.sync.lastSyncedAt";

export type SyncState = "never" | "syncing" | "ok" | "failed" | "offline" | "behind";

export interface SyncStatus {
  readonly state: SyncState;
  /** RFC 3339, or null if this device has never completed a sync. */
  readonly lastSyncedAt: string | null;
  /** Set when `state` is "failed" — said out loud rather than swallowed. */
  readonly detail: string | null;
  /** Peers with a payload in the mailbox, this device excluded. */
  readonly peers: number;
}

export interface SyncOutcome {
  readonly reviewsAdded: number;
  readonly flagsTaken: number;
  readonly trackStateTaken: number;
  readonly peersMerged: number;
  readonly pushedBytes: number;
  /** Peers that could not be merged, with why. The sync still completed. */
  readonly failures: readonly string[];
}

export interface PeerRow {
  readonly deviceId: string;
  readonly bytes: number;
  readonly updatedAt: string;
  /** sha256 of the peer's stored payload; absent on payloads older than 2026-09-29. */
  readonly sha?: string;
  /** 全体が無く差分だけがある（全体を消された端末）。2026-10-10。 */
  readonly noPayload?: true;
  /** その端末が全体の後に積んだ差分。`src/sync/delta.ts`。 */
  readonly delta?: { readonly bytes: number; readonly updatedAt: string; readonly sha?: string };
}

/**
 * WHICH VERSION OF EACH PEER THIS DEVICE HAS ALREADY MERGED — 2026-09-29.
 *
 * Zach: *"everytime i hit the sync button, how much data does it consume?"* —
 * measured, ~4.2 MB: every press downloaded all eight other payloads (~2.3 MB
 * compressed) whether or not they had changed, and uploaded 1.9 MB uncompressed.
 *
 * So a peer is fetched only when the listing's `sha` differs from the one
 * recorded here — and the recorded one is the hash of the bytes this device
 * actually MERGED (the `X-Payload-Sha` of that download), never the listing's.
 * KV is eventually consistent for up to a minute; recording the listing's hash
 * could mark new data as merged while the download returned the old bytes. This
 * way either lag costs one extra download, never a missed one.
 *
 * `localStorage`, beside the device id — and FORGOTTEN whenever the database is
 * replaced (`forgetMergedPeers`, called from boot): a record that outlived the
 * data it describes would skip every peer for ever on a freshly seeded device.
 */
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
    /* storage off: every peer is fetched next time, which is only slower */
  }
}

/** 差分の側の「どれをマージしたか」。端末ごとに、差分の束の sha。 */
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
    /* 次回もう一度取るだけ */
  }
}

/**
 * 送った印 — この端末の採点のうち、mailbox に（全体か差分で）届いた最大の
 * reviews.id。`src/sync/delta.ts`。null は「まだ一度も全体を送っていない」で、
 * その時は差分ではなく全体を送る（差分は全体の上に積むものだから）。
 */
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
    /* 次は全体を送るだけ */
  }
}

/**
 * 採点以外の書き込みがあった — 次の送信は全体。`worker-client.ts` の `ask` が付ける。
 *
 * 値は時刻：送信の前に読んだ値と、送れた後の値が同じ時だけ消す。送っている間に
 * 次の編集が入ったら、その編集はまだ送っていない。
 */
const DIRTY_KEY = "hashigo.sync.fullDirty";

export function markFullDirty(): void {
  try {
    localStorage.setItem(DIRTY_KEY, String(Date.now()));
  } catch {
    /* 印が付けられないなら、次の送信が差分になるだけ — 手動同期は常に全体 */
  }
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
    /* 次も全体を送るだけ */
  }
}

/** The database was replaced or is new: nothing here has merged anything yet. */
export function forgetMergedPeers(): void {
  try {
    localStorage.removeItem(MERGED_KEY);
    localStorage.removeItem(MERGED_DELTA_KEY);
    // 印は端末内の行番号なので、データベースが替われば意味を失う。
    localStorage.removeItem(MARK_KEY);
  } catch {
    /* nothing to forget */
  }
}

/**
 * The upload, gzipped when the mailbox is the Worker (which decodes
 * `X-Payload-Encoding`). The laptop's dev mailbox gets it plain, as before.
 */
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

/** `^[a-z0-9][a-z0-9-]{5,63}$` — the mailbox validates this too. */
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
    // A private window with storage blocked. Sync degrades to "this session
    // only", which is honest — and better than throwing on a page load.
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
    /* see `deviceId` */
  }
}

/**
 * What the indicator shows before anything has been asked of the network.
 *
 * Deliberately does NOT call the mailbox: this runs on every page load and the
 * status must be readable offline. `peers` is 0 until a real sync has looked.
 */
export function initialStatus(): SyncStatus {
  const last = readLastSynced();
  return {
    state: last === null ? "never" : "ok",
    lastSyncedAt: last,
    detail: null,
    peers: 0,
  };
}

/**
 * `fetch`, with the ONE failure that is not about the mailbox named properly.
 *
 * Zach, on his phone, 2026-09-19:
 *
 *     sync failed — Failed to fetch
 *
 * That is the same class of defect as the `<!doctype` line above and it arrives
 * one layer earlier: `mailboxJson`'s careful diagnosis never runs, because
 * `fetch` itself rejects before there is any response to inspect. "Failed to
 * fetch" is the browser's words for "the request did not reach a server", and it
 * names neither the server nor anything he can do.
 *
 * **It was not the laptop, either time.** Checked while he was looking at it: the
 * `npm run phone` server answered `200` in 10 ms locally, `tailscale serve` was
 * mapping `node.tailed819e.ts.net` to it, and that name answered `200` in 478 ms.
 * `tailscale status` had the answer — his handset was `offline, last seen 2h ago`.
 * The tailnet is the transport decision 33 chose precisely because it is not the
 * open internet, and the cost it accepted is exactly this: **off the tailnet, no
 * sync.** That is the designed availability, so the message should state it
 * rather than leave him reading a browser string at 10pm.
 *
 * A `TypeError` is what every browser raises for a network-layer failure — DNS,
 * refused connection, no route, TLS. It is deliberately NOT narrowed further:
 * distinguishing them is not possible from here and would not change the action.
 */
async function reach(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(mailboxUrl(path), {
      ...init,
      headers: mailboxHeaders((init.headers as Record<string, string> | undefined) ?? {}),
    });
  } catch (cause) {
    if (cause instanceof TypeError) {
      // NO EM DASH: `paintSync` renders this as `sync failed — <detail>`, and a
      // second one in the detail makes the line read as three fragments.
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

/**
 * GET something from the mailbox and insist it is actually JSON.
 *
 * ─── THE ERROR THIS EXISTS TO REPLACE ───────────────────────────────────────
 *
 * Zach, on his phone, 2026-09-13:
 *
 *     sync failed — Unexpected token '<', "<!doctype "... is not valid JSON
 *
 * There is nothing he can do with that. It is `JSON.parse` describing the first
 * character of a page, and it says neither which request failed nor that the
 * answer was a PAGE — which is the entire diagnosis.
 *
 * **`response.ok` does not catch it and cannot.** A server with no `/sync/`
 * route does not 404: Vite's SPA fallback answers **200 with `index.html`**,
 * because a single-page app's unknown routes are supposed to be the app. So the
 * status check passes and the parser is the first thing to notice.
 *
 * **What produced it was a STALE SERVER.** `npm run phone` runs `vite preview`
 * on port 4274 and `tailscale serve` points there permanently. A preview process
 * left over from an older checkout keeps that port, keeps answering the phone,
 * and — because preview reads `build/app-dist` from disk — keeps serving the
 * NEWEST bundle out of a process whose middleware chain is old. New screen, old
 * server, and the only symptom is this one line. `scripts/phone.mjs` now refuses
 * to leave the tunnel pointed at a server it did not start; this is the other
 * half, for every other way a mailbox can be absent.
 */
async function mailboxJson(url: string): Promise<unknown> {
  return (await mailboxPayload(url)).payload;
}

/** `mailboxJson`, plus the `X-Payload-Sha` the mailbox sent with it (null if none). */
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
  // Read as TEXT and parse here rather than trusting `response.json()`, so the
  // failure can say what actually came back. Checking `content-type` instead
  // would be one more thing to be wrong about a server we do not control.
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

/**
 * 本文をストリームで読み、受け取ったバイト数を逐一知らせる。
 *
 * 数えるのは「展開後」のバイト。Worker は gzip（Content-Encoding）で送り、
 * ブラウザが展開してから body に流すので、ここで見えるのは展開後の長さ — そして
 * 一覧の `bytes` も展開後（保存されている JSON の長さ）なので、二つは同じ単位で
 * 割り算できる。Content-Length は圧縮後なので使わない（決定 6：単位を名乗る）。
 */
async function readText(response: Response, onBytes?: (received: number) => void): Promise<string> {
  // `== null`：body の無い Response（古いブラウザ、テストの偽物）は丸ごと読む。
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

// ─── 同期の進み具合と、あと何秒か — Zach, 2026-10-09 ─────────────────────────
//
// *"if I'm on a train and I want to review it it would take so much time without
// knowing how long it would take"*.
//
// 種のダウンロードの ETA（`sync-climb.ts` の `readout`）は使えない。あれは 15 秒の
// 標本を待ってから出す設計で、同期は全体でそれより短いことが多い。しかも同期の
// 大半はバイトの無いマージ（ワーカー内のトランザクション）で、速度から推定でき
// ない。だから見積もりは「前回この端末で測った速さ」から出す：マージは展開後
// 1 バイトあたり何 ms、送信（書き出し＋PUT）は何 ms。初回だけは見積もりが無く、
// 画面はそう言う（"estimating"）。作り話の数字は出さない。

export type SyncStage = "checking" | "downloading" | "merging" | "sending";

export interface SyncProgress {
  readonly stage: SyncStage;
  /** 1-based, among the peers that changed. 0 while checking or sending. */
  readonly peer: number;
  /** Peers that changed since this device last merged them. */
  readonly peers: number;
  /** Uncompressed bytes downloaded so far, across every changed peer. */
  readonly received: number;
  /** Uncompressed bytes to download in all, from the listing. */
  readonly total: number;
  /** Seconds left, from the last run's measured speeds; null on a first run. */
  readonly etaSeconds: number | null;
}

export interface SyncOptions {
  readonly onProgress?: (progress: SyncProgress) => void;
  readonly signal?: AbortSignal;
}

/** What the last completed run measured on THIS device. */
export interface SyncTiming {
  /** Merge time per uncompressed payload byte. */
  readonly mergeMsPerByte: number | null;
  /** Download speed in uncompressed bytes per ms. */
  readonly downBytesPerMs: number | null;
  /** Export + upload, which does not scale with the peers. */
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
    /* the next run just has no estimate */
  }
}

/**
 * Seconds left, or null when any part of what is left has never been measured.
 *
 * Pure, so the arithmetic is testable. A partial estimate (download known, merge
 * not) is NOT returned: it would be the short half of the truth, which is the
 * number that makes him miss a train.
 */
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

/** The listing, alone — a directory read with no payload bodies. */
export async function listPeers(signal?: AbortSignal): Promise<PeerRow[]> {
  const response = await mailboxPayload("/sync/", signal === undefined ? {} : { signal });
  return (response.payload as { peers: PeerRow[] }).peers;
}

/**
 * 一つの版を名指す鍵。sha があればそれ、無ければ「上げた時刻＋大きさ」。
 *
 * 2026-10-09 に実測：クラウドの mailbox の 6 枠のうち sha を持つのは使っている 2 台
 * だけで、9 月 26〜28 日に最後に上げた 4 枠は sha 導入（2026-09-29）より古い。
 * 「sha が無ければ必ず取る」規則のせいで、同期のたびにその 4 枠（展開後 ~7.4 MB）
 * を落としてマージし直していた — 中身は一か月変わっていないのに。時刻と大きさは
 * mailbox が上げ直すたびに変わるので、版の名前として十分。
 */
export function versionOf(peer: PeerRow): string {
  return peer.sha ?? `t:${peer.updatedAt}|${peer.bytes}`;
}

/** The peers whose payload this device has not merged yet. */
export function changedPeers(peers: readonly PeerRow[]): PeerRow[] {
  const self = deviceId();
  return peers.filter((peer) => peer.deviceId !== self && (baseChanged(peer) || deltaChanged(peer)));
}

function baseChanged(peer: PeerRow): boolean {
  return peer.noPayload !== true && readMerged()[peer.deviceId] !== versionOf(peer);
}

function deltaChanged(peer: PeerRow): boolean {
  if (peer.delta === undefined) return false;
  // sha の無い差分は無い（mailbox が必ず付ける）が、無ければ毎回取る側に倒す。
  return peer.delta.sha === undefined || readMergedDelta()[peer.deviceId] !== peer.delta.sha;
}

export interface SyncPorts {
  /** Ask the worker for this device's payload, and the mark it covers. */
  exportPayload(): Promise<{ json: string; bytes: number; mark?: number }>;
  /** 印より後の採点だけ。無ければ（古いポート）差分は送らず全体を送る。 */
  exportDelta?(after: number): Promise<{ json: string; bytes: number; mark: number; count: number }>;
  /** Hand the worker a peer's payload to merge. */
  mergePayload(payload: unknown): Promise<{
    reviewsAdded: number;
    flagsTaken: number;
    trackStateTaken: number;
    markBefore?: number;
    markAfter?: number;
  }>;
}

/**
 * マージで入ってきた採点は、送り残しではない — 持ち主の端末の mailbox にある。
 * 印がマージ前の最大と同じだった（送り残しが無かった）なら、印をマージ後へ運ぶ。
 * 運ばないと、次の差分が他の端末の採点を何百件も運び直す（実測：一回の起動の
 * マージで 610 件）。
 */
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

/**
 * Pull every peer's payload, merge each, then push this device's.
 *
 * PULL BEFORE PUSH, and the order is the point: pushing first would publish a
 * payload that does not yet contain what the peers just told us, so a third
 * device reading the mailbox would get a stale picture. Pulling first means the
 * payload this device leaves behind is the merged one.
 */
export async function syncNow(
  ports: SyncPorts,
  options: SyncOptions & { readonly listing?: readonly PeerRow[]; readonly push?: boolean } = {},
): Promise<SyncOutcome> {
  const self = deviceId();
  const { onProgress, signal } = options;
  const timing = readTiming();

  // 一覧を既に持っている呼び出し側（起動時）は二度聞かない。
  const peers = options.listing ?? (await listPeers(signal));
  // 何を取るかは、記録を書き換える前に決める。全体と差分はそれぞれの版で。
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

  // 進み具合。ダウンロード速度は今回の実測を優先し、無ければ前回の値。
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

  // ONE BAD PEER MUST NOT STOP THE SYNC. Found by leaving a hand-written test
  // payload in the mailbox: its archive was `{}`, the merge threw, and the whole
  // run aborted — the good peer was never read and this device never pushed. A
  // peer on an older build, or a half-written file, would do the same. Each
  // peer is merged on its own and a failure is carried out rather than thrown.
  const failures: string[] = [];
  const merged = readMerged();
  const mergedDelta = readMergedDelta();
  const save = (): void => {
    writeMerged(merged);
    writeMergedDelta(mergedDelta);
  };
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
      // 最初のバイトの前に言う — 繋がるまでの間も「何を待っているか」は分かる。
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
      // 中止はダウンロードの間だけ効く。マージはワーカーのトランザクションで、
      // 途中で止めても待つ時間は減らない — 始まったら終わらせる方が正直。
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
        // sha があれば「マージした中身」の sha（KV の遅れ対策、上の MERGED_KEY 参照）。
        // 無い古い枠は一覧の鍵で — そういう枠はもう書き換えられないので遅れは起きない。
        if (sha !== null) merged[peer.deviceId] = sha;
        else if (peer.sha === undefined) merged[peer.deviceId] = versionOf(peer);
      }
      if (item.delta) {
        const size = peer.delta?.bytes ?? 0;
        const { payload, sha } = await download(`/sync/${peer.deviceId}/delta`, size);
        const entries = Array.isArray(payload) ? payload : [];
        report("merging", index + 1);
        const mergeFrom = performance.now();
        // 一つずつ、積まれた順に。どれも冪等なので、全体と重なっていても壊れない。
        for (const entry of entries) take(await ports.mergePayload(entry));
        mergeMs += performance.now() - mergeFrom;
        mergedBytes += size;
        if (sha !== null) mergedDelta[peer.deviceId] = sha;
      }
      peersMerged += 1;
    } catch (error) {
      // 中止は「一つの端末の失敗」ではない — 呼び出し側まで投げる。
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

  // Only after the loop, and only the peers that merged: a failure is retried next time.
  save();

  // 起動時は送らない（`push: false`）。受け取る側は「最初のカードの前」に済ませる
  // 必要があるが、送る側は彼を待たせる理由が無い — 起動後に裏で `pushNow` が送る。
  let sendMs = timing.sendMs;
  let pushedBytes = 0;
  if (options.push !== false) {
    report("sending", 0);
    const sendFrom = performance.now();
    pushedBytes = await putFull(ports, self);
    sendMs = performance.now() - sendFrom;
  }

  // 次回の見積もりのために、今回測れた分だけ書き換える。測れなかった項目
  // （変わった端末が無かった回のマージ等）は前回の値を残す。
  writeTiming({
    mergeMsPerByte: mergedBytes > 0 && mergeMs > 0 ? mergeMs / mergedBytes : timing.mergeMsPerByte,
    // 速すぎて測れなかった回も記録する（1 ms で割る）— 記録しないと、速い回線では
    // ダウンロード速度が永遠に「未測定」になり、見積もりも永遠に出ない。実際に
    // ローカルの mailbox でそうなった。
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

/**
 * HAS A PEER PUSHED SINCE THIS DEVICE LAST MERGED? — Zach, 2026-09-14.
 *
 * *"right now im reviewing this card and it looks like i already did it in the
 * morning on my phone … but the light is green… which means it's synced…?"*
 *
 * It was green and it was honest and it was still the wrong thing to believe.
 * `lastSyncedAt` means "my last PULL succeeded", and the automatic half of sync
 * is `pushNow`, which deliberately never pulls (a merge mid-card freezes the
 * review screen for ~8 seconds and can move what is due underneath him). So a
 * device goes on saying "synced 38m ago" for ever while a peer drops newer work
 * into the mailbox a minute later. Measured on his own mailbox that evening: the
 * phone's payload carried 36 reviews for the day and the laptop had merged none
 * of them, so he re-reviewed four cards the phone had already answered.
 *
 * Nothing was lost — reviews UNION, and both grades are real — but he did the
 * work twice and the indicator told him he would not have to.
 *
 * **The listing already carries the answer.** `GET /sync/` returns every peer's
 * `updatedAt` and no payload bodies, so this is a directory read, not a merge: it
 * can be asked on load and after a push without any of the cost that made the
 * pull manual in the first place. This does not sync anything. It only decides
 * whether the dot is allowed to claim that he is up to date.
 *
 * A failure here is NOT a sync failure and must not be shown as one — being
 * offline is the normal state of a local-first app. The caller keeps its status.
 */
export async function peersNewerThan(lastSyncedAt: string | null): Promise<number> {
  const self = deviceId();
  const { peers } = (await mailboxJson("/sync/")) as { peers: PeerRow[] };
  const since = lastSyncedAt === null ? null : new Date(lastSyncedAt).getTime();
  let newer = 0;
  for (const peer of peers) {
    if (peer.deviceId === self) continue;
    // Never synced: any peer at all is newer than nothing.
    if (since === null || Number.isNaN(since)) {
      newer += 1;
      continue;
    }
    const at = new Date(peer.updatedAt).getTime();
    if (!Number.isNaN(at) && at > since) newer += 1;
  }
  return newer;
}

/** "3 minutes ago" — the only form the indicator needs. */
export function sinceLabel(at: string | null, now: Date = new Date()): string {
  const ago = agoLabel(at, now);
  return ago === null ? "never synced" : `synced ${ago}`;
}

/**
 * The same clock without the verb — "just now", "3m ago", "1d ago".
 *
 * `sinceLabel` hard-coded the word "synced" into every branch, so the push row
 * came out as *"grades sent synced just now"*. Two phrasings, ONE arithmetic:
 * a second copy of this is a second place for the thresholds to drift.
 *
 * Null means there is no such moment yet, which each caller words for itself —
 * "never synced" is not the same sentence as "grades never sent".
 */
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

/**
 * Is this status worth his attention?
 *
 * A day is the threshold because his workflow is daily — he reviews on the phone
 * and creates on the laptop, so a device more than a day out of contact is one
 * whose grades are not anywhere else yet.
 */
export function isStale(status: SyncStatus, now: Date = new Date()): boolean {
  // `behind` is the sharpest case and does not wait for the day threshold: a
  // peer's grades are sitting in the mailbox RIGHT NOW and this device is about
  // to re-ask him cards it has already been told the answer to.
  if (status.state === "failed" || status.state === "never" || status.state === "behind") {
    return true;
  }
  if (status.lastSyncedAt === null) return true;
  const ms = now.getTime() - new Date(status.lastSyncedAt).getTime();
  return Number.isNaN(ms) || ms > 24 * 60 * 60 * 1000;
}

/**
 * PUSH ONLY — this device's payload into the mailbox, no pull, no merge.
 *
 * ─── WHY THIS EXISTS, 2026-09-14 ────────────────────────────────────────────
 *
 * Zach: *"i already reviewed so many items on my phone today, but it's not
 * reflected on any browser on my pc. we need to fix this. what happens with my
 * ACID😭"*
 *
 * Nothing was lost and nothing was broken — `syncNow` had simply never been
 * called. Sync was reachable from exactly two click handlers (the header dot and
 * the sidebar row) and from nothing else, so a day of reviewing on the phone sat
 * in the phone's OPFS with the newest mailbox payload **23 hours old**. Every
 * merge rule in `src/sync/merge.ts` was correct and irrelevant: no payload, no
 * merge.
 *
 * ─── WHY A PUSH IS ITS OWN VERB ─────────────────────────────────────────────
 *
 * `syncNow` pulls every peer and MERGES before it pushes, and the merge is the
 * expensive half — it was seven minutes before it got a transaction and is ~8
 * seconds now. That is fine for a button he pressed and wrong for something that
 * fires while he is mid-card: the worker owns the session, so a merge is 8
 * seconds of a frozen review screen, and a merge can change what is due
 * underneath him.
 *
 * A push cannot. It reads, serialises and PUTs; it changes nothing locally and
 * nothing on any other device until that device chooses to pull. So the
 * automatic half of sync is the half that is safe to automate, and the half that
 * protects the thing he cannot reconstruct.
 *
 * ─── AND WHY IT IS NOT A TIMER ──────────────────────────────────────────────
 *
 * SPEC problem #1 is battery: *"no polling, no sockets, precomputed renders"*.
 * This is called from a DEBOUNCE on his own grading (`main.ts`), so a device
 * nobody is reviewing on sends nothing at all. An idle phone in his pocket does
 * no work.
 */
export async function pushNow(ports: SyncPorts): Promise<number> {
  return putFull(ports, deviceId());
}

/**
 * 全体を送る。`X-Covers-Mark` で「ここまでの採点は入っている」と言い、mailbox は
 * それ以下の差分を捨てる。送れたら印を進め、「全体を送るべき」印を消す。
 */
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
  clearDirty(dirty);
  writeLastPushed(new Date().toISOString());
  return mine.bytes;
}

/** `keepalive` の本文上限は 64 KB。少し手前で切る。 */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

export type PushKind = "delta" | "full" | "nothing";

/**
 * 採点を送る — 差分で送れるなら差分、送れないなら全体。2026-10-10。
 *
 * 全体になるのは：まだ一度も全体を送っていない（印が無い）、採点以外の書き込み
 * があった（`markFullDirty`）、mailbox が差分を受けない（ローカルの開発用 mailbox
 * は 404/405、差分が積もりすぎたら 413）。
 *
 * `keepalive`: ページが隠れる瞬間（タブレットを閉じた）に呼ぶ。その時は差分しか
 * 送らない — 全体は 64 KB を超えるので `keepalive` が使えず、走り切らない送信を
 * 始めても意味がない。返事は届かないかもしれず、その時は印を進めない：次の送信
 * が同じ採点をもう一度運び、マージは冪等なので重複は無害（mailbox は同じ印を
 * 二度積まない）。
 */
export async function pushGradesNow(
  ports: SyncPorts,
  options: { readonly keepalive?: boolean } = {},
): Promise<PushKind> {
  const self = deviceId();
  const mark = readMark();
  const dirty = readDirty() !== null;
  if (ports.exportDelta === undefined || mark === null || (dirty && options.keepalive !== true)) {
    if (options.keepalive === true) return "nothing";
    await putFull(ports, self);
    return "full";
  }
  const delta = await ports.exportDelta(mark);
  if (delta.count === 0) {
    if (!dirty) return "nothing";
    if (options.keepalive === true) return "nothing";
    await putFull(ports, self);
    return "full";
  }
  const keepalive = options.keepalive === true && delta.bytes <= KEEPALIVE_MAX_BYTES;
  if (options.keepalive === true && !keepalive) return "nothing";
  const response = await reach(`/sync/${self}/delta`, {
    method: "POST",
    body: delta.json,
    headers: { "Content-Type": "application/json" },
    ...(keepalive ? { keepalive: true } : {}),
  });
  if (response.status === 404 || response.status === 405 || response.status === 413) {
    if (options.keepalive === true) return "nothing";
    await putFull(ports, self);
    return "full";
  }
  if (!response.ok) throw new Error(`the mailbox refused this device's grades (${response.status})`);
  writeMark(delta.mark);
  writeLastPushed(new Date().toISOString());
  return "delta";
}

/**
 * WHEN THIS DEVICE'S WORK LAST LEFT IT — a different fact from `lastSyncedAt`.
 *
 * `lastSyncedAt` means "this device pulled everyone and pushed", which is what
 * the dot has always claimed. A push-only run must not write that: it would
 * report a merge that did not happen, and the honest reading of the indicator is
 * the one thing standing between him and the silent failure he has now hit
 * twice. So it is its own key, and the dot says "sent" rather than "synced".
 */
const PUSHED_KEY = "hashigo.sync.pushed";

function writeLastPushed(at: string): void {
  try {
    localStorage.setItem(PUSHED_KEY, at);
  } catch {
    /* private window, or storage off — the push still happened */
  }
}

export function lastPushedAt(): string | null {
  try {
    return localStorage.getItem(PUSHED_KEY);
  } catch {
    return null;
  }
}
