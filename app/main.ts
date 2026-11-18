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
import { mountPrepared, type MountedCard, type PreparedCard, type Pronunciation } from "../src/review/index.js";
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
import { newCardFrom, setReviewCard } from "./found-in.js";
import { fillAccents } from "./accent-helper.js";
import { watchForUpdates } from "./update-check.js";
import { localDate, shouldStartNewDay } from "./new-day.js";
import { isFocused } from "./focus.js";
import { keptDay, LATE_NIGHT_ENDED_KEY, LATE_NIGHT_KEY, stampNow } from "../src/session/late-night.js";
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
import { count } from "./plural.js";
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
import { isTypingTarget, type KeyTarget } from "./keys.js";
import { cardIdToCopy } from "./copy-id.js";
import { handleLineKeys } from "./line-edit.js";
import { clearVisits, noteVisit } from "./visits.js";
import { mountClimb } from "./climb.js";
import { overdueLabel, overdueTitle } from "./overdue.js";
import { lastSeenLabel, lastSeenTitle } from "./last-seen.js";
import { barValueText, barWidths } from "./progress.js";
import { reviewAction } from "./review-keys.js";
import {
  heroLength,
  promptPositions as promptBoundary,
  sideScale,
  visiblePositions,
  type BoundarySide,
} from "./review-boundary.js";
import { toggleCloze } from "./cloze-toggle.js";
import { fieldKind } from "../src/fields/index.js";
import { setOfflineFiller } from "./settings.js";
import { exampleSentencePrompt, isEnglishSentenceField } from "./example-sentence.js";
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
import type { FieldOutput } from "./field-ops.js";

listenToWorker({ log: (m) => line(m.text, m.level), fetching: showFetchProgress });
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
hydrateIcons();
el("bootversion").textContent = versionLabel();
const readingButton = el<HTMLButtonElement>("readingtoggle");
const doneView = el("done");
const doneText = el("donetext");

const climb = mountClimb(
  document.getElementById("climbmark") as unknown as SVGSVGElement,
);

const fetchRows = new Map<string, { row: HTMLElement; fill: HTMLElement; label: HTMLElement }>();

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

let fetchSamples: Sample[] = [];
let fetchStartedAt = 0;
let climbRaf: number | undefined;
let climbShownAt: number | null = null;

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

function startClimb(): void {
  if (climbShownAt !== null) return;
  climbShownAt = performance.now();
  bootFetch.hidden = false;
  bootAccent.setAttribute("opacity", "0");
  const quiet = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (quiet) {
    paintClimb(restFrame());
    return;
  }
  const tick = (now: number): void => {
    paintClimb(climbFrame(now - (climbShownAt ?? now)));
    climbRaf = requestAnimationFrame(tick);
  };
  climbRaf = requestAnimationFrame(tick);
}

function stopClimb(): void {
  if (climbRaf !== undefined) cancelAnimationFrame(climbRaf);
  climbRaf = undefined;
  climbShownAt = null;
  paintClimb(restFrame());
  bootAccent.removeAttribute("opacity");
  bootFetch.hidden = true;
}

function paintFetch(phase: Phase, message: Extract<AppMessage, { kind: "fetching" }>): void {
  const now = performance.now();
  const view = readout(phase, fetchSamples, message.total, now, fetchStartedAt);
  bootPhase.textContent =
    phase === "downloading"
      ? `${PHASE_WORDS[phase]} · ${message.index} of ${message.of}`
      : PHASE_WORDS[phase];
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
    bootStall.textContent = IN_CLOUD
      ? "Nothing has arrived for a while. The connection may have dropped."
      : "No data for a while. The transfer is still open — your computer may have gone " +
        "to sleep, or dropped off the tailnet.";
  }
}

function showFetchProgress(message: Extract<AppMessage, { kind: "fetching" }>): void {
  let entry = fetchRows.get(message.url);
  if (entry === undefined) {
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

  fetchSamples.push({ at: performance.now(), received: message.received });
  if (fetchSamples.length > 600) fetchSamples.splice(0, fetchSamples.length - 600);
  if (performance.now() - fetchStartedAt >= GATE_MS) startClimb();
  if (climbShownAt !== null) {
    paintFetch(message.done ? "saving" : "downloading", message);
  }
}

let scope: BlobUrlScope | null = null;
let mounted: MountedCard<HTMLElement> | null = null;
let drill: ShadowingSide<HTMLElement> | null = null;
let steps: RevealStep[] = [];
let stepIndex = 0;
let quietEntry = false;
let replayState: "ready" | "missing" = "ready";
let shownAt = 0;
let revealed = false;
let askedOnEntry = false;
let currentCardId: string | null = null;
let previewOfCurrent: PreparedCard | null = null;
setReviewCard(() => ({ host: cardHost, prepared: previewOfCurrent }));
let drawHandles: DrawHandle[] = [];
let inputHandles: InputHandle[] = [];
let currentPinned = false;
let currentArchived = false;
let peekOffset = 0;

function makeDrawable(result: { widgets: readonly { element: HTMLElement; name: string; attributes: Readonly<Record<string, string>> }[] }): DrawHandle[] {
  const handles: DrawHandle[] = [];
  for (const widget of result.widgets) {
    if (widget.name !== "draw") continue;
    if (!(widget.element instanceof HTMLCanvasElement)) continue;
    const handle = attachDraw(widget, widget.element as unknown as DrawSurface);
    handles.push(handle);
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

const footer = el("footer");
const measureFooter = (): void => {
  document.documentElement.style.setProperty("--footer-h", `${footer.offsetHeight}px`);
};
new ResizeObserver(measureFooter).observe(footer);
measureFooter();

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
        foldKana: true,
        ...(onSubmit === null ? {} : { onSubmit }),
      }),
    );
  }
  return handles;
}

function setState(state: "prompt" | "revealing" | "revealed"): void {
  reviewView.setAttribute("data-state", state);
}

function visibleSides(result: RenderResult<HTMLElement>): number[] {
  return visiblePositions(boundarySides(result));
}

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
  clearBacklinks();
}

