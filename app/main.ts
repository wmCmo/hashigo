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
  STALL_AFTER_MS,
  type Phase,
  type Rung,
  type Sample,
} from "./sync-climb.js";
import { mountPrepared, type MountedCard, type PreparedCard } from "../src/review/index.js";
import { ask, listenToWorker } from "./worker-client.js";
import {
  bareLayer,
  closeIfTop,
  closeTop,
  layerHost,
  layers,
  registerLayer,
  type Layer,
} from "./layers.js";
import { el } from "./dom.js";
import { checkEviction, checkPersistence, exportBackup } from "./backup-ui.js";
import {
  attachLinkEditing,
  confirmDelete,
  openEditorById,
  pushUndo,
  refreshAfterOp,
  runCardOp,
  runUndo,
  templateRow,
} from "./ops.js";
import {
  closeSidebar,
  fillSidebar,
  openSidebar,
  pushAfterBoot,
  railStanding,
  schedulePush,
  secondsLeft,
  syncAtBoot,
} from "./sidebar.js";
import { openGalleryFromUrl } from "./gallery.js";
import type { SyncProgress } from "./sync-client.js";
import { openPalette } from "./palette.js";
import { provideShell } from "./shell.js";
import { line, mib, say } from "./ui.js";
import { openVoiceDialog } from "./voice-dialog.js";
import { hydrateIcons, icon, opIcon, prependIcon, setIcon, type IconName } from "./icons.js";
import { cloudHeaders, cloudUrl, IN_CLOUD, SERVER_NAME } from "./cloud.js";
import { versionLabel } from "./version.js";
import { forgetMergedPeers } from "./sync-client.js";
import { attachDraw, type DrawHandle, type DrawSurface } from "../src/render/draw.js";
import {
  attachInput,
  type AnswerCheck,
  type InputHandle,
  type InputSurface,
} from "../src/render/input.js";
import type { RenderResult } from "../src/render/index.js";
import type { ShadowingSide } from "../src/render/reveal.js";
// Import-free rules `test/` can reach; see `test/app-logic.test.ts`.
import { isTypingTarget, type KeyTarget } from "./keys.js";
import { clearVisits, noteVisit } from "./visits.js";
import { mountClimb } from "./climb.js";
import { overdueLabel, overdueTitle } from "./overdue.js";
import { lastSeenLabel, lastSeenTitle } from "./last-seen.js";
import { barValueText, barWidths } from "./progress.js";
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
  TemplateChoice,
  ReplyFor,
} from "./protocol.js";

// ─── the page ────────────────────────────────────────────────────────────────

// The boot log and the seed-download readout. Subscribed first, so
// `worker-client.ts` can replay whatever the worker said before this ran.
listenToWorker({ log: (m) => line(m.text, m.level), fetching: showFetchProgress });
// What the extracted features still need from this file. `app/shell.ts` says why
// it is a port and not an import; every member is hoisted, so this is safe here.
provideShell({
  showSessionCard,
  restartReview: async () => {
    doneView.hidden = true;
    reviewView.hidden = false;
    await showSessionCard();
  },
  repaintReviewFlags,
  openPreview,
  paintLayerOps,
  openEditorFor,
});

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
const progressMiss = el("progressmiss");
const revealButton = el<HTMLButtonElement>("reveal");
const revealWord = el("revealword");
const forgotButton = el<HTMLButtonElement>("forgot");
const rememberedButton = el<HTMLButtonElement>("remembered");
const replayButton = el<HTMLButtonElement>("replay");
// Phosphor Light for every `data-icon` in the markup (app/icons.ts). The buttons
// keep their aria-labels and their words; the icons are aria-hidden.
hydrateIcons();
el("bootversion").textContent = versionLabel();
const readingButton = el<HTMLButtonElement>("readingtoggle");
const doneView = el("done");
const doneText = el("donetext");

/* Decision 32 §5. Built once, at rest, and stepped when a session is cleared —
   `mountClimb` draws the static mark, so the done screen is never blank while it
   waits for the animation. */
const climb = mountClimb(
  document.getElementById("climbmark") as unknown as SVGSVGElement,
);


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
/** True while `remountAfterEdit` redraws the card: the entry asks nothing aloud. */
let quietEntry = false;
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
  // Decision 6: name the basis. The denominator is answered-today PLUS what is left
  // in this device's plan (due and today's new tracks, `Session.progress`), so it
  // never equals the dashboard's "due now", which counts only what is still waiting.
  // 31/914 beside "876 due" was the two quantities, not a disagreement.
  progressLabel.title =
    `${reply.progress.answeredToday} answered of ${reply.progress.plannedToday} planned today` +
    (reply.progress.reasksRemaining > 0 ? ` · ${reply.progress.reasksRemaining} to see again` : "");

  // His request 4. The denominator is today's workload and NOT that plus reasks: a
  // decision-13 re-ask is a card he already answered, so counting it would make
  // the bar go BACKWARDS every time he forgets one. Re-asks are shown as the
  // `+2` beside the count instead, where a growing number reads correctly.
  //
  // AND THE MISSES, as a red prefix — his request of 2026-09-17. The arithmetic
  // (and the clamping the two numbers need) is `app/progress.ts`, which `test/`
  // can reach; this only writes the widths.
  const widths = barWidths(reply.progress);
  progressFill.style.width = `${widths.donePercent.toFixed(2)}%`;
  progressMiss.style.width = `${widths.missedPercent.toFixed(2)}%`;
  progressBar.setAttribute("aria-valuenow", String(widths.done));
  progressBar.setAttribute("aria-valuemax", String(widths.planned));
  // The bar is 2px of colour, so the misses have to be SAID as well as drawn.
  progressBar.setAttribute("aria-valuetext", barValueText(widths));

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
  if (reply.isNew) deckLine.appendChild(tag("new card", "newtag", "sparkle"));
  if (reply.reask) deckLine.appendChild(tag("again · not graded", "reasktag", "repeat-once"));
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
  if (reply.card.direction === "reverse") deckLine.appendChild(tag("reversed", "reversetag", "arrows-left-right"));
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
    const chip = tag(late, "latetag", "clock");
    chip.title = overdueTitle(reply.overdueDays, reply.dueAt);
    deckLine.appendChild(chip);
  }
  // WHEN HE LAST SAW IT — Zach, 2026-09-23: *"oh wow it's been 8 months since i
  // last reviewed this track"*. AFTER the late chip, because this one never
  // changes while the session is open and the one before it is the actionable
  // figure; and quiet for the same reason, since 9,085 of his tracks have a date
  // and nearly every reviewed card will carry one.
  //
  // A DIFFERENT NUMBER FROM THE ONE ABOVE. A year-interval track that fell due
  // three days ago is `due 3 days ago` and `Sep 20, 2025` — the late chip cannot
  // say how long it has been, which is the thing he asked for.
  const seen = lastSeenLabel(reply.lastReviewedAt);
  if (seen !== null) {
    const chip = tag(seen, "seentag", "calendar-blank");
    // Says what the date means: bare, beside `due 17 days ago`, it could be read
    // as a second due date.
    chip.title = lastSeenTitle(reply.lastReviewedAt) ?? "";
    deckLine.appendChild(chip);
  }

  readingButton.hidden = card.mode.readingFieldId === null;
  paintReadingButton(card.mode.reading);

  setState("prompt");
  revealWord.textContent = "reveal";
  prependIcon(revealButton, "eye");
  // The mode-aware entry. On a produce card this plays nothing; on an identify
  // card it asks the question and leaves every cloze masked. 編集後の描き直し
  // （`remountAfterEdit`）では鳴らさない — 保存しただけで音が出るのはおかしい。
  if (!quietEntry) for (const position of prompt) card.enter(position);

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

