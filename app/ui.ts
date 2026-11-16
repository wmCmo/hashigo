import { el, setTextWithCode } from "./dom.js";
import { bareLayer, closeIfTop, pushLayer } from "./layers.js";

export function line(text: string, level = "info"): void {
  const log = el("bootlog");
  const row = document.createElement("div");
  row.className = `logline ${level}`;
  row.textContent = text;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

export function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function say(text: string, bad = false, stay = false): void {
  const strip = el("say");
  strip.textContent = text;
  strip.classList.toggle("bad", bad);
  strip.hidden = false;
  window.clearTimeout(sayTimer);
  if (stay) return;
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
  setTextWithCode(p, body);
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
  setTextWithCode(text, body);

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