async function showCardAt(): Promise<void> {
  const reply = await ask<"next">({ kind: "next", offset: peekOffset });
  maxLookBehind = reply.progress.answered;
  progressLabel.textContent =
    `${reply.progress.answeredToday}/${reply.progress.plannedToday}` +
    (reply.progress.reasksRemaining > 0 ? ` +${reply.progress.reasksRemaining}` : "");
  progressLabel.title =
    `${reply.progress.answeredToday} answered of ${reply.progress.plannedToday} planned today` +
    (reply.progress.reasksRemaining > 0 ? ` · ${reply.progress.reasksRemaining} to see again` : "");

  const widths = barWidths(reply.progress);
  progressFill.style.width = `${widths.donePercent.toFixed(2)}%`;
  progressMiss.style.width = `${widths.missedPercent.toFixed(2)}%`;
  progressBar.setAttribute("aria-valuenow", String(widths.done));
  progressBar.setAttribute("aria-valuemax", String(widths.planned));
  progressBar.setAttribute("aria-valuetext", barValueText(widths));

  if (reply.card === null) {
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
      `${reply.progress.answeredToday} answered · ${reply.progress.reasksQueued} shown again`;
    void climb.step();
    void endLateNight();
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
    playback: currentPlayback,
    resolve: async (address) => (await ask<"payload">({
      kind: "payload",
      cardId: reply.card!.cardId,
      address,
    })).payload,
    onOutcome: (outcome) => {
      const button = outcome.mount.element.nextElementSibling;
      if (button instanceof HTMLButtonElement && button.classList.contains("clip")) {
        button.setAttribute("data-clip", outcome.kind);
        button.disabled = outcome.kind === "missing" || outcome.kind === "unaddressable";
        if (button.disabled) button.title = `no clip on this device for ${outcome.mount.alt}`;
        if (outcome.kind === "missing") offerMissingClip(card, outcome.mount, button);
      }
      if (outcome.kind === "playing" || outcome.kind === "replayed") {
        replayState = "ready";
        paintReplay(drill === null ? "none" : "ready");
        return;
      }
      const asked = card.loop.log.some((event) => event.kind === "prompt");
      const showHint = asked || card.mode.mode === "identify";
      if (outcome.kind === "deferred") return;
      if (outcome.kind === "blocked" && !(outcome.detail ?? "").includes("NotSupportedError")) {
        if (showHint) hintLine.textContent = "tap play to hear it, then reveal";
        replayState = "ready";
        paintReplay(drill === null ? "none" : "ready");
        return;
      }
      if (showHint) {
        const making = !autoFillTried.has(card.cardId) || autoFilling.has(card.cardId);
        hintLine.textContent =
          outcome.kind === "missing"
            ? making
              ? MAKING_CLIP_HINT
              : NO_CLIP_HINT
            : outcome.kind === "unaddressable"
              ? "no clip for this card — reveal to read it"
              : "the clip didn't play — reveal to read it";
      }
      replayState = "missing";
      paintReplay("missing");
    },
  });
  mounted = card;
  void fillGeneratedText(card);

  const shown = visibleSides(card.result);
  const prompt = new Set(promptPositions(card));
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
  drill = null;
  replayState = "ready";

  for (const side of card.result.sides) {
    side.element.hidden = side.empty || !prompt.has(side.position);
    if (prompt.has(side.position)) side.element.classList.add("drill");
  }
  scaleSides(card);
  markAccentLabel(card);
  mountClipButtons(card);

  cardHost.appendChild(card.result.root);
  drawHandles = makeDrawable(card.result as never);
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
  if (reply.card.direction === "reverse") deckLine.appendChild(tag("reversed", "reversetag", "arrows-left-right"));
  const late = overdueLabel(reply.overdueDays);
  if (late !== null) {
    const chip = tag(late, "latetag", "clock");
    chip.title = overdueTitle(reply.overdueDays, reply.dueAt);
    deckLine.appendChild(chip);
  }
  const seen = lastSeenLabel(reply.lastReviewedAt);
  if (seen !== null) {
    const chip = tag(seen, "seentag", "calendar-blank");
    chip.title = lastSeenTitle(reply.lastReviewedAt) ?? "";
    deckLine.appendChild(chip);
  }

  readingButton.hidden = card.mode.readingFieldId === null;
  paintReadingButton(card.mode.reading);

  setState("prompt");
  revealWord.textContent = "reveal";
  prependIcon(revealButton, "eye");
  if (!quietEntry) for (const position of prompt) card.enter(position);

  const prompted = card.loop.log.find((event) => event.kind === "prompt");
  const asked = prompted !== undefined;
  if (prompted !== undefined) drill = prompted.side;
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

  askedOnEntry = asked;
  reviewView.toggleAttribute("data-asked", asked);
  paintReplay(drill === null ? "none" : "ready");

  shownAt = performance.now();
  paintPeek();
}

function paintReplay(state: "none" | "ready" | "missing"): void {
  replayButton.hidden = state === "none";
  replayButton.disabled = state === "missing";
  replayButton.title =
    state === "missing" ? "no clip on this device for this card" : "play the clip again";
}

function paintPeek(): void {
  const peeking = peekOffset !== 0;
  reviewView.toggleAttribute("data-peek", peeking);
  const behind = peekOffset < 0;
  forgotButton.disabled = behind;
  rememberedButton.disabled = behind;
  peekLine.hidden = !peeking;
  peekText.textContent = peeking
    ? behind
      ? `${peekOffset} back — already answered, so it cannot be graded again`
      : `+${peekOffset} ahead — grade it here and it leaves the queue`
    : "";
}

async function showSessionCard(): Promise<void> {
  peekOffset = 0;
  await showCardAt();
}

function tag(text: string, className: string, glyph?: IconName): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  if (glyph !== undefined) prependIcon(span, glyph);
  return span;
}

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

function runStep(
  card: MountedCard<HTMLElement>,
  step: RevealStep,
  silent = false,
): HTMLElement | null {
  const side = card.loop.side(step.position);
  if (side === null) return null;
  if (step.show) {
    side.element.hidden = false;
    card.loop.enter(step.position);
  }
  const mount = step.cloze === null ? undefined : side.clozes[step.cloze];
  if (mount !== undefined) side.revealCloze(mount, "caller", { silent });
  else side.reveal("caller", { silent });
  if (side.revealed && side.audio.length > 0) drill = side;
  return step.show ? side.element : (mount?.element ?? side.element);
}

