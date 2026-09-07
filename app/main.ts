/**
 * The review screen — decision 23, direction A2, over the real pipeline.
 *
 *     hashigo/session → hashigo/review → hashigo/render → this file's chrome
 *
 * ─── WHAT THIS FILE OWNS AND WHAT IT MUST NOT ───────────────────────────────
 *
 * It owns the DOM, the object URLs and the two buttons. It owns NO SQL: the
 * database is in `./db.worker.ts` because `opfs-sahpool` is worker-only (see
 * `./protocol.ts`). And it renders through `src/render` — every class inside a
 * card comes from that module's `CLASS`, so `./style.css` styles the real output
 * rather than a copy of it.
 *
 * **It does not decide when audio plays.** `mountPrepared` returns a
 * `MountedCard` whose `enter()` already knows the card's mode (decision 29), so
 * the screen calls `enter()` and `reveal()` and nothing else. That is deliberate:
 * the one rule this app cannot get wrong lives in `src/`, tested over 7,716 real
 * cards, and a screen that re-implemented the condition would be a second place
 * for it to be wrong.
 *
 * ─── HOW MANY SIDES ARE ON SCREEN, AND WHY NOT ALL OF THEM ──────────────────
 *
 * **MEASURED, and it is the one structural thing the mockup could not tell us.**
 * `build/mock/out/a2-terminal.html` puts every non-empty side inside `.answer`
 * behind one reveal, and its always-visible `.head` is hand-authored HTML that
 * `src/render` never produces. Doing that for real leaks the answer:
 *
 *     単語 side 3 is `><<例文>>` — the example SENTENCE, and it is NOT clozed.
 *     On an identify card the question is "what word did you just hear"; side 3
 *     prints that word in context. On a produce card it prints the kanji.
 *
 * So sides are PROGRESSIVE, which is also what `src/render/reveal.ts` assumes in
 * as many words ("sides are presented in sequence: revealing side 3's cloze while
 * side 2 is on screen leaks the answer to side 2"). Two phases, two taps:
 *
 *     PROMPT     the first non-empty side, plus any widget-only side after it
 *     REVEALED   every remaining side, and exactly ONE clip
 *
 * ─── THE BOUNDARY RULE, AND THE ONE THAT WAS WRONG ──────────────────────────
 *
 * **The prompt is the FIRST non-empty side.** That is it, plus one exception:
 * a following side whose only content is a WIDGET comes with it, because 漢字 is
 * `<<Kanji>>` / `<draw>` / `<<Reading>>` / `<<Meaning>>` and the canvas has to be
 * on screen while he is drawing from memory.
 *
 * A first version instead took "every side up to the first one that hides or
 * sounds something", and **running the app killed it in one card.** The first card
 * the real session served was a REVERSE New Vocab track, whose side order is
 * permuted to Meaning → Example → Vocab. The Example side carries audio, so that
 * rule pulled it into the prompt — and the example sentence *"time constraints
 * make it impossible to do everything"* contains the answer word. The screen
 * printed the answer above the question.
 *
 * Reverse tracks are why the rule has to be positional rather than clever:
 * whatever the template author put first is the question, in whichever order the
 * direction asks for it.
 *
 * ─── EXACTLY ONE CLIP PER REVEAL ────────────────────────────────────────────
 *
 * `audioController.play()` defers extra clips only WITHIN one call, so revealing
 * three sides starts three clips. Measured on 単語, which has two: the word and
 * the example sentence, both at once. So the reveal picks ONE side to sound — the
 * first with audio — and unmasks every other side with `reveal(cause,
 * {silent:true})`.
 */

import { BlobUrlScope } from "../src/blobs/url.js";
import { browserDocument, CLASS } from "../src/render/index.js";
import { mountPrepared, type MountedCard, type PreparedCard } from "../src/review/index.js";
import { attachDraw, type DrawHandle, type DrawSurface } from "../src/render/draw.js";
import {
  attachInput,
  type AnswerCheck,
  type InputHandle,
  type InputSurface,
} from "../src/render/input.js";
// The template editor's two rules, from the modules that own them. `referencedNames`
// is the same lexer the parser uses (`FIELD_TOKEN`), so the 'not a field' check on
// screen cannot disagree with what the renderer will actually resolve.
import { referencedNames } from "../src/template/index.js";
// The link rules, in an import-free module `test/` can reach — the same seam as
// `./keys.ts` and `./review-keys.ts`. `test/app-links.test.ts` round-trips all
// 8,744 authored links through it.
import { completeLink, linkAt, triggerAt, type Trigger } from "./links.js";
import { moveWithin } from "../src/schema/index.js";
import type { RenderResult } from "../src/render/index.js";
import type { ShadowingSide } from "../src/render/reveal.js";
// The two extracted rules. Import-free modules so `test/` can reach them; see
// `test/app-logic.test.ts` and the headers of both files.
import { childrenOf as treeChildrenOf, subtreeTotals } from "./deck-tree.js";
import { isTypingTarget, type KeyTarget } from "./keys.js";
import { reviewAction } from "./review-keys.js";
import {
  promptPositions as promptBoundary,
  visiblePositions,
  type BoundarySide,
} from "./review-boundary.js";
import type {
  AppMessage,
  AppRequest,
  BrowseHit,
  CardOp,
  DeckOp,
  TemplateChoice,
  TemplateDetail,
  TemplateFieldRow,
  TemplateOpRequest,
  DeckBrief,
  ReplyFor,
  TemplateBrief,
} from "./protocol.js";

// ─── the worker, as a promise-returning client ───────────────────────────────

const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });

let nextId = 1;
const pending = new Map<
  number,
  { resolve: (value: never) => void; reject: (reason: Error) => void }
>();

worker.onmessage = (event: MessageEvent<AppMessage>): void => {
  const message = event.data;
  if (message.kind === "log") {
    line(message.text, message.level);
    return;
  }
  const waiting = pending.get(message.id);
  if (waiting === undefined) return;
  pending.delete(message.id);
  if (message.kind === "error") {
    waiting.reject(Object.assign(new Error(message.message), { stack: message.stack ?? undefined }));
    return;
  }
  (waiting.resolve as (value: AppMessage) => void)(message);
};

function ask<K extends keyof ReplyFor>(
  request: Omit<Extract<AppRequest, { kind: K }>, "id">,
): Promise<ReplyFor[K]> {
  const id = nextId++;
  return new Promise<ReplyFor[K]>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (value: never) => void,
      reject,
    });
    worker.postMessage({ ...request, id } as AppRequest);
  });
}

// ─── the page ────────────────────────────────────────────────────────────────

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} is not in index.html`);
  return found as T;
};

const bootView = el("boot");
const bootLog = el("bootlog");
const reviewView = el("review");
const deckLine = el("deck");
const cardHost = el("cardhost");
const hintLine = el("hint");
const peekLine = el("peek");
const progressLabel = el("progress");
const progressBar = el("progressbar");
const progressFill = el("progressfill");
const revealButton = el<HTMLButtonElement>("reveal");
const forgotButton = el<HTMLButtonElement>("forgot");
const rememberedButton = el<HTMLButtonElement>("remembered");
const replayButton = el<HTMLButtonElement>("replay");
const readingButton = el<HTMLButtonElement>("readingtoggle");
const banner = el("banner");
const doneView = el("done");
const doneText = el("donetext");

function line(text: string, level = "info"): void {
  const row = document.createElement("div");
  row.className = `logline ${level}`;
  row.textContent = text;
  bootLog.appendChild(row);
  bootLog.scrollTop = bootLog.scrollHeight;
}

/** One scope per card presentation: the scope that mints a URL revokes it. */
let scope: BlobUrlScope | null = null;
let mounted: MountedCard<HTMLElement> | null = null;
let drill: ShadowingSide<HTMLElement> | null = null;
let tail: ShadowingSide<HTMLElement>[] = [];
let shownAt = 0;
let revealed = false;
let currentCardId: string | null = null;
/** The review card's prepared form, so `e` can edit it without re-fetching. */
let previewOfCurrent: PreparedCard | null = null;
let drawHandles: DrawHandle[] = [];
let inputHandles: InputHandle[] = [];
/**
 * The review card's collection state, straight from the row (`collectionState` in
 * the worker). It labels the two toggles and decides which verb they send, so it
 * is READ rather than remembered — see that function's header.
 */
let currentPinned = false;
let currentArchived = false;
/**
 * How far the screen is from the session's cursor — his #9.
 *
 * `0` is the card he is being asked. Anything else is a look-ahead (or a
 * look-back), and while it is non-zero **nothing can be graded**: `answer()` acts
 * on the session's item, not on what is displayed, so a grade from here would move
 * a due date on a card he is not reading. `paintPeek` is where that is enforced
 * and shown; `showSessionCard` is how every other caller gets back to 0.
 */
let peekOffset = 0;

/**
 * Make every `<draw>` canvas on a card actually drawable — his #10.
 *
 * **He asked whether the drawing field worked. It did not, and this is why.**
 * `src/render` deliberately emits a BARE `<canvas>` — its own header says a
 * drawing surface has to be sized in device pixels at attach time or every stroke
 * is drawn at half resolution and blurs — and `attachDraw` is the function that
 * does that sizing and binds the pointer events. Nothing in the shell had ever
 * called it. The canvas appeared, took no strokes, and reported no error: the
 * 漢字 exercise is *draw it from memory, then check*, so 1,662 cards had their
 * exercise silently missing.
 *
 * `touch-action: none` is set inside `attachDraw` for a measured reason: without
 * it the browser reads the first finger movement as a scroll and the stroke never
 * arrives — which is exactly what "i tried but it didn't work" looks like on a
 * phone.
 *
 * Handles are returned so the caller can dispose them with the card; a canvas
 * that outlives its mount keeps pointer listeners alive on a detached node.
 */
function makeDrawable(result: { widgets: readonly { element: HTMLElement; name: string; attributes: Readonly<Record<string, string>> }[] }): DrawHandle[] {
  const handles: DrawHandle[] = [];
  for (const widget of result.widgets) {
    if (widget.name !== "draw") continue;
    if (!(widget.element instanceof HTMLCanvasElement)) continue;
    const handle = attachDraw(widget, widget.element as unknown as DrawSurface);
    handles.push(handle);
    // Undo and clear, as BUTTONS. `DrawHandle` has had both since stage 4 and
    // neither was reachable — and on a phone there is no keyboard to reach them
    // with, which is his standing rule: every 操作 on the desktop must exist on
    // mobile. A stroke you cannot take back is a canvas you stop using.
    const bar = document.createElement("div");
    bar.className = "draw-bar";
    for (const [label, run] of [
      ["undo stroke", () => handle.undo()],
      ["clear", () => handle.clear()],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "draw-button";
      button.textContent = label;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        run();
      });
      bar.appendChild(button);
    }
    widget.element.insertAdjacentElement("afterend", bar);
  }
  return handles;
}

/**
 * `--footer-h`: the real height of the bottom controls, in pixels.
 *
 * THIS EXISTS BECAUSE THE HAND-TUNED VERSION WAS WRONG, measured. The operations
 * row and the reveal/grade bar were two separately-fixed elements, each with its
 * own `bottom:` offset, and on a 375x812 viewport the lower one covered the upper
 * by **19px** — the bottom of every operation button, gone. The offsets could not
 * have stayed right: `.bar`'s height is whatever its font and padding make it, so
 * either changing moves it over its neighbour silently.
 *
 * They are one fixed box now, stacked in normal flow, so overlapping is not
 * expressible. What is left is everything that has to CLEAR them — the card's
 * bottom padding, the replay button, the status strip — and those read this
 * variable rather than each carrying a copy of the number.
 *
 * A ResizeObserver rather than one measurement at boot: the row is taller when a
 * label wraps, the safe-area inset arrives late on iOS, and the browser's own font
 * size is a setting he can change.
 */
const footer = el("footer");
const measureFooter = (): void => {
  document.documentElement.style.setProperty("--footer-h", `${footer.offsetHeight}px`);
};
new ResizeObserver(measureFooter).observe(footer);
measureFooter();

/**
 * Make every rendered `<input>` check its own answer — the second half of his #10's
 * shape, and the one that was still open.
 *
 * **`attachInput` has existed since stage 4 and nothing had ever called it.** The
 * exact same defect as the drawing field: the renderer emits the box, puts the
 * authored answer in `data-expect` (it is the EXPECTED ANSWER, not a prefill — the
 * 数字 template reads a number aloud and reveals the formatted one), and stops
 * there, because "what a right answer means to the scheduler" is not the
 * renderer's. Nothing downstream picked it up, so the box took typing and reported
 * nothing, on all 90 数字 cards.
 *
 * ─── WHAT A VERDICT DOES AND DELIBERATELY DOES NOT DO ───────────────────────
 *
 * It marks the box and reveals. It does **not** grade. Decision 2 is that grades are
 * binary and HIS — the app cannot know whether he wants a typo counted as forgotten,
 * and `checkAnswer` folds width, case and kana precisely because the answer to that
 * is "not on a technicality". So Enter reveals and shows the comparison; `f` and `j`
 * still decide.
 *
 * `normaliseAnswer` is why this is not `===`: 数字 answers arrive as full-width
 * digits, with commas, from an IME. NFKC plus separator-stripping is what makes
 * `１，０００` and `1000` the same answer.
 */
function makeCheckable(
  result: {
    widgets: readonly {
      element: HTMLElement;
      name: string;
      expected: string | null;
    }[];
  },
  onSubmit: ((check: AnswerCheck | null) => void) | null,
): InputHandle[] {
  const handles: InputHandle[] = [];
  for (const widget of result.widgets) {
    if (widget.name !== "input") continue;
    if (!(widget.element instanceof HTMLInputElement)) continue;
    handles.push(
      attachInput(widget, widget.element as unknown as InputSurface, {
        // Kana folding on: a 数字 answer typed through an IME can arrive as kana
        // or as digits, and both are the same answer to the exercise.
        foldKana: true,
        ...(onSubmit === null ? {} : { onSubmit }),
      }),
    );
  }
  return handles;
}

/** `data-state` on the review view, which is what `style.css` switches on. */
function setState(state: "prompt" | "revealed"): void {
  reviewView.setAttribute("data-state", state);
}

/**
 * Both of these are ADAPTERS now. The rules themselves live in
 * `./review-boundary.js`, over four plain fields instead of over
 * `RenderResult<HTMLElement>`, so `test/app-logic.test.ts` can reach them — this
 * file cannot be imported from `test/`, because the root `tsconfig.json` excludes
 * `app/` on purpose.
 *
 * The question boundary had been wrong in production once (a reverse track printed
 * the answer above the question) and was covered by nothing. It is now pinned by
 * eight tests, three of which were confirmed to fail when the rule is broken.
 */
function visibleSides(result: RenderResult<HTMLElement>): number[] {
  return visiblePositions(boundarySides(result));
}

/** The question: the first non-empty side, plus a following widget-only side. */
function promptPositions(card: MountedCard<HTMLElement>): number[] {
  return promptBoundary(
    boundarySides(card.result),
    card.result.widgets.map((widget) => widget.side),
  );
}

function boundarySides(result: RenderResult<HTMLElement>): BoundarySide[] {
  return result.sides.map((side) => ({
    position: side.position,
    index: side.index,
    empty: side.empty,
    text: side.element.textContent ?? "",
  }));
}

function releaseCard(): void {
  for (const handle of drawHandles) handle.detach();
  drawHandles = [];
  for (const handle of inputHandles) handle.detach();
  inputHandles = [];
  mounted?.dispose();
  scope?.releaseAll();
  mounted = null;
  scope = null;
  drill = null;
  tail = [];
  cardHost.replaceChildren();
}

/**
 * Show the card at `peekOffset` from the session cursor. `0` is the card he is on.
 *
 * ─── WHY THIS REPLACED A PREVIEW LAYER ──────────────────────────────────────
 *
 * The first version of his #9 opened the neighbouring card as a PREVIEW layer, and
 * he rejected it in two words: *"you can only press it once, not what i intended"*.
 * Both halves of that were the same mistake.
 *
 * A layer swallows the keyboard — deliberately, so that space cannot grade the card
 * underneath a preview he is reading — so the second arrow press had nowhere to go.
 * And a preview is decision 30's OTHER mode: every side at once, fully revealed,
 * nothing masked. Which is exactly wrong for *"just wanna see what's next"*: it
 * hands him the answer to the card he is about to be asked.
 *
 * So stepping happens in the review view itself. The card arrives masked, in its
 * own mode, with its own audio behaviour — the card as he will meet it. What
 * changes is that the session cursor has not moved, so **nothing can be graded from
 * here**, and the screen says so rather than letting a keystroke write a review
 * against the wrong card.
 */
async function showCardAt(): Promise<void> {
  const reply = await ask<"next">({ kind: "next", offset: peekOffset });
  maxLookBehind = reply.progress.answered;
  progressLabel.textContent =
    `${reply.progress.answered}/${reply.progress.planned}` +
    (reply.progress.reasksRemaining > 0 ? ` +${reply.progress.reasksRemaining}` : "");

  // His request 4. The denominator is `planned` and NOT `planned + reasks`: a
  // decision-13 re-ask is a card he already answered, so counting it would make
  // the bar go BACKWARDS every time he forgets one. Re-asks are shown as the
  // `+2` beside the count instead, where a growing number reads correctly.
  const planned = Math.max(reply.progress.planned, 1);
  const done = Math.min(reply.progress.answered, planned);
  progressFill.style.width = `${((100 * done) / planned).toFixed(2)}%`;
  progressBar.setAttribute("aria-valuenow", String(done));
  progressBar.setAttribute("aria-valuemax", String(planned));

  if (reply.card === null) {
    // Only the real cursor can finish the session. Running off the end of a
    // look-ahead means "there is nothing further ahead", not "you are done" —
    // showing the done screen there would end a session he is mid-way through.
    if (peekOffset !== 0) {
      peekOffset = 0;
      await showCardAt();
      say("that is the end of the plan — back to your card");
      return;
    }
    releaseCard();
    reviewView.hidden = true;
    doneView.hidden = false;
    doneText.textContent =
      `${reply.progress.answered} answered · ${reply.progress.reasksQueued} shown again`;
    return;
  }

  releaseCard();
  revealed = false;
  currentCardId = reply.card.cardId;
  previewOfCurrent = reply.card;
  currentPinned = reply.pinned;
  currentArchived = reply.archived;
  paintCardOps();
  scope = new BlobUrlScope();

  const card = mountPrepared<HTMLElement>(reply.card, {
    document: browserDocument(document),
    // THE ONLY PATH TO BYTES, and it posts a message. `audioController` calls it
    // from `play()` alone, so a card merely on screen produces no payload
    // message at all — see `./protocol.ts`.
    resolve: async (address) => (await ask<"payload">({
      kind: "payload",
      cardId: reply.card!.cardId,
      address,
    })).payload,
    onOutcome: (outcome) => {
      if (outcome.kind === "playing" || outcome.kind === "replayed") return;
      // A clip that cannot be produced is worth saying out loud whenever it was the
      // QUESTION: silence there is not a missing extra, it is the card asking
      // nothing at all.
      //
      // GATED ON `mode === "identify"` UNTIL 2026-09-07, AND THAT WAS THE WRONG
      // CONDITION. Zach opened a 数字 card, got silence, and got no explanation —
      // because 数字 declares no `accent` field, so its mode is `produce` (the
      // fail-safe default), and the gate excluded it. But it HAD been asked:
      // `promptsOnEntry` has a second arm for widgets — an `<input>` means "produce
      // your answer here", so the clip is the prompt — and 89 of 90 数字 cards had no
      // clip in the shipped subset.
      //
      // So the condition is now "was a prompt actually issued", read off the loop's
      // own log rather than inferred from the mode. `asked` below computes the same
      // thing for the hint text; this is the same fact, one frame earlier.
      const asked = card.loop.log.some((event) => event.kind === "prompt");
      if (asked || card.mode.mode === "identify") {
        hintLine.textContent = `no clip for this card (${outcome.kind}) — reveal to read it`;
      }
    },
  });
  mounted = card;

  const shown = visibleSides(card.result);
  const prompt = new Set(promptPositions(card));
  tail = shown
    .filter((position) => !prompt.has(position))
    .map((position) => card.loop.side(position))
    .filter((side): side is ShadowingSide<HTMLElement> => side !== null);
  // The side the replay button plays: the first one with a clip, question side or
  // answer side. On an identify card that is the question itself.
  drill = card.loop.sides.find((side) => side.audio.length > 0) ?? null;

  // Hide what is not part of the question yet, and hide empty sides outright: a
  // mode-2 単語 card renders side 1 EMPTY (its whole body is inside
  // `<<#Reading>>`), and a blank screen to tap through is not a side.
  for (const side of card.result.sides) {
    side.element.hidden = side.empty || !prompt.has(side.position);
    if (prompt.has(side.position)) side.element.classList.add("drill");
  }

  cardHost.appendChild(card.result.root);
  // AFTER it is in the document: `attachDraw` sizes the backing store from the
  // element's laid-out box, and a detached canvas has none.
  drawHandles = makeDrawable(card.result as never);
  // Enter in the box reveals, and says whether it matched. It does NOT grade —
  // see `makeCheckable`: decision 2's binary grade is his, and a typo is not the
  // app's call to make.
  inputHandles = makeCheckable(card.result as never, (check) => {
    if (check !== null) {
      hintLine.textContent = check.ok
        ? `correct — ${check.expected}`
        : `you typed ${check.typed || "nothing"} · the card says ${check.expected}`;
    }
    if (!revealed) reveal();
  });
  deckLine.replaceChildren(document.createTextNode(reply.deckPath));
  if (reply.isNew) deckLine.appendChild(tag("new card", "newtag"));
  if (reply.reask) deckLine.appendChild(tag("again · not graded", "reasktag"));
  // His request 6, and it is not decoration. A reversed track shows the SAME card
  // with its sides permuted, so without the label a card that looks familiar and
  // reads backwards is indistinguishable from one he has genuinely forgotten.
  //
  // **5,676 cards, not the 5,357 first written here** — corrected by Zach on
  // 2026-08-23, who asked whether his 数字 deck exports in reverse. It does not
  // (90 cards, 90 forward tracks, zero reverse), and checking that turned up the
  // wrong total: 5,357 is 単語 + 漢字 alone. Only FOUR decks store `reverse: on`
  // — 単語 3,702 · 漢字 1,655 · 言葉 146 · 文法 83 — their children inherit it
  // (81 more), and 9 cards carry a per-card override. Everything else, 数字
  // included, resolves to off.
  if (reply.card.direction === "reverse") deckLine.appendChild(tag("reversed", "reversetag"));

  readingButton.hidden = card.mode.readingFieldId === null;
  readingButton.textContent = card.mode.reading ? "Reading → false" : "Reading → true";

  setState("prompt");
  // The mode-aware entry. On a produce card this plays nothing; on an identify
  // card it asks the question and leaves every cloze masked.
  for (const position of prompt) card.enter(position);

  // THE HINT DESCRIBES THE SCREEN, NOT THE CARD'S MODE, and that distinction has
  // now been a live bug TWICE.
  //
  // First: a REVERSE identify 単語 track said "listen, name the word" with nothing
  // to listen to, because the permuted order puts 意味 first and the audio sits on
  // a later side where it is the ANSWER. `promptsOnEntry` already got that right,
  // because it asks about the SIDE; the hint just had to stop claiming otherwise.
  //
  // Second, and Zach caught this one on a 数字 card: **"say the contour aloud" was
  // being said on every template outside the accent drill.** `produce` is the
  // fail-safe DEFAULT for 漢字, 敬語, New Vocab, 基本情報 and 数字 — it means "do
  // not autoplay", not "this is a pitch-accent card" — so reading the mode alone
  // put 単語's instruction on a card whose exercise is to hear a number and TYPE
  // it. There is no contour on a 数字 card.
  //
  // So the contour line is gated on `accentDrill`, which is the only thing that
  // actually means "naming a pitch pattern is the exercise here".
  const asked = card.loop.log.some((event) => event.kind === "prompt");
  const typing = card.result.widgets.some((widget) => prompt.has(
    card.result.sides.find((side) => side.index === widget.side)?.position ?? -1,
  ));
  hintLine.textContent = asked
    ? "listen, name the word, then reveal"
    : card.mode.mode === "identify"
      ? "name it, then reveal"
      : card.mode.accentDrill
        ? "say the contour aloud, then reveal"
        : typing
          ? "answer on the card, then reveal"
          : "answer, then reveal";
  shownAt = performance.now();
  paintPeek();
}

