/**
 * THE SMALL PIECES OF CHROME EVERY FEATURE USES — the one-line status strip and
 * the two dialogs. (The element lookup is `./dom.ts`.)
 *
 * Moved out of `main.ts` on 2026-09-25 with the layer stack, because every feature
 * module extracted after it needs these and none of these needs a feature.
 */

import { el } from "./dom.js";
import { bareLayer, closeIfTop, pushLayer } from "./layers.js";

/** One place the app says what just happened, on every surface. */
export function say(text: string, bad = false): void {
  const strip = el("say");
  strip.textContent = text;
  strip.classList.toggle("bad", bad);
  strip.hidden = false;
  window.clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => {
    strip.hidden = true;
  }, 4000);
}
let sayTimer = 0;

export function openConfirm(
  title: string,
  body: string,
  verb: string,
  run: () => void,
  tone: "danger" | "normal" = "danger",
): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = body;
  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.addEventListener("click", () => closeIfTop(root));
  const go = document.createElement("button");
  go.type = "button";
  if (tone === "danger") go.className = "danger";
  go.textContent = verb;
  go.addEventListener("click", () => {
    closeIfTop(root);
    run();
  });
  bar.append(cancel, go);
  panel.append(h, p, bar);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  cancel.focus();
}

/**
 * A one-field dialog: a name, a button, Enter and Escape.
 *
 * `window.prompt()` is what this replaces and it is not usable here. It blocks the
 * event loop (so the worker's replies queue behind it), it cannot be styled, and on
 * a phone it is a system sheet that reads as the browser interrupting rather than
 * the app asking. It also cannot say WHY it is asking, and every use of this one
 * has a consequence worth a sentence.
 */
export function openPrompt(
  title: string,
  body: string,
  label: string,
  initial: string,
  run: (value: string) => void,
): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = body;

  const field = document.createElement("label");
  field.className = "edit-row";
  const name = document.createElement("span");
  name.className = "edit-label";
  name.textContent = label;
  const input = document.createElement("input");
  input.className = "edit-input";
  input.type = "text";
  input.value = initial;
  field.append(name, input);

  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.addEventListener("click", () => closeIfTop(root));
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "ok";
  const submit = (): void => {
    const value = input.value.trim();
    // An empty name is refused rather than accepted-and-defaulted: a deck called
    // "new deck" that he meant to name something is a deck he has to find again.
    if (value === "") {
      input.focus();
      return;
    }
    closeIfTop(root);
    run(value);
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  bar.append(cancel, go);
  panel.append(heading, text, field, bar);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  input.focus();
  input.select();
}