function followReveal(target: HTMLElement): void {
  requestAnimationFrame(() => {
    const header = document.querySelector<HTMLElement>(".review header");
    const rect = target.getBoundingClientRect();
    const by = revealScroll({
      top: header === null ? 0 : header.offsetHeight,
      bottom: window.innerHeight - footer.offsetHeight,
      elementTop: rect.top,
      elementBottom: rect.bottom,
      gap: 16,
    });
    if (by === 0) return;
    window.scrollBy({
      top: by,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  });
}

function settleReveal(card: MountedCard<HTMLElement>): void {
  while (stepIndex < steps.length && stepDone(card, steps[stepIndex]!)) stepIndex += 1;
  if (stepIndex > 0) revealed = true;

  if (stepIndex >= steps.length) {
    revealed = true;
    for (const rendered of card.result.sides) {
      if (!rendered.empty) rendered.element.hidden = false;
    }
    for (const side of card.loop.sides) side.reveal("caller", { silent: true });
    setState("revealed");
    if (currentCardId !== null) paintBacklinks(currentCardId);
  } else {
    setState("revealing");
    revealWord.textContent = `next · ${steps.length - stepIndex}`;
    prependIcon(revealButton, "arrow-down");
  }
  paintReplay(drill === null ? "none" : replayState);
}

const BACKLINK_ROWS = 6;

const backlinksHost = el("backlinks");
let backlinksFor: string | null = null;

async function backlinkSection(cardId: string): Promise<HTMLElement | null> {
  let reply: ReplyFor["backlinks"];
  try {
    reply = await ask<"backlinks">({ kind: "backlinks", cardId });
  } catch {
    return null;
  }
  const cards = reply.cards;
  const found = reply.foundIn;
  if (cards.length === 0 && found === null) return null;

  const section = document.createElement("section");
  section.className = "backlinks";

  if (found !== null) {
    const head = document.createElement("h2");
    head.className = "backlinks-head";
    head.textContent = "found in";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "link-item found-in";
    const name = document.createElement("b");
    name.textContent = found.name === "" ? found.cardId : found.name;
    const line = document.createElement("i");
    line.textContent = found.sentence !== "" ? found.sentence : found.deckPath;
    row.append(name, line);
    if (found.deckPath === "") row.disabled = true;
    else row.addEventListener("click", () => void openPreview(found.cardId));
    section.append(head, row);
  }
  if (cards.length === 0) return section;

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
      row.className = "link-item";
      const name = document.createElement("b");
      name.textContent = card.name === "" ? card.cardId : card.name;
      const deck = document.createElement("i");
      deck.textContent = card.archived ? `${card.deckPath} · archived` : card.deckPath;
      row.append(name, deck);
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

function clearBacklinks(): void {
  backlinksFor = null;
  backlinksHost.replaceChildren();
  backlinksHost.hidden = true;
}

function mountClipButtons(card: MountedCard<HTMLElement>): void {
  for (const side of card.loop.sides) {
    for (const clip of side.audio) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "clip";
      button.append(icon("play"), icon("play-fill"));
      button.setAttribute("aria-label", "play this clip");

      const media = clip.element as unknown as HTMLMediaElement;
      const paint = (): void => {
        const at = media.duration > 0 ? Math.min(1, media.currentTime / media.duration) : 0;
        button.style.setProperty("--played", `${(at * 100).toFixed(1)}%`);
      };
      media.addEventListener("timeupdate", paint);
      media.addEventListener("ended", () => button.style.setProperty("--played", "0%"));
      media.addEventListener("play", () => {
        const frame = (): void => {
          if (media.ended) {
            button.style.setProperty("--played", "0%");
            return;
          }
          paint();
          if (!media.paused) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!mayPlayClip(takeState)) return;
        side.play(clip, { unmask: false });
      });
      clip.element.insertAdjacentElement("afterend", button);
    }
  }
}

function stepDone(card: MountedCard<HTMLElement>, step: RevealStep): boolean {
  const side = card.loop.side(step.position);
  if (side === null) return true;
  if (step.cloze === null) return side.revealed;
  return side.clozes[step.cloze]?.revealed === true;
}

const REFUSAL: Record<AnswerRefusal, string> = {
  "already-answered": "you already answered this one — ctrl+z to take it back",
  "nothing-there": "there is no card there",
};

async function fillGeneratedText(card: MountedCard<HTMLElement>): Promise<void> {
  if (card.textSlots.length === 0) {
    void autoFill(card.cardId);
    return;
  }
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
    const tried = autoFillTried.has(card.cardId) && !autoFilling.has(card.cardId);
    if (tried) {
      settleMissing(card);
      offerMissingGenerations(card, reply.texts);
    } else {
      markGenerating(card, reply.texts);
      void autoFill(card.cardId).then(() => {
        settleMissing(card);
        offerMissingGenerations(card, reply.texts);
      });
    }
    if (card === mounted) scaleSides(card);
  } catch {
  }
}

const GENERATE_ENDPOINT = "/generate/";

const CLIP_TIMEOUT_MS = 30_000;
const TEXT_TIMEOUT_MS = 120_000;

async function askLaptop(
  body: unknown,
  timeoutMs: number,
): Promise<{ response: Response } | { failure: string }> {
  const started = performance.now();
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
    return {
      failure: timedOut
        ? IN_CLOUD
          ? `Cloudflare did not answer in ${waited}s — this device may be offline. Press again to retry.`
          : `the laptop did not answer in ${waited}s — it may be asleep, or off the tailnet. Press again to retry.`
        : `could not reach ${SERVER_NAME}: ${(cause as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const GENERATABLE: ReadonlySet<string> = new Set(["ai", "translate"]);

function markGenerating(card: MountedCard<HTMLElement>, texts: readonly (string | null)[]): void {
  card.textSlots.forEach((slot, index) => {
    if (texts[index] !== null || !GENERATABLE.has(slot.kind)) return;
    const target = card.result.generations.find(
      (mount) => mount.request?.text === slot.text && mount.request?.kind === slot.kind,
    );
    target?.element.setAttribute("data-state", "generating");
  });
}

function settleMissing(card: MountedCard<HTMLElement>): void {
  for (const mount of card.result.generations) {
    if (mount.request === null || !GENERATABLE.has(mount.request.kind)) continue;
    const state = mount.element.getAttribute("data-state");
    if (state === "pending" || state === "generating") mount.element.setAttribute("data-state", "missing");
  }
}

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
    if (output.querySelector(".regen") !== null) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "regen";
    button.textContent = "try again";
    button.title = slot.text;
    button.addEventListener("click", () => {
      void requestGeneration(card, slot, button);
    });
    output.appendChild(button);
  });
}

function offerMissingClip(
  card: MountedCard<HTMLElement>,
  mount: MountedCard<HTMLElement>["result"]["media"][number],
  clipButton: HTMLButtonElement,
): void {
  const address = audioAddress(card.result, mount);
  if (address === null || address.origin !== "generator") return;
  const request = address.request;
  if (request.kind !== "speech" || request.text.trim() === "") return;
  if (clipButton.nextElementSibling instanceof HTMLButtonElement &&
      clipButton.nextElementSibling.classList.contains("regen")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "regen";
  button.textContent = "try again";
  button.title = request.text;
  button.addEventListener("click", () => {
    void requestClip(card, mount, request, button, clipButton);
  });
  const running = autoFillRuns.get(card.cardId);
  if (running !== undefined) {
    button.disabled = true;
    button.textContent = "making it…";
    void running.then(() => {
      button.disabled = false;
      button.textContent = "try again";
    });
  }
  clipButton.insertAdjacentElement("afterend", button);
}

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
  const word = await ask<"pronunciation">({ kind: "pronunciation", cardId: card.cardId, text: request.text });
  if (word.waiting) {
    say("this word's clip waits for its reading — the laptop's helper fills 読み and 型 first");
    button.disabled = false;
    return;
  }
  button.textContent = "speaking…";
  try {
    const attempt = await askLaptop(
      {
        kind: "speech",
        text: request.text,
        lang: request.lang,
        voice: request.voice,
        options: request.options,
        ...(word.pronounce === null ? {} : { pronounce: word.pronounce }),
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
        voice: body.voice ?? null,
        options: request.options,
      },
      audio: body.audio,
    }).catch(() => undefined);
    button.remove();
    clipButton.disabled = false;
    if (body.mismatch !== undefined) say(body.mismatch, true);
    else if (body.cached === true) say(`already on ${SERVER_NAME} — ${body.voice ?? "fill voice"}`);
    const side = card.loop.sides.find((entry) => entry.index === mount.side);
    side?.play(mount, { unmask: false });
  } catch (cause) {
    say(`could not reach ${SERVER_NAME} to generate: ${(cause as Error).message}`, true);
    button.disabled = false;
    button.textContent = was;
  }
}

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
      ...(info.pronounce === null ? {} : { pronounce: info.pronounce }),
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
  await showCardAt();
}

const autoFilling = new Set<string>();
const autoFillTried = new Set<string>();

const MAKING_CLIP_HINT = "making the clip — reveal to read it";
const NO_CLIP_HINT = "no clip on this device — reveal to read it";
function settleMakingHint(cardId: string): void {
  if (mounted?.cardId === cardId && hintLine.textContent === MAKING_CLIP_HINT) {
    hintLine.textContent = NO_CLIP_HINT;
  }
}
const autoFillRuns = new Map<string, Promise<boolean>>();

function autoFill(cardId: string, options: { readonly force?: boolean } = {}): Promise<boolean> {
  const running = autoFillRuns.get(cardId);
  if (running !== undefined) return running;
  if (options.force !== true && autoFillTried.has(cardId)) return Promise.resolve(true);
  const run = fillGaps(cardId).finally(() => autoFillRuns.delete(cardId));
  autoFillRuns.set(cardId, run);
  return run;
}

async function makeCardGaps(cardId: string): Promise<{ made: number; failure: string | null }> {
  let made = 0;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const reply = await ask<"cardGaps">({ kind: "cardGaps", cardId });
      if (reply.gaps.length === 0) break;
      let progress = 0;
      for (const gap of reply.gaps) {
        const result = await generateGap(gap);
        if ("failure" in result) return { made, failure: result.failure };
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
        made += 1;
      }
      if (progress === 0) break;
    }
  } catch (cause) {
    return { made, failure: (cause as Error).message };
  }
  return { made, failure: null };
}

async function fillGaps(cardId: string): Promise<boolean> {
  autoFilling.add(cardId);
  autoFillTried.add(cardId);
  let made = 0;
  try {
    const result = await makeCardGaps(cardId);
    made = result.made;
    if (result.failure !== null) {
      say(`could not fill this card's generated parts: ${result.failure}`, true);
      return false;
    }
  } finally {
    autoFilling.delete(cardId);
    if (made > 0) await redrawFilled(cardId, made);
    else settleMakingHint(cardId);
  }
  return true;
}

