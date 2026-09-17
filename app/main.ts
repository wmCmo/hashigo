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
 *     PROMPT     the first non-empty side
 *     REVEALED   every remaining side, and exactly ONE clip
 *
 * ─── THE BOUNDARY RULE, AND THE TWO THAT WERE WRONG ─────────────────────────
 *
 * **The prompt is the FIRST non-empty side.** That is the whole rule. It carried a
 * widget exception until 2026-09-14 — 漢字's `<draw>` side came up with the kanji —
 * and that exception was an agent's, never his: he had authored a `---` there on
 * purpose. `./review-boundary.ts` has the quote and the reasoning; the short version
 * is that a `---` is a side break he wrote, and code does not get to overrule it.
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
import { audioAddress } from "../src/render/audio.js";
import {
  climbFrame,
  etaLabel,
  GATE_MS,
  railX,
  readout,
  restFrame,
  rungMix,
  slotY,
  type Phase,
  type Rung,
  type Sample,
} from "./sync-climb.js";
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
import { completeLink, linkAt, linksIn, triggerAt, type Trigger } from "./links.js";
import { moveWithin } from "../src/schema/index.js";
import type { RenderResult } from "../src/render/index.js";
import type { ShadowingSide } from "../src/render/reveal.js";
// The two extracted rules. Import-free modules so `test/` can reach them; see
// `test/app-logic.test.ts` and the headers of both files.
import { childrenOf as treeChildrenOf, subtreeTotals } from "./deck-tree.js";
import { isTypingTarget, type KeyTarget } from "./keys.js";
import { clearVisits, noteVisit, readVisits } from "./visits.js";
import { mountClimb } from "./climb.js";
import { installOrigin, registerServiceWorker, watchForInstall } from "./install.js";
import {
  initialStatus,
  agoLabel,
  isStale,
  lastPushedAt,
  peersNewerThan,
  pushNow,
  sinceLabel,
  syncNow,
  type SyncStatus,
} from "./sync-client.js";
import { overdueLabel, overdueTitle } from "./overdue.js";
import { reviewAction } from "./review-keys.js";
import {
  promptPositions as promptBoundary,
  sideScale,
  visiblePositions,
  type BoundarySide,
} from "./review-boundary.js";
import { revealScroll } from "./review-scroll.js";
import { revealSteps, type RevealStep } from "./review-steps.js";
import {
  readTheme,
  themeAttribute,
  themeLabel,
  forcedChrome,
  THEMES,
  THEME_KEY,
  type Theme,
} from "./theme.js";
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
  type Playback,
  type TakeState,
} from "./shadow-controls.js";
import type {
  AnswerRefusal,
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
  if (message.kind === "fetching") {
    showFetchProgress(message);
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
const peekText = el("peektext");
const progressLabel = el("progress");
const progressBar = el("progressbar");
const progressFill = el("progressfill");
const revealButton = el<HTMLButtonElement>("reveal");
const revealWord = el("revealword");
const forgotButton = el<HTMLButtonElement>("forgot");
const rememberedButton = el<HTMLButtonElement>("remembered");
const replayButton = el<HTMLButtonElement>("replay");
const readingButton = el<HTMLButtonElement>("readingtoggle");
const banner = el("banner");
const doneView = el("done");
const doneText = el("donetext");

/* Decision 32 §5. Built once, at rest, and stepped when a session is cleared —
   `mountClimb` draws the static mark, so the done screen is never blank while it
   waits for the animation. */
const climb = mountClimb(
  document.getElementById("climbmark") as unknown as SVGSVGElement,
);

function line(text: string, level = "info"): void {
  const row = document.createElement("div");
  row.className = `logline ${level}`;
  row.textContent = text;
  bootLog.appendChild(row);
  bootLog.scrollTop = bootLog.scrollHeight;
}

/** MiB to one decimal — the only unit worth showing for a ~300 MB download. */
function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The first-run download, drawn rather than narrated.
 *
 * Zach, on 5G, 2026-09-08: *"frozen on this page for like 5 mins"*. It was not
 * frozen — it was pulling 73 MB of cards and 224 MB of audio behind a single
 * static line of text. A long operation with no visible progress is a long
 * operation the user kills, and on a phone there is no console to check.
 *
 * ONE ROW PER FILE, reused, so the log does not grow by a thousand lines. The bar
 * goes indeterminate when the server sends no `Content-Length` (a proxy may strip
 * it — `tailscale serve` is in front of this on his phone), because a made-up
 * percentage is worse than an honest "still going".
 */
const fetchRows = new Map<string, { row: HTMLElement; fill: HTMLElement; label: HTMLElement }>();


// ─── THE SEED DOWNLOAD, DRAWN — Zach's design, 2026-09-16 ────────────────────
//
// His prototype came with dials on it: presets for a fast / typical / post-rebuild
// fetch, a stall simulator, sliders for every stage. `./sync-climb.ts` holds the
// numbers and the rules; this is the half that touches the DOM.
//
// **THE CLOCK IS INDEPENDENT OF EVERYTHING ELSE.** `performance.now()` directly,
// never a value anything else scales — in one of his prototypes the climb was
// multiplied by an unrelated speed and ran 20× too fast. The animation must look
// identical on a fast and a slow connection; it is the logo breathing, not a
// progress indicator wearing a disguise.
const bootFetch = el("bootfetch");
const bootPhase = el("bootphase");
const bootBar = el("bootbar");
const bootFill = el("bootfill");
const bootGot = el("bootgot");
const bootRate = el("bootrate");
const bootEta = el("booteta");
const bootStall = el("bootstall");
const bootRungs = el("bootrungs");
const bootAccent = el("bootaccent");

const PHASE_WORDS: Readonly<Record<Phase, string>> = {
  connecting: "Connecting to your computer",
  downloading: "Downloading your cards",
  saving: "Saving to this device",
  ready: "Ready",
};

/** Per-file samples, so the rate and the stall are about THIS transfer. */
let fetchSamples: Sample[] = [];
let fetchStartedAt = 0;
let climbRaf: number | undefined;
let climbShownAt: number | null = null;

/**
 * Paint one frame of the climb into the boot mark.
 *
 * The rungs REPLACE the authored group's children, and the authored accent is
 * hidden while they do — otherwise the static vermilion rung sits on top of the
 * moving one and the beat never reads as empty.
 */
function paintClimb(rungs: readonly Rung[]): void {
  const ns = "http://www.w3.org/2000/svg";
  bootRungs.replaceChildren(
    ...rungs
      .filter((rung) => rung.s >= -0.2 && rung.s <= 4.05)
      .map((rung) => {
        const y = slotY(rung.s);
        const [x1, x2] = railX(y);
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", `M${x1.toFixed(2)} ${y.toFixed(2)}H${x2.toFixed(2)}`);
        path.setAttribute("opacity", rung.op.toFixed(3));
        path.style.setProperty("--t", rungMix(rung.s).toFixed(3));
        return path;
      }),
  );
}

/**
 * Show the screen, once the fetch has been slow enough to deserve it.
 *
 * THE GATE IS WHY MOST BOOTS SHOW NOTHING. A full-frame download UI that flashes
 * for 400 ms reads as a glitch and makes a fast boot feel slower than it was —
 * and the common case here is that every file is already in OPFS and nothing is
 * fetched at all. The draft justified the gate with "most syncs are fast"; the
 * real reason is that most boots fetch NOTHING.
 */
function startClimb(): void {
  if (climbShownAt !== null) return;
  climbShownAt = performance.now();
  bootFetch.hidden = false;
  bootAccent.setAttribute("opacity", "0");
  const quiet = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (quiet) {
    // Still, and honest about it. The byte counter is the progress indicator in
    // this mode, which is the right fallback because it was carrying the
    // information anyway.
    paintClimb(restFrame());
    return;
  }
  const tick = (now: number): void => {
    paintClimb(climbFrame(now - (climbShownAt ?? now)));
    climbRaf = requestAnimationFrame(tick);
  };
  climbRaf = requestAnimationFrame(tick);
}

/** Put the mark back the way `index.html` authored it. */
function stopClimb(): void {
  if (climbRaf !== undefined) cancelAnimationFrame(climbRaf);
  climbRaf = undefined;
  climbShownAt = null;
  paintClimb(restFrame());
  bootAccent.removeAttribute("opacity");
  bootFetch.hidden = true;
}

/** The readout, from what the worker has posted about the current file. */
function paintFetch(phase: Phase, message: Extract<AppMessage, { kind: "fetching" }>): void {
  const now = performance.now();
  const view = readout(phase, fetchSamples, message.total, now, fetchStartedAt);
  bootPhase.textContent =
    phase === "downloading"
      ? `${PHASE_WORDS[phase]} · ${message.index} of ${message.of}`
      : PHASE_WORDS[phase];
  // The bar ENCODES the phase: sweeping is indeterminate, filling is bytes.
  bootBar.classList.toggle("sweep", view.fraction === null);
  bootFill.style.width = view.fraction === null ? "" : `${(view.fraction * 100).toFixed(1)}%`;
  bootGot.textContent =
    message.total === null
      ? mib(message.received)
      : `${mib(message.received)} of ${mib(message.total)}`;
  const first = fetchSamples[0];
  const last = fetchSamples[fetchSamples.length - 1];
  const seconds = first !== undefined && last !== undefined ? (last.at - first.at) / 1000 : 0;
  bootRate.textContent = view.stalled
    ? "stalled"
    : seconds > 0.5 && last !== undefined && first !== undefined
      ? `${((last.received - first.received) / seconds / 1048576).toFixed(1)} MB/s`
      : "";
  bootEta.textContent = etaLabel(view.etaSeconds);
  bootStall.hidden = !view.stalled;
  if (view.stalled) {
    bootStall.textContent =
      "No data for a while. The transfer is still open — your computer may have gone " +
      "to sleep, or dropped off the tailnet.";
  }
}

function showFetchProgress(message: Extract<AppMessage, { kind: "fetching" }>): void {
  let entry = fetchRows.get(message.url);
  if (entry === undefined) {
    // A new file: its own samples, its own clock. The rate and the stall are
    // about THIS transfer — 9 MB of text and 643 MB of audio share nothing.
    fetchSamples = [];
    fetchStartedAt = performance.now();
    const row = document.createElement("div");
    row.className = "logline step fetchrow";
    const label = document.createElement("span");
    label.className = "fetchlabel";
    const track = document.createElement("span");
    track.className = "fetchtrack";
    const fill = document.createElement("span");
    fill.className = "fetchfill";
    track.appendChild(fill);
    row.append(label, track);
    bootLog.appendChild(row);
    bootLog.scrollTop = bootLog.scrollHeight;
    entry = { row, fill, label };
    fetchRows.set(message.url, entry);
  }

  const name = message.url.replace(/^\//, "");
  const pct = message.total === null ? null : Math.min(100, (message.received / message.total) * 100);
  entry.label.textContent =
    `${name} · ${message.index}/${message.of} · ` +
    (message.total === null
      ? mib(message.received)
      : `${mib(message.received)} of ${mib(message.total)}` +
        (pct === null ? "" : ` · ${pct.toFixed(0)}%`));
  entry.fill.style.width = pct === null ? "100%" : `${pct}%`;
  entry.row.classList.toggle("indeterminate", message.total === null && !message.done);
  entry.row.classList.toggle("good", message.done);

  // ── and the designed screen above the log ──
  fetchSamples.push({ at: performance.now(), received: message.received });
  // Bounded: a 643 MB file at ~10 posts a second is thousands of samples, and
  // the rate window only ever looks at the first and the last.
  if (fetchSamples.length > 600) fetchSamples.splice(0, fetchSamples.length - 600);
  if (performance.now() - fetchStartedAt >= GATE_MS) startClimb();
  if (climbShownAt !== null) {
    paintFetch(message.done ? "saving" : "downloading", message);
  }
}

/** One scope per card presentation: the scope that mints a URL revokes it. */
let scope: BlobUrlScope | null = null;
let mounted: MountedCard<HTMLElement> | null = null;
/**
 * The side the round replay button plays — the last one that actually SOUNDED.
 *
 * It used to be fixed at mount to "the first side with audio", which is what made
 * the example sentence unreachable: 単語 carries two clips (the word on side 2, the
 * sentence on side 3), the native `<audio>` is hidden in review, and the one
 * visible affordance was nailed to the first of them. Following the reveal answers
 * Zach's own question from 2026-09-12 — *"a single play button where we couldn't
 * distinguish which audio to play shouldn't work right?"* — without adding a
 * second control: the step says which clip is current, so the button does too.
 */
let drill: ShadowingSide<HTMLElement> | null = null;
/** His reveal order, as a plan. See `./review-steps.ts`. */
let steps: RevealStep[] = [];
let stepIndex = 0;
/**
 * Whether the clip the replay button points at is actually on this device.
 *
 * Remembered rather than recomputed because it cannot be known at mount time — the
 * resolve is async, so a missing payload only announces itself through
 * `onOutcome`, after the step that asked for it. The button follows `drill` now,
 * so it moves from clip to clip and this has to move with it.
 */
let replayState: "ready" | "missing" = "ready";
let shownAt = 0;
/**
 * The answer is on screen, so a grade is meaningful. TRUE FROM THE FIRST STEP —
 * not from the last.
 *
 * Stepping must never make grading wait: he knows whether he remembered the moment
 * the reading appears, and forcing three more presses to say so would be a worse
 * screen than the one he complained about. `moreToReveal` is the separate
 * question, and it is what `space` reads.
 */
let revealed = false;
/**
 * Whether the current card ASKED something on entry — decision 29's mode 2, or a
 * card whose side carries a widget (数字's `<input>`).
 *
 * It gates the replay button and the `r` key. `app/review-keys.ts`'s `KeyState.asked`
 * carries the reasoning: when the clip is the question, revealing in order to hear it
 * again hands over the answer.
 */
let askedOnEntry = false;
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
    if (DRAW_DEBUG) instrumentDraw(widget.element, bar);
  }
  return handles;
}

/**
 * `?drawdebug` — the same readout `app/public/draw-test.html` prints, but on the
 * REAL card rather than on a bare page of its own.
 *
 * ─── WHY THE APP NEEDS ITS OWN, WHEN A TEST PAGE ALREADY EXISTS ─────────────
 *
 * That page did its job: on his Samsung Internet, a canvas WITHOUT
 * `touch-action: none` had every stroke cancelled — `pointerdown 2,
 * pointercancel 2`, with `touchmove` still flowing at 70 while `pointermove`
 * stopped at 17 — and the two boxes that set it drew perfectly (ink 3,788 and
 * 38,142). So the mechanism is understood and `attachDraw` already sets exactly
 * that rule.
 *
 * Which means the fault is something the app does and the bare page does not,
 * and no amount of reading has found it. This prints the three facts that would
 * separate the remaining candidates, from the real screen:
 *
 *   * the COMPUTED `touch-action` — is the rule actually in force there?
 *   * the geometry — rect, backing store, ratio
 *   * live event counts, `pointercancel` among them — is the stroke being
 *     taken away, or never arriving at all?
 *
 * **The listeners are passive and only count.** A diagnostic that can change the
 * thing it measures is worse than none — and `preventDefault` from here would
 * mask the very cancel we are looking for.
 *
 * Opt-in by query string so it costs a normal review nothing, and left in the
 * codebase afterwards: this is the second defect in this widget that could only
 * be seen on his handset, and there will be a third.
 */
const DRAW_DEBUG = new URLSearchParams(location.search).has("drawdebug");

function instrumentDraw(canvas: HTMLCanvasElement, bar: HTMLElement): void {
  const readout = document.createElement("pre");
  readout.className = "draw-debug";
  bar.insertAdjacentElement("afterend", readout);

  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  const paint = (): void => {
    const rect = canvas.getBoundingClientRect();
    const seen = Object.keys(counts)
      .map((type) => `${type} ${counts[type] ?? 0}`)
      .join("  ");
    readout.textContent =
      `touch-action  ${getComputedStyle(canvas).touchAction}\n` +
      `css           ${Math.round(rect.width)} x ${Math.round(rect.height)}\n` +
      `backing       ${canvas.width} x ${canvas.height}   dpr ${devicePixelRatio}\n` +
      `strokes       ${canvas.getAttribute("data-strokes") ?? "?"}\n` +
      `events        ${seen === "" ? "none yet — draw on the canvas" : seen}`;
  };

  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "lostpointercapture",
    "touchstart",
    "touchmove",
  ]) {
    canvas.addEventListener(
      type,
      () => {
        counts[type] = (counts[type] ?? 0) + 1;
        paint();
      },
      { passive: true },
    );
  }
  paint();
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

