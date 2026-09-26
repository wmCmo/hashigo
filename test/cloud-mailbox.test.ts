import { describe, expect, it } from "vitest";

import { handle, type Env, type KvLike } from "../cloud/mailbox/src/mailbox.js";

/**
 * The Cloudflare mailbox, over an in-memory KV — proven before it is deployed.
 *
 * The property that matters is that it is a DROP-IN for `syncMailbox()` in
 * `vite.app.config.ts`: same routes, same shapes, same refusals, so
 * `app/sync-client.ts` cannot tell which one it is talking to. The one thing it
 * adds — a token — is tested for both arms, because a mailbox on the open
 * internet that lets a wrong token through is his whole review history public.
 */

function memoryKv(): KvLike & { readonly data: Map<string, { value: string; metadata?: unknown }> } {
  const data = new Map<string, { value: string; metadata?: unknown }>();
  return {
    data,
    async get(key) {
      return data.get(key)?.value ?? null;
    },
    async put(key, value, options) {
      data.set(key, { value, metadata: options?.metadata });
    },
    async list(options) {
      const keys = [...data.entries()]
        .filter(([name]) => name.startsWith(options?.prefix ?? ""))
        .map(([name, entry]) => ({ name, metadata: entry.metadata }));
      return { keys, list_complete: true };
    },
  };
}

const TOKEN = "test-token-0123456789";
const ORIGIN = "https://node.tailed819e.ts.net";

function env(): Env & { MAILBOX: ReturnType<typeof memoryKv> } {
  return { MAILBOX: memoryKv(), MAILBOX_TOKEN: TOKEN, ALLOWED_ORIGINS: `${ORIGIN},http://127.0.0.1:5274` };
}

