/**
 * CARD OPERATIONS AND THE UNDO STACK — his #7 and #13, plus the card editor's link
 * autocomplete and the new-card dialog it opens.
 *
 * Moved out of `main.ts` on 2026-09-25. Almost every feature leans on it —
 * `pushUndo`, `runCardOp`, `refreshAfterOp` — so it had to come out before the
 * features that call it could stop reaching through `./shell.ts`.
 *
 * It never touches the review screen's state. When an operation may have changed
 * the review card, it asks `main.ts` to repaint (`shell().repaintReviewFlags`),
 * because those variables are that file's and an import cannot be assigned to.
 */

import type { PreparedCard } from "../src/review/index.js";
import type { Trigger } from "./links.js";
import type { BrowseHit, CardOp, CreateCardMessage, TemplateChoice } from "./protocol.js";
import { el } from "./dom.js";
import { paintGallery } from "./gallery.js";
import { bareLayer, closeIfTop, closeTop, layers, pushLayer } from "./layers.js";
// The link rules, in an import-free module `test/` can reach — the same seam as
// `./keys.ts` and `./review-keys.ts`. `test/app-links.test.ts` round-trips all
// 8,744 authored links through it.
import { completeLink, linkAt, linksIn, triggerAt } from "./links.js";
import { shell } from "./shell.js";
import { deckIndex, loadDecks, templateChoices } from "./sidebar.js";
import { openTemplateEditorById } from "./template-editor.js";
import { openConfirm, say } from "./ui.js";
import { noteVisit, readVisits } from "./visits.js";
import { ask } from "./worker-client.js";

/**
 * The undo stack — his #13.
 *
 * *"when you ctrl+z, it should undo your last action, whether create card, review
 * card, remember card, forget card, etc., we need button on mobile as well"*.
 *
 * **Every entry carries its own reversal, computed by the WORKER at the moment it
 * acted**, rather than being re-derived later from a description. That is the
 * difference between an undo that works and one that guesses: the worker knew the
 * card was unarchived before it archived it; nothing afterwards does.
 *
 * **Delete is deliberately NOT undoable and says so** rather than offering a
 * reversal it cannot honour — the card's reviews go with it, and a "restored" card
 * with no history would be a quiet lie.
 */
interface UndoEntry {
  readonly describe: string;
  readonly run: () => Promise<void>;
}

const undoStack: UndoEntry[] = [];
const undoButton = el<HTMLButtonElement>("opundo");

/**
 * A NAME THAT IS ALREADY A CARD. `createCard` refuses a second card of the same
 * name on the same template and says which exist (`src/cards/create.ts`). The
 * form shows that, then two quiet choices: use the card that is there — open it,
 * or link it, whichever the form was for — or make the second one anyway, for a
 * homograph that really is another word. `duplicate` null (a reply with no card
 * and no reason) is said as a failure rather than offered.
 */
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

/**
 * PEEK, RUN, THEN POP — and the order is the whole point.
 *
 * This used to `pop()` before awaiting `run()`, with no `catch`. Undo state lives in
 * TWO places: this stack, and the worker's stack of `AnswerResult`s that `ungrade`
 * pops. They stay in step only because each grade pushes exactly one entry to each,
 * LIFO on both sides.
 *
 * A failed `run()` broke that. The entry was already gone from here while the worker's
 * was intact, so the two were off by one — and the NEXT ctrl+Z would pop this stack's
 * previous entry while the worker popped its latest, undoing a different grade than
 * the one named on the button. Silently, because an unawaited rejection says nothing.
 *
 * Popping only on success keeps the two stacks the same length at every point where
 * anything can observe them. It also makes a failed undo retryable, which is the
 * behaviour a reader expects from a button that did not visibly do anything.
 */
export async function runUndo(): Promise<void> {
  const entry = undoStack.at(-1);
  if (entry === undefined) return;
  undoButton.disabled = true;
  try {
    await entry.run();
    undoStack.pop();
    say(`undid: ${entry.describe}`);
  } catch (cause) {
    // Loud, and the entry stays. The alternative is the two stacks disagreeing
    // about what the next ctrl+Z means.
    say(`could not undo ${entry.describe}: ${(cause as Error).message}`, true);
  } finally {
    paintUndo();
  }
}

