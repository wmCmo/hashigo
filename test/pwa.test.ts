/**
 * The install/offline contract, pinned.
 *
 * The expensive failure here is silent and it is not "the app won't install".
 * It is the SERVICE WORKER CACHING A DATABASE. `/hashigo-app-blobs.db` is
 * ~224 MB; a Cache Storage copy sits in the SAME origin quota as the OPFS copy,
 * so the app would hold ~600 MB to use ~300 MB. On a phone that is the
 * difference between fitting and being evicted — and decision 17 exists because
 * eviction has already happened to him once.
 *
 * Nothing about that shows up in a passing build or a working install. It shows
 * up weeks later as a database that went missing. So the rule is tested, and it
 * is tested against the SERVER's own list rather than a copy: if someone adds a
 * fourth seeded file to `vite.app.config.ts`, this fails until `sw.js` knows.
 */
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

/** The URLs `serveAppDatabases()` answers — parsed from the config, not retyped. */
function seededUrls(): string[] {
  const block = /const ASSETS: ReadonlyMap<string, string> = new Map\(\[([\s\S]*?)\]\);/.exec(
    viteConfig,
  );
  expect(block, "the ASSETS map in vite.app.config.ts").not.toBeNull();
  return [...(block?.[1] ?? "").matchAll(/\["(\/[^"]+)"/g)].map((m) => m[1] as string);
}

/** The URLs `sw.js` refuses to touch. */
function neverCached(): string[] {
  const block = /const NEVER_CACHE = new Set\(\[([\s\S]*?)\]\);/.exec(sw);
  expect(block, "the NEVER_CACHE set in app/public/sw.js").not.toBeNull();
  return [...(block?.[1] ?? "").matchAll(/"(\/[^"]+)"/g)].map((m) => m[1] as string);
}

describe("the service worker never caches a database", () => {
  it("refuses every URL the dev/preview server seeds from disk", () => {
    const seeded = seededUrls();
    // Sanity: the parse found something real.
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
    // `db.worker.ts` compares the manifest's review count against what OPFS
    // holds to decide whether to re-fetch. Cached, it would always agree.
    expect(neverCached()).toContain("/hashigo-app.json");
  });

  it("passes ranged requests through", () => {
    // A range request is a media seek; answering it from Cache Storage returns
    // the whole body and breaks playback.
    expect(sw).toMatch(/headers\.has\("range"\)/);
  });

  it("is network-first for the SHELL, so a build can never get stuck behind a stale page", () => {
    // Since 2026-09-26 the network wait has a deadline (a wifi that swallows
    // packets froze the app on a bare page), but the shell still ASKS the
    // network before it reads the cache.
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
    // background_color is what the OS paints before the first frame. A wrong one
    // is a flash of the wrong product on every cold launch.
    expect(manifest.background_color.toUpperCase()).toBe("#F2F2F2");
  });
});

describe("the icons on disk are what the manifest promises", () => {
  /** width, height and colour type out of a PNG's IHDR. */
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
    // Zach, 2026-09-12, looking at the installed icon: it read GREY on his home
    // screen. Measured rather than adjudicated by taste — --paper #ECEAE5 is
    // luminance 0.82 against white's 1.00, so 18% darker. Inside the app that
    // reads as paper because the whole screen is that colour and --card sits
    // brighter on it; paper is paper by RELATIONSHIP. An icon has no
    // relationship. --card #FBFAF7 is 0.96, and is also the honest token: an
    // app tile is a raised surface, which is what --card means here.
    const bytes = readFileSync(
      new URL("../app/public/icons/icon-maskable-512.png", import.meta.url),
    );
    // First pixel of the first row, past the IHDR/IDAT plumbing: decode instead.
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
    // Colour type 6 carries alpha; the maskable one must still be opaque
    // everywhere, which `tools/icons.mjs` does by not applying the badge.
    expect(bytes[25]).toBe(6);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

/**
 * ZACH, ON HIS PHONE, 2026-09-13: `sync failed — Unexpected token '<', "<!doctype "`.
 *
 * The cause was a stale server (see `app/sync-client.ts`), but the sweep that
 * followed found a second, quieter fault in here: this worker was CACHING the
 * mailbox. `/sync/` and every peer payload are served `Cache-Control: no-store`
 * and the store rule — `response.ok && response.type === "basic"` — is true for
 * both, so they went into Cache Storage like any shell asset.
 *
 * Network-first hides it while he is online. Offline it does not: `syncNow`
 * would read a cached peers list, fetch cached payloads, and MERGE A SNAPSHOT of
 * his other device from whenever it was last seen. The push after it is a PUT,
 * which this worker ignores, so the run fails at the end — after the merge has
 * already happened. A partial merge reported as a failure is worse than a clean
 * refusal, and sync simply should not work offline.
 */
describe("the service worker never caches sync state", () => {
  it("passes the mailbox straight through, like the databases", () => {
    // A prefix, not a Set entry: `/sync/` carries a device id per peer, so there
    // is no fixed list of paths to name.
    expect(sw, "no mailbox guard in the fetch handler").toMatch(/isMailbox\(url\.pathname\)/);
    const guard = /function isMailbox\([^)]*\) \{([\s\S]*?)\n\}/.exec(sw)?.[1] ?? "";
    expect(guard, "isMailbox is gone").not.toBe("");
    expect(guard).toMatch(/startsWith\("\/sync\/"\)/);
  });

  it("bails BEFORE respondWith, so nothing is stored and nothing is served back", () => {
    // The guard has to sit with the other pass-throughs, above `event.respondWith`.
    // Below it, the worker would still answer from cache when the network fails,
    // which is the half that merges stale state.
    const handler = /addEventListener\("fetch"[\s\S]*$/.exec(sw)?.[0] ?? "";
    const guardAt = handler.indexOf("isMailbox(url.pathname)");
    const respondAt = handler.indexOf("event.respondWith");
    expect(guardAt, "the mailbox guard is not in the fetch handler").toBeGreaterThan(-1);
    expect(respondAt).toBeGreaterThan(-1);
    expect(guardAt, "the mailbox guard runs after respondWith").toBeLessThan(respondAt);
  });
});

/**
 * ─── THE SEED ROUTE, AND WHY IT IS PATTERN-MATCHED RATHER THAN ENUMERATED ───
 *
 * `ASSETS` is built when the config LOADS. The bundle is read per request — so a
 * running server serves a page asking for a seed file the process has never heard
 * of, and answers it with the SPA fallback: `index.html`, 200. Zach, 2026-09-16,
 * on his phone, after a rebuild added a third file:
 *
 *     /hashigo-app-gen.db returned 19114 bytes that are not a SQLite file
 *     (header "<!doctype html>")
 *
 * `seedFile` removes the restart. It also widens what a URL can reach, which is
 * the half that needs pinning — `server.fs.allow` is narrowed in this repo
 * because `[root]` once exposed `build/hashigo.db` and the 617.9 MiB blob store
 * to anyone who could reach the port.
 */
describe("the seed-file route", () => {
  it("serves every bootstrap file, including one added after startup", () => {
    for (const url of [
      "/hashigo-app.db",
      "/hashigo-app-gen.db",
      "/hashigo-app-blobs.db",
      "/hashigo-app.json",
      // The point of the pattern: the next seed file needs no restart.
      "/hashigo-app-future-thing.db",
    ]) {
      expect(seedFile(url), url).toBeTypeOf("string");
    }
  });

  it("REFUSES anything that is not one plain name in that one directory", () => {
    for (const url of [
      "/hashigo.db", // the real card database, 74 MB, one directory up
      "/.env", // the API keys
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
    // The pattern already forbids a separator; this asserts the second guard
    // rather than trusting the first, because the cost of being wrong here is
    // handing out his study history over a tunnel.
    const dir = resolve(process.cwd(), "build/app");
    for (const name of ["hashigo-app.db", "hashigo-app-gen.db", "hashigo-app-x.json"]) {
      expect(seedFile(`/${name}`)?.startsWith(dir)).toBe(true);
    }
  });
});
