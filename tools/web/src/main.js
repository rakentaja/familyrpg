import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const MANIFEST = window.SB_MANIFEST; // {props:{name:url}, chars:[{name,label,group,model|null,ref,height,pos,rot,anim}]}
const PAPER = 0xf2eadb, INK = 0x2a2328;

// ---------- renderer / scene ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e1d3);
scene.fog = new THREE.Fog(0xe9e1d3, 26, 48);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
camera.position.set(12.5, 11, 16);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.8, -0.5); controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 4; controls.maxDistance = 40;

const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
sun.position.set(-8, 14, 9); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 50 });
sun.shadow.bias = -0.0008;
scene.add(sun, new THREE.HemisphereLight(0xf4efe6, 0xb4abc6, 1.1));

// ---------- toon + hatch material ----------
const grad = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]), 3, 1);
grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
const hatchUniforms = { uHatch: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) } };

function toonify(src) {
  const m = new THREE.MeshToonMaterial({
    color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1),
    map: src.map || null, gradientMap: grad,
    emissive: src.emissive ? src.emissive.clone() : new THREE.Color(0), emissiveMap: src.emissiveMap || null,
    transparent: src.transparent, alphaTest: src.alphaTest || 0, side: src.side,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHatch = hatchUniforms.uHatch;
    sh.fragmentShader = 'uniform float uHatch;\n' + sh.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
       float lum = dot(gl_FragColor.rgb, vec3(0.299,0.587,0.114));
       vec2 p = gl_FragCoord.xy;
       float h1 = step(0.82, fract((p.x + p.y) * 0.16));
       float h2 = step(0.82, fract((p.x - p.y) * 0.16));
       float shade = smoothstep(0.62, 0.32, lum);
       float dark  = smoothstep(0.40, 0.18, lum);
       float hatch = max(h1 * shade, h2 * dark) * uHatch;
       gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.165,0.137,0.157), hatch * 0.55);`);
  };
  return m;
}
const outlineMat = (w) => {
  const m = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>\n transformed += normalize(normal) * ${w.toFixed(4)};`);
  };
  return m;
};
const OUTLINE = { thin: outlineMat(0.012), med: outlineMat(0.02) };
const outlines = [];

function stylize(root, width = 'thin') {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    o.castShadow = o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.material = Array.isArray(o.material) ? mats.map(toonify) : toonify(mats[0]);
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const line = o.isSkinnedMesh ? new THREE.SkinnedMesh(o.geometry, OUTLINE[width]) : new THREE.Mesh(o.geometry, OUTLINE[width]);
    if (o.isSkinnedMesh) line.bind(o.skeleton, o.bindMatrix);
    line.castShadow = false; line.raycast = () => {};
    o.add(line); outlines.push(line);
  }
}

// ---------- loading ----------
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const cache = {};
const loadGLB = (url) => (cache[url] ||= loader.loadAsync(url));
const mixers = [];
const pickables = [];

async function placeProp(name, x, z, rot = 0, s = 1) {
  const g = await loadGLB(MANIFEST.props[name]);
  const o = g.scene.clone(true);
  o.position.set(x, 0, z); o.rotation.y = rot; o.scale.setScalar(s);
  stylize(o, s > 1.5 ? 'med' : 'thin'); scene.add(o); return o;
}

// fit a model to target height, feet on ground
function fitHeight(o, h, name) {
  o.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(o, true); const sz = b.getSize(new THREE.Vector3());
  const k = h / Math.max(sz.y, 1e-3); o.scale.multiplyScalar(k); o.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(o, true); o.position.y -= b2.min.y;
  (window.SB_FIT ||= {})[name] = [sz.x, sz.y, sz.z, k].map((v) => +v.toFixed(3));
}

async function placeChar(c) {
  const holder = new THREE.Group(); holder.position.set(c.pos[0], 0, c.pos[1]); holder.rotation.y = c.rot || 0;
  holder.userData = c; scene.add(holder);
  if (c.model) {
    const g = await loadGLB(c.model);
    const o = g.animations.length ? skClone(g.scene) : g.scene.clone(true);
    fitHeight(o, c.height, c.name); stylize(o, 'thin'); holder.add(o);
    if (g.animations.length) {
      const mx = new THREE.AnimationMixer(o); const clip = g.animations[0];
      const a = mx.clipAction(clip); a.play(); a.time = Math.random() * clip.duration; mixers.push(mx);
    } else {
      holder.userData.idle = c.name === 'blizzard-wisp' ? 'spin' : 'bob'; holder.userData.phase = Math.random() * 6;
    }
  } else {
    // cardboard standee from the reference front view
    const tex = await new THREE.TextureLoader().loadAsync(c.ref); tex.colorSpace = THREE.SRGBColorSpace;
    const ar = tex.image.width / tex.image.height;
    const card = new THREE.Mesh(new THREE.PlaneGeometry(c.height * ar, c.height),
      new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide }));
    card.position.y = c.height / 2 + 0.08; card.castShadow = true;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.08, 20), toonify({ color: new THREE.Color(0x8c84a3) }));
    base.position.y = 0.04; base.castShadow = base.receiveShadow = true;
    holder.add(card, base); holder.userData.standee = card;
  }
  holder.traverse((o) => { if (o.isMesh) { o.userData.char = c; pickables.push(o); } });
}