/**
 * `data-state` on the review view, which is what `style.css` switches on.
 *
 * THREE states since Zach's stepped reveal, and the middle one is the whole
 * change: `revealing` is "part of the answer is up and there is more to come".
 * The grades are live in it — see `revealed` — and the reveal button is still
 * there, reading `next`.
 */
function setState(state: "prompt" | "revealing" | "revealed"): void {
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

/** The question: the first non-empty side. The template's `---` ends it. */
function promptPositions(card: MountedCard<HTMLElement>): number[] {
  return promptBoundary(boundarySides(card.result));
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
  // His recording belongs to the card he made it on — see `dropTake`.
  dropTake();
  for (const handle of drawHandles) handle.detach();
  drawHandles = [];
  for (const handle of inputHandles) handle.detach();
  inputHandles = [];
  mounted?.dispose();
  scope?.releaseAll();
  mounted = null;
  scope = null;
  drill = null;
  steps = [];
  stepIndex = 0;
  cardHost.replaceChildren();
  // Leaves with the card. A list left standing through the mount of the next one
  // is a list of cards linking to the card BEFORE it — and the next card's
  // prompt is exactly what it must not be sitting under.
  clearBacklinks();
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
  // THE DAY, NOT THE SESSION. `answered/planned` reset to `0/715` the moment he
  // reloaded, and he read that as a review that had not landed. `answeredToday` is
  // read from `reviews`, so a reload changes nothing it says — see `SessionProgress`
  // for why `plannedToday` is the denominator that holds the fraction steady across
  // one. Re-asks stay out of both and keep their `+2`.
  progressLabel.textContent =
    `${reply.progress.answeredToday}/${reply.progress.plannedToday}` +
    (reply.progress.reasksRemaining > 0 ? ` +${reply.progress.reasksRemaining}` : "");

  // His request 4. The denominator is today's workload and NOT that plus reasks: a
  // decision-13 re-ask is a card he already answered, so counting it would make
  // the bar go BACKWARDS every time he forgets one. Re-asks are shown as the
  // `+2` beside the count instead, where a growing number reads correctly.
  const planned = Math.max(reply.progress.plannedToday, 1);
  const done = Math.min(reply.progress.answeredToday, planned);
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
    // Today, for the same reason the counter above is: finishing the plan in two
    // sittings should say what the day came to, not what the last sitting did.
    // `shown again` stays per-session — a re-ask is a thing that happened in this
    // sitting and writes no row, so there is no day-scoped version of it to read.
    doneText.textContent =
      `${reply.progress.answeredToday} answered · ${reply.progress.reasksQueued} shown again`;
    // One rung, once, when the plan is cleared. Not awaited: the done screen is
    // already correct and the climb is feedback, not a step in the flow.
    void climb.step();
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
    // His shadowing controls. A FUNCTION, so a rate he changes mid-card reaches
    // the very next press rather than the next card — see `currentPlayback`.
    playback: currentPlayback,
    // THE ONLY PATH TO BYTES, and it posts a message. `audioController` calls it
    // from `play()` alone, so a card merely on screen produces no payload
    // message at all — see `./protocol.ts`.
    resolve: async (address) => (await ask<"payload">({
      kind: "payload",
      cardId: reply.card!.cardId,
      address,
    })).payload,
    onOutcome: (outcome) => {
      // The clip's own button, beside the line it plays. `missing` is DISABLED
      // rather than hidden, for the same reason the round button is: a control
      // that vanishes makes "not on this device" indistinguishable from "this
      // card has no clip", and a control that fails identically every press
      // reads as the app being broken.
      const button = outcome.mount.element.nextElementSibling;
      if (button instanceof HTMLButtonElement && button.classList.contains("clip")) {
        button.setAttribute("data-clip", outcome.kind);
        button.disabled = outcome.kind === "missing" || outcome.kind === "unaddressable";
        if (button.disabled) button.title = `no clip on this device for ${outcome.mount.alt}`;
        // AND OFFER TO MAKE IT. See `offerMissingClip` — a disabled button says
        // the clip is not here; it cannot say that nothing ever made it.
        if (outcome.kind === "missing") offerMissingClip(card, outcome.mount, button);
      }
      if (outcome.kind === "playing" || outcome.kind === "replayed") {
        // A clip that DID play clears a previous step's failure: the button
        // points at this one now.
        replayState = "ready";
        paintReplay(drill === null ? "none" : "ready");
        return;
      }
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
      // The button cannot know this at mount time — the resolve is async — so the
      // failure is what tells it. See `paintReplay`.
      replayState = "missing";
      paintReplay("missing");
    },
  });
  mounted = card;
  // The example sentence, the emoji line, the translations. Not awaited — see
  // the function. The card is already usable without them.
  void fillGeneratedText(card);

  const shown = visibleSides(card.result);
  const prompt = new Set(promptPositions(card));
  // His reveal order, computed once. `./review-steps.ts` owns the rule; this just
  // reduces the mounted card to the four fields it reads.
  steps = revealSteps(
    shown.map((position) => {
      const side = card.loop.side(position);
      return {
        position,
        clozes: side?.clozes.length ?? 0,
        audio: side?.audio.length ?? 0,
        prompt: prompt.has(position),
      };
    }),
  );
  stepIndex = 0;
  // Nothing has sounded yet, so there is nothing to replay yet. The entry prompt
  // below sets it when the clip IS the question; every step that sounds a side
  // sets it after that.
  drill = null;
  replayState = "ready";

  // Hide what is not part of the question yet, and hide empty sides outright: a
  // mode-2 単語 card renders side 1 EMPTY (its whole body is inside
  // `<<#Reading>>`), and a blank screen to tap through is not a side.
  for (const side of card.result.sides) {
    side.element.hidden = side.empty || !prompt.has(side.position);
    // The question, marked for anything that wants to know which side it is. It
    // no longer decides the TYPE SIZE — see `sideScale`: doing that positionally
    // is what put a six-synonym English definition at 40px on a reverse track and
    // left the kanji in body text.
    if (prompt.has(side.position)) side.element.classList.add("drill");
  }
  scaleSides(card);
  markAccentLabel(card);
  mountClipButtons(card);

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
  // HOW LATE IT IS — Zach, 2026-09-17: *"it would be helpful to see that this
  // track was due 5 days ago"*. Last in the row, because it is the only tag that
  // changes every day and the three before it are properties of the card.
  //
  // QUIET, and it must stay quiet: 827 of his 1,032 late tracks are 2-30 days
  // late, so on a catch-up session nearly every card carries one. A chip that
  // shouts on 80% of a session is a chip he stops seeing. It is also not an
  // error — decision 40's argument against red for the stall applies here with
  // more force, since being behind is the thing he is currently FIXING.
  const late = overdueLabel(reply.overdueDays);
  if (late !== null) {
    const chip = tag(late, "latetag");
    chip.title = overdueTitle(reply.overdueDays, reply.dueAt);
    deckLine.appendChild(chip);
  }

  readingButton.hidden = card.mode.readingFieldId === null;
  readingButton.textContent = card.mode.reading ? "Reading → false" : "Reading → true";

  setState("prompt");
  revealWord.textContent = "reveal";
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
  const prompted = card.loop.log.find((event) => event.kind === "prompt");
  const asked = prompted !== undefined;
  // The question sounded, so THAT is what "play it again" means until a step
  // sounds something else.
  if (prompted !== undefined) drill = prompted.side;
  // "Answer ON THE CARD" — the two templates that give him somewhere to answer are
  // 数字 (`<input>`, on the prompt side) and 漢字 (`<draw>`, one press away since the
  // boundary stopped overruling his `---`). This asks whether the CARD has a surface,
  // not whether it is on screen yet: keying it on the prompt made the hint vanish
  // from 漢字 the moment the canvas moved behind a press, on 1,662 cards whose whole
  // exercise is to draw the answer.
  const typing = card.result.widgets.length > 0;
  hintLine.textContent = asked
    ? "listen, name the word, then reveal"
    : card.mode.mode === "identify"
      ? "name it, then reveal"
      : card.mode.accentDrill
        ? "say the contour aloud, then reveal"
        : typing
          ? "answer on the card, then reveal"
          : "answer, then reveal";

  // THE REPLAY BUTTON APPEARS NOW, NOT AT THE REVEAL, when the clip was the
  // question. Zach, on a 数字 card: *"why can't i see the play button, now i can't
  // replay it even if i want to, i would have to click review first"*. He is right,
  // and the cost is not cosmetic — revealing to hear the question again shows him
  // the answer, which is the whole exercise on the 3,177 mode-2 cards.
  //
  // On a `produce` card it STAYS behind the reveal. That is decision 29 rather than
  // an oversight: there the clip is the answer, and a play button sitting on screen
  // before he has produced the contour is the defect the hard rule exists to stop.
  askedOnEntry = asked;
  reviewView.toggleAttribute("data-asked", asked);
  // A card that declares NO audio side at all: nothing to replay, ever.
  //
  // "declared but the payload is absent" is a DIFFERENT state and cannot be read
  // here: `RevealEvent.kind` is `enter | reveal | conceal | replay | prompt` and
  // carries no failure, because a missing payload is an audio OUTCOME and arrives
  // asynchronously through `onOutcome` — after this function has returned. So that
  // case is handled there, and this only covers the sides-have-no-audio case.
  paintReplay(drill === null ? "none" : "ready");

  shownAt = performance.now();
  paintPeek();
}

/**
 * The replay button's three states.
 *
 * `none` — the card declares no audio side. Hidden; there is nothing to replay.
 * `ready` — a clip is addressable. Enabled.
 * `missing` — addressable but not on this device (101 of 5,708 cards after the
 *   subset change). Shown and DISABLED with the reason, because a button that
 *   fails identically on every press reads as the app being broken, and hiding it
 *   would make a missing clip indistinguishable from a card that has none.
 */
function paintReplay(state: "none" | "ready" | "missing"): void {
  replayButton.hidden = state === "none";
  replayButton.disabled = state === "missing";
  replayButton.title =
    state === "missing" ? "no clip on this device for this card" : "play the clip again";
}

/**
 * The look-ahead banner, and which half of it is gradable.
 *
 * AHEAD grades normally. `answerAt` swaps the card he is reading into the cursor
 * first, so the screen and `plan[cursor]` cannot disagree — that is what makes a
 * live grade safe here, and the hazard it closes is the one the inline note below
 * records. BEHIND does not grade: those cards are answered, and a second review
 * row for one event is not a correction.
 *
 * Reveal stays live in both directions. Looking at the answer of a card he has not
 * been asked yet is exactly what he asked for, and it writes nothing.
 */
