import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BlobUrlScope, type BlobPayload } from "../src/blobs/url.js";
import { fieldValueText } from "../src/import/entities.js";
import {
  asRecord,
  asRecords,
  asText,
  isRecord,
  loadExport,
  walkCards,
  type MochiRecord,
} from "../src/import/transit.js";
import { parseContent, resolveCard, type TemplateInput } from "../src/template/index.js";
import {
  MemoryElement,
  MemoryText,
  memoryDocument,
  renderResolvedCard,
  renderSides,
  serialise,
  type MediaMount,
  type RenderDocument,
  type RenderResult,
} from "../src/render/index.js";
import {
  AUDIO_DATA,
  audioAddress,
  audioController,
  type AudioAddress,
  type AudioController,
  type AudioOutcome,
  type PlayableMediaElement,
} from "../src/render/audio.js";
import {
  REVEAL_ATTRIBUTES,
  shadowingLoop,
  type ActivationTarget,
  type RevealAudio,
  type RevealEvent,
  type ShadowingLoop,
} from "../src/render/reveal.js";

export const audioElementSatisfiesPort: PlayableMediaElement =
  null as unknown as HTMLAudioElement;
export const videoElementSatisfiesPort: PlayableMediaElement =
  null as unknown as HTMLVideoElement;
export const htmlElementIsActivatable: ActivationTarget = null as unknown as HTMLElement;
export const controllerSatisfiesRevealAudio: RevealAudio<MemoryElement> =
  null as unknown as AudioController<MemoryElement>;

class LiveElement extends MemoryElement {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeMedia extends LiveElement {
  plays = 0;
  pauses = 0;
  loads = 0;
  currentTime = 0;
  #paused = true;
  rejectPlay: string | null = null;

  get src(): string {
    return this.getAttribute("src") ?? "";
  }

  set src(value: string) {
    this.setAttribute("src", value);
  }

  get paused(): boolean {
    return this.#paused;
  }

  play(): Promise<void> {
    this.plays += 1;
    if (this.rejectPlay !== null) return Promise.reject(new Error(this.rejectPlay));
    this.#paused = false;
    this.dispatch("play");
    return Promise.resolve();
  }

  pause(): void {
    this.pauses += 1;
    this.#paused = true;
  }

