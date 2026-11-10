import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { stylize, hatchUniforms, outlines } from './style.js';

// SB_REVIEW = {char,label,model, clips:[{key,file,label,source,frames,notes,url}]}
const DATA = window.SB_REVIEW;
const $ = (id) => document.getElementById(id);
const INK = 0x2a2328, ROOT_BONE = 'Hips', TRAVEL_MIN = 0.05, WRAP = 1.6;
const tdir = new THREE.Vector3();

// ---------- renderer / scene ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e1d3);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.55;

const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
sun.position.set(-3, 6, 4); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target, new THREE.HemisphereLight(0xf4efe6, 0xb4abc6, 1.1));
function shadowBox(r) {
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: 40 });
  sun.shadow.camera.updateProjectionMatrix();
}

// ground: cream board, 1 m grid, inked 1 m tile under each bear
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshToonMaterial({ color: 0xf2eadb }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(40, 40, 0xb4abc6, 0xb4abc6);
grid.material.transparent = true; grid.material.opacity = 0.55; grid.position.y = 0.002; scene.add(grid);
const tileGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const tileMat = new THREE.MeshToonMaterial({ color: 0xa9bfa0 });
const tileEdge = new THREE.EdgesGeometry(tileGeo);
const edgeMat = new THREE.LineBasicMaterial({ color: INK });
function makeTile() {
  const t = new THREE.Mesh(tileGeo, tileMat); t.position.y = 0.004; t.receiveShadow = true;
  const e = new THREE.LineSegments(tileEdge, edgeMat); e.position.y = 0.002; t.add(e);
  return t;
}

// ---------- loading ----------
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const loadGLB = (u) => loader.loadAsync(u);

let base = null; // raw gltf of the model
let lift = 0, height = 1, footprint = 0.8;
const clips = []; // {key,label,meta,clip(in-place),dur,fps,frames,travel:Vector3|null}
const rootTravel = {}; // key -> bool (true = let it travel)

const findBone = (root, name) => { let b = null; root.traverse((o) => { if (!b && o.isBone && o.name === name) b = o; }); return b; };

// Analyse Hips.position: horizontal displacement over the clip, in model-root space. If it travels,
// strip the linear drift so the clip loops on the spot; travel is re-applied on the holder when asked.
function prepareClip(raw, key, probe) {
  const clip = raw.clone(); clip.name = key;
  let keys = 0; for (const t of clip.tracks) keys = Math.max(keys, t.times.length);
  let span = 0; for (const t of clip.tracks) if (t.times.length === keys) span = t.times[keys - 1] - t.times[0];
  const fps = span > 0 && keys > 1 ? Math.round((keys - 1) / span) : 30;
  let travel = null;
  const tr = clip.tracks.find((t) => t.name === `${ROOT_BONE}.position`);
  const hips = findBone(probe, ROOT_BONE);
  if (tr && hips && tr.times.length > 1) {
    probe.updateMatrixWorld(true);
    const M = new THREE.Matrix4().copy(probe.matrixWorld).invert().multiply(hips.parent.matrixWorld);
    const Mi = M.clone().invert();
    const v = tr.values, n = tr.times.length, p = new THREE.Vector3(), q = new THREE.Vector3();
    p.fromArray(v, 0).applyMatrix4(M); q.fromArray(v, (n - 1) * 3).applyMatrix4(M);
    const D = q.sub(p).setY(0);
    if (D.length() > TRAVEL_MIN) {
      travel = D.clone();
      const t0 = tr.times[0], t1 = tr.times[n - 1];
      const nv = new Float32Array(v.length);
      for (let i = 0; i < n; i++) {
        p.fromArray(v, i * 3).applyMatrix4(M).addScaledVector(D, -(tr.times[i] - t0) / (t1 - t0)).applyMatrix4(Mi);
        p.toArray(nv, i * 3);
      }
      const idx = clip.tracks.indexOf(tr);
      clip.tracks[idx] = new THREE.VectorKeyframeTrack(tr.name, tr.times, nv, tr.getInterpolation());
    }
  }
  return { clip, dur: clip.duration, fps, travel };
}

function instance() {
  const root = SkeletonUtils.clone(base.scene);
  stylize(root, 'thin');
  root.position.y = lift;
  const holder = new THREE.Group(); holder.add(root);
  const tile = makeTile();
  const group = new THREE.Group(); group.add(tile, holder); scene.add(group);
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const c of clips) actions[c.key] = mixer.clipAction(c.clip);
  const helper = new THREE.SkeletonHelper(root);
  helper.material.depthTest = false; helper.material.transparent = true; helper.renderOrder = 10;
  const col = helper.geometry.attributes.color; const rc = new THREE.Color(0x8a4a4e);
  for (let i = 0; i < col.count; i++) col.setXYZ(i, rc.r, rc.g, rc.b);
  col.needsUpdate = true; helper.visible = skelOn;
  // joint dots so the rig reads at a glance over the toon shading
  const bones = helper.bones;
  const joints = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(bones.length * 3), 3)),
    new THREE.PointsMaterial({ color: 0x8a4a4e, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
  joints.renderOrder = 11; joints.frustumCulled = false; scene.add(helper, joints);
  return { group, holder, root, mixer, actions, helper, joints, bones, active: null, key: null, base: new THREE.Vector3(), lastT: 0 };
}
function dispose(inst) {
  inst.mixer.stopAllAction(); scene.remove(inst.group, inst.helper, inst.joints);
  inst.root.traverse((o) => { if (o.isMesh && o.material?.side === THREE.BackSide) { const i = outlines.indexOf(o); if (i >= 0) outlines.splice(i, 1); } });
}

const v3 = new THREE.Vector3(), labelOff = new THREE.Vector3(0, 0, 0.5); // label under the tile's front edge

// ---------- state ----------
let mode = 'single', single = null, gridInst = [], selKey = null;
let playing = true, speed = 1, loop = true, fade = 0.3, skelOn = false, inkOn = true;
const clock = new THREE.Clock();
const clipBy = (k) => clips.find((c) => c.key === k);
const insts = () => (mode === 'single' ? (single ? [single] : []) : gridInst);

function applyLoop(a) {
  a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); a.clampWhenFinished = !loop;
}

