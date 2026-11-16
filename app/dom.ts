export const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} is not in index.html`);
  return found as T;
};

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
