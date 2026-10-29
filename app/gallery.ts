/**
 * THE CARD GALLERY — his #6: *"once you click the deck … the main screen goes to
 * the card gallery, imagine a notion gallery database view"*.
 *
 * Moved out of `main.ts` on 2026-09-25.
 */

import type { BrowseHit } from "./protocol.js";
import { el } from "./dom.js";
import { shell } from "./shell.js";
import { closeSidebar, deckIndex, loadDecks } from "./sidebar.js";
import { ask } from "./worker-client.js";
import { confirmDelete, openEditorById, runCardOp } from "./ops.js";
import { icon, setIcon, type IconName } from "./icons.js";
import { bareLayer, closeIfTop, pushLayer } from "./layers.js";
import { paintDeckReview } from "./focus.js";

/**
 * *"once you click the deck, what happens? the main screen goes to the card
 * gallery, imagine a notion gallery database view, something like that, where you
 * can filter, search, sort, click to preview, edit archive, pin, copy, duplicate,
 * delete, from there"*.
 *
 * It REPLACES the main screen rather than being another layer, because that is
 * what he described and because a gallery is somewhere you stay — layers are for
 * things you look at and dismiss. `data-view` on the body switches them, and
 * going back to review is one control.
 *
 * **The card list that was in the sidebar this morning lives here now** (his #4).
 * A list of 10,000 cards in a 330px drawer was the wrong shape; a filtered,
 * sorted, searchable grid of one deck is the right one.
 */
/**
 * TWO ORDERS, NAMED FOR WHAT THEY DO.
 *
 * This was `"name" | "due" | "created"`, and both extra members were fiction:
 * `BrowseHit` carries no due date and no created stamp, so neither could ever have
 * been sorted on, and the `<select>` offered only two options anyway — with `"due"`
 * LABELLED "relevance". The behaviour was right (fall through to the order `browse`
 * returned, which for a query IS the search ranking) and the name was a lie, which
 * is the kind of thing that reads as a bug for as long as it survives.
 *
 * Sorting by due or created is a real feature and needs the worker to send those
 * fields; it is not a line of page code away, so it is not pretended at here.
 */
type SortKey = "name" | "relevance";

interface GalleryState {
  deckId: string | null;
  query: string;
  sort: SortKey;
  includeArchived: boolean;
}

/**
 * `includeArchived` starts FALSE. An archived card is one he took out of rotation,
 * and a deck listing that opens on them is answering a question he did not ask:
 * 日本語 opened on rows of 数字 tiles named `124652706`, all archived, because
 * digits sort before kana. The checkbox brings them back; decision 47 made the same
 * call for the empty Ctrl+K.
 */
const gallery: GalleryState = { deckId: null, query: "", sort: "name", includeArchived: false };
const galleryGrid = el("gallerygrid");
const galleryTitle = el("gallerytitle");
const galleryCount = el("gallerycount");
const gallerySearch = el<HTMLInputElement>("gallerysearch");
let galleryToken = 0;

/**
 * THE GALLERY HAS A URL — `#deck/<id>`, or `#everything`.
 *
 * Every screen used to live at `/` under the title `梯子 · review`, so a deck could
 * not be reloaded into, bookmarked, or left with the browser's Back — and on his
 * phone Back is the system gesture, which took him out of the app from inside a
 * deck. The gallery is the one VIEW (dashboard, settings and previews are layers,
 * things you look at and dismiss), so it is the one that gets an address.
 *
 * ONE HISTORY ENTRY, whatever happens inside it. Opening the gallery from review
 * pushes; moving to another deck while already in it REPLACES, so Back always
 * means "back to review" rather than walking every deck he clicked through.
 */
const GALLERY_STATE = "hashigoGallery";

function galleryHash(deckId: string | null): string {
  return deckId === null ? "#everything" : `#deck/${encodeURIComponent(deckId)}`;
}