undoButton.addEventListener("click", () => void runUndo());

export async function runCardOp(
  op: CardOp,
  cardId: string,
  /**
   * `setTemplate`'s target. Spread rather than defaulted, because `null` is a legal
   * value there — "no template" — and `?? null` would turn "not asked for" into it.
   */
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
            // Same reason: `templateId: null` must survive as null and be absent
            // when the op does not use it.
            ...("templateId" in undo ? { templateId: undo.templateId } : {}),
          });
          await refreshAfterOp();
        },
      });
    }
    // The worker advances the SESSION when the op took the current card; the page has
    // to advance the SCREEN to match, or a deleted card stays visible over a session
    // that has already moved on.
    if (reply.advanced) await shell().showSessionCard();
    await refreshAfterOp();
  } catch (cause) {
    say((cause as Error).message, true);
  }
}

/**
 * Everything that displays collection state, re-read from the database.
 *
 * Three surfaces can show the same card at once — the review bar, an open preview
 * and the gallery behind it — and any of them, plus an undo, can flip the row. So
 * after every operation the state is fetched again rather than patched: patching
 * three copies from one event is how the gallery ends up offering "pin" under a
 * tile that is already marked pinned.
 */
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

/**
 * His #7's delete, *"with warning modal ofc"* — and the warning states the cost in
 * numbers rather than asking "are you sure?", because the cost is the reviews.
 */
export function confirmDelete(cardId: string, name: string): void {
  openConfirm(
    `Delete ${name === "" ? cardId : name}?`,
    "The card, its field values, its tags, its links and ALL of its review history " +
      "go with it. This is the one operation that cannot be undone.",
    "delete",
    () => void runCardOp("delete", cardId),
  );
}

/**
 * `tone` exists because this dialog stopped being only about deletion.
 *
 * It grew from one caller (delete a card) to eight, and four of them are not
 * destructive at all: building the dashboard, changing target retention, unarchiving
 * a deck, turning reverse on. A red confirm button on "build it" teaches him that red
 * means "the app wants you to read this", which is exactly the meaning it must NOT
 * have by the time he sees it on "delete 3,467 reviews".
 *
 * Default stays `danger`, so a caller that does not think about it gets the cautious
 * one.
 */
/**
 * The template row at the top of the editor — his feedback of 2026-09-07:
 * *"i should have drop down for changing card template on the spot … and there
 * should be a place that i can edit the template that belongs to that card right
 * away, and it should open another modal on top just like いつも"*.
 *
 * ─── IT IS NOT A BARE DROPDOWN, AND THE MEASUREMENT IS WHY ──────────────────
 *
 * He said *"im not saying it should be drop down, i trust your design skill"*, so:
 * each option states what the move costs THIS card. Field ids are almost entirely
 * template-private — measured across all ten templates, only four ids exist in more
 * than one (`name` everywhere, and decision 9's three local fields on 単語 + 言葉).
 * So 単語 <-> 言葉 carries four values and every other pair carries one.
 *
 * A plain `<select>` would present "move to 漢字" as equivalent to "move to 言葉"
 * when one keeps four values and the other hides six. Nothing is deleted either way
 * — `card_field_values` is deliberately not foreign-keyed to `template_fields` — but
 * "hidden" is a thing he should choose knowingly, so the count is on the option and
 * the expensive ones confirm.
 */
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

  // "Edit the template that belongs to this card", opening on top — the stack
  // already nests, so this is one call and no new machinery.
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