function paintPeek(): void {
  const peeking = peekOffset !== 0;
  reviewView.toggleAttribute("data-peek", peeking);
  // GRADING IS NO LONGER LOCKED WHILE LOOKING AHEAD — 2026-09-12. Zach: *"in
  // mochi, you can use arrows to go to next or previous cards to review them,
  // not stuck like this"*. The lock was protecting a real hazard (grading writes
  // to `plan[cursor]`, so a screen out of step with the cursor would grade the
  // wrong card) but it treated the symptom. `answerAt` fixes the cause by
  // swapping the card he is reading into the cursor before grading it, so the
  // two can no longer disagree — and the buttons can stay live.
  //
  // BACKWARD is still not gradable, because those cards are answered: a second
  // review row for one event is not a correction. The worker refuses and says so.
  const behind = peekOffset < 0;
  forgotButton.disabled = behind;
  rememberedButton.disabled = behind;
  peekLine.hidden = !peeking;
  // Only the sentence is rewritten — the button beside it is the way out and is
  // part of the markup. Reported by Zach 2026-09-12: the old banner said what
  // could NOT be done and nothing about how to leave, so a state that is one tap
  // deep read as a frozen app.
  peekText.textContent = peeking
    ? behind
      ? `${peekOffset} back — already answered, so it cannot be graded again`
      : `+${peekOffset} ahead — grade it here and it leaves the queue`
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

/**
 * ONE STEP of the reveal — Zach, 2026-09-12.
 *
 * *"when you click reveal, it shows the whole thing, the next slide, and the third
 * slide, and every cloze. the correct order should be, each cloze in that slide,
 * once every clozes are shown, the next side and so on."*
 *
 * The old body is worth keeping in mind, because two of its properties had to
 * survive and one of them was a bug:
 *
 *   * **exactly one clip per press — KEPT, and now for free.** The old code had to
 *     arbitrate (`audioController.play()` defers extras only within one call, so
 *     unmasking three sides started three clips) by nominating one side to sound
 *     and revealing the rest with `{silent:true}`. A step touches ONE side, so
 *     there is nothing to arbitrate.
 *   * **the other clips were unreachable — FIXED.** The nominated side was "the
 *     first with audio", the native `<audio>` is `display:none` in review, and the
 *     replay button was pinned to the same side. So 単語's example-sentence clip
 *     could not be played at all, on any card, by any gesture. *"i still can't
 *     hear audio of example sentence"*. Now side 3's step sounds side 3.
 */
function reveal(): void {
  const card = mounted;
  if (card === null) return;

  const step = steps[stepIndex];
  let arrived: HTMLElement | null = null;
  if (step !== undefined) {
    stepIndex += 1;
    arrived = runStep(card, step);
  }
  settleReveal(card);
  if (arrived !== null) followReveal(arrived);
}

/**
 * Perform one step: put the side on screen if this is its first, unmask, sound.
 *
 * Returns WHAT ARRIVED, for `followReveal` to bring into view. A step that puts a
 * side on screen returns the SIDE — the whole thing is new, so its top edge is
 * what he wants to find. A step that unmasks one cloze on a side already up
 * returns the CLOZE: the side has been read, and the answer that just appeared in
 * the middle of it is the only part that moved.
 */
function runStep(card: MountedCard<HTMLElement>, step: RevealStep): HTMLElement | null {
  const side = card.loop.side(step.position);
  if (side === null) return null;
  if (step.show) {
    side.element.hidden = false;
    // `loop.enter`, NOT `card.enter` — the mount's entry is the one that asks
    // decision 29's mode-2 question, and an answer side is not a question.
    card.loop.enter(step.position);
  }
  const mount = step.cloze === null ? undefined : side.clozes[step.cloze];
  if (mount !== undefined) side.revealCloze(mount, "caller");
  else side.reveal("caller");
  // `revealed` on a side means every cloze on it is shown, which is when its clip
  // sounds — so this is exactly "the clip he just heard".
  if (side.revealed && side.audio.length > 0) drill = side;
  return step.show ? side.element : (mount?.element ?? side.element);
}

/**
 * FOLLOW THE WALK DOWN THE PAGE — Zach, 2026-09-14.
 *
 * *"when review card, clicking next should scrolling the card down because it
 * overflows vertically"*. `./review-scroll.ts` owns the rule and the reasoning;
 * this is the measuring, which is the half that can only be done here.
 *
 * TWO THINGS MUST BE MEASURED RATHER THAN CONSTANTS, and both have moved before:
 * the header is sticky and carries the progress bar on its bottom edge, and
 * `--footer-h` exists precisely because the footer's height is whatever its font
 * and its labels make it (see `measureFooter`). A hand-tuned pair of offsets is
 * the defect that variable was introduced to fix.
 *
 * **THE HEADER'S HEIGHT, NOT ITS RECT** — measured, on a 漢字 card, and the
 * difference was 74 pixels. `getBoundingClientRect().bottom` is where the header
 * is SITTING, and at the top of the page it is sitting 74px down because the
 * storage-eviction banner is above it in flow. That banner scrolls away; the
 * header is `position: sticky`, so the instant the page moves it pins to 0 and
 * its bottom becomes its own height. Measuring where it is rather than where it
 * is about to be made the band 74px shorter than the one he ends up reading,
 * which pushed a `<draw>` side into the "taller than the window" arm and
 * top-aligned it 12px short of clearing the footer. The banner is in normal
 * flow, so nothing of the card is ever under it — using the height costs the
 * unscrolled case nothing.
 *
 * AFTER THE FRAME, NOT IN IT. Unmasking swaps a fixed-width mask for the answer
 * and the last step unhides whole sides, so measuring synchronously measures the
 * layout the press replaced — the rect would be the OLD one and the scroll would
 * land short by exactly the amount the answer grew.
 */
function followReveal(target: HTMLElement): void {
  requestAnimationFrame(() => {
    const header = document.querySelector<HTMLElement>(".review header");
    const rect = target.getBoundingClientRect();
    const by = revealScroll({
      top: header === null ? 0 : header.offsetHeight,
      bottom: window.innerHeight - footer.offsetHeight,
      elementTop: rect.top,
      elementBottom: rect.bottom,
      // One line of body text. Enough that the revealed edge does not sit flush
      // against the reveal button, which reads as clipped rather than as complete.
      gap: 16,
    });
    if (by === 0) return;
    window.scrollBy({
      top: by,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  });
}

/**
 * Bring the screen into line with how far the reveal has got.
 *
 * Called after a press AND after a tap on a cloze, because the loop reveals that
 * cloze itself (`bindClozes`) and the plan has to notice rather than replay it —
 * without this, a tapped cloze would be revealed once by the loop and then the
 * next press would spend a step re-revealing it.
 */
function settleReveal(card: MountedCard<HTMLElement>): void {
  while (stepIndex < steps.length && stepDone(card, steps[stepIndex]!)) stepIndex += 1;
  if (stepIndex > 0) revealed = true;

  if (stepIndex >= steps.length) {
    revealed = true;
    // Decision 23's one scroll, at the end of the walk. Anything the plan did not
    // cover — a side with no clozes and no clip, which earns no step — is
    // unmasked here, silently.
    for (const rendered of card.result.sides) {
      if (!rendered.empty) rendered.element.hidden = false;
    }
    for (const side of card.loop.sides) side.reveal("caller", { silent: true });
    setState("revealed");
    // THE ONLY PLACE THIS IS CALLED, and that is the leak guard — see the block
    // above `backlinkSection`. The answer is up, so the cards that name it are
    // no longer a spoiler.
    if (currentCardId !== null) paintBacklinks(currentCardId);
  } else {
    setState("revealing");
    revealWord.textContent = `next · ${steps.length - stepIndex}`;
  }
  paintReplay(drill === null ? "none" : replayState);
}

// ─── WHAT LINKS HERE — Zach, 2026-09-14 ─────────────────────────────────────
//
// *"i need to know which cards are linked with this, so... list of back links?
// but ill let you decide where's the best place to put it — do we put it at the
// bottom do we scroll it or do we open a modal again"*
//
// ─── AT THE BOTTOM, AND ONLY AFTER THE WALK. THE SECOND HALF IS NOT TASTE ────
//
// Forward links already render in place (decision 19). The backward direction is
// new, and it cannot simply live at the foot of the card, because **a backlink
// list is usually the answer**. 94% of links in this corpus display the target's
// own name (`app/links.ts` measured it), so the cards pointing at 転 are 転出,
// 移転, 転職 — each of them containing the kanji. Put that under a 漢字 card,
// whose exercise is to draw the kanji from memory, or under a mode-2 単語 card,
// whose exercise is to identify the word from its clip, and the page prints what
// it is asking for. So the block is built when `settleReveal` reaches `revealed`
// and at no earlier moment.
//
// Given that, the bottom of the card beats a modal. Decision 23's shape is one
// scroll with the controls pinned, and this is something he glances at on card
// after card — a layer would be a tap he pays every time, and it would cover the
// answer he opened it from. In a PREVIEW there is no walk to wait for (decision
// 30: fully revealed, by definition), so the same block goes in unconditionally.
//
// ─── SIX ROWS, THEN A BUTTON — MEASURED ─────────────────────────────────────
//
// Distinct source cards per target: p50 **2**, p90 **7**, max **45** (人; then
// 手 and 物 at 41, 大 39, 出 38 — the heavy targets are all single kanji, which
// is exactly where this is most worth reading). **91.4% of linked cards have six
// or fewer**, so the cap is where the long tail starts rather than a round
// number, and `show all` appears on 8.6% of them.
//
// **62.5% of the corpus (4,823 cards) has no backlinks at all.** Those get
// nothing — no heading, no empty state, no reserved space. A line saying "no
// cards link here" on two cards out of three is noise on every screen he owns.
const BACKLINK_ROWS = 6;

const backlinksHost = el("backlinks");
/** The card `backlinksHost` currently speaks for. Null while it is empty. */
let backlinksFor: string | null = null;

/**
 * The block itself, or null when there is nothing to say.
 *
 * Shared by the review screen and the preview, which is why it returns an element
 * rather than writing to one: the two have different hosts and different moments,
 * and everything else about them is identical.
 */
async function backlinkSection(cardId: string): Promise<HTMLElement | null> {
  let reply: ReplyFor["backlinks"];
  try {
    reply = await ask<"backlinks">({ kind: "backlinks", cardId });
  } catch {
    // Swallowed on purpose. A list of related cards is a convenience, and a red
    // banner across a card he is mid-way through grading is not worth one.
    return null;
  }
  const cards = reply.cards;
  if (cards.length === 0) return null;

  const section = document.createElement("section");
  section.className = "backlinks";
  const head = document.createElement("h2");
  head.className = "backlinks-head";
  head.textContent = cards.length === 1 ? "1 card links here" : `${cards.length} cards link here`;
  const list = document.createElement("div");
  list.className = "backlinks-list";
  section.append(head, list);

  const paint = (limit: number): void => {
    list.replaceChildren();
    for (const card of cards.slice(0, limit)) {
      const row = document.createElement("button");
      row.type = "button";
      // The same row the link picker uses, for the same reason: the deck path is
      // how he tells 蟻-as-単語 from 蟻-as-言葉 apart.
      row.className = "link-item";
      const name = document.createElement("b");
      name.textContent = card.name === "" ? card.cardId : card.name;
      const deck = document.createElement("i");
      // Archived sources — 264 of them — are shown and MARKED, never hidden. The
      // rule browse already follows: a card he archived is still a card he wrote.
      deck.textContent = card.archived ? `${card.deckPath} · archived` : card.deckPath;
      row.append(name, deck);
      // A preview, not the editor: decision 30's mode is exactly "what is this
      // card", which is the question a backlink raises.
      row.addEventListener("click", () => void openPreview(card.cardId));
      list.appendChild(row);
    }
    if (cards.length > limit) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "backlinks-more";
      more.textContent = `show all ${cards.length}`;
      more.addEventListener("click", () => paint(cards.length));
      list.appendChild(more);
    }
  };
  paint(BACKLINK_ROWS);
  return section;
}

/**
 * Fill the review screen's block, once, for the card that has just been answered.
 *
 * `settleReveal` runs on every press AND on every tap of a cloze, so this has to
 * be idempotent per card or the worker gets a question it has already answered
 * and the list flickers as it is replaced by itself.
 *
 * The `backlinksFor` re-check after the await is the other half: he can arrow to
 * the next card while the worker is still answering, and a list that arrives late
 * would land under a card it has nothing to do with.
 */
function paintBacklinks(cardId: string): void {
  if (backlinksFor === cardId) return;
  backlinksFor = cardId;
  void (async () => {
    const section = await backlinkSection(cardId);
    if (section === null || backlinksFor !== cardId) return;
    backlinksHost.replaceChildren(section);
    backlinksHost.hidden = false;
  })();
}

/** Take the block off screen. Called with the card it belonged to. */
function clearBacklinks(): void {
  backlinksFor = null;
  backlinksHost.replaceChildren();
  backlinksHost.hidden = true;
}

/**
 * ONE PLAY CONTROL PER CLIP, BESIDE THE CLIP IT PLAYS.
 *
 * ─── ZACH, 2026-09-12, ON A CARD CARRYING TWO ──────────────────────────────
 *
 * *"we only have 1 play button, what if i have two audio like this and i wanna
 * replay the first one or the second one... what's the best ui?"*
 *
 * The round button bottom-right is decision 23 and stays exactly where it is: he
 * reviews one-handed with his right thumb, and it now follows the walk, so it
 * always means "again" for the clip he last heard. That covers the common case
 * and costs no reach. What it cannot do is NAME a clip.
 *
 * So the answer is not a second global control or a picker — it is to stop making
 * the clip anonymous. A clip already sits on the side that owns it: 単語's word
 * clip is on the side with the word, its sentence clip on the side with the
 * sentence, and the sides are separated by hairlines. A small square button in
 * that line needs no label, because the line IS the label.
 *
 * ─── WHY NOT SIMPLY SHOW THE NATIVE `<audio controls>` ─────────────────────
 *
 * It is already in the DOM and `shadowingLoop` already arms it, so unhiding it
 * would have been one CSS line. Three reasons not to, and the stylesheet has
 * carried the first one since the design brief landed:
 *
 *   * the renderer creates media elements with **no `src`**, so the native
 *     control is inert until something binds bytes — and a dead-looking transport
 *     bar is worse than no control at all;
 *   * it is a full-width transport with a seek bar and a volume slider, none of
 *     which this card wants, and it puts play at the FAR LEFT — the worst corner
 *     for the thumb decision 23 is built around;
 *   * it cannot show the two states that matter here, "this one is playing" and
 *     "this one is not on your device".
 *
 * ─── IT ASKS, IT DOES NOT ANSWER ────────────────────────────────────────────
 *
 * `{ unmask: false }`, always. On a mode-2 card the clip is the QUESTION and its
 * side is on screen with the kanji still masked; a play button that revealed the
 * answer would be the same defect the round button had until today.
 */
function mountClipButtons(card: MountedCard<HTMLElement>): void {
  for (const side of card.loop.sides) {
    for (const clip of side.audio) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "clip";
      button.textContent = "▶";
      // The clip's own alt text — the word, or the sentence. Never shown: the
      // line beside it already says this, and repeating it would be noise on a
      // card whose whole job is to be read.
      button.setAttribute("aria-label", `play ${clip.alt}`);
      button.title = clip.alt;

      // THE HAIRLINE. A 2px rule under the button, filling as the clip runs.
      //
      // NOT A SCRUB BAR, and the corpus is why: the isolated-word clips have a
      // median length of 1.63s and a maximum of 2.59s, so a seek target on one
      // is smaller than the gesture that would use it. What a scrub bar is
      // genuinely for here is the 1.0% of clips over ten seconds — and for those
      // the question is "is this still running", not "take me to 0:14". A line
      // answers the first and offers nothing for the second.
      //
      // With `loop` armed it also shows the loop turning over, which is the only
      // feedback that control has.
      //
      // A CSS variable rather than a child element: `.clip::after` reads it, so
      // nothing new is inserted into the card's own markup. Listeners live as
      // long as the element does and the card's dispose takes both together.
      const media = clip.element as unknown as HTMLMediaElement;
      const paint = (): void => {
        const at = media.duration > 0 ? Math.min(1, media.currentTime / media.duration) : 0;
        button.style.setProperty("--played", `${(at * 100).toFixed(1)}%`);
      };
      media.addEventListener("timeupdate", paint);
      media.addEventListener("ended", () => button.style.setProperty("--played", "0%"));

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // NOTHING SOUNDS WHILE THE MICROPHONE IS OPEN. `mayPlayClip` carries
        // the reasoning: a take recorded over a playing clip contains that clip.
        if (!mayPlayClip(takeState)) return;
        side.play(clip, { unmask: false });
      });
      clip.element.insertAdjacentElement("afterend", button);
    }
  }
}