/**
 * The look-ahead banner, and the reason grading is locked while it is up.
 *
 * `answer()` grades **the session's current item**, not whatever is on screen. So a
 * grade pressed while looking ahead would write a review, move a due date and burn
 * a card — against a DIFFERENT card from the one he is reading. That is silent
 * corruption of the study history, from one keystroke, and it is the whole reason
 * this state is visible rather than subtle: the buttons go dead, they say why, and
 * one press of the other arrow comes back.
 *
 * Reveal stays live. Looking at the answer of a card he has not been asked yet is
 * exactly what he asked for, and it writes nothing.
 */
function paintPeek(): void {
  const peeking = peekOffset !== 0;
  reviewView.toggleAttribute("data-peek", peeking);
  forgotButton.disabled = peeking;
  rememberedButton.disabled = peeking;
  peekLine.hidden = !peeking;
  peekLine.textContent = peeking
    ? `${peekOffset > 0 ? "+" : ""}${peekOffset} from your card — nothing here can be graded`
    : "";
}

/**
 * Show the card the SESSION is on, clearing any look-ahead.
 *
 * Every caller outside the arrows means this: after a grade, after an undo, after
 * an operation moved the cursor, at boot. Keeping it a separate name from
 * `showCardAt` is what stops "advance the session" and "look at a neighbour" being
 * the same call — they were, and the offset survived a grade.
 */
async function showSessionCard(): Promise<void> {
  peekOffset = 0;
  await showCardAt();
}

