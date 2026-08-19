/**
 * THROWAWAY (spike harness) — the page where Zach sees his own cards for the
 * first time. An inspection harness over stage 4, not the review UI: there is no
 * grading, no queue and no scheduler anywhere in this file, because those need
 * his taste and belong to stage 7.
 *
 * WHAT IT IS FOR, in one sentence: to let him check, on his own phone, that a
 * clip is silent when a side appears and fires on the reveal.
 *
 * THE FOUR THINGS THIS FILE IS SHAPED BY
 *
 * 1. IT RENDERS THROUGH `src/render`, not a copy. `renderResolvedCard` builds the
 *    DOM; every class on a card comes from that module's `CLASS`; the only DOM
 *    this file creates inside a card is one `<span class="viewer-audio-note">` per
 *    media element, and one drawing surface's backing store.
 *
 * 2. NOTHING PLAYS, AND NOTHING IS EVEN FETCHED, UNTIL A REVEAL. Stepping onto a
 *    side sends no `payload` message, mints no object URL, assigns no `src` and
 *    calls no `play()`. The gate panel counts all four, from GLOBAL instruments
 *    installed before the first render, so the claim is measured rather than
 *    asserted — and the instruments catch a call from anywhere on the page, this
 *    file included.
 *
 * 3. THE SCOPE THAT MINTS A URL REVOKES IT. One `BlobUrlScope` per card
 *    presentation, `releaseAll()` when the card is replaced (src/blobs/url.ts,
 *    rules 1 and 2). Attachments are detached — pause, clear, load, revoke, in
 *    that order — before the scope is released.
 *
 * 4. POINTER, NOT MOUSE. He reviews on Android in Samsung Internet. Buttons use
 *    `click` (pointer-agnostic and keyboard-reachable), the drawing surface uses
 *    `pointerdown/move/up`, and nothing anywhere is revealed by hover.
 */

import { BlobUrlScope, attachMedia } from "../../src/blobs/url.js";
import {
  DATA,
  browserDocument,
  renderResolvedCard,
  type ClozeMount,
  type MediaMount,
  type RenderResult,
} from "../../src/render/index.js";
import { renderCard, type Direction, type TemplateInput } from "../../src/template/index.js";

import { bridgeSpeechFields, type Rewrite } from "./speech-bridge.js";
import type {
  AttachmentRow,
  CardBrief,
  CardBundle,
  DeckBrief,
  PayloadMessage,
  ViewerMessage,
  ViewerRequest,
} from "./protocol.js";

// ─── global instruments, installed FIRST ─────────────────────────────────────

/**
 * The hard rule is a claim about things that did NOT happen, so it is measured by
 * wrapping the two platform calls that would have to happen for a clip to be
 * heard — anywhere on this page, by any code, including this file's own.
 *
 * `HTMLMediaElement.prototype.play` is the only way audio starts (there is no
 * `autoplay` and no `src` in the renderer's output — see the audit button), and
 * `URL.createObjectURL` is the only way stored bytes become loadable, because
 * nothing in this app has a path. Two counters and a log line each.
 */
interface Instruments {
  plays: number;
  mints: number;
  revokes: number;
  payloadReads: number;
  readonly playLog: string[];
}
const instruments: Instruments = { plays: 0, mints: 0, revokes: 0, payloadReads: 0, playLog: [] };

((): void => {
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function instrumentedPlay(this: HTMLMediaElement): Promise<void> {
    instruments.plays += 1;
    const label = this.getAttribute("aria-label") ?? this.getAttribute(DATA.mediaKey) ?? "(unlabelled)";
    const note = `play() #${instruments.plays} on <${this.tagName.toLowerCase()}> ${label} — src=${
      this.getAttribute("src") === null ? "NONE" : "set"
    }`;
    instruments.playLog.push(note);
    write(note, this.getAttribute("src") === null ? "bad" : "good");
    return nativePlay.call(this);
  };

  const nativeCreate = URL.createObjectURL.bind(URL);
  const nativeRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource): string => {
    instruments.mints += 1;
    return nativeCreate(object);
  };
  URL.revokeObjectURL = (url: string): void => {
    instruments.revokes += 1;
    nativeRevoke(url);
  };
})();

// ─── the page ────────────────────────────────────────────────────────────────

const need = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`page markup is missing ${selector}`);
  return element;
};

const logElement = need<HTMLPreElement>("#log");
const stage = need<HTMLDivElement>("#stage");
const deckSelect = need<HTMLSelectElement>("#deck");
const cardSelect = need<HTMLSelectElement>("#card");
const cardIdInput = need<HTMLInputElement>("#cardid");
const chipsBar = need<HTMLDivElement>("#chips");
const demosBar = need<HTMLDivElement>("#demos");
const orderNote = need<HTMLSpanElement>("#order");
const bridgeButton = need<HTMLButtonElement>("#bridge");
const bridgeNote = need<HTMLSpanElement>("#bridgeNote");
const forwardButton = need<HTMLButtonElement>("#forward");
const reverseButton = need<HTMLButtonElement>("#reverse");

function write(text: string, level: "info" | "step" | "good" | "bad" | "warn" = "info"): void {
  const line = document.createElement("span");
  line.className = level === "info" ? "dim" : level === "step" ? "" : level;
  if (level === "step") line.style.fontWeight = "700";
  const stamp = new Date().toISOString().slice(11, 23);
  line.textContent = `${stamp}  ${text}\n`;
  logElement.append(line);
  logElement.scrollTop = logElement.scrollHeight;
}