const OFFLINE_DAYS = 3;
const OFFLINE_WORKERS = 3;
const OFFLINE_GIVE_UP_AFTER = 5;

async function fillUpcoming(progress: (line: string) => void): Promise<void> {
  const { cardIds } = await ask<"upcomingCards">({ kind: "upcomingCards", days: OFFLINE_DAYS });
  let next = 0;
  let done = 0;
  let made = 0;
  let failed = 0;
  let failingInARow = 0;
  let lastFailure = "";
  const report = (): void =>
    progress(`${done.toLocaleString()} of ${cardIds.length.toLocaleString()} cards checked · ${made.toLocaleString()} parts made` +
      (failed > 0 ? ` · ${failed} cards failed` : ""));
  report();
  const worker = async (): Promise<void> => {
    while (next < cardIds.length && failingInARow < OFFLINE_GIVE_UP_AFTER) {
      const cardId = cardIds[next++]!;
      const running = autoFillRuns.get(cardId);
      if (running !== undefined) await running;
      const result = await makeCardGaps(cardId);
      made += result.made;
      if (result.failure === null) {
        failingInARow = 0;
        autoFillTried.add(cardId);
      } else {
        failed += 1;
        failingInARow += 1;
        lastFailure = result.failure;
      }
      if (result.made > 0 && mounted?.cardId === cardId) await remountAfterEdit(cardId);
      done += 1;
      report();
    }
  };
  await Promise.all(Array.from({ length: OFFLINE_WORKERS }, worker));
  if (failingInARow >= OFFLINE_GIVE_UP_AFTER) {
    throw new Error(`stopped after ${done} of ${cardIds.length} cards: ${lastFailure}`);
  }
  const summary =
    `ready for offline: ${cardIds.length.toLocaleString()} cards due or new in the next ${OFFLINE_DAYS} days, ` +
    `${made.toLocaleString()} parts made` + (failed > 0 ? `, ${failed} cards failed (${lastFailure})` : "");
  progress(summary);
}
setOfflineFiller(fillUpcoming);