function tag(text: string, className: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function reveal(): void {
  const card = mounted;
  if (card === null || revealed) return;
  revealed = true;

  // Show the whole card — decision 23's one scroll — and enter the sides that
  // were not part of the question.
  for (const side of tail) {
    side.element.hidden = false;
    card.loop.enter(side.position);
  }
  for (const rendered of card.result.sides) {
    if (!rendered.empty) rendered.element.hidden = false;
  }

  // EXACTLY ONE CLIP. `audioController.play()` defers extras only within a single
  // call, so unmasking three sides the obvious way starts three clips — measured
  // on 単語, whose word clip and example-sentence clip both fired. `sounding` is
  // the one that plays; every other side is unmasked silently.
  const sounding = card.loop.sides.find((side) => side.audio.length > 0) ?? null;
  for (const side of card.loop.sides) {
    if (side === sounding) continue;
    side.reveal("caller", { silent: true });
  }
  sounding?.reveal("caller");

  setState("revealed");
}

async function grade(remembered: boolean): Promise<void> {
  if (mounted === null) return;
  const durationMs = Math.round(performance.now() - shownAt);
  forgotButton.disabled = true;
  rememberedButton.disabled = true;
  try {
    const reply = await ask<"answer">({ kind: "answer", remembered, durationMs });
    if (reply.graded && reply.dueAt !== null) {
      line(
        `graded · due ${reply.dueAt.slice(0, 10)} · ${reply.writeMs.toFixed(1)} ms write · ` +
          `${reply.openStatements} open / ${reply.cachedStatements} cached statements`,
        "good",
      );
    }
    // HIS #13, and the action he named FIRST. A grade writes a `reviews` row and
    // advances the FSRS schedule, so until this existed it was the only thing in the
    // app that could not be taken back — a mis-tap moved a card's next due date by up
    // to 383 days and the undo button stayed disabled.
    //
    // The entry carries nothing: the worker owns the stack of answers, because the
    // undo needs the session's cursor and re-ask queue as well as the two rows.
    pushUndo({
      describe: `${remembered ? "remembered" : "forgot"} ${
        previewOfCurrent?.loaded.name ?? "a card"
      }`,
      run: async () => {
        const undone = await ask<"ungrade">({ kind: "ungrade" });
        say(undone.describe);
        await showSessionCard();
      },
    });
    await showSessionCard();
  } finally {
    forgotButton.disabled = false;
    rememberedButton.disabled = false;
  }
}

/** Decision 29's audit loop, without leaving the session. */
async function flipReading(): Promise<void> {
  const card = mounted;
  if (card === null || card.mode.readingFieldId === null || currentCardId === null) return;
  const value = !card.mode.reading;
  readingButton.disabled = true;
  try {
    await ask<"reading">({ kind: "reading", cardId: currentCardId, value });
    readingButton.textContent = value ? "Reading → false" : "Reading → true";
    // The change takes effect on the card's NEXT appearance, not mid-reveal:
    // re-mounting now would re-render the thing he is looking at underneath him.
    hintLine.textContent = `Reading = ${value} — takes effect next time this card comes up`;
  } finally {
    readingButton.disabled = false;
  }
}

// ─── decision 17: eviction, detected after the fact ─────────────────────────

/**
 * A RECEIPT, in `localStorage`, of the last successful open.
 *
 * `localStorage` rather than the database, obviously — a receipt inside the thing
 * that went missing proves nothing. It is also the only store the PAGE can use;
 * `localStorage` does not exist in a worker, which is why this half lives here
 * and the worker reports the file's presence instead.
 */
const RECEIPT_KEY = "hashigo.receipt.v1";

interface Receipt {
  readonly at: string;
  readonly localReviews: number;
  readonly schemaVersion: number;
}

function readReceipt(): Receipt | null {
  try {
    const raw = localStorage.getItem(RECEIPT_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<Receipt>;
    return typeof parsed.at === "string" && typeof parsed.localReviews === "number"
      ? { at: parsed.at, localReviews: parsed.localReviews, schemaVersion: parsed.schemaVersion ?? 0 }
      : null;
  } catch {
    // A corrupt receipt is not worth failing a boot over; it just means the
    // eviction check cannot answer this time, which it says rather than assumes.
    return null;
  }
}

function writeReceipt(receipt: Receipt): void {
  try {
    localStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
  } catch {
    /* a full or disabled localStorage costs the check, not the session */
  }
}

/**
 * Did the browser throw the database away since last time?
 *
 * **What this CAN detect:** OPFS had no card database, and a receipt says one was
 * there before. That is an eviction, or "clear site data", or a profile that moved
 * — indistinguishable from each other and all costing the same thing, so they get
 * the same message.
 *
 * **What it CANNOT detect, said out loud rather than implied:** a full site-data
 * clear takes the receipt with it, and then this looks exactly like a first run.
 * There is no store that survives that, so the honest fallback is the boot log —
 * a re-fetch of 72 MB is visible, and the number of local reviews is stated on
 * every successful open so the drop is noticeable even when the cause is not.
 *
 * It is the LOSS that is reported, not the event: `localReviews` is the only thing
 * in the database `exports/` cannot rebuild (decision 17), so a receipt saying 0
 * means an eviction cost nothing and does not deserve an alarm.
 */
function checkEviction(opened: {
  readonly cardsWerePresent: boolean;
  readonly localReviews: number;
  readonly schemaVersion: number;
}): void {
  const receipt = readReceipt();
  if (!opened.cardsWerePresent && receipt !== null) {
    const lost = receipt.localReviews;
    line(
      lost > 0
        ? `THE DATABASE WAS GONE. A receipt from ${receipt.at.slice(0, 16)} says it held ` +
            `${lost.toLocaleString()} local review(s). They are not recoverable from exports/ — ` +
            `restore a backup with the export you took.`
        : `The database was gone (receipt from ${receipt.at.slice(0, 16)}), but it held 0 local ` +
            `reviews, so nothing was lost — exports/ rebuilds the rest.`,
      lost > 0 ? "bad" : "info",
    );
    if (lost > 0) {
      banner.replaceChildren(
        document.createTextNode(
          `Storage was cleared since ${receipt.at.slice(0, 10)} — ${lost.toLocaleString()} ` +
            `local review(s) were lost. Restore from a backup, and keep exporting.`,
        ),
      );
      banner.hidden = false;
    }
  }
  writeReceipt({
    at: new Date().toISOString(),
    localReviews: opened.localReviews,
    schemaVersion: opened.schemaVersion,
  });
}

// ─── decision 17's banner ────────────────────────────────────────────────────

/**
 * `navigator.storage.persist` is **Window-only** — absent from
 * `StorageManager.prototype` in a worker, confirmed on Zach's own handset. So the
 * grant is asked for HERE, and the worker can only read `persisted()`.
 *
 * The banner is not dismissible, per `notes/archive/persistence.md`. What DID
 * drop in priority is the "add to home screen" prompt: persistence was granted in
 * a plain browser tab on his device. But Chromium grants it off site engagement
 * and a fresh origin starts at zero, so the banner still has to exist.
 */
async function checkPersistence(): Promise<void> {
  // An eviction message already on screen is the more important one — it names a
  // loss that HAS happened, not a risk — so this may not overwrite it. But the
  // REQUEST still has to run: an evicted boot is precisely when persistence is
  // most worth asking for, and an early return here would have skipped it. (That
  // was a live flaw in the first version of this function.)
  const evicted = !banner.hidden;
  const say = (text: string): void => {
    if (evicted) return;
    banner.textContent = text;
    banner.hidden = false;
  };

  if (navigator.storage?.persisted === undefined) {
    say("this browser cannot report storage persistence — export a backup often");
    return;
  }
  if (await navigator.storage.persisted()) {
    if (!evicted) banner.hidden = true;
    return;
  }
  const granted = (await navigator.storage.persist?.()) ?? false;
  if (granted) {
    line("storage persistence granted", "good");
    if (!evicted) banner.hidden = true;
    return;
  }
  line("storage persistence DENIED — the browser may evict this database", "bad");
  if (evicted) return;
  banner.replaceChildren(
    document.createTextNode(
      "storage is NOT persistent — the browser may evict your reviews. Export a backup: ",
    ),
  );
  const button = document.createElement("button");
  button.textContent = "export backup";
  button.addEventListener("click", () => void exportBackup());
  banner.appendChild(button);
  banner.hidden = false;
}

/**
 * Decision 17's one tap.
 *
 * A `<a download>` is deliberate rather than a share sheet: the archive is rows
 * plus stable keys (`src/backup/README.md`), and a file he can see in his own
 * downloads folder is the point.
 */
async function exportBackup(): Promise<void> {
  const reply = await ask<"backup">({ kind: "backup" });
  const url = URL.createObjectURL(new Blob([reply.json], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `hashigo-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  line(`backup ${reply.bytes.toLocaleString()} bytes · ${JSON.stringify(reply.counts)}`, "good");
}

// ─── wiring ──────────────────────────────────────────────────────────────────

revealButton.addEventListener("click", reveal);
forgotButton.addEventListener("click", () => void grade(false));
rememberedButton.addEventListener("click", () => void grade(true));
replayButton.addEventListener("click", () => {
  drill?.replay();
});
readingButton.addEventListener("click", () => void flipReading());
el("backup").addEventListener("click", () => void exportBackup());

/**
 * The two toggles say which way they go — his #6 lists "archive, pin" beside each
 * other and both are states, not actions.
 *
 * Repainted after every op rather than flipped in place: an undo, a gallery button
 * and a keystroke can all change the same row, and three writers of one label is
 * how a toggle starts lying.
 */
const pinButton = el<HTMLButtonElement>("oppin");
const archiveButton = el<HTMLButtonElement>("oparchive");

function paintCardOps(): void {
  pinButton.firstChild!.textContent = currentPinned ? "unpin" : "pin";
  pinButton.classList.toggle("on", currentPinned);
  archiveButton.firstChild!.textContent = currentArchived ? "unarchive" : "archive";
  archiveButton.classList.toggle("on", currentArchived);
}

pinButton.addEventListener("click", () => {
  if (currentCardId !== null) void runCardOp(currentPinned ? "unpin" : "pin", currentCardId);
});

/**
 * ONE DECISION, THEN ONE CALL EACH.
 *
 * The rule — which key does what, given what is on screen — moved to
 * `./review-keys.ts`, an import-free module `test/` can reach. **That file's header
 * is the reason**: this handler is where the app's two most expensive bugs lived,
 * and both were the same shape — a key correct in one state doing something
 * destructive in another, with nothing on screen to say so. Typing a deck name into
 * the gallery's filter box archived and GRADED the card behind it; grading during a
 * look-ahead moves a due date on a card he is not reading.
 *
 * Neither is visible when it happens, and both were one boolean in a long `if`
 * chain. The chain is a table now, and `test/app-keys.test.ts` enumerates it.
 *
 * What stays here is the mapping from an action to a call — and the keycap HINTS
 * stay behind `@media (hover:hover) and (pointer:fine)` in the stylesheet
 * (decision 19: never behind a hover affordance, and a phone has no hover).
 */
document.addEventListener("keydown", (event) => {
  const action = reviewAction(event, {
    // `./keys.js` owns this, over `tagName` rather than `instanceof`, so it is
    // testable in Node and survives a cross-realm element. See that file's header.
    typing: isTypingTarget(event.target as KeyTarget | null),
    layerOpen: layerHost.childElementCount > 0,
    layerActs: layers.at(-1)?.ops === true,
    sidebarOpen: document.body.classList.contains("sidebar-open"),
    reviewHidden: reviewView.hidden,
    revealed,
    peeking: peekOffset !== 0,
    hasCard: currentCardId !== null,
  });
  if (action === null) return;

  // Every action below is one the app is handling, so none of them should also do
  // whatever the browser would have done — scroll on space, quick-find on `/`.
  event.preventDefault();

  const top = layers.at(-1);
  switch (action) {
    case "palette":
      openPalette();
      return;
    case "undo":
      void runUndo();
      return;
    case "closeLayer":
      closeTop();
      return;
    case "editLayer":
      openEditor();
      return;
    case "layerPin":
      if (top !== undefined) void runCardOp(top.pinned ? "unpin" : "pin", top.cardId);
      return;
    case "layerArchive":
      if (top !== undefined) {
        void runCardOp(top.archived ? "unarchive" : "archive", top.cardId);
      }
      return;
    case "layerDelete":
      if (top !== undefined) {
        confirmDelete(top.cardId, top.prepared?.loaded.name ?? top.cardId);
      }
      return;
    case "closeSidebar":
      closeSidebar();
      return;
    case "openSidebar":
      openSidebar();
      return;
    case "edit":
      openEditor();
      return;
    case "reveal":
      reveal();
      return;
    case "archive":
      if (currentCardId !== null) {
        void runCardOp(currentArchived ? "unarchive" : "archive", currentCardId);
      }
      return;
    case "pin":
      if (currentCardId !== null) void runCardOp(currentPinned ? "unpin" : "pin", currentCardId);
      return;
    case "delete":
      if (currentCardId !== null) {
        confirmDelete(currentCardId, previewOfCurrent?.loaded.name ?? currentCardId);
      }
      return;
    case "next":
      void stepCard(1);
      return;
    case "previous":
      void stepCard(-1);
      return;
    case "backToCard":
      void showSessionCard();
      return;
    case "gradeBlocked":
      say("looking ahead — press ← or Escape to get back to your card first");
      return;
    case "gradeForgot":
      void grade(false);
      return;
    case "gradeRemembered":
      void grade(true);
      return;
    case "replay":
      drill?.replay();
      return;
  }
});

/**
 * His #9: *"use arrows (left and right) to move to next card and move back,
 * without registering any reviewing record, just wanna see what's next"*.
 *
 * It moves `peekOffset` and re-renders the review view. It does NOT move the
 * session cursor, open a layer, or write anything — see `showCardAt` for why the
 * first version's preview layer was wrong twice over, and `paintPeek` for why
 * grading is locked while the offset is not zero.
 *
 * Repeatable in both directions, which is the half he reported: nothing here
 * swallows the keyboard, so the twentieth press works like the first.
 */
async function stepCard(delta: number): Promise<void> {
  const next = peekOffset + delta;
  if (next < -maxLookBehind) {
    say("that is as far back as this session goes");
    return;
  }
  const previous = peekOffset;
  peekOffset = next;
  await showCardAt();
  if (peekOffset === previous) return; // showCardAt bounced off the end
  if (peekOffset === 0) say("back to the card you were on");
}

/**
 * How far back the arrows reach.
 *
 * `ReviewSession.peek` returns null below index 0, so the floor is the start of
 * the PLAN and not the start of the session — a card he already answered is still
 * in the plan behind the cursor, and looking back at it is exactly the "move back"
 * he asked for. `progress.answered` is that distance.
 */
let maxLookBehind = 0;

el("prevcard").addEventListener("click", () => void stepCard(-1));
el("nextcard").addEventListener("click", () => void stepCard(1));
archiveButton.addEventListener("click", () => {
  if (currentCardId !== null) {
    void runCardOp(currentArchived ? "unarchive" : "archive", currentCardId);
  }
});
el("opdelete").addEventListener("click", () => {
  if (currentCardId !== null) {
    confirmDelete(currentCardId, previewOfCurrent?.loaded.name ?? currentCardId);
  }
});
el("palettebutton").addEventListener("click", () => {
  closeSidebar();
  openPalette();
});

// A tap on a cloze reveals too — `shadowingLoop`'s `bindClozes` does that for
// free — so the screen has to follow the state it did not cause.
document.addEventListener(
  "click",
  (event) => {
    const target = event.target as HTMLElement | null;
    // NOT from inside a layer. A preview's clozes are already open, and without
    // this the click would reveal the REVIEW card sitting behind it — answering a
    // question he has not been asked yet.
    if (target?.closest(".layer") != null) return;
    if (target?.closest(`.${CLASS.cloze}`) === null || revealed) return;
    reveal();
  },
  true,
);

/**
 * `?reset=1` — destroy the OPFS copy and stop.
 *
 * A URL parameter rather than a button, and behind a `confirm()`, because it
 * destroys local grades. It is here because a SCHEMA BUMP has no other route (a
 * bump means re-import, not migrate) and because `unlink()` frees nothing — only
 * `removeVfs()` does. It is also how the eviction detector below gets tested
 * rather than assumed.
 */
async function maybeReset(): Promise<boolean> {
  if (new URLSearchParams(location.search).get("reset") !== "1") return false;
  if (
    !confirm(
      "Delete Hashigo's local database? Any grades made in this app are lost — " +
        "exports/ cannot rebuild them. Take a backup first if you have not.",
    )
  ) {
    line("reset cancelled — nothing was removed.", "info");
    return false;
  }
  const reply = await ask<"reset">({ kind: "reset" });
  line(
    `reset: removed ${reply.removed.join(", ")} · ${reply.localReviews} local grade(s) gone. ` +
      `Reload without ?reset=1 to re-import.`,
    "bad",
  );
  return true;
}


// ─── his request 2: preview layers, and they STACK ──────────────────────────

/**
 * A PREVIEW IS NOT A REVIEW — decision 30, and it decides everything here.
 *
 * > showing a preview card is not the same as put the card into a review mode,
 * > when you enter a review mode, everything goes as it is now, showing a
 * > previewed card lets you view every sides at once
 *
 * So a layer renders every side at once, fully revealed, with no masks, no
 * grading, and **nothing plays by itself**. A clip is one deliberate tap away, as
 * it always is — which is why the native `<audio>` controls, hidden in review, are
 * SHOWN in a layer: there is no reveal here to hang playback on.
 *
 * That also means a layer needs none of review's machinery. No `enter()` (which
 * would ask the mode-2 question), no drill boundary, no one-clip arbitration —
 * every side is unmasked with `{ silent: true }` and left alone.
 *
 * ─── THEY NEST, AND HIS OWN CORPUS SAYS THAT IS UNBOUNDED ───────────────────
 *
 * > when you click another link that's on the pop up modal, it opens another
 * > layer on the top, and you can keep going in mochi, and i kinda like that
 *
 * Measured before building it: 8,744 links from 4,335 cards, the deepest acyclic
 * chain is 9, and there are **23 MUTUAL pairs** — A links to B, B links back to A
 * — so the stack can grow without bound on real data. No depth cap is imposed
 * here, because the corpus does not impose one and a limit would be a decision
 * nobody has made. What IS bounded is cost: each layer owns its mount and
 * disposes it on close, so the audio controller and every object URL it minted go
 * with it (`src/blobs/url.ts` rule 1 — the scope that mints revokes).
 */
interface Layer {
  readonly root: HTMLElement;
  /** Null for a layer that renders no card — the editor, and "card not found". */
  readonly mounted: MountedCard<HTMLElement> | null;
  /** The prepared card, so `e` can edit whatever layer is on top. */
  readonly prepared: PreparedCard | null;
  readonly cardId: string;
  /**
   * Whether the single-key card operations act on this layer.
   *
   * TRUE for a preview only, and it is deliberately not derived from `cardId`. The
   * EDITOR carries a card id too, and every one of its fields is an input — so a
   * layer keyed on the id alone would archive the card he is editing the moment
   * focus sat on the panel instead of a box. A preview has nothing to type into,
   * which is exactly why the bare keys belong there and nowhere else.
   */
  readonly ops: boolean;
  /** Repainted in place by `refreshAfterOp`, for the same reason the review bar is. */
  pinned: boolean;
  archived: boolean;
}

const layerHost = el("layers");
const layers: Layer[] = [];

async function openPreview(cardId: string): Promise<void> {
  const reply = await ask<"preview">({ kind: "preview", cardId });

  const root = document.createElement("div");
  root.className = "layer";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `preview: ${reply.name}`);

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  // Tap the dim to close the TOP layer, which is this one only while it is top.
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  root.appendChild(panel);

  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  title.textContent = reply.card === null ? "card not found" : `${reply.deckPath} · preview`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close this preview");
  close.textContent = "✕";
  close.addEventListener("click", () => closeIfTop(root));
  // EVERY operation as a control, not only as a key — his standing rule, and a
  // preview is where he browses on the phone. Built empty and filled by
  // `paintLayerOps` once the state is known, so the labels cannot disagree with
  // the row (`collectionState` in the worker says why that matters).
  const ops = document.createElement("div");
  ops.className = "layer-ops";
  head.append(title, ops, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);

  if (reply.card === null) {
    // 8,958 tombstones in this corpus, so a link into a deleted card is expected.
    // Say which one, rather than showing an empty box.
    const gone = document.createElement("p");
    gone.className = "layer-missing";
    gone.textContent = `${cardId} is not in this database — it was probably deleted in Mochi.`;
    body.appendChild(gone);
    layerHost.appendChild(root);
    document.body.classList.add("layered");
    // ON THE STACK, like every other layer. It used to be appended and not pushed,
    // and `Layer.mounted` has always been documented as "null for a layer that
    // renders no card — the editor, and 'card not found'", so the type expected it
    // here and only the push was missing.
    //
    // The cost was not cosmetic: with a preview open underneath, Escape popped the
    // layer BENEATH the one on screen and left the not-found box orphaned on top.
    // `closeTop` already tolerates a null mount (`top.mounted?.dispose()`), so this
    // needs no special case anywhere.
    layers.push({
      root,
      mounted: null,
      prepared: null,
      cardId,
      ops: false,
      pinned: false,
      archived: false,
    });
    close.focus();
    return;
  }

  const mounted = mountPrepared<HTMLElement>(reply.card, {
    document: browserDocument(document),
    resolve: async (address) =>
      (await ask<"payload">({ kind: "payload", cardId: reply.card!.cardId, address })).payload,
  });

  // Every side visible, every cloze open, and SILENT — decision 30's whole shape
  // in three lines. `{ silent: true }` is what keeps it a preview rather than a
  // reveal: unmask, do not sound.
  for (const side of mounted.result.sides) side.element.hidden = side.empty;
  for (const side of mounted.loop.sides) side.reveal("caller", { silent: true });

  body.appendChild(mounted.result.root);
  layerHost.appendChild(root);
  // A preview shows every side, so 漢字's canvas is on screen there too.
  makeDrawable(mounted.result as never);
  // Checkable in a preview as well, with no reveal to trigger: decision 30 says a
  // preview is already fully revealed, so Enter marks the box and nothing more.
  makeCheckable(mounted.result as never, null);
  document.body.classList.add("layered");
  close.focus();

  const layer: Layer = {
    root,
    mounted,
    prepared: reply.card,
    cardId,
    ops: true,
    pinned: reply.pinned,
    archived: reply.archived,
  };
  layers.push(layer);
  paintLayerOps(layer, ops);
}

/**
 * Fill a preview's operation bar. Called on open and again after every op, because
 * an undo or a gallery button can flip the same row from outside this layer.
 */
function paintLayerOps(layer: Layer, host: HTMLElement): void {
  host.replaceChildren();
  const buttons: readonly (readonly [string, boolean, () => void])[] = [
    [
      layer.pinned ? "unpin" : "pin",
      layer.pinned,
      () => void runCardOp(layer.pinned ? "unpin" : "pin", layer.cardId),
    ],
    [
      layer.archived ? "unarchive" : "archive",
      layer.archived,
      () => void runCardOp(layer.archived ? "unarchive" : "archive", layer.cardId),
    ],
    ["edit", false, () => openEditor()],
    [
      "delete",
      false,
      () => confirmDelete(layer.cardId, layer.prepared?.loaded.name ?? layer.cardId),
    ],
  ];
  for (const [label, on, run] of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "layer-op";
    if (on) button.classList.add("on");
    if (label === "delete") button.classList.add("danger");
    button.textContent = label;
    button.addEventListener("click", run);
    host.appendChild(button);
  }
}

function closeIfTop(root: HTMLElement): void {
  if (layers.at(-1)?.root !== root) {
    // Not the top layer. Removing it would strand everything above it, so the
    // click does nothing — the same thing every stacked dialog does.
    return;
  }
  closeTop();
}

function closeTop(): void {
  const top = layers.pop();
  if (top === undefined) return;
  // Dispose BEFORE detaching: the mount releases its audio leases and revokes
  // every object URL it minted, and a detached tree would still be holding them.
  // Null on an editor layer, which renders no card and holds no lease.
  top.mounted?.dispose();
  top.root.remove();
  if (layerHost.childElementCount === 0) document.body.classList.remove("layered");
  const next = layers.at(-1);
  (next?.root.querySelector(".layer-close") as HTMLElement | undefined)?.focus();
}

/**
 * A card link opens a layer instead of navigating — his request 2, and the
 * navigation is the part he is rejecting: *"it doesn't navigate away"*.
 *
 * Bound in the CAPTURE phase on the document so it catches links inside review
 * AND inside any layer, which is what makes nesting fall out for free rather than
 * needing per-layer wiring.
 */
document.addEventListener(
  "click",
  (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
      `a.${CLASS.cardLink}`,
    );
    if (anchor === null || anchor === undefined) return;
    const cardId = anchor.getAttribute("data-card-id");
    if (cardId === null) return;
    event.preventDefault();
    event.stopPropagation();
    void openPreview(cardId);
  },
  true,
);

// ─── his request 3: `e` edits every field, from either mode ─────────────────

/**
 * *"whether the card is in the review mode or the pop up mode, you can press `e`
 * for edit to edit each field of the card right away"*.
 *
 * **It is another LAYER**, which is what makes "from either mode" fall out rather
 * than needing two implementations: the stack already knows what is on top, so
 * `e` edits the previewed card when a preview is open and the review card
 * otherwise. Escape peels it like any other layer.
 *
 * ─── WHY THIS IS THE SMALLEST QUARTER OF CRUD ──────────────────────────────
 *
 * `notes/crud-audit.md`: `card_field_values` is the one table the app already
 * writes end to end — the `Reading` toggle has been doing page → worker → upsert
 * since the shell existed. So this is a UI over a proven path, not a new one.
 * The worker validates anyway (`setField` there), because the field id arrives in
 * a message and a misdirected write destroys data silently.
 *
 * ─── WHAT IT DELIBERATELY WILL NOT LET HIM EDIT, AND WHY IT SAYS SO ────────
 *
 * `speech`, `translate` and `ai` fields are shown READ-ONLY with the reason on
 * screen. Measured over the whole corpus: 19 such fields, **zero non-empty
 * values**. Mochi keeps generated output in `component-cache` addressed by
 * generation identity, so the field's own value has always been empty — typing
 * into it would change nothing visible and would put text where the renderer
 * expects a marker. Greying it out without saying why is how a UI teaches
 * someone that it is broken.
 */
function editableCard(): { card: PreparedCard; onSaved: () => void } | null {
  const top = layers.at(-1);
  if (top !== undefined) {
    return top.prepared === null
      ? null
      : { card: top.prepared, onSaved: () => { /* a preview does not re-render */ } };
  }
  if (mounted === null || previewOfCurrent === null) return null;
  return { card: previewOfCurrent, onSaved: () => { /* applies on next appearance */ } };
}

/**
 * `e`, from review or from a preview.
 *
 * Goes through `openEditorById` rather than using the `PreparedCard` already in
 * hand, because the editor now needs the per-card template costs and neither `next`
 * nor `preview`'s cached copy carries them. One extra message, and it buys the
 * property that matters: `e` and the gallery's edit button open the SAME editor.
 * Passing the prepared card here and the choices there is how the two drift.
 */
function openEditor(): void {
  const target = editableCard();
  if (target === null) return;
  void openEditorById(target.card.cardId);
}

function openEditorFor(card: PreparedCard, choices: readonly TemplateChoice[] = []): void {
  const fields = card.loaded.template?.fields ?? [];

  const root = document.createElement("div");
  root.className = "layer layer-edit";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `edit ${card.loaded.name}`);

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  title.textContent = `edit · ${card.loaded.deckPath}`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close the editor");
  close.textContent = "✕";
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);
  root.appendChild(panel);

  const status = document.createElement("div");
  status.className = "edit-status";
  status.setAttribute("aria-live", "polite");

  body.appendChild(templateRow(card, choices));

  if (fields.length === 0) {
    // A card with NO template. `openEditorFor` used to `return` here, so the editor
    // simply refused to open — and the one thing he needs on such a card is the
    // template row above, which is the only way to give it one.
    const none = document.createElement("p");
    none.className = "settings-note";
    none.textContent =
      "This card has no template, so it has no fields to edit. Pick one above; its " +
      "values are still stored and will reappear for whichever fields the new " +
      "template declares.";
    body.appendChild(none);
  }

  for (const field of fields) {
    const value = card.loaded.values.get(field.id) ?? "";
    const row = document.createElement("label");
    row.className = "edit-row";

    const label = document.createElement("span");
    label.className = "edit-label";
    label.textContent = field.name;
    const type = document.createElement("i");
    type.className = "edit-type";
    type.textContent = field.type;
    label.appendChild(type);
    row.appendChild(label);

    if (!EDITABLE_FIELD_TYPES.has(field.type)) {
      const note = document.createElement("p");
      note.className = "edit-readonly";
      note.textContent =
        `generated — its content lives in the generation cache, not on the card, ` +
        `so there is nothing here to edit`;
      row.appendChild(note);
      body.appendChild(row);
      continue;
    }

    const save = (next: string): void => {
      void ask<"setField">({ kind: "setField", cardId: card.cardId, fieldId: field.id, value: next })
        .then((reply) => {
          status.textContent = `saved ${field.name}`;
          status.classList.remove("bad");
          // HIS #13. `previous` comes from the worker because the page's copy of a
          // field value is whatever it last rendered, not what is on disk. A null
          // previous means the row did not exist, and the undo REMOVES it rather
          // than writing "" — `<<#field>>` gates on presence, not on emptiness.
          pushUndo({
            describe: `edit of ${field.name} on ${card.loaded.name || card.cardId}`,
            run: async () => {
              await ask<"setField">({
                kind: "setField",
                cardId: card.cardId,
                fieldId: field.id,
                value: reply.previous,
              });
              await refreshAfterOp();
            },
          });
          // The card in front of him is NOT re-rendered. Re-mounting mid-edit
          // would move the thing he is typing into; the change applies the next
          // time the card is shown, and the status line says so.
        })
        .catch((cause: Error) => {
          status.textContent = `${field.name}: ${cause.message}`;
          status.classList.add("bad");
        });
    };

    if (field.type === "boolean") {
      // A checkbox, not a text box: `card_field_values.value` is TEXT and the
      // importer writes "true"/"false", so a free-text box would happily store
      // "maybe" and every gate in every template would read it as TRUE.
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "edit-check";
      box.checked = value.trim() !== "" && value.trim() !== "false";
      box.addEventListener("change", () => save(box.checked ? "true" : "false"));
      row.appendChild(box);
    } else {
      const area = document.createElement("textarea");
      area.className = "edit-input";
      area.value = value;
      area.rows = value.includes("\n") ? 4 : 1;
      area.spellcheck = false;
      if (field.type === "number") area.inputMode = "numeric";
      // On BLUR, not on every keystroke: a write per character would be ~1,777
      // upserts for the longest field in the corpus, and each one is an OPFS
      // write measured at 20-80 ms.
      area.addEventListener("blur", () => {
        if (area.value !== value) save(area.value);
      });
      row.appendChild(area);
      // Obsidian-style `[[` / `@` completion, and ctrl+click to follow a link into
      // its own editor. Only on the text kinds: a `number` field holds digits and a
      // `boolean` is a checkbox, so neither can contain a link.
      if (field.type === "plain" || field.type === "text") {
        attachLinkEditing(area, () => {
          if (area.value !== value) save(area.value);
        });
      }
    }
    body.appendChild(row);
  }

  body.appendChild(status);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  // `ops: false` — this is the EDITOR. See `Layer.ops`.
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: card.cardId,
    ops: false,
    pinned: false,
    archived: false,
  });
  (body.querySelector(".edit-input, .edit-check") as HTMLElement | null)?.focus();
}

