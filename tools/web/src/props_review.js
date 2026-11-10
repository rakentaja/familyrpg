// Prop review board: every assets/props GLB on its own plinth of 1 m snow tiles, grouped in rows, labelled.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { stylize, toonify, hatchUniforms, outlines } from './style.js';

const DATA = window.SB_PROPS; // {groups:[{name, props:[{name,label,kind,isNew,url}]}]}
const ROW_W = 17, GAP = 0.9;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e1d3);
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 300);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.48;

const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0008;
scene.add(sun, sun.target, new THREE.HemisphereLight(0xf4efe6, 0xb4abc6, 1.1));

const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const load = (url) => loader.loadAsync(url);

function tris(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return Math.round(n);
}

function label(text, sub, isNew, w = 2.2) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#2a2328'; g.textAlign = 'center';
  g.font = '700 54px Kalam, "Comic Sans MS", cursive'; g.fillText(text, 256, 66, 500);
  g.font = '38px "IM Fell English", Georgia, serif'; g.fillStyle = isNew ? '#8a4a4e' : '#6a5e68';
  g.fillText(sub, 256, 128, 500);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 160 / 512), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
  m.rotation.x = -Math.PI / 2; return m;
}

function waterTile(x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 0.12, 1), toonify({ color: new THREE.Color(0x3a4a5e) }));
  m.position.set(x, -0.06, z); m.receiveShadow = true; scene.add(m);
}

const hands = []; const cells = {}; const groupBoxes = {};

async function build() {
  const glbs = {};
  const all = DATA.groups.flatMap((g) => g.props);
  await Promise.all(all.map(async (p) => { glbs[p.name] = await load(p.url); }));
  const tile = glbs.tile_snow || (await load(all.find((p) => p.name === 'tile_snow').url));
  let zCursor = 0; const stats = [];
  for (const grp of DATA.groups) {
    // measure
    const items = grp.props.map((p) => {
      const o = glbs[p.name].scene.clone(true); o.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(o); const s = b.getSize(new THREE.Vector3());
      return { p, o, b, w: Math.max(1, Math.ceil(s.x - 0.05)), d: Math.max(1, Math.ceil(s.z - 0.05)), tris: tris(o) };
    });
    // shelf-pack into rows
    const rows = []; let row = [], rw = 0;
    for (const it of items) {
      if (row.length && rw + it.w > ROW_W) { rows.push(row); row = []; rw = 0; }
      row.push(it); rw += it.w + GAP;
    }
    if (row.length) rows.push(row);
    const gStart = zCursor;
    // group title
    const t = label(grp.name, `${items.length} prop${items.length > 1 ? 's' : ''}`, false, 3.4);
    t.position.set(-ROW_W / 2 - 2.4, 0.01, zCursor + 0.6); scene.add(t);
    for (const r of rows) {
      const depth = Math.max(...r.map((i) => i.d));
      const width = r.reduce((a, i) => a + i.w, 0) + GAP * (r.length - 1);
      let x = -width / 2; const zc = zCursor + depth / 2;
      for (const it of r) {
        const cx = x + it.w / 2;
        const tiled = it.p.kind === 'tile';
        if (!tiled) { // plinth of snow tiles, one per grid square
          for (let i = 0; i < it.w; i++) for (let j = 0; j < it.d; j++) {
            const tt = tile.scene.clone(true); tt.position.set(cx - it.w / 2 + 0.5 + i, it.p.kind === 'island' ? -5 : 0, zc - it.d / 2 + 0.5 + j);
            if (it.p.kind === 'island') { waterTile(tt.position.x, tt.position.z); continue; }
            stylize(tt); scene.add(tt);
          }
        }
        const o = it.o; o.position.set(cx, 0, zc);
        if (it.p.kind === 'edge') o.position.y = -it.b.min.y; // hanging pieces: lift so the lowest tip rests on the plinth
        stylize(o, it.b.getSize(new THREE.Vector3()).y > 3 ? 'med' : 'thin'); scene.add(o);
        o.traverse((n) => { if (n.name === 'hand') hands.push(n); });
        const l = label(it.p.label, `${it.tris} tris${it.p.isNew ? ' · new' : ''}`, it.p.isNew, Math.min(2.4, Math.max(1.6, it.w)));
        l.position.set(cx, 0.02, zc + it.d / 2 + 0.42); scene.add(l);
        cells[it.p.name] = { x: cx, z: zc, w: it.w, d: it.d, h: it.b.max.y };
        stats.push([it.p.name, it.tris, ...it.b.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)), +it.b.min.y.toFixed(3)]);
        x += it.w + GAP;
      }
      zCursor += depth + 1.4;
    }
    groupBoxes[grp.name] = { z0: gStart, z1: zCursor - 1.4 };
    zCursor += 0.8;
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, zCursor + 30), toonify({ color: new THREE.Color(0xe6ddcd) }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(-1, -0.125, zCursor / 2); floor.receiveShadow = true; scene.add(floor);
  const mid = zCursor / 2;
  sun.position.set(-10, 18, mid + 12); sun.target.position.set(0, 0, mid);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: zCursor / 2 + 6, bottom: -zCursor / 2 - 6, near: 1, far: 80 });
  sun.shadow.camera.updateProjectionMatrix();
  window.SB_STATS = stats; window.SB_EXTENT = zCursor;
}