/** The deck a URL names: a string id, null for "everything", undefined for not-the-gallery. */
function deckFromHash(hash: string): string | null | undefined {
  if (hash === "#everything") return null;
  const match = /^#deck\/(.+)$/.exec(hash);
  return match === null ? undefined : decodeURIComponent(match[1] as string);
}

export async function openGallery(
  deckId: string | null,
  options: { readonly fromHistory?: boolean } = {},
): Promise<void> {
  const wasOpen = document.body.getAttribute("data-view") === "gallery";
  const sameDeck = wasOpen && gallery.deckId === deckId;
  gallery.deckId = deckId;
  // A DIFFERENT DECK STARTS AS A SKELETON. Measured in the pane: the new title was
  // up in 1 ms while the grid still held the PREVIOUS deck's cards — 177 ms of
  // English cards under "漢字", 282 ms of a 漢字 card under "単語" — on the laptop,
  // and longer on his phone. Wrong cards under the right title is worse than none.
  // Not on a filter keystroke (`paintGallery` alone): that would flicker per key.
  if (!sameDeck) {
    galleryCount.textContent = "";
    galleryGrid.replaceChildren(...gallerySkeleton());
    galleryGrid.classList.add("is-loading");
    galleryGrid.setAttribute("aria-busy", "true");
  }
  if (options.fromHistory !== true) {
    const state = { [GALLERY_STATE]: deckId };
    if (wasOpen) history.replaceState(state, "", galleryHash(deckId));
    else history.pushState(state, "", galleryHash(deckId));
  }
  document.body.setAttribute("data-view", "gallery");
  closeSidebar();
  const deck = deckIndex.find((entry) => entry.id === deckId);
  galleryTitle.textContent = deck?.path ?? "everything";
  document.title = `梯子 · ${deck?.path ?? "everything"}`;
  await Promise.all([
    paintGallery(),
    paintDeckReview(el("galleryreview"), deckId, deck?.name ?? null),
  ]);
}

function closeGallery(): void {
  document.body.setAttribute("data-view", "review");
}

/**
 * THE URL FOLLOWS THE VIEW, NOT THE OTHER WAY ROUND. Three things leave the gallery
 * — its own `review` button, a deck review started from it (`focus.ts`), and Back —
 * and only the last goes through history. Watching `data-view` catches all three
 * with one rule instead of three call sites that each have to remember: if the
 * gallery's entry is the current one, step back off it (so the next Back does not
 * land on a dead duplicate of review); otherwise just drop the hash.
 */
new MutationObserver(() => {
  if (document.body.getAttribute("data-view") === "gallery") return;
  document.title = "梯子 · review";
  if (deckFromHash(location.hash) === undefined) return;
  const state = history.state as Record<string, unknown> | null;
  if (state !== null && GALLERY_STATE in state) history.back();
  else history.replaceState(null, "", location.pathname + location.search);
}).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });

window.addEventListener("popstate", () => {
  const deckId = deckFromHash(location.hash);
  if (deckId !== undefined) void openGallery(deckId, { fromHistory: true });
  else if (document.body.getAttribute("data-view") === "gallery") closeGallery();
});

/**
 * Boot's half: a reload or a bookmark on `#deck/<id>` opens that deck once the
 * first card is up. The deck list is loaded first because the title is read from
 * it — the rail fills it at ≥1024px, a phone has not loaded it yet.
 */