/** Mirrors the worker's `EDITABLE_TYPES`. Kept in sync by the worker REFUSING. */
const EDITABLE_FIELD_TYPES = new Set(["plain", "text", "boolean", "number", "accent"]);

// ─── his request 5: the sidebar, the half that is not blocked ───────────────

/**
 * *"a side bar to navigate, which is a space where we create cards, navigate the
 * card gallery"*.
 *
 * **The browsing half is built; CREATE is not, and that is not laziness.**
 * `notes/crud-audit.md`: nothing outside the importer creates a card, and unlike
 * delete — where the schema is already complete, every foreign key at `cards`
 * being `ON DELETE CASCADE` — create is blocked on a real decision that is Zach's.
 * **What id does a card made in Hashigo get?** Mochi's are 8-character opaque
 * strings and decision 16 leaves exactly ONE more import to collide with. The
 * panel says that, by name, rather than showing a button that does nothing.
 *
 * ─── IT OPENS ON THE LEFT, WHICH IS THE ONE PLACE IT CAN GO ────────────────
 *
 * Decision 23 put the replay button bottom-RIGHT because he reviews one-handed
 * with his right thumb. A navigation drawer on the right would sit under that
 * thumb and be opened by accident mid-review, which is the worst failure a
 * navigation control can have here — it would interrupt a card he is holding an
 * answer for. Left, and reachable deliberately.
 *
 * ─── CLICKING A RESULT OPENS A PREVIEW LAYER ───────────────────────────────
 *
 * Not a navigation, and not a second card renderer: it is his request 2 reused
 * exactly. Browsing to a card and following a link to a card are the same act, so
 * they get the same surface — decision 30's preview, every side at once.
 */
const sidebarToggle = el<HTMLButtonElement>("sidebartoggle");
const deckList = el("decklist");

/**
 * THE SIDEBAR IS A TREE, AND IT NO LONGER LISTS CARDS.
 *
 * *"showing cards on the sidebar is pointless, i have like 10,000+ cards, it's
 * better to use obsidian style search"* — so the card list that shipped this
 * morning is gone. What is left is navigation: decks, nested and collapsible
 * (*"nesting deck on the side bar should be togglable"*), templates beside them
 * (*"why are templates not nesting like notion pages"*), and a way into the
 * dashboard. Finding a card is Ctrl+K's job now; SEEING a set of cards is the
 * gallery's.
 *
 * Expansion state lives in `localStorage` because a tree that forgets is a tree
 * he re-opens every session, and 39 decks is small enough that the whole map fits
 * in one key.
 */
const EXPANDED_KEY = "hashigo.sidebar.expanded";

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return new Set(raw === null ? [] : (JSON.parse(raw) as string[]));
  } catch {
    return new Set();
  }
}

function writeExpanded(open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...open]));
  } catch {
    /* a full localStorage costs the memory, not the session */
  }
}

let deckIndex: readonly DeckBrief[] = [];
let templateChoices: readonly TemplateBrief[] = [];
let decksLoaded = false;
const expanded = readExpanded();

async function loadDecks(force = false): Promise<void> {
  if (decksLoaded && !force) return;
  decksLoaded = true;
  const reply = await ask<"decks">({ kind: "decks" });
  deckIndex = reply.decks;
  templateChoices = reply.templates;
  paintTree(reply.cards);
  fillNewCardChoices(reply.decks);
}

/**
 * Adapters over `./deck-tree.js`, which owns the walk and is tested in Node.
 *
 * The recursion used to live here with no cycle guard. It did not need one — nothing
 * in `deckOp` can reparent a deck — but request 14's deck CRUD will grow a MOVE, and
 * an unguarded walk kills the page on load rather than misdrawing a total. The guard
 * and its two tests cost less than diagnosing that once.
 */
function childrenOf(parentId: string | null): readonly DeckBrief[] {
  return treeChildrenOf(deckIndex, parentId);
}

/**
 * Cards in this deck AND everything under it, which is what a parent should say.
 *
 * `truncated` is reported ONCE per session rather than discarded. A guard that
 * silently returns a wrong-but-safe number is how "the sidebar totals are a bit off"
 * becomes a week of confusion — and a cycle in the deck graph is a data bug worth
 * hearing about, not a rendering detail.
 */
function subtreeCards(deck: DeckBrief): { cards: number; due: number } {
  const totals = subtreeTotals(deckIndex, deck);
  if (totals.truncated && !cycleReported) {
    cycleReported = true;
    console.warn(`deck graph has a cycle at or under ${deck.path} — sidebar totals are a floor`);
    say(`deck "${deck.name}" is inside a cycle; its totals are a floor, not exact`, true);
  }
  return totals;
}
let cycleReported = false;

function paintTree(total: number): void {
  deckList.replaceChildren();
  const everything = navRow("everything", total, 0, 0, null, false);
  everything.addEventListener("click", () => void openGallery(null));
  deckList.appendChild(everything);
  for (const root of childrenOf(null)) deckList.appendChild(deckNode(root, 0));

  // CREATE, the letter of his #14 that had no route at all. At the root, because a
  // sub-deck is made from its parent's menu and a top-level deck has no parent to
  // hang the action off.
  const add = document.createElement("button");
  add.type = "button";
  add.className = "tree-add";
  add.textContent = "+ new top-level deck";
  add.addEventListener("click", () => {
    openPrompt("New deck", "It starts empty, at the top level, with reverse set to inherit.",
      "name", "", (name) => void runDeckOp({ op: "create", deckId: "", name, parentId: null }));
  });
  deckList.appendChild(add);

  // Templates, as their own collapsible group — his #2. They are not decks and do
  // not nest into them, but they are the other thing he navigates by.
  const group = document.createElement("div");
  group.className = "tree-group";
  const header = navRow(`templates`, templateChoices.length, 0, 0, "__templates__", true);
  group.appendChild(header);
  if (expanded.has("__templates__")) {
    for (const template of templateChoices) {
      const row = navRow(template.name, template.fields, 0, 1, null, false);
      row.classList.add("is-template");
      row.addEventListener("click", () => openTemplateEditor(template));
      group.appendChild(row);
    }
  }
  deckList.appendChild(group);
}

function deckNode(deck: DeckBrief, depth: number): HTMLElement {
  const wrap = document.createElement("div");
  const kids = childrenOf(deck.id);
  const under = subtreeCards(deck);
  const row = navRow(deck.name, under.cards, under.due, depth, kids.length > 0 ? deck.id : null, false);
  if (deck.archived) row.classList.add("is-archived");

  // A VISIBLE HANDLE, not only a right-click. Deck operations used to be reachable
  // by `contextmenu` alone, which on his phone is nothing at all — and the phone is
  // where he reviews. His standing rule is that every 操作 on the desktop exists on
  // mobile; a gesture with no mobile equivalent is the exact failure it names.
  //
  // A `<span>` rather than a `<button>`: `navRow` returns a `<button>` and a button
  // inside a button is invalid, which browsers repair by hoisting it OUT of the row.
  // The twist control is a span for the same reason.
  const more = document.createElement("span");
  more.className = "tree-more";
  more.setAttribute("role", "button");
  more.tabIndex = 0;
  more.setAttribute("aria-label", `actions for ${deck.name}`);
  more.textContent = "\u22ef";
  const openMenu = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
    openDeckMenu(deck);
  };
  more.addEventListener("click", openMenu);
  more.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") openMenu(event);
  });
  row.appendChild(more);

  row.addEventListener("click", (event) => {
    const hit = event.target as HTMLElement;
    if (hit.classList.contains("tree-twist") || hit.classList.contains("tree-more")) return;
    void openGallery(deck.id);
  });
  // Kept as an accelerator, now that it is not the only route.
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openDeckMenu(deck);
  });
  wrap.appendChild(row);
  if (kids.length > 0 && expanded.has(deck.id)) {
    for (const child of kids) wrap.appendChild(deckNode(child, depth + 1));
  }
  return wrap;
}

function navRow(
  label: string,
  count: number,
  due: number,
  depth: number,
  twistFor: string | null,
  isGroupHeader: boolean,
): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-row";
  if (isGroupHeader) row.classList.add("tree-header");
  row.style.paddingLeft = `${12 + depth * 14}px`;

  const twist = document.createElement("span");
  twist.className = "tree-twist";
  if (twistFor !== null) {
    twist.textContent = expanded.has(twistFor) ? "▾" : "▸";
    twist.addEventListener("click", (event) => {
      // His #5: TOGGLABLE. Stop the click reaching the row, or opening a deck and
      // collapsing it would be the same gesture.
      event.stopPropagation();
      if (expanded.has(twistFor)) expanded.delete(twistFor);
      else expanded.add(twistFor);
      writeExpanded(expanded);
      paintTree(deckIndex.reduce((n, d) => n + d.cards, 0));
    });
  } else {
    twist.textContent = "";
  }
  row.appendChild(twist);

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = label;
  const counts = document.createElement("span");
  counts.className = "tree-counts";
  counts.textContent = due > 0 ? `${due} · ${count}` : String(count);
  if (due > 0) counts.classList.add("has-due");
  row.append(name, counts);
  return row;
}

function openSidebar(): void {
  document.body.classList.add("sidebar-open");
  sidebarToggle.setAttribute("aria-expanded", "true");
  const host = el("newcardhost");
  if (host.childElementCount === 0) host.appendChild(buildNewCardForm());
  void loadDecks();
}

function closeSidebar(): void {
  document.body.classList.remove("sidebar-open");
  sidebarToggle.setAttribute("aria-expanded", "false");
}

sidebarToggle.addEventListener("click", () => {
  if (document.body.classList.contains("sidebar-open")) closeSidebar();
  else openSidebar();
});
el("sidebarclose").addEventListener("click", closeSidebar);
el("sidebarscrim").addEventListener("click", closeSidebar);
el("dashboardlink").addEventListener("click", () => void openDashboard());
el("settingslink").addEventListener("click", () => {
  closeSidebar();
  void openSettings();
});

// ─── his #3: Ctrl+K ─────────────────────────────────────────────────────────

/**
 * *"i want notion, obsidian like searching feature, so like ctrl +k and it pops
 * up a modal that we can search and enter"* — his second time asking.
 *
 * It is a LAYER, like everything else that goes over the card, so Escape peels it
 * and the review underneath is untouched. Arrow keys move the selection, Enter
 * opens the highlighted card as a preview.
 *
 * The query goes through `src/search`, which matters at two characters: `card_fts`
 * uses a trigram tokeniser and CANNOT serve a query shorter than three, and two
 * characters is the commonest search unit in Japanese. That module routes to a
 * ranked scan instead — 意味 returns 0 from MATCH and 3 from the scan.
 */
let paletteIndex = 0;
let paletteHits: readonly BrowseHit[] = [];
let paletteToken = 0;

function openPalette(): void {
  if (document.querySelector(".palette") !== null) return;
  const root = document.createElement("div");
  root.className = "layer palette";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "search");

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "palette-panel";
  const input = document.createElement("input");
  input.className = "palette-input";
  input.type = "search";
  input.placeholder = "search cards";
  input.autocomplete = "off";
  input.spellcheck = false;
  const list = document.createElement("div");
  list.className = "palette-list";
  const foot = document.createElement("div");
  foot.className = "palette-foot";
  panel.append(input, list, foot);
  root.appendChild(panel);

  const run = async (): Promise<void> => {
    const token = ++paletteToken;
    const reply = await ask<"browse">({
      kind: "browse",
      query: input.value,
      deckId: null,
      limit: 40,
    });
    if (token !== paletteToken) return;
    paletteHits = reply.hits;
    paletteIndex = 0;
    foot.textContent =
      reply.total === 0
        ? "nothing"
        : `${reply.hits.length} of ${reply.total.toLocaleString()}` +
          (reply.mode === null ? "" : ` · ${reply.mode} · ${reply.elapsedMs.toFixed(0)}ms`);
    paintPalette(list);
  };

  input.addEventListener("input", () => void run());
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = paletteIndex + (event.key === "ArrowDown" ? 1 : -1);
      paletteIndex = Math.max(0, Math.min(paletteHits.length - 1, next));
      paintPalette(list);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = paletteHits[paletteIndex];
      if (hit !== undefined) {
        closeIfTop(root);
        void openPreview(hit.cardId);
      }
    }
  });

  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({ root, mounted: null, prepared: null, cardId: "", ops: false, pinned: false, archived: false });
  input.focus();
  void run();
}

