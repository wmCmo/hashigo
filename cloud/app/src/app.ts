/**
 * HASHIGO ON CLOUDFLARE — the whole app from one origin: its files, his seed
 * databases, the sync mailbox and generation.
 *
 * Zach, 2026-09-26: *"let's tackle those two while im reviewing"* — sync had
 * moved off the laptop, and the two things left on it were generation (moved in
 * `cloud/mailbox/src/generate.ts`) and APP UPDATES: a phone that cannot reach the
 * laptop, like his on the apartment wifi, never receives a new build. Serving
 * the app from here ends that.
 *
 * ─── ONE ORIGIN, AND WHY THAT DECIDES THE LOCK ──────────────────────────────
 *
 * The tailnet build carries the mailbox key in its bundle, which is fine only
 * because that bundle never leaves the tailnet. A bundle on the open internet
 * cannot hold a secret — anyone can download it. So this origin is locked with
 * a PASSPHRASE entered once per device (`/unlock`), answered with a signed,
 * HttpOnly cookie, and the app, the seed and every API route require that
 * cookie. Same origin means the browser sends it on every request by itself —
 * the page, the service worker and the database worker — with no key anywhere
 * in code.
 *
 * `/ping` and `/unlock` are the only open routes. The unlock page says nothing
 * about what is behind it.
 *
 * ─── THE SEED, FROM R2, AND THE ONE FILE TOO BIG TO UPLOAD WHOLE ────────────
 *
 * The four seed files (`build/app/`) live in R2, served under the same names the
 * laptop served them, so `app/db.worker.ts` fetches exactly what it always did.
 * `hashigo-app-blobs.db` is 674 MB and `wrangler r2 object put` stops at 300 MB,
 * so `scripts/cloud-seed-upload.ts` sends it through R2 MULTIPART (`multipart`
 * below), which R2 joins into one object. Every seed file is then served as a
 * single native stream the Worker never touches.
 */

import { handle as mailbox, type Env as MailboxEnv } from "../../mailbox/src/mailbox.js";

interface R2ObjectBodyLike {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

interface R2UploadedPartLike {
  readonly partNumber: number;
  readonly etag: string;
}

interface R2MultipartUploadLike {
  readonly uploadId: string;
  uploadPart(partNumber: number, body: ReadableStream<Uint8Array> | ArrayBuffer): Promise<R2UploadedPartLike>;
  complete(parts: readonly R2UploadedPartLike[]): Promise<unknown>;
  abort(): Promise<void>;
}

interface R2Like {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<{ readonly size: number } | null>;
  createMultipartUpload?(key: string): Promise<R2MultipartUploadLike>;
  resumeMultipartUpload?(key: string, uploadId: string): R2MultipartUploadLike;
  delete?(keys: string | string[]): Promise<void>;
}

interface AssetsLike {
  fetch(request: Request): Promise<Response>;
}

export interface AppEnv extends MailboxEnv {
  readonly SEED: R2Like;
  readonly ASSETS: AssetsLike;
  /** SHA-256 hex of the unlock passphrase. The passphrase itself is nowhere here. */
  readonly UNLOCK_HASH: string;
  /** HMAC key for the cookie. */
  readonly COOKIE_KEY: string;
}

const COOKIE = "hashigo_unlock";
const COOKIE_DAYS = 400;
/** The laptop's own pattern: one segment, no traversal expressible. */
const SEED_NAME = /^\/(hashigo-app[a-z-]*\.(?:db|json))$/;

// ─── the lock ────────────────────────────────────────────────────────────────

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmac(key: string, message: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message)));
}

function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

export async function makeCookie(env: AppEnv, now = Date.now()): Promise<string> {
  const expires = now + COOKIE_DAYS * 24 * 60 * 60 * 1000;
  const value = `${expires}.${await hmac(env.COOKIE_KEY, String(expires))}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${COOKIE_DAYS * 24 * 60 * 60}; HttpOnly; Secure; SameSite=Lax`;
}

