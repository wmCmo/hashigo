import { icon, prependIcon, setIcon, type IconName } from "./icons.js";
import type { DeckBrief, TemplateBrief } from "./protocol.js";
import type { SyncStatus } from "./sync-client.js";
import { openDashboard } from "./dashboard.js";
import { childrenOf as treeChildrenOf, subtreeTotals } from "./deck-tree.js";
import { el } from "./dom.js";
import { openGallery } from "./gallery.js";
import { installOrigin, registerServiceWorker, watchForInstall } from "./install.js";
import { buildNewCardForm, fillNewCardChoices } from "./palette.js";
import {
  agoLabel,
  changedPeers,
  initialStatus,
  isStale,
  lastPushedAt,
  listPeers,
  peersNewerThan,
  pushGradesNow,
  sinceLabel,
  syncNow,
  whenEdited,
  type SyncPorts,
  type SyncProgress,
} from "./sync-client.js";
import { openTemplateEditor, openTemplateEditorById } from "./template-editor.js";
import { mib, openPrompt, say } from "./ui.js";
import { count as countOf } from "./plural.js";
import { ask } from "./worker-client.js";
import { refreshAfterOp } from "./ops.js";
import { openDeckMenu, runDeckOp } from "./deck-menu.js";
import { openSettings } from "./settings.js";

const sidebarToggles = [
  el<HTMLButtonElement>("sidebartoggle"),
  el<HTMLButtonElement>("donesidebartoggle"),
];
const deckList = el("decklist");

const EXPANDED_KEY = "hashigo.sidebar.expanded";

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return new Set(raw === null ? [] : (JSON.parse(raw) as string[]));
  } catch {
    return new Set();
  }
}

function writeExpanded(open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...open]));
  } catch {
  }
}

export let deckIndex: readonly DeckBrief[] = [];
export let templateChoices: readonly TemplateBrief[] = [];
let decksLoaded = false;
let decksLoading: Promise<void> | null = null;
const expanded = readExpanded();

export async function loadDecks(force = false): Promise<void> {
  if (decksLoaded && !force) return;
  if (decksLoading !== null && !force) return decksLoading;
  const loading = (async () => {
    const reply = await ask<"decks">({ kind: "decks" });
    deckIndex = reply.decks;
    templateChoices = reply.templates;
    paintTree(reply.cards);
    fillNewCardChoices(reply.decks);
    decksLoaded = true;
  })();
  decksLoading = loading;
  try {
    await loading;
  } finally {
    if (decksLoading === loading) decksLoading = null;
  }
}

export function childrenOf(parentId: string | null): readonly DeckBrief[] {
  return treeChildrenOf(deckIndex, parentId);
}

export function subtreeCards(deck: DeckBrief): { cards: number; due: number } {
  const totals = subtreeTotals(deckIndex, deck);
  if (totals.truncated && !cycleReported) {
    cycleReported = true;
    console.warn(`deck graph has a cycle at or under ${deck.path} — sidebar totals are a floor`);
    say(`deck "${deck.name}" is inside a cycle; its totals are a floor, not exact`, true);
  }
  return totals;
}
let cycleReported = false;