export async function openGalleryFromUrl(): Promise<void> {
  const deckId = deckFromHash(location.hash);
  if (deckId === undefined) return;
  await loadDecks();
  if (deckId !== null && !deckIndex.some((deck) => deck.id === deckId)) {
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  // The entry the page loaded on becomes REVIEW and the gallery is pushed on top of
  // it, so the history reads the same as if he had opened the deck by hand — and
  // leaving it steps back to review instead of off the end of the app.
  history.replaceState(null, "", location.pathname + location.search);
  await openGallery(deckId);
}

export async function paintGallery(): Promise<void> {
  const token = ++galleryToken;
  const reply = await ask<"browse">({
    kind: "browse",
    query: gallery.query,
    deckId: gallery.deckId,
    limit: 300,
    // FALSE, and that is the point of the flag: an empty gallery is "the cards in this
    // deck", which is a listing. Ordering it by what he opened lately would be a
    // different question answered under the same heading.
    suggest: false,
    visited: [],
    includeArchived: gallery.includeArchived,
  });
  if (token !== galleryToken) return;

  const hits = [...reply.hits];
  if (gallery.sort === "name") hits.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  // PINNED FIRST, IN BOTH ORDERS — including relevance, which is the one that looks
  // arguable. It is not: a pin is a statement about the collection and a ranking is a
  // statement about the query, so the pin is the outer key and the ranking decides
  // ties within each half. A stable sort keeps whatever order arrived underneath,
  // which is `name` above or the search ranking as `browse` returned it.
  hits.sort((a, b) => Number(b.pinned) - Number(a.pinned));

  galleryCount.textContent =
    hits.length < reply.total
      ? `${hits.length} of ${reply.total.toLocaleString()}`
      : `${hits.length.toLocaleString()}`;

  galleryGrid.replaceChildren();
  galleryGrid.classList.remove("is-loading");
  galleryGrid.removeAttribute("aria-busy");
  for (const hit of hits) galleryGrid.appendChild(galleryCard(hit));
  if (hits.length === 0) {
    const empty = document.createElement("p");
    empty.className = "gallery-empty";
    empty.textContent = gallery.query === "" ? "no cards here" : `nothing matching ${gallery.query}`;
    galleryGrid.appendChild(empty);
  }
}

/**
 * Tiles to stand in while a deck's cards load: REAL `galleryCard` tiles with
 * stand-in text of a typical length, so each is the size it will be, and
 * `.gallery-grid.is-loading` paints the text as grey blocks. Their buttons are
 * disabled — a stand-in has no card behind it.
 */
function gallerySkeleton(): HTMLElement[] {
  const tiles: HTMLElement[] = [];
  for (let i = 0; i < 12; i += 1) {
    const tile = galleryCard({
      cardId: "",
      name: i % 3 === 0 ? "〇〇〇〇" : "〇〇",
      deckPath: "〇〇〇/〇〇",
      archived: false,
      pinned: false,
      snippet: null,
      gist: i % 2 === 0 ? "a short gloss of a typical length" : "a gloss",
    });
    for (const button of tile.querySelectorAll("button")) button.disabled = true;
    tiles.push(tile);
  }
  return tiles;
}

function galleryCard(hit: BrowseHit): HTMLElement {
  const tile = document.createElement("article");
  tile.className = "gcard";
  if (hit.archived) tile.classList.add("is-archived");
  // Pin and archive are INDEPENDENT (see the worker's `pin` case), so a tile can
  // legitimately carry both marks and the meta line has to be able to say both.
  if (hit.pinned) tile.classList.add("is-pinned");

  const label = hit.name === "" ? hit.cardId : hit.name;
  const name = document.createElement("h3");
  name.className = "gcard-name";
  // A BUTTON inside the heading, so the tile is reachable from the keyboard. The
  // tile's own click handler still covers the whole surface for a pointer; this is
  // the same action given a focus stop and a name.
  const open = document.createElement("button");
  open.type = "button";
  open.className = "gcard-open";
  open.textContent = label;
  open.addEventListener("click", () => void shell().openPreview(hit.cardId));
  name.appendChild(open);

  // ONE `⋯` instead of six buttons. Every tile used to carry preview · edit · pin ·
  // archive · duplicate · delete, so a 300-card deck put 300 red `delete`s on screen
  // — the loudest thing in the gallery was the one operation that destroys four
  // years of history. Decision 40 moved the review card's operations behind `⋯` for
  // the same reason, and "every 操作 on the desktop exists on mobile" is met by a
  // menu on both.
  const more = document.createElement("button");
  more.type = "button";
  more.className = "gcard-more";
  more.setAttribute("aria-label", `${label} actions`);
  setIcon(more, "dots-three");
  more.addEventListener("click", () => openTileMenu(hit, label));

  const top = document.createElement("div");
  top.className = "gcard-top";
  top.append(name, more);
  tile.appendChild(top);

  if (hit.gist !== null) {
    const gist = document.createElement("p");
    gist.className = "gcard-gist";
    gist.textContent = hit.gist;
    tile.appendChild(gist);
  }
  if (hit.snippet !== null && hit.snippet !== "") {
    const snip = document.createElement("p");
    snip.className = "gcard-snippet";
    snip.textContent = hit.snippet;
    tile.appendChild(snip);
  }

  const meta = document.createElement("p");
  meta.className = "gcard-meta";
  meta.textContent = [hit.deckPath, hit.pinned ? "pinned" : null, hit.archived ? "archived" : null]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
  tile.appendChild(meta);

  tile.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button") !== null) return;
    void shell().openPreview(hit.cardId);
  });
  return tile;
}

