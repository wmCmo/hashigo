import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { seedFile } from "../vite.app.config.js";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const sw = read("app/public/sw.js");
const viteConfig = read("vite.app.config.ts");
const manifest = JSON.parse(read("app/public/manifest.webmanifest")) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
  background_color: string;
  theme_color: string;
};

function seededUrls(): string[] {
  const block = /const ASSETS: ReadonlyMap<string, string> = new Map\(\[([\s\S]*?)\]\);/.exec(
    viteConfig,
  );
  expect(block, "the ASSETS map in vite.app.config.ts").not.toBeNull();
  return [...(block?.[1] ?? "").matchAll(/\["(\/[^"]+)"/g)].map((m) => m[1] as string);
}

function neverCached(): string[] {
  const block = /const NEVER_CACHE = new Set\(\[([\s\S]*?)\]\);/.exec(sw);
  expect(block, "the NEVER_CACHE set in app/public/sw.js").not.toBeNull();
  return [...(block?.[1] ?? "").matchAll(/"(\/[^"]+)"/g)].map((m) => m[1] as string);
}

describe("the service worker never caches a database", () => {
  it("refuses every URL the dev/preview server seeds from disk", () => {
    const seeded = seededUrls();
    expect(seeded).toContain("/hashigo-app.db");
    expect(seeded).toContain("/hashigo-app-blobs.db");
    expect(seeded.length).toBeGreaterThanOrEqual(3);

    const never = neverCached();
    for (const url of seeded) {
      expect(
        never,
        `${url} is served by vite.app.config.ts but sw.js would CACHE it — ` +
          `that is a second copy in the same origin quota as OPFS`,
      ).toContain(url);
    }
  });

  it("keeps the seed manifest live, because a stale one hides a stale database", () => {
    expect(neverCached()).toContain("/hashigo-app.json");
  });

  it("passes ranged requests through", () => {
    expect(sw).toMatch(/headers\.has\("range"\)/);
  });

  it("is network-first for the SHELL, so a build can never get stuck behind a stale page", () => {
    const body = sw.slice(sw.indexOf("async function networkFirst"));
    const networkAt = body.indexOf("fetch(request)");
    const cacheAt = body.indexOf("fromCache(request)");
    expect(networkAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeGreaterThan(-1);
    expect(networkAt, "the network attempt must come before the cache fallback").toBeLessThan(
      cacheAt,
    );
  });

  it("is cache-first ONLY for hashed /assets/ — never for index.html", () => {
    const handler = sw.slice(sw.indexOf('addEventListener("fetch"'));
    expect(handler).toMatch(/url\.pathname\.startsWith\("\/assets\/"\)\s*\?\s*assetFirst\(request\)\s*:\s*networkFirst\(request\)/);
  });

  it("gives the network a deadline, then serves what the phone already has", () => {
    expect(sw).toMatch(/const NETWORK_WAIT_MS = \d+;/);
    expect(sw).toMatch(/Promise\.race\(\[network, deadline\]\)/);
  });

  it("never serves a cached /assets/ entry that is HTML — the old fallback poisoned those", () => {
    const body = sw.slice(sw.indexOf("async function assetFirst"));
    expect(body.slice(0, body.indexOf("\n}\n"))).toMatch(/isHtml\(cached\)/);
  });

  it("precaches per-URL rather than atomically, so one 404 cannot void the lot", () => {
    expect(sw).not.toMatch(/cache\.addAll\(/);
    expect(sw).toMatch(/cache\.add\(/);
  });
});

describe("the manifest is the one Samsung Internet needs", () => {
  it("declares what makes a page installable", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBeTruthy();
    expect(manifest.theme_color).toBeTruthy();
  });

  it("carries a 192, a 512 and a maskable, which is the set Chromium asks for", () => {
    const sizes = manifest.icons.map((i) => `${i.sizes}/${i.purpose}`);
    expect(sizes).toContain("192x192/any");
    expect(sizes).toContain("512x512/any");
    expect(sizes).toContain("512x512/maskable");
  });

  it("uses the brief's palette for the splash, not an invented colour", () => {
    expect(manifest.background_color.toUpperCase()).toBe("#F2F2F2");
  });
});

describe("the icons on disk are what the manifest promises", () => {
  function ihdr(path: string): { width: number; height: number; colourType: number } {
    const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      colourType: bytes[25] as number,
    };
  }

  it("every declared icon exists at its declared size", () => {
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split("x").map(Number);
      const real = ihdr(`app/public${icon.src}`);
      expect(real.width, `${icon.src} width`).toBe(w);
      expect(real.height, `${icon.src} height`).toBe(h);
    }
  });

  it("the apple-touch-icon exists, because iOS never reads the manifest", () => {
    expect(ihdr("app/public/icons/apple-touch-icon.png").width).toBe(180);
  });

  it("the icon ground is --card, not --paper", () => {
    const bytes = readFileSync(
      new URL("../app/public/icons/icon-maskable-512.png", import.meta.url),
    );
    const { inflateSync } = require("node:zlib") as typeof import("node:zlib");
    let offset = 8;
    const chunks: Buffer[] = [];
    let width = 0;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === "IHDR") width = data.readUInt32BE(0);
      if (type === "IDAT") chunks.push(data);
      offset += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(chunks));
    const stride = width * 4 + 1;
    const at = 6 * stride + 1 + 6 * 4;
    const hex =
      "#" +
      [raw[at], raw[at + 1], raw[at + 2]]
        .map((v) => (v as number).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
    expect(hex, "the icon ground drifted off --card").toBe("#FCFCFC");
  });

  it("the maskable icon is FULL BLEED — a transparent corner is a visible notch", () => {
    const bytes = readFileSync(
      new URL("../app/public/icons/icon-maskable-512.png", import.meta.url),
    );
    expect(bytes[25]).toBe(6);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe("the service worker never caches sync state", () => {
  it("passes the mailbox straight through, like the databases", () => {
    expect(sw, "no mailbox guard in the fetch handler").toMatch(/isMailbox\(url\.pathname\)/);
    const guard = /function isMailbox\([^)]*\) \{([\s\S]*?)\n\}/.exec(sw)?.[1] ?? "";
    expect(guard, "isMailbox is gone").not.toBe("");
    expect(guard).toMatch(/startsWith\("\/sync\/"\)/);
  });

  it("bails BEFORE respondWith, so nothing is stored and nothing is served back", () => {
    const handler = /addEventListener\("fetch"[\s\S]*$/.exec(sw)?.[0] ?? "";
    const guardAt = handler.indexOf("isMailbox(url.pathname)");
    const respondAt = handler.indexOf("event.respondWith");
    expect(guardAt, "the mailbox guard is not in the fetch handler").toBeGreaterThan(-1);
    expect(respondAt).toBeGreaterThan(-1);
    expect(guardAt, "the mailbox guard runs after respondWith").toBeLessThan(respondAt);
  });
});

describe("the seed-file route", () => {
  it("serves every bootstrap file, including one added after startup", () => {
    for (const url of [
      "/hashigo-app.db",
      "/hashigo-app-gen.db",
      "/hashigo-app-blobs.db",
      "/hashigo-app.json",
      "/hashigo-app-future-thing.db",
    ]) {
      expect(seedFile(url), url).toBeTypeOf("string");
    }
  });

  it("REFUSES anything that is not one plain name in that one directory", () => {
    for (const url of [
      "/hashigo.db",
      "/.env",
      "/../hashigo.db",
      "/hashigo-app/../../hashigo.db",
      "/hashigo-app.db/../../../.env",
      "/hashigo-app..%2F..%2Fhashigo.db",
      "/hashigo-app-gen.db.bak",
      "/hashigo-app-gen.txt",
    ]) {
      expect(seedFile(url), url).toBeUndefined();
    }
  });

  it("never resolves outside the asset directory, whatever the name", () => {
    const dir = resolve(process.cwd(), "build/app");
    for (const name of ["hashigo-app.db", "hashigo-app-gen.db", "hashigo-app-x.json"]) {
      expect(seedFile(`/${name}`)?.startsWith(dir)).toBe(true);
    }
  });
});

describe("a new build downloads only the files it has not seen", () => {
  type Handler = (event: { waitUntil(p: Promise<unknown>): void }) => void;

  async function install(precache: string[], held: Record<string, string>) {
    const stores = new Map<string, Map<string, Response>>();
    const old = new Map<string, Response>();
    for (const [url, type] of Object.entries(held)) {
      old.set(url, new Response("bytes", { headers: { "content-type": type } }));
    }
    stores.set("hashigo-shell-old", old);
    const fetched: string[] = [];
    const caches = {
      async open(name: string) {
        const store = stores.get(name) ?? new Map<string, Response>();
        stores.set(name, store);
        return {
          async put(url: string, response: Response) { store.set(url, response); },
          async add(request: Request) {
            const path = new URL(request.url).pathname;
            fetched.push(path);
            store.set(path, new Response("fresh"));
          },
        };
      },
      async match(url: string) {
        for (const store of stores.values()) if (store.has(url)) return store.get(url);
        return undefined;
      },
    };
    const handlers: Record<string, Handler> = {};
    const self = {
      __HASHIGO_VERSION__: "hashigo-shell-new",
      __HASHIGO_PRECACHE__: precache,
      location: { origin: "https://hashigo.test" },
      addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; },
      skipWaiting: () => undefined,
      clients: { claim: () => undefined },
    };
    const RequestAt = class extends Request {
      constructor(url: string, init?: RequestInit) { super(new URL(url, self.location.origin), init); }
    };
    new Function("self", "caches", "Request", sw)(self, caches, RequestAt);
    let done: Promise<unknown> = Promise.resolve();
    handlers.install?.({ waitUntil: (p) => { done = p; } });
    await done;
    return { fetched, fresh: stores.get("hashigo-shell-new") ?? new Map() };
  }

  it("copies an unchanged hashed asset from the old cache instead of fetching it", async () => {
    const font = "/assets/notosansjp-400-DEBxyHjG.woff2";
    const wasm = "/assets/sqlite3-BVKGSWc-.wasm";
    const css = "/assets/index-NEW.css";
    const { fetched, fresh } = await install(["/", font, wasm, css], {
      [font]: "font/woff2",
      [wasm]: "application/wasm",
    });
    expect(fetched.sort()).toEqual(["/", css].sort());
    expect([...fresh.keys()].sort()).toEqual(["/", css, font, wasm].sort());
  });

  it("still re-fetches the unhashed shell, which must be the current one", async () => {
    const { fetched } = await install(["/", "/icons/icon-192.png"], {
      "/": "text/html",
      "/icons/icon-192.png": "image/png",
    });
    expect(fetched.sort()).toEqual(["/", "/icons/icon-192.png"]);
  });

  it("never copies a cached HTML page posing as an asset", async () => {
    const js = "/assets/index-C2oUWW91.js";
    const { fetched } = await install([js], { [js]: "text/html" });
    expect(fetched).toEqual([js]);
  });

  it("fetches everything on a device's very first install", async () => {
    const list = ["/", "/assets/a-1.js", "/assets/b-2.woff2"];
    const { fetched } = await install(list, {});
    expect(fetched.sort()).toEqual([...list].sort());
  });
});
