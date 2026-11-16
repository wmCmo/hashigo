import { describe, expect, it } from "vitest";

import { REVIEWING, reviewAction, type KeyState } from "../app/review-keys.js";

const press = (key: string, mods: Partial<Record<string, boolean>> = {}) => ({ key, ...mods });

const state = (over: Partial<KeyState> = {}): KeyState => ({ ...REVIEWING, ...over });

describe("reviewing a card", () => {
  it("reveals, then grades", () => {
    expect(reviewAction(press(" "), state())).toBe("reveal");
    expect(reviewAction(press("Enter"), state())).toBe("reveal");
    expect(reviewAction(press(" "), state({ revealed: true }))).toBe("reveal");
    expect(reviewAction(press(" "), state({ revealed: true, moreToReveal: false }))).toBeNull();

    expect(reviewAction(press("f"), state())).toBeNull();
    expect(reviewAction(press("j"), state())).toBeNull();
    expect(reviewAction(press("f"), state({ revealed: true }))).toBe("gradeForgot");
    expect(reviewAction(press("j"), state({ revealed: true, moreToReveal: false }))).toBe(
      "gradeRemembered",
    );
    expect(reviewAction(press("r"), state({ revealed: true }))).toBe("replay");
  });

  it("`f` fires from the first step; `j` waits for the last", () => {
    const midWalk = state({ revealed: true, moreToReveal: true });
    expect(reviewAction(press("f"), midWalk)).toBe("gradeForgot");
    expect(reviewAction(press("j"), midWalk)).toBe("gradeTooEarly");

    const walkDone = state({ revealed: true, moreToReveal: false });
    expect(reviewAction(press("f"), walkDone)).toBe("gradeForgot");
    expect(reviewAction(press("j"), walkDone)).toBe("gradeRemembered");

    expect(reviewAction(press(" "), midWalk)).toBe("reveal");

    expect(reviewAction(press("j"), state({ ...midWalk, peeking: true }))).toBe("gradeBlocked");
    expect(reviewAction(press("j"), state({ ...walkDone, peeking: true }))).toBe("gradeBlocked");
  });

  it("REPLAYS BEFORE THE REVEAL when the card asked — and not when it did not", () => {
    expect(reviewAction(press("r"), state({ asked: true }))).toBe("replay");
    expect(reviewAction(press("r"), state({ asked: false }))).toBeNull();
    expect(reviewAction(press("r"), state({ asked: false, revealed: true }))).toBe("replay");
    expect(reviewAction(press("r"), state({ asked: true, revealed: true }))).toBe("replay");
  });

  it("does not let `asked` leak into grading — that is still the reveal's job", () => {
    const asked = state({ asked: true });
    expect(reviewAction(press("f"), asked)).toBeNull();
    expect(reviewAction(press("j"), asked)).toBeNull();
    expect(reviewAction(press(" "), asked)).toBe("reveal");
  });

  it("acts on the card WITHOUT grading, revealed or not", () => {
    for (const revealed of [false, true]) {
      const s = state({ revealed });
      expect(reviewAction(press("a"), s)).toBe("archive");
      expect(reviewAction(press("d"), s)).toBe("delete");
      expect(reviewAction(press("e"), s)).toBe("edit");
      expect(reviewAction(press("ArrowRight"), s)).toBe("next");
      expect(reviewAction(press("ArrowLeft"), s)).toBe("previous");
    }
  });

  it("SHIFT-qualifies pin, because `p` alone is one slip from `o`", () => {
    expect(reviewAction(press("P", { shiftKey: true }), state())).toBe("pin");
    expect(reviewAction(press("p"), state())).toBeNull();
  });

  it("does nothing at all when there is no card", () => {
    const s = state({ hasCard: false, revealed: true });
    for (const key of ["a", "d", "P", "ArrowRight", "ArrowLeft"]) {
      expect(reviewAction(press(key, { shiftKey: true }), s), key).toBeNull();
    }
    expect(reviewAction(press("e"), s)).toBe("edit");
  });
});

