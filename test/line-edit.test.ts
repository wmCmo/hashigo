/**
 * VS Code's line keys (`app/line-edit.ts`) — the arithmetic, on the kind of text
 * his 意味 fields hold. Zach, 2026-11-13: *"alt ⬆️⬇️ to move lines and like ctrl x
 * to cut the entire line"*.
 */
import { describe, expect, it } from "vitest";

import {
  afterEdit,
  continueList,
  copyLines,
  deleteLines,
  moveLines,
  wholeLine,
  type Edit,
  type TextState,
} from "../app/line-edit.js";

/** `|` marks the caret, `[` `]` a selection. */
function at(marked: string): TextState {
  const caret = marked.indexOf("|");
  if (caret !== -1) return { value: marked.replace("|", ""), start: caret, end: caret };
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { value: marked.replace("[", "").replace("]", ""), start, end };
}

function show(s: TextState, edit: Edit | null): string {
  if (edit === null) return "(nothing)";
  const value = afterEdit(s.value, edit);
  if (edit.start === edit.end) return `${value.slice(0, edit.start)}|${value.slice(edit.start)}`;
  return `${value.slice(0, edit.start)}[${value.slice(edit.start, edit.end)}]${value.slice(edit.end)}`;
}

const MEANING = "1. to become stiff\nGodan verb\n2. to get absorbed in";

describe("Alt+↑ / Alt+↓ move lines", () => {
  it("moves the caret's line down, caret with it", () => {
    const s = at("1. to become stiff\nGo|dan verb\n2. to get absorbed in");
    expect(show(s, moveLines(s, 1))).toBe("1. to become stiff\n2. to get absorbed in\nGo|dan verb");
  });

  it("moves it up", () => {
    const s = at("1. to become stiff\nGo|dan verb\n2. to get absorbed in");
    expect(show(s, moveLines(s, -1))).toBe("Go|dan verb\n1. to become stiff\n2. to get absorbed in");
  });

  it("moves every line a selection touches, keeping the selection", () => {
    const s = at("a\nb[b\nc]c\nd");
    expect(show(s, moveLines(s, 1))).toBe("a\nd\nb[b\nc]c");
    expect(show(s, moveLines(s, -1))).toBe("b[b\nc]c\na\nd");
  });

  it("a selection ending at column 0 does not drag that line along", () => {
    const s = at("[a\n]b\nc");
    expect(show(s, moveLines(s, 1))).toBe("b\n[a\n]c");
  });

  it("does nothing past the top or the bottom", () => {
    expect(moveLines(at("fi|rst\nsecond"), -1)).toBeNull();
    expect(moveLines(at("first\nsec|ond"), 1)).toBeNull();
    expect(moveLines(at("on|ly"), 1)).toBeNull();
  });

  it("keeps empty lines as lines", () => {
    const s = at("a\n\n|b");
    expect(show(s, moveLines(s, -1))).toBe("a\n|b\n");
  });
});

describe("Shift+Alt+↑ / ↓ copy lines", () => {
  it("down: the copy goes below and the caret follows it", () => {
    const s = at("x\nGo|dan\ny");
    expect(show(s, copyLines(s, 1))).toBe("x\nGodan\nGo|dan\ny");
  });

  it("up: the copy goes above and the caret stays on the upper one", () => {
    const s = at("x\nGo|dan\ny");
    expect(show(s, copyLines(s, -1))).toBe("x\nGo|dan\nGodan\ny");
  });
});

describe("Ctrl+X / Ctrl+C with nothing selected take the whole line", () => {
  it("a middle line, with the newline after it", () => {
    const s = at(MEANING.replace("Godan", "Go|dan"));
    const range = wholeLine(s);
    expect(range).not.toBeNull();
    expect(s.value.slice(range!.start, range!.end)).toBe("Godan verb\n");
  });

  it("the last line takes the newline BEFORE it, so a cut leaves no blank line", () => {
    const s = at("first\nla|st");
    const range = wholeLine(s)!;
    expect(s.value.slice(0, range.start) + s.value.slice(range.end)).toBe("first");
  });

  it("the only line", () => {
    const s = at("on|ly");
    expect(wholeLine(s)).toEqual({ start: 0, end: 4 });
  });

  it("steps aside for a real selection and an empty field", () => {
    expect(wholeLine(at("a [bc] d"))).toBeNull();
    expect(wholeLine(at("|"))).toBeNull();
  });
});

describe("Ctrl+Shift+K deletes lines", () => {
  it("a middle line", () => {
    const s = at("a\nb|b\nc");
    expect(show(s, deleteLines(s))).toBe("a\n|c");
  });

  it("the last line, leaving no trailing newline", () => {
    const s = at("a\nb|b");
    expect(show(s, deleteLines(s))).toBe("|a");
  });
});

describe("Enter continues a Markdown list", () => {
  it("numbers the next item", () => {
    const s = at("1. to become stiff|");
    expect(show(s, continueList(s))).toBe("1. to become stiff\n2. |");
  });

  it("keeps the bullet, the delimiter, the indent and the gap", () => {
    expect(show(at("  - stiff|"), continueList(at("  - stiff|")))).toBe("  - stiff\n  - |");
    expect(show(at("9) x|"), continueList(at("9) x|")))).toBe("9) x\n10) |");
    expect(show(at("*   x|"), continueList(at("*   x|")))).toBe("*   x\n*   |");
  });

  it("a task item starts an unchecked one", () => {
    const s = at("- [x] done|");
    expect(show(s, continueList(s))).toBe("- [x] done\n- [ ] |");
  });

  it("splits an item where the caret is", () => {
    const s = at("- to become| stiff");
    expect(show(s, continueList(s))).toBe("- to become\n- | stiff");
  });

  it("Enter on an empty item ends the list", () => {
    const s = at("1. stiff\n2. |");
    expect(show(s, continueList(s))).toBe("1. stiff\n|");
  });

  it("is plain Enter outside a list, before the marker, or over a selection", () => {
    expect(continueList(at("Godan verb|"))).toBeNull();
    expect(continueList(at("|1. stiff"))).toBeNull();
    expect(continueList(at("1. [stiff]"))).toBeNull();
    // A year is not a list: no space after the dot.
    expect(continueList(at("2026.11|"))).toBeNull();
    // Japanese text with a full stop is not a list either.
    expect(continueList(at("最近はどんな物に凝っているの？|"))).toBeNull();
  });
});
