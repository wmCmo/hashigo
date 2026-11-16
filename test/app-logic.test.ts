import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { childrenOf, rootsOf, subtreeTotals, type TreeDeck } from "../app/deck-tree.js";
import { gistOf } from "../app/gist.js";
import { isTypingTarget, survivesTyping } from "../app/keys.js";
import { localDate, shouldStartNewDay } from "../app/new-day.js";
import { cardIdToCopy } from "../app/copy-id.js";
import {
  promptPositions,
  heroLength,
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

function side(
  position: number,
  index: number,
  { empty = false, text = "" }: { empty?: boolean; text?: string } = {},
): BoundarySide {
  return { position, index, empty, text };
}

describe("the question boundary — which sides are the prompt", () => {
  it("is the first visible side, and nothing else, on an ordinary card", () => {
    const sides = [
      side(0, 0, { text: "慈善" }),
      side(1, 1, { text: "じぜん 平板" }),
      side(2, 2, { text: "example sentence" }),
      side(3, 3, { text: "charity" }),
    ];
    expect(promptPositions(sides)).toEqual([0]);
  });

  it("SKIPS an empty leading side, which is how a `Reading = false` 単語 starts at side 2", () => {
    const sides = [
      side(0, 0, { empty: true }),
      side(1, 1, { text: "[…] […] 中高 (3)" }),
      side(2, 2, { text: "example sentence" }),
    ];
    expect(visiblePositions(sides)).toEqual([1, 2]);
    expect(promptPositions(sides)).toEqual([1]);
  });

  it("STOPS AT 漢字's `---`, even though the next side is only a canvas", () => {
    const sides = [
      side(0, 0, { text: "慈" }),
      side(1, 1, { text: "" }),
      side(2, 2, { text: "じ" }),
    ];
    expect(promptPositions(sides)).toEqual([0]);
  });

  it("never extends over a later side, whatever is on it", () => {
    for (const text of ["", "じ", "じ — the answer, beside the widget"]) {
      expect(promptPositions([side(0, 0, { text: "慈" }), side(1, 1, { text })])).toEqual([0]);
    }
  });

  it("IS POSITIONAL, NOT AUTHORED — the regression that printed the answer above the question", () => {
    const sides = [
      side(0, 2, { text: "time constraints make it impossible to do everything" }),
      side(1, 1, { text: "an example sentence, with audio" }),
      side(2, 0, { text: "constraint" }),
    ];
    expect(promptPositions(sides)).toEqual([0]);
  });

  it("yields an empty question for a card that renders nothing, rather than throwing", () => {
    expect(promptPositions([])).toEqual([]);
    expect(promptPositions([side(0, 0, { empty: true })])).toEqual([]);
  });

});

function deck(id: string, parentId: string | null, cards: number, due = 0): TreeDeck {
  return { id, parentId, cards, due };
}

describe("the sidebar's deck tree", () => {
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
    const filtered = [deck("tango", "ja", 3477), deck("onomatope", "tango", 41)];
    expect(rootsOf(filtered).map((d) => d.id)).toEqual(["tango"]);
  });

  it("counts descendants, which is the whole reason a parent shows a number", () => {
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
    const diamond = [
      deck("root", null, 0),
      deck("left", "root", 1),
      deck("right", "root", 2),
      deck("shared", "left", 10),
    ];
    expect(subtreeTotals(diamond, diamond[0]!).cards).toBe(13);
  });
});

