/**
 * THE SYNC MAILBOX, ON CLOUDFLARE — the same four requests `syncMailbox()` in
 * `vite.app.config.ts` answers, stored in Workers KV instead of `build/sync/`.
 *
 * Zach, 2026-09-26, after an evening proving his apartment wifi drops every
 * tunnel packet over ~1,208 bytes: *"then can we do the move while im
 * reviewing? … let's just do it for me (for now), let's make it work first"*.
 * Decision 49 had already retired "no cloud" as a principle; this is the move.
 *
 * ─── WHAT IT KEEPS FROM THE LAPTOP MAILBOX, ON PURPOSE ──────────────────────
 *
 * Everything the client depends on: `GET /sync/` lists peers with their size
 * and time, `GET /sync/<id>` returns one payload byte for byte, `PUT /sync/<id>`
 * replaces it, and the id pattern and the refusal of a non-JSON body are the
 * same. It still has NO opinion about any payload — the merge happens in each
 * device's own worker (`src/sync/merge.ts`), because this side never sees a
 * database. Swapping one mailbox for the other changes where the files live and
 * nothing about what they mean.
 *
 * ─── WHAT IT ADDS, BECAUSE THIS ONE IS ON THE OPEN INTERNET ─────────────────
 *
 * A bearer token on every request. The laptop mailbox needed none: the tailnet
 * was the lock. Here anyone who knows the URL could read his whole review
 * history or overwrite a device's payload, so the token is the lock. It is
 * compared in constant time, and a missing or wrong one is a 401 that says
 * nothing about what exists.
 *
 * CORS for the origins the app is actually served from, because the app still
 * comes from the laptop (`node.tailed819e.ts.net`) and this answers from
 * `*.workers.dev`.
 *
 * ─── ONE KNOWN LIMIT, NAMED ─────────────────────────────────────────────────
 *
 * KV is eventually consistent across Cloudflare's edge — a write can take up to
 * ~60 s to be visible from ANOTHER location. Both his devices resolve to Tokyo,
 * and the merge rules are idempotent (a peer read a little late is merged again
 * next time, never wrongly), so this costs at most one sync of delay.
 *
 * Free tier, measured against his use: 100,000 reads and 1,000 writes a day. A
 * push is one write, debounced to one per 30 s of grading, so a long session is
 * tens of writes.
 */

import { GEN_PREFIX, generate, parse, type GenerateEnv } from "./generate.js";

export interface KvLike {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface Env extends GenerateEnv {
  readonly MAILBOX: KvLike;
  readonly MAILBOX_TOKEN: string;
  /** Comma-separated origins allowed to call this from a browser. */
  readonly ALLOWED_ORIGINS: string;
}

/** Same pattern as the laptop mailbox's `SYNC_ID`. */
const SYNC_ID = /^[a-z0-9][a-z0-9-]{5,63}$/;

/** KV's own value cap is 25 MiB; his payload is ~1.8 MB. */
const MAX_BYTES = 24 * 1024 * 1024;

const PREFIX = "payload:";

interface PayloadMeta {
  readonly bytes: number;
  readonly updatedAt: string;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((entry) => entry.trim());
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors,
    },
  });
}

