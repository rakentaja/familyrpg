import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { stylize, hatchUniforms, outlines } from './style.js';

// window.SB_REINDEER = {model, clips:{walk, run}}  (data URIs; the model carries the idle clip)
const DATA = window.SB_REINDEER;
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
sun.position.set(-3, 6, 4); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 30 });
scene.add(sun, new THREE.HemisphereLight(0xf4efe6, 0xb4abc6, 1.1));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshToonMaterial({ color: 0xf2eadb }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(20, 20, 0xb4abc6, 0xb4abc6);
grid.material.transparent = true; grid.material.opacity = 0.6; grid.position.y = 0.002; scene.add(grid);

const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await loader.loadAsync(DATA.model);
const model = gltf.scene; scene.add(model); stylize(model, 'thin');
const mixer = new THREE.AnimationMixer(model);
const actions = {};
actions.idle = mixer.clipAction(gltf.animations[0]);
for (const [k, u] of Object.entries(DATA.clips)) {
  const g = await loader.loadAsync(u); // clips bind to the model purely by bone name
  actions[k] = mixer.clipAction(g.animations[0]);
}
const skel = new THREE.SkeletonHelper(model); skel.visible = false;
skel.material.depthTest = false; skel.material.linewidth = 2; scene.add(skel);

let cur = null, paused = false;
function play(k) {
  const a = actions[k]; if (!a) return;
  if (cur && cur !== a) cur.fadeOut(0.25);
  a.reset().fadeIn(cur ? 0.25 : 0).play(); cur = a;
  document.querySelectorAll('[data-clip]').forEach((b) => b.classList.toggle('on', b.dataset.clip === k));
  info();
}
const box = () => new THREE.Box3().setFromObject(model, true);
function info() {
  const b = box(), s = b.getSize(new THREE.Vector3());
  const k = Object.keys(actions).find((n) => actions[n] === cur);
  $('info').textContent = `${k} · ${cur.getClip().duration.toFixed(2)} s · bbox ${s.x.toFixed(2)}×${s.y.toFixed(2)}×${s.z.toFixed(2)} m · min y ${b.min.y.toFixed(3)}`;
}
for (const k of Object.keys(actions)) {
  const b = document.createElement('button'); b.textContent = k; b.dataset.clip = k; b.onclick = () => play(k); $('clips').append(b);
}
$('bSkel').onclick = () => { skel.visible = !skel.visible; $('bSkel').classList.toggle('on', skel.visible); };
$('bPause').onclick = () => { paused = !paused; $('bPause').textContent = paused ? 'Play' : 'Pause'; };
$('bInk').onclick = () => { const on = !outlines[0].visible; outlines.forEach((o) => (o.visible = on)); $('bInk').classList.toggle('on', on); };
$('bHatch').onclick = () => { hatchUniforms.uHatch.value = 1 - hatchUniforms.uHatch.value; $('bHatch').classList.toggle('on', !!hatchUniforms.uHatch.value); };
function view(name) {
  const t = new THREE.Vector3(0, 0.75, 0.1);
  const p = { side: [4.6, 1.0, 0.1], three: [3.2, 1.6, 3.4], front: [0, 1.0, 4.6] }[name];
  camera.position.set(...p); controls.target.copy(t); controls.update();
}
$('bCam').onclick = () => view('three');

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize(); view('three');
play('idle');
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (!paused) mixer.update(dt);
  controls.update(); renderer.render(scene, camera);
});
// hooks for headless screenshots
window.SB_PLAY = play;
window.SB_SKEL = (on) => { skel.visible = on; };
window.SB_VIEW = view;
window.SB_SEEK = (t) => { paused = true; cur.time = t; mixer.update(0); info(); renderer.render(scene, camera); return $('info').textContent; };
window.SB_INFO = () => ({ clips: Object.fromEntries(Object.entries(actions).map(([k, a]) => [k, a.getClip().duration])), info: $('info').textContent,
  bones: (() => { const n = []; model.traverse((o) => o.isBone && n.push(o.name)); return n.length; })() });
window.SB_READY = true;
