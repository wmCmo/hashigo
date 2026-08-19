/**
 * THROWAWAY (spike harness). The page: real mp3s out of the corpus, into real
 * `<audio>` elements, through `src/blobs/url.ts` — which is the one PRODUCTION
 * file this spike exists to exercise.
 *
 * What it is trying to disprove, in order:
 *
 *   1. "The bytes reached the element" — which looks identical to a `src` that
 *      404s if all you check is that the element exists. So every clip is judged
 *      on `duration` being a finite number, `canplay`/`playing` actually firing,
 *      `currentTime` advancing, and (for one clip) `ended` arriving after a seek.
 *      A second, independent decode through `AudioContext.decodeAudioData` reports
 *      sample rate and channel count, which no amount of assignment can fake.
 *   2. "A browser handed text/xml in an <audio> element will not play it, so this
 *      breaks playback outright" — SPEC.html's claim, which nobody had run. The same real
 *      mp3 is offered to four differently-labelled Blobs and to a `<source
 *      type=…>`, and the results are printed side by side.
 *   3. "Revoking is a detail." Six lifecycle probes, including revoking before the
 *      element loads and revoking after it has started, because those two have
 *      opposite outcomes and only one of them is a bug.
 *
 * The autoplay policy is measured, not worked around silently:
 * `navigator.getAutoplayPolicy()` is read and the first `play()` is attempted
 * BEFORE any click, so the transcript says whether this browser needed a gesture.
 */

import { BlobUrlScope, attachMedia, playableMime } from "../../src/blobs/url.js";

import type { AudioSpikeMessage, AudioSpikeRequest, ClipPayload } from "./protocol.js";

const logElement = document.querySelector<HTMLPreElement>("#log");
const factsElement = document.querySelector<HTMLDListElement>("#facts");
const playersElement = document.querySelector<HTMLDivElement>("#players");
const runButton = document.querySelector<HTMLButtonElement>("#run");
const reimportButton = document.querySelector<HTMLButtonElement>("#reimport");
if (
  logElement === null ||
  factsElement === null ||
  playersElement === null ||
  runButton === null ||
  reimportButton === null
) {
  throw new Error("page markup is missing");
}

/** Everything written to the log, so a driver can lift the whole transcript. */
const transcript: string[] = [];
declare global {
  interface Window {
    __transcript: string[];
    __state: { opened: boolean; suiteDone: boolean; failures: string[] };
  }
}
window.__transcript = transcript;
window.__state = { opened: false, suiteDone: false, failures: [] };