function paintTree(total: number): void {
  deckList.replaceChildren();
  const everything = navRow("everything", total, 0, 0, null, false);
  everything.addEventListener("click", () => void openGallery(null));
  deckList.appendChild(everything);
  for (const root of childrenOf(null)) deckList.appendChild(deckNode(root, 0));

  const add = document.createElement("button");
  add.type = "button";
  add.className = "tree-add";
  add.textContent = "new top-level deck";
  prependIcon(add, "plus");
  add.addEventListener("click", () => {
    openPrompt("New deck", "It starts empty, at the top level, with reverse set to inherit.",
      "name", "", (name) => void runDeckOp({ op: "create", deckId: "", name, parentId: null }));
  });
  deckList.appendChild(add);

  const group = document.createElement("div");
  group.className = "tree-group";
  const header = navRow(`templates`, templateChoices.length, 0, 0, "__templates__", true);
  header.setAttribute("aria-expanded", String(expanded.has("__templates__")));
  header.addEventListener("click", () => {
    (header.querySelector(".tree-twist") as HTMLElement | null)?.click();
  });
  group.appendChild(header);
  if (expanded.has("__templates__")) {
    for (const template of templateChoices) {
      const row = navRow(template.name, template.fields, 0, 1, null, false, "fields");
      row.classList.add("is-template");
      row.addEventListener("click", () => openTemplateEditor(template));
      group.appendChild(row);
    }
    const make = document.createElement("button");
    make.type = "button";
    make.className = "tree-add";
    make.textContent = "new template";
    prependIcon(make, "plus");
    make.addEventListener("click", () => {
      openPrompt(
        "New template",
        "It starts with two fields, Front and Back, one per side. Add fields and shape the body in the editor that opens next.",
        "name",
        "",
        (name) =>
          void ask<"createTemplate">({ kind: "createTemplate", name })
            .then(async (reply) => {
              say(`made template ${name.trim()}`);
              await loadDecks(true);
              await openTemplateEditorById(reply.templateId);
            })
            .catch((cause: Error) => say(cause.message, true)),
      );
    });
    group.appendChild(make);
  }
  deckList.appendChild(group);
}

function deckNode(deck: DeckBrief, depth: number): HTMLElement {
  const wrap = document.createElement("div");
  const kids = childrenOf(deck.id);
  const under = subtreeCards(deck);
  const row = navRow(deck.name, under.cards, under.due, depth, kids.length > 0 ? deck.id : null, false);
  if (deck.archived) row.classList.add("is-archived");

  const more = document.createElement("span");
  more.className = "tree-more";
  more.setAttribute("role", "button");
  more.tabIndex = 0;
  more.setAttribute("aria-label", `actions for ${deck.name}`);
  setIcon(more, "dots-three");
  const openMenu = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
    openDeckMenu(deck);
  };
  more.addEventListener("click", openMenu);
  more.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") openMenu(event);
  });
  row.appendChild(more);

  row.addEventListener("click", (event) => {
    const hit = event.target as HTMLElement;
    if (hit.closest(".tree-twist, .tree-more") !== null) return;
    void openGallery(deck.id);
  });
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openDeckMenu(deck);
  });
  wrap.appendChild(row);
  if (kids.length > 0 && expanded.has(deck.id)) {
    for (const child of kids) wrap.appendChild(deckNode(child, depth + 1));
  }
  return wrap;
}

function navRow(
  label: string,
  count: number,
  due: number,
  depth: number,
  twistFor: string | null,
  isGroupHeader: boolean,
  unit = "cards",
): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-row";
  if (isGroupHeader) row.classList.add("tree-header");
  row.style.paddingLeft = `${12 + depth * 14}px`;

  const twist = document.createElement("span");
  twist.className = "tree-twist";
  if (twistFor !== null) {
    setIcon(twist, expanded.has(twistFor) ? "caret-down" : "caret-right");
    twist.addEventListener("click", (event) => {
      event.stopPropagation();
      if (expanded.has(twistFor)) expanded.delete(twistFor);
      else expanded.add(twistFor);
      writeExpanded(expanded);
      paintTree(deckIndex.reduce((n, d) => n + d.cards, 0));
    });
  } else {
    twist.textContent = "";
  }
  row.appendChild(twist);

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = label;
  const counts = document.createElement("span");
  counts.className = "tree-counts";
  counts.textContent = due > 0 ? `${due} · ${count}` : String(count);
  if (due > 0) counts.classList.add("has-due");
  if (!isGroupHeader && label !== "everything") {
    const words =
      due > 0
        ? `${due.toLocaleString()} due · ${count.toLocaleString()} ${unit}`
        : `${count.toLocaleString()} ${unit}`;
    counts.title = words;
    row.setAttribute("aria-label", `${label}, ${words}`);
  }
  row.append(name, counts);
  return row;
}

