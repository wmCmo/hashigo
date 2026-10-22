/**
 * Ctrl+L in the card editor toggles a cloze (`app/cloze-toggle.ts`).
 */
import { describe, expect, it } from "vitest";

import { toggleCloze, type ClozeEdit } from "../app/cloze-toggle.js";
import { parseInline } from "../src/template/parse.js";

/** Apply an edit and mark the resulting selection with [ ]. */
function run(source: string): string {
  // `|` marks a caret, `[` … `]` a selection, in the INPUT.
  const caret = source.indexOf("|");
  const text = source.replace(/[|[\]]/g, "");
  const start = caret >= 0 ? caret : source.indexOf("[");
  const end = caret >= 0 ? caret : source.indexOf("]") - 1;
  const edit = toggleCloze(text, start, end) as ClozeEdit | null;
  if (edit === null) return "null";
  const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return out.slice(0, edit.selectStart) + "[" + out.slice(edit.selectStart, edit.selectEnd) + "]" + out.slice(edit.selectEnd);
}

describe("Ctrl+L toggles a cloze", () => {
  it("wraps a selection and keeps it selected inside the braces", () => {
    expect(run("彼は[左遷]された")).toBe("彼は{{[左遷]}}された");
  });

  it("unwraps when the selection is the cloze's own text — the toggle", () => {
    expect(run("彼は{{[左遷]}}された")).toBe("彼は[左遷]された");
  });

  it("unwraps from a bare caret anywhere inside, braces included", () => {
    expect(run("彼は{{左|遷}}された")).toBe("彼は[左遷]された");
    expect(run("彼は|{{左遷}}された")).toBe("彼は[左遷]された");
    expect(run("彼は{{左遷}}|された")).toBe("彼は[左遷]された");
  });

  it("unwraps a selection that covers the whole cloze", () => {
    expect(run("彼は[{{左遷}}]された")).toBe("彼は[左遷]された");
  });

  it("drops an index with the braces", () => {
    expect(run("{{2::[きせい]}}")).toBe("[きせい]");
  });

  it("finds the right one of two clozes on a line", () => {
    expect(run("{{謙}}と{{虚|}}")).toBe("{{謙}}と[虚]");
  });

  it("a bare caret outside any cloze opens an empty one", () => {
    expect(run("謙虚|")).toBe("謙虚{{[]}}");
  });

  it("refuses a selection across a line — the renderer would print the braces", () => {
    expect(run("[一\n二]")).toBe("null");
  });

  it("what it wraps is what the renderer masks", () => {
    const text = run("彼は[左遷]された").replace(/[[\]]/g, "");
    expect(parseInline(text, []).some((n) => n.kind === "cloze")).toBe(true);
  });
});
