// Lens service worker — pins HuggingFace model weights and esm.sh
// libraries in Cache Storage so the SmolVLM-256M (~250 MB) downloads
// once per device and stays cached until the user explicitly clears it.
//
// Without this, transformers.js's default `useBrowserCache: true` writes
// to Cache Storage but the browser is free to evict it on storage
// pressure or "Empty Caches" — so every Develop-menu cache clear forces
// a fresh download. A registered SW makes the cache survive both.

const CACHE = 'lens-deps-v1';

// Hosts whose responses are immutable (versioned URLs, hash-named blobs)
// — safe to cache-first forever.
const PIN_HOSTS = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'esm.sh',
  'cdn.jsdelivr.net',
]);

self.addEventListener('install',  (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!PIN_HOSTS.has(url.hostname)) return;   // only intercept cacheable hosts

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try {
      const res = await fetch(event.request);
      // Only cache successful, non-opaque, non-partial responses.
      // CRUCIAL: do NOT await cache.put — that would buffer the
      // entire 200 MB body before returning the response to
      // transformers.js, which then sees zero progress for minutes.
      // Cloning forks the stream; cache.put reads its fork in
      // parallel with the consumer reading the original.
      if (res.ok && res.type !== 'opaque' && res.status !== 206) {
        cache.put(event.request, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      return new Response(`Network failed for ${url.href}`, { status: 599 });
    }
  })());
});
