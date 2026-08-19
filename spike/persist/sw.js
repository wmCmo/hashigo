/*
 * THROWAWAY (spike harness) — spike/persist/sw.js
 *
 * A service worker that caches NOTHING. It exists for exactly one reason: to
 * make `/persist/` installable, because Chrome's storage-persistence heuristic
 * treats an installed PWA very differently from a tab, and that difference is
 * what the phone test is for.
 *
 * Caching is deliberately absent. A cache here would sit in the same origin
 * quota as OPFS and would make the `estimate()` numbers this spike prints
 * mean something other than "the database and the audio".
 */

self.addEventListener("install", () => {
  // Take over immediately; there is no old version whose data matters.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A fetch handler is what historically made a page installable. It is a
// pass-through on purpose: every request goes straight to the network.
self.addEventListener("fetch", () => {
  // Intentionally empty: not calling event.respondWith() means "browser, you
  // handle it exactly as you would have without me".
});
