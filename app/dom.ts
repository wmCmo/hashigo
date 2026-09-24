/**
 * `el` — the one element lookup, and it FAILS LOUDLY.
 *
 * Its own module so that `layers.ts` and `ui.ts` can both use it without importing
 * each other. The layer host is looked up once, at load, so a cycle through the
 * dialogs would have worked only by evaluation-order luck.
 */

export const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} is not in index.html`);
  return found as T;
};
