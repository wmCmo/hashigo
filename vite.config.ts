import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

const BOOTSTRAP_URL = "/hashigo-bootstrap.db";
const BOOTSTRAP_FILE = resolve(root, "build/spike/hashigo-bootstrap.db");

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
  publicDir: false,
  plugins: [serveBootstrapDatabase(), serveMockups()],
  define: {
    __SCHEMA_VERSION_FROM_NODE__: JSON.stringify(schemaVersionFromNode()),
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
  },
  server: {
    allowedHosts: [
      "acids-viewed-sound-royal.trycloudflare.com",
      "crayfish-shorty-thinning.ngrok-free.dev",
    ],
    port: 5273,
    strictPort: true,
    fs: {
      allow: [
        resolve(root, "spike"),
        resolve(root, "src"),
        resolve(root, "node_modules"),
      ],
      deny: [".env", ".env.*", "*.db", "*.db-wal", "*.db-shm", "*.pem", "*.key"],
    },
  },
  preview: {
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
    minify: false,
    sourcemap: false,
    target: "es2022",
  },
});
