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
  // No more wiping non-current caches — that just trashed the user's
  // 250 MB of cached weights every time we bumped the cache name.
  // Old caches will get garbage-collected by the browser eventually
  // under storage pressure; meanwhile they cost nothing to keep.
  e.waitUntil(self.clients.claim());
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
      if (res.ok && res.type !== 'opaque' && res.status !== 206) {
        // Stream-fork: send the original response to the consumer
        // immediately; drain the clone into cache in parallel. AND
        // wrap the cache.put in event.waitUntil() so the SW context
        // stays alive long enough to finish the write — otherwise the
        // browser can terminate the SW after `respondWith` resolves
        // (i.e. as soon as the consumer has the response handle),
        // killing the cache.put mid-flight and leaving nothing behind.
        const putP = cache.put(event.request, res.clone()).then(
          () => console.log('[lens-sw] cached:', url.pathname),
          (e) => console.warn('[lens-sw] cache.put failed:', url.pathname, e),
        );
        event.waitUntil(putP);
      }
      return res;
    } catch (e) {
      return new Response(`Network failed for ${url.href}`, { status: 599 });
    }
  })());
});
