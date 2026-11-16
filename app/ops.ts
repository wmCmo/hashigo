import type { PreparedCard } from "../src/review/index.js";
import type { Trigger } from "./links.js";
import type { BrowseHit, CardOp, CreateCardMessage, TemplateChoice } from "./protocol.js";
import { el } from "./dom.js";
import { paintGallery } from "./gallery.js";
import { bareLayer, closeIfTop, closeTop, layers, pushLayer } from "./layers.js";
import { completeLink, linkAt, linksIn, triggerAt } from "./links.js";
import { shell } from "./shell.js";
import { deckIndex, loadDecks, templateChoices } from "./sidebar.js";
import { openTemplateEditorById } from "./template-editor.js";
import { openConfirm, say } from "./ui.js";
import { count } from "./plural.js";
import { noteVisit, readVisits } from "./visits.js";
import { ask } from "./worker-client.js";

interface UndoEntry {
  readonly describe: string;
  readonly run: () => Promise<void>;
}

const undoStack: UndoEntry[] = [];
const undoButton = el<HTMLButtonElement>("opundo");

export function offerDuplicate(
  said: HTMLElement,
  duplicate: CreateCardMessage["duplicate"],
  actions: {
    readonly use: { readonly label: string; readonly run: (cardId: string) => void };
    readonly anyway: () => void;
  },
): void {
  said.replaceChildren();
  if (duplicate === null) {
    said.classList.add("bad");
    said.textContent = "no card was made, and the worker did not say why";
    return;
  }
  said.classList.remove("bad");
  said.append(duplicate.message);
  const choices = document.createElement("span");
  choices.className = "newcard-choices";
  for (const existing of duplicate.existing) {
    const use = document.createElement("button");
    use.type = "button";
    use.className = "newcard-choice";
    use.textContent =
      duplicate.existing.length === 1
        ? `${actions.use.label} it`
        : `${actions.use.label} the one in ${existing.deckPath}`;
    use.dataset["cardId"] = existing.cardId;
    use.addEventListener("click", () => actions.use.run(existing.cardId));
    choices.appendChild(use);
  }
  const anyway = document.createElement("button");
  anyway.type = "button";
  anyway.className = "newcard-choice";
  anyway.textContent = "create anyway";
  anyway.addEventListener("click", () => actions.anyway());
  choices.appendChild(anyway);
  said.appendChild(choices);
}

export function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > 50) undoStack.shift();
  paintUndo();
}

function paintUndo(): void {
  const top = undoStack.at(-1);
  undoButton.disabled = top === undefined;
  undoButton.title = top === undefined ? "nothing to undo" : `undo: ${top.describe}`;
}

export async function runUndo(): Promise<void> {
  const entry = undoStack.at(-1);
  if (entry === undefined) return;
  undoButton.disabled = true;
  try {
    await entry.run();
    undoStack.pop();
    say(`undid: ${entry.describe}`);
  } catch (cause) {
    say(`could not undo ${entry.describe}: ${(cause as Error).message}`, true);
  } finally {
    paintUndo();
  }
}

undoButton.addEventListener("click", () => void runUndo());

export async function runCardOp(
  op: CardOp,
  cardId: string,
  extra: { readonly templateId?: string | null } = {},
): Promise<void> {
  try {
    const reply = await ask<"cardOp">({ kind: "cardOp", op, cardId, ...extra });
    say(reply.describe, op === "delete");
    if (reply.undo !== null) {
      const undo = reply.undo;
      pushUndo({
        describe: reply.describe,
        run: async () => {
          await ask<"cardOp">({
            kind: "cardOp",
            op: undo.op,
            cardId: undo.cardId,
            ...("templateId" in undo ? { templateId: undo.templateId } : {}),
          });
          await refreshAfterOp();
        },
      });
    }
    if (reply.advanced) await shell().showSessionCard();
    await refreshAfterOp();
  } catch (cause) {
    say((cause as Error).message, true);
  }
}

export async function refreshAfterOp(): Promise<void> {
  await loadDecks(true);
  await shell().repaintReviewFlags();
  for (const layer of layers) {
    if (!layer.ops) continue;
    const state = await ask<"preview">({ kind: "preview", cardId: layer.cardId });
    layer.pinned = state.pinned;
    layer.archived = state.archived;
    const host = layer.root.querySelector(".layer-ops");
    if (host instanceof HTMLElement) shell().paintLayerOps(layer, host);
  }
  if (document.body.getAttribute("data-view") === "gallery") await paintGallery();
}

export function confirmDelete(cardId: string, name: string): void {
  openConfirm(
    `Delete ${name === "" ? cardId : name}?`,
    "The card, its field values, its tags, its links and ALL of its review history " +
      "go with it. This is the one operation that cannot be undone.",
    "delete",
    () => void runCardOp("delete", cardId),
  );
}

