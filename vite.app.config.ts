import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

import { generateOnDemand } from "./vite.generate.js";

const root = dirname(fileURLToPath(import.meta.url));

const ALLOWED_HOSTS = [
  "acids-viewed-sound-royal.trycloudflare.com",
  "crayfish-shorty-thinning.ngrok-free.dev",
];

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
    }
  }
  return hosts;
}

const HOSTS = [...ALLOWED_HOSTS, ...localTunnelHosts()];

const ASSET_DIR = resolve(root, "build/app");

const ASSETS: ReadonlyMap<string, string> = new Map([
  ["/hashigo-app.db", resolve(ASSET_DIR, "hashigo-app.db")],
  ["/hashigo-app-gen.db", resolve(ASSET_DIR, "hashigo-app-gen.db")],
  ["/hashigo-app-fields.db", resolve(ASSET_DIR, "hashigo-app-fields.db")],
  ["/hashigo-app-blobs.db", resolve(ASSET_DIR, "hashigo-app-blobs.db")],
  ["/hashigo-app.json", resolve(ASSET_DIR, "hashigo-app.json")],
]);

export function seedFile(url: string): string | undefined {
  const name = url.startsWith("/") ? url.slice(1) : url;
  if (!/^hashigo-app[A-Za-z0-9-]*\.(db|json)$/.test(name)) return undefined;
  const file = resolve(ASSET_DIR, name);
  return file.startsWith(ASSET_DIR) ? file : undefined;
}

function requestLog(): Plugin {
  const file = resolve(root, "build/phone-requests.log");
  return {
    name: "hashigo-request-log",
    configurePreviewServer(server) {
      server.middlewares.use(((
        request: { url?: string; method?: string; headers: Record<string, string | undefined> },
        response: { statusCode: number; getHeader(name: string): unknown; on(event: string, fn: () => void): void },
        next: () => void,
      ) => {
        const path = (request.url ?? "").split("?")[0];
        const ua = request.headers["user-agent"] ?? "";
        const who = /Android/.test(ua) ? "android" : /Windows/.test(ua) ? "windows" : "other";
        const via = request.headers["x-forwarded-for"] ?? "-";
        const write = (line: string): void => {
          try {
            appendFileSync(file, `${line}\n`);
          } catch {
          }
        };
        const started = Date.now();
        write([new Date(started).toISOString(), who, "start", request.method, path, via].join(" "));
        response.on("finish", () => {
          write(
            [
              new Date().toISOString(),
              who,
              request.method,
              path,
              response.statusCode,
              String(response.getHeader("content-type") ?? "-"),
              request.headers["sec-fetch-dest"] ?? "-",
              request.headers["service-worker"] === "script" ? "sw-script" : "",
              via,
              `${Date.now() - started}ms`,
            ].join(" "),
          );
        });
        next();
      }) as never);
    },
  };
}

function ping(): Plugin {
  const handler = (
    request: { url?: string | undefined; headers: Record<string, string | undefined> },
    response: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void },
    next: () => void,
  ): void => {
    if ((request.url ?? "").split("?")[0] !== "/ping") {
      next();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(
      `hashigo laptop answered at ${new Date().toISOString()}\n` +
        `you asked for host: ${request.headers["host"] ?? "?"}\n`,
    );
  };
  return {
    name: "hashigo-ping",
    configureServer(server) {
      server.middlewares.use(handler as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler as never);
    },
  };
}

function missingAssetsAre404(): Plugin {
  const assets = resolve(root, "build/app-dist/assets");
  const handler = (
    request: { url?: string | undefined },
    response: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void },
    next: () => void,
  ): void => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (!path.startsWith("/assets/")) {
      next();
      return;
    }
    const name = path.slice("/assets/".length);
    if (name === "" || name.includes("/") || name.includes("\\") || name.includes("..")) {
      next();
      return;
    }
    if (existsSync(resolve(assets, decodeURIComponent(name)))) {
      next();
      return;
    }
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(`no such build asset: ${name} — this page is from an older build; reload`);
  };
  return {
    name: "hashigo-missing-assets-are-404",
    configurePreviewServer(server) {
      server.middlewares.use(handler as never);
    },
  };
}

const KEEP_DAYS = 14;

