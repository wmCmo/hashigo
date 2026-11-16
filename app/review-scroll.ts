export interface RevealViewport {
  readonly top: number;
  readonly bottom: number;
  readonly elementTop: number;
  readonly elementBottom: number;
  readonly gap: number;
}

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
