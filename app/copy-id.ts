/**
 * CTRL+C WITH NOTHING SELECTED COPIES THE OPEN CARD'S ID. Zach, 2026-11-13:
 * *"when open a card, and nothing is selected, if we do ctrl c, then it copies
 * card's id"*.
 *
 * An id is what every tool around the app takes — `[[name|id]]` links, the
 * `--card` flag of `scripts/sync-set.ts`, a message to a session about one card —
 * and until now the only way to get one was the editor's URL or a payload dump.
 *
 * WHICH card is "open": the top layer when one is up (a preview, or the editor,
 * whose fields are inputs — but a copy with focus in one is a text copy and never
 * reaches here), otherwise the card on the review screen. The gallery and the
 * done screen show no single card, so they copy nothing.
 *
 * NEVER IN THE WAY OF A REAL COPY: any selected text, or focus in a field that
 * takes text, and this steps aside — the browser copies what it would have.
 *
 * Import-free, like `./keys.ts` and `./review-boundary.ts`, so `test/` reaches it.
 */

export interface CopyContext {
  /** `window.getSelection()?.toString()` — what a normal copy would take. */
  readonly selection: string;
  /** Focus is in an input, textarea, select or contenteditable (`isTypingTarget`). */
  readonly typing: boolean;
  /** The top layer's card id, or null with no layer up. "" for a layer with no card. */
  readonly layerCardId: string | null;
  /** The card on the review screen when the review is what is showing, else null. */
  readonly reviewCardId: string | null;
}

/** The id to put on the clipboard instead of the (empty) selection, or null to leave the copy alone. */
export function cardIdToCopy(context: CopyContext): string | null {
  if (context.selection.trim() !== "") return null;
  if (context.typing) return null;
  if (context.layerCardId !== null) return context.layerCardId === "" ? null : context.layerCardId;
  return context.reviewCardId;
}
