// Lens — step 4: end-to-end click flow.
//
// IDLE  → preset click → THINKING (streamed mock answer) → ANSWER
// ANSWER → "Find skills" → ROUTING → ORBIT (in-browser via meridian's _lib/router.mjs)
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
import { init } from './init.js';
import { loadVlm, captureSceneFrame, captureCameraFrame, requestCamera, isCameraReady, describeImage, isVlmReady } from './vlm.mjs';

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
  { id: 'skills',   label: 'Skill hint',   prompt: 'What skills would I need to act on this?' },
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
  skills:   'Spatial UI navigation, ray-pick interaction, voice-to-prompt, controller haptics.',
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
// Nav rail on the same circle as the preset cards (radius 1.5). Pushed
// to ~-72° (-1.25 rad) so the angular separation from the leftmost card
// (-π/4 = -45°) is a clear 27° instead of the original 15°. On the
// circle that puts it at x≈-1.42, z≈-0.46 — visibly off-arc-end but
// still on-curve.
const NAV_ARC_ANGLE = -1.25;
const NAV_ARC_RADIUS = ARC_RADIUS;
const NAV_X      = Math.sin(NAV_ARC_ANGLE) * NAV_ARC_RADIUS;
const NAV_Z      = -Math.cos(NAV_ARC_ANGLE) * NAV_ARC_RADIUS;
const NAV_Y_TOP  = 1.85;
const NAV_GAP    = 0.16;
const NAV_W      = 0.70;
const NAV_H      = 0.13;

const FALLBACK_SKILLS = [
  { id: 'orbital-route', name: 'orbital-route', class: 'planet',    score: 0.91, system: 'meridian-mcp', description: 'Route a free-form task to compatible skills via Llama-3.3-70B classification.' },
  { id: 'vision-snap',   name: 'vision-snap',   class: 'asteroid',  score: 0.74, system: 'lens',         description: 'Capture the current scene and run a VLM query in-headset.' },
  { id: 'skill-orbit',   name: 'skill-orbit',   class: 'trojan',    score: 0.62, system: 'meridian-mcp', description: 'Materialise matched skills as orbital planets around the user.' },
  { id: 'comet-router',  name: 'comet-router',  class: 'comet',     score: 0.55, system: 'meridian-mcp', description: 'Long-period high-eccentricity router for rare-task coverage.' },
  { id: 'moon-cache',    name: 'moon-cache',    class: 'moon',      score: 0.48, system: 'lens',         description: 'Lightweight skill that satellites a parent skill (here: orbits the planet).' },
  { id: 'irregular-fx',  name: 'irregular-fx',  class: 'irregular', score: 0.41, system: 'meridian-mcp', description: 'Out-of-plane retrograde companion — high inclination, opposite direction.' },
];

// Demo mode — six curated skills, one per class. Independent of any LLM
// response so a recording always shows every orbital signature.
const DEMO_SKILLS = [
  { id: 'demo-planet',    name: 'persona-research',     class: 'planet',    score: 0.91, system: 'meridian-mcp', description: 'Build a source base for a person-specific voice model from public material — find, score, de-noise.' },
  { id: 'demo-moon',      name: 'voice-cache',          class: 'moon',      score: 0.78, system: 'meridian-mcp', description: 'Lightweight cache satellites persona-research — local audio chunk store, tight loop around the parent.' },
  { id: 'demo-trojan',    name: 'consent-archive',      class: 'trojan',    score: 0.72, system: 'meridian-mcp', description: 'Locked at L4 with persona-research — consent records share its orbital plane and period, leading by 60°.' },
  { id: 'demo-asteroid',  name: 'transcript-clean',     class: 'asteroid',  score: 0.65, system: 'meridian-mcp', description: 'Fast small loop in the inner belt — quick transcript de-disfluency pass.' },
  { id: 'demo-comet',     name: 'rare-language-router', class: 'comet',     score: 0.55, system: 'meridian-mcp', description: 'Long-period high-eccentricity router — rare-language coverage swooping through every ~75 s.' },
  { id: 'demo-irregular', name: 'retro-corpus-mirror',  class: 'irregular', score: 0.48, system: 'meridian-mcp', description: 'Out-of-plane retrograde companion — high inclination, opposite direction.' },
];

// Orbital mechanics — each celestial class the meridian skill router emits gets a distinct
// orbital character so the visualization shows the difference instead of N identical circles.
// All orbits are centered at (0, ORBIT_Y, 0) (the user). y-axis is "up" in three.js.
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

// Skill routing now runs in-browser via meridian's edge router, loaded
// cross-origin from its GitHub Pages site. ESM dynamic import + a static
// _skills.json corpus replace the old POST to /api/orbital-route.
const MERIDIAN_PAGES   = 'https://luuow.github.io/meridian-mcp';
const ROUTER_MODULE    = `${MERIDIAN_PAGES}/_lib/router.mjs`;
const ROUTER_CORPUS    = `${MERIDIAN_PAGES}/_skills.json`;

