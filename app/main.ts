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
import type { RenderResult } from "../src/render/index.js";
import type { ShadowingSide } from "../src/render/reveal.js";
import type {
  AppMessage,
  AppRequest,
  BrowseHit,
  CardOp,
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

/** `data-state` on the review view, which is what `style.css` switches on. */
function setState(state: "prompt" | "revealed"): void {
  reviewView.setAttribute("data-state", state);
}

function visibleSides(result: RenderResult<HTMLElement>): number[] {
  return result.sides.filter((side) => !side.empty).map((side) => side.position);
}

/**
 * The question: the first non-empty side, plus a following widget-only side.
 *
 * See the header for why this is positional and not clever. The widget exception
 * is 漢字 and only 漢字 today — `<draw>` on its own side, which has to be on
 * screen while he draws from memory.
 */
function promptPositions(card: MountedCard<HTMLElement>): number[] {
  const shown = visibleSides(card.result);
  const first = shown[0];
  if (first === undefined) return [];
  const prompt = [first];
  const widgetPositions = new Set(
    card.result.widgets.map(
      (widget) => card.result.sides.find((side) => side.index === widget.side)?.position ?? -1,
    ),
  );
  for (const position of shown.slice(1)) {
    if (!widgetPositions.has(position)) break;
    const side = card.result.sides.find((entry) => entry.position === position);
    // Widget AND nothing else: a side that also carries text is an answer side.
    if (side === undefined || (side.element.textContent ?? "").trim() !== "") break;
    prompt.push(position);
  }
  return prompt;
}

function releaseCard(): void {
  for (const handle of drawHandles) handle.detach();
  drawHandles = [];
  mounted?.dispose();
  scope?.releaseAll();
  mounted = null;
  scope = null;
  drill = null;
  tail = [];
  cardHost.replaceChildren();
}

async function showNext(): Promise<void> {
  const reply = await ask<"next">({ kind: "next" });
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
    releaseCard();
    reviewView.hidden = true;
    doneView.hidden = false;
    doneText.textContent =
      `${reply.progress.answered} answered · ${reply.progress.reasksQueued} shown again`;
    return;
  }

  releaseCard();
  revealed = false;
  peekOffset = 0;
  currentCardId = reply.card.cardId;
  previewOfCurrent = reply.card;
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
      // A clip that cannot be produced is worth saying out loud on an identify
      // card: silence there is not a missing extra, it is the QUESTION going
      // missing. 14 of the 391 言葉 cards are in this state today.
      if (card.mode.mode === "identify") {
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
    await showNext();
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

// Keys, for the desktop pointer only — the keycap HINTS are behind
// `@media (hover:hover) and (pointer:fine)` in the stylesheet (decision 19: never
// behind a hover affordance, and a phone has no hover).
document.addEventListener("keydown", (event) => {
  if (event.repeat) return;

  // His #3 and #13, and both are global: they work over a layer, over the
  // gallery, and mid-review, because that is what a palette and an undo are for.
  const typing =
    event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !typing) {
    event.preventDefault();
    void runUndo();
    return;
  }
  // ESCAPE closes the top layer, and a layer swallows every other key. Without
  // this, space would grade the card UNDERNEATH the preview he is reading.
  if (layerHost.childElementCount > 0) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTop();
    }
    // `e` over a PREVIEW opens the editor for the previewed card — his request 3
    // is explicit that it works in both modes. Not while typing in the editor
    // itself, or every `e` he types would open another one.
    if (
      event.key.toLowerCase() === "e" &&
      !(event.target instanceof HTMLTextAreaElement) &&
      !(event.target instanceof HTMLInputElement)
    ) {
      event.preventDefault();
      openEditor();
    }
    return;
  }
  // The sidebar is navigation, so it answers to keys only when no layer is over
  // it — a layer is a thing he opened on purpose and owns the keyboard.
  if (document.body.classList.contains("sidebar-open")) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSidebar();
      return;
    }
    // Anything else belongs to the search box he is typing into.
    if (event.target instanceof HTMLInputElement) return;
  }
  if (event.key === "/" && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault();
    openSidebar();
    return;
  }
  if (reviewView.hidden) return;
  if (event.key.toLowerCase() === "e") {
    event.preventDefault();
    openEditor();
    return;
  }
  const key = event.key.toLowerCase();
  if (key === " " || key === "enter") {
    event.preventDefault();
    if (!revealed) reveal();
    return;
  }
  // His #7 and #9, on the review card. These act WITHOUT grading — stepping and
  // archiving are not answers, and none of them writes a review.
  if (key === "a" && currentCardId !== null) {
    event.preventDefault();
    void runCardOp("archive", currentCardId);
    return;
  }
  if (key === "d" && currentCardId !== null) {
    event.preventDefault();
    confirmDelete(currentCardId, previewOfCurrent?.loaded.name ?? currentCardId);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    void stepCard(1);
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    void stepCard(-1);
    return;
  }
  if (!revealed) return;
  if (key === "f") void grade(false);
  else if (key === "j") void grade(true);
  else if (key === "r") drill?.replay();
});

