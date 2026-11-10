// One mini on the table: hero, foe or token. Owns its clone, mixer, movement along paths (metres, free movement),
// one-shot clips, hop-teleports, ghosting (hidden / remote preview) and the code-driven motion used for unrigged
// models (bob / hop / spin).
import * as THREE from 'three';
import type { Assets, ModelTemplate } from './assets';
import { addOutline, PALETTE, toonMaterial } from './style';

export type ActorKind = 'hero' | 'foe' | 'token';
type Base = 'idle' | 'walk' | 'sleep' | 'happy';
export type Motion = 'none' | 'bob' | 'float' | 'spin' | 'hover';

const ALIASES: Record<string, string[]> = {
  idle: ['idle'],
  walk: ['walk', 'run'], run: ['run', 'walk'],
  cheer: ['cheer', 'victory', 'clap', 'jump'], victory: ['victory', 'cheer', 'clap'], clap: ['clap', 'cheer'],
  wave: ['wave', 'cheer'], jump: ['jump', 'cheer'], throw: ['throw', 'pick_up'],
  pick_up: ['pick_up', 'pickup', 'pick'], pickup: ['pick_up', 'pickup'], hit: ['hit', 'hurt'], hurt: ['hit', 'hurt'],
  happy: ['happy_idle', 'happy', 'cheer', 'victory'], sleep: ['sleep', 'tuckered', 'lie'],
};

export const WALK_SPEED = 1.6; // metres per second
const tv = new THREE.Vector3();

const angleDamp = (a: number, b: number, k: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};
const easeOutBack = (x: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; };

// shared bits
const baseGeo = new THREE.CylinderGeometry(1, 1.06, 0.05, 28).translate(0, 0.025, 0);
const baseMats = new Map<string, THREE.Material>();
function baseMat(color: string): THREE.Material {
  let m = baseMats.get(color);
  if (!m) { m = toonMaterial({ color: new THREE.Color(color) }); baseMats.set(color, m); }
  return m;
}
// ghost versions of toon materials (hidden tokens on the Guide's screen, remote drag previews)
const ghostMats = new Map<THREE.Material, THREE.Material>();
export function ghostOf(src: THREE.Material): THREE.Material {
  let m = ghostMats.get(src);
  if (!m) {
    const s = src as THREE.MeshToonMaterial;
    m = toonMaterial({ color: s.color, map: s.map, transparent: true, opacity: 0.42, side: s.side });
    m.depthWrite = false;
    ghostMats.set(src, m);
  }
  return m;
}
export function disposeActorShared(): void {
  baseGeo.dispose(); for (const m of baseMats.values()) m.dispose(); baseMats.clear();
  for (const m of ghostMats.values()) m.dispose(); ghostMats.clear();
}

export class Actor {
  readonly root = new THREE.Group();    // board position
  readonly yaw = new THREE.Group();     // facing
  readonly pose = new THREE.Group();    // code-driven hop / tilt / pop scale
  body: THREE.Object3D | null = null;
  tpl: ModelTemplate | null = null;
  height = 1; radius = 0.35;
  motion: Motion = 'none';

  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private cur: THREE.AnimationAction | null = null;
  private oneShot: THREE.AnimationAction | null = null;
  private base: Base = 'idle';
  private walkScale = 1;

  // movement
  private path: THREE.Vector3[] = [];
  private slide = false;
  private targetYaw = 0;
  readonly goal = new THREE.Vector3();  // where the actor ends up

  // code-driven
  private t = Math.random() * 10;
  private hopT = -1; private shakeT = -1; private spinT = -1;
  private lie = 0; private lieGoal = 0;
  private popT = 0; private popDelay = 0;
  private leaveT = -1;
  dead = false;

  tuckered = false; down = false;
  speed = WALK_SPEED;                   // m/s along paths
  private ghosted = false;
  private realMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private hop: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  lift = 0; private liftCur = 0;          // raised while dragged
  private baseDisc: THREE.Mesh | null = null;
  carriedBy: string | null = null;
  pickable = true;

  constructor(readonly id: string, readonly kind: ActorKind) {
    this.root.add(this.yaw); this.yaw.add(this.pose);
    this.root.userData.actor = this;
  }

