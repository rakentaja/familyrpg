// In-scene meters: the Midnight clock prop (its 'hand' node turns with the night), a pile of presents that grows
// with the goal meter, and a glass Twinkle jar with one glowing star per Twinkle.
import * as THREE from 'three';
import type { Assets } from './assets';
import { addOutline, PALETTE, toonMaterial, toonMaterials } from './style';

export type MeterKind = 'clock' | 'goal' | 'sparks';
const PRESENT_KEYS = ['prop:present_rose', 'prop:present_sage', 'prop:present_lavender', 'prop:present_gold', 'prop:present_cream', 'prop:present_ice', 'prop:present', 'token:goal'];
const PRESENT_SIZE = 0.34;

let starTex: THREE.Texture | null = null, glowTex: THREE.Texture | null = null;
function starTexture(): THREE.Texture {
  if (starTex) return starTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.translate(64, 64); g.beginPath();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 22 : 52, a = -Math.PI / 2 + (i * Math.PI) / 5; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath(); g.fillStyle = '#f6d98a'; g.fill(); g.lineWidth = 9; g.lineJoin = 'round'; g.strokeStyle = '#2a2328'; g.stroke();
  g.beginPath(); g.arc(-10, -12, 8, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.8)'; g.fill();
  starTex = new THREE.CanvasTexture(c); starTex.colorSpace = THREE.SRGBColorSpace;
  return starTex;
}
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,236,170,0.9)'); gr.addColorStop(0.4, 'rgba(255,222,140,0.35)'); gr.addColorStop(1, 'rgba(255,222,140,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c); glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

interface Star { s: THREE.Sprite; home: THREE.Vector3; ph: number; pop: number }

export class Meters {
  readonly group = new THREE.Group();
  readonly clock = new THREE.Group();
  readonly presents = new THREE.Group();
  readonly jar = new THREE.Group();
  private hands: THREE.Object3D[] = [];
  private handCur = 0; private handGoal = 0; private handInit = false;
  private pile: { obj: THREE.Object3D; pop: number }[] = [];
  private stars: Star[] = [];
  private starsGroup = new THREE.Group();
  private glow: THREE.Sprite;
  private owned: { dispose(): void }[] = [];
  private assets: Assets | null = null;
  private presentKeys: string[] = [];
  private t = 0;
  private bump: Record<MeterKind, number> = { clock: 0, goal: 0, sparks: 0 };

  constructor() {
    this.group.add(this.clock, this.presents, this.jar);
    for (const [g, k] of [[this.clock, 'clock'], [this.presents, 'goal'], [this.jar, 'sparks']] as const) g.userData.meter = k;
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    this.glow.scale.setScalar(0.9);
  }

  build(assets: Assets, at: { clock: THREE.Vector3; presents: THREE.Vector3; jar: THREE.Vector3 }): void {
    this.clear();
    this.assets = assets;
    this.clock.position.copy(at.clock); this.presents.position.copy(at.presents); this.jar.position.copy(at.jar);
    // clock: face the default camera (+z)
    const c = assets.instance('prop:midnight_clock');
    if (c) {
      this.clock.add(c);
      c.traverse((o) => { if (o.name === 'hand') this.hands.push(o); });
    } else this.clock.add(this.fallbackClock());
    this.handInit = false;
    this.presentKeys = PRESENT_KEYS.filter((k) => assets.has(k));
    this.buildJar();
    this.pile.length = 0;
  }

  private fallbackClock(): THREE.Object3D {
    const g = new THREE.Group();
    const m = toonMaterial({ color: new THREE.Color(PALETTE.cream) }); this.owned.push({ dispose: () => { m.dispose(); toonMaterials.delete(m); } });
    const geo = new THREE.CylinderGeometry(0.35, 0.35, 0.08, 32).rotateX(Math.PI / 2); this.owned.push(geo);
    const face = new THREE.Mesh(geo, m); face.position.y = 0.6; addOutline(face, 'med'); g.add(face);
    const hm = toonMaterial({ color: new THREE.Color(PALETTE.ink) }); this.owned.push({ dispose: () => { hm.dispose(); toonMaterials.delete(hm); } });
    const hg = new THREE.BoxGeometry(0.04, 0.26, 0.02).translate(0, 0.12, 0); this.owned.push(hg);
    const hand = new THREE.Mesh(hg, hm); hand.name = 'hand'; hand.position.set(0, 0.6, 0.05); g.add(hand); this.hands.push(hand);
    return g;
  }

