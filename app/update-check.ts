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

export function watchForUpdates(): void {
  if (APP_BUILD === "") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    void check(hiddenAt === 0 ? 0 : Date.now() - hiddenAt);
  });
  void check(0);
}
