#!/usr/bin/env python3
"""Generate dist/worker.js — a Cloudflare Worker that serves src/* as a
static site (no bundler, no build step on the Worker side; modules
resolve via the importmap in src/index.html at runtime).

Output is suitable for direct upload via:
  PUT /accounts/{account}/workers/scripts/lens-proxy
  metadata={"body_part":"script","compatibility_date":"2025-01-01"}
  script=@dist/worker.js
"""
import base64
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC  = ROOT / 'src'
OUT  = ROOT / 'dist' / 'worker.js'

files = {}
for rel in ['index.html', 'index.js', 'init.js']:
    files[rel] = base64.b64encode((SRC / rel).read_bytes()).decode('ascii')

manifest = {
    '/':            { 'file': 'index.html', 'type': 'text/html; charset=utf-8' },
    '/index.html':  { 'file': 'index.html', 'type': 'text/html; charset=utf-8' },
    '/index.js':    { 'file': 'index.js',   'type': 'application/javascript; charset=utf-8' },
    '/init.js':     { 'file': 'init.js',    'type': 'application/javascript; charset=utf-8' },
}

# Tag the build with a timestamp so /healthz reports the deployed version.
build_meta = {
    'built_at':   os.environ.get('BUILD_TIMESTAMP') or '',
    'commit':     os.environ.get('GITHUB_SHA', 'local')[:7],
    'workflow':   os.environ.get('GITHUB_RUN_ID', 'local'),
}

worker = """// lens.ask-meridian.uk — auto-generated Cloudflare Worker.
// Built by scripts/build-worker.py from src/. The Worker only serves files;
// runtime module resolution happens in the browser via the importmap in
// src/index.html (esm.sh + jsdelivr).

const FILES = __FILES__;
const MANIFEST = __MANIFEST__;
const BUILD_META = __BUILD_META__;

function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

addEventListener('fetch', (event) => {
  event.respondWith(handle(event.request));
});

async function handle(req) {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path === '/healthz') {
    return new Response(JSON.stringify({
      ok: true,
      name: 'lens',
      edge: 'cloudflare-workers',
      build: BUILD_META,
    }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const entry = MANIFEST[path];
  if (!entry) return new Response('not found', { status: 404 });
  return new Response(bytesFromB64(FILES[entry.file]), {
    status: 200,
    headers: {
      'content-type':  entry.type,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  });
}
"""
worker = (worker
    .replace('__FILES__',     json.dumps(files))
    .replace('__MANIFEST__',  json.dumps(manifest))
    .replace('__BUILD_META__', json.dumps(build_meta))
)

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(worker, encoding='utf-8')
print(f'wrote {OUT}  ({len(worker)} bytes)  commit={build_meta["commit"]}')