function playOn(inst, key, fadeSec) {
  const next = inst.actions[key]; const prev = inst.active;
  if (!next) return;
  applyLoop(next);
  next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
  if (prev && prev !== next) { if (fadeSec > 0) prev.crossFadeTo(next, fadeSec, false); else prev.stop(); }
  inst.active = next; inst.key = key; inst.lastT = 0;
  inst.base.copy(inst.holder.position);
  if (!(clipBy(key).travel && rootTravel[key])) { inst.base.set(0, 0, 0); inst.holder.position.set(0, 0, 0); }
}

function select(key) {
  if (!clipBy(key)) return;
  selKey = key;
  if (mode === 'single') playOn(single, key, fade);
  document.querySelectorAll('#clips .clip').forEach((b) => b.classList.toggle('on', b.dataset.k === key));
  document.querySelectorAll('#labels div').forEach((d) => d.classList.toggle('sel', d.dataset.k === key));
  const c = clipBy(key);
  const rb = $('bRoot');
  rb.disabled = !c.travel || mode === 'grid';
  rb.textContent = c.travel && rootTravel[key] ? 'Travel' : 'In place';
  rb.classList.toggle('on', !!(c.travel && rootTravel[key]));
  const m = c.meta;
  const bits = [`${c.frames} f @ ${c.fps} fps`, `${c.dur.toFixed(2)} s`];
  if (c.travel) bits.push(`root moves ${c.travel.length().toFixed(2)} m/loop`);
  $('meta').innerHTML = `<b>${DATA.label}</b> · ${mode === 'grid' ? `${clips.length} clips side by side` : c.label}<br>`
    + `${mode === 'grid' ? `selected: ${c.label}` : bits.join(' · ')}${m.file ? `<br><span class="notes">${m.file}${m.source ? ' · ' + m.source : ''}</span>` : ''}`
    + (m.notes && mode !== 'grid' ? `<br><span class="notes">${m.notes}</span>` : '');
}

