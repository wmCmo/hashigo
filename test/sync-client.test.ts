import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agoLabel,
  forgetMergedPeers,
  isStale,
  markEdited,
  peersNewerThan,
  pushGradesNow,
  readMark,
  sinceLabel,
  syncEta,
  syncNow,
  type SyncPorts,
  type SyncProgress,
  versionOf,
  whenEdited,
} from "../app/sync-client.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

function json(
  body: unknown,
  sha: string | null = null,
): { ok: boolean; status: number; headers: Headers; text: () => Promise<string> } {
  const headers = new Headers(sha === null ? {} : { "X-Payload-Sha": sha });
  return { ok: true, status: 200, headers, text: async () => JSON.stringify(body) };
}

function fakeMailbox(
  files: Record<string, unknown>,
  shas: { listed?: Record<string, string>; served?: Record<string, string> } = {},
): { downloads: Map<string, number> } {
  const store = new Map<string, string>([["hashigo.sync.deviceId", "dev-selftest01"]]);
  const downloads = new Map<string, number>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => void store.set(k, v),
    removeItem: (k: string): void => void store.delete(k),
  });
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    if ((init?.method ?? "GET") !== "GET") {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url === "/sync/") {
      return json({
        peers: Object.keys(files).map((deviceId) => ({
          deviceId,
          bytes: 1,
          updatedAt: NOW.toISOString(),
          ...(shas.listed?.[deviceId] === undefined ? {} : { sha: shas.listed[deviceId] }),
        })),
      });
    }
    const id = url.slice("/sync/".length);
    downloads.set(id, (downloads.get(id) ?? 0) + 1);
    if (!(id in files)) return { ok: false, status: 404, headers: new Headers(), text: async () => "" };
    return json(files[id], shas.served?.[id] ?? null);
  });
  return { downloads };
}

