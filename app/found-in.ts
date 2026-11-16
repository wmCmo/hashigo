import { prependIcon } from "./icons.js";
import { layers } from "./layers.js";
import { openNewCardDialog } from "./ops.js";
import type { PreparedCard } from "../src/review/index.js";

let remembered: Range | null = null;

let reviewCard: () => { readonly host: Element; readonly prepared: PreparedCard | null } = () => ({
  host: document.body,
  prepared: null,
});
export function setReviewCard(get: typeof reviewCard): void {
  reviewCard = get;
}

function cardOf(node: Node): { host: Element; prepared: PreparedCard } | null {
  for (const layer of [...layers].reverse()) {
    if (layer.ops && layer.prepared !== null && layer.root.contains(node)) {
      return { host: layer.root, prepared: layer.prepared };
    }
  }
  const review = reviewCard();
  return review.prepared !== null && review.host.contains(node)
    ? { host: review.host, prepared: review.prepared }
    : null;
}

const floater = document.createElement("button");
floater.type = "button";
floater.className = "selection-newcard";
floater.textContent = "new card";
prependIcon(floater, "plus");
floater.hidden = true;
document.body.appendChild(floater);
let floaterFor: { host: Element; prepared: PreparedCard } | null = null;
let hideTimer: number | undefined;

const fire = (event: Event): void => {
  event.preventDefault();
  const target = floaterFor;
  floater.hidden = true;
  if (target !== null) newCardFrom(target.host, target.prepared);
};
floater.addEventListener("pointerdown", fire);
floater.addEventListener("click", (event) => {
  if ((event as PointerEvent).pointerType === "" || event.detail === 0) fire(event);
});

document.addEventListener("selectionchange", () => {
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => (floater.hidden = true), 300);
    return;
  }
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  if (element === null || element.closest(".hashigo-side") === null) return;
  remembered = range.cloneRange();
  const card = cardOf(node);
  if (card === null || plain(range.cloneContents()) === "") return;
  window.clearTimeout(hideTimer);
  floaterFor = card;
  const box = range.getBoundingClientRect();
  floater.hidden = false;
  const width = floater.offsetWidth;
  const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), window.innerWidth - width - 8);
  floater.style.left = `${left}px`;
  floater.style.top = `${Math.min(box.bottom + 8, window.innerHeight - floater.offsetHeight - 8)}px`;
});

document.addEventListener("scroll", () => (floater.hidden = true), { capture: true, passive: true });

function plain(source: Node): string {
  const holder = document.createElement("div");
  holder.appendChild(source instanceof DocumentFragment ? source : source.cloneNode(true));
  const own = holder.firstElementChild?.classList.contains("hashigo-ojad") === true;
  for (const drop of holder.querySelectorAll(own ? "rt, rp" : "rt, rp, .hashigo-ojad")) drop.remove();
  return (holder.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function pickedIn(host: Element): { readonly word: string; readonly sentence: string } {
  const range = remembered;
  if (range === null || !host.contains(range.commonAncestorContainer)) return { word: "", sentence: "" };
  const word = plain(range.cloneContents());
  if (word === "") return { word: "", sentence: "" };
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const block = start?.closest(".hashigo-generator, blockquote, p, li, td, .hashigo-side") ?? null;
  let sentence = block === null ? "" : plain(block);
  if (sentence.length > 160) {
    const pieces = sentence.split(/(?<=[。！？!?])/);
    sentence = pieces.find((piece) => piece.includes(word))?.trim() ?? sentence.slice(0, 160);
  }
  return { word, sentence };
}

export function newCardFrom(host: Element, prepared: PreparedCard): void {
  const { word, sentence } = pickedIn(host);
  openNewCardDialog({
    name: word,
    deckId: prepared.loaded.deckId,
    templateId: prepared.loaded.templateId,
    onCreated: () => undefined,
    source: { cardId: prepared.loaded.id, name: prepared.loaded.name, sentence },
  });
}