function tag(text: string, className: string, glyph?: IconName): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  // 2026-09-28: *"the new card and the reversed tag would also be easier to see
  // with the icons"*. The words stay; the shape is what the eye finds first.
  if (glyph !== undefined) prependIcon(span, glyph);
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
function runStep(
  card: MountedCard<HTMLElement>,
  step: RevealStep,
  silent = false,
): HTMLElement | null {
  const side = card.loop.side(step.position);
  if (side === null) return null;
  if (step.show) {
    side.element.hidden = false;
    // `loop.enter`, NOT `card.enter` — the mount's entry is the one that asks
    // decision 29's mode-2 question, and an answer side is not a question.
    card.loop.enter(step.position);
  }
  const mount = step.cloze === null ? undefined : side.clozes[step.cloze];
  if (mount !== undefined) side.revealCloze(mount, "caller", { silent });
  else side.reveal("caller", { silent });
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
    prependIcon(revealButton, "arrow-down");
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
      // Both weights, and CSS shows the Fill one while `data-clip="playing"` —
      // the "on" state is the same icon filled (app/icons.ts).
      button.append(icon("play"), icon("play-fill"));
      // A NEUTRAL name, never the clip's alt text. The alt is the word or the
      // sentence the clip SAYS — on a masked side, the answer — and it used to be
      // both the accessible name and the `title`, so hovering the button (or any
      // screen reader, or the accessibility tree) read out `たっぷり` while the cloze
      // still hid it. Found 2026-10-16 by reading the review screen's tree before a
      // reveal. The line beside the button is its real label, as decision 36 says;
      // this only has to say what pressing it does.
      button.setAttribute("aria-label", "play this clip");

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
      cardId: card.cardId,
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
    // A card made here fills its own gaps — see `autoFill`. Fire-and-forget: the
    // card is usable as it is, and the redraw comes when the fill lands.
    void autoFill(card.cardId);
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

/**
 * HOW LONG A GENERATION MAY SIT THERE BEFORE IT IS CALLED A FAILURE.
 *
 * Zach, 2026-09-18, on an English card: *"this one takes forever to generate"*.
 * A bare `fetch` has NO timeout, so every one of these buttons could sit on
 * `speaking…` — disabled, silent, unretryable — for as long as the link took to
 * give up, which on a phone that has wandered off the tailnet is minutes or
 * never. Nothing in the app could tell that from working.
 *
 * **This does not make anything faster, and it is not the fix for his card** —
 * that one is in `vite.generate.ts`, where the lookup was missing a clip the
 * laptop already had. This is what makes the NEXT one legible: a bounded wait,
 * a sentence saying how long it waited, and the button put back so he can press
 * it again.
 *
 * Two budgets, because the two paths have honestly different shapes. MEASURED
 * on the laptop 2026-09-18, his own sentence: the Google call is **329 ms** and
 * a cache hit serving a 188 KB clip is **9 ms**, so 30 s is roughly a hundred
 * times the expected cost — long enough that a slow phone link is never cut off,
 * short enough to be a wait rather than a hang. A text field can reach Opus or a
 * local Ollama model, where tens of seconds is ordinary work rather than a
 * stall, so it gets four times as long.
 */
const CLIP_TIMEOUT_MS = 30_000;
const TEXT_TIMEOUT_MS = 120_000;

/**
 * `fetch` with a deadline, and a sentence for the two ways it ends badly.
 *
 * `AbortSignal.timeout` raises a `TimeoutError`, which is indistinguishable from
 * any other abort at the call site unless it is named here — and "it timed out"
 * and "the laptop is not reachable" send him to two different places.
 */
async function askLaptop(
  body: unknown,
  timeoutMs: number,
): Promise<{ response: Response } | { failure: string }> {
  const started = performance.now();
  // `AbortSignal.timeout` IS NOT ASSUMED, and the reason is his phone. It needs
  // Samsung Internet 20 (Chromium 103), and calling it where it is absent throws
  // a TypeError SYNCHRONOUSLY — so a browser one version too old would not get a
  // slow button, it would get a button that does nothing at all, which is
  // strictly worse than the unbounded wait this replaces. Verified present in
  // the dev browser (Chrome 152, raises `TimeoutError` at 1,014 ms for a 1,000 ms
  // budget); the fallback is for the device I cannot test from here.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(cloudUrl(GENERATE_ENDPOINT), {
      method: "POST",
      headers: cloudHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { response };
  } catch (cause) {
    const waited = ((performance.now() - started) / 1000).toFixed(0);
    // `timedOut`, not the error's name: an abort reports itself as `AbortError`
    // here and as `TimeoutError` under `AbortSignal.timeout`, and the flag is the
    // one thing both spellings agree on.
    return {
      failure: timedOut
        ? IN_CLOUD
          ? `Cloudflare did not answer in ${waited}s — this device may be offline. Press again to retry.`
          : `the laptop did not answer in ${waited}s — it may be asleep, or off the tailnet. Press again to retry.`
        : `could not reach ${SERVER_NAME}: ${(cause as Error).message}`,
    };
  } finally {
    // Or a 120 s text budget keeps the page awake for two minutes after a reply.
    clearTimeout(timer);
  }
}

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
  request: {
    text: string;
    lang: string | null;
    voice: string | null;
    options: Readonly<Record<string, string>>;
  },
  button: HTMLButtonElement,
  clipButton: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  const was = button.textContent;
  button.textContent = "speaking…";
  try {
    // `voice` IS SENT NOW, AND IT USED TO BE DROPPED. The endpoint keys its
    // cache on the voice; without this it could only ever look under the fill
    // voice, so 141 clips that exist on the laptop — 45 of them English — were
    // re-synthesised on every press, in Japanese. `vite.generate.ts` carries the
    // measurement.
    const attempt = await askLaptop(
      {
        kind: "speech",
        text: request.text,
        lang: request.lang,
        voice: request.voice,
        options: request.options,
      },
      CLIP_TIMEOUT_MS,
    );
    if ("failure" in attempt) {
      say(attempt.failure, true);
      button.disabled = false;
      button.textContent = was;
      return;
    }
    const response = attempt.response;
    // The status before the body, for the reason `requestGeneration` records at
    // length: an empty 404 parsed as JSON reaches him as "Unexpected end of JSON
    // input", which names neither the status nor the cause.
    const raw = await response.text();
    let body: {
      audio?: string;
      error?: string;
      cached?: boolean;
      voice?: string;
      mismatch?: string;
    } = {};
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
            : `${SERVER_NAME} said ${response.status} ${response.statusText}`),
        true,
      );
      button.disabled = false;
      button.textContent = was;
      return;
    }
    await ask<"storeClip">({
      kind: "storeClip",
      slot: {
        text: request.text,
        lang: request.lang,
        // The producing voice, from the laptop. Undefined falls back to the fill
        // voice in `storeGeneratedSpeech`, which is right for anything it made.
        voice: body.voice ?? null,
        options: request.options,
      },
      audio: body.audio,
    }).catch(() => undefined);
    button.remove();
    clipButton.disabled = false;
    // SAY WHICH IT WAS. A clip that came off the laptop's disk in the card's own
    // voice and one Google just made in Japanese sound different and cost
    // different things, and until now the screen said neither.
    if (body.mismatch !== undefined) say(body.mismatch, true);
    else if (body.cached === true) say(`already on ${SERVER_NAME} — ${body.voice ?? "fill voice"}`);
    // Re-ask for the bytes, now that both stores have them.
    // `ShadowingSide.play` takes the MOUNT, not a reason — it is the per-clip
    // control decision 36 added, and `{ unmask: false }` is `prompt()`'s
    // contract: a mode-2 card's answer stays behind its cloze.
    const side = card.loop.sides.find((entry) => entry.index === mount.side);
    side?.play(mount, { unmask: false });
  } catch (cause) {
    say(`could not reach ${SERVER_NAME} to generate: ${(cause as Error).message}`, true);
    button.disabled = false;
    button.textContent = was;
  }
}