export const railStanding = window.matchMedia("(min-width: 1024px)");

export function fillSidebar(): void {
  const host = el("newcardhost");
  if (host.childElementCount === 0) host.appendChild(buildNewCardForm());
  loadDecks().catch(() => undefined);
}

export function openSidebar(): void {
  fillSidebar();
  if (railStanding.matches) {
    el("sidebar").querySelector<HTMLElement>("button:not([hidden]), input")?.focus();
    return;
  }
  document.body.classList.add("sidebar-open");
  for (const t of sidebarToggles) t.setAttribute("aria-expanded", "true");
}

export function closeSidebar(): void {
  document.body.classList.remove("sidebar-open");
  for (const t of sidebarToggles) t.setAttribute("aria-expanded", "false");
}

railStanding.addEventListener("change", (event) => {
  if (event.matches) fillSidebar();
  else closeSidebar();
});

for (const t of sidebarToggles) {
  t.addEventListener("click", () => {
    if (document.body.classList.contains("sidebar-open")) closeSidebar();
    else openSidebar();
  });
}
el("sidebarclose").addEventListener("click", closeSidebar);
el("sidebarscrim").addEventListener("click", closeSidebar);
el("dashboardlink").addEventListener("click", () => void openDashboard());
el("settingslink").addEventListener("click", () => {
  closeSidebar();
  void openSettings();
});

const installButton = el<HTMLButtonElement>("installapp");
const installNote = el("installnote");

const install = watchForInstall({
  setAvailable(available) {
    installButton.hidden = !available;
    if (!available) return;
    const where = installOrigin();
    installNote.textContent = where.durable ? "" : `⚠ ${where.why}`;
    installButton.classList.toggle("is-risky", !where.durable);
  },
  say,
});

installButton.addEventListener("click", () => {
  closeSidebar();
  void install.install();
});

registerServiceWorker();

const syncDot = el<HTMLButtonElement>("syncdot");
const syncDotText = el("syncdottext");
const syncDetail = el("syncdetail");
let syncStatus: SyncStatus = initialStatus();

const SYNC_ICON: Readonly<Record<string, IconName>> = {
  ok: "cloud-check-fill",
  stale: "cloud-check",
  never: "cloud-slash",
  failed: "cloud-x",
  offline: "cloud-warning",
  behind: "cloud-arrow-down",
  syncing: "arrows-clockwise",
};

function paintSync(): void {
  const label =
    syncStatus.state === "syncing"
      ? "syncing…"
      : syncStatus.state === "failed"
        ? `sync failed — ${syncStatus.detail ?? "unknown"}`
        : syncStatus.state === "behind"
          ?
            syncStatus.peers === 1
              ? "another device has newer grades — sync, or you will be re-asked cards"
              : `${syncStatus.peers} devices have newer grades — sync, or you will be re-asked cards`
          : sinceLabel(syncStatus.lastSyncedAt);
  const shown =
    syncStatus.state === "ok" && isStale(syncStatus) ? "stale" : syncStatus.state;
  syncDot.dataset["state"] = shown;
  const glyph = syncDot.querySelector("i");
  if (glyph !== null && glyph.dataset["shown"] !== shown) {
    glyph.dataset["shown"] = shown;
    glyph.replaceChildren(icon(SYNC_ICON[shown] ?? "cloud-slash"));
  }
  syncDot.title = label;
  syncDot.setAttribute("aria-label", label);
  syncDotText.textContent = label;
  const sent = syncStatus.state === "syncing" ? null : agoLabel(lastPushedAt());
  syncDetail.textContent = sent === null ? label : `${label} · grades sent ${sent}`;
}

