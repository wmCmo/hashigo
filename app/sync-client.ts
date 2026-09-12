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

const DEVICE_KEY = "hashigo.sync.deviceId";
const LAST_KEY = "hashigo.sync.lastSyncedAt";

export type SyncState = "never" | "syncing" | "ok" | "failed" | "offline";

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

  const index = await fetch("/sync/", { cache: "no-store" });
  if (!index.ok) throw new Error(`the mailbox answered ${index.status}`);
  const { peers } = (await index.json()) as { peers: PeerRow[] };

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
      const response = await fetch(`/sync/${peer.deviceId}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`the mailbox answered ${response.status}`);
      const payload: unknown = await response.json();
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
  const put = await fetch(`/sync/${self}`, {
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

/** "3 minutes ago" — the only form the indicator needs. */
export function sinceLabel(at: string | null, now: Date = new Date()): string {
  if (at === null) return "never synced";
  const ms = now.getTime() - new Date(at).getTime();
  if (Number.isNaN(ms)) return "never synced";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `synced ${days}d ago`;
}

/**
 * Is this status worth his attention?
 *
 * A day is the threshold because his workflow is daily — he reviews on the phone
 * and creates on the laptop, so a device more than a day out of contact is one
 * whose grades are not anywhere else yet.
 */
export function isStale(status: SyncStatus, now: Date = new Date()): boolean {
  if (status.state === "failed" || status.state === "never") return true;
  if (status.lastSyncedAt === null) return true;
  const ms = now.getTime() - new Date(status.lastSyncedAt).getTime();
  return Number.isNaN(ms) || ms > 24 * 60 * 60 * 1000;
}