function request(method: string, path: string, init: { body?: string; token?: string | null; origin?: string } = {}): Request {
  const headers: Record<string, string> = { Origin: init.origin ?? ORIGIN };
  if (init.token !== null) headers["Authorization"] = `Bearer ${init.token ?? TOKEN}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://hashigo-mailbox.example.workers.dev${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

describe("the Cloudflare mailbox is a drop-in for the laptop one", () => {
  it("PUT then GET returns the payload byte for byte, and the listing names it", async () => {
    const e = env();
    const payload = JSON.stringify({ syncVersion: 1, archive: { reviews: [] }, note: "橋と箸" });
    const put = await handle(request("PUT", "/sync/dev-1665859d9737", { body: payload }), e);
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ deviceId: "dev-1665859d9737" });

    const got = await handle(request("GET", "/sync/dev-1665859d9737"), e);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe(payload);

    const list = (await (await handle(request("GET", "/sync/"), e)).json()) as {
      peers: { deviceId: string; bytes: number; updatedAt: string }[];
    };
    expect(list.peers).toHaveLength(1);
    expect(list.peers[0]).toMatchObject({
      deviceId: "dev-1665859d9737",
      bytes: new TextEncoder().encode(payload).length,
    });
    expect(Date.parse(list.peers[0]?.updatedAt ?? "")).not.toBeNaN();
  });

  it("refuses the same things the laptop mailbox refuses", async () => {
    const e = env();
    expect((await handle(request("GET", "/sync/BAD_ID"), e)).status).toBe(400);
    expect((await handle(request("PUT", "/sync/dev-1665859d9737", { body: "<!doctype html>" }), e)).status).toBe(400);
    expect((await handle(request("GET", "/sync/dev-0000000000"), e)).status).toBe(404);
    expect((await handle(request("DELETE", "/sync/dev-1665859d9737"), e)).status).toBe(405);
  });
});

describe("the token is the lock, because this one is on the open internet", () => {
  it("no token → 401, and nothing is written", async () => {
    const e = env();
    const put = await handle(request("PUT", "/sync/dev-1665859d9737", { body: "{}", token: null }), e);
    expect(put.status).toBe(401);
    expect(e.MAILBOX.data.size).toBe(0);
    expect((await handle(request("GET", "/sync/", { token: null }), e)).status).toBe(401);
  });

  it("a wrong token → 401, including one that shares a prefix", async () => {
    const e = env();
    expect((await handle(request("GET", "/sync/", { token: "wrong" }), e)).status).toBe(401);
    expect((await handle(request("GET", "/sync/", { token: `${TOKEN}x` }), e)).status).toBe(401);
    expect((await handle(request("GET", "/sync/", { token: TOKEN.slice(0, -1) }), e)).status).toBe(401);
  });

  it("an empty configured token locks everything rather than opening it", async () => {
    const e = { ...env(), MAILBOX_TOKEN: "" };
    expect((await handle(request("GET", "/sync/", { token: "" }), e)).status).toBe(401);
  });

  it("/ping answers without a token and says nothing about what is stored", async () => {
    const response = await handle(request("GET", "/ping", { token: null }), env());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hashigo mailbox is up\n");
  });
});

describe("CORS, because the app is served from the laptop and this from workers.dev", () => {
  it("answers the preflight for an allowed origin, with the auth header allowed", async () => {
    const response = await handle(request("OPTIONS", "/sync/", { token: null }), env());
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
  });

  it("grants nothing to an origin that is not his", async () => {
    const response = await handle(request("GET", "/sync/", { origin: "https://evil.example" }), env());
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

// ─── /generate/ on the Worker ────────────────────────────────────────────────

import { generate, parse } from "../cloud/mailbox/src/generate.js";

describe("generation on the Worker answers like the laptop, and keeps what it makes", () => {
  const fakeSpeech = async (): Promise<Uint8Array> => new Uint8Array([0xff, 0xfb, 1, 2, 3]);
  let calls = 0;
  const countedSpeech = async (): Promise<Uint8Array> => {
    calls += 1;
    return fakeSpeech();
  };

  it("makes a clip in the field's catalogue voice, keeps it, and answers the second press from KV", async () => {
    calls = 0;
    const e = { ...env(), GOOGLE_TTS_SECRET: "g" };
    const request = parse({ kind: "speech", text: "日向", lang: "ja-JP", voice: "ja-JP-Neural2-B", options: {} });
    expect(typeof request).not.toBe("string");
    const [status, body] = await generate(request as never, e, { synthesise: countedSpeech });
    expect(status).toBe(200);
    expect(body).toMatchObject({ cached: false, voice: "ja-JP-Neural2-B", mime: "audio/mpeg" });
    expect([...e.MAILBOX.data.keys()].filter((k) => k.startsWith("gen:"))).toHaveLength(1);

    const [, again] = await generate(request as never, e, { synthesise: countedSpeech });
    expect(again).toMatchObject({ cached: true });
    expect(calls).toBe(1); // the second press billed nothing
  });

  it("an AZURE voice Mochi stored is spoken in the language's fill voice, and the record says who spoke", async () => {
    const e = { ...env(), GOOGLE_TTS_SECRET: "g" };
    const request = parse({ kind: "speech", text: "snare", lang: "en-US", voice: "en-US-AIGenerate1Neural", options: { gender: "male" } });
    const [, body] = await generate(request as never, e, { synthesise: fakeSpeech });
    expect(body).toMatchObject({ voice: "en-US-Neural2-D" });
    const stored = JSON.parse([...e.MAILBOX.data.values()][0]?.value ?? "{}") as { voice: string; options: unknown };
    expect(stored.voice).toBe("en-US-Neural2-D");
    expect(stored.options).toEqual({ gender: "male" });
  });

  it("refuses to speak a raw generator tag — the snare bug, on this side too", async () => {
    const e = { ...env(), GOOGLE_TTS_SECRET: "g" };
    const request = parse({ kind: "speech", text: "<ai>Example sentence of snare</ai>", lang: "en-US", voice: null, options: {} });
    const [status] = await generate(request as never, e, { synthesise: fakeSpeech });
    expect(status).toBe(422);
  });

  it("a preview stores nothing", async () => {
    const e = { ...env(), GOOGLE_TTS_SECRET: "g" };
    const [status] = await generate(parse({ kind: "speech", preview: true, voice: "en-US-Neural2-J" }) as never, e, { synthesise: fakeSpeech });
    expect(status).toBe(200);
    expect(e.MAILBOX.data.size).toBe(0);
  });

  it("text is generated once and then served from KV", async () => {
    let asked = 0;
    const e = { ...env(), ANTHROPIC_API_KEY: "a" };
    const write = async (): Promise<string> => {
      asked += 1;
      return "☀️🌳";
    };
    const request = parse({ kind: "ai", text: "Describe a word 日向 using emojis only", lang: null, voice: null, options: {} });
    const [, first] = await generate(request as never, e, { generateText: write });
    const [, second] = await generate(request as never, e, { generateText: write });
    expect(first).toMatchObject({ text: "☀️🌳", cached: false });
    expect(second).toMatchObject({ text: "☀️🌳", cached: true });
    expect(asked).toBe(1);
  });

  it("says which secret is missing rather than failing somewhere inside", async () => {
    const [status, body] = await generate(parse({ kind: "speech", text: "x", lang: "ja-JP", voice: null, options: {} }) as never, env());
    expect(status).toBe(503);
    expect(body).toMatchObject({ error: expect.stringContaining("GOOGLE_TTS_SECRET") });
  });

  it("the route needs the key like everything else", async () => {
    const response = await handle(request("POST", "/generate/", { body: "{}", token: null }), env());
    expect(response.status).toBe(401);
  });
});
