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
  // ESCAPE closes the top layer, and a layer swallows every other key. Without
  // this, space would grade the card UNDERNEATH the preview he is reading.
  if (layerHost.childElementCount > 0) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTop();
    }
    return;
  }
  if (reviewView.hidden) return;
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
  readonly mounted: MountedCard<HTMLElement>;
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
  document.body.classList.add("layered");
  close.focus();

  layers.push({ root, mounted, cardId });
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
  top.mounted.dispose();
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