/** Has this step's work already been done — by a tap on the cloze itself? */
function stepDone(card: MountedCard<HTMLElement>, step: RevealStep): boolean {
  const side = card.loop.side(step.position);
  if (side === null) return true;
  if (step.cloze === null) return side.revealed;
  return side.clozes[step.cloze]?.revealed === true;
}

/**
 * Why a grade was refused, in words he can act on.
 *
 * Every one of these is a thing he DID, not a fault — so they are said plainly
 * and the app keeps going. A refusal that showed nothing is what made the old
 * look-ahead read as a frozen app.
 */
const REFUSAL: Record<AnswerRefusal, string> = {
  // Grading it again would write a SECOND review row for one event, and that
  // feeds the scheduler. Undo is the way to change an answer.
  "already-answered": "you already answered this one — ctrl+z to take it back",
  // Decision 13: a re-ask writes no review at all.
  "re-ask": "this one is a re-ask — it is shown again but never graded",
  "nothing-there": "there is no card there",
};


/**
 * Fill the card's empty text generators — the example sentence, the emoji line,
 * the translations.
 *
 * Zach, 2026-09-12: *"the sentence is literally not there"*. It never was: the
 * renderer leaves an `ai` slot empty by contract (its children are the PROMPT,
 * not the output) and nothing had ever written the output in — on any card in
 * the corpus. See `src/review/text.ts`.
 *
 * Fire-and-forget on purpose. The card is already on screen and already usable;
 * the sentence arriving a frame later is strictly better than holding the mount
 * for a round trip. A failure leaves the slots `pending`, which is exactly what
 * they were before this existed.
 */
async function fillGeneratedText(card: MountedCard<HTMLElement>): Promise<void> {
  if (card.textSlots.length === 0) return;
  try {
    const reply = await ask<"generatedText">({
      kind: "generatedText",
      slots: card.textSlots.map((slot) => ({
        kind: slot.kind,
        text: slot.text,
        lang: slot.lang,
        voice: slot.voice,
        options: slot.options,
      })),
    });
    card.fillText(reply.texts);
    offerMissingGenerations(card, reply.texts);
    // RE-SCALE, AND THIS IS NOT OPTIONAL. `sideScale` measures rendered text, and
    // an `ai` slot is EMPTY at render time by contract — so 単語's example-sentence
    // side measures as a two-character stub, lands in `display`, and then the
    // sentence arrives a moment later at 40px. The fill is the only thing that
    // knows the side's text is now final.
    if (card === mounted) scaleSides(card);
  } catch {
    /* see the header: pending is the old behaviour, not a new failure */
  }
}

// ─── FILL WHAT MOCHI NEVER GENERATED — Zach, 2026-09-14 ─────────────────────
//
// *"im now at 疑念 card — i dont see emojis. i need way to regenerate on the fly
// when something is missing. maybe some ui?"*
//
// ─── IT IS NOT RARE, AND IT IS NOT A BUG IN THE IMPORT ──────────────────────
//
// Measured over the two templates that carry the line
// (`{{<ai>Describe a word << 単語 >> using emojis only</ai>}}`):
//
//     単語   726 of 3,468 missing   20.9%
//     言葉    73 of   391 missing   18.7%
//     ------------------------------------
//            799 of 3,859           20.7%
//
// One card in five. The example sentence, by contrast, is missing on 18 of 3,870
// (0.5%) — so this is specifically the emoji line, and the reason is that Mochi
// generated LAZILY, on render. A card whose side 4 he never reached in Mochi
// never had its emoji made. Generating on demand is therefore not a new idea
// bolted on: it is the behaviour he already had, moved to a button he can see.
//
// ─── WHY A BUTTON AND NOT A SILENT AUTO-FILL ────────────────────────────────
//
// It spends his API credit and it is not idempotent — an LLM asked twice for
// emoji for 疑念 returns two different answers. Filling silently on mount would
// bill 799 cards over a few weeks of review without ever asking, and would make
// the card change under him on a re-review. So: he asks, once, and the answer is
// stored (twice — see `requestGeneration`).
//
// `fillTextSlots` already leaves an unresolved slot at `data-state="pending"`
// rather than emptying it, precisely because "nothing was generated" and "this
// generated an empty string" are different facts. That attribute is the hook.
const GENERATE_ENDPOINT = "/generate/";

/** Kinds the laptop will generate. Audio is deferred — `vite.generate.ts` says why. */
const GENERATABLE: ReadonlySet<string> = new Set(["ai", "translate"]);

/**
 * Put a `generate` control in every slot that came back empty.
 *
 * Takes the REPLY rather than re-reading the DOM: `texts[i] === null` is the
 * worker saying "the store has nothing for this", which is the fact worth acting
 * on. Reading `data-state` back would also catch a slot that resolved to an empty
 * string, and that is a different thing to offer to fix.
 */
function offerMissingGenerations(
  card: MountedCard<HTMLElement>,
  texts: readonly (string | null)[],
): void {
  card.textSlots.forEach((slot, index) => {
    if (texts[index] !== null) return;
    if (!GENERATABLE.has(slot.kind)) return;
    const target = card.result.generations.find(
      (mount) => mount.request?.text === slot.text && mount.request?.kind === slot.kind,
    );
    const output = target?.output;
    if (output === undefined || output === null) return;
    // Already offered — `fillGeneratedText` runs once per mount, but a preview of
    // the same card opens its own and this keeps the two from stacking.
    if (output.querySelector(".regen") !== null) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "regen";
    // Just "generate". `slot.name` is the RENDERER's element name — `ai`,
    // `translate` — so "generate ai" is the internals leaking into the card. The
    // button stands in the hole its content belongs in, which is the only label
    // it needs; the prompt goes on `title` for a pointer that has one.
    button.textContent = "generate";
    button.title = slot.text;
    button.addEventListener("click", () => {
      void requestGeneration(card, slot, button);
    });
    output.appendChild(button);
  });
}

/**
 * OFFER TO SYNTHESISE THE CLIP THAT IS NOT THERE.
 *
 * Zach, 2026-09-15, on a 合理 card: *"it won't let me play the audio of the
 * example sentence — do you think because it's missing? then we need a way to
 * regenerate it, like the emoji section we did."*
 *
 * It was missing, and so are **785 of 10,420 mounts (7.5%) across 627 cards** —
 * 576 example sentences and 209 head words, **178 of the head words on mode-2
 * cards where decision 29 makes the clip the question**. A disabled `.clip`
 * button already said "not on this device"; it could not say "nothing ever made
 * this", and those are different problems with different answers.
 *
 * ─── WHY THE OUTCOME AND NOT THE SLOT ───────────────────────────────────────
 *
 * The emoji version walks `card.textSlots`, because an unfilled text generation
 * is knowable before anything is played. A clip is not: `audioController` asks
 * for bytes only from `play()` (that is the hard rule — decision 29 — and the
 * reason a card merely on screen produces no payload message at all). So the
 * first moment anyone can know a clip is absent is the failed play, and the
 * offer has to be made from `onOutcome`.
 *
 * The consequence is worth stating: **the button appears after he presses play,
 * not before.** That is not a compromise — a button offered before the attempt
 * would mean resolving every clip on entry, which is precisely the thing the
 * hard rule forbids.
 */
function offerMissingClip(
  card: MountedCard<HTMLElement>,
  mount: MountedCard<HTMLElement>["result"]["media"][number],
  clipButton: HTMLButtonElement,
): void {
  const address = audioAddress(card.result, mount);
  // An attachment cannot be synthesised — there is no generator input to speak,
  // only a file Mochi lost. One such mount exists in the whole corpus.
  if (address === null || address.origin !== "generator") return;
  const request = address.request;
  if (request.kind !== "speech" || request.text.trim() === "") return;
  if (clipButton.nextElementSibling instanceof HTMLButtonElement &&
      clipButton.nextElementSibling.classList.contains("regen")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "regen";
  button.textContent = "generate audio";
  button.title = request.text;
  button.addEventListener("click", () => {
    void requestClip(card, mount, request, button, clipButton);
  });
  clipButton.insertAdjacentElement("afterend", button);
}

/**
 * Ask the laptop to speak one line, file it twice, and play it.
 *
 * The two writes are `requestGeneration`'s, for the same reasons: the endpoint
 * has already put it in `build/hashigo.db` (which survives a seed rebuild and
 * which decision 41 made the system of record), and this stores the device's own
 * copy so the card is right now.
 *
 * **It plays afterwards, and that is a deliberate choice about the hard rule.**
 * He pressed a button asking for this clip; playing it is the same gesture
 * `replay()` serves, and `{ unmask: false }` is what `side.play` is given
 * everywhere so a mode-2 card's answer stays behind its cloze.
 */
async function requestClip(
  card: MountedCard<HTMLElement>,
  mount: MountedCard<HTMLElement>["result"]["media"][number],
  request: { text: string; lang: string | null; options: Readonly<Record<string, string>> },
  button: HTMLButtonElement,
  clipButton: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  const was = button.textContent;
  button.textContent = "speaking…";
  try {
    const response = await fetch(GENERATE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "speech", text: request.text, lang: request.lang, options: request.options }),
    });
    // The status before the body, for the reason `requestGeneration` records at
    // length: an empty 404 parsed as JSON reaches him as "Unexpected end of JSON
    // input", which names neither the status nor the cause.
    const raw = await response.text();
    let body: { audio?: string; error?: string } = {};
    try {
      body = raw === "" ? {} : (JSON.parse(raw) as typeof body);
    } catch {
      /* not ours — the status is the story */
    }
    if (!response.ok || typeof body.audio !== "string" || body.audio === "") {
      say(
        body.error ??
          (response.status === 404 || response.status === 405
            ? "this server has no /generate/ — it started before the endpoint existed. " +
              "On the laptop: npx kill-port 4274, then npm run phone"
            : `the laptop said ${response.status} ${response.statusText}`),
        true,
      );
      button.disabled = false;
      button.textContent = was;
      return;
    }
    await ask<"storeClip">({
      kind: "storeClip",
      slot: { text: request.text, lang: request.lang, options: request.options },
      audio: body.audio,
    }).catch(() => undefined);
    button.remove();
    clipButton.disabled = false;
    // Re-ask for the bytes, now that both stores have them.
    // `ShadowingSide.play` takes the MOUNT, not a reason — it is the per-clip
    // control decision 36 added, and `{ unmask: false }` is `prompt()`'s
    // contract: a mode-2 card's answer stays behind its cloze.
    const side = card.loop.sides.find((entry) => entry.index === mount.side);
    side?.play(mount, { unmask: false });
  } catch (cause) {
    say(`could not reach the laptop to generate: ${(cause as Error).message}`, true);
    button.disabled = false;
    button.textContent = was;
  }
}

/**
 * Ask the laptop for one generation, then put it everywhere it belongs.
 *
 * ─── TWO WRITES, AND THE ONE THAT SURVIVES IS ON THE LAPTOP ─────────────────
 *
 * The endpoint writes it into `build/hashigo.db` before replying. That is not an
 * optimisation, it is the whole reason this is a server round trip rather than a
 * `fetch` to Anthropic from here:
 *
 *   · decision 33's sync payload carries reviews, tracks and flags, NOT blobs —
 *     Zach deferred blob delivery himself — so a generation made on the phone
 *     would never reach the laptop;
 *   · `app-bootstrap` rebuilds each device's seed FROM `build/hashigo.db`, so
 *     anything living only in OPFS is gone at the next rebuild.
 *
 * The `storeGeneration` message is the second write: this device's own copy, so
 * the card stays filled until the rebuild hands it back properly.
 */
