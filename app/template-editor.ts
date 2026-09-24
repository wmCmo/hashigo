/**
 * THE TEMPLATE EDITOR — his #11, moved out of `main.ts` on 2026-09-25.
 *
 * It is the feature with the largest blast radius per click in the app (a template
 * edit changes every card on it — 単語 is 3,742), and it lived inside the one file
 * no test can import. The pure half of it — what a field's row SAYS — was already
 * in `./field-form.ts` and tested over the real 48 fields; this is the DOM half.
 *
 * It reloads the deck tree after an edit (`./sidebar.ts`) and pushes each edit's
 * reversal onto the undo stack (`./ops.ts`).
 */

import { decodeFieldOptions } from "../src/cards/index.js";
import { moveWithin } from "../src/schema/index.js";
import { referencedNames } from "../src/template/index.js";
import { factsLine, inputLine, settingLines, undeclaredKeys } from "./field-form.js";
import { bareLayer, closeIfTop, layers, pushLayer } from "./layers.js";
import type {
  TemplateBrief,
  TemplateDetail,
  TemplateFieldRow,
  TemplateOpRequest,
} from "./protocol.js";
import { loadDecks } from "./sidebar.js";
import { openConfirm, say } from "./ui.js";
import { ask } from "./worker-client.js";
import { pushUndo, refreshAfterOp } from "./ops.js";

/**
 * *"where can i edit my template? there should be a modal for editing template and
 * fields"* — his #11.
 *
 * ─── THE ONE THING THAT MAKES THIS DIFFERENT FROM THE CARD EDITOR ───────────
 *
 * A card edit changes one card. **A template edit changes every card on it**, and
 * the count is on screen for that reason: 単語 is 3,742. So every row here states
 * its blast radius before he touches it, and the two irreversible-looking ones
 * (rename a field, delete a field) both say what happens to the text underneath.
 *
 * ─── RENAMING A FIELD REWRITES THE BODY, AND HE IS TOLD SO ──────────────────
 *
 * The resolver binds `<<Field>>` by NAME, so a rename that stopped at
 * `template_fields` would unbind every marker in silence. The worker rewrites the
 * body and every generator prompt in the same transaction; this screen shows the
 * reference COUNT beside each field so the number in "rewrote 6 reference(s)" is
 * one he could have predicted.
 *
 * ─── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 *
 * Changing a field's TYPE, and repointing a generator's source. Both reinterpret
 * every existing value at once — a migration, not a form control — and the worker
 * refuses them rather than this screen hiding them. `templateOp` says why.
 */
export function openTemplateEditor(brief: TemplateBrief): void {
  void openTemplateEditorById(brief.id);
}