function write(text: string, level: "info" | "step" | "good" | "bad" = "info"): void {
  transcript.push(text);
  const line = document.createElement("span");
  line.className = `log-${level}`;
  line.textContent = `${text}\n`;
  logElement!.append(line);
  logElement!.scrollTop = logElement!.scrollHeight;
  if (level === "bad") window.__state.failures.push(text);
}
const step = (text: string): void => write(text, "step");
const good = (text: string): void => write(text, "good");
const bad = (text: string): void => write(text, "bad");
const fact = (term: string, value: string): void => {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  factsElement!.append(dt, dd);
};
const n = (value: unknown): string => Number(value).toLocaleString("en-US");
const secs = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(3)}s` : String(value));

// ── the worker ────────────────────────────────────────────────────────────────

const worker = new Worker(new URL("./blobs.worker.ts", import.meta.url), {
  type: "module",
  name: "hashigo-audio-blobs",
});

let clips: ClipPayload[] = [];
let requestId = 0;
const pendingUrl = new Map<number, (value: { url: string | null; error?: string }) => void>();
let openResolve: ((ok: boolean) => void) | null = null;

worker.onmessage = (event: MessageEvent<AudioSpikeMessage>): void => {
  const message = event.data;
  if (message.kind === "log") {
    write(message.text, message.level);
    return;
  }
  if (message.kind === "opened") {
    for (const [term, value] of message.facts) fact(term, value);
    clips = [...message.clips];
    window.__state.opened = true;
    openResolve?.(true);
    return;
  }
  if (message.kind === "workerUrl") {
    const resolve = pendingUrl.get(message.id);
    pendingUrl.delete(message.id);
    resolve?.({ url: message.url, ...(message.error === undefined ? {} : { error: message.error }) });
    return;
  }
  bad(`worker failed: ${message.error}`);
  openResolve?.(false);
};

worker.onerror = (event: ErrorEvent): void => {
  bad(`worker error: ${event.message} (${event.filename}:${event.lineno})`);
  openResolve?.(false);
};

const send = (request: AudioSpikeRequest): void => {
  worker.postMessage(request);
};

function workerMintedUrl(hash: string): Promise<{ url: string | null; error?: string }> {
  const id = ++requestId;
  return new Promise((resolve) => {
    pendingUrl.set(id, resolve);
    send({ kind: "workerUrl", id, hash });
  });
}

// ── media helpers ─────────────────────────────────────────────────────────────

const MEDIA_ERRORS: Record<number, string> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

const READY_STATES = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];

const WATCHED = [
  "loadstart",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "play",
  "playing",
  "timeupdate",
  "pause",
  "ended",
  "stalled",
  "suspend",
  "error",
  "emptied",
] as const;

interface Recorder {
  readonly seen: string[];
  /** The furthest playback position any `timeupdate` reported. */
  readonly maxTime: () => number;
  count(name: string): number;
  stop(): void;
}

function recordEvents(element: HTMLMediaElement): Recorder {
  const seen: string[] = [];
  let furthest = 0;
  const handlers = WATCHED.map((name) => {
    const handler = (): void => {
      seen.push(name);
      if (element.currentTime > furthest) furthest = element.currentTime;
    };
    element.addEventListener(name, handler);
    return [name, handler] as const;
  });
  return {
    seen,
    maxTime: () => furthest,
    count: (name) => seen.filter((event) => event === name).length,
    stop: () => {
      for (const [name, handler] of handlers) element.removeEventListener(name, handler);
    },
  };
}

/** Resolve with the first of `names` to fire, or "timeout". */
function firstEvent(element: HTMLMediaElement, names: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string): void => {
      if (done) return;
      done = true;
      for (const [name, handler] of handlers) element.removeEventListener(name, handler);
      clearTimeout(timer);
      resolve(value);
    };
    const handlers = names.map((name) => {
      const handler = (): void => {
        finish(name);
      };
      element.addEventListener(name, handler);
      return [name, handler] as const;
    });
    const timer = setTimeout(() => {
      finish("timeout");
    }, timeoutMs);
  });
}

/**
 * Load whatever is on `element.src` and try to play it, reporting what the
 * platform did. `element.src` must already be set.
 *
 * THE MEASUREMENT BUG THIS FUNCTION EXISTS TO NOT HAVE: the obvious version
 * awaits `play()`, then waits for `playing`, then samples `currentTime` twice
 * 400 ms apart. `playing` fires *during* the await of `play()`, so the wait times
 * out; four seconds later the 1.6-second clips have run to their end and the two
 * `currentTime` samples are identical — which reads exactly like a clip that
 * never played. The fix is to arm the listener before calling `play()`, and to
 * judge progress by the furthest position any `timeupdate` reported rather than
 * by a difference between two arbitrary moments.
 */
interface PlaybackProbe {
  readonly settled: string;
  readonly playing: string;
  /** The name of the error `play()` rejected with — `NotAllowedError` is the autoplay policy. */
  readonly playError: string | null;
  readonly duration: number;
  /** Furthest position reached. > 0 is the thing that cannot be faked. */
  readonly maxTime: number;
  readonly advanced: number;
  readonly ended: boolean;
  readonly timeupdates: number;
  readonly errorCode: number | null;
  readonly events: readonly string[];
}

async function probePlayback(
  element: HTMLMediaElement,
  options: { readonly loadMs?: number; readonly sampleMs?: number } = {},
): Promise<PlaybackProbe> {
  const recorder = recordEvents(element);
  const settled = await firstEvent(element, ["canplay", "error"], options.loadMs ?? 8000);
  const duration = element.duration;
  let playing = "-";
  let playError: string | null = null;
  let advanced = 0;
  if (settled === "canplay") {
    const armed = firstEvent(element, ["playing", "error"], 3000);
    try {
      await element.play();
      playing = await armed;
    } catch (error) {
      playError = error instanceof Error ? error.name : String(error);
      playing = playError;
    }
    const before = element.currentTime;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, options.sampleMs ?? 400);
    });
    advanced = element.currentTime - before;
    element.pause();
  }
  recorder.stop();
  return {
    settled,
    playing,
    playError,
    duration,
    // `timeupdate` only fires every ~250 ms, so the last sample of `currentTime`
    // is usually further along than any event reported. Fold it in, or a 250 ms
    // probe of a clip that IS playing reads as a clip that never moved — which is
    // the false negative that made the first run of this page lie about autoplay.
    maxTime: Math.max(recorder.maxTime(), element.currentTime),
    advanced,
    ended: recorder.count("ended") > 0,
    timeupdates: recorder.count("timeupdate"),
    errorCode: element.error === null ? null : element.error.code,
    events: recorder.seen,
  };
}

const sleep = (millis: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, millis);
  });

/** An `<audio controls>` in the page, labelled, so the screenshot means something. */
function player(label: string): HTMLAudioElement {
  const row = document.createElement("div");
  row.className = "player";
  const caption = document.createElement("span");
  caption.textContent = label;
  const element = document.createElement("audio");
  element.controls = true;
  element.preload = "auto";
  row.append(caption, element);
  playersElement!.append(row);
  return element;
}

const audioClips = (): ClipPayload[] => clips.filter((clip) => clip.mime === "audio/mpeg");
const clipLabel = (clip: ClipPayload): string =>
  `${clip.deck}/${clip.fileName} ${n(clip.byteSize)}B ${clip.sourceText === null ? "" : JSON.stringify(clip.sourceText)}`;

// ── phase 0: before any user gesture ──────────────────────────────────────────

async function autoplayProbe(): Promise<void> {
  step("7. BEFORE any click: does decode need a gesture, and does playback?");
  const policy = (navigator as { getAutoplayPolicy?: (kind: string) => string }).getAutoplayPolicy;
  write(
    `  navigator.getAutoplayPolicy("mediaelement") = ` +
      `${policy === undefined ? "unavailable" : policy.call(navigator, "mediaelement")}`,
  );
  write(`  navigator.userActivation.hasBeenActive = ${String(navigator.userActivation?.hasBeenActive)}`);
  const clip = audioClips()[0];
  if (clip === undefined) {
    bad("  no audio/mpeg clip to probe");
    return;
  }
  const scope = new BlobUrlScope();
  const lease = scope.claim({ hash: clip.hash, bytes: clip.bytes, mime: clip.mime });
  const element = player(`gesture-free probe · ${clipLabel(clip)}`);
  const attachment = attachMedia(element, lease);
  const probe = await probePlayback(element, { sampleMs: 250 });
  write(
    `  without a gesture: ${probe.settled}, duration ${secs(probe.duration)}, ` +
      `readyState ${READY_STATES[element.readyState] ?? element.readyState}`,
  );
  if (probe.settled === "canplay" && Number.isFinite(probe.duration) && probe.duration > 0) {
    good("  DECODE DOES NOT NEED A GESTURE: metadata and a full buffer arrived unprompted");
  } else {
    bad(`  the clip did not even load without a gesture (${probe.settled})`);
  }
  if (probe.playError === null) {
    write(
      `  play() RESOLVED with no user gesture and reached ${secs(probe.maxTime)}. This browser is ` +
        `NOT enforcing the autoplay policy — Playwright's Chromium is launched with it off — so ` +
        `the blocked case could not be observed here at all. A phone WILL enforce it.`,
    );
  } else {
    write(`  play() REJECTED with no user gesture — ${probe.playError}`);
    write("  that is the autoplay policy, and it is why the rest of this page runs off a click");
  }
  attachment.detach();
  write(`  events: ${probe.events.join(" ")}`);
  write(`  after detach: lease.revoked ${String(lease.revoked)}, scope.live ${scope.live}`);
}

