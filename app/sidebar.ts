/**
 * THE SIDEBAR — the deck tree, the templates group, the sync indicator and the
 * install prompt. His request 5 and the navigation half of #2 and #14.
 *
 * Moved out of `main.ts` on 2026-09-25. It OWNS the two lists the rest of the app
 * reads — `deckIndex` and `templateChoices` — and `loadDecks` is the only thing
 * that writes them. Exported as live bindings, so a reader always sees the latest
 * list, and an import cannot be assigned to, so the owner stays the only writer.
 */

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
  type SyncPorts,
  type SyncProgress,
} from "./sync-client.js";
import { openTemplateEditor } from "./template-editor.js";
import { mib, openPrompt, say } from "./ui.js";
import { ask } from "./worker-client.js";
import { refreshAfterOp } from "./ops.js";
import { openDeckMenu, runDeckOp } from "./deck-menu.js";
import { openSettings } from "./settings.js";

/**
 * *"a side bar to navigate, which is a space where we create cards, navigate the
 * card gallery"*.
 *
 * **The browsing half is built; CREATE is not, and that is not laziness.**
 * `notes/crud-audit.md`: nothing outside the importer creates a card, and unlike
 * delete — where the schema is already complete, every foreign key at `cards`
 * being `ON DELETE CASCADE` — create is blocked on a real decision that is Zach's.
 * **What id does a card made in Hashigo get?** Mochi's are 8-character opaque
 * strings and decision 16 leaves exactly ONE more import to collide with. The
 * panel says that, by name, rather than showing a button that does nothing.
 *
 * ─── IT OPENS ON THE LEFT, WHICH IS THE ONE PLACE IT CAN GO ────────────────
 *
 * Decision 23 put the replay button bottom-RIGHT because he reviews one-handed
 * with his right thumb. A navigation drawer on the right would sit under that
 * thumb and be opened by accident mid-review, which is the worst failure a
 * navigation control can have here — it would interrupt a card he is holding an
 * answer for. Left, and reachable deliberately.
 *
 * ─── CLICKING A RESULT OPENS A PREVIEW LAYER ───────────────────────────────
 *
 * Not a navigation, and not a second card renderer: it is his request 2 reused
 * exactly. Browsing to a card and following a link to a card are the same act, so
 * they get the same surface — decision 30's preview, every side at once.
 */
const sidebarToggle = el<HTMLButtonElement>("sidebartoggle");
const deckList = el("decklist");

/**
 * THE SIDEBAR IS A TREE, AND IT NO LONGER LISTS CARDS.
 *
 * *"showing cards on the sidebar is pointless, i have like 10,000+ cards, it's
 * better to use obsidian style search"* — so the card list that shipped this
 * morning is gone. What is left is navigation: decks, nested and collapsible
 * (*"nesting deck on the side bar should be togglable"*), templates beside them
 * (*"why are templates not nesting like notion pages"*), and a way into the
 * dashboard. Finding a card is Ctrl+K's job now; SEEING a set of cards is the
 * gallery's.
 *
 * Expansion state lives in `localStorage` because a tree that forgets is a tree
 * he re-opens every session, and 39 decks is small enough that the whole map fits
 * in one key.
 */
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
    /* a full localStorage costs the memory, not the session */
  }
}

export let deckIndex: readonly DeckBrief[] = [];
export let templateChoices: readonly TemplateBrief[] = [];
let decksLoaded = false;
let decksLoading: Promise<void> | null = null;
const expanded = readExpanded();

/**
 * LOADED IS RECORDED ON SUCCESS, NOT ON ASKING. The flag used to be set before
 * the request, so a request that failed — the rail filling itself while the
 * worker was still opening the database, e.g. a window that crossed 1024px
 * during boot (`railStanding`'s listener below) — left the tree EMPTY and every
 * later call returning early. That was "the sidebar is empty after boot until
 * `/` is pressed" (NEXT.md, 2026-09-18): only `/`'s forced reload ever repaired
 * it. A failure now leaves the flag down, so the next call simply tries again —
 * and boot's own `fillSidebar`, which runs after `open`, is that next call.
 * Concurrent calls share one request rather than racing two paints.
 */
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

