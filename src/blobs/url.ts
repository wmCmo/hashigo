/**
 * Turning a stored blob into something an `<audio>` or `<img>` element can load,
 * and taking it back afterwards.
 *
 * WHY THIS FILE HAS TO EXIST. Every other layer of Hashigo is built on the rule
 * that a payload has no location: `blobs.hash` means "ask the store for these
 * bytes" and nothing in the database says where they are (see address.ts). The
 * platform's media elements want the opposite — a URL. `URL.createObjectURL`
 * is the only bridge that does not reintroduce a path: it mints a
 * `blob:https://origin/<uuid>` handle for bytes already in memory, resolvable
 * only by this document, only until it is revoked.
 *
 * WHICH MAKES REVOCATION THE WHOLE PROBLEM. An object URL is a strong reference
 * held by the *user agent*, not by the page. It outlives every variable that
 * mentioned it and is released by exactly two things: `revokeObjectURL`, or the
 * environment being torn down. A review session that mints one per clip and
 * never revokes leaks the audio it has played for as long as the tab lives —
 * 60,551 B per clip on average in this corpus, 3,374,905 B at the worst, and
 * Zach reviews ~69 cards a day on a phone. That is the bug this file is shaped
 * to prevent, so the rules are stated rather than left to a caller:
 *
 *   1. THE SCOPE THAT MINTS A URL REVOKES IT. Nothing else may. In particular an
 *      element must never revoke its own `src` from an event handler: `ended`
 *      does not fire on a clip the user skipped, `error` fires for reasons that
 *      have nothing to do with the URL, and a double revoke is silent.
 *   2. A SCOPE IS AS SHORT AS THE THING IT SERVES. One `BlobUrlScope` per card
 *      presentation; `releaseAll()` when the card goes away. That single call is
 *      the entire lifecycle in the common case.
 *   3. CLEAR THE ELEMENT BEFORE REVOKING. Revoking a URL that is still assigned
 *      to `element.src` leaves the element holding a handle that no longer
 *      resolves; the next `load()` fails with a MEDIA_ELEMENT_ERROR that names
 *      the blob URL and explains nothing. `attachMedia()` returns a `detach()`
 *      that does pause -> clear -> `load()` -> revoke, in that order.
 *   4. THE CAP IS A BACKSTOP, NOT A CACHE POLICY. `maxLive`/`maxLiveBytes` exist
 *      so that a caller who forgets rule 2 leaks a bounded amount instead of an
 *      unbounded amount. Eviction is LRU and it revokes, which can break a clip
 *      still attached to an element — so it is deliberately sized well above one
 *      card's worth of audio and `attachMedia` touches its lease.
 *
 * MEASURED, NOT ASSUMED (Chromium 151 on Windows, `spike/audio/`, 18 real clips
 * out of the corpus read from a `SqliteBlobStore` in OPFS; the transcript is
 * pasted in spike/audio/README.md):
 *
 *   * 15 of 15 real mp3s played: `duration` finite (1.560 s to 28.968 s, 80.4 s
 *     of audio in total), `loadedmetadata`/`canplay`/`play`/`playing` all fired,
 *     `currentTime` advanced ~0.37 s per 400 ms of wall clock, and one clip
 *     seeked to `duration - 0.4` reached `ended` at exactly `duration`.
 *     `decodeAudioData` on the same bytes reports 1 channel at 48,000 Hz and a
 *     duration matching the element's to the millisecond.
 *   * THE BLOB'S `type` DOES NOT GATE `<audio src>`. The same mp3, labelled
 *     `audio/mpeg`, `text/xml`, `application/octet-stream`, `""` and
 *     `audio/mpeg; codecs="mp3"`, loaded and played in all five cases —
 *     `duration 1.560s` and the clock advancing every time — even though
 *     `canPlayType("text/xml")` is `""`. Chromium sniffs the container and
 *     ignores the label. **SPEC.html is therefore wrong where it says "A browser
 *     handed text/xml in an <audio> element will not play it, so this breaks
 *     playback outright"** — it does play it. Sniffing on import is still right,
 *     for the reasons below, and this file's mime handling is defence-in-depth
 *     rather than the thing that makes audio work.
 *   * `<source type="…">` IS a gate. It is filtered by `canPlayType()` before any
 *     bytes are fetched: with `type="text/xml"` the `<source>` raised its own
 *     `error`, `networkState` went to 3 (NETWORK_NO_SOURCE), `duration` stayed
 *     `NaN` and `element.error` stayed **null** — a failure with no error object
 *     on the element to notice it by. The identical bytes behind
 *     `type="audio/mpeg"` reached `canplay`. That is the one shape in which a
 *     wrong mime is fatal, which is why `attachMedia` sets `src` and never
 *     `<source>`, and why `playableMime()` refuses to pass a known lie through.
 *   * REVOKING TOO EARLY AND REVOKING TOO LATE FAIL DIFFERENTLY. Revoked before
 *     the element loaded: `error`, `MEDIA_ERR_SRC_NOT_SUPPORTED`, `duration NaN`.
 *     Revoked after `canplay`: playback still started and reached 0.244 s,
 *     because the resource was already fetched — but the next `load()` on that
 *     same still-assigned URL failed with `MEDIA_ERR_SRC_NOT_SUPPORTED`. Hence
 *     rule 3's order, and hence `attachMedia` refusing a revoked lease outright.
 *   * A URL MINTED IN A WORKER *DOES* RESOLVE IN THE DOCUMENT (same origin, one
 *     blob URL store): the worker minted, the page played it, 4.392 s. So rule 1
 *     is about ownership, not capability — the worker cannot know when the
 *     element is finished, so it must not be the thing holding the handle.
 *
 * PURE BROWSER, AND NOT IN THE BARREL. No `node:*` imports, so this file is part
 * of the browser build; `./index.js` is *not*, because it re-exports `node.ts`.
 * Import this module directly, the way `address.js` and `store.js` are imported
 * by browser code. Nothing here touches the DOM at module load, so the dist
 * verifier can still import it under Node.
 */

