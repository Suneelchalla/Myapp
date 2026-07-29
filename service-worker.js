// =============================================================================
//  Ripple service worker — offline app shell.
//  Bump CACHE_VERSION whenever you deploy new frontend files.
// =============================================================================
const CACHE_VERSION = "ripple-v9";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/config.js",
  "./js/api.js",
  "./js/db.js",
  "./js/app.js",
  "./js/lock.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/favicon-32.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                 // never cache POSTs (all API traffic)

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let cross-origin (Apps Script API) pass through

  // Navigations: serve cached shell when offline (SPA fallback).
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }

  // Static same-origin assets: cache-first, then network (and cache the result).
  event.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached)
    )
  );
});