/**
 * Adapters over `./deck-tree.js`, which owns the walk and is tested in Node.
 *
 * The recursion used to live here with no cycle guard. It did not need one — nothing
 * in `deckOp` can reparent a deck — but request 14's deck CRUD will grow a MOVE, and
 * an unguarded walk kills the page on load rather than misdrawing a total. The guard
 * and its two tests cost less than diagnosing that once.
 */
export function childrenOf(parentId: string | null): readonly DeckBrief[] {
  return treeChildrenOf(deckIndex, parentId);
}

/**
 * Cards in this deck AND everything under it, which is what a parent should say.
 *
 * `truncated` is reported ONCE per session rather than discarded. A guard that
 * silently returns a wrong-but-safe number is how "the sidebar totals are a bit off"
 * becomes a week of confusion — and a cycle in the deck graph is a data bug worth
 * hearing about, not a rendering detail.
 */
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

  // CREATE, the letter of his #14 that had no route at all. At the root, because a
  // sub-deck is made from its parent's menu and a top-level deck has no parent to
  // hang the action off.
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

  // Templates, as their own collapsible group — his #2. They are not decks and do
  // not nest into them, but they are the other thing he navigates by.
  const group = document.createElement("div");
  group.className = "tree-group";
  const header = navRow(`templates`, templateChoices.length, 0, 0, "__templates__", true);
  // The WHOLE row toggles, not only its caret. A deck row's label opens the deck and
  // its caret folds it, so the two need separate targets; this row has nothing to
  // open, and a full-width button that ignores a click on its own name reads as broken.
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
  }
  deckList.appendChild(group);
}

function deckNode(deck: DeckBrief, depth: number): HTMLElement {
  const wrap = document.createElement("div");
  const kids = childrenOf(deck.id);
  const under = subtreeCards(deck);
  const row = navRow(deck.name, under.cards, under.due, depth, kids.length > 0 ? deck.id : null, false);
  if (deck.archived) row.classList.add("is-archived");

  // A VISIBLE HANDLE, not only a right-click. Deck operations used to be reachable
  // by `contextmenu` alone, which on his phone is nothing at all — and the phone is
  // where he reviews. His standing rule is that every 操作 on the desktop exists on
  // mobile; a gesture with no mobile equivalent is the exact failure it names.
  //
  // A `<span>` rather than a `<button>`: `navRow` returns a `<button>` and a button
  // inside a button is invalid, which browsers repair by hoisting it OUT of the row.
  // The twist control is a span for the same reason.
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
    // アイコンの SVG が target になるので、クラスではなく祖先で見る。
    if (hit.closest(".tree-twist, .tree-more") !== null) return;
    void openGallery(deck.id);
  });
  // Kept as an accelerator, now that it is not the only route.
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
      // His #5: TOGGLABLE. Stop the click reaching the row, or opening a deck and
      // collapsing it would be the same gesture.
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
  // The pair has no room for words on a 330px rail, so the words go where a reader
  // that needs them looks: the pointer's tooltip and the accessible name. `744 · 5950`
  // is due TRACKS beside CARDS — the dashboard's `7,726/11,050` for the same deck is
  // tracks learned of tracks live, a third quantity, and neither said which it was.
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

/**
 * THE RAIL STANDS AT ≥1024px — and two things in here assumed a drawer.
 *
 * The breakpoint is named once, in JS and in CSS, and they have to agree: the
 * stylesheet's composition block at the end of `style.css` carries the reasoning
 * for the number. 1024 is the width at which a 330px rail plus a 720px card
 * column plus air still fits, and below it the drawer is the honest answer.
 *
 * **`openSidebar` was the only thing that ever filled the sidebar.** That was
 * right while opening was the only way to see it, and wrong the moment the rail
 * is on screen from boot — it would stand there empty until he pressed a key
 * that visibly does nothing. So filling is split out and boot calls it.
 */
