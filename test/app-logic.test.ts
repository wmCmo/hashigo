import { describe, expect, it } from "vitest";

import { childrenOf, rootsOf, subtreeTotals, type TreeDeck } from "../app/deck-tree.js";
import { isTypingTarget, survivesTyping } from "../app/keys.js";
import {
  promptPositions,
  visiblePositions,
  type BoundarySide,
} from "../app/review-boundary.js";

/**
 * THE FIRST TESTS `app/` HAS EVER HAD.
 *
 * `app/` is the shipping UI — 4,829 lines across `main.ts` (1,987), `db.worker.ts`
 * (940), `style.css` (1,243), `protocol.ts` (495) — and until this file, `grep -rl
 * "app/" test/` returned nothing. Every one of those lines was covered by `npm run
 * app:check` proving it TYPES and by nothing at all proving it BEHAVES.
 *
 * That is not evenly risky. A wrong colour is visible the moment he opens the page; a
 * wrong question boundary printed the answer above the question and was only caught
 * because a human was looking at the first card of a real session. So the rules pulled
 * out of `main.ts` and pinned here are the ones whose failure is SILENT:
 *
 *   keys.ts              is he typing? Shortcuts GRADED from the gallery filter box.
 *   review-boundary.ts   which sides are the question. Has been wrong in production.
 *   deck-tree.ts         a parent's totals, and the recursion that computes them.
 *
 * WHY THIS IS NOT "app/ IS NOW TESTED". It is not. This covers two extracted modules
 * of pure logic. The DOM painting, the worker RPC, the modal stack and the undo stack
 * remain untested, and the honest reason is that testing them needs a DOM environment
 * — a new dependency and a bigger decision than one session should make alone. What
 * this does establish is the SEAM: pure rule in its own import-free module, tested in
 * Node, called from `main.ts`. Every future rule can follow it.
 */

// ── the question boundary ─────────────────────────────────────────────────────

/** `position` is display order (post-permutation); `index` is the authored side. */
function side(
  position: number,
  index: number,
  { empty = false, text = "" }: { empty?: boolean; text?: string } = {},
): BoundarySide {
  return { position, index, empty, text };
}

