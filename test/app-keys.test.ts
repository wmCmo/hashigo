/**
 * The key table, enumerated — the rule the two most expensive bugs in `app/` lived
 * inside.
 *
 * Both were the same shape: a key correct in one state doing something destructive
 * in another, with nothing on screen to say so. Typing a deck name into the
 * gallery's filter box archived and GRADED the card behind it. Grading during his
 * #9 look-ahead moves a due date on a card he is not reading. Neither is visible
 * when it happens, and each was one boolean in a long `if` chain.
 *
 * So the tests here are not "does `j` grade". They are the STATES: what does `j` do
 * when he is typing, when a preview is up, when the sidebar is open, when he is
 * looking ahead. That is the axis the bugs were on.
 */

import { describe, expect, it } from "vitest";

import { REVIEWING, reviewAction, type KeyState } from "../app/review-keys.js";

/** A keystroke, defaulting to no modifiers. */
const press = (key: string, mods: Partial<Record<string, boolean>> = {}) => ({ key, ...mods });

const state = (over: Partial<KeyState> = {}): KeyState => ({ ...REVIEWING, ...over });

describe("reviewing a card", () => {
  it("reveals, then grades", () => {
    expect(reviewAction(press(" "), state())).toBe("reveal");
    expect(reviewAction(press("Enter"), state())).toBe("reveal");
    // SPACE WALKS, AND `revealed` DOES NOT STOP IT — Zach's stepped reveal,
    // 2026-09-12. Mid-walk the answer is partly up (so `revealed`) and there is
    // still somewhere to go (so `moreToReveal`), and space has to keep going or
    // the keyboard stops halfway through a card the thumb can still finish.
    expect(reviewAction(press(" "), state({ revealed: true }))).toBe("reveal");
    // At the END of the walk it stops: a spare space must not re-enter anything.
    expect(reviewAction(press(" "), state({ revealed: true, moreToReveal: false }))).toBeNull();

    // f and j are DEAD until the reveal. That is decision 2's binary grade being
    // an answer to a question he has actually been asked.
    expect(reviewAction(press("f"), state())).toBeNull();
    expect(reviewAction(press("j"), state())).toBeNull();
    expect(reviewAction(press("f"), state({ revealed: true }))).toBe("gradeForgot");
    expect(reviewAction(press("j"), state({ revealed: true }))).toBe("gradeRemembered");
    expect(reviewAction(press("r"), state({ revealed: true }))).toBe("replay");
  });

  /**
   * REPLAY BEFORE THE REVEAL, and only when the clip is the QUESTION.
   *
   * Zach hit the first arm on a 数字 card: *"why can't i see the play button, now i
   * can't replay it even if i want to, i would have to click review first"*. On a
   * mode-2 card revealing to hear the question again shows him the answer, which is
   * the exercise on 3,177 cards.
   *
   * The second arm is decision 29 and must NOT be relaxed with it: on the 692
   * `Reading = true` cards the clip is the answer, so replay stays behind the
   * reveal. Both arms are asserted here for the same reason the mode-1 autoplay
   * tests are — so that fixing one does not quietly delete the other.
   */
  it("REPLAYS BEFORE THE REVEAL when the card asked — and not when it did not", () => {
    expect(reviewAction(press("r"), state({ asked: true }))).toBe("replay");
    expect(reviewAction(press("r"), state({ asked: false }))).toBeNull();
    // Once revealed, both arms replay: the answer is already on screen.
    expect(reviewAction(press("r"), state({ asked: false, revealed: true }))).toBe("replay");
    expect(reviewAction(press("r"), state({ asked: true, revealed: true }))).toBe("replay");
  });

  it("does not let `asked` leak into grading — that is still the reveal's job", () => {
    // The narrow fix must stay narrow. `asked` is about the QUESTION being audible,
    // and nothing about it means he has answered.
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
    // Unlike `a` and `d` a pin has no visible consequence on the card, so a
    // silently pinned card is one he finds later and cannot explain.
    expect(reviewAction(press("p"), state())).toBeNull();
  });

  it("does nothing at all when there is no card", () => {
    const s = state({ hasCard: false, revealed: true });
    for (const key of ["a", "d", "P", "ArrowRight", "ArrowLeft"]) {
      expect(reviewAction(press(key, { shiftKey: true }), s), key).toBeNull();
    }
    // `e` and reveal are about the screen, not the card, and stay reachable.
    expect(reviewAction(press("e"), s)).toBe("edit");
  });
});

describe("TYPING MUST NEVER GRADE, ARCHIVE OR DELETE", () => {
  /**
   * The bug, by name. Every single-key shortcut fired while he typed in the
   * gallery's filter box, because `reviewView.hidden` is FALSE the whole time the
   * gallery is up — it is shown by `data-view` on the body and hidden in CSS.
   *
   *   a  ->  archived the review card behind the gallery
   *   d  ->  opened the delete-confirm for it
   *   j  ->  graded it REMEMBERED, if it had been revealed
   *   f  ->  graded it FORGOT
   *   space/enter -> revealed it, which is what made j and f live
   *
   * Typing "japanese" was an archive and a grade.
   */
  it("swallows every destructive key while a text field has focus", () => {
    const typing = state({ typing: true, revealed: true });
    for (const key of ["a", "d", "f", "j", "e", "r", " ", "Enter", "/", "P"]) {
      expect(reviewAction(press(key, { shiftKey: true }), typing), key).toBeNull();
    }
    // The exact word that was typed, letter by letter, against a revealed card.
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
    // Ctrl+K over a filter box is a reasonable thing to press. Ctrl+Z inside a text
    // field means the browser's own undo, not the app's card-operation stack.
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
    // `layerActs` is deliberately not "the layer has a card". The editor has one and
    // every field in it is an input, so a rule keyed on the id would archive the card
    // he is editing the moment focus sat on the panel instead of in a box.
    const editor = state({ layerOpen: true, layerActs: false });
    expect(reviewAction(press("a"), editor)).toBeNull();
    expect(reviewAction(press("d"), editor)).toBeNull();
    expect(reviewAction(press("P", { shiftKey: true }), editor)).toBeNull();
    // `e` and Escape still work: closing it and re-opening it are not destructive.
    expect(reviewAction(press("Escape"), editor)).toBe("closeLayer");
    expect(reviewAction(press("e"), editor)).toBe("editLayer");
  });

  it("beats the sidebar — a layer is a thing he opened on purpose", () => {
    const both = state({ layerOpen: true, layerActs: true, sidebarOpen: true });
    expect(reviewAction(press("Escape"), both)).toBe("closeLayer");
  });
});

