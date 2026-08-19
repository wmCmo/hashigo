/**
 * THROWAWAY (spike harness) — spike/persist/drive.mjs
 *
 * Drives the page in real Chrome over the DevTools Protocol, with no browser
 * automation dependency at all: Node 22+ has a global `WebSocket`, and CDP is
 * JSON over one socket. Raw CDP rather than Playwright because two domains this
 * spike needs are not exposed by any automation wrapper:
 *
 *   * `Browser.grantPermissions(["durableStorage"])` — the ONLY way to observe
 *     the `persist() === true` branch on a desktop. Chrome never grants it to a
 *     fresh automated profile, so without this the "granted" path is untestable
 *     and the plumbing for it unproven.
 *   * `Storage.overrideQuotaForOrigin` — sets a small quota so the page can be
 *     driven INTO the limit in seconds instead of writing 10 GiB to Zach's disk.
 *
 * Usage (the vite dev server must already be running):
 *
 *   node spike/persist/drive.mjs <scenario> [--url http://localhost:5273/persist/] [--show]
 *
 *   deny      persist() with no permission granted  (the default state)
 *   grant     persist() with durableStorage granted (the PWA-like state)
 *   fill      open + write ~700 MB, quota before/after
 *   quota     override the quota to 800 MB, then overrun it on purpose
 *   multitab  two tabs on one origin: the failure, then the handover
 *   evict     wipe all OPFS, then time the recovery
 *
 * Every scenario uses its OWN fresh user-data-dir, so no scenario can inherit
 * another's OPFS or permissions.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.CHROME_PATH ?? "",
].filter((p) => p !== "");

const argv = process.argv.slice(2);
const scenario = argv[0] ?? "deny";
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const URL_BASE = flag("url", "http://localhost:5273/persist/");
const SHOW = argv.includes("--show");
const PORT = Number(flag("port", "9333"));

function chromePath() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error(`no chrome.exe found; tried:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
}

const profile = join(tmpdir(), `hashigo-persist-${scenario}-${Date.now()}`);
mkdirSync(profile, { recursive: true });

function launch() {
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--window-size=520,900",
    "about:blank",
  ];
  // Mirrors Android Chrome's chrome://flags/#unsafely-treat-insecure-origin-as-secure,
  // which is the only cable-free way to get OPFS on a plain http:// LAN address.
  const insecure = flag("insecure-origin", "");
  if (insecure !== "") args.unshift(`--unsafely-treat-insecure-origin-as-secure=${insecure}`);
  if (!SHOW) args.unshift("--headless=new");
  const child = spawn(chromePath(), args, { stdio: "ignore", detached: false });
  return child;
}

async function browserSocket() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const json = await response.json();
      return { ws: json.webSocketDebuggerUrl, browser: json.Browser };
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("chrome never opened its debugging port");
}

/** Minimal flat-protocol CDP client. */
class Cdp {
  #ws;
  #next = 1;
  #waiting = new Map();
  listeners = [];

  static async connect(url) {
    const client = new Cdp();
    client.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      client.#ws.onopen = resolve;
      client.#ws.onerror = (e) => reject(new Error(`cdp socket failed: ${e.message ?? e.type}`));
    });
    client.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiter = client.#waiting.get(message.id);
        client.#waiting.delete(message.id);
        if (message.error) waiter?.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter?.resolve(message.result);
        return;
      }
      for (const listener of client.listeners) listener(message);
    };
    return client;
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
  }

  close() {
    this.#ws.close();
  }
}