// ── phase 1: every clip, judged on decode ─────────────────────────────────────

interface PlayResult {
  readonly clip: ClipPayload;
  readonly ok: boolean;
  readonly duration: number;
  readonly maxTime: number;
  readonly settled: string;
  readonly errorCode: number | null;
}

async function playClip(clip: ClipPayload, scope: BlobUrlScope, expect: "audio" | "not-audio"): Promise<PlayResult> {
  const lease = scope.claim({ hash: clip.hash, bytes: clip.bytes, mime: clip.mime });
  const element = player(`${expect === "audio" ? "" : "control · "}${clipLabel(clip)}`);
  const attachment = attachMedia(element, lease);
  const probe = await probePlayback(element);
  attachment.detach();
  const decoded = probe.settled === "canplay" && Number.isFinite(probe.duration) && probe.duration > 0;
  const played = decoded && probe.maxTime > 0 && probe.timeupdates > 0;
  const ok = expect === "audio" ? played : !decoded;
  write(
    `  ${ok ? "OK  " : "BAD "} ${clip.declaredType || "(nothing)"} -> ${clip.mime} ` +
      `${clip.fileName} ${n(clip.byteSize)}B | ${probe.settled}` +
      `${probe.errorCode === null ? "" : ` ${MEDIA_ERRORS[probe.errorCode] ?? probe.errorCode}`} | ` +
      `duration ${secs(probe.duration)} | play ${probe.playing} | reached ${secs(probe.maxTime)} ` +
      `(+${probe.advanced.toFixed(3)}s in the last 400ms${probe.ended ? ", ended" : ""}) | ` +
      `timeupdate x${probe.timeupdates} | read ${clip.readMs.toFixed(2)}ms | ` +
      `address ${clip.addressOk ? "ok" : "MISMATCH"}`,
    ok ? "info" : "bad",
  );
  return {
    clip,
    ok,
    duration: probe.duration,
    maxTime: probe.maxTime,
    settled: probe.settled,
    errorCode: probe.errorCode,
  };
}

