import { assertAddress } from "./address.js";
import { BlobConflictError } from "./store.js";

export interface BlobPayload {
  readonly hash: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
}

export interface BlobUrlLease {
  readonly hash: string;
  readonly url: string;
  readonly mime: string;
  readonly byteLength: number;
  readonly revoked: boolean;
  touch(): void;
  revoke(): void;
}

export interface BlobUrlScopeOptions {
  readonly maxLive?: number;
  readonly maxLiveBytes?: number;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
}

export interface BlobUrlScopeStats {
  readonly claimed: number;
  readonly reused: number;
  readonly revoked: number;
  readonly evicted: number;
}

const MIME_LIES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/xml",
  "text/xml",
  "text/plain",
]);

export function playableMime(mime: string | null | undefined): string {
  const value = (mime ?? "").trim().toLowerCase();
  if (value === "") return "";
  if (MIME_LIES.has(value)) return "";
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

  markRevoked(): void {
    this.#revoked = true;
  }
}

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

  get live(): number {
    return this.#entries.size;
  }

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

  peek(hash: string): BlobUrlLease | null {
    return this.#entries.get(assertAddress(hash))?.lease ?? null;
  }

  touch(hash: string): boolean {
    const entry = this.#entries.get(assertAddress(hash));
    if (entry === undefined) return false;
    entry.touched = this.#clock++;
    return true;
  }

  release(hash: string): boolean {
    return this.#drop(assertAddress(hash), false);
  }

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
      if (oldest === null || this.#entries.size === 1) return;
      this.#drop(oldest, true);
    }
  }
}

export interface MediaAttachment {
  readonly lease: BlobUrlLease;
  detach(): void;
}

export interface AttachMediaOptions {
  readonly revoke?: boolean;
}

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
      }
      element.removeAttribute("src");
      element.load();
      if (options.revoke !== false) lease.revoke();
    },
  };
}
