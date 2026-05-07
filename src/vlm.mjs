// Vision-language inference for lens.
//
// Loads SmolVLM-256M-Instruct via @huggingface/transformers (already in the
// importmap, esm.sh-resolved), runs in WebGPU when available. Captures a
// frame from the in-VR scene by rendering a Three.js scene through an
// offscreen WebGLRenderTarget from the player's POV, and streams tokens
// from the VLM into a callback.
//
// The first load downloads ~250 MB of weights into the browser cache; all
// subsequent loads are instant. WebGPU is preferred (~5–8 s on M-series),
// WASM is the fallback (~25–40 s, single-threaded).

import * as THREE from 'three';
import {
  env, AutoProcessor, AutoModelForVision2Seq, RawImage, TextStreamer,
} from '@huggingface/transformers';

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';
// Bump when swapping the model or its quantization so cached weights
// from previous versions get evicted on next visit instead of being
// silently re-used. This is the *only* string anyone has to touch to
// force a fresh download.
const MODEL_VERSION = 'SmolVLM-256M-Instruct/fp16-q4@1';

env.allowLocalModels = false;
env.useBrowserCache  = true;

let _modelPromise = null;

// ── Cache version pin (IDB) ─────────────────────────────────────────
// transformers.js + the SW already give us a stable cache key (the
// huggingface.co URL → Cache Storage entry). What's missing is a
// version check: if MODEL_VERSION changes we want to drop the stale
// weights so users don't run an outdated checkpoint forever. Persist
// the active version in IndexedDB and evict matching cache entries
// on mismatch.

const IDB_NAME    = 'lens-vlm';
const IDB_STORE   = 'meta';
const VERSION_KEY = 'modelVersion';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function idbRun(mode, fn) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const store = tx.objectStore(IDB_STORE);
    let result;
    try { result = fn(store); } catch (e) { db.close(); reject(e); return; }
    tx.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
    tx.onabort    = () => { db.close(); reject(tx.error || new Error('aborted')); };
  }));
}

async function evictModelCache(modelId) {
  if (typeof caches === 'undefined') return 0;
  const slug = modelId.split('/').pop();
  let evicted = 0;
  const names = await caches.keys();
  for (const name of names) {
    const cache = await caches.open(name);
    const reqs = await cache.keys();
    for (const req of reqs) {
      let url;
      try { url = new URL(req.url); } catch { continue; }
      if (!url.hostname.includes('huggingface.co')) continue;
      if (!url.pathname.includes(slug)) continue;
      if (await cache.delete(req)) evicted++;
    }
  }
  return evicted;
}

async function ensureFreshCache() {
  let stored = null;
  try { stored = await idbRun('readonly', s => s.get(VERSION_KEY)); }
  catch (e) { console.warn('[lens-vlm] IDB read failed:', e); }

  if (stored && stored !== MODEL_VERSION) {
    const n = await evictModelCache(MODEL_ID).catch(() => 0);
    console.info(`[lens-vlm] model version ${stored} → ${MODEL_VERSION}, evicted ${n} cache entries`);
  }
  if (stored !== MODEL_VERSION) {
    try { await idbRun('readwrite', s => s.put(MODEL_VERSION, VERSION_KEY)); }
    catch (e) { console.warn('[lens-vlm] IDB write failed:', e); }
  }
}