const ports = (onMerge: (p: unknown) => void): SyncPorts => ({
  async exportPayload() {
    return { json: "{}", bytes: 2 };
  },
  async mergePayload(payload: unknown) {
    onMerge(payload);
    if ((payload as { bad?: boolean }).bad === true) throw new Error("archive version undefined");
    return { reviewsAdded: 1, flagsTaken: 2, trackStateTaken: 0 };
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("one bad peer does not stop the sync", () => {
  it("merges the good peers and still pushes, reporting the failure", async () => {
    fakeMailbox({ "dev-aaa": { bad: true }, "dev-bbb": { ok: true }, "dev-ccc": { ok: true } });
    const seen: unknown[] = [];
    const outcome = await syncNow(ports((p) => seen.push(p)));

    expect(seen).toHaveLength(3);
    expect(outcome.peersMerged).toBe(2);
    expect(outcome.reviewsAdded).toBe(2);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toContain("dev-aaa");
    expect(outcome.pushedBytes).toBe(2);
  });

  it("never merges its own payload back into itself", async () => {
    fakeMailbox({ "dev-selftest01": { ok: true }, "dev-bbb": { ok: true } });
    const seen: unknown[] = [];
    const outcome = await syncNow(ports((p) => seen.push(p)));
    expect(seen).toHaveLength(1);
    expect(outcome.peersMerged).toBe(1);
  });
});

describe("an unchanged peer is not downloaded again — 2026-09-29", () => {
  it("skips a peer whose listed hash is the one this device last merged", async () => {
    const shas = { listed: { "dev-bbb": "h1" }, served: { "dev-bbb": "h1" } };
    const box = fakeMailbox({ "dev-bbb": { ok: true } }, shas);
    await syncNow(ports(() => undefined));
    await syncNow(ports(() => undefined));
    expect(box.downloads.get("dev-bbb")).toBe(1);
  });

  it("downloads again when the peer's hash changes", async () => {
    const shas = { listed: { "dev-bbb": "h1" }, served: { "dev-bbb": "h1" } };
    const box = fakeMailbox({ "dev-bbb": { ok: true } }, shas);
    await syncNow(ports(() => undefined));
    shas.listed["dev-bbb"] = "h2";
    shas.served["dev-bbb"] = "h2";
    await syncNow(ports(() => undefined));
    expect(box.downloads.get("dev-bbb")).toBe(2);
  });

  it("records the hash of what it MERGED, not what the listing claimed — a lagging read is retried", async () => {
    const shas = { listed: { "dev-bbb": "h2" }, served: { "dev-bbb": "h1" } };
    const box = fakeMailbox({ "dev-bbb": { ok: true } }, shas);
    await syncNow(ports(() => undefined));
    await syncNow(ports(() => undefined));
    expect(box.downloads.get("dev-bbb")).toBe(2);
  });

  it("a peer with no hash (an old payload) is downloaded once, not on every sync — 2026-10-09", async () => {
    const box = fakeMailbox({ "dev-bbb": { ok: true } });
    await syncNow(ports(() => undefined));
    await syncNow(ports(() => undefined));
    expect(box.downloads.get("dev-bbb")).toBe(1);
  });

  it("a hashless peer that uploads again is downloaded again", () => {
    const listed = { deviceId: "dev-bbb", bytes: 10, updatedAt: "2026-09-26T12:00:00.000Z" };
    expect(versionOf(listed)).not.toBe(versionOf({ ...listed, updatedAt: "2026-10-09T12:00:00.000Z" }));
    expect(versionOf(listed)).not.toBe(versionOf({ ...listed, bytes: 11 }));
    expect(versionOf({ ...listed, sha: "abc" })).toBe("abc");
  });

  it("a failed merge is not recorded, so the next sync tries that peer again", async () => {
    const shas = { listed: { "dev-aaa": "h1" }, served: { "dev-aaa": "h1" } };
    const box = fakeMailbox({ "dev-aaa": { bad: true } }, shas);
    await syncNow(ports(() => undefined));
    await syncNow(ports(() => undefined));
    expect(box.downloads.get("dev-aaa")).toBe(2);
  });

  it("forgetting (a new or replaced database) makes every peer download again", async () => {
    const shas = { listed: { "dev-bbb": "h1" }, served: { "dev-bbb": "h1" } };
    const box = fakeMailbox({ "dev-bbb": { ok: true } }, shas);
    await syncNow(ports(() => undefined));
    forgetMergedPeers();
    await syncNow(ports(() => undefined));
    expect(box.downloads.get("dev-bbb")).toBe(2);
  });
});

describe("what the indicator says", () => {
  it("says never rather than inventing a time", () => {
    expect(sinceLabel(null)).toBe("never synced");
    expect(sinceLabel("not a date")).toBe("never synced");
  });

  it("reads in the units he would use", () => {
    expect(sinceLabel("2026-09-12T11:59:30.000Z", NOW)).toBe("synced just now");
    expect(sinceLabel("2026-09-12T11:40:00.000Z", NOW)).toBe("synced 20m ago");
    expect(sinceLabel("2026-09-12T09:00:00.000Z", NOW)).toBe("synced 3h ago");
    expect(sinceLabel("2026-09-09T12:00:00.000Z", NOW)).toBe("synced 3d ago");
  });

  it("calls a day-old sync stale, because his workflow is daily", () => {
    const base = { detail: null, peers: 1 } as const;
    expect(isStale({ ...base, state: "never", lastSyncedAt: null }, NOW)).toBe(true);
    expect(isStale({ ...base, state: "failed", lastSyncedAt: NOW.toISOString() }, NOW)).toBe(true);
    expect(isStale({ ...base, state: "ok", lastSyncedAt: "2026-09-12T11:00:00.000Z" }, NOW)).toBe(
      false,
    );
    expect(isStale({ ...base, state: "ok", lastSyncedAt: "2026-09-10T11:00:00.000Z" }, NOW)).toBe(
      true,
    );
  });
});

describe("a mailbox that answers with a page", () => {
  function pageInsteadOfJson(): void {
    vi.stubGlobal("localStorage", {
      getItem: (k: string): string | null => (k === "hashigo.sync.deviceId" ? "dev-selftest01" : null),
      setItem: (): void => undefined,
    });
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        ['<!doctype html>', '<html lang="ja">', "  <head>", "    <title>梯子</title>"].join("\n"),
    }));
  }

  it("says the answer was a PAGE, rather than quoting a parser", async () => {
    pageInsteadOfJson();
    await expect(syncNow(ports(() => undefined))).rejects.toThrow(/answered with a PAGE, not JSON/);
  });

  it("names the request, and what to actually do about it", async () => {
    pageInsteadOfJson();
    const failure = await syncNow(ports(() => undefined)).catch((cause: Error) => cause.message);
    expect(failure).toContain("/sync/");
    expect(failure).toContain("npm run phone");
    expect(failure).not.toContain("Unexpected token");
  });

  it("quotes the body when it is neither JSON nor a page", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (): string | null => "dev-selftest01",
      setItem: (): void => undefined,
    });
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        ["502 Bad Gateway", "", "the tunnel is up but nothing is behind it"].join("\n"),
    }));
    const failure = await syncNow(ports(() => undefined)).catch((cause: Error) => cause.message);
    expect(failure).toContain("502 Bad Gateway");
    expect(failure).not.toContain("Unexpected token");
  });

  it("still reports a plain HTTP failure as a status", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (): string | null => "dev-selftest01",
      setItem: (): void => undefined,
    });
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503, text: async () => "" }));
    await expect(syncNow(ports(() => undefined))).rejects.toThrow(/answered 503/);
  });
});

