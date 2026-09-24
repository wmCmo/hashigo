/**
 * DECISION 17'S UI — the persistence banner, the one-tap export, and eviction
 * detected after the fact.
 *
 * Moved out of `main.ts` on 2026-09-25. Two sections there became one module:
 * they share the banner element and the reason they exist — his history lives in
 * this browser's OPFS and nowhere else (decision 41).
 */

import { el } from "./dom.js";
import { line } from "./ui.js";
import { ask } from "./worker-client.js";

/** The one strip decision 17 speaks through: eviction, persistence, the export. */
const banner = el("banner");

/**
 * A RECEIPT, in `localStorage`, of the last successful open.
 *
 * `localStorage` rather than the database, obviously — a receipt inside the thing
 * that went missing proves nothing. It is also the only store the PAGE can use;
 * `localStorage` does not exist in a worker, which is why this half lives here
 * and the worker reports the file's presence instead.
 */
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
    // A corrupt receipt is not worth failing a boot over; it just means the
    // eviction check cannot answer this time, which it says rather than assumes.
    return null;
  }
}

function writeReceipt(receipt: Receipt): void {
  try {
    localStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
  } catch {
    /* a full or disabled localStorage costs the check, not the session */
  }
}

/**
 * Did the browser throw the database away since last time?
 *
 * **What this CAN detect:** OPFS had no card database, and a receipt says one was
 * there before. That is an eviction, or "clear site data", or a profile that moved
 * — indistinguishable from each other and all costing the same thing, so they get
 * the same message.
 *
 * **What it CANNOT detect, said out loud rather than implied:** a full site-data
 * clear takes the receipt with it, and then this looks exactly like a first run.
 * There is no store that survives that, so the honest fallback is the boot log —
 * a re-fetch of 72 MB is visible, and the number of local reviews is stated on
 * every successful open so the drop is noticeable even when the cause is not.
 *
 * It is the LOSS that is reported, not the event: `localReviews` is the only thing
 * in the database `exports/` cannot rebuild (decision 17), so a receipt saying 0
 * means an eviction cost nothing and does not deserve an alarm.
 */
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
            `${lost.toLocaleString()} local review(s). They are not recoverable from exports/ — ` +
            `restore a backup with the export you took.`
        : `The database was gone (receipt from ${receipt.at.slice(0, 16)}), but it held 0 local ` +
            `reviews, so nothing was lost — exports/ rebuilds the rest.`,
      lost > 0 ? "bad" : "info",
    );
    if (lost > 0) {
      banner.replaceChildren(
        document.createTextNode(
          `Storage was cleared since ${receipt.at.slice(0, 10)} — ${lost.toLocaleString()} ` +
            `local review(s) were lost. Restore from a backup, and keep exporting.`,
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


/**
 * `navigator.storage.persist` is **Window-only** — absent from
 * `StorageManager.prototype` in a worker, confirmed on Zach's own handset. So the
 * grant is asked for HERE, and the worker can only read `persisted()`.
 *
 * The banner is not dismissible, per `notes/archive/persistence.md`. What DID
 * drop in priority is the "add to home screen" prompt: persistence was granted in
 * a plain browser tab on his device. But Chromium grants it off site engagement
 * and a fresh origin starts at zero, so the banner still has to exist.
 */
export async function checkPersistence(): Promise<void> {
  // An eviction message already on screen is the more important one — it names a
  // loss that HAS happened, not a risk — so this may not overwrite it. But the
  // REQUEST still has to run: an evicted boot is precisely when persistence is
  // most worth asking for, and an early return here would have skipped it. (That
  // was a live flaw in the first version of this function.)
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

/**
 * Decision 17's one tap.
 *
 * A `<a download>` is deliberate rather than a share sheet: the archive is rows
 * plus stable keys (`src/backup/README.md`), and a file he can see in his own
 * downloads folder is the point.
 */
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
