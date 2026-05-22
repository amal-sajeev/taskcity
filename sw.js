const CACHE = 'citylog-v10';

// The static app shell. Everything the frontend loads at boot lives here.
// No third-party CDNs anymore (apart from the Google Fonts the document
// references directly, which the browser handles independently). The API
// routes are NEVER cached.
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './css/reset.css',
  './css/variables.css',
  './css/layout.css',
  './css/skyline.css',
  './css/sheet.css',
  './css/panels.css',
  './css/modals.css',
  './css/hud.css',
  './css/tabbar.css',
  './css/views.css',
  './css/stats.css',
  './css/animations.css',
  './css/auth.css',
  './js/main.js',
  './js/store.js',
  './js/sheet.js',
  './js/ui.js',
  './js/tasks.js',
  './js/buildings.js',
  './js/skyline.js',
  './js/layout.js',
  './js/modals.js',
  './js/districts.js',
  './js/toast.js',
  './js/spring.js',
  './js/swipe.js',
  './js/audio.js',
  './js/settings.js',
  './js/keyboard.js',
  './js/router.js',
  './js/stats.js',
  './js/sync.js',
  './js/auth.js',
  './js/api.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // /api/* is dynamic, per-user, and must never be cached. Let the browser
  // talk straight to the network so cookies + freshness are honored.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return;
  }

  // Other cross-origin (Google Fonts, etc.): network-first with cache fallback.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // Same-origin app shell: cache-first, with network refill on miss.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