// ── Model load ─────────────────────────────────────────────────────────
// Concurrent calls share one promise. progress_callback is fed both files
// and percentages — we surface the most recent file's progress so the
// gate's <progress> bar makes sense without aggregation gymnastics.
export function loadVlm({ onProgress, onStatus } = {}) {
  if (_modelPromise) return _modelPromise
  const wrap = (cb) => (p) => {
    if (p?.status === 'progress' && typeof p.progress === 'number')
      cb?.(p.progress, p.file)
    else if (p?.status)
      onStatus?.(p.status, p.file)
  }
  _modelPromise = (async () => {
    onStatus?.('init')
    // Evict stale cached weights *before* transformers.js issues any
    // fetches — so the upcoming downloads either reuse the verified
    // version's cache or do a clean re-download.
    await ensureFreshCache()
    const useGpu = !!navigator.gpu
    const processor = await AutoProcessor.from_pretrained(MODEL_ID, {
      progress_callback: wrap(onProgress),
    })
    onStatus?.('weights')
    const model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
      dtype:  useGpu ? 'fp16' : 'q4',
      device: useGpu ? 'webgpu' : 'wasm',
      progress_callback: wrap(onProgress),
    })
    onStatus?.('ready')
    return { processor, model, device: useGpu ? 'webgpu' : 'wasm' }
  })()
  return _modelPromise
}

export function isVlmReady() {
  return !!_modelPromise
}

// ── Webcam capture ─────────────────────────────────────────────────────
// Preferred path: real camera via getUserMedia. Returns a hidden <video>
// element with the stream wired up. Idempotent — repeated calls return the
// existing stream. Throws if the user denies permission or no device.

let _cameraStream = null
let _cameraVideo = null

export async function requestCamera({ facingMode = 'environment' } = {}) {
  if (_cameraVideo && _cameraStream?.active) return _cameraVideo
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('getUserMedia not supported')

  // 'environment' (rear) is preferred for the AR-style demo, but most
  // laptops only expose a 'user' (front) camera; fall back automatically.
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: 1280, height: 720 },
      audio: false,
    })
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true, audio: false,
    })
  }
  _cameraStream = stream

  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.muted = true
  video.srcObject = stream
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;'
  document.body.appendChild(video)
  await new Promise((res) => {
    if (video.readyState >= 2) return res()
    video.addEventListener('loadeddata', res, { once: true })
  })
  await video.play().catch(() => {})
  _cameraVideo = video
  return video
}

export function isCameraReady() {
  return !!(_cameraVideo && _cameraStream?.active)
}

export function stopCamera() {
  try { _cameraStream?.getTracks?.().forEach(t => t.stop()) } catch {}
  if (_cameraVideo) {
    try { _cameraVideo.srcObject = null } catch {}
    try { _cameraVideo.remove() } catch {}
  }
  _cameraStream = null
  _cameraVideo = null
}

const _camCanvas = (typeof OffscreenCanvas !== 'undefined')
  ? new OffscreenCanvas(384, 384)
  : Object.assign(document.createElement('canvas'), { width: 384, height: 384 })

export function captureCameraFrame(size = 384) {
  if (!_cameraVideo) throw new Error('camera not requested')
  if (_camCanvas.width !== size) { _camCanvas.width = size; _camCanvas.height = size }
  const ctx = _camCanvas.getContext('2d')

  // Cover-fit: crop the video to a centered square then scale to size×size.
  const vw = _cameraVideo.videoWidth, vh = _cameraVideo.videoHeight
  const side = Math.min(vw, vh)
  const sx = (vw - side) / 2, sy = (vh - side) / 2
  ctx.drawImage(_cameraVideo, sx, sy, side, side, 0, 0, size, size)

  const data = ctx.getImageData(0, 0, size, size).data
  // RGBA → RGB
  const rgb = new Uint8ClampedArray(size * size * 3)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j]     = data[i]
    rgb[j + 1] = data[i + 1]
    rgb[j + 2] = data[i + 2]
  }
  return new RawImage(rgb, size, size, 3)
}

// ── Scene capture (fallback) ───────────────────────────────────────────
// Render the live scene from the player's head position to a 384×384
// offscreen target. Works during an active XR session (separate render
// pass; doesn't disturb the XR display). Pixels come back upside-down from
// WebGL's bottom-left origin — flipped here to image-space top-left.

const _capCam = new THREE.PerspectiveCamera(70, 1, 0.05, 100)
let _capTarget = null
let _capPixels = null
const _vWorldPos = new THREE.Vector3()
const _vWorldQuat = new THREE.Quaternion()