function frameCamera() {
  const box = new THREE.Box3();
  for (const i of insts()) { i.group.updateMatrixWorld(true); box.expandByObject(i.group, false);
    box.expandByPoint(v3.copy(i.group.position).setY(height)); }
  const c = box.getCenter(new THREE.Vector3()), r = box.getBoundingSphere(new THREE.Sphere()).radius;
  const vf = THREE.MathUtils.degToRad(camera.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  const dist = r / Math.sin(Math.min(vf, hf) / 2) * (mode === 'grid' ? 0.8 : 0.9);
  const dir = new THREE.Vector3(0.45, 0.45, 1).normalize();
  controls.target.copy(c).setY(height * (mode === 'grid' ? 0.4 : 0.48));
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  controls.update();
  const s = box.getSize(new THREE.Vector3());
  shadowBox(Math.max(3, Math.max(s.x, s.z) * 0.75 + 1));
  sun.target.position.copy(controls.target); sun.position.copy(controls.target).add(new THREE.Vector3(-3, 6, 4));
}

function setMode(m) {
  mode = m;
  $('mSingle').classList.toggle('on', m === 'single'); $('mGrid').classList.toggle('on', m === 'grid');
  const lab = $('labels'); lab.innerHTML = '';
  if (m === 'grid') {
    single.group.visible = false; single.helper.visible = single.joints.visible = false; single.mixer.timeScale = 0;
    if (!gridInst.length) {
      const n = clips.length, cols = n <= 4 ? n : Math.ceil(Math.sqrt(n));
      const gap = Math.max(1.6, footprint * 1.6, height * 0.95);   // big characters (troll, golem) need more room
      const rows = Math.ceil(clips.length / cols);
      clips.forEach((c, i) => {
        const inst = instance();
        inst.group.position.set((i % cols - (cols - 1) / 2) * gap, 0, (Math.floor(i / cols) - (rows - 1) / 2) * gap);
        playOn(inst, c.key, 0); gridInst.push(inst);
      });
      outlines.forEach((o) => (o.visible = inkOn));
    }
    gridInst.forEach((g) => { g.group.visible = true; g.helper.visible = skelOn; g.holder.position.set(0, 0, 0); g.mixer.timeScale = 1; });
    syncGrid(0);
    for (const g of gridInst) {
      const d = document.createElement('div'); d.dataset.k = g.key; d.textContent = clipBy(g.key).label;
      d.onclick = () => { select(g.key); }; d.ondblclick = () => { setMode('single'); select(g.key); };
      lab.appendChild(d); g.label = d;
    }
  } else {
    gridInst.forEach((g) => { g.group.visible = false; g.helper.visible = g.joints.visible = false; g.mixer.timeScale = 0; });
    single.group.visible = true; single.helper.visible = skelOn; single.mixer.timeScale = 1;
  }
  select(selKey); frameCamera();
}
function syncGrid(phase) {
  for (const g of gridInst) { g.active.time = phase * g.active.getClip().duration; g.mixer.update(0); }
}

// ---------- UI ----------
function buildUI() {
  const el = $('clips'); el.innerHTML = '';
  clips.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'clip' + (c.travel ? ' travels' : ''); b.dataset.k = c.key;
    b.innerHTML = `<span>${i < 9 ? `<span class="lbl">${i + 1}</span> ` : ''}${c.label}</span><small>${c.frames} f · ${c.dur.toFixed(2)} s</small>`;
    b.onclick = () => select(c.key); el.appendChild(b);
  });
}
const setPlaying = (p) => { playing = p; $('bPlay').textContent = playing ? 'Pause' : 'Play'; };
$('bPlay').onclick = () => {
  if (!playing) for (const i of insts()) if (i.active && !loop && i.active.time >= i.active.getClip().duration - 1e-3) { i.active.reset().play(); }
  setPlaying(!playing);
};
$('speed').oninput = (e) => { speed = +e.target.value; $('speedv').textContent = speed.toFixed(2) + '×'; };
$('fade').oninput = (e) => { fade = +e.target.value; $('fadev').textContent = fade.toFixed(2) + 's'; };
$('scrub').oninput = (e) => seek(+e.target.value);
function seek(phase) {
  setPlaying(false);
  for (const i of insts()) { if (!i.active) continue; const d = i.active.getClip().duration;
    i.active.paused = false; i.active.enabled = true; i.active.time = Math.min(phase, 0.99999) * d; i.lastT = i.active.time; }
  for (const i of insts()) { i.mixer.update(0); placeRoot(i, false); }
}
function step(df) {
  const c = clipBy(selKey); if (!c) return;
  const ref = mode === 'single' ? single.active : gridInst.find((g) => g.key === selKey)?.active; if (!ref) return;
  const d = ref.getClip().duration; let t = (ref.time + df / c.fps) % d; if (t < 0) t += d;
  seek(t / d);
}
$('bLoop').onclick = (e) => { loop = !loop; e.currentTarget.classList.toggle('on', loop); for (const i of [single, ...gridInst]) Object.values(i.actions).forEach(applyLoop); };
$('bRoot').onclick = () => { if (!selKey) return; rootTravel[selKey] = !rootTravel[selKey]; select(selKey);
  single.base.set(0, 0, 0); single.holder.position.set(0, 0, 0); single.lastT = single.active?.time || 0; };
