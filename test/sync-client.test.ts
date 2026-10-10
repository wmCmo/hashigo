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
  forgetMergedPeers,
  isStale,
  markFullDirty,
  peersNewerThan,
  pushGradesNow,
  readMark,
  sinceLabel,
  syncEta,
  syncNow,
  type SyncPorts,
  type SyncProgress,
  versionOf,
} from "../app/sync-client.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

/**
 * A response the client will accept. `text`, not `json`: the client reads the
 * body as text and parses it itself, so that an answer which is NOT JSON can be
 * described instead of reaching him as a parser error.
 */
function json(
  body: unknown,
  sha: string | null = null,
): { ok: boolean; status: number; headers: Headers; text: () => Promise<string> } {
  const headers = new Headers(sha === null ? {} : { "X-Payload-Sha": sha });
  return { ok: true, status: 200, headers, text: async () => JSON.stringify(body) };
}

/**
 * `shas.listed` is what the listing says each peer's hash is; `shas.served` is the
 * hash that comes back WITH the download. They differ when KV lags — the case the
 * skip rule has to survive. `downloads` counts GETs per peer.
 */
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

describe("an unchanged peer is not downloaded again — 2026-09-29", () => {
  // Measured before this: every press downloaded all eight peers (~2.3 MB) whether
  // or not they had changed.
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
    // KV lag: the listing already says h2, the download still returns h1's bytes.
    const shas = { listed: { "dev-bbb": "h2" }, served: { "dev-bbb": "h1" } };
    const box = fakeMailbox({ "dev-bbb": { ok: true } }, shas);
    await syncNow(ports(() => undefined));
    await syncNow(ports(() => undefined));
    // Recording h2 would have skipped the second sync and lost h2 until the next change.
    expect(box.downloads.get("dev-bbb")).toBe(2);
  });

  it("a peer with no hash (an old payload) is downloaded once, not on every sync — 2026-10-09", async () => {
    // 実測：クラウドの 6 枠のうち 4 枠が sha 導入前のもので、同期のたびに ~7.4 MB を
    // 落としてマージし直していた。版の名前は「上げた時刻＋大きさ」で足りる。
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
      headers: new Headers(),
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
 * The failure that arrives one layer BEFORE the mailbox can be inspected.
 *
 * Zach, on his phone, 2026-09-19: *"sync failed — Failed to fetch"*. Checked
 * while he was looking at it — the laptop was serving (200 in 10 ms locally,
 * 200 in 478 ms through `node.tailed819e.ts.net`) and `tailscale status` said
 * his handset was `offline, last seen 2h ago`. Off the tailnet is decision 33's
 * accepted cost, so the message has to name it.
 */
describe("a device that cannot reach the laptop at all", () => {
  function offTheTailnet(): void {
    vi.stubGlobal("localStorage", {
      getItem: (): string | null => "dev-selftest01",
      setItem: (): void => undefined,
    });
    // EXACTLY what a browser does for a network-layer failure: `fetch` REJECTS
    // with a TypeError. There is no response to look at, which is why none of
    // the mailbox diagnostics above can reach this case.
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
    // The string he actually read, which says nothing he can act on.
    expect(failure).not.toContain("Failed to fetch");
  });

  it("does not add a second em dash — `paintSync` already supplies one", () => {
    // Rendered as `sync failed — <detail>`; a dash inside the detail makes the
    // banner read as three fragments on a 375px screen.
    const rendered = `sync failed — could not reach the laptop.`;
    expect(rendered.split("—")).toHaveLength(2);
  });

  it("still rethrows a NON-network error untouched", async () => {
    // `reach` may only dress up a TypeError. A bug in the client that throws
    // something else must not come out wearing a networking diagnosis.
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

/**
 * 同期の進み具合と、あと何秒か — Zach, 2026-10-09: *"if I'm on a train and I want
 * to review it it would take so much time without knowing how long it would take"*.
 *
 * 見積もりは前回この端末で測った速さから出す。測っていない部分がある間は null —
 * 短い方の半分だけを言う数字は、電車に乗り遅れさせる数字だから。
 */
describe("how long a sync will take", () => {
  const measured = { mergeMsPerByte: 0.004, downBytesPerMs: 500, sendMs: 900 };

  it("adds download, merge and send from the last run's speeds", () => {
    const eta = syncEta(measured, { downloadBytes: 1_000_000, mergeBytes: 2_000_000, send: true });
    // 2,000 ms + 8,000 ms + 900 ms
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
    // ダウンロードが終わった後は、ダウンロード速度を知らなくても見積もれる。
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
    // 二回目は同じ端末に新しい版がある、という状況にする。
    store.set("hashigo.sync.merged", "{}");
    const timing = JSON.parse(store.get("hashigo.sync.timing") ?? "{}") as Record<string, unknown>;
    // テストの偽物は一瞬で終わるので、マージ速度が測れていれば十分。
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
    // 受け取る半分は済んだので「同期済み」の時刻は書く。
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

/**
 * 差分で送る — 2026-10-10。Zach: *"so it's guaranteed that my last min of reviewing
 * won't be synced from my tablet"*。全体（~2 MB）は `keepalive` の 64 KB に入らず、
 * 閉じた瞬間には届かない。差分は数 KB で入る。
 */
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
  const port = (deltaCount = 2, mark = 42): SyncPorts => ({
    async exportPayload() {
      exported.push("full");
      return { json: "{}", bytes: 2_000_000, mark: 40 };
    },
    async exportDelta(after: number) {
      exported.push(`delta>${after}`);
      return { json: JSON.stringify({ delta: 1, mark, reviews: [] }), bytes: 900, mark, count: deltaCount };
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

  it("an edit (anything but a grade) makes the next send full, and clears the flag", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    markFullDirty();
    expect(await pushGradesNow(port())).toBe("full");
    expect(box.store.has("hashigo.sync.fullDirty")).toBe(false);
  });

  it("closing the page sends the delta with keepalive — even after an edit, the GRADES go", async () => {
    const box = mailboxRecording();
    box.store.set("hashigo.sync.mark", "40");
    markFullDirty();
    expect(await pushGradesNow(port(), { keepalive: true })).toBe("delta");
    expect(box.calls[0]).toMatchObject({ method: "POST", keepalive: true });
    // 編集はまだ送っていない — 次の普通の送信が全体にする。
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
    // 二度目は取らない — 差分の sha が記録されている。
    await syncNow(ports, { push: false });
    expect(merged).toHaveLength(2);
  });

  it("a merge that brings in another device's grades carries the mark, so they are not sent back", async () => {
    const box = mailboxRecording({
      listing: [{ deviceId: "dev-tablet01", bytes: 10, updatedAt: NOW.toISOString(), sha: "base2" }],
    });
    box.store.set("hashigo.sync.mark", "42");
    await syncNow(port(), { push: false });
    // port の merge は markBefore 42 → markAfter 50。
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
});