  /** Attach a loaded model (or a procedural stand-in). */
  setModel(assets: Assets, key: string | undefined, fallback: () => THREE.Object3D, extraScale = 1): void {
    const obj = key ? assets.instance(key) : null;
    this.tpl = key ? assets.models.get(key) ?? null : null;
    this.body = obj ?? fallback();
    if (extraScale !== 1) this.body.scale.multiplyScalar(extraScale);
    this.pose.add(this.body);
    if (this.tpl && obj) {
      this.height = this.tpl.height * extraScale; this.radius = this.tpl.radius * extraScale;
      if (this.tpl.rigged) {
        this.mixer = new THREE.AnimationMixer(obj);
        this.mixer.addEventListener('finished', (e) => this.onFinished(e.action as THREE.AnimationAction));
        const walk = this.clip('walk');
        if (walk?.speed) {
          const natural = walk.speed * this.tpl.scale * extraScale;
          this.walkScale = THREE.MathUtils.clamp(this.speed / natural, 0.7, 2.2);
        }
      }
    } else {
      const b = new THREE.Box3().setFromObject(this.body);
      this.height = Math.max(0.3, b.max.y); this.radius = Math.max(0.25, Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2);
    }
    if (this.kind !== 'token' && !this.mixer && this.motion === 'none') this.motion = 'bob';
    this.fadeTo('idle', 0);
  }

  addBase(color: string): void {
    const r = THREE.MathUtils.clamp(this.radius * 0.95, 0.3, 0.44);
    const m = new THREE.Mesh(baseGeo, baseMat(color));
    m.scale.set(r, 1, r); m.receiveShadow = true; m.castShadow = false;
    addOutline(m, 'thin');
    this.root.add(m); this.baseDisc = m;
  }
  setBaseColor(color: string): void { if (this.baseDisc) this.baseDisc.material = baseMat(color); }

  // ---------------------------------------------------------------- clips
  private clip(name: string) {
    const c = this.tpl?.clips; if (!c) return undefined;
    for (const n of ALIASES[name] ?? [name]) { const k = c.get(n); if (k) return k; }
    return c.get(name);
  }
  hasClip(name: string): boolean { return !!this.mixer && !!this.clip(name); }
  private action(name: string): THREE.AnimationAction | null {
    if (!this.mixer) return null;
    const c = this.clip(name); if (!c) return null;
    let a = this.actions.get(c.clip.name);
    if (!a) { a = this.mixer.clipAction(c.clip); this.actions.set(c.clip.name, a); }
    return a;
  }

