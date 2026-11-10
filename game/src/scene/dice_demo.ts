// Stand-alone dice test page: a table, a phone-like camera and an armed DiceRig.
// Bundle: bun build src/scene/dice_demo.ts --outfile <dir>/dice_demo.js, then open an HTML page with <canvas id="c">.
// Hooks for headless screenshots: SB_READY, SB_FLICK(phase), SB_STEP(seconds), SB_REPLAY(), SB_INFO().
import * as THREE from 'three';
import { DiceRig } from './dice';
import type { DiceThrow } from '../contracts';
import { PaperOverlay, toonMaterial, addOutline, PALETTE } from './style';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e1d3);
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
const paper = new PaperOverlay();

// table 8 × 8 m, centred, top at y = 0
const TW = 8, TD = 8;
const top = new THREE.Mesh(new THREE.BoxGeometry(TW, 0.3, TD), toonMaterial({ color: new THREE.Color(PALETTE.sage) }));
top.position.y = -0.15; top.receiveShadow = true; addOutline(top, 'thick'); scene.add(top);
const grid = new THREE.GridHelper(TW, TW, 0x8f9f88, 0x8f9f88); grid.position.y = 0.002; scene.add(grid);
const obstacles = [{ x: -2.2, z: -0.5, r: 0.55 }, { x: 2.3, z: -2.0, r: 0.7 }];
for (const o of obstacles) {
  const tree = new THREE.Mesh(new THREE.ConeGeometry(o.r, 1.9, 7), toonMaterial({ color: new THREE.Color(0x7f9a78) }));
  tree.position.set(o.x, 0.95, o.z); tree.castShadow = true; addOutline(tree, 'med'); scene.add(tree);
}
// a 1.5 m stand-in hero for scale
const hero = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 4, 10), toonMaterial({ color: new THREE.Color(PALETTE.rose) }));
hero.position.set(0.8, 0.75, 1.6); hero.castShadow = true; addOutline(hero, 'med'); scene.add(hero);

scene.add(new THREE.HemisphereLight(0xfff6ea, 0x8a7f86, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-5, 12, 6); sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 40 });
scene.add(sun);

function fit(): void {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  camera.aspect = w / h;
  // portrait framing like the game: pitch 60°, distance so the table width fits
  const pitch = THREE.MathUtils.degToRad(60), tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max((TW * 0.62) / (tanH * camera.aspect), TD * 1.3);
  camera.position.set(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist + 0.5);
  camera.lookAt(0, 0, 0.5);
  camera.updateProjectionMatrix();
  paper.setSize(w, h);
}
fit(); addEventListener('resize', fit);

try { localStorage.removeItem('sb.dice.flicked'); } catch { /* file:// */ }
const rig = new DiceRig({ scene, camera, canvas });
rig.setTable({ w: TW, d: TD }, obstacles);
let last: DiceThrow | null = null;
rig.onThrown = (t) => { last = t; console.log('thrown', JSON.stringify({ values: t.values, land: t.land, bytes: JSON.stringify(t.frames).length })); };
rig.arm('roll-1', 'Kind +3 — flick!');

function render(): void { renderer.render(scene, camera); paper.render(renderer); }

// gestures: real pointer events also work when the page is opened in a browser
canvas.addEventListener('pointerdown', (e) => rig.pointerDown(e));
canvas.addEventListener('pointermove', (e) => rig.pointerMove(e));
canvas.addEventListener('pointerup', (e) => rig.pointerUp(e));

let manual = false;
let prev = performance.now();
function loop(now: number): void {
  if (!manual) { const dt = Math.min(0.05, (now - prev) / 1000); rig.update(dt); render(); }
  prev = now; requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

const w = window as unknown as Record<string, unknown>;
let ts = 1000;
const ev = (type: string, x: number, y: number) => ({ type, pointerId: 7, clientX: x, clientY: y, timeStamp: ts } as unknown as PointerEvent);
w.SB_STEP = (sec: number) => { manual = true; const n = Math.round(sec * 60); for (let i = 0; i < n; i++) rig.update(1 / 60); render(); };
/** phase 'hold': finger down on the dice and dragged up a little; 'release': quick upward flick with a slight curve. */
w.SB_FLICK = (phase: 'hold' | 'release', dx = 40) => {
  manual = true;
  const cx = innerWidth / 2, cy = innerHeight * 0.8;
  if (phase === 'hold') {
    console.log('down consumed', rig.pointerDown(ev('pointerdown', cx, cy)));
    for (let i = 1; i <= 4; i++) { ts += 16; rig.pointerMove(ev('pointermove', cx + i * 2, cy - i * 6)); }
    for (let i = 0; i < 10; i++) rig.update(1 / 60);
  } else {
    for (let i = 1; i <= 5; i++) { ts += 16; rig.pointerMove(ev('pointermove', cx + 8 + i * dx / 5, cy - 24 - i * 55)); }
    ts += 16; rig.pointerUp(ev('pointerup', cx + 8 + dx, cy - 24 - 330));
  }
  render();
};
/** Tap on the dice (accessibility fallback → default medium throw). */
w.SB_TAP = () => { manual = true; const cx = innerWidth / 2, cy = innerHeight * 0.8; rig.pointerDown(ev('pointerdown', cx, cy)); ts += 90; rig.pointerUp(ev('pointerup', cx + 2, cy)); render(); };
w.SB_ARM = (label: string) => { manual = true; rig.arm('roll-' + ts, label); render(); };
w.SB_REPLAY = () => { manual = true; if (last) void rig.replay(last).then(() => console.log('replay done')); };
w.SB_INFO = () => ({ armed: rig.armed, last: last && { values: last.values, land: last.land, bytes: JSON.stringify(last.frames).length, frames: (last.frames[3] as number) } });
w.SB_READY = true;