  private buildJar(): void {
    // lathe profile: base, belly, shoulder, neck
    const pts = [[0, 0], [0.16, 0], [0.2, 0.04], [0.21, 0.3], [0.18, 0.38], [0.12, 0.42], [0.12, 0.47]].map(([x, y]) => new THREE.Vector2(x, y));
    const geo = new THREE.LatheGeometry(pts, 28); this.owned.push(geo);
    const glass = new THREE.MeshToonMaterial({ color: 0xdfeaf0, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide });
    this.owned.push(glass);
    const body = new THREE.Mesh(geo, glass); body.renderOrder = 6; addOutline(body, 'thin');
    const lidGeo = new THREE.CylinderGeometry(0.135, 0.125, 0.07, 20).translate(0, 0.5, 0); this.owned.push(lidGeo);
    const lidMat = toonMaterial({ color: new THREE.Color(PALETTE.rose) }); this.owned.push({ dispose: () => { lidMat.dispose(); toonMaterials.delete(lidMat); } });
    const lid = new THREE.Mesh(lidGeo, lidMat); lid.castShadow = true; addOutline(lid, 'thin');
    const ribbonGeo = new THREE.TorusGeometry(0.125, 0.012, 6, 24).rotateX(Math.PI / 2).translate(0, 0.44, 0); this.owned.push(ribbonGeo);
    const ribbonMat = toonMaterial({ color: new THREE.Color(PALETTE.sage) }); this.owned.push({ dispose: () => { ribbonMat.dispose(); toonMaterials.delete(ribbonMat); } });
    const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
    this.jar.add(this.starsGroup, body, lid, ribbon, this.glow);
    this.glow.position.y = 0.22;
    this.jar.scale.setScalar(1.7);
  }

  /** midnight 0..12 */
  setMidnight(m: number): void {
    this.handGoal = -(THREE.MathUtils.clamp(m, 0, 12) / 12) * Math.PI * 2;
    if (!this.handInit) { this.handCur = this.handGoal; this.handInit = true; }
  }

  setGoal(n: number, animate: boolean): void {
    n = Math.max(0, Math.min(24, Math.floor(n)));
    while (this.pile.length > n) { const p = this.pile.pop()!; p.obj.removeFromParent(); }
    while (this.pile.length < n) {
      const i = this.pile.length;
      const key = this.presentKeys[i % Math.max(1, this.presentKeys.length)];
      const obj = (key && this.assets?.instance(key)) || this.boxPresent(i);
      // normalise size
      obj.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(obj), s = b.getSize(new THREE.Vector3());
      const k = PRESENT_SIZE / Math.max(0.05, Math.max(s.x, s.y, s.z));
      obj.scale.multiplyScalar(k);
      const holder = new THREE.Group(); holder.add(obj);
      // pyramid: 3 on the bottom, 2, then 1, then a second pyramid beside it
      const slots = [[-0.36, 0, 0], [0, 0, 0.02], [0.36, 0, -0.02], [-0.18, 1, 0], [0.18, 1, 0], [0, 2, 0]];
      const sl = slots[i % 6]!, group = Math.floor(i / 6);
      holder.position.set(sl[0]! + group * 0.95 * (group % 2 ? 1 : -1) * Math.ceil(group / 2), sl[1]! * PRESENT_SIZE * 0.95, sl[2]! + (group ? -0.3 : 0));
      holder.rotation.y = ((i * 37) % 11 - 5) * 0.06;
      this.presents.add(holder);
      this.pile.push({ obj: holder, pop: animate ? 0.0001 : 1 });
      if (animate) { holder.scale.setScalar(0.0001); this.bump.goal = 1; }
    }
  }
  private boxPresent(i: number): THREE.Object3D {
    const cols = [PALETTE.rose, PALETTE.sage, PALETTE.lavender, PALETTE.gold, PALETTE.cream];
    const geo = new THREE.BoxGeometry(1, 0.8, 1).translate(0, 0.4, 0); this.owned.push(geo);
    const m = toonMaterial({ color: new THREE.Color(cols[i % cols.length]!) }); this.owned.push({ dispose: () => { m.dispose(); toonMaterials.delete(m); } });
    const mesh = new THREE.Mesh(geo, m); mesh.castShadow = true; addOutline(mesh, 'thin');
    return mesh;
  }