/** The picker, as a menu of decisions with their cost — see `templateRow`. */
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
  // Zach, 2026-09-24: *"what does that even mean"*. The old sentence was true and
  // written in the schema's vocabulary ("declares", "stop rendering"). What he
  // needs from it is one fact — nothing is lost — and how to read the two numbers.
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
      // Only the lossy ones confirm. A move that hides nothing is not a decision
      // worth a dialog, and a dialog on every option teaches him to click through.
      if (choice.hides === 0) move();
      else {
        openConfirm(
          `Move to ${choice.name}?`,
          `${choice.hides} of this card's values are not declared by ${choice.name} ` +
            `and will stop rendering. They are NOT deleted — the values table is ` +
            `deliberately not foreign-keyed to the template, so moving back brings ` +
            `them straight back. Ctrl+Z undoes this.`,
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

/**
 * OBSIDIAN-STYLE LINK COMPLETION in a field, and ctrl+click to follow one.
 *
 * *"i want the auto complete when you type just like when you're in obsidian, and
 * ctrl+clicking it should open a new card on top, (the newly opened card on top
 * should be in edit mode ofc), also `@` and `[[` should both start the trigger"*.
 *
 * ─── THREE THINGS THE CORPUS DECIDED ────────────────────────────────────────
 *
 * 1. **The inserted display text is a DEFAULT, not a fixed value.** 8,210 of his
 *    8,744 links display the target's name, but 534 display an inflection pointing
 *    at a dictionary form — `[[越|4nKAg2kH]]` targets 越す. So completion seeds the
 *    name and leaves the caret ON the display text, which makes his commonest
 *    deliberate edit one keystroke instead of four.
 * 2. **`@` triggers only after whitespace.** Four field values in the whole corpus
 *    contain `@`; three are `](@media/…)` image paths. `app/links.ts` has the rule.
 * 3. **The search is the same one Ctrl+K uses.** `browse` routes through
 *    `src/search`, which is the only path that answers a two-character Japanese
 *    query — `card_fts`'s trigram tokeniser cannot serve one at all.
 *
 * ─── WHY CTRL+CLICK READS `selectionStart` ──────────────────────────────────
 *
 * A `<textarea>` has no elements in it, so there is no anchor to click and
 * `closest("a")` — how the review screen follows a link — cannot work here. What is
 * available is the caret: the browser sets it on mousedown even with a modifier
 * held, so after the click `selectionStart` is the character offset under the
 * pointer, and `linkAt(text, offset)` turns that into a card id. Pure, and tested.
 */
/**
 * MAKE A LINK LOOK LIKE ONE INSIDE THE TEXTAREA.
 *
 * Zach, 2026-09-08: *"now the hyperlinks work, but the appearance doesn't look like
 * hyperlink, the cursor hover too, i think for editing mode and preview mode they
 * should look different?"*
 *
 * **Yes, and they cannot help being different — the two modes hold different TEXT.**
 * Preview holds `換え` inside an `<a>`; the editor holds the literal 15 characters
 * `[[換え|C1p9g1mL]]`, because the markup is the thing he is editing. So preview gets
 * the link look (`.hashigo-card-link`: dotted underline, pointer, hover) and the
 * editor gets a look that says *this run of characters is one object* — a tinted box
 * around the whole span, brackets and id included.
 *
 * ─── WHY A MIRROR, AND WHY IT PAINTS NO TEXT ────────────────────────────────
 *
 * A `<textarea>` has no elements inside it, so a range within it cannot be styled —
 * the same fact that made ctrl+click read `selectionStart` instead of `closest("a")`.
 * The standard answer is a mirror: a div behind the field, laid out with the SAME
 * font, padding and wrapping, carrying the highlight.
 *
 * **Its text is `transparent` and the textarea's is not**, which is the opposite of
 * what a syntax highlighter does and is deliberate. Painting the mirror and hiding
 * the textarea's own text would allow colouring the brackets separately — and would
 * also mean the textarea's selection background covers the only visible copy of the
 * text, so selecting a word would make it disappear. Backgrounds and underlines
 * render fine under `color: transparent` (`text-decoration-color` is explicit), and
 * that is all this needs.
 *
 * ─── AND THE CURSOR, WHICH IS THE HALF HE ASKED ABOUT SECOND ────────────────
 *
 * Following a link here needs Ctrl held, so the affordance is armed rather than
 * constant: while Ctrl (or Cmd) is down over a field that HAS links, the boxes
 * brighten and the caret becomes a pointer. Never `cursor: pointer` unconditionally
 * — most of a field is not a link, and a pointer over plain prose is a lie.
 */
function attachLinkMirror(area: HTMLTextAreaElement): () => void {
  const shell = document.createElement("div");
  shell.className = "edit-field";
  area.replaceWith(shell);
  const mirror = document.createElement("div");
  mirror.className = "edit-mirror";
  // It is a copy of text that is already on screen and already reachable. A
  // screen reader meeting it twice would read every field twice.
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
    // The trailing "\n" is not decoration: a final newline in a `pre-wrap` block
    // is not laid out, so without it the mirror is one line short of the
    // textarea the moment he presses Enter at the end.
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
  // He can hold Ctrl before touching the field, so the key events never reach it.
  shell.addEventListener("mousemove", (event) => arm(event.ctrlKey || event.metaKey));
  shell.addEventListener("mouseleave", () => arm(false));
  // A modifier held across a window switch is stuck down as far as this page is
  // concerned; blur is the only honest place to let it go.
  area.addEventListener("blur", () => arm(false));

  paint();
  return paint;
}

/**
 * THE CARD BEING EDITED, as far as the link picker needs it — the defaults for a
 * card created from `[[`.
 */
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

  /**
   * `+ create card` — his Mochi routine, 2026-09-24: type `[[` before 貫く, move
   * the caret past 貫, arrow down to the bottom row, Enter, and a creator opens on
   * top; make the card, and the link is already there.
   *
   * It is the row AFTER the hits, so `index === hits.length` selects it. Offered
   * whenever something is typed — even when a card by that name exists, because a
   * word and its kanji are often two cards (貫く in 単語, 貫 in 漢字) and the
   * picker cannot know which one he means to make.
   */
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
      // `mousedown`, not `click`: a click would first blur the textarea, and blur is
      // what SAVES the field — so the value would be written without the link.
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

  /**
   * Make the card, THEN link to it, THEN open it — in that order so that nothing
   * is written if he backs out of the creator. The trigger is captured now,
   * because the textarea is under a layer until the creator closes and nothing
   * can move its text in the meantime.
   */
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
    // Setting `.value` fires no `input` event, so the mirror does not hear about
    // the link it just gained. Without this the box appears on his next keystroke.
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
      // A bare `@` is the palette's question in miniature: eight rows and nothing
      // typed. The alphabet spends all eight of them on numeric names.
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
  // MOVING THE CARET IS A NEW QUERY, and nothing heard it. Zach, 2026-09-24: type
  // `[[` in front of 貫く, press → once, and the query is now 貫 — but the caret
  // moved without an `input` or a `click`, so the menu kept showing what it had
  // found for the empty query. Up/Down are left out on purpose: with the menu open
  // they move the SELECTION, and refreshing would snap it back to the top.
  area.addEventListener("keyup", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      refresh();
    }
  });
  area.addEventListener("blur", () => {
    // Deferred: a mousedown on the menu fires blur first, and closing here
    // synchronously would destroy the item before its handler ran.
    setTimeout(close, 120);
  });

  area.addEventListener("keydown", (event) => {
    // Ctrl+Enter is NOT handled here any more. It used to follow the link under the
    // caret; since 2026-09-24 it means "done — close and preview", his Mochi habit,
    // and the editor layer takes it in the capture phase before this runs. See the
    // handler at the end of `openEditorFor`. Ctrl+CLICK still follows a link.
    if (menu === null || live === null) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      // `rows()`, not `hits.length`: the create row is the last stop.
      index = Math.max(0, Math.min(rows() - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      paint();
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (rows() === 0) return;
      event.preventDefault();
      choose(index);
    } else if (event.key === "Escape") {
      // Swallowed, so Escape dismisses the MENU rather than the whole editor —
      // otherwise abandoning a search costs him everything he was typing.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  area.addEventListener("mousedown", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    // The caret is set by this very mousedown, so the offset is only readable
    // afterwards. One tick is enough and needs no measurement of the pointer.
    setTimeout(() => {
      const span = linkAt(area.value, area.selectionStart);
      // IN EDIT MODE — he asked for that explicitly. `openEditorById` fetches the
      // card and stacks its editor on top of this one.
      if (span !== null) void openEditorById(span.target);
    }, 0);
  });
}

/**
 * A CARD CREATOR ON TOP OF WHAT HE IS EDITING — his Mochi routine, 2026-09-24.
 *
 * *"on the reference field, i would type 貫く … put cursor here |貫く and then type
 * [[ … when i move cursor to [[貫|く … i would press arrow ↓↓ to that option and
 * enter, and boom, it brings up the create card modal for me on top of what i have
 * now … it would be 単語 template … i will change it to 漢字 … and if that card
 * contains english words i don't know, i can just repeat that process"*.
 *
 * The sidebar form already does creation; this is the same three choices as a
 * layer, opened from the link picker with the word already in it. On create it
 * makes the card, hands the new id back so the picker can finish the link, and
 * opens the new card's editor — whose own fields have the same picker, which is
 * what makes his "repeat that process" work to any depth.
 *
 * ─── THE DECK FOLLOWS THE TEMPLATE, UNTIL HE TOUCHES THE DECK ───────────────
 *
 * A card cannot be moved between decks from its editor, so this is the only moment
 * the deck gets chosen — and his routine does not mention the deck at all, because
 * in practice it is implied: 1,654 of his 1,744 漢字-template cards are in
 * `日本語/漢字`. Starting from the 貫く card, the creator opens as `単語` in
 * `日本語/単語`; switching it to `漢字` moves the deck to `日本語/漢字` with it. Once
 * he picks a deck by hand, the template stops moving it.
 *
 * NOTHING IS WRITTEN UNTIL `create`. Backing out leaves no empty card behind and
 * no half-finished `[[` turned into a link.
 */
export function openNewCardDialog(options: {
  readonly name: string;
  readonly deckId: string;
  readonly templateId: string | null;
  readonly onCreated: (cardId: string) => void;
  /** `出典`: the card it was found in, and the sentence. See `src/cards/found-in.ts`. */
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
  // The lists may still be arriving on a cold page; refill once they have.
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
          // He came here to LINK a word, so the card that exists is the answer:
          // link it, exactly as a new one would have been.
          offerDuplicate(said, reply.duplicate, {
            use: {
              label: "link",
              run: (cardId) => {
                closeIfTop(root);
                options.onCreated(cardId);
              },
            },
            anyway: () => submit(true),
          });
          return;
        }
        const cardId = reply.cardId;
        pushUndo({
          describe: `new card ${cardId}`,
          run: async () => {
            await ask<"cardOp">({ kind: "cardOp", op: "delete", cardId });
            await refreshAfterOp();
          },
        });
        closeIfTop(root);
        // Link first, while the field he came from is still the one under this
        // layer; then the new card's editor goes on top of it.
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

  // Says what `出典` will record, so the link is not a surprise in the editor.
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
  // The name is already right in his routine, so the first thing he does is pick
  // the template — focus goes there. With no name yet (a "new card from this"
  // with nothing selected), the name is the first thing to type.
  if (options.name === "") title.focus();
  else template.focus();
}

/** Open the editor for a card the page does not already hold prepared. */
export async function openEditorById(
  cardId: string,
  options: { readonly replacing?: HTMLElement } = {},
): Promise<void> {
  const reply = await ask<"preview">({ kind: "preview", cardId });
  if (reply.card === null) return;
  noteVisit(cardId);
  // Swapped only NOW, once the editor is in hand: closing the preview before the
  // round trip would show a blank gap, and if he closed it himself meanwhile it is
  // no longer the top layer and the editor simply opens.
  const replaced = options.replacing !== undefined && layers.at(-1)?.root === options.replacing;
  if (replaced) closeTop();
  shell().openEditorFor(reply.card, reply.templates, { fromPreview: replaced });
}