export async function openTemplateEditorById(templateId: string): Promise<void> {
  const reply = await ask<"template">({ kind: "template", templateId });
  if (reply.template === null) {
    say(`no template ${templateId}`, true);
    return;
  }

  const root = document.createElement("div");
  root.className = "layer layer-edit layer-template";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `edit template ${reply.template.name}`);

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close the template editor");
  close.textContent = "✕";
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);
  root.appendChild(panel);

  let detail = reply.template;

  /** Run one op, then repaint from the row the worker sent back. */
  const run: TemplateRunner = async (request) => {
    try {
      const done = await ask<"templateOp">({ kind: "templateOp", ...request });
      say(done.describe);
      if (done.template !== null) {
        detail = done.template;
        paint();
      }
      if (done.undo !== null) {
        const entry = done.undo;
        pushUndo({
          describe: done.describe,
          run: async () => {
            const back = await ask<"templateOp">({ kind: "templateOp", ...entry });
            if (back.template !== null && layers.some((layer) => layer.root === root)) {
              detail = back.template;
              paint();
            }
            await refreshAfterOp();
          },
        });
      }
      await loadDecks(true);
    } catch (cause) {
      say((cause as Error).message, true);
    }
  };

  function paint(): void {
    title.textContent = `${detail.name} · ${detail.cards.toLocaleString()} card(s)`;
    body.replaceChildren();

    // ── the name ──
    const nameRow = document.createElement("div");
    nameRow.className = "edit-row";
    const nameLabel = document.createElement("span");
    nameLabel.className = "edit-label";
    nameLabel.textContent = "template name";
    const nameInput = document.createElement("input");
    nameInput.className = "edit-input";
    nameInput.type = "text";
    nameInput.value = detail.name;
    nameInput.addEventListener("change", () => {
      if (nameInput.value.trim() !== detail.name) {
        void run({ op: "rename", templateId: detail.id, name: nameInput.value.trim() });
      }
    });
    nameRow.append(nameLabel, nameInput);
    body.appendChild(nameRow);

    // ── the fields ──
    const fieldsHead = document.createElement("h3");
    fieldsHead.className = "tpl-head";
    fieldsHead.textContent = `fields (${detail.fields.length})`;
    body.appendChild(fieldsHead);

    const list = document.createElement("div");
    list.className = "tpl-fields";
    detail.fields.forEach((field, index) => {
      list.appendChild(templateFieldRow(detail, field, index, run));
    });
    body.appendChild(list);

    // ── add ──
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tree-add";
    add.textContent = "+ add a field";
    add.addEventListener("click", () => openAddField(detail, run));
    body.appendChild(add);

    // ── the body ──
    const bodyHead = document.createElement("h3");
    bodyHead.className = "tpl-head";
    bodyHead.textContent = "body";
    body.appendChild(bodyHead);

    const why = document.createElement("p");
    why.className = "settings-note";
    why.textContent =
      `This is what every one of the ${detail.cards.toLocaleString()} cards on this ` +
      `template renders. '---' starts a new side and '___' is a rule within one. ` +
      `<<Field>> interpolates, <<#Field>> and <<^Field>> gate a block on a boolean, ` +
      `{{...}} is a cloze. A name that is not a field of this template resolves to ` +
      `nothing — silently — so the check below is the one that matters.`;
    body.appendChild(why);

    const area = document.createElement("textarea");
    area.className = "edit-input tpl-body";
    area.rows = 14;
    area.spellcheck = false;
    area.value = detail.content;
    const unknown = document.createElement("p");
    unknown.className = "settings-bad";
    unknown.hidden = true;

    // AN UNRESOLVED `<<X>>` IS AN EMPTY STRING, NOT AN ERROR. So the one useful
    // check on a body is "does every name it uses exist here", and it runs while
    // he types rather than after he saves.
    const check = (): void => {
      const known = new Set(detail.fields.map((entry) => entry.name));
      const missing = [...referencedNames(area.value)].filter((name) => !known.has(name));
      unknown.hidden = missing.length === 0;
      unknown.textContent =
        `${missing.join(", ")} — not a field of ${detail.name}. Those markers will ` +
        `render as nothing, on every card.`;
    };
    area.addEventListener("input", check);
    // On BLUR, like the card editor: an OPFS write is 20-80 ms and a keystroke is
    // not a save. The template is one row, but it is a row 3,742 cards read.
    area.addEventListener("blur", () => {
      if (area.value !== detail.content) {
        void run({ op: "body", templateId: detail.id, content: area.value });
      }
    });
    check();
    body.append(area, unknown);
  }

  paint();
  pushLayer(bareLayer(root));
  close.focus();
}

/** What every row in the template editor is handed to write with. */
type TemplateRunner = (request: Omit<TemplateOpRequest, "kind" | "id">) => Promise<void>;

