import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NAMED_FILE = resolve(ROOT, ".tunnel-named");
const HOST_FILE = resolve(ROOT, ".tunnel-host");

const PORT = 4274;

const LOCAL = `http://127.0.0.1:${PORT}`;
const LOCAL_HOSTPORT = `127.0.0.1:${PORT}`;

const CLOUDFLARED =
  process.env["CLOUDFLARED"] ??
  (existsSync("C:/Program Files (x86)/cloudflared/cloudflared.exe")
    ? "C:/Program Files (x86)/cloudflared/cloudflared.exe"
    : "cloudflared");

const TAILSCALE =
  process.env["TAILSCALE"] ??
  (existsSync("C:/Program Files/Tailscale/tailscale.exe")
    ? "C:/Program Files/Tailscale/tailscale.exe"
    : "tailscale");

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!existsSync(resolve(ROOT, "build/app/hashigo-app.db"))) {
  die("build/app/hashigo-app.db is missing. Make it:\n  npx vite-node scripts/app-bootstrap.ts");
}
if (!existsSync(resolve(ROOT, "build/app-dist/index.html"))) {
  die("build/app-dist/ is missing. Build it:\n  npm run app:build");
}

const portHolder = spawnSync(
  process.platform === "win32" ? "netstat" : "lsof",
  process.platform === "win32" ? ["-ano"] : ["-ti", `tcp:${PORT}`],
  { encoding: "utf8" },
);
const occupied =
  process.platform === "win32"
    ? (portHolder.stdout ?? "")
        .split("\n")
        .some((line) => line.includes(`:${PORT}`) && line.includes("LISTENING"))
    : (portHolder.stdout ?? "").trim() !== "";
if (occupied) {
  die(
    `Port ${PORT} is already being served by something this script did not start.\n\n` +
      `  That is worse than it sounds: \`tailscale serve\` points at ${PORT}\n` +
      `  permanently, so your phone will keep talking to THAT server — and\n` +
      `  because preview reads build/app-dist from disk, it will even show your\n` +
      `  newest build. An old process serving a new screen is how you get\n` +
      `  "sync failed — Unexpected token '<'": no /sync/ route, so the page\n` +
      `  came back instead of JSON.\n\n` +
      `  IT HAS NOW HAPPENED TWICE. 2026-09-14, the same shape with a POST:\n` +
      `  the generate button rendered from a fresh build, and /generate/ 404'd\n` +
      `  with an EMPTY body from a process started before that route existed.\n` +
      `  A GET gets the SPA fallback, a POST gets an empty 404 — one class,\n` +
      `  two faces, and every middleware route added from now on inherits it.\n\n` +
      `  Stop it, then run this again:\n` +
      `    npx kill-port ${PORT}`,
  );
}

function firstLine(file) {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))[0];
}

const named = process.env["TUNNEL_HOST"] ?? firstLine(NAMED_FILE);

function providerFor(host) {
  if (host.endsWith(".ts.net")) return "tailscale";
  if (/\.ngrok(-free)?\.(app|dev|io)$/.test(host)) return "ngrok";
  return "cloudflared";
}

const children = [];
const stopAll = () => {
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  }
};
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}
process.on("exit", stopAll);

function startServer() {
  console.log(`\n  serving ${LOCAL}`);
  const server = spawn(
    process.execPath,
    [
      resolve(ROOT, "node_modules/vite/bin/vite.js"),
      "preview",
      "--config",
      "vite.app.config.ts",
      "--host",
      "127.0.0.1",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(server);
  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(
        `\n  the preview server exited ${code}.\n` +
          `  If it says port ${PORT} is in use, an earlier run is still holding it:\n` +
          `    npx kill-port ${PORT}\n`,
      );
    }
    stopAll();
    process.exit(code ?? 0);
  });
}

if (named !== undefined && providerFor(named) === "tailscale") {
  const serve = spawnSync(TAILSCALE, ["serve", "status"], { encoding: "utf8" });
  const configured = (serve.stdout ?? "").includes(String(PORT));
  if (!configured) {
    die(
      `${named} has no \`tailscale serve\` config for port ${PORT}.\n\n` +
        `  ONE TIME, in this order:\n\n` +
        `  1. Enable HTTPS certificates for your tailnet — this is the one that\n` +
        `     cannot be done from here, and without it the next command HANGS\n` +
        `     with no output rather than failing:\n` +
        `       https://login.tailscale.com/admin/dns  →  HTTPS Certificates  →  Enable\n\n` +
        `  2. Then:\n` +
        `       & "${TAILSCALE}" serve --bg ${PORT}\n\n` +
        `  It persists across reboots, so this is not part of the daily routine.\n` +
        `  To undo it later:  & "${TAILSCALE}" serve reset`,
    );
  }
  console.log(`\n  tailscale  ${named}  (fixed, and reachable only on your tailnet)`);
  startServer();
  console.log(`\n  OPEN ON YOUR PHONE:  https://${named}/\n`);
} else if (named !== undefined && providerFor(named) === "ngrok") {
  console.log(`\n  ngrok      ${named}  (fixed — watch the 1 GB/month cap)`);
  const tunnel = spawn("ngrok", ["http", `--url=https://${named}`, LOCAL_HOSTPORT], {
    cwd: ROOT,
    shell: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(tunnel);
  tunnel.on("exit", (code) => {
    if (code !== 0) die(`ngrok exited ${code}.`);
  });
  startServer();
  console.log(
    `\n  OPEN ON YOUR PHONE:  https://${named}/\n` +
      `\n  If it answers 403 ERR_NGROK_725 the month's 1 GB is gone — a first load\n` +
      `  of this app is ~115 MB. Delete .tunnel-named for a quick tunnel.\n`,
  );
} else if (named !== undefined) {
  console.log(`\n  tunnel   ${named}  (named — the database on your phone persists)`);
  const tunnel = spawn(CLOUDFLARED, ["tunnel", "run"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(tunnel);
  tunnel.on("exit", (code) => {
    if (code !== 0) {
      die(
        `cloudflared exited ${code}. A named tunnel needs \`cloudflared tunnel login\`\n` +
          `and a tunnel with credentials on this machine. Delete .tunnel-named to fall\n` +
          `back to a quick tunnel.`,
      );
    }
  });
  startServer();
  console.log(`\n  OPEN ON YOUR PHONE:  https://${named}/\n`);
} else {
  console.log("\n  no .tunnel-host — starting a QUICK tunnel");
  const tunnel = spawn(CLOUDFLARED, ["tunnel", "--url", LOCAL], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(tunnel);

  let found = false;
  const watch = (chunk) => {
    const text = String(chunk);
    process.stderr.write(text);
    const match = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(text);
    if (match === null || found) return;
    found = true;
    const host = match[1];
    writeFileSync(HOST_FILE, `${host}\n`, "utf8");
    startServer();
    console.log(
      `\n  OPEN ON YOUR PHONE:  https://${host}/\n` +
        `\n  THIS NAME IS NEW, SO THE PHONE'S DATABASE IS EMPTY.\n` +
        `  OPFS is keyed by origin: it will re-download ~115 MB, and anything you\n` +
        `  graded on the last random name is under that name, not this one.\n` +
        `  A named tunnel fixes this permanently — see scripts/phone.mjs.\n`,
    );
  };
  tunnel.stdout.on("data", watch);
  tunnel.stderr.on("data", watch);
  tunnel.on("exit", (code) => {
    if (!found) die(`cloudflared exited (${code}) before printing a hostname.`);
  });
}