// camera helpers
function frame(x, z, w, d, h = 1.5, k = 1.0) {
  const span = Math.max(w, d * 1.3, h * 1.6) * k;
  const dist = span / (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.min(camera.aspect, 1.6) * 1.15;
  controls.target.set(x, h * 0.35, z);
  camera.position.set(x + dist * 0.18, h * 0.35 + dist * 0.55, z + dist * 0.85);
  controls.update();
}
window.SB_OVERVIEW = () => frame(-1, window.SB_EXTENT / 2, ROW_W + 6, window.SB_EXTENT, 2, 0.95);
window.SB_GROUP = (name) => { const g = groupBoxes[name]; frame(0, (g.z0 + g.z1) / 2 + 0.4, ROW_W - 2, g.z1 - g.z0, 2.2, 0.78); };
window.SB_FOCUS = (name) => { const c = cells[name]; frame(c.x, c.z + 0.3, c.w + 0.8, c.d + 1, c.h, 1.25); };
window.SB_GROUPS = () => Object.keys(groupBoxes);
window.SB_HAND = (rad) => hands.forEach((h) => (h.rotation.z = rad));

// UI
let spin = true;
document.getElementById('bAll').onclick = () => window.SB_OVERVIEW();
document.getElementById('bInk').onclick = (e) => { const on = !outlines[0]?.visible; outlines.forEach((o) => (o.visible = on)); e.target.classList.toggle('on', on); };
document.getElementById('bHatch').onclick = (e) => { const on = hatchUniforms.uHatch.value < 0.5; hatchUniforms.uHatch.value = on ? 1 : 0; e.target.classList.toggle('on', on); };
document.getElementById('bHand').onclick = (e) => { spin = !spin; e.target.classList.toggle('on', spin); };

function resize() { const w = canvas.clientWidth, h = canvas.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize);
const clock = new THREE.Clock();
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (spin) hands.forEach((h) => (h.rotation.z -= dt * 0.5)); // clockwise seen from the front
  controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop);
}

(async () => {
  resize();
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]);
  await build();
  const nav = document.getElementById('groups');
  for (const g of window.SB_GROUPS()) {
    const b = document.createElement('button'); b.textContent = g; b.onclick = () => window.SB_GROUP(g); nav.appendChild(b);
  }
  const n = DATA.groups.reduce((a, g) => a + g.props.length, 0), nn = DATA.groups.reduce((a, g) => a + g.props.filter((p) => p.isNew).length, 0);
  document.getElementById('count').textContent = `${n} props · ${nn} new · 1 tile = 1 m · front faces you`;
  window.SB_OVERVIEW(); loop();
  document.getElementById('loading').style.display = 'none';
  window.SB_READY = true;
})().catch((e) => { document.getElementById('loading').textContent = 'Error: ' + e.message; console.error(e); });