async function generateGap(gap: {
  readonly kind: string;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly pronounce?: Pronunciation;
}): Promise<{ text: string } | { audio: string; voice: string | null } | { failure: string }> {
  const speech = gap.kind === "speech";
  const attempt = await askLaptop(
    {
      kind: gap.kind,
      text: gap.text,
      lang: gap.lang,
      voice: gap.voice,
      options: gap.options,
      ...(gap.pronounce === undefined ? {} : { pronounce: gap.pronounce }),
    },
    speech ? CLIP_TIMEOUT_MS : TEXT_TIMEOUT_MS,
  );
  if ("failure" in attempt) return attempt;
  const response = attempt.response;
  const raw = await response.text();
  let body: { text?: string; audio?: string; voice?: string; error?: string } = {};
  try {
    body = raw === "" ? {} : (JSON.parse(raw) as typeof body);
  } catch {
  }
  const value = speech ? body.audio : body.text;
  if (!response.ok || typeof value !== "string" || value === "") {
    return { failure: body.error ?? `${SERVER_NAME} said ${response.status} ${response.statusText}` };
  }
  return speech ? { audio: value, voice: body.voice ?? null } : { text: value };
}

async function redrawFilled(cardId: string, made: number): Promise<void> {
  say(`filled ${made} generated part${made === 1 ? "" : "s"} of this card`);
  await remountAfterEdit(cardId);
  const top = layers.at(-1);
  if (top !== undefined && top.ops && top.cardId === cardId) {
    closeTop();
    await openPreview(cardId);
  }
}

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
    const raw = await response.text();
    let body: { text?: string; error?: string } = {};
    try {
      body = raw === "" ? {} : (JSON.parse(raw) as typeof body);
    } catch {
    }
    if (!response.ok || typeof body.text !== "string" || body.text === "") {
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
    await ask<"storeGeneration">({
      kind: "storeGeneration",
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

function markAccentLabel(card: MountedCard<HTMLElement>): void {
  const field = card.loaded.template?.fields.find((f) => f.type === "accent");
  if (field === undefined) return;
  const value = (card.loaded.values.get(field.id) ?? "").trim();
  if (value === "") return;
  const title = `${field.name} — the accent pattern`;
  for (const side of card.result.sides) {
    for (const element of side.element.querySelectorAll<HTMLElement>("*")) {
      if ((element.textContent ?? "").trim() !== value) continue;
      if (element.querySelector("*") !== null) continue;
      element.classList.add("accent-label");
      element.setAttribute("title", title);
    }
    const walker = document.createTreeWalker(side.element, NodeFilter.SHOW_TEXT);
    const bare: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim() !== value) continue;
      if ((node.parentElement?.classList.contains("accent-label") ?? false)) continue;
      bare.push(node as Text);
    }
    for (const node of bare) {
      const span = document.createElement("span");
      span.className = "accent-label";
      span.setAttribute("title", title);
      span.textContent = node.textContent;
      node.parentNode?.replaceChild(span, node);
    }
  }
}

function contentText(element: HTMLElement): string {
  let text = "";
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest("button") !== null) continue;
    text += node.textContent ?? "";
  }
  return text;
}

function scaleSides(card: MountedCard<HTMLElement>): void {
  for (const side of card.result.sides) {
    const text = contentText(side.element);
    side.element.setAttribute("data-scale", sideScale(text));
    const hero = heroLength(text);
    if (hero > 0) side.element.setAttribute("data-hero", String(hero));
    else side.element.removeAttribute("data-hero");
  }
}

async function grade(remembered: boolean): Promise<void> {
  if (mounted === null) return;
  const durationMs = Math.round(performance.now() - shownAt);
  forgotButton.disabled = true;
  rememberedButton.disabled = true;
  const offset = peekOffset;
  try {
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
    peekOffset = offset;
    if (reply.graded && reply.dueAt !== null) {
      line(
        `graded · due ${reply.dueAt.slice(0, 10)} · ${reply.writeMs.toFixed(1)} ms write · ` +
          `${reply.openStatements} open / ${reply.cachedStatements} cached statements`,
        "good",
      );
      schedulePush();
    }
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
    await showCardAt();
  } finally {
    forgotButton.disabled = false;
    rememberedButton.disabled = false;
  }
}

function paintReadingButton(value: boolean): void {
  readingButton.setAttribute("aria-pressed", String(value));
  readingButton.title = value
    ? "Reading = true — press to make it false"
    : "Reading = false — press to make it true";
}

async function flipReading(): Promise<void> {
  const card = mounted;
  if (card === null || card.mode.readingFieldId === null || currentCardId === null) return;
  const value = !card.mode.reading;
  readingButton.disabled = true;
  try {
    await ask<"reading">({ kind: "reading", cardId: currentCardId, value });
    paintReadingButton(value);
    hintLine.textContent = `Reading = ${value} — takes effect next time this card comes up`;
  } finally {
    readingButton.disabled = false;
  }
}

revealButton.addEventListener("click", reveal);
forgotButton.addEventListener("click", () => void grade(false));
rememberedButton.addEventListener("click", () => void grade(true));
replayButton.addEventListener("click", () => {
  if (!mayPlayClip(takeState)) return;
  drill?.replay();
});
readingButton.addEventListener("click", () => void flipReading());
el("backup").addEventListener("click", () => void exportBackup());
window.addEventListener("appinstalled", () => void checkPersistence());

const moreButton = el<HTMLButtonElement>("opmore");

function paintCardOps(): void {
  const flags = [currentPinned ? "pinned" : "", currentArchived ? "archived" : ""].filter(
    (flag) => flag !== "",
  );
  moreButton.classList.toggle("on", flags.length > 0);
  moreButton.title = flags.length === 0 ? "card actions" : `card actions — ${flags.join(", ")}`;
}

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

const PLAYBACK_KEY = "hashigo.playback";

let playbackState: Playback = DEFAULT_PLAYBACK;
try {
  playbackState = readPlayback(localStorage.getItem(PLAYBACK_KEY));
} catch {
}

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
const takeAudio = new Audio();
let takeGeneration = 0;

function savePlayback(): void {
  try {
    localStorage.setItem(PLAYBACK_KEY, writePlayback(playbackState));
  } catch {
  }
  paintShadowbar();
}