describe("the typing guard — the shortcut that must never fire while he types", () => {
  it("blocks every text-entry element", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("allows the page's own elements, so the shortcuts still work", () => {
    expect(isTypingTarget({ tagName: "BODY" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "SECTION" })).toBe(false);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });

  it("is case-insensitive about tagName, because not every source shouts", () => {
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
    expect(isTypingTarget({ tagName: "TextArea" })).toBe(true);
  });

  it("does NOT rely on instanceof, so a cross-realm element is still caught", () => {
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

const stepSide = (
  position: number,
  clozes: number,
  audio: number,
  prompt = false,
): StepSide => ({ position, clozes, audio, prompt });

describe("the reveal order", () => {
  it("walks 単語 Reading=true: side 2's cloze, the sentence, then the meaning", () => {
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
    const steps = revealSteps([stepSide(1, 2, 1, true), stepSide(2, 0, 1), stepSide(3, 1, 0)]);
    expect(steps).toEqual([
      { position: 1, cloze: 0, show: false },
      { position: 1, cloze: 1, show: false },
      { position: 2, cloze: null, show: true },
      { position: 3, cloze: 0, show: true },
    ]);
  });

  it("walks 漢字: the canvas, the reading, the meaning — three presses, since 2026-09-14", () => {
    const steps = revealSteps([
      stepSide(0, 0, 0, true),
      stepSide(1, 0, 0),
      stepSide(2, 0, 0),
      stepSide(3, 0, 0),
    ]);
    expect(steps).toEqual([
      { position: 1, cloze: null, show: true },
      { position: 2, cloze: null, show: true },
      { position: 3, cloze: null, show: true },
    ]);
  });

  it("gives a question side with audio and no cloze a step of its own", () => {
    expect(revealSteps([stepSide(0, 0, 1, true)])).toEqual([
      { position: 0, cloze: null, show: false },
    ]);
  });

  it("gives a question side with neither cloze nor audio no step at all", () => {
    expect(revealSteps([stepSide(0, 0, 0, true)])).toEqual([]);
  });

  it("never crosses into the next side before finishing this one", () => {
    const steps = revealSteps([stepSide(0, 2, 0, true), stepSide(1, 2, 0)]);
    expect(steps.map((step) => step.position)).toEqual([0, 0, 1, 1]);
    expect(steps.map((step) => step.cloze)).toEqual([0, 1, 0, 1]);
    expect(steps.map((step) => step.show)).toEqual([false, false, true, false]);
  });

  it("reverses the SIDES and leaves cloze order ascending — the second half of his sentence", () => {
    const forward = revealSteps([stepSide(0, 2, 0, true), stepSide(1, 2, 0)]);
    const reverse = revealSteps([stepSide(0, 2, 0, true), stepSide(1, 2, 0)]);
    expect(reverse).toEqual(forward);
    for (const position of [0, 1]) {
      const clozes = reverse.filter((step) => step.position === position).map((s) => s.cloze);
      expect(clozes, `side ${position} must ascend`).toEqual([0, 1]);
    }
  });
});

describe("which sides are set as the hero (decision 57)", () => {
  it("takes a short run of Japanese script, and says how long it is", () => {
    expect(heroLength("慈")).toBe(1);
    expect(heroLength("東京")).toBe(2);
    expect(heroLength(" 日本語 ")).toBe(3);
    expect(heroLength("にんじん")).toBe(4);
    expect(heroLength("コーヒー")).toBe(4);
    expect(heroLength("人々")).toBe(2);
  });

  it("leaves Latin to `display`, because decision 35's short reverse prompts are not heroes", () => {
    expect(heroLength("protein")).toBe(0);
    expect(heroLength("cook; chef")).toBe(0);
    expect(heroLength("shun")).toBe(0);
  });

  it("never takes a side holding a cloze mask, so a reveal cannot jump sizes", () => {
    expect(heroLength("[…]係数[…]係数 中高(3)")).toBe(0);
    expect(heroLength("[…]")).toBe(0);
  });

  it("covers the three head-word steps and stops at twelve; an empty side is not a hero", () => {
    expect(heroLength("気が付く")).toBe(4);
    expect(heroLength("一から十まで")).toBe(6);
    expect(heroLength("あいうえおかきくけこさし")).toBe(12);
    expect(heroLength("あいうえおかきくけこさしす")).toBe(0);
    expect(heroLength("")).toBe(0);
    expect(heroLength("   ")).toBe(0);
  });

  it("counts 𠮟 once — a code point, which for Japanese is what `sideScale`'s graphemes are too", () => {
    expect(heroLength("𠮟る")).toBe(2);
  });
});

describe("how big the text on a side should be", () => {
  it("puts every forward vocabulary prompt in display", () => {
    for (const text of [
      "判断",
      "慈",
      "[…]係数[…]係数 中高(3)",
      "[…]判断[…]判断頭高",
      "にんじん",
      "shun",
    ]) {
      expect(sideScale(text), text).toBe("display");
    }
  });

  it("counts an emoji as what a reader sees, not as its joined code points", () => {
    const side = "🤝👩‍💼👨‍💼🤝[…]携わる[…]携たずさわる中高 (4)";
    expect([...side].length).toBe(29);
    expect(sideScale(side)).toBe("display");
  });

  it("drops the reverse prompt that started all this out of display", () => {
    const definition = "judgement; judgement; decision; conclusion; adjudication";
    expect([...definition].length).toBe(56);
    expect(sideScale(definition)).toBe("mid");
    expect(sideScale(`${definition}
divination
🀄JPDB🎬IKD`)).toBe("body");
    expect(sideScale("coefficient #Mathematics coefficient; factor; proportional constant")).toBe(
      "body",
    );
    for (const text of [definition, "coefficient #Mathematics coefficient; factor"]) {
      expect(sideScale(text), text).not.toBe("display");
    }
  });

  it("keeps a SHORT reverse prompt big, because the rule is length and not direction", () => {
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
    const astral = "𠮟".repeat(28);
    expect(astral.length).toBe(56);
    expect(sideScale(astral)).toBe("display");
  });

  it("collapses whitespace before measuring, so a wrapped render is not punished", () => {
    expect(sideScale("  judgement \n\n   decision  ")).toBe("display");
    expect(sideScale("")).toBe("display");
  });

  it("is the rule that also fixes 基本情報 FORWARD, which nobody had reported", () => {
    const long =
      "コンピュータの五大装置のうち、演算装置と制御装置を合わせたものを何と呼ぶか。またその役割を説明せよ。";
    expect([...long].length).toBeGreaterThan(28);
    expect(sideScale(long)).not.toBe("display");
  });
});

describe("the audio file's own freshness", () => {
  it("re-fetches when the server is serving a different build", () => {
    expect(audioIsStale("2026-09-12T12:11:02.236Z", "2026-09-08T01:58:28.378Z")).toBe(true);
  });

  it("leaves it alone when they match — the whole point is a local, offline app", () => {
    expect(audioIsStale("2026-09-12T12:11:02.236Z", "2026-09-12T12:11:02.236Z")).toBe(false);
  });

  it("does NOT re-fetch against an older manifest that has no such field", () => {
    expect(audioIsStale(undefined, "2026-09-08T01:58:28.378Z")).toBe(false);
    expect(audioIsStale("", "2026-09-08T01:58:28.378Z")).toBe(false);
  });

  it("DOES re-fetch a store that cannot say when it was built", () => {
    expect(audioIsStale("2026-09-12T12:11:02.236Z", undefined)).toBe(true);
    expect(audioIsStale("2026-09-12T12:11:02.236Z", "")).toBe(true);
  });

  it("compares for DIFFERENCE, not for newer", () => {
    expect(audioIsStale("2026-09-08T01:58:28.378Z", "2026-09-12T12:11:02.236Z")).toBe(true);
  });
});

describe("shadowing controls", () => {
  describe("the speed ladder", () => {
    it("starts at normal, so one press is the slow one", () => {
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
      expect(SPEEDS).not.toContain(0.5);
      expect(Math.min(...SPEEDS)).toBe(0.75);
    });

    it("resets an unknown rate rather than honouring it", () => {
      expect(nextSpeed(4)).toBe(1);
      expect(nextSpeed(Number.NaN)).toBe(1);
    });

    it("writes normal speed as `1×`, not `1.00×`", () => {
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
      expect(readPlayback('{"rate":4,"loop":false}').rate).toBe(1);
      expect(readPlayback('{"rate":"0.75"}').rate).toBe(1);
      expect(readPlayback('{"rate":0.5}').rate).toBe(1);
      expect(readPlayback('{"rate":0.75,"loop":"yes"}')).toEqual({ rate: 0.75, loop: false });
    });
  });

  describe("the take", () => {
    it("says `allow…` while the browser is asking", () => {
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
      expect(takeLabels("denied").recordDisabled).toBe(true);
      expect(takeLabels("denied").record).toBe("record");
    });

    it("refuses to sound a clip while the mic is open", () => {
      expect(mayPlayClip("recording")).toBe(false);
      expect(mayPlayClip("arming")).toBe(false);
      expect(mayPlayClip("idle")).toBe(true);
      expect(mayPlayClip("take")).toBe(true);
      expect(mayPlayClip("denied")).toBe(true);
    });

    it("opens the mic with the processing that would flatten a contour OFF", () => {
      expect(CAPTURE.autoGainControl).toBe(false);
      expect(CAPTURE.noiseSuppression).toBe(false);
      expect(CAPTURE.echoCancellation).toBe(true);
    });

    it("picks opus where it exists and still records where it does not", () => {
      expect(pickRecordingType((type) => type.includes("webm"))).toBe("audio/webm;codecs=opus");
      expect(pickRecordingType((type) => type === "audio/mp4")).toBe("audio/mp4");
      expect(pickRecordingType(() => false)).toBe("");
    });
  });
});

describe("theme", () => {
  it("says `follow this device` by taking the attribute OFF, not by naming it", () => {
    expect(themeAttribute("system")).toBeNull();
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
  });

  it("offers three states, because a switch would take his sunset away", () => {
    expect([...THEMES]).toEqual(["system", "light", "dark"]);
    expect(themeLabel("system")).toBe("follow this device");
  });

  it("forces the phone's chrome only when he has actually chosen", () => {
    expect(forcedChrome("system")).toBeNull();
    expect(forcedChrome("dark")).toBe("#262626");
    expect(forcedChrome("light")).toBe("#F2F2F2");
  });

  it("falls back to following the device on anything unrecognised", () => {
    for (const raw of [null, undefined, "", "System", "auto", "{}", "DARK"]) {
      expect(readTheme(raw), `readTheme(${String(raw)})`).toBe("system");
    }
    expect(readTheme("dark")).toBe("dark");
  });
});

const phone = (elementTop: number, elementBottom: number, gap = 16): RevealViewport => ({
  top: 97,
  bottom: 662,
  elementTop,
  elementBottom,
  gap,
});

describe("following the reveal down the page", () => {
  it("moves just far enough to clear the footer, not to the top of the window", () => {
    expect(revealScroll(phone(600, 720))).toBe(74);
  });

  it("leaves the page alone when the revealed thing is already readable", () => {
    expect(revealScroll(phone(300, 420))).toBe(0);
    expect(revealScroll(phone(113, 646))).toBe(0);
  });

  it("NEVER scrolls up, whatever the geometry says", () => {
    expect(revealScroll(phone(-400, -200))).toBe(0);
    expect(revealScroll(phone(-50, 300))).toBe(0);
    expect(revealScroll(phone(20, 90))).toBe(0);
  });

  it("top-aligns a side taller than the visible box, because clearing it cannot work", () => {
    expect(revealScroll(phone(200, 1100))).toBe(87);
    expect(revealScroll(phone(100, 1000))).toBe(0);
  });

  it("does nothing when there is no room to scroll into", () => {
    expect(revealScroll({ top: 300, bottom: 320, elementTop: 900, elementBottom: 1000, gap: 16 }))
      .toBe(0);
  });

  it("returns whole pixels, so a smooth scroll has an integer to land on", () => {
    expect(revealScroll(phone(700.4, 800.6))).toBe(155);
    expect(Number.isInteger(revealScroll(phone(700.4, 800.6)))).toBe(true);
  });
});

describe("the tap highlight", () => {
  const css = readFileSync("app/style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("is off for the whole page, from body, where everything inherits it", () => {
    const body = /(?:^|\n)body\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(body).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
  });

  it("is never turned back on", () => {
    const values = [...css.matchAll(/-webkit-tap-highlight-color:\s*([^;}]+)/g)].map((m) => (m[1] as string).trim());
    expect(values.filter((v) => v !== "transparent")).toEqual([]);
  });
});

describe("the done screen's way out", () => {
  const html = readFileSync("app/index.html", "utf8");
  const css = readFileSync("app/style.css", "utf8");
  const done = /<section id="done"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

  it("carries its own drawer toggle", () => {
    expect(done).toMatch(/<button id="donesidebartoggle" class="sidebartoggle"[^>]*aria-controls="sidebar"/);
    const sidebar = readFileSync("app/sidebar.ts", "utf8");
    expect(sidebar).toContain('el<HTMLButtonElement>("donesidebartoggle")');
  });

  it("does not style that toggle as one of its pill buttons", () => {
    expect(css).not.toMatch(/\.done button/);
    expect(css).toMatch(/\.done-actions > button/);
  });

  it("keeps its pills apart: a wrapping row with a gap, not bare inline buttons", () => {
    const actions = /<div class="done-actions">([\s\S]*?)<\/div>/.exec(done)?.[1] ?? "";
    expect(actions).toContain('id="focusclear"');
    expect(actions).toContain('id="backup"');
    const rule = /\.done-actions\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    expect(rule).toMatch(/gap:\s*var\(--space-3\)/);
  });

  it("gives way to the gallery the toggle can now open", () => {
    expect(css).toContain('body[data-view="gallery"] .done { display: none; }');
  });
});

describe("copying the open card's id", () => {
  const base = { selection: "", typing: false, layerCardId: null, reviewCardId: "rev1" };

  it("copies the review card's id when nothing is selected", () => {
    expect(cardIdToCopy(base)).toBe("rev1");
  });

  it("copies the TOP LAYER's card over the review card underneath", () => {
    expect(cardIdToCopy({ ...base, layerCardId: "prev9" })).toBe("prev9");
  });

  it("steps aside for a real copy: selected text, or focus in a field", () => {
    expect(cardIdToCopy({ ...base, selection: "数隻" })).toBe(null);
    expect(cardIdToCopy({ ...base, typing: true })).toBe(null);
  });

  it("whitespace alone is not a selection", () => {
    expect(cardIdToCopy({ ...base, selection: " \n" })).toBe("rev1");
  });

  it("copies nothing where no single card is open", () => {
    expect(cardIdToCopy({ ...base, reviewCardId: null })).toBe(null);
    expect(cardIdToCopy({ ...base, layerCardId: "" })).toBe(null);
  });
});

describe("a new day on a page that stayed open", () => {
  const base = {
    plannedOn: "2026-11-06",
    today: "2026-11-09",
    onDone: true,
    layered: false,
    typing: false,
  };

  it("reloads a FINISHED plan from an earlier date", () => {
    expect(shouldStartNewDay(base)).toBe(true);
  });

  it("leaves a plan from today alone", () => {
    expect(shouldStartNewDay({ ...base, today: "2026-11-06" })).toBe(false);
  });

  it("never reloads under a card — a session past midnight keeps its day", () => {
    expect(shouldStartNewDay({ ...base, onDone: false })).toBe(false);
  });

  it("waits while something is half-typed", () => {
    expect(shouldStartNewDay({ ...base, layered: true })).toBe(false);
    expect(shouldStartNewDay({ ...base, typing: true })).toBe(false);
  });

  it("reads the LOCAL calendar date, zero-padded", () => {
    expect(localDate(new Date(2026, 10, 9, 0, 30))).toBe("2026-11-09");
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("the climbing mark on the boot screen", () => {
  it("draws the SHIPPED mark, not a copy of it", () => {
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
    expect(climbFrame(0)).toEqual(restFrame());
    expect(climbFrame(SYNC_STAGES.hold - 1)).toEqual(restFrame());
    expect(climbFrame(SYNC_STAGES.hold + 1)[1]!.s).toBeGreaterThan(1);
  });

  it("keeps the BEAT — a window with nothing at the top of the mark", () => {
    const beatAt = SYNC_STAGES.hold + SYNC_STAGES.drop + SYNC_STAGES.beat / 2;
    const during = climbFrame(beatAt);
    expect(during).toHaveLength(3);
    expect(during.some((rung) => rung.s < 0.5)).toBe(false);
    expect(climbFrame(SYNC_STAGES.hold + SYNC_STAGES.drop - 1)).toHaveLength(4);
    expect(
      climbFrame(SYNC_STAGES.hold + SYNC_STAGES.drop + SYNC_STAGES.beat + 1),
    ).toHaveLength(4);
  });

  it("gives the reward timing one pass that starts ON the drop", () => {
    const start = climbFrame(0, REWARD_STAGES);
    expect(start).toHaveLength(4);
    expect(start[0]!.s).toBe(0);
    expect(climbFrame(REWARD_STAGES.drop / 4, REWARD_STAGES)[0]!.s).toBeGreaterThan(0.3);
  });

  it("returns a MIX POSITION, never a colour — the themes differ", () => {
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
    expect(readout("downloading", samples, 640_000_000, 2_000, 0).etaSeconds).toBeNull();
    const later = [sample(0, 0), sample(20_000, 80_000_000)];
    expect(readout("downloading", later, 640_000_000, 20_000, 0).etaSeconds).toBeCloseTo(140, 0);
  });

  it("calls it stalled on BYTES, not on slowness", () => {
    const crawling = [sample(0, 0), sample(20_000, 40_000)];
    expect(readout("downloading", crawling, 640_000_000, 20_100, 0).stalled).toBe(false);
    expect(readout("downloading", crawling, 640_000_000, 29_000, 0).stalled).toBe(true);
    expect(readout("saving", crawling, 640_000_000, 29_000, 0).stalled).toBe(false);
  });

  it("sweeps rather than inventing a percentage when Content-Length is missing", () => {
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

describe("how late a track is, in words", () => {
  it("says nothing at all for a track that is not in the past", () => {
    expect(overdueLabel(0)).toBeNull();
    expect(overdueLabel(-3)).toBeNull();
    expect(overdueLabel(Number.NaN)).toBeNull();
  });

  it("counts days for the case he described, and names yesterday", () => {
    expect(overdueLabel(1)).toBe("due yesterday");
    expect(overdueLabel(5)).toBe("due 5 days ago");
    expect(overdueLabel(30)).toBe("due 30 days ago");
  });

  it("switches to months and then years, because 757 days is not a duration", () => {
    expect(overdueLabel(31)).toBe("due 1 month ago");
    expect(overdueLabel(61)).toBe("due 2 months ago");
    expect(overdueLabel(364)).toBe("due 11 months ago");
    expect(overdueLabel(365)).toBe("due 1 year ago");
    expect(overdueLabel(757)).toBe("due 2 years ago");
  });

  it("never lets months and years disagree about which is longer", () => {
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
    expect(dueDateOf("2026-09-12T04:00:00.000+09:00")).toBe("2026-09-12");
    expect(dueDateOf(null)).toBeNull();
    expect(dueDateOf("whenever")).toBeNull();
    expect(overdueTitle(5, "2026-09-12T04:00:00.000+09:00")).toBe("due 2026-09-12 — 5 days late");
    expect(overdueTitle(5, null)).toBe("5 days late");
  });
});

describe("the progress bar's two widths", () => {
  it("draws the misses as a PREFIX of the fill, not a slice out of it", () => {
    const w = barWidths({ answeredToday: 10, missedToday: 3, plannedToday: 40 });
    expect(w.donePercent).toBeCloseTo(25);
    expect(w.missedPercent).toBeCloseTo(7.5);
    expect(w.missedPercent).toBeLessThanOrEqual(w.donePercent);
  });

  it("clamps a numerator that legitimately exceeds its denominator", () => {
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
    expect(barValueText(barWidths({ answeredToday: 12, missedToday: 0, plannedToday: 40 })))
      .toBe("12 of 40 answered today");
  });
});

describe("the last-seen date", () => {
  it("renders his own example format", () => {
    expect(lastSeenLabel("2025-07-02T00:00:00+09:00")).toBe("Jul 2, 2025");
  });

  it("reads the LOCAL date, not the viewer's", () => {
    expect(lastSeenLabel("2025-07-02T00:00:00+09:00")).toBe("Jul 2, 2025");
    expect(lastSeenLabel("2025-07-02T23:30:00+09:00")).toBe("Jul 2, 2025");
    expect(lastSeenLabel("2025-07-01T15:00:00Z")).toBe("Jul 1, 2025");
  });

  it("does not move with the device locale", () => {
    const label = lastSeenLabel("2025-12-31T00:00:00+09:00");
    expect(label).toBe("Dec 31, 2025");
    expect(label).not.toMatch(/\d+\/\d+/);
  });

  it("says nothing for a new track, rather than something wrong", () => {
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
