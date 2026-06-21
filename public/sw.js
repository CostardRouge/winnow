/*
 * Winnow service worker.
 *
 * Winnow is a NAS-backed media tool: most payloads (RAW thumbnails, video
 * proxies, downloads, JSON from /api) are large and/or volatile, so the worker
 * deliberately caches very little. Its jobs are:
 *   1. make the app installable (a fetch handler + the manifest),
 *   2. serve the static app shell fast (Next.js build assets, icons),
 *   3. show a graceful offline page when a navigation can't reach the network.
 *
 * It never caches /api responses or media bytes — those always hit the network.
 */

const VERSION = "v1";
const STATIC_CACHE = `winnow-static-${VERSION}`;
const SHELL_CACHE = `winnow-shell-${VERSION}`;
const OFFLINE_URL = "/offline.html";

// Minimal precache: just enough to render *something* offline.
const PRECACHE = [
  OFFLINE_URL,
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key !== STATIC_CACHE && key !== SHELL_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Allow the page to trigger an immediate activation after an update.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isMediaOrApi(url) {
  // Dynamic, large, or sensitive — never served from cache.
  return (
    url.pathname.startsWith("/api/") ||
    /\/(thumb|proxy|download)(\b|\/|$)/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET, only same-origin; everything else is a straight passthrough.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isMediaOrApi(url)) return;

  // Navigations: network-first, fall back to cache, then the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached || caches.match(OFFLINE_URL);
        }),
    );
    return;
  }

  // Static build assets & icons: stale-while-revalidate for instant loads.
  const isStatic =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    /\.(?:css|js|woff2?|png|svg|ico|webmanifest)$/.test(url.pathname);

  if (isStatic) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
