import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { handleApp, makeCookie, unlocked, type AppEnv } from "../cloud/app/src/app.js";

/**
 * The app Worker — the whole of Hashigo from one public origin — tested before it
 * is deployed. Two properties carry the weight:
 *
 *   1. NOTHING behind the lock is reachable without the cookie: not the app, not
 *      the seed (his cards and audio), not the mailbox (his review history).
 *   2. The 674 MB audio database, uploaded in parts, arrives as ONE file whose
 *      bytes and declared length are exactly the original's.
 */

const PASSPHRASE = "ladder-kite-orbit-mango";

function r2(objects: Record<string, Uint8Array | string>) {
  const bytes = (value: Uint8Array | string): Uint8Array =>
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return {
    async get(key: string) {
      const value = objects[key];
      if (value === undefined) return null;
      const data = bytes(value);
      return { body: new Response(data as BodyInit).body as ReadableStream<Uint8Array>, size: data.length };
    },
    async head(key: string) {
      const value = objects[key];
      return value === undefined ? null : { size: bytes(value).length };
    },
  };
}

function env(objects: Record<string, Uint8Array | string> = {}): AppEnv {
  return {
    MAILBOX: {
      async get() {
        return null;
      },
      async put() {},
      async list() {
        return { keys: [], list_complete: true };
      },
    },
    MAILBOX_TOKEN: "unused-bearer",
    ALLOWED_ORIGINS: "",
    SEED: r2(objects),
    ASSETS: { fetch: async () => new Response("<!doctype html><title>app</title>", { headers: { "Content-Type": "text/html" } }) },
    UNLOCK_HASH: createHash("sha256").update(PASSPHRASE).digest("hex"),
    COOKIE_KEY: "cookie-key-for-tests",
  };
}

const BASE = "https://hashigo.titan-zp4.workers.dev";

function get(path: string, cookie?: string, accept = "*/*"): Request {
  return new Request(`${BASE}${path}`, { headers: { Accept: accept, ...(cookie === undefined ? {} : { Cookie: cookie }) } });
}

async function cookieFor(e: AppEnv): Promise<string> {
  const response = await handleApp(
    new Request(`${BASE}/unlock`, {
      method: "POST",
      body: new URLSearchParams({ passphrase: PASSPHRASE }),
    }),
    e,
  );
  expect(response.status).toBe(303);
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
}