/**
 * His #9: step between cards WITHOUT registering a review.
 *
 * *"just wanna see what's next"*. So this does not touch the session cursor and
 * writes nothing — it PREVIEWS the neighbouring card, which is the honest way to
 * look ahead without answering. Moving the session cursor would either skip a card
 * or grade it, and both are worse than a preview.
 */
let peekOffset = 0;

async function stepCard(delta: number): Promise<void> {
  const next = peekOffset + delta;
  const reply = await ask<"next">({ kind: "next", offset: next });
  if (reply.card === null) {
    say(next > 0 ? "nothing further ahead" : "that is the first card");
    return;
  }
  peekOffset = next;
  if (peekOffset === 0) {
    // Back to the card he is actually on: close the look-ahead and show the real
    // one, so `reveal` and the grade buttons act on what he can see.
    await showNext();
    say("back to the card you were on");
    return;
  }
  await openPreview(reply.card.cardId);
  say(
    `${peekOffset > 0 ? "+" : ""}${peekOffset} — looking ahead, nothing graded ` +
      `(${reply.progress.answered}/${reply.progress.planned})`,
  );
}

el("prevcard").addEventListener("click", () => void stepCard(-1));
el("nextcard").addEventListener("click", () => void stepCard(1));
el("oparchive").addEventListener("click", () => {
  if (currentCardId !== null) void runCardOp("archive", currentCardId);
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
  head.append(title, close);
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
  document.body.classList.add("layered");
  close.focus();

  layers.push({ root, mounted, prepared: reply.card, cardId });
}

function closeIfTop(root: HTMLElement): void {
  if (layers.at(-1)?.root !== root) {
    // Not the top layer. Removing it would strand everything above it, so the
    // click does nothing — the same thing every stacked dialog does.
    if (root.parentElement === layerHost && !layers.some((entry) => entry.root === root)) {
      // A "card not found" layer, which carries no mount and is not on the stack.
      root.remove();
      if (layers.length === 0) document.body.classList.remove("layered");
    }
    return;
  }
  closeTop();
}

function closeTop(): void {
  const top = layers.pop();
  if (top === undefined) {
    // The missing-card layer, which never joined the stack.
    layerHost.lastElementChild?.remove();
    if (layerHost.childElementCount === 0) document.body.classList.remove("layered");
    return;
  }
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

function openEditor(): void {
  const target = editableCard();
  if (target === null) return;
  openEditorFor(target.card);
}

function openEditorFor(card: PreparedCard): void {
  const fields = card.loaded.template?.fields ?? [];
  if (fields.length === 0) return;

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
        .then(() => {
          status.textContent = `saved ${field.name}`;
          status.classList.remove("bad");
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
    }
    body.appendChild(row);
  }

  body.appendChild(status);
  layerHost.appendChild(root);
  document.body.classList.add("layered");
  layers.push({ root, mounted: null, prepared: null, cardId: card.cardId });
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

/** Children of `parentId`, in path order — the tree the flat list implies. */
function childrenOf(parentId: string | null): readonly DeckBrief[] {
  return deckIndex.filter((deck) => deck.parentId === parentId);
}

/** Cards in this deck AND everything under it, which is what a parent should say. */
function subtreeCards(deck: DeckBrief): { cards: number; due: number } {
  let cards = deck.cards;
  let due = deck.due;
  for (const child of childrenOf(deck.id)) {
    const under = subtreeCards(child);
    cards += under.cards;
    due += under.due;
  }
  return { cards, due };
}

function paintTree(total: number): void {
  deckList.replaceChildren();
  deckList.appendChild(navRow("everything", total, 0, 0, null, false));
  for (const root of childrenOf(null)) deckList.appendChild(deckNode(root, 0));

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
  row.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).classList.contains("tree-twist")) return;
    void openGallery(deck.id);
  });
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openDeckMenu(deck, row);
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
  layers.push({ root, mounted: null, prepared: null, cardId: "" });
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
type SortKey = "name" | "due" | "created";

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

  const name = document.createElement("h3");
  name.className = "gcard-name";
  name.textContent = hit.name === "" ? hit.cardId : hit.name;
  const meta = document.createElement("p");
  meta.className = "gcard-meta";
  meta.textContent = hit.archived ? `${hit.deckPath} · archived` : hit.deckPath;
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
    [hit.archived ? "unarchive" : "archive", () => void runCardOp(hit.archived ? "unarchive" : "archive", hit.cardId)],
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