import { assertAddress } from "./address.js";
import { BlobConflictError } from "./store.js";

/** Bytes plus the address they are filed under and the mime the database sniffed. */
export interface BlobPayload {
  readonly hash: string;
  readonly bytes: Uint8Array;
  /** `blobs.mime`. Sniffed from the bytes on import — never Mochi's claim. */
  readonly mime: string;
}

/**
 * One live object URL. Handed out by a scope, revoked by that scope; `revoke()`
 * is here so a caller can end one clip early without reaching into the scope,
 * and is idempotent.
 */
export interface BlobUrlLease {
  readonly hash: string;
  /** `blob:https://origin/<uuid>`. Valid only in the context that minted it. */
  readonly url: string;
  /** What the Blob was actually labelled — `playableMime()` of the row's mime. */
  readonly mime: string;
  readonly byteLength: number;
  /** True once revoked, by `revoke()`, by the scope, or by eviction. */
  readonly revoked: boolean;
  /**
   * Mark this lease most-recently-used, so the cap evicts something else.
   * `attachMedia` calls it: a lease an element is actually holding is the last
   * one that should be revoked out from under it. No-op once revoked.
   */
  touch(): void;
  revoke(): void;
}

export interface BlobUrlScopeOptions {
  /**
   * Live leases before the least-recently-used one is revoked. A card in this
   * corpus references at most a handful of clips, so 32 is ~8x a card's worth.
   */
  readonly maxLive?: number;
  /**
   * Live bytes before the least-recently-used lease is revoked. 32 MiB is ~550
   * average clips, or ten of the largest one in the corpus.
   */
  readonly maxLiveBytes?: number;
  /** Injected for tests and for measuring; defaults to the platform's. */
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
}

export interface BlobUrlScopeStats {
  /** URLs minted. */
  readonly claimed: number;
  /** `claim()` calls answered with a live lease instead of a new URL. */
  readonly reused: number;
  /** URLs revoked, however that happened. */
  readonly revoked: number;
  /** Of those, revoked by the cap rather than by a caller. */
  readonly evicted: number;
}

/** Mime labels in this corpus that are known to be lies, and what to do about them. */
const MIME_LIES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/xml",
  "text/xml",
  "text/plain",
]);

/**
 * The label to put on the Blob.
 *
 * `blobs.mime` is sniffed on import and is therefore already right. What the
 * export declared, recounted from the raw `.mochi` files by
 * `spike/audio/pick-clips.py`: `application/octet-stream` 4,979, `text/xml`
 * 3,443, nothing at all 2,424, `audio/mpeg` 36, `image/jpeg` 4, `image/png` 1 —
 * 41 correct out of 10,887. This function is what stops a future generator,
 * a hand-written row or an unsniffed import from putting one of those declared
 * lies onto a Blob: a label this project knows to be untrustworthy is replaced
 * with the empty string, which makes the platform sniff the bytes instead of
 * believing a label. An empty type is a weaker promise than a wrong one.
 *
 * It is not a sniffer and must not become one. `sniffMime()` in
 * `src/import/blobs.ts` owns that decision, from the bytes, once, at import.
 */
export function playableMime(mime: string | null | undefined): string {
  const value = (mime ?? "").trim().toLowerCase();
  if (value === "") return "";
  if (MIME_LIES.has(value)) return "";
  // A parameterised type (`audio/mpeg; codecs=...`) is legal and useful; keep it.
  return value;
}

interface Entry {
  lease: MutableLease;
  bytes: number;
  touched: number;
}

