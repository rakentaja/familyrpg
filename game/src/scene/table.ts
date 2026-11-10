// The diorama: a paper sheet, a wooden tray of size.w × size.d metres centred on 0,0, the painted ground
// (scene.ground + areas, baked into one canvas texture), wobbling water, extruded rock walls and the placed props.
import * as THREE from 'three';
import type { Area, AreaKind, PackScene } from '../rules/types';
import type { Assets } from './assets';
import { addOutline, toonMaterial, toonMaterials } from './style';
import { ghostOf } from './actors';

const deg = (d: number | undefined) => ((d ?? 0) * Math.PI) / 180;

// deterministic noise for the painting
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function hash(str: string): number { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; }

const FILL: Record<AreaKind | 'solid', string> = {
  floor: '#dcc6a8', snow: '#f5f0e7', ice: '#cfe1ea', crack: '#cbdde6', water: '#4d6782', gap: '#3a3140',
  roof: '#d8a7a7', wall: '#a49aaa', solid: '#d9e7ee',
};

export interface PropRef { index: number; obj: THREE.Object3D; uid: string; model: string; hidden: boolean }
export interface Obstacle { x: number; z: number; r: number }

export class Table {
  readonly group = new THREE.Group();
  readonly propGroup = new THREE.Group();
  readonly props: PropRef[] = [];
  readonly obstacles: Obstacle[] = [];
  readonly hands: THREE.Object3D[] = [];
  private owned: { dispose(): void }[] = [];
  private groundOwned: { dispose(): void }[] = [];
  private groundGroup = new THREE.Group();
  private waterMats: THREE.ShaderMaterial[] = [];
  private groundKey = '';
  w = 8; d = 8;
  hasWater = false;

  constructor() { this.group.add(this.groundGroup, this.propGroup); }

  private own<T extends { dispose(): void }>(x: T, ground = false): T { (ground ? this.groundOwned : this.owned).push(x); return x; }
  private mat(color: number | string, ground = false): THREE.MeshToonMaterial {
    const m = toonMaterial({ color: new THREE.Color(color) });
    this.own({ dispose: () => { m.dispose(); toonMaterials.delete(m); } }, ground);
    return m;
  }

  build(def: PackScene, assets: Assets, solid: string[]): void {
    this.clear();
    this.w = Math.max(2, def.size?.w ?? 8); this.d = Math.max(2, def.size?.d ?? 8);
    const w = this.w, d = this.d;

    // paper sheet under everything (slightly skewed, deckled by a canvas alpha edge)
    const sheet = new THREE.Mesh(this.own(new THREE.PlaneGeometry(w + 3.2, d + 3.2).rotateX(-Math.PI / 2)), this.mat(0xf3ecdf));
    sheet.position.y = -0.36; sheet.rotation.y = 0.025; sheet.receiveShadow = true;
    this.group.add(sheet);

    // tray: slab + raised wooden rim
    const slab = new THREE.Mesh(this.own(new THREE.BoxGeometry(w + 0.5, 0.34, d + 0.5)), this.mat(0x9a7f86));
    slab.position.y = -0.18; slab.receiveShadow = true; slab.castShadow = true; addOutline(slab, 'med');
    this.group.add(slab);
    const rimMat = this.mat(0xb98f84), rimH = 0.07, rimW = 0.25;
    const rims: [number, number, number, number][] = [
      [0, -(d / 2 + rimW / 2), w + rimW * 2, rimW], [0, d / 2 + rimW / 2, w + rimW * 2, rimW],
      [-(w / 2 + rimW / 2), 0, rimW, d], [w / 2 + rimW / 2, 0, rimW, d],
    ];
    for (const [x, z, sx, sz] of rims) {
      const r = new THREE.Mesh(this.own(new THREE.BoxGeometry(sx, rimH, sz)), rimMat);
      r.position.set(x, rimH / 2 - 0.005, z); r.receiveShadow = true; r.castShadow = true; addOutline(r, 'thin');
      this.group.add(r);
    }

    this.syncProps(def, assets, false);
    this.setGround(def, solid);
  }