function paintPalette(list: HTMLElement): void {
  list.replaceChildren();
  paletteHits.forEach((hit, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "palette-row";
    if (index === paletteIndex) row.classList.add("on");
    if (hit.archived) row.classList.add("is-archived");
    const name = document.createElement("span");
    name.className = "palette-name";
    name.textContent = hit.name === "" ? hit.cardId : hit.name;
    const meta = document.createElement("span");
    meta.className = "palette-meta";
    meta.textContent = hit.archived ? `${hit.deckPath} · archived` : hit.deckPath;
    row.append(name, meta);
    row.addEventListener("click", () => {
      const top = layers.at(-1);
      if (top !== undefined) closeIfTop(top.root);
      void openPreview(hit.cardId);
    });
    list.appendChild(row);
    if (index === paletteIndex) row.scrollIntoView({ block: "nearest" });
  });
}

/**
 * The new-card form — his request 5's other half, and the last of the six.
 *
 * Three inputs and nothing more: a title, a deck, a template. It then opens the
 * EDITOR on the card it made, because a card with a title and no fields is not
 * yet a card and the next thing he wants is always to fill it in.
 *
 * **The card does not join the session already in progress.** `buildSession` ran
 * before it existed, and rebuilding mid-session would reshuffle the queue under
 * him — so the reply says which tracks were opened and the form says when it will
 * appear. It enters the NEW queue (due_at NULL, reps 0), which means decision 12's
 * ten-a-day limit applies to it like any other new card.
 */
// DECLARED ABOVE `buildNewCardForm`, not below it. `let` sits in a temporal dead
// zone until its own statement executes, and the form is built during module
// initialisation — so declaring these after the function threw
// `Cannot access 'newCardDeck' before initialization` and killed the whole
// module before `boot()` ran. The page came up blank with an empty log.
let newCardDeck: HTMLSelectElement | null = null;
let newCardTemplate: HTMLSelectElement | null = null;

function buildNewCardForm(): HTMLElement {
  const form = document.createElement("form");
  form.className = "newcard";

  const title = document.createElement("input");
  title.className = "newcard-title";
  title.type = "text";
  title.placeholder = "new card — the word";
  title.autocomplete = "off";
  title.spellcheck = false;

  const deck = document.createElement("select");
  deck.className = "newcard-select";
  deck.setAttribute("aria-label", "deck");

  const template = document.createElement("select");
  template.className = "newcard-select";
  template.setAttribute("aria-label", "template");
  const none = document.createElement("option");
  none.value = "";
  // 66 of his cards have no template at all, so this is a real option and not a
  // placeholder.
  none.textContent = "no template";
  template.appendChild(none);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "newcard-submit";
  submit.textContent = "create";

  const said = document.createElement("p");
  said.className = "newcard-said";

  form.append(title, deck, template, submit, said);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (deck.value === "") return;
    submit.disabled = true;
    void ask<"createCard">({
      kind: "createCard",
      deckId: deck.value,
      templateId: template.value === "" ? null : template.value,
      name: title.value.trim(),
    })
      .then((reply) => {
        said.classList.remove("bad");
        said.textContent =
          `made ${reply.cardId} · ${reply.tracks.join(" + ")} · ` +
          `it joins the NEW queue next session`;
        title.value = "";
        // HIS #13's "create card". Undone by deleting it — which is safe here in a
        // way `delete` generally is not: a card made seconds ago has no review
        // history to lose, which is the whole reason delete is otherwise final.
        pushUndo({
          describe: `new card ${reply.cardId}`,
          run: async () => {
            await ask<"cardOp">({ kind: "cardOp", op: "delete", cardId: reply.cardId });
            await refreshAfterOp();
          },
        });
        // Straight into the editor on the card just made: a title with no fields
        // is not yet a card, and this is always the next thing he wants.
        if (reply.card !== null) openEditorFor(reply.card);
        void loadDecks(true);
      })
      .catch((cause: Error) => {
        said.classList.add("bad");
        said.textContent = cause.message;
      })
      .finally(() => {
        submit.disabled = false;
      });
  });

  // Filled when the deck list arrives.
  newCardDeck = deck;
  newCardTemplate = template;
  return form;
}

function fillNewCardChoices(decks: readonly DeckBrief[]): void {
  if (newCardDeck !== null) {
    newCardDeck.replaceChildren();
    for (const entry of decks) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.path;
      newCardDeck.appendChild(option);
    }
  }
  if (newCardTemplate !== null) {
    const none = newCardTemplate.firstElementChild;
    newCardTemplate.replaceChildren();
    if (none !== null) newCardTemplate.appendChild(none);
    for (const entry of templateChoices) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = `${entry.name} · ${entry.fields} fields`;
      newCardTemplate.appendChild(option);
    }
  }
}

// ─── his #6: the card gallery ───────────────────────────────────────────────

/**
 * *"once you click the deck, what happens? the main screen goes to the card
 * gallery, imagine a notion gallery database view, something like that, where you
 * can filter, search, sort, click to preview, edit archive, pin, copy, duplicate,
 * delete, from there"*.
 *
 * It REPLACES the main screen rather than being another layer, because that is
 * what he described and because a gallery is somewhere you stay — layers are for
 * things you look at and dismiss. `data-view` on the body switches them, and
 * going back to review is one control.
 *
 * **The card list that was in the sidebar this morning lives here now** (his #4).
 * A list of 10,000 cards in a 330px drawer was the wrong shape; a filtered,
 * sorted, searchable grid of one deck is the right one.
 */
/**
 * TWO ORDERS, NAMED FOR WHAT THEY DO.
 *
 * This was `"name" | "due" | "created"`, and both extra members were fiction:
 * `BrowseHit` carries no due date and no created stamp, so neither could ever have
 * been sorted on, and the `<select>` offered only two options anyway — with `"due"`
 * LABELLED "relevance". The behaviour was right (fall through to the order `browse`
 * returned, which for a query IS the search ranking) and the name was a lie, which
 * is the kind of thing that reads as a bug for as long as it survives.
 *
 * Sorting by due or created is a real feature and needs the worker to send those
 * fields; it is not a line of page code away, so it is not pretended at here.
 */
type SortKey = "name" | "relevance";

interface GalleryState {
  deckId: string | null;
  query: string;
  sort: SortKey;
  includeArchived: boolean;
}

const gallery: GalleryState = { deckId: null, query: "", sort: "name", includeArchived: true };
const galleryGrid = el("gallerygrid");
const galleryTitle = el("gallerytitle");
const galleryCount = el("gallerycount");
const gallerySearch = el<HTMLInputElement>("gallerysearch");
let galleryToken = 0;

async function openGallery(deckId: string | null): Promise<void> {
  gallery.deckId = deckId;
  document.body.setAttribute("data-view", "gallery");
  closeSidebar();
  const deck = deckIndex.find((entry) => entry.id === deckId);
  galleryTitle.textContent = deck?.path ?? "everything";
  await paintGallery();
}

function closeGallery(): void {
  document.body.setAttribute("data-view", "review");
}

async function paintGallery(): Promise<void> {
  const token = ++galleryToken;
  const reply = await ask<"browse">({
    kind: "browse",
    query: gallery.query,
    deckId: gallery.deckId,
    limit: 300,
  });
  if (token !== galleryToken) return;

  let hits = [...reply.hits];
  if (!gallery.includeArchived) hits = hits.filter((hit) => !hit.archived);
  if (gallery.sort === "name") hits.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  // PINNED FIRST, IN BOTH ORDERS — including relevance, which is the one that looks
  // arguable. It is not: a pin is a statement about the collection and a ranking is a
  // statement about the query, so the pin is the outer key and the ranking decides
  // ties within each half. A stable sort keeps whatever order arrived underneath,
  // which is `name` above or the search ranking as `browse` returned it.
  hits.sort((a, b) => Number(b.pinned) - Number(a.pinned));

  galleryCount.textContent =
    hits.length < reply.total
      ? `${hits.length} of ${reply.total.toLocaleString()}`
      : `${hits.length.toLocaleString()}`;

  galleryGrid.replaceChildren();
  for (const hit of hits) galleryGrid.appendChild(galleryCard(hit));
  if (hits.length === 0) {
    const empty = document.createElement("p");
    empty.className = "gallery-empty";
    empty.textContent = gallery.query === "" ? "no cards here" : `nothing matching ${gallery.query}`;
    galleryGrid.appendChild(empty);
  }
}

function galleryCard(hit: BrowseHit): HTMLElement {
  const tile = document.createElement("article");
  tile.className = "gcard";
  if (hit.archived) tile.classList.add("is-archived");
  // Pin and archive are INDEPENDENT (see the worker's `pin` case), so a tile can
  // legitimately carry both marks and the meta line has to be able to say both.
  if (hit.pinned) tile.classList.add("is-pinned");

  const name = document.createElement("h3");
  name.className = "gcard-name";
  name.textContent = hit.name === "" ? hit.cardId : hit.name;
  const meta = document.createElement("p");
  meta.className = "gcard-meta";
  meta.textContent = [hit.deckPath, hit.pinned ? "pinned" : null, hit.archived ? "archived" : null]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
  tile.append(name, meta);
  if (hit.snippet !== null && hit.snippet !== "") {
    const snip = document.createElement("p");
    snip.className = "gcard-snippet";
    snip.textContent = hit.snippet;
    tile.appendChild(snip);
  }

  // EVERY operation as a BUTTON, not only as a shortcut. His standing rule: any
  // 操作 available on the desktop must be available on mobile, and a phone has no
  // shift+P.
  const bar = document.createElement("div");
  bar.className = "gcard-ops";
  const ops: readonly (readonly [string, () => void])[] = [
    ["preview", () => void openPreview(hit.cardId)],
    ["edit", () => void openEditorById(hit.cardId)],
    [
      hit.pinned ? "unpin" : "pin",
      () => void runCardOp(hit.pinned ? "unpin" : "pin", hit.cardId),
    ],
    [
      hit.archived ? "unarchive" : "archive",
      () => void runCardOp(hit.archived ? "unarchive" : "archive", hit.cardId),
    ],
    ["duplicate", () => void runCardOp("duplicate", hit.cardId)],
    ["delete", () => void confirmDelete(hit.cardId, hit.name)],
  ];
  for (const [label, run] of ops) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gcard-op";
    if (label === "delete") button.classList.add("danger");
    button.textContent = label;
    button.addEventListener("click", run);
    bar.appendChild(button);
  }
  tile.appendChild(bar);
  tile.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".gcard-ops") !== null) return;
    void openPreview(hit.cardId);
  });
  return tile;
}

gallerySearch.addEventListener("input", () => {
  gallery.query = gallerySearch.value;
  void paintGallery();
});
el("galleryback").addEventListener("click", closeGallery);
el<HTMLSelectElement>("gallerysort").addEventListener("change", (event) => {
  gallery.sort = (event.target as HTMLSelectElement).value as SortKey;
  void paintGallery();
});
el<HTMLInputElement>("galleryarchived").addEventListener("change", (event) => {
  gallery.includeArchived = (event.target as HTMLInputElement).checked;
  void paintGallery();
});

// ─── his #7 and #13: operations, and undo ───────────────────────────────────

/**
 * The undo stack — his #13.
 *
 * *"when you ctrl+z, it should undo your last action, whether create card, review
 * card, remember card, forget card, etc., we need button on mobile as well"*.
 *
 * **Every entry carries its own reversal, computed by the WORKER at the moment it
 * acted**, rather than being re-derived later from a description. That is the
 * difference between an undo that works and one that guesses: the worker knew the
 * card was unarchived before it archived it; nothing afterwards does.
 *
 * **Delete is deliberately NOT undoable and says so** rather than offering a
 * reversal it cannot honour — the card's reviews go with it, and a "restored" card
 * with no history would be a quiet lie.
 */
interface UndoEntry {
  readonly describe: string;
  readonly run: () => Promise<void>;
}

const undoStack: UndoEntry[] = [];
const undoButton = el<HTMLButtonElement>("opundo");

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > 50) undoStack.shift();
  paintUndo();
}

function paintUndo(): void {
  const top = undoStack.at(-1);
  undoButton.disabled = top === undefined;
  undoButton.title = top === undefined ? "nothing to undo" : `undo: ${top.describe}`;
}

/**
 * PEEK, RUN, THEN POP — and the order is the whole point.
 *
 * This used to `pop()` before awaiting `run()`, with no `catch`. Undo state lives in
 * TWO places: this stack, and the worker's stack of `AnswerResult`s that `ungrade`
 * pops. They stay in step only because each grade pushes exactly one entry to each,
 * LIFO on both sides.
 *
 * A failed `run()` broke that. The entry was already gone from here while the worker's
 * was intact, so the two were off by one — and the NEXT ctrl+Z would pop this stack's
 * previous entry while the worker popped its latest, undoing a different grade than
 * the one named on the button. Silently, because an unawaited rejection says nothing.
 *
 * Popping only on success keeps the two stacks the same length at every point where
 * anything can observe them. It also makes a failed undo retryable, which is the
 * behaviour a reader expects from a button that did not visibly do anything.
 */
async function runUndo(): Promise<void> {
  const entry = undoStack.at(-1);
  if (entry === undefined) return;
  undoButton.disabled = true;
  try {
    await entry.run();
    undoStack.pop();
    say(`undid: ${entry.describe}`);
  } catch (cause) {
    // Loud, and the entry stays. The alternative is the two stacks disagreeing
    // about what the next ctrl+Z means.
    say(`could not undo ${entry.describe}: ${(cause as Error).message}`, true);
  } finally {
    paintUndo();
  }
}

undoButton.addEventListener("click", () => void runUndo());

/** One place the app says what just happened, on every surface. */
function say(text: string, bad = false): void {
  const strip = el("say");
  strip.textContent = text;
  strip.classList.toggle("bad", bad);
  strip.hidden = false;
  window.clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => {
    strip.hidden = true;
  }, 4000);
}
let sayTimer = 0;

async function runCardOp(
  op: CardOp,
  cardId: string,
  /**
   * `setTemplate`'s target. Spread rather than defaulted, because `null` is a legal
   * value there — "no template" — and `?? null` would turn "not asked for" into it.
   */
  extra: { readonly templateId?: string | null } = {},
): Promise<void> {
  try {
    const reply = await ask<"cardOp">({ kind: "cardOp", op, cardId, ...extra });
    say(reply.describe, op === "delete");
    if (reply.undo !== null) {
      const undo = reply.undo;
      pushUndo({
        describe: reply.describe,
        run: async () => {
          await ask<"cardOp">({
            kind: "cardOp",
            op: undo.op,
            cardId: undo.cardId,
            // Same reason: `templateId: null` must survive as null and be absent
            // when the op does not use it.
            ...("templateId" in undo ? { templateId: undo.templateId } : {}),
          });
          await refreshAfterOp();
        },
      });
    }
    // The worker advances the SESSION when the op took the current card; the page has
    // to advance the SCREEN to match, or a deleted card stays visible over a session
    // that has already moved on.
    if (reply.advanced) await showSessionCard();
    await refreshAfterOp();
  } catch (cause) {
    say((cause as Error).message, true);
  }
}

/**
 * Everything that displays collection state, re-read from the database.
 *
 * Three surfaces can show the same card at once — the review bar, an open preview
 * and the gallery behind it — and any of them, plus an undo, can flip the row. So
 * after every operation the state is fetched again rather than patched: patching
 * three copies from one event is how the gallery ends up offering "pin" under a
 * tile that is already marked pinned.
 */
async function refreshAfterOp(): Promise<void> {
  await loadDecks(true);
  if (currentCardId !== null) {
    const state = await ask<"preview">({ kind: "preview", cardId: currentCardId });
    currentPinned = state.pinned;
    currentArchived = state.archived;
    paintCardOps();
  }
  for (const layer of layers) {
    if (!layer.ops) continue;
    const state = await ask<"preview">({ kind: "preview", cardId: layer.cardId });
    layer.pinned = state.pinned;
    layer.archived = state.archived;
    const host = layer.root.querySelector(".layer-ops");
    if (host instanceof HTMLElement) paintLayerOps(layer, host);
  }
  if (document.body.getAttribute("data-view") === "gallery") await paintGallery();
}

/**
 * His #7's delete, *"with warning modal ofc"* — and the warning states the cost in
 * numbers rather than asking "are you sure?", because the cost is the reviews.
 */
function confirmDelete(cardId: string, name: string): void {
  openConfirm(
    `Delete ${name === "" ? cardId : name}?`,
    "The card, its field values, its tags, its links and ALL of its review history " +
      "go with it. This is the one operation that cannot be undone.",
    "delete",
    () => void runCardOp("delete", cardId),
  );
}