/**
 * "REDO A CLIP" — discard a clip on this card and make a new one.
 *
 * Zach, 2026-09-26: *"the audio of 日向 example sentence read it as みゅー、、、 i need
 * a way to discard that audio and regenerate it"*. That clip was made by Google
 * itself, and Google answers the same input with the same audio, so a plain
 * "again" would repeat the misreading. A redo therefore:
 *
 *   1. asks the worker which clip the card plays now and how the CARD reads its
 *      word (`読み`, else the derived reading — what the ojad line already used);
 *   2. asks the Worker for a NEW clip (`force`), with that reading as SSML
 *      `<sub>` so the voice says ひなた for 日向;
 *   3. files it with `retire` — the old clip stops matching any lookup but keeps
 *      its bytes (`src/blobs/retire.ts`), and sync and the laptop pull carry the
 *      retirement everywhere else;
 *   4. redraws the card, because a clip that has played once stays attached to
 *      its button and would otherwise keep playing the old audio.
 *
 * In the card menu rather than beside every clip: the review screen stays as it
 * was (decision 36's one control per clip), and a redo is a rare, deliberate act.
 */
function openRedoDialog(card: MountedCard<HTMLElement>): void {
  const clips = card.result.media
    .map((mount) => ({ mount, address: audioAddress(card.result, mount) }))
    .filter(
      (entry): entry is { mount: typeof entry.mount; address: Extract<NonNullable<typeof entry.address>, { origin: "generator" }> } =>
        entry.address !== null && entry.address.origin === "generator" && entry.address.request.kind === "speech",
    );

  const root = document.createElement("div");
  root.className = "layer layer-confirm layer-menu";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "redo a clip");
  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  const panel = document.createElement("div");
  panel.className = "confirm-panel";
  const heading = document.createElement("h2");
  heading.textContent = "Redo a clip";
  const text = document.createElement("p");
  text.textContent =
    clips.length === 0
      ? "This card has no generated clips to redo."
      : "The old clip is retired, not deleted, and the new one is told how this card reads its word.";
  panel.append(heading, text);

  const list = document.createElement("div");
  list.className = "menu-list";
  for (const { mount, address } of clips) {
    const request = address.request;
    const row = document.createElement("div");
    row.className = "redo-row";
    const label = document.createElement("span");
    label.className = "redo-text";
    label.textContent = request.text.replace(/\s+/g, " ").trim().slice(0, 80);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "clip";
    play.setAttribute("aria-label", `play ${mount.alt}`);
    play.append(icon("play"), icon("play-fill"));
    play.addEventListener("click", () => {
      const side = card.loop.sides.find((entry) => entry.index === mount.side);
      side?.play(mount, { unmask: false });
    });
    const redo = document.createElement("button");
    redo.type = "button";
    redo.className = "gcard-op";
    redo.append(icon("arrows-clockwise"), document.createTextNode(" redo"));
    redo.addEventListener("click", () => void redoClip(card, request, redo));
    row.append(play, label, redo);
    list.appendChild(row);
  }
  panel.appendChild(list);
  root.append(backdrop, panel);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  registerLayer(bareLayer(root));
}