class MutableLease implements BlobUrlLease {
  readonly hash: string;
  readonly url: string;
  readonly mime: string;
  readonly byteLength: number;
  #revoked = false;
  readonly #release: (hash: string) => void;
  readonly #touch: (hash: string) => void;

  constructor(
    hash: string,
    url: string,
    mime: string,
    byteLength: number,
    release: (hash: string) => void,
    touch: (hash: string) => void,
  ) {
    this.hash = hash;
    this.url = url;
    this.mime = mime;
    this.byteLength = byteLength;
    this.#release = release;
    this.#touch = touch;
  }

  get revoked(): boolean {
    return this.#revoked;
  }

  touch(): void {
    if (this.#revoked) return;
    this.#touch(this.hash);
  }

  revoke(): void {
    if (this.#revoked) return;
    this.#release(this.hash);
  }

  /** Called by the scope, which is the only thing allowed to do the revoking. */
  markRevoked(): void {
    this.#revoked = true;
  }
}

/**
 * A bounded set of live object URLs with one owner.
 *
 * Make one per card presentation, `claim()` each blob it needs, and
 * `releaseAll()` when the card is replaced. Claiming the same address twice
 * returns the same live lease and does not mint a second URL, so a card that
 * shows the same clip in two places costs one URL and one copy of the bytes.
 */
export class BlobUrlScope {
  readonly #entries = new Map<string, Entry>();
  readonly #maxLive: number;
  readonly #maxLiveBytes: number;
  readonly #create: (blob: Blob) => string;
  readonly #revoke: (url: string) => void;
  #clock = 0;
  #bytes = 0;
  #claimed = 0;
  #reused = 0;
  #revoked = 0;
  #evicted = 0;

  constructor(options: BlobUrlScopeOptions = {}) {
    this.#maxLive = options.maxLive ?? 32;
    this.#maxLiveBytes = options.maxLiveBytes ?? 32 * 1024 * 1024;
    if (this.#maxLive < 1) throw new RangeError("maxLive must be at least 1");
    const create = options.createObjectURL;
    const revoke = options.revokeObjectURL;
    if ((create === undefined) !== (revoke === undefined)) {
      throw new TypeError(
        "createObjectURL and revokeObjectURL must be injected together: minting with " +
          "one implementation and revoking with another leaks every URL.",
      );
    }
    if (create !== undefined && revoke !== undefined) {
      this.#create = create;
      this.#revoke = revoke;
      return;
    }
    const platform = globalThis.URL as
      | (typeof URL & {
          createObjectURL?: (blob: Blob) => string;
          revokeObjectURL?: (url: string) => void;
        })
      | undefined;
    if (platform?.createObjectURL === undefined || platform.revokeObjectURL === undefined) {
      throw new Error(
        "URL.createObjectURL is unavailable here. A BlobUrlScope belongs in the context " +
          "that owns the elements — the document, or a worker that will consume the URL " +
          "itself — not in Node. Inject createObjectURL/revokeObjectURL to test without one.",
      );
    }
    this.#create = platform.createObjectURL.bind(platform);
    this.#revoke = platform.revokeObjectURL.bind(platform);
  }

  /** Live leases. */
  get live(): number {
    return this.#entries.size;
  }

  /** Bytes pinned by live leases. This is the number the cap is protecting. */
  get liveBytes(): number {
    return this.#bytes;
  }

  get stats(): BlobUrlScopeStats {
    return {
      claimed: this.#claimed,
      reused: this.#reused,
      revoked: this.#revoked,
      evicted: this.#evicted,
    };
  }

  /**
   * A URL for these bytes, minting one if this scope does not already hold one.
   *
   * Idempotent per address, like `BlobStore.write`: a second claim of the same
   * hash returns the first lease and counts as `reused`. A second claim with a
   * *different* payload length under the same address is a content-address
   * violation and throws `BlobConflictError`, exactly as the store does — the
   * bytes cannot have changed if the hash did not.
   */
  claim(payload: BlobPayload): BlobUrlLease {
    const hash = assertAddress(payload.hash);
    const held = this.#entries.get(hash);
    if (held !== undefined) {
      if (held.bytes !== payload.bytes.byteLength) {
        throw new BlobConflictError(hash, held.bytes, payload.bytes.byteLength);
      }
      held.touched = this.#clock++;
      this.#reused += 1;
      return held.lease;
    }

    const mime = playableMime(payload.mime);
    // The Blob is built from a COPY of the caller's view, for two reasons that
    // happen to agree. Practically: the caller may well want to transfer or reuse
    // that buffer the moment this returns (the worker in `spike/audio/` transfers
    // it), and a Blob over a detached buffer is a resource that reads as empty at
    // load time and nowhere else. Formally: `BlobPart` is `ArrayBufferView<
    // ArrayBuffer>` since TypeScript 5.7, and a `Uint8Array<ArrayBufferLike>` —
    // which is what every SQLite handle hands back — does not satisfy it, so the
    // alternative is a cast that asserts something about the caller's buffer that
    // this module cannot see. A copy of one clip costs ~60 KB and ~0.02 ms.
    const part = new Uint8Array(payload.bytes);
    const blob = mime === "" ? new Blob([part]) : new Blob([part], { type: mime });
    const lease = new MutableLease(
      hash,
      this.#create(blob),
      mime,
      payload.bytes.byteLength,
      (target) => {
        this.release(target);
      },
      (target) => {
        this.touch(target);
      },
    );
    this.#entries.set(hash, { lease, bytes: payload.bytes.byteLength, touched: this.#clock++ });
    this.#bytes += payload.bytes.byteLength;
    this.#claimed += 1;
    this.#enforceCap();
    return lease;
  }

  /** The live lease for this address, or null. Does not mint and does not touch. */
  peek(hash: string): BlobUrlLease | null {
    return this.#entries.get(assertAddress(hash))?.lease ?? null;
  }

  /** Mark this lease as most-recently-used, so the cap does not evict it. */
  touch(hash: string): boolean {
    const entry = this.#entries.get(assertAddress(hash));
    if (entry === undefined) return false;
    entry.touched = this.#clock++;
    return true;
  }

  /** Revoke one URL. True if there was one. Safe to call twice. */
  release(hash: string): boolean {
    return this.#drop(assertAddress(hash), false);
  }

  /**
   * Revoke everything this scope holds. THE ONE CALL THAT MATTERS: put it where
   * the card presentation ends, and no clip can outlive the card that played it.
   * Returns how many URLs it revoked.
   */
  releaseAll(): number {
    let count = 0;
    for (const hash of [...this.#entries.keys()]) {
      if (this.#drop(hash, false)) count += 1;
    }
    return count;
  }

  #drop(hash: string, evicted: boolean): boolean {
    const entry = this.#entries.get(hash);
    if (entry === undefined) return false;
    this.#entries.delete(hash);
    this.#bytes -= entry.bytes;
    entry.lease.markRevoked();
    this.#revoke(entry.lease.url);
    this.#revoked += 1;
    if (evicted) this.#evicted += 1;
    return true;
  }

  #enforceCap(): void {
    while (this.#entries.size > this.#maxLive || this.#bytes > this.#maxLiveBytes) {
      let oldest: string | null = null;
      let oldestTouched = Number.POSITIVE_INFINITY;
      for (const [hash, entry] of this.#entries) {
        if (entry.touched < oldestTouched) {
          oldestTouched = entry.touched;
          oldest = hash;
        }
      }
      // One live lease can exceed maxLiveBytes on its own (the corpus's largest
      // clip is 3.4 MB, but nothing stops a bigger one). Revoking the only lease
      // there is would hand back a dead URL, so the cap yields instead.
      if (oldest === null || this.#entries.size === 1) return;
      this.#drop(oldest, true);
    }
  }
}

/** What `attachMedia` hands back. Call `detach()` when the element is done. */
export interface MediaAttachment {
  readonly lease: BlobUrlLease;
  /**
   * Pause, clear the element's source, then revoke — in that order, because an
   * element left holding a revoked URL fails its next `load()` for reasons that
   * do not mention revocation. Idempotent.
   */
  detach(): void;
}

export interface AttachMediaOptions {
  /**
   * Revoke the lease as part of `detach()`. Default true, because the common
   * case is one clip on one element and the lifetimes are the same. Pass false
   * when the same lease is attached to more than one element and the scope
   * outlives them.
   */
  readonly revoke?: boolean;
}

/**
 * Point a media element at a lease.
 *
 * `src` and not `<source type>`: a `<source>` element is filtered by
 * `canPlayType()` before anything is fetched, so a wrong mime there means the
 * element never even looks at the bytes — measured, and the one shape in which
 * this corpus's `text/xml` labels really are fatal.
 */
export function attachMedia(
  element: HTMLMediaElement,
  lease: BlobUrlLease,
  options: AttachMediaOptions = {},
): MediaAttachment {
  if (lease.revoked) {
    throw new Error(
      `blob ${lease.hash} has already been revoked; claim it again rather than reusing a ` +
        `dead object URL (the element would fail to load with no useful error).`,
    );
  }
  // The cap must not evict the clip an element is holding; see rule 4.
  lease.touch();
  element.src = lease.url;
  let detached = false;
  return {
    lease,
    detach(): void {
      if (detached) return;
      detached = true;
      try {
        element.pause();
      } catch {
        // A detached or never-loaded element can throw here; it changes nothing.
      }
      element.removeAttribute("src");
      // Required: without a load() the element keeps the old resource selected
      // and a later assignment can resurrect the revoked URL.
      element.load();
      if (options.revoke !== false) lease.revoke();
    },
  };
}
