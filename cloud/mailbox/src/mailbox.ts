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
  /** The value AND its metadata from one entry — so a hash in the metadata describes these bytes. */
  getWithMetadata(key: string, type: "text"): Promise<{ value: string | null; metadata: unknown }>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
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

/**
 * 差分 — 2026-10-10。`payload:<id>~delta` に、その端末が全体を最後に上げた後の
 * 採点を `SyncDelta` の配列として積む（`src/sync/delta.ts`）。
 *
 * 同じ接頭辞の下に置くのは、一覧が KV の `list` 一回で済むように（無料枠は一日
 * 1,000 回）。`~` は端末 id の文字集合に無いので、どの端末の名前とも衝突しない。
 *
 * 全体の PUT が `X-Covers-Mark` で「ここまでは全体に入っている」と言えば、それ
 * 以下の差分は捨てる。差分の側は、送った端末が自分の印を名乗るだけで、ここは
 * 印の意味を知らない — 比べるだけ。
 */
const DELTA_SUFFIX = "~delta";

/**
 * 差分の積み上げの上限。超えたら 413 — 端末は全体を送り、全体の PUT がここを
 * 空にする。一枚 ~400 B として ~1,300 枚、一日の復習より多い。
 */
const MAX_DELTA_BYTES = 512 * 1024;

interface DeltaEntry {
  readonly mark: number;
}

function isDeltaEntry(value: unknown): value is DeltaEntry & { delta: 1 } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { delta?: unknown }).delta === 1 &&
    typeof (value as { mark?: unknown }).mark === "number" &&
    Array.isArray((value as { reviews?: unknown }).reviews)
  );
}