/**
 * `tone` exists because this dialog stopped being only about deletion.
 *
 * It grew from one caller (delete a card) to eight, and four of them are not
 * destructive at all: building the dashboard, changing target retention, unarchiving
 * a deck, turning reverse on. A red confirm button on "build it" teaches him that red
 * means "the app wants you to read this", which is exactly the meaning it must NOT
 * have by the time he sees it on "delete 3,467 reviews".
 *
 * Default stays `danger`, so a caller that does not think about it gets the cautious
 * one.
 */
/**
 * The template row at the top of the editor — his feedback of 2026-09-07:
 * *"i should have drop down for changing card template on the spot … and there
 * should be a place that i can edit the template that belongs to that card right
 * away, and it should open another modal on top just like いつも"*.
 *
 * ─── IT IS NOT A BARE DROPDOWN, AND THE MEASUREMENT IS WHY ──────────────────
 *
 * He said *"im not saying it should be drop down, i trust your design skill"*, so:
 * each option states what the move costs THIS card. Field ids are almost entirely
 * template-private — measured across all ten templates, only four ids exist in more
 * than one (`name` everywhere, and decision 9's three local fields on 単語 + 言葉).
 * So 単語 <-> 言葉 carries four values and every other pair carries one.
 *
 * A plain `<select>` would present "move to 漢字" as equivalent to "move to 言葉"
 * when one keeps four values and the other hides six. Nothing is deleted either way
 * — `card_field_values` is deliberately not foreign-keyed to `template_fields` — but
 * "hidden" is a thing he should choose knowingly, so the count is on the option and
 * the expensive ones confirm.
 */
function templateRow(card: PreparedCard, choices: readonly TemplateChoice[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "edit-row edit-template";

  const label = document.createElement("span");
  label.className = "edit-label";
  label.textContent = "template";
  const current = choices.find((c) => c.current);
  const type = document.createElement("i");
  type.className = "edit-type";
  type.textContent = current === undefined ? "none" : `${current.fields} fields`;
  label.appendChild(type);
  row.appendChild(label);

  const bar = document.createElement("div");
  bar.className = "tpl-pick";

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "gcard-op";
  pick.textContent = current === undefined ? "choose a template" : current.name;
  pick.addEventListener("click", () => openTemplatePicker(card, choices));
  bar.appendChild(pick);

  // "Edit the template that belongs to this card", opening on top — the stack
  // already nests, so this is one call and no new machinery.
  if (current !== undefined) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "gcard-op";
    edit.textContent = `edit ${current.name}`;
    edit.title = "opens the template editor on top of this one";
    edit.addEventListener("click", () => void openTemplateEditorById(current.templateId));
    bar.appendChild(edit);
  }

  row.appendChild(bar);
  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    "Changing the template never deletes a value. Values whose field the new " +
    "template does not declare stop rendering and stay stored — field ids are " +
    "per-template, so 単語 and 言葉 share four and every other pair shares one.";
  row.appendChild(note);
  return row;
}

/** The picker, as a menu of decisions with their cost — see `templateRow`. */
function openTemplatePicker(card: PreparedCard, choices: readonly TemplateChoice[]): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm layer-menu";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = `Template for ${card.loaded.name || card.cardId}`;
  const text = document.createElement("p");
  text.textContent =
    "Nothing is deleted. The number is how many of this card's non-empty values " +
    "the new template also declares; the rest stop rendering and stay stored.";
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  for (const choice of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item";
    if (choice.current) button.classList.add("on");
    if (!choice.current && choice.hides > 0) button.classList.add("danger");
    const name = document.createElement("b");
    name.textContent = choice.current ? `${choice.name} — current` : choice.name;
    const why = document.createElement("i");
    why.textContent = choice.current
      ? `${choice.fields} fields`
      : `${choice.fields} fields · keeps ${choice.keeps}` +
        (choice.hides === 0 ? "" : `, hides ${choice.hides}`);
    button.append(name, why);
    button.addEventListener("click", () => {
      closeIfTop(root);
      if (choice.current) return;
      const move = (): void =>
        void runCardOp("setTemplate", card.cardId, { templateId: choice.templateId });
      // Only the lossy ones confirm. A move that hides nothing is not a decision
      // worth a dialog, and a dialog on every option teaches him to click through.
      if (choice.hides === 0) move();
      else {
        openConfirm(
          `Move to ${choice.name}?`,
          `${choice.hides} of this card's values are not declared by ${choice.name} ` +
            `and will stop rendering. They are NOT deleted — the values table is ` +
            `deliberately not foreign-keyed to the template, so moving back brings ` +
            `them straight back. Ctrl+Z undoes this.`,
          `move to ${choice.name}`,
          move,
        );
      }
    });
    list.appendChild(button);
  }

  panel.appendChild(list);
  root.append(backdrop, panel);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: "",
    ops: false,
    pinned: false,
    archived: false,
  });
  (list.firstElementChild as HTMLElement | null)?.focus();
}

/**
 * OBSIDIAN-STYLE LINK COMPLETION in a field, and ctrl+click to follow one.
 *
 * *"i want the auto complete when you type just like when you're in obsidian, and
 * ctrl+clicking it should open a new card on top, (the newly opened card on top
 * should be in edit mode ofc), also `@` and `[[` should both start the trigger"*.
 *
 * ─── THREE THINGS THE CORPUS DECIDED ────────────────────────────────────────
 *
 * 1. **The inserted display text is a DEFAULT, not a fixed value.** 8,210 of his
 *    8,744 links display the target's name, but 534 display an inflection pointing
 *    at a dictionary form — `[[越|4nKAg2kH]]` targets 越す. So completion seeds the
 *    name and leaves the caret ON the display text, which makes his commonest
 *    deliberate edit one keystroke instead of four.
 * 2. **`@` triggers only after whitespace.** Four field values in the whole corpus
 *    contain `@`; three are `](@media/…)` image paths. `app/links.ts` has the rule.
 * 3. **The search is the same one Ctrl+K uses.** `browse` routes through
 *    `src/search`, which is the only path that answers a two-character Japanese
 *    query — `card_fts`'s trigram tokeniser cannot serve one at all.
 *
 * ─── WHY CTRL+CLICK READS `selectionStart` ──────────────────────────────────
 *
 * A `<textarea>` has no elements in it, so there is no anchor to click and
 * `closest("a")` — how the review screen follows a link — cannot work here. What is
 * available is the caret: the browser sets it on mousedown even with a modifier
 * held, so after the click `selectionStart` is the character offset under the
 * pointer, and `linkAt(text, offset)` turns that into a card id. Pure, and tested.
 */
function attachLinkEditing(area: HTMLTextAreaElement, onSaveNeeded: () => void): void {
  let menu: HTMLElement | null = null;
  let hits: readonly BrowseHit[] = [];
  let index = 0;
  let token = 0;
  let live: Trigger | null = null;

  const close = (): void => {
    menu?.remove();
    menu = null;
    live = null;
    hits = [];
  };

  const paint = (): void => {
    if (menu === null || live === null) return;
    menu.replaceChildren();
    if (hits.length === 0) {
      const empty = document.createElement("i");
      empty.className = "link-empty";
      empty.textContent = live.query === "" ? "type to search cards" : `no card matching ${live.query}`;
      menu.appendChild(empty);
      return;
    }
    hits.forEach((hit, at) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "link-item";
      if (at === index) item.classList.add("on");
      const name = document.createElement("b");
      name.textContent = hit.name === "" ? hit.cardId : hit.name;
      const deck = document.createElement("i");
      deck.textContent = hit.deckPath;
      item.append(name, deck);
      // `mousedown`, not `click`: a click would first blur the textarea, and blur is
      // what SAVES the field — so the value would be written without the link.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(at);
      });
      menu!.appendChild(item);
      if (at === index) item.scrollIntoView({ block: "nearest" });
    });
  };

  const choose = (at: number): void => {
    const hit = hits[at];
    if (hit === undefined || live === null) return;
    const out = completeLink(area.value, live, hit.name === "" ? hit.cardId : hit.name, hit.cardId);
    area.value = out.text;
    area.setSelectionRange(out.caret, out.caret);
    close();
    area.focus();
    onSaveNeeded();
  };

  const refresh = (): void => {
    const trigger = triggerAt(area.value, area.selectionStart);
    if (trigger === null) {
      close();
      return;
    }
    live = trigger;
    if (menu === null) {
      menu = document.createElement("div");
      menu.className = "link-menu";
      area.parentElement?.appendChild(menu);
    }
    const mine = ++token;
    void ask<"browse">({ kind: "browse", query: trigger.query, deckId: null, limit: 8 }).then(
      (reply) => {
        if (mine !== token || live === null) return;
        hits = reply.hits;
        index = 0;
        paint();
      },
    );
    paint();
  };

  area.addEventListener("input", refresh);
  area.addEventListener("click", () => refresh());
  area.addEventListener("blur", () => {
    // Deferred: a mousedown on the menu fires blur first, and closing here
    // synchronously would destroy the item before its handler ran.
    setTimeout(close, 120);
  });

  area.addEventListener("keydown", (event) => {
    // CTRL+CLICK'S KEYBOARD TWIN, and the only way to follow a link without a
    // pointer. Same rule, same offset.
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      const span = linkAt(area.value, area.selectionStart);
      if (span !== null) {
        event.preventDefault();
        void openEditorById(span.target);
        return;
      }
    }
    if (menu === null || live === null) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      index = Math.max(0, Math.min(hits.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      paint();
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (hits.length === 0) return;
      event.preventDefault();
      choose(index);
    } else if (event.key === "Escape") {
      // Swallowed, so Escape dismisses the MENU rather than the whole editor —
      // otherwise abandoning a search costs him everything he was typing.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  area.addEventListener("mousedown", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    // The caret is set by this very mousedown, so the offset is only readable
    // afterwards. One tick is enough and needs no measurement of the pointer.
    setTimeout(() => {
      const span = linkAt(area.value, area.selectionStart);
      // IN EDIT MODE — he asked for that explicitly. `openEditorById` fetches the
      // card and stacks its editor on top of this one.
      if (span !== null) void openEditorById(span.target);
    }, 0);
  });
}

function openConfirm(
  title: string,
  body: string,
  verb: string,
  run: () => void,
  tone: "danger" | "normal" = "danger",
): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = body;
  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.addEventListener("click", () => closeIfTop(root));
  const go = document.createElement("button");
  go.type = "button";
  if (tone === "danger") go.className = "danger";
  go.textContent = verb;
  go.addEventListener("click", () => {
    closeIfTop(root);
    run();
  });
  bar.append(cancel, go);
  panel.append(h, p, bar);
  root.append(backdrop, panel);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({ root, mounted: null, prepared: null, cardId: "", ops: false, pinned: false, archived: false });
  cancel.focus();
}

/** Open the editor for a card the page does not already hold prepared. */
async function openEditorById(cardId: string): Promise<void> {
  const reply = await ask<"preview">({ kind: "preview", cardId });
  if (reply.card !== null) openEditorFor(reply.card, reply.templates);
}

// ─── his #11 and #1 ─────────────────────────────────────────────────────────

/**
 * *"where can i edit my template? there should be a modal for editing template and
 * fields"* — his #11.
 *
 * ─── THE ONE THING THAT MAKES THIS DIFFERENT FROM THE CARD EDITOR ───────────
 *
 * A card edit changes one card. **A template edit changes every card on it**, and
 * the count is on screen for that reason: 単語 is 3,742. So every row here states
 * its blast radius before he touches it, and the two irreversible-looking ones
 * (rename a field, delete a field) both say what happens to the text underneath.
 *
 * ─── RENAMING A FIELD REWRITES THE BODY, AND HE IS TOLD SO ──────────────────
 *
 * The resolver binds `<<Field>>` by NAME, so a rename that stopped at
 * `template_fields` would unbind every marker in silence. The worker rewrites the
 * body and every generator prompt in the same transaction; this screen shows the
 * reference COUNT beside each field so the number in "rewrote 6 reference(s)" is
 * one he could have predicted.
 *
 * ─── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 *
 * Changing a field's TYPE, and repointing a generator's source. Both reinterpret
 * every existing value at once — a migration, not a form control — and the worker
 * refuses them rather than this screen hiding them. `templateOp` says why.
 */
function openTemplateEditor(brief: TemplateBrief): void {
  void openTemplateEditorById(brief.id);
}

async function openTemplateEditorById(templateId: string): Promise<void> {
  const reply = await ask<"template">({ kind: "template", templateId });
  if (reply.template === null) {
    say(`no template ${templateId}`, true);
    return;
  }

  const root = document.createElement("div");
  root.className = "layer layer-edit layer-template";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `edit template ${reply.template.name}`);

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close the template editor");
  close.textContent = "✕";
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);
  root.appendChild(panel);

  let detail = reply.template;

  /** Run one op, then repaint from the row the worker sent back. */
  const run: TemplateRunner = async (request) => {
    try {
      const done = await ask<"templateOp">({ kind: "templateOp", ...request });
      say(done.describe);
      if (done.template !== null) {
        detail = done.template;
        paint();
      }
      if (done.undo !== null) {
        const entry = done.undo;
        pushUndo({
          describe: done.describe,
          run: async () => {
            const back = await ask<"templateOp">({ kind: "templateOp", ...entry });
            if (back.template !== null && layers.some((layer) => layer.root === root)) {
              detail = back.template;
              paint();
            }
            await refreshAfterOp();
          },
        });
      }
      await loadDecks(true);
    } catch (cause) {
      say((cause as Error).message, true);
    }
  };

  function paint(): void {
    title.textContent = `${detail.name} · ${detail.cards.toLocaleString()} card(s)`;
    body.replaceChildren();

    // ── the name ──
    const nameRow = document.createElement("div");
    nameRow.className = "edit-row";
    const nameLabel = document.createElement("span");
    nameLabel.className = "edit-label";
    nameLabel.textContent = "template name";
    const nameInput = document.createElement("input");
    nameInput.className = "edit-input";
    nameInput.type = "text";
    nameInput.value = detail.name;
    nameInput.addEventListener("change", () => {
      if (nameInput.value.trim() !== detail.name) {
        void run({ op: "rename", templateId: detail.id, name: nameInput.value.trim() });
      }
    });
    nameRow.append(nameLabel, nameInput);
    body.appendChild(nameRow);

    // ── the fields ──
    const fieldsHead = document.createElement("h3");
    fieldsHead.className = "tpl-head";
    fieldsHead.textContent = `fields (${detail.fields.length})`;
    body.appendChild(fieldsHead);

    const list = document.createElement("div");
    list.className = "tpl-fields";
    detail.fields.forEach((field, index) => {
      list.appendChild(templateFieldRow(detail, field, index, run));
    });
    body.appendChild(list);

    // ── add ──
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tree-add";
    add.textContent = "+ add a field";
    add.addEventListener("click", () => openAddField(detail, run));
    body.appendChild(add);

    // ── the body ──
    const bodyHead = document.createElement("h3");
    bodyHead.className = "tpl-head";
    bodyHead.textContent = "body";
    body.appendChild(bodyHead);

    const why = document.createElement("p");
    why.className = "settings-note";
    why.textContent =
      `This is what every one of the ${detail.cards.toLocaleString()} cards on this ` +
      `template renders. '---' starts a new side and '___' is a rule within one. ` +
      `<<Field>> interpolates, <<#Field>> and <<^Field>> gate a block on a boolean, ` +
      `{{...}} is a cloze. A name that is not a field of this template resolves to ` +
      `nothing — silently — so the check below is the one that matters.`;
    body.appendChild(why);

    const area = document.createElement("textarea");
    area.className = "edit-input tpl-body";
    area.rows = 14;
    area.spellcheck = false;
    area.value = detail.content;
    const unknown = document.createElement("p");
    unknown.className = "settings-bad";
    unknown.hidden = true;

    // AN UNRESOLVED `<<X>>` IS AN EMPTY STRING, NOT AN ERROR. So the one useful
    // check on a body is "does every name it uses exist here", and it runs while
    // he types rather than after he saves.
    const check = (): void => {
      const known = new Set(detail.fields.map((entry) => entry.name));
      const missing = [...referencedNames(area.value)].filter((name) => !known.has(name));
      unknown.hidden = missing.length === 0;
      unknown.textContent =
        `${missing.join(", ")} — not a field of ${detail.name}. Those markers will ` +
        `render as nothing, on every card.`;
    };
    area.addEventListener("input", check);
    // On BLUR, like the card editor: an OPFS write is 20-80 ms and a keystroke is
    // not a save. The template is one row, but it is a row 3,742 cards read.
    area.addEventListener("blur", () => {
      if (area.value !== detail.content) {
        void run({ op: "body", templateId: detail.id, content: area.value });
      }
    });
    check();
    body.append(area, unknown);
  }

  paint();
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: "",
    ops: false,
    pinned: false,
    archived: false,
  });
  close.focus();
}

/** What every row in the template editor is handed to write with. */
type TemplateRunner = (request: Omit<TemplateOpRequest, "kind" | "id">) => Promise<void>;

