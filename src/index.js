// Lens — step 4: end-to-end click flow.
//
// IDLE  → preset click → THINKING (streamed mock answer) → ANSWER
// ANSWER → "Find skills" → ROUTING → ORBIT (real /api/orbital-route)
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
import { init } from './init.js';

// ── Tunables ─────────────────────────────────────────────────────────────
const PRESETS = [
  { id: 'describe', label: 'Describe',     prompt: 'Describe this scene in one sentence.' },
  { id: 'read',     label: 'Read text',    prompt: 'What text is visible? Transcribe it verbatim.' },
  { id: 'activity', label: 'Activity?',    prompt: 'What activity is happening here?' },
  { id: 'objects',  label: 'List objects', prompt: 'List the visible objects, comma-separated.' },
  { id: 'context',  label: 'Context',      prompt: 'Work, home, outdoor, public — which?' },
  { id: 'skills',   label: 'Skill hint',   prompt: 'What skills would I need to act on this?' },
];

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
  { label: '✕ Exit VR',     url: '__exit__' },
];
const NAV_X      = -1.55;
const NAV_Y_TOP  = 1.85;
const NAV_GAP    = 0.16;
const NAV_W      = 0.70;
const NAV_H      = 0.13;

const FALLBACK_SKILLS = [
  { id: 'orbital-route', name: 'orbital-route', score: 0.91, system: 'meridian-mcp', description: 'Route a free-form task to compatible skills via Llama-3.3-70B classification.' },
  { id: 'vision-snap',   name: 'vision-snap',   score: 0.74, system: 'lens',         description: 'Capture the current scene and run a VLM query in-headset.' },
  { id: 'skill-orbit',   name: 'skill-orbit',   score: 0.62, system: 'meridian-mcp', description: 'Materialise matched skills as orbital planets around the user.' },
];

const ROUTE_ENDPOINT = 'https://ask-meridian.uk/api/orbital-route';

const ARC_RADIUS    = 1.5;
const CARD_Y        = 1.5;
const ARC_SPAN      = Math.PI / 2;
const PANEL_W       = 0.50;
const PANEL_H       = 0.18;
const ANSWER_Y      = 1.85;
const ANSWER_DIST   = -1.6;
const ANSWER_W      = 1.1;
const ANSWER_H      = 0.50;
const ROUTE_Y       = ANSWER_Y - 0.40;
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

function makeRouteButton() {
  const group = new THREE.Group();
  group.position.set(0, ROUTE_Y, ANSWER_DIST + 0.02);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.55, 0.10),
    frontMaterial(0x1f2740, 0.95),
  );
  panel.userData.kind = 'route';
  group.add(panel);

  const text = makeText('Find skills →', { size: 0.038, color: COL_TEXT_H });
  text.position.z = 0.002;
  text.sync();
  group.add(text);

  group.lookAt(0, ROUTE_Y, 0);
  group.visible = false;
  group.userData = { kind: 'route-group', panel, text, originalColor: 0x1f2740 };
  return group;
}

