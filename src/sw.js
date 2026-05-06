// Lens service worker — pins HuggingFace model weights and esm.sh
// libraries in Cache Storage so SmolVLM-256M (~250 MB) downloads once
// per device and survives 'Empty Caches' clears + cache-bust query
// bumps on the app bundle.
//
// Two design decisions worth flagging:
//
//  1. We do NOT await cache.put — the response stream is forked via
//     clone() and one fork goes back to transformers.js immediately
//     while the other drains into Cache Storage in parallel. Awaiting
//     the put would buffer the entire 200 MB body before the consumer
//     saw a single byte (bug in v1 of this file).
//
//  2. self.skipWaiting() in install + clients.claim() in activate
//     means a freshly-installed SW takes control of the current page
//     ASAP. But on the very first navigation that registers the SW,
//     it can't intercept fetches that already started — so the first
//     model download bypasses the SW and goes straight to network.
//     Subsequent reloads hit the cache.

const CACHE = 'lens-deps-v2';   // bump on logic changes to evict stale entries

const PIN_HOSTS = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'esm.sh',
  'cdn.jsdelivr.net',
]);

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Drop any old cache versions so we don't accumulate orphaned
    // 200 MB blobs from previous logic. Match the prefix only.
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('lens-deps-') && n !== CACHE)
                            .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!PIN_HOSTS.has(url.hostname)) return;   // only intercept cacheable hosts

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) {
      console.log('[lens-sw] hit:', url.pathname);
      return cached;
    }
    console.log('[lens-sw] miss → network:', url.pathname);
    try {
      const res = await fetch(event.request);
      // Skip caching: non-OK, opaque (no-cors), Range responses (206).
      // CRUCIAL: do NOT await cache.put — fork the stream, send the
      // original to the consumer immediately, drain the clone into
      // cache in parallel.
      if (res.ok && res.type !== 'opaque' && res.status !== 206) {
        cache.put(event.request, res.clone()).catch((e) =>
          console.warn('[lens-sw] cache.put failed for', url.pathname, e));
      }
      return res;
    } catch (e) {
      return new Response(`Network failed for ${url.href}`, { status: 599 });
    }
  })());
});
