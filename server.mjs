// lens.ask-meridian.uk — static file server for the WebXR Vision Lab.
// Loopback only (127.0.0.1); Cloudflare Tunnel terminates HTTPS at the edge.
//
// No bundler. We serve src/ directly — index.js loads ES modules via the
// importmap in index.html, which resolves to esm.sh CDN. The 1 GB VM has
// no business running webpack.

import { createServer } from 'node:http'
import { readFile, stat }   from 'node:fs/promises'
import { fileURLToPath }    from 'node:url'
import { dirname, join, normalize, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(__dirname, 'src')
const PORT = parseInt(process.env.LENS_PORT || '8104', 10)
const HOST = process.env.LENS_HOST || '127.0.0.1'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ogg':  'audio/ogg',
  '.mp3':  'audio/mpeg',
  '.ttf':  'font/ttf',
  '.wasm': 'application/wasm',
  '.map':  'application/json',
}

function contentType(path) {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? (TYPES[path.slice(dot)] || 'application/octet-stream') : 'application/octet-stream'
}

async function safePath(reqUrl) {
  // Strip query string + normalize, then ensure the result stays inside DIST.
  const url = new URL(reqUrl, 'http://x')
  let p = decodeURIComponent(url.pathname)
  if (p.endsWith('/')) p += 'index.html'
  const abs = resolve(DIST, '.' + normalize(p))
  if (!abs.startsWith(DIST)) return null   // path traversal attempt
  return abs
}

const server = createServer(async (req, res) => {
  const t0 = performance.now()
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('method not allowed'); return
  }
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, name: 'lens', dist: DIST }))
    return
  }
  const path = await safePath(req.url)
  if (!path) { res.writeHead(400); res.end('bad path'); return }
  try {
    const s = await stat(path)
    if (s.isDirectory()) { res.writeHead(404); res.end('not found'); return }
    const buf = await readFile(path)
    const headers = {
      'content-type':         contentType(path),
      'content-length':       s.size,
      // We previously set COEP=require-corp anticipating SharedArrayBuffer
      // needs, but transformers.js on WebGPU works fine without cross-origin
      // isolation, and require-corp blocks third-party CDN imports (jsdelivr,
      // HuggingFace) unless they emit CORP headers, which they don't reliably
      // do. Drop them; revisit if we ever need WASM threads.
      'cross-origin-opener-policy':   'same-origin-allow-popups',
      // Long cache for hashed bundles; HTML stays uncached so deploys propagate.
      // no-store, not no-cache: Cloudflare's edge caches `.js` by default
      // regardless of `no-cache`. `no-store` is the only cache-control value
      // CF guarantees to respect for bypassing the edge cache.
      'cache-control': 'no-store, no-cache, must-revalidate',
    }
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? null : buf)
    const ms = (performance.now() - t0).toFixed(1)
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> 200 (${s.size}B, ${ms}ms)`)
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); res.end('not found') }
    else { res.writeHead(500); res.end('error: ' + e.message) }
  }
})

server.listen(PORT, HOST, () => {
  console.log(`lens static server  http://${HOST}:${PORT}  serving ${DIST}`)
})