  /** Add / move / remove props to match the layout (the Guide can change it live). Hidden props are only shown
   *  (see-through) when `showHidden`. Pieces are matched by uid, so unchanged ones keep their objects. */
  syncProps(def: PackScene, assets: Assets, showHidden: boolean, skip?: THREE.Object3D | null): void {
    const old = new Map(this.props.map((p) => [p.uid, p]));
    const next: PropRef[] = [];
    this.obstacles.length = 0; this.hands.length = 0;
    def.props.forEach((pl, index) => {
      const uid = pl.uid ?? 'i' + index, hidden = !!pl.hidden;
      let ref = old.get(uid);
      if (ref && ref.model !== pl.model) { ref.obj.removeFromParent(); ref = undefined; }
      if (hidden && !showHidden) { if (ref) ref.obj.removeFromParent(); return; }
      if (!ref) {
        const obj = assets.instance(pl.model);
        if (!obj) return;
        const holder = new THREE.Group();
        holder.add(obj);
        this.propGroup.add(holder);
        ref = { index, obj: holder, uid, model: pl.model, hidden: false };
      }
      old.delete(uid);
      const holder = ref.obj;
      ref.index = index;
      holder.userData.propIndex = index;
      holder.userData.propUid = uid;
      if (holder !== skip) holder.position.set(pl.x, 0, pl.z);
      holder.rotation.y = deg(pl.rot);
      holder.scale.setScalar(pl.scale ?? 1);
      if (ref.hidden !== hidden) { setGhost(holder, hidden); ref.hidden = hidden; }
      holder.traverse((o) => { if (o.name === 'hand') this.hands.push(o); });
      next.push(ref);
      if (hidden) return;
      let r = pl.block;
      if (r === undefined) {
        holder.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(holder);
        r = Math.max(0, Math.min(b.max.x - b.min.x, b.max.z - b.min.z) * 0.42);
      }
      if (r > 0.05) this.obstacles.push({ x: pl.x, z: pl.z, r });
    });
    for (const r of old.values()) r.obj.removeFromParent();
    this.props.length = 0; this.props.push(...next);
  }
  propByIndex(i: number): THREE.Object3D | null { return this.props.find((p) => p.index === i)?.obj ?? null; }

  /** Repaint ground + water + walls (scene.solid changes swap crack/water to solid ice). */
  setGround(def: PackScene, solid: string[]): void {
    const key = def.id + '|' + solid.join(',') + '|' + def.ground + JSON.stringify(def.areas);
    if (key === this.groundKey) return;
    this.groundKey = key;
    for (const o of this.groundOwned) o.dispose();
    this.groundOwned.length = 0; this.waterMats.length = 0;
    this.groundGroup.clear();
    const w = this.w, d = this.d;
    const solidSet = new Set(solid);

    const tex = this.own(paintGround(def, w, d, solidSet), true);
    const ground = new THREE.Mesh(this.own(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), true), this.groundMat(tex));
    ground.receiveShadow = true;
    this.groundGroup.add(ground);

    this.hasWater = false;
    for (const a of def.areas) {
      if (a.kind === 'water' && !solidSet.has(a.id)) {
        this.hasWater = true;
        const geo = this.own(shapeGeo(a), true);
        const m = this.own(waterMaterial(), true);
        this.waterMats.push(m);
        const mesh = new THREE.Mesh(geo, m);
        mesh.position.y = 0.006; mesh.renderOrder = 1;
        this.groundGroup.add(mesh);
      } else if (a.kind === 'wall') {
        const geo = this.own(shapeGeo(a, 0.45), true);
        const mesh = new THREE.Mesh(geo, this.mat(0x9d93a6, true));
        mesh.castShadow = true; mesh.receiveShadow = true; addOutline(mesh, 'med');
        this.groundGroup.add(mesh);
      }
    }
  }

  private groundMat(tex: THREE.Texture): THREE.MeshToonMaterial {
    const m = toonMaterial({ map: tex });
    this.own({ dispose: () => { m.dispose(); toonMaterials.delete(m); } }, true);
    return m;
  }

  update(t: number): void { for (const m of this.waterMats) m.uniforms.uTime!.value = t; }

  clear(): void {
    for (const o of [...this.owned, ...this.groundOwned]) o.dispose();
    this.owned.length = 0; this.groundOwned.length = 0; this.waterMats.length = 0;
    this.groundGroup.clear(); this.propGroup.clear();
    for (const c of [...this.group.children]) if (c !== this.groundGroup && c !== this.propGroup) this.group.remove(c);
    this.props.length = 0; this.obstacles.length = 0; this.hands.length = 0; this.groundKey = '';
  }
  dispose(): void { this.clear(); }
}

/** See-through look for hidden props (the Guide's view). */
function setGhost(root: THREE.Object3D, on: boolean): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData.sbOutline) { m.visible = !on; return; }
    if (on) { m.userData.realMat = m.material; m.material = Array.isArray(m.material) ? m.material.map(ghostOf) : ghostOf(m.material); }
    else if (m.userData.realMat) { m.material = m.userData.realMat; delete m.userData.realMat; }
    m.castShadow = !on;
  });
}

