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

interface PeerRow {
  readonly deviceId: string;
  readonly bytes: number;
  readonly updatedAt: string;
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
  const response = await reach(url, { cache: "no-store" });
  if (response.status === 401) {
    throw new Error(`the mailbox refused this device's key (401) — rebuild with the key in .env`);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  // Read as TEXT and parse here rather than trusting `response.json()`, so the
  // failure can say what actually came back. Checking `content-type` instead
  // would be one more thing to be wrong about a server we do not control.
  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
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

export interface SyncPorts {
  /** Ask the worker for this device's payload. */
  exportPayload(): Promise<{ json: string; bytes: number }>;
  /** Hand the worker a peer's payload to merge. */
  mergePayload(payload: unknown): Promise<{
    reviewsAdded: number;
    flagsTaken: number;
    trackStateTaken: number;
  }>;
}

/**
 * Pull every peer's payload, merge each, then push this device's.
 *
 * PULL BEFORE PUSH, and the order is the point: pushing first would publish a
 * payload that does not yet contain what the peers just told us, so a third
 * device reading the mailbox would get a stale picture. Pulling first means the
 * payload this device leaves behind is the merged one.
 */
export async function syncNow(ports: SyncPorts): Promise<SyncOutcome> {
  const self = deviceId();

  const { peers } = (await mailboxJson("/sync/")) as { peers: PeerRow[] };

  let reviewsAdded = 0;
  let flagsTaken = 0;
  let trackStateTaken = 0;
  let peersMerged = 0;

  // ONE BAD PEER MUST NOT STOP THE SYNC. Found by leaving a hand-written test
  // payload in the mailbox: its archive was `{}`, the merge threw, and the whole
  // run aborted — the good peer was never read and this device never pushed. A
  // peer on an older build, or a half-written file, would do the same. Each
  // peer is merged on its own and a failure is carried out rather than thrown.
  const failures: string[] = [];
  for (const peer of peers) {
    if (peer.deviceId === self) continue;
    try {
      const payload = await mailboxJson(`/sync/${peer.deviceId}`);
      const report = await ports.mergePayload(payload);
      reviewsAdded += report.reviewsAdded;
      flagsTaken += report.flagsTaken;
      trackStateTaken += report.trackStateTaken;
      peersMerged += 1;
    } catch (error) {
      failures.push(
        `${peer.deviceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const mine = await ports.exportPayload();
  const put = await reach(`/sync/${self}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: mine.json,
  });
  if (!put.ok) throw new Error(`the mailbox refused this device's payload (${put.status})`);

  writeLastSynced(new Date().toISOString());
  return {
    reviewsAdded,
    flagsTaken,
    trackStateTaken,
    peersMerged,
    pushedBytes: mine.bytes,
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
  const self = deviceId();
  const mine = await ports.exportPayload();
  const put = await reach(`/sync/${self}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: mine.json,
  });
  if (!put.ok) throw new Error(`the mailbox refused this device's payload (${put.status})`);
  writeLastPushed(new Date().toISOString());
  return mine.bytes;
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