$('bSkel').onclick = (e) => { skelOn = !skelOn; e.currentTarget.classList.toggle('on', skelOn); insts().forEach((i) => (i.helper.visible = skelOn)); };
$('bInk').onclick = (e) => { inkOn = !inkOn; e.currentTarget.classList.toggle('on', inkOn); outlines.forEach((o) => (o.visible = inkOn)); };
$('bHatch').onclick = (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); hatchUniforms.uHatch.value = on ? 1 : 0; };
$('bCam').onclick = () => frameCamera();
$('mSingle').onclick = () => mode !== 'single' && setMode('single');
$('mGrid').onclick = () => mode !== 'grid' && setMode('grid');
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === ' ') { e.preventDefault(); $('bPlay').click(); }
  else if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'g' || e.key === 'G') setMode(mode === 'grid' ? 'single' : 'grid');
  else if (e.key === 's' || e.key === 'S') $('bSkel').click();
  else { const n = +e.key; if (n >= 1 && n <= 9 && clips[n - 1]) select(clips[n - 1].key); }
});

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  hatchUniforms.uRes.value.set(w, h);
}
addEventListener('resize', resize);

// root travel: clip plays in place, holder carries the stripped displacement
function placeRoot(i, advancing) {
  const c = i.key && clipBy(i.key);
  if (mode !== 'single' || !c?.travel || !rootTravel[i.key] || !i.active) { if (mode === 'single' && i === single) i.holder.position.set(0, 0, 0); return; }
  const d = i.active.getClip().duration, t = i.active.time;
  if (advancing && t + 1e-4 < i.lastT) i.base.add(c.travel);
  i.lastT = t;
  i.holder.position.copy(i.base).addScaledVector(c.travel, t / d);
  // walk across the stage: past +WRAP along the travel direction, jump back to -WRAP
  tdir.copy(c.travel).normalize();
  if (i.holder.position.dot(tdir) > WRAP) { i.base.addScaledVector(tdir, -2 * WRAP); i.holder.position.addScaledVector(tdir, -2 * WRAP); }
}