function templateFieldRow(
  detail: TemplateDetail,
  field: TemplateFieldRow,
  index: number,
  run: TemplateRunner,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "tpl-field";
  if (field.local) row.classList.add("is-local");

  const name = document.createElement("input");
  name.className = "edit-input tpl-name";
  name.type = "text";
  name.value = field.name;
  name.addEventListener("change", () => {
    if (name.value.trim() !== field.name) {
      void run({
        op: "renameField",
        templateId: detail.id,
        fieldId: field.id,
        name: name.value.trim(),
      });
    }
  });

  const facts = document.createElement("p");
  facts.className = "tpl-facts";
  facts.textContent = factsLine(field);

  const ops = document.createElement("div");
  ops.className = "tpl-ops";
  const order = detail.fields.map((entry) => entry.id);

  const step = (delta: number): void => {
    const to = index + delta;
    if (to < 0 || to >= order.length) return;
    // `before` is the id to land in FRONT of. Moving DOWN has to land in front of
    // the field AFTER the one being passed, or the swap is a no-op.
    const before = delta < 0 ? order[to] : (order[to + 1] ?? null);
    void run({
      op: "orderFields",
      templateId: detail.id,
      order: moveWithin(order, field.id, before ?? null),
    });
  };

  const button = (label: string, title: string, on: () => void, danger = false): void => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "gcard-op";
    if (danger) element.classList.add("danger");
    element.textContent = label;
    element.title = title;
    element.addEventListener("click", on);
    ops.appendChild(element);
  };

  button("↑", "move up", () => step(-1));
  button("↓", "move down", () => step(1));
  button(
    "delete",
    field.dependents.length > 0 ? `${field.dependents.join(", ")} generate from this` : "remove it",
    () => {
      openConfirm(
        `Remove ${field.name} from ${detail.name}?`,
        (field.values === 0
          ? "No card carries a value for it. "
          : `${field.values.toLocaleString()} card(s) carry a value for it. Those ` +
            `values are NOT deleted — 'card_field_values' is deliberately not ` +
            `foreign-keyed to the field, because losing four years of authored text ` +
            `is worse than an orphan row. Undo puts the field back and the text is ` +
            `still under it. `) +
          (field.references === 0
            ? "Nothing in the body references it."
            : `The body references it ${field.references} time(s); those markers will ` +
              `render as nothing until you edit the body.`),
        "remove the field",
        () => void run({ op: "deleteField", templateId: detail.id, fieldId: field.id }),
      );
    },
    true,
  );

  const settings = templateFieldSettings(detail, field);
  if (settings !== null) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "gcard-op";
    toggle.textContent = "⌄";
    toggle.title = "what this field carries";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const open = settings.hidden;
      settings.hidden = !open;
      toggle.textContent = open ? "⌃" : "⌄";
      toggle.setAttribute("aria-expanded", String(open));
    });
    ops.insertBefore(toggle, ops.firstChild);
    settings.hidden = true;
    row.append(name, facts, ops, settings);
    return row;
  }

  row.append(name, facts, ops);
  return row;
}

/**
 * What a field carries, unfolded under its own row.
 *
 * IN THE ROW rather than in a panel beside it or a modal above it — Zach's call,
 * 2026-09-17. `.tpl-field` collapses to one column under 640px already, so a
 * `grid-column: 1 / -1` child is the same thing on the phone as on the laptop and
 * there is no second layout to keep honest. A layer over a layer is the shape his
 * phone handles worst.
 *
 * Every control here is generated from `settingsOf(field.type)`, so this function
 * knows nothing about speech, prompts or translation directions, and a new
 * setting is a registry entry rather than a branch.
 */
