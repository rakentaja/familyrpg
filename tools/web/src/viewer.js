import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { stylize, hatchUniforms, outlines } from './style.js';

// SB_ANIM = [{name,label,group,height,model,clips:{idle?:url,walk?:url,run?:url}, motion?:'bob'|'spin'}]
const CHARS = window.SB_ANIM;
const $ = (id) => document.getElementById(id);

const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e1d3);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.55;

const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
sun.position.set(-3, 6, 4); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 4, bottom: -1, near: 0.5, far: 20 });
scene.add(sun, new THREE.HemisphereLight(0xf4efe6, 0xb4abc6, 1.1));

// stage: round plinth
const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.7, 0.12, 48),
  new THREE.MeshToonMaterial({ color: 0xf2eadb }));
plinth.position.y = -0.06; plinth.receiveShadow = true; scene.add(plinth);
const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.64, 64), new THREE.MeshBasicMaterial({ color: 0x2a2328 }));
ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; scene.add(ring);
const grid = new THREE.GridHelper(3, 6, 0xb4abc6, 0xb4abc6); grid.material.transparent = true; grid.material.opacity = 0.4;
grid.position.y = 0.003; scene.add(grid);

const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const cache = {}; const load = (u) => (cache[u] ||= loader.loadAsync(u));

let cur = null; // {holder, model, mixer, actions:{}, active, char, skel}
let playing = true, speed = 1, turntable = false;
const clock = new THREE.Clock();

function frameModel(obj, h) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj, true);
  const s = b.getSize(new THREE.Vector3());
  const tall = Math.max(s.y, 0.6 * Math.max(s.x, s.z));
  const dist = tall * 2.6 + 0.8;
  camera.position.set(dist * 0.55, tall * 0.75 + 0.3, dist);
  controls.target.set(0, tall * 0.48, 0); controls.update();
  return s;
}

