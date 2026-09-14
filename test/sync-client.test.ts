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

import {
  agoLabel,
  isStale,
  peersNewerThan,
  sinceLabel,
  syncNow,
  type SyncPorts,
} from "../app/sync-client.js";

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

/**
 * The two clocks say different things, and conflating them is what let a day of
 * grading look fine — Zach, 2026-09-14.
 */
describe("the sent clock is not the synced clock", () => {
  const NOW = new Date("2026-09-14T12:00:00.000Z");

  it("words the same instant two ways, from one arithmetic", () => {
    const at = "2026-09-14T11:58:00.000Z";
    expect(agoLabel(at, NOW)).toBe("2m ago");
    expect(sinceLabel(at, NOW)).toBe("synced 2m ago");
  });

  it("never lets the push row read `grades sent synced just now`", () => {
    // The literal defect: `sinceLabel` bakes the verb into every branch, so the
    // row built from it said "grades sent synced just now".
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
    // Null is not "just now". A device that has never pushed must not report a
    // push, which is the whole failure this row exists to make visible.
    expect(agoLabel(null, NOW)).toBeNull();
    expect(agoLabel("not a date", NOW)).toBeNull();
    expect(sinceLabel(null, NOW)).toBe("never synced");
  });
});

/**
 * A GREEN DOT MUST NOT MEAN "UP TO DATE" WHEN IT ONLY MEANS "MY LAST PULL WORKED".
 *
 * Zach, 2026-09-14, mid-session on the laptop: *"it looks like i already did it
 * in the morning on my phone, same with 4-5 cards before this, but the light is
 * green... which means it's synced...?"*
 *
 * It was green, it was honest, and it was the wrong thing to believe. The
 * automatic half of sync is `pushNow`, which never pulls — deliberately, because
 * a merge mid-card freezes the screen for ~8 seconds and can move what is due
 * underneath him. So `lastSyncedAt` records the last PULL and then stands still
 * while a peer drops newer work into the mailbox a minute later.
 *
 * Reproduced from his own mailbox that evening: the phone's payload carried 36
 * reviews for the day, the laptop had merged none of them, and he re-answered
 * four cards the phone had already done at 08:42. Nothing was lost — reviews
 * UNION — but he did the work twice and the dot said he would not have to.
 *
 * `peersNewerThan` is a LISTING, not a merge: no payload bodies, nothing applied.
 * That is what makes it cheap enough to ask on load and after every push, which
 * is what closes the window the pull's manualness opens.
 */
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
    // The push that fires on his own grading rewrites this device's own slot and
    // makes it the newest file in the mailbox, every time. Counting it would put
    // the dot permanently in `behind` thirty seconds after every card.
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
    // Offline must not read as "you are up to date" HERE. The caller swallows it
    // and keeps the status it had; silently answering 0 would paint the dot green
    // on a device that simply could not ask, which is the original defect again.
    mailbox({});
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503, text: async () => "" }));
    await expect(peersNewerThan(SYNCED)).rejects.toThrow();
  });

  it("makes `behind` count as needing attention, without waiting a day", async () => {
    // `isStale` gates the sidebar's own nudge. `behind` is sharper than the
    // day-old threshold: the grades are in the mailbox NOW.
    expect(
      isStale({ state: "behind", lastSyncedAt: SYNCED, detail: null, peers: 1 }, new Date(SYNCED)),
    ).toBe(true);
    expect(
      isStale({ state: "ok", lastSyncedAt: SYNCED, detail: null, peers: 0 }, new Date(SYNCED)),
    ).toBe(false);
  });
});