/** One page, attached, with `eval` that awaits promises and surfaces throws. */
async function openTab(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  const console_ = [];
  cdp.listeners.push((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.consoleAPICalled") {
      console_.push(message.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (message.method === "Runtime.exceptionThrown") {
      console_.push(`EXCEPTION ${message.params.exceptionDetails.text}`);
    }
  });

  const tab = {
    targetId,
    sessionId,
    console: console_,
    async goto(to) {
      await cdp.send("Page.navigate", { url: to }, sessionId);
      await tab.waitForSpike();
    },
    async reload() {
      await cdp.send("Page.reload", { ignoreCache: false }, sessionId);
      await tab.waitForSpike();
    },
    async eval(expression, timeout = 600_000) {
      const result = await Promise.race([
        cdp.send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout },
          sessionId,
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`eval timed out after ${timeout}ms: ${expression}`)), timeout),
        ),
      ]);
      if (result.exceptionDetails) {
        throw new Error(
          `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    },
    async waitForSpike() {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const ready = await tab
          .eval("typeof window.__spike === 'object' && window.__spike !== null", 5000)
          .catch(() => false);
        if (ready === true) {
          // main.ts kicks off stepEnvironment() itself; let it finish.
          await new Promise((r) => setTimeout(r, 400));
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error("window.__spike never appeared — did the module fail to load?");
    },
    async transcript() {
      return tab.eval("window.__spike.transcript()");
    },
    async stats() {
      return tab.eval("JSON.stringify(window.__spike.stats())").then((s) => JSON.parse(s));
    },
  };
  await tab.goto(url);
  return tab;
}

function banner(text) {
  console.log(`\n${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`);
}

function dumpStats(stats) {
  for (const [key, value] of Object.entries(stats)) {
    console.log(`  ${key.padEnd(26)} ${value}`);
  }
}

// -- scenarios ----------------------------------------------------------------

const scenarios = {
  async deny(cdp, origin) {
    banner("SCENARIO deny — persist() with no durableStorage permission");
    const tab = await openTab(cdp, URL_BASE);
    console.log(await tab.transcript());
    banner("stats");
    dumpStats(await tab.stats());
    banner("permission state Chrome actually reports");
    console.log(
      JSON.stringify(
        await tab.eval("navigator.permissions.query({name:'persistent-storage'}).then(p=>p.state)"),
      ),
    );
  },

  async grant(cdp, origin) {
    banner("SCENARIO grant — Browser.grantPermissions(['durableStorage'])");
    await cdp.send("Browser.grantPermissions", { origin, permissions: ["durableStorage"] });
    console.log(`granted durableStorage to ${origin}`);
    const tab = await openTab(cdp, URL_BASE);
    console.log(await tab.transcript());
    banner("stats");
    dumpStats(await tab.stats());
    banner("permission state Chrome actually reports");
    console.log(
      JSON.stringify(
        await tab.eval("navigator.permissions.query({name:'persistent-storage'}).then(p=>p.state)"),
      ),
    );
    banner("and the worker, with persistence GRANTED, still cannot ask");
    await tab.eval("window.__spike.open(false)");
    console.log(await tab.transcript());
  },

  async fill(cdp) {
    banner("SCENARIO fill — open the real database, then write ~700 MB");
    const tab = await openTab(cdp, URL_BASE);
    await tab.eval("window.__spike.open(false)");
    await tab.eval("window.__spike.fill(0)");
    console.log(await tab.transcript());
    banner("stats");
    dumpStats(await tab.stats());
  },

  async quota(cdp, origin) {
    banner("SCENARIO quota — override the quota, then run past it on purpose");
    const OVERRIDE = Number(flag("quota", String(400 * 1024 * 1024)));
    // The override must be applied on a PAGE session and only once the origin
    // exists as far as the storage layer is concerned; sent on the browser
    // session before any navigation it answers "Internal error (-32603)".
    const tab = await openTab(cdp, URL_BASE);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: OVERRIDE }, tab.sessionId);
    console.log(`Storage.overrideQuotaForOrigin ${origin} -> ${OVERRIDE.toLocaleString()} bytes`);
    console.log(
      `page now reports: ${JSON.stringify(
        await tab.eval("navigator.storage.estimate().then(e=>({usage:e.usage,quota:e.quota}))"),
      )}`,
    );
    console.log("--- what the page sees for quota now ---");
    dumpStats(await tab.stats());
    await tab.eval("window.__spike.open(false)");
    console.log("--- a small write BEFORE the origin is full ---");
    await tab.eval("window.__spike.write()");
    await tab.eval("window.__spike.fill(0)");
    console.log("--- and a small write AFTER the bulk write hit the ceiling ---");
    await tab.eval("window.__spike.write()");
    console.log(await tab.transcript());
    banner("stats");
    dumpStats(await tab.stats());
    banner("does the card database still verify after a quota failure?");
    await tab.eval("window.__spike.open(false)");
    console.log(await tab.transcript());
  },

  async handles(cdp) {
    banner("SCENARIO handles — does close() give the OPFS file back?");
    // handles() FIRST: calling open() beforehand leaves a file pinned and the
    // baseline check can no longer tell us anything.
    const tab = await openTab(cdp, URL_BASE);
    await tab.eval("window.__spike.handles()");
    console.log(await tab.transcript());
  },

  /**
   * The scenario that can actually destroy the database WITHOUT an eviction:
   * the origin is already over quota when Hashigo starts. sqlite-wasm's failure
   * path for a pool install calls `removeVfs()`, which recursively deletes the
   * pool directory — the database with it.
   */
  async starve(cdp, origin) {
    banner("SCENARIO starve — already OVER quota at startup");
    const tab = await openTab(cdp, URL_BASE);
    await tab.eval("window.__spike.open(false)");
    await tab.eval("window.__spike.write()");
    const before = await tab.eval(
      "navigator.storage.estimate().then(e=>JSON.stringify({usage:e.usage,quota:e.quota}))",
    );
    console.log(`usage/quota with the database imported: ${before}`);

    const SMALL = Number(flag("quota", String(20 * 1024 * 1024)));
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: SMALL }, tab.sessionId);
    console.log(`quota now overridden to ${SMALL.toLocaleString()} bytes — far BELOW current usage`);

    banner("reload, so a brand-new worker installs the pool under starvation");
    await tab.reload();
    console.log(await tab.transcript());
    console.log("--- can it still open and verify? ---");
    console.log(`  open() -> ${await tab.eval("window.__spike.open(false)")}`);
    console.log("--- can it still record a review? ---");
    await tab.eval("window.__spike.write()");
    console.log(await tab.transcript());
    banner("stats");
    dumpStats(await tab.stats());

    // THE question. sqlite-wasm's install-failure path calls removeVfs(), which
    // recursively deletes the pool directory. Did the 69 MB database survive a
    // failed install, or did the failure destroy it?
    banner("LIFT the quota override, reload, and see if the database survived");
    await cdp.send("Storage.overrideQuotaForOrigin", { origin }, tab.sessionId);
    console.log("override removed");
    await tab.reload();
    console.log(`  open() -> ${await tab.eval("window.__spike.open(false)")}`);
    const transcript = await tab.transcript();
    console.log(transcript);
    console.log(
      transcript.includes("already in OPFS")
        ? "VERDICT: the database SURVIVED the failed install."
        : "VERDICT: the database was GONE and had to be re-imported.",
    );
    banner("stats");
    dumpStats(await tab.stats());
  },

  async multitab(cdp) {
    banner("SCENARIO multitab — two tabs, one origin, one sahpool");
    const preexisting = (await cdp.send("Target.getTargets", {})).targetInfos.filter(
      (t) => t.type === "worker",
    );
    console.log(`workers before ANY tab was opened: ${preexisting.length}`);
    const a = await openTab(cdp, URL_BASE);
    console.log(`tab A = ${await a.eval("window.__spike.tabId")}`);
    await a.eval("window.__spike.open(false)");
    await a.eval("window.__spike.hold(true)");
    console.log("--- TAB A, holding the database ---");
    console.log(await a.transcript());

    const b = await openTab(cdp, URL_BASE);
    console.log(`tab B = ${await b.eval("window.__spike.tabId")}`);
    console.log("--- TAB B, on load: did the Web Lock warn it? ---");
    console.log(await b.transcript());
    console.log("--- TAB B: polite open (respects the lock) ---");
    console.log(`  __spike.open() returned ${await b.eval("window.__spike.open(false)")}`);
    console.log(await b.transcript());

    console.log("--- TAB B: FORCE open, ignoring the lock. This is the ugly case. ---");
    let forced;
    try {
      forced = await b.eval("window.__spike.forceOpen()");
    } catch (error) {
      forced = `driver caught: ${error.message}`;
    }
    console.log(`  forceOpen() returned ${JSON.stringify(forced)}`);
    console.log(await b.transcript());

    console.log("--- did tab B corrupt anything? re-verify the oracle in TAB A ---");
    await a.eval("window.__spike.open(false)");
    console.log(await a.transcript());

    banner("HANDOVER: tab A pauses the VFS, tab B takes it");
    await a.eval("window.__spike.pause(true)");
    console.log("--- TAB A after pauseVfs() ---");
    console.log(await a.transcript());
    let after;
    try {
      after = await b.eval("window.__spike.forceOpen()");
    } catch (error) {
      after = `driver caught: ${error.message}`;
    }
    console.log(`--- TAB B forceOpen() after A paused: ${JSON.stringify(after)} ---`);
    console.log(await b.transcript());

    // The path a real person has: close the other tab. That kills the worker,
    // and a dead worker cannot hold a sync access handle.
    const workers = async (when) => {
      const all = await cdp.send("Target.getTargets", {});
      const w = all.targetInfos.filter((t) => t.type === "worker");
      console.log(
        `  dedicated workers ${when}: ${w.length} -> ${JSON.stringify(
          w.map((t) => `${t.title || "(no title)"} @ ${t.url || "(no url)"}`),
        )}`,
      );
      return w.length;
    };

    banner("TAB A TERMINATES ITS WORKER — what closing a tab does to it");
    await workers("before terminate");
    await a.eval("window.__spike.terminate()");
    await new Promise((r) => setTimeout(r, 800));
    await workers("after terminate");
    let afterTerminate;
    try {
      afterTerminate = await b.eval("window.__spike.forceOpen()");
    } catch (error) {
      afterTerminate = `driver caught: ${error.message}`;
    }
    console.log(`  TAB B forceOpen() after A terminated its worker -> ${JSON.stringify(afterTerminate)}`);
    // --no-retry reproduces the pre-diagnosis behaviour: without the flagged
    // retry, the cached rejection stands and the backoff loop below takes ~15 s.
    if (!argv.includes("--no-retry")) {
      console.log("  ... and now the same install WITH forceReinitIfPreviouslyFailed:");
      await b.eval("window.__spike.retry()");
      console.log(await b.transcript());
    } else {
      console.log("  (--no-retry: skipping the flagged retry on purpose)");
    }

    banner("NAVIGATING TAB A AWAY (destroys its document and its worker)");
    await workers("before");
    // Navigation, not Target.closeTarget: closing a target over CDP left tab A's
    // dedicated worker alive, which is not what a person closing a tab does.
    await cdp.send("Page.navigate", { url: "about:blank" }, a.sessionId);
    await new Promise((r) => setTimeout(r, 1500));
    await workers("after navigating tab A to about:blank");
    // Retry with real waits. "Close the other tab" is the only instruction a
    // person can act on, so how long it takes to work is the finding.
    for (const wait of [500, 1000, 2000, 4000, 8000]) {
      await new Promise((r) => setTimeout(r, wait));
      let attempt;
      try {
        attempt = await b.eval("window.__spike.forceOpen()");
      } catch (error) {
        attempt = `driver caught: ${error.message}`;
      }
      const lock = await b.eval("window.__spike.lockHeld()");
      console.log(`  after +${wait}ms: forceOpen() -> ${JSON.stringify(attempt)}, lockHeld=${lock}`);
      if (attempt === true) break;
    }
    console.log(await b.transcript());
    banner("tab B stats");
    dumpStats(await b.stats());
  },

  async evict(cdp, origin) {
    banner("SCENARIO evict — wipe all OPFS, then time the recovery");
    const tab = await openTab(cdp, URL_BASE);
    await tab.eval("window.__spike.open(false)");
    await tab.eval("window.__spike.fill(0)");
    const before = await tab.eval(
      "navigator.storage.estimate().then(e=>JSON.stringify({usage:e.usage,quota:e.quota}))",
    );
    console.log(`usage/quota before the eviction: ${before}`);

    // The page's own removeVfs() route, first: this is the button Zach taps.
    banner("in-page wipe (removeVfs) — the button on the phone");
    await tab.eval("window.__spike.evict()");
    console.log(await tab.transcript());

    // Then the real thing, from outside: Storage.clearDataForOrigin is what an
    // eviction actually does to the origin, and no page code can prevent it.
    banner("REAL eviction: Storage.clearDataForOrigin, then reload");
    await cdp.send(
      "Storage.clearDataForOrigin",
      { origin, storageTypes: "all" },
      tab.sessionId,
    );
    const after = await tab.eval(
      "navigator.storage.estimate().then(e=>JSON.stringify({usage:e.usage,quota:e.quota}))",
    );
    console.log(`usage/quota after clearDataForOrigin: ${after}`);
    await tab.reload();
    console.log("--- the page on a freshly-evicted origin ---");
    console.log(await tab.transcript());
    banner("timed recovery, from nothing");
    await tab.eval("window.__spike.recover()");
    console.log(await tab.transcript());
    banner("stats");
    dumpStats(await tab.stats());
  },
};

// -- main ---------------------------------------------------------------------

const run = scenarios[scenario];
if (run === undefined) {
  console.error(`unknown scenario ${JSON.stringify(scenario)}; try: ${Object.keys(scenarios).join(", ")}`);
  process.exit(2);
}

const child = launch();
let cdp;
let code = 0;
try {
  const { ws, browser } = await browserSocket();
  console.log(`chrome: ${browser}`);
  console.log(`page:   ${URL_BASE}`);
  console.log(`profile: ${profile}`);
  cdp = await Cdp.connect(ws);
  const origin = new URL(URL_BASE).origin;
  await run(cdp, origin);
} catch (error) {
  console.error(`\nDRIVER FAILED: ${error.stack ?? error.message}`);
  code = 1;
} finally {
  try {
    cdp?.send("Browser.close").catch(() => {});
  } catch {
    /* the socket may already be gone */
  }
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.log(`(left ${profile} behind; chrome still had it open)`);
  }
}
process.exit(code);