  setSparks(n: number, animate: boolean): void {
    n = Math.max(0, Math.min(20, Math.floor(n)));
    while (this.stars.length > n) { const s = this.stars.pop()!; s.s.removeFromParent(); s.s.material.dispose(); if (animate) this.bump.sparks = 1; }
    while (this.stars.length < n) {
      const i = this.stars.length;
      const mat = new THREE.SpriteMaterial({ map: starTexture(), transparent: true, depthWrite: false });
      const s = new THREE.Sprite(mat); s.renderOrder = 5;
      const a = i * 2.4, r = 0.06 + (i % 3) * 0.035;
      const home = new THREE.Vector3(Math.cos(a) * r, 0.07 + (i % 5) * 0.06 + Math.floor(i / 5) * 0.02, Math.sin(a) * r);
      s.position.copy(home); s.scale.setScalar(animate ? 0.0001 : 0.11);
      this.starsGroup.add(s);
      this.stars.push({ s, home, ph: i * 1.7, pop: animate ? 0 : 1 });
      if (animate) this.bump.sparks = 1;
    }
    (this.glow.material as THREE.SpriteMaterial).opacity = n ? Math.min(0.95, 0.35 + n * 0.1) : 0;
  }

  /** Little wiggle on a meter (tapped / changed). */
  poke(k: MeterKind): void { this.bump[k] = 1; }

  get busy(): boolean {
    return Math.abs(this.handGoal - this.handCur) > 1e-3 || this.pile.some((p) => p.pop < 1) || this.stars.some((s) => s.pop < 1) ||
      this.bump.clock > 0 || this.bump.goal > 0 || this.bump.sparks > 0;
  }

  update(dt: number): void {
    this.t += dt;
    this.handCur += (this.handGoal - this.handCur) * (1 - Math.exp(-dt * 4));
    for (const h of this.hands) h.rotation.z = this.handCur;
    for (const p of this.pile) if (p.pop < 1) {
      p.pop = Math.min(1, p.pop + dt / 0.45);
      const u = p.pop, s = 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2;
      p.obj.scale.setScalar(Math.max(0.0001, s));
    }
    for (const st of this.stars) {
      if (st.pop < 1) st.pop = Math.min(1, st.pop + dt / 0.5);
      st.s.position.set(st.home.x + Math.sin(this.t * 1.3 + st.ph) * 0.015, st.home.y + Math.sin(this.t * 2 + st.ph) * 0.02, st.home.z);
      st.s.scale.setScalar(0.13 * (st.pop < 1 ? Math.sin(st.pop * Math.PI * 0.5) * 1.2 : 1) * (0.92 + Math.sin(this.t * 3 + st.ph) * 0.08));
      st.s.material.rotation = Math.sin(this.t * 0.8 + st.ph) * 0.3;
    }
    for (const [k, g] of [['clock', this.clock], ['goal', this.presents], ['sparks', this.jar]] as const) {
      if (this.bump[k] <= 0) continue;
      this.bump[k] = Math.max(0, this.bump[k] - dt / 0.5);
      const u = 1 - this.bump[k];
      g.rotation.z = Math.sin(u * Math.PI * 4) * 0.06 * (1 - u);
    }
  }

  clear(): void {
    for (const s of this.stars) s.s.material.dispose();
    this.stars.length = 0; this.starsGroup.clear();
    for (const g of [this.clock, this.presents, this.jar]) g.clear();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0; this.hands.length = 0; this.pile.length = 0;
  }
  dispose(): void {
    this.clear(); (this.glow.material as THREE.Material).dispose();
    starTex?.dispose(); glowTex?.dispose(); starTex = glowTex = null;
  }
}