async function playEverything(): Promise<PlayResult[]> {
  step("8. every clip, through src/blobs/url.ts, judged on decode and on the clock");
  const scope = new BlobUrlScope();
  const results: PlayResult[] = [];
  for (const clip of clips) {
    const expect = clip.mime === "audio/mpeg" ? "audio" : "not-audio";
    results.push(await playClip(clip, scope, expect));
  }
  write(
    `  scope after ${results.length} clips: live ${scope.live}, liveBytes ${n(scope.liveBytes)}, ` +
      `stats ${JSON.stringify(scope.stats)}`,
  );
  if (scope.live === 0) good("  every URL this phase minted has been revoked");
  else bad(`  ${scope.live} object URL(s) still live after detaching every element`);
  const audio = results.filter((result) => result.clip.mime === "audio/mpeg");
  const passed = audio.filter((result) => result.ok).length;
  if (passed === audio.length) {
    good(`  ${passed}/${audio.length} real mp3s decoded AND advanced their clock`);
  } else {
    bad(`  only ${passed}/${audio.length} real mp3s decoded and advanced`);
  }
  return results;
}

/** One clip played to its end, after a seek: proof the whole pipeline works. */
async function playToEnd(): Promise<void> {
  step("9. one clip seeked near its end and played out — 'ended' has to arrive");
  const clip = audioClips()[0];
  if (clip === undefined) {
    bad("  no clip");
    return;
  }
  const scope = new BlobUrlScope();
  const lease = scope.claim({ hash: clip.hash, bytes: clip.bytes, mime: clip.mime });
  const element = player(`played to the end · ${clipLabel(clip)}`);
  const recorder = recordEvents(element);
  const attachment = attachMedia(element, lease);
  await firstEvent(element, ["canplay", "error"], 8000);
  const duration = element.duration;
  element.currentTime = Math.max(0, duration - 0.4);
  await element.play().catch(() => undefined);
  const finished = await firstEvent(element, ["ended", "error"], 6000);
  write(
    `  duration ${secs(duration)}, seeked to ${secs(Math.max(0, duration - 0.4))}, ` +
      `${finished} at currentTime ${secs(element.currentTime)}`,
  );
  if (finished === "ended") good("  'ended' fired: the decoder ran to the end of a real clip");
  else bad(`  did not reach the end: ${finished}`);
  recorder.stop();
  attachment.detach();
}

// ── phase 2: an independent decode ────────────────────────────────────────────