function facts(target: HTMLElement, rows: readonly (readonly [string, string])[]): void {
  target.textContent = "";
  for (const [term, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    target.append(dt, dd);
  }
}

function rows(
  table: HTMLTableElement,
  cells: readonly (readonly (readonly [string, string])[])[],
): void {
  const body = table.tBodies[0];
  if (body === undefined) return;
  body.textContent = "";
  for (const cellRow of cells) {
    const tr = document.createElement("tr");
    for (const [text, className] of cellRow) {
      const td = document.createElement("td");
      td.textContent = text;
      if (className !== "") td.className = className;
      tr.append(td);
    }
    body.append(tr);
  }
}

const n = (value: number): string => value.toLocaleString("en-US");

// ─── the worker ──────────────────────────────────────────────────────────────

const worker = new Worker(new URL("./cards.worker.ts", import.meta.url), {
  type: "module",
  name: "hashigo-viewer",
});

let nextId = 0;
const pending = new Map<number, { resolve(message: ViewerMessage): void; reject(error: Error): void }>();

worker.onmessage = (event: MessageEvent<ViewerMessage>): void => {
  const message = event.data;
  if (message.kind === "log") {
    write(message.text, message.level);
    return;
  }
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  if (waiter === undefined) return;
  if (message.kind === "fail") waiter.reject(new Error(message.error));
  else waiter.resolve(message);
};

worker.onerror = (event: ErrorEvent): void => {
  write(`worker error: ${event.message} (${event.filename}:${event.lineno})`, "bad");
};

/**
 * `Omit` over a union collapses it into one object type, which would let a
 * `browse` request carry a `hash`. Distributing keeps the four request shapes
 * apart, so the compiler still checks which fields go with which `kind`.
 */
type WithoutId<T> = T extends { readonly id: number } ? Omit<T, "id"> : never;

function ask<T extends ViewerMessage>(request: WithoutId<ViewerRequest>): Promise<T> {
  const id = (nextId += 1);
  const full = { ...request, id } as ViewerRequest;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (m: ViewerMessage) => void, reject });
    worker.postMessage(full);
  });
}

// ─── state ───────────────────────────────────────────────────────────────────

/** How a clip was matched to an audio element. Printed, never hidden. */
type MatchTier = "ref_key" | "source_text" | "unclaimed" | "none";

interface AudioSlot {
  readonly mount: MediaMount<HTMLElement>;
  readonly element: HTMLElement;
  readonly note: HTMLSpanElement;
  readonly attachment: AttachmentRow | null;
  readonly tier: MatchTier;
  /** The text the generator would have said, for the report. */
  readonly text: string;
  /**
   * How to undo the attach. `attachMedia` for `<audio>`/`<video>`; a hand-rolled
   * pair for `<img>`, because `attachMedia`'s `detach()` calls `load()`, which an
   * `HTMLImageElement` does not have — routing an image through it threw a
   * TypeError out of teardown. Found by loading `Hz4r241V`, which has one.
   */
  live: { detach(): void } | null;
}

interface Presentation {
  readonly bundle: CardBundle;
  readonly direction: Direction;
  readonly result: RenderResult<HTMLElement>;
  readonly slots: readonly AudioSlot[];
  readonly rewrites: readonly Rewrite[];
  readonly scope: BlobUrlScope;
  readonly revealed: Set<number>;
  position: number;
  /** Instrument counters as they stood when the current side was entered. */
  entered: { plays: number; mints: number; payloadReads: number; label: string };
}

let current: Presentation | null = null;
let direction: Direction = "forward";
let bridgeOn = true;
let decks: readonly DeckBrief[] = [];

/** The cards make-viewer-db.ts pins, so audio is guaranteed for each. */
const DEMOS: readonly (readonly [string, string])[] = [
  ["29thh3wW", "単語 Reading=false"],
  ["ChtBgqLJ", "単語 Reading=true"],
  ["gARDCdEz", "漢字 draw"],
  ["pDN5aJ2O", "敬語 inline <speech>"],
  ["FnsfOCqt", "content card"],
  ["MhjRjdgV", "単語 links"],
];

// ─── rendering a card ────────────────────────────────────────────────────────

function templateInput(bundle: CardBundle): { template: TemplateInput | null; rewrites: readonly Rewrite[] } {
  if (bundle.template === null) return { template: null, rewrites: [] };
  const fields = bundle.template.fields.map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type,
  }));
  const bridged = bridgeOn
    ? bridgeSpeechFields(bundle.template.content, bundle.template.fields)
    : { content: bundle.template.content, rewrites: [] as readonly Rewrite[], unchanged: true };
  return {
    template: {
      id: bundle.template.id,
      content: bridged.content,
      fields,
      reversePermutation: bundle.template.reversePermutation ?? null,
    },
    rewrites: bridged.rewrites,
  };
}

/**
 * Which stored clip belongs to which audio element.
 *
 * Two exact rules and one honest guess, and the UI prints which one fired:
 *
 *   `ref_key`      the element came from an authored `@media/<file>` reference and
 *                  `MediaMount.reference.key` IS `blob_refs.ref_key`. Exact.
 *   `source_text`  the element came from a generator, and a `speech` blob on this
 *                  card has `source_text` equal to the text the generator would
 *                  say. This is the generation identity, minus the hashing that
 *                  stage 9 owns. Exact for the word clip on every 単語 card.
 *   `unclaimed`    a leftover `speech` blob assigned to a leftover element. A
 *                  GUESS, and labelled as one: it is what picks up the
 *                  example-SENTENCE clip, whose text lives inside an `ai`
 *                  generation this harness does not resolve.
 *
 * THE TIERS RUN AS THREE SEPARATE PASSES, and that is a bug fix rather than a
 * style: matching greedily in document order gave the RIGHT answers forward and
 * the WRONG ones in reverse. In reverse, 単語's empty `<<Audio>>` element comes
 * first, took the word clip as `unclaimed`, and left the sentence clip for the
 * element whose text was an exact match. Every exact match therefore has to be
 * settled before any guess is allowed to consume a clip.
 */
