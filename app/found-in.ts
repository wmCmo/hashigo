/**
 * "NEW CARD FROM THIS" — the screen half of `出典` (`src/cards/found-in.ts`).
 *
 * Zach, 2026-10-26: he meets 包帯 in a card's example sentence and makes a card
 * for it, and nothing remembered which card he was on. The action makes the card
 * with that memory attached.
 *
 * ─── THE SELECTION IS REMEMBERED, NOT READ AT CLICK TIME ────────────────────
 *
 * On his phone, tapping `⋯` collapses the selection before the menu opens, so
 * reading `getSelection()` when the item is pressed gets nothing. Every non-empty
 * selection inside a card is kept as it happens, and the action takes it only if
 * it is still in the card being acted on — a range from the previous card is in
 * nodes that have left the document, and `host.contains` says no.
 *
 * ─── FURIGANA IS NOT PART OF THE WORD ───────────────────────────────────────
 *
 * A selection across `<ruby>` includes the `<rt>` text in `toString()` —
 * 包帯ほうたい. Both the word and the sentence are read from a CLONE with `rt` and
 * `rp` removed.
 */
import { layers } from "./layers.js";
import { openNewCardDialog } from "./ops.js";
import type { PreparedCard } from "../src/review/index.js";

let remembered: Range | null = null;

/** The review card, as `main.ts` holds it — set once at startup. */
let reviewCard: () => { readonly host: Element; readonly prepared: PreparedCard | null } = () => ({
  host: document.body,
  prepared: null,
});
export function setReviewCard(get: typeof reviewCard): void {
  reviewCard = get;
}

/** Which card a node is on: a preview layer's, else the review card's. */
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

/**
 * THE BUTTON AT THE SELECTION. Zach, 2026-10-26: *"it's just that when i select,
 * i don't see `...`"* — he selected 濃紺 and expected the action THERE, not in a
 * menu he had to know about. So a selection inside a card puts `+ new card` just
 * BELOW it: below, because his phone's own Copy/Share bar sits above.
 *
 * It acts on `pointerdown` with `preventDefault`, because on a touch screen the
 * tap that reaches a button first collapses the selection, and a button that
 * vanished on collapse would never receive its click. The selection is
 * remembered anyway (`remembered`), so the word survives either way.
 */
const floater = document.createElement("button");
floater.type = "button";
floater.className = "selection-newcard";
floater.textContent = "+ new card";
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
// Keyboard: Tab to it and Enter. A pointer press already acted on `pointerdown`.
floater.addEventListener("click", (event) => {
  if ((event as PointerEvent).pointerType === "" || event.detail === 0) fire(event);
});

document.addEventListener("selectionchange", () => {
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    // Not at once: on a phone the collapse can land before the tap reaches us.
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

// A scroll moves the text from under a fixed button; drop it rather than chase.
document.addEventListener("scroll", () => (floater.hidden = true), { capture: true, passive: true });

/**
 * Text of a fragment or element without its furigana, whitespace folded. The
 * `<ojad>` line (decision 43) goes too unless it IS the source: it sits in the
 * same paragraph as `例文` and spells the sentence again in kana.
 */
function plain(source: Node): string {
  const holder = document.createElement("div");
  holder.appendChild(source instanceof DocumentFragment ? source : source.cloneNode(true));
  const own = holder.firstElementChild?.classList.contains("hashigo-ojad") === true;
  for (const drop of holder.querySelectorAll(own ? "rt, rp" : "rt, rp, .hashigo-ojad")) drop.remove();
  return (holder.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** What he selected inside `host`, and the sentence around it. Empty when nothing is. */
export function pickedIn(host: Element): { readonly word: string; readonly sentence: string } {
  const range = remembered;
  if (range === null || !host.contains(range.commonAncestorContainer)) return { word: "", sentence: "" };
  const word = plain(range.cloneContents());
  if (word === "") return { word: "", sentence: "" };
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  // A generated span first: `例文` is one, and its paragraph also holds the OJAD line.
  const block = start?.closest(".hashigo-generator, blockquote, p, li, td, .hashigo-side") ?? null;
  let sentence = block === null ? "" : plain(block);
  // A side with several lines: keep the sentence that holds the word.
  if (sentence.length > 160) {
    const pieces = sentence.split(/(?<=[。！？!?])/);
    sentence = pieces.find((piece) => piece.includes(word))?.trim() ?? sentence.slice(0, 160);
  }
  return { word, sentence };
}

/** Open the creator for a card found in `prepared`, from whatever is selected in `host`. */
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