async function readDeltas(env: Env, id: string): Promise<unknown[]> {
  const body = await env.MAILBOX.get(`${PREFIX}${id}${DELTA_SUFFIX}`, "text");
  if (body === null) return [];
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeDeltas(env: Env, id: string, entries: readonly unknown[]): Promise<PayloadMeta | null> {
  const key = `${PREFIX}${id}${DELTA_SUFFIX}`;
  if (entries.length === 0) {
    await env.MAILBOX.delete(key);
    return null;
  }
  const body = JSON.stringify(entries);
  const meta: PayloadMeta = {
    bytes: new TextEncoder().encode(body).length,
    updatedAt: new Date().toISOString(),
    sha: await sha256Hex(body),
  };
  await env.MAILBOX.put(key, body, { metadata: meta });
  return meta;
}

interface PayloadMeta {
  readonly bytes: number;
  readonly updatedAt: string;
  /**
   * sha256 of the stored JSON, hex — 2026-09-29. A device merges a peer only when
   * this differs from the hash it last merged, so an unchanged peer costs a line of
   * the listing instead of a 1.9 MB download. Absent on payloads written before
   * then, and absent means "download it".
   */
  readonly sha?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The request body as text — gunzipped when the device says it compressed it.
 *
 * `X-Payload-Encoding`, not `Content-Encoding`: whether the runtime decodes a
 * request body on its own is not something this code wants to depend on, and a
 * header of our own means the decode happens exactly once, here. A payload
 * gzips 1.9 MB → ~0.33 MB, and the upload is the half nothing else compressed.
 */
async function requestText(request: Request): Promise<string> {
  if ((request.headers.get("X-Payload-Encoding") ?? "").toLowerCase() !== "gzip") return request.text();
  if (request.body === null) return "";
  const plain = request.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(plain).text();
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((entry) => entry.trim());
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Payload-Encoding, X-Covers-Mark",
    "Access-Control-Expose-Headers": "X-Payload-Sha",
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

interface PeerListing {
  deviceId: string;
  bytes: number;
  updatedAt: string;
  sha?: string;
  /** 全体がまだ無く、差分だけがある（全体が消された端末）。 */
  noPayload?: true;
  delta?: { bytes: number; updatedAt: string; sha?: string };
}

async function listPeers(env: Env): Promise<PeerListing[]> {
  const peers = new Map<string, PeerListing>();
  const entry = (id: string): PeerListing => {
    let peer = peers.get(id);
    if (peer === undefined) {
      peer = { deviceId: id, bytes: 0, updatedAt: new Date(0).toISOString(), noPayload: true };
      peers.set(id, peer);
    }
    return peer;
  };
  let cursor: string | undefined;
  do {
    const page = await env.MAILBOX.list({ prefix: PREFIX, ...(cursor === undefined ? {} : { cursor }) });
    for (const key of page.keys) {
      const meta = (key.metadata ?? {}) as Partial<PayloadMeta>;
      const name = key.name.slice(PREFIX.length);
      const bytes = typeof meta.bytes === "number" ? meta.bytes : 0;
      const updatedAt = typeof meta.updatedAt === "string" ? meta.updatedAt : new Date(0).toISOString();
      if (name.endsWith(DELTA_SUFFIX)) {
        entry(name.slice(0, -DELTA_SUFFIX.length)).delta = {
          bytes,
          updatedAt,
          ...(typeof meta.sha === "string" ? { sha: meta.sha } : {}),
        };
        continue;
      }
      const peer = entry(name);
      delete peer.noPayload;
      peer.bytes = bytes;
      peer.updatedAt = updatedAt;
      if (typeof meta.sha === "string") peer.sha = meta.sha;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return [...peers.values()];
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

  // ── 差分：/sync/<id>/delta ────────────────────────────────────────────────
  if (rest.endsWith("/delta")) {
    const id = rest.slice(0, -"/delta".length);
    if (!SYNC_ID.test(id)) {
      return json(400, { error: "device id must match ^[a-z0-9][a-z0-9-]{5,63}$" }, cors);
    }
    const key = `${PREFIX}${id}${DELTA_SUFFIX}`;
    if (method === "GET") {
      const { value: body, metadata } = await env.MAILBOX.getWithMetadata(key, "text");
      const sha = (metadata as Partial<PayloadMeta> | null)?.sha;
      return new Response(body ?? "[]", {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...(typeof sha === "string" ? { "X-Payload-Sha": sha } : {}),
          ...cors,
        },
      });
    }
    if (method === "POST") {
      // 差分は小さい（`keepalive` の 64 KB に収めるために作った）ので、上限も小さく。
      if (Number(request.headers.get("Content-Length") ?? "0") > 64 * 1024) {
        return json(413, { error: "a delta is at most 64 KB — send the full payload" }, cors);
      }
      let incoming: unknown;
      try {
        incoming = JSON.parse(await requestText(request));
      } catch {
        return json(400, { error: "body is not JSON" }, cors);
      }
      if (!isDeltaEntry(incoming)) return json(400, { error: "body is not a sync delta" }, cors);
      const held = await readDeltas(env, id);
      // 同じ印をもう一度（keepalive と再送が両方届いた）は積まない。マージは冪等
      // なので積んでも壊れないが、場所の無駄。
      if (held.some((entry) => isDeltaEntry(entry) && entry.mark === incoming.mark)) {
        return json(200, { deviceId: id, entries: held.length, duplicate: true }, cors);
      }
      const next = [...held, incoming];
      if (new TextEncoder().encode(JSON.stringify(next)).length > MAX_DELTA_BYTES) {
        return json(413, { error: "deltas are full — send the full payload" }, cors);
      }
      const meta = await writeDeltas(env, id, next);
      return json(200, { deviceId: id, entries: next.length, sha: meta?.sha }, cors);
    }
    return json(405, { error: `${method} not allowed on a delta` }, cors);
  }

  if (!SYNC_ID.test(rest)) {
    return json(400, { error: "device id must match ^[a-z0-9][a-z0-9-]{5,63}$" }, cors);
  }

  if (method === "GET") {
    const { value: body, metadata } = await env.MAILBOX.getWithMetadata(`${PREFIX}${rest}`, "text");
    if (body === null) return json(404, { error: `no payload from ${rest}` }, cors);
    const sha = (metadata as Partial<PayloadMeta> | null)?.sha;
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...(typeof sha === "string" ? { "X-Payload-Sha": sha } : {}),
        ...cors,
      },
    });
  }

  if (method === "PUT" || method === "POST") {
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > MAX_BYTES) return json(413, { error: `payload over ${MAX_BYTES} bytes` }, cors);
    let body: string;
    try {
      body = await requestText(request);
    } catch {
      return json(400, { error: "body said gzip and did not decompress" }, cors);
    }
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > MAX_BYTES) return json(413, { error: `payload over ${MAX_BYTES} bytes` }, cors);
    try {
      JSON.parse(body);
    } catch {
      return json(400, { error: "body is not JSON" }, cors);
    }
    const meta: PayloadMeta = { bytes, updatedAt: new Date().toISOString(), sha: await sha256Hex(body) };
    await env.MAILBOX.put(`${PREFIX}${rest}`, body, { metadata: meta });
    // 全体が覆った差分を捨てる。印が無い PUT（古い端末）は差分に触らない —
    // 何を覆ったか言えない全体で、まだ要るかもしれない差分を消してはいけない。
    const covers = Number(request.headers.get("X-Covers-Mark") ?? "NaN");
    if (Number.isFinite(covers)) {
      const held = await readDeltas(env, rest);
      const kept = held.filter((entry) => !isDeltaEntry(entry) || entry.mark > covers);
      if (kept.length !== held.length) await writeDeltas(env, rest, kept);
    }
    return json(200, { deviceId: rest, bytes, sha: meta.sha }, cors);
  }

  return json(405, { error: `${method} not allowed on /sync/` }, cors);
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
};
