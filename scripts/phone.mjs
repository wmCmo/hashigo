/**
 * `npm run phone` — the daily routine, as one command.
 *
 * Starts the tunnel FIRST, learns the hostname it was given, authorises that
 * hostname, and only then starts the server. That order is not stylistic:
 * `allowedHosts` is read once at Vite startup, so a server started first cannot be
 * told about a hostname that did not exist yet.
 *
 * ─── THE ORIGIN IS THE WHOLE PROBLEM ────────────────────────────────────────
 *
 * OPFS is keyed by ORIGIN. The database, the 42 MiB of audio and every local grade
 * live under whatever hostname the browser was on. A `cloudflared tunnel --url`
 * quick tunnel hands out a NEW random `*.trycloudflare.com` name every run — so
 * every session is a new origin, which means an empty database, a re-download of
 * ~115 MB, and any grades made on the phone gone with the old name.
 *
 * That is fine for a test and unusable as a routine. A FIXED hostname is the only
 * thing that makes the phone's database survive to tomorrow, and `.tunnel-named` is
 * where one is recorded. Three ways to get one, measured 2026-08-26:
 *
 * | route                | fixed? | costs                          | private? |
 * |----------------------|--------|--------------------------------|----------|
 * | cloudflared quick    | NO     | free                           | public   |
 * | cloudflared named    | yes    | a domain on his CF account     | public   |
 * | ngrok free static    | yes    | free, **1 GB/month**           | public   |
 * | tailscale serve      | yes    | free                           | TAILNET  |
 *
 * **ngrok's cap is not theoretical and it is not generous here.** He has a reserved
 * free static domain (`crayfish-shorty-thinning.ngrok-free.dev` — it bound on the
 * first try), and it currently answers **403 ERR_NGROK_725: "This ngrok account has
 * reached its network bandwidth limit for the month."** A first load of this app is
 * ~115 MB (72 MB of cards + 42 MB of audio), so a single fresh origin is 11% of the
 * monthly allowance. With a STABLE origin that is a one-time cost and daily use is
 * a few hundred KB; with the quick tunnel's new name every session it would have
 * been four sessions a month.
 *
 * **`tailscale serve` is the only one that is not public.** The other three put a
 * server holding his entire study history on the open internet behind an
 * unguessable name. Tailnet-only is a different security posture, not a smaller
 * inconvenience.
 *
 * ─── AND A LAN ADDRESS CANNOT SUBSTITUTE ────────────────────────────────────
 *
 * `http://192.168.x.x:4274` is not a secure context, and `navigator.storage` is
 * ABSENT on one — no OPFS, no persistence, no app. Measured on his own handset,
 * `notes/archive/PHONE-TEST.md`: "Route B (LAN IP) cannot work at all". The tunnel
 * is not a convenience here; it is the only route that runs the app.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * TWO FILES, BECAUSE THEY ARE TWO DIFFERENT THINGS — and the first version of this
 * script used one for both, which broke on the second run.
 *
 * `.tunnel-named` is CONFIGURATION: the fixed hostname of a named tunnel, written
 * once by hand. Its presence is what says "a named tunnel exists".
 *
 * `.tunnel-host` is SCRATCH: whatever random name the last quick tunnel was given,
 * rewritten every run and dead the moment that run ends.
 *
 * Conflating them meant the quick tunnel wrote a name into the file the script then
 * read as "a named tunnel is configured", so the next run tried `cloudflared tunnel
 * run` with no tunnel and handed out a URL that answered **530** — Cloudflare
 * routing to a connector that no longer exists. It printed a working-looking link
 * for a dead hostname, which is the worst way to be wrong.
 *
 * Both are gitignored and both are read by `vite.app.config.ts`, so a hostname gets
 * authorised without editing a committed file — and `allowedHosts` stays an
 * explicit list. It is never `true`: that is Vite's DNS-rebinding guard, and a
 * wildcard hands any page he visits a route to a server serving a 72 MB database.
 */
const NAMED_FILE = resolve(ROOT, ".tunnel-named");
const HOST_FILE = resolve(ROOT, ".tunnel-host");

/** Port 4274 — `preview` in `vite.app.config.ts`. */
const PORT = 4274;

/**
 * IPv4 EXPLICITLY, on both sides.
 *
 * On Windows `localhost` resolves to `::1` first, and binding one address family
 * refuses the other. Pointing the tunnel at `127.0.0.1` and binding the server to
 * `127.0.0.1` sidesteps it in the only direction that has ever worked here — and
 * it also means nothing on the LAN can reach the server at all.
 */
const LOCAL = `http://127.0.0.1:${PORT}`;
/** ngrok takes `host:port`, not a URL, as its forwarding target. */
const LOCAL_HOSTPORT = `127.0.0.1:${PORT}`;