describe("nothing behind the lock without the cookie", () => {
  it("a page visit is sent to /unlock", async () => {
    const response = await handleApp(get("/", undefined, "text/html"), env());
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${BASE}/unlock`);
  });

  it("the seed, the mailbox and generation are 401 — never a page", async () => {
    const e = env({ "hashigo-app.db": "sqlite" });
    for (const path of ["/hashigo-app.db", "/sync/", "/generated/"]) {
      const response = await handleApp(get(path), e);
      expect(response.status, path).toBe(401);
      expect(response.headers.get("Content-Type"), path).toMatch(/json/);
    }
  });

  it("a wrong passphrase sets no cookie", async () => {
    const response = await handleApp(
      new Request(`${BASE}/unlock`, { method: "POST", body: new URLSearchParams({ passphrase: "nope" }) }),
      env(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("the right passphrase unlocks everything, with an HttpOnly Secure cookie", async () => {
    const e = env({ "hashigo-app.db": "sqlite-bytes" });
    const response = await handleApp(
      new Request(`${BASE}/unlock`, { method: "POST", body: new URLSearchParams({ passphrase: PASSPHRASE }) }),
      e,
    );
    expect(response.headers.get("Set-Cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const cookie = await cookieFor(e);
    expect((await handleApp(get("/", cookie, "text/html"), e)).status).toBe(200);
    expect(await (await handleApp(get("/hashigo-app.db", cookie), e)).text()).toBe("sqlite-bytes");
  });

  it("a forged or expired cookie is refused", async () => {
    const e = env();
    expect(await unlocked(get("/", "hashigo_unlock=99999999999999.deadbeef"), e)).toBe(false);
    const old = (await makeCookie(e, Date.now() - 500 * 24 * 60 * 60 * 1000)).split(";")[0] as string;
    expect(await unlocked(get("/", old), e)).toBe(false);
    const good = (await makeCookie(e)).split(";")[0] as string;
    expect(await unlocked(get("/", good), e)).toBe(true);
    expect(await unlocked(get("/", good), { ...e, COOKIE_KEY: "rotated" })).toBe(false);
  });

  it("/ping and /unlock stay open, and say nothing about what is stored", async () => {
    expect(await (await handleApp(get("/ping"), env())).text()).toBe("hashigo is up\n");
    expect((await handleApp(get("/unlock", undefined, "text/html"), env())).status).toBe(200);
  });
});

describe("every seed file is ONE stored object, served with its length", () => {
  it("serves a stored file whole, with Content-Length — the Worker never touches the bytes", async () => {
    const whole = new Uint8Array(3_000_000).map((_, index) => (index * 7) % 251);
    const e = env({ "hashigo-app-blobs.db": whole });
    const response = await handleApp(get("/hashigo-app-blobs.db", await cookieFor(e)), e);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(whole.length));
    const got = new Uint8Array(await response.arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(createHash("sha256").update(whole).digest("hex"));
  });

  it("a seed file that was never uploaded is a clear 404", async () => {
    const e = env();
    const response = await handleApp(get("/hashigo-app-gen.db", await cookieFor(e)), e);
    expect(response.status).toBe(404);
    expect(await response.text()).toMatch(/cloud-seed-upload/);
  });
});

describe("the multipart upload route — how a 674 MB file gets in", () => {
  function multipartR2() {
    const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array>; done?: Uint8Array }>();
    let next = 0;
    const handle = (key: string, uploadId: string) => ({
      uploadId,
      async uploadPart(partNumber: number, body: ReadableStream<Uint8Array> | ArrayBuffer) {
        const bytes = new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
        uploads.get(uploadId)?.parts.set(partNumber, bytes);
        return { partNumber, etag: `etag-${partNumber}` };
      },
      async complete(parts: readonly { partNumber: number }[]) {
        const entry = uploads.get(uploadId);
        if (entry === undefined) throw new Error("no upload");
        const chunks = parts.map((part) => entry.parts.get(part.partNumber) as Uint8Array);
        entry.done = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
        return {};
      },
      async abort() {
        uploads.delete(uploadId);
      },
      key,
    });
    return {
      uploads,
      async get() {
        return null;
      },
      async head() {
        return null;
      },
      async createMultipartUpload(key: string) {
        const uploadId = `u${(next += 1)}`;
        uploads.set(uploadId, { key, parts: new Map() });
        return handle(key, uploadId);
      },
      resumeMultipartUpload(key: string, uploadId: string) {
        return handle(key, uploadId);
      },
    };
  }

  const admin = (method: string, path: string, body?: BodyInit, token = "unused-bearer"): Request =>
    new Request(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body }),
    });

  it("refuses without the bearer key — the cookie is not enough to write the seed", async () => {
    const e = { ...env(), SEED: multipartR2() };
    const cookie = await cookieFor(e);
    const withCookie = await handleApp(
      new Request(`${BASE}/admin/multipart/create?key=hashigo-app-blobs.db`, { method: "POST", headers: { Cookie: cookie } }),
      e,
    );
    expect(withCookie.status).toBe(401);
    expect((await handleApp(admin("POST", "/admin/multipart/create?key=hashigo-app-blobs.db", undefined, "wrong"), e)).status).toBe(401);
  });

  it("refuses a key outside the seed's names", async () => {
    const e = { ...env(), SEED: multipartR2() };
    expect((await handleApp(admin("POST", "/admin/multipart/create?key=../evil"), e)).status).toBe(400);
  });

  it("create → parts → complete joins the parts into one object, in order", async () => {
    const bucket = multipartR2();
    const e = { ...env(), SEED: bucket };
    const created = (await (await handleApp(admin("POST", "/admin/multipart/create?key=hashigo-app-blobs.db"), e)).json()) as { uploadId: string };
    const one = new Uint8Array([1, 2, 3]);
    const two = new Uint8Array([4, 5]);
    const parts = [];
    for (const [index, bytes] of [one, two].entries()) {
      const response = await handleApp(
        admin("PUT", `/admin/multipart/part?key=hashigo-app-blobs.db&uploadId=${created.uploadId}&part=${index + 1}`, bytes as BodyInit),
        e,
      );
      parts.push(await response.json());
    }
    const done = await handleApp(
      admin("POST", `/admin/multipart/complete?key=hashigo-app-blobs.db&uploadId=${created.uploadId}`, JSON.stringify(parts)),
      e,
    );
    expect(done.status).toBe(200);
    expect([...(bucket.uploads.get(created.uploadId)?.done ?? [])]).toEqual([1, 2, 3, 4, 5]);
  });
});