function matchAudio(
  result: RenderResult<HTMLElement>,
  bundle: CardBundle,
): { slots: AudioSlot[] } {
  const speech = bundle.attachments.filter((row) => row.kind === "speech");
  const claimed = new Set<string>();

  const generatorFor = (mount: MediaMount<HTMLElement>): string => {
    const owner = result.generations.find((generation) => generation.media === mount);
    return owner?.request?.text ?? "";
  };

  const draft = result.media.map((mount) => {
    const note = document.createElement("span");
    note.className = "viewer-audio-note";
    mount.element.insertAdjacentElement("afterend", note);
    return {
      mount,
      element: mount.element,
      note,
      text: mount.origin === "generator" ? generatorFor(mount) : "",
      attachment: null as AttachmentRow | null,
      tier: "none" as MatchTier,
      live: null as { detach(): void } | null,
    };
  });

  // Pass 1: `blob_refs.ref_key`, which is what `MediaMount.reference.key` IS.
  for (const slot of draft) {
    const key = slot.mount.reference.key;
    if (key === null) continue;
    const row = bundle.attachments.find((attachment) => attachment.refKey === key);
    if (row === undefined || claimed.has(row.hash)) continue;
    slot.attachment = row;
    slot.tier = "ref_key";
    claimed.add(row.hash);
  }
  // Pass 2: generation identity by text. Every exact match, before any guess.
  for (const slot of draft) {
    if (slot.attachment !== null || slot.text === "") continue;
    const row = speech.find(
      (attachment) =>
        !claimed.has(attachment.hash) && (attachment.sourceText ?? "").trim() === slot.text.trim(),
    );
    if (row === undefined) continue;
    slot.attachment = row;
    slot.tier = "source_text";
    claimed.add(row.hash);
  }
  // Pass 3: the leftovers, in document order, and labelled as a guess.
  for (const slot of draft) {
    if (slot.attachment !== null || slot.mount.kind !== "audio") continue;
    const row = speech.find((attachment) => !claimed.has(attachment.hash));
    if (row === undefined) continue;
    slot.attachment = row;
    slot.tier = "unclaimed";
    claimed.add(row.hash);
  }
  return { slots: draft };
}

function slotSummary(slot: AudioSlot): string {
  if (slot.attachment === null) {
    return `no clip found for this element (${slot.text === "" ? "no text to say" : `text "${slot.text}"`})`;
  }
  if (!slot.attachment.payloadPresent) {
    return `clip ${slot.attachment.refKey} is in the database but its payload is not in this ` +
      "harness subset — raise --speech-bytes in make-viewer-db.ts";
  }
  return `armed: ${slot.attachment.refKey}, ${n(slot.attachment.byteSize)} B, matched by ${slot.tier} — ` +
    "SILENT until you reveal this side";
}

