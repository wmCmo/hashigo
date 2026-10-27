/**
 * A RUNNING APP NOTICES A NEW DEPLOY. Zach, 2026-10-27: his phone said
 * `c1f0cad` two days and six deploys later — *"worse"*. Everything since (the
 * backlink repair, the selection button, the accent helper's fills) had never
 * reached it.
 *
 * ─── WHY IT WAS STUCK ───────────────────────────────────────────────────────
 *
 * `sw.js` is network-first, so a fresh LOAD is current. But nothing checked
 * while the app was RUNNING, and on Android a tab or home-screen app he switches
 * away from is resumed, not reloaded — a page opened on the 25th is still the
 * 25th's code. (Not measured on the phone; it is the only path that fits, and
 * the fix covers the other one too, below.)
 *
 * ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
 *
 * When the page becomes visible (at most once a minute — no timer, no polling:
 * SPEC problem #1), it reads the build's version file — written by
 * `serviceWorkerPrecache()` in `vite.app.config.ts`, and never stored by the
 * service worker. A different build than this one means a deploy
 * landed. Then:
 *
 *   · the service worker is asked to update FIRST, and the reload waits for the
 *     new one to activate — it precaches the new `index.html`, so a slow
 *     network's 3-second fallback (`NETWORK_WAIT_MS`) cannot serve the old shell
 *     straight back;
 *   · away five minutes or more, and no layer open (an editor holds a half-typed
 *     field): reload on its own — he is starting a sitting, and the boot screen
 *     syncs first anyway (decision 50);
 *   · otherwise a bar offers it, because reloading under a card he is halfway
 *     through would throw away the walk.
 */
import { APP_BUILD } from "./version.js";

const CHECK_GAP_MS = 60_000;
const AWAY_MS = 5 * 60_000;
const ACTIVATE_WAIT_MS = 20_000;

let lastCheck = 0;
let hiddenAt = 0;
let bar: HTMLElement | null = null;

async function liveBuild(): Promise<string | null> {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { build?: unknown };
    return typeof body.build === "string" && body.build !== "" ? body.build : null;
  } catch {
    return null;
  }
}

/** Ask for the new service worker and wait (bounded) until it is in charge. */
async function primeWorker(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (registration === undefined) return;
  await registration.update().catch(() => undefined);
  const next = registration.installing ?? registration.waiting;
  if (next === null) return;
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ACTIVATE_WAIT_MS);
    const done = (): void => {
      if (next.state !== "activated" && next.state !== "redundant") return;
      window.clearTimeout(timer);
      resolve();
    };
    next.addEventListener("statechange", done);
    done();
  });
}

async function reloadToNew(): Promise<void> {
  await primeWorker();
  window.location.reload();
}

function offer(build: string): void {
  if (bar !== null) return;
  bar = document.createElement("div");
  bar.className = "banner update-bar";
  bar.setAttribute("role", "status");
  bar.textContent = `A new version of Hashigo is ready (${build}).`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "reload";
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "loading…";
    void reloadToNew();
  });
  bar.appendChild(button);
  const anchor = document.getElementById("banner");
  if (anchor !== null) anchor.after(bar);
  else document.body.prepend(bar);
}

async function check(awayMs: number): Promise<void> {
  const now = Date.now();
  if (now - lastCheck < CHECK_GAP_MS) return;
  lastCheck = now;
  const live = await liveBuild();
  if (live === null || live === APP_BUILD) return;
  if (awayMs >= AWAY_MS && !document.body.classList.contains("layered")) {
    await reloadToNew();
    return;
  }
  offer(live);
}

/** Start watching. A build with no commit (tests, a bare checkout) never checks. */
export function watchForUpdates(): void {
  if (APP_BUILD === "") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    void check(hiddenAt === 0 ? 0 : Date.now() - hiddenAt);
  });
  // Once after boot as well: a load the service worker answered from its cache
  // (the network took longer than its deadline) can itself be an old build.
  void check(0);
}