describe("a device that cannot reach the laptop at all", () => {
  function offTheTailnet(): void {
    vi.stubGlobal("localStorage", {
      getItem: (): string | null => "dev-selftest01",
      setItem: (): void => undefined,
    });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
  }

  it("says which machine and what to do, not the browser's words", async () => {
    offTheTailnet();
    const failure = await syncNow(ports(() => undefined)).catch((cause: Error) => cause.message);
    expect(failure).toContain("could not reach the laptop");
    expect(failure).toContain("tailnet");
    expect(failure).toContain("Tailscale");
    expect(failure).not.toContain("Failed to fetch");
  });

  it("does not add a second em dash — `paintSync` already supplies one", () => {
    const rendered = `sync failed — could not reach the laptop.`;
    expect(rendered.split("—")).toHaveLength(2);
  });

  it("still rethrows a NON-network error untouched", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (): string | null => "dev-selftest01",
      setItem: (): void => undefined,
    });
    vi.stubGlobal("fetch", async () => {
      throw new RangeError("a real bug, not the network");
    });
    await expect(syncNow(ports(() => undefined))).rejects.toThrow(/a real bug, not the network/);
  });
});

describe("the sent clock is not the synced clock", () => {
  const NOW = new Date("2026-09-14T12:00:00.000Z");

  it("words the same instant two ways, from one arithmetic", () => {
    const at = "2026-09-14T11:58:00.000Z";
    expect(agoLabel(at, NOW)).toBe("2m ago");
    expect(sinceLabel(at, NOW)).toBe("synced 2m ago");
  });

  it("never lets the push row read `grades sent synced just now`", () => {
    for (const at of [
      "2026-09-14T11:59:59.000Z",
      "2026-09-14T11:30:00.000Z",
      "2026-09-14T02:00:00.000Z",
      "2026-09-10T12:00:00.000Z",
    ]) {
      expect(agoLabel(at, NOW)).not.toContain("synced");
    }
  });

  it("says nothing rather than lying when there is no such moment", () => {
    expect(agoLabel(null, NOW)).toBeNull();
    expect(agoLabel("not a date", NOW)).toBeNull();
    expect(sinceLabel(null, NOW)).toBe("never synced");
  });
});

describe("knowing a peer is ahead", () => {
  const SYNCED = "2026-09-14T12:00:00.000Z";

  function mailbox(peers: Record<string, string>): void {
    const store = new Map<string, string>([["hashigo.sync.deviceId", "dev-selftest01"]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => void store.set(k, v),
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url !== "/sync/") return { ok: false, status: 404, text: async () => "" };
      return json({
        peers: Object.entries(peers).map(([deviceId, updatedAt]) => ({
          deviceId,
          bytes: 1,
          updatedAt,
        })),
      });
    });
  }

  it("counts a peer that pushed AFTER this device last merged", async () => {
    mailbox({ "dev-phone": "2026-09-14T12:40:00.000Z" });
    expect(await peersNewerThan(SYNCED)).toBe(1);
  });

  it("ignores a peer whose payload this device has already merged", async () => {
    mailbox({ "dev-phone": "2026-09-14T11:00:00.000Z" });
    expect(await peersNewerThan(SYNCED)).toBe(0);
  });

  it("never counts THIS device — its own push is not news", async () => {
    mailbox({ "dev-selftest01": "2026-09-14T23:00:00.000Z" });
    expect(await peersNewerThan(SYNCED)).toBe(0);
  });

  it("treats every peer as newer when this device has NEVER synced", async () => {
    mailbox({ "dev-phone": "2026-09-01T00:00:00.000Z", "dev-other": "2026-09-02T00:00:00.000Z" });
    expect(await peersNewerThan(null)).toBe(2);
  });

  it("counts each ahead peer, because the label says how many", async () => {
    mailbox({
      "dev-phone": "2026-09-14T12:40:00.000Z",
      "dev-other": "2026-09-14T12:50:00.000Z",
      "dev-old": "2026-09-13T00:00:00.000Z",
      "dev-selftest01": "2026-09-14T23:00:00.000Z",
    });
    expect(await peersNewerThan(SYNCED)).toBe(2);
  });

  it("propagates a mailbox failure rather than reporting 0 peers ahead", async () => {
    mailbox({});
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503, text: async () => "" }));
    await expect(peersNewerThan(SYNCED)).rejects.toThrow();
  });

  it("makes `behind` count as needing attention, without waiting a day", async () => {
    expect(
      isStale({ state: "behind", lastSyncedAt: SYNCED, detail: null, peers: 1 }, new Date(SYNCED)),
    ).toBe(true);
    expect(
      isStale({ state: "ok", lastSyncedAt: SYNCED, detail: null, peers: 0 }, new Date(SYNCED)),
    ).toBe(false);
  });
});