describe("the question boundary — which sides are the prompt", () => {
  it("is the first visible side, and nothing else, on an ordinary card", () => {
    // 単語, Reading = true: side 1 is the head word, sides 2-4 are the answer.
    const sides = [
      side(0, 0, { text: "慈善" }),
      side(1, 1, { text: "じぜん 平板" }),
      side(2, 2, { text: "example sentence" }),
      side(3, 3, { text: "charity" }),
    ];
    expect(promptPositions(sides, [])).toEqual([0]);
  });

  it("SKIPS an empty leading side, which is how a `Reading = false` 単語 starts at side 2", () => {
    // Side 1's whole body sits inside `<<#Reading>>`, so it renders to nothing. The
    // screen has to start at side 2 rather than showing a blank panel.
    const sides = [
      side(0, 0, { empty: true }),
      side(1, 1, { text: "[…] […] 中高 (3)" }),
      side(2, 2, { text: "example sentence" }),
    ];
    expect(visiblePositions(sides)).toEqual([1, 2]);
    expect(promptPositions(sides, [])).toEqual([1]);
  });

  it("extends over a widget-ONLY side, which is 漢字's draw canvas", () => {
    // `<draw>` has its own side and must be on screen while he draws from memory, so
    // the question is side 1 AND side 2 here — the one case the rule is not just
    // "the first side".
    const sides = [
      side(0, 0, { text: "慈" }),
      side(1, 1, { text: "" }), // the canvas: a widget and no text
      side(2, 2, { text: "じ" }),
    ];
    expect(promptPositions(sides, [1])).toEqual([0, 1]);
  });

  it("STOPS at a widget side that also carries text, because that is an answer side", () => {
    const sides = [
      side(0, 0, { text: "慈" }),
      side(1, 1, { text: "じ — the answer, beside the widget" }),
    ];
    expect(promptPositions(sides, [1])).toEqual([0]);
  });

  it("does not extend past a NON-widget side even when the next one has a widget", () => {
    // The run must be contiguous. A gap ends the question.
    const sides = [
      side(0, 0, { text: "a" }),
      side(1, 1, { text: "b" }), // no widget: stop here
      side(2, 2, { text: "" }), // widget, but unreachable
    ];
    expect(promptPositions(sides, [2])).toEqual([0]);
  });

  it("IS POSITIONAL, NOT AUTHORED — the regression that printed the answer above the question", () => {
    // The real card: `oYjmEPwB` (`constraint`), a reverse track whose order is permuted
    // to Meaning → Example → Vocab. Its Example side carries audio, and the first
    // version of this rule pulled "every side up to the first that hides or sounds
    // something" into the question — which on THIS permutation is the meaning AND the
    // sentence, i.e. the answer.
    //
    // Authored order:  0 vocab · 1 example(audio) · 2 meaning
    // Display order:   meaning first, then example, then vocab.
    const sides = [
      side(0, 2, { text: "time constraints make it impossible to do everything" }),
      side(1, 1, { text: "an example sentence, with audio" }),
      side(2, 0, { text: "constraint" }),
    ];
    // The question is the FIRST DISPLAYED side and stops there. Audio on a later side
    // is not a reason to include it — that is exactly the bug.
    expect(promptPositions(sides, [])).toEqual([0]);
  });

  it("yields an empty question for a card that renders nothing, rather than throwing", () => {
    expect(promptPositions([], [])).toEqual([]);
    expect(promptPositions([side(0, 0, { empty: true })], [])).toEqual([]);
  });

  it("ignores a widget pointing at a side that did not render", () => {
    // The `?? -1` in the implementation. A dangling widget must not extend the
    // question over a side the reader cannot see.
    const sides = [side(0, 0, { text: "a" }), side(1, 1, { text: "" })];
    expect(promptPositions(sides, [99])).toEqual([0]);
  });
});

// ── the deck tree ─────────────────────────────────────────────────────────────

function deck(id: string, parentId: string | null, cards: number, due = 0): TreeDeck {
  return { id, parentId, cards, due };
}