function opLabel(button: HTMLElement): HTMLElement {
  return button.querySelector<HTMLElement>(".op-label") ?? button;
}

function paintShadowbar(): void {
  loopButton.classList.toggle("on", playbackState.loop);
  loopButton.setAttribute("aria-pressed", String(playbackState.loop));
  opLabel(speedButton).textContent = speedLabel(playbackState.rate);
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

function openCardIdToCopy(): string | null {
  const top = layers.at(-1);
  return cardIdToCopy({
    selection: window.getSelection()?.toString() ?? "",
    typing: isTypingTarget(document.activeElement as KeyTarget | null),
    layerCardId: top === undefined ? null : top.cardId,
    reviewCardId:
      !reviewView.hidden && document.body.getAttribute("data-view") !== "gallery" ? currentCardId : null,
  });
}
document.addEventListener("keydown", handleLineKeys);
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (event.key.toLowerCase() !== "c" && event.key !== "Insert") return;
  const id = openCardIdToCopy();
  if (id === null) return;
  event.preventDefault();
  copyingId = false;
  const raised = document.execCommand("copy");
  if (raised && copyingId) return;
  if (navigator.clipboard === undefined) {
    say(`could not copy — the card id is ${id}`, true);
    return;
  }
  navigator.clipboard.writeText(id).then(
    () => say(`copied card id ${id}`),
    () => say(`could not copy — the card id is ${id}`, true),
  );
});
let copyingId = false;
document.addEventListener("copy", (event) => {
  const id = openCardIdToCopy();
  if (id === null || event.clipboardData === null) return;
  event.clipboardData.setData("text/plain", id);
  event.preventDefault();
  copyingId = true;
  say(`copied card id ${id}`);
});

document.addEventListener("keydown", (event) => {
  const action = reviewAction(event, {
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

async function stepCard(delta: number): Promise<void> {
  const next = peekOffset + delta;
  if (next < -maxLookBehind) {
    say("that is as far back as this session goes");
    return;
  }
  const previous = peekOffset;
  peekOffset = next;
  await showCardAt();
  if (peekOffset === previous) return;
  if (peekOffset === 0) say("back to the card you were on");
}

let maxLookBehind = 0;

el("prevcard").addEventListener("click", () => void stepCard(-1));
el("nextcard").addEventListener("click", () => void stepCard(1));

el("peekback").addEventListener("click", () => {
  void showSessionCard().then(() => say("back to the card you were on"));
});
el("palettebutton").addEventListener("click", () => {
  closeSidebar();
  openPalette();
});

document.addEventListener(
  "click",
  (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".layer") != null) return;
    if (target?.closest(`.${CLASS.cloze}`) === null) return;
    const card = mounted;
    if (card !== null) settleReveal(card);
  },
  false,
);

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
  clearVisits();
  line(
    `reset: removed ${reply.removed.join(", ")} · ${count(reply.localReviews, "local grade")} gone. ` +
      `Reload without ?reset=1 to re-import.`,
    "bad",
  );
  return true;
}

async function openPreview(cardId: string): Promise<void> {
  const reply = await ask<"preview">({ kind: "preview", cardId });
  if (reply.card !== null) noteVisit(cardId);

  const root = document.createElement("div");
  root.className = "layer";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `preview: ${reply.name}`);

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  root.appendChild(panel);

  const head = document.createElement("div");
  head.className = "layer-head layer-head-preview";
  const title = document.createElement("span");
  title.textContent = reply.card === null ? "card not found" : `${reply.deckPath} · preview`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close this preview");
  setIcon(close, "x");
  close.addEventListener("click", () => closeIfTop(root));
  const ops = document.createElement("div");
  ops.className = "layer-ops";
  head.append(title, close, ops);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);

  if (reply.card === null) {
    const gone = document.createElement("p");
    gone.className = "layer-missing";
    gone.textContent = `${cardId} is not in this database — it was probably deleted in Mochi.`;
    body.appendChild(gone);
    layerHost.appendChild(root);
    document.body.classList.add("layered");
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
    playback: currentPlayback,
    resolve: async (address) =>
      (await ask<"payload">({ kind: "payload", cardId: reply.card!.cardId, address })).payload,
    onOutcome: (outcome) => {
      const button = outcome.mount.element.nextElementSibling;
      if (!(button instanceof HTMLButtonElement) || !button.classList.contains("clip")) return;
      button.setAttribute("data-clip", outcome.kind);
      button.disabled = outcome.kind === "missing" || outcome.kind === "unaddressable";
      if (button.disabled) button.title = `no clip on this device for ${outcome.mount.alt}`;
      if (outcome.kind === "missing") offerMissingClip(mounted, outcome.mount, button);
    },
  });

  void fillGeneratedText(mounted);
  for (const side of mounted.result.sides) side.element.hidden = side.empty;
  for (const side of mounted.loop.sides) side.reveal("caller", { silent: true });
  markAccentLabel(mounted);
  scaleSides(mounted);

  body.appendChild(mounted.result.root);
  layerHost.appendChild(root);
  mountClipButtons(mounted);
  makeDrawable(mounted.result as never);
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

  void (async () => {
    const section = await backlinkSection(cardId);
    if (section !== null && root.isConnected) body.appendChild(section);
  })();
}

