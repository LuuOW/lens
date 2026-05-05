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

The app POSTs to `MERIDIAN_API` (defined in `src/index.js`) for skill
routing. Update that URL when the meridian backend moves.