async function decodeIndependently(): Promise<void> {
  step("10. the same bytes through AudioContext.decodeAudioData — PCM, not a promise");
  const context = new AudioContext();
  for (const clip of audioClips().slice(0, 3)) {
    // decodeAudioData detaches the buffer it is given, so hand it a copy: the
    // page still needs these bytes for the <audio> tests.
    const copy = clip.bytes.slice().buffer as ArrayBuffer;
    const start = performance.now();
    try {
      const buffer = await context.decodeAudioData(copy);
      write(
        `  ${clip.fileName} ${n(clip.byteSize)}B -> ${buffer.numberOfChannels} channel(s), ` +
          `${n(buffer.sampleRate)} Hz, ${n(buffer.length)} samples, ${secs(buffer.duration)} ` +
          `in ${(performance.now() - start).toFixed(1)}ms`,
      );
    } catch (error) {
      bad(`  ${clip.fileName} did NOT decode: ${(error as Error).message}`);
    }
  }
  write(`  AudioContext state ${context.state}, sampleRate ${n(context.sampleRate)}`);
  await context.close();
}

// ── phase 3: does the mime label matter? ──────────────────────────────────────

async function mimeMatrix(): Promise<void> {
  step("11. THE MIME QUESTION: one real mp3, five labels, <audio src=blob:…>");
  const clip = audioClips().find((candidate) => candidate.declaredType === "text/xml") ?? audioClips()[0];
  if (clip === undefined) {
    bad("  no clip");
    return;
  }
  write(`  clip ${clip.fileName}, declared ${clip.declaredType || "(nothing)"}, sniffed ${clip.mime}`);
  const canPlayProbe = document.createElement("audio");
  for (const label of ["audio/mpeg", "text/xml", "application/octet-stream", "", 'audio/mpeg; codecs="mp3"']) {
    const canPlay = canPlayProbe.canPlayType(label);
    const blob = label === "" ? new Blob([clip.bytes]) : new Blob([clip.bytes], { type: label });
    const url = URL.createObjectURL(blob);
    const element = document.createElement("audio");
    element.preload = "auto";
    element.src = url;
    const probe = await probePlayback(element, { sampleMs: 250 });
    write(
      `  Blob type ${JSON.stringify(label).padEnd(26)} canPlayType ${JSON.stringify(canPlay).padEnd(12)} ` +
        `-> ${probe.settled.padEnd(7)} duration ${secs(probe.duration).padEnd(8)} ` +
        `reached ${secs(probe.maxTime)} (+${probe.advanced.toFixed(3)}s)` +
        `${probe.errorCode === null ? "" : ` ${MEDIA_ERRORS[probe.errorCode]}`}`,
    );
    element.removeAttribute("src");
    element.load();
    URL.revokeObjectURL(url);
  }
  write(`  playableMime() of each: ` +
    ["audio/mpeg", "text/xml", "application/octet-stream", "", "application/xml", "text/plain"]
      .map((label) => `${JSON.stringify(label)}->${JSON.stringify(playableMime(label))}`)
      .join(" "));

  step("12. the same bytes behind <source type=…>, which IS filtered by canPlayType");
  for (const label of ["text/xml", "audio/mpeg"]) {
    const url = URL.createObjectURL(new Blob([clip.bytes], { type: "audio/mpeg" }));
    const element = document.createElement("audio");
    element.preload = "auto";
    const source = document.createElement("source");
    source.type = label;
    source.src = url;
    element.append(source);
    const sourceFailed = new Promise<string>((resolve) => {
      source.addEventListener("error", () => {
        resolve("source error");
      });
    });
    element.load();
    const settled = await Promise.race([
      firstEvent(element, ["canplay", "error"], 4000),
      sourceFailed,
    ]);
    write(
      `  <source type=${JSON.stringify(label)}> -> ${settled}, networkState ${element.networkState} ` +
        `(3 = NETWORK_NO_SOURCE), duration ${secs(element.duration)}, ` +
        `element.error ${element.error === null ? "null" : MEDIA_ERRORS[element.error.code]}`,
    );
    element.innerHTML = "";
    element.load();
    URL.revokeObjectURL(url);
  }
}

// ── phase 4: the lifecycle, which is the whole reason url.ts exists ───────────