  load(): void {
    this.loads += 1;
  }
}

function liveDocument(): RenderDocument<MemoryElement> {
  return {
    createElement: (tag) =>
      tag === "audio" || tag === "video" ? new FakeMedia(tag) : new LiveElement(tag),
    createTextNode: (data) => new MemoryText(data),
  };
}

function payloadFor(seed: string, bytes = 64): BlobPayload {
  let hash = "";
  for (let index = 0; hash.length < 64; index += 1) {
    hash += Math.abs(hashCode(`${seed}:${index}`)).toString(16).padStart(8, "0");
  }
  return {
    hash: hash.slice(0, 64),
    bytes: new Uint8Array(bytes).fill(7),
    mime: "audio/mpeg",
  };
}

function hashCode(text: string): number {
  let value = 0;
  for (const character of text) value = (value * 31 + character.codePointAt(0)!) | 0;
  return value;
}

function urlRecorder(): {
  readonly minted: string[];
  readonly revoked: string[];
  readonly options: { createObjectURL: (blob: Blob) => string; revokeObjectURL: (url: string) => void };
} {
  const minted: string[] = [];
  const revoked: string[] = [];
  return {
    minted,
    revoked,
    options: {
      createObjectURL: (blob: Blob) => {
        const url = `blob:https://hashigo.test/${minted.length}-${blob.size}`;
        minted.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    },
  };
}

interface Harness {
  readonly result: RenderResult<MemoryElement>;
  readonly loop: ShadowingLoop<MemoryElement>;
  readonly audio: AudioController<MemoryElement>;
  readonly scope: BlobUrlScope;
  readonly urls: ReturnType<typeof urlRecorder>;
  readonly requests: AudioAddress[];
  readonly outcomes: AudioOutcome<MemoryElement>[];
  readonly events: RevealEvent<MemoryElement>[];
  media(index?: number): FakeMedia;
  cloze(index: number): LiveElement;
}

function harness(
  text: string,
  options: { readonly store?: ReadonlyMap<string, BlobPayload>; readonly armMedia?: boolean } = {},
): Harness {
  const store = options.store ?? new Map<string, BlobPayload>();
  const urls = urlRecorder();
  const scope = new BlobUrlScope(urls.options);
  const requests: AudioAddress[] = [];
  const outcomes: AudioOutcome<MemoryElement>[] = [];
  const events: RevealEvent<MemoryElement>[] = [];
  const result = renderSides(parseContent(text), { document: liveDocument() });
  const audio = audioController(result, {
    scope,
    resolve: (address) => {
      requests.push(address);
      return store.get(addressKey(address)) ?? null;
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const loop = shadowingLoop(result, {
    audio,
    onEvent: (event) => events.push(event),
    ...(options.armMedia === undefined ? {} : { armMedia: options.armMedia }),
  });
  return {
    result,
    loop,
    audio,
    scope,
    urls,
    requests,
    outcomes,
    events,
    media(index = 0) {
      const mount = result.media.filter((entry) => entry.kind === "audio")[index];
      if (mount === undefined) throw new Error(`no audio mount ${index}`);
      return mount.element as FakeMedia;
    },
    cloze(index) {
      const mount = result.clozes[index];
      if (mount === undefined) throw new Error(`no cloze ${index}`);
      return mount.element as LiveElement;
    },
  };
}

function addressKey(address: AudioAddress): string {
  return address.origin === "attachment"
    ? `attachment:${address.key}`
    : `${address.request.kind}:${address.request.lang ?? ""}:${address.request.text}`;
}

const AUDIO_ATTACHMENT = "![Copilot_Audio_20260122_194103.mp3](uVQp0iMb.mp3)";
const SHADOWING_SIDE = `{{あらかた}}\n${AUDIO_ATTACHMENT}`;
const CLIP = payloadFor("uVQp0iMb.mp3");
const STORE = new Map<string, BlobPayload>([["attachment:uVQp0iMb.mp3", CLIP]]);

describe("the hard rule: audio fires on reveal, never on side entry", () => {
  it("requests NO audio when a side is rendered and entered", () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    expect(h.requests).toEqual([]);
    expect(h.urls.minted).toEqual([]);
    expect(h.media().plays).toBe(0);

    for (const side of h.loop.sides) h.loop.enter(side.position);
    expect(h.loop.sides.map((side) => side.entered)).toEqual([true]);
    expect(h.requests).toEqual([]);
    expect(h.urls.minted).toEqual([]);
    expect(h.audio.stats.requested).toBe(0);
    expect(h.media().plays).toBe(0);
    expect(h.media().hasAttribute("src")).toBe(false);
    expect(h.media().getAttribute(AUDIO_DATA.state)).toBe("idle");
    expect(serialise(h.media())).toBe(
      '<audio class="hashigo-audio" data-media-kind="audio" data-media-ref="uVQp0iMb.mp3"' +
        ' data-media-key="uVQp0iMb.mp3" controls="" preload="none"' +
        ' aria-label="Copilot_Audio_20260122_194103.mp3" data-audio-state="idle"></audio>',
    );
    expect(h.events.map((event) => [event.kind, event.audio])).toEqual([["enter", 0]]);
  });

  it("requests and plays the audio ON REVEAL, once he has produced the reading", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.enter(0);
    expect(h.loop.side(0)?.trigger).toBe("cloze");

    expect(h.loop.side(0)?.reveal("cloze")).toBe(true);
    await h.audio.idle();

    expect(h.requests).toEqual([{ origin: "attachment", key: "uVQp0iMb.mp3" }]);
    expect(h.audio.stats.requested).toBe(1);
    expect(h.urls.minted).toHaveLength(1);
    expect(h.media().src).toBe(h.urls.minted[0]);
    expect(h.media().plays).toBe(1);
    expect(h.media().paused).toBe(false);
    expect(h.media().getAttribute(AUDIO_DATA.state)).toBe("playing");
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["playing"]);
    expect(h.outcomes[0]?.reason).toBe("reveal");
    expect(h.outcomes[0]?.hash).toBe(CLIP.hash);
    expect(h.result.clozes[0]?.revealed).toBe(true);
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("true");
  });

  it("revokes the blob: URL, so a long session leaks nothing", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    const url = h.urls.minted[0];
    expect(url).toBeDefined();
    expect(h.scope.live).toBe(1);

    h.loop.dispose();

    expect(h.urls.revoked).toEqual([url]);
    expect(h.scope.live).toBe(0);
    expect(h.scope.liveBytes).toBe(0);
    expect(h.media().hasAttribute("src")).toBe(false);
    expect(h.media().pauses).toBeGreaterThan(0);
    expect(h.media().loads).toBe(1);
    h.loop.dispose();
    expect(h.urls.revoked).toEqual([url]);
  });

  it("holds nothing after a 40-card session — one URL per clip, all of them released", async () => {
    const urls = urlRecorder();
    let live = 0;
    let peak = 0;
    for (let card = 0; card < 40; card += 1) {
      const scope = new BlobUrlScope(urls.options);
      const payload = payloadFor(`clip-${card}`, 60_551);
      const result = renderSides(parseContent(`{{答え}}\n![clip](card${card}.mp3)`), {
        document: liveDocument(),
      });
      const audio = audioController(result, {
        scope,
        resolve: () => payload,
      });
      const loop = shadowingLoop(result, { audio });
      loop.enter(0);
      loop.side(0)?.reveal("cloze");
      await audio.idle();
      live += 1;
      peak = Math.max(peak, scope.live);
      loop.dispose();
      live -= 1;
      expect(scope.live).toBe(0);
    }
    expect(urls.minted).toHaveLength(40);
    expect(urls.revoked).toHaveLength(40);
    expect(new Set(urls.revoked)).toEqual(new Set(urls.minted));
    expect(peak).toBe(1);
    expect(live).toBe(0);
  });
});

describe("prompt(): the mode-2 question", () => {
  it("plays without unmasking, which is the whole difference from play()", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    expect(h.requests).toEqual([]);
    expect(side.revealed).toBe(false);

    expect(side.prompt()).toBe(true);
    await h.audio.idle();

    expect(h.media().plays).toBe(1);
    expect(h.requests).toHaveLength(1);
    expect(h.outcomes.map((o) => o.reason)).toEqual(["prompt"]);
    expect(side.revealed).toBe(false);
    expect(h.result.clozes.every((cloze) => !cloze.revealed)).toBe(true);
    expect(h.events.map((e) => e.kind)).toEqual(["enter", "prompt"]);
    expect(h.events.at(-1)?.clozes).toBe(0);
    h.loop.dispose();
  });

  it("and play() on the same side DOES unmask — the contrast, asserted", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    const mount = h.result.media.find((m) => m.kind === "audio")!;
    expect(side.play(mount)).toBe(true);
    await h.audio.idle();
    expect(side.revealed).toBe(true);
    h.loop.dispose();
  });

