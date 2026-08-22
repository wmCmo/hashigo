/**
 * The bundler. Its only current job is the stage-0.5 spike under `spike/`, but
 * the four things it settles are the reason there is a config file at all, and
 * they are what the PWA shell will need verbatim.
 *
 *   1. `@sqlite.org/sqlite-wasm` must NOT be pre-bundled by esbuild in dev.
 *      Its module locates the wasm with `new URL("sqlite3.wasm",
 *      import.meta.url)`, and pre-bundling rewrites that URL to a path inside
 *      `node_modules/.vite/deps/`, where the wasm is not. `optimizeDeps.exclude`
 *      is the whole fix; on `vite build` Rollup emits the wasm as an asset and
 *      rewrites the URL itself.
 *   2. NO COOP/COEP HEADERS ARE SET, deliberately. The `opfs-sahpool` VFS needs
 *      neither SharedArrayBuffer nor cross-origin isolation, and the spike page
 *      asserts `crossOriginIsolated === false` so that a future header cannot
 *      quietly become load-bearing. Hashigo stays plain static files.
 *   3. The worker is an ES module worker (`worker.format = "es"`), because
 *      `src/db/browser.ts` reaches sqlite-wasm through a dynamic `import()`.
 *   4. `SCHEMA_VERSION` is read out of `src/schema/index.ts` HERE and injected,
 *      because that module cannot be imported in a browser (`node:fs` at module
 *      load) and `src/db/browser.ts` therefore has to carry its own copy of the
 *      number. Injecting the real one turns a silent divergence into a failing
 *      page. When `src/schema/index.ts` eventually exports its constants from a
 *      module free of `node:fs`, delete this and import it.
 *
 * The ~69 MB bootstrap database is served by middleware from `build/spike/`
 * rather than out of a `public/` directory: copying it into the build output on
 * every `vite build` costs seconds and gains nothing.
 *
 *   5. THE STAGE-7 MOCKUPS ARE SERVED AT `/mock/`, by the same middleware trick
 *      and for the same reason. They are generated into `build/mock/out/`, which
 *      is gitignored and sits above the Vite root (`spike/`), so without this
 *      they are unreachable from the dev server and reviewing them on a phone
 *      needs a SECOND server and a SECOND tunnel. `allowedHosts` below is per
 *      server, so a second server means a second host to authorise every time
 *      the tunnel name changes. One server, one tunnel.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

/** The bootstrap database, as produced by `npm run spike:bootstrap`. */
const BOOTSTRAP_URL = "/hashigo-bootstrap.db";
const BOOTSTRAP_FILE = resolve(root, "build/spike/hashigo-bootstrap.db");

/** `SCHEMA_VERSION` as `src/schema/index.ts` declares it. Parsed, not imported. */
function schemaVersionFromNode(): number {
  const source = readFileSync(resolve(root, "src/schema/index.ts"), "utf8");
  const match = /export const SCHEMA_VERSION = (\d+)/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(
      "vite.config.ts could not find `export const SCHEMA_VERSION = <n>` in " +
      "src/schema/index.ts. Fix the parse rather than guessing the version.",
    );
  }
  return Number(match[1]);
}

/**
 * Serve the prebuilt database in dev AND in `vite preview`, straight off disk.
 * A missing file answers 404 with the command that makes it, because the
 * alternative is a page that fails inside `fetch` for no visible reason.
 */