describe("how long a sync will take", () => {
  const measured = { mergeMsPerByte: 0.004, downBytesPerMs: 500, sendMs: 900 };

  it("adds download, merge and send from the last run's speeds", () => {
    const eta = syncEta(measured, { downloadBytes: 1_000_000, mergeBytes: 2_000_000, send: true });
    expect(eta).toBeCloseTo(10.9, 5);
  });

  it("says nothing rather than half the truth when the merge was never timed", () => {
    const eta = syncEta(
      { ...measured, mergeMsPerByte: null },
      { downloadBytes: 1_000, mergeBytes: 1_000, send: true },
    );
    expect(eta).toBeNull();
  });

  it("does not need what is already done", () => {
    const eta = syncEta(
      { ...measured, downBytesPerMs: null },
      { downloadBytes: 0, mergeBytes: 250_000, send: false },
    );
    expect(eta).toBeCloseTo(1, 5);
  });

  it("prefers this run's measured download rate to the stored one", () => {
    const eta = syncEta(measured, { downloadBytes: 1_000_000, mergeBytes: 0, send: false }, 100);
    expect(eta).toBeCloseTo(10, 5);
  });
});

describe("what a sync reports while it runs", () => {
  function sizedMailbox(sizes: Record<string, number>): { gets: string[]; store: Map<string, string> } {
    const store = new Map<string, string>([["hashigo.sync.deviceId", "dev-selftest01"]]);
    const gets: string[] = [];
    vi.stubGlobal("localStorage", {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => void store.set(k, v),
      removeItem: (k: string): void => void store.delete(k),
    });
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string; signal?: AbortSignal }) => {
      if ((init?.method ?? "GET") !== "GET") return { ok: true, status: 200 };
      init?.signal?.throwIfAborted();
      gets.push(url);
      if (url === "/sync/") {
        return json({
          peers: Object.entries(sizes).map(([deviceId, bytes]) => ({
            deviceId,
            bytes,
            updatedAt: NOW.toISOString(),
            sha: `${deviceId}-v1`,
          })),
        });
      }
      const id = url.slice("/sync/".length);
      return json({ ok: true }, `${id}-v1`);
    });
    return { gets, store };
  }

  it("totals the download from the listing and walks the stages in order", async () => {
    sizedMailbox({ "dev-aaa": 300, "dev-bbb": 700 });
    const seen: SyncProgress[] = [];
    await syncNow(ports(() => undefined), { onProgress: (p) => seen.push(p) });
    expect(seen.every((p) => p.total === 1000)).toBe(true);
    expect(seen.map((p) => `${p.stage}:${p.peer}`)).toEqual([
      "checking:0",
      "downloading:1",
      "merging:1",
      "downloading:2",
      "merging:2",
      "sending:0",
    ]);
  });

  it("has no estimate on the first run on a device, and has one on the second", async () => {
    const { store } = sizedMailbox({ "dev-aaa": 300 });
    const first: SyncProgress[] = [];
    await syncNow(ports(() => undefined), { onProgress: (p) => first.push(p) });
    expect(first.every((p) => p.etaSeconds === null)).toBe(true);
    store.set("hashigo.sync.merged", "{}");
    const timing = JSON.parse(store.get("hashigo.sync.timing") ?? "{}") as Record<string, unknown>;
    store.set("hashigo.sync.timing", JSON.stringify({ ...timing, mergeMsPerByte: 0.01, downBytesPerMs: 100 }));
    const second: SyncProgress[] = [];
    await syncNow(ports(() => undefined), { onProgress: (p) => second.push(p) });
    expect(second[0]?.etaSeconds).not.toBeNull();
  });

  it("with push: false, sends nothing and never says it is sending", async () => {
    const box = sizedMailbox({ "dev-aaa": 300 });
    const exported: number[] = [];
    const seen: SyncProgress[] = [];
    const outcome = await syncNow(
      { ...ports(() => undefined), exportPayload: async () => (exported.push(1), { json: "{}", bytes: 2 }) },
      { push: false, onProgress: (p) => seen.push(p) },
    );
    expect(exported).toHaveLength(0);
    expect(outcome.pushedBytes).toBe(0);
    expect(seen.some((p) => p.stage === "sending")).toBe(false);
    expect(box.store.get("hashigo.sync.lastSyncedAt")).toBeDefined();
  });

  it("reuses a listing it is handed instead of asking again", async () => {
    const box = sizedMailbox({ "dev-aaa": 300 });
    const listing = [{ deviceId: "dev-aaa", bytes: 300, updatedAt: NOW.toISOString(), sha: "dev-aaa-v1" }];
    await syncNow(ports(() => undefined), { listing });
    expect(box.gets).toEqual(["/sync/dev-aaa"]);
  });

  it("an abort is thrown, not filed as one peer's failure", async () => {
    sizedMailbox({ "dev-aaa": 300 });
    const abort = new AbortController();
    abort.abort();
    await expect(syncNow(ports(() => undefined), { signal: abort.signal })).rejects.toThrow();
  });
});