describe("the sidebar's deck tree", () => {
  /** 日本語 is `inherit` with no parent, so the corpus default is a forest of roots. */
  const decks: TreeDeck[] = [
    deck("ja", null, 0, 0),
    deck("tango", "ja", 3477, 400),
    deck("onomatope", "tango", 41, 5),
    deck("kanji", "ja", 1662, 43),
    deck("english", null, 1258, 0),
  ];

  it("returns direct children only, in the source list's order", () => {
    expect(childrenOf(decks, "ja").map((d) => d.id)).toEqual(["tango", "kanji"]);
    expect(childrenOf(decks, "tango").map((d) => d.id)).toEqual(["onomatope"]);
    expect(childrenOf(decks, "onomatope")).toEqual([]);
  });

  it("finds the roots, including a deck whose parent is not in the list", () => {
    expect(rootsOf(decks).map((d) => d.id)).toEqual(["ja", "english"]);
    // A filtered list — one subtree, say — must not lose its top.
    const filtered = [deck("tango", "ja", 3477), deck("onomatope", "tango", 41)];
    expect(rootsOf(filtered).map((d) => d.id)).toEqual(["tango"]);
  });

  it("counts descendants, which is the whole reason a parent shows a number", () => {
    // `ja` owns 0 cards of its own. Without the subtree walk it reads 0 beside a
    // child reading 3,477.
    expect(subtreeTotals(decks, decks[0]!)).toEqual({
      cards: 3477 + 41 + 1662,
      due: 400 + 5 + 43,
      truncated: false,
    });
    expect(subtreeTotals(decks, decks[1]!)).toEqual({ cards: 3477 + 41, due: 405, truncated: false });
  });

  it("counts a leaf as itself", () => {
    expect(subtreeTotals(decks, decks[4]!)).toEqual({ cards: 1258, due: 0, truncated: false });
  });

  it("TERMINATES on a self-parenting deck instead of dying on the stack", () => {
    // Not reachable through today's `deckOp` — archive/unarchive/rename/create/delete
    // cannot reparent. It becomes reachable the day request 14's deck CRUD grows a
    // MOVE, and an unguarded recursion here kills the page on load rather than
    // misdrawing a total.
    const cyclic = [deck("a", "a", 5, 1)];
    const totals = subtreeTotals(cyclic, cyclic[0]!);
    expect(totals.cards).toBe(5);
    expect(totals.truncated).toBe(true);
  });

  it("TERMINATES on a two-deck cycle, and says the totals are a floor", () => {
    const cyclic = [deck("a", "b", 5, 1), deck("b", "a", 7, 2)];
    const totals = subtreeTotals(cyclic, cyclic[0]!);
    expect(totals.cards).toBe(12);
    expect(totals.due).toBe(3);
    expect(totals.truncated).toBe(true);
  });

  it("counts a diamond once per deck, not once per path", () => {
    // Two parents claiming one child is not a tree, but nothing in the schema forbids
    // it, and counting the child twice would inflate a total the reader trusts.
    const diamond = [
      deck("root", null, 0),
      deck("left", "root", 1),
      deck("right", "root", 2),
      deck("shared", "left", 10),
    ];
    expect(subtreeTotals(diamond, diamond[0]!).cards).toBe(13);
  });
});

// ── the typing guard ──────────────────────────────────────────────────────────

describe("the typing guard — the shortcut that must never fire while he types", () => {
  /**
   * The bug this pins: `a` archived, `d` prompted delete, and `j`/`f` GRADED, all
   * while typing in the gallery filter box. Grades write a `reviews` row and advance
   * the FSRS schedule, so this silently corrupted the study history from a search box.
   *
   * The reason it survived review is worth keeping next to the test: two of the three
   * views DID guard their inputs, and `if (reviewView.hidden) return` looked like it
   * covered the third — but the gallery is shown with `data-view` and CSS
   * `display: none`, so the `hidden` PROPERTY was false the whole time.
   */
  it("blocks every text-entry element", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    // A select eats letter keys to jump between options, so `a` in the gallery's sort
    // dropdown must not archive a card either.
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("allows the page's own elements, so the shortcuts still work", () => {
    expect(isTypingTarget({ tagName: "BODY" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "SECTION" })).toBe(false);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
    // Nothing focused: the key belongs to the page. That is the normal case.
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });

  it("is case-insensitive about tagName, because not every source shouts", () => {
    // `tagName` is upper-case on HTML elements, lower-case on XML/SVG ones. Reading
    // the property rather than using `instanceof` is what makes this a real case.
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
    expect(isTypingTarget({ tagName: "TextArea" })).toBe(true);
  });

  it("does NOT rely on instanceof, so a cross-realm element is still caught", () => {
    // An element from an iframe fails every `instanceof HTMLInputElement` check
    // against the parent realm's constructors. A plain object with a tagName stands
    // in for exactly that: no prototype chain, still recognised.
    const fromAnotherRealm = Object.create(null) as { tagName: string };
    fromAnotherRealm.tagName = "INPUT";
    expect(isTypingTarget(fromAnotherRealm)).toBe(true);
  });

  it("lets Escape through and nothing else, because Escape closes what he is typing in", () => {
    expect(survivesTyping("Escape")).toBe(true);
    for (const key of ["a", "d", "j", "f", "e", " ", "Enter", "ArrowRight", "/"]) {
      expect(survivesTyping(key), `${key} must not survive a text field`).toBe(false);
    }
  });
});