function makePlanet(skill, i, n) {
  const ang = (i / n) * Math.PI * 2;
  const score = Math.max(0, Math.min(1, +skill.score || 0.5));
  const radius = 0.07 + score * 0.10;
  const y = ORBIT_Y + (score - 0.5) * 0.5;
  const color = COL_PLANETS[i % COL_PLANETS.length];

  const mesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius, 1),
    new THREE.MeshStandardMaterial({
      color, roughness: 0.4, metalness: 0.1,
      emissive: color, emissiveIntensity: 0.25,
    }),
  );
  mesh.position.set(Math.cos(ang) * ORBIT_RADIUS, y, Math.sin(ang) * ORBIT_RADIUS);
  mesh.userData = {
    kind: 'planet', skill, ang, radius, y,
    spin: 0.18 + Math.random() * 0.10,
    color,
  };
  // Use raycaster intersectObjects(planet) — Mesh works fine even though
  // it's not a flat panel. Adding the planet itself to state.panels.

  // Static label that always faces origin (planet position varies per frame
  // so we'll re-orient the label in onFrame; planets themselves don't need
  // to face the user since they're round).
  const label = makeText(`${skill.name}  ·  ${(score * 100).toFixed(0)}%`, {
    size: 0.035, color: 0xffffff,
  });
  label.position.y = radius + 0.05;
  label.sync();
  mesh.add(label);
  mesh.userData.label = label;

  return mesh;
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
  group.position.set(NAV_X, NAV_Y_TOP - i * NAV_GAP, -1.0);

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
function setupScene({ scene, renderer }) {
  state.scene = scene;
  state.renderer = renderer;
  scene.background = new THREE.Color(COL_BG);
  scene.add(new THREE.AmbientLight(0x202838, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(2, 5, 3);
  scene.add(key);

  // Starfield
  {
    const geom = new THREE.BufferGeometry();
    const N = 800;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random(), v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi   = Math.acos(2 * v - 1);
      const r = 25 + Math.random() * 8;
      pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(geom, new THREE.PointsMaterial({
      color: 0xc9d4ec, size: 0.07, sizeAttenuation: true,
      transparent: true, opacity: 0.85,
    })));
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
  state.full = MOCK_ANSWERS[preset.id] || '...';
  state.shown = 0;
  state.thinkStart = performance.now();
  state.phase = 'thinking';

  state.answer.userData.title.text = preset.label;
  state.answer.userData.title.sync();
  state.answer.userData.meta.text  = 'mock';
  state.answer.userData.meta.sync();
  state.answer.userData.body.text  = '';
  state.answer.userData.body.sync();
  state.answer.visible = true;

  state.route.visible = false;
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
  setHint('routing through ask-meridian.uk…', COL_TEXT_H);

  let skills = [];
  try {
    const res = await fetch(ROUTE_ENDPOINT, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: state.full.slice(0, 500),
        limit: 5, provider: 'workers-ai', context: 'text',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) skills = (data.skills || data.results || []).slice(0, 5);
  } catch (e) {
    console.warn('[lens] route fetch failed', e);
  }
  if (!skills.length) skills = FALLBACK_SKILLS;
  spawnOrbit(skills);
  state.routeBusy = false;
}

function spawnOrbit(skills) {
  clearOrbit();
  skills.forEach((raw, i) => {
    const sk = {
      id: raw.id || `s-${i}`,
      name: raw.name || raw.label || `skill-${i}`,
      score: raw.score ?? raw.match ?? 0.5,
      system: raw.system || raw.system_id || raw.provider || '',
      description: raw.description || raw.summary || raw.body || '',
    };
    const planet = makePlanet(sk, i, skills.length);
    state.scene.add(planet);
    state.orbit.push(planet);
    state.panels.push(planet);
  });
  state.phase = 'orbit';
  setHint('aim a planet to inspect', COL_TEXT);
}

function clearOrbit() {
  state.orbit.forEach((p) => {
    state.scene.remove(p);
    const idx = state.panels.indexOf(p);
    if (idx >= 0) state.panels.splice(idx, 1);
  });
  state.orbit = [];
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
function flashClick(panel) {
  const orig = panel.material.color.getHex();
  panel.userData._origColor = orig;
  panel.material.color.setHex(COL_PANEL_C);
  state.flashUntil = performance.now() + 220;
  state.flashing = panel;
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
  } else if (k === 'navlink') {
    const url = panel.userData.url;
    if (url === '__exit__') {
      // End the XR session so the DOM gate (and the burger menu) reappear.
      state.renderer?.xr?.getSession?.()?.end?.();
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
    if (m.userData.kind === 'preset') {
      m.material.color.setHex(COL_PANEL);
      const card = m.parent;
      card.userData.text.color = COL_TEXT;
      card.userData.text.material.color.setHex(COL_TEXT);
      card.userData.text.sync();
    } else if (m.userData.kind === 'route') {
      m.material.color.setHex(0x1f2740);
    } else if (m.userData.kind === 'close') {
      m.material.color.setHex(0x1f2740);
    } else if (m.userData.kind === 'planet') {
      m.material.emissiveIntensity = 0.25;
      m.scale.setScalar(1);
    } else if (m.userData.kind === 'navlink') {
      m.material.color.setHex(m.userData.baseColor);
    }
  }

  if (panel) {
    if (panel.userData.kind === 'preset') {
      panel.material.color.setHex(COL_PANEL_H);
      const card = panel.parent;
      card.userData.text.color = COL_TEXT_H;
      card.userData.text.material.color.setHex(COL_TEXT_H);
      card.userData.text.sync();
    } else if (panel.userData.kind === 'route') {
      panel.material.color.setHex(COL_PANEL_C);
    } else if (panel.userData.kind === 'close') {
      panel.material.color.setHex(COL_PANEL_C);
    } else if (panel.userData.kind === 'planet') {
      panel.material.emissiveIntensity = 0.5;
      panel.scale.setScalar(1.15);
    } else if (panel.userData.kind === 'navlink') {
      panel.material.color.setHex(COL_PANEL_C);
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

  // Orbit motion + label re-face (planet has a label child; keep it
  // facing the user so the score is readable from any orbit position.)
  if (state.orbit.length) {
    const cam = camera.getWorldPosition(_o);
    state.orbit.forEach((p) => {
      p.userData.ang += p.userData.spin * delta;
      p.position.x = Math.cos(p.userData.ang) * ORBIT_RADIUS;
      p.position.z = Math.sin(p.userData.ang) * ORBIT_RADIUS;
      p.userData.label?.lookAt(cam);
    });
  }

  // Click flash decay
  if (state.flashing && performance.now() > state.flashUntil) {
    const m = state.flashing;
    if (m.userData.kind === 'preset') {
      m.material.color.setHex(state.hovered === m ? COL_PANEL_H : COL_PANEL);
    } else if (m.userData.kind === 'route') {
      m.material.color.setHex(state.hovered === m ? COL_PANEL_C : 0x1f2740);
    } else if (m.userData.kind === 'close') {
      m.material.color.setHex(state.hovered === m ? COL_PANEL_C : 0x1f2740);
    }
    state.flashing = null;
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
(async () => {
  const globals = await init(setupScene, onFrame);
  const status = document.getElementById('dl-status');
  if (status) status.textContent = 'Lens · click → answer → orbit · press Enter VR.';
  const begin = document.getElementById('beginBtn');
  if (begin) begin.disabled = true;
  revealVrButton(globals.vrButton);
})();