export const railStanding = window.matchMedia("(min-width: 1024px)");

export function fillSidebar(): void {
  const host = el("newcardhost");
  if (host.childElementCount === 0) host.appendChild(buildNewCardForm());
  // Caught, not dropped: before `open` this rejects, and the next fill retries.
  loadDecks().catch(() => undefined);
}

export function openSidebar(): void {
  fillSidebar();
  // The rail is already on screen, so `/` cannot mean "open it". It means "put
  // me in it" — a key that does nothing visible reads as a broken key.
  if (railStanding.matches) {
    el("sidebar").querySelector<HTMLElement>("button:not([hidden]), input")?.focus();
    return;
  }
  document.body.classList.add("sidebar-open");
  sidebarToggle.setAttribute("aria-expanded", "true");
}

export function closeSidebar(): void {
  document.body.classList.remove("sidebar-open");
  sidebarToggle.setAttribute("aria-expanded", "false");
}

// Crossing the breakpoint with a window drag: the rail has to fill itself on the
// way up, and shed the drawer class on the way down so a later resize does not
// find it open behind a scrim that the composition block has hidden.
railStanding.addEventListener("change", (event) => {
  if (event.matches) fillSidebar();
  else closeSidebar();
});

sidebarToggle.addEventListener("click", () => {
  if (document.body.classList.contains("sidebar-open")) closeSidebar();
  else openSidebar();
});
el("sidebarclose").addEventListener("click", closeSidebar);
el("sidebarscrim").addEventListener("click", closeSidebar);
el("dashboardlink").addEventListener("click", () => void openDashboard());
el("settingslink").addEventListener("click", () => {
  closeSidebar();
  void openSettings();
});

/* ── "add to home screen" (his PWA ask, 2026-09-12) ─────────────────────────
 *
 * The button is hidden until `beforeinstallprompt` fires, so it is never a dead
 * control. The NOTE under it is the part that earns its place: OPFS is keyed by
 * ORIGIN and an install pins the origin, so installing from a quick tunnel — a
 * new random hostname every run — produces a home-screen icon pointing at a host
 * that will not exist tomorrow, and a second empty database if it ever did. */
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

/* ── stage 11: sync, and the indicator that says whether it happened ────────
 *
 * Zach, 2026-09-12, after archiving 数字 on his phone for the second time:
 * *"on desktop it's still not archived, can we add icon or any visual to show
 * the sync status"*. The archive was never the bug — there was no transport at
 * all, and nothing on screen said so. An absent sync has to LOOK absent. */
const syncDot = el<HTMLButtonElement>("syncdot");
const syncDotText = el("syncdottext");
const syncDetail = el("syncdetail");
let syncStatus: SyncStatus = initialStatus();

/** Which icon each state wears. Filled means "fine"; the glyph inside says the rest. */
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
          ? // NAMES THE CONSEQUENCE, not the state. "behind" is jargon; "you will
            // be asked cards you have already answered" is the thing he noticed
            // on his own, one card at a time, before the dot said anything.
            `${syncStatus.peers} device(s) have newer grades — sync, or you will be re-asked cards`
          : sinceLabel(syncStatus.lastSyncedAt);
  // "stale" is not a state the client returns — it is `ok` that has aged past a
  // day, and the dot shows it hollow because at that point his two devices hold
  // grades neither has seen.
  const shown =
    syncStatus.state === "ok" && isStale(syncStatus) ? "stale" : syncStatus.state;
  syncDot.dataset["state"] = shown;
  // AN ICON PER STATE, so the SHAPE says it (2026-09-26). "Synced" and "failed"
  // were both filled circles — green and red — and in his phone's black-and-white
  // bedroom mode they were the same dot. Colour still repeats the meaning; it no
  // longer carries it alone.
  const glyph = syncDot.querySelector("i");
  if (glyph !== null && glyph.dataset["shown"] !== shown) {
    glyph.dataset["shown"] = shown;
    glyph.replaceChildren(icon(SYNC_ICON[shown] ?? "cloud-slash"));
  }
  syncDot.title = label;
  syncDot.setAttribute("aria-label", label);
  syncDotText.textContent = label;
  // THE DETAIL ROW SAYS BOTH CLOCKS, BECAUSE THEY ARE DIFFERENT FACTS and the
  // difference is exactly what cost him a day. "synced" means this device pulled
  // everyone and pushed; "sent" means only that its own grades are in the
  // mailbox, which is the automatic half (`schedulePush`) and the half that
  // protects work he cannot reconstruct. A device can be hours from its last
  // full sync and still have every grade safely off it — that reads as a problem
  // unless the row says so.
  const sent = syncStatus.state === "syncing" ? null : agoLabel(lastPushedAt());
  syncDetail.textContent = sent === null ? label : `${label} · grades sent ${sent}`;
}

