/**
 * VS CODE'S LINE KEYS IN EVERY TEXT FIELD. Zach, 2026-11-13, in a card's 意味:
 * *"on any text field, i want the vs code ability, like automatic markdown and alt
 * ⬆️⬇️ to move lines and like ctrl x to cut the entire line, etc..."*
 *
 *     Alt+↑ / Alt+↓            move the line (or every line the selection touches)
 *     Shift+Alt+↑ / ↓          copy it up / down
 *     Ctrl+X / Ctrl+C, nothing selected   cut / copy the whole line
 *     Ctrl+Shift+K             delete the line
 *     Enter in a list item     continue the list (`- `, `* `, `+ `, `1. `, `1) `,
 *                              `- [ ] `); Enter on an EMPTY item ends the list
 *
 * "Automatic markdown" is read as the list continuation — what VS Code does as you
 * type in a Markdown file. Shift+Enter is always a plain newline.
 *
 * THE EDITS GO THROUGH `execCommand("insertText")`, not `value =`, for two reasons
 * that both bite: assigning `value` empties the browser's undo stack, so Ctrl+Z
 * would stop working on the field; and it raises no `input` event, which the
 * editor's link mirror and every derived-field rule listen for (decision 61).
 * insertText is the same path as typing, so both keep working. Cut and copy do not
 * even do that much: they SELECT the line and let the browser's own cut or copy run.
 *
 * Steps aside for: an IME composition (Enter commits a conversion), a key another
 * handler already took (`defaultPrevented` — the `[[` link menu owns Enter and the
 * arrows while it is open), and anything that is not a plain text field.
 *
 * The line arithmetic is pure and import-free so `test/line-edit.test.ts` reaches it.
 */

/** A field's text and its selection, in UTF-16 offsets like `selectionStart`. */
export interface TextState {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Replace `[from, to)` with `insert`, then select `[start, end)` in the result. */
export interface Edit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly start: number;
  readonly end: number;
}

export function lineStart(value: string, at: number): number {
  return value.lastIndexOf("\n", at - 1) + 1;
}

export function lineEnd(value: string, at: number): number {
  const next = value.indexOf("\n", at);
  return next === -1 ? value.length : next;
}

/**
 * The lines a selection touches, as `[from, to)` without the final newline. A
 * selection that ends at the very start of a line does not take that line — the
 * way a drag down to the next line's column 0 reads in VS Code.
 */
export function selectedLines(s: TextState): { from: number; to: number } {
  const last = s.end > s.start && s.value[s.end - 1] === "\n" ? s.end - 1 : s.end;
  return { from: lineStart(s.value, s.start), to: lineEnd(s.value, Math.max(s.start, last)) };
}

/** Alt+↑ (`-1`) / Alt+↓ (`1`): swap the selected lines with the one beside them. */
export function moveLines(s: TextState, direction: -1 | 1): Edit | null {
  const { from, to } = selectedLines(s);
  const block = s.value.slice(from, to);
  if (direction === -1) {
    if (from === 0) return null;
    const prevFrom = lineStart(s.value, from - 1);
    const prev = s.value.slice(prevFrom, from - 1);
    const shift = prev.length + 1;
    return { from: prevFrom, to, insert: `${block}\n${prev}`, start: s.start - shift, end: s.end - shift };
  }
  if (to >= s.value.length) return null;
  const nextTo = lineEnd(s.value, to + 1);
  const next = s.value.slice(to + 1, nextTo);
  const shift = next.length + 1;
  return { from, to: nextTo, insert: `${next}\n${block}`, start: s.start + shift, end: s.end + shift };
}

/** Shift+Alt+↑ / ↓: duplicate the selected lines; the caret ends on the copy in that direction. */
export function copyLines(s: TextState, direction: -1 | 1): Edit {
  const { from, to } = selectedLines(s);
  const block = s.value.slice(from, to);
  if (direction === -1) return { from, to: from, insert: `${block}\n`, start: s.start, end: s.end };
  const shift = block.length + 1;
  return { from: to, to, insert: `\n${block}`, start: s.start + shift, end: s.end + shift };
}

/** Ctrl+Shift+K: remove the selected lines, newline included. */
export function deleteLines(s: TextState): Edit {
  const { from, to } = selectedLines(s);
  if (to < s.value.length) return { from, to: to + 1, insert: "", start: from, end: from };
  const cut = from > 0 ? from - 1 : from;
  return { from: cut, to, insert: "", start: lineStart(s.value, cut), end: lineStart(s.value, cut) };
}

/**
 * Ctrl+X / Ctrl+C with nothing selected: the range to select so the browser's own
 * cut or copy takes the whole line. Its newline goes with it — the one after it, or
 * for the last line the one before, so a cut leaves no blank line behind. Null when
 * there is a selection (a normal cut) or nothing to take.
 */