async function runUndo(): Promise<void> {
  const entry = undoStack.pop();
  paintUndo();
  if (entry === undefined) return;
  await entry.run();
  say(`undid: ${entry.describe}`);
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

async function runCardOp(op: CardOp, cardId: string): Promise<void> {
  try {
    const reply = await ask<"cardOp">({ kind: "cardOp", op, cardId });
    say(reply.describe, op === "delete");
    if (reply.undo !== null) {
      const undo = reply.undo;
      pushUndo({
        describe: reply.describe,
        run: async () => {
          await ask<"cardOp">({ kind: "cardOp", op: undo.op, cardId: undo.cardId });
          await refreshAfterOp();
        },
      });
    }
    await refreshAfterOp();
  } catch (cause) {
    say((cause as Error).message, true);
  }
}

async function refreshAfterOp(): Promise<void> {
  await loadDecks(true);
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

function openConfirm(title: string, body: string, verb: string, run: () => void): void {
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
  go.className = "danger";
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
  layers.push({ root, mounted: null, prepared: null, cardId: "" });
  cancel.focus();
}

/** Open the editor for a card the page does not already hold prepared. */
async function openEditorById(cardId: string): Promise<void> {
  const reply = await ask<"preview">({ kind: "preview", cardId });
  if (reply.card !== null) openEditorFor(reply.card);
}

// ─── his #11 and #1 ─────────────────────────────────────────────────────────

/**
 * *"where can i edit my template? there should be a modal for editing template and
 * fields"* — his #11. This is the FIELD LIST and the body; it is deliberately not
 * a field-type editor yet, because changing a field's type is a data migration and
 * not a form.
 */
function openTemplateEditor(template: TemplateBrief): void {
  openConfirm(
    `${template.name} · ${template.fields} fields`,
    "Template editing is not built yet. What exists today is per-CARD field " +
      "editing (press e on any card). Editing the template BODY changes how every " +
      "card on it renders, and editing a field's type is a data migration — both " +
      "want more care than a text box.",
    "ok",
    () => {},
  );
}

/** His #1: the dashboard, from the sidebar. */
async function openDashboard(): Promise<void> {
  closeSidebar();
  openConfirm(
    "Dashboard",
    "The dashboard is generated by `npm run dashboard` as a standalone HTML file " +
      "with zero JavaScript (SPEC problem #1, battery). Wiring it into the app " +
      "means porting src/dashboard to run against the OPFS database in the worker — " +
      "real work, not a link. Recorded rather than faked.",
    "ok",
    () => {},
  );
}

/** Right-click a deck: his #14. */
function openDeckMenu(deck: DeckBrief, anchor: HTMLElement): void {
  void anchor;
  openConfirm(
    deck.path,
    `${deck.cards} cards. Archiving a deck marks the deck AND its cards, because ` +
      `the review queue filters on the card — two predicates that disagree is worse ` +
      `than one that is blunt. This is also the answer to your 数字 question: Mochi ` +
      `has no deck-level archive at all, so a deck you archived there arrived here ` +
      `unarchived.`,
    deck.archived ? "unarchive deck" : "archive deck",
    () => {
      void (async () => {
        try {
          const reply = await ask<"deckOp">({
            kind: "deckOp",
            op: deck.archived ? "unarchive" : "archive",
            deckId: deck.id,
          });
          say(reply.describe);
          if (reply.undo !== null) {
            const undo = reply.undo;
            pushUndo({
              describe: reply.describe,
              run: async () => {
                await ask<"deckOp">({ kind: "deckOp", op: undo.op, deckId: undo.deckId });
                await refreshAfterOp();
              },
            });
          }
          await refreshAfterOp();
        } catch (cause) {
          say((cause as Error).message, true);
        }
      })();
    },
  );
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
    await showNext();
  } catch (cause) {
    line(String((cause as Error).message), "bad");
    line("nothing was written. Fix the above and reload.", "bad");
  }
}

void boot();
