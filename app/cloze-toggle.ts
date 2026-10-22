/**
 * CTRL+L IN THE EDITOR TOGGLES A CLOZE. Zach, 2026-10-22: *"when i edit the card,
 * if i select any text, and press ctrl + l, i want to be able to toggle the
 * cloze"*.
 *
 * Pure: text and selection in, one replacement out. The caller applies it with
 * `insertText` so Ctrl+Z still undoes it — assigning `.value` would wipe the
 * textarea's undo stack.
 *
 * The rules, in order:
 *
 *   1. The selection (or the bare caret) sits inside a cloze — anywhere from its
 *      `{{` to its `}}` — so UNWRAP it, `n::` index included, and select what was
 *      inside. Pressing it again re-wraps the same text, which is the toggle.
 *   2. A selection that is not inside one is WRAPPED, and stays selected inside
 *      the braces.
 *   3. A bare caret outside any cloze gets an empty `{{}}` with the caret inside.
 *
 * A cloze is found the way `parseInline` finds one — the first `}}` after a `{{`,
 * on the same line — so what this unwraps is exactly what the renderer masks.
 * A selection that crosses a line is refused: `parseInline` never closes a cloze
 * across one (0 of 1,087 in the corpus do), so the wrap would render as braces.
 */

export interface ClozeEdit {
  /** The range of the ORIGINAL text to replace. */
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  /** The selection to leave, in the NEW text. */
  readonly selectStart: number;
  readonly selectEnd: number;
}

/** The `{{…}}` spans on the line holding `at`, as [open, closeEnd) offsets. */
function spansOnLine(text: string, at: number): [number, number][] {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const newline = text.indexOf("\n", at);
  const lineEnd = newline < 0 ? text.length : newline;
  const spans: [number, number][] = [];
  let i = lineStart;
  while (i < lineEnd) {
    const open = text.indexOf("{{", i);
    if (open < 0 || open >= lineEnd) break;
    const close = text.indexOf("}}", open + 2);
    // `close > open + 2`: the parser does not treat an empty `{{}}` as a cloze,
    // but unwrapping one is still the right answer to Ctrl+L on it.
    if (close < 0 || close + 2 > lineEnd) break;
    spans.push([open, close + 2]);
    i = close + 2;
  }
  return spans;
}

export function toggleCloze(text: string, start: number, end: number): ClozeEdit | null {
  const from = Math.min(start, end);
  const to = Math.max(start, end);

  const enclosing = spansOnLine(text, from).find(([open, closeEnd]) => open <= from && to <= closeEnd);
  if (enclosing !== undefined) {
    const [open, closeEnd] = enclosing;
    const inner = text.slice(open + 2, closeEnd - 2);
    const body = inner.replace(/^\d+::/, "");
    return { from: open, to: closeEnd, insert: body, selectStart: open, selectEnd: open + body.length };
  }

  const selected = text.slice(from, to);
  if (selected.includes("\n")) return null;
  return {
    from,
    to,
    insert: `{{${selected}}}`,
    selectStart: from + 2,
    selectEnd: from + 2 + selected.length,
  };
}
