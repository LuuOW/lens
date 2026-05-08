// Lens — step 4: end-to-end click flow.
//
// IDLE  → preset click → THINKING (streamed mock answer) → ANSWER
// ANSWER → "Find candidates" → ROUTING → ORBIT (POST mcp.ask-meridian.uk/v1/route → real classifier)
// ORBIT  → planet click → DETAIL → close → ORBIT
// any state: left-controller squeeze → IDLE
//
// Discipline carried from earlier debugging:
//   - Cards/answer/route/detail/planets are STATIC. No per-frame yaw chase.
//   - Each Group's orientation is set ONCE via lookAt(0, group.y, 0) at
//     creation, which is the only orientation pattern proven to give LTR
//     text without mirroring (verified at minimal-1 → step-2).
//   - troika text material is forced FrontSide so back-side viewing produces
//     no glyph render rather than a silently-mirrored one.
//   - Single-source state machine; no entangled per-frame mutations.

import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { XR_BUTTONS } from 'gamepad-wrapper';
import gsap from 'gsap';
// __BUILD_SHA__ is sed-replaced with the commit SHA at deploy time
// (see .github/workflows/pages.yml) so each push produces brand-new
// URLs for every module — Safari's disk cache can't serve stale code.
import { init } from './init.js?v=__BUILD_SHA__';
import { loadVlm, captureSceneFrame, captureCameraFrame, requestCamera, stopCamera, isCameraReady, describeImage, isVlmReady, requestPersistentStorage } from './vlm.mjs?v=__BUILD_SHA__';
import { route as routeViaMeridian, sendFeedback } from './meridian-route.mjs?v=__BUILD_SHA__';

// gsap on a THREE.Color animates its r/g/b numeric props directly. Pre-allocate
// a scratch Color so we can call .setHex() once instead of allocating per tween.
const _tColor = new THREE.Color();
function tweenColor(mat, hex, dur = 0.22) {
  _tColor.setHex(hex);
  gsap.to(mat.color, { r: _tColor.r, g: _tColor.g, b: _tColor.b, duration: dur, ease: 'power2.out', overwrite: 'auto' });
}
function tweenScale(obj, to, dur = 0.20, ease = 'power2.out') {
  gsap.to(obj.scale, { x: to, y: to, z: to, duration: dur, ease, overwrite: 'auto' });
}
function tweenEmissive(mat, intensity, dur = 0.20) {
  gsap.to(mat, { emissiveIntensity: intensity, duration: dur, ease: 'power2.out', overwrite: 'auto' });
}

// ── Tunables ─────────────────────────────────────────────────────────────
const PRESETS = [
  { id: 'describe', label: 'Describe',     prompt: 'Describe this scene in one sentence.' },
  { id: 'read',     label: 'Read text',    prompt: 'What text is visible? Transcribe it verbatim.' },
  { id: 'activity', label: 'Activity?',    prompt: 'What activity is happening here?' },
  { id: 'objects',  label: 'List objects', prompt: 'List the visible objects, comma-separated.' },
  { id: 'context',  label: 'Context',      prompt: 'Work, home, outdoor, public — which?' },
  { id: 'candidates',   label: 'Candidate hint',   prompt: 'What candidates would I need to act on this?' },
];

// Fallback strings used only if the VLM is unavailable (model not loaded
// because the user took the "Skip model" path on the gate, or hardware
// doesn't support WebGPU/WASM). The real flow runs SmolVLM on a live
// frame capture from the player's POV.
const MOCK_ANSWERS = {
  describe: 'A floating workspace of luminous panels arranged in a concave arc above a starfield grid.',
  read:     'No text is visible in the rendered scene.',
  activity: 'Exploration of an in-headset interface; a controller is selecting a preset.',
  objects:  'panels, glyphs, a starfield, a translucent floor grid, controllers, a laser ray.',
  context:  'Virtual reality work session — interactive demo space.',
  candidates:   'Spatial UI navigation, ray-pick interaction, voice-to-prompt, controller haptics.',
};

// Cross-property nav, mirrored from the DOM burger menu so you can move
// between miniapp / vision-lab / photon / lens without leaving the headset.
// Selecting one ends the XR session (via `session.end()` if EXIT, otherwise
// implicitly via `window.location.href`) and the browser navigates.
const NAV_LINKS = [
  { label: '🛰️ Try it',     url: 'https://ask-meridian.uk/miniapp/' },
  { label: '🔭 Vision Lab', url: 'https://ask-meridian.uk/miniapp/vision-lab/' },
  { label: '⚛︎ Photon',     url: 'https://photon.ask-meridian.uk' },
  { label: '◎ Lens',         url: null,        current: true },
  { label: '▶ Demo',         url: '__demo__' },
  { label: '✕ Exit VR',     url: '__exit__' },
];
const NAV_Y_TOP  = 1.85;
const NAV_GAP    = 0.16;
const NAV_W      = 0.70;
const NAV_H      = 0.13;
// NAV_X / NAV_Z derived from ARC_RADIUS — defined further down to
// preserve declaration order (TDZ).

// Demo mode — six curated candidates, one per class. Independent of any LLM
// response so a recording always shows every orbital signature. Each
// entry includes a `parent` slug (so the post-pass can lock trojans/moons
// to it) and a `star_affinity` triple (so the planet's hue blends from
// the three system colours).
const DEMO_CANDIDATES = [
  { id: 'demo-planet',    name: 'persona-research',     class: 'planet',    score: 0.91, system: 'meridian-mcp',
    star_affinity: { forge: 0.20, signal: 0.35, mind: 0.85 },
    description: 'Build a source base for a person-specific voice model from public material — find, score, de-noise.' },
  { id: 'demo-moon',      name: 'voice-cache',          class: 'moon',      score: 0.78, system: 'meridian-mcp',
    parent: 'demo-planet',
    star_affinity: { forge: 0.65, signal: 0.05, mind: 0.30 },
    description: 'Lightweight cache satellites persona-research — local audio chunk store, tight loop around the parent.' },
  { id: 'demo-trojan',    name: 'consent-archive',      class: 'trojan',    score: 0.72, system: 'meridian-mcp',
    parent: 'demo-planet',
    star_affinity: { forge: 0.45, signal: 0.50, mind: 0.20 },
    description: 'Locked at L4 with persona-research — consent records share its orbital plane and period, leading by 60°.' },
  { id: 'demo-asteroid',  name: 'transcript-clean',     class: 'asteroid',  score: 0.65, system: 'meridian-mcp',
    star_affinity: { forge: 0.30, signal: 0.10, mind: 0.55 },
    description: 'Fast small loop in the inner belt — quick transcript de-disfluency pass.' },
  { id: 'demo-comet',     name: 'rare-language-router', class: 'comet',     score: 0.55, system: 'meridian-mcp',
    star_affinity: { forge: 0.10, signal: 0.65, mind: 0.40 },
    description: 'Long-period high-eccentricity router — rare-language coverage swooping through every ~75 s.' },
  { id: 'demo-irregular', name: 'retro-corpus-mirror',  class: 'irregular', score: 0.48, system: 'meridian-mcp',
    star_affinity: { forge: 0.50, signal: 0.45, mind: 0.40 },
    description: 'Out-of-plane retrograde companion — high inclination, opposite direction.' },
];

// Orbital mechanics — each celestial class the meridian candidate router emits gets a distinct
// orbital character so the visualization shows the difference instead of N identical circles.
// All orbits are centered on the anchor star (ANCHOR_X, ANCHOR_Y, ANCHOR_Z) — see below.
// y-axis is "up" in three.js.
//                a (m) | e    | i (rad) | ω (rad)   | retrograde
const ORBITAL_ELEMENTS = {
  planet:    { a: 2.0,  e: 0.05, i: 0.08,  omega: 0.0,         retrograde: false },
  moon:      { a: 0.7,  e: 0.10, i: 0.50,  omega: 0.0,         retrograde: false },
  trojan:    { a: 2.0,  e: 0.02, i: 0.08,  omega: Math.PI/3,   retrograde: false },  // 60° offset vs planet (Lagrange L4)
  asteroid:  { a: 1.3,  e: 0.20, i: 0.15,  omega: 0.0,         retrograde: false },
  comet:     { a: 3.2,  e: 0.78, i: 0.45,  omega: 0.0,         retrograde: false },
  irregular: { a: 2.5,  e: 0.35, i: 1.20,  omega: 0.0,         retrograde: true  },
};
// Kepler's 3rd law: T = T_UNIT * a^1.5 (s). Tuned so a planet (a=2) orbits in ~28 s.
const KEPLER_T_UNIT = 28 / Math.pow(2.0, 1.5);

