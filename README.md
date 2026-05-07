# lens

WebXR Vision Lab — a Three.js immersive scene that pairs an in-browser VLM
(SmolVLM / Moondream2 via transformers.js) with the meridian orbital-route
skill router. Point at something in VR, snap, ask, see candidate skills
arrange themselves in orbit.

## Hosting

GitHub Pages. No bundler, no server, no build artifact — `src/` is the site.

* Modules resolve at runtime through the importmap in `src/index.html`
  (esm.sh + jsdelivr).
* CI is `.github/workflows/pages.yml`: checkout → write
  `src/healthz.json` → publish `src/` as a Pages artifact.
* `/healthz.json` reports `{ commit, run_id, built_at }` for deploy
  verification.

To bring up Pages on a fresh fork: **Settings → Pages → Source: GitHub
Actions**. First push to `main` deploys.

## Local dev

```
node server.mjs    # serves src/ on http://127.0.0.1:8104
```

`server.mjs` is a 90-line static file server (no deps). Used during
development; not part of the deploy.

## API dependency

The app POSTs to `https://mcp.ask-meridian.uk/v1/route` (the live
Meridian MCP's first-party browser endpoint) for skill routing. The
endpoint is operator-paid (the GitHub PAT lives in a Cloudflare Worker
secret), Origin-restricted to `lens.ask-meridian.uk` + sister
sub-properties, and returns the full classifier output (per-skill
celestial class + physics signature + decision rule) so the orbits
render with real parameters instead of cosmetic ones.

The endpoint URL is in `src/meridian-route.mjs`. SmolVLM inference
remains fully on-device — only the routing call leaves the browser.
