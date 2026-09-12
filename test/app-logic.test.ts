import { describe, expect, it } from "vitest";

import { childrenOf, rootsOf, subtreeTotals, type TreeDeck } from "../app/deck-tree.js";
import { isTypingTarget, survivesTyping } from "../app/keys.js";
import {
  promptPositions,
  sideScale,
  visiblePositions,
  type BoundarySide,
} from "../app/review-boundary.js";
import { revealSteps, type StepSide } from "../app/review-steps.js";
import { audioIsStale } from "../app/seed-freshness.js";
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