function classElements(cls) {
  return ORBITAL_ELEMENTS[cls] || ORBITAL_ELEMENTS.planet;
}
function classPeriod(elements) {
  return KEPLER_T_UNIT * Math.pow(elements.a, 1.5);
}
function solveKepler(M, e) {
  // Newton-Raphson for E - e*sin(E) = M. 4 iterations cover e<0.95 to <1e-6 rad.
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 4; k++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  return E;
}
function keplerPosition(elements, t, M0) {
  const { a, e, i, omega, retrograde } = elements;
  const T = classPeriod(elements);
  const M = (M0 || 0) + (retrograde ? -1 : 1) * 2 * Math.PI * (t / T);
  const E = solveKepler(M, e);
  // Perifocal frame (periapsis on +x):
  const x_p = a * (Math.cos(E) - e);
  const y_p = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
  // ω rotates within the orbital plane:
  const cw = Math.cos(omega), sw = Math.sin(omega);
  const x_op = x_p * cw - y_p * sw;
  const y_op = x_p * sw + y_p * cw;
  // Inclination tilts the orbital plane around its line of nodes (here, world +x axis):
  const ci = Math.cos(i), si = Math.sin(i);
  return { x: x_op, y: y_op * si, z: y_op * ci };
}

// Candidate routing calls the live Meridian MCP at mcp.ask-meridian.uk
// — see ./meridian-route.mjs. The endpoint is operator-paid (the
// GitHub PAT lives in a Cloudflare Worker secret), Origin-restricted
// to lens.ask-meridian.uk, and returns the full classifier output so
// spawnOrbit() can use real semi-major axis / eccentricity /
// inclination per candidate.

const ARC_RADIUS    = 1.5;
const CARD_Y        = 1.5;
const ARC_SPAN      = Math.PI / 2;
// Nav rail on the same R=1.5 circle as the cards, pushed to -1.25 rad
// (~-72°) for a clear 27° angular gap from the leftmost card (-π/4).
// Computed here so they reference the already-declared ARC_RADIUS.
const NAV_ARC_ANGLE  = -1.25;
const NAV_ARC_RADIUS = ARC_RADIUS;
const NAV_X = Math.sin(NAV_ARC_ANGLE) * NAV_ARC_RADIUS;
const NAV_Z = -Math.cos(NAV_ARC_ANGLE) * NAV_ARC_RADIUS;
const PANEL_W       = 0.50;
const PANEL_H       = 0.18;
const ANSWER_Y      = 1.85;
// Sit on the same x²+z²=ARC_RADIUS² circle as the preset cards and
// the route button. Was -1.6 (off-arc by 10 cm) which read as a
// near-miss — the card looked subtly misaligned vs the rest of the
// arc. Now r=ARC_RADIUS at the front-centre angle (0).
const ANSWER_DIST   = -ARC_RADIUS;
const ANSWER_W      = 1.1;
const ANSWER_H      = 0.50;
const ROUTE_Y       = 1.20;     // below the preset arc (CARD_Y=1.5) and the answer card (1.85)
// Sit on the same circle x²+z²=ARC_RADIUS² as the preset cards, at angle 0
// (front-centre — between activity at θ=-π/20 and objects at θ=+π/20).
// Y is below the cards' plane so it never collides with their footprint.
const ROUTE_DIST    = -ARC_RADIUS;
const ORBIT_RADIUS  = 2.0;
const ORBIT_Y       = 1.55;

// ── Anchor star ──────────────────────────────────────────────────────
// Candidates now orbit a real anchor star instead of riding around the
// user's head. The star sits at azimuth +45° (front-right) and
// elevation +45° (above eye line) at ANCHOR_DIST_M metres — both
// values agree with the in-scene degree ring (axes=1) so it's easy
// to verify visually.
const ANCHOR_DIST_M = 4.0;
const ANCHOR_AZ_RAD = Math.PI / 4;
const ANCHOR_EL_RAD = Math.PI / 4;
const ANCHOR_X = Math.sin(ANCHOR_AZ_RAD) * Math.cos(ANCHOR_EL_RAD) * ANCHOR_DIST_M;
const ANCHOR_Y = ORBIT_Y + Math.sin(ANCHOR_EL_RAD) * ANCHOR_DIST_M;
const ANCHOR_Z = -Math.cos(ANCHOR_AZ_RAD) * Math.cos(ANCHOR_EL_RAD) * ANCHOR_DIST_M;

const COL_BG        = 0x07090f;
const COL_PANEL     = 0x12182a;
const COL_PANEL_H   = 0x1f2740;
const COL_PANEL_C   = 0xffa276;
const COL_TEXT      = 0xc9d4ec;
const COL_TEXT_H   = 0xffa276;
const COL_HINT      = 0x6e87b8;
const COL_PLANETS   = [0x6ec3f4, 0xffa276, 0xb592e0, 0x69e2c4, 0xf3d27a];

// Star-system base colors. The orbital classifier returns a star_affinity
// triple per candidate; we blend these three colors weighted by it so each
// planet's hue reflects the systems it actually orbits between.
//   forge  = devops/backend  → cool blue
//   signal = growth/marketing → magenta
//   mind   = AI/research      → amber
const SYS_COL = {
  forge:  new THREE.Color(0x6ec3f4),
  signal: new THREE.Color(0xb592e0),
  mind:   new THREE.Color(0xffa276),
};
const SYS_COL_FALLBACK = new THREE.Color(0x9bb6ea);

function colorFromAffinity(aff) {
  if (!aff) return null;
  const wf = +aff.forge || 0, ws = +aff.signal || 0, wm = +aff.mind || 0;
  const total = wf + ws + wm;
  if (total < 0.01) return SYS_COL_FALLBACK.clone();
  return new THREE.Color()
    .add(SYS_COL.forge.clone().multiplyScalar(wf  / total))
    .add(SYS_COL.signal.clone().multiplyScalar(ws / total))
    .add(SYS_COL.mind.clone().multiplyScalar(wm   / total));
}

// ── State ───────────────────────────────────────────────────────────────
const state = {
  scene:    null,
  cards:    [],
  panels:   [],          // raycast targets
  hovered:  null,
  flashUntil: 0,
  hint:     null,
  answer:   null,        // { group, title, body, meta }
  route:    null,        // { group, panel, text }
  orbit:    [],          // planet meshes
  orbitRings: [],        // per-planet ellipse Lines (visible orbit traces)
  trails:   [],          // per-planet fading trail records
  tethers:  [],          // trojan ↔ parent visible link lines
  starLayers: [],        // parallax + twinkle star Points groups
  physicsPanel: null,    // right-side hover info card
  detail:   null,        // { group, closeMesh }
  anchorStar: null,      // { group, core, halo1, halo2 } — body the orbits center on
  // The most recent /v1/route batch — kept verbatim (raw classifier
  // output, not the simplified spawnOrbit shape) so we can POST
  // /v1/feedback when the user engages a planet. Set in routeAndOrbit
  // and DEMO_CANDIDATES-skipping pieces of the flow.
  lastRoutingBatch: null, // { task: string, candidates: classifier_output[] }
  selected: null,
  full:     '',
  shown:    0,
  thinkStart: 0,
  routeBusy: false,
  phase:    'idle',
  prevSqueeze: false,
};

// ── Builders ─────────────────────────────────────────────────────────────
function frontMaterial(color, opacity = 0.92) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.FrontSide,
  });
}
function textFrontMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, side: THREE.FrontSide,
  });
}

function makeText(str, opts = {}) {
  const t = new Text();
  t.text = str;
  t.fontSize = opts.size || 0.05;
  t.color = opts.color ?? COL_TEXT;
  t.anchorX = opts.anchorX || 'center';
  t.anchorY = opts.anchorY || 'middle';
  if (opts.maxWidth) t.maxWidth = opts.maxWidth;
  t.material = textFrontMaterial(t.color);
  return t;
}

function makeCard(preset, ang) {
  const group = new THREE.Group();
  group.position.set(
    Math.sin(ang) * ARC_RADIUS, CARD_Y, -Math.cos(ang) * ARC_RADIUS,
  );
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, PANEL_H),
    frontMaterial(COL_PANEL),
  );
  panel.userData.kind = 'preset';
  panel.userData.preset = preset.id;
  group.add(panel);

  const text = makeText(preset.label, { size: 0.05 });
  text.position.z = 0.002;
  text.sync();
  group.add(text);

  group.lookAt(0, CARD_Y, 0);
  group.userData = { kind: 'card', preset: preset.id, panel, text, originalColor: COL_PANEL };
  return group;
}