function paintLayerOps(layer: Layer, host: HTMLElement): void {
  host.replaceChildren();
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
    ...(layer.prepared === null
      ? []
      : ([["new card", false, () => newCardFrom(layer.root, layer.prepared as PreparedCard)]] as const)),
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

function editableCard(): { card: PreparedCard; onSaved: () => void } | null {
  const top = layers.at(-1);
  if (top !== undefined) {
    return top.prepared === null
      ? null
      : { card: top.prepared, onSaved: () => { } };
  }
  if (mounted === null || previewOfCurrent === null) return null;
  return { card: previewOfCurrent, onSaved: () => { } };
}

function openEditor(): void {
  const target = editableCard();
  if (target === null) return;
  const top = layers.at(-1);
  const replacing = top !== undefined && top.ops && top.cardId === target.card.cardId ? top.root : undefined;
  void openEditorById(target.card.cardId, replacing === undefined ? {} : { replacing });
}

async function fillGeneratedNotes(cardId: string, notes: ReadonlyMap<string, HTMLElement>): Promise<void> {
  let outputs: readonly FieldOutput[];
  try {
    outputs = (await ask<"fieldOutputs">({ kind: "fieldOutputs", cardId })).outputs;
  } catch {
    for (const note of notes.values()) note.textContent = "filled for you — could not look it up";
    return;
  }
  for (const output of outputs) {
    const note = notes.get(output.fieldId);
    if (note === undefined) continue;
    const from = output.from.length === 0 ? "filled for you" : `filled from ${output.from.join(", ")}`;
    if (output.audio !== null) {
      const address = { origin: "generator" as const, request: output.audio };
      note.textContent = `${from} — audio `;
      const play = document.createElement("button");
      play.type = "button";
      play.className = "gcard-op edit-play";
      play.textContent = "play";
      play.addEventListener("click", (event) => {
        event.preventDefault();
        void ask<"payload">({ kind: "payload", cardId, address }).then(({ payload }) => {
          if (payload === null) {
            play.disabled = true;
            play.title = "no clip on this device";
            return;
          }
          const url = URL.createObjectURL(new Blob([payload.bytes as BlobPart], { type: payload.mime }));
          const audio = new Audio(url);
          audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
          void audio.play();
        });
      });
      note.appendChild(play);
    } else if (output.text !== null && output.text.trim() !== "") {
      note.textContent = `${from} — ${output.text.trim()}`;
    } else {
      note.textContent = `${from} — not made yet; it is made when the card is shown or the editor closes`;
    }
  }
}

function openEditorFor(
  card: PreparedCard,
  choices: readonly TemplateChoice[],
  options: { readonly fromPreview?: boolean } = {},
): void {
  const fields = card.loaded.template?.fields ?? [];

  const root = document.createElement("div");
  root.className = "layer layer-edit";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `edit ${card.loaded.name}`);
  root.dataset["cardId"] = card.cardId;

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
    const none = document.createElement("p");
    none.className = "settings-note";
    none.textContent =
      "This card has no template, so it has no fields to edit. Pick one above; its " +
      "values are still stored and will reappear for whichever fields the new " +
      "template declares.";
    body.appendChild(none);
  }

  const liveValues = new Map<string, HTMLTextAreaElement>();
  const generatedNotes = new Map<string, HTMLElement>();
  const derivedNotes = new Map<string, (value: string) => void>();
  for (const field of fields) {
    const value = card.loaded.values.get(field.id) ?? "";
    let saved = value;
    const row = document.createElement("label");
    row.className = "edit-row";
    row.dataset["fieldId"] = field.id;
    row.dataset["fieldName"] = field.name;

    const label = document.createElement("span");
    label.className = "edit-label";
    label.textContent = field.name;
    const kind = fieldKind(field);
    const type = document.createElement("i");
    type.className = "edit-type";
    type.textContent = kind.label;
    label.appendChild(type);
    row.appendChild(label);

    if (!EDITABLE_FIELD_TYPES.has(field.type)) {
      const note = document.createElement("p");
      note.className = "edit-readonly";
      note.textContent = "filled for you — looking it up…";
      generatedNotes.set(field.id, note);
      row.appendChild(note);
      body.appendChild(row);
      continue;
    }

    if (kind.derived) {
      const from = fields.find((entry) => entry.id === field.sourceFieldId)?.name;
      const note = document.createElement("p");
      note.className = "edit-readonly";
      const show = (now: string): void => {
        note.textContent =
          now.trim() === ""
            ? `filled for you — empty: ${kind.whenEmpty ?? "nothing has filled it yet"}. Nothing to type here`
            : `${from === undefined ? "filled for you" : `filled from ${from}`} — ${now.trim()}`;
      };
      show(value);
      derivedNotes.set(field.id, show);
      row.appendChild(note);
      body.appendChild(row);
      continue;
    }

    const save = (next: string): void => {
      const before = saved;
      saved = next;
      void ask<"setField">({ kind: "setField", cardId: card.cardId, fieldId: field.id, value: next })
        .then((reply) => {
          for (const gone of reply.cleared) derivedNotes.get(gone.fieldId)?.("");
          status.textContent =
            reply.cleared.length === 0
              ? `saved ${field.name}`
              : `saved ${field.name} — emptied ${reply.cleared.map((gone) => gone.name).join(", ")} ` +
                `for the laptop's helper to fill for the new word`;
          status.classList.remove("bad");
          pushUndo({
            describe: `edit of ${field.name} on ${card.loaded.name || card.cardId}`,
            run: async () => {
              await ask<"setField">({
                kind: "setField",
                cardId: card.cardId,
                fieldId: field.id,
                value: reply.previous,
              });
              for (const gone of reply.cleared) {
                await ask<"setField">({
                  kind: "setField",
                  cardId: card.cardId,
                  fieldId: gone.fieldId,
                  value: gone.previous,
                });
              }
              await refreshAfterOp();
            },
          });
        })
        .catch((cause: Error) => {
          if (saved === next) saved = before;
          status.textContent = `${field.name}: ${cause.message}`;
          status.classList.add("bad");
        });
    };

    if (field.type === "boolean") {
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
      area.addEventListener("input", () => fitTextarea(area));
      if (field.type === "number") area.inputMode = "numeric";
      area.addEventListener("blur", () => {
        if (area.value !== saved) save(area.value);
      });
      row.appendChild(area);
      if (field.type === "plain") {
        attachLinkEditing(
          area,
          () => {
            if (area.value !== saved) save(area.value);
          },
          { deckId: card.loaded.deckId, templateId: card.loaded.templateId },
        );
      }
      liveValues.set(field.id, area);
      if (isEnglishSentenceField(field, fields)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "regen edit-generate";
        button.textContent = "generate";
        const sync = (): void => {
          button.hidden = area.value.trim() !== "";
        };
        area.addEventListener("input", sync);
        sync();
        button.addEventListener("click", (event) => {
          event.preventDefault();
          const values = new Map([...liveValues].map(([id, el]) => [id, el.value]));
          const prompt = exampleSentencePrompt(fields, values);
          if (prompt === null) {
            status.textContent = `${field.name}: write the word first`;
            status.classList.add("bad");
            return;
          }
          button.disabled = true;
          button.textContent = "generating…";
          void generateGap({ kind: "ai", text: prompt, lang: null, voice: null, options: {} }).then((result) => {
            button.disabled = false;
            button.textContent = "generate";
            if (!("text" in result)) {
              status.textContent = `${field.name}: ${"failure" in result ? result.failure : "no text came back"}`;
              status.classList.add("bad");
              return;
            }
            if (area.value.trim() !== "") return;
            area.value = result.text;
            fitTextarea(area);
            sync();
            save(area.value);
          });
        });
        row.appendChild(button);
      }
    }
    body.appendChild(row);
  }
  if (generatedNotes.size > 0) void fillGeneratedNotes(card.cardId, generatedNotes);

  body.appendChild(status);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  let showPreview = options.fromPreview === true;
  const flushFields = (): void => {
    for (const area of root.querySelectorAll<HTMLTextAreaElement>("textarea.edit-input")) {
      area.dispatchEvent(new Event("blur"));
    }
  };
  registerLayer({
    root,
    mounted: null,
    prepared: null,
    cardId: card.cardId,
    ops: false,
    pinned: false,
    archived: false,
    onClose: () => {
      flushFields();
      void autoFill(card.cardId, { force: true })
        .then(() => fillAccents([card.cardId], (text) => line(text, "good"), (text) => say(text, true)))
        .then((filled) => {
          if (filled !== null && filled.labels + filled.yomi + filled.ojad > 0) refreshShown(card.cardId);
        });
      void remountAfterEdit(card.cardId);
      if (!showPreview) return;
      const under = layers.at(-1);
      if (under !== undefined && under.ops && under.cardId === card.cardId) closeTop();
      void openPreview(card.cardId);
    },
  });
  for (const area of body.querySelectorAll("textarea.edit-input")) {
    fitTextarea(area as HTMLTextAreaElement);
  }
  (body.querySelector(".edit-input, .edit-check") as HTMLElement | null)?.focus();

  root.addEventListener(
    "keydown",
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (layers.at(-1)?.root !== root) return;
      showPreview = true;
      (document.activeElement as HTMLElement | null)?.blur();
      closeTop();
    },
    { capture: true },
  );

  root.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== "l") return;
    const area = event.target;
    if (!(area instanceof HTMLTextAreaElement) || !area.classList.contains("edit-input")) return;
    event.preventDefault();
    const edit = toggleCloze(area.value, area.selectionStart, area.selectionEnd);
    if (edit === null) return;
    area.setSelectionRange(edit.from, edit.to);
    if (!document.execCommand("insertText", false, edit.insert)) {
      area.setRangeText(edit.insert, edit.from, edit.to);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    }
    area.setSelectionRange(edit.selectStart, edit.selectEnd);
  });
}

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