async function requestGeneration(
  card: MountedCard<HTMLElement>,
  slot: MountedCard<HTMLElement>["textSlots"][number],
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  const was = button.textContent;
  button.textContent = "generating…";
  try {
    const response = await fetch(GENERATE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: slot.kind,
        text: slot.text,
        lang: slot.lang,
        voice: slot.voice,
        options: slot.options,
      }),
    });
    // THE STATUS BEFORE THE BODY, AND THIS COST A ROUND TRIP.
    //
    // The first version called `response.json()` first. Zach's phone then hit a
    // server with no `/generate/` handler, got Vite's 404 with an EMPTY body, and
    // the parse threw — so the screen said *"could not reach the laptop to
    // generate: Unexpected end of JSON input"*, which names neither the status
    // nor the cause. A diagnostic that turns a 404 into a JSON error is worse
    // than none: it sent him looking at the network when the answer was a stale
    // server process.
    //
    // `vite preview` is why that case is REAL rather than theoretical. It reads
    // `build/app-dist` from disk per request, so `npm run app:build` updates the
    // client half of this feature in a running server — but the config, and so
    // the middleware, is loaded once at startup. The button can therefore exist
    // on a server that has never heard of the endpoint, and 404 is exactly what
    // that looks like.
    const raw = await response.text();
    let body: { text?: string; error?: string } = {};
    try {
      body = raw === "" ? {} : (JSON.parse(raw) as typeof body);
    } catch {
      /* not ours — the status is the story, see below */
    }
    if (!response.ok || typeof body.text !== "string" || body.text === "") {
      // THE COMMON FAILURE IS NOT AN ERROR, IT IS BEING AWAY FROM THE LAPTOP,
      // and the message has to say so — otherwise a phone on mobile data reads
      // as a broken app rather than as a feature that needs the tailnet, which
      // is the same availability the sync dot already has.
      const reason =
        body.error ??
        (response.status === 404 || response.status === 405
          ? "this server has no /generate/ — it started before the endpoint existed. " +
            "On the laptop: npx kill-port 4274, then npm run phone"
          : `the laptop said ${response.status} ${response.statusText}`);
      say(reason, true);
      button.disabled = false;
      button.textContent = was;
      return;
    }
    // Cache it here too. A failure to cache is logged by the worker and does not
    // stop the text reaching the card — he asked for it, he should see it.
    await ask<"storeGeneration">({ kind: "storeGeneration", slot, text: body.text }).catch(
      () => undefined,
    );
    button.remove();
    card.fillText(card.textSlots.map((s) => (s === slot ? body.text! : null)));
    if (card === mounted) scaleSides(card);
  } catch (cause) {
    say(`could not reach the laptop to generate: ${(cause as Error).message}`, true);
    button.disabled = false;
    button.textContent = was;
  }
}

/**
 * `型` IS A LABEL, AND IT HAD STOPPED LOOKING LIKE ONE.
 *
 * Zach, 2026-09-14, over a 疑念 card: *"it looks like 平板 itself now became the
 * vocab, dont you think it looks confusing?"* He is right, and measured on the
 * review screen it was worse than a matter of taste — the head word was the DIM
 * one:
 *
 *     ruby.hashigo-furigana   40px   --muted        the word
 *     .hashigo-cloze-answer   40px   --ink-bright   the accent label
 *
 * Half of that is fixed in the stylesheet (`.hashigo-furigana` takes `inherit`
 * now). This is the other half: with both at full ink, a two-character label at
 * 40px beside a two-character word at 40px is still two words, and on a
 * `Reading = false` card there are THREE such lines — `Reference`, the head word,
 * and `型`. Nothing on the screen says which one is being learned.
 *
 * ─── WHY THIS MATCHES TEXT INSTEAD OF READING PROVENANCE ────────────────────
 *
 * There is none to read. `src/template/resolve.ts` substitutes a plain field to
 * TEXT before the parse — its own header says so, and so does CLAUDE.md: *"a
 * resolved plain field is substituted to TEXT before the render and nothing
 * downstream knows `平板` came from `型`."* Two proper fixes exist and both were
 * weighed:
 *
 *   · wrap it in the template, the way `<ojad>` is (`<accent><< 型 >></accent>`
 *     plus an `ELEMENTS` entry). This is the RIGHT one and decision 20's own
 *     words ask for it — *"it should render conditionally from my template"*.
 *     It is also a template migration that has to reach two devices by sync, for
 *     a cosmetic fix, while he is out of the house on the phone it would fix.
 *   · wrap it in the resolver, keyed on the `accent` FIELD TYPE. Rejected on
 *     inspection: `value()` is the ONE place every interpolation path shares,
 *     *"the body, a cloze, and a generator's prompt input"* — so markup there
 *     would land inside a generation prompt and break decision 7.
 *
 * So this matches the card's own stored value, by field TYPE rather than by the
 * id `local-accent`. The failure mode is benign and that is what makes it
 * acceptable: a miss leaves the label rendering exactly as it does today, never
 * somewhere wrong. The four values are `平板` / `頭高` / `中高(n)` / `尾高`, so
 * something whose entire text is one of them and is not the accent label is not
 * a case this corpus has.
 *
 * ─── IT HAS TO MATCH A TEXT NODE, NOT ONLY AN ELEMENT — 2026-09-15 ─────────
 *
 * The first version searched ELEMENTS only, and Zach found what that misses:
 * *"i think the reading -> cards still treat the 平板 as something that doesn't
 * look like label?"* — over a 発言 card where it was still full-size white text
 * beside the head word.
 *
 * The two card modes put `型` in structurally different places, and only one of
 * them has an element to find (decision 20 — `<<#Reading>>` clozes it, and
 * `<<^Reading>>` leaves it plain):
 *
 *     mode 1, Reading = true    {{<< 型 >>}}   -> `.hashigo-cloze-answer`, an
 *                                                ELEMENT whose whole text is 平板
 *     mode 2, Reading not true  << 型 >>       -> a BARE TEXT NODE inside the
 *                                                <p> that also holds both clozes
 *                                                and the speech mount
 *
 * So the fix shipped on 2026-09-14 worked on the card it was tested with — a
 * mode-1 card — and did nothing at all for the **3,177** mode-2 cards, which are
 * the ones where decision 29 makes `型` the DISCOVERY SIGNAL he promotes cards
 * from. The wrong half was covered.
 *
 * A bare text node cannot carry a class, so it is wrapped in a `<span>`. That is
 * a DOM edit rather than a render change on purpose: `<accent>` as a real
 * template element is still the right answer and still needs a migration that
 * reaches two devices.
 *
 * **Decision 27 is why this shrinks the label rather than hiding it.** `型` is
 * the SOLE carrier of 平板-vs-尾高 on 2,148 of 3,830 labelled cards — the
 * distinction is inaudible in an isolated word and undrawable without a
 * particle. It is not a caption a layout may drop. A label treatment makes it
 * read as the annotation it is; it stays legible at a floor of 15px.
 */
function markAccentLabel(card: MountedCard<HTMLElement>): void {
  const field = card.loaded.template?.fields.find((f) => f.type === "accent");
  if (field === undefined) return;
  const value = (card.loaded.values.get(field.id) ?? "").trim();
  if (value === "") return;
  const title = `${field.name} — the accent pattern`;
  for (const side of card.result.sides) {
    for (const element of side.element.querySelectorAll<HTMLElement>("*")) {
      if ((element.textContent ?? "").trim() !== value) continue;
      // INNERMOST ONLY. A cloze answer and the paragraph holding it both match,
      // and styling the paragraph would shrink whatever else shares the line.
      if (element.querySelector("*") !== null) continue;
      element.classList.add("accent-label");
      element.setAttribute("title", title);
    }
    // THE MODE-2 SHAPE: a bare text node with no element of its own. Collected
    // first and replaced after, because replacing while walking a live
    // TreeWalker is how a walk starts skipping nodes.
    const walker = document.createTreeWalker(side.element, NodeFilter.SHOW_TEXT);
    const bare: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim() !== value) continue;
      // Already inside something marked above: leave it alone rather than
      // nesting a second span inside the element that is already the label.
      if ((node.parentElement?.classList.contains("accent-label") ?? false)) continue;
      bare.push(node as Text);
    }
    for (const node of bare) {
      const span = document.createElement("span");
      span.className = "accent-label";
      span.setAttribute("title", title);
      // The node's own text, not `value` — it carries the surrounding
      // whitespace the layout already accounts for.
      span.textContent = node.textContent;
      node.parentNode?.replaceChild(span, node);
    }
  }
}

/** Size every side from what it actually says. See `sideScale`. */
function scaleSides(card: MountedCard<HTMLElement>): void {
  for (const side of card.result.sides) {
    side.element.setAttribute("data-scale", sideScale(side.element.textContent ?? ""));
  }
}