function makeAnswerCard() {
  const group = new THREE.Group();
  group.position.set(0, ANSWER_Y, ANSWER_DIST);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(ANSWER_W, ANSWER_H),
    frontMaterial(COL_PANEL, 0.94),
  );
  group.add(panel);

  const title = makeText('Answer', {
    size: 0.045, color: COL_TEXT_H, anchorX: 'left', anchorY: 'top',
  });
  title.position.set(-ANSWER_W / 2 + 0.04, ANSWER_H / 2 - 0.04, 0.002);
  title.sync();
  group.add(title);

  const meta = makeText('', {
    size: 0.025, color: 0x9bb6ea, anchorX: 'right', anchorY: 'top',
  });
  meta.position.set(ANSWER_W / 2 - 0.04, ANSWER_H / 2 - 0.04, 0.002);
  meta.sync();
  group.add(meta);

  const body = makeText('', {
    size: 0.034, color: 0xffffff, anchorX: 'left', anchorY: 'top',
    maxWidth: ANSWER_W - 0.08,
  });
  body.position.set(-ANSWER_W / 2 + 0.04, ANSWER_H / 2 - 0.10, 0.002);
  body.sync();
  group.add(body);

  group.lookAt(0, ANSWER_Y, 0);
  group.visible = false;
  group.userData = { kind: 'answer-group', title, body, meta };
  return group;
}

// Camera toggle button — front-centre, on the cards' arc, sitting below
// the route button. No roll. Visually it stacks under the primary 'Find
// candidates' action so the user always finds it without head-turn:
//   answer card        y=1.85
//   preset cards       y=1.50  (θ ∈ [-π/4, +π/4])
//   route button       y=1.20  (θ=0)
//   camera toggle      y=0.95  (θ=0)   ← here
const CAMERA_COL_OFF = 0x4a2a14;          // amber — permission needed
const CAMERA_COL_ON  = 0x1f4a26;          // green — camera live
const CAMERA_BTN_Y   = 0.95;

function makeCameraBtn() {
  const group = new THREE.Group();
  group.position.set(0, CAMERA_BTN_Y, -ARC_RADIUS);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.14),
    frontMaterial(CAMERA_COL_OFF, 0.96),
  );
  panel.userData.kind = 'camera-toggle';
  panel.userData.baseColor = CAMERA_COL_OFF;
  group.add(panel);

  const text = makeText('🎥 Allow camera', { size: 0.045, color: 0xffd1a3 });
  text.position.z = 0.002;
  text.sync();
  group.add(text);

  // Face the user (origin) without any roll — keep it upright.
  group.lookAt(0, group.position.y, 0);
  group.userData = { kind: 'camera-btn-group', panel, text };
  return group;
}

// Refresh the toggle's label + base colour to match current camera state.
function refreshCameraBtn() {
  const g = state.cameraBtn;
  if (!g) return;
  const live = isCameraReady();
  const baseColor = live ? CAMERA_COL_ON : CAMERA_COL_OFF;
  g.userData.panel.userData.baseColor = baseColor;
  g.userData.panel.material.color.setHex(baseColor);
  g.userData.text.text = live ? '🛑 Disable camera' : '🎥 Allow camera';
  g.userData.text.color = live ? 0xc6f3c7 : 0xffd1a3;
  g.userData.text.material.color.setHex(g.userData.text.color);
  g.userData.text.sync();
}

function makeRouteButton() {
  const group = new THREE.Group();
  group.position.set(0, ROUTE_Y, ROUTE_DIST);

  // Larger, brighter button — it's now the primary call-to-action after
  // the VLM streams its description and we want it impossible to miss.
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.70, 0.13),
    frontMaterial(0x2d2160, 0.96),
  );
  panel.userData.kind = 'route';
  group.add(panel);

  const text = makeText('Find candidates →', { size: 0.05, color: COL_TEXT_H });
  text.position.z = 0.002;
  text.sync();
  group.add(text);

  group.lookAt(0, ROUTE_Y, 0);
  group.visible = false;
  group.userData = { kind: 'route-group', panel, text, originalColor: 0x2d2160 };
  return group;
}

// Map the classifier's a∈[1,7] (heavy/broad/independent → close orbit;
// light/dependent → far) into the visualization's working range [0.7, 3.2]
// so distinct candidates get distinct rings without flying past the user's view.
function rescaleA(a_phys) {
  const a = Math.max(1, Math.min(7, a_phys));
  return 0.7 + ((a - 1) / 6) * (3.2 - 0.7);
}

function makePlanet(candidate, i, n) {
  const score = Math.max(0, Math.min(1, +candidate.score || 0.5));
  const cls   = candidate.class || 'planet';
  // Class table contributes only the dynamical hints the physics scalars
  // don't encode: argument of periapsis (60° trojan offset for Lagrange L4)
  // and the retrograde flag for irregular candidates.
  const classExtras = classElements(cls);
  const o = candidate.orbital;
  const elements = o
    ? {
        a:          rescaleA(o.semi_major_axis),
        e:          Math.max(0, Math.min(0.95, o.eccentricity)),
        i:          Math.max(0, Math.min(Math.PI / 2, o.inclination)),
        omega:      classExtras.omega,
        retrograde: classExtras.retrograde,
      }
    : classExtras;
  const radius = 0.06 + score * 0.08;
  // Per-candidate colour from star_affinity if the classifier supplied one,
  // otherwise the legacy index-rotating palette (DEMO_CANDIDATES path).
  const affColor = colorFromAffinity(candidate.star_affinity);
  const color = affColor ? affColor.getHex() : COL_PLANETS[i % COL_PLANETS.length];

  const mesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius, 1),
    new THREE.MeshStandardMaterial({
      color, roughness: 0.4, metalness: 0.1,
      emissive: color, emissiveIntensity: 0.25,
    }),
  );

  // Use the classifier's deterministic mean_anomaly (slug-hashed) when
  // present so the same candidate always materialises in the same orbital
  // phase. Falls back to random for DEMO_CANDIDATES (no classifier output).
  const M0 = o?.mean_anomaly ?? Math.random() * Math.PI * 2;
  const p0 = keplerPosition(elements, 0, M0);
  mesh.position.set(p0.x + ANCHOR_X, p0.y + ANCHOR_Y, p0.z + ANCHOR_Z);
  mesh.userData = {
    kind: 'planet', candidate, elements, M0, color, radius, cls,
  };

  const label = makeText(`${candidate.name}  ·  ${cls}`, { size: 0.032, color: 0xffffff });
  label.position.y = radius + 0.05;
  label.sync();
  mesh.add(label);
  mesh.userData.label = label;

  return mesh;
}

// Per-class trail length. Comets streak much further so the high-eccentricity
// arc reads at a glance; irregular gets a medium-length retrograde tail.
const TRAIL_LEN = { planet: 30, moon: 22, trojan: 30, asteroid: 28, comet: 70, irregular: 42 };