export function captureSceneFrame({ renderer, scene, player, size = 384 }) {
  if (!_capTarget) {
    _capTarget = new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: true, stencilBuffer: false,
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    })
    _capPixels = new Uint8Array(size * size * 4)
  }

  // Best approximation of the user's POV: take the player's world transform
  // and lift to head height. In active XR Three's player rig is positioned
  // by reference space; head rotation lives on the XR camera. Reading from
  // the XR camera here gives us actual head pose.
  const xrCam = renderer.xr?.getCamera?.()
  if (xrCam?.cameras?.length) {
    xrCam.matrixWorld.decompose(_vWorldPos, _vWorldQuat, new THREE.Vector3())
    _capCam.position.copy(_vWorldPos)
    _capCam.quaternion.copy(_vWorldQuat)
  } else {
    _capCam.position.copy(player.position)
    _capCam.position.y += 1.6
    _capCam.quaternion.copy(player.quaternion)
  }
  _capCam.updateMatrixWorld(true)

  const prevTarget = renderer.getRenderTarget()
  const prevXrEnabled = renderer.xr.enabled
  renderer.xr.enabled = false   // render the offscreen pass with a normal camera
  renderer.setRenderTarget(_capTarget)
  renderer.clear()
  renderer.render(scene, _capCam)
  renderer.readRenderTargetPixels(_capTarget, 0, 0, size, size, _capPixels)
  renderer.setRenderTarget(prevTarget)
  renderer.xr.enabled = prevXrEnabled

  // Flip vertically — WebGL origin is bottom-left, image-space is top-left.
  const flipped = new Uint8ClampedArray(_capPixels.length)
  const stride = size * 4
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * stride
    flipped.set(_capPixels.subarray(src, src + stride), y * stride)
  }

  // Convert to a transformers.js RawImage. Channels are RGBA → RGB drop-alpha.
  const rgb = new Uint8ClampedArray(size * size * 3)
  for (let i = 0, j = 0; i < flipped.length; i += 4, j += 3) {
    rgb[j]     = flipped[i]
    rgb[j + 1] = flipped[i + 1]
    rgb[j + 2] = flipped[i + 2]
  }
  return new RawImage(rgb, size, size, 3)
}

// ── Inference ──────────────────────────────────────────────────────────
// Run the VLM with a captured image + a free-form prompt. Streams tokens
// to onToken as they're decoded. Returns the full string when done.
export async function describeImage(image, prompt, { onToken, signal, maxTokens = 96 } = {}) {
  if (!_modelPromise) throw new Error('VLM not loaded')
  const { processor, model } = await _modelPromise
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const messages = [{
    role: 'user',
    content: [
      { type: 'image' },
      { type: 'text', text: prompt },
    ],
  }]
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true })
  const inputs = await processor(text, [image])

  let buffer = ''
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => {
      buffer += chunk
      onToken?.(buffer, chunk)
    },
  })

  await model.generate({
    ...inputs,
    max_new_tokens: maxTokens,
    // Match HuggingFace's reference config for SmolVLM-256M: sampling
    // with low temperature. The previous greedy + repetition_penalty=1.3
    // + no_repeat_ngram_size=3 combination killed phrase loops but warped
    // the model's outputs into semantically wrong territory — the
    // n-gram ban prohibits common captioning trigrams ('the X is',
    // 'with a X'), forcing the greedy path into unrelated tokens.
    // Sampling with temperature=0.5 avoids the loops naturally.
    do_sample: true,
    temperature: 0.5,
    top_p: 0.9,
    repetition_penalty: 1.0,
    streamer,
  })

  // The streamer truncates the trailing EOS but in practice still includes
  // some assistant boilerplate; trim it.
  return buffer.replace(/^\s*Assistant:\s*/i, '').trim()
}