const ARC_RADIUS    = 1.5;
const CARD_Y        = 1.5;
const ARC_SPAN      = Math.PI / 2;
const PANEL_W       = 0.50;
const PANEL_H       = 0.18;
const ANSWER_Y      = 1.85;
const ANSWER_DIST   = -1.6;
const ANSWER_W      = 1.1;
const ANSWER_H      = 0.50;
const ROUTE_Y       = 1.20;     // below the preset arc (CARD_Y=1.5) and the answer card (1.85)
// Sit on the same circle x²+z²=ARC_RADIUS² as the preset cards, at angle 0
// (front-centre — between activity at θ=-π/20 and objects at θ=+π/20).
// Y is below the cards' plane so it never collides with their footprint.
const ROUTE_DIST    = -ARC_RADIUS;
const ORBIT_RADIUS  = 2.0;
const ORBIT_Y       = 1.55;

const COL_BG        = 0x07090f;
const COL_PANEL     = 0x12182a;
const COL_PANEL_H   = 0x1f2740;
const COL_PANEL_C   = 0xffa276;
const COL_TEXT      = 0xc9d4ec;
const COL_TEXT_H   = 0xffa276;
const COL_HINT      = 0x6e87b8;
const COL_PLANETS   = [0x6ec3f4, 0xffa276, 0xb592e0, 0x69e2c4, 0xf3d27a];

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
  starLayers: [],        // parallax + twinkle star Points groups
  physicsPanel: null,    // right-side hover info card
  detail:   null,        // { group, closeMesh }
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

// "Allow camera" button placed off to the user's right-and-back at
// azimuth +120° (clockwise around Y from -Z forward), on the same
// ARC_RADIUS circle as the cards. After lookAt() faces the user, a
// rotateZ in the local frame rolls the panel 50° around its facing
// axis. Visible only until requestCamera() succeeds.
function makeCameraBtn() {
  const group = new THREE.Group();
  const yaw = 120 * Math.PI / 180;          // azimuth from -Z forward
  const roll = 50 * Math.PI / 180;          // local-Z roll after lookAt
  group.position.set(
    Math.sin(yaw) * ARC_RADIUS,
    1.40,
    -Math.cos(yaw) * ARC_RADIUS,
  );

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.14),
    frontMaterial(0x4a2a14, 0.96),          // amber — reads as "permission needed"
  );
  panel.userData.kind = 'camera-grant';
  panel.userData.baseColor = 0x4a2a14;
  group.add(panel);

  const text = makeText('🎥 Allow camera', { size: 0.045, color: 0xffd1a3 });
  text.position.z = 0.002;
  text.sync();
  group.add(text);

  group.lookAt(0, group.position.y, 0);     // face the user
  group.rotateZ(roll);                      // 50° roll in local frame
  group.visible = !isCameraReady();
  group.userData = { kind: 'camera-btn-group', panel, text };
  return group;
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

  const text = makeText('Find skills →', { size: 0.05, color: COL_TEXT_H });
  text.position.z = 0.002;
  text.sync();
  group.add(text);

  group.lookAt(0, ROUTE_Y, 0);
  group.visible = false;
  group.userData = { kind: 'route-group', panel, text, originalColor: 0x2d2160 };
  return group;
}

function makePlanet(skill, i, n) {
  const score = Math.max(0, Math.min(1, +skill.score || 0.5));
  const cls   = skill.class || 'planet';
  const elements = classElements(cls);
  const radius = 0.06 + score * 0.08;     // sphere visual size
  const color = COL_PLANETS[i % COL_PLANETS.length];

  const mesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius, 1),
    new THREE.MeshStandardMaterial({
      color, roughness: 0.4, metalness: 0.1,
      emissive: color, emissiveIntensity: 0.25,
    }),
  );

  // Random initial mean anomaly so co-class planets don't bunch at periapsis.
  const M0 = Math.random() * Math.PI * 2;
  const p0 = keplerPosition(elements, 0, M0);
  mesh.position.set(p0.x, p0.y + ORBIT_Y, p0.z);
  mesh.userData = {
    kind: 'planet', skill, elements, M0, color, radius, cls,
  };

  const label = makeText(`${skill.name}  ·  ${cls}`, { size: 0.032, color: 0xffffff });
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
    pts.push(new THREE.Vector3(x_op, y_op * si + ORBIT_Y, y_op * ci));
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