/**
 * A tile's `⋯` — the review card's menu (`openCardMenu` in `main.ts`) in shape and
 * wording, so the same card offers the same sentences wherever he opens it. It
 * cannot BE that function: nothing imports `main.ts`, and that one reads the
 * review screen's own flags rather than a hit's.
 */
function openTileMenu(hit: BrowseHit, label: string): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm layer-menu";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `${label} actions`);
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = label;
  const flags = [hit.pinned ? "pinned" : "", hit.archived ? "archived" : ""].filter(
    (flag) => flag !== "",
  );
  const text = document.createElement("p");
  text.textContent =
    flags.length === 0 ? "Nothing flagged on this card." : `Currently ${flags.join(" and ")}.`;
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  const item = (glyph: IconName, name: string, note: string, run: () => void, danger = false): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item has-icon";
    if (danger) button.classList.add("danger");
    const bold = document.createElement("b");
    bold.textContent = name;
    const why = document.createElement("i");
    why.textContent = note;
    button.append(icon(glyph), bold, why);
    button.addEventListener("click", () => {
      closeIfTop(root);
      run();
    });
    list.appendChild(button);
  };

  item("eye", "preview", "every side at once, nothing graded", () => void shell().openPreview(hit.cardId));
  item("pencil-simple", "edit", "the fields, the template, the deck", () => void openEditorById(hit.cardId));
  item(
    hit.pinned ? "push-pin-slash" : "push-pin",
    hit.pinned ? "unpin" : "pin",
    hit.pinned ? "stop keeping it near the top" : "keep it near the top of a search",
    () => void runCardOp(hit.pinned ? "unpin" : "pin", hit.cardId),
  );
  item(
    hit.archived ? "box-arrow-up" : "archive",
    hit.archived ? "unarchive" : "archive",
    hit.archived
      ? "put it back in the queue — its reviews were never touched"
      : "it stops being scheduled. Nothing is deleted and undo puts it back",
    () => void runCardOp(hit.archived ? "unarchive" : "archive", hit.cardId),
  );
  item("copy", "duplicate", "same fields, same deck — its schedule starts fresh", () =>
    void runCardOp("duplicate", hit.cardId),
  );
  item(
    "trash",
    "delete",
    "the card, its fields, its links and ALL of its review history",
    () => confirmDelete(hit.cardId, hit.name),
    true,
  );

  panel.appendChild(list);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  (list.firstElementChild as HTMLElement | null)?.focus();
}

gallerySearch.addEventListener("input", () => {
  gallery.query = gallerySearch.value;
  void paintGallery();
});
el("galleryback").addEventListener("click", closeGallery);
el<HTMLSelectElement>("gallerysort").addEventListener("change", (event) => {
  gallery.sort = (event.target as HTMLSelectElement).value as SortKey;
  void paintGallery();
});
el<HTMLInputElement>("galleryarchived").addEventListener("change", (event) => {
  gallery.includeArchived = (event.target as HTMLInputElement).checked;
  void paintGallery();
});