// ---------- board ----------
async function buildBoard() {
  const W = 14, D = 12;
  const ice = new Set(['9,6', '10,6', '9,7', '10,7', '11,7', '9,8', '10,8', '8,7']); // frozen pond, front right
  const jobs = [];
  for (let i = 0; i < W; i++) for (let j = 0; j < D; j++) {
    const x = i - W / 2 + 0.5, z = j - D / 2 + 0.5;
    jobs.push(placeProp(ice.has(`${i},${j}`) ? 'tile_ice' : 'tile_snow', x, z));
  }
  await Promise.all(jobs);
  // grid lines
  const grid = new THREE.GridHelper(Math.max(W, D), Math.max(W, D), 0xb4abc6, 0xb4abc6);
  grid.position.y = 0.002; grid.material.opacity = 0.35; grid.material.transparent = true; scene.add(grid);

  const P = placeProp;
  await Promise.all([
    P('great_tree', 0, -4.5, 0, 1),
    P('gingerbread_house', -5, -3.6, 0.35), P('gingerbread_house', 5.1, -3.8, -0.4),
    P('chimney', 6.2, -1.6, 0.2), P('roof_segment', 5.9, -0.2, -Math.PI / 2),
    P('pine_tree', -6.3, -5.2, 0, 1.2), P('pine_tree', -3.2, -5.4), P('pine_tree', 3.0, -5.3, 0, 1.15), P('pine_tree', 6.4, -5.2, 0, 1.3),
    P('pine_tree', -6.4, 1.6, 0, 0.9), P('pine_tree', 6.5, 4.8, 0, 1.1),
    P('candy_cane_tree', -2.0, -4.9, 0.6), P('candy_cane_tree', 2.0, -5.0, 2.4), P('candy_cane_tree', -6.3, -0.5, 1.2),
    P('lamp_post', -2.5, -2.0), P('lamp_post', 2.5, -2.0),
    P('fence', -5.5, 5.4), P('fence', -4.5, 5.4), P('fence', 4.6, 5.4), P('fence', 5.6, 5.4),
    P('crate', -6.1, 3.2, 0.3), P('crate', -5.6, 4.1, -0.2, 0.8),
    P('workbench', -4.6, 1.4, Math.PI / 2),
    P('rock', 6.0, 2.5), P('rock', 3.4, 5.2, 1, 0.8),
    P('present', -0.6, -2.7, 0.3), P('present', 0.7, -2.9, -0.5, 0.8), P('present', 4.5, 1.6, 0.9),
    P('star', 1.6, -2.4, -0.4, 1.0),
    P('dice', -1.2, 5.3, 0.4), P('dice', -0.7, 5.5, 1.1),
    P('cocoa_mug', -4.4, 1.0, 0, 1.4), P('snowball', 2.9, 1.2), P('snowball', 3.15, 1.35, 0, 0.8),
  ]);
}

// ---------- UI ----------
const tip = document.getElementById('tip');
const ray = new THREE.Raycaster(); const mouse = new THREE.Vector2();
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(pickables, false)[0];
  if (hit) { const c = hit.object.userData.char; tip.style.display = 'block'; tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 10 + 'px';
    tip.innerHTML = `<b>${c.label}</b><br>${c.model ? 'Meshy model' : 'Reference standee — model pending'}`; }
  else tip.style.display = 'none';
});
const list = document.getElementById('list');
function renderList() {
  list.innerHTML = MANIFEST.chars.map((c) =>
    `<li><span class="dot ${c.model ? 'ok' : 'pending'}"></span>${c.label}<em>${c.group}</em></li>`).join('');
  const n = MANIFEST.chars.filter((c) => c.model).length;
  document.getElementById('count').textContent = `${n} / ${MANIFEST.chars.length} characters modelled · ${Object.keys(MANIFEST.props).length} Blender props`;
}
let rotate = false;
document.getElementById('bRotate').onclick = (e) => { rotate = !rotate; e.target.classList.toggle('on', rotate); };
document.getElementById('bHatch').onclick = (e) => { const on = hatchUniforms.uHatch.value < 0.5; hatchUniforms.uHatch.value = on ? 1 : 0; e.target.classList.toggle('on', on); };
document.getElementById('bInk').onclick = (e) => { const on = !outlines[0]?.visible; outlines.forEach((o) => (o.visible = on)); e.target.classList.toggle('on', on); };
document.getElementById('bTop').onclick = () => { camera.position.set(0.01, 26, 0.6); controls.target.set(0, 0, 0); };
document.getElementById('bCast').onclick = () => { camera.position.set(2.5, 3.2, 9.5); controls.target.set(0.2, 0.9, 1.6); };
document.getElementById('bHero').onclick = () => { camera.position.set(12.5, 11, 16); controls.target.set(0, 0.8, -0.5); };

// ---------- loop ----------
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
const clock = new THREE.Clock();
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  mixers.forEach((m) => m.update(dt));
  const tt = clock.elapsedTime;
  scene.children.forEach((o) => {
    if (o.userData.idle === 'spin') { o.rotation.y += dt * 1.6; o.position.y = 0.15 + Math.sin(tt * 2 + o.userData.phase) * 0.12; }
    else if (o.userData.idle === 'bob') { o.position.y = Math.abs(Math.sin(tt * 6 + o.userData.phase)) * 0.04; o.rotation.z = Math.sin(tt * 12) * 0.03; }
  });
  scene.traverse((o) => { if (o.userData.standee) o.userData.standee.lookAt(camera.position.x, o.userData.standee.getWorldPosition(new THREE.Vector3()).y, camera.position.z); });
  if (rotate) { controls.autoRotate = true; controls.autoRotateSpeed = 0.6; } else controls.autoRotate = false;
  controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop);
}

(async () => {
  resize(); renderList(); loop();
  await buildBoard();
  await Promise.all(MANIFEST.chars.map(placeChar));
  document.getElementById('loading').style.display = 'none';
  window.SB_READY = true;
})().catch((e) => { document.getElementById('loading').textContent = 'Error: ' + e.message; console.error(e); });