async function redoClip(
  card: MountedCard<HTMLElement>,
  request: { text: string; lang: string | null; voice: string | null; options: Readonly<Record<string, string>> },
  button: HTMLButtonElement,
): Promise<void> {
  const info = await ask<"redoInfo">({
    kind: "redoInfo",
    cardId: card.cardId,
    request: { text: request.text, lang: request.lang, voice: request.voice, options: request.options },
  });
  const reading = info.readings[0];
  const confirmText = button.dataset["armed"] === "yes";
  if (!confirmText) {
    // Two presses, the second one saying what will happen — one line, in place,
    // rather than a dialog over the dialog.
    button.dataset["armed"] = "yes";
    button.replaceChildren(
      icon("arrows-clockwise"),
      document.createTextNode(
        reading === undefined ? " discard + redo?" : ` discard, redo reading ${reading.base} as ${reading.alias}?`,
      ),
    );
    return;
  }
  button.disabled = true;
  button.replaceChildren(document.createTextNode("speaking…"));
  const attempt = await askLaptop(
    {
      kind: "speech",
      text: request.text,
      lang: request.lang,
      voice: request.voice,
      options: request.options,
      force: true,
      readings: info.readings,
      ...(info.hash === null ? {} : { replaces: info.hash }),
    },
    CLIP_TIMEOUT_MS,
  );
  if ("failure" in attempt) {
    say(attempt.failure, true);
    button.disabled = false;
    button.replaceChildren(icon("arrows-clockwise"), document.createTextNode(" redo"));
    delete button.dataset["armed"];
    return;
  }
  const raw = await attempt.response.text();
  let body: { audio?: string; voice?: string; error?: string } = {};
  try {
    body = raw === "" ? {} : (JSON.parse(raw) as typeof body);
  } catch {
    /* the status is the story */
  }
  if (!attempt.response.ok || typeof body.audio !== "string") {
    say(body.error ?? `${SERVER_NAME} said ${attempt.response.status}`, true);
    button.disabled = false;
    button.replaceChildren(icon("arrows-clockwise"), document.createTextNode(" redo"));
    delete button.dataset["armed"];
    return;
  }
  const stored = await ask<"storeClip">({
    kind: "storeClip",
    slot: { text: request.text, lang: request.lang, voice: body.voice ?? null, options: request.options },
    audio: body.audio,
    ...(info.hash === null ? {} : { retire: info.hash }),
  });
  closeIfTop(button.closest(".layer") as HTMLElement);
  if (stored.same === true) {
    say("Google gave back the same clip, so it was kept. The misreading needs a different voice or wording.", true);
    return;
  }
  say(`redone in ${body.voice ?? "the fill voice"}${reading === undefined ? "" : ` — ${reading.base} read as ${reading.alias}`}`);
  // Redraw, so the card plays the new clip rather than the one still attached
  // to its button.
  await showCardAt();
}

/**
 * AUTO-FILL: A CARD MADE HERE GETS ITS GENERATIONS WITHOUT A TAP.
 *
 * Zach, 2026-10-21, after his first 漢検 cards came up with an example-sentence
 * side reading `<<Translate>>` `<<Audio>>` and a "generate" button: *"those things
 * that automatically generates should also be created when we created the card,
 * no need to wait for users to click it"*.
 *
 * ─── ONLY FOR CARDS CREATED IN THIS APP ─────────────────────────────────────
 *
 * The worker answers for `cards.local = 1` and nothing else. The 785 clips and
 * 1,311 texts Mochi never made are a different matter, and his: audio
 * regeneration happens after the app is finished (CLAUDE.md, "do not ask again"
 * #2). A screen that silently synthesised them on view would spend his money on
 * a decision he has made the other way.
 *
 * ─── A LOOP, BECAUSE THE FIELDS CHAIN ───────────────────────────────────────
 *
 * 単語's `Translate` and `Audio` read `例文`, which is itself generated, so their
 * requests do not exist until the sentence does. Each pass asks the worker what
 * is still missing (`cardGaps`, which renders against what is stored NOW), fills
 * it, and asks again. Three passes covers the deepest chain any template has
 * (field → ai → translate/speech) with one to spare; a pass that makes nothing
 * stops it.
 *
 * ─── WHEN ───────────────────────────────────────────────────────────────────
 *
 * When the editor closes, which is the end of "creating the card" — a new card is
 * a name until its fields are typed in — and whenever such a card is shown. The
 * second is what reaches his OTHER device: a generation is filed where it was
 * made and in the Worker's KV, not in the sync payload, so the phone asks too and
 * the Worker answers from its cache (`cloud/mailbox/src/generate.ts`, "ALREADY
 * THERE?") without making anything twice. Once per card per session on view; the
 * editor's close always runs, because an edit can change what a generator reads.
 *
 * Nothing here PLAYS. Filing a clip is not sounding one; the hard rule is about
 * the second (decision 29).
 */
const autoFilling = new Set<string>();
const autoFillTried = new Set<string>();