const syncPorts: SyncPorts = {
  async exportPayload() {
    const reply = await ask<"syncExport">({ kind: "syncExport" });
    return { json: reply.json, bytes: reply.bytes, mark: reply.mark, index: reply.index };
  },
  async exportDelta(after: number, sent?: string) {
    const reply = await ask<"syncDelta">({ kind: "syncDelta", after, ...(sent === undefined ? {} : { sent }) });
    return {
      json: reply.json,
      bytes: reply.bytes,
      mark: reply.mark,
      count: reply.count,
      edits: reply.edits,
      ...(reply.index === undefined ? {} : { index: reply.index }),
    };
  },
  async exportIndex() {
    const reply = await ask<"syncExport">({ kind: "syncExport", indexOnly: true });
    return reply.index;
  },
  async mergePayload(payload: unknown) {
    const reply = await ask<"syncMerge">({ kind: "syncMerge", payload });
    return {
      reviewsAdded: reply.reviewsAdded,
      flagsTaken: reply.flagsTaken,
      trackStateTaken: reply.trackStateTaken,
      markBefore: reply.markBefore,
      markAfter: reply.markAfter,
    };
  },
};

export function syncProgressText(progress: SyncProgress): string {
  const eta = progress.etaSeconds === null ? "" : ` · ${secondsLeft(progress.etaSeconds)}`;
  switch (progress.stage) {
    case "checking":
      return "syncing · checking the other devices…";
    case "downloading":
      return (
        `syncing · downloading ${progress.peer} of ${progress.peers} · ` +
        `${mib(progress.received)} of ${mib(progress.total)}${eta}`
      );
    case "merging":
      return `syncing · merging ${progress.peer} of ${progress.peers}${eta}`;
    case "sending":
      return `syncing · sending this device's grades${eta}`;
  }
}

export function secondsLeft(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  return s < 60 ? `about ${s} s left` : `about ${Math.round(s / 60)} min left`;
}

async function runSync(): Promise<void> {
  if (syncStatus.state === "syncing") return;
  syncStatus = { ...syncStatus, state: "syncing", detail: null };
  paintSync();
  try {
    const outcome = await syncNow(syncPorts, {
      onProgress: (progress) => say(syncProgressText(progress), false, true),
    });
    syncStatus = {
      state: "ok",
      lastSyncedAt: new Date().toISOString(),
      detail: null,
      peers: outcome.peersMerged,
    };
    paintSync();
    if (outcome.failures.length > 0) {
      say(
        `synced, but ${countOf(outcome.failures.length, "device")} failed — ${outcome.failures[0]}`,
        true,
      );
    } else {
      say(
        outcome.peersMerged === 0
          ? "nothing to merge — this is the only device that has checked in"
          : `synced · ${countOf(outcome.reviewsAdded, "grade")} in · ` +
              `${countOf(outcome.flagsTaken, "card")} changed`,
      );
    }
    if (outcome.reviewsAdded > 0 || outcome.flagsTaken > 0) await refreshAfterOp();
  } catch (error) {
    syncStatus = {
      ...syncStatus,
      state: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
    paintSync();
    say(`sync failed — ${syncStatus.detail ?? ""}`, true);
  }
}

const LIST_TIMEOUT_MS = 8_000;

export type BootSyncResult =
  | { readonly kind: "offline" }
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "current" }
  | { readonly kind: "skipped" }
  | { readonly kind: "merged"; readonly reviewsAdded: number; readonly peers: number; readonly failures: readonly string[] };

