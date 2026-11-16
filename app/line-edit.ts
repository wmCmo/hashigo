export interface TextState {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

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

export function selectedLines(s: TextState): { from: number; to: number } {
  const last = s.end > s.start && s.value[s.end - 1] === "\n" ? s.end - 1 : s.end;
  return { from: lineStart(s.value, s.start), to: lineEnd(s.value, Math.max(s.start, last)) };
}

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

export function copyLines(s: TextState, direction: -1 | 1): Edit {
  const { from, to } = selectedLines(s);
  const block = s.value.slice(from, to);
  if (direction === -1) return { from, to: from, insert: `${block}\n`, start: s.start, end: s.end };
  const shift = block.length + 1;
  return { from: to, to, insert: `\n${block}`, start: s.start + shift, end: s.end + shift };
}

export function deleteLines(s: TextState): Edit {
  const { from, to } = selectedLines(s);
  if (to < s.value.length) return { from, to: to + 1, insert: "", start: from, end: from };
  const cut = from > 0 ? from - 1 : from;
  return { from: cut, to, insert: "", start: lineStart(s.value, cut), end: lineStart(s.value, cut) };
}

export function wholeLine(s: TextState): { start: number; end: number } | null {
  if (s.start !== s.end || s.value === "") return null;
  const from = lineStart(s.value, s.start);
  const to = lineEnd(s.value, s.start);
  if (to < s.value.length) return { start: from, end: to + 1 };
  if (from > 0) return { start: from - 1, end: to };
  return { start: from, end: to };
}

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/;

export function continueList(s: TextState): Edit | null {
  if (s.start !== s.end) return null;
  const from = lineStart(s.value, s.start);
  const to = lineEnd(s.value, s.start);
  const line = s.value.slice(from, to);
  const m = LIST_ITEM.exec(line);
  if (m === null) return null;
  const marker = m[0];
  if (s.start - from < marker.length) return null;
  if (line.slice(marker.length).trim() === "" && s.start === to) {
    return { from, to, insert: "", start: from, end: from };
  }
  const [, indent = "", bullet, number, delimiter, gap = " ", box] = m;
  const next = bullet ?? `${Number(number) + 1}${delimiter}`;
  const insert = `\n${indent}${next}${gap}${box === undefined ? "" : "[ ] "}`;
  return { from: s.start, to: s.start, insert, start: s.start + insert.length, end: s.start + insert.length };
}

export function afterEdit(value: string, edit: Edit): string {
  return value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
}

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

export function handleLineKeys(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  const field = textField(event.target);
  if (field === null) return;
  const s = stateOf(field);
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key;
  const multiline = field instanceof HTMLTextAreaElement;

  if (ctrl && !event.altKey && !event.shiftKey && (key === "x" || key === "X" || key === "c" || key === "C")) {
    const range = wholeLine(s);
    if (range === null) return;
    const command = key.toLowerCase() === "x" ? "cut" : "copy";
    field.setSelectionRange(range.start, range.end);
    if (document.execCommand(command)) event.preventDefault();
    if (command === "copy") setTimeout(() => field.setSelectionRange(s.start, s.end), 0);
    return;
  }
  if (!multiline) return;

  let edit: Edit | null = null;
  if (event.altKey && !ctrl && (key === "ArrowUp" || key === "ArrowDown")) {
    const direction = key === "ArrowUp" ? -1 : 1;
    edit = event.shiftKey ? copyLines(s, direction) : moveLines(s, direction);
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