function templateFieldSettings(
  detail: TemplateDetail,
  field: TemplateFieldRow,
): HTMLElement | null {
  const options = decodeFieldOptions(field.options);
  const lines = settingLines(field.type, options);
  const extras = undeclaredKeys(field.type, options);
  const nameOf = (id: string): string | null =>
    detail.fields.find((entry) => entry.id === id)?.name ?? null;
  const input = inputLine(field, nameOf);
  if (lines.length === 0 && extras.length === 0 && input === null) return null;

  const panel = document.createElement("div");
  panel.className = "tpl-settings";

  if (input !== null) {
    const pipe = document.createElement("p");
    pipe.className = "tpl-setting-pipe";
    pipe.textContent = input;
    panel.appendChild(pipe);
  }

  for (const line of lines) {
    const item = document.createElement("div");
    item.className = "tpl-setting";
    if (line.unset) item.classList.add("is-unset");

    const label = document.createElement("span");
    label.className = "tpl-setting-label";
    label.textContent = line.label;

    const value = document.createElement("span");
    value.className = "tpl-setting-value";
    value.textContent = line.value;
    // Said in the row rather than only in the note, because "you cannot change
    // this" is the first thing a reader wants and the last thing a note gives.
    if (line.readOnly) value.title = "read-only";

    const note = document.createElement("p");
    note.className = "tpl-setting-note";
    note.textContent = line.note;

    item.append(label, value, note);
    panel.appendChild(item);
  }

  for (const extra of extras) {
    // Shown, never dropped. `options` is free-form JSON that survived an import
    // and will survive a sync; a key this build does not declare is more likely
    // to be something real than something wrong.
    const item = document.createElement("div");
    item.className = "tpl-setting is-undeclared";
    const label = document.createElement("span");
    label.className = "tpl-setting-label";
    label.textContent = extra.key;
    const value = document.createElement("span");
    value.className = "tpl-setting-value";
    value.textContent = extra.value;
    const note = document.createElement("p");
    note.className = "tpl-setting-note";
    note.textContent = "Carried by this field and not declared by its kind — kept as it is.";
    item.append(label, value, note);
    panel.appendChild(item);
  }

  return panel;
}

function openAddField(detail: TemplateDetail, run: TemplateRunner): void {
  // Only the types a person AUTHORS. The generated ones (`speech`, `ai`,
  // `translate`, `furigana`, `dictionary`, `image-search`) need options and a source
  // that this form cannot ask for sensibly, and their VALUES are empty by design —
  // Mochi keeps generated output in `component-cache`, addressed by generation
  // identity. Offering them here would create a field that can never show anything.
  const TYPES: readonly (readonly [string, string])[] = [
    ["plain", "plain — one line of text"],
    ["text", "text — several lines"],
    ["boolean", "boolean — true/false, gates <<#Field>> blocks"],
    ["number", "number"],
    ["accent", "accent — 平板 / 頭高 / 中高 / 尾高 (decision 20's 型)"],
  ];

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
  heading.textContent = `Add a field to ${detail.name}`;
  const text = document.createElement("p");
  text.textContent =
    "It is created LOCAL (decision 9), which is what stops a re-import pruning its " +
    "values — that is the flag whose absence once threw away 3,454 型 labels. It " +
    "renders nowhere until you put <<Name>> in the body.";

  const nameRow = document.createElement("label");
  nameRow.className = "edit-row";
  const nameLabel = document.createElement("span");
  nameLabel.className = "edit-label";
  nameLabel.textContent = "name";
  const nameInput = document.createElement("input");
  nameInput.className = "edit-input";
  nameInput.type = "text";
  nameRow.append(nameLabel, nameInput);

  const typeRow = document.createElement("label");
  typeRow.className = "edit-row";
  const typeLabel = document.createElement("span");
  typeLabel.className = "edit-label";
  typeLabel.textContent = "type";
  const typeSelect = document.createElement("select");
  typeSelect.className = "edit-input";
  for (const [value, label] of TYPES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    typeSelect.appendChild(option);
  }
  typeRow.append(typeLabel, typeSelect);

  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.addEventListener("click", () => closeIfTop(root));
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "add";
  go.addEventListener("click", () => {
    const value = nameInput.value.trim();
    if (value === "") {
      nameInput.focus();
      return;
    }
    closeIfTop(root);
    void run({
      op: "addField",
      templateId: detail.id,
      name: value,
      fieldType: typeSelect.value,
    });
  });
  bar.append(cancel, go);

  panel.append(heading, text, nameRow, typeRow, bar);
  root.append(backdrop, panel);
  pushLayer(bareLayer(root));
  nameInput.focus();
}