  it("returns false where there is no question to ask", () => {
    const h = harness("{{あらかた}}");
    const side = h.loop.enter(0)!;
    expect(side.prompt()).toBe(false);
    expect(h.events.map((e) => e.kind)).toEqual(["enter"]);
    expect(side.revealed).toBe(false);
    h.loop.dispose();
  });

  it("reveal({silent}) unmasks and sounds NOTHING", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    expect(side.reveal("caller", { silent: true })).toBe(true);
    await h.audio.idle();
    expect(side.revealed).toBe(true);
    expect(h.result.clozes.every((cloze) => cloze.revealed)).toBe(true);
    expect(h.requests).toEqual([]);
    expect(h.urls.minted).toEqual([]);
    expect(h.media().plays).toBe(0);
    expect(h.events.at(-1)?.audio).toBe(0);
    h.loop.dispose();
  });

  it("and the same side WITHOUT silent does sound — the pairing", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    expect(side.reveal("caller")).toBe(true);
    await h.audio.idle();
    expect(h.media().plays).toBe(1);
    h.loop.dispose();
  });

  it("a reveal AFTER a prompt still works, and is what compares", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const side = h.loop.enter(0)!;
    side.prompt();
    await h.audio.idle();
    expect(side.reveal("caller")).toBe(true);
    await h.audio.idle();
    expect(side.revealed).toBe(true);
    expect(h.media().plays).toBe(2);
    expect(h.urls.minted).toHaveLength(1);
    h.loop.dispose();
  });
});

