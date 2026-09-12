/**
 * The APP's bundler config — `app/`, the shipping shell.
 *
 * A second config rather than a second entry in `vite.config.ts`, and the reason
 * is `root`. That file has `root: "spike"`, so every URL the spike documents
 * (`/persist/`, `/blobstore/`, `/mock/`) is relative to it. Moving the root up to
 * the repo would change all of them and widen what `server.fs.allow` means. Two
 * roots, two ports, one shared set of hard-won settings — imported below rather
 * than copied, because a divergence between them is the kind of thing that only
 * shows up on the phone.
 *
 *   npm run app:dev -- --host ::           phone / tunnel: answers localhost too
 *   npm run app:dev -- --host 127.0.0.1    local only, nothing off this machine
 *
 * THE BIND ADDRESS IS A TRAP IN BOTH DIRECTIONS and it has cost a round trip:
 * binding one address family REFUSES the other, and on Windows `localhost`
 * resolves to `::1` FIRST. `--host 127.0.0.1` is fine for a local browser, but a
 * tunnel pointed at `localhost:5274` gets ECONNREFUSED on ::1 — PowerShell falls
 * back to IPv4 and succeeds, **ngrok does not and returns 502**.
 *
 * The two databases are served by MIDDLEWARE from `build/app/` rather than out of
 * a `public/` directory: they are ~70 MB and ~32 MiB, and copying them into the
 * build output on every `vite build` costs seconds and gains nothing.
 */
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

/** Tunnel hostnames Zach reviews from. NEVER `allowedHosts: true` — that is
 *  Vite's DNS-rebinding guard, and a wildcard hands any page he visits a route to
 *  this server, which serves a 72 MB database. These names are ephemeral (a free
 *  ngrok/cloudflared name is reassignable), so an entry is a convenience for a live
 *  tunnel, not a durable grant. Prune dead ones. */
const ALLOWED_HOSTS = [
  "acids-viewed-sound-royal.trycloudflare.com",
  "crayfish-shorty-thinning.ngrok-free.dev",
];

/**
 * `.tunnel-named` and `.tunnel-host` — gitignored, appended to the list above.
 *
 * `.tunnel-named` is the fixed hostname of a named tunnel, written once by hand.
 * `.tunnel-host` is whatever random name the last quick tunnel was given. Two files
 * because they are two different things; `scripts/phone.mjs` says what went wrong
 * when they were one.
 *
 * `npm run phone` writes it. A QUICK tunnel gets a new random name every run, so
 * without this every session means hand-editing this committed file and the diff
 * is noise nobody reads — which is how `allowedHosts: true` starts looking
 * reasonable. It stays an explicit list; only the source of one entry moved.
 *
 * Read with a try/catch rather than an `existsSync` guard: this file is parsed on
 * every Vite start, and a config that throws because an optional local file is
 * mid-write is a failure with no useful message.
 */
function localTunnelHosts(): string[] {
  const hosts: string[] = [];
  for (const name of [".tunnel-named", ".tunnel-host"]) {
    try {
      hosts.push(
        ...readFileSync(resolve(root, name), "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("#")),
      );
    } catch {
      /* optional */
    }
  }
  return hosts;
}

const HOSTS = [...ALLOWED_HOSTS, ...localTunnelHosts()];

/** `--out` of `scripts/app-bootstrap.ts`. */
const ASSET_DIR = resolve(root, "build/app");

/** URL → file. Exactly these two; nothing else on disk is reachable this way. */
const ASSETS: ReadonlyMap<string, string> = new Map([
  ["/hashigo-app.db", resolve(ASSET_DIR, "hashigo-app.db")],
  ["/hashigo-app-blobs.db", resolve(ASSET_DIR, "hashigo-app-blobs.db")],
  // The seed manifest: a few hundred bytes naming what the two files above hold,
  // so a browser that already has a database can tell whether it is the CURRENT
  // one without downloading 73 MB to find out. See `app/db.worker.ts`.
  ["/hashigo-app.json", resolve(ASSET_DIR, "hashigo-app.json")],
]);

/** `SCHEMA_VERSION` as `src/schema/index.ts` declares it. Parsed, not imported —
 *  that module reads `node:fs` at load time, so a browser cannot have it, and
 *  `src/db/browser.ts` therefore carries its own copy of the number. Injecting
 *  the real one turns a silent divergence into a failing page. */
function schemaVersionFromNode(): number {
  const source = readFileSync(resolve(root, "src/schema/index.ts"), "utf8");
  const match = /export const SCHEMA_VERSION = (\d+)/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(
      "vite.app.config.ts could not find `export const SCHEMA_VERSION = <n>` in " +
        "src/schema/index.ts. Fix the parse rather than guessing the version.",
    );
  }
  return Number(match[1]);
}