function templateFieldRow(
  detail: TemplateDetail,
  field: TemplateFieldRow,
  index: number,
  run: TemplateRunner,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "tpl-field";
  if (field.local) row.classList.add("is-local");

  const name = document.createElement("input");
  name.className = "edit-input tpl-name";
  name.type = "text";
  name.value = field.name;
  name.addEventListener("change", () => {
    if (name.value.trim() !== field.name) {
      void run({
        op: "renameField",
        templateId: detail.id,
        fieldId: field.id,
        name: name.value.trim(),
      });
    }
  });

  const facts = document.createElement("p");
  facts.className = "tpl-facts";
  facts.textContent = [
    field.type,
    field.local ? "local (decision 9 — protected from re-import)" : null,
    `${field.references} reference(s) in the body`,
    field.values === 0 ? null : `${field.values.toLocaleString()} value(s)`,
    field.dependents.length === 0 ? null : `feeds ${field.dependents.join(", ")}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  const ops = document.createElement("div");
  ops.className = "tpl-ops";
  const order = detail.fields.map((entry) => entry.id);

  const step = (delta: number): void => {
    const to = index + delta;
    if (to < 0 || to >= order.length) return;
    // `before` is the id to land in FRONT of. Moving DOWN has to land in front of
    // the field AFTER the one being passed, or the swap is a no-op.
    const before = delta < 0 ? order[to] : (order[to + 1] ?? null);
    void run({
      op: "orderFields",
      templateId: detail.id,
      order: moveWithin(order, field.id, before ?? null),
    });
  };

  const button = (label: string, title: string, on: () => void, danger = false): void => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "gcard-op";
    if (danger) element.classList.add("danger");
    element.textContent = label;
    element.title = title;
    element.addEventListener("click", on);
    ops.appendChild(element);
  };

  button("↑", "move up", () => step(-1));
  button("↓", "move down", () => step(1));
  button(
    "delete",
    field.dependents.length > 0 ? `${field.dependents.join(", ")} generate from this` : "remove it",
    () => {
      openConfirm(
        `Remove ${field.name} from ${detail.name}?`,
        (field.values === 0
          ? "No card carries a value for it. "
          : `${field.values.toLocaleString()} card(s) carry a value for it. Those ` +
            `values are NOT deleted — 'card_field_values' is deliberately not ` +
            `foreign-keyed to the field, because losing four years of authored text ` +
            `is worse than an orphan row. Undo puts the field back and the text is ` +
            `still under it. `) +
          (field.references === 0
            ? "Nothing in the body references it."
            : `The body references it ${field.references} time(s); those markers will ` +
              `render as nothing until you edit the body.`),
        "remove the field",
        () => void run({ op: "deleteField", templateId: detail.id, fieldId: field.id }),
      );
    },
    true,
  );

  row.append(name, facts, ops);
  return row;
}

function openAddField(detail: TemplateDetail, run: TemplateRunner): void {
  // Only the types a person AUTHORS. The generated ones (`speech`, `ai`,
  // `translate`, `furigana`, `dictionary`, `image-search`) need options and a source
  // that this form cannot ask for sensibly, and their VALUES are empty by design —
  // Mochi keeps generated output in `component-cache`, addressed by generation
  // identity. Offering them here would create a field that can never show anything.
  const TYPES: readonly (readonly [string, string])[] = [
    ["plain", "plain — one line of text"],
    ["text", "text — several lines"],
    ["boolean", "boolean — true/false, gates <<#Field>> blocks"],
    ["number", "number"],
    ["accent", "accent — 平板 / 頭高 / 中高 / 尾高 (decision 20's 型)"],
  ];

  const root = document.createElement("div");
  root.className = "layer layer-confirm";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = `Add a field to ${detail.name}`;
  const text = document.createElement("p");
  text.textContent =
    "It is created LOCAL (decision 9), which is what stops a re-import pruning its " +
    "values — that is the flag whose absence once threw away 3,454 型 labels. It " +
    "renders nowhere until you put <<Name>> in the body.";

  const nameRow = document.createElement("label");
  nameRow.className = "edit-row";
  const nameLabel = document.createElement("span");
  nameLabel.className = "edit-label";
  nameLabel.textContent = "name";
  const nameInput = document.createElement("input");
  nameInput.className = "edit-input";
  nameInput.type = "text";
  nameRow.append(nameLabel, nameInput);

  const typeRow = document.createElement("label");
  typeRow.className = "edit-row";
  const typeLabel = document.createElement("span");
  typeLabel.className = "edit-label";
  typeLabel.textContent = "type";
  const typeSelect = document.createElement("select");
  typeSelect.className = "edit-input";
  for (const [value, label] of TYPES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    typeSelect.appendChild(option);
  }
  typeRow.append(typeLabel, typeSelect);

  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.addEventListener("click", () => closeIfTop(root));
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "add";
  go.addEventListener("click", () => {
    const value = nameInput.value.trim();
    if (value === "") {
      nameInput.focus();
      return;
    }
    closeIfTop(root);
    void run({
      op: "addField",
      templateId: detail.id,
      name: value,
      fieldType: typeSelect.value,
    });
  });
  bar.append(cancel, go);

  panel.append(heading, text, nameRow, typeRow, bar);
  root.append(backdrop, panel);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: "",
    ops: false,
    pinned: false,
    archived: false,
  });
  nameInput.focus();
}

/**
 * His #1, and the answer to *"what about just simple dashboard in mobile app and
 * full suit dashboard on laptop?"*
 *
 * **The split is right; the axis is not device.** He reviews on the laptop too, and
 * a laptop tab runs the same sqlite-wasm in the same one worker — so the full
 * report is the same 81 seconds there. It splits by what the numbers are FOR: this
 * is "how am I doing", and the four-year analysis is a button inside it.
 *
 * Rendered in the app's own palette rather than in an iframe, which is the other
 * half of his question. The full report is a complete document with its own white
 * stylesheet and has no choice; a dozen figures do, and on a phone a white sheet
 * dropped into a dark app at night is its own answer.
 */
async function openDashboard(): Promise<void> {
  closeSidebar();
  let reply: ReplyFor["glance"];
  try {
    reply = await ask<"glance">({ kind: "glance" });
  } catch (cause) {
    say((cause as Error).message, true);
    return;
  }
  const g = reply.glance;

  const root = document.createElement("div");
  root.className = "layer layer-edit layer-glance";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "dashboard");

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  title.textContent = `dashboard · ${reply.elapsedMs.toFixed(0)} ms`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close the dashboard");
  close.textContent = "✕";
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);
  root.appendChild(panel);

  const pct = (r: number | null): string => (r === null ? "—" : `${(100 * r).toFixed(1)}%`);

  // ── today, and the streak ──
  body.appendChild(
    glanceTiles([
      ["due now", g.today.due.toLocaleString(), `${g.today.fresh} new waiting`],
      [
        "done today",
        g.today.reviews.toLocaleString(),
        g.today.reviews === 0 ? "not started" : `${pct(g.today.remembered / g.today.reviews)} kept`,
      ],
      [
        "streak",
        `${g.streakDays}`,
        // Said out loud because the number is generous on purpose — see
        // `Glance.streakDays`. A streak that reads 0 at breakfast is a number that
        // punishes him for the time of day.
        g.today.reviews === 0 && g.streakDays > 0 ? "through yesterday" : "days",
      ],
      ["live tracks", g.collection.live.toLocaleString(), `of ${g.collection.tracks.toLocaleString()}`],
    ]),
  );

  // ── the last 14 active days ──
  body.appendChild(glanceHead("the last 14 days you studied"));
  body.appendChild(
    glanceBars(
      g.recent.map((day) => ({
        label: day.date.slice(5),
        value: day.reviews,
        // Retention as the bar's TONE, not a second bar. Two bars per day on a
        // 375px screen is four pixels each.
        good: day.reviews === 0 ? null : day.remembered / day.reviews,
      })),
    ),
  );

  // ── what is coming ──
  body.appendChild(glanceHead("scheduled, next 14 days"));
  body.appendChild(
    glanceBars(
      g.forecast.map((day) => ({ label: day.date.slice(5), value: day.due, good: null })),
    ),
  );

  // ── the two windows ──
  body.appendChild(glanceHead("windows"));
  body.appendChild(
    glanceTiles([
      [
        "last 30 days",
        g.last30.reviews.toLocaleString(),
        `${pct(g.last30.retention)} · ${g.last30.activeDays} active days`,
      ],
      [
        "all time",
        g.allTime.reviews.toLocaleString(),
        `${pct(g.allTime.retention)} · ${g.allTime.firstDate ?? "—"} → ${g.allTime.lastDate ?? "—"}`,
      ],
    ]),
  );

  // ── the full report ──
  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    `The full analysis — retention by interval, by deck, by track, the heatmap, the ` +
    `long-interval outlook — is the same document \`npm run dashboard\` writes. It ` +
    `reads the whole history and SQLite runs synchronously in the one worker, so ` +
    `nothing can grade while it builds. ` +
    (dashboardLastMs === null
      ? `On a desktop it measured 81 seconds.`
      : `Last run here: ${(dashboardLastMs / 1000).toFixed(0)} seconds.`);
  const full = document.createElement("button");
  full.type = "button";
  full.className = "sidebar-action";
  full.textContent = "build the full report";
  full.addEventListener("click", () => void buildDashboard());
  body.append(glanceHead("the four-year report"), note, full);

  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: "",
    ops: false,
    pinned: false,
    archived: false,
  });
  close.focus();
}

function glanceHead(text: string): HTMLElement {
  const head = document.createElement("h3");
  head.className = "tpl-head";
  head.textContent = text;
  return head;
}

function glanceTiles(rows: readonly (readonly [string, string, string])[]): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "glance-tiles";
  for (const [label, value, note] of rows) {
    const tile = document.createElement("div");
    tile.className = "glance-tile";
    const l = document.createElement("span");
    l.className = "glance-label";
    l.textContent = label;
    const v = document.createElement("b");
    v.className = "glance-value";
    v.textContent = value;
    const n = document.createElement("i");
    n.className = "glance-note";
    n.textContent = note;
    tile.append(l, v, n);
    grid.appendChild(tile);
  }
  return grid;
}

/**
 * A bar row in CSS, with no chart library and no canvas.
 *
 * SPEC problem #1 is battery: this is the same reason the standalone dashboard
 * ships zero JavaScript. A `<div>` with a percentage height computes once at layout
 * and never again.
 */
function glanceBars(
  days: readonly { label: string; value: number; good: number | null }[],
): HTMLElement {
  const chart = document.createElement("div");
  chart.className = "glance-bars";
  const peak = Math.max(1, ...days.map((day) => day.value));
  for (const day of days) {
    const column = document.createElement("div");
    column.className = "glance-col";
    column.title = `${day.label}: ${day.value}`;
    const bar = document.createElement("i");
    bar.className = "glance-bar";
    // A zero-review day still gets a hairline, so a GAP reads as a gap rather
    // than as a day the chart forgot.
    bar.style.height = `${Math.max(2, Math.round((100 * day.value) / peak))}%`;
    if (day.good !== null && day.good < 0.85) bar.classList.add("is-low");
    const label = document.createElement("span");
    label.className = "glance-tick";
    label.textContent = day.label;
    column.append(bar, label);
    chart.appendChild(column);
  }
  return chart;
}

async function buildDashboard(): Promise<void> {
  say("building the dashboard — the database is busy until it finishes…");
  let reply: ReplyFor["dashboard"];
  try {
    reply = await ask<"dashboard">({ kind: "dashboard", locale: dashboardLocale });
  } catch (cause) {
    say((cause as Error).message, true);
    return;
  }
  dashboardLastMs = reply.elapsedMs;

  const root = document.createElement("div");
  root.className = "layer layer-dashboard";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "dashboard");

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  title.textContent =
    `dashboard · ${(reply.bytes / 1024).toFixed(0)} KB · ` +
    `${reply.elapsedMs.toFixed(0)} ms`;

  const ops = document.createElement("div");
  ops.className = "layer-ops";
  // Decision: English by default, `ja` byte-identical to a committed golden file.
  // Both are one render, so the toggle re-asks rather than translating on screen.
  const language = document.createElement("button");
  language.type = "button";
  language.className = "layer-op";
  language.textContent = dashboardLocale === "ja" ? "English" : "日本語";
  language.addEventListener("click", () => {
    dashboardLocale = dashboardLocale === "ja" ? "en" : "ja";
    closeIfTop(root);
    // Straight to the build: he has already agreed to the cost once, and asking
    // again for the same data in the other language is a question with one answer.
    void buildDashboard();
  });
  ops.appendChild(language);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close the dashboard");
  close.textContent = "✕";
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, ops, close);
  panel.appendChild(head);

  const frame = document.createElement("iframe");
  frame.className = "dashboard-frame";
  frame.setAttribute("title", "dashboard");
  // No `allow-scripts`: the document contains none, and saying so here is what
  // makes that a guarantee rather than an observation.
  frame.setAttribute("sandbox", "");
  frame.srcdoc = reply.html;
  panel.appendChild(frame);
  root.appendChild(panel);

  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: "",
    ops: false,
    pinned: false,
    archived: false,
  });
  close.focus();
  say(`dashboard: ${reply.elapsedMs.toFixed(0)} ms over the whole history`);
}

/** Remembered for the session only; the render is per open either way. */
let dashboardLocale = "en";

/**
 * What the last build actually cost HERE.
 *
 * Null until one has run, and the fallback is the desktop figure said as a desktop
 * figure. His phone wrote the corpus 1.44x faster than this machine, so quoting 81
 * seconds at him there would be wrong in the direction that reads as a warning —
 * which is the direction that stops him using something that works.
 */
let dashboardLastMs: number | null = null;

// ─── his #12: settings ──────────────────────────────────────────────────────

/**
 * *"i want to have a setting screen where i can adjust all the setting that we
 * have"*.
 *
 * **"All the settings we have" has an answer, and it is short.** It is the five
 * rows in `settings` plus the two keys `src/session/settings.ts` resolves — seven
 * — and every one of them is here. That is worth saying because the tempting
 * version of this screen invents preferences: a theme, a font size, an autoplay
 * toggle. There is no autoplay toggle, because decision 29 makes autoplay a
 * property of the CARD (`Reading`) and not of the app; putting a global switch
 * beside it would offer to break the 692 cards whose whole exercise is the silence.
 *
 * ─── EVERY CHANGE SAYS WHEN IT TAKES EFFECT, BECAUSE THEY DIFFER ────────────
 *
 * Two of these apply to the next GRADE and two to the next SESSION, and the
 * difference is not cosmetic — it decides whether he should reload:
 *
 *   `target_retention.default`   next grade. Read per card through
 *                                `deck_target_retention_resolved` at schedule time.
 *   `reverse.default`            next card built. `card_reverse_resolved` is a view.
 *   `new.limit`                  next session. `buildSession` runs once per open.
 *   `session.interleave`         next session, same reason.
 *
 * Rebuilding the session on a settings write was the alternative and it is worse:
 * it reshuffles the plan under a card he is halfway through, which is the same
 * reason `createCard` does not do it either.
 *
 * ─── AND WHAT IT SHOWS THAT IS NOT A SETTING ────────────────────────────────
 *
 * Storage, audio coverage and the versions. He would come here to check them and
 * they lived only in the boot log, which scrolls away the moment the first card
 * lands. The audio number is MEASURED here rather than quoted from the bootstrap
 * script's build-time print — see the worker's `settings`.
 */

/** One control's shape, so the rows are data rather than five copies of a form. */
interface SettingRow {
  readonly key: string;
  readonly label: string;
  readonly note: string;
  readonly when: string;
  readonly control:
    | { readonly kind: "number"; readonly min: number; readonly max: number; readonly step: number }
    | { readonly kind: "choice"; readonly options: readonly (readonly [string, string])[] }
    | { readonly kind: "text"; readonly placeholder: string };
  /** Shown before the write lands. Absent means write straight away. */
  readonly confirm?: { readonly title: string; readonly body: string };
}

const SETTING_ROWS: readonly SettingRow[] = [
  {
    key: "new.limit",
    label: "new cards per day",
    note:
      "Decision 12, and decision 15: it is 10 TRACKS a day chosen at random, not 10 " +
      "cards — forward and reverse are not paired. 0 means due cards only.",
    when: "next session",
    control: { kind: "number", min: 0, max: 500, step: 1 },
  },
  {
    key: "session.interleave",
    label: "where new cards land",
    note:
      "spread puts them evenly through the plan. due-first holds them to the end, " +
      "which means a long day never reaches them.",
    when: "next session",
    control: {
      kind: "choice",
      options: [
        ["spread", "spread through the session"],
        ["new-first", "new cards first"],
        ["due-first", "due cards first"],
      ],
    },
  },
  {
    key: "target_retention.default",
    label: "target retention",
    note:
      "Decision 1, settled by measurement: 0.90 reproduces his realised 69.2 " +
      "reviews/day, and 0.95 would be 1.9-3.0x that. Per-deck overrides still win. " +
      "The 365-day cap (decision 1) is what keeps a low value safe.",
    when: "next grade",
    control: { kind: "number", min: 0.7, max: 0.97, step: 0.01 },
    confirm: {
      title: "Change target retention?",
      body:
        "This changes the interval every future grade produces, on every deck that " +
        "does not override it. It does not touch a single existing due date — " +
        "decision 14: no one-off respread. So the corpus converges to the new " +
        "value as cards come up, over weeks, rather than moving today.",
    },
  },
  {
    key: "reverse.default",
    label: "reverse reviews, by default",
    note:
      "Only reaches decks that resolve `inherit`. Four decks store `on` explicitly " +
      "(単語 3,702 · 漢字 1,655 · 言葉 146 · 文法 83) and are unaffected either way; " +
      "日本語 itself is `inherit` with no parent, so this IS the corpus default.",
    when: "next card built",
    control: {
      kind: "choice",
      options: [
        ["off", "off — reverse is opt-in per deck"],
        ["on", "on — every inheriting deck reverses"],
      ],
    },
    confirm: {
      title: "Turn reverse on by default?",
      body:
        "Every deck resolving `inherit` gains a reverse track per card, and each " +
        "one is a new card he has never seen. No history is destroyed either way " +
        "— a track turned off goes dormant and keeps its reviews.",
    },
  },
  {
    key: "timezone.default",
    label: "timezone",
    note:
      "Decides which local date counts as today, which is the only thing that " +
      "selects the queue. IANA name, e.g. Asia/Tokyo.",
    when: "next session",
    control: { kind: "text", placeholder: "Asia/Tokyo" },
  },
  {
    key: "voice.default",
    label: "default voice",
    note:
      "EMPTY is correct and is the shipped value. Every existing clip is addressed " +
      "by the voice Mochi recorded, so a non-empty default misses all 10,791 " +
      "speech lookups at once and re-bills the corpus. Set it when regenerating " +
      "deliberately (his own deferral: after the app is finished), not before.",
    when: "next clip generated",
    control: { kind: "text", placeholder: "(empty — use the template's voice)" },
    confirm: {
      title: "Set a default voice?",
      body:
        "This is the one setting here that costs money. A non-empty value changes " +
        "the address every speech lookup resolves to, so nothing already on the " +
        "device answers and every clip is regenerated. He has said audio " +
        "regeneration happens AFTER the app is finished.",
    },
  },
];

