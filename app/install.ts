interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

export interface InstallUi {
  setAvailable(available: boolean): void;
  say(message: string, bad?: boolean): void;
}

export interface InstallController {
  available(): boolean;
  install(): Promise<void>;
  installed(): boolean;
}

export function isInstalled(): boolean {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return standalone || iosStandalone;
}

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
    event.preventDefault();
    stashed = event as BeforeInstallPromptEvent;
    ui.setAvailable(true);
  });

  window.addEventListener("appinstalled", () => {
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
      stashed = null;
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === "accepted") {
        ui.setAvailable(false);
        return;
      }
      ui.setAvailable(false);
      ui.say("not installed — your browser's menu still has “add page to”");
    },
  };
}

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    });
  });
}
