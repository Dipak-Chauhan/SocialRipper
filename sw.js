const CACHE_NAME = 'social-ripper-shell-v7';
const SHELL_ASSETS = [
  '/',
  '/social-ripper.css?v=14',
  '/app.js?v=9',
  '/manifest.webmanifest',
  '/icons/icon-192.png?v=3',
  '/icons/icon-512.png?v=3',
  '/icons/icon-maskable-512.png?v=3',
  '/icons/apple-touch-icon.png?v=3'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS.map((asset) => new Request(asset, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('social-ripper-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (url.pathname === '/' && !url.search && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request)
          .then((response) => {
            if (response.ok) {
              cache.put(event.request, response.clone()).catch(() => {});
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    )
  );
});
