/* 波波酪梨 · 酪梨行情  sw.js  v1.0.1
 * 改版時務必更新 CACHE 名稱，否則舊快取不會被淘汰。
 * 快取名稱刻意用 probro-market- 前綴，與出貨通知的 probro-ship- 區隔，
 * 兩支 App 部署在同一個網域底下也不會互相清掉對方的快取。
 */
const CACHE = 'probro-market-v1.0.1';

const ASSETS = [
  './', './index.html', './app.js', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-512-maskable.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(ASSETS.map(u => c.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('probro-market-') && k !== CACHE)
          .map(k => caches.delete(k))
    );
    self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 行情 API 永遠走網路，絕不快取：資料新舊由 App 用 fetchedAt 管理並顯示，
  // 離線時的退路是 localStorage，不是 SW 快取。
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      e.waitUntil((async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
        } catch (err) { /* 離線 */ }
      })());
      return cached;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
      return fresh;
    } catch (err) {
      const fb = await caches.match('./index.html');
      return fb || new Response('離線且沒有快取', { status: 503 });
    }
  })());
});
