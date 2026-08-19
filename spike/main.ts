/**
 * THROWAWAY (spike harness). The main thread's whole job:
 *
 *   * spawn the worker and render what it says,
 *   * call `navigator.storage.persist()`, which does not exist in a worker,
 *   * prove no COOP/COEP header is being served, by reading the page's own
 *     response headers,
 *   * offer one deliberate misuse — installing the VFS on the main thread — so
 *     the failure is measured rather than assumed.
 *
 * It never holds a database handle. That is the contract, and the reason this
 * file does not import anything from `src/db/browser.ts` except for the probe.
 */

import { installPool } from "../src/db/browser.js";

import type { SpikeMessage, SpikeRequest } from "./protocol.js";

declare const __SCHEMA_VERSION_FROM_NODE__: number;

const logElement = document.querySelector<HTMLPreElement>("#log");
const factsElement = document.querySelector<HTMLDListElement>("#facts");
if (logElement === null || factsElement === null) throw new Error("page markup is missing");

let requestId = 0;

function write(text: string, level: "info" | "step" | "good" | "bad" = "info"): void {
  const line = document.createElement("span");
  line.className = `log-${level}`;
  line.textContent = `${text}\n`;
  logElement!.append(line);
  logElement!.scrollTop = logElement!.scrollHeight;
}

function fact(term: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  factsElement!.append(dt, dd);
}

const worker = new Worker(new URL("./db.worker.ts", import.meta.url), {
  type: "module",
  name: "hashigo-db",
});

worker.onmessage = (event: MessageEvent<SpikeMessage>): void => {
  const message = event.data;
  if (message.kind === "log") {
    write(message.text, message.level);
    return;
  }
  if (message.kind === "rows") {
    write(`rows: ${JSON.stringify(message.rows)}${message.error === undefined ? "" : ` error ${message.error}`}`);
    return;
  }
  if (message.ok) {
    write("", "info");
    write("=== ORACLE, from an OPFS-backed database ===", "step");
    for (const [key, value] of Object.entries(message.oracle ?? {})) {
      write(`  ${key.padEnd(20)} ${String(value)}`, "good");
    }
  } else {
    write(`run failed: ${message.error ?? "unknown"}`, "bad");
  }
};

worker.onerror = (event: ErrorEvent): void => {
  write(`worker error: ${event.message} (${event.filename}:${event.lineno})`, "bad");
};

async function pageFacts(): Promise<boolean> {
  fact("origin", location.origin);
  fact("mode", import.meta.env.DEV ? "vite dev server" : "built bundle (vite build + preview)");
  fact("crossOriginIsolated (main)", String(crossOriginIsolated));
  fact("isSecureContext", String(isSecureContext));
  fact("SCHEMA_VERSION (from src/schema/index.ts, injected)", String(__SCHEMA_VERSION_FROM_NODE__));

  // Same-origin: the browser lets us read our own response headers, which is a
  // direct check that nothing is serving COOP/COEP rather than an inference.
  try {
    const response = await fetch(location.href, { cache: "no-store" });
    const interesting = [...response.headers]
      .filter(([name]) => name.startsWith("cross-origin-"))
      .map(([name, value]) => `${name}: ${value}`);
    fact("COOP/COEP response headers", interesting.length === 0 ? "none served" : interesting.join(" | "));
  } catch (error) {
    fact("COOP/COEP response headers", `could not read (${String(error)})`);
  }

  // persist() is main-thread only. The worker cannot ask.
  let persisted = false;
  try {
    persisted = await navigator.storage.persisted();
    const granted = await navigator.storage.persist();
    persisted = await navigator.storage.persisted();
    fact("navigator.storage.persist()", `granted=${granted} persisted=${persisted}`);
  } catch (error) {
    fact("navigator.storage.persist()", `threw ${String(error)}`);
  }
  return persisted;
}

async function main(reimport: boolean): Promise<void> {
  logElement!.textContent = "";
  const persisted = await navigator.storage.persisted().catch(() => false);
  const request: SpikeRequest = {
    kind: "run",
    id: ++requestId,
    reimport,
    schemaVersionFromNode: __SCHEMA_VERSION_FROM_NODE__,
    persisted,
  };
  worker.postMessage(request);
}

/** The misuse, measured: sahpool on the main thread, in its own directory. */
async function mainThreadProbe(): Promise<void> {
  write("", "info");
  write("MAIN-THREAD PROBE — installing opfs-sahpool outside a worker", "step");
  write("  (its own vfs name and directory, so it cannot disturb the worker's pool)");
  try {
    const pool = await installPool({
      allowMainThread: true,
      vfsName: "opfs-sahpool-mainthread-probe",
      directory: ".hashigo-mainthread-probe",
      initialCapacity: 2,
    });
    write(`  INSTALLED on the main thread: vfs ${pool.vfsName}, capacity ${pool.getCapacity()}`, "good");
    write("  ... so createSyncAccessHandle is permitted outside a worker in THIS browser.", "good");
    write("  It is still wrong for Hashigo: every query would block the UI thread.", "info");
    await pool.removeVfs();
    write("  removed the probe VFS again", "info");
  } catch (error) {
    write(`  REFUSED on the main thread: ${String(error)}`, "bad");
  }
}

document.querySelector("#run")?.addEventListener("click", () => void main(false));
document.querySelector("#reimport")?.addEventListener("click", () => void main(true));
document.querySelector("#mainthread")?.addEventListener("click", () => void mainThreadProbe());
document
  .querySelector("#exhaust")
  ?.addEventListener("click", () => worker.postMessage({ kind: "exhaust", id: ++requestId }));
document.querySelector("#reload")?.addEventListener("click", () => location.reload());

void (async () => {
  await pageFacts();
  await main(false);
})();