function updatePhysicsPanel(skill, elements) {
  const panel = state.physicsPanel;
  if (!panel) return;
  const cls = skill.class || 'planet';
  const T = classPeriod(elements);
  panel.userData.title.text = skill.name;
  panel.userData.title.sync();
  panel.userData.meta.text = `class: ${cls} · score ${(skill.score * 100).toFixed(0)}%`;
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

function makeDetailCard(skill) {
  const group = new THREE.Group();
  const w = 0.95, h = 0.50;
  group.position.set(0, ANSWER_Y, ANSWER_DIST + 0.4);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    frontMaterial(COL_PANEL, 0.96),
  );
  group.add(panel);

  const title = makeText(skill.name || 'skill', {
    size: 0.045, color: COL_TEXT_H, anchorX: 'left', anchorY: 'top',
  });
  title.position.set(-w / 2 + 0.05, h / 2 - 0.05, 0.002);
  title.sync();
  group.add(title);

  const meta = makeText(`${skill.system || 'unknown'}  ·  match ${(Math.max(0, Math.min(1, +skill.score || 0)) * 100).toFixed(0)}%`, {
    size: 0.030, color: 0x9bb6ea, anchorX: 'left', anchorY: 'top',
  });
  meta.position.set(-w / 2 + 0.05, h / 2 - 0.12, 0.002);
  meta.sync();
  group.add(meta);

  const body = makeText(skill.description || skill.summary || '(no description)', {
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
  setHint('aim "Find skills" or pick another preset', COL_TEXT);
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
    setHint('aim "Find skills" or pick another preset', COL_TEXT);
  }
}

async function routeAndOrbit() {
  if (state.routeBusy) return;
  state.routeBusy = true;
  state.phase = 'routing';
  state.route.visible = false;
  setHint('routing locally via meridian edge router…', COL_TEXT_H);

  let skills = [];
  try {
    const { route } = await import(/* @vite-ignore */ ROUTER_MODULE);
    const data = await route({
      task:      state.full.slice(0, 500),
      limit:     5,
      skillsUrl: ROUTER_CORPUS,
    });
    skills = (data.skills || []).slice(0, 5);
  } catch (e) {
    console.warn('[lens] router import/route failed', e);
  }
  if (!skills.length) skills = FALLBACK_SKILLS;
  spawnOrbit(skills);
  state.routeBusy = false;
}

function spawnOrbit(skills) {
  clearOrbit();
  // /api/orbital-route nests classification + uses route_score; FALLBACK_SKILLS
  // is flat with score in 0..1. Read both. route_score is unbounded (≈0..200+),
  // so normalize against the batch max when it overflows the 0..1 visual range.
  const rawScores = skills.map(s => +s.route_score || +s.score || +s.match || 0);
  const maxRaw = Math.max(0.0001, ...rawScores);
  const needsNormalize = maxRaw > 1.5;
  skills.forEach((raw, i) => {
    const rawScore = rawScores[i];
    const sk = {
      id: raw.id || raw.slug || `s-${i}`,
      name: raw.name || raw.slug || raw.label || `skill-${i}`,
      class: raw.classification?.class || raw.class || raw.cls || 'planet',
      score: needsNormalize ? rawScore / maxRaw : rawScore,
      system: raw.classification?.star_system || raw.system || raw.system_id || raw.provider || '',
      description: raw.description || raw.summary || raw.body || '',
    };
    const planet = makePlanet(sk, i, skills.length);
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
  state.phase = 'orbit';
  setHint('aim a planet to inspect orbital elements', COL_TEXT);
}

function spawnDemoSkills() {
  closeDetail();
  state.answer.visible = false;
  state.route.visible = false;
  spawnOrbit(DEMO_SKILLS);
  setHint('demo · one curated skill per class', COL_TEXT);
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
  hidePhysicsPanel();
}

function showDetail(skill) {
  closeDetail();
  const card = makeDetailCard(skill);
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
    showDetail(panel.userData.skill);
  } else if (k === 'close' && state.phase === 'detail') {
    closeDetail();
    state.phase = 'orbit';
    setHint('aim a planet to inspect', COL_TEXT);
  } else if (k === 'physics-close') {
    hidePhysicsPanel();
  } else if (k === 'camera-grant') {
    setHint('check the browser window for the camera prompt', COL_TEXT_H);
    requestCamera({ facingMode: 'environment' })
      .then(() => {
        if (state.cameraBtn) state.cameraBtn.visible = false;
        setHint('camera granted ✓', COL_TEXT);
      })
      .catch((e) => {
        setHint('camera denied: ' + (e.message || e), COL_HINT);
      });
  } else if (k === 'navlink') {
    const url = panel.userData.url;
    if (url === '__exit__') {
      // End the XR session so the DOM gate (and the burger menu) reappear.
      state.renderer?.xr?.getSession?.()?.end?.();
    } else if (url === '__demo__') {
      spawnDemoSkills();
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
      updatePhysicsPanel(panel.userData.skill, panel.userData.elements);
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
      const pos = keplerPosition(p.userData.elements, tNow, p.userData.M0);
      p.position.set(pos.x, pos.y + ORBIT_Y, pos.z);
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
  set('cap-opfs', opfs, opfs ? 'OPFS · model cached after first load' : 'OPFS · model re-downloads each visit')

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
      try {
        await loadVlm({
          onProgress: (frac, file) => {
            if (dlBar) { dlBar.value = Math.round(frac); }
            if (status) status.textContent = `Loading ${file?.split('/').pop() || 'weights'}… ${Math.round(frac)}%`;
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
        if (status) status.textContent = 'SmolVLM ready · requesting camera…';
        try {
          await requestCamera({ facingMode: 'environment' });
          ready('Camera + VLM ready · enter VR. The trigger captures from your camera.');
        } catch (e) {
          console.warn('[lens] camera unavailable, scene-capture fallback:', e);
          ready('VLM ready · camera denied/unavailable, will describe the rendered VR scene.');
        }
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