/** Constant-time string comparison, so the token cannot be guessed by timing. */
function sameSecret(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

function authorised(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return env.MAILBOX_TOKEN !== "" && token !== "" && sameSecret(token, env.MAILBOX_TOKEN);
}

async function listPeers(env: Env): Promise<{ deviceId: string; bytes: number; updatedAt: string }[]> {
  const peers: { deviceId: string; bytes: number; updatedAt: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MAILBOX.list({ prefix: PREFIX, ...(cursor === undefined ? {} : { cursor }) });
    for (const key of page.keys) {
      const meta = (key.metadata ?? {}) as Partial<PayloadMeta>;
      peers.push({
        deviceId: key.name.slice(PREFIX.length),
        bytes: typeof meta.bytes === "number" ? meta.bytes : 0,
        updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : new Date(0).toISOString(),
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return peers;
}

/**
 * `preAuthorised` is for the app Worker (`cloud/app/`), which serves this from
 * its own origin and has already checked the unlock cookie. The bearer token
 * still works either way.
 */
export async function handle(request: Request, env: Env, preAuthorised = false): Promise<Response> {
  const cors = corsHeaders(request, env);
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname === "/" || url.pathname === "/ping") {
    // Unauthenticated and content-free, so "is the mailbox up" can be asked
    // from any browser without a token.
    return new Response("hashigo mailbox is up\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...cors },
    });
  }
  const known =
    url.pathname.startsWith("/sync/") ||
    url.pathname === "/generate/" ||
    url.pathname.startsWith("/generated/");
  if (!known) return json(404, { error: "not found" }, cors);
  if (!preAuthorised && !authorised(request, env)) return json(401, { error: "unauthorised" }, cors);

  // ── generation (./generate.ts) ─────────────────────────────────────────────
  if (url.pathname === "/generate/") {
    if (request.method.toUpperCase() !== "POST") return json(405, { error: "POST only" }, cors);
    const text = await request.text();
    if (text.length > 64 * 1024) return json(413, { error: "body too large" }, cors);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return json(400, { error: "body is not JSON" }, cors);
    }
    const parsed = parse(raw);
    if (typeof parsed === "string") return json(400, { error: parsed }, cors);
    try {
      const [status, body] = await generate(parsed, env);
      return json(status, body, cors);
    } catch (cause) {
      // The message, not the stack: it reaches a phone as one line of status.
      return json(502, { error: (cause as Error).message }, cors);
    }
  }

  // ── what was generated here, for the laptop to file (scripts/cloud-generated-pull.ts)
  if (url.pathname === "/generated/") {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.MAILBOX.list({ prefix: GEN_PREFIX, ...(cursor === undefined ? {} : { cursor }) });
      for (const key of page.keys) keys.push(key.name.slice(GEN_PREFIX.length));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
    return json(200, { keys }, cors);
  }
  if (url.pathname.startsWith("/generated/")) {
    const id = decodeURIComponent(url.pathname.slice("/generated/".length));
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(id)) return json(400, { error: "bad key" }, cors);
    const body = await env.MAILBOX.get(`${GEN_PREFIX}${id}`, "text");
    if (body === null) return json(404, { error: "no such generation" }, cors);
    return new Response(body, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
    });
  }

  const rest = url.pathname.slice("/sync/".length);
  const method = request.method.toUpperCase();

  if (rest === "" && method === "GET") return json(200, { peers: await listPeers(env) }, cors);

  if (!SYNC_ID.test(rest)) {
    return json(400, { error: "device id must match ^[a-z0-9][a-z0-9-]{5,63}$" }, cors);
  }

  if (method === "GET") {
    const body = await env.MAILBOX.get(`${PREFIX}${rest}`, "text");
    if (body === null) return json(404, { error: `no payload from ${rest}` }, cors);
    return new Response(body, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
    });
  }

  if (method === "PUT" || method === "POST") {
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > MAX_BYTES) return json(413, { error: `payload over ${MAX_BYTES} bytes` }, cors);
    const body = await request.text();
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > MAX_BYTES) return json(413, { error: `payload over ${MAX_BYTES} bytes` }, cors);
    try {
      JSON.parse(body);
    } catch {
      return json(400, { error: "body is not JSON" }, cors);
    }
    const meta: PayloadMeta = { bytes, updatedAt: new Date().toISOString() };
    await env.MAILBOX.put(`${PREFIX}${rest}`, body, { metadata: meta });
    return json(200, { deviceId: rest, bytes }, cors);
  }

  return json(405, { error: `${method} not allowed on /sync/` }, cors);
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
};
