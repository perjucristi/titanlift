const CACHE_NAME = 'titanlift-cloud-v13';
const CORE_ASSETS = [
  './',
  './index.html',
  './cloud.js',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS).catch(() => {});
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Nu atinge cererile de scriere/trimitere (POST) către Firebase sau Web3Forms
  if (event.request.method !== 'GET') return;

  // Nu atinge NICIODATĂ serverele externe (Firebase, Google, Web3Forms, CDN-uri)
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Pentru fișierele aplicației tale: ia mereu versiunea cea mai nouă de pe net,
  // iar dacă ești offline la sală, încarcă copia salvată în telefon.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});