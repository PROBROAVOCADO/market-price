/* 波波酪梨 · 農產行情  sw.js  v1.5.0
 * 改版時務必更新 CACHE 名稱，否則舊快取不會被淘汰。
 * 快取名稱用 probro-market- 前綴，與出貨通知的 probro-ship- 區隔。
 */
const CACHE = 'probro-market-v1.5.0';

const ASSETS = [
  './', './index.html', './app.js', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-512-maskable.png'
];

/* 字型走 Google Fonts，離線時要靠快取，所以這兩個網域破例納管。
   行情 API 不在此列——資料新舊由 App 用 fetchedAt 管理。 */
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

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

  const url = new URL(req.url);
  const 自家 = url.origin === self.location.origin;
  const 字型 = FONT_HOSTS.indexOf(url.hostname) >= 0;

  // 行情 API 永遠走網路，絕不快取：離線時的退路是 localStorage，不是 SW 快取。
  if (!自家 && !字型) return;

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
      if (!自家) return new Response('', { status: 504 });   // 字型抓不到就用系統宋體
      const fb = await caches.match('./index.html');
      return fb || new Response('離線且沒有快取', { status: 503 });
    }
  })());
});
