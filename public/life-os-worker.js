"use strict";
// Install support only. No fetch interception, offline content or private cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
