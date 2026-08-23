/**
 * THROWAWAY (spike harness) — `spike/persist/main.ts`.
 *
 * The main thread. Its jobs, in order of how much they matter:
 *
 *   1. Ask for storage persistence, because **only a Window can**. Report the
 *      answer in letters big enough to read at arm's length on a phone, and
 *      pass it into the worker, which cannot obtain it for itself.
 *   2. Show what the app must show when the answer is NO. That banner is the
 *      deliverable — a user who is never told is a user who finds out by losing
 *      1,317 days of review history.
 *   3. Coordinate tabs. `opfs-sahpool` is single-connection; a second tab is
 *      the failure mode most likely to be ugly, so this page detects it BEFORE
 *      touching the database (Web Locks) and also lets you provoke the raw
 *      failure on purpose.
 *
 * Everything is exposed on `window.__spike` so a CDP driver can run the same
 * steps a thumb would.
 */

import { gib, mib, type PersistMessage, type PersistRequest, type StorageVerdict } from "./protocol.js";

const LOCK_NAME = "hashigo-db-exclusive";
const CHANNEL_NAME = "hashigo-persist-spike";

const logElement = document.querySelector<HTMLPreElement>("#log");
const statsElement = document.querySelector<HTMLDListElement>("#stats");
const bannerElement = document.querySelector<HTMLDivElement>("#banner");
const tabsElement = document.querySelector<HTMLDivElement>("#tabs");
if (logElement === null || statsElement === null || bannerElement === null || tabsElement === null) {
  throw new Error("page markup is missing");
}

/** This tab's identity, so the multi-tab log is readable. */
const TAB_ID = `tab-${Math.random().toString(36).slice(2, 7)}`;
document.title = `persist · ${TAB_ID}`;

let requestId = 0;
const pending = new Map<number, { resolve: (ok: boolean) => void }>();

function write(text: string, level = "info"): void {
  const line = document.createElement("span");
  line.className = `log-${level}`;
  line.textContent = `${text}\n`;
  logElement!.append(line);
  logElement!.scrollTop = logElement!.scrollHeight;
}

const statNodes = new Map<string, HTMLElement>();
function stat(key: string, value: string, level = "info"): void {
  let dd = statNodes.get(key);
  if (dd === undefined) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    dd = document.createElement("dd");
    statsElement!.append(dt, dd);
    statNodes.set(key, dd);
  }
  dd.textContent = value;
  dd.className = `stat-${level}`;
}

// -- the worker --------------------------------------------------------------

const worker = new Worker(new URL("./db.worker.ts", import.meta.url), {
  type: "module",
  name: `hashigo-persist-${TAB_ID}`,
});

worker.onmessage = (event: MessageEvent<PersistMessage>): void => {
  const message = event.data;
  if (message.kind === "log") {
    write(message.text, message.level);
    return;
  }
  if (message.kind === "stat") {
    stat(message.key, message.value, message.level ?? "info");
    return;
  }
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  if (!message.ok) write(`step failed: ${message.error ?? "unknown"}`, "bad");
  waiter?.resolve(message.ok);
};

worker.onerror = (event: ErrorEvent): void => {
  write(`worker error: ${event.message} (${event.filename}:${event.lineno})`, "bad");
};

/**
 * A request minus its `id`. `Omit<Union, "id">` does NOT work here: it collapses
 * the union to the keys every member shares, which loses `reimport`,
 * `limitBytes`, `hold` and `paused`. The conditional type distributes instead.
 */
type Unidentified<T> = T extends { readonly id: number } ? Omit<T, "id"> : never;

function ask(request: Unidentified<PersistRequest>): Promise<boolean> {
  const id = ++requestId;
  const full = { ...request, id } as PersistRequest;
  return new Promise<boolean>((resolve) => {
    pending.set(id, { resolve });
    worker.postMessage(full);
  });
}

// -- 1. persistence: the only thread that may ask ----------------------------

/**
 * The correct plumbing, in one function. Note the order: `persisted()` first so
 * the before/after is honest, `persist()` second, `persisted()` again because
 * **`persist()`'s return value is not the fact you want** — it is what the
 * browser decided this instant, and re-reading `persisted()` is the fact.
 */
