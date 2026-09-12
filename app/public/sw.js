/*
 * The service worker. Two jobs, and the second one is the real one.
 *
 * 1. It makes the app INSTALLABLE. Samsung Internet, like every Chromium
 *    browser, wants a manifest plus a service worker with a fetch handler
 *    before it will offer "add to home screen" with the app's own icon.
 *
 * 2. IT IS WHAT MAKES THE OFFLINE PROMISE TRUE. This is the part that is easy
 *    to miss. The database and the audio already live on the device in OPFS —
 *    but `index.html`, the module graph and the fonts do not, so without this
 *    file, opening Hashigo on a train gets you a browser error page and 300 MB
 *    of perfectly good study material you cannot reach. The shell is a few
 *    hundred KB. Caching it is the difference between "local-first" as a claim
 *    and as a fact.
 *
 * ─── WHAT IT MUST NEVER CACHE, AND WHY THAT IS NOT A DETAIL ─────────────────
 *
 * `/hashigo-app.db` is ~73 MB and `/hashigo-app-blobs.db` is ~224 MB. They are
 * fetched ONCE, into OPFS, and never read over the network again. A Cache
 * Storage copy would:
 *
 *   · sit in the SAME origin quota as OPFS, so the app would hold ~600 MB to
 *     use ~300 MB — on a phone, that is the difference between fitting and
 *     being evicted, and decision 17 exists because eviction is a real event
 *     here (it has happened to him once already);
 *   · break the download progress bar, which reads `Content-Length` and streams;
 *   · interfere with range requests.
 *
 * `/hashigo-app.json` is small and MUST be live: it is the seed manifest, and
 * `db.worker.ts` compares its review count against what OPFS holds to decide
 * whether the server has a newer seed. A cached copy makes a stale database
 * look current, which is the one lie this app cannot afford.
 *
 * So all three are passed straight through, untouched.
 *
 * ─── NETWORK-FIRST, NOT CACHE-FIRST ─────────────────────────────────────────
 *
 * Cache-first is faster and wrong here. Vite emits hashed asset names in a
 * build, but `index.html` is not hashed, and a cache-first shell is how a PWA
 * gets stuck on a version from three weeks ago with no way for the user to tell.
 * Network-first with a cache fallback costs one round trip when online and is
 * always current; offline it serves the last thing that worked.
 */

/*
 * ─── THE PRECACHE LIST IS WRITTEN BY THE BUILD, AND HAS TO BE ───────────────
 *
 * Runtime caching alone is NOT enough for a real offline promise, and the way it
 * fails is quiet. It only ever stores what actually crossed the network, so an
 * asset the browser happened to serve from its own memory or HTTP cache is never
 * seen by this worker — measured 2026-09-12, when the shell and the CSS were
 * cached and `fraunces-latin.woff2` was not, purely because that load did not
 * re-request it. The hole only shows up on the train.
 *
 * A build cannot be listed here by hand either: Vite hashes every asset name.
 * So `vite.app.config.ts` prepends the real list to this file at build time, and
 * the fallbacks below are what dev uses (where names are stable and runtime
 * caching is sufficient).
 */
const VERSION = self.__HASHIGO_VERSION__ ?? "hashigo-shell-dev";
const PRECACHE = self.__HASHIGO_PRECACHE__ ?? ["/"];

/** Fetched straight from the network, never stored. See the header. */
const NEVER_CACHE = new Set(["/hashigo-app.db", "/hashigo-app-blobs.db", "/hashigo-app.json"]);

/** Vite's dev-server plumbing. Caching any of it would serve a dead module
 *  graph after a restart, and none of it exists in a build. */
function isDevPlumbing(pathname, search) {
  return (
    pathname.startsWith("/@vite/") ||
    pathname.startsWith("/@fs/") ||
    pathname.startsWith("/@id/") ||
    pathname.startsWith("/node_modules/") ||
    // HMR cache-busting. Anchored, because a bare `includes("t=")` also matches
    // innocent queries like `?sort=name`.
    /[?&]t=\d/.test(search) ||
    /[?&]import(&|=|$)/.test(search)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) =>
        // NOT `addAll`: it is atomic, so one 404 throws away the whole precache
        // and the app silently loses offline support. Each URL is stored on its
        // own and a miss costs only that file.
        Promise.all(
          PRECACHE.map((url) =>
            cache.add(new Request(url, { cache: "reload" })).catch(() => undefined),
          ),
        ),
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
  // The page asks for this after it has told the user an update is waiting.
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.has(url.pathname)) return;
  if (isDevPlumbing(url.pathname, url.search)) return;
  // A ranged request is a media seek. Let the browser own it.
  if (request.headers.has("range")) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        // Opaque and error responses are not worth keeping, and caching a 404
        // shell is how an app serves its own error page offline forever.
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          void caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      } catch (networkError) {
        const cached = await caches.match(request);
        if (cached !== undefined) return cached;
        // A navigation that misses the cache still gets the shell — the app is
        // a single page, so any route it owns is served by the same document.
        if (request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell !== undefined) return shell;
        }
        throw networkError;
      }
    })(),
  );
});
