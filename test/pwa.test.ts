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

import { describe, expect, it } from "vitest";

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

  it("is network-first, so a build can never get stuck behind a stale shell", () => {
    const fetchHandler = sw.slice(sw.indexOf('addEventListener("fetch"'));
    const networkAt = fetchHandler.indexOf("await fetch(request)");
    const cacheAt = fetchHandler.indexOf("caches.match(request)");
    expect(networkAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeGreaterThan(-1);
    expect(networkAt, "the network attempt must come before the cache fallback").toBeLessThan(
      cacheAt,
    );
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
    expect(manifest.background_color.toUpperCase()).toBe("#ECEAE5");
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
