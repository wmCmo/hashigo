/**
 * "Add to home screen", as a control in the app rather than a browser menu.
 *
 * Zach's standing rule is that every 操作 available on the desktop is available
 * on mobile and that a shortcut is an accelerator, never the only route. The
 * same reasoning applies here one level out: Samsung Internet WILL offer an
 * install from its own ⋮ menu, but a thing buried three taps into browser chrome
 * is not discoverable, and the browser decides when to surface it.
 *
 * ─── THE CONTRACT, WHICH IS LOOSER THAN IT LOOKS ────────────────────────────
 *
 * `beforeinstallprompt` is Chromium-only (so: Samsung Internet, Chrome, Edge —
 * every browser he actually uses) and it fires only when the browser has already
 * decided the app is installable. That means:
 *
 *   · The button appears when the browser says so, NOT when we feel like it. If
 *     the event never fires, no button is shown, because a button that cannot
 *     work is worse than no button — it is the "dead control" rule from the
 *     audio element, applied to chrome.
 *   · `prompt()` may only be called from a user gesture, and only once per
 *     event. After a choice, the stashed event is spent and must be dropped.
 *   · iOS Safari never fires it at all. There is no API there; the route is the
 *     Share sheet, and this module says nothing rather than lying.
 *
 * ─── THE TRAP THAT MATTERS MORE THAN ANY OF THAT ────────────────────────────
 *
 * **OPFS IS KEYED BY ORIGIN, AND INSTALLING PINS THE ORIGIN.** An installed PWA
 * launches at the `start_url` of the origin it was installed FROM. A quick
 * cloudflared tunnel gets a new random hostname every run, so installing from
 * one produces a home-screen icon pointing at a host that will not exist
 * tomorrow — and, because the origin differs, a second empty OPFS database and
 * another ~300 MB download if it ever did resolve.
 *
 * So the install is only durable from a FIXED hostname: `.tunnel-named`, which
 * for him is `tailscale serve`. `installOrigin()` below reports what the page
 * would be installed from so the UI can say so before he taps.
 */

/** The Chromium-only event. Not in lib.dom yet. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

export interface InstallUi {
  /** Show or hide the control. Called with `false` until the browser offers. */
  setAvailable(available: boolean): void;
  /** Say something to the user — wired to the app's existing status strip. */
  say(message: string, bad?: boolean): void;
}

export interface InstallController {
  /** True once the browser has offered. */
  available(): boolean;
  /** Run the browser's own install flow. Must be called from a user gesture. */
  install(): Promise<void>;
  /** True when the app is already running as an installed app. */
  installed(): boolean;
}

/**
 * Is this page already the installed app?
 *
 * `display-mode: standalone` is the portable answer and covers Android. iOS
 * exposes a non-standard `navigator.standalone` instead, which is why both are
 * consulted.
 */
export function isInstalled(): boolean {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return standalone || iosStandalone;
}

/**
 * The origin an install would be pinned to, and whether that origin survives a
 * restart. A `trycloudflare.com` name is regenerated every run — see the header.
 */
export function installOrigin(): { origin: string; durable: boolean; why: string } {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return {
      origin: window.location.origin,
      durable: false,
      why: "localhost only exists while the dev server is running on this machine",
    };
  }
  if (host.endsWith(".trycloudflare.com")) {
    return {
      origin: window.location.origin,
      durable: false,
      why: "a quick cloudflared tunnel gets a new hostname every run, and OPFS is keyed by origin",
    };
  }
  return { origin: window.location.origin, durable: true, why: "" };
}

export function watchForInstall(ui: InstallUi): InstallController {
  let stashed: BeforeInstallPromptEvent | null = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Chromium shows its own mini-infobar unless this is prevented. We want the
    // in-app control to be the route, so the browser's banner is suppressed.
    event.preventDefault();
    stashed = event as BeforeInstallPromptEvent;
    ui.setAvailable(true);
  });

  window.addEventListener("appinstalled", () => {
    // Spent: the event cannot be reused, and the control has nothing left to do.
    stashed = null;
    ui.setAvailable(false);
    ui.say("installed — open it from your home screen from now on");
  });

  return {
    available: () => stashed !== null,
    installed: isInstalled,
    async install() {
      const event = stashed;
      if (event === null) {
        ui.say("this browser has not offered an install for this page", true);
        return;
      }
      // One shot. Drop it before awaiting, so a double tap cannot call
      // `prompt()` twice on a consumed event.
      stashed = null;
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === "accepted") {
        ui.setAvailable(false);
        return;
      }
      // Dismissed. The event is spent, so the control would no longer work —
      // hide it rather than leave a button that silently does nothing.
      ui.setAvailable(false);
      ui.say("not installed — your browser's menu still has “add page to”");
    },
  };
}

/**
 * Register the service worker.
 *
 * Registered in DEV TOO, deliberately. It is network-first (see `sw.js`), so it
 * cannot serve a stale module graph, and `beforeinstallprompt` will not fire
 * without it — which would mean the install button could only ever be tested in
 * a preview build, and he tests on his phone through `npm run phone`, which is
 * the dev server.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // A failed registration costs installability and offline, and nothing
      // else — the app runs from the network exactly as it did before. Not
      // worth a banner.
    });
  });
}