// ---------------------------------------------------------------- geometry
function areaShape(a: Area): THREE.Shape {
  const s = new THREE.Shape();
  if (a.shape === 'circle') { s.absarc(0, 0, a.r ?? 1, 0, Math.PI * 2, false); return s; }
  const hw = (a.w ?? 1) / 2, hd = (a.d ?? 1) / 2;
  s.moveTo(-hw, -hd); s.lineTo(hw, -hd); s.lineTo(hw, hd); s.lineTo(-hw, hd); s.closePath();
  return s;
}
/** Flat (or extruded) area geometry in world space on the table plane. */
function shapeGeo(a: Area, height = 0): THREE.BufferGeometry {
  const sh = areaShape(a);
  const g = height > 0
    ? new THREE.ExtrudeGeometry(sh, { depth: height, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1, curveSegments: 20 })
    : new THREE.ShapeGeometry(sh, 32);
  // shape XY → table XZ (+90° about X: shape +y becomes table +z)
  g.rotateX(Math.PI / 2);
  if (height > 0) g.translate(0, height, 0);
  g.rotateY(deg(a.rot));
  g.translate(a.x, 0, a.z);
  if (height <= 0) { // ShapeGeometry faces down after the flip: turn it back up
    const idx = g.getIndex();
    if (idx) { const arr = idx.array as Uint16Array; for (let i = 0; i < arr.length; i += 3) { const t = arr[i]!; arr[i] = arr[i + 2]!; arr[i + 2] = t; } idx.needsUpdate = true; }
    g.computeVertexNormals();
  }
  return g;
}

function waterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float uTime; varying vec3 vW;
      void main(){
        vec2 p = vW.xz;
        float a = sin(p.x * 3.1 + uTime * 1.3 + sin(p.y * 2.3 + uTime * 0.7) * 1.4);
        float b = sin(p.y * 3.7 - uTime * 1.1 + sin(p.x * 1.9 - uTime * 0.5) * 1.2);
        float rip = smoothstep(0.82, 0.97, a * b);
        vec3 deep = vec3(0.27, 0.36, 0.47), lite = vec3(0.62, 0.72, 0.80);
        vec3 col = mix(deep, deep * 1.18, 0.5 + 0.5 * sin(p.x * 0.8 + p.y * 0.6 + uTime * 0.4));
        col = mix(col, lite, rip * 0.75);
        gl_FragColor = vec4(col, 0.92);
      }`,
  });
}

// ---------------------------------------------------------------- painting
function pathArea(g: CanvasRenderingContext2D, a: Area, ppm: number, ox: number, oz: number, grow = 0): void {
  g.save();
  g.translate((a.x + ox) * ppm, (a.z + oz) * ppm);
  g.rotate(-deg(a.rot)); // same sense as three.js rotation.y
  g.beginPath();
  if (a.shape === 'circle') g.arc(0, 0, ((a.r ?? 1) + grow) * ppm, 0, Math.PI * 2);
  else { const hw = ((a.w ?? 1) / 2 + grow) * ppm, hd = ((a.d ?? 1) / 2 + grow) * ppm; g.rect(-hw, -hd, hw * 2, hd * 2); }
  g.restore();
}

function speckle(g: CanvasRenderingContext2D, W: number, H: number, n: number, color: string, r0: number, r1: number, rand: () => number): void {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) { g.beginPath(); g.arc(rand() * W, rand() * H, r0 + rand() * (r1 - r0), 0, Math.PI * 2); g.fill(); }
}

function paintKind(g: CanvasRenderingContext2D, kind: AreaKind | 'solid', W: number, H: number, ppm: number, rand: () => number, bounds?: [number, number, number, number]): void {
  const [bx, by, bw, bh] = bounds ?? [0, 0, W, H];
  g.fillStyle = FILL[kind]; g.fillRect(0, 0, W, H);
  switch (kind) {
    case 'snow': {
      // soft drifts + speckle
      for (let i = 0; i < (W * H) / (ppm * ppm) * 0.6; i++) {
        const x = rand() * W, y = rand() * H, r = (0.4 + rand() * 0.9) * ppm;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, rand() < 0.5 ? 'rgba(180,171,198,0.13)' : 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      speckle(g, W, H, (W * H) / 900, 'rgba(160,150,180,0.16)', 0.6, 1.6, rand);
      break;
    }
    case 'floor': {
      const plank = 0.42 * ppm;
      g.strokeStyle = 'rgba(42,35,40,0.28)'; g.lineWidth = Math.max(1, ppm * 0.02);
      for (let y = 0; y < H; y += plank) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
        let x = -rand() * 2 * ppm;
        while (x < W) { x += (1.4 + rand() * 1.6) * ppm; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + plank); g.stroke(); }
        g.fillStyle = `rgba(138,74,78,${0.03 + rand() * 0.06})`; g.fillRect(0, y, W, plank);
      }
      g.strokeStyle = 'rgba(42,35,40,0.08)'; g.lineWidth = 1;
      for (let i = 0; i < W * H / 4000; i++) { const x = rand() * W, y = rand() * H; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (0.3 + rand() * 0.6) * ppm, y + (rand() - 0.5) * 2); g.stroke(); }
      break;
    }
    case 'ice': case 'crack': case 'solid': {
      // glossy streaks
      g.save(); g.globalAlpha = 0.5;
      for (let i = 0; i < (bw * bh) / (ppm * ppm) * 1.2 + 3; i++) {
        const x = bx + rand() * bw, y = by + rand() * bh, L = (0.4 + rand() * 1.2) * ppm;
        g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = Math.max(1.5, ppm * (0.02 + rand() * 0.04)); g.lineCap = 'round';
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + L, y - L * 0.55); g.stroke();
      }
      g.restore();
      if (kind === 'solid') speckle(g, W, H, (W * H) / 500, 'rgba(255,255,255,0.7)', 0.8, 2.2, rand);
      speckle(g, W, H, (W * H) / 2600, 'rgba(110,140,160,0.18)', 0.5, 1.3, rand);
      if (kind === 'crack' || kind === 'solid') {
        // ink cracks: a few branching polylines from random centres
        const n = Math.max(2, Math.round((bw * bh) / (ppm * ppm) * 0.5));
        g.strokeStyle = kind === 'solid' ? 'rgba(90,110,130,0.28)' : 'rgba(42,35,40,0.85)'; g.lineCap = 'round'; g.lineJoin = 'round';
        const branch = (x: number, y: number, a: number, len: number, wdt: number, depth: number) => {
          g.lineWidth = wdt; g.beginPath(); g.moveTo(x, y);
          let cx = x, cy = y;
          const steps = 4 + Math.floor(rand() * 4);
          for (let s = 0; s < steps; s++) {
            a += (rand() - 0.5) * 0.9; const l = len / steps;
            cx += Math.cos(a) * l; cy += Math.sin(a) * l; g.lineTo(cx, cy);
            if (depth < 2 && rand() < 0.35) { g.stroke(); branch(cx, cy, a + (rand() < 0.5 ? 1 : -1) * (0.6 + rand() * 0.6), len * 0.45, wdt * 0.6, depth + 1); g.lineWidth = wdt; g.beginPath(); g.moveTo(cx, cy); }
          }
          g.stroke();
        };
        for (let i = 0; i < n; i++) {
          const x = bx + (0.15 + rand() * 0.7) * bw, y = by + (0.15 + rand() * 0.7) * bh;
          const arms = 3 + Math.floor(rand() * 3);
          for (let k = 0; k < arms; k++) branch(x, y, (k / arms) * Math.PI * 2 + rand() * 0.8, (0.6 + rand() * 0.9) * ppm, Math.max(1.5, ppm * 0.035), 0);
        }
      }
      break;
    }
    case 'water': break; // the wobbling water mesh sits on top
    case 'gap': {
      const gr = g.createLinearGradient(0, by, 0, by + bh);
      gr.addColorStop(0, '#2a2328'); gr.addColorStop(0.5, '#3d3446'); gr.addColorStop(1, '#2a2328');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      speckle(g, W, H, (W * H) / 1800, 'rgba(242,234,219,0.35)', 0.8, 1.8, rand); // falling snow far below
      break;
    }
    case 'roof': {
      const rowH = 0.22 * ppm, sw = 0.28 * ppm;
      for (let row = 0, y = by - rowH; y < by + bh + rowH; row++, y += rowH) {
        for (let x = bx - sw + (row % 2) * sw * 0.5; x < bx + bw + sw; x += sw) {
          g.fillStyle = rand() < 0.15 ? '#c99393' : rand() < 0.2 ? '#e2b6b4' : '#d8a7a7';
          g.strokeStyle = 'rgba(138,74,78,0.75)'; g.lineWidth = Math.max(1, ppm * 0.018);
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + sw, y); g.lineTo(x + sw, y + rowH * 0.6);
          g.arc(x + sw / 2, y + rowH * 0.6, sw / 2, 0, Math.PI); g.closePath(); g.fill(); g.stroke();
        }
      }
      // snow along the ridge
      g.fillStyle = 'rgba(247,243,236,0.9)';
      for (let x = bx; x < bx + bw; x += 0.18 * ppm) { g.beginPath(); g.arc(x, by + rand() * 4, (0.06 + rand() * 0.06) * ppm, 0, Math.PI * 2); g.fill(); }
      break;
    }
    case 'wall': speckle(g, W, H, (W * H) / 700, 'rgba(42,35,40,0.2)', 1, 2.5, rand); break;
  }
}

function areaBounds(a: Area, ppm: number, ox: number, oz: number): [number, number, number, number] {
  const r = a.shape === 'circle' ? (a.r ?? 1) : Math.hypot((a.w ?? 1) / 2, (a.d ?? 1) / 2);
  const ex = a.shape === 'circle' ? r : Math.abs(Math.cos(deg(a.rot))) * (a.w ?? 1) / 2 + Math.abs(Math.sin(deg(a.rot))) * (a.d ?? 1) / 2;
  const ez = a.shape === 'circle' ? r : Math.abs(Math.sin(deg(a.rot))) * (a.w ?? 1) / 2 + Math.abs(Math.cos(deg(a.rot))) * (a.d ?? 1) / 2;
  return [(a.x + ox - ex) * ppm, (a.z + oz - ez) * ppm, ex * 2 * ppm, ez * 2 * ppm];
}

function paintGround(def: PackScene, w: number, d: number, solid: Set<string>): THREE.CanvasTexture {
  const ppm = Math.min(96, 2048 / Math.max(w, d));
  const W = Math.round(w * ppm), H = Math.round(d * ppm);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const ox = w / 2, oz = d / 2;
  const base = def.ground ?? 'snow';
  paintKind(g, base, W, H, ppm, rng(hash(def.id + ':ground')));

  // per area: paint the kind into an offscreen layer, clip it with the shape
  const layer = document.createElement('canvas'); layer.width = W; layer.height = H;
  const lg = layer.getContext('2d')!;
  for (const a of def.areas ?? []) {
    const kind: AreaKind | 'solid' = (a.kind === 'crack' || a.kind === 'water') && solid.has(a.id) ? 'solid' : a.kind;
    if (kind === 'floor' && base === 'floor') continue;
    const rand = rng(hash(def.id + ':' + a.id));
    const bounds = areaBounds(a, ppm, ox, oz);
    // soft shadow / lip around holes and water
    if (kind === 'gap' || kind === 'water') {
      g.save(); pathArea(g, a, ppm, ox, oz, 0.08); g.fillStyle = kind === 'gap' ? 'rgba(247,243,236,0.95)' : 'rgba(207,225,234,0.9)'; g.fill(); g.restore();
    }
    lg.clearRect(0, 0, W, H);
    lg.save(); pathArea(lg, a, ppm, ox, oz); lg.clip();
    paintKind(lg, kind, W, H, ppm, rand, bounds);
    lg.restore();
    g.drawImage(layer, 0, 0);
    // ink contour (loose: two slightly offset strokes); cracks and mended ice blend into the ice around them
    if (kind === 'crack' || kind === 'solid') continue;
    g.save();
    g.strokeStyle = kind === 'gap' ? 'rgba(42,35,40,0.95)' : 'rgba(42,35,40,0.55)';
    g.lineWidth = Math.max(1.5, ppm * (kind === 'gap' ? 0.05 : 0.025)); g.lineJoin = 'round';
    pathArea(g, a, ppm, ox, oz); g.stroke();
    g.globalAlpha = 0.35; g.lineWidth *= 0.6; pathArea(g, a, ppm, ox + 0.015, oz + 0.01); g.stroke();
    g.restore();
  }
  // gentle darkening at the tray edge
  const ew = Math.min(W, H) * 0.06;
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, 'rgba(90,70,90,0.18)'); gr.addColorStop(1, 'rgba(90,70,90,0)');
    g.fillStyle = gr; g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || W, Math.abs(y1 - y0) || H);
  };
  edge(0, 0, 0, ew); edge(0, H, 0, H - ew); edge(0, 0, ew, 0); edge(W, 0, W - ew, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}
