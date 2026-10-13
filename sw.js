/**
 * Service Worker：让这个网页可以"装到主屏"并离线打开。
 *
 * 单机版没有任何后端请求，所以策略很简单：静态资源全部走缓存优先，
 * 后台顺便更新缓存。改样式后如果没生效，把 CACHE 版本号 +1 即可。
 */

const CACHE = 'holdem-v1';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/main.css',
  './src/ui/app.js',
  './src/core/engine.js',
  './src/core/evaluator.js',
  './src/core/cards.js',
  './src/core/ai.js',
  './src/core/rng.js',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => {});
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
