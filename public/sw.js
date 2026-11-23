// Minimal service worker: makes Blomp installable. No offline caching on purpose,
// because every screen shows live Kane results that must never be stale.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