async function grade(remembered: boolean): Promise<void> {
  if (mounted === null) return;
  const durationMs = Math.round(performance.now() - shownAt);
  forgotButton.disabled = true;
  rememberedButton.disabled = true;
  try {
    // The offset travels WITH the grade. He can be reading a card ahead of the
    // cursor — that is the point of the arrows — and the worker swaps it into
    // place before grading, so the card he read is the card that is graded.
    const reply = await ask<"answer">({
      kind: "answer",
      remembered,
      durationMs,
      offset: peekOffset,
    });
    if (reply.refused !== null) {
      say(REFUSAL[reply.refused], true);
      paintPeek();
      return;
    }
    // Graded: the swap put that card at the cursor and the cursor advanced, so
    // the screen is back in step with the session.
    peekOffset = 0;
    if (reply.graded && reply.dueAt !== null) {
      line(
        `graded · due ${reply.dueAt.slice(0, 10)} · ${reply.writeMs.toFixed(1)} ms write · ` +
          `${reply.openStatements} open / ${reply.cachedStatements} cached statements`,
        "good",
      );
      // THE GRADE LEAVES THIS DEVICE ON ITS OWN NOW. See `schedulePush`.
      schedulePush();
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
  if (!mayPlayClip(takeState)) return;
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
const moreButton = el<HTMLButtonElement>("opmore");

/**
 * THE TWO STATES STILL HAVE TO BE READABLE WITHOUT OPENING ANYTHING.
 *
 * The old row spelled them out — the button itself read `unpin` / `unarchive`,
 * which said the state and the action in one word. Behind a menu that is gone,
 * and "you must open a menu to find out whether this card is archived" is a
 * worse trade than the room it bought. So the handle carries them: `.on` is the
 * same class the two buttons used, so the visual language does not change, and
 * the `title` names them in words because a lit handle does not say WHICH.
 */
function paintCardOps(): void {
  const flags = [currentPinned ? "pinned" : "", currentArchived ? "archived" : ""].filter(
    (flag) => flag !== "",
  );
  moreButton.classList.toggle("on", flags.length > 0);
  moreButton.title = flags.length === 0 ? "card actions" : `card actions — ${flags.join(", ")}`;
}

moreButton.addEventListener("click", () => {
  if (currentCardId !== null) {
    openCardMenu(currentCardId, previewOfCurrent?.loaded.name ?? currentCardId);
  }
});

// ─── his theme ──────────────────────────────────────────────────────────────

/**
 * Zach, 2026-09-13: *"where do i change light dark theme?"* He could not — the
 * app followed `prefers-color-scheme` and had no control at all, even though
 * `style.css` has carried `[data-theme]` for both directions since decision 32.
 *
 * The attribute is applied twice on purpose: once by four inline lines in
 * `index.html`'s `<head>`, before anything paints, and once here. This module
 * runs after the document is parsed, which is too late to stop the boot screen
 * flashing the wrong ground — and the boot screen is up for as long as the
 * database takes to fetch. `app/theme.ts` owns the key both of them read.
 */
let currentTheme: Theme = "system";
try {
  currentTheme = readTheme(localStorage.getItem(THEME_KEY));
} catch {
  /* a disabled localStorage costs the preference, not the session */
}

function applyTheme(theme: Theme): void {
  currentTheme = theme;
  const attribute = themeAttribute(theme);
  if (attribute === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", attribute);

  // THE PHONE'S OWN CHROME HAS TO FOLLOW, or a forced-light app sits in a black
  // status bar. `index.html` ships two media-scoped `theme-color` tags; forcing
  // a theme means overriding BOTH, because either may be the one that matches.
  const forced = forcedChrome(theme);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (forced !== null) meta.content = forced;
    else meta.content = meta.media.includes("dark") ? "#1A1815" : "#ECEAE5";
  }

  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* full or disabled: it still applies for this session */
  }
}

applyTheme(currentTheme);

// ─── the shadowing controls: loop, speed, and his own voice ─────────────────

/**
 * THE DRILL FINALLY HAS CONTROLS. Zach, 2026-09-12, over a card-controls mockup
 * another session had built — the one thing in it this app did not have was
 * anything for the exercise every clip in the corpus exists for.
 *
 * `app/shadow-controls.ts` holds every rule that can be decided without a DOM,
 * and its header carries the measurements: the clip-length distribution that
 * killed the mockup's scrub bar, why the rate ladder stops at 0.75, and why a
 * take is ephemeral. This file is the wiring.
 *
 * ─── WHAT IS NOT ALLOWED TO CHANGE ──────────────────────────────────────────
 *
 * Decision 29's hard rule is untouched, and it is untouched STRUCTURALLY rather
 * than carefully: `l` and `s` write two numbers, `m` opens a microphone, and
 * none of the four can reach `audioController`. The only thing here that makes a
 * sound is `playTake`, and it plays HIS voice from its own element.
 */
const PLAYBACK_KEY = "hashigo.playback";

let playbackState: Playback = DEFAULT_PLAYBACK;
try {
  playbackState = readPlayback(localStorage.getItem(PLAYBACK_KEY));
} catch {
  /* a disabled or full localStorage costs the setting, not the session */
}

/**
 * Handed to every `audioController` as `playback`, and asked at each play.
 *
 * A FUNCTION, NOT THE VALUE. A value read at mount would be frozen for the life
 * of one card, so a rate he changed mid-card would not take until the next one —
 * and "I pressed it and nothing happened" is how a control gets pressed twice.
 */
function currentPlayback(): Playback {
  return playbackState;
}

const loopButton = el<HTMLButtonElement>("oploop");
const speedButton = el<HTMLButtonElement>("opspeed");
const recordButton = el<HTMLButtonElement>("oprecord");
const takeButton = el<HTMLButtonElement>("optake");

let takeState: TakeState = "idle";
let takeUrl: string | null = null;
let recorder: MediaRecorder | null = null;
let recordingStream: MediaStream | null = null;
/**
 * A private element, NEVER the card's.
 *
 * His take must not travel through `audioController`: that would let it set
 * `drill`, retarget the round replay button, and appear in `card.loop.log` — the
 * log the hard-rule tests read. A recording of his own voice is not a clip.
 */
const takeAudio = new Audio();
/**
 * Which card a recording belongs to.
 *
 * `MediaRecorder.stop()` finishes ASYNCHRONOUSLY. Without this, stopping a
 * recording by moving to the next card lands the finished blob on the card he
 * has just arrived at — his 転出 take offered as his 償却 take.
 */
let takeGeneration = 0;

function savePlayback(): void {
  try {
    localStorage.setItem(PLAYBACK_KEY, writePlayback(playbackState));
  } catch {
    /* full or disabled: the setting still applies for this session */
  }
  paintShadowbar();
}

function paintShadowbar(): void {
  loopButton.classList.toggle("on", playbackState.loop);
  loopButton.setAttribute("aria-pressed", String(playbackState.loop));
  speedButton.firstChild!.textContent = speedLabel(playbackState.rate);
  // Normal speed is the ABSENCE of a setting, so it does not light up.
  speedButton.classList.toggle("on", playbackState.rate !== 1);

  const labels = takeLabels(takeState);
  recordButton.firstChild!.textContent = labels.record;
  recordButton.disabled = labels.recordDisabled;
  recordButton.classList.toggle("arm", takeState === "recording");
  recordButton.title =
    takeState === "denied"
      ? "no microphone here — the permission was refused, or this browser has none"
      : "record yourself saying it, then play both back";
  takeButton.hidden = labels.take === null;
  if (labels.take !== null) takeButton.firstChild!.textContent = labels.take;
}

/**
 * Silence every clip on the card.
 *
 * Called before the microphone opens. He reviews on a phone, on its own speaker;
 * a take captured over a playing clip contains that clip, and comparing his
 * contour against a mix of itself and his voice is not weak feedback, it is
 * confidently wrong feedback about the one thing he is training.
 */
function silenceClips(): void {
  for (const media of mounted?.result.media ?? []) {
    const element = media.element as unknown as { pause?: () => void };
    element.pause?.();
  }
}

function releaseTake(): void {
  takeAudio.pause();
  if (takeUrl !== null) URL.revokeObjectURL(takeUrl);
  takeUrl = null;
}

/**
 * The take does not follow him to the next card — see `shadow-controls.ts` for
 * why it is ephemeral rather than stored.
 *
 * `denied` SURVIVES. It is a fact about the browser, not about the card, and
 * resetting it would ask him for the microphone again on every single card after
 * he has already said no once.
 */
function dropTake(): void {
  takeGeneration += 1;
  if (takeState === "recording") recorder?.stop();
  recorder = null;
  for (const track of recordingStream?.getTracks() ?? []) track.stop();
  recordingStream = null;
  releaseTake();
  if (takeState !== "denied") takeState = "idle";
  paintShadowbar();
}

async function toggleRecord(): Promise<void> {
  if (takeState === "recording") {
    recorder?.stop();
    return;
  }
  if (takeState === "arming" || takeState === "denied") return;

  silenceClips();
  releaseTake();
  takeState = "arming";
  paintShadowbar();

  const generation = takeGeneration;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: CAPTURE });
  } catch (cause) {
    // DISABLED AND SAID, not hidden — the `.clip[data-clip="missing"]` rule. A
    // control that vanishes leaves him wondering whether the feature exists.
    takeState = "denied";
    paintShadowbar();
    say(`no microphone — ${(cause as Error).message}`, true);
    return;
  }
  if (generation !== takeGeneration) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }

  recordingStream = stream;
  const type = pickRecordingType((candidate) => MediaRecorder.isTypeSupported(candidate));
  recorder = new MediaRecorder(stream, type === "" ? {} : { mimeType: type });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    // THE MIC LIGHT HAS TO GO OUT. A live track left open keeps the phone's
    // recording indicator on for the rest of the session, which on his handset
    // looks exactly like an app that is still listening — because it is.
    for (const track of stream.getTracks()) track.stop();
    if (generation !== takeGeneration) return;
    recordingStream = null;
    takeUrl = URL.createObjectURL(new Blob(chunks, type === "" ? {} : { type }));
    takeAudio.src = takeUrl;
    takeState = "take";
    paintShadowbar();
  });
  recorder.start();
  takeState = "recording";
  paintShadowbar();
}

function playTake(): void {
  if (takeUrl === null) return;
  takeAudio.currentTime = 0;
  // AT THE SAME RATE AS THE REFERENCE, so the comparison is like for like. If he
  // is listening to the clip at 0.75× and his own take comes back at 1×, the two
  // contours are stretched differently and the thing he is comparing is tempo.
  takeAudio.preservesPitch = true;
  takeAudio.playbackRate = playbackState.rate;
  void takeAudio.play().catch(() => say("could not play your take", true));
}

loopButton.addEventListener("click", () => {
  playbackState = { ...playbackState, loop: !playbackState.loop };
  savePlayback();
});
speedButton.addEventListener("click", () => {
  playbackState = { ...playbackState, rate: nextSpeed(playbackState.rate) };
  savePlayback();
});
recordButton.addEventListener("click", () => void toggleRecord());
takeButton.addEventListener("click", playTake);
paintShadowbar();

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
    hasTake: takeUrl !== null,
    reviewHidden: reviewView.hidden,
    revealed,
    moreToReveal: stepIndex < steps.length || !revealed,
    asked: askedOnEntry,
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
    case "toggleLoop":
      loopButton.click();
      return;
    case "cycleSpeed":
      speedButton.click();
      return;
    case "toggleRecord":
      void toggleRecord();
      return;
    case "playTake":
      playTake();
      return;
    case "backToCard":
      void showSessionCard();
      return;
    case "gradeBlocked":
      say("looking ahead — press ← or Escape to get back to your card first");
      return;
    // Decision 42. The count is the useful half: "not yet" with no number is the
    // same unexplained nothing the `gradeBlocked` message exists to avoid.
    case "gradeTooEarly":
      say(`${steps.length - stepIndex} more to see — space, then j`);
      return;
    case "gradeForgot":
      void grade(false);
      return;
    case "gradeRemembered":
      void grade(true);
      return;
    case "replay":
      if (mayPlayClip(takeState)) drill?.replay();
      return;
  }
});

/**
 * His #9: *"use arrows (left and right) to move to next card and move back,
 * without registering any reviewing record, just wanna see what's next"*.
 *
 * It moves `peekOffset` and re-renders the review view. It does NOT move the
 * session cursor, open a layer, or write anything — see `showCardAt` for why the
 * first version's preview layer was wrong twice over, and `paintPeek` for which
 * half of a non-zero offset can still be graded (ahead yes, behind no).
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

/* The exit from look-ahead, as a control rather than a thing to work out. It
 * returns to the session cursor in ONE tap from any offset — stepping back with
 * the arrow takes as many presses as he took forward, which is the wrong shape
 * for "get me out of here". */
el("peekback").addEventListener("click", () => {
  void showSessionCard().then(() => say("back to the card you were on"));
});
el("palettebutton").addEventListener("click", () => {
  closeSidebar();
  openPalette();
});

// A tap on a cloze reveals too — `shadowingLoop`'s `bindClozes` does that for
// free — so the screen has to follow the state it did not cause.
//
// IT MUST NOT ALSO TAKE A STEP. The loop has already unmasked exactly the cloze he
// touched; running `reveal()` here would spend a step on top of it and skip the
// next one. `settleReveal` walks the plan past whatever is already done instead,
// which also copes with him tapping the clozes out of order.
document.addEventListener(
  "click",
  (event) => {
    const target = event.target as HTMLElement | null;
    // NOT from inside a layer. A preview's clozes are already open, and without
    // this the click would reveal the REVIEW card sitting behind it — answering a
    // question he has not been asked yet.
    if (target?.closest(".layer") != null) return;
    if (target?.closest(`.${CLASS.cloze}`) === null) return;
    const card = mounted;
    if (card !== null) settleReveal(card);
  },
  // BUBBLE, not capture — it used to be capture and had to stop being. The loop's
  // own listener sits on the cloze element, so a capturing handler on `document`
  // runs BEFORE the cloze is unmasked and would see nothing to settle.
  false,
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
  // The visit log too. A re-seed happens to restore the same card ids, so the log
  // would still resolve — but "delete Hashigo's local database" leaving behind a
  // record of what he opened is the surprising reading of that sentence.
  clearVisits();
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
  // THE VISIT, and the two funnels are here and in `openEditorById` because every
  // deliberate open in the app goes through one of them — palette, card link,
  // gallery, `e` in review. Only after the card came back: a dead link is not a
  // visit, and logging one would keep it at the top of Ctrl+K for fifty opens.
  if (reply.card !== null) noteVisit(cardId);

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
    // Decision 30 keeps a preview silent on entry but leaves a clip one tap
    // away. When he takes that tap it should sound the way the review screen
    // sounds — a rate that applied on one surface and not the other would be a
    // setting he could not trust.
    playback: currentPlayback,
    resolve: async (address) =>
      (await ask<"payload">({ kind: "payload", cardId: reply.card!.cardId, address })).payload,
    // A PREVIEW HAD NO OUTCOME HANDLER AT ALL until 2026-09-15, so its `.clip`
    // buttons could not say "playing", could not say "not on this device", and
    // could not offer to make a clip that was never generated. A press on a
    // missing one simply did nothing — which is the same dead-control complaint
    // the native `<audio>` earned the day before. Decision 30 makes a preview the
    // place he LOOKS at a card, so it is exactly where a gap should be visible.
    onOutcome: (outcome) => {
      const button = outcome.mount.element.nextElementSibling;
      if (!(button instanceof HTMLButtonElement) || !button.classList.contains("clip")) return;
      button.setAttribute("data-clip", outcome.kind);
      button.disabled = outcome.kind === "missing" || outcome.kind === "unaddressable";
      if (button.disabled) button.title = `no clip on this device for ${outcome.mount.alt}`;
      // `mounted` is this preview's own card, not the module-level review card
      // it shadows — and reading it from inside its own initialiser is safe for
      // one reason worth naming: `onOutcome` fires only from `play()`, and the
      // hard rule (decision 29) means nothing plays during a mount. If that ever
      // stops being true this is a temporal-dead-zone throw, not a wrong card.
      if (outcome.kind === "missing") offerMissingClip(mounted, outcome.mount, button);
    },
  });

  // Every side visible, every cloze open, and SILENT — decision 30's whole shape
  // in three lines. `{ silent: true }` is what keeps it a preview rather than a
  // reveal: unmask, do not sound.
  void fillGeneratedText(mounted);
  for (const side of mounted.result.sides) side.element.hidden = side.empty;
  for (const side of mounted.loop.sides) side.reveal("caller", { silent: true });
  // The label treatment belongs here too. A preview is where he LOOKS at a card
  // (decision 30), so `型` reading as a second head word is the same complaint on
  // this surface as on the review screen.
  markAccentLabel(mounted);

  body.appendChild(mounted.result.root);
  layerHost.appendChild(root);
  // THE ONLY WAY TO HEAR A CLIP HERE, as of 2026-09-14. A preview used to show
  // the native `<audio controls>` instead, and it was inert: the renderer leaves
  // media sourceless, and a press on the native play button of a sourceless
  // element fires NEITHER `click` NOR `play` on the host, so nothing ever got the
  // chance to attach the bytes. Measured on the card Zach reported it with — see
  // the note in `style.css` beside `.layer .hashigo-cloze-answer`.
  //
  // Decision 30 says a clip stays one deliberate tap away in a preview. This is
  // that tap, and it is the same control the review screen uses (decision 36),
  // which is the other half: a play button that lives in a different place and
  // works differently on two surfaces is worse than one derived once.
  mountClipButtons(mounted);
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

  // UNCONDITIONAL HERE, because decision 30 already settled it: a preview is
  // fully revealed by definition, so there is no answer left for a backlink list
  // to give away. Appended after the layer is on the stack rather than awaited
  // before it — the card should be on screen while the worker answers, and a
  // preview that waited on a second round trip would open visibly slower than
  // the one that shipped yesterday.
  void (async () => {
    const section = await backlinkSection(cardId);
    // He can close a preview faster than the worker replies. `root.isConnected`
    // is the honest test for that, and it costs nothing.
    if (section !== null && root.isConnected) body.appendChild(section);
  })();
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
      area.rows = 1;
      area.spellcheck = false;
      // GROW TO THE CONTENT. `rows` used to be guessed from whether the value
      // held a newline, which is right for a head word and wrong for a link:
      // `[[換え|C1p9g1mL]]` is fifteen characters and no newline, and on a 375px
      // phone it wraps to a second line that was simply CLIPPED. Seen while
      // verifying the link mirror, which is also why it matters here — a field
      // that never scrolls is a field whose mirror cannot wrap differently.
      area.addEventListener("input", () => fitTextarea(area));
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
  // AFTER the layer is in the document: `scrollHeight` is 0 on a detached node,
  // so sizing at creation time would collapse every field to one line.
  for (const area of body.querySelectorAll("textarea.edit-input")) {
    fitTextarea(area as HTMLTextAreaElement);
  }
  (body.querySelector(".edit-input, .edit-check") as HTMLElement | null)?.focus();
}

