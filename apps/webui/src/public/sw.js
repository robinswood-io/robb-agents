self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// Remote sessions require the host to be online. Keep requests network-only so
// authenticated session data is never persisted in a service-worker cache.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
