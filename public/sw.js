/* Minimal service worker: enables installability without aggressive caching.
   We intentionally avoid caching to prevent stale asset issues.
*/
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through network; browser/proxy caching handled elsewhere.
});