export function templateRow(card: PreparedCard, choices: readonly TemplateChoice[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "edit-row edit-template";

  const label = document.createElement("span");
  label.className = "edit-label";
  label.textContent = "template";
  const current = choices.find((c) => c.current);
  const type = document.createElement("i");
  type.className = "edit-type";
  type.textContent = current === undefined ? "none" : `${current.fields} fields`;
  label.appendChild(type);
  row.appendChild(label);

  const bar = document.createElement("div");
  bar.className = "tpl-pick";

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "gcard-op";
  pick.textContent = current === undefined ? "choose a template" : current.name;
  pick.addEventListener("click", () => openTemplatePicker(card, choices));
  bar.appendChild(pick);

  if (current !== undefined) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "gcard-op";
    edit.textContent = `edit ${current.name}`;
    edit.title = "opens the template editor on top of this one";
    edit.addEventListener("click", () => void openTemplateEditorById(current.templateId));
    bar.appendChild(edit);
  }

  row.appendChild(bar);
  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    "Switching templates never deletes anything. A value only shows if the new " +
    "template has the same field; the rest stay saved and come back if you switch " +
    "back. 単語 and 言葉 share four fields; most other pairs share one.";
  row.appendChild(note);
  return row;
}

function openTemplatePicker(card: PreparedCard, choices: readonly TemplateChoice[]): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm layer-menu";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = `Template for ${card.loaded.name || card.cardId}`;
  const text = document.createElement("p");
  text.textContent =
    "Switching never deletes anything. Each template has its own fields, so only " +
    "some of what's filled in carries over: “keeps 3” means three of this card's " +
    "filled-in fields will still show, “hides 2” means two won't — they stay " +
    "saved and come back if you switch back.";
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  for (const choice of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item";
    if (choice.current) button.classList.add("on");
    if (!choice.current && choice.hides > 0) button.classList.add("danger");
    const name = document.createElement("b");
    name.textContent = choice.current ? `${choice.name} — current` : choice.name;
    const why = document.createElement("i");
    why.textContent = choice.current
      ? `${choice.fields} fields`
      : `${choice.fields} fields · keeps ${choice.keeps}` +
        (choice.hides === 0 ? "" : `, hides ${choice.hides}`);
    button.append(name, why);
    button.addEventListener("click", () => {
      closeIfTop(root);
      if (choice.current) return;
      const move = (): void =>
        void runCardOp("setTemplate", card.cardId, { templateId: choice.templateId });
      if (choice.hides === 0) move();
      else {
        openConfirm(
          `Move to ${choice.name}?`,
          `${choice.name} has no field for ${count(choice.hides, "value")} on this ` +
            `card. Hidden values stay saved and come back if you move it back. ` +
            `Ctrl+Z undoes this.`,
          `move to ${choice.name}`,
          move,
        );
      }
    });
    list.appendChild(button);
  }

  panel.appendChild(list);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  (list.firstElementChild as HTMLElement | null)?.focus();
}

function attachLinkMirror(area: HTMLTextAreaElement): () => void {
  const shell = document.createElement("div");
  shell.className = "edit-field";
  area.replaceWith(shell);
  const mirror = document.createElement("div");
  mirror.className = "edit-mirror";
  mirror.setAttribute("aria-hidden", "true");
  shell.append(mirror, area);

  const paint = (): void => {
    const text = area.value;
    const spans = linksIn(text);
    shell.classList.toggle("has-links", spans.length > 0);
    const parts: Node[] = [];
    let at = 0;
    for (const span of spans) {
      if (span.start > at) parts.push(document.createTextNode(text.slice(at, span.start)));
      const box = document.createElement("mark");
      box.className = "edit-link";
      box.textContent = span.raw;
      parts.push(box);
      at = span.end;
    }
    parts.push(document.createTextNode(text.slice(at) + "\n"));
    mirror.replaceChildren(...parts);
    mirror.scrollTop = area.scrollTop;
  };

  const arm = (on: boolean): void => {
    shell.classList.toggle("mod", on);
  };

  area.addEventListener("input", paint);
  area.addEventListener("scroll", () => {
    mirror.scrollTop = area.scrollTop;
  });
  area.addEventListener("keydown", (event) => arm(event.ctrlKey || event.metaKey));
  area.addEventListener("keyup", (event) => arm(event.ctrlKey || event.metaKey));
  shell.addEventListener("mousemove", (event) => arm(event.ctrlKey || event.metaKey));
  shell.addEventListener("mouseleave", () => arm(false));
  area.addEventListener("blur", () => arm(false));

  paint();
  return paint;
}

