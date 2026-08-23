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
import { mountPrepared, type MountedCard } from "../src/review/index.js";
import type { RenderResult } from "../src/render/index.js";
import type { ShadowingSide } from "../src/render/reveal.js";
import type { AppMessage, AppRequest, ReplyFor } from "./protocol.js";

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
  currentCardId = reply.card.cardId;
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
  deckLine.replaceChildren(document.createTextNode(reply.deckPath));
  if (reply.isNew) deckLine.appendChild(tag("new card", "newtag"));
  if (reply.reask) deckLine.appendChild(tag("again · not graded", "reasktag"));

  readingButton.hidden = card.mode.readingFieldId === null;
  readingButton.textContent = card.mode.reading ? "Reading → false" : "Reading → true";

  setState("prompt");
  // The mode-aware entry. On a produce card this plays nothing; on an identify
  // card it asks the question and leaves every cloze masked.
  for (const position of prompt) card.enter(position);

  // THE HINT DESCRIBES THE SCREEN, NOT THE CARD'S MODE, and that distinction was
  // a live bug: a REVERSE identify 単語 track said "listen, name the word" with
  // nothing to listen to. On a reverse track the permuted order puts 意味 first,
  // so the prompt side carries a cloze and NO clip — the audio sits on a later
  // side, where it is the ANSWER rather than the question.
  //
  // `promptsOnEntry` already gets that right, because it asks about the SIDE and
  // not about the card. This only has to stop claiming otherwise, so it reads the
  // loop's own log rather than re-deriving anything.
  const asked = card.loop.log.some((event) => event.kind === "prompt");
  hintLine.textContent = asked
    ? "listen, name the word, then reveal"
    : card.mode.mode === "identify"
      ? "name it, then reveal"
      : "say the contour aloud, then reveal";
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
      line(`graded · due ${reply.dueAt.slice(0, 10)} · ${reply.writeMs.toFixed(1)} ms write`, "good");
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
  if (navigator.storage?.persisted === undefined) {
    banner.textContent = "this browser cannot report storage persistence — export a backup often";
    banner.hidden = false;
    return;
  }
  if (await navigator.storage.persisted()) {
    banner.hidden = true;
    return;
  }
  const granted = (await navigator.storage.persist?.()) ?? false;
  if (granted) {
    banner.hidden = true;
    return;
  }
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
  if (event.repeat || reviewView.hidden) return;
  const key = event.key.toLowerCase();
  if (key === " " || key === "enter") {
    event.preventDefault();
    if (!revealed) reveal();
    return;
  }
  if (!revealed) return;
  if (key === "f") void grade(false);
  else if (key === "j") void grade(true);
  else if (key === "r") drill?.replay();
});

// A tap on a cloze reveals too — `shadowingLoop`'s `bindClozes` does that for
// free — so the screen has to follow the state it did not cause.
document.addEventListener(
  "click",
  (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(`.${CLASS.cloze}`) === null || revealed) return;
    reveal();
  },
  true,
);

async function boot(): Promise<void> {
  try {
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
        `${opened.progress.newCount} new)`,
      "good",
    );
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
