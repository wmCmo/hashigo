/**
 * THE CARD GALLERY — his #6: *"once you click the deck … the main screen goes to
 * the card gallery, imagine a notion gallery database view"*.
 *
 * Moved out of `main.ts` on 2026-09-25.
 */

import type { BrowseHit } from "./protocol.js";
import { el } from "./dom.js";
import { shell } from "./shell.js";
import { closeSidebar, deckIndex } from "./sidebar.js";
import { ask } from "./worker-client.js";
import { confirmDelete, openEditorById, runCardOp } from "./ops.js";

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

const gallery: GalleryState = { deckId: null, query: "", sort: "name", includeArchived: true };
const galleryGrid = el("gallerygrid");
const galleryTitle = el("gallerytitle");
const galleryCount = el("gallerycount");
const gallerySearch = el<HTMLInputElement>("gallerysearch");
let galleryToken = 0;

export async function openGallery(deckId: string | null): Promise<void> {
  gallery.deckId = deckId;
  document.body.setAttribute("data-view", "gallery");
  closeSidebar();
  const deck = deckIndex.find((entry) => entry.id === deckId);
  galleryTitle.textContent = deck?.path ?? "everything";
  await paintGallery();
}

function closeGallery(): void {
  document.body.setAttribute("data-view", "review");
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
  });
  if (token !== galleryToken) return;

  let hits = [...reply.hits];
  if (!gallery.includeArchived) hits = hits.filter((hit) => !hit.archived);
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
  for (const hit of hits) galleryGrid.appendChild(galleryCard(hit));
  if (hits.length === 0) {
    const empty = document.createElement("p");
    empty.className = "gallery-empty";
    empty.textContent = gallery.query === "" ? "no cards here" : `nothing matching ${gallery.query}`;
    galleryGrid.appendChild(empty);
  }
}

function galleryCard(hit: BrowseHit): HTMLElement {
  const tile = document.createElement("article");
  tile.className = "gcard";
  if (hit.archived) tile.classList.add("is-archived");
  // Pin and archive are INDEPENDENT (see the worker's `pin` case), so a tile can
  // legitimately carry both marks and the meta line has to be able to say both.
  if (hit.pinned) tile.classList.add("is-pinned");

  const name = document.createElement("h3");
  name.className = "gcard-name";
  name.textContent = hit.name === "" ? hit.cardId : hit.name;
  const meta = document.createElement("p");
  meta.className = "gcard-meta";
  meta.textContent = [hit.deckPath, hit.pinned ? "pinned" : null, hit.archived ? "archived" : null]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
  tile.append(name, meta);
  if (hit.snippet !== null && hit.snippet !== "") {
    const snip = document.createElement("p");
    snip.className = "gcard-snippet";
    snip.textContent = hit.snippet;
    tile.appendChild(snip);
  }

  // EVERY operation as a BUTTON, not only as a shortcut. His standing rule: any
  // 操作 available on the desktop must be available on mobile, and a phone has no
  // shift+P.
  const bar = document.createElement("div");
  bar.className = "gcard-ops";
  const ops: readonly (readonly [string, () => void])[] = [
    ["preview", () => void shell().openPreview(hit.cardId)],
    ["edit", () => void openEditorById(hit.cardId)],
    [
      hit.pinned ? "unpin" : "pin",
      () => void runCardOp(hit.pinned ? "unpin" : "pin", hit.cardId),
    ],
    [
      hit.archived ? "unarchive" : "archive",
      () => void runCardOp(hit.archived ? "unarchive" : "archive", hit.cardId),
    ],
    ["duplicate", () => void runCardOp("duplicate", hit.cardId)],
    ["delete", () => void confirmDelete(hit.cardId, hit.name)],
  ];
  for (const [label, run] of ops) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gcard-op";
    if (label === "delete") button.classList.add("danger");
    button.textContent = label;
    button.addEventListener("click", run);
    bar.appendChild(button);
  }
  tile.appendChild(bar);
  tile.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".gcard-ops") !== null) return;
    void shell().openPreview(hit.cardId);
  });
  return tile;
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