async function lifecycle(): Promise<void> {
  step("13. revocation: who revokes, when, and what breaks if it is done wrongly");
  const clip = audioClips()[0];
  const other = audioClips()[1];
  if (clip === undefined || other === undefined) {
    bad("  need two clips");
    return;
  }

  // (a) revoked before the element ever looks at it.
  {
    const scope = new BlobUrlScope();
    const lease = scope.claim({ hash: clip.hash, bytes: clip.bytes, mime: clip.mime });
    const dead = lease.url;
    lease.revoke();
    const element = document.createElement("audio");
    element.src = dead;
    const settled = await firstEvent(element, ["canplay", "error"], 4000);
    write(
      `  (a) revoke BEFORE load -> ${settled}` +
        `${element.error === null ? "" : ` ${MEDIA_ERRORS[element.error.code]}`}, ` +
        `duration ${secs(element.duration)}`,
    );
    let threw = "no";
    try {
      attachMedia(element, lease);
    } catch (error) {
      threw = (error as Error).message.slice(0, 68);
    }
    write(`  (a) attachMedia() on a revoked lease refuses: ${threw}`);
  }

  // (b) revoked after the element has already loaded it.
  {
    const scope = new BlobUrlScope();
    const lease = scope.claim({ hash: other.hash, bytes: other.bytes, mime: other.mime });
    const element = player(`revoked mid-life · ${other.fileName}`);
    element.src = lease.url;
    const settled = await firstEvent(element, ["canplay", "error"], 8000);
    lease.revoke();
    const recorder = recordEvents(element);
    await element.play().catch(() => undefined);
    await sleep(350);
    recorder.stop();
    write(
      `  (b) revoke AFTER ${settled}, then play -> reached ${secs(recorder.maxTime())} ` +
        `(the resource was already fetched; revoking does not reclaim it mid-play)`,
    );
    element.pause();
    // And the state rule 3 warns about: a revoked URL still assigned to src.
    element.load();
    const reload = await firstEvent(element, ["canplay", "error"], 3000);
    write(
      `  (b) then load() again with the dead URL still on src -> ${reload}` +
        `${element.error === null ? "" : ` ${MEDIA_ERRORS[element.error.code]}`} ` +
        `— this is why detach() clears src BEFORE revoking`,
    );
  }

  // (c) idempotence and reuse.
  {
    const scope = new BlobUrlScope();
    const first = scope.claim({ hash: clip.hash, bytes: clip.bytes, mime: clip.mime });
    const again = scope.claim({ hash: clip.hash, bytes: clip.bytes, mime: clip.mime });
    write(
      `  (c) claiming the same address twice: same URL ${String(first.url === again.url)}, ` +
        `live ${scope.live}, stats ${JSON.stringify(scope.stats)}`,
    );
    first.revoke();
    first.revoke();
    write(`  (c) revoke twice: revoked ${String(first.revoked)}, stats ${JSON.stringify(scope.stats)}`);
  }

  // (d) a second payload under one address is a content-address violation.
  {
    const scope = new BlobUrlScope();
    scope.claim({ hash: clip.hash, bytes: clip.bytes, mime: clip.mime });
    let refused = "no";
    try {
      scope.claim({ hash: clip.hash, bytes: clip.bytes.subarray(0, clip.byteSize - 1), mime: clip.mime });
    } catch (error) {
      refused = `${(error as Error).name}`;
    }
    write(`  (d) same address, different bytes -> ${refused}`);
    scope.releaseAll();
  }

  // (e) the cap: a caller who forgets releaseAll() leaks a BOUNDED amount.
  {
    const scope = new BlobUrlScope({ maxLive: 3 });
    const leases = audioClips()
      .slice(0, 6)
      .map((each) => scope.claim({ hash: each.hash, bytes: each.bytes, mime: each.mime }));
    write(
      `  (e) maxLive 3, claimed ${leases.length}: live ${scope.live}, ` +
        `liveBytes ${n(scope.liveBytes)}, stats ${JSON.stringify(scope.stats)}`,
    );
    write(
      `  (e) oldest lease revoked by eviction: ${String(leases[0]?.revoked)}; ` +
        `newest still live: ${String(leases[leases.length - 1]?.revoked === false)}`,
    );
    const byBytes = new BlobUrlScope({ maxLiveBytes: 64 * 1024 });
    for (const each of audioClips().slice(0, 6)) {
      byBytes.claim({ hash: each.hash, bytes: each.bytes, mime: each.mime });
    }
    write(
      `  (e) maxLiveBytes 65,536: live ${byBytes.live}, liveBytes ${n(byBytes.liveBytes)} ` +
        `(one clip may exceed the cap on its own; the cap yields rather than hand back a dead URL)`,
    );
    write(`  (e) releaseAll() revoked ${scope.releaseAll()} + ${byBytes.releaseAll()}`);
  }

  // (f) the review-session shape: one scope per card, releaseAll on card exit.
  {
    let peak = 0;
    let revoked = 0;
    const rounds = 40;
    for (let round = 0; round < rounds; round += 1) {
      const scope = new BlobUrlScope();
      for (const each of audioClips().slice(0, 3)) {
        scope.claim({ hash: each.hash, bytes: each.bytes, mime: each.mime });
      }
      peak = Math.max(peak, scope.liveBytes);
      revoked += scope.releaseAll();
    }
    write(
      `  (f) ${rounds} card presentations x 3 clips: ${revoked} URLs minted and revoked, ` +
        `peak live ${n(peak)} bytes — a session's ceiling is one card, not the session`,
    );
  }
}

