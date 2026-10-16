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

/**
 * Set text whose `backticked` spans are code — as `<code>`, not as backticks.
 *
 * The settings and dashboard notes quote identifiers the way the source does
 * (`inherit`, `npm run dashboard`), and printed as plain text in the UI face the
 * backtick did not survive: 2026-10-16, on the live app, `inherit` read as
 * `ìnherit`` — the grave fused onto the letter after it. The words are his and
 * stay as written; only the quoting becomes the mono face it stands for.
 */
export function setTextWithCode(element: HTMLElement, text: string): void {
  element.replaceChildren();
  const parts = text.split(/`([^`]+)`/);
  parts.forEach((part, i) => {
    if (part === "") return;
    if (i % 2 === 1) {
      const code = document.createElement("code");
      code.textContent = part;
      element.appendChild(code);
    } else {
      element.appendChild(document.createTextNode(part));
    }
  });
}