async function autoFill(cardId: string, options: { readonly force?: boolean } = {}): Promise<void> {
  if (autoFilling.has(cardId)) return;
  if (options.force !== true && autoFillTried.has(cardId)) return;
  autoFilling.add(cardId);
  autoFillTried.add(cardId);
  let made = 0;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const reply = await ask<"cardGaps">({ kind: "cardGaps", cardId });
      if (!reply.local || reply.gaps.length === 0) break;
      let progress = 0;
      // Sequential, for `fill-generations.ts`'s reason: a 429 halfway through
      // costs more than the seconds a parallel burst would save.
      for (const gap of reply.gaps) {
        const result = await generateGap(gap);
        if ("failure" in result) {
          say(`could not fill this card's generated parts: ${result.failure}`, true);
          return;
        }
        if ("text" in result) {
          await ask<"storeGeneration">({ kind: "storeGeneration", cardId, slot: gap, text: result.text });
        } else {
          await ask<"storeClip">({
            kind: "storeClip",
            slot: { text: gap.text, lang: gap.lang, voice: result.voice, options: gap.options },
            audio: result.audio,
          });
        }
        progress += 1;
      }
      made += progress;
      if (progress === 0) break;
    }
  } catch (cause) {
    say(`could not fill this card's generated parts: ${(cause as Error).message}`, true);
  } finally {
    autoFilling.delete(cardId);
    if (made > 0) await redrawFilled(cardId, made);
  }
}

/** One generation from the Worker, read the way `requestGeneration` / `requestClip` read it. */
async function generateGap(gap: {
  readonly kind: string;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
}): Promise<{ text: string } | { audio: string; voice: string | null } | { failure: string }> {
  const speech = gap.kind === "speech";
  const attempt = await askLaptop(
    { kind: gap.kind, text: gap.text, lang: gap.lang, voice: gap.voice, options: gap.options },
    speech ? CLIP_TIMEOUT_MS : TEXT_TIMEOUT_MS,
  );
  if ("failure" in attempt) return attempt;
  const response = attempt.response;
  // Status before body — `requestGeneration` records what parsing first cost.
  const raw = await response.text();
  let body: { text?: string; audio?: string; voice?: string; error?: string } = {};
  try {
    body = raw === "" ? {} : (JSON.parse(raw) as typeof body);
  } catch {
    /* not ours — the status is the story */
  }
  const value = speech ? body.audio : body.text;
  if (!response.ok || typeof value !== "string" || value === "") {
    return { failure: body.error ?? `${SERVER_NAME} said ${response.status} ${response.statusText}` };
  }
  return speech ? { audio: value, voice: body.voice ?? null } : { text: value };
}