function refreshShown(cardId: string): void {
  void remountAfterEdit(cardId);
  const top = layers.at(-1);
  if (top !== undefined && top.ops && top.cardId === cardId) {
    closeTop();
    void openPreview(cardId);
  }
}

function fitTextarea(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
}

const EDITABLE_FIELD_TYPES = new Set(["plain", "boolean", "number", "accent"]);

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

  item("pencil-simple", "edit", "the fields, the template, the deck", () => void openEditorById(cardId));

  if (previewOfCurrent !== null && previewOfCurrent.loaded.id === cardId) {
    const prepared = previewOfCurrent;
    item("plus", "new card from this", "select a word first; the new card remembers it came from here", () =>
      newCardFrom(cardHost, prepared),
    );
  }

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

  item("speaker-high", "voice", "which voice this card's new clips are made in", () =>
    openVoiceDialog("card", cardId, name),
  );

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
  registerLayer(bareLayer(root));
  (list.firstElementChild as HTMLElement | null)?.focus();
}

const STAGE_WORDS: Readonly<Record<SyncProgress["stage"], string>> = {
  checking: "Checking your other devices",
  downloading: "Getting grades from your other devices",
  merging: "Merging them into this device",
  sending: "Sending this device's grades",
};
const bootSkip = el("bootskip");

let plannedDay = "";

async function endLateNight(): Promise<void> {
  if (isFocused()) return;
  try {
    const settings = await ask<"settings">({ kind: "settings" });
    const stored = settings.values[LATE_NIGHT_KEY];
    if (stored === undefined || stored === "") return;
    if (stored < localDate(new Date())) {
      const now = stampNow();
      if (keptDay(stored, now) !== null) {
        await ask<"setSetting">({ kind: "setSetting", key: LATE_NIGHT_ENDED_KEY, value: now });
      }
      plannedDay = stored;
    }
    await ask<"setSetting">({ kind: "setSetting", key: LATE_NIGHT_KEY, value: "" });
    say(`late night is off — ${stored} is done`);
  } catch (cause) {
    say(`late night could not switch off: ${(cause as Error).message}`, true);
  }
}

function watchForNewDay(plannedOn: string): void {
  plannedDay = plannedOn;
  let reloading = false;
  const check = (): void => {
    if (reloading || document.visibilityState !== "visible") return;
    const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type]), input[type="text"], input[type="search"], textarea',
    );
    const typing =
      isTypingTarget(document.activeElement as KeyTarget | null) ||
      [...fields].some((f) => f.value.trim() !== "");
    const go = shouldStartNewDay({
      plannedOn: plannedDay,
      today: localDate(new Date()),
      onDone: !doneView.hidden,
      layered: document.body.classList.contains("layered"),
      typing,
    });
    if (!go) return;
    reloading = true;
    window.location.reload();
  };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
}

async function bootSync(): Promise<number> {
  const abort = new AbortController();
  const startedAt = performance.now();
  let latest: SyncProgress | null = null;
  let lastBytesAt = startedAt;
  let lastReceived = 0;
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
          `sync: ${count(result.reviewsAdded, "grade")} in from ${count(result.peers, "device")}`,
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
    checkEviction(opened);
    await checkPersistence();
    await bootSync();
    stopClimb();
    bootView.hidden = true;
    reviewView.hidden = false;
    if (railStanding.matches) fillSidebar();
    await showSessionCard();
    await openGalleryFromUrl();
    pushAfterBoot();
    watchForUpdates();
    watchForNewDay(localDate(new Date()));
    void fillAccents(
      undefined,
      (text) => line(text, "good"),
      (text) => say(text, true),
      async (cardIds) => {
        for (const cardId of cardIds) await autoFill(cardId);
      },
    );
  } catch (cause) {
    line(String((cause as Error).message), "bad");
    line("nothing was written. Fix the above and reload.", "bad");
  }
}

void boot();