const syncPorts: SyncPorts = {
  async exportPayload() {
    const reply = await ask<"syncExport">({ kind: "syncExport" });
    return { json: reply.json, bytes: reply.bytes, mark: reply.mark };
  },
  async exportDelta(after: number) {
    const reply = await ask<"syncDelta">({ kind: "syncDelta", after });
    return { json: reply.json, bytes: reply.bytes, mark: reply.mark, count: reply.count };
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

/**
 * 手動同期の進み具合を、どの画面にも出る一行（`say`）で言う。Zach, 2026-10-09:
 * *"when you click the cloud icon to sync … so you know how long it would take"*。
 * 雲のアイコンは回るだけで、何秒待つのかは言わなかった。
 */
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

/** 秒の粒度で言う — 同期は分単位にならない。 */
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
    // A peer that could not be merged is reported rather than swallowed — the
    // sync still completed for everyone else, and that distinction matters.
    if (outcome.failures.length > 0) {
      say(`synced, but ${outcome.failures.length} peer(s) failed — ${outcome.failures[0]}`, true);
    } else {
      say(
        outcome.peersMerged === 0
          ? "nothing to merge — this is the only device that has checked in"
          : `synced · ${outcome.reviewsAdded} grades in · ${outcome.flagsTaken} cards changed`,
      );
    }
    // A merge can change what is due and what is archived, so the queue the
    // screen is holding may no longer be the right one.
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

/**
 * 起動時の同期 — Zach, 2026-10-09。
 *
 * *"when you open the app and it has not been synced it won't let you go through
 * the page at all … what's the point of having the first waiting page if you have
 * to go inside the app and tap the sync button again"*。
 *
 * ─── 受け取るのは最初のカードの前、送るのは後 ────────────────────────────────
 *
 * 手動同期が自動化されなかった理由は二つで、どちらも「カードの途中」の話だった：
 * マージ中は 8 秒画面が固まる、そしてマージで due が手元のカードの下で動く。起動
 * 画面ではどちらも起きない — まだカードが無い。だからここで引き、終わったら計画を
 * 組み直す（`replan`）。`open` が組んだ計画のままだと、電話で答えたカードをまた
 * 聞かれる。2026-09-14 の重複と同じもの。
 *
 * 送る方（書き出し＋PUT）は待たせない。`pushAfterBoot` が最初のカードの後に送る。
 *
 * ─── 圏外なら止めない ────────────────────────────────────────────────────────
 *
 * 彼の言葉どおり「先に進ませない」のは、届く mailbox があって新しい採点がある時
 * だけ。電車で圏外なら、手元のデータで復習できるのがローカルファーストの意味で、
 * 起動画面で永遠に待たせたら app が使えない。だから：
 *   - `navigator.onLine` が false → すぐ通す
 *   - 一覧が `LIST_TIMEOUT_MS` で返らない／届かない → 通す（起動ログにそう書く）
 *   - ダウンロードが止まった（`STALL_AFTER_MS`）→ 「同期せずに開く」を出す
 * マージが始まったら終わるまで待つ。トランザクションの途中で離れても、ワーカー
 * はそれを終えるまで次の要求を処理しないので、待つ時間は一秒も減らない。
 */
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
    // 一覧の sha が全部、ここで既にマージしたものと一致した — 受け取る物は無い。
    // それは「同期済み」の受け取る半分そのものなので、そう表示する。
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
    // まだ一枚も採点していないので、組み直しても誰の手元も動かない。
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

/**
 * 起動後、最初のカードが出てから — 前回送れなかった採点があれば送る。
 *
 * 送り残しの判断は印（`readMark`、`src/sync/delta.ts`）で、送るのは差分。送り
 * 残しが無ければワーカーに一度聞くだけで、通信は無い。圏外の電車で採点した分、
 * 閉じた瞬間に届かなかった分は、次に開いた時ここで出ていく。マージで入ってきた
 * 他の端末の採点は、`carryMark` が印を運ぶので送り直さない。
 */
export function pushAfterBoot(): void {
  void pushGrades();
}

/**
 * A GRADE LEAVES THIS DEVICE WITHOUT BEING ASKED TO — Zach, 2026-09-14.
 *
 * *"i already reviewed so many items on my phone today, but it's not reflected on
 * any browser on my pc. we need to fix this. what happens with my ACID😭"*
 *
 * Nothing had gone wrong with the durability. Every grade was committed to the
 * phone's OPFS and every merge rule in `src/sync/merge.ts` was correct — but
 * `runSync` was reachable from TWO CLICK HANDLERS and nothing else, so a day of
 * reviewing sat on one device with the newest mailbox payload **23 hours old**.
 * A sync nobody presses is a sync that does not exist, and decision 33 shipped
 * the transport without ever giving it a trigger.
 *
 * ─── PUSH, NOT SYNC, AND THAT IS THE WHOLE SAFETY ARGUMENT ──────────────────
 *
 * `pushNow` sends and merges nothing. A full `syncNow` pulls every peer first,
 * and the merge is ~8 seconds in the worker that also owns the session — 8
 * seconds of frozen review screen, and a merge that can change what is due
 * under his thumb mid-card. Automating that would trade one silent failure for a
 * louder one. Automating the PUSH protects exactly the thing he cannot
 * reconstruct and touches nothing else, on this device or any other.
 *
 * ─── DEBOUNCED OFF HIS OWN GRADING, NEVER A TIMER ───────────────────────────
 *
 * SPEC problem #1 is battery — *"no polling, no sockets"* — so there is no
 * interval here. The clock starts when he grades and is pushed forward by the
 * next grade — so on its own it sends only after `PUSH_AFTER_MS` with NO grade,
 * which a steady session never reaches (2026-10-10, below: `PUSH_MAX_WAIT_MS`
 * caps it). A device nobody is reviewing on sends nothing at all.
 *
 * ─── AND IT FAILS QUIETLY, WHICH IS DELIBERATE ──────────────────────────────
 *
 * Off the tailnet the PUT cannot land, and that is his NORMAL state on a train.
 * A red banner every 30 seconds would train him to ignore the one that matters.
 * The dot carries it instead — that is what the indicator is for — and the next
 * grade schedules another attempt, so a session that starts offline still sends
 * everything the moment he is home.
 */
const PUSH_AFTER_MS = 30_000;

/**
 * 上の「一定のセッションでも 30 秒ごとに一度送る」は誤りだった — Zach, 2026-10-10。
 *
 * *"i remember i have seen this exact order of cards from last night while i was
 * reviewing on my tablet … after i reviewing them i closed my tablet instantly"*。
 *
 * 採点のたびに `clearTimeout` するので、30 秒を「考える時間」ではなく「採点しない
 * 時間」として数えていた。10 秒に一枚のペースなら、止まるまで一度も送らない。そして
 * 止まった瞬間に閉じると、`visibilitychange` の送信（~350 KB、`keepalive` は 64 KB
 * 上限で使えない）は Android が止めるタブの中で走るだけで、まず届かない。結果、
 * 一晩のセッションがまるごとタブレットに残り、翌朝の電話が同じ順番で同じカードを
 * 出した。
 *
 * だから最初の未送信の採点から `PUSH_MAX_WAIT_MS` 経ったら、連続採点中でも送る。
 * 取り残され得るのは最後の 2 分以内になる。費用は 1 回 ~350 KB（gzip）、20 分の
 * セッションで ~10 回 — 通信量を気にする彼に対して、セッションを丸ごと失うよりは
 * ずっと安い。残る穴（閉じる直前の 2 分）は、その端末を次に開いた時に
 * `pushAfterBoot` が送る。
 */
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

async function pushGrades(options: { readonly keepalive?: boolean } = {}): Promise<void> {
  pushTimer = undefined;
  // この送信がこれまでの未送信分を全部運ぶ — 次の採点から新しい窓。失敗しても
  // 同じ：次の採点が次の試みを予約する（圏外の電車）。
  pendingSince = undefined;
  // Never on top of a full sync: that one pushes too, and the second PUT would
  // race the first with an older export. `keepalive` は例外：ページが隠れる瞬間で、
  // 走っている送信を待つ時間は無い。差分は冪等なので、重なっても壊れない。
  if (options.keepalive !== true && (pushing || syncStatus.state === "syncing")) return;
  pushing = true;
  try {
    // 2026-10-10：差分（数 KB）が既定、編集の後だけ全体。`pushGradesNow` 参照。
    const sent = await pushGradesNow(syncPorts, options);
    if (sent === "nothing" || options.keepalive === true) return;
    // WE ARE ALREADY TALKING TO THE MAILBOX, so ask the one question the push
    // cannot answer: has anyone else left newer work in it? A listing, not a
    // merge — no payload bodies, nothing applied, nothing on screen moves. This
    // is what turns "synced 38m ago" from true-but-useless into a dot that knows
    // it is out of date.
    await refreshBehind();
    paintSync();
  } catch {
    // Quiet on purpose — see the header. `paintSync` still reads the pushed
    // clock, so the indicator tells the truth without interrupting a card.
    paintSync();
  } finally {
    pushing = false;
  }
}

/**
 * Ask the mailbox whether a peer is ahead of this device's last MERGE.
 *
 * Never throws and never downgrades a real status: offline is the normal state
 * of a local-first app, and a listing that could not be fetched is not evidence
 * that anything is wrong. It can only move `ok` to `behind`, or `behind` back to
 * `ok` once he has actually synced.
 */
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
    /* offline, or no mailbox on this server — say nothing */
  }
}

