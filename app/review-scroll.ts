/**
 * HOW FAR THE PAGE MOVES WHEN A REVEAL PUTS SOMETHING BELOW THE FOLD.
 *
 * ─── HIS REPORT, 2026-09-14 ─────────────────────────────────────────────────
 *
 * *"when review card, clicking next should scrolling the card down because it
 * overflows vertically"*.
 *
 * Decision 34 made the reveal a WALK — side 2's clozes, then side 3, then side 4
 * — and every step ADDS to a page that was already as tall as it needed to be.
 * The controls are pinned to the bottom edge (decision 23), so the button he
 * presses never moves; the thing it reveals arrives off screen and stays there
 * until he scrolls by hand. On a 単語 card that is four presses and three manual
 * scrolls, about a hundred times a day.
 *
 * ─── WHY THIS IS NOT `scrollIntoView` ───────────────────────────────────────
 *
 * `scrollIntoView({ block: "nearest" })` is the obvious answer and it gets two
 * things wrong on this screen, both structural rather than cosmetic:
 *
 *   * **The viewport is not the visible box.** A sticky header sits over the top
 *     of the page and a fixed footer over the bottom of it, so "in view" by the
 *     browser's reckoning includes two bands the reader cannot read. `nearest`
 *     would happily park the answer under the reveal button.
 *   * **It scrolls BOTH ways.** A reveal only ever adds below, so a step that
 *     scrolls UP is always wrong — it is the page yanking him backwards away
 *     from the thing he just asked to see. This returns 0 for every such case
 *     rather than a negative number, so the direction is not a caller's choice.
 *
 * `scroll-margin` would fix the first and not the second.
 *
 * ─── THE RULE, AND WHY IT IS "JUST ENOUGH" ──────────────────────────────────
 *
 * Minimum movement that clears the footer, NOT top-alignment. He is comparing:
 * on a `Reading = true` card the reading he just produced is on the side above
 * the one that appeared, and a step that slams the new side to the top of the
 * window throws the thing being compared against off screen. The exception is a
 * side TALLER than the visible box, where clearing the bottom is impossible and
 * the top edge is the only alignment that shows the beginning of it.
 *
 * NO IMPORTS — the same rule as `./review-steps.ts` and `./review-boundary.ts`,
 * for the same reason: the root `tsconfig.json` excludes `app/`, so a module
 * that imports nothing is reachable from `test/` and one that touches the DOM
 * types is not. `main.ts` measures the boxes; this decides what to do with them.
 */

/**
 * Everything the rule looks at, in VIEWPORT coordinates — the same frame
 * `getBoundingClientRect()` reports in, so the caller does no arithmetic.
 */
export interface RevealViewport {
  /** The first row the reader can read: the bottom edge of the sticky header. */
  readonly top: number;
  /** The last one: the top edge of the fixed footer. */
  readonly bottom: number;
  /** The newly revealed thing. */
  readonly elementTop: number;
  readonly elementBottom: number;
  /** Breathing room to leave between it and whichever edge it is pushed off. */
  readonly gap: number;
}

/**
 * Pixels to scroll DOWN. Zero means leave the page alone.
 *
 * Zero is the answer for all four of the cases that are not "it is below the
 * fold": already fully visible, already scrolled past, a target taller than the
 * window whose top is already up, and a visible box with no room in it (a
 * landscape phone with the keyboard up, where any scroll is a guess).
 */
export function revealScroll(view: RevealViewport): number {
  const room = view.bottom - view.top - 2 * view.gap;
  if (room <= 0) return 0;
  const height = view.elementBottom - view.elementTop;
  const wanted =
    height > room
      ? view.elementTop - view.top - view.gap
      : view.elementBottom - view.bottom + view.gap;
  return wanted > 0 ? Math.round(wanted) : 0;
}