/** Show what was filled: the review card in place, or a preview of it reopened. */
async function redrawFilled(cardId: string, made: number): Promise<void> {
  say(`filled ${made} generated part${made === 1 ? "" : "s"} of this card`);
  await remountAfterEdit(cardId);
  const top = layers.at(-1);
  if (top !== undefined && top.ops && top.cardId === cardId) {
    closeTop();
    await openPreview(cardId);
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
    const attempt = await askLaptop(
      {
        kind: slot.kind,
        text: slot.text,
        lang: slot.lang,
        voice: slot.voice,
        options: slot.options,
      },
      TEXT_TIMEOUT_MS,
    );
    if ("failure" in attempt) {
      say(attempt.failure, true);
      button.disabled = false;
      button.textContent = was;
      return;
    }
    const response = attempt.response;
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
          : `${SERVER_NAME} said ${response.status} ${response.statusText}`);
      say(reason, true);
      button.disabled = false;
      button.textContent = was;
      return;
    }
    // Cache it here too. A failure to cache is logged by the worker and does not
    // stop the text reaching the card — he asked for it, he should see it.
    await ask<"storeGeneration">({
      kind: "storeGeneration",
      // So the worker can refresh THIS card's search text now, rather than the
      // sentence staying unfindable until the next rebuild.
      cardId: card.cardId,
      slot,
      text: body.text,
    }).catch(
      () => undefined,
    );
    button.remove();
    card.fillText(card.textSlots.map((s) => (s === slot ? body.text! : null)));
    if (card === mounted) scaleSides(card);
  } catch (cause) {
    say(`could not reach ${SERVER_NAME} to generate: ${(cause as Error).message}`, true);
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

/**
 * `Reading` をスイッチの形で見せる。以前は「Reading → true」と押した後の値を文字で
 * 書いていたが、スイッチは今の値を示す — 塗りのトグルが true、線のトグルが false。
 */
function paintReadingButton(value: boolean): void {
  readingButton.setAttribute("aria-pressed", String(value));
  readingButton.title = value
    ? "Reading = true — press to make it false"
    : "Reading = false — press to make it true";
}

/** Decision 29's audit loop, without leaving the session. */
async function flipReading(): Promise<void> {
  const card = mounted;
  if (card === null || card.mode.readingFieldId === null || currentCardId === null) return;
  const value = !card.mode.reading;
  readingButton.disabled = true;
  try {
    await ask<"reading">({ kind: "reading", cardId: currentCardId, value });
    paintReadingButton(value);
    // The change takes effect on the card's NEXT appearance, not mid-reveal:
    // re-mounting now would re-render the thing he is looking at underneath him.
    hintLine.textContent = `Reading = ${value} — takes effect next time this card comes up`;
  } finally {
    readingButton.disabled = false;
  }
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
// Chromium はインストール済みのアプリに永続化を許す。起動時に一度断られていても、
// 入れた直後にもう一度頼めば次の起動を待たずに警告が消える。
window.addEventListener("appinstalled", () => void checkPersistence());

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

/**
 * Re-read the REVIEW card's pin and archive flags and repaint its handle.
 *
 * Its own function so that `./ops.ts` can ask for it after an operation without
 * ever reading or writing the review screen's state: those three variables are
 * this file's, and an import cannot be assigned to.
 */
async function repaintReviewFlags(): Promise<void> {
  if (currentCardId === null) return;
  const state = await ask<"preview">({ kind: "preview", cardId: currentCardId });
  currentPinned = state.pinned;
  currentArchived = state.archived;
  paintCardOps();
}

moreButton.addEventListener("click", () => {
  if (currentCardId !== null) {
    openCardMenu(currentCardId, previewOfCurrent?.loaded.name ?? currentCardId);
  }
});

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

/** ボタンの文言の span。先頭はアイコンなので `firstChild` ではもう届かない。 */
function opLabel(button: HTMLElement): HTMLElement {
  return button.querySelector<HTMLElement>(".op-label") ?? button;
}

function paintShadowbar(): void {
  loopButton.classList.toggle("on", playbackState.loop);
  loopButton.setAttribute("aria-pressed", String(playbackState.loop));
  opLabel(speedButton).textContent = speedLabel(playbackState.rate);
  // Normal speed is the ABSENCE of a setting, so it does not light up.
  speedButton.classList.toggle("on", playbackState.rate !== 1);

  const labels = takeLabels(takeState);
  opLabel(recordButton).textContent = labels.record;
  recordButton.disabled = labels.recordDisabled;
  recordButton.classList.toggle("arm", takeState === "recording");
  recordButton.title =
    takeState === "denied"
      ? "no microphone here — the permission was refused, or this browser has none"
      : "record yourself saying it, then play both back";
  takeButton.hidden = labels.take === null;
  if (labels.take !== null) opLabel(takeButton).textContent = labels.take;
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
  setIcon(close, "x");
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
    registerLayer({
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
  registerLayer(layer);
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
  // `delete` FIRST, the far end from ✕. It used to be last, one 8px gap from the
  // close button — the control he presses on every preview sat beside the one that
  // takes a card's whole review history, and on a phone the two are a thumb apart.
  // `confirmDelete` still asks; this keeps the near-miss from reaching that dialog.
  const buttons: readonly (readonly [string, boolean, () => void])[] = [
    [
      "delete",
      false,
      () => confirmDelete(layer.cardId, layer.prepared?.loaded.name ?? layer.cardId),
    ],
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
  ];
  for (const [label, on, run] of buttons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "layer-op";
    if (on) button.classList.add("on");
    if (label === "delete") button.classList.add("danger");
    button.textContent = label;
    const glyph = opIcon(label);
    if (glyph !== null) prependIcon(button, glyph);
    button.addEventListener("click", run);
    host.appendChild(button);
  }
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

/**
 * A TAG BEHAVES LIKE A LINK AND LOOKS UNLIKE ONE — Zach, 2026-09-18:
 * *"i want the tag to behave like hyperlink too, but looks different than like
 * hyperlink"*.
 *
 * The behaviour is here; the look is `.hashigo-tag` in `app/style.css`.
 *
 * A tap opens the palette SCOPED to the tag — its cards and its children's, with
 * anything typed then searching within them (`openPalette(tagPath)`,
 * `scopeToTag` in `./deck-scope.ts`). The first cut seeded the search box with
 * the tag's name instead and returned 18 cards for `#Mathematics` where 9 carry
 * the tag; a link that lands next to its answer is not a link.
 *
 * Capture phase on the document, exactly as the card-link handler above it, so
 * it works inside review AND inside any layer without per-layer wiring.
 */
document.addEventListener(
  "click",
  (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
      `a.${CLASS.tag}`,
    );
    if (anchor === null || anchor === undefined) return;
    const path = anchor.getAttribute("data-tag");
    if (path === null) return;
    event.preventDefault();
    event.stopPropagation();
    openPalette(path);
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
  // From a PREVIEW of this card, the editor takes its place instead of stacking
  // on it — see `openEditorFor`'s `fromPreview`. From the review screen there is
  // no preview to replace and it opens as it always did.
  const top = layers.at(-1);
  const replacing = top !== undefined && top.ops && top.cardId === target.card.cardId ? top.root : undefined;
  void openEditorById(target.card.cardId, replacing === undefined ? {} : { replacing });
}

function openEditorFor(
  card: PreparedCard,
  choices: readonly TemplateChoice[] = [],
  options: { readonly fromPreview?: boolean } = {},
): void {
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
  setIcon(close, "x");
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
    /**
     * WHAT IS ON DISK NOW, not what was there when the editor opened. The blur
     * check used to compare against `value` — captured once, never updated — so
     * edit → blur (saved) → type it back to the original → blur compared equal and
     * wrote NOTHING: the screen showed the original and the database kept the
     * edit. Found 2026-09-24 when a test's own restore silently failed.
     */
    let saved = value;
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
      // Recorded before the round trip so a second blur mid-flight does not send
      // it twice; rolled back below if the worker refuses, so a failed save is
      // retried on the next blur instead of being remembered as written.
      const before = saved;
      saved = next;
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
          // The card in front of him is NOT re-rendered while the editor is open —
          // re-mounting mid-edit would move the thing he is typing into. Closing
          // the editor redraws it (`remountAfterEdit`).
        })
        .catch((cause: Error) => {
          if (saved === next) saved = before;
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
        if (area.value !== saved) save(area.value);
      });
      row.appendChild(area);
      // Obsidian-style `[[` / `@` completion, and ctrl+click to follow a link into
      // its own editor. Only on the text kinds: a `number` field holds digits and a
      // `boolean` is a checkbox, so neither can contain a link.
      if (field.type === "plain" || field.type === "text") {
        attachLinkEditing(
          area,
          () => {
            if (area.value !== saved) save(area.value);
          },
          // A card made from this field's `[[` starts where THIS card is. He changes
          // the template on the way (貫く is 単語, 貫 will be 漢字) and the deck
          // follows it — see `openNewCardDialog`.
          { deckId: card.loaded.deckId, templateId: card.loaded.templateId },
        );
      }
    }
    body.appendChild(row);
  }

  body.appendChild(status);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  /**
   * THE EDITOR IS A MODE OF THE PREVIEW, NOT A LAYER ON TOP OF IT — Zach,
   * 2026-09-24: *"when i pressed e … it should just turn the current preview modal
   * to the editing, so that once we save the editing and close it it now renders
   * the changes without going stale"*.
   *
   * It used to STACK: the preview stayed underneath, rendered from the text before
   * the edit, and every way out except Ctrl+Enter (✕, Escape, the backdrop)
   * uncovered it. Now `e` replaces the preview (`openEditorById`, `replacing`), and
   * closing the editor — by any route — turns it back into a FRESH preview.
   *
   * `showPreview` starts true when it came from a preview and is set by Ctrl+Enter
   * otherwise, since Ctrl+Enter always means "done, show me the card".
   */
  let showPreview = options.fromPreview === true;
  const flushFields = (): void => {
    // EVERY field, by dispatch, not by focus: with the window unfocused no blur
    // event fires on its own, and an edit was dropped while the preview opened as
    // if nothing had changed (measured). Each field writes only if its text
    // differs from what is on disk, so untouched fields send nothing.
    for (const area of root.querySelectorAll<HTMLTextAreaElement>("textarea.edit-input")) {
      area.dispatchEvent(new Event("blur"));
    }
  };
  // `ops: false` — this is the EDITOR. See `Layer.ops`.
  registerLayer({
    root,
    mounted: null,
    prepared: null,
    cardId: card.cardId,
    ops: false,
    pinned: false,
    archived: false,
    onClose: () => {
      // Saves first, and the worker answers in order — so the preview asked for
      // next is rendered from the saved text, never the stale one.
      flushFields();
      // The end of making (or editing) a card, so its generations are made now —
      // forced, because the edit may have changed what a generator reads.
      void autoFill(card.cardId, { force: true });
      void remountAfterEdit(card.cardId);
      if (!showPreview) return;
      // A preview of this card still underneath (it can only get there by some
      // path that stacked) would now show old text; close it before opening fresh.
      const under = layers.at(-1);
      if (under !== undefined && under.ops && under.cardId === card.cardId) closeTop();
      void openPreview(card.cardId);
    },
  });
  // AFTER the layer is in the document: `scrollHeight` is 0 on a detached node,
  // so sizing at creation time would collapse every field to one line.
  for (const area of body.querySelectorAll("textarea.edit-input")) {
    fitTextarea(area as HTMLTextAreaElement);
  }
  (body.querySelector(".edit-input, .edit-check") as HTMLElement | null)?.focus();

  /**
   * CTRL+ENTER: DONE — save, close the editor, show the card. Zach, 2026-09-24:
   * *"usually on mochi, once i do ctrl + enter, it would close the edit modal and
   * show the card preview right away"*.
   *
   * CAPTURE PHASE on the layer, so it wins over every field inside it — including
   * the link picker, which used to claim Ctrl+Enter for "follow the link under the
   * caret". That binding was an agent's (bdffa59, 2026-09-07), recorded in no
   * decision, and it collided with his routine exactly: finishing a `[[` link
   * leaves the caret INSIDE `[[貫|…]]`, so his habitual Ctrl+Enter would have
   * opened the linked card instead of closing this one. Ctrl+click still follows.
   *
   * Saving and the fresh preview are the layer's `onClose` (above), shared with
   * every other way of closing the editor.
   */
  root.addEventListener(
    "keydown",
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (layers.at(-1)?.root !== root) return;
      // Saving and the fresh preview both live in this layer's `onClose`, so every
      // way out behaves the same; Ctrl+Enter only adds "and show me the card".
      showPreview = true;
      (document.activeElement as HTMLElement | null)?.blur();
      closeTop();
    },
    { capture: true },
  );
}

