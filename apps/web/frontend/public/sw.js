/*
 * ScanList service worker — deliberately tiny, no build-time workbox, no asset manifest.
 *
 * Policy (card C2): cache-first for the app shell, network for data.
 *  - shell  = navigations, same-origin JS/CSS/images/fonts/manifest: serve the cached copy and
 *             refresh it in the background (stale-while-revalidate). Vite's hashed chunk names make
 *             this safe: a new build links new file names, so a stale chunk is never referenced by
 *             the freshly fetched index.html.
 *  - data   = /embed/*, /off/*, /health, /docs and every cross-origin request: straight to the
 *             network, never cached. Ranking data must always be live.
 *  - offline navigation falls back to the cached index.html.
 */

const CACHE = "scanlist-shell-v1";

// Both paths are stable: Vite copies public/ verbatim, so no build step is needed here.
const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isDataRequest(url) {
  return (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/embed/") ||
    url.pathname.startsWith("/off/") ||
    url.pathname === "/health" ||
    url.pathname === "/docs" ||
    url.pathname.startsWith("/openapi")
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (isDataRequest(url)) return; // default fetch: network only

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const refreshed = fetch(request)
        .then((response) => {
          // Opaque/error responses are not worth caching; ok responses refresh the shell.
          if (response.ok && response.type === "basic") cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(refreshed.then(() => undefined));
        return cached;
      }

      const fresh = await refreshed;
      if (fresh) return fresh;

      if (request.mode === "navigate") {
        const shell = await cache.match("/index.html");
        if (shell) return shell;
      }
      return Response.error();
    }),
  );
});
