import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { childrenOf, rootsOf, subtreeTotals, type TreeDeck } from "../app/deck-tree.js";
import { gistOf } from "../app/gist.js";
import { isTypingTarget, survivesTyping } from "../app/keys.js";
import {
  promptPositions,
  sideScale,
  visiblePositions,
  type BoundarySide,
} from "../app/review-boundary.js";
import { revealScroll, type RevealViewport } from "../app/review-scroll.js";
import {
  climbFrame,
  etaLabel,
  railX,
  readout,
  restFrame,
  rungMix,
  slotY,
  REWARD_STAGES,
  SYNC_STAGES,
  type Sample,
} from "../app/sync-climb.js";
import { overdueLabel, overdueTitle, dueDateOf } from "../app/overdue.js";
import { lastSeenLabel, lastSeenTitle } from "../app/last-seen.js";
import { barValueText, barWidths } from "../app/progress.js";
import { revealSteps, type StepSide } from "../app/review-steps.js";
import { audioIsStale } from "../app/seed-freshness.js";
import {
  forcedChrome,
  readTheme,
  themeAttribute,
  themeLabel,
  THEMES,
} from "../app/theme.js";
import {
  CAPTURE,
  DEFAULT_PLAYBACK,
  mayPlayClip,
  nextSpeed,
  pickRecordingType,
  readPlayback,
  speedLabel,
  takeLabels,
  writePlayback,
  SPEEDS,
} from "../app/shadow-controls.js";

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
    expect(promptPositions(sides)).toEqual([0]);
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
    expect(promptPositions(sides)).toEqual([1]);
  });

  it("STOPS AT 漢字's `---`, even though the next side is only a canvas", () => {
    // ─── THE EXCEPTION THIS REPLACED, AND WHY IT IS GONE ──────────────────────
    //
    // The rule used to extend over "a following side that carries a widget AND
    // NOTHING ELSE", so that 漢字's `<draw>` came up beside the kanji. Zach saw it
    // on 2026-09-14: *"so it doesn't follow the `---`??? because i added that
    // explicitly, i have my reasons."*
    //
    // The exception was an agent's, introduced in `16afee6` and recorded in no
    // decision. A `---` is a side break HE AUTHORED; code deciding a side is really
    // part of the previous one is overruling the template, which is the mistake this
    // repo names four times over. If the canvas belongs beside the kanji, the change
    // is one deleted `---` in `templates.content`.
    const sides = [
      side(0, 0, { text: "慈" }),
      side(1, 1, { text: "" }), // the canvas, on its own authored side
      side(2, 2, { text: "じ" }),
    ];
    expect(promptPositions(sides)).toEqual([0]);
  });

  it("never extends over a later side, whatever is on it", () => {
    // There is no shape of side 2 that joins the question any more. Empty, text,
    // widget-and-text — the answer is the same one, which is the point.
    for (const text of ["", "じ", "じ — the answer, beside the widget"]) {
      expect(promptPositions([side(0, 0, { text: "慈" }), side(1, 1, { text })])).toEqual([0]);
    }
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
    expect(promptPositions(sides)).toEqual([0]);
  });

  it("yields an empty question for a card that renders nothing, rather than throwing", () => {
    expect(promptPositions([])).toEqual([]);
    expect(promptPositions([side(0, 0, { empty: true })])).toEqual([]);
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

// ── the reveal order ──────────────────────────────────────────────────────────

/**
 * ZACH, 2026-09-12: *"when you click reveal, it shows the whole thing, the next
 * slide, and the third slide, and every cloze. the correct order should be, each
 * cloze in that slide, once every clozes are shown, the next side and so on. for
 * the reverse, the cloze are still in the same ascending order, just the side
 * reverse."*
 */
const stepSide = (
  position: number,
  clozes: number,
  audio: number,
  prompt = false,
): StepSide => ({ position, clozes, audio, prompt });

describe("the reveal order", () => {
  it("walks 単語 Reading=true: side 2's cloze, the sentence, then the meaning", () => {
    // Side 1 is the head word and is the question. Side 2 carries one cloze and
    // the word's clip, side 3 the example sentence and its clip, side 4 the
    // meaning behind a cloze.
    const steps = revealSteps([
      stepSide(0, 0, 0, true),
      stepSide(1, 1, 1),
      stepSide(2, 0, 1),
      stepSide(3, 1, 0),
    ]);
    expect(steps).toEqual([
      { position: 1, cloze: 0, show: true },
      { position: 2, cloze: null, show: true },
      { position: 3, cloze: 0, show: true },
    ]);
  });

  it("walks 単語 Reading=false: the reading, THEN the kanji, then the rest", () => {
    // Side 1 is empty on a mode-2 card, so the screen starts at side 2 — which is
    // the question AND carries two clozes. Both are steps; neither shows a side,
    // because the side is already up.
    const steps = revealSteps([stepSide(1, 2, 1, true), stepSide(2, 0, 1), stepSide(3, 1, 0)]);
    expect(steps).toEqual([
      { position: 1, cloze: 0, show: false },
      { position: 1, cloze: 1, show: false },
      { position: 2, cloze: null, show: true },
      { position: 3, cloze: 0, show: true },
    ]);
  });

  it("walks 漢字: the canvas, the reading, the meaning — three presses, since 2026-09-14", () => {
    // `<<Kanji>>` / `<draw>` / `<<Reading>>` / `<<Meaning>>`, no clozes and no audio
    // anywhere. The canvas used to come up WITH the kanji because the boundary rule
    // carried a widget exception; his `---` says otherwise, so it is a step now.
    //
    // **The extra press reveals no answer.** It puts a blank canvas on screen, which
    // is the one kind of step that cannot leak anything — so the cost of honouring
    // the template here is one tap on 1,662 cards and nothing else.
    const steps = revealSteps([
      stepSide(0, 0, 0, true), // 漢字 — the question
      stepSide(1, 0, 0), // the canvas
      stepSide(2, 0, 0), // 読み
      stepSide(3, 0, 0), // 意味
    ]);
    expect(steps).toEqual([
      { position: 1, cloze: null, show: true },
      { position: 2, cloze: null, show: true },
      { position: 3, cloze: null, show: true },
    ]);
  });

  it("gives a question side with audio and no cloze a step of its own", () => {
    // 敬語 and New Vocab: the head word is unmasked beside its clip, so the CLIP
    // is the only answer there is. Before the stepper these sounded because the
    // one-shot reveal nominated "the first side with audio"; a plan that skipped
    // them would have made 1,204 cards silent.
    expect(revealSteps([stepSide(0, 0, 1, true)])).toEqual([
      { position: 0, cloze: null, show: false },
    ]);
  });

  it("gives a question side with neither cloze nor audio no step at all", () => {
    // There is nothing left to do to it, and a press that changes nothing on
    // screen reads as a broken button.
    expect(revealSteps([stepSide(0, 0, 0, true)])).toEqual([]);
  });

  it("never crosses into the next side before finishing this one", () => {
    const steps = revealSteps([stepSide(0, 2, 0, true), stepSide(1, 2, 0)]);
    expect(steps.map((step) => step.position)).toEqual([0, 0, 1, 1]);
    expect(steps.map((step) => step.cloze)).toEqual([0, 1, 0, 1]);
    // Only the FIRST step on a hidden side puts it on screen.
    expect(steps.map((step) => step.show)).toEqual([false, false, true, false]);
  });

  it("reverses the SIDES and leaves cloze order ascending — the second half of his sentence", () => {
    // A reverse track permutes sides; `position` is display order, so the plan
    // sees them already permuted and does nothing clever. Within a side, document
    // order is untouched by the permutation — so this needs no code, and this
    // test is what stops that staying true only by accident.
    const forward = revealSteps([stepSide(0, 2, 0, true), stepSide(1, 2, 0)]);
    const reverse = revealSteps([stepSide(0, 2, 0, true), stepSide(1, 2, 0)]);
    expect(reverse).toEqual(forward);
    for (const position of [0, 1]) {
      const clozes = reverse.filter((step) => step.position === position).map((s) => s.cloze);
      expect(clozes, `side ${position} must ascend`).toEqual([0, 1]);
    }
  });
});

// ── the type scale ────────────────────────────────────────────────────────────

/**
 * ZACH, 2026-09-12: *"i think it's correct that the 漢字 has the big text because
 * it's short, but when it's reverse, why is 漢字 small and the definition big...?
 * this is super ugly lol"*
 *
 * The old rule was positional (`.drill`, the question side). These are the real
 * strings from his corpus on both sides of the thresholds.
 */
describe("how big the text on a side should be", () => {
  it("puts every forward vocabulary prompt in display", () => {
    for (const text of [
      "判断", // 単語 forward, Reading = true
      "慈", // 漢字 forward — one character
      "[…]係数[…]係数 中高(3)", // 単語 forward, Reading = false: masks and the accent
      "[…]判断[…]判断頭高",
      "にんじん",
      "shun",
    ]) {
      expect(sideScale(text), text).toBe("display");
    }
  });

  it("drops the reverse prompt that started all this out of display", () => {
    // The card in his screenshot. At 40px it was three lines of English before the
    // question had even been asked. The DEFINITION alone is 56 characters and lands
    // in `mid`; the side as actually rendered carries the second sense and the two
    // link labels with it, which is why the live card measured `body` at 15px.
    const definition = "judgement; judgement; decision; conclusion; adjudication";
    expect([...definition].length).toBe(56);
    expect(sideScale(definition)).toBe("mid");
    expect(sideScale(`${definition}
divination
🀄JPDB🎬IKD`)).toBe("body");
    expect(sideScale("coefficient #Mathematics coefficient; factor; proportional constant")).toBe(
      "body",
    );
    // Either way, the thing he objected to is gone: not display, on any of them.
    for (const text of [definition, "coefficient #Mathematics coefficient; factor"]) {
      expect(sideScale(text), text).not.toBe("display");
    }
  });

  it("keeps a SHORT reverse prompt big, because the rule is length and not direction", () => {
    // "protein" is a reverse prompt too. Nothing about being an answer-turned-
    // question makes it want small type.
    expect(sideScale("protein")).toBe("display");
    expect(sideScale("cook; chef")).toBe("display");
  });

  it("has a middle, so the fall is not a cliff", () => {
    expect(sideScale("mission; errandtask; duty; obligation")).toBe("mid");
    expect(sideScale("彼の行動を判断するのは難しい。It is difficult to judge his behavior.")).toBe(
      "mid",
    );
  });

  it("counts CODE POINTS, so a surrogate pair does not cost two", () => {
    // 28 astral characters: one bucket in code points, two in UTF-16 units.
    const astral = "𠮟".repeat(28);
    expect(astral.length).toBe(56);
    expect(sideScale(astral)).toBe("display");
  });

  it("collapses whitespace before measuring, so a wrapped render is not punished", () => {
    expect(sideScale("  judgement \n\n   decision  ")).toBe("display");
    expect(sideScale("")).toBe("display");
  });

  it("is the rule that also fixes 基本情報 FORWARD, which nobody had reported", () => {
    // Its forward prompts run to 170 characters and were rendering at 40px under
    // the positional rule — the same defect, in the direction that looked safe. A
    // rule keyed on `direction === "reverse"` would have left this one broken.
    const long =
      "コンピュータの五大装置のうち、演算装置と制御装置を合わせたものを何と呼ぶか。またその役割を説明せよ。";
    expect([...long].length).toBeGreaterThan(28);
    expect(sideScale(long)).not.toBe("display");
  });
});

// ── is the seed on this device still the one being served? ───────────────────

/**
 * ZACH, 2026-09-12, reporting the same defect for the THIRD time: *"i don't know
 * what to tell you but the example sentence audio is not there😭"*
 *
 * Half the diagnosis was the audio budget. The other half was that a rebuild
 * could never have reached him: the freshness check was entirely about the CARD
 * database, `seedReviews` does not move when only the audio changes, and
 * `ensureFile` skips any file OPFS already holds — in green, saying "already in
 * OPFS — not re-fetching".
 */
describe("the audio file's own freshness", () => {
  it("re-fetches when the server is serving a different build", () => {
    expect(audioIsStale("2026-09-12T12:11:02.236Z", "2026-09-08T01:58:28.378Z")).toBe(true);
  });

  it("leaves it alone when they match — the whole point is a local, offline app", () => {
    expect(audioIsStale("2026-09-12T12:11:02.236Z", "2026-09-12T12:11:02.236Z")).toBe(false);
  });

  it("does NOT re-fetch against an older manifest that has no such field", () => {
    // THE ARM THAT MUST NOT FIRE. A manifest written before 2026-09-12 carries no
    // `storeCreated`, and a static host serving one has to keep working. Treating
    // it as a mismatch re-downloads 640 MB on every boot, for ever, and the user
    // has no way to tell why.
    expect(audioIsStale(undefined, "2026-09-08T01:58:28.378Z")).toBe(false);
    expect(audioIsStale("", "2026-09-08T01:58:28.378Z")).toBe(false);
  });

  it("DOES re-fetch a store that cannot say when it was built", () => {
    // The other direction is not symmetric. A manifest that names a build and a
    // local file that cannot answer is a file of unknown provenance, and the
    // audio store is a pure cache — replacing it costs bandwidth and nothing else.
    expect(audioIsStale("2026-09-12T12:11:02.236Z", undefined)).toBe(true);
    expect(audioIsStale("2026-09-12T12:11:02.236Z", "")).toBe(true);
  });

  it("compares for DIFFERENCE, not for newer", () => {
    // Re-bootstrapping at a smaller budget is a legitimate thing to want — his
    // phone's storage is finite. "Older" is not "wrong".
    expect(audioIsStale("2026-09-08T01:58:28.378Z", "2026-09-12T12:11:02.236Z")).toBe(true);
  });
});

// ─── the shadowing controls: loop, speed, and his own voice ─────────────────

/**
 * Zach, 2026-09-12, handing over a card-controls mockup: the one thing in it the
 * app did not have was controls for the drill the audio exists for.
 *
 * These rules are here rather than in `main.ts` because each has a failure that
 * is SILENT on the exact thing the corpus trains. A rate that escapes the ladder
 * plays a clip at a speed no control on screen can explain. A permission denial
 * that reads as `idle` gives him a button that does nothing forever. And a clip
 * allowed to sound while the mic is open puts the reference recording inside his
 * own take, which is confidently wrong feedback about his accent.
 */
describe("shadowing controls", () => {
  describe("the speed ladder", () => {
    it("starts at normal, so one press is the slow one", () => {
      // The direction he wants nine times out of ten. A ladder that gives 1.25
      // first costs two presses to reach the only rate a learner reaches for.
      expect(SPEEDS[0]).toBe(1);
      expect(nextSpeed(1)).toBe(0.75);
    });

    it("wraps, and never leaves the ladder", () => {
      let rate: number = SPEEDS[0];
      const walk = [rate];
      for (let step = 0; step < SPEEDS.length; step += 1) {
        rate = nextSpeed(rate);
        walk.push(rate);
      }
      expect(walk).toEqual([1, 0.75, 1.25, 1]);
    });

    it("HAS NO 0.5×, and that is the accent talking", () => {
      // Rate change on an <audio> is a phase vocoder: time stretched, pitch held
      // — which is what is wanted, since the accent IS the F0 contour. But the
      // stretch smears rapid transitions and the DOWNSTEP is a rapid transition.
      // 0.75 is mild; 0.5 lands artifacts on the one feature being trained.
      expect(SPEEDS).not.toContain(0.5);
      expect(Math.min(...SPEEDS)).toBe(0.75);
    });

    it("resets an unknown rate rather than honouring it", () => {
      expect(nextSpeed(4)).toBe(1);
      expect(nextSpeed(Number.NaN)).toBe(1);
    });

    it("writes normal speed as `1×`, not `1.00×`", () => {
      // The resting state has to read as the ABSENCE of a setting.
      expect(speedLabel(1)).toBe("1×");
      expect(speedLabel(0.75)).toBe("0.75×");
      expect(speedLabel(1.25)).toBe("1.25×");
    });
  });

  describe("persistence tolerates whatever localStorage holds", () => {
    it("round-trips", () => {
      const held = { rate: 0.75, loop: true };
      expect(readPlayback(writePlayback(held))).toEqual(held);
    });

    it("falls back on absent, empty and unparseable", () => {
      for (const raw of [null, undefined, "", "{", "not json", "[]", "null"]) {
        expect(readPlayback(raw), `readPlayback(${String(raw)})`).toEqual(DEFAULT_PLAYBACK);
      }
    });

    it("DROPS a rate that is not on the ladder", () => {
      // The dangerous shape: something writes `{"rate":4}` and the clip plays at
      // 4× with every control on screen still reading `1×`. Honouring a stored
      // number because it is a number is how that happens.
      expect(readPlayback('{"rate":4,"loop":false}').rate).toBe(1);
      expect(readPlayback('{"rate":"0.75"}').rate).toBe(1);
      expect(readPlayback('{"rate":0.5}').rate).toBe(1);
      // A legal one survives alongside a broken sibling.
      expect(readPlayback('{"rate":0.75,"loop":"yes"}')).toEqual({ rate: 0.75, loop: false });
    });
  });

  describe("the take", () => {
    it("says `allow…` while the browser is asking", () => {
      // `getUserMedia` sits on a permission prompt for as long as he takes to
      // answer it. A button that still reads `record` gets pressed again.
      expect(takeLabels("arming").record).toBe("allow…");
      expect(takeLabels("arming").recordDisabled).toBe(true);
    });

    it("offers playback ONLY once something was captured", () => {
      expect(takeLabels("idle").take).toBeNull();
      expect(takeLabels("arming").take).toBeNull();
      expect(takeLabels("recording").take).toBeNull();
      expect(takeLabels("denied").take).toBeNull();
      expect(takeLabels("take").take).toBe("your take");
    });

    it("DISABLES on denial rather than hiding — the `missing clip` rule", () => {
      // A control that vanishes leaves him wondering whether the feature exists.
      // One that is visibly unavailable, with the reason in its title, does not.
      expect(takeLabels("denied").recordDisabled).toBe(true);
      expect(takeLabels("denied").record).toBe("record");
    });

    it("refuses to sound a clip while the mic is open", () => {
      // He reviews on a phone, on its own speaker. A take captured over the
      // reference contains the reference — and comparing his contour against a
      // mix of itself and his voice is worse than no feedback.
      expect(mayPlayClip("recording")).toBe(false);
      expect(mayPlayClip("arming")).toBe(false);
      expect(mayPlayClip("idle")).toBe(true);
      expect(mayPlayClip("take")).toBe(true);
      expect(mayPlayClip("denied")).toBe(true);
    });

    it("opens the mic with the processing that would flatten a contour OFF", () => {
      // AGC flattens dynamics, suppression reshapes the spectrum. Both are tuned
      // for a phone call; this recording exists to be compared against a pitch
      // contour. Echo cancellation stays on — speaker and mic are centimetres
      // apart on the device he reviews with.
      expect(CAPTURE.autoGainControl).toBe(false);
      expect(CAPTURE.noiseSuppression).toBe(false);
      expect(CAPTURE.echoCancellation).toBe(true);
    });

    it("picks opus where it exists and still records where it does not", () => {
      expect(pickRecordingType((type) => type.includes("webm"))).toBe("audio/webm;codecs=opus");
      // Safari.
      expect(pickRecordingType((type) => type === "audio/mp4")).toBe("audio/mp4");
      // Nothing recognised: the empty string is legal and means "you pick".
      expect(pickRecordingType(() => false)).toBe("");
    });
  });
});

// ─── light, dark, or whatever the device says ───────────────────────────────

/**
 * Zach, 2026-09-13: *"where do i change light dark theme?"* He could not — the
 * app followed `prefers-color-scheme` and offered no control, though
 * `app/style.css` has carried both `[data-theme]` branches since decision 32.
 *
 * The rule with the silent failure is `themeAttribute`, and it is worth a test
 * on its own: the stylesheet's media block is guarded `:not([data-theme="light"])`,
 * so ANY string in that attribute is a statement. Writing "system" into it would
 * leave a dark phone permanently light, and the screen would still read
 * "follow this device".
 */
describe("theme", () => {
  it("says `follow this device` by taking the attribute OFF, not by naming it", () => {
    expect(themeAttribute("system")).toBeNull();
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
  });

  it("offers three states, because a switch would take his sunset away", () => {
    // A phone that turns dark at sunset is a feature he already has. A two-way
    // toggle removes it the first time he touches it, with no way back short of
    // clearing site data.
    expect([...THEMES]).toEqual(["system", "light", "dark"]);
    expect(themeLabel("system")).toBe("follow this device");
  });

  it("forces the phone's chrome only when he has actually chosen", () => {
    // On `system` the two media-scoped <meta> tags answer for themselves; a
    // forced value there would freeze the status bar at one ground.
    expect(forcedChrome("system")).toBeNull();
    expect(forcedChrome("dark")).toBe("#1A1815");
    expect(forcedChrome("light")).toBe("#ECEAE5");
  });

  it("falls back to following the device on anything unrecognised", () => {
    for (const raw of [null, undefined, "", "System", "auto", "{}", "DARK"]) {
      expect(readTheme(raw), `readTheme(${String(raw)})`).toBe("system");
    }
    expect(readTheme("dark")).toBe("dark");
  });
});

/**
 * A 375x812 phone with this app's real chrome on it: the sticky header ends at
 * y=97 (its own height plus the progress bar), and the fixed footer is 150px
 * tall, so the last readable row is y=662. Those two numbers are measured from
 * `--footer-h` and the header's own rect at runtime; here they only have to be
 * plausible, because the rule is about the arithmetic between them.
 */
const phone = (elementTop: number, elementBottom: number, gap = 16): RevealViewport => ({
  top: 97,
  bottom: 662,
  elementTop,
  elementBottom,
  gap,
});

describe("following the reveal down the page", () => {
  it("moves just far enough to clear the footer, not to the top of the window", () => {
    // He is COMPARING: on a Reading=true card the reading he just produced is on
    // the side above the one that arrived. Top-aligning the new side throws the
    // thing being compared against off screen, so the rule is minimum movement.
    // A 120px side sitting 40px below the fold needs 40 + the 16px gap.
    expect(revealScroll(phone(600, 720))).toBe(74);
  });

  it("leaves the page alone when the revealed thing is already readable", () => {
    // A press that scrolls a visible answer is worse than one that scrolls
    // nothing: the text he is reading moves under his eye for no reason.
    expect(revealScroll(phone(300, 420))).toBe(0);
    // Flush against the gap on both edges is still "already readable".
    expect(revealScroll(phone(113, 646))).toBe(0);
  });

  it("NEVER scrolls up, whatever the geometry says", () => {
    // A reveal only ever adds BELOW. Scrolling up is the page yanking him
    // backwards away from the thing he just asked to see, so the direction is
    // not a caller's choice — every upward case returns 0 rather than a
    // negative number.
    expect(revealScroll(phone(-400, -200))).toBe(0);
    expect(revealScroll(phone(-50, 300))).toBe(0);
    expect(revealScroll(phone(20, 90))).toBe(0);
  });

  it("top-aligns a side taller than the visible box, because clearing it cannot work", () => {
    // 基本情報's forward prompts run to 170 characters and 意味 sides carry lists.
    // Bottom-clearing a 900px side would scroll past its beginning — the one part
    // he has not read. The visible box is 565px; this side is 900.
    expect(revealScroll(phone(200, 1100))).toBe(87); // 200 - 97 - 16
    // And even then, not upwards: a tall side already under the header stays put.
    expect(revealScroll(phone(100, 1000))).toBe(0);
  });

  it("does nothing when there is no room to scroll into", () => {
    // A landscape phone with the keyboard up. Any movement here is a guess, and
    // a guess that moves the card is worse than one that does not.
    expect(revealScroll({ top: 300, bottom: 320, elementTop: 900, elementBottom: 1000, gap: 16 }))
      .toBe(0);
  });

  it("returns whole pixels, so a smooth scroll has an integer to land on", () => {
    expect(revealScroll(phone(700.4, 800.6))).toBe(155);
    expect(Number.isInteger(revealScroll(phone(700.4, 800.6)))).toBe(true);
  });
});

// ── the climb, while the seed downloads ──────────────────────────────────────

/**
 * Zach's design, 2026-09-16, handed over as a prototype with dials on it. These
 * pin the three things that are easy to break and invisible when broken.
 */
describe("the climbing mark on the boot screen", () => {
  it("draws the SHIPPED mark, not a copy of it", () => {
    // `app/index.html` authors the rungs by hand. If the animation's geometry
    // drifts from them, the loop ends at rest in a subtly different shape than
    // the static logo — which nobody would report and everybody would feel.
    const html = readFileSync("app/index.html", "utf8");
    for (const [slot, d] of [
      [0, "M31.47 13H68.53"],
      [1, "M25.83 40H74.17"],
      [2, "M22.27 57H77.73"],
      [3, "M18.09 77H81.91"],
    ] as const) {
      expect(html, `slot ${slot} is not in the mark`).toContain(d);
      const y = slotY(slot);
      const [x1, x2] = railX(y);
      expect(`M${x1.toFixed(2)} ${y}H${x2.toFixed(2)}`).toBe(d);
    }
  });

  it("STARTS AT REST, so a short fetch shows the complete mark and no motion", () => {
    // The phase offset. Easy to break, easy to miss: get it wrong and every boot
    // that clears the gate opens mid-drop, which reads as the logo glitching.
    expect(climbFrame(0)).toEqual(restFrame());
    expect(climbFrame(SYNC_STAGES.hold - 1)).toEqual(restFrame());
    // One millisecond later the drop has begun — the rungs have moved off their
    // slots, even if only barely.
    expect(climbFrame(SYNC_STAGES.hold + 1)[1]!.s).toBeGreaterThan(1);
  });

  it("keeps the BEAT — a window with nothing at the top of the mark", () => {
    // Without it the new accent fades in under cover of the drop and is never
    // seen to arrive. That was the defect in his first version.
    const beatAt = SYNC_STAGES.hold + SYNC_STAGES.drop + SYNC_STAGES.beat / 2;
    const during = climbFrame(beatAt);
    expect(during).toHaveLength(3);
    expect(during.some((rung) => rung.s < 0.5)).toBe(false);
    // And it is exactly as long as it says: one frame either side is not the beat.
    expect(climbFrame(SYNC_STAGES.hold + SYNC_STAGES.drop - 1)).toHaveLength(4);
    expect(
      climbFrame(SYNC_STAGES.hold + SYNC_STAGES.drop + SYNC_STAGES.beat + 1),
    ).toHaveLength(4);
  });

  it("gives the reward timing one pass that starts ON the drop", () => {
    // `hold: 0` makes the offset equal the cycle, so t=0 is the drop's first
    // frame rather than the rest. One implementation, two timings — which is
    // what makes "re-evaluate if deck completion ships" a one-line change.
    const start = climbFrame(0, REWARD_STAGES);
    expect(start).toHaveLength(4);
    expect(start[0]!.s).toBe(0);
    // A quarter through the drop it has visibly moved.
    expect(climbFrame(REWARD_STAGES.drop / 4, REWARD_STAGES)[0]!.s).toBeGreaterThan(0.3);
  });

  it("returns a MIX POSITION, never a colour — the themes differ", () => {
    // His prototype lerps [224,69,29] → [27,59,111] in JavaScript. Those are the
    // LIGHT tokens; dark overrides both, and #1B3B6F on the dark ground measures
    // 1.60:1 — the landed rungs would be invisible on the screen he actually
    // uses. The mix belongs in CSS, where the tokens know about the theme.
    expect(rungMix(0)).toBe(0);
    expect(rungMix(1)).toBe(1);
    expect(rungMix(3)).toBe(1);
    expect(rungMix(-2)).toBe(0);
    expect(rungMix(0.5)).toBeCloseTo(0.5);
  });
});

describe("what the download screen says", () => {
  const sample = (at: number, received: number): Sample => ({ at, received });

  it("shows no estimate until a rate has had time to settle", () => {
    const samples = [sample(0, 0), sample(2_000, 8_000_000)];
    // An ETA that appears instantly then swings from 2 minutes to 11 is worse
    // than none.
    expect(readout("downloading", samples, 640_000_000, 2_000, 0).etaSeconds).toBeNull();
    const later = [sample(0, 0), sample(20_000, 80_000_000)];
    expect(readout("downloading", later, 640_000_000, 20_000, 0).etaSeconds).toBeCloseTo(140, 0);
  });

  it("calls it stalled on BYTES, not on slowness", () => {
    // A 2G train is not a stall, and saying so every commute would cry wolf.
    const crawling = [sample(0, 0), sample(20_000, 40_000)];
    expect(readout("downloading", crawling, 640_000_000, 20_100, 0).stalled).toBe(false);
    // Nothing since 20 s, asked at 29 s: past the 8 s threshold.
    expect(readout("downloading", crawling, 640_000_000, 29_000, 0).stalled).toBe(true);
    // And only while downloading — a long disk write is not a stalled transfer.
    expect(readout("saving", crawling, 640_000_000, 29_000, 0).stalled).toBe(false);
  });

  it("sweeps rather than inventing a percentage when Content-Length is missing", () => {
    // `tailscale serve` sits in front of this on his phone and a proxy may strip
    // the header. A made-up percentage is worse than an honest "still going".
    expect(readout("downloading", [sample(0, 1_000)], null, 1_000, 0).fraction).toBeNull();
    expect(readout("downloading", [sample(0, 50)], 100, 1_000, 0).fraction).toBeCloseTo(0.5);
  });

  it("words the estimate the way he would say it", () => {
    expect(etaLabel(null)).toBe("");
    expect(etaLabel(12)).toBe("less than a minute left");
    expect(etaLabel(59)).toBe("less than a minute left");
    expect(etaLabel(95)).toBe("about 2 minutes left");
    expect(etaLabel(61)).toBe("about 1 minute left");
  });
});

/**
 * ─── HOW LATE THIS TRACK IS ─────────────────────────────────────────────────
 *
 * Zach, 2026-09-17: *"it would actually be perfect if there's a label showing
 * when this card was due in the past … this track was due 5 days ago or
 * something"*.
 *
 * The buckets come from his real queue on that date, 1,166 due tracks: 134 due
 * today, 135 one day late, 827 between 2 and 30, NOTHING between 31 and 364,
 * and 70 over a year (数字, untouched since 2024-08; the oldest is 757 days).
 */
describe("how late a track is, in words", () => {
  it("says nothing at all for a track that is not in the past", () => {
    // 134 of 1,166. Due TODAY is the plan working, and a chip on every one of
    // them would stop the late ones standing out — which is the whole request.
    expect(overdueLabel(0)).toBeNull();
    expect(overdueLabel(-3)).toBeNull();
    // A new track has no due date; the worker sends 0 and this is why that is
    // safe rather than a missing value wearing a number's clothes.
    expect(overdueLabel(Number.NaN)).toBeNull();
  });

  it("counts days for the case he described, and names yesterday", () => {
    expect(overdueLabel(1)).toBe("due yesterday");
    expect(overdueLabel(5)).toBe("due 5 days ago");
    // 827 of his 1,032 late tracks are in here.
    expect(overdueLabel(30)).toBe("due 30 days ago");
  });

  it("switches to months and then years, because 757 days is not a duration", () => {
    expect(overdueLabel(31)).toBe("due 1 month ago");
    expect(overdueLabel(61)).toBe("due 2 months ago");
    // Clamped at 11: `364 / 30.44` rounds to 12, and "due 12 months ago" beside
    // a "due 1 year ago" that means FEWER days is the worse pair.
    expect(overdueLabel(364)).toBe("due 11 months ago");
    expect(overdueLabel(365)).toBe("due 1 year ago");
    // The real oldest track in his queue.
    expect(overdueLabel(757)).toBe("due 2 years ago");
  });

  it("never lets months and years disagree about which is longer", () => {
    // A sweep rather than three examples: the label must be monotonic in days,
    // and the two boundaries are exactly where a rounding rule goes wrong.
    const rank = (days: number): number => {
      const label = overdueLabel(days);
      if (label === null) return 0;
      const n = Number(/\d+/.exec(label)?.[0] ?? 1);
      if (label.includes("year")) return n * 365;
      if (label.includes("month")) return n * 30.44;
      return n;
    };
    let previous = 0;
    for (let days = 1; days <= 800; days += 1) {
      const now = rank(days);
      expect(now, `${days} days ranked below ${days - 1}`).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  it("SLICES the date for the title and never parses it", () => {
    // `due_at` carries his offset. `new Date()` would re-interpret it in the
    // viewer's zone and can land a day off — on a label whose only job is a day
    // count, a defect that appears when travelling.
    expect(dueDateOf("2026-09-12T04:00:00.000+09:00")).toBe("2026-09-12");
    expect(dueDateOf(null)).toBeNull();
    expect(dueDateOf("whenever")).toBeNull();
    expect(overdueTitle(5, "2026-09-12T04:00:00.000+09:00")).toBe("due 2026-09-12 — 5 days late");
    expect(overdueTitle(5, null)).toBe("5 days late");
  });
});

/**
 * ─── THE DAY'S BAR, WITH THE MISSES IN IT ───────────────────────────────────
 *
 * Zach, 2026-09-17: *"for missed/forgot card, we can actually make it visible on
 * the progress bar, but maybe as a red bar? so the bar can now tell the
 * proportion"*.
 */
describe("the progress bar's two widths", () => {
  it("draws the misses as a PREFIX of the fill, not a slice out of it", () => {
    const w = barWidths({ answeredToday: 10, missedToday: 3, plannedToday: 40 });
    expect(w.donePercent).toBeCloseTo(25);
    expect(w.missedPercent).toBeCloseTo(7.5);
    // The property that makes both segments monotonic: each only ever grows, so
    // the boundary never walks backwards while he reviews.
    expect(w.missedPercent).toBeLessThanOrEqual(w.donePercent);
  });

  it("clamps a numerator that legitimately exceeds its denominator", () => {
    // `answeredToday` counts grades made ANYWHERE today, including a sync pull,
    // while `plannedToday` is built from this device's plan. A phone morning
    // landing on the laptop can put the numerator ahead for one paint, and a bar
    // wider than 100% overhangs the header.
    const w = barWidths({ answeredToday: 99, missedToday: 99, plannedToday: 40 });
    expect(w.donePercent).toBe(100);
    expect(w.missedPercent).toBe(100);
    expect(w.done).toBe(40);
  });

  it("never lets the red exceed the fill, whatever it is handed", () => {
    const w = barWidths({ answeredToday: 4, missedToday: 9, plannedToday: 40 });
    expect(w.missed).toBe(4);
    expect(w.missedPercent).toBeLessThanOrEqual(w.donePercent);
  });

  it("survives an empty day rather than dividing by zero", () => {
    const w = barWidths({ answeredToday: 0, missedToday: 0, plannedToday: 0 });
    expect(w.donePercent).toBe(0);
    expect(w.missedPercent).toBe(0);
    expect(Number.isFinite(w.donePercent)).toBe(true);
  });

  it("SAYS the misses too, because the bar is 2px of colour", () => {
    expect(barValueText(barWidths({ answeredToday: 12, missedToday: 3, plannedToday: 40 })))
      .toBe("12 of 40 answered today, 3 missed");
    // A clean day says nothing about misses rather than saying "0 missed".
    expect(barValueText(barWidths({ answeredToday: 12, missedToday: 0, plannedToday: 40 })))
      .toBe("12 of 40 answered today");
  });
});

/**
 * WHEN HE LAST SAW A TRACK, as a plain date.
 *
 * Zach, 2026-09-23: *"it would be great if we can see when we reviewed this
 * track last time … but i think just a plain date would be better, like
 * `Jul 2, 2025` or something"*.
 *
 * He framed the date as a preference, and it is also the only honest rendering:
 * all 103,110 imported reviews carry `time_unknown = 1` and the corpus holds
 * exactly ONE distinct time-of-day, so the date is a fact and a clock time is
 * invented. These pin the two ways that could quietly go wrong — the viewer's
 * timezone, and the viewer's locale.
 */
describe("the last-seen date", () => {
  it("renders his own example format", () => {
    expect(lastSeenLabel("2025-07-02T00:00:00+09:00")).toBe("Jul 2, 2025");
  });

  it("reads the LOCAL date, not the viewer's", () => {
    // `new Date(s).getDate()` would convert to the running machine's zone, so a
    // review taken just after midnight in Tokyo reads as the previous day on a
    // laptop set to UTC — the same track, two dates, depending on where he opens
    // it. `src/scheduler/predicates.ts` documents the substring rule at length;
    // this is that rule applied to display.
    expect(lastSeenLabel("2025-07-02T00:00:00+09:00")).toBe("Jul 2, 2025");
    expect(lastSeenLabel("2025-07-02T23:30:00+09:00")).toBe("Jul 2, 2025");
    // Same instant, written in UTC, is a different LOCAL date and must say so.
    expect(lastSeenLabel("2025-07-01T15:00:00Z")).toBe("Jul 1, 2025");
  });

  it("does not move with the device locale", () => {
    // `toLocaleDateString` gives `7/2/2025` here and `02/07/2025` there, which
    // are the same string to two different readers. He reads this on a laptop
    // and a phone, so the month is spelled.
    const label = lastSeenLabel("2025-12-31T00:00:00+09:00");
    expect(label).toBe("Dec 31, 2025");
    expect(label).not.toMatch(/\d+\/\d+/);
  });

  it("says nothing for a new track, rather than something wrong", () => {
    // Null is a fact here — there is no last time — and 4,308 of his tracks are
    // in that state. Rendering "Jan 1, 1970" or an empty chip would both be worse.
    expect(lastSeenLabel(null)).toBeNull();
    expect(lastSeenLabel(undefined)).toBeNull();
    expect(lastSeenTitle(null)).toBeNull();
  });

  it("refuses a malformed value instead of inventing a plausible date", () => {
    expect(lastSeenLabel("")).toBeNull();
    expect(lastSeenLabel("not a date")).toBeNull();
    expect(lastSeenLabel("2025-13-02T00:00:00+09:00")).toBeNull();
    expect(lastSeenLabel("2025-00-02T00:00:00+09:00")).toBeNull();
    expect(lastSeenLabel("2025-07-00T00:00:00+09:00")).toBeNull();
  });

  it("names what the date means, because the chip beside it is a due date", () => {
    expect(lastSeenTitle("2025-07-02T00:00:00+09:00")).toBe("last reviewed Jul 2, 2025");
  });

  it("covers every month boundary", () => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (let m = 1; m <= 12; m += 1) {
      const mm = String(m).padStart(2, "0");
      expect(lastSeenLabel(`2025-${mm}-15T00:00:00+09:00`)).toBe(`${months[m - 1]} 15, 2025`);
    }
  });
});

/**
 * A gallery tile's second line (`app/gist.ts`). The inputs are shapes measured in
 * the real corpus on 2026-10-16, not invented ones.
 */
describe("gistOf", () => {
  it("takes the FIRST sense of a numbered 意味, without its number", () => {
    expect(
      gistOf("1. even if …; even supposing that\n2. also as …; also for …"),
    ).toBe("even if …; even supposing that");
  });

  it("reduces a wiki link to its display text, as 単語's fields author them", () => {
    expect(gistOf("~に[[越|4nKAg2kH]]したことはない")).toBe("~に越したことはない");
  });

  it("drops emphasis and skips blank leading lines", () => {
    expect(gistOf("\n\n**plentifully**; amply")).toBe("plentifully; amply");
  });

  it("is null when there is nothing to read — no second line beats an empty one", () => {
    expect(gistOf("")).toBeNull();
    expect(gistOf("  \n\n")).toBeNull();
    expect(gistOf("<ai>Example sentence of plectrum</ai>")).toBeNull();
  });
});