interface LinkOrigin {
  readonly deckId: string;
  readonly templateId: string | null;
}

export function attachLinkEditing(
  area: HTMLTextAreaElement,
  onSaveNeeded: () => void,
  origin: LinkOrigin,
): void {
  const repaint = attachLinkMirror(area);
  let menu: HTMLElement | null = null;
  let hits: readonly BrowseHit[] = [];
  let index = 0;
  let token = 0;
  let live: Trigger | null = null;

  const canCreate = (): boolean => live !== null && live.query.trim() !== "";
  const rows = (): number => hits.length + (canCreate() ? 1 : 0);

  const close = (): void => {
    menu?.remove();
    menu = null;
    live = null;
    hits = [];
  };

  const paint = (): void => {
    if (menu === null || live === null) return;
    menu.replaceChildren();
    if (hits.length === 0) {
      const empty = document.createElement("i");
      empty.className = "link-empty";
      empty.textContent = live.query === "" ? "type to search cards" : `no card matching ${live.query}`;
      menu.appendChild(empty);
    }
    hits.forEach((hit, at) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "link-item";
      if (at === index) item.classList.add("on");
      const name = document.createElement("b");
      name.textContent = hit.name === "" ? hit.cardId : hit.name;
      const deck = document.createElement("i");
      deck.textContent = hit.deckPath;
      item.append(name, deck);
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(at);
      });
      menu!.appendChild(item);
      if (at === index) item.scrollIntoView({ block: "nearest" });
    });
    if (canCreate()) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "link-item link-create";
      if (index === hits.length) item.classList.add("on");
      const name = document.createElement("b");
      name.textContent = `+ create card “${live.query.trim()}”`;
      const where = document.createElement("i");
      where.textContent = "choose its template and deck next";
      item.append(name, where);
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(hits.length);
      });
      menu.appendChild(item);
      if (index === hits.length) item.scrollIntoView({ block: "nearest" });
    }
  };

  const create = (): void => {
    if (live === null) return;
    const trigger = live;
    const name = trigger.query.trim();
    close();
    openNewCardDialog({
      name,
      deckId: origin.deckId,
      templateId: origin.templateId,
      onCreated: (cardId) => {
        const out = completeLink(area.value, trigger, name, cardId);
        area.value = out.text;
        area.setSelectionRange(out.caret, out.caret);
        repaint();
        onSaveNeeded();
      },
    });
  };

  const choose = (at: number): void => {
    if (at === hits.length && canCreate()) {
      create();
      return;
    }
    const hit = hits[at];
    if (hit === undefined || live === null) return;
    const out = completeLink(area.value, live, hit.name === "" ? hit.cardId : hit.name, hit.cardId);
    area.value = out.text;
    area.setSelectionRange(out.caret, out.caret);
    repaint();
    close();
    area.focus();
    onSaveNeeded();
  };

  const refresh = (): void => {
    const trigger = triggerAt(area.value, area.selectionStart);
    if (trigger === null) {
      close();
      return;
    }
    live = trigger;
    if (menu === null) {
      menu = document.createElement("div");
      menu.className = "link-menu";
      area.parentElement?.appendChild(menu);
    }
    const mine = ++token;
    void ask<"browse">({
      kind: "browse",
      query: trigger.query,
      deckId: null,
      limit: 8,
      suggest: true,
      visited: readVisits(),
    }).then(
      (reply) => {
        if (mine !== token || live === null) return;
        hits = reply.hits;
        index = 0;
        paint();
      },
    );
    paint();
  };

  area.addEventListener("input", refresh);
  area.addEventListener("click", () => refresh());
  area.addEventListener("keyup", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      refresh();
    }
  });
  area.addEventListener("blur", () => {
    setTimeout(close, 120);
  });

  area.addEventListener("keydown", (event) => {
    if (menu === null || live === null) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      index = Math.max(0, Math.min(rows() - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      paint();
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (rows() === 0) return;
      event.preventDefault();
      choose(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  area.addEventListener("mousedown", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    setTimeout(() => {
      const span = linkAt(area.value, area.selectionStart);
      if (span !== null) void openEditorById(span.target);
    }, 0);
  });
}

export function openNewCardDialog(options: {
  readonly name: string;
  readonly deckId: string;
  readonly templateId: string | null;
  readonly onCreated: (cardId: string) => void;
  readonly source?: { readonly cardId: string; readonly name: string; readonly sentence: string };
}): void {
  void loadDecks();
  const root = document.createElement("div");
  root.className = "layer layer-confirm";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "new card");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("form");
  panel.className = "confirm-panel newcard-dialog";
  const heading = document.createElement("h2");
  heading.textContent = "New card";

  const title = document.createElement("input");
  title.className = "newcard-title";
  title.type = "text";
  title.value = options.name;
  title.autocomplete = "off";
  title.spellcheck = false;
  title.setAttribute("aria-label", "name");

  const template = document.createElement("select");
  template.className = "newcard-select";
  template.setAttribute("aria-label", "template");
  const deck = document.createElement("select");
  deck.className = "newcard-select";
  deck.setAttribute("aria-label", "deck");

  let deckTouched = false;
  const fill = (): void => {
    template.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "no template";
    template.appendChild(none);
    for (const entry of templateChoices) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.name;
      template.appendChild(option);
    }
    template.value = options.templateId ?? "";
    deck.replaceChildren();
    for (const entry of deckIndex) {
      if (entry.archived) continue;
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.path;
      deck.appendChild(option);
    }
    deck.value = options.deckId;
  };
  fill();
  if (deckIndex.length === 0 || templateChoices.length === 0) void loadDecks().then(fill);

  deck.addEventListener("change", () => {
    deckTouched = true;
  });
  template.addEventListener("change", () => {
    if (deckTouched) return;
    const home = templateChoices.find((entry) => entry.id === template.value)?.homeDeckId;
    if (home !== null && home !== undefined && deckIndex.some((entry) => entry.id === home)) {
      deck.value = home;
    }
  });

  const said = document.createElement("p");
  said.className = "newcard-said";

  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.addEventListener("click", () => closeIfTop(root));
  const go = document.createElement("button");
  go.type = "submit";
  go.textContent = "create";
  bar.append(cancel, go);

  const submit = (allowDuplicate: boolean): void => {
    const name = title.value.trim();
    if (name === "" || deck.value === "") return;
    go.disabled = true;
    void ask<"createCard">({
      kind: "createCard",
      deckId: deck.value,
      templateId: template.value === "" ? null : template.value,
      name,
      allowDuplicate,
      ...(options.source === undefined
        ? {}
        : { source: { cardId: options.source.cardId, sentence: options.source.sentence } }),
    })
      .then((reply) => {
        go.disabled = false;
        if (reply.duplicate !== null || reply.cardId === null) {
          const source = options.source;
          offerDuplicate(said, reply.duplicate, {
            use:
              source === undefined
                ? {
                    label: "link",
                    run: (cardId) => {
                      closeIfTop(root);
                      options.onCreated(cardId);
                    },
                  }
                : {
                    label: "use",
                    run: (cardId) => {
                      void ask<"recordFoundIn">({
                        kind: "recordFoundIn",
                        cardId,
                        sourceCardId: source.cardId,
                        sentence: source.sentence,
                      })
                        .then((done) => {
                          closeIfTop(root);
                          say(
                            done.outcome === "recorded"
                              ? `${name} already had a card — it now says it was found in ${source.name}`
                              : done.outcome === "kept"
                                ? `${name} already had a card, found somewhere else first — that is kept`
                                : `${name} already had a card — opened it`,
                          );
                          void shell().openPreview(cardId);
                        })
                        .catch((cause: Error) => {
                          said.classList.add("bad");
                          said.textContent = cause.message;
                        });
                    },
                  },
            anyway: () => submit(true),
          });
          return;
        }
        const cardId = reply.cardId;
        pushUndo({
          describe: `new card ${name}`,
          run: async () => {
            await ask<"cardOp">({ kind: "cardOp", op: "delete", cardId });
            await refreshAfterOp();
          },
        });
        closeIfTop(root);
        options.onCreated(cardId);
        void loadDecks(true);
        void openEditorById(cardId);
      })
      .catch((cause: Error) => {
        said.classList.add("bad");
        said.textContent = cause.message;
        go.disabled = false;
      });
  };
  panel.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(false);
  });

  const from = document.createElement("p");
  from.className = "newcard-from";
  if (options.source !== undefined) {
    const where = document.createElement("b");
    where.textContent = `found in ${options.source.name}`;
    from.appendChild(where);
    if (options.source.sentence !== "") {
      const line = document.createElement("i");
      line.textContent = options.source.sentence;
      from.appendChild(line);
    }
  }
  panel.append(heading, ...(options.source === undefined ? [] : [from]), title, template, deck, said, bar);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  if (options.name === "") title.focus();
  else template.focus();
}

export async function openEditorById(
  cardId: string,
  options: { readonly replacing?: HTMLElement } = {},
): Promise<void> {
  const reply = await ask<"preview">({ kind: "preview", cardId });
  if (reply.card === null) return;
  noteVisit(cardId);
  const replaced = options.replacing !== undefined && layers.at(-1)?.root === options.replacing;
  if (replaced) closeTop();
  shell().openEditorFor(reply.card, reply.templates, { fromPreview: replaced });
}
