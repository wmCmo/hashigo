/// <reference types="vite/client" />
/**
 * WHERE THE CLOUD WORKER IS, AND ITS KEY — one place for every caller.
 *
 * Set at BUILD time from `.env` (`VITE_MAILBOX_URL`, `VITE_MAILBOX_TOKEN`), so the
 * phone needs no setting and no pasted secret. Empty means "the laptop": the same
 * origin's `/sync/` and `/generate/`, exactly as before 2026-09-26 — which is what
 * every test and every build without those two lines still gets.
 *
 * Why the cloud exists at all: his apartment wifi drops every tunnel packet over
 * ~1,208 bytes, so nothing that goes through Tailscale works from home.
 * `cloud/mailbox/` answers sync and generation from `*.workers.dev` over plain
 * HTTPS, and needs a bearer token because the tailnet is no longer the lock.
 *
 * The token is in the bundle, and the bundle is only ever served over the
 * tailnet. It opens one mailbox of study payloads and a generate route whose
 * provider keys stay on the Worker — decision 18 is about THOSE keys, and they
 * never leave Cloudflare.
 */

const BASE = (import.meta.env["VITE_MAILBOX_URL"] as string | undefined)?.replace(/\/+$/, "") ?? "";
const TOKEN = (import.meta.env["VITE_MAILBOX_TOKEN"] as string | undefined) ?? "";

/** True when sync and generation go to Cloudflare rather than the laptop. */
// `--mode cloud` too (2026-09-27): that build is served BY Cloudflare and talks to
// its own origin, so its BASE is "" and the URL alone called it "the laptop" —
// "already on the laptop", and a failed sync told him to open Tailscale.
export const IN_CLOUD = BASE !== "" || import.meta.env.MODE === "cloud";

/** The name to put in a message: "the laptop" or "Cloudflare". */
export const SERVER_NAME = IN_CLOUD ? "Cloudflare" : "the laptop";

export function cloudUrl(path: string): string {
  return `${BASE}${path}`;
}

export function cloudHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return TOKEN === "" ? extra : { ...extra, Authorization: `Bearer ${TOKEN}` };
}