/**
 * Serve the two bootstrap databases straight off disk, in dev and in preview.
 *
 * A missing file answers 404 **with the command that makes it**, because the
 * alternative is `fetch` failing inside a worker for no visible reason. And the
 * content type matters: a 200 carrying an HTML error body looks exactly like a
 * database to `importDb`, which then reports an unhelpful malformed-database — so
 * `app/db.worker.ts` checks the SQLite magic on arrival as well.
 */
function serveAppDatabases(): Plugin {
  const handler = (
    request: { url?: string | undefined },
    response: {
      statusCode: number;
      setHeader(name: string, value: string | number): void;
      end(body?: string): void;
    },
    next: () => void,
  ): void => {
    const url = (request.url ?? "").split("?")[0] ?? "";
    const file = ASSETS.get(url);
    if (file === undefined) {
      next();
      return;
    }
    if (!existsSync(file)) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(
        `${file} is not there. Make both bootstrap files with:\n` +
          `  npx vite-node scripts/app-bootstrap.ts\n`,
      );
      return;
    }
    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      url.endsWith(".json") ? "application/json; charset=utf-8" : "application/vnd.sqlite3",
    );
    response.setHeader("Content-Length", statSync(file).size);
    response.setHeader("Cache-Control", "no-store");
    createReadStream(file).pipe(response as unknown as NodeJS.WritableStream);
  };

  return {
    name: "hashigo-app-databases",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

/**
 * Write the service worker's precache list, at build time, from what was
 * actually emitted.
 *
 * THIS IS NOT A CONVENIENCE. `app/public/sw.js` explains the failure it fixes:
 * runtime caching only ever stores what crossed the network, so an asset served
 * from the browser's own cache is invisible to the worker and is simply missing
 * when the network goes away. Measured — the shell and the CSS cached, the
 * wordmark font did not.
 *
 * The list cannot be authored by hand because Vite hashes every asset name, so
 * it is PREPENDED to the emitted `sw.js` rather than substituted into it: a
 * marker-replacement silently does nothing if someone edits the marker, whereas
 * a missing prepend fails loudly the first time a build is taken offline.
 *
 * `VERSION` carries a hash of the list, so a new build is a new cache and the
 * `activate` handler drops the old one. Without that the worker would keep
 * serving the previous release's assets for as long as they matched.
 */
function serviceWorkerPrecache(): Plugin {
  return {
    name: "hashigo-sw-precache",
    apply: "build",
    writeBundle(options, bundle) {
      const dir = options.dir ?? resolve(root, "build/app-dist");
      const swFile = resolve(dir, "sw.js");
      if (!existsSync(swFile)) {
        throw new Error(
          "sw.js was not emitted into the build. It lives in app/public/ and is " +
            "copied verbatim; if publicDir moved, this plugin must move with it.",
        );
      }

      // Everything Vite emitted, plus the unhashed files the manifest names by
      // absolute path. The databases are NOT here and must never be — they are
      // ~297 MB served by middleware straight into OPFS.
      const emitted = Object.keys(bundle).map((name) => `/${name}`);
      const urls = [
        "/",
        ...emitted.filter((u) => u !== "/index.html"),
        "/manifest.webmanifest",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        "/icons/icon-maskable-512.png",
        "/icons/apple-touch-icon.png",
      ];
      const unique = [...new Set(urls)].sort();

      let hash = 5381;
      for (const url of unique) for (let i = 0; i < url.length; i += 1) {
        hash = ((hash * 33) ^ url.charCodeAt(i)) >>> 0;
      }

      const header =
        `// GENERATED by vite.app.config.ts — see serviceWorkerPrecache().\n` +
        `self.__HASHIGO_VERSION__ = ${JSON.stringify(`hashigo-shell-${hash.toString(36)}`)};\n` +
        `self.__HASHIGO_PRECACHE__ = ${JSON.stringify(unique)};\n\n`;

      writeFileSync(swFile, header + readFileSync(swFile, "utf8"));
      this.info?.(`sw.js precaches ${unique.length} URLs (cache hashigo-shell-${hash.toString(36)})`);
    },
  };
}

export default defineConfig({
  root: "app",
  /**
   * `app/public/` — the PWA's three unhashable files.
   *
   * This was `false`, and the comment above explains why the two DATABASES are
   * served by middleware instead of from here: they are ~73 MB and ~224 MB and
   * copying them into the build output on every `vite build` costs seconds and
   * gains nothing. That reasoning is untouched — they are still middleware.
   *
   * What lives here is the set of files whose URL is part of a CONTRACT and so
   * cannot be hashed or rewritten:
   *
   *   sw.js                  must be served from the scope root at a stable
   *                          path, or the service worker cannot claim `/`
   *   manifest.webmanifest   Vite would happily hash this, but the icon paths
   *                          INSIDE it are plain JSON that no bundler rewrites,
   *                          so the whole set has to be copied verbatim
   *   icons/*.png            referenced by that JSON, by absolute path
   */
  publicDir: "public",
  plugins: [serveAppDatabases(), serviceWorkerPrecache()],
  define: {
    __SCHEMA_VERSION_FROM_NODE__: JSON.stringify(schemaVersionFromNode()),
  },
  optimizeDeps: {
    // `@sqlite.org/sqlite-wasm` locates its wasm with
    // `new URL("sqlite3.wasm", import.meta.url)`, and esbuild pre-bundling
    // rewrites that URL into `node_modules/.vite/deps/`, where the wasm is not.
    // Excluding it is the whole fix; `vite build` emits the wasm as an asset and
    // Rollup rewrites the URL itself.
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    // `src/db/browser.ts` reaches sqlite-wasm through a dynamic `import()`.
    format: "es",
  },
  server: {
    allowedHosts: HOSTS,
    // 5274, one above the spike's 5273, so both can run at once.
    port: 5274,
    strictPort: true,
    fs: {
      // `app/` imports `src/`, which is above the Vite root, so this has to reach
      // outside `app/`. It must NOT reach the whole repo: with `[root]`, Vite's
      // `/@fs/<abs path>` route served the ENTIRE corpus — measured on the spike
      // config 2026-08-22, `build/hashigo.db` came back 200 at 74,465,280 bytes
      // and the blob store at 673,554,432. Harmless on localhost; not harmless
      // behind the public tunnel `allowedHosts` above authorises.
      allow: [resolve(root, "app"), resolve(root, "src"), resolve(root, "node_modules")],
      // Belt and braces: matched on the BASENAME, so it survives a later widening
      // of `allow`. The two bootstrap databases are reachable only through the
      // middleware above, which serves exactly two URLs.
      deny: [".env", ".env.*", "*.db", "*.db-wal", "*.db-shm", "*.pem", "*.key"],
    },
  },
  preview: {
    // A separate server with a separate check — otherwise `app:preview` rejects
    // the same tunnel `app:dev` accepts.
    allowedHosts: HOSTS,
    port: 4274,
    strictPort: true,
  },
  build: {
    outDir: "../build/app-dist",
    emptyOutDir: true,
    // A readable stack beats a few KB. Sourcemaps stay OFF: Vite emits the client
    // and worker chunks into one assets/ directory and their .map names collide,
    // which prints a warning nobody should have to chase.
    minify: false,
    sourcemap: false,
    target: "es2022",
  },
});