function loop_() {
  const dt = Math.min(clock.getDelta(), 0.05);
  for (const i of insts()) {
    if (playing) i.mixer.update(dt * speed); placeRoot(i, playing);
    i.joints.visible = i.helper.visible;
    if (i.helper.visible) { i.root.updateMatrixWorld(true); const a = i.joints.geometry.attributes.position;
      i.bones.forEach((b, k) => { v3.setFromMatrixPosition(b.matrixWorld); a.setXYZ(k, v3.x, v3.y, v3.z); }); a.needsUpdate = true; }
  }
  // readout from the selected clip
  const ref = mode === 'single' ? single?.active : gridInst.find((g) => g.key === selKey)?.active;
  const c = selKey && clipBy(selKey);
  if (ref && c) {
    const d = ref.getClip().duration, t = loop ? ref.time % d : Math.min(ref.time, d);
    const f = Math.min(c.frames, Math.round(t * c.fps));
    $('tread').textContent = `f ${String(f).padStart(3, ' ')} / ${c.frames} · ${t.toFixed(2)} / ${d.toFixed(2)} s`;
    if (playing) $('scrub').value = d ? t / d : 0;
  }
  if (mode === 'grid') {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const g of gridInst) {
      v3.copy(g.group.position).add(labelOff).project(camera);
      g.label.style.left = ((v3.x + 1) / 2 * w) + 'px'; g.label.style.top = ((1 - v3.y) / 2 * h + 4) + 'px';
      g.label.style.display = v3.z < 1 ? '' : 'none';
    }
  }
  controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop_);
}

// ---------- boot ----------
async function boot() {
  $('meta').textContent = 'Loading…';
  base = await loadGLB(DATA.model);
  const probe = SkeletonUtils.clone(base.scene); probe.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(probe, true); lift = -bb.min.y; height = bb.max.y - bb.min.y; footprint = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
  const add = (raw, key, meta) => {
    const p = prepareClip(raw, key, probe);
    const frames = meta.frames || Math.round(p.dur * p.fps);
    clips.push({ key, label: meta.label || key, meta, ...p, frames });
    rootTravel[key] = false;
  };
  for (const a of base.animations) {   // embedded clips: 'idle' (default) and the older Meshy 'idle_look'
    const look = a.name === 'idle_look', key = look ? 'idle_look' : (a.name === 'idle' || base.animations.length === 1 ? 'idle' : a.name);
    add(a, key, { label: look ? 'Look around' : 'Idle', file: 'embedded in model', source: look ? 'Meshy idle (body turns)' : 'model default idle' });
  }
  for (const c of DATA.clips) {
    const g = await loadGLB(c.url);
    if (!g.animations[0]) { console.warn('no clip in', c.file); continue; }
    add(g.animations[0], c.key, c);
  }
  console.log('[review] clips', clips.map((c) => `${c.key}:${c.dur.toFixed(2)}s/${c.fps}fps${c.travel ? ' travel ' + c.travel.length().toFixed(2) + 'm' : ''}`).join(', '));
  single = instance();
  buildUI(); resize();
  selKey = clips.find((c) => c.key !== 'idle')?.key || clips[0]?.key;
  setMode('single');
  loop_();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.SB_READY = true;
}
window.SB_MODE = (m) => setMode(m);
window.SB_PLAY = (k) => select(k);
window.SB_SEEK = (p) => seek(p);
window.SB_SKEL = (on) => { if (on !== skelOn) $('bSkel').click(); };
window.SB_ROOT = (k, travel) => { if (!!rootTravel[k] !== !!travel) { select(k); $('bRoot').click(); } };
window.SB_CLIPS = () => clips.map((c) => ({ key: c.key, dur: c.dur, fps: c.fps, frames: c.frames, travel: c.travel && c.travel.toArray() }));
boot().catch((e) => { console.error(e); $('meta').textContent = 'Failed to load: ' + e.message; });