describe("TYPING MUST NEVER GRADE, ARCHIVE OR DELETE", () => {
  it("swallows every destructive key while a text field has focus", () => {
    const typing = state({ typing: true, revealed: true });
    for (const key of ["a", "d", "f", "j", "e", "r", " ", "Enter", "/", "P"]) {
      expect(reviewAction(press(key, { shiftKey: true }), typing), key).toBeNull();
    }
    for (const key of [..."japanese"]) {
      expect(reviewAction(press(key), typing), key).toBeNull();
    }
  });

  it("lets Escape through, because it closes the thing he is typing in", () => {
    expect(reviewAction(press("Escape"), state({ typing: true, layerOpen: true }))).toBe(
      "closeLayer",
    );
    expect(reviewAction(press("Escape"), state({ typing: true, sidebarOpen: true }))).toBe(
      "closeSidebar",
    );
  });

  it("lets Ctrl+K through and holds Ctrl+Z back", () => {
    expect(reviewAction(press("k", { ctrlKey: true }), state({ typing: true }))).toBe("palette");
    expect(reviewAction(press("z", { ctrlKey: true }), state({ typing: true }))).toBeNull();
    expect(reviewAction(press("z", { ctrlKey: true }), state())).toBe("undo");
    expect(reviewAction(press("z", { metaKey: true }), state())).toBe("undo");
  });

  it("ignores every other modified key rather than guessing", () => {
    for (const key of ["a", "d", "f", "j", " ", "s", "r"]) {
      expect(reviewAction(press(key, { ctrlKey: true }), state({ revealed: true })), key).toBeNull();
    }
  });
});

describe("a layer owns the keyboard", () => {
  it("stops space grading the card UNDERNEATH the preview he is reading", () => {
    const s = state({ layerOpen: true, layerActs: true, revealed: true });
    expect(reviewAction(press(" "), s)).toBeNull();
    expect(reviewAction(press("j"), s)).toBeNull();
    expect(reviewAction(press("f"), s)).toBeNull();
    expect(reviewAction(press("ArrowRight"), s)).toBeNull();
  });

  it("gives the preview its own operations — his 'on both preview and review'", () => {
    const s = state({ layerOpen: true, layerActs: true });
    expect(reviewAction(press("Escape"), s)).toBe("closeLayer");
    expect(reviewAction(press("e"), s)).toBe("editLayer");
    expect(reviewAction(press("P", { shiftKey: true }), s)).toBe("layerPin");
    expect(reviewAction(press("a"), s)).toBe("layerArchive");
    expect(reviewAction(press("d"), s)).toBe("layerDelete");
  });

  it("REFUSES THEM ON THE EDITOR, which also carries a card id", () => {
    const editor = state({ layerOpen: true, layerActs: false });
    expect(reviewAction(press("a"), editor)).toBeNull();
    expect(reviewAction(press("d"), editor)).toBeNull();
    expect(reviewAction(press("P", { shiftKey: true }), editor)).toBeNull();
    expect(reviewAction(press("Escape"), editor)).toBe("closeLayer");
    expect(reviewAction(press("e"), editor)).toBe("editLayer");
  });

  it("beats the sidebar — a layer is a thing he opened on purpose", () => {
    const both = state({ layerOpen: true, layerActs: true, sidebarOpen: true });
    expect(reviewAction(press("Escape"), both)).toBe("closeLayer");
  });
});