async function openSettings(): Promise<void> {
  const reply = await ask<"settings">({ kind: "settings" });

  const root = document.createElement("div");
  root.className = "layer layer-edit layer-settings";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "settings");

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  title.textContent = "settings";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close settings");
  close.textContent = "\u2715";
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);
  root.appendChild(panel);

  const status = document.createElement("div");
  status.className = "edit-status";
  status.setAttribute("aria-live", "polite");

  // A stored value the session could not use. Loud, at the top, and naming both
  // the text and the substitute — `readSessionSettings` collects these precisely
  // so that a silently ignored setting is impossible.
  for (const bad of reply.resolved.rejected) {
    const warn = document.createElement("p");
    warn.className = "settings-bad";
    warn.textContent =
      `${bad.key} is ${JSON.stringify(bad.value)}, which is not usable — ` +
      `the session is running on the default instead. Fix or clear it below.`;
    body.appendChild(warn);
  }

  // TWO OF THESE KEYS ARE NOT SEEDED, AND A BLANK BOX WOULD LIE ABOUT THEM.
  //
  // `new.limit` and `session.interleave` are resolved rather than stored
  // (`src/session/settings.ts` says why that avoids a SCHEMA_VERSION bump), so on a
  // database he has never touched they have no row. Rendering "" would show an
  // empty new-cards box beside a state line reading "10 new/day" — the screen
  // disagreeing with itself about the same number.
  //
  // So an absent row shows the value the session WILL use, and says it is not
  // stored yet. Typing anything stores it; leaving it alone changes nothing.
  const effective: Readonly<Record<string, string>> = {
    "new.limit": String(reply.resolved.newLimit),
    "session.interleave": reply.resolved.interleave,
  };
  for (const row of SETTING_ROWS) {
    const stored = reply.values[row.key];
    body.appendChild(
      settingRow(row, stored ?? effective[row.key] ?? "", stored === undefined, status),
    );
  }

  body.appendChild(settingsState(reply));
  body.appendChild(status);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: "",
    ops: false,
    pinned: false,
    archived: false,
  });
  (body.querySelector(".edit-input") as HTMLElement | null)?.focus();
}

function settingRow(
  row: SettingRow,
  current: string,
  unstored: boolean,
  status: HTMLElement,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "edit-row";

  const label = document.createElement("span");
  label.className = "edit-label";
  label.textContent = row.label;
  const when = document.createElement("i");
  when.className = "edit-type";
  when.textContent = unstored ? `${row.when} · default, not stored` : row.when;
  label.appendChild(when);
  wrap.appendChild(label);

  let control: HTMLInputElement | HTMLSelectElement;
  if (row.control.kind === "choice") {
    const select = document.createElement("select");
    select.className = "edit-input";
    for (const [value, text] of row.control.options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }
    select.value = current;
    control = select;
  } else {
    const input = document.createElement("input");
    input.className = "edit-input";
    if (row.control.kind === "number") {
      input.type = "number";
      input.min = String(row.control.min);
      input.max = String(row.control.max);
      input.step = String(row.control.step);
      // A phone shows a number pad for this, which is the whole reason `type` is
      // set rather than validating text — his rule is desktop parity, and a
      // stepper he cannot use one-handed is not parity.
    } else {
      input.type = "text";
      input.placeholder = row.control.placeholder;
    }
    input.value = current;
    control = input;
  }

  const commit = (): void => {
    const value = control.value.trim();
    if (value === current) return;
    const write = (): void => {
      void saveSetting(row.key, value, current, status);
    };
    if (row.confirm === undefined) write();
    else openConfirm(row.confirm.title, row.confirm.body, "change it", write, "normal");
  };
  // `change`, not `input`: a number box fires `input` on every keystroke, so
  // typing "20" over "1" would write 2 and then 20 — two rows in the undo stack
  // and one of them a value he never chose.
  control.addEventListener("change", commit);
  wrap.appendChild(control);

  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent = row.note;
  wrap.appendChild(note);
  return wrap;
}

async function saveSetting(
  key: string,
  value: string,
  before: string,
  status: HTMLElement,
): Promise<void> {
  try {
    const reply = await ask<"setSetting">({ kind: "setSetting", key, value });
    status.textContent = reply.describe;
    say(reply.describe);
    // His #13's "etc.". A settings change with no way back is the one kind he would
    // have to repair by remembering what it used to be.
    pushUndo({
      describe: reply.describe,
      run: async () => {
        await ask<"setSetting">({ kind: "setSetting", key, value: reply.previous ?? before });
      },
    });
  } catch (cause) {
    status.textContent = (cause as Error).message;
    say((cause as Error).message, true);
  }
}

/** The things he would open settings to CHECK, which are not rows. */
function settingsState(reply: ReplyFor["settings"]): HTMLElement {
  const box = document.createElement("div");
  box.className = "settings-state";

  const mib = (bytes: number | null): string =>
    bytes === null ? "unknown" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const coverage =
    reply.audio.cardsWithSpeech === 0
      ? "no speech in this database"
      : `${reply.audio.cardsThatCanPlay.toLocaleString()} of ` +
        `${reply.audio.cardsWithSpeech.toLocaleString()} cards with speech can play ` +
        `(${((100 * reply.audio.cardsThatCanPlay) / reply.audio.cardsWithSpeech).toFixed(1)}%)`;

  const lines: readonly (readonly [string, string])[] = [
    [
      "storage",
      `${reply.storage.persisted ? "persistent" : "NOT persistent — evictable"} · ` +
        `${mib(reply.storage.usageBytes)} used of ${mib(reply.storage.quotaBytes)}`,
    ],
    ["audio on this device", `${coverage} · ${reply.audio.payloads.toLocaleString()} payloads`],
    ["local reviews", reply.localReviews.toLocaleString()],
    [
      "resolved plan",
      `${reply.resolved.newLimit} new/day, ${reply.resolved.interleave}`,
    ],
    ["versions", `schema v${reply.schemaVersion} · sqlite ${reply.sqliteVersion}`],
  ];
  for (const [name, text] of lines) {
    const line = document.createElement("p");
    line.className = "settings-line";
    const key = document.createElement("b");
    key.textContent = name;
    line.append(key, document.createTextNode(text));
    box.appendChild(line);
  }

  // Decision 17. The export lives in the banner too, and belongs here as well:
  // the banner only appears when persistence was refused, and a backup is
  // something he should be able to take on a day nothing is wrong.
  const backup = document.createElement("button");
  backup.type = "button";
  backup.className = "sidebar-action";
  backup.textContent = "export a backup";
  backup.addEventListener("click", () => void exportBackup());
  box.appendChild(backup);
  return box;
}

/**
 * A one-field dialog: a name, a button, Enter and Escape.
 *
 * `window.prompt()` is what this replaces and it is not usable here. It blocks the
 * event loop (so the worker's replies queue behind it), it cannot be styled, and on
 * a phone it is a system sheet that reads as the browser interrupting rather than
 * the app asking. It also cannot say WHY it is asking, and every use of this one
 * has a consequence worth a sentence.
 */
function openPrompt(
  title: string,
  body: string,
  label: string,
  initial: string,
  run: (value: string) => void,
): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = body;

  const field = document.createElement("label");
  field.className = "edit-row";
  const name = document.createElement("span");
  name.className = "edit-label";
  name.textContent = label;
  const input = document.createElement("input");
  input.className = "edit-input";
  input.type = "text";
  input.value = initial;
  field.append(name, input);

  const bar = document.createElement("div");
  bar.className = "confirm-bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.addEventListener("click", () => closeIfTop(root));
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "ok";
  const submit = (): void => {
    const value = input.value.trim();
    // An empty name is refused rather than accepted-and-defaulted: a deck called
    // "new deck" that he meant to name something is a deck he has to find again.
    if (value === "") {
      input.focus();
      return;
    }
    closeIfTop(root);
    run(value);
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  bar.append(cancel, go);
  panel.append(heading, text, field, bar);
  root.append(backdrop, panel);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: "",
    ops: false,
    pinned: false,
    archived: false,
  });
  input.focus();
  input.select();
}

/**
 * Every deck operation goes through here, so undo and the error path exist once.
 *
 * The undo is spread from `reply.undo` rather than rebuilt: `restoreArchive`
 * carries the exact card ids the archive flipped, and reconstructing the inverse
 * op instead of replaying the recorded one is the bug that un-archived 234
 * individually-archived cards on a single ctrl+Z.
 */
async function runDeckOp(request: {
  op: DeckOp;
  deckId: string;
  name?: string;
  parentId?: string | null;
}): Promise<void> {
  try {
    const reply = await ask<"deckOp">({ kind: "deckOp", ...request });
    say(reply.describe);
    if (reply.undo !== null) {
      const undo = reply.undo;
      pushUndo({
        describe: reply.describe,
        run: async () => {
          await ask<"deckOp">({
            kind: "deckOp",
            op: undo.op,
            deckId: undo.deckId,
            ...(undo.name === undefined ? {} : { name: undo.name }),
            ...(undo.parentId === undefined ? {} : { parentId: undo.parentId }),
            ...(undo.cardIds === undefined ? {} : { cardIds: undo.cardIds }),
          });
          await refreshAfterOp();
        },
      });
    }
    await refreshAfterOp();
  } catch (cause) {
    // The worker refuses a delete that would take cards and a move that would make
    // a cycle, and both messages explain themselves. Shown as-is.
    say((cause as Error).message, true);
  }
}

/**
 * His #14, in full: *"and also, we need CRUD for decks"*.
 *
 * Every operation the worker supports, each with the sentence that makes it a
 * decision rather than a button. It is a LAYER like everything else, so Escape
 * peels it and the review underneath is untouched.
 *
 * ─── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * Per-deck `reverse` and `target_retention` overrides. Both are real columns with
 * real resolution views, and both change what he is DRILLED on — the line decision
 * 31 draws around what stays his. The workspace defaults are in settings, where a
 * change is one row and obvious; a per-deck override buried in a context menu is
 * how a deck ends up scheduled differently for a reason nobody remembers.
 */
function openDeckMenu(deck: DeckBrief): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm layer-menu";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `${deck.path} actions`);
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = deck.path;
  const totals = subtreeCards(deck);
  const text = document.createElement("p");
  text.textContent =
    `${totals.cards.toLocaleString()} card(s) in this deck and everything under it` +
    (deck.cards === totals.cards ? "" : ` · ${deck.cards.toLocaleString()} directly in it`) +
    (deck.archived ? " · archived" : "");
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  const item = (label: string, note: string, run: () => void, danger = false): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item";
    if (danger) button.classList.add("danger");
    const name = document.createElement("b");
    name.textContent = label;
    const why = document.createElement("i");
    why.textContent = note;
    button.append(name, why);
    button.addEventListener("click", () => {
      closeIfTop(root);
      run();
    });
    list.appendChild(button);
  };

  item("open", "see its cards in the gallery", () => void openGallery(deck.id));

  item("rename", "the name only — nothing moves", () => {
    openPrompt("Rename deck", `Currently ${deck.path}.`, "name", deck.name, (name) =>
      void runDeckOp({ op: "rename", deckId: deck.id, name }),
    );
  });

  item("new sub-deck", "empty, inside this one", () => {
    openPrompt(
      "New sub-deck",
      `It goes inside ${deck.name} and starts empty. Reverse is 'inherit', so it ` +
        `follows whatever ${deck.name} resolves to.`,
      "name",
      "",
      (name) => void runDeckOp({ op: "create", deckId: "", name, parentId: deck.id }),
    );
  });

  item("move", "put it under another deck, or at the top", () => openDeckMove(deck));

  item(
    deck.archived ? "unarchive" : "archive",
    deck.archived
      ? "put it and its cards back in the queue"
      : "this deck AND every card under it stop being scheduled",
    () => {
      openConfirm(
        deck.path,
        `${deck.archived ? "Unarchiving" : "Archiving"} marks the deck AND every ` +
          `card in its subtree (${totals.cards.toLocaleString()}), because the review ` +
          `queue filters on the CARD — two predicates that disagree is worse than one ` +
          `that is blunt. Undo restores exactly the rows this flips, so cards you ` +
          `archived by hand keep their state. This is also the answer to your 数字 ` +
          `question: Mochi has no deck-level archive at all, so a deck you archived ` +
          `there arrived here unarchived.`,
        deck.archived ? "unarchive deck" : "archive deck",
        () => void runDeckOp({ op: deck.archived ? "unarchive" : "archive", deckId: deck.id }),
        // Undo restores exactly the rows it flipped, and no history is destroyed
        // either way — an archived track goes dormant, it does not lose its reviews.
        "normal",
      );
    },
  );

  item(
    "delete",
    "only an empty deck — the schema refuses to take cards with it",
    () => {
      openConfirm(
        `Delete ${deck.name}?`,
        totals.cards > 0
          ? `It holds ${totals.cards.toLocaleString()} card(s) in its subtree. ` +
            `\`cards.deck_id\` is ON DELETE RESTRICT, deliberately — deleting a deck ` +
            `must never silently take four years of cards with it. Move them, or ` +
            `archive the deck instead.`
          : `It is empty, so nothing goes with it. There is no undo for a deleted ` +
            `deck; making it again is one action.`,
        "delete",
        () => void runDeckOp({ op: "delete", deckId: deck.id }),
      );
    },
    true,
  );

  panel.appendChild(list);
  root.append(backdrop, panel);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: "",
    ops: false,
    pinned: false,
    archived: false,
  });
  (list.firstElementChild as HTMLElement | null)?.focus();
}

/**
 * Choose a new parent.
 *
 * The list EXCLUDES the deck and everything under it, because moving a deck into
 * its own descendant makes `deck_ancestry` — a recursive view with no depth bound —
 * loop, and every path, count and inheritance query goes through it. The worker
 * refuses it as well; this stops him getting as far as an error message.
 */
function openDeckMove(deck: DeckBrief): void {
  const under = new Set<string>();
  const walk = (id: string): void => {
    under.add(id);
    for (const child of childrenOf(id)) walk(child.id);
  };
  walk(deck.id);

  const root = document.createElement("div");
  root.className = "layer layer-confirm layer-menu";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = `Move ${deck.name}`;
  const text = document.createElement("p");
  text.textContent =
    "Its cards and sub-decks come with it. Its own sub-decks are not listed — a " +
    "deck cannot go inside itself.";
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  const choose = (label: string, parentId: string | null): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item";
    const name = document.createElement("b");
    name.textContent = label;
    button.appendChild(name);
    button.addEventListener("click", () => {
      closeIfTop(root);
      void runDeckOp({ op: "move", deckId: deck.id, parentId });
    });
    list.appendChild(button);
  };
  choose("the top level", null);
  for (const candidate of deckIndex) {
    if (under.has(candidate.id)) continue;
    if (candidate.id === deck.parentId) continue;
    choose(candidate.path, candidate.id);
  }

  panel.appendChild(list);
  root.append(backdrop, panel);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({
    root,
    mounted: null,
    prepared: null,
    cardId: "",
    ops: false,
    pinned: false,
    archived: false,
  });
  (list.firstElementChild as HTMLElement | null)?.focus();
}

async function boot(): Promise<void> {
  try {
    if (await maybeReset()) return;
    line("opening the database…", "step");
    const opened = await ask<"open">({ kind: "open", reimport: false });
    line(
      `sqlite ${opened.sqliteVersion} · schema v${opened.schemaVersion} · ` +
        `${opened.cards.toLocaleString()} cards · ${opened.reviews.toLocaleString()} reviews · ` +
        `${opened.storeRows.toLocaleString()} payloads`,
      "good",
    );
    line(
      `plan: ${opened.progress.planned} cards (${opened.progress.dueCount} due, ` +
        `${opened.progress.newCount} new) · ${opened.localReviews.toLocaleString()} local reviews`,
      "good",
    );
    // BEFORE the persistence check, so an eviction that already happened is the
    // first thing said rather than the second — and so its banner is not
    // overwritten by the "not persistent" one.
    checkEviction(opened);
    await checkPersistence();
    bootView.hidden = true;
    reviewView.hidden = false;
    await showSessionCard();
  } catch (cause) {
    line(String((cause as Error).message), "bad");
    line("nothing was written. Fix the above and reload.", "bad");
  }
}

void boot();
