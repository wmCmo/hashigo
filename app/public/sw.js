const VERSION = self.__HASHIGO_VERSION__ ?? "hashigo-shell-dev";
const PRECACHE = self.__HASHIGO_PRECACHE__ ?? ["/"];

const NEVER_CACHE = new Set([
  "/hashigo-app.db",
  "/hashigo-app-gen.db",
  "/hashigo-app-fields.db",
  "/hashigo-app-blobs.db",
  "/hashigo-app.json",
  "/version.json",
]);

function isMailbox(pathname) {
  return pathname === "/sync" || pathname.startsWith("/sync/");
}

function isDevPlumbing(pathname, search) {
  return (
    pathname.startsWith("/@vite/") ||
    pathname.startsWith("/@fs/") ||
    pathname.startsWith("/@id/") ||
    pathname.startsWith("/node_modules/") ||
    /[?&]t=\d/.test(search) ||
    /[?&]import(&|=|$)/.test(search)
  );
}

function isHashedAsset(url) {
  return new URL(url, self.location.origin).pathname.startsWith("/assets/");
}

async function precacheOne(cache, url) {
  if (isHashedAsset(url)) {
    const held = await caches.match(url);
    if (held !== undefined && held.ok && !isHtml(held)) {
      await cache.put(url, held);
      return;
    }
  }
  await cache.add(new Request(url, { cache: "reload" }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) =>
        Promise.all(PRECACHE.map((url) => precacheOne(cache, url).catch(() => undefined))),
      )
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

const NETWORK_WAIT_MS = 3000;

function keep(request, response) {
  if (!response.ok || response.type !== "basic") return;
  const copy = response.clone();
  void caches.open(VERSION).then((cache) => cache.put(request, copy));
}

function isHtml(response) {
  return (response.headers.get("content-type") ?? "").includes("text/html");
}

async function assetFirst(request) {
  const cached = await caches.match(request);
  if (cached !== undefined && !isHtml(cached)) return cached;
  if (cached !== undefined) void caches.open(VERSION).then((cache) => cache.delete(request));
  const response = await fetch(request);
  if (!isHtml(response)) keep(request, response);
  return response;
}

async function fromCache(request) {
  const cached = await caches.match(request);
  if (cached !== undefined) return cached;
  if (request.mode === "navigate") return caches.match("/");
  return undefined;
}

async function networkFirst(request) {
  const network = fetch(request).then((response) => {
    keep(request, response);
    return response;
  });
  const deadline = new Promise((resolve) => setTimeout(() => resolve("late"), NETWORK_WAIT_MS));
  try {
    const first = await Promise.race([network, deadline]);
    if (first !== "late") return first;
    const stored = await fromCache(request);
    if (stored !== undefined) {
      network.catch(() => undefined);
      return stored;
    }
    return await network;
  } catch (networkError) {
    const stored = await fromCache(request);
    if (stored !== undefined) return stored;
    throw networkError;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.has(url.pathname)) return;
  if (isMailbox(url.pathname)) return;
  if (url.pathname === "/ping") return;
  if (isDevPlumbing(url.pathname, url.search)) return;
  if (request.headers.has("range")) return;

  event.respondWith(
    url.pathname.startsWith("/assets/") ? assetFirst(request) : networkFirst(request),
  );
});