export async function syncAtBoot(hooks: {
  readonly onProgress: (progress: SyncProgress) => void;
  readonly signal: AbortSignal;
}): Promise<BootSyncResult> {
  if (navigator.onLine === false) {
    syncStatus = { ...syncStatus, state: "offline" };
    paintSync();
    return { kind: "offline" };
  }
  let listing;
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), LIST_TIMEOUT_MS);
  const stopListing = (): void => timeout.abort();
  hooks.signal.addEventListener("abort", stopListing);
  try {
    listing = await listPeers(timeout.signal);
  } catch (error) {
    if (hooks.signal.aborted) return { kind: "skipped" };
    const detail = timeout.signal.aborted
      ? `no answer from the mailbox in ${LIST_TIMEOUT_MS / 1000} s`
      : error instanceof Error
        ? error.message
        : String(error);
    syncStatus = { ...syncStatus, state: "offline", detail };
    paintSync();
    return { kind: "unreachable", detail };
  } finally {
    window.clearTimeout(timer);
    hooks.signal.removeEventListener("abort", stopListing);
  }

  if (changedPeers(listing).length === 0) {
    await refreshBehind();
    paintSync();
    return { kind: "current" };
  }

  syncStatus = { ...syncStatus, state: "syncing", detail: null };
  paintSync();
  try {
    const outcome = await syncNow(syncPorts, {
      listing,
      push: false,
      onProgress: hooks.onProgress,
      signal: hooks.signal,
    });
    syncStatus = {
      state: "ok",
      lastSyncedAt: new Date().toISOString(),
      detail: null,
      peers: outcome.peersMerged,
    };
    paintSync();
    if (outcome.reviewsAdded > 0 || outcome.flagsTaken > 0 || outcome.trackStateTaken > 0) {
      await ask<"replan">({ kind: "replan" });
    }
    return {
      kind: "merged",
      reviewsAdded: outcome.reviewsAdded,
      peers: outcome.peersMerged,
      failures: outcome.failures,
    };
  } catch (error) {
    if (hooks.signal.aborted) {
      syncStatus = { ...syncStatus, state: syncStatus.lastSyncedAt === null ? "never" : "ok" };
      await refreshBehind();
      paintSync();
      return { kind: "skipped" };
    }
    const detail = error instanceof Error ? error.message : String(error);
    syncStatus = { ...syncStatus, state: "failed", detail };
    paintSync();
    return { kind: "unreachable", detail };
  }
}

export function pushAfterBoot(): void {
  void pushGrades();
}

const PUSH_AFTER_MS = 30_000;

const PUSH_MAX_WAIT_MS = 120_000;
let pushTimer: number | undefined;
let pendingSince: number | undefined;
let pushing = false;

export function schedulePush(): void {
  if (pushTimer !== undefined) clearTimeout(pushTimer);
  const now = Date.now();
  pendingSince ??= now;
  if (now - pendingSince >= PUSH_MAX_WAIT_MS) {
    void pushGrades();
    return;
  }
  pushTimer = window.setTimeout(() => void pushGrades(), PUSH_AFTER_MS);
}

whenEdited(schedulePush);

async function pushGrades(options: { readonly keepalive?: boolean } = {}): Promise<void> {
  pushTimer = undefined;
  pendingSince = undefined;
  if (options.keepalive !== true && (pushing || syncStatus.state === "syncing")) return;
  pushing = true;
  try {
    const sent = await pushGradesNow(syncPorts, options);
    if (sent === "nothing" || options.keepalive === true) return;
    await refreshBehind();
    paintSync();
  } catch {
    paintSync();
  } finally {
    pushing = false;
  }
}

async function refreshBehind(): Promise<void> {
  if (syncStatus.state === "syncing" || syncStatus.state === "failed") return;
  try {
    const newer = await peersNewerThan(syncStatus.lastSyncedAt);
    if (newer > 0) {
      syncStatus = { ...syncStatus, state: "behind", peers: newer };
    } else if (syncStatus.state === "behind") {
      syncStatus = {
        ...syncStatus,
        state: syncStatus.lastSyncedAt === null ? "never" : "ok",
        peers: 0,
      };
    }
  } catch {
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  if (pushTimer === undefined) return;
  clearTimeout(pushTimer);
  void pushGrades({ keepalive: true });
});

syncDot.addEventListener("click", () => void runSync());
el("synclink").addEventListener("click", () => {
  closeSidebar();
  void runSync();
});
paintSync();
void refreshBehind().then(paintSync);