export function wholeLine(s: TextState): { start: number; end: number } | null {
  if (s.start !== s.end || s.value === "") return null;
  const from = lineStart(s.value, s.start);
  const to = lineEnd(s.value, s.start);
  if (to < s.value.length) return { start: from, end: to + 1 };
  if (from > 0) return { start: from - 1, end: to };
  return { start: from, end: to };
}

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/;

/**
 * Enter at a caret in a list item. Null means "not a list item here — let Enter be
 * Enter": no selection allowed, and the caret must be past the marker.
 */
export function continueList(s: TextState): Edit | null {
  if (s.start !== s.end) return null;
  const from = lineStart(s.value, s.start);
  const to = lineEnd(s.value, s.start);
  const line = s.value.slice(from, to);
  const m = LIST_ITEM.exec(line);
  if (m === null) return null;
  const marker = m[0];
  if (s.start - from < marker.length) return null;
  // An item with nothing in it: Enter ends the list, VS Code's way — the marker
  // goes and the caret stays on the now-empty line.
  if (line.slice(marker.length).trim() === "" && s.start === to) {
    return { from, to, insert: "", start: from, end: from };
  }
  const [, indent = "", bullet, number, delimiter, gap = " ", box] = m;
  const next = bullet ?? `${Number(number) + 1}${delimiter}`;
  const insert = `\n${indent}${next}${gap}${box === undefined ? "" : "[ ] "}`;
  return { from: s.start, to: s.start, insert, start: s.start + insert.length, end: s.start + insert.length };
}

/** What `value` becomes after `edit` — the check `applyEdit` makes on the browser. */
export function afterEdit(value: string, edit: Edit): string {
  return value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
}

// ─── the DOM half ────────────────────────────────────────────────────────────

type TextField = HTMLTextAreaElement | HTMLInputElement;

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", ""]);

function textField(target: EventTarget | null): TextField | null {
  if (target instanceof HTMLTextAreaElement) return target.readOnly || target.disabled ? null : target;
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) {
    return target.readOnly || target.disabled ? null : target;
  }
  return null;
}

function stateOf(field: TextField): TextState {
  return { value: field.value, start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0 };
}

/** Apply through the browser's typing path (undo + `input`), falling back to `setRangeText`. */
export function applyEdit(field: TextField, edit: Edit): void {
  const expected = afterEdit(field.value, edit);
  field.setSelectionRange(edit.from, edit.to);
  const done =
    edit.insert === ""
      ? edit.from === edit.to || document.execCommand("delete")
      : document.execCommand("insertText", false, edit.insert);
  if (!done || field.value !== expected) {
    field.value = expected;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  field.setSelectionRange(edit.start, edit.end);
}

/** The one keydown listener (`main.ts`). */
export function handleLineKeys(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  const field = textField(event.target);
  if (field === null) return;
  const s = stateOf(field);
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key;
  const multiline = field instanceof HTMLTextAreaElement;

  // Cut / copy the line: select it and run the browser's own cut or copy FROM THE
  // KEY PRESS. Leaving it to the default action is not enough: a browser need not
  // raise one for a key it was not shown (measured 2026-11-13 in the dev app's
  // Chromium, the same finding as `./copy-id.ts`). `execCommand("cut")` is an
  // editing command, so Ctrl+Z still brings the line back. If the browser refuses
  // it, the line stays selected and the default cut or copy runs as before.
  if (ctrl && !event.altKey && !event.shiftKey && (key === "x" || key === "X" || key === "c" || key === "C")) {
    const range = wholeLine(s);
    if (range === null) return;
    const command = key.toLowerCase() === "x" ? "cut" : "copy";
    field.setSelectionRange(range.start, range.end);
    if (document.execCommand(command)) event.preventDefault();
    // A copy leaves the caret where it was, as VS Code does.
    if (command === "copy") setTimeout(() => field.setSelectionRange(s.start, s.end), 0);
    return;
  }
  if (!multiline) return;

  let edit: Edit | null = null;
  if (event.altKey && !ctrl && (key === "ArrowUp" || key === "ArrowDown")) {
    const direction = key === "ArrowUp" ? -1 : 1;
    edit = event.shiftKey ? copyLines(s, direction) : moveLines(s, direction);
    // At the top or bottom there is nowhere to move: swallow it anyway, so the
    // browser does not treat Alt+↑ as something else.
    if (edit === null) {
      event.preventDefault();
      return;
    }
  } else if (ctrl && event.shiftKey && !event.altKey && (key === "k" || key === "K")) {
    edit = deleteLines(s);
  } else if (key === "Enter" && !ctrl && !event.altKey && !event.shiftKey) {
    edit = continueList(s);
  }
  if (edit === null) return;
  event.preventDefault();
  applyEdit(field, edit);
}