function paintCard(): void {
  const presentation = current;
  if (presentation === null) return;
  const { bundle, result, rewrites } = presentation;

  // Sides: everything up to the current position is visible, the rest is `hidden`.
  // The renderer built them all; this only chooses what is on screen.
  for (const side of result.sides) {
    side.element.hidden = side.position > presentation.position;
  }

  // The side chips ARE the stepper: one tap per side, thumb-sized, always visible.
  chipsBar.textContent = "";
  for (const side of result.sides) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "viewer-chip";
    chip.textContent = `${side.position + 1}`;
    chip.title = `authored side ${side.index}`;
    chip.setAttribute("aria-pressed", String(side.position === presentation.position));
    chip.addEventListener("click", () => {
      goTo(side.position);
    });
    chipsBar.append(chip);
  }

  const order = result.sides.map((side) => side.index).join(" -> ");
  const declared = bundle.template?.reversePermutation ?? null;
  orderNote.textContent =
    `${presentation.direction}: authored sides ${order}` +
    (presentation.direction === "reverse"
      ? declared === null
        ? " (no reverse_permutation declared: the authored order reversed)"
        : ` (declared reverse_permutation ${JSON.stringify(declared)})`
      : "");

  bridgeNote.textContent =
    rewrites.length === 0
      ? bridgeOn
        ? "nothing to bridge on this card"
        : "off: a speech field resolves to nothing, so no <audio> exists"
      : rewrites
          .map((rewrite) =>
            rewrite.skipped === null
              ? `<<${rewrite.field}>> -> <speech>${rewrite.source}</speech>`
              : `<<${rewrite.field}>> left alone (${rewrite.skipped})`,
          )
          .join(" · ");

  const side = result.sides[presentation.position];
  const audioHere = presentation.slots.filter((slot) => slot.mount.side === side?.index);
  facts(need<HTMLElement>("#cardFacts"), [
    ["card", `${bundle.name || "(untitled)"}  [${bundle.id}]`],
    ["deck", bundle.deckPath],
    ["template", bundle.template === null ? "(none — sides come from cards.content)" : `${bundle.template.name} [${bundle.template.id}]`],
    ["reverse", `card ${bundle.cardReverse} · deck ${bundle.deckReverse}`],
    ["reviews", n(bundle.reviews)],
    ["field values", `${bundle.values.length} row(s)`],
    [
      "showing",
      `side ${presentation.position + 1} of ${result.sides.length} · authored index ${side?.index ?? "-"} · ` +
        `${result.clozes.filter((cloze) => cloze.side === side?.index).length} cloze(s) · ` +
        `${audioHere.length} audio element(s)`,
    ],
  ]);

  const census = [...result.census.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  facts(
    need<HTMLElement>("#census"),
    census.map(([kind, count]) => [kind, n(count)] as const),
  );
  rows(
    need<HTMLTableElement>("#diagnostics"),
    result.diagnostics.map(
      (diagnostic) =>
        [
          [diagnostic.side === -1 ? "card" : String(diagnostic.side), ""],
          [diagnostic.kind, diagnostic.kind === "resolver-warning" ? "warn" : "bad"],
          [diagnostic.detail, "wrap"],
        ] as const,
    ),
  );

  const mountRows: (readonly (readonly [string, string])[])[] = [];
  for (const cloze of result.clozes) {
    mountRows.push([
      ["cloze", ""],
      [String(cloze.side), ""],
      [
        `#${cloze.ordinal}${cloze.index === null ? "" : ` index ${cloze.index}`} · ${
          cloze.revealed ? "revealed" : "hidden"
        } · answer "${(cloze.answer.textContent ?? "").slice(0, 60)}"`,
        "wrap",
      ],
    ]);
  }
  for (const generation of result.generations) {
    mountRows.push([
      [`generator:${generation.name}`, ""],
      [String(generation.side), ""],
      [
        `${generation.request === null ? "no request" : `${generation.request.kind} lang=${generation.request.lang ?? "-"} voice=${generation.request.voice ?? "-"} text="${generation.request.text}"`}` +
          `${generation.media === null ? "" : " · has media"}`,
        "wrap",
      ],
    ]);
  }
  for (const widget of result.widgets) {
    mountRows.push([
      [`widget:${widget.name}`, ""],
      [String(widget.side), ""],
      [`${JSON.stringify(widget.attributes)}${widget.expected === null ? "" : ` expect=${widget.expected}`}`, "wrap"],
    ]);
  }
  for (const link of result.links) {
    mountRows.push([
      [`link:${link.kind}`, ""],
      [String(link.side), ""],
      [`${link.target} -> ${link.href}`, "wrap"],
    ]);
  }
  rows(need<HTMLTableElement>("#mounts"), mountRows);

  const matched = new Map<string, string>();
  for (const slot of presentation.slots) {
    if (slot.attachment !== null) {
      matched.set(slot.attachment.hash, `${slot.tier} -> side ${slot.mount.side} #${slot.mount.ordinal}`);
    }
  }
  rows(
    need<HTMLTableElement>("#attachments"),
    bundle.attachments.map(
      (attachment) =>
        [
          [attachment.kind, ""],
          [n(attachment.byteSize), ""],
          [attachment.refKey.length > 24 ? `${attachment.refKey.slice(0, 20)}…` : attachment.refKey, ""],
          [(attachment.sourceText ?? "").slice(0, 40), "wrap"],
          [`${attachment.voice ?? "-"} / ${attachment.lang ?? "-"}`, ""],
          [attachment.payloadPresent ? "present" : "not in subset", attachment.payloadPresent ? "good" : "warn"],
          [matched.get(attachment.hash) ?? "-", matched.has(attachment.hash) ? "good" : "dim"],
        ] as const,
    ),
  );

  for (const slot of presentation.slots) {
    if (slot.live !== null) continue;
    slot.note.dataset["armed"] = slot.attachment === null ? "none" : "locked";
    slot.note.textContent = slotSummary(slot);
  }
  paintGate();
}

/** The gate panel. Everything here is read off the live DOM, not remembered. */
function paintGate(): void {
  const presentation = current;
  const gate = need<HTMLElement>("#gate");
  if (presentation === null) {
    facts(gate, [["state", "no card loaded"]]);
    return;
  }
  const { result, slots, entered } = presentation;
  const side = result.sides[presentation.position];
  const here = slots.filter((slot) => slot.mount.side === side?.index);
  const withSrc = here.filter((slot) => slot.element.getAttribute("src") !== null).length;
  facts(gate, [
    [
      entered.label,
      `audio on this side ${here.length} · with src 0 · payload reads 0 · object URLs 0 · play() 0` +
        "   (deltas from the moment the side appeared)",
    ],
    [
      "now",
      `audio on this side ${here.length} · with src ${withSrc} · payload reads ${
        instruments.payloadReads - entered.payloadReads
      } · object URLs ${instruments.mints - entered.mints} · play() ${instruments.plays - entered.plays}`,
    ],
    [
      "whole page, since load",
      `play() ${instruments.plays} · object URLs minted ${instruments.mints}, revoked ${instruments.revokes} · ` +
        `payload reads ${instruments.payloadReads}`,
    ],
    [
      "scope",
      `${presentation.scope.live} live lease(s), ${n(presentation.scope.liveBytes)} B · ` +
        JSON.stringify(presentation.scope.stats),
    ],
  ]);

  rows(
    need<HTMLTableElement>("#gateTable"),
    slots.map((slot) => {
      const isMedia = slot.element instanceof HTMLMediaElement;
      const element = slot.element as HTMLMediaElement;
      const srcAttribute = slot.element.getAttribute("src");
      return [
        [String(slot.mount.side), ""],
        [slot.mount.kind, ""],
        [srcAttribute === null ? "NONE" : "set", srcAttribute === null ? "good" : ""],
        [!isMedia || element.currentSrc === "" ? '""' : `${element.currentSrc.slice(0, 28)}…`, ""],
        [isMedia ? String(element.networkState) : "-", ""],
        [isMedia ? String(element.readyState) : "-", ""],
        [slot.element.getAttribute("preload") ?? "(unset)", ""],
        [String(slot.element.hasAttribute("autoplay")), slot.element.hasAttribute("autoplay") ? "bad" : "good"],
        [String(slot.element.hasAttribute("loop")), slot.element.hasAttribute("loop") ? "bad" : "good"],
        [isMedia ? String(element.played.length) : "-", ""],
        [slot.attachment === null ? "-" : `${slot.attachment.refKey} (${slot.tier})`, ""],
      ] as const;
    }),
  );
}