describe("sending grades as a delta", () => {
  interface Call {
    method: string;
    url: string;
    headers: Record<string, string>;
    keepalive: boolean;
    body: unknown;
  }

  function mailboxRecording(
    options: { deltaStatus?: number; listing?: unknown[]; deltas?: Record<string, unknown[]> } = {},
  ): { calls: Call[]; store: Map<string, string> } {
    const store = new Map<string, string>([["hashigo.sync.deviceId", "dev-selftest01"]]);
    const calls: Call[] = [];
    vi.stubGlobal("localStorage", {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => void store.set(k, v),
      removeItem: (k: string): void => void store.delete(k),
    });
    vi.stubGlobal(
      "fetch",
      async (url: string, init: { method?: string; headers?: Record<string, string>; keepalive?: boolean; body?: unknown } = {}) => {
        const method = init.method ?? "GET";
        calls.push({ method, url, headers: init.headers ?? {}, keepalive: init.keepalive === true, body: init.body });
        if (method === "POST" && url.endsWith("/delta")) {
          return { ok: (options.deltaStatus ?? 200) < 300, status: options.deltaStatus ?? 200 };
        }
        if (method === "PUT") return { ok: true, status: 200 };
        if (url === "/sync/") return json({ peers: options.listing ?? [] });
        if (url.endsWith("/delta")) {
          const id = url.slice("/sync/".length, -"/delta".length);
          return json(options.deltas?.[id] ?? [], `delta-${id}-v1`);
        }
        return json({ full: true }, `${url}-sha`);
      },
    );
    return { calls, store };
  }

  const exported: string[] = [];
  const port = (deltaCount = 2, mark = 42, editRows = 3): SyncPorts => ({
    async exportPayload() {
      exported.push("full");
      return { json: "{}", bytes: 2_000_000, mark: 40, index: "index-of-full" };
    },
    async exportDelta(after: number, sent?: string) {
      exported.push(sent === undefined ? `delta>${after}` : `delta>${after}+edits-since:${sent}`);
      const edits = sent === undefined ? 0 : editRows;
      return {
        json: JSON.stringify({ delta: 1, mark, reviews: [] }),
        bytes: 900,
        mark,
        count: deltaCount,
        edits,
        ...(sent === undefined ? {} : { index: `index-after:${sent}` }),
      };
    },
    async exportIndex() {
      exported.push("index");
      return "index-now";
    },
    async mergePayload() {
      return { reviewsAdded: 1, flagsTaken: 0, trackStateTaken: 0, markBefore: 42, markAfter: 50 };
    },
  });

  afterEach(() => {
    exported.length = 0;
  });

  it("the first send is FULL, covering its mark — a delta needs a full payload under it", async () => {
    const box = mailboxRecording();
    expect(await pushGradesNow(port())).toBe("full");
    const put = box.calls.find((c) => c.method === "PUT");
    expect(put?.headers["X-Covers-Mark"]).toBe("40");
    expect(readMark()).toBe(40);
  });

  it("after that, grades go as a few-KB delta and the mark moves", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    expect(await pushGradesNow(port())).toBe("delta");
    expect(exported).toEqual(["delta>40"]);
    expect(box.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /sync/dev-selftest01/delta"]);
    expect(readMark()).toBe(42);
  });

  it("an edit with no fingerprint to diff against sends the full payload, and keeps its fingerprint", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    markEdited();
    expect(await pushGradesNow(port())).toBe("full");
    expect(box.store.has("hashigo.sync.fullDirty")).toBe(false);
    expect(box.store.get("hashigo.sync.sent")).toBe("index-of-full");
  });

  it("an edit goes as a DELTA once a fingerprint exists — decision 64, no full payload for one card", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    box.store.set("hashigo.sync.sent", "fp1");
    markEdited();
    expect(await pushGradesNow(port())).toBe("delta");
    expect(exported).toEqual(["delta>40+edits-since:fp1"]);
    expect(box.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /sync/dev-selftest01/delta"]);
    expect(box.store.get("hashigo.sync.sent")).toBe("index-after:fp1");
    expect(box.store.has("hashigo.sync.fullDirty")).toBe(false);
    expect(readMark()).toBe(42);
  });

  it("an edit delta that does not land keeps the OLD fingerprint and the flag, so it is sent again", async () => {
    const box = mailboxRecording({ deltaStatus: 500 });
    box.store.set("hashigo.sync.mark", "40");
    box.store.set("hashigo.sync.sent", "fp1");
    markEdited();
    await expect(pushGradesNow(port())).rejects.toThrow(/500/);
    expect(box.store.get("hashigo.sync.sent")).toBe("fp1");
    expect(box.store.has("hashigo.sync.fullDirty")).toBe(true);
  });

  it("an edit made WHILE the delta was being sent stays marked unsent", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    box.store.set("hashigo.sync.sent", "fp1");
    markEdited();
    const racing: SyncPorts = {
      ...port(),
      async exportDelta(after: number, sent?: string) {
        const reply = await port().exportDelta!(after, sent);
        box.store.set("hashigo.sync.fullDirty", "a-later-edit");
        return reply;
      },
    };
    expect(await pushGradesNow(racing)).toBe("delta");
    expect(box.store.get("hashigo.sync.fullDirty")).toBe("a-later-edit");
  });

  it("an edit that changed nothing a peer receives sends nothing, and settles the flag", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "42");
    box.store.set("hashigo.sync.sent", "fp1");
    markEdited();
    expect(await pushGradesNow(port(0, 42, 0))).toBe("nothing");
    expect(box.calls).toHaveLength(0);
    expect(box.store.has("hashigo.sync.fullDirty")).toBe(false);
    expect(box.store.get("hashigo.sync.sent")).toBe("index-after:fp1");
  });

  it("a port that cannot diff (no fingerprint back) gets the full payload, never a grades-only send", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    box.store.set("hashigo.sync.sent", "fp1");
    markEdited();
    const old: SyncPorts = {
      ...port(),
      async exportDelta() {
        return { json: "{}", bytes: 900, mark: 42, count: 2 };
      },
    };
    expect(await pushGradesNow(old)).toBe("full");
    expect(box.store.has("hashigo.sync.fullDirty")).toBe(false);
  });

  it("a full push from a port with no fingerprint FORGETS the old one", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.sent", "stale");
    const old: SyncPorts = { ...port(), exportPayload: async () => ({ json: "{}", bytes: 2, mark: 40 }) };
    expect(await pushGradesNow(old)).toBe("full");
    expect(box.store.has("hashigo.sync.sent")).toBe(false);
  });

  it("forgetting the database forgets the fingerprint with the mark", () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    box.store.set("hashigo.sync.sent", "fp1");
    forgetMergedPeers();
    expect(box.store.has("hashigo.sync.sent")).toBe(false);
    expect(box.store.has("hashigo.sync.mark")).toBe(false);
  });

  it("an edit delta over the mailbox's 64 KB goes full without trying the doomed POST", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    box.store.set("hashigo.sync.sent", "fp1");
    markEdited();
    const big: SyncPorts = {
      ...port(),
      async exportDelta(after: number, sent?: string) {
        return { ...(await port().exportDelta!(after, sent)), bytes: 70 * 1024 };
      },
    };
    expect(await pushGradesNow(big)).toBe("full");
    expect(box.calls.map((c) => c.method)).toEqual(["PUT"]);
    expect(box.store.get("hashigo.sync.sent")).toBe("index-of-full");
  });

  it("an edit asks for a push itself — it does not wait for the next grade (2026-11-05)", () => {
    mailboxRecording();
    let asked = 0;
    whenEdited(() => {
      asked += 1;
    });
    markEdited();
    expect(asked).toBe(1);
  });

  it("closing the page sends the delta with keepalive — even after an edit, the GRADES go", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    markEdited();
    expect(await pushGradesNow(port(), { keepalive: true })).toBe("delta");
    expect(box.calls[0]).toMatchObject({ method: "POST", keepalive: true });
    expect(box.store.has("hashigo.sync.fullDirty")).toBe(true);
  });

  it("on keepalive, never starts a full send it cannot finish", async () => {
    const box = mailboxRecording();
    expect(await pushGradesNow(port(), { keepalive: true })).toBe("nothing");
    expect(box.calls).toHaveLength(0);
  });

  it("nothing new and nothing edited sends nothing at all — no radio, no request", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "42");
    expect(await pushGradesNow(port(0, 42))).toBe("nothing");
    expect(box.calls).toHaveLength(0);
  });

  it("a mailbox with no delta route (the laptop's dev one) gets the full payload instead", async () => {
    const box = mailboxRecording({ deltaStatus: 404 });
    box.store.set("hashigo.sync.mark", "40");
    expect(await pushGradesNow(port())).toBe("full");
    expect(box.calls.map((c) => c.method)).toEqual(["POST", "PUT"]);
  });

  it("pulls a peer's delta alone when only the delta changed, merging each entry once", async () => {
    const box = mailboxRecording({
      listing: [{ deviceId: "dev-tablet01", bytes: 10, updatedAt: NOW.toISOString(), sha: "base1", delta: { bytes: 5, updatedAt: NOW.toISOString(), sha: "delta-dev-tablet01-v1" } }],
      deltas: { "dev-tablet01": [{ delta: 1, mark: 3 }, { delta: 1, mark: 7 }] },
    });
    box.store.set("hashigo.sync.merged", JSON.stringify({ "dev-tablet01": "base1" }));
    const merged: unknown[] = [];
    const ports = { ...port(), mergePayload: async (p: unknown) => (merged.push(p), { reviewsAdded: 1, flagsTaken: 0, trackStateTaken: 0 }) };
    await syncNow(ports, { push: false });
    expect(box.calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual(["/sync/", "/sync/dev-tablet01/delta"]);
    expect(merged).toHaveLength(2);
    await syncNow(ports, { push: false });
    expect(merged).toHaveLength(2);
  });

  it("a merge that brings in another device's grades carries the mark, so they are not sent back", async () => {
    const box = mailboxRecording({
      listing: [{ deviceId: "dev-tablet01", bytes: 10, updatedAt: NOW.toISOString(), sha: "base2" }],
    });
    box.store.set("hashigo.sync.mark", "42");
    await syncNow(port(), { push: false });
    expect(readMark()).toBe(50);
  });

  it("does not carry the mark when this device still had unsent grades", async () => {
    const box = mailboxRecording({
      listing: [{ deviceId: "dev-tablet01", bytes: 10, updatedAt: NOW.toISOString(), sha: "base3" }],
    });
    box.store.set("hashigo.sync.mark", "30");
    await syncNow(port(), { push: false });
    expect(readMark()).toBe(30);
  });

  it("after merging another device's edits, re-takes the fingerprint so they are not sent back", async () => {
    const box = mailboxRecording({
      listing: [{ deviceId: "dev-laptop01", bytes: 10, updatedAt: NOW.toISOString(), sha: "base1", delta: { bytes: 5, updatedAt: NOW.toISOString(), sha: "delta-dev-laptop01-v1" } }],
      deltas: { "dev-laptop01": [{ delta: 1, mark: 3, reviews: [], edits: { cardFlags: [{ cardId: "new1" }] } }] },
    });
    box.store.set("hashigo.sync.merged", JSON.stringify({ "dev-laptop01": "base1" }));
    box.store.set("hashigo.sync.sent", "fp1");
    await syncNow(port(), { push: false });
    expect(exported).toEqual(["index"]);
    expect(box.store.get("hashigo.sync.sent")).toBe("index-now");
  });

  it("does NOT re-take it while a local edit is unsent — that edit is not in the mailbox", async () => {
    const box = mailboxRecording({
      listing: [{ deviceId: "dev-laptop01", bytes: 10, updatedAt: NOW.toISOString(), sha: "base2" }],
    });
    box.store.set("hashigo.sync.sent", "fp1");
    markEdited();
    await syncNow(port(), { push: false });
    expect(exported).toEqual([]);
    expect(box.store.get("hashigo.sync.sent")).toBe("fp1");
  });

  it("does not re-take it when the edit lands DURING the export", async () => {
    const box = mailboxRecording({
      listing: [{ deviceId: "dev-laptop01", bytes: 10, updatedAt: NOW.toISOString(), sha: "base3" }],
    });
    box.store.set("hashigo.sync.sent", "fp1");
    const racing: SyncPorts = {
      ...port(),
      async exportIndex() {
        box.store.set("hashigo.sync.fullDirty", "an-edit-meanwhile");
        return "index-now";
      },
    };
    await syncNow(racing, { push: false });
    expect(box.store.get("hashigo.sync.sent")).toBe("fp1");
  });

  it("the sync BUTTON sends a delta too — a full push there would undo the saving for every device", async () => {
    const box = mailboxRecording({ listing: [] });
    box.store.set("hashigo.sync.mark", "40");
    box.store.set("hashigo.sync.sent", "fp1");
    markEdited();
    const outcome = await syncNow(port());
    expect(box.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /sync/dev-selftest01/delta",
    ]);
    expect(outcome.pushedBytes).toBe(900);
  });

  it("merges only the delta entries it has not merged before — the stack is re-downloaded whole", async () => {
    const entries = [{ delta: 1, mark: 3, reviews: [] }, { delta: 1, mark: 7, reviews: [] }];
    const listed = (sha: string) => [{ deviceId: "dev-tablet01", bytes: 10, updatedAt: NOW.toISOString(), sha: "base9", delta: { bytes: 5, updatedAt: NOW.toISOString(), sha } }];
    const box = mailboxRecording({ listing: listed("delta-dev-tablet01-v1"), deltas: { "dev-tablet01": entries } });
    box.store.set("hashigo.sync.merged", JSON.stringify({ "dev-tablet01": "base9" }));
    const merged: unknown[] = [];
    const ports = { ...port(), mergePayload: async (p: unknown) => (merged.push(p), { reviewsAdded: 0, flagsTaken: 0, trackStateTaken: 0 }) };
    await syncNow(ports, { push: false });
    expect(merged).toHaveLength(2);
    entries.push({ delta: 1, mark: 9, reviews: [] });
    box.store.set("hashigo.sync.mergedDelta", JSON.stringify({ "dev-tablet01": "an-older-sha" }));
    await syncNow(ports, { push: false });
    expect(merged).toHaveLength(3);
    expect((merged[2] as { mark: number }).mark).toBe(9);
    forgetMergedPeers();
    box.store.set("hashigo.sync.merged", JSON.stringify({ "dev-tablet01": "base9" }));
    await syncNow(ports, { push: false });
    expect(merged).toHaveLength(6);
  });

  it("a merge of grades only leaves the fingerprint alone — no export on the boot screen", async () => {
    const box = mailboxRecording({
      listing: [{ deviceId: "dev-phone01", bytes: 10, updatedAt: NOW.toISOString(), sha: "base4", delta: { bytes: 5, updatedAt: NOW.toISOString(), sha: "delta-dev-phone01-v1" } }],
      deltas: { "dev-phone01": [{ delta: 1, mark: 3, reviews: [] }] },
    });
    box.store.set("hashigo.sync.merged", JSON.stringify({ "dev-phone01": "base4" }));
    box.store.set("hashigo.sync.sent", "fp1");
    await syncNow(port(), { push: false });
    expect(exported).toEqual([]);
  });
});