describe("cloze grouping", () => {
  const TWO_CLOZES = "{{あらかた}}\n{{<furigana>粗方</furigana>}}";

  it("reveals ONE cloze per tap, in document order, and never crosses the side", () => {
    const h = harness(`${TWO_CLOZES}\n---\n{{意味}}`);
    expect(h.result.clozes).toHaveLength(3);
    expect(h.loop.sides.map((side) => side.clozes.length)).toEqual([2, 1]);

    h.cloze(0).dispatch("click");

    expect(h.result.clozes.map((mount) => mount.revealed)).toEqual([true, false, false]);
    expect(h.loop.sides.map((side) => side.revealed)).toEqual([false, false]);
    expect(h.loop.sides[0]?.masked).toBe(1);
    expect(h.events.filter((event) => event.kind === "step")).toHaveLength(1);
    expect(h.events.filter((event) => event.kind === "reveal")).toHaveLength(0);

    h.cloze(1).dispatch("click");

    expect(h.result.clozes.map((mount) => mount.revealed)).toEqual([true, true, false]);
    expect(h.loop.sides.map((side) => side.revealed)).toEqual([true, false]);
    expect(h.events.filter((event) => event.kind === "reveal")).toHaveLength(1);
    expect(h.events.find((event) => event.kind === "reveal")?.clozes).toBe(2);
  });

  it("steps in order from revealNext(), and sounds the clip only on the LAST one", async () => {
    const h = harness(`{{あらかた}}\n{{<furigana>粗方</furigana>}}\n![clip](uVQp0iMb.mp3)`, {
      store: STORE,
    });
    const side = h.loop.side(0);
    expect(side?.masked).toBe(2);

    expect(side?.revealNext()).toBe(true);
    await h.audio.idle();
    expect(h.result.clozes.map((mount) => mount.revealed)).toEqual([true, false]);
    expect(h.audio.stats.requested).toBe(0);
    expect(h.media().plays).toBe(0);

    expect(side?.revealNext()).toBe(true);
    await h.audio.idle();
    expect(side?.revealed).toBe(true);
    expect(h.media().plays).toBe(1);
    expect(h.outcomes[0]?.reason).toBe("reveal");

    expect(side?.revealNext()).toBe(false);
    expect(h.media().plays).toBe(1);
  });

  it("counts a cloze revealed by ANY route, including result.revealAll()", () => {
    const direct = harness(TWO_CLOZES);
    direct.result.clozes[1]?.reveal();
    expect(direct.loop.sides[0]?.revealed).toBe(false);
    expect(direct.loop.sides[0]?.masked).toBe(1);
    direct.result.clozes[0]?.reveal();
    expect(direct.loop.sides[0]?.revealed).toBe(true);
    expect(direct.result.clozes.map((mount) => mount.revealed)).toEqual([true, true]);

    const all = harness(`${TWO_CLOZES}\n---\n{{意味}}`);
    all.result.revealAll();
    expect(all.loop.sides.map((side) => side.revealed)).toEqual([true, true]);
    expect(all.events.filter((event) => event.kind === "reveal")).toHaveLength(2);
  });

  it("is keyboard reachable and announces itself", () => {
    const h = harness("{{答え}}");
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.role)).toBe("button");
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.tabIndex)).toBe("0");
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("false");

    let prevented = 0;
    h.cloze(0).dispatch("keydown", { key: "x", preventDefault: () => (prevented += 1) });
    expect(h.loop.sides[0]?.revealed).toBe(false);
    h.cloze(0).dispatch("keydown", { key: " ", preventDefault: () => (prevented += 1) });
    expect(h.loop.sides[0]?.revealed).toBe(true);
    expect(prevented).toBe(1);
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("true");
  });

  it("re-masks on conceal and pauses the clip, then replays on the next reveal", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    h.loop.side(0)?.conceal();
    expect(h.result.clozes[0]?.revealed).toBe(false);
    expect(h.media().paused).toBe(true);
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("false");
    expect(h.scope.live).toBe(1);

    h.loop.side(0)?.reveal();
    await h.audio.idle();
    expect(h.media().plays).toBe(2);
    expect(h.urls.minted).toHaveLength(1);
    expect(h.audio.stats.requested).toBe(1);
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["playing", "replayed"]);
  });

  it("leaves a render with no clozes and no audio at trigger `none`", () => {
    const h = harness("路線\nroute");
    expect(h.loop.sides.map((side) => side.trigger)).toEqual(["none"]);
    h.loop.enter(0);
    expect(h.loop.side(0)?.reveal()).toBe(true);
    expect(h.requests).toEqual([]);
  });
});

describe("a side with audio but no cloze", () => {
  const AUDIO_ALONE = `例文を読んでください。\n${AUDIO_ATTACHMENT}`;

  it("classifies the side and still plays nothing on entry", () => {
    const h = harness(AUDIO_ALONE, { store: STORE });
    expect(h.loop.side(0)?.trigger).toBe("audio");
    expect(h.loop.side(0)?.clozes).toEqual([]);
    h.loop.enter(0);
    expect(h.requests).toEqual([]);
    expect(h.media().plays).toBe(0);
  });

  it("plays on the review UI's own reveal call", async () => {
    const h = harness(AUDIO_ALONE, { store: STORE });
    h.loop.enter(0);
    expect(h.loop.side(0)?.reveal("caller")).toBe(true);
    await h.audio.idle();
    expect(h.media().plays).toBe(1);
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["playing"]);
  });

  it("plays on the element's own play affordance, exactly once, then unbinds", async () => {
    const h = harness(AUDIO_ALONE, { store: STORE });
    h.loop.enter(0);
    expect(h.media().count("click")).toBe(1);
    expect(h.media().count("play")).toBe(1);

    h.media().dispatch("click");
    await h.audio.idle();

    expect(h.loop.side(0)?.revealed).toBe(true);
    expect(h.events.find((event) => event.kind === "reveal")?.cause).toBe("gesture");
    expect(h.media().plays).toBe(1);
    expect(h.media().count("click")).toBe(0);
    expect(h.media().count("play")).toBe(0);
    expect(h.audio.stats.requested).toBe(1);
    expect(h.urls.minted).toHaveLength(1);
  });

  it("stops interpreting gestures once the element has a source", async () => {
    const h = harness(AUDIO_ALONE, { store: STORE });
    h.loop.side(0)?.reveal("caller");
    await h.audio.idle();
    expect(h.media().plays).toBe(1);
    expect(h.media().count("play")).toBe(0);
    expect(h.media().count("click")).toBe(0);

    h.media().dispatch("click");
    expect(h.media().plays).toBe(1);
    expect(h.audio.stats.requested).toBe(1);
  });

  it("stays tappable when the clip was missing, because nothing got attached", async () => {
    const h = harness(AUDIO_ALONE);
    h.media().dispatch("click");
    await h.audio.idle();
    expect(h.audio.stats.missing).toBe(1);
    expect(h.media().hasAttribute("src")).toBe(false);
    expect(h.media().count("click")).toBe(1);

    h.media().dispatch("click");
    await h.audio.idle();
    expect(h.audio.stats.missing).toBe(2);
  });

  it("arms nothing when asked not to, and then only the caller can start it", () => {
    const h = harness(AUDIO_ALONE, { store: STORE, armMedia: false });
    expect(h.media().count("click")).toBe(0);
    h.media().dispatch("click");
    expect(h.loop.side(0)?.revealed).toBe(false);
    expect(h.requests).toEqual([]);
  });

  it("starts the FIRST clip only and defers the rest of the side", async () => {
    const store = new Map<string, BlobPayload>([
      ["attachment:a.mp3", payloadFor("a")],
      ["attachment:b.mp3", payloadFor("b")],
    ]);
    const h = harness("![a](a.mp3)\n![b](b.mp3)", { store });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["deferred", "playing"]);
    expect(h.media(0).plays).toBe(1);
    expect(h.media(1).plays).toBe(0);
    expect(h.urls.minted).toHaveLength(1);
    h.media(1).dispatch("click");
    await h.audio.idle();
    expect(h.media(1).plays).toBe(1);
    expect(h.urls.minted).toHaveLength(2);
  });
});