// ─── stepping ────────────────────────────────────────────────────────────────

function enterSide(label: string): void {
  const presentation = current;
  if (presentation === null) return;
  presentation.entered = {
    plays: instruments.plays,
    mints: instruments.mints,
    payloadReads: instruments.payloadReads,
    label: `on ${label}`,
  };
  const side = presentation.result.sides[presentation.position];
  const here = presentation.slots.filter((slot) => slot.mount.side === side?.index);
  paintCard();
  write(
    `${label}: position ${presentation.position} = authored side ${side?.index ?? "-"} · ` +
      `${here.length} audio element(s), ${here.filter((slot) => slot.element.getAttribute("src") !== null).length} with a src · ` +
      `payload reads so far ${instruments.payloadReads}, play() ${instruments.plays}`,
    "step",
  );
}

function goTo(position: number): void {
  const presentation = current;
  if (presentation === null) return;
  const clamped = Math.max(0, Math.min(position, presentation.result.sides.length - 1));
  if (clamped === presentation.position) return;
  presentation.position = clamped;
  enterSide("side entry");
}

/**
 * Reveal the current side.
 *
 * Revealing the clozes fires their own `onReveal` listeners, and the audio hangs
 * off THAT — not off this function — so the wiring is the same one stage 7 will
 * use. A side with no cloze (敬語's first, 単語's third) has no reveal event of
 * its own, so this counts as the explicit reveal for that side and says so.
 */
function revealSide(): void {
  const presentation = current;
  if (presentation === null) return;
  const side = presentation.result.sides[presentation.position];
  if (side === undefined) return;
  const clozes = presentation.result.clozes.filter((cloze) => cloze.side === side.index);
  if (clozes.length === 0) {
    write(`reveal: authored side ${side.index} has no cloze — explicit reveal`, "step");
    void armSide(side.index, "explicit reveal (no cloze on this side)");
  } else {
    write(`reveal: revealing ${clozes.length} cloze(s) on authored side ${side.index}`, "step");
    for (const cloze of clozes) cloze.reveal();
  }
  paintCard();
}

/**
 * Attach and start the clips on one side. THE ONLY PLACE `play()` IS CALLED and
 * the only place a `payload` message is sent.
 */
async function armSide(authoredSide: number, why: string): Promise<void> {
  const presentation = current;
  if (presentation === null) return;
  if (presentation.revealed.has(authoredSide)) return;
  presentation.revealed.add(authoredSide);

  const here = presentation.slots.filter((slot) => slot.mount.side === authoredSide);
  if (here.length === 0) {
    write(`  no media on authored side ${authoredSide}; nothing to attach`);
    paintGate();
    return;
  }
  let started = false;
  for (const slot of here) {
    if (slot.attachment === null || !slot.attachment.payloadPresent) {
      write(`  ${slot.mount.kind}: ${slotSummary(slot)}`, "warn");
      continue;
    }
    const hash = slot.attachment.hash;
    instruments.payloadReads += 1;
    const message = await ask<PayloadMessage>({ kind: "payload", hash });
    if (message.bytes === null) {
      write(`  payload ${hash.slice(0, 12)} unavailable: ${message.error ?? "unknown"}`, "bad");
      continue;
    }
    if (!message.addressOk) {
      write(`  payload ${hash.slice(0, 12)} DOES NOT rehash to its address`, "bad");
      continue;
    }
    const lease = presentation.scope.claim({ hash, bytes: message.bytes, mime: message.mime });
    const element = slot.element as HTMLMediaElement;
    if (slot.mount.kind === "image") {
      // `attachMedia` is for media elements; see the note on `AudioSlot.live`.
      slot.element.setAttribute("src", lease.url);
      slot.live = {
        detach(): void {
          slot.element.removeAttribute("src");
          lease.revoke();
        },
      };
    } else {
      slot.live = attachMedia(element, lease);
    }
    slot.note.dataset["armed"] = "attached";
    slot.note.textContent =
      `attached ${slot.attachment.refKey} · ${n(message.bytes.byteLength)} B · ` +
      `sha256 verified · read from OPFS in ${message.readMs.toFixed(1)}ms · mime "${message.mime}" -> blob "${lease.mime}"`;
    write(
      `  ${why}: attached ${slot.attachment.refKey} (${n(message.bytes.byteLength)} B, ${slot.tier}) ` +
        `in ${message.readMs.toFixed(1)}ms`,
      "good",
    );
    if (slot.mount.kind === "audio" && !started) {
      started = true;
      element.play().then(
        () => {
          write(`  playing ${slot.attachment?.refKey ?? ""} — duration ${element.duration.toFixed(3)}s`, "good");
          paintGate();
        },
        (error: unknown) => {
          // Not a failure of the rule: a browser may refuse playback without a
          // user gesture. The reveal IS a gesture, so this should not fire — and
          // if it does, it is worth seeing rather than swallowing.
          write(`  play() rejected: ${String(error)} (element attached and ready to tap)`, "warn");
          paintGate();
        },
      );
    }
  }
  paintGate();
}