export async function unlocked(request: Request, env: AppEnv, now = Date.now()): Promise<boolean> {
  if (env.COOKIE_KEY === "" || env.UNLOCK_HASH === "") return false;
  const cookies = request.headers.get("Cookie") ?? "";
  const match = cookies.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  if (match === undefined) return false;
  const [expires, signature] = match.slice(COOKIE.length + 1).split(".");
  if (expires === undefined || signature === undefined) return false;
  if (!(Number(expires) > now)) return false;
  return sameText(signature, await hmac(env.COOKIE_KEY, expires));
}

const UNLOCK_PAGE = (message: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hashigo</title>
<style>
  :root { color-scheme: light dark; --ink:#1b1b1b; --paper:#f6f3ec; --line:#cfc8b8; --indigo:#1b3b6f; }
  @media (prefers-color-scheme: dark) { :root { --ink:#ece7dc; --paper:#161512; --line:#3a372f; --indigo:#8fb0e8; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--paper); color:var(--ink);
         font: 16px/1.5 system-ui, sans-serif; }
  form { width:min(22rem, calc(100vw - 32px)); display:grid; gap:12px; }
  h1 { font-size:1.4rem; margin:0; }
  input, button { font:inherit; padding:12px; border:1px solid var(--line); background:transparent; color:var(--ink); }
  button { background:var(--indigo); color:var(--paper); border-color:var(--indigo); }
  p { margin:0; font-size:.9rem; opacity:.8; }
</style></head>
<body><form method="post" action="/unlock">
  <h1>hashigo</h1>
  <p>${message}</p>
  <input type="password" name="passphrase" autocomplete="current-password" autofocus aria-label="passphrase">
  <button type="submit">unlock</button>
</form></body></html>`;

function html(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

async function unlock(request: Request, env: AppEnv): Promise<Response> {
  if (request.method === "GET") return html(200, UNLOCK_PAGE("Enter the passphrase once on this device."));
  if (request.method !== "POST") return html(405, UNLOCK_PAGE("Enter the passphrase."));
  const form = await request.formData().catch(() => null);
  const passphrase = String(form?.get("passphrase") ?? "").trim();
  if (passphrase === "" || env.UNLOCK_HASH === "" || !sameText(await sha256(passphrase), env.UNLOCK_HASH)) {
    return html(401, UNLOCK_PAGE("That was not it. Try again."));
  }
  return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": await makeCookie(env) } });
}

// ─── the seed ────────────────────────────────────────────────────────────────

function seedType(name: string): string {
  return name.endsWith(".json") ? "application/json; charset=utf-8" : "application/vnd.sqlite3";
}

/**
 * One stored object, returned as R2 hands it over. The Worker never touches the
 * bytes, and that is load-bearing: on the free plan a request gets milliseconds
 * of CPU, and an earlier version that stitched the 674 MB audio store together
 * from parts was cut off after 108 MB, with no length header — measured
 * 2026-09-26. The store is now uploaded as ONE object through R2 multipart
 * (`/admin/multipart`, below), so every seed file is a single native stream.
 */
async function seed(name: string, env: AppEnv): Promise<Response> {
  const object = await env.SEED.get(name);
  if (object === null) {
    return new Response(JSON.stringify({ error: `no ${name} in the seed bucket — run scripts/cloud-seed-upload.ts` }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response(object.body, {
    headers: { "Content-Type": seedType(name), "Cache-Control": "no-store", "Content-Length": String(object.size) },
  });
}

// ─── uploading a seed file too big for `wrangler r2 object put` ─────────────

/**
 * R2 multipart, driven from the laptop by `scripts/cloud-seed-upload.ts`.
 *
 * `wrangler r2 object put` stops at 300 MB and the audio store is 674 MB. R2
 * itself takes a file in parts and JOINS them into one object, which it can then
 * serve natively. Each part is one request body — under the free plan's 100 MB
 * request cap — streamed straight into R2, so no CPU is spent on the bytes here.
 *
 * Bearer token only (`MAILBOX_TOKEN`), never the cookie: this writes the seed
 * every device downloads, and it is a laptop-script route, not a page route.
 */
async function multipart(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const header = request.headers.get("Authorization") ?? "";
  if (env.MAILBOX_TOKEN === "" || header !== `Bearer ${env.MAILBOX_TOKEN}`) {
    return new Response("unauthorised", { status: 401 });
  }
  const key = url.searchParams.get("key") ?? "";
  if (SEED_NAME.exec(`/${key}`) === null) return new Response("bad key", { status: 400 });
  const action = url.pathname.slice("/admin/multipart/".length);
  const answer = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json; charset=utf-8" } });
  if (env.SEED.createMultipartUpload === undefined || env.SEED.resumeMultipartUpload === undefined) {
    return new Response("this bucket binding cannot do multipart", { status: 500 });
  }
  if (action === "create" && request.method === "POST") {
    const upload = await env.SEED.createMultipartUpload(key);
    return answer({ uploadId: upload.uploadId });
  }
  const uploadId = url.searchParams.get("uploadId") ?? "";
  if (uploadId === "") return new Response("no uploadId", { status: 400 });
  const upload = env.SEED.resumeMultipartUpload(key, uploadId);
  if (action === "part" && request.method === "PUT") {
    const partNumber = Number(url.searchParams.get("part"));
    if (!Number.isInteger(partNumber) || partNumber < 1 || request.body === null) {
      return new Response("bad part", { status: 400 });
    }
    return answer(await upload.uploadPart(partNumber, request.body));
  }
  if (action === "complete" && request.method === "POST") {
    const parts = (await request.json()) as R2UploadedPartLike[];
    await upload.complete(parts);
    return answer({ key, parts: parts.length });
  }
  if (action === "abort" && request.method === "POST") {
    await upload.abort();
    return answer({ aborted: key });
  }
  return new Response("unknown action", { status: 404 });
}

// ─── routing ─────────────────────────────────────────────────────────────────

/**
 * 鍵の外に置くもの — アプリとして入れるのに要るファイルだけ。
 *
 * 2026-09-27、Edge でも Samsung Internet でも「アプリとしてインストール」が出なかった。
 * ブラウザは manifest を Cookie なしで取りに来る（仕様で credentials は omit、
 * `crossorigin="use-credentials"` を付けない限り）ので、鍵の中にあると 401 が返り、
 * manifest のないページはインストールできない。アイコンも同じ。`sw.js` も外に
 * 出す — 更新確認で 401 を受けるとサービスワーカーが古いまま残る道がひとつ減る。
 *
 * どれも中身は汎用のコードと画像で、カードも復習履歴も含まない。種（R2）と
 * mailbox には届かない: ここは ASSETS だけを返す。
 */
const PUBLIC_FILES = new Set(["/manifest.webmanifest", "/sw.js"]);
const PUBLIC_DIRS = ["/icons/", "/brand/"];

export function isPublicAsset(pathname: string): boolean {
  return PUBLIC_FILES.has(pathname) || PUBLIC_DIRS.some((dir) => pathname.startsWith(dir));
}

export async function handleApp(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/ping") {
    return new Response("hashigo is up\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/unlock") return unlock(request, env);
  if (url.pathname.startsWith("/admin/multipart/")) return multipart(request, env, url);
  if (request.method === "GET" && isPublicAsset(url.pathname)) return env.ASSETS.fetch(request);

  if (!(await unlocked(request, env))) {
    // A page navigation is sent to the lock; anything else is a plain 401, so a
    // fetch from a locked device fails clearly instead of receiving a web page.
    const navigating = request.headers.get("Sec-Fetch-Mode") === "navigate" || request.headers.get("Accept")?.includes("text/html");
    if (navigating && request.method === "GET") return Response.redirect(new URL("/unlock", url).toString(), 303);
    return new Response(JSON.stringify({ error: "locked — open the app and enter the passphrase" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (url.pathname.startsWith("/sync/") || url.pathname === "/generate/" || url.pathname.startsWith("/generated/")) {
    return mailbox(request, env, true);
  }
  const seedMatch = SEED_NAME.exec(url.pathname);
  if (seedMatch !== null && request.method === "GET") return seed(seedMatch[1] as string, env);
  return env.ASSETS.fetch(request);
}

export default {
  fetch: (request: Request, env: AppEnv): Promise<Response> => handleApp(request, env),
};