describe("replaying deliberately", () => {
  it("restarts from the top and mints no second object URL", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    h.media().currentTime = 3.2;

    h.loop.side(0)?.replay();
    await h.audio.idle();

    expect(h.media().plays).toBe(2);
    expect(h.media().currentTime).toBe(0);
    expect(h.urls.minted).toHaveLength(1);
    expect(h.scope.stats.claimed).toBe(1);
    expect(h.scope.stats.reused).toBe(0);
    expect(h.audio.stats.requested).toBe(1);
    expect(h.audio.stats.replayed).toBe(1);
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["playing", "replayed"]);
    expect(h.events.map((event) => event.kind)).toEqual(["reveal", "replay"]);
  });

  it("REPLAY BEFORE THE REVEAL ASKS AGAIN — it does not answer", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.replay();
    await h.audio.idle();

    expect(h.media().plays).toBe(1);
    expect(h.loop.side(0)?.revealed).toBe(false);
    expect(h.result.clozes[0]?.revealed).toBe(false);
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("false");
    expect(h.events.map((event) => event.kind)).toEqual(["prompt"]);
    expect(h.outcomes[0]?.reason).toBe("prompt");
  });

  it("still replays normally once the side IS revealed", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    h.loop.side(0)?.replay();
    await h.audio.idle();

    expect(h.media().plays).toBe(2);
    expect(h.events.map((event) => event.kind)).toEqual(["reveal", "replay"]);
    expect(h.loop.side(0)?.revealed).toBe(true);
  });

  it("a deliberate tap on the clip ITSELF still unmasks, which is a different act", () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    const clip = h.result.media[0] as MediaMount<MemoryElement>;
    expect(h.loop.side(0)?.play(clip)).toBe(true);
    expect(h.loop.side(0)?.revealed).toBe(true);
    expect(h.result.clozes[0]?.revealed).toBe(true);
  });

  it("re-claims rather than reusing a revoked lease", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    h.scope.release(CLIP.hash);
    await h.audio.replay(h.result.media[0] as MediaMount<MemoryElement>);
    expect(h.urls.minted).toHaveLength(2);
    expect(h.media().src).toBe(h.urls.minted[1]);
    expect(h.audio.stats.requested).toBe(2);
  });
});

describe("a missing blob", () => {
  it("reveals anyway, plays nothing, and mints nothing", async () => {
    const h = harness(SHADOWING_SIDE);
    h.loop.enter(0);
    expect(h.loop.side(0)?.reveal("cloze")).toBe(true);
    await h.audio.idle();

    expect(h.result.clozes[0]?.revealed).toBe(true);
    expect(h.cloze(0).getAttribute(REVEAL_ATTRIBUTES.expanded)).toBe("true");
    expect(h.audio.stats.requested).toBe(1);
    expect(h.audio.stats.missing).toBe(1);
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["missing"]);
    expect(h.outcomes[0]?.detail).toBe("attachment uVQp0iMb.mp3");
    expect(h.urls.minted).toEqual([]);
    expect(h.media().plays).toBe(0);
    expect(h.media().hasAttribute("src")).toBe(false);
    expect(h.media().getAttribute(AUDIO_DATA.state)).toBe("missing");
    h.loop.dispose();
    expect(h.urls.revoked).toEqual([]);
  });

  it("reports an unaddressable reference instead of asking the store", () => {
    const h = harness("![x](audio.weird)");
    expect(h.result.media.map((mount) => mount.kind)).toEqual(["file"]);
    expect(h.audio.tracks).toEqual([]);
    h.loop.side(0)?.reveal();
    expect(h.requests).toEqual([]);
  });

  it("reports a rejected play() as blocked, not as a broken clip", async () => {
    const h = harness(SHADOWING_SIDE, { store: STORE });
    h.media().rejectPlay = "NotAllowedError";
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    expect(h.outcomes.map((outcome) => outcome.kind)).toEqual(["blocked"]);
    expect(h.media().getAttribute(AUDIO_DATA.state)).toBe("blocked");
    expect(h.result.clozes[0]?.revealed).toBe(true);
    expect(h.media().src).toBe(h.urls.minted[0]);
  });

  it("survives a resolver that throws", async () => {
    const result = renderSides(parseContent(SHADOWING_SIDE), { document: liveDocument() });
    const audio = audioController(result, {
      scope: new BlobUrlScope(urlRecorder().options),
      resolve: () => {
        throw new Error("worker is gone");
      },
    });
    const loop = shadowingLoop(result, { audio });
    expect(loop.side(0)?.reveal()).toBe(true);
    await audio.idle();
    expect(audio.stats.failed).toBe(1);
    expect(result.clozes[0]?.revealed).toBe(true);
  });
});