async function requestPersistence(): Promise<StorageVerdict> {
  write("", "info");
  write("MAIN THREAD — asking for storage persistence", "step");
  if (typeof navigator.storage?.persist !== "function") {
    const error = "navigator.storage.persist is not a function even on the main thread";
    write(`  ${error}`, "bad");
    return { persistedBefore: false, granted: false, persistedAfter: false, usage: 0, quota: 0, error };
  }
  try {
    const persistedBefore = await navigator.storage.persisted();
    write(`  persisted() before asking : ${persistedBefore}`);
    const granted = await navigator.storage.persist();
    write(`  persist() returned        : ${granted}`);
    const persistedAfter = await navigator.storage.persisted();
    write(`  persisted() after asking  : ${persistedAfter}`, persistedAfter ? "good" : "bad");
    const e = await navigator.storage.estimate();
    const usage = e.usage ?? 0;
    const quota = e.quota ?? 0;
    write(`  estimate()                : usage ${mib(usage)} / quota ${gib(quota)}`);
    return { persistedBefore, granted, persistedAfter, usage, quota };
  } catch (error) {
    const message = String(error);
    write(`  threw: ${message}`, "bad");
    return { persistedBefore: false, granted: false, persistedAfter: false, usage: 0, quota: 0, error: message };
  }
}

/**
 * What the app must do when the answer is NO. This is deliverable 1's second
 * half: a state the user cannot miss, not a console warning.
 */
function showVerdict(verdict: StorageVerdict): void {
  stat("persisted()", String(verdict.persistedAfter), verdict.persistedAfter ? "good" : "bad");
  stat("persist() granted", String(verdict.granted), verdict.granted ? "good" : "bad");
  stat("quota", gib(verdict.quota));
  stat("OPFS usage", mib(verdict.usage));
  stat("secure context", String(isSecureContext), isSecureContext ? "good" : "bad");
  stat("crossOriginIsolated", String(crossOriginIsolated));
  stat("origin", location.origin);
  stat("installed (display-mode)", installedDisplayMode());

  bannerElement!.className = verdict.persistedAfter ? "banner banner-ok" : "banner banner-risk";
  bannerElement!.textContent = verdict.persistedAfter
    ? "STORAGE IS PERSISTENT — the browser has promised not to evict Hashigo to reclaim space."
    : "STORAGE IS BEST-EFFORT. The browser may delete EVERYTHING — the database and all audio, " +
      "together, without asking — when the device runs low on space. Keep an export.";
}

/** Chrome grants persistence far more readily to an installed PWA. */
function installedDisplayMode(): string {
  for (const mode of ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"]) {
    if (matchMedia(`(display-mode: ${mode})`).matches) return `yes (${mode})`;
  }
  return "no (browser tab)";
}

// -- 3. tabs -----------------------------------------------------------------

const channel = new BroadcastChannel(CHANNEL_NAME);
const seen = new Map<string, string>();

channel.onmessage = (event: MessageEvent<{ tab: string; state: string }>): void => {
  const { tab, state } = event.data;
  if (tab === TAB_ID) return;
  seen.set(tab, state);
  renderTabs();
  write(`[other tab ${tab}] ${state}`, "warn");
};

function announce(state: string): void {
  channel.postMessage({ tab: TAB_ID, state });
}

function renderTabs(): void {
  const others = [...seen.entries()].map(([tab, state]) => `${tab}: ${state}`);
  tabsElement!.textContent =
    others.length === 0
      ? `${TAB_ID} (this tab) — no other tab has announced itself`
      : `${TAB_ID} (this tab) | ${others.join(" | ")}`;
}

/**
 * The mitigation, and the recommendation that falls out of this spike: take a
 * Web Lock BEFORE opening the database. Web Locks are per-origin and work
 * across tabs, so the second tab learns it is a follower **without** having to
 * provoke an OPFS failure first.
 */
let lockHeld = false;
async function takeLock(): Promise<boolean> {
  // Re-entrant: this tab already owns it, and asking again would deadlock
  // against itself (`ifAvailable` would answer null and the tab would decide it
  // was a follower of itself).
  if (lockHeld) {
    write("  Web Lock already held by THIS tab", "good");
    return true;
  }
  const locks = (navigator as unknown as { locks?: LockManager }).locks;
  if (locks === undefined) {
    write("  navigator.locks is unavailable; cannot coordinate tabs politely", "bad");
    return true;
  }
  return new Promise<boolean>((resolve) => {
    void locks.request(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (lock === null) {
        write("  Web Lock NOT available — another tab owns the database. This tab is a FOLLOWER.", "bad");
        stat("this tab owns the DB", "NO — another tab does", "bad");
        resolve(false);
        return;
      }
      lockHeld = true;
      write("  Web Lock acquired — this tab owns the database.", "good");
      stat("this tab owns the DB", "yes (Web Lock held)", "good");
      resolve(true);
      // Hold it for the tab's lifetime. Releasing means releasing ownership.
      await new Promise<void>((release) => {
        releaseLock = () => {
          lockHeld = false;
          release();
        };
      });
    });
  });
}
let releaseLock: (() => void) | undefined;

// -- the steps, also callable from a driver -----------------------------------