function keepRecentAssets(): Plugin {
  let outDir = resolve(root, "build/app-dist");
  return {
    name: "hashigo-keep-recent-assets",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const assets = resolve(outDir, "assets");
      if (!existsSync(assets)) return;
      const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
      for (const name of readdirSync(assets)) {
        const file = resolve(assets, name);
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      }
    },
  };
}

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
    const file = ASSETS.get(url) ?? seedFile(url);
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
      writeFileSync(resolve(dir, "version.json"), `${JSON.stringify(BUILD_INFO)}\n`);
      this.info?.(`sw.js precaches ${unique.length} URLs (cache hashigo-shell-${hash.toString(36)})`);
    },
  };
}

const SYNC_DIR = resolve(root, "build/sync");
const SYNC_ID = /^[a-z0-9][a-z0-9-]{5,63}$/;
const SYNC_MAX_BYTES = 32 * 1024 * 1024;

function syncMailbox(): Plugin {
  const handler = (
    request: { url?: string | undefined; method?: string | undefined; on: Function },
    response: {
      statusCode: number;
      setHeader(name: string, value: string | number): void;
      end(body?: string): void;
    },
    next: () => void,
  ): void => {
    const url = request.url ?? "";
    if (!url.startsWith("/sync/")) {
      next();
      return;
    }

    const send = (status: number, body: unknown): void => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(body));
    };

    const rest = url.slice("/sync/".length).split("?")[0] ?? "";
    const method = (request.method ?? "GET").toUpperCase();

    if (rest === "" && method === "GET") {
      mkdirSync(SYNC_DIR, { recursive: true });
      const peers = readdirSync(SYNC_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const stat = statSync(resolve(SYNC_DIR, f));
          return {
            deviceId: f.slice(0, -".json".length),
            bytes: stat.size,
            updatedAt: stat.mtime.toISOString(),
          };
        });
      send(200, { peers });
      return;
    }

    if (!SYNC_ID.test(rest)) {
      send(400, { error: "device id must match ^[a-z0-9][a-z0-9-]{5,63}$" });
      return;
    }
    const file = resolve(SYNC_DIR, `${rest}.json`);

    if (method === "GET") {
      if (!existsSync(file)) {
        send(404, { error: `no payload from ${rest}` });
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(readFileSync(file, "utf8"));
      return;
    }

    if (method === "PUT" || method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      request.on("data", (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > SYNC_MAX_BYTES) {
          aborted = true;
          send(413, { error: `payload over ${SYNC_MAX_BYTES} bytes` });
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (aborted) return;
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          JSON.parse(body);
        } catch {
          send(400, { error: "body is not JSON" });
          return;
        }
        mkdirSync(SYNC_DIR, { recursive: true });
        writeFileSync(file, body, "utf8");
        send(200, { deviceId: rest, bytes: Buffer.byteLength(body) });
      });
      return;
    }

    send(405, { error: `${method} not allowed on /sync/` });
  };

  return {
    name: "hashigo-sync-mailbox",
    configureServer(server) {
      server.middlewares.use(handler as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler as never);
    },
  };
}

const CLOUD = process.argv.includes("--mode") && process.argv[process.argv.indexOf("--mode") + 1] === "cloud";

function buildInfo(): { version: string; build: string } {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let build = "";
  try {
    build = git("rev-parse", "--short", "HEAD");
    if (git("status", "--porcelain", "--untracked-files=no") !== "") build += "-dirty";
  } catch {
    build = "";
  }
  return { version: pkg.version, build };
}
const BUILD_INFO = buildInfo();

export default defineConfig({
  root: "app",
  envDir: root,
  publicDir: "public",
  plugins: [
    requestLog(),
    ping(),
    missingAssetsAre404(),
    keepRecentAssets(),
    serveAppDatabases(),
    syncMailbox(),
    generateOnDemand(),
    serviceWorkerPrecache(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_INFO.version),
    __APP_BUILD__: JSON.stringify(BUILD_INFO.build),
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
  },
  server: {
    allowedHosts: HOSTS,
    port: 5274,
    strictPort: true,
    fs: {
      allow: [resolve(root, "app"), resolve(root, "src"), resolve(root, "node_modules")],
      deny: [".env", ".env.*", "*.db", "*.db-wal", "*.db-shm", "*.pem", "*.key"],
    },
  },
  preview: {
    allowedHosts: HOSTS,
    port: 4274,
    strictPort: true,
  },
  build: {
    outDir: CLOUD ? "../build/app-cloud-dist" : "../build/app-dist",
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    target: "es2022",
  },
});