// ── phase 5: minting the URL in the worker instead ────────────────────────────

async function workerMinted(): Promise<void> {
  step("14. an object URL minted in the WORKER, consumed in the document");
  const clip = audioClips()[0];
  if (clip === undefined) {
    bad("  no clip");
    return;
  }
  const result = await workerMintedUrl(clip.hash);
  if (result.url === null) {
    write(`  the worker could not mint one: ${result.error ?? "unknown"}`);
    return;
  }
  const element = player(`worker-minted URL · ${clip.fileName}`);
  element.src = result.url;
  const probe = await probePlayback(element, { sampleMs: 250 });
  write(
    `  ${result.url.slice(0, 12)}… -> ${probe.settled}, duration ${secs(probe.duration)}, ` +
      `reached ${secs(probe.maxTime)}` +
      `${probe.errorCode === null ? "" : ` ${MEDIA_ERRORS[probe.errorCode]}`}`,
  );
  write(
    probe.settled === "canplay"
      ? "  a worker-minted URL DOES resolve in the document (same origin, one blob URL store)" +
          " — but the worker cannot know when the element is done with it, which is why" +
          " src/blobs/url.ts lives on the side that owns the element"
      : "  a worker-minted URL does NOT resolve in the document; mint where you consume",
  );
  element.removeAttribute("src");
  element.load();
}

// ── the image control, so "it decoded" is not just "an element existed" ───────

async function imageControl(): Promise<void> {
  step("15. the non-audio controls, through the same code path");
  const jpeg = clips.find((clip) => clip.mime === "image/jpeg");
  if (jpeg === undefined) {
    bad("  no jpeg in the sample");
    return;
  }
  const scope = new BlobUrlScope();
  const lease = scope.claim({ hash: jpeg.hash, bytes: jpeg.bytes, mime: jpeg.mime });
  const image = new Image();
  const loaded = new Promise<string>((resolve) => {
    image.addEventListener("load", () => {
      resolve("load");
    });
    image.addEventListener("error", () => {
      resolve("error");
    });
  });
  image.src = lease.url;
  image.alt = jpeg.fileName;
  image.className = "shot";
  playersElement!.append(image);
  const settled = await loaded;
  write(
    `  ${jpeg.fileName} as <img>: ${settled}, ${image.naturalWidth}x${image.naturalHeight}, ` +
      `declared ${jpeg.declaredType || "(nothing)"} sniffed ${jpeg.mime}`,
  );
  if (settled === "load" && image.naturalWidth > 0) {
    good("  the same BlobUrlScope serves images; the earlier <audio> failure was the CONTENT");
  } else {
    bad("  the jpeg did not decode either — something is wrong with the byte path, not the mime");
  }
  // Left attached on purpose: the screenshot wants it. The scope goes with the page.
}

// ── driver ────────────────────────────────────────────────────────────────────