describe("HIS #9: looking ahead must not grade a card he is not reading", () => {
  /**
   * `answer()` grades the SESSION's current item, not what is displayed. So `j`
   * during a look-ahead writes a `reviews` row and advances the FSRS schedule of a
   * different card — silently, from the key he presses a hundred times a day.
   */
  it("blocks both grade keys and says so, rather than ignoring them", () => {
    const peeking = state({ peeking: true, revealed: true });
    expect(reviewAction(press("j"), peeking)).toBe("gradeBlocked");
    expect(reviewAction(press("f"), peeking)).toBe("gradeBlocked");
    // SAID, not swallowed: the two keys he uses constantly doing nothing without
    // explanation reads as the app being broken.
    expect(reviewAction(press("j"), peeking)).not.toBeNull();
  });

  it("keeps the way OUT working — the arrows and Escape", () => {
    const peeking = state({ peeking: true, revealed: true });
    expect(reviewAction(press("ArrowLeft"), peeking)).toBe("previous");
    expect(reviewAction(press("ArrowRight"), peeking)).toBe("next");
    expect(reviewAction(press("Escape"), peeking)).toBe("backToCard");
  });

  it("leaves Escape inert when he is NOT looking ahead", () => {
    // Nothing else in review answers to Escape, and inventing a meaning for it
    // there would make the one key that always means "get out of this" ambiguous.
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
    // Boot, and the done screen. There is no card, and `reviewHidden` is the only
    // flag that is actually true in those states.
    const hidden = state({ reviewHidden: true, revealed: true });
    for (const key of ["a", "d", "f", "j", "e", " ", "r", "ArrowRight"]) {
      expect(reviewAction(press(key), hidden), key).toBeNull();
    }
    // The two global ones survive: he can still undo and still search.
    expect(reviewAction(press("k", { ctrlKey: true }), hidden)).toBe("palette");
    expect(reviewAction(press("z", { ctrlKey: true }), hidden)).toBe("undo");
  });

  it("ignores an auto-repeating key", () => {
    // Holding `j` down must grade once, not once per repeat.
    expect(reviewAction({ key: "j", repeat: true }, state({ revealed: true }))).toBeNull();
  });
});

/**
 * THE SHADOWING CONTROLS SIT BEFORE THE REVEAL, AND THAT IS THE POINT.
 *
 * The drill is produce-then-verify: look at the kanji, recall the contour, say it
 * aloud, THEN reveal and compare. Setting the rate and arming the recorder belong
 * to the first half. A control reachable only after the reveal is a control for
 * an exercise he has already finished — which is the same mistake decision 29's
 * `asked` gate exists to prevent for replay, and Zach reported that one out loud:
 * *"now i can't replay it even if i want to"*.
 */
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
    // `event.key` for shift+m is "M", which lowercases to the same "m" as the
    // record key — so the shifted branch has to come first or recording starts
    // every time he asks to hear himself.
    expect(reviewAction(press("m", { shiftKey: true }), state({ hasTake: true }))).toBe("playTake");
    expect(reviewAction(press("m", { shiftKey: true }), state({ hasTake: false }))).toBeNull();
    // And the unshifted key is unaffected by the take existing.
    expect(reviewAction(press("m"), state({ hasTake: true }))).toBe("toggleRecord");
  });

  it("does not reach past a text field, a layer, or a hidden review screen", () => {
    // The guard every single-key shortcut in this table lives behind. Typing
    // "small" into the gallery filter must not cycle the speed and open the mic.
    for (const key of ["l", "s", "m"]) {
      expect(reviewAction(press(key), state({ typing: true })), key).toBeNull();
      expect(reviewAction(press(key), state({ layerOpen: true })), key).toBeNull();
      expect(reviewAction(press(key), state({ reviewHidden: true })), key).toBeNull();
      expect(reviewAction(press(key), state({ hasCard: false })), key).toBeNull();
    }
  });

  it("takes no key that already meant something", () => {
    // `l`, `s` and `m` were free; the ones in his fingers are not. If a future
    // control reaches for one of these, this is where it gets caught.
    const fresh = state();
    expect(reviewAction(press("f"), state({ revealed: true }))).toBe("gradeForgot");
    expect(reviewAction(press("j"), state({ revealed: true }))).toBe("gradeRemembered");
    expect(reviewAction(press("a"), fresh)).toBe("archive");
    expect(reviewAction(press("d"), fresh)).toBe("delete");
    expect(reviewAction(press("e"), fresh)).toBe("edit");
    expect(reviewAction(press("r"), state({ asked: true }))).toBe("replay");
  });
});