async function select(c) {
  document.querySelectorAll('#list li').forEach((li) => li.classList.toggle('sel', li.dataset.n === c.name));
  $('stage-msg').textContent = 'Loading…';
  if (cur) { scene.remove(cur.holder); cur.mixer?.stopAllAction(); }
  outlines.length = 0;
  const g = await load(c.model);
  const holder = new THREE.Group(); scene.add(holder);
  const model = g.scene; // single instance per character; reused on revisit
  if (model.parent) model.parent.remove(model);
  if (!model.userData.styled) { stylize(model, 'thin'); model.userData.styled = true; }
  model.traverse((o) => { if (o.isMesh && o.material?.side === THREE.BackSide) outlines.push(o); });
  holder.add(model);
  // fit height (models are already near target height; static meshes need scaling)
  model.scale.setScalar(1); model.position.set(0, 0, 0); model.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(model, true); const sz = b.getSize(new THREE.Vector3());
  if (Math.abs(sz.y - c.height) / c.height > 0.15) model.scale.setScalar(c.height / sz.y);
  model.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(model, true); model.position.y -= b2.min.y;
  const size = frameModel(model, c.height);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const [k, u] of Object.entries(c.clips || {})) { const url = u === "@model" ? c.model : u;
    const cg = await load(url);
    if (cg.animations[0]) { const clip = cg.animations[0].clone(); clip.name = k; actions[k] = mixer.clipAction(clip); }
  }
  let skel = null; model.traverse((o) => { if (o.isSkinnedMesh && !skel) skel = o.skeleton; });
  const helper = skel ? new THREE.SkeletonHelper(model) : null;
  if (helper) { helper.visible = $('bSkel').classList.contains('on'); helper.material.linewidth = 2; holder.add(helper); }

  let tris = 0; model.traverse((o) => { if (o.isMesh && o.material?.side !== THREE.BackSide) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  cur = { holder, model, mixer, actions, active: null, char: c, helper, base: model.position.y };
  $('meta').innerHTML = `<b>${c.label}</b> · ${c.group}<br>${Math.round(tris).toLocaleString()} triangles · ${skel ? skel.bones.length + ' bones' : 'no rig'}<br>${(sz.y >= 0.2 ? sz.y : c.height).toFixed(2)} m tall`;

  // clip buttons
  const clipsEl = $('clips'); clipsEl.innerHTML = '';
  const names = Object.keys(actions);
  if (!names.length) {
    const m = c.motion || 'bob';
    clipsEl.innerHTML = `<button class="clip on" data-k="__code">${m === 'spin' ? 'Spin + float' : 'Wind-up bob'} <small>(code)</small></button>`;
    cur.code = m; $('stage-msg').textContent = 'Static mesh — motion is driven by code, not baked clips.';
  } else {
    names.forEach((k) => { const b = document.createElement('button'); b.className = 'clip'; b.dataset.k = k;
      b.textContent = k[0].toUpperCase() + k.slice(1); b.onclick = () => play(k); clipsEl.appendChild(b); });
    play(names.includes('idle') ? 'idle' : names[0]);
    $('stage-msg').textContent = '';
  }
  updateTimeline();
}

function play(k) {
  if (!cur?.actions[k]) return;
  const next = cur.actions[k]; const prev = cur.active;
  next.reset().setEffectiveWeight(1).play();
  if (prev && prev !== next) prev.crossFadeTo(next, 0.25, false);
  cur.active = next; cur.activeKey = k;
  document.querySelectorAll('#clips .clip').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
  const d = next.getClip().duration;
  $('scrub').max = d; $('dur').textContent = d.toFixed(2) + 's';
}

function updateTimeline() {
  const has = !!cur?.active;
  ['scrub', 'bPlay'].forEach((id) => ($(id).disabled = !has && !cur?.code));
  if (!has) { $('t').textContent = '—'; $('dur').textContent = ''; }
}

// controls
$('bPlay').onclick = () => { playing = !playing; $('bPlay').textContent = playing ? 'Pause' : 'Play'; };
$('speed').oninput = (e) => { speed = +e.target.value; $('speedv').textContent = speed.toFixed(2) + '×'; };
$('scrub').oninput = (e) => {
  if (!cur?.active) return; playing = false; $('bPlay').textContent = 'Play';
  cur.active.time = +e.target.value; cur.mixer.update(0);
};
$('bTurn').onclick = (e) => { turntable = !turntable; e.target.classList.toggle('on', turntable); };
$('bInk').onclick = (e) => { const on = !e.target.classList.contains('on'); e.target.classList.toggle('on', on); outlines.forEach((o) => (o.visible = on)); };
$('bHatch').onclick = (e) => { const on = !e.target.classList.contains('on'); e.target.classList.toggle('on', on); hatchUniforms.uHatch.value = on ? 1 : 0; };
$('bSkel').onclick = (e) => { const on = !e.target.classList.contains('on'); e.target.classList.toggle('on', on); if (cur?.helper) cur.helper.visible = on; };
addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); $('bPlay').click(); }
  const i = CHARS.findIndex((c) => c === cur?.char);
  if (e.key === 'ArrowDown') select(CHARS[(i + 1) % CHARS.length]);
  if (e.key === 'ArrowUp') select(CHARS[(i - 1 + CHARS.length) % CHARS.length]);
  const n = +e.key; if (n >= 1 && n <= 3 && cur) { const k = Object.keys(cur.actions)[n - 1]; if (k) play(k); }
});

// list
$('list').innerHTML = CHARS.map((c) => {
  const tags = Object.keys(c.clips || {}); const t = tags.length ? tags.join(' · ') : 'static';
  return `<li data-n="${c.name}"><span>${c.label}</span><em>${t}</em></li>`;
}).join('');
document.querySelectorAll('#list li').forEach((li) => (li.onclick = () => select(CHARS.find((c) => c.name === li.dataset.n))));

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (cur) {
    if (playing) cur.mixer.update(dt * speed);
    if (cur.active) { const d = cur.active.getClip().duration; const t = cur.active.time % d;
      $('t').textContent = t.toFixed(2) + 's'; if (playing) $('scrub').value = t; }
    if (cur.code && playing) {
      const tt = clock.elapsedTime * speed;
      if (cur.code === 'spin') { cur.model.rotation.y += dt * speed * 1.6; cur.model.position.y = cur.base + 0.15 + Math.sin(tt * 2) * 0.12; }
      else { cur.model.position.y = cur.base + Math.abs(Math.sin(tt * 6)) * 0.04; cur.model.rotation.z = Math.sin(tt * 12) * 0.03; }
    }
  }
  controls.autoRotate = turntable; controls.autoRotateSpeed = 1.5;
  controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop);
}
resize(); loop();
select(CHARS[0]).then(() => (window.SB_READY = true));
window.SB_SELECT = (n) => select(CHARS.find((c) => c.name === n));