async function pageFacts(): Promise<void> {
  fact("origin", location.origin);
  fact("mode", import.meta.env.DEV ? "vite dev server" : "built bundle");
  fact("crossOriginIsolated (main)", String(crossOriginIsolated));
  fact("isSecureContext", String(isSecureContext));
  fact("userAgent", navigator.userAgent);
  const response = await fetch(location.href, { method: "GET", cache: "no-store" });
  for (const header of ["cross-origin-opener-policy", "cross-origin-embedder-policy"]) {
    fact(header, response.headers.get(header) ?? "(not set)");
  }
}

async function openDatabases(reimport: boolean): Promise<boolean> {
  const opened = new Promise<boolean>((resolve) => {
    openResolve = resolve;
  });
  send({ kind: "open", id: ++requestId, reimport });
  return opened;
}

async function boot(): Promise<void> {
  await pageFacts();
  const ok = await openDatabases(false);
  if (!ok) {
    bad("the databases did not open; nothing below can run");
    return;
  }
  write("");
  write(`${clips.length} clip(s) came back from the worker:`);
  for (const clip of clips) {
    write(
      `  ${clip.deck.padEnd(6)} ${clip.fileName.padEnd(16)} ${clip.blobKind.padEnd(7)} ` +
        `declared ${(clip.declaredType || "(nothing)").padEnd(26)} sniffed ${clip.mime.padEnd(24)} ` +
        `${n(clip.byteSize).padStart(9)}B ${clip.voice ?? "-"} ${clip.lang ?? "-"} ` +
        `${clip.sourceText === null ? "" : JSON.stringify(clip.sourceText)}`,
    );
  }
  write("");
  await autoplayProbe();
  write("");
  write("READY — click Run (a real click is a user gesture, which is what the", "step");
  write("autoplay policy wants). The driver clicks it; a human can too.", "step");
  runButton!.disabled = false;
  // `?auto=1` runs the suite without waiting for a click. It exists because the
  // dev server reloads this page whenever another agent saves a file in src/, and
  // a run that has to be re-clicked never finishes. A gesture-driven run is the
  // one worth reporting; this one is for when the gesture cannot survive.
  if (new URLSearchParams(location.search).get("auto") === "1") {
    write("?auto=1 — running without waiting for a click", "step");
    await suite();
  }
}

async function suite(): Promise<void> {
  runButton!.disabled = true;
  write("");
  write(`user gesture recorded: navigator.userActivation.isActive = ${String(navigator.userActivation?.isActive)}`);
  const results = await playEverything();
  await playToEnd();
  await decodeIndependently();
  await mimeMatrix();
  await lifecycle();
  await workerMinted();
  await imageControl();

  write("");
  step("16. verdict");
  const audio = results.filter((result) => result.clip.mime === "audio/mpeg");
  const decoded = audio.filter((result) => result.ok);
  const longest = decoded.reduce((best, result) => (result.duration > best ? result.duration : best), 0);
  write(`  real mp3s from the corpus played: ${decoded.length}/${audio.length}`);
  write(
    `  total audio decoded: ${secs(decoded.reduce((sum, result) => sum + result.duration, 0))}, ` +
      `longest ${secs(longest)}, furthest position reached on any one clip ` +
      `${secs(decoded.reduce((best, result) => (result.maxTime > best ? result.maxTime : best), 0))}`,
  );
  write(`  failures recorded on this page: ${window.__state.failures.length}`);
  if (decoded.length === audio.length && window.__state.failures.length === 0) {
    good("  ALL STEPS COMPLETED — real corpus mp3, out of a SQLite blob store in OPFS,");
    good("  through URL.createObjectURL, decoded and played in a real browser.");
  } else {
    bad("  SOMETHING FAILED — read the BAD lines above");
  }
  window.__state.suiteDone = true;
  // The dev server full-reloads this page whenever anything under src/ is saved,
  // which in a repo with several agents in it is often. Keep the transcript where
  // a reload cannot take it.
  try {
    sessionStorage.setItem("hashigo-audio-transcript", transcript.join("\n"));
  } catch {
    // Private mode, quota, whatever — the DOM still has the log.
  }
}

runButton.disabled = true;
runButton.addEventListener("click", () => {
  void suite();
});
reimportButton.addEventListener("click", () => {
  void openDatabases(true);
});

void boot();
