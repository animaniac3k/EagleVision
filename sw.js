const CACHE_NAME = 'spotr-v19';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/variables.css',
  './css/layout.css',
  './css/viewport.css',
  './css/controls.css',
  './css/gallery.css',
  './js/main.js',
  './js/state.js',
  './js/camera/streamManager.js',
  './js/camera/streamStats.js',
  './js/renderer/compositor.js',
  './js/renderer/zoomWindow.js',
  './js/renderer/imageFilters.js',
  './js/renderer/overlayManager.js',
  './js/recorder/memoryRingBuffer.js',
  './js/recorder/instantReplay.js',
  './js/storage/videoStore.js',
  './js/storage/settingsStore.js',
  './js/ui/hudController.js',
  './js/ui/sidebarControls.js',
  './js/ui/videoBrowser.js',
  './js/ui/reticleScreen.js',
  './js/ui/ringController.js',
  './js/ui/splashScreen.js',
  './js/input/gamepadController.js',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first strategy so updates load immediately, with offline cache fallback
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