/**
 * Size a textarea to its content.
 *
 * `height: auto` first, or `scrollHeight` reports the height it ALREADY has and
 * the box can only ever grow. The `offsetHeight - clientHeight` term is the
 * border: `box-sizing` is `border-box` here and `scrollHeight` is not.
 */
function fitTextarea(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
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

/**
 * THE RAIL STANDS AT ≥1024px — and two things in here assumed a drawer.
 *
 * The breakpoint is named once, in JS and in CSS, and they have to agree: the
 * stylesheet's composition block at the end of `style.css` carries the reasoning
 * for the number. 1024 is the width at which a 330px rail plus a 720px card
 * column plus air still fits, and below it the drawer is the honest answer.
 *
 * **`openSidebar` was the only thing that ever filled the sidebar.** That was
 * right while opening was the only way to see it, and wrong the moment the rail
 * is on screen from boot — it would stand there empty until he pressed a key
 * that visibly does nothing. So filling is split out and boot calls it.
 */
const railStanding = window.matchMedia("(min-width: 1024px)");

function fillSidebar(): void {
  const host = el("newcardhost");
  if (host.childElementCount === 0) host.appendChild(buildNewCardForm());
  void loadDecks();
}

function openSidebar(): void {
  fillSidebar();
  // The rail is already on screen, so `/` cannot mean "open it". It means "put
  // me in it" — a key that does nothing visible reads as a broken key.
  if (railStanding.matches) {
    el("sidebar").querySelector<HTMLElement>("button:not([hidden]), input")?.focus();
    return;
  }
  document.body.classList.add("sidebar-open");
  sidebarToggle.setAttribute("aria-expanded", "true");
}

function closeSidebar(): void {
  document.body.classList.remove("sidebar-open");
  sidebarToggle.setAttribute("aria-expanded", "false");
}

// Crossing the breakpoint with a window drag: the rail has to fill itself on the
// way up, and shed the drawer class on the way down so a later resize does not
// find it open behind a scrim that the composition block has hidden.
railStanding.addEventListener("change", (event) => {
  if (event.matches) fillSidebar();
  else closeSidebar();
});

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

/* ── "add to home screen" (his PWA ask, 2026-09-12) ─────────────────────────
 *
 * The button is hidden until `beforeinstallprompt` fires, so it is never a dead
 * control. The NOTE under it is the part that earns its place: OPFS is keyed by
 * ORIGIN and an install pins the origin, so installing from a quick tunnel — a
 * new random hostname every run — produces a home-screen icon pointing at a host
 * that will not exist tomorrow, and a second empty database if it ever did. */
const installButton = el<HTMLButtonElement>("installapp");
const installNote = el("installnote");

const install = watchForInstall({
  setAvailable(available) {
    installButton.hidden = !available;
    if (!available) return;
    const where = installOrigin();
    installNote.textContent = where.durable ? "" : `⚠ ${where.why}`;
    installButton.classList.toggle("is-risky", !where.durable);
  },
  say,
});

installButton.addEventListener("click", () => {
  closeSidebar();
  void install.install();
});

registerServiceWorker();

/* ── stage 11: sync, and the indicator that says whether it happened ────────
 *
 * Zach, 2026-09-12, after archiving 数字 on his phone for the second time:
 * *"on desktop it's still not archived, can we add icon or any visual to show
 * the sync status"*. The archive was never the bug — there was no transport at
 * all, and nothing on screen said so. An absent sync has to LOOK absent. */
const syncDot = el<HTMLButtonElement>("syncdot");
const syncDotText = el("syncdottext");
const syncDetail = el("syncdetail");
let syncStatus: SyncStatus = initialStatus();

function paintSync(): void {
  const label =
    syncStatus.state === "syncing"
      ? "syncing…"
      : syncStatus.state === "failed"
        ? `sync failed — ${syncStatus.detail ?? "unknown"}`
        : syncStatus.state === "behind"
          ? // NAMES THE CONSEQUENCE, not the state. "behind" is jargon; "you will
            // be asked cards you have already answered" is the thing he noticed
            // on his own, one card at a time, before the dot said anything.
            `${syncStatus.peers} device(s) have newer grades — sync, or you will be re-asked cards`
          : sinceLabel(syncStatus.lastSyncedAt);
  // "stale" is not a state the client returns — it is `ok` that has aged past a
  // day, and the dot shows it hollow because at that point his two devices hold
  // grades neither has seen.
  const shown =
    syncStatus.state === "ok" && isStale(syncStatus) ? "stale" : syncStatus.state;
  syncDot.dataset["state"] = shown;
  syncDot.title = label;
  syncDot.setAttribute("aria-label", label);
  syncDotText.textContent = label;
  // THE DETAIL ROW SAYS BOTH CLOCKS, BECAUSE THEY ARE DIFFERENT FACTS and the
  // difference is exactly what cost him a day. "synced" means this device pulled
  // everyone and pushed; "sent" means only that its own grades are in the
  // mailbox, which is the automatic half (`schedulePush`) and the half that
  // protects work he cannot reconstruct. A device can be hours from its last
  // full sync and still have every grade safely off it — that reads as a problem
  // unless the row says so.
  const sent = syncStatus.state === "syncing" ? null : agoLabel(lastPushedAt());
  syncDetail.textContent = sent === null ? label : `${label} · grades sent ${sent}`;
}

const syncPorts = {
  async exportPayload(): Promise<{ json: string; bytes: number }> {
    const reply = await ask<"syncExport">({ kind: "syncExport" });
    return { json: reply.json, bytes: reply.bytes };
  },
  async mergePayload(payload: unknown): Promise<{
    reviewsAdded: number;
    flagsTaken: number;
    trackStateTaken: number;
  }> {
    const reply = await ask<"syncMerge">({ kind: "syncMerge", payload });
    return {
      reviewsAdded: reply.reviewsAdded,
      flagsTaken: reply.flagsTaken,
      trackStateTaken: reply.trackStateTaken,
    };
  },
};

async function runSync(): Promise<void> {
  if (syncStatus.state === "syncing") return;
  syncStatus = { ...syncStatus, state: "syncing", detail: null };
  paintSync();
  try {
    const outcome = await syncNow(syncPorts);
    syncStatus = {
      state: "ok",
      lastSyncedAt: new Date().toISOString(),
      detail: null,
      peers: outcome.peersMerged,
    };
    paintSync();
    // A peer that could not be merged is reported rather than swallowed — the
    // sync still completed for everyone else, and that distinction matters.
    if (outcome.failures.length > 0) {
      say(`synced, but ${outcome.failures.length} peer(s) failed — ${outcome.failures[0]}`, true);
    } else {
      say(
        outcome.peersMerged === 0
          ? "nothing to merge — this is the only device that has checked in"
          : `synced · ${outcome.reviewsAdded} grades in · ${outcome.flagsTaken} cards changed`,
      );
    }
    // A merge can change what is due and what is archived, so the queue the
    // screen is holding may no longer be the right one.
    if (outcome.reviewsAdded > 0 || outcome.flagsTaken > 0) await refreshAfterOp();
  } catch (error) {
    syncStatus = {
      ...syncStatus,
      state: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
    paintSync();
    say(`sync failed — ${syncStatus.detail ?? ""}`, true);
  }
}

/**
 * A GRADE LEAVES THIS DEVICE WITHOUT BEING ASKED TO — Zach, 2026-09-14.
 *
 * *"i already reviewed so many items on my phone today, but it's not reflected on
 * any browser on my pc. we need to fix this. what happens with my ACID😭"*
 *
 * Nothing had gone wrong with the durability. Every grade was committed to the
 * phone's OPFS and every merge rule in `src/sync/merge.ts` was correct — but
 * `runSync` was reachable from TWO CLICK HANDLERS and nothing else, so a day of
 * reviewing sat on one device with the newest mailbox payload **23 hours old**.
 * A sync nobody presses is a sync that does not exist, and decision 33 shipped
 * the transport without ever giving it a trigger.
 *
 * ─── PUSH, NOT SYNC, AND THAT IS THE WHOLE SAFETY ARGUMENT ──────────────────
 *
 * `pushNow` sends and merges nothing. A full `syncNow` pulls every peer first,
 * and the merge is ~8 seconds in the worker that also owns the session — 8
 * seconds of frozen review screen, and a merge that can change what is due
 * under his thumb mid-card. Automating that would trade one silent failure for a
 * louder one. Automating the PUSH protects exactly the thing he cannot
 * reconstruct and touches nothing else, on this device or any other.
 *
 * ─── DEBOUNCED OFF HIS OWN GRADING, NEVER A TIMER ───────────────────────────
 *
 * SPEC problem #1 is battery — *"no polling, no sockets"* — so there is no
 * interval here. The clock starts when he grades and is pushed forward by the
 * next grade, so a steady session sends once every `PUSH_AFTER_MS` of thinking
 * time and once more when he stops. A device nobody is reviewing on sends
 * nothing at all.
 *
 * ─── AND IT FAILS QUIETLY, WHICH IS DELIBERATE ──────────────────────────────
 *
 * Off the tailnet the PUT cannot land, and that is his NORMAL state on a train.
 * A red banner every 30 seconds would train him to ignore the one that matters.
 * The dot carries it instead — that is what the indicator is for — and the next
 * grade schedules another attempt, so a session that starts offline still sends
 * everything the moment he is home.
 */
const PUSH_AFTER_MS = 30_000;
let pushTimer: number | undefined;
let pushing = false;

function schedulePush(): void {
  if (pushTimer !== undefined) clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => void pushGrades(), PUSH_AFTER_MS);
}

async function pushGrades(): Promise<void> {
  pushTimer = undefined;
  // Never on top of a full sync: that one pushes too, and the second PUT would
  // race the first with an older export.
  if (pushing || syncStatus.state === "syncing") return;
  pushing = true;
  try {
    await pushNow(syncPorts);
    // WE ARE ALREADY TALKING TO THE MAILBOX, so ask the one question the push
    // cannot answer: has anyone else left newer work in it? A listing, not a
    // merge — no payload bodies, nothing applied, nothing on screen moves. This
    // is what turns "synced 38m ago" from true-but-useless into a dot that knows
    // it is out of date.
    await refreshBehind();
    paintSync();
  } catch {
    // Quiet on purpose — see the header. `paintSync` still reads the pushed
    // clock, so the indicator tells the truth without interrupting a card.
    paintSync();
  } finally {
    pushing = false;
  }
}

/**
 * Ask the mailbox whether a peer is ahead of this device's last MERGE.
 *
 * Never throws and never downgrades a real status: offline is the normal state
 * of a local-first app, and a listing that could not be fetched is not evidence
 * that anything is wrong. It can only move `ok` to `behind`, or `behind` back to
 * `ok` once he has actually synced.
 */
async function refreshBehind(): Promise<void> {
  if (syncStatus.state === "syncing" || syncStatus.state === "failed") return;
  try {
    const newer = await peersNewerThan(syncStatus.lastSyncedAt);
    if (newer > 0) {
      syncStatus = { ...syncStatus, state: "behind", peers: newer };
    } else if (syncStatus.state === "behind") {
      syncStatus = {
        ...syncStatus,
        state: syncStatus.lastSyncedAt === null ? "never" : "ok",
        peers: 0,
      };
    }
  } catch {
    /* offline, or no mailbox on this server — say nothing */
  }
}

/**
 * The last thing before he closes the tab, and the only place a timer is short.
 *
 * `visibilitychange` to hidden is the strongest "he has stopped" signal a page
 * gets, and on Android it is what fires when he switches apps or locks the
 * screen — the exact moment a debounce that has not elapsed would be lost.
 *
 * NOT `keepalive: true`, which is the usual answer here and does not apply: its
 * body cap is 64 KB and his payload is **1.5 MB**. So this is a best-effort
 * push from a page that is still alive, and the debounce above is what makes it
 * rarely have anything left to do.
 */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  if (pushTimer === undefined) return;
  clearTimeout(pushTimer);
  void pushGrades();
});