describe("addressing", () => {
  it("addresses an attachment by ref_key and a generator slot by its request", async () => {
    const attachment = harness(AUDIO_ATTACHMENT);
    expect(attachment.audio.tracks.map((track) => track.address)).toEqual([
      { origin: "attachment", key: "uVQp0iMb.mp3" },
    ]);

    const generated = harness('<speech lang="jp">言葉</speech>');
    expect(generated.audio.tracks[0]?.address).toEqual(
      audioAddress(generated.result, generated.result.media[0] as MediaMount<MemoryElement>),
    );
    const address = generated.audio.tracks[0]?.address;
    expect(address?.origin).toBe("generator");
    if (address?.origin !== "generator") throw new Error("unreachable");
    expect(address.request.kind).toBe("speech");
    expect(address.request.text).toBe("言葉");
    expect(address.request.lang).toBe("ja-JP");

    const payload = payloadFor("tts");
    const store = new Map([[`speech:ja-JP:言葉`, payload]]);
    const h = harness('<speech lang="jp">言葉</speech>', { store });
    h.loop.side(0)?.reveal();
    await h.audio.idle();
    expect(h.media().plays).toBe(1);
    expect(h.outcomes[0]?.hash).toBe(payload.hash);
  });

  it("shares one object URL when the same clip appears twice on a card", async () => {
    const h = harness(`![a](same.mp3)\n---\n![b](same.mp3)`, {
      store: new Map([["attachment:same.mp3", payloadFor("same")]]),
    });
    h.loop.side(0)?.reveal();
    h.loop.side(1)?.reveal();
    await h.audio.idle();
    expect(h.media(0).plays).toBe(1);
    expect(h.media(1).plays).toBe(1);
    expect(h.urls.minted).toHaveLength(1);
    expect(h.scope.stats.reused).toBe(1);
    h.loop.dispose();
    expect(h.urls.revoked).toHaveLength(1);
    expect(h.media(0).hasAttribute("src")).toBe(false);
    expect(h.media(1).hasAttribute("src")).toBe(false);
  });

  it("does nothing at all without an audio port", () => {
    const result = renderSides(parseContent(SHADOWING_SIDE), { document: liveDocument() });
    const loop = shadowingLoop(result);
    loop.enter(0);
    expect(loop.side(0)?.reveal()).toBe(true);
    expect(result.clozes[0]?.revealed).toBe(true);
    expect((result.media[0]?.element as FakeMedia).plays).toBe(0);
  });

  it("changes nothing in a serialised render when binding is off", () => {
    const plain = renderSides(parseContent("{{答え}}"), { document: memoryDocument() });
    const before = serialise(plain.root);
    shadowingLoop(plain, { bindClozes: false, armMedia: false });
    expect(serialise(plain.root)).toBe(before);
  });
});