/**
 * The last thing before he closes the tab, and the only place a timer is short.
 *
 * `visibilitychange` to hidden is the strongest "he has stopped" signal a page
 * gets, and on Android it is what fires when he switches apps or locks the
 * screen — the exact moment a debounce that has not elapsed would be lost.
 *
 * NOT `keepalive: true`, which is the usual answer here and does not apply: its
 * body cap is 64 KB and his payload is **1.5 MB**. So this is a best-effort
 * push from a page that is still alive, and the debounce above is what makes it
 * rarely have anything left to do.
 */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  if (pushTimer === undefined) return;
  clearTimeout(pushTimer);
  // 2026-10-10：差分を `keepalive` で。ページが凍っても、閉じられても、ブラウザ
  // が送り切る。上の「keepalive は使えない（1.5 MB）」は全体の話で、差分は数 KB。
  void pushGrades({ keepalive: true });
});

syncDot.addEventListener("click", () => void runSync());
el("synclink").addEventListener("click", () => {
  closeSidebar();
  void runSync();
});
paintSync();
// ON LOAD, BEFORE HE STARTS REVIEWING — the case that cost him the duplicates.
// He opens the laptop hours after the phone last pushed; nothing has been graded
// here yet, so no push has fired and nothing else would ask. A listing is cheap
// enough to spend on every load, and this is the moment the answer is worth
// most: the alternative is finding out one already-answered card at a time.
void refreshBehind().then(paintSync);
