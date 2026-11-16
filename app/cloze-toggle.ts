export interface ClozeEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly selectStart: number;
  readonly selectEnd: number;
}

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