const SRC_RENDER = resolve(import.meta.dirname, "..", "src", "render");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("source discipline", () => {
  it("never mentions autoplay and never assigns a src", () => {
    for (const name of ["reveal.ts", "audio.ts"]) {
      const code = stripComments(readFileSync(resolve(SRC_RENDER, name), "utf8"));
      expect(code, `${name} mentions autoplay`).not.toContain("autoplay");
      expect(code, `${name} sets a src attribute`).not.toMatch(/setAttribute\(\s*["']src["']/);
      expect(code, `${name} uses innerHTML`).not.toContain("innerHTML");
      expect(code, `${name} assigns element.src`).not.toMatch(/\.src\s*=[^=]/);
    }
  });

  it("starts playback from exactly four NAMED places, and none of them is `enter`", () => {
    const reveal = stripComments(readFileSync(resolve(SRC_RENDER, "reveal.ts"), "utf8"));
    const asks = [...reveal.matchAll(/audio(?:\?)?\.play\(\s*\[?[^,)]*\]?\s*,\s*(.*?)\)/g)];
    expect(asks).toHaveLength(4);
    const reasons = asks.map((match) => (match[1] ?? "").trim());
    expect(reasons).toContain('"reveal"');
    expect(reasons).toContain('"prompt"');
    expect(reasons.some((reason) => reason.includes('"replay"'))).toBe(true);
    for (const reason of reasons) {
      expect(reason, `computed play reason: ${reason}`).toMatch(/^["'?:\s\w]+$/);
    }

    const enter = /enter\(\): void \{([\s\S]*?)\n      \},/.exec(reveal)?.[1] ?? "MISSING";
    expect(enter).not.toBe("MISSING");
    expect(enter).not.toContain("play");
    expect(enter).not.toContain("prompt");
    expect(enter).not.toMatch(/audio\s*[?.[]/);

    expect(reveal, "reveal.ts must not know about Reading").not.toMatch(/\bReading\b/);

    const audio = stripComments(readFileSync(resolve(SRC_RENDER, "audio.ts"), "utf8"));
    expect([...audio.matchAll(/element\.play\(/g)]).toHaveLength(1);
  });
});

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const EXPORT_DIRS = EXPORT_NAMES.map((name) => resolve(import.meta.dirname, "..", "exports", name));
const HAVE_EXPORTS = EXPORT_DIRS.every((dir) => existsSync(join(dir, "data.json")));

interface CorpusCard {
  readonly id: string;
  readonly templateId: string;
  readonly content: string;
  readonly values: Record<string, string>;
}

let corpus: { cards: CorpusCard[]; templates: Map<string, TemplateInput> } | null = null;

function readCorpus(): { cards: CorpusCard[]; templates: Map<string, TemplateInput> } {
  return (corpus ??= loadCorpus());
}

function loadCorpus(): { cards: CorpusCard[]; templates: Map<string, TemplateInput> } {
  const cards: CorpusCard[] = [];
  const templates = new Map<string, TemplateInput>();
  for (const dir of EXPORT_DIRS) {
    const root = loadExport(dir);
    for (const raw of asRecords(root["templates"])) {
      templates.set(asText(raw["id"]), {
        id: asText(raw["id"]),
        content: asText(raw["content"]),
        fields: Object.entries(asRecord(raw["fields"])).flatMap(([key, field]) =>
          isRecord(field)
            ? [
                {
                  id: asText(field["id"]) || key,
                  name: asText(field["name"]),
                  ...(asText(field["type"]) === "" ? {} : { type: asText(field["type"]) }),
                },
              ]
            : [],
        ),
        reversePermutation: null,
      });
    }
    for (const { card } of walkCards(root)) {
      const values: Record<string, string> = {};
      for (const [fieldId, field] of Object.entries(asRecord(card["fields"]))) {
        values[fieldId] = fieldValueText(isRecord(field) ? (field as MochiRecord)["value"] : field);
      }
      cards.push({
        id: asText(card["id"]),
        templateId: asText(card["template-id"]),
        content: asText(card["content"]),
        values,
      });
    }
  }
  return { cards, templates };
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function census(
  cards: readonly CorpusCard[],
  templates: ReadonlyMap<string, TemplateInput>,
  fillSpeechFields: boolean,
): {
  readonly sides: Map<string, number>;
  readonly perAudioSide: Map<number, number>;
  readonly triggers: Map<string, number>;
  readonly where: Map<string, number>;
  readonly origins: Map<string, number>;
  readonly cardsWithAudio: number;
  readonly totalSides: number;
} {
  const sides = new Map<string, number>();
  const perAudioSide = new Map<number, number>();
  const triggers = new Map<string, number>();
  const where = new Map<string, number>();
  const origins = new Map<string, number>();
  let cardsWithAudio = 0;
  let totalSides = 0;
  for (const card of cards) {
    const template = templates.get(card.templateId) ?? null;
    const values = { ...card.values };
    if (fillSpeechFields && template !== null) {
      for (const field of template.fields ?? []) {
        if (field.type === "speech") values[field.id] = "![tts](generated.mp3)";
      }
    }
    const resolved = resolveCard({ id: card.id, content: card.content, values }, template);
    const result = renderResolvedCard(resolved, { document: memoryDocument() });
    const loop = shadowingLoop(result, { bindClozes: false, armMedia: false });
    let hasAudio = false;
    for (const side of loop.sides) {
      totalSides += 1;
      bump(triggers, side.trigger);
      const key =
        side.audio.length === 0
          ? side.clozes.length === 0
            ? "neither"
            : "cloze-only"
          : side.clozes.length === 0
            ? "audio-alone"
            : "audio+cloze";
      bump(sides, key);
      if (side.audio.length === 0) continue;
      hasAudio = true;
      perAudioSide.set(side.audio.length, (perAudioSide.get(side.audio.length) ?? 0) + 1);
      bump(where, `${card.templateId || "(template-less)"} side ${side.index}: ${key}`);
      for (const mount of side.audio) bump(origins, mount.origin);
    }
    if (hasAudio) cardsWithAudio += 1;
  }
  return { sides, perAudioSide, triggers, where, origins, cardsWithAudio, totalSides };
}

function object<K extends string | number>(counts: Map<K, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

describe.skipIf(!HAVE_EXPORTS)("the real corpus (exports/)", () => {
  it("censuses cloze-and-audio co-occurrence, which is what decides the trigger", () => {
    const { cards, templates } = readCorpus();
    expect(cards).toHaveLength(7716);
    const now = census(cards, templates, false);
    const later = census(cards, templates, true);
    console.log(
      [
        "── TODAY, as the export stands ────────────────────────────────",
        `cards ${cards.length} · sides ${now.totalSides} · cards with audio ${now.cardsWithAudio}`,
        `per side        ${JSON.stringify(object(now.sides))}`,
        `trigger         ${JSON.stringify(object(now.triggers))}`,
        `audio origin    ${JSON.stringify(object(now.origins))}`,
        `clips per audio side ${JSON.stringify(object(now.perAudioSide))}`,
        `audio sides     ${JSON.stringify(object(now.where), null, 1)}`,
        "── PROJECTED, with the typed `speech` fields filled (stage 9) ──",
        `cards with audio ${later.cardsWithAudio}`,
        `per side        ${JSON.stringify(object(later.sides))}`,
        `trigger         ${JSON.stringify(object(later.triggers))}`,
        `audio origin    ${JSON.stringify(object(later.origins))}`,
        `clips per audio side ${JSON.stringify(object(later.perAudioSide))}`,
        `audio sides     ${JSON.stringify(object(later.where), null, 1)}`,
      ].join("\n"),
    );

    expect(now.sides.get("audio+cloze") ?? 0).toBe(0);
    expect(now.sides.get("audio-alone")).toBe(91);
    expect(now.cardsWithAudio).toBe(86);
    expect(object(now.origins)).toEqual({ attachment: 1, generator: 94 });
    expect(later.sides.get("audio+cloze") ?? 0).toBeGreaterThan(0);
    expect(later.sides.get("audio-alone") ?? 0).toBeGreaterThan(
      later.sides.get("audio+cloze") ?? 0,
    );
  }, 120_000);

  it(
    "enters every side of every card in silence, then reveals it and hears exactly one clip",
    async () => {
      const { cards, templates } = readCorpus();
      const violations: string[] = [];
      const urls = urlRecorder();
      const outcomes = new Map<string, number>();
      let entered = 0;
      let armed = 0;
      let revealed = 0;
      let played = 0;
      let peakLive = 0;
      let entering = true;
      for (const card of cards) {
        const resolved = resolveCard(
          { id: card.id, content: card.content, values: card.values },
          templates.get(card.templateId) ?? null,
        );
        const result = renderResolvedCard(resolved, { document: liveDocument() });
        const scope = new BlobUrlScope({
          createObjectURL: (blob) => {
            if (entering) violations.push(`${card.id}: object URL minted on entry`);
            return urls.options.createObjectURL(blob);
          },
          revokeObjectURL: urls.options.revokeObjectURL,
        });
        const audio = audioController(result, {
          scope,
          resolve: (address) => {
            if (entering) violations.push(`${card.id}: bytes requested on entry`);
            return payloadFor(addressKey(address));
          },
          onOutcome: (outcome) => bump(outcomes, outcome.kind),
        });
        const loop = shadowingLoop(result, { audio });

        for (const side of loop.sides) {
          loop.enter(side.position);
          entered += 1;
          for (const mount of side.audio) {
            armed += 1;
            const element = mount.element as FakeMedia;
            if (element.plays > 0) violations.push(`${card.id}: element played on entry`);
            if (element.hasAttribute("src")) violations.push(`${card.id}: src set on entry`);
          }
        }
        const idle = audio.stats;
        if (idle.requested + idle.playing + idle.replayed + idle.attached > 0) {
          violations.push(`${card.id}: ${JSON.stringify(idle)}`);
        }

        entering = false;
        for (const side of loop.sides) {
          if (side.audio.length === 0) continue;
          side.reveal("caller");
          revealed += 1;
        }
        await audio.idle();
        played += result.media.filter(
          (mount) => mount.kind === "audio" && (mount.element as FakeMedia).plays > 0,
        ).length;
        peakLive = Math.max(peakLive, scope.live);
        loop.dispose();
        expect(scope.live).toBe(0);
        entering = true;
      }
      console.log(
        [
          `entered ${entered} sides across ${cards.length} cards · armed ${armed} media elements`,
          `revealed ${revealed} audio sides · clips played ${played} · object URLs ` +
            `${urls.minted.length} minted / ${urls.revoked.length} revoked · peak live per card ${peakLive}`,
          `outcomes ${JSON.stringify(object(outcomes))}`,
        ].join("\n"),
      );
      expect(violations).toEqual([]);
      expect(entered).toBe(27355);
      expect(armed).toBe(95);
      expect(revealed).toBe(91);
      expect(played).toBe(91);
      expect(outcomes.get("deferred")).toBe(4);
      expect(urls.minted).toHaveLength(91);
      expect(urls.revoked).toHaveLength(91);
      expect(new Set(urls.revoked)).toEqual(new Set(urls.minted));
    },
    120_000,
  );
});