  private baseAction(): THREE.AnimationAction | null {
    switch (this.base) {
      case 'walk': { const a = this.action('walk'); if (a) { a.setLoop(THREE.LoopRepeat, Infinity); a.timeScale = this.walkScale; } return a ?? this.action('idle'); }
      case 'happy': { const a = this.action('happy'); if (a) a.setLoop(THREE.LoopRepeat, Infinity); return a ?? this.action('idle'); }
      case 'sleep': { const a = this.action('sleep'); if (a) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; } return a ?? this.action('idle'); }
      default: { const a = this.action('idle'); a?.setLoop(THREE.LoopRepeat, Infinity); return a; }
    }
  }

  private fadeTo(base: Base, fade = 0.22): void {
    this.base = base;
    // procedural lie-down when there is no sleep clip
    this.lieGoal = base === 'sleep' && !this.hasClip('sleep') ? 1 : 0;
    if (this.oneShot) return;           // the one-shot returns to the base when it ends
    const a = this.baseAction();
    if (!a || a === this.cur) return;
    a.reset(); a.enabled = true; a.setEffectiveWeight(1); a.fadeIn(fade).play();
    if (this.cur) this.cur.fadeOut(fade);
    this.cur = a;
  }

  private onFinished(a: THREE.AnimationAction): void {
    if (a !== this.oneShot) return;
    this.oneShot = null;
    const b = this.baseAction();
    if (b && b !== a) { b.reset(); b.setEffectiveWeight(1); b.fadeIn(0.25).play(); a.fadeOut(0.25); this.cur = b; }
    else this.cur = a;
  }

  /** Play a clip once, then go back to the base (idle / sleep / walk). Falls back to code-driven motion. */
  playOnce(name: string): void {
    if (this.dead || this.leaveT >= 0) return;
    if (this.tuckered && name !== 'jump') return;
    const a = this.action(name);
    if (a && this.mixer) {
      a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.timeScale = 1;
      a.setEffectiveWeight(1); a.fadeIn(0.15).play();
      if (this.cur && this.cur !== a) this.cur.fadeOut(0.15);
      this.cur = a; this.oneShot = a;
      return;
    }
    if (name === 'hit' || name === 'hurt') this.shakeT = 0;
    else if (name === 'cheer' || name === 'victory' || name === 'happy') { this.hopT = 0; this.spinT = 0; }
    else this.hopT = 0;
  }

  // ---------------------------------------------------------------- state
  setTuckered(on: boolean, animate: boolean): void {
    if (on === this.tuckered) return;
    this.tuckered = on;
    if (on) {
      this.oneShot = null; this.fadeTo('sleep', animate ? 0.3 : 0);
      if (!animate) { this.lie = this.lieGoal; if (this.cur && this.hasClip('sleep')) this.cur.time = this.cur.getClip().duration - 1e-3; }
    }
    else { this.fadeTo('idle', 0.3); if (animate) this.playOnce('jump'); }
  }

  /** Knocked-out foe: falls over (sleep clip, or a tip-over for unrigged minis), then a puff and shrink. */
  knockOut(onPuff: (a: Actor) => void): void {
    if (this.down) return;
    this.down = true; this.pickable = false;
    this.path.length = 0; this.oneShot = null;
    this.fadeTo('sleep', 0.2);                   // unrigged minis tip over (lieGoal)
    this.leaveT = 0; this.leaveDelay = 1.8; this.onLeave = onPuff;
  }
  private onLeave: ((a: Actor) => void) | null = null;
  private leaveDelay = 1.6;

  /** Remove with a quick shrink (no happy clip). */
  leave(onPuff?: (a: Actor) => void, delay = 0): void {
    if (this.leaveT >= 0) return;
    this.pickable = false; this.leaveT = 0; this.leaveDelay = delay; this.onLeave = onPuff ?? null;
  }
  get leaving(): boolean { return this.leaveT >= 0; }

  popIn(delay = 0): void { this.popT = 0.0001; this.popDelay = delay; this.pose.scale.setScalar(0.0001); }

  place(p: THREE.Vector3): void {
    this.root.position.copy(p); this.goal.copy(p); this.hop = null;
    if (this.path.length) { this.path.length = 0; if (!this.tuckered && !this.down) this.fadeTo('idle', 0.15); }
  }

  /** Quick hop to a spot (Guide placement / teleport). */
  hopTo(p: THREE.Vector3): void {
    this.path.length = 0;
    if (!this.tuckered && !this.down && this.base === 'walk') this.fadeTo('idle', 0.15);
    this.hop = { from: this.root.position.clone(), to: p.clone(), t: 0 };
    this.goal.copy(p);
  }

  /** See-through look (hidden things for the Guide, remote drag previews). */
  setGhost(on: boolean): void {
    if (on === this.ghosted || !this.body) return;
    this.ghosted = on;
    this.body.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.userData.sbOutline) { m.visible = !on; return; }
      if (on) { this.realMats.set(m, m.material); m.material = Array.isArray(m.material) ? m.material.map(ghostOf) : ghostOf(m.material); }
      else { const r = this.realMats.get(m); if (r) m.material = r; }
      m.castShadow = !on;
    });
    if (!on) this.realMats.clear();
  }
  get ghost(): boolean { return this.ghosted; }
  face(yaw: number, instant = false): void { this.targetYaw = yaw; if (instant) this.yaw.rotation.y = yaw; }

  /** Walk (or slide) through world points. */
  moveAlong(points: THREE.Vector3[], slide = false): void {
    if (!points.length) return;
    this.path = points; this.slide = slide;
    this.goal.copy(points[points.length - 1]!);
    if (!slide && !this.tuckered && !this.down) { this.oneShot = null; this.fadeTo('walk', 0.15); }
  }
  get moving(): boolean { return this.path.length > 0; }

  /** Top of head in world space. */
  head(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.root.position).setY(this.root.position.y + this.pose.position.y + this.height * (1 - this.lie * 0.6) * this.pose.scale.y + 0.1);
  }

  get busy(): boolean { return this.path.length > 0 || !!this.hop || Math.abs(this.liftCur - this.lift) > 1e-3 || !!this.oneShot || this.popT > 0 || this.leaveT >= 0 || this.hopT >= 0 || this.shakeT >= 0 || Math.abs(this.lie - this.lieGoal) > 0.01; }

  // ---------------------------------------------------------------- per frame
  update(dt: number): void {
    this.t += dt;
    // movement
    if (this.path.length) {
      const target = this.path[0]!;
      const p = this.root.position;
      tv.subVectors(target, p); tv.y = 0;
      const d = tv.length(), step = (this.slide ? 4 : this.speed) * dt;
      if (d > 1e-4 && !this.slide) this.targetYaw = Math.atan2(tv.x, tv.z);
      if (d <= step) { p.x = target.x; p.z = target.z; this.path.shift(); }
      else p.addScaledVector(tv, step / d);
      if (!this.path.length && !this.tuckered && !this.down) this.fadeTo('idle', 0.2);
    }
    if (this.hop) {
      this.hop.t += dt / 0.38;
      const u = Math.min(1, this.hop.t), e = u * u * (3 - 2 * u);
      this.root.position.lerpVectors(this.hop.from, this.hop.to, e);
      this.root.position.y = Math.sin(u * Math.PI) * (0.35 + Math.min(1, this.hop.from.distanceTo(this.hop.to) * 0.1));
      tv.subVectors(this.hop.to, this.hop.from); tv.y = 0;
      if (tv.lengthSq() > 0.01) this.targetYaw = Math.atan2(tv.x, tv.z);
      if (u >= 1) { this.root.position.copy(this.hop.to); this.root.position.y = 0; this.hop = null; }
    }
    this.liftCur += (this.lift - this.liftCur) * (1 - Math.exp(-dt * 14));
    this.yaw.rotation.y = angleDamp(this.yaw.rotation.y, this.targetYaw, 1 - Math.exp(-dt * 12));
    this.mixer?.update(dt);

    // code-driven layers
    let y = 0, rz = 0, ry = 0;
    const moving = this.path.length > 0;
    if (this.motion === 'bob') y += (Math.sin(this.t * 2.4) * 0.5 + 0.5) * 0.05;
    else if (this.motion === 'float') { y += 0.18 + Math.sin(this.t * 2) * 0.07; ry = this.t * 1.2; }
    else if (this.motion === 'spin') { ry = this.t * 1.1; y += Math.sin(this.t * 2) * 0.03; }
    else if (this.motion === 'hover') y += 0.05 + Math.sin(this.t * 2.2) * 0.05;
    if (moving && !this.mixer && !this.slide) { y += Math.abs(Math.sin(this.t * 11)) * 0.12; rz = Math.sin(this.t * 11) * 0.08; }
    if (this.hopT >= 0) { this.hopT += dt; const u = this.hopT / 0.55; if (u >= 1) this.hopT = -1; else y += Math.sin(u * Math.PI) * 0.45; }
    if (this.spinT >= 0) { this.spinT += dt; const u = this.spinT / 0.6; if (u >= 1) this.spinT = -1; else ry += u * Math.PI * 2; }
    if (this.shakeT >= 0) { this.shakeT += dt; const u = this.shakeT / 0.45; if (u >= 1) this.shakeT = -1; else rz += Math.sin(u * 40) * 0.2 * (1 - u); }
    this.lie += (this.lieGoal - this.lie) * (1 - Math.exp(-dt * 6));
    this.pose.position.y = y + this.lie * this.radius * 0.5 + this.liftCur;
    this.pose.rotation.set(-this.lie * Math.PI * 0.48, ry, rz + this.lie * 0.15);

    // pop in / leave
    if (this.popT > 0) {
      if (this.popDelay > 0) this.popDelay -= dt;
      else {
        this.popT += dt / 0.45;
        const s = this.popT >= 1 ? 1 : Math.max(0.0001, easeOutBack(this.popT));
        this.pose.scale.setScalar(s);
        if (this.popT >= 1) this.popT = 0;
      }
    }
    if (this.leaveT >= 0) {
      this.leaveT += dt;
      const u = (this.leaveT - this.leaveDelay) / 0.35;
      if (u >= 0 && this.onLeave) { this.onLeave(this); this.onLeave = null; }
      if (u >= 0) this.pose.scale.setScalar(Math.max(0.0001, 1 - u) * (1 + Math.sin(Math.min(1, u) * Math.PI) * 0.25));
      if (u >= 1) { this.dead = true; this.root.visible = false; }
    }
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    if (this.mixer && this.body) this.mixer.uncacheRoot(this.body);
    this.root.removeFromParent();
  }
}