const CLOUDFLARED =
  process.env["CLOUDFLARED"] ??
  (existsSync("C:/Program Files (x86)/cloudflared/cloudflared.exe")
    ? "C:/Program Files (x86)/cloudflared/cloudflared.exe"
    : "cloudflared");

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// ─── the two files the app cannot start without ─────────────────────────────
// A missing one fails inside a worker as a fetch error with no visible cause, so
// it is checked here where the fix can be printed beside it.
if (!existsSync(resolve(ROOT, "build/app/hashigo-app.db"))) {
  die("build/app/hashigo-app.db is missing. Make it:\n  npx vite-node scripts/app-bootstrap.ts");
}
if (!existsSync(resolve(ROOT, "build/app-dist/index.html"))) {
  die("build/app-dist/ is missing. Build it:\n  npm run app:build");
}

function firstLine(file) {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))[0];
}

const named = process.env["TUNNEL_HOST"] ?? firstLine(NAMED_FILE);

/**
 * Which tool serves that hostname, from the hostname itself.
 *
 * A second knob would be one more thing to keep in sync with the first, and these
 * suffixes are unambiguous — nothing else ends in `.ts.net`, and ngrok's endings
 * are reserved. Wrong guesses are visible immediately: the tool it picks either
 * starts or says why.
 */
function providerFor(host) {
  if (host.endsWith(".ts.net")) return "tailscale";
  if (/\.ngrok(-free)?\.(app|dev|io)$/.test(host)) return "ngrok";
  return "cloudflared";
}

/**
 * Kill both children together — and on Windows that means the TREE.
 *
 * `child.kill()` kills the process it started. Under `shell: true` that process is
 * `cmd.exe`, and killing it leaves the node it launched still holding the port:
 * measured, the second run of this script died on `Port 4274 is already in use`
 * while the tunnel stayed up and served **530** to the phone. The server is spawned
 * without a shell now (see `startServer`), and `taskkill /T` is the belt to that
 * braces — a grandchild can still appear and a stranded tunnel outlives the
 * terminal it was started from.
 */
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
// Ctrl+C is SIGINT; a terminal closing is SIGBREAK on Windows and SIGTERM
// elsewhere. All three, because an orphaned tunnel keeps a public hostname pointed
// at this machine after the window it was started from is gone.
//
// A `taskkill /F` on THIS process cannot be trapped and will orphan both children —
// nothing in a Node script can prevent that. `npx kill-port 4274` clears the server;
// the tunnel appears in Task Manager as cloudflared.exe.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}
process.on("exit", stopAll);

function startServer() {
  console.log(`\n  serving ${LOCAL}`);
  // `node node_modules/vite/bin/vite.js`, NOT `npx vite` through a shell. A shell
  // puts `cmd.exe` between this process and the server, and killing cmd leaves the
  // server holding port 4274 — which is exactly how the second run of this script
  // failed while the tunnel stayed up and answered 530.
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
    // `strictPort` is on, so "already in use" is fatal rather than a silent move to
    // another port the tunnel is not pointed at. Say what to do about it.
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

// ─── a fixed hostname: the phone's database survives to tomorrow ────────────
if (named !== undefined && providerFor(named) === "tailscale") {
  // NO CHILD PROCESS. `tailscale serve --bg` is persistent configuration, not a
  // tunnel that has to be held open — it survives reboots and is already running
  // as a service. So this starts the server and nothing else.
  //
  //   tailscale serve --bg 4274        (configured once, not by this script)
  //
  // That command is deliberately NOT run from here: it changes machine state that
  // outlives this process, and a script that silently reconfigures his tailnet
  // every time he wants to review is the wrong shape.
  console.log(`\n  tailscale  ${named}  (fixed, and reachable only on your tailnet)`);
  startServer();
  console.log(`\n  OPEN ON YOUR PHONE:  https://${named}/\n`);
} else if (named !== undefined && providerFor(named) === "ngrok") {
  // Verified against his own reserved domain 2026-08-26: the tunnel binds on the
  // first try. What stopped it was the free tier's 1 GB/month, not the syntax.
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
    // NOT `shell: true`. The default install path is
    // `C:\Program Files (x86)\cloudflared\cloudflared.exe`, and a shell splits it
    // at the first space — cmd.exe reported `'C:/Program' is not recognized`.
    // The exe path is absolute and the args are a list, so no shell is needed.
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(tunnel);
  // A named tunnel that cannot start is the case that used to print a working-looking
  // link for a hostname answering 530. It exits within a second or two when there is
  // no credentials file, so a non-zero exit before the server is up is reported as
  // what it is rather than left for him to discover on the phone.
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
  // ─── quick tunnel: a NEW hostname every run ───────────────────────────────
  console.log("\n  no .tunnel-host — starting a QUICK tunnel");
  // No shell — see the named branch: a space in the install path splits the command.
  const tunnel = spawn(CLOUDFLARED, ["tunnel", "--url", LOCAL], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(tunnel);

  let found = false;
  const watch = (chunk) => {
    const text = String(chunk);
    process.stderr.write(text);
    // cloudflared prints the assigned name to STDERR, inside a box.
    const match = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(text);
    if (match === null || found) return;
    found = true;
    const host = match[1];
    // SCRATCH, not configuration — `.tunnel-named` is the other one. Written
    // before the server starts, because `allowedHosts` is read once at Vite
    // startup: a server started first cannot learn a name that did not exist yet.
    // That ordering is the whole reason the tunnel goes first.
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