function makeTrail(cls, color) {
  const N = TRAIL_LEN[cls] ?? 30;
  const positions = new Float32Array(N * 3);
  // Per-vertex normalized index 0..1 — used in the fragment shader to fade
  // from invisible (oldest, head of buffer) to bright (newest, tail of buffer).
  const idx = new Float32Array(N);
  for (let i = 0; i < N; i++) idx[i] = i / (N - 1);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aIdx',     new THREE.BufferAttribute(idx, 1));
  geom.setDrawRange(N, 0);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: `
      attribute float aIdx;
      varying float vIdx;
      void main() {
        vIdx = aIdx;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform vec3 uColor;
      varying float vIdx;
      void main() {
        // Quadratic head-bias so the very tip pops without a hard cutoff at the tail.
        float a = vIdx * vIdx * 0.78;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const line = new THREE.Line(geom, mat);
  line.frustumCulled = false; // trails span large arcs — false-cull bug otherwise
  return { line, positions, count: 0, N };
}

// Visible link line drawn between a trojan and its parent. Two vertices
// (from, to) updated each frame from their current world positions so the
// L4 60° lead is always anchored where the parent actually is.
function makeTether(color) {
  const positions = new Float32Array(6);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.32,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const line = new THREE.Line(geom, mat);
  line.frustumCulled = false;
  return { line, positions };
}

function makeOrbitRing(elements, color = 0x9bb6ea) {
  // Sample 96 mean-anomaly steps and project through the same Kepler->3D pipeline
  // as the planet itself, so the rendered ring exactly matches the planet's path.
  const N = 96;
  const pts = [];
  for (let k = 0; k <= N; k++) {
    const M = 2 * Math.PI * k / N;
    const E = solveKepler(M, elements.e);
    const x_p = elements.a * (Math.cos(E) - elements.e);
    const y_p = elements.a * Math.sqrt(Math.max(0, 1 - elements.e * elements.e)) * Math.sin(E);
    const cw = Math.cos(elements.omega), sw = Math.sin(elements.omega);
    const x_op = x_p * cw - y_p * sw;
    const y_op = x_p * sw + y_p * cw;
    const ci = Math.cos(elements.i), si = Math.sin(elements.i);
    pts.push(new THREE.Vector3(x_op + ANCHOR_X, y_op * si + ANCHOR_Y, y_op * ci + ANCHOR_Z));
  }
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.Line(geom, new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.22,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
}

function makePhysicsPanel() {
  // Static panel pinned on the user's right at eye height. Sticky: shows on
  // first planet hover, updates to track subsequent hovers, dismissed only
  // by the × button or a scene reset (clearOrbit).
  const group = new THREE.Group();
  const w = 0.70, h = 0.40;
  group.position.set(1.55, 1.85, -1.0);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    frontMaterial(COL_PANEL, 0.94),
  );
  group.add(panel);

  const title = makeText('', { size: 0.040, color: COL_TEXT_H, anchorX: 'left', anchorY: 'top' });
  title.position.set(-w / 2 + 0.04, h / 2 - 0.04, 0.002);
  title.sync(); group.add(title);

  const meta = makeText('', { size: 0.026, color: 0x9bb6ea, anchorX: 'left', anchorY: 'top' });
  meta.position.set(-w / 2 + 0.04, h / 2 - 0.10, 0.002);
  meta.sync(); group.add(meta);

  const body = makeText('', { size: 0.028, color: 0xe9eef7, anchorX: 'left', anchorY: 'top', maxWidth: w - 0.08 });
  body.position.set(-w / 2 + 0.04, h / 2 - 0.16, 0.002);
  body.sync(); group.add(body);

  // × close button — top-right corner, distinct from the answer-detail
  // 'close' kind so handleClick can route it independently.
  const closeBaseColor = 0x1f2740;
  const close = new THREE.Mesh(
    new THREE.PlaneGeometry(0.09, 0.07),
    frontMaterial(closeBaseColor, 0.94),
  );
  close.position.set(w / 2 - 0.06, h / 2 - 0.05, 0.003);
  close.userData.kind = 'physics-close';
  close.userData.baseColor = closeBaseColor;
  group.add(close);

  const closeText = makeText('×', { size: 0.046, color: COL_TEXT });
  closeText.position.set(w / 2 - 0.06, h / 2 - 0.05, 0.004);
  closeText.sync();
  group.add(closeText);

  group.lookAt(0, 1.85, 0);
  group.visible = false;
  group.userData = { kind: 'physics-group', title, meta, body, closeMesh: close };
  return group;
}

function updatePhysicsPanel(candidate, elements) {
  const panel = state.physicsPanel;
  if (!panel) return;
  const cls = candidate.class || 'planet';
  const T = classPeriod(elements);
  panel.userData.title.text = candidate.name;
  panel.userData.title.sync();
  panel.userData.meta.text = `class: ${cls} · score ${(candidate.score * 100).toFixed(0)}%`;
  panel.userData.meta.sync();
  panel.userData.body.text =
    `a (semi-major)   ${elements.a.toFixed(2)} m\n` +
    `e (eccentricity) ${elements.e.toFixed(2)}\n` +
    `i (inclination)  ${(elements.i * 180 / Math.PI).toFixed(0)}°\n` +
    `T (period)       ${T.toFixed(0)} s` +
    (elements.retrograde ? '\nretrograde' : '');
  panel.userData.body.sync();
  if (!panel.visible) {
    panel.visible = true;
    // Raycaster doesn't filter on .visible, so the × is only in the panels
    // list while the panel is showing.
    if (state.panels.indexOf(panel.userData.closeMesh) < 0) {
      state.panels.push(panel.userData.closeMesh);
    }
  }
}
function hidePhysicsPanel() {
  const panel = state.physicsPanel;
  if (!panel) return;
  panel.visible = false;
  const idx = state.panels.indexOf(panel.userData.closeMesh);
  if (idx >= 0) state.panels.splice(idx, 1);
}

function makeDetailCard(candidate) {
  const group = new THREE.Group();
  const w = 0.95, h = 0.50;
  group.position.set(0, ANSWER_Y, ANSWER_DIST + 0.4);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    frontMaterial(COL_PANEL, 0.96),
  );
  group.add(panel);

  const title = makeText(candidate.name || 'candidate', {
    size: 0.045, color: COL_TEXT_H, anchorX: 'left', anchorY: 'top',
  });
  title.position.set(-w / 2 + 0.05, h / 2 - 0.05, 0.002);
  title.sync();
  group.add(title);

  const meta = makeText(`${candidate.system || 'unknown'}  ·  match ${(Math.max(0, Math.min(1, +candidate.score || 0)) * 100).toFixed(0)}%`, {
    size: 0.030, color: 0x9bb6ea, anchorX: 'left', anchorY: 'top',
  });
  meta.position.set(-w / 2 + 0.05, h / 2 - 0.12, 0.002);
  meta.sync();
  group.add(meta);

  const body = makeText(candidate.description || candidate.summary || '(no description)', {
    size: 0.028, color: 0xe9eef7, anchorX: 'left', anchorY: 'top',
    maxWidth: w - 0.10,
  });
  body.position.set(-w / 2 + 0.05, h / 2 - 0.20, 0.002);
  body.sync();
  group.add(body);

  const close = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 0.06),
    frontMaterial(0x1f2740, 0.92),
  );
  close.position.set(w / 2 - 0.12, -h / 2 + 0.05, 0.003);
  close.userData.kind = 'close';
  group.add(close);

  const closeText = makeText('Close', { size: 0.028 });
  closeText.position.set(w / 2 - 0.12, -h / 2 + 0.05, 0.004);
  closeText.sync();
  group.add(closeText);

  group.lookAt(0, ANSWER_Y, 0);
  group.userData = { kind: 'detail-group', closeMesh: close };
  return group;
}

function makeNavLink(item, i) {
  const group = new THREE.Group();
  group.position.set(NAV_X, NAV_Y_TOP - i * NAV_GAP, NAV_Z);

  const isCurrent  = !!item.current;
  const isExit     = item.url === '__exit__';
  const baseColor  = isCurrent ? 0x2a2240 : (isExit ? 0x401f1f : 0x1f2740);
  const labelColor = isCurrent ? 0xc9d4ec : (isExit ? 0xf57b8a : COL_TEXT);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(NAV_W, NAV_H),
    frontMaterial(baseColor, 0.92),
  );
  panel.userData.kind = 'navlink';
  panel.userData.url  = item.url;
  panel.userData.current = isCurrent;
  panel.userData.baseColor = baseColor;
  group.add(panel);

  const text = makeText(item.label, { size: 0.05, color: labelColor });
  text.position.z = 0.002;
  text.sync();
  group.add(text);

  // Static one-shot orient toward origin — same rule as the cards.
  group.lookAt(0, group.position.y, 0);
  group.userData = { kind: 'navlink-group', panel, text };
  return group;
}

// Anchor star — the body all the orbits center on. Visually it's a
// glowing yellow sphere with a soft halo and a PointLight so planets
// pick up real Lambertian shading when they swing close. Sits at
// (ANCHOR_X, ANCHOR_Y, ANCHOR_Z) — matches the values used by
// makePlanet / makeOrbitRing / onFrame so the orbits actually loop
// around it.
function makeAnchorStar() {
  const group = new THREE.Group();
  group.position.set(ANCHOR_X, ANCHOR_Y, ANCHOR_Z);

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.22, 2),
    new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 1.0 }),
  );
  group.add(core);

  // Two additive halo shells so the star reads as luminous rather than
  // a flat sphere, even before bloom passes.
  const halo1 = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.34, 2),
    new THREE.MeshBasicMaterial({
      color: 0xffd56b, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  group.add(halo1);
  const halo2 = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.55, 2),
    new THREE.MeshBasicMaterial({
      color: 0xffa276, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  group.add(halo2);

  const point = new THREE.PointLight(0xfff0c2, 1.6, 14, 1.4);
  group.add(point);

  group.userData = { kind: 'anchor-star', core, halo1, halo2 };
  return group;
}

function makeLaser() {
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -3),
  ]);
  return new THREE.Line(geom, new THREE.LineBasicMaterial({
    color: 0xffa276, transparent: true, opacity: 0.6,
  }));
}

// ── Setup ───────────────────────────────────────────────────────────────
function setupScene({ scene, renderer, player }) {
  state.scene = scene;
  state.renderer = renderer;
  state.player = player;
  scene.background = new THREE.Color(COL_BG);
  scene.add(new THREE.AmbientLight(0x202838, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(2, 5, 3);
  scene.add(key);

  // Starfield — three concentric layers at different radii give true parallax
  // when the user moves their head; each layer rotates at its own slow rate.
  // Per-vertex twinkle seed drives a per-fragment sin() so brightness wobbles
  // independently for each star without per-vertex CPU work.
  {
    const layerSpec = [
      { count: 420, rMin: 22, rMax: 28, size: 4.5, opacity: 0.85, rotSpeed:  0.0009, color: 0xc9d4ec },
      { count: 240, rMin: 32, rMax: 38, size: 7.5, opacity: 0.62, rotSpeed: -0.0005, color: 0xb6c5e8 },
      { count: 110, rMin: 45, rMax: 52, size: 11.5, opacity: 0.42, rotSpeed:  0.0002, color: 0xa78bfa },
    ];
    for (const spec of layerSpec) {
      const positions = new Float32Array(spec.count * 3);
      const seeds     = new Float32Array(spec.count);
      for (let i = 0; i < spec.count; i++) {
        const u = Math.random(), v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi   = Math.acos(2 * v - 1);
        const r = spec.rMin + Math.random() * (spec.rMax - spec.rMin);
        positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.cos(phi);
        positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
        seeds[i] = Math.random();
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('aSeed',    new THREE.BufferAttribute(seeds, 1));
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime:    { value: 0 },
          uSize:    { value: spec.size },
          uColor:   { value: new THREE.Color(spec.color) },
          uOpacity: { value: spec.opacity },
        },
        vertexShader: `
          attribute float aSeed;
          varying float vSeed;
          uniform float uSize;
          void main() {
            vSeed = aSeed;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = uSize;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          precision mediump float;
          varying float vSeed;
          uniform float uTime;
          uniform vec3  uColor;
          uniform float uOpacity;
          void main() {
            vec2 c = gl_PointCoord - 0.5;
            float d = dot(c, c);
            if (d > 0.25) discard;
            // Twinkle: sin with per-star phase + frequency. mediump-safe.
            float t = sin(uTime * (0.5 + vSeed * 1.4) + vSeed * 6.2832);
            float a = uOpacity * (0.55 + 0.45 * t);
            // Soft round point (1 - 4*d2) clamped.
            gl_FragColor = vec4(uColor, a * max(0.0, 1.0 - d * 4.0));
          }
        `,
      });
      const points = new THREE.Points(geom, mat);
      points.userData = { rotSpeed: spec.rotSpeed, mat };
      scene.add(points);
      state.starLayers.push(points);
    }
  }

  scene.add(new THREE.GridHelper(20, 20, 0x223052, 0x1a2438));

  // Anchor star — the body the spawned candidates orbit. Pinned in world
  // space so the user can move around the orbit instead of dragging
  // it with their head.
  state.anchorStar = makeAnchorStar();
  scene.add(state.anchorStar);

  // ── Axis + degree reference (debug-only, toggle via ?axes=0) ────────
  // Visible XYZ axes at world origin and a degree ring on the cards'
  // R=ARC_RADIUS circle, ticked every 30°. Useful for communicating
  // spatial changes precisely ("move it to -75°", "tilt around Z by 50").
  // X=red (+X right), Y=green (+Y up), Z=blue (+Z back; -Z is forward).
  // Angle convention matches makeCard's: ang = sin/-cos, 0° = front,
  // positive = clockwise from above (right side), negative = left.
  if (new URL(location.href).searchParams.get('axes') !== '0') {
    const axes = new THREE.AxesHelper(0.8);
    axes.position.set(0, 0.005, 0);
    scene.add(axes);

    const labelOpts = (color) => ({ size: 0.05, color });
    const xL = makeText('+X', labelOpts(0xff7878));   xL.position.set(0.88, 0.05, 0);    xL.sync(); scene.add(xL);
    const yL = makeText('+Y', labelOpts(0x9aff9a));   yL.position.set(0, 0.88, 0);       yL.sync(); scene.add(yL);
    const zL = makeText('+Z (back)', labelOpts(0x9abbff)); zL.position.set(0, 0.05, 0.88); zL.lookAt(0, 0.05, 0); zL.sync(); scene.add(zL);
    const fL = makeText('-Z (front, 0°)', labelOpts(0x9abbff)); fL.position.set(0, 0.05, -0.88); fL.lookAt(0, 0.05, 0); fL.sync(); scene.add(fL);

    // Floor ring on the cards' R=ARC_RADIUS circle.
    const segs = 96;
    const ringPts = new Float32Array((segs + 1) * 3);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      ringPts[i * 3]     = Math.sin(a) * ARC_RADIUS;
      ringPts[i * 3 + 1] = 0.006;
      ringPts[i * 3 + 2] = -Math.cos(a) * ARC_RADIUS;
    }
    const ringGeom = new THREE.BufferGeometry();
    ringGeom.setAttribute('position', new THREE.BufferAttribute(ringPts, 3));
    scene.add(new THREE.LineLoop(ringGeom, new THREE.LineBasicMaterial({
      color: 0x4a5878, transparent: true, opacity: 0.55,
    })));

    // Degree ticks + labels every 30°. 0° = front (-Z), positive = right.
    for (let deg = -180; deg < 180; deg += 30) {
      const a = deg * Math.PI / 180;
      const x = Math.sin(a) * ARC_RADIUS;
      const z = -Math.cos(a) * ARC_RADIUS;
      const tickGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x * 0.96, 0.006, z * 0.96),
        new THREE.Vector3(x * 1.06, 0.006, z * 1.06),
      ]);
      scene.add(new THREE.Line(tickGeom, new THREE.LineBasicMaterial({
        color: 0x8aa0c8, transparent: true, opacity: 0.75,
      })));
      const txt = `${deg > 0 ? '+' : ''}${deg}°`;
      const label = makeText(txt, { size: 0.04, color: 0x9bb6ea });
      label.position.set(x * 1.13, 0.02, z * 1.13);
      label.lookAt(0, 0.02, 0);
      label.sync();
      scene.add(label);
    }
  }

  PRESETS.forEach((preset, i) => {
    const t = PRESETS.length === 1 ? 0.5 : i / (PRESETS.length - 1);
    const ang = -ARC_SPAN / 2 + t * ARC_SPAN;
    const card = makeCard(preset, ang);
    scene.add(card);
    state.cards.push(card);
    state.panels.push(card.userData.panel);
  });

  state.answer = makeAnswerCard();
  scene.add(state.answer);

  state.route = makeRouteButton();
  scene.add(state.route);
  state.panels.push(state.route.children[0]); // route's panel mesh

  state.hint = makeText('aim a controller, pull the trigger', { size: 0.05, color: COL_HINT });
  state.hint.position.set(0, 0.95, -1.5);
  state.hint.lookAt(0, 0.95, 0);
  state.hint.sync();
  scene.add(state.hint);

  // In-VR nav strip on the user's left so you can hop between properties
  // without taking the headset off. Skipped from the raycast list for the
  // current entry (no point clicking yourself).
  NAV_LINKS.forEach((item, i) => {
    const link = makeNavLink(item, i);
    scene.add(link);
    if (!item.current) state.panels.push(link.userData.panel);
  });

  // Physics panel — pinned on the right, hidden until a planet is hovered.
  state.physicsPanel = makePhysicsPanel();
  scene.add(state.physicsPanel);

  // In-VR camera-permission button — only meaningful if the user
  // entered VR without granting camera at the gate (Skip path or
  // permission denial). Click triggers getUserMedia, OS prompt
  // appears outside the VR canvas.
  state.cameraBtn = makeCameraBtn();
  scene.add(state.cameraBtn);
  state.panels.push(state.cameraBtn.userData.panel);
}

// ── Phase transitions ───────────────────────────────────────────────────
function setHint(s, color) {
  state.hint.text = s;
  state.hint.color = color ?? COL_HINT;
  state.hint.material.color.setHex(state.hint.color);
  state.hint.sync();
}

function startSelection(presetId) {
  // Reset any prior orbit/detail state — selecting a preset always restarts.
  closeDetail();
  clearOrbit();

  const preset = PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  state.selected = preset;
  state.shown = 0;
  state.full = '';

  state.answer.userData.title.text = preset.label;
  state.answer.userData.title.sync();
  state.answer.userData.meta.text  = isVlmReady() ? 'capturing…' : 'mock';
  state.answer.userData.meta.sync();
  state.answer.userData.body.text  = '';
  state.answer.userData.body.sync();
  state.answer.visible = true;

  state.route.visible = false;
  setHint('looking…', COL_TEXT_H);

  // Real VLM path — capture a frame and stream tokens. The 'vlm' phase
  // intentionally bypasses streamTick() so the mock stream's auto-advance
  // doesn't race the async inference.
  if (isVlmReady()) {
    state.phase = 'vlm';
    runVlmInference(preset).catch((e) => {
      console.warn('[lens] VLM failed, falling back to mock:', e);
      runMockStream(preset);
    });
  } else {
    state.phase = 'thinking';
    state.thinkStart = performance.now();
    runMockStream(preset);
  }
}

async function runVlmInference(preset) {
  let image, source = 'scene'
  // Prefer real camera; fall back to scene capture if unavailable/denied.
  if (isCameraReady()) {
    try { image = captureCameraFrame(384); source = 'camera' }
    catch (e) { console.warn('[lens] camera capture failed:', e) }
  }
  if (!image) {
    try {
      image = captureSceneFrame({
        renderer: state.renderer,
        scene:    state.scene,
        player:   state.player,
      });
    } catch (e) {
      console.warn('[lens] frame capture failed:', e);
      return runMockStream(preset);
    }
  }

  state.answer.userData.meta.text = `SmolVLM · ${source}`;
  state.answer.userData.meta.sync();
  setHint(source === 'camera' ? 'looking through your camera…' : 'describing the scene…', COL_TEXT_H);

  await describeImage(image, preset.prompt, {
    onToken: (full) => {
      state.full = full;
      state.shown = full.length;
      state.answer.userData.body.text = full;
      state.answer.userData.body.sync();
    },
    maxTokens: 96,
  });

  state.phase = 'answer';
  state.route.visible = true;
  setHint('aim "Find candidates" or pick another preset', COL_TEXT);
}

function runMockStream(preset) {
  state.full = MOCK_ANSWERS[preset.id] || '...';
  state.shown = 0;
  state.thinkStart = performance.now();
  state.phase = 'thinking';
  state.answer.userData.meta.text = 'mock';
  state.answer.userData.meta.sync();
  setHint('thinking…', COL_TEXT_H);
}

function streamTick() {
  if (state.phase !== 'thinking') return;
  const elapsed = performance.now() - state.thinkStart;
  if (elapsed < 500) return;
  const target = Math.min(state.full.length, Math.floor((elapsed - 500) / 25));
  if (target !== state.shown) {
    state.shown = target;
    state.answer.userData.body.text = state.full.slice(0, target);
    state.answer.userData.body.sync();
  }
  if (state.shown >= state.full.length) {
    state.phase = 'answer';
    state.route.visible = true;
    setHint('aim "Find candidates" or pick another preset', COL_TEXT);
  }
}

async function routeAndOrbit() {
  if (state.routeBusy) return;
  state.routeBusy = true;
  state.phase = 'routing';
  state.route.visible = false;

  setHint('routing via Meridian MCP · Llama-3.3-70B + orbital classifier…', COL_TEXT_H);

  let candidates = [];
  const taskForBatch = state.full.slice(0, 500);
  try {
    const data = await routeViaMeridian({
      task:  taskForBatch,
      limit: 5,
    });
    candidates = (data.candidates || []).slice(0, 5);
    // Cache the raw classifier output so /v1/feedback can replay the
    // exact (query, candidates) tuple when the user clicks a planet.
    state.lastRoutingBatch = { task: taskForBatch, candidates };
  } catch (e) {
    console.warn('[lens] Meridian MCP route failed', e);
    setHint('routing failed: ' + (e.message || e), COL_HINT);
    state.routeBusy = false;
    state.phase = 'answer';
    state.route.visible = true;
    return;
  }

  if (!candidates.length) {
    setHint('LLM produced no candidates — try a different prompt', COL_HINT);
    state.routeBusy = false;
    state.phase = 'answer';
    state.route.visible = true;
    return;
  }
  spawnOrbit(candidates);
  state.routeBusy = false;
}

function spawnOrbit(candidates) {
  clearOrbit();
  // The MCP / GitHub-Models pipeline returns nested classification + route_score;
  // DEMO_CANDIDATES is the flat demo shape with score in 0..1. Read both.
  // route_score is unbounded (≈0..200+), so normalize against the batch max
  // when it overflows the 0..1 visual range.
  const rawScores = candidates.map(s => +s.route_score || +s.score || +s.match || 0);
  const maxRaw = Math.max(0.0001, ...rawScores);
  const needsNormalize = maxRaw > 1.5;
  candidates.forEach((raw, i) => {
    const rawScore = rawScores[i];
    const sk = {
      id: raw.id || raw.slug || `s-${i}`,
      name: raw.name || raw.slug || raw.label || `candidate-${i}`,
      class: raw.classification?.class || raw.class || raw.cls || 'planet',
      score: needsNormalize ? rawScore / maxRaw : rawScore,
      system: raw.classification?.star_system || raw.system || raw.system_id || raw.provider || '',
      description: raw.description || raw.summary || raw.body || '',
      // Preserve the classifier's per-candidate orbital elements so the
      // visualization shows the actual physics it computed instead of a
      // class lookup table. Falls back to undefined for DEMO_CANDIDATES,
      // which keeps the classElements() lookup as a default.
      orbital: raw.classification?.physics?.orbital,
      // Star-system affinity drives the planet's hue (blend of the three
      // base colors). Parent slug links trojans/moons to their primary,
      // so trojans can lock to L4 and moons can orbit the parent itself.
      star_affinity: raw.classification?.physics?.star_affinity,
      parent: raw.classification?.parent || raw.parent || null,
    };
    const planet = makePlanet(sk, i, candidates.length);
    state.scene.add(planet);
    state.orbit.push(planet);
    state.panels.push(planet);

    // Spawn pop — scale-from-near-zero with a back-out overshoot, staggered so
    // the orbit assembles like a system materialising rather than appearing
    // all at once. delay caps at 6×0.06s = 0.36s so a full orbit is in place
    // well under half a second.
    planet.scale.setScalar(0.001);
    gsap.to(planet.scale, {
      x: 1, y: 1, z: 1, duration: 0.55, ease: 'back.out(1.7)',
      delay: i * 0.06,
      overwrite: 'auto',
    });

    // Per-planet orbit ring — colour matches the planet so you can tell which
    // ring belongs to which when several share an inclination.
    const ring = makeOrbitRing(planet.userData.elements, planet.userData.color);
    state.scene.add(ring);
    state.orbitRings.push(ring);

    // Comet-style fading trail. Shader fades vIdx² so the freshest segment
    // (just behind the planet) is bright and the tail tapers to invisible.
    const trail = makeTrail(planet.userData.cls, planet.userData.color);
    state.scene.add(trail.line);
    trail.planet = planet;
    state.trails.push(trail);
  });

  // Post-pass: lock trojans to their parent at Lagrange L4 (same orbit,
  // 60° lead in mean anomaly), and mark moons to orbit their parent's
  // current position rather than the anchor star. The classifier already
  // identified parents via Jaccard similarity (orbital.mjs:165–176);
  // we just consume that here.
  const planetBySlug = new Map();
  state.orbit.forEach((p) => planetBySlug.set(p.userData.candidate.id, p));

  state.orbit.forEach((p, idx) => {
    const parentSlug = p.userData.candidate.parent;
    if (!parentSlug) return;
    const parent = planetBySlug.get(parentSlug);
    if (!parent || parent === p) return;

    if (p.userData.cls === 'trojan') {
      const pe = parent.userData.elements;
      p.userData.elements = {
        a: pe.a, e: pe.e, i: pe.i,
        omega: pe.omega, retrograde: pe.retrograde,
      };
      p.userData.M0 = parent.userData.M0 + Math.PI / 3;   // L4 lead
      p.userData.parentRef = parent;

      // Replace the orbit ring with one matching the parent's path (dimmer
      // — the trojan rides the same orbit, no need for a second bright loop).
      const oldRing = state.orbitRings[idx];
      if (oldRing) {
        state.scene.remove(oldRing);
        oldRing.geometry.dispose(); oldRing.material.dispose();
      }
      const newRing = makeOrbitRing(p.userData.elements, p.userData.color);
      newRing.material.opacity = 0.10;
      state.orbitRings[idx] = newRing;
      state.scene.add(newRing);

      // Visible thread between trojan and parent — anchor for the eye.
      const tether = makeTether(p.userData.color);
      tether.from = p; tether.to = parent;
      state.tethers.push(tether);
      state.scene.add(tether.line);
    } else if (p.userData.cls === 'moon') {
      p.userData.parentRef = parent;
      // Tighter orbit so the moon is visibly satelliting the parent
      // rather than the user; cap eccentricity for a clean little ellipse.
      p.userData.elements = {
        ...p.userData.elements,
        a: 0.32,
        e: Math.min(0.30, p.userData.elements.e),
      };
      // The moon's orbit ring would have to follow the parent every frame
      // to stay truthful — easier to hide it. The planet's own trail still
      // communicates motion.
      const r = state.orbitRings[idx];
      if (r) r.visible = false;
    }
  });

  state.phase = 'orbit';
  setHint('aim a planet to inspect orbital elements', COL_TEXT);
}

function spawnDemoCandidates() {
  closeDetail();
  state.answer.visible = false;
  state.route.visible = false;
  spawnOrbit(DEMO_CANDIDATES);
  setHint('demo · one curated candidate per class', COL_TEXT);
}

function clearOrbit() {
  // Kill any in-flight tweens on the bodies we're about to dispose so gsap
  // doesn't keep ticking against freed materials.
  state.orbit.forEach((p) => {
    gsap.killTweensOf(p.scale);
    gsap.killTweensOf(p.material);
    state.scene.remove(p);
    p.geometry.dispose();
    p.material.dispose();
    try { p.userData.label?.dispose?.(); } catch { /* troika best-effort */ }
    const idx = state.panels.indexOf(p);
    if (idx >= 0) state.panels.splice(idx, 1);
  });
  state.orbit = [];
  state.orbitRings.forEach((r) => {
    state.scene.remove(r);
    r.geometry.dispose();
    r.material.dispose();
  });
  state.orbitRings = [];
  state.trails.forEach((t) => {
    state.scene.remove(t.line);
    t.line.geometry.dispose();
    t.line.material.dispose();
  });
  state.trails = [];
  (state.tethers || []).forEach((t) => {
    state.scene.remove(t.line);
    t.line.geometry.dispose();
    t.line.material.dispose();
  });
  state.tethers = [];
  hidePhysicsPanel();
}

function showDetail(candidate) {
  closeDetail();
  const card = makeDetailCard(candidate);
  state.scene.add(card);
  state.detail = { group: card, closeMesh: card.userData.closeMesh };
  state.panels.push(card.userData.closeMesh);
  state.phase = 'detail';
  setHint('aim "Close" to dismiss', COL_TEXT);
}

function closeDetail() {
  if (!state.detail) return;
  const idx = state.panels.indexOf(state.detail.closeMesh);
  if (idx >= 0) state.panels.splice(idx, 1);
  state.scene.remove(state.detail.group);
  state.detail = null;
}

function reset() {
  closeDetail();
  clearOrbit();
  state.answer.visible = false;
  state.route.visible = false;
  state.selected = null;
  state.full = '';
  state.shown = 0;
  state.phase = 'idle';
  setHint('aim a controller, pull the trigger', COL_HINT);
}

// ── Click dispatch ──────────────────────────────────────────────────────
// Snap to white, then ease back to whatever the panel should look like once
// the click resolves (hovered colour if still hovered, otherwise base). One
// gsap tween replaces the prior per-frame flash-decay book-keeping.
function flashBaseColor(panel) {
  const k = panel.userData.kind;
  if (k === 'preset')        return COL_PANEL;
  if (k === 'route')         return 0x1f2740;
  if (k === 'close')         return 0x1f2740;
  if (k === 'physics-close') return panel.userData.baseColor;
  if (k === 'navlink')       return panel.userData.baseColor;
  return null;
}
function flashClick(panel) {
  const base = flashBaseColor(panel);
  if (base === null) return;
  const targetHex = state.hovered === panel ? COL_PANEL_C : base;
  panel.material.color.setHex(0xffffff);
  tweenColor(panel.material, targetHex, 0.32);
}

function handleClick(panel) {
  flashClick(panel);
  const k = panel.userData.kind;
  if (k === 'preset') {
    startSelection(panel.userData.preset);
  } else if (k === 'route' && state.phase === 'answer') {
    routeAndOrbit();
  } else if (k === 'planet' && (state.phase === 'orbit' || state.phase === 'detail')) {
    // Implicit positive label: the user picked this candidate from the
    // orbit. Fire-and-forget POST to /v1/feedback so the worker's
    // online SGD trains on it.
    const batch = state.lastRoutingBatch;
    if (batch) {
      sendFeedback({
        task:       batch.task,
        candidates:     batch.candidates,
        chosenSlug: panel.userData.candidate?.id || panel.userData.candidate?.slug,
        action:     'detail_open',
      });
    }
    showDetail(panel.userData.candidate);
  } else if (k === 'close' && state.phase === 'detail') {
    closeDetail();
    state.phase = 'orbit';
    setHint('aim a planet to inspect', COL_TEXT);
  } else if (k === 'physics-close') {
    hidePhysicsPanel();
  } else if (k === 'camera-toggle') {
    if (isCameraReady()) {
      stopCamera();
      refreshCameraBtn();
      setHint('camera disabled', COL_TEXT);
    } else {
      setHint('check the browser window for the camera prompt', COL_TEXT_H);
      requestCamera({ facingMode: 'environment' })
        .then(() => {
          refreshCameraBtn();
          setHint('camera granted ✓', COL_TEXT);
        })
        .catch((e) => {
          setHint('camera denied: ' + (e.message || e), COL_HINT);
        });
    }
  } else if (k === 'navlink') {
    const url = panel.userData.url;
    if (url === '__exit__') {
      // End the XR session so the DOM gate (and the burger menu) reappear.
      state.renderer?.xr?.getSession?.()?.end?.();
    } else if (url === '__demo__') {
      spawnDemoCandidates();
    } else if (url) {
      // Cross-property nav: ending the session first prevents Quest from
      // showing a stuck black frame as the new page loads.
      try { state.renderer?.xr?.getSession?.()?.end?.(); } catch { /* fine */ }
      window.location.href = url;
    }
  }
}

// ── Hover ───────────────────────────────────────────────────────────────
function setHover(panel) {
  if (state.hovered === panel) return;

  if (state.hovered) {
    const m = state.hovered;
    const k = m.userData.kind;
    if (k === 'preset') {
      tweenColor(m.material, COL_PANEL);
      const card = m.parent;
      // Troika text needs an explicit material colour change + sync; tween
      // the underlying material.color the same way as the panel.
      tweenColor(card.userData.text.material, COL_TEXT);
      card.userData.text.color = COL_TEXT;
      card.userData.text.sync();
    } else if (k === 'route' || k === 'close') {
      tweenColor(m.material, 0x1f2740);
    } else if (k === 'planet') {
      tweenEmissive(m.material, 0.25);
      tweenScale(m, 1.0, 0.22);
      // Physics panel stays sticky; only × or clearOrbit dismisses.
    } else if (k === 'physics-close' || k === 'navlink') {
      tweenColor(m.material, m.userData.baseColor);
    }
  }

  if (panel) {
    const k = panel.userData.kind;
    if (k === 'preset') {
      tweenColor(panel.material, COL_PANEL_H);
      const card = panel.parent;
      tweenColor(card.userData.text.material, COL_TEXT_H);
      card.userData.text.color = COL_TEXT_H;
      card.userData.text.sync();
    } else if (k === 'route' || k === 'close' || k === 'physics-close' || k === 'navlink') {
      tweenColor(panel.material, COL_PANEL_C);
    } else if (k === 'planet') {
      tweenEmissive(panel.material, 0.55);
      tweenScale(panel, 1.18, 0.22, 'back.out(2)');
      updatePhysicsPanel(panel.userData.candidate, panel.userData.elements);
    }
  }
  state.hovered = panel;
}

// ── Per-controller utilities ────────────────────────────────────────────
function ensureLaser(rec) {
  if (!rec || rec.laser) return;
  const laser = makeLaser();
  rec.raySpace.add(laser);
  rec.laser = laser;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const FORWARD_NEG_Z = new THREE.Vector3(0, 0, -1);
const raycaster = new THREE.Raycaster();

function onFrame(delta, _time, { controllers, camera }) {
  // Lazy-attach lasers
  ensureLaser(controllers.right);
  ensureLaser(controllers.left);

  // Stream mock reply if currently thinking
  streamTick();

  const tNow = performance.now() / 1000;

  // Starfield: drift each layer slowly (independent rates → parallax) and
  // tick each shader's uTime so the per-fragment twinkle wobbles.
  for (const layer of state.starLayers) {
    layer.rotation.y += layer.userData.rotSpeed;
    layer.userData.mat.uniforms.uTime.value = tNow;
  }

  // Per-class Kepler motion. Each planet's mean anomaly advances at its own
  // (Kepler's-3rd-law) rate; we solve for the eccentric anomaly each frame
  // and project to 3D through the perifocal → inclined frame. Trails buffer
  // the same world position into a shifting Float32Array — copyWithin shifts
  // by one vec3 per frame, then we overwrite the new head.
  if (state.orbit.length) {
    const cam = camera.getWorldPosition(_o);
    state.orbit.forEach((p) => {
      const local = keplerPosition(p.userData.elements, tNow, p.userData.M0);
      const parentRef = p.userData.parentRef;
      if (p.userData.cls === 'moon' && parentRef) {
        // Moon orbits its parent's CURRENT position, not the anchor star.
        // The parent has already had its position written this frame
        // because state.orbit is iterated in spawn order and moons come
        // after their parents in our routing data — but to be safe across
        // any insertion order we read parentRef.position directly.
        p.position.set(
          parentRef.position.x + local.x,
          parentRef.position.y + local.y,
          parentRef.position.z + local.z,
        );
      } else {
        p.position.set(local.x + ANCHOR_X, local.y + ANCHOR_Y, local.z + ANCHOR_Z);
      }
      p.userData.label?.lookAt(cam);
    });
    for (const t of state.trails) {
      const p = t.planet;
      t.positions.copyWithin(0, 3);
      const last = t.N * 3;
      t.positions[last - 3] = p.position.x;
      t.positions[last - 2] = p.position.y;
      t.positions[last - 1] = p.position.z;
      t.line.geometry.attributes.position.needsUpdate = true;
      t.count = Math.min(t.count + 1, t.N);
      t.line.geometry.setDrawRange(t.N - t.count, t.count);
    }
    // Update trojan↔parent tethers from current positions.
    for (const t of state.tethers) {
      t.positions[0] = t.from.position.x;
      t.positions[1] = t.from.position.y;
      t.positions[2] = t.from.position.z;
      t.positions[3] = t.to.position.x;
      t.positions[4] = t.to.position.y;
      t.positions[5] = t.to.position.z;
      t.line.geometry.attributes.position.needsUpdate = true;
    }
  }

  // Right controller: raycast for hover / click
  const rec = controllers.right || controllers.left;
  if (!rec) { setHover(null); return; }
  const { raySpace, gamepad } = rec;
  raySpace.getWorldPosition(_o);
  raySpace.getWorldQuaternion(_q);
  _d.copy(FORWARD_NEG_Z).applyQuaternion(_q);
  raycaster.set(_o, _d);

  const hits = raycaster.intersectObjects(state.panels, false);
  setHover(hits.length ? hits[0].object : null);

  if (state.hovered && gamepad?.getButtonClick?.(XR_BUTTONS.TRIGGER)) {
    handleClick(state.hovered);
    try { gamepad.getHapticActuator(0).pulse(0.6, 100); }
    catch { /* haptics best-effort */ }
  }

  // Left squeeze → reset to IDLE (escape hatch from any state)
  const left = controllers.left;
  if (left) {
    const sq = !!left.gamepad?.getButton?.(XR_BUTTONS.SQUEEZE)?.pressed;
    if (sq && !state.prevSqueeze) {
      reset();
      try { left.gamepad.getHapticActuator(0).pulse(0.3, 60); }
      catch { /* haptics best-effort */ }
    }
    state.prevSqueeze = sq;
  }
}

// ── Boot ────────────────────────────────────────────────────────────────
let _vrRevealed = false;
function revealVrButton(button) {
  if (_vrRevealed) return;
  const host = document.getElementById('vrButtonHost');
  if (host && button) host.appendChild(button);
  _vrRevealed = true;
}
// Capability check — fills in the gate's <li class="pending"> with ✓/✗
// based on real feature detection. Returns true if WebGPU is available
// (the only hard requirement for fp16 SmolVLM; WASM works as fallback).
async function runCapabilityChecks() {
  const set = (id, ok, label) => {
    const li = document.getElementById(id)
    if (!li) return
    li.classList.remove('pending')
    li.classList.add(ok ? 'ok' : 'fail')
    const icon = li.querySelector('.icon')
    if (icon) icon.textContent = ok ? '✓' : '✗'
    if (label) {
      const span = li.querySelectorAll('span')[1]
      if (span) span.textContent = label
    }
  }
  let xr = false
  try { xr = !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')) } catch {}
  set('cap-webxr', xr, xr ? 'WebXR (immersive-vr)' : 'WebXR · use a VR-capable browser or IWER')

  const gpu = !!navigator.gpu
  set('cap-webgpu', gpu, gpu ? 'WebGPU · fp16 inference' : 'WebGPU · falls back to WASM (slower)')

  let opfs = false
  try { opfs = !!(navigator.storage && await navigator.storage.getDirectory()) } catch {}
  // Persistent-storage state determines whether OPFS survives eviction.
  // Without it, the model is best-effort and the browser can drop it any
  // time it wants disk space — that's the real "I keep re-downloading"
  // failure mode. After Begin is clicked we request persistence and the
  // status flips to ✓.
  let persisted = false
  try { persisted = !!(navigator.storage?.persisted && await navigator.storage.persisted()) } catch {}
  const opfsLabel = !opfs
    ? 'OPFS · model re-downloads each visit'
    : persisted
      ? 'OPFS · persistent · model survives eviction'
      : 'OPFS · best-effort · click Begin to request persistence'
  set('cap-opfs', opfs, opfsLabel)

  return { xr, gpu, opfs }
}

(async () => {
  const globals = await init(setupScene, onFrame);
  const status = document.getElementById('dl-status');
  const beginBtn = document.getElementById('beginBtn');
  const skipBtn  = document.getElementById('skipBtn');
  const dlBar    = document.getElementById('dl');

  await runCapabilityChecks();
  if (beginBtn) beginBtn.disabled = false;
  if (skipBtn)  skipBtn.hidden = false;

  // One-time PAT-cleanup — older lens builds stashed a GitHub PAT in
  // localStorage to call GitHub Models directly. Routing now goes
  // through the operator-paid MCP, so any leftover token is dead
  // weight and we wipe it on first load.
  try { localStorage.removeItem('lens.github_token'); } catch {}

  // Hand the VR button over only after the user has either downloaded the
  // VLM or explicitly skipped it. Mirrors the gate's existing copy.
  function ready(line) {
    if (status) status.textContent = line;
    if (beginBtn) { beginBtn.disabled = true; beginBtn.textContent = '✓ ready'; }
    if (skipBtn) skipBtn.hidden = true;
    revealVrButton(globals.vrButton);
  }

  // The skip path keeps the existing mock-answer flow alive for hardware
  // that can't load the model — useful while debugging from a headless dev
  // machine. With Skip, presets stream pre-baked strings.
  if (skipBtn) {
    skipBtn.hidden = false;
    skipBtn.addEventListener('click', () => {
      ready('VLM skipped · presets stream mock answers · enter VR.');
    });
  }

  if (beginBtn) {
    beginBtn.disabled = false;
    beginBtn.addEventListener('click', async () => {
      beginBtn.disabled = true;
      beginBtn.textContent = '… loading';
      // Ask the browser to mark site storage as persistent BEFORE the
      // model download starts. Without this, the 250 MB OPFS-cached
      // weights are best-effort and the browser evicts them under
      // disk pressure — the actual root cause of "why am I re-downloading
      // SmolVLM?" Must run on this user-gesture (the click) for Firefox
      // to even prompt; Chrome grants heuristically.
      try {
        const persist = await requestPersistentStorage();
        console.info('[lens] persistent storage:', persist);
      } catch (e) { console.warn('[lens] persist() failed:', e); }
      try {
        await loadVlm({
          onProgress: (frac, file) => {
            // transformers.js v3 reports 'progress' as 0-100, but be
            // defensive — older builds emit 0-1.
            const pct = frac > 1 ? Math.round(frac) : Math.round(frac * 100);
            if (dlBar) dlBar.value = pct;
            if (status) status.textContent = `Loading ${file?.split('/').pop() || 'weights'}… ${pct}%`;
          },
          onStatus: (s, file) => {
            if (status) status.textContent = ({
              init: 'Initialising SmolVLM…',
              weights: 'Loading model weights…',
              ready: 'SmolVLM ready · enter VR to use it.',
            }[s]) || `${s}${file ? ' · ' + file.split('/').pop() : ''}`;
          },
        });
        if (dlBar) dlBar.value = 100;
        // Don't request camera here — defer to the in-VR 'Allow camera'
        // button so the OS prompt fires inside the demo flow, not on
        // the gate. The button at azimuth +120° is the explicit
        // user-controlled trigger.
        ready('SmolVLM ready · enter VR · use the in-scene Allow Camera button to grant access.');
      } catch (e) {
        console.error('[lens] VLM load failed:', e);
        if (status) {
          status.textContent = `VLM load failed (${e?.message || e}). Click "Skip model" to enter VR with mock answers.`;
          status.style.color = '#f57b8a';
        }
        beginBtn.textContent = 'retry';
        beginBtn.disabled = false;
      }
    });
  }
})();