function serveBootstrapDatabase(): Plugin {
  const handler = (
    request: { url?: string | undefined; },
    response: {
      statusCode: number;
      setHeader(name: string, value: string | number): void;
      end(body?: string): void;
    },
    next: () => void,
  ): void => {
    const url = (request.url ?? "").split("?")[0];
    if (url !== BOOTSTRAP_URL) {
      next();
      return;
    }
    if (!existsSync(BOOTSTRAP_FILE)) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(
        `${BOOTSTRAP_FILE} is not there. Make it with:\n  npm run spike:bootstrap\n`,
      );
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/vnd.sqlite3");
    response.setHeader("Content-Length", statSync(BOOTSTRAP_FILE).size);
    response.setHeader("Cache-Control", "no-store");
    createReadStream(BOOTSTRAP_FILE).pipe(response as unknown as NodeJS.WritableStream);
  };

  return {
    name: "hashigo-bootstrap-db",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

/**
 * The stage-7 mockups, at `/mock/` — `/mock/` itself is the index.
 *
 * `.html` only, and the resolved path must stay inside the directory: this is
 * reachable from a public tunnel whenever one is up, so it serves exactly the
 * generated pages and nothing else on the disk.
 */
const MOCK_PREFIX = "/mock";
const MOCK_DIR = resolve(root, "build/mock/out");

function serveMockups(): Plugin {
  const handler = (
    request: { url?: string | undefined; },
    response: {
      statusCode: number;
      setHeader(name: string, value: string | number): void;
      end(body?: string): void;
    },
    next: () => void,
  ): void => {
    const url = (request.url ?? "").split("?")[0] ?? "";
    if (url !== MOCK_PREFIX && !url.startsWith(`${MOCK_PREFIX}/`)) {
      next();
      return;
    }
    const rel = url.slice(MOCK_PREFIX.length).replace(/^\//, "") || "index.html";
    const file = resolve(MOCK_DIR, rel);
    // Containment by `relative`, not by string prefix: no separator to escape,
    // and `..` is the only thing that can climb out.
    const rel2 = relative(MOCK_DIR, file);
    const inside = rel2 !== "" && !rel2.startsWith("..") && !isAbsolute(rel2);
    if (!inside || !file.endsWith(".html") || !existsSync(file) || !statSync(file).isFile()) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(
        `No mockup at ${url}. Generate them with:\n` +
          "  npx vite-node scripts/mockup-cards.ts\n" +
          "  npx vite-node scripts/mockup-html.ts\n",
      );
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", statSync(file).size);
    response.setHeader("Cache-Control", "no-store");
    createReadStream(file).pipe(response as unknown as NodeJS.WritableStream);
  };

  return {
    name: "hashigo-mockups",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  root: "spike",
  // The 69 MB database is middleware-served; there is nothing to copy.
  publicDir: false,
  plugins: [serveBootstrapDatabase(), serveMockups()],
  define: {
    __SCHEMA_VERSION_FROM_NODE__: JSON.stringify(schemaVersionFromNode()),
  },
  optimizeDeps: {
    // See (1) in the header. Without this the dev server 404s on sqlite3.wasm.
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
  },
  server: {
    // Tunnel hostnames Zach reviews from on his phone. ADD THE NAME, never
    // `allowedHosts: true` — the check is Vite's DNS-rebinding guard, and a
    // wildcard hands any page he visits a route to this dev server.
    // These are ephemeral: a free ngrok/cloudflared name is reassignable, so an
    // entry here is a convenience for a live tunnel, not a durable grant. Prune
    // dead ones.
    allowedHosts: [
      "acids-viewed-sound-royal.trycloudflare.com",
      "crayfish-shorty-thinning.ngrok-free.dev",
    ],
    port: 5273,
    strictPort: true,
    fs: {
      // spike/ imports src/db/browser.ts, which is above the Vite root — so this
      // has to reach outside `spike/`. It must NOT reach the whole repo.
      //
      // WHY THIS IS A LIST AND NOT `[root]`, MEASURED 2026-08-22. With `[root]`,
      // Vite's `/@fs/<abs path>` route served **the entire corpus** to anyone who
      // could reach the dev server: `build/hashigo.db` came back 200 at
      // 74,465,280 bytes and `build/hashigo.db.blobs.db` at 673,554,432 — every
      // card, all 102,020 reviews and all the audio. That is harmless on
      // localhost and is NOT harmless behind the public tunnel this config
      // authorises in `allowedHosts` above.
      //
      // Vite's own denylist already refused `.env` (403) and `.git/` (403), so no
      // credential was ever exposed. Source, notes and databases were.
      allow: [
        resolve(root, "spike"),
        resolve(root, "src"),
        resolve(root, "node_modules"),
      ],
      // Belt and braces: even inside an allowed directory, never a database or an
      // env file. `deny` is matched on the basename, so it survives a later
      // widening of `allow`.
      deny: [".env", ".env.*", "*.db", "*.db-wal", "*.db-shm", "*.pem", "*.key"],
    },
  },
  preview: {
    // A separate server with a separate check — `spike:preview` would otherwise
    // reject the same tunnel that `spike:dev` accepts.
    allowedHosts: [
      "acids-viewed-sound-royal.trycloudflare.com",
      "crayfish-shorty-thinning.ngrok-free.dev",
    ],
    port: 4273,
    strictPort: true,
  },
  build: {
    outDir: "../build/spike-dist",
    emptyOutDir: true,
    // The spike prints numbers; a readable stack beats 4 KB of saved bandwidth.
    // (minify off is enough for that: sourcemaps are left OFF because Vite emits
    // the client and worker chunks into one assets/ directory and their .map
    // names collide, which prints a warning nobody should have to chase.)
    minify: false,
    sourcemap: false,
    target: "es2022",
  },
});
