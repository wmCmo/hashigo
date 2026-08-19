/**
 * THROWAWAY (spike harness). The main thread: spawn the worker, render what it
 * says, and call `navigator.storage.persist()` — which does not exist in a
 * worker, so the page has to ask and pass the answer in.
 *
 * It never holds a database handle or a blob store. That is the contract.
 */

import { readPack } from "./pack.js";
import type { SpikeMessage, SpikeRequest } from "./protocol.js";

// Vite dev turns this into a `/@fs/…` URL for a file outside the Vite root. It
// is never bundled: `vite build` only has the root index.html as an input, so a
// 625 MiB asset import cannot end up in the output.
import packUrl from "../../build/spike/blob-corpus.pack?url";

/** Served by the middleware in vite.config.ts, in dev and in preview both. */
const BOOTSTRAP_URL = "/hashigo-bootstrap.db";

const logElement = document.querySelector<HTMLPreElement>("#log");
const factsElement = document.querySelector<HTMLDListElement>("#facts");
if (logElement === null || factsElement === null) throw new Error("page markup is missing");

let requestId = 0;

function write(text: string, level: "info" | "step" | "good" | "bad" = "info"): void {
  const line = document.createElement("span");
  line.className = `log-${level}`;
  line.textContent = `${text}\n`;
  logElement?.append(line);
  if (logElement !== null) logElement.scrollTop = logElement.scrollHeight;
}

function fact(term: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  factsElement?.append(dt, dd);
}

const worker = new Worker(new URL("./store.worker.ts", import.meta.url), {
  type: "module",
  name: "hashigo-blobstore",
});

worker.onmessage = (event: MessageEvent<SpikeMessage>): void => {
  const message = event.data;
  if (message.kind === "log") {
    write(message.text, message.level);
    return;
  }
  write("", "info");
  if (message.ok) {
    write("=== SUMMARY ===", "step");
    for (const [key, value] of Object.entries(message.summary ?? {})) {
      write(`  ${key.padEnd(22)} ${String(value)}`, "good");
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
  fact("mode", import.meta.env.DEV ? "vite dev server" : "built bundle");
  fact("crossOriginIsolated (main)", String(crossOriginIsolated));
  fact("isSecureContext", String(isSecureContext));
  fact("pack URL", packUrl);
  try {
    const response = await fetch(location.href, { cache: "no-store" });
    const isolating = [...response.headers].filter(([name]) => name.startsWith("cross-origin-"));
    fact(
      "COOP/COEP response headers",
      isolating.length === 0 ? "none served" : isolating.map(([n, v]) => `${n}: ${v}`).join(" | "),
    );
  } catch (error) {
    fact("COOP/COEP response headers", `could not read (${String(error)})`);
  }
  let persisted = false;
  try {
    const granted = await navigator.storage.persist();
    persisted = await navigator.storage.persisted();
    fact("navigator.storage.persist()", `granted=${granted} persisted=${persisted}`);
  } catch (error) {
    fact("navigator.storage.persist()", `threw ${String(error)}`);
  }
  return persisted;
}

function main(fresh: boolean): void {
  if (logElement !== null) logElement.textContent = "";
  void navigator.storage
    .persisted()
    .catch(() => false)
    .then((persisted) => {
      const request: SpikeRequest = {
        kind: "run",
        id: ++requestId,
        fresh,
        persisted,
        packUrl,
        bootstrapUrl: BOOTSTRAP_URL,
        vacuum: document.querySelector<HTMLInputElement>("#vacuum")?.checked === true,
      };
      worker.postMessage(request);
    });
}

/**
 * The pack, parsed on the MAIN thread and thrown away. Nothing to do with the
 * store — it is here because "is the 625 MiB file the page is about to fetch
 * actually the corpus" is a question worth being able to answer without a
 * database in the way.
 */
async function checkPack(): Promise<void> {
  write("checking the pack (no database involved)…", "step");
  let count = 0;
  let bytes = 0;
  let mismatches = 0;
  const { sha256Hex } = await import("../../src/blobs/sha256.js");
  const result = await readPack(packUrl, (hash, payload) => {
    count += 1;
    bytes += payload.length;
    if (count % 1_000 === 0 && sha256Hex(payload) !== hash) mismatches += 1;
  });
  write(
    `pack: ${count} payloads / ${(bytes / 1024 / 1024).toFixed(1)} MiB, header says ` +
      `${result.header.count} / ${(result.header.totalBytes / 1024 / 1024).toFixed(1)} MiB; ` +
      `${mismatches} mismatches in the sampled rehash`,
    mismatches === 0 && count === result.header.count ? "good" : "bad",
  );
}

document.querySelector("#run")?.addEventListener("click", () => main(false));
document.querySelector("#fresh")?.addEventListener("click", () => main(true));
document.querySelector("#pack")?.addEventListener("click", () => void checkPack());

void pageFacts().then(() => main(false));
