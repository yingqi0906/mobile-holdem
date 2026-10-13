/**
 * Service Worker：让这个网页能"装到主屏"并且离线可玩。
 *
 * 策略是「网络优先 + 缓存兜底」，而不是常见的缓存优先。
 * 原因：这是个几十 KB 的游戏，走网络的开销可以忽略，但缓存优先会让
 * 改完代码之后老用户一直看到旧版本 —— 改样式时踩过一次这个坑。
 *
 * 联机时：每次都取最新，顺便刷新缓存。
 * 断网时：回退到缓存，游戏照样能玩。
 */

const CACHE = 'holdem-v2';

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
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const shell = await caches.match('./index.html');
        if (shell) return shell;
        return new Response('离线，且本地没有缓存。', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      })
  );
});
