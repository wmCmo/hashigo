import type { BrowseHit } from "./protocol.js";
import { el } from "./dom.js";
import { shell } from "./shell.js";
import { closeSidebar, deckIndex, loadDecks } from "./sidebar.js";
import { ask } from "./worker-client.js";
import { confirmDelete, openEditorById, runCardOp } from "./ops.js";
import { icon, setIcon, type IconName } from "./icons.js";
import { bareLayer, closeIfTop, closeTop, layers, pushLayer } from "./layers.js";
import { paintDeckReview } from "./focus.js";

type SortKey = "name" | "relevance";

interface GalleryState {
  deckId: string | null;
  query: string;
  sort: SortKey;
  includeArchived: boolean;
}

const gallery: GalleryState = { deckId: null, query: "", sort: "name", includeArchived: false };
const galleryGrid = el("gallerygrid");
const galleryTitle = el("gallerytitle");
const galleryCount = el("gallerycount");
const gallerySearch = el<HTMLInputElement>("gallerysearch");
let galleryToken = 0;

const GALLERY_STATE = "hashigoGallery";

function galleryHash(deckId: string | null): string {
  return deckId === null ? "#everything" : `#deck/${encodeURIComponent(deckId)}`;
}

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
  if (deckId !== undefined) {
    void openGallery(deckId, { fromHistory: true });
    return;
  }
  if (document.body.getAttribute("data-view") !== "gallery") return;
  if (layers.length > 0) {
    closeTop();
    history.pushState({ [GALLERY_STATE]: gallery.deckId }, "", galleryHash(gallery.deckId));
    return;
  }
  closeGallery();
});

export async function openGalleryFromUrl(): Promise<void> {
  const deckId = deckFromHash(location.hash);
  if (deckId === undefined) return;
  await loadDecks();
  if (deckId !== null && !deckIndex.some((deck) => deck.id === deckId)) {
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
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
    suggest: false,
    visited: [],
    includeArchived: gallery.includeArchived,
  });
  if (token !== galleryToken) return;

  const hits = [...reply.hits];
  if (gallery.sort === "name") hits.sort((a, b) => a.name.localeCompare(b.name, "ja"));
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
  if (hit.pinned) tile.classList.add("is-pinned");

  const label = hit.name === "" ? hit.cardId : hit.name;
  const name = document.createElement("h3");
  name.className = "gcard-name";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "gcard-open";
  open.textContent = label;
  open.addEventListener("click", () => void shell().openPreview(hit.cardId));
  name.appendChild(open);

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