// ---------------------------------------------------------------- procedural stand-ins
const fallbackMats = new Map<number, THREE.Material>();
const fmat = (c: number) => { let m = fallbackMats.get(c); if (!m) { m = toonMaterial({ color: new THREE.Color(c) }); fallbackMats.set(c, m); } return m; };
const fallbackGeos: THREE.BufferGeometry[] = [];
function geo<T extends THREE.BufferGeometry>(g: T): T { fallbackGeos.push(g); return g; }
let pawnGeo: THREE.BufferGeometry | null = null, gemGeo: THREE.BufferGeometry | null = null, ringGeo: THREE.BufferGeometry | null = null, coneGeo: THREE.BufferGeometry | null = null;

export function pawn(color: number = PALETTE.lavender, h = 1): THREE.Object3D {
  pawnGeo ??= geo(new THREE.LatheGeometry([
    new THREE.Vector2(0, 0), new THREE.Vector2(0.28, 0), new THREE.Vector2(0.24, 0.12), new THREE.Vector2(0.14, 0.45),
    new THREE.Vector2(0.2, 0.62), new THREE.Vector2(0.2, 0.8), new THREE.Vector2(0.12, 0.95), new THREE.Vector2(0, 1),
  ], 16));
  const m = new THREE.Mesh(pawnGeo, fmat(color)); m.scale.setScalar(h); m.castShadow = true; addOutline(m);
  const g = new THREE.Group(); g.add(m); return g;
}
export function gem(color: number = PALETTE.gold, s = 0.3): THREE.Object3D {
  gemGeo ??= geo(new THREE.OctahedronGeometry(1, 0));
  const m = new THREE.Mesh(gemGeo, fmat(color)); m.scale.set(s * 0.8, s, s * 0.8); m.position.y = s + 0.1; m.castShadow = true; addOutline(m, 'med');
  const g = new THREE.Group(); g.add(m); return g;
}
/** Ground ring with an arrow (exit) or a bobbing glyph sprite (clue / npc). */
export function marker(color: number, glyph?: string): THREE.Object3D {
  ringGeo ??= geo(new THREE.RingGeometry(0.3, 0.42, 32).rotateX(-Math.PI / 2));
  const g = new THREE.Group();
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
  ring.position.y = 0.02; ring.renderOrder = 2; g.add(ring);
  if (!glyph) {
    coneGeo ??= geo(new THREE.ConeGeometry(0.16, 0.3, 4).rotateX(Math.PI));
    const c = new THREE.Mesh(coneGeo, fmat(color)); c.position.y = 0.55; c.castShadow = true; addOutline(c, 'med'); g.add(c);
  } else {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const x = cv.getContext('2d')!;
    x.beginPath(); x.arc(64, 64, 54, 0, Math.PI * 2); x.fillStyle = '#f7f3ec'; x.fill(); x.lineWidth = 8; x.strokeStyle = '#2a2328'; x.stroke();
    x.fillStyle = '#' + color.toString(16).padStart(6, '0'); x.font = '700 84px "Kalam", "Comic Sans MS", cursive';
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(glyph, 64, 70);
    x.lineWidth = 3; x.strokeStyle = '#2a2328'; x.strokeText(glyph, 64, 70);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t })); s.scale.setScalar(0.42); s.position.y = 0.75; g.add(s);
  }
  return g;
}
export function disposeFallbacks(): void {
  for (const g of fallbackGeos) g.dispose(); fallbackGeos.length = 0;
  pawnGeo = gemGeo = ringGeo = coneGeo = null;
  for (const m of fallbackMats.values()) m.dispose(); fallbackMats.clear();
}
