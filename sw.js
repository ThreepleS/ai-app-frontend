// PWA service worker: network-first everywhere so updates are picked up
// immediately; the cache is only used as an offline fallback.
// Cache version bump invalidates previously cached shells.
const CACHE = "ai-app-shell-v9";
const SHELL = ["./", "./index.html", "./admin.html", "./style.css", "./admin.css", "./admin.js", "./marked.min.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

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
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Кросс-доменные запросы (например API на туннеле) не трогаем — отдаём сети.
  if (url.origin !== self.location.origin) {
    return;
  }
  // Never cache API responses or navigation/page requests — always go to network.
  if (url.pathname.startsWith("/api/") || event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request)),
    );
    return;
  }
  // Static assets: network-first, fall back to cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