// ─── the drawing surface ─────────────────────────────────────────────────────

/**
 * Size and wire one `<canvas class="hashigo-draw">`.
 *
 * The renderer deliberately emits no width/height: a backing store has to be
 * sized to `devicePixelRatio` at mount or the strokes blur, and only the code
 * that knows the device can do it. PROVISIONAL: plain pointer strokes, the
 * authored brush colour and radius, no smoothing and no pressure — 漢字 is
 * "draw from memory, THEN see the answer", and how that should feel under a
 * finger is exactly the judgement this harness is not making for him.
 */
function wireCanvas(canvas: HTMLCanvasElement, attributes: Readonly<Record<string, string>>): void {
  const cssHeight = Number.parseInt(attributes["height"] ?? "300", 10) || 300;
  const colour = attributes["brushColor"] ?? "#FF0000";
  const radius = Number(attributes["brushRadius"] ?? "4") || 4;
  const resize = (): void => {
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 320;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.scale(ratio, ratio);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = colour;
    context.lineWidth = radius * 2;
  };
  resize();
  window.addEventListener("resize", resize);

  let drawing = false;
  const at = (event: PointerEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    const context = canvas.getContext("2d");
    if (context === null) return;
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    const [x, y] = at(event);
    context.beginPath();
    context.moveTo(x, y);
  });
  canvas.addEventListener("pointermove", (event: PointerEvent) => {
    if (!drawing) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const [x, y] = at(event);
    context.lineTo(x, y);
    context.stroke();
  });
  const end = (event: PointerEvent): void => {
    if (!drawing) return;
    drawing = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

// ─── loading a card ──────────────────────────────────────────────────────────

function teardown(): void {
  const presentation = current;
  if (presentation === null) return;
  // Order matters: detach each element (pause, clear src, load, revoke) before
  // releasing the scope, so no element is left holding a URL that no longer
  // resolves. src/blobs/url.ts rule 3.
  for (const slot of presentation.slots) slot.live?.detach();
  const released = presentation.scope.releaseAll();
  if (released > 0) write(`released ${released} object URL(s) with the previous card`);
  current = null;
  stage.textContent = "";
}

function present(bundle: CardBundle): void {
  teardown();
  const { template, rewrites } = templateInput(bundle);
  const linkNames = new Map(bundle.links.map(([id, name]) => [id, name] as const));
  const resolved = renderCard(
    { id: bundle.id, content: bundle.content, values: Object.fromEntries(bundle.values) },
    template,
    direction,
  );
  const canvases: { canvas: HTMLCanvasElement; attributes: Readonly<Record<string, string>> }[] = [];
  const result = renderResolvedCard(resolved, {
    document: browserDocument(document),
    resolveCardLink: (id: string) => {
      if (!linkNames.has(id)) return null;
      const name = linkNames.get(id) ?? null;
      return name === null ? {} : { name };
    },
    hooks: {
      widget: (mount) => {
        if (mount.name === "draw" && mount.element instanceof HTMLCanvasElement) {
          canvases.push({ canvas: mount.element, attributes: mount.attributes });
        }
      },
    },
  });

  const { slots } = matchAudio(result, bundle);
  const scope = new BlobUrlScope();
  current = {
    bundle,
    direction,
    result,
    slots,
    rewrites,
    scope,
    revealed: new Set<number>(),
    position: 0,
    entered: { plays: instruments.plays, mints: instruments.mints, payloadReads: instruments.payloadReads, label: "on side entry" },
  };

  // The audio wiring, and the whole point of the harness: it hangs off the
  // renderer's reveal event, so nothing this file does can start a clip early.
  result.onReveal((cloze: ClozeMount<HTMLElement>) => {
    void armSide(cloze.side, `cloze #${cloze.ordinal} revealed`);
  });

  stage.append(result.root);
  // Canvases can only be sized once they are in the document and have a width.
  for (const entry of canvases) wireCanvas(entry.canvas, entry.attributes);

  cardIdInput.value = bundle.id;
  write(
    `loaded ${bundle.id} "${bundle.name}" · ${bundle.deckPath} · template ${
      bundle.template?.name ?? "(none)"
    } · ${result.sides.length} sides · ${result.clozes.length} cloze(s) · ` +
      `${result.media.length} media mount(s) · ${bundle.attachments.length} blob ref(s)`,
    "step",
  );
  enterSide("side entry");
}

async function load(request: { cardId: string | null; deckId: string | null; withAudio: boolean }): Promise<void> {
  try {
    const message = await ask<{ kind: "card"; id: number; card: CardBundle }>({
      kind: "card",
      cardId: request.cardId,
      deckId: request.deckId,
      withAudio: request.withAudio,
    });
    present(message.card);
    await refreshCardList();
  } catch (error) {
    write(`could not load a card: ${String(error)}`, "bad");
  }
}

async function refreshCardList(): Promise<void> {
  const deckId = deckSelect.value === "" ? null : deckSelect.value;
  const message = await ask<{ kind: "cards"; id: number; cards: readonly CardBrief[] }>({
    kind: "browse",
    deckId,
    limit: 400,
  });
  cardSelect.textContent = "";
  for (const card of message.cards) {
    const option = document.createElement("option");
    option.value = card.id;
    option.textContent =
      `${card.name || "(untitled)"} — ${card.templateName ?? "no template"}` +
      `${card.audioBlobs > 0 ? ` · ${card.audioBlobs} clip(s)` : ""}`;
    option.selected = card.id === current?.bundle.id;
    cardSelect.append(option);
  }
  if (message.cards.length === 400) {
    const option = document.createElement("option");
    option.disabled = true;
    option.textContent = "… list truncated at 400; use Random or the id box";
    cardSelect.append(option);
  }
}

// ─── controls ────────────────────────────────────────────────────────────────

function setDirection(next: Direction): void {
  direction = next;
  forwardButton.setAttribute("aria-pressed", String(next === "forward"));
  reverseButton.setAttribute("aria-pressed", String(next === "reverse"));
  const bundle = current?.bundle;
  if (bundle !== undefined) present(bundle);
}

need<HTMLButtonElement>("#prev").addEventListener("click", () => {
  goTo((current?.position ?? 0) - 1);
});
need<HTMLButtonElement>("#next").addEventListener("click", () => {
  goTo((current?.position ?? 0) + 1);
});
need<HTMLButtonElement>("#reveal").addEventListener("click", () => {
  revealSide();
});
need<HTMLButtonElement>("#conceal").addEventListener("click", () => {
  const presentation = current;
  if (presentation === null) return;
  presentation.result.concealAll();
  write("concealed every cloze (conceal fires no listeners, by design)", "step");
  paintCard();
});
forwardButton.addEventListener("click", () => {
  setDirection("forward");
});
reverseButton.addEventListener("click", () => {
  setDirection("reverse");
});
bridgeButton.addEventListener("click", () => {
  bridgeOn = !bridgeOn;
  bridgeButton.setAttribute("aria-pressed", String(bridgeOn));
  bridgeButton.textContent = `Speech-field bridge: ${bridgeOn ? "ON" : "OFF"}`;
  write(`speech-field bridge ${bridgeOn ? "ON" : "OFF"} — re-rendering`, "step");
  const bundle = current?.bundle;
  if (bundle !== undefined) present(bundle);
});
need<HTMLButtonElement>("#load").addEventListener("click", () => {
  void load({ cardId: cardIdInput.value.trim(), deckId: null, withAudio: false });
});
need<HTMLButtonElement>("#random").addEventListener("click", () => {
  void load({ cardId: null, deckId: deckSelect.value === "" ? null : deckSelect.value, withAudio: false });
});
need<HTMLButtonElement>("#randomAudio").addEventListener("click", () => {
  void load({ cardId: null, deckId: deckSelect.value === "" ? null : deckSelect.value, withAudio: true });
});
cardSelect.addEventListener("change", () => {
  void load({ cardId: cardSelect.value, deckId: null, withAudio: false });
});
deckSelect.addEventListener("change", () => {
  void refreshCardList();
});
need<HTMLButtonElement>("#reimport").addEventListener("click", () => {
  void start(true);
});
need<HTMLButtonElement>("#audit").addEventListener("click", () => {
  audit();
});

/** Every media element in the page, read straight off the DOM. */
function audit(): void {
  const media = [...document.querySelectorAll<HTMLMediaElement>("audio, video")];
  write(`AUDIT: ${media.length} media element(s) in the document`, "step");
  let offenders = 0;
  for (const element of media) {
    const bad = element.hasAttribute("autoplay") || element.hasAttribute("loop");
    if (bad) offenders += 1;
    write(
      `  <${element.tagName.toLowerCase()} class="${element.className}"> ` +
        `src=${element.getAttribute("src") === null ? "NONE" : "set"} ` +
        `preload=${element.getAttribute("preload") ?? "(unset)"} ` +
        `autoplay=${element.hasAttribute("autoplay")} loop=${element.hasAttribute("loop")} ` +
        `currentSrc=${element.currentSrc === "" ? '""' : "set"} networkState=${element.networkState} ` +
        `readyState=${element.readyState} paused=${element.paused} played=${element.played.length}`,
      bad ? "bad" : "good",
    );
  }
  write(
    `  offenders (autoplay or loop): ${offenders} · play() calls page-wide: ${instruments.plays}` +
      `${instruments.playLog.length === 0 ? "" : ` [${instruments.playLog.join("; ")}]`}`,
    offenders === 0 ? "good" : "bad",
  );
}

/**
 * A DEBUG HANDLE, deliberately.
 *
 * `hashigoViewer.snapshot()` returns exactly what the gate panel shows, as data,
 * so the hard rule can be checked by a script — or by Zach in the phone's own dev
 * console — rather than by reading a table off a screen. It is also how the
 * evidence in the report was collected: step, snapshot, step, snapshot.
 */
interface ViewerSnapshot {
  readonly card: string | null;
  readonly direction: Direction;
  readonly bridge: boolean;
  readonly position: number;
  readonly authoredSide: number | null;
  readonly instruments: { plays: number; mints: number; revokes: number; payloadReads: number };
  readonly sides: readonly {
    position: number;
    side: number;
    hidden: boolean;
    /** Every text node the renderer produced, concealed answers included. */
    text: string;
    /** What is actually on screen: `[hidden]` subtrees dropped. */
    visible: string;
  }[];
  readonly media: readonly Record<string, unknown>[];
  readonly diagnostics: readonly { kind: string; side: number; detail: string }[];
  readonly census: Record<string, number>;
}

function snapshot(): ViewerSnapshot {
  const presentation = current;
  // The harness's own annotations are stripped before the text is read, so the
  // evidence is the RENDERER's output and not this file's commentary on it.
  const textOf = (element: HTMLElement, dropHidden: boolean): string => {
    const clone = element.cloneNode(true) as HTMLElement;
    for (const note of clone.querySelectorAll(".viewer-audio-note")) note.remove();
    if (dropHidden) for (const hidden of clone.querySelectorAll("[hidden]")) hidden.remove();
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  };
  const sides = [...document.querySelectorAll<HTMLElement>(".hashigo-side")].map((element) => ({
    position: Number(element.getAttribute(DATA.position) ?? -1),
    side: Number(element.getAttribute(DATA.side) ?? -1),
    hidden: element.hidden,
    text: textOf(element, false),
    visible: textOf(element, true),
  }));
  const media = (presentation?.slots ?? []).map((slot) => {
    // `<img>` has none of `currentSrc`'s media siblings, so every one of them is
    // read through `isMedia`. Reading `played.length` off an image is what threw
    // out of this function the first time an image card was loaded.
    const isMedia = slot.element instanceof HTMLMediaElement;
    const element = slot.element as HTMLMediaElement;
    return {
      side: slot.mount.side,
      kind: slot.mount.kind,
      label: slot.element.getAttribute("aria-label"),
      srcAttribute: slot.element.getAttribute("src") === null ? "NONE" : "set",
      currentSrc: !isMedia || element.currentSrc === "" ? "" : `${element.currentSrc.slice(0, 32)}…`,
      networkState: isMedia ? element.networkState : null,
      readyState: isMedia ? element.readyState : null,
      preload: slot.element.getAttribute("preload"),
      autoplay: slot.element.hasAttribute("autoplay"),
      loop: slot.element.hasAttribute("loop"),
      paused: isMedia ? element.paused : null,
      played: isMedia ? element.played.length : null,
      currentTime: isMedia ? Number(element.currentTime.toFixed(3)) : null,
      duration: isMedia && Number.isFinite(element.duration) ? Number(element.duration.toFixed(3)) : null,
      clip: slot.attachment?.refKey ?? null,
      bytes: slot.attachment?.byteSize ?? null,
      tier: slot.tier,
      note: slot.note.textContent,
    };
  });
  return {
    card: presentation?.bundle.id ?? null,
    direction,
    bridge: bridgeOn,
    position: presentation?.position ?? -1,
    authoredSide: presentation?.result.sides[presentation.position]?.index ?? null,
    instruments: {
      plays: instruments.plays,
      mints: instruments.mints,
      revokes: instruments.revokes,
      payloadReads: instruments.payloadReads,
    },
    sides,
    media,
    diagnostics: (presentation?.result.diagnostics ?? []).map((diagnostic) => ({
      kind: diagnostic.kind,
      side: diagnostic.side,
      detail: diagnostic.detail,
    })),
    census: Object.fromEntries(presentation?.result.census ?? new Map()),
  };
}

(globalThis as unknown as { hashigoViewer: unknown }).hashigoViewer = {
  snapshot,
  audit,
  instruments,
};

// `#/card/<id>` is the href the renderer mints for a wiki-link. Following it here
// costs nothing and checks that the contract is usable.
window.addEventListener("hashchange", () => {
  const match = /^#\/card\/(.+)$/.exec(location.hash);
  if (match?.[1] === undefined) return;
  void load({ cardId: decodeURIComponent(match[1]), deckId: null, withAudio: false });
});

// ─── start ───────────────────────────────────────────────────────────────────

for (const [id, label] of DEMOS) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    void load({ cardId: id, deckId: null, withAudio: false });
  });
  demosBar.append(button);
}

