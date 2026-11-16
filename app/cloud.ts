/// <reference types="vite/client" />

const BASE = (import.meta.env["VITE_MAILBOX_URL"] as string | undefined)?.replace(/\/+$/, "") ?? "";
const TOKEN = (import.meta.env["VITE_MAILBOX_TOKEN"] as string | undefined) ?? "";

export const IN_CLOUD = BASE !== "" || import.meta.env.MODE === "cloud";

export const SERVER_NAME = IN_CLOUD ? "Cloudflare" : "the laptop";

export function cloudUrl(path: string): string {
  return `${BASE}${path}`;
}

export function cloudHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return TOKEN === "" ? extra : { ...extra, Authorization: `Bearer ${TOKEN}` };
}