describe("HIS #9: looking ahead must not grade a card he is not reading", () => {
  it("blocks both grade keys and says so, rather than ignoring them", () => {
    const peeking = state({ peeking: true, revealed: true });
    expect(reviewAction(press("j"), peeking)).toBe("gradeBlocked");
    expect(reviewAction(press("f"), peeking)).toBe("gradeBlocked");
    expect(reviewAction(press("j"), peeking)).not.toBeNull();
  });

  it("keeps the way OUT working — the arrows and Escape", () => {
    const peeking = state({ peeking: true, revealed: true });
    expect(reviewAction(press("ArrowLeft"), peeking)).toBe("previous");
    expect(reviewAction(press("ArrowRight"), peeking)).toBe("next");
    expect(reviewAction(press("Escape"), peeking)).toBe("backToCard");
  });

  it("leaves Escape inert when he is NOT looking ahead", () => {
    expect(reviewAction(press("Escape"), state({ revealed: true }))).toBeNull();
  });

  it("still allows reveal, archive and pin — none of them writes a review", () => {
    const peeking = state({ peeking: true });
    expect(reviewAction(press(" "), peeking)).toBe("reveal");
    expect(reviewAction(press("a"), peeking)).toBe("archive");
    expect(reviewAction(press("P", { shiftKey: true }), peeking)).toBe("pin");
  });
});

describe("the sidebar and the boot screen", () => {
  it("answers Escape, and leaves the rest to the box he is typing in", () => {
    expect(reviewAction(press("Escape"), state({ sidebarOpen: true }))).toBe("closeSidebar");
    expect(reviewAction(press("/"), state())).toBe("openSidebar");
  });

  it("does nothing while the review view is not on screen", () => {
    const hidden = state({ reviewHidden: true, revealed: true });
    for (const key of ["a", "d", "f", "j", "e", " ", "r", "ArrowRight"]) {
      expect(reviewAction(press(key), hidden), key).toBeNull();
    }
    expect(reviewAction(press("k", { ctrlKey: true }), hidden)).toBe("palette");
    expect(reviewAction(press("z", { ctrlKey: true }), hidden)).toBe("undo");
  });

  it("ignores an auto-repeating key", () => {
    expect(reviewAction({ key: "j", repeat: true }, state({ revealed: true }))).toBeNull();
  });
});

describe("loop, speed and recording (2026-09-12)", () => {
  it("all work BEFORE anything is revealed", () => {
    const fresh = state({ revealed: false, moreToReveal: true });
    expect(reviewAction(press("l"), fresh)).toBe("toggleLoop");
    expect(reviewAction(press("s"), fresh)).toBe("cycleSpeed");
    expect(reviewAction(press("m"), fresh)).toBe("toggleRecord");
  });

  it("and after", () => {
    const done = state({ revealed: true, moreToReveal: false });
    expect(reviewAction(press("l"), done)).toBe("toggleLoop");
    expect(reviewAction(press("s"), done)).toBe("cycleSpeed");
    expect(reviewAction(press("m"), done)).toBe("toggleRecord");
  });

  it("shift+m plays the take, and does nothing when there is none", () => {
    expect(reviewAction(press("m", { shiftKey: true }), state({ hasTake: true }))).toBe("playTake");
    expect(reviewAction(press("m", { shiftKey: true }), state({ hasTake: false }))).toBeNull();
    expect(reviewAction(press("m"), state({ hasTake: true }))).toBe("toggleRecord");
  });

  it("does not reach past a text field, a layer, or a hidden review screen", () => {
    for (const key of ["l", "s", "m"]) {
      expect(reviewAction(press(key), state({ typing: true })), key).toBeNull();
      expect(reviewAction(press(key), state({ layerOpen: true })), key).toBeNull();
      expect(reviewAction(press(key), state({ reviewHidden: true })), key).toBeNull();
      expect(reviewAction(press(key), state({ hasCard: false })), key).toBeNull();
    }
  });

  it("takes no key that already meant something", () => {
    const fresh = state();
    expect(reviewAction(press("f"), state({ revealed: true }))).toBe("gradeForgot");
    expect(reviewAction(press("j"), state({ revealed: true, moreToReveal: false }))).toBe(
      "gradeRemembered",
    );
    expect(reviewAction(press("a"), fresh)).toBe("archive");
    expect(reviewAction(press("d"), fresh)).toBe("delete");
    expect(reviewAction(press("e"), fresh)).toBe("edit");
    expect(reviewAction(press("r"), state({ asked: true }))).toBe("replay");
  });
});