async function start(reimport: boolean): Promise<void> {
  logElement.textContent = "";
  facts(need<HTMLElement>("#facts"), [["state", "opening…"]]);
  try {
    const opened = await ask<{
      kind: "opened";
      id: number;
      facts: readonly (readonly [string, string])[];
      oracle: readonly (readonly [string, string])[];
      decks: readonly DeckBrief[];
    }>({ kind: "open", reimport });
    decks = opened.decks;
    facts(need<HTMLElement>("#facts"), [
      ["mode", import.meta.env.DEV ? "vite dev server" : "built bundle"],
      ["origin", location.origin],
      ["devicePixelRatio", String(window.devicePixelRatio)],
      ["viewport", `${window.innerWidth}x${window.innerHeight}`],
      ["pointer: coarse", String(window.matchMedia("(pointer: coarse)").matches)],
      ["display-mode: standalone", String(window.matchMedia("(display-mode: standalone)").matches)],
      ...opened.facts,
      ...opened.oracle,
    ]);
    deckSelect.textContent = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = `(every deck) — ${n(decks.reduce((sum, deck) => sum + deck.cards, 0))} cards`;
    deckSelect.append(all);
    for (const deck of decks) {
      const option = document.createElement("option");
      option.value = deck.id;
      option.textContent = `${deck.path} — ${n(deck.cards)} card(s), ${n(deck.withAudio)} with audio`;
      deckSelect.append(option);
    }
    await refreshCardList();
    const hash = /^#\/card\/(.+)$/.exec(location.hash);
    await load({
      cardId: hash?.[1] === undefined ? (DEMOS[0]?.[0] ?? null) : decodeURIComponent(hash[1]),
      deckId: null,
      withAudio: false,
    });
  } catch (error) {
    write(`could not open: ${String(error)}`, "bad");
    facts(need<HTMLElement>("#facts"), [["state", `failed: ${String(error)}`]]);
  }
}

void start(false);