syncDot.addEventListener("click", () => void runSync());
el("synclink").addEventListener("click", () => {
  closeSidebar();
  void runSync();
});
paintSync();
// ON LOAD, BEFORE HE STARTS REVIEWING — the case that cost him the duplicates.
// He opens the laptop hours after the phone last pushed; nothing has been graded
// here yet, so no push has fired and nothing else would ask. A listing is cheap
// enough to spend on every load, and this is the moment the answer is worth
// most: the alternative is finding out one already-answered card at a time.
void refreshBehind().then(paintSync);

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
    const suggesting = input.value.trim() === "";
    const reply = await ask<"browse">({
      kind: "browse",
      query: input.value,
      deckId: null,
      limit: 40,
      suggest: true,
      visited: readVisits(),
    });
    if (token !== paletteToken) return;
    paletteHits = reply.hits;
    paletteIndex = 0;
    // "recent" rather than "40 of 7,716", which counts the collection and says nothing
    // about what is on screen. The suggestion list is not a result set.
    foot.textContent = suggesting
      ? `recent · ${reply.hits.length}`
      : reply.total === 0
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
    // FALSE, and that is the point of the flag: an empty gallery is "the cards in this
    // deck", which is a listing. Ordering it by what he opened lately would be a
    // different question answered under the same heading.
    suggest: false,
    visited: [],
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
/**
 * MAKE A LINK LOOK LIKE ONE INSIDE THE TEXTAREA.
 *
 * Zach, 2026-09-08: *"now the hyperlinks work, but the appearance doesn't look like
 * hyperlink, the cursor hover too, i think for editing mode and preview mode they
 * should look different?"*
 *
 * **Yes, and they cannot help being different — the two modes hold different TEXT.**
 * Preview holds `換え` inside an `<a>`; the editor holds the literal 15 characters
 * `[[換え|C1p9g1mL]]`, because the markup is the thing he is editing. So preview gets
 * the link look (`.hashigo-card-link`: dotted underline, pointer, hover) and the
 * editor gets a look that says *this run of characters is one object* — a tinted box
 * around the whole span, brackets and id included.
 *
 * ─── WHY A MIRROR, AND WHY IT PAINTS NO TEXT ────────────────────────────────
 *
 * A `<textarea>` has no elements inside it, so a range within it cannot be styled —
 * the same fact that made ctrl+click read `selectionStart` instead of `closest("a")`.
 * The standard answer is a mirror: a div behind the field, laid out with the SAME
 * font, padding and wrapping, carrying the highlight.
 *
 * **Its text is `transparent` and the textarea's is not**, which is the opposite of
 * what a syntax highlighter does and is deliberate. Painting the mirror and hiding
 * the textarea's own text would allow colouring the brackets separately — and would
 * also mean the textarea's selection background covers the only visible copy of the
 * text, so selecting a word would make it disappear. Backgrounds and underlines
 * render fine under `color: transparent` (`text-decoration-color` is explicit), and
 * that is all this needs.
 *
 * ─── AND THE CURSOR, WHICH IS THE HALF HE ASKED ABOUT SECOND ────────────────
 *
 * Following a link here needs Ctrl held, so the affordance is armed rather than
 * constant: while Ctrl (or Cmd) is down over a field that HAS links, the boxes
 * brighten and the caret becomes a pointer. Never `cursor: pointer` unconditionally
 * — most of a field is not a link, and a pointer over plain prose is a lie.
 */
function attachLinkMirror(area: HTMLTextAreaElement): () => void {
  const shell = document.createElement("div");
  shell.className = "edit-field";
  area.replaceWith(shell);
  const mirror = document.createElement("div");
  mirror.className = "edit-mirror";
  // It is a copy of text that is already on screen and already reachable. A
  // screen reader meeting it twice would read every field twice.
  mirror.setAttribute("aria-hidden", "true");
  shell.append(mirror, area);

  const paint = (): void => {
    const text = area.value;
    const spans = linksIn(text);
    shell.classList.toggle("has-links", spans.length > 0);
    const parts: Node[] = [];
    let at = 0;
    for (const span of spans) {
      if (span.start > at) parts.push(document.createTextNode(text.slice(at, span.start)));
      const box = document.createElement("mark");
      box.className = "edit-link";
      box.textContent = span.raw;
      parts.push(box);
      at = span.end;
    }
    // The trailing "\n" is not decoration: a final newline in a `pre-wrap` block
    // is not laid out, so without it the mirror is one line short of the
    // textarea the moment he presses Enter at the end.
    parts.push(document.createTextNode(text.slice(at) + "\n"));
    mirror.replaceChildren(...parts);
    mirror.scrollTop = area.scrollTop;
  };

  const arm = (on: boolean): void => {
    shell.classList.toggle("mod", on);
  };

  area.addEventListener("input", paint);
  area.addEventListener("scroll", () => {
    mirror.scrollTop = area.scrollTop;
  });
  area.addEventListener("keydown", (event) => arm(event.ctrlKey || event.metaKey));
  area.addEventListener("keyup", (event) => arm(event.ctrlKey || event.metaKey));
  // He can hold Ctrl before touching the field, so the key events never reach it.
  shell.addEventListener("mousemove", (event) => arm(event.ctrlKey || event.metaKey));
  shell.addEventListener("mouseleave", () => arm(false));
  // A modifier held across a window switch is stuck down as far as this page is
  // concerned; blur is the only honest place to let it go.
  area.addEventListener("blur", () => arm(false));

  paint();
  return paint;
}

function attachLinkEditing(area: HTMLTextAreaElement, onSaveNeeded: () => void): void {
  const repaint = attachLinkMirror(area);
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
    // Setting `.value` fires no `input` event, so the mirror does not hear about
    // the link it just gained. Without this the box appears on his next keystroke.
    repaint();
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
    void ask<"browse">({
      kind: "browse",
      query: trigger.query,
      deckId: null,
      limit: 8,
      // A bare `@` is the palette's question in miniature: eight rows and nothing
      // typed. The alphabet spends all eight of them on numeric names.
      suggest: true,
      visited: readVisits(),
    }).then(
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
  if (reply.card === null) return;
  noteVisit(cardId);
  openEditorFor(reply.card, reply.templates);
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
        // The readout is where retention becomes a NUMBER. The tone says "this
        // day was below 0.85" and cannot say by how much; a quiet day says so in
        // words rather than showing "0 reviews · —% remembered".
        detail:
          day.reviews === 0
            ? `${day.date} · nothing reviewed`
            : `${day.date} · ${day.reviews.toLocaleString()} reviews · ` +
              `${pct(day.remembered / day.reviews)} remembered`,
      })),
    ),
  );

  // ── what is coming ──
  body.appendChild(glanceHead("scheduled, next 14 days"));
  body.appendChild(
    glanceBars(
      g.forecast.map((day) => ({
        label: day.date.slice(5),
        value: day.due,
        good: null,
        detail: `${day.date} · ${day.due.toLocaleString()} due`,
      })),
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

/** One column of a glance chart. `detail` is the sentence the readout says. */
interface GlanceColumn {
  readonly label: string;
  readonly value: number;
  readonly good: number | null;
  /** What this bar MEANS, in words. The only place its number is legible. */
  readonly detail: string;
}

/**
 * A bar row in CSS, with no chart library and no canvas.
 *
 * SPEC problem #1 is battery: this is the same reason the standalone dashboard
 * ships zero JavaScript. A `<div>` with a percentage height computes once at layout
 * and never again.
 *
 * ─── THE NUMBER HAS TO BE REACHABLE BY THUMB — Zach, 2026-09-14 ─────────────
 *
 * *"on mobile dashboard, there are bar charts, i want to see numbers when i press
 * them or hold"*. The figure was on `title` and nowhere else, which is a HOVER
 * affordance — the sole-carrier case decision 19 forbids, on the one screen with
 * no keycaps to excuse it. And it was worse than "hard to reach" on his handset:
 * the tick labels under the bars are `display: none` below 520px (two weeks of
 * dates do not fit 375px), so a bar on a phone carried **no number and no date at
 * all**. Fourteen anonymous rectangles.
 *
 * So every column is a real button and the chart carries a readout line above it.
 * **`pointerdown`, not `click`** — that is what makes "or hold" work with no timer
 * and no long-press gesture to learn: the readout fills the instant the finger
 * lands and stays until the next press, so holding and releasing both show it.
 * `click` is bound as well, for the keyboard, and is idempotent with it.
 *
 * The readout starts on the LAST column rather than empty. An empty line is a
 * band of blank space that has to be discovered before it explains anything, and
 * the most recent day — today's work, or tomorrow's load — is the one worth
 * reading unprompted.
 */
function glanceBars(days: readonly GlanceColumn[]): HTMLElement {
  const chart = document.createElement("div");
  chart.className = "glance-chart";
  // `output` with `aria-live`: a bar is a picture, and this line is the only form
  // of it a screen reader can read at all.
  const readout = document.createElement("output");
  readout.className = "glance-read";
  readout.setAttribute("aria-live", "polite");
  const bars = document.createElement("div");
  bars.className = "glance-bars";
  chart.append(readout, bars);

  const peak = Math.max(1, ...days.map((day) => day.value));
  const columns: HTMLButtonElement[] = [];
  const pick = (at: number): void => {
    columns.forEach((column, index) => {
      column.classList.toggle("is-picked", index === at);
      column.setAttribute("aria-pressed", index === at ? "true" : "false");
    });
    readout.textContent = days[at]?.detail ?? "";
  };

  days.forEach((day, index) => {
    const column = document.createElement("button");
    column.type = "button";
    column.className = "glance-col";
    // Kept for a pointer that has one, and repeated as the accessible name so the
    // button is not announced as an empty control.
    column.title = day.detail;
    column.setAttribute("aria-label", day.detail);
    column.setAttribute("aria-pressed", "false");
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
    column.addEventListener("pointerdown", () => pick(index));
    column.addEventListener("click", () => pick(index));
    columns.push(column);
    bars.appendChild(column);
  });

  if (days.length > 0) pick(days.length - 1);
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
  // FIRST, AND IT IS THE ONE ROW THAT DOES NOT WRITE TO THE DATABASE. Every
  // other setting here syncs between his two devices (decision 33); a theme must
  // not, because the laptop at his desk in the afternoon and the phone in bed at
  // night are different answers to the same question. See `app/theme.ts`.
  body.appendChild(themeRow());

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

/**
 * The theme picker — the same `.edit-row` shape as the six below it, so it does
 * not read as a different kind of thing, and a plainly different mechanism.
 *
 * `system` is a real choice rather than the absence of one. A phone that turns
 * dark at sunset is a feature he already has, and a two-way switch takes it away
 * the first time he touches it with no way back short of clearing site data.
 */
function themeRow(): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "edit-row";

  const label = document.createElement("span");
  label.className = "edit-label";
  label.textContent = "theme";
  const when = document.createElement("i");
  when.className = "edit-type";
  when.textContent = "at once · this device only";
  label.appendChild(when);
  wrap.appendChild(label);

  const select = document.createElement("select");
  select.className = "edit-input";
  for (const value of THEMES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = themeLabel(value);
    select.appendChild(option);
  }
  select.value = currentTheme;
  select.addEventListener("change", () => {
    applyTheme(readTheme(select.value));
  });
  wrap.appendChild(select);

  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    "Both grounds are measured for contrast in every colour this app puts text " +
    "in — decision 32 ships them as equals rather than one being the real one. " +
    "This does NOT sync: it is the one preference where his two devices should " +
    "be allowed to disagree.";
  wrap.appendChild(note);
  return wrap;
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
/**
 * The card's own `⋯` — and it is the DECK menu's pattern rather than a new one.
 *
 * The mockup that prompted this (2026-09-12) reaches for a popover on desktop
 * and a bottom sheet on mobile. That is two presentations to build, style, trap
 * focus in and keep in step, and this app already has one that works on both:
 * `openDeckMenu`'s modal `.layer-menu`, which he uses on every deck. Pressing
 * `⋯` on a card and on a deck landing in two different kinds of object is a
 * worse outcome than either shape on its own.
 *
 * `.menu-item`'s convention holds — a menu of DECISIONS, not a list of verbs, so
 * every row carries the sentence that says what it costs. The expensive one
 * still goes through `openConfirm` on top of this.
 *
 * The flags come from the module's own `currentPinned` / `currentArchived`
 * because the only caller is the review card's handle. They are the same two
 * values `paintCardOps` lights the handle with, so the menu cannot disagree with
 * the thing that opened it.
 */
function openCardMenu(cardId: string, name: string): void {
  const root = document.createElement("div");
  root.className = "layer layer-confirm layer-menu";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `${name} actions`);
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));

  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = name;
  const flags = [currentPinned ? "pinned" : "", currentArchived ? "archived" : ""].filter(
    (flag) => flag !== "",
  );
  const text = document.createElement("p");
  text.textContent =
    flags.length === 0 ? "Nothing flagged on this card." : `Currently ${flags.join(" and ")}.`;
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  const item = (label: string, note: string, run: () => void, danger = false): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item";
    if (danger) button.classList.add("danger");
    const bold = document.createElement("b");
    bold.textContent = label;
    const why = document.createElement("i");
    why.textContent = note;
    button.append(bold, why);
    button.addEventListener("click", () => {
      closeIfTop(root);
      run();
    });
    list.appendChild(button);
  };

  // FIRST, because it is the only item here he reaches for mid-review and the
  // only one that is not a flag. Decision 29's audit loop ends in an edit — the
  // `型` label surfaces an accent he had wrong and he promotes the card to
  // `Reading = true` — and until now that loop needed the `e` key, which his
  // phone does not have. His standing rule is that every 操作 on the desktop
  // exists on mobile as a real button; `e` was the last one that did not.
  //
  // `openEditorById` rather than `openEditorFor` with a card already in hand:
  // that is the same call `e` makes, so the two cannot drift into different
  // editors — see `openEditor`.
  item("edit", "the fields, the template, the deck", () => void openEditorById(cardId));

  item(
    currentPinned ? "unpin" : "pin",
    currentPinned ? "stop keeping it near the top" : "keep it near the top of a search",
    () => void runCardOp(currentPinned ? "unpin" : "pin", cardId),
  );

  item(
    currentArchived ? "unarchive" : "archive",
    currentArchived
      ? "put it back in the queue — its reviews were never touched"
      : "it stops being scheduled. Nothing is deleted and undo puts it back",
    () => void runCardOp(currentArchived ? "unarchive" : "archive", cardId),
  );

  item(
    "delete",
    "the card, its fields, its links and ALL of its review history",
    () => confirmDelete(cardId, name),
    true,
  );

  panel.appendChild(list);
  root.append(backdrop, panel);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  // `ops: false` like the deck menu: the single-key card operations must keep
  // meaning the REVIEW card, not this dialog. The dialog has buttons for them.
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
    // The climb stops with the screen it lives on, and the mark goes back to the
    // form `index.html` authored. A `requestAnimationFrame` loop left running
    // behind a hidden section is a wake-up every frame for the life of the
    // session — which is problem #1 in SPEC, on a phone.
    stopClimb();
    bootView.hidden = true;
    reviewView.hidden = false;
    // The rail is on screen from here at ≥1024px, so it has to have something in
    // it. Below that it is still a drawer and fills when it opens.
    if (railStanding.matches) fillSidebar();
    await showSessionCard();
  } catch (cause) {
    line(String((cause as Error).message), "bad");
    line("nothing was written. Fix the above and reload.", "bad");
  }
}

void boot();