/**
 * 編集を閉じたら、復習中のカードを保存後の内容で描き直す。Zach, 2026-09-27:
 * *"when i review and i edit the card … and i close the edit modal, the card
 * rendering doesn't update until i refresh"*.
 *
 * 以前は意図的に描き直さなかった（編集中に描き直すと打っている場所が動く）。
 * それは編集が開いている間の話で、閉じた後は理由がない。
 *
 * 見た目の位置は保つ: 歩き（reveal の段）をどこまで進めていたかを覚えておき、
 * 描き直した後に同じ段まで黙って進める。音は一切鳴らさない — mode 2 の問いも、
 * 段の最後で鳴るクリップも。聞き直すなら再生ボタンがある。編集で段の数が減って
 * いたら、ある分だけ進める。
 *
 * `ask` は worker が順番に答えるので、直前の blur で送った保存より後に
 * `next` が処理され、描き直しは必ず保存後の内容になる（プレビューと同じ理屈）。
 */
async function remountAfterEdit(cardId: string): Promise<void> {
  if (currentCardId !== cardId || reviewView.hidden) return;
  const walked = stepIndex;
  const scroll = window.scrollY;
  quietEntry = true;
  try {
    await showCardAt();
  } finally {
    quietEntry = false;
  }
  const card = mounted;
  if (card === null || currentCardId !== cardId) return;
  while (stepIndex < Math.min(walked, steps.length)) {
    const step = steps[stepIndex]!;
    stepIndex += 1;
    runStep(card, step, true);
  }
  if (walked > 0) settleReveal(card);
  window.scrollTo({ top: scroll });
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

// ─── the review card's own menu ──────────────────────────────────────────────────

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
  const item = (
    glyph: IconName,
    label: string,
    note: string,
    run: () => void,
    danger = false,
  ): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-item has-icon";
    if (danger) button.classList.add("danger");
    const bold = document.createElement("b");
    bold.textContent = label;
    const why = document.createElement("i");
    why.textContent = note;
    button.append(icon(glyph), bold, why);
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
  item("pencil-simple", "edit", "the fields, the template, the deck", () => void openEditorById(cardId));

  item(
    currentPinned ? "push-pin-slash" : "push-pin",
    currentPinned ? "unpin" : "pin",
    currentPinned ? "stop keeping it near the top" : "keep it near the top of a search",
    () => void runCardOp(currentPinned ? "unpin" : "pin", cardId),
  );

  item(
    currentArchived ? "box-arrow-up" : "archive",
    currentArchived ? "unarchive" : "archive",
    currentArchived
      ? "put it back in the queue — its reviews were never touched"
      : "it stops being scheduled. Nothing is deleted and undo puts it back",
    () => void runCardOp(currentArchived ? "unarchive" : "archive", cardId),
  );

  // Stage E. A preference about NEW clips, priced before it is set — see
  // `./voice-dialog.ts`. Below the flags because it is rarer than they are.
  item("speaker-high", "voice", "which voice this card's new clips are made in", () =>
    openVoiceDialog("card", cardId, name),
  );

  // Only for the card actually on the review screen — the dialog plays and redoes
  // the MOUNTED clips, and the menu can also be opened for a card that is not.
  if (mounted !== null && mounted.cardId === cardId) {
    const card = mounted;
    item("arrows-clockwise", "redo a clip", "discard a clip that sounds wrong and make a new one", () => openRedoDialog(card));
  }

  item(
    "trash",
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
  registerLayer(bareLayer(root));
  (list.firstElementChild as HTMLElement | null)?.focus();
}

// ─── boot ────────────────────────────────────────────────────────────────────────

// ─── 起動時の同期を、種と同じ画面で — Zach, 2026-10-09 ──────────────────────
//
// 理由と規則は `sidebar.ts` の `syncAtBoot`。ここは画面の半分だけ。
//
// 種のダウンロードと同じ要素（はしごの動き、段階、バー、残り時間、止まった時の
// 一文）を使う。二つ目の待ち画面を作らないのは、彼にとってどちらも「開く前に
// 待つもの」で、違う顔をしている理由が無いから。GATE_MS も同じ — 変わった端末が
// 無い普通の起動では、一覧を聞くだけで何も見せずに通る。
const STAGE_WORDS: Readonly<Record<SyncProgress["stage"], string>> = {
  checking: "Checking your other devices",
  downloading: "Getting grades from your other devices",
  merging: "Merging them into this device",
  sending: "Sending this device's grades",
};
const bootSkip = el("bootskip");

/** 取り込んだ採点の数を返す。 */
async function bootSync(): Promise<number> {
  const abort = new AbortController();
  const startedAt = performance.now();
  let latest: SyncProgress | null = null;
  let lastBytesAt = startedAt;
  let lastReceived = 0;
  // バーは戻らない。見積もりは段階ごとに出し直すので、そのまま描くと揺れる。
  let shownFraction = 0;

  const paint = (): void => {
    if (climbShownAt === null) return;
    const now = performance.now();
    const progress = latest;
    const stage = progress?.stage ?? "checking";
    bootPhase.textContent =
      stage === "downloading" || stage === "merging"
        ? `${STAGE_WORDS[stage]} · ${progress?.peer ?? 0} of ${progress?.peers ?? 0}`
        : STAGE_WORDS[stage];
    const eta = progress?.etaSeconds ?? null;
    let fraction: number | null = null;
    if (eta !== null) {
      const elapsed = (now - startedAt) / 1000;
      fraction = elapsed / (elapsed + eta);
    } else if (stage === "downloading" && progress !== null && progress.total > 0) {
      fraction = progress.received / progress.total;
    }
    if (fraction !== null) shownFraction = Math.max(shownFraction, Math.min(1, fraction));
    bootBar.classList.toggle("sweep", fraction === null);
    bootFill.style.width = fraction === null ? "" : `${(shownFraction * 100).toFixed(1)}%`;
    bootGot.textContent =
      progress === null || progress.total === 0
        ? ""
        : `${mib(progress.received)} of ${mib(progress.total)}`;
    bootRate.textContent = "";
    bootEta.textContent =
      eta !== null
        ? secondsLeft(eta)
        : stage === "merging"
          ? "first sync timed on this device — the next one will say how long"
          : "";
    // 止まったかどうかはバイトで決める（`readout` と同じ規則）。マージ中はバイト
    // が来ないのが正常なので、そこでは言わない。
    const stalled = stage !== "merging" && now - lastBytesAt >= STALL_AFTER_MS;
    bootStall.hidden = !stalled;
    bootSkip.hidden = !stalled;
    if (stalled) {
      bootStall.textContent =
        "Nothing has arrived for a while. The connection may have dropped — you can " +
        "open with what is on this device and sync later.";
    }
  };

  const gate = window.setTimeout(() => {
    startClimb();
    paint();
  }, GATE_MS);
  const ticker = window.setInterval(paint, 1000);
  const skip = (): void => abort.abort();
  bootSkip.addEventListener("click", skip);

  try {
    const result = await syncAtBoot({
      signal: abort.signal,
      onProgress: (progress) => {
        if (progress.received !== lastReceived || progress.stage !== latest?.stage) {
          lastReceived = progress.received;
          lastBytesAt = performance.now();
        }
        latest = progress;
        paint();
      },
    });
    switch (result.kind) {
      case "offline":
        line("offline — opening with what is on this device; sync when you have signal", "step");
        break;
      case "unreachable":
        line(`could not sync (${result.detail}) — opening with what is on this device`, "bad");
        break;
      case "skipped":
        line("sync skipped — opening with what is on this device", "step");
        break;
      case "current":
        line("sync: nothing new from your other devices", "good");
        break;
      case "merged":
        line(
          `sync: ${result.reviewsAdded.toLocaleString()} grade(s) in from ${result.peers} device(s)`,
          result.failures.length > 0 ? "bad" : "good",
        );
        for (const failure of result.failures) line(failure, "bad");
        return result.reviewsAdded;
    }
    return 0;
  } finally {
    window.clearTimeout(gate);
    window.clearInterval(ticker);
    bootSkip.removeEventListener("click", skip);
    bootSkip.hidden = true;
    bootStall.hidden = true;
  }
}

async function boot(): Promise<void> {
  try {
    if (await maybeReset()) return;
    line("opening the database…", "step");
    const opened = await ask<"open">({ kind: "open", reimport: false });
    // A database that was not already here (or was just downloaded) has merged
    // nothing, whatever `localStorage` remembers — so the next sync pulls every
    // peer in full. See `forgetMergedPeers`.
    if (!opened.cardsWerePresent || opened.imported > 0) forgetMergedPeers();
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
    await bootSync();
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
    // A reload on `#deck/<id>` lands back in that deck — after the first card, so
    // the review underneath it is real and Back has somewhere to go.
    await openGalleryFromUrl();
    // 送り残しは最初のカードの後、裏で。`pushAfterBoot` 参照。
    pushAfterBoot();
  } catch (cause) {
    line(String((cause as Error).message), "bad");
    line("nothing was written. Fix the above and reload.", "bad");
  }
}

void boot();
