import { el } from "./dom.js";
import { count } from "./plural.js";
import { line } from "./ui.js";
import { ask } from "./worker-client.js";

const banner = el("banner");

const RECEIPT_KEY = "hashigo.receipt.v1";

interface Receipt {
  readonly at: string;
  readonly localReviews: number;
  readonly schemaVersion: number;
}

function readReceipt(): Receipt | null {
  try {
    const raw = localStorage.getItem(RECEIPT_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<Receipt>;
    return typeof parsed.at === "string" && typeof parsed.localReviews === "number"
      ? { at: parsed.at, localReviews: parsed.localReviews, schemaVersion: parsed.schemaVersion ?? 0 }
      : null;
  } catch {
    return null;
  }
}

function writeReceipt(receipt: Receipt): void {
  try {
    localStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
  } catch {
  }
}

export function checkEviction(opened: {
  readonly cardsWerePresent: boolean;
  readonly localReviews: number;
  readonly schemaVersion: number;
}): void {
  const receipt = readReceipt();
  if (!opened.cardsWerePresent && receipt !== null) {
    const lost = receipt.localReviews;
    line(
      lost > 0
        ? `THE DATABASE WAS GONE. A receipt from ${receipt.at.slice(0, 16)} says it held ` +
            `${count(lost, "local review")}. They are not recoverable from exports/ — ` +
            `restore a backup with the export you took.`
        : `The database was gone (receipt from ${receipt.at.slice(0, 16)}), but it held 0 local ` +
            `reviews, so nothing was lost — exports/ rebuilds the rest.`,
      lost > 0 ? "bad" : "info",
    );
    if (lost > 0) {
      banner.replaceChildren(
        document.createTextNode(
          `Storage was cleared since ${receipt.at.slice(0, 10)} — ${count(lost, "local review")} ` +
            `${lost === 1 ? "was" : "were"} lost. Restore from a backup, and keep exporting.`,
        ),
      );
      banner.hidden = false;
    }
  }
  writeReceipt({
    at: new Date().toISOString(),
    localReviews: opened.localReviews,
    schemaVersion: opened.schemaVersion,
  });
}

export async function checkPersistence(): Promise<void> {
  const evicted = !banner.hidden;
  const say = (text: string): void => {
    if (evicted) return;
    banner.textContent = text;
    banner.hidden = false;
  };

  if (navigator.storage?.persisted === undefined) {
    say("this browser cannot report storage persistence — export a backup often");
    return;
  }
  if (await navigator.storage.persisted()) {
    if (!evicted) banner.hidden = true;
    return;
  }
  const granted = (await navigator.storage.persist?.()) ?? false;
  if (granted) {
    line("storage persistence granted", "good");
    if (!evicted) banner.hidden = true;
    return;
  }
  line("storage persistence DENIED — the browser may evict this database", "bad");
  if (evicted) return;
  banner.replaceChildren(
    document.createTextNode(
      "storage is NOT persistent — the browser may evict your reviews. Export a backup: ",
    ),
  );
  const button = document.createElement("button");
  button.textContent = "export backup";
  button.addEventListener("click", () => void exportBackup());
  banner.appendChild(button);
  banner.hidden = false;
}

export async function exportBackup(): Promise<void> {
  const reply = await ask<"backup">({ kind: "backup" });
  const url = URL.createObjectURL(new Blob([reply.json], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `hashigo-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  line(`backup ${reply.bytes.toLocaleString()} bytes · ${JSON.stringify(reply.counts)}`, "good");
}
