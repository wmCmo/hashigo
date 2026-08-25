/**
 * IS THE USER TYPING? THE MOST DANGEROUS QUESTION IN THIS APP.
 *
 * `app/main.ts` binds single-key review shortcuts on `document`: `a` archives, `d`
 * opens the delete confirm, `j` and `f` GRADE, space reveals. Grades write a `reviews`
 * row and advance the FSRS schedule, so a shortcut that fires when it should not does
 * not annoy the user — it corrupts the study history the whole app exists to protect.
 *
 * They fired while he typed in the gallery filter box. The near-miss is instructive:
 * two of the three views DID guard their inputs, and `if (reviewView.hidden) return`
 * looked like it covered the third. It did not, because the gallery is shown by
 * `data-view="gallery"` on the body and hidden in CSS — `.review { display: none }` —
 * so the `hidden` PROPERTY stayed false the entire time the gallery was up. Typing
 * "japanese" archived a card and graded it.
 *
 * WHY THIS IS A FUNCTION OVER PROPERTIES RATHER THAN `instanceof`. `main.ts` used
 * `target instanceof HTMLInputElement`, which is correct in one realm and quietly
 * false across realms — an element from an iframe fails every `instanceof` check
 * against the parent's constructors. Reading `tagName` has no such failure mode, and
 * it is testable in Node, which `instanceof HTMLInputElement` is not. That is the
 * whole reason this lives in its own import-free module: the guard that matters most
 * was the one no test could reach.
 *
 * `<select>` is included deliberately. A select consumes letter keys to jump between
 * options, so `a` in the gallery's sort dropdown must not archive a card either.
 */

/** The shape this needs from an event target. `EventTarget` carries none of it. */
export interface KeyTarget {
  readonly tagName?: string | undefined;
  readonly isContentEditable?: boolean | undefined;
}

/**
 * True when the target swallows the keystroke as text, so no single-key shortcut may
 * act on it.
 *
 * `null` is false: a key pressed with nothing focused belongs to the page, which is
 * how every shortcut is meant to be used.
 */
export function isTypingTarget(target: KeyTarget | null | undefined): boolean {
  if (target === null || target === undefined) return false;
  if (target.isContentEditable === true) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The one key that must always reach the page, even from inside a text field: it
 * closes the thing being typed in.
 *
 * Named rather than inlined so the exception is visible next to the rule. Ctrl/meta
 * combinations are handled separately in `main.ts` and are deliberately allowed while
 * typing — ctrl+K over a filter box is a reasonable thing to press.
 */
export function survivesTyping(key: string): boolean {
  return key === "Escape";
}
