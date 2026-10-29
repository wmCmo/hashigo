/**
 * THE ACCENT HELPER'S TWO HALVES AGREE — decision 56.
 *
 * The helper is Python (`tools/accent_helper.py`) and the app that asks it is
 * TypeScript (`app/accent-helper.ts`), so they cannot share a constant: the port
 * and the allowed origins are written once in each. Read both and require them to
 * match, so moving the app (a new Worker name, a new dev port) cannot leave the
 * helper refusing it — which would look exactly like "the helper is not running":
 * no error on screen, just no reading and no 型.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const python = readFileSync("tools/accent_helper.py", "utf8");
const client = readFileSync("app/accent-helper.ts", "utf8");
const wrangler = readFileSync("cloud/app/wrangler.jsonc", "utf8");
const vite = readFileSync("vite.app.config.ts", "utf8");

const helperOrigins = new Set(
  [...(/ORIGINS = frozenset\(\{([\s\S]*?)\}\)/.exec(python)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]),
);

describe("the accent helper and the app", () => {
  it("talk on the same port", () => {
    const helperPort = /^PORT = (\d+)$/m.exec(python)?.[1];
    const clientPort = /HELPER = "http:\/\/127\.0\.0\.1:(\d+)"/.exec(client)?.[1];
    expect(helperPort, "no PORT in tools/accent_helper.py").toBeDefined();
    expect(clientPort).toBe(helperPort);
  });

  it("lets in the live app", () => {
    const allowed = /"ALLOWED_ORIGINS":\s*"([^"]+)"/.exec(wrangler)?.[1] ?? "";
    const origins = allowed.split(",").map((s) => s.trim()).filter((s) => s.startsWith("https://"));
    expect(origins.length, "no https origin in cloud/app/wrangler.jsonc").toBeGreaterThan(0);
    for (const origin of origins) expect(helperOrigins, origin).toContain(origin);
  });

  it("lets in the dev server and the preview, by the ports vite.app.config.ts uses", () => {
    const ports = [...vite.matchAll(/^\s+port: (\d+),/gm)].map((m) => m[1]);
    expect(ports.length).toBeGreaterThanOrEqual(2);
    for (const port of ports) {
      expect(helperOrigins).toContain(`http://127.0.0.1:${port}`);
      expect(helperOrigins).toContain(`http://localhost:${port}`);
    }
  });
});
