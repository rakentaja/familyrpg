import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { stylize, hatchUniforms, outlines } from './style.js';

// SB_PAL = {pal:[{name,hex}], rows:[{key,label}], chars:[{key,label,glb,tex:{<rowKey>:dataUri}}]}
const D = window.SB_PAL;
const $ = (id) => document.getElementById(id);
const FOV = 24, YAW0 = { /* per-character front correction, radians */ };

// ---------- DOM ----------
const sw = $('swatches');
for (const p of D.pal) {
  const s = document.createElement('div'); s.className = 'sw';
  s.innerHTML = `<i style="background:${p.hex}"></i><span>${p.name}<br><small>${p.hex}</small></span>`;
  sw.appendChild(s);
}
const grid = $('grid');
grid.style.setProperty('--cols', D.chars.length);
const cells = []; // {el, char, row}
grid.appendChild(Object.assign(document.createElement('div'), { className: 'corner' }));
D.chars.forEach((c, ci) => {
  const h = document.createElement('button'); h.className = 'colh'; h.textContent = c.label; h.title = 'Focus ' + c.label;
  h.onclick = () => focus(ci); grid.appendChild(h);
});
D.rows.forEach((r, ri) => {
  const l = document.createElement('div'); l.className = 'rowh'; l.textContent = r.label; grid.appendChild(l);
  D.chars.forEach((c, ci) => {
    const el = document.createElement('div'); el.className = 'cell'; el.onclick = () => focus(ci);
    grid.appendChild(el); cells.push({ el, ci, ri, view: 'grid' });
  });
});
// focus view: the three strengths of one character, large, with the flat textures underneath
const fcells = [];
D.rows.forEach((r, ri) => {
  const w = document.createElement('div'); w.className = 'fcol';
  w.innerHTML = `<div class="flab">${r.label}</div>`;
  const el = document.createElement('div'); el.className = 'cell big'; w.appendChild(el);
  const img = document.createElement('img'); img.className = 'tex'; img.alt = r.label + ' texture'; w.appendChild(img);
  $('focus').appendChild(w); fcells.push({ el, ri, img, view: 'focus' });
});

// ---------- renderer ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setScissorTest(true);
const scene = new THREE.Scene();
const sun = new THREE.DirectionalLight(0xfff4e6, 2.4); sun.position.set(-3, 6, 4);
scene.add(sun, new THREE.HemisphereLight(0xf4efe6, 0xb4abc6, 1.1));
const camera = new THREE.PerspectiveCamera(FOV, 0.75, 0.02, 100);

const state = { raw: false, ink: true, hatch: true, yaw: 0, focus: -1 };
const models = []; // [ci][ri] -> {group, toon:[mesh,mat][], raw:[]}
const fit = []; // per char {center, height, radius}

const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const loadImg = (uri) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = uri; });

async function build() {
  for (const [ci, c] of D.chars.entries()) {
    const g = await loader.loadAsync(c.glb);
    const clip = g.animations.find((a) => a.name === 'idle') || g.animations[0];
    const row = [];
    for (const [ri, r] of D.rows.entries()) {
      const root = SkeletonUtils.clone(g.scene);
      const img = c.tex[r.key] ? await loadImg(c.tex[r.key]) : null;
      const meshes = [];
      root.traverse((o) => { if (o.isMesh) meshes.push(o); });
      for (const o of meshes) {
        o.material = o.material.clone();
        if (img && o.material.map) {
          const map = o.material.map.clone(); map.source = new THREE.Source(img); map.needsUpdate = true; o.material.map = map;
        }
      }
      const raws = meshes.map((o) => new THREE.MeshBasicMaterial({ map: o.material.map, color: o.material.color }));
      if (clip) { const mx = new THREE.AnimationMixer(root); mx.clipAction(clip).play(); mx.update(0); }
      stylize(root, 'thin');
      const group = new THREE.Group(); group.add(root); group.visible = false; scene.add(group);
      row.push({ group, meshes, toon: meshes.map((o) => o.material), raws });
    }
    models.push(row);
    const probe = row[0].group; probe.updateMatrixWorld(true);
    probe.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.update(); });
    const b = new THREE.Box3().setFromObject(probe, true);
    const size = b.getSize(new THREE.Vector3()), center = b.getCenter(new THREE.Vector3());
    fit.push({ center, height: size.y, minY: b.min.y, radius: Math.max(size.x, size.z) / 2 });
    for (const m of row) { m.group.children[0].position.set(-center.x, 0, -center.z); }
    $('status').textContent = `loading ${ci + 1}/${D.chars.length}`;
  }
  $('status').textContent = '';
  applyState();
}

