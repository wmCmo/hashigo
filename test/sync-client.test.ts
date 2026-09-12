/**
 * The sync CLIENT — the transport loop and the words the indicator shows.
 *
 * `src/sync` owns the merge and is tested against real databases. This file owns
 * the part that talks to the mailbox, and the one thing in it that was found by
 * accident rather than by design: ONE BAD PEER MUST NOT STOP THE SYNC.
 *
 * That happened for real on 2026-09-12. A hand-written test payload was left in
 * the mailbox with `archive: {}`; the merge threw, the loop aborted, and the run
 * never reached the good peer or the push. A peer on an older build, or a file
 * caught half-written, does exactly the same thing — so a failure is now carried
 * out in the result rather than thrown.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isStale, sinceLabel, syncNow, type SyncPorts } from "../app/sync-client.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

/**
 * A response the client will accept. `text`, not `json`: the client reads the
 * body as text and parses it itself, so that an answer which is NOT JSON can be
 * described instead of reaching him as a parser error.
 */
function json(body: unknown): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function fakeMailbox(files: Record<string, unknown>): void {
  const store = new Map<string, string>([["hashigo.sync.deviceId", "dev-selftest01"]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => void store.set(k, v),
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
        })),
      });
    }
    const id = url.slice("/sync/".length);
    if (!(id in files)) return { ok: false, status: 404, text: async () => "" };
    return json(files[id]);
  });
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

    // The bad one was attempted, the other two merged, and the run completed.
    expect(seen).toHaveLength(3);
    expect(outcome.peersMerged).toBe(2);
    expect(outcome.reviewsAdded).toBe(2);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toContain("dev-aaa");
    // The push still happened — this is the half the abort used to swallow.
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

/**
 * ─── THE ERROR ZACH GOT ON HIS PHONE, 2026-09-13 ────────────────────────────
 *
 *     sync failed — Unexpected token '<', "<!doctype "... is not valid JSON
 *
 * Nothing in that is actionable. It is `JSON.parse` describing the first
 * character of a web page, and it names neither the request nor the fact that
 * the answer WAS a page — which is the whole diagnosis.
 *
 * **`response.ok` cannot catch this.** A server with no `/sync/` route does not
 * 404: a single-page app's fallback answers 200 with `index.html`, on purpose,
 * because unknown routes are supposed to be the app. So the status check passes
 * and the parser is the first thing to notice anything is wrong.
 *
 * The cause that day was a stale `vite preview` holding port 4274 while
 * `tailscale serve` kept pointing at it — a process whose middleware predated
 * the mailbox, serving a bundle rebuilt that evening. Today's screen, last
 * week's server. `scripts/phone.mjs` now refuses to start into that; this is the
 * half that covers every other way a mailbox can be missing.
 */
describe("a mailbox that answers with a page", () => {
  function pageInsteadOfJson(): void {
    vi.stubGlobal("localStorage", {
      getItem: (k: string): string | null => (k === "hashigo.sync.deviceId" ? "dev-selftest01" : null),
      setItem: (): void => undefined,
    });
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
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
    // Which request. Without this he cannot tell a missing mailbox from a
    // missing peer.
    expect(failure).toContain("/sync/");
    // And the fix, because the cause is almost always the same one.
    expect(failure).toContain("npm run phone");
    // The thing it must NOT be.
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
      text: async () =>
        ["502 Bad Gateway", "", "the tunnel is up but nothing is behind it"].join("\n"),
    }));
    const failure = await syncNow(ports(() => undefined)).catch((cause: Error) => cause.message);
    expect(failure).toContain("502 Bad Gateway");
    expect(failure).not.toContain("Unexpected token");
  });

  it("still reports a plain HTTP failure as a status", async () => {
    // The case that DID work before must keep working: a real 404 or 500 is
    // already a clear answer and must not be dressed up as a parse problem.
    vi.stubGlobal("localStorage", {
      getItem: (): string | null => "dev-selftest01",
      setItem: (): void => undefined,
    });
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503, text: async () => "" }));
    await expect(syncNow(ports(() => undefined))).rejects.toThrow(/answered 503/);
  });
});
