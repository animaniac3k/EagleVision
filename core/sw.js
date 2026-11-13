const CACHE_NAME = 'spotr-v61';
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
  './js/audio/voiceManifest.js',
  './js/audio/voiceAudioEngine.js',
  './js/recorder/memoryRingBuffer.js',
  './js/recorder/instantReplay.js',
  './js/storage/videoStore.js',
  './js/storage/settingsStore.js',
  './js/ui/hudController.js',
  './js/ui/sidebarControls.js',
  './js/ui/videoBrowser.js',
  './js/ui/reticleScreen.js',
  './js/ui/controllerScreen.js',
  './js/ui/ringController.js',
  './js/ui/splashScreen.js',
  './js/input/gamepadController.js',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/audio/voice-sprite.mp3'
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

function fetchWithTimeout(request, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal })
    .then((res) => {
      clearTimeout(timeoutId);
      return res;
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      throw err;
    });
}

// Cache-First strategy with Stale-While-Revalidate for robust offline & camera Wi-Fi operation
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }

  // Bypass service worker caching for RTSP live streams and local API endpoints
  const reqUrl = new URL(event.request.url);
  if (reqUrl.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      // 1. If asset is in cache, serve immediately (0ms instant boot, works offline on camera Wi-Fi)
      if (cachedResponse) {
        // In the background, refresh cache only if browser reports internet connectivity
        if (navigator.onLine) {
          fetch(event.request)
            .then((networkResponse) => {
              if (
                networkResponse &&
                networkResponse.status === 200 &&
                (networkResponse.type === 'basic' || networkResponse.type === 'cors')
              ) {
                const clone = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
              }
            })
            .catch(() => {});
        }
        return cachedResponse;
      }

      // 2. Navigation fallback for PWA home-screen launches or reloads when offline
      if (event.request.mode === 'navigate' || event.request.destination === 'document') {
        return caches.match('./index.html', { ignoreSearch: true }).then((indexCached) => {
          if (indexCached) return indexCached;
          return caches.match('./', { ignoreSearch: true }).then((rootCached) => {
            if (rootCached) return rootCached;
            return fetchWithTimeout(event.request, 2500);
          });
        });
      }

      // 3. Fallback to network with short timeout so requests never hang when on local camera Wi-Fi without internet
      return fetchWithTimeout(event.request, 2500)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            (networkResponse.type === 'basic' || networkResponse.type === 'cors')
          ) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request, { ignoreSearch: true }));
    })
  );
});
