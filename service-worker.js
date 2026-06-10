'use strict';

const CACHE_VERSION = 'vault-cache-v2';
const STATIC_CACHE_NAME = `${CACHE_VERSION}-static`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

function normalizeRequestUrl(requestUrl) {
  const url = new URL(requestUrl);
  const path = url.pathname;

  if (path.endsWith('/icons/icon-192-maskable.png')) {
    return './icons/icon-192-maskable.png';
  }
  if (path.endsWith('/icons/icon-512-maskable.png')) {
    return './icons/icon-512-maskable.png';
  }
  if (path.endsWith('/icons/icon-192.png')) {
    return './icons/icon-192.png';
  }
  if (path.endsWith('/icons/icon-512.png')) {
    return './icons/icon-512.png';
  }
  if (path.endsWith('/manifest.json')) {
    return './manifest.json';
  }
  if (path.endsWith('/app.js')) {
    return './app.js';
  }
  if (path.endsWith('/styles.css')) {
    return './styles.css';
  }
  if (path.endsWith('/index.html') || path.endsWith('/')) {
    return './index.html';
  }

  return null;
}

self.addEventListener('install', function onInstall(event) {
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME).then(function onCacheOpen(cache) {
      return cache.addAll(STATIC_ASSETS);
    }).then(function onInstalled() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function onActivate(event) {
  event.waitUntil(
    caches.keys().then(function onCacheKeys(cacheNames) {
      const deletionPromises = cacheNames.map(function onEachCacheName(cacheName) {
        if (cacheName.startsWith('vault-cache-') && cacheName !== STATIC_CACHE_NAME) {
          return caches.delete(cacheName);
        }
        return Promise.resolve(false);
      });
      return Promise.all(deletionPromises);
    }).then(function onCleanupComplete() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function onFetch(event) {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);

  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  const normalizedPath = normalizeRequestUrl(request.url);

  if (!normalizedPath) {
    return;
  }

  event.respondWith(
    caches.match(normalizedPath).then(function onCacheMatch(cachedResponse) {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then(function onNetworkResponse(networkResponse) {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'error') {
          return networkResponse;
        }

        const responseClone = networkResponse.clone();

        caches.open(STATIC_CACHE_NAME).then(function onCacheOpen(cache) {
          cache.put(normalizedPath, responseClone);
        });

        return networkResponse;
      }).catch(function onFetchError() {
        return caches.match('./index.html');
      });
    })
  );
});