async function stepEnvironment(): Promise<void> {
  logElement!.textContent = "";
  write(`=== ${TAB_ID} · ${new Date().toISOString()} ===`, "step");
  write(`  mode: ${import.meta.env.DEV ? "vite dev server" : "built bundle"}`);
  write(`  isSecureContext ${isSecureContext} · crossOriginIsolated ${crossOriginIsolated}`);
  write(`  display-mode: ${installedDisplayMode()}`);
  const verdict = await requestPersistence();
  showVerdict(verdict);
  lastVerdict = verdict;
  await ask({ kind: "probe" });
}

let lastVerdict: StorageVerdict = {
  persistedBefore: false,
  granted: false,
  persistedAfter: false,
  usage: 0,
  quota: 0,
};

async function stepOpen(reimport = false): Promise<boolean> {
  write("", "info");
  write("TAB COORDINATION — Web Lock first, database second", "step");
  const owner = await takeLock();
  announce(owner ? "owns the Web Lock, opening the database" : "follower, did not open the database");
  if (!owner) {
    write("  A well-behaved app stops here and says 'Hashigo is open in another tab'.", "warn");
    write("  Use 'force open anyway' to see what happens if it does not.", "warn");
    return false;
  }
  return ask({ kind: "open", reimport, verdict: lastVerdict });
}

/** Deliberately ignore the lock, to measure the raw sahpool failure. */
async function stepForceOpen(): Promise<boolean> {
  write("", "info");
  write("FORCE OPEN — ignoring the Web Lock on purpose", "step");
  announce("forcing the database open while another tab may hold it");
  return ask({ kind: "open", reimport: false, verdict: lastVerdict });
}

const api = {
  tabId: TAB_ID,
  environment: stepEnvironment,
  open: stepOpen,
  forceOpen: stepForceOpen,
  fill: (limitBytes = 0) => ask({ kind: "fill", limitBytes }),
  hold: (on = true) => ask({ kind: "hold", hold: on }),
  pause: (paused = true) => ask({ kind: "pause", paused }),
  evict: () => ask({ kind: "evict" }),
  recover: () => ask({ kind: "recover" }),
  write: () => ask({ kind: "write" }),
  handles: () => ask({ kind: "handles" }),
  retry: () => ask({ kind: "retry" }),
  /**
   * Kill the worker outright. This is precisely what the browser does to a
   * dedicated worker when its tab closes, and it is the ONLY thing observed in
   * this spike that reliably releases the OPFS sync access handles — see
   * notes/archive/persistence.md. Also the mitigation a follower tab can rely on: the
   * leader terminates its worker on `pagehide` and the follower can take over.
   */
  terminate: (): boolean => {
    worker.terminate();
    releaseLock?.();
    announce("terminated its worker and released the lock");
    write("  worker TERMINATED (as closing the tab would do)", "warn");
    stat("this tab owns the DB", "no (worker terminated)", "warn");
    return true;
  },
  releaseLock: (): boolean => {
    releaseLock?.();
    announce("released the Web Lock");
    write("  released the Web Lock", "warn");
    stat("this tab owns the DB", "released", "warn");
    return true;
  },
  lockHeld: () => lockHeld,
  transcript: () => logElement!.textContent ?? "",
  stats: (): Record<string, string> =>
    Object.fromEntries([...statNodes].map(([key, node]) => [key, node.textContent ?? ""])),
  async all(): Promise<void> {
    await stepEnvironment();
    await stepOpen(false);
    await api.fill(0);
  },
};

(window as unknown as { __spike: typeof api }).__spike = api;

// -- buttons -----------------------------------------------------------------

const wire: Record<string, () => unknown> = {
  "#env": stepEnvironment,
  "#open": () => stepOpen(false),
  "#reimport": () => stepOpen(true),
  "#force": stepForceOpen,
  "#fill": () => api.fill(0),
  "#hold": () => api.hold(true),
  "#unhold": () => api.hold(false),
  "#pause": () => api.pause(true),
  "#unpause": () => api.pause(false),
  "#release": () => api.releaseLock(),
  "#evict": () => api.evict(),
  "#recover": () => api.recover(),
  "#reload": () => location.reload(),
  "#newtab": () => window.open(location.href, "_blank"),
  // Reading 40 numbers off a phone and typing them into a laptop is how a phone
  // test stops getting run. One tap, then paste.
  "#copy": async () => {
    const stats = [...statNodes].map(([key, node]) => `${key}: ${node.textContent ?? ""}`).join("\n");
    const text = `${location.href}\n${navigator.userAgent}\n\n${stats}\n\n${api.transcript()}`;
    try {
      await navigator.clipboard.writeText(text);
      write("  copied everything to the clipboard", "good");
    } catch (error) {
      write(`  clipboard refused (${String(error)}) — select the transcript and copy by hand`, "bad");
    }
  },
};
for (const [selector, handler] of Object.entries(wire)) {
  document.querySelector(selector)?.addEventListener("click", () => void handler());
}

renderTabs();
announce("loaded");
window.addEventListener("pagehide", () => announce("closed"));

void stepEnvironment();