function applyState() {
  hatchUniforms.uHatch.value = state.hatch && !state.raw ? 1 : 0;
  for (const l of outlines) l.visible = state.ink && !state.raw;
  for (const row of models) for (const m of row) {
    m.meshes.forEach((o, i) => { o.material = state.raw ? m.raws[i] : m.toon[i]; });
  }
  $('bToon').classList.toggle('on', !state.raw); $('bRaw').classList.toggle('on', state.raw);
  $('bInk').classList.toggle('on', state.ink); $('bHatch').classList.toggle('on', state.hatch);
  $('bInk').disabled = $('bHatch').disabled = state.raw;
  document.body.classList.toggle('focusing', state.focus >= 0);
  if (state.focus >= 0) {
    const c = D.chars[state.focus];
    $('ftitle').textContent = c.label;
    fcells.forEach((f) => { f.img.src = c.tex[D.rows[f.ri].key] || c.orig_tex; });
  }
  dirty = true;
}

function focus(ci) { state.focus = ci; applyState(); window.scrollTo(0, 0); }

// ---------- draw ----------
let dirty = true;
function drawCell(el, ci, ri, clip) {
  const r = el.getBoundingClientRect();
  const x0 = Math.max(r.left, clip.left), x1 = Math.min(r.right, clip.right);
  const y0 = Math.max(r.top, clip.top), y1 = Math.min(r.bottom, clip.bottom);
  if (x1 <= x0 || y1 <= y0) return;
  const H = canvas.clientHeight;
  renderer.setViewport(r.left, H - r.bottom, r.width, r.height);
  renderer.setScissor(x0, H - y1, x1 - x0, y1 - y0);
  const f = fit[ci], m = models[ci][ri];
  m.group.visible = true; m.group.rotation.y = state.yaw + (YAW0[D.chars[ci].key] || 0);
  camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
  const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const dist = Math.max((f.height * 0.56) / t, (f.radius * 1.15) / (t * camera.aspect)) + f.radius;
  const cy = f.minY + f.height * 0.5, el10 = 0.17;
  camera.position.set(0, cy + Math.sin(el10) * dist, Math.cos(el10) * dist);
  camera.lookAt(0, cy, 0);
  renderer.render(scene, camera);
  m.group.visible = false;
}
function frame() {
  requestAnimationFrame(frame);
  if (!dirty || !fit.length) return;
  dirty = false;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio()))
    renderer.setSize(w, h, false);
  renderer.setScissor(0, 0, w, h); renderer.setClearColor(0, 0); renderer.clear();
  if (state.focus >= 0) {
    const clip = $('focus').getBoundingClientRect();
    for (const f of fcells) drawCell(f.el, state.focus, f.ri, clip);
  } else {
    const clip = $('gridwrap').getBoundingClientRect();
    for (const c of cells) if (c.ci < fit.length) drawCell(c.el, c.ci, c.ri, clip);
  }
}
const redraw = () => { dirty = true; };
addEventListener('resize', redraw); addEventListener('scroll', redraw, { passive: true });
$('gridwrap').addEventListener('scroll', redraw, { passive: true });

// ---------- controls ----------
$('bToon').onclick = () => { state.raw = false; applyState(); };
$('bRaw').onclick = () => { state.raw = true; applyState(); };
$('bInk').onclick = () => { state.ink = !state.ink; applyState(); };
$('bHatch').onclick = () => { state.hatch = !state.hatch; applyState(); };
$('bBack').onclick = () => { state.focus = -1; applyState(); };
$('yaw').oninput = (e) => { state.yaw = THREE.MathUtils.degToRad(+e.target.value); $('yawv').textContent = `${e.target.value}°`; dirty = true; };
// drag on a cell turns everything
let drag = null;
document.addEventListener('pointerdown', (e) => { if (e.target.classList.contains('cell')) drag = { x: e.clientX, yaw: state.yaw, moved: false }; });
document.addEventListener('pointermove', (e) => {
  if (!drag) return; const dx = e.clientX - drag.x; if (Math.abs(dx) > 4) drag.moved = true;
  state.yaw = drag.yaw + dx * 0.012; const deg = Math.round(THREE.MathUtils.radToDeg(state.yaw) % 360);
  $('yaw').value = ((deg + 540) % 360) - 180; $('yawv').textContent = `${$('yaw').value}°`; dirty = true;
});
document.addEventListener('pointerup', () => { drag = null; });
document.addEventListener('click', (e) => { if (drag?.moved) e.stopPropagation(); }, true);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { state.focus = -1; applyState(); }
  if (e.key === 't') { state.raw = !state.raw; applyState(); }
});

// hooks for headless screenshots
window.SB_SET = (o) => {
  Object.assign(state, o);
  if (o.yawDeg !== undefined) state.yaw = THREE.MathUtils.degToRad(o.yawDeg);
  if (o.yawFix) Object.assign(YAW0, o.yawFix);
  applyState();
};
window.SB_READY = false;
build().then(() => { requestAnimationFrame(() => requestAnimationFrame(() => { window.SB_READY = true; })); })
  .catch((e) => { $('status').textContent = 'load error: ' + e.message; console.error(e); });
requestAnimationFrame(frame);
