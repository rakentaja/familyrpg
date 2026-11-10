// Flick-to-throw dice. Two chunky inked dice wait at the bottom of the view; a flick throws them onto the table,
// cannon-es decides the faces, and the throw is recorded at 30 Hz so other devices can replay it exactly.
//
//   DicePhysics  pure simulation + recording (no DOM, runs headless in tests)
//   DiceRig      visuals, gestures, arming hint/label, replay
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { DiceThrow } from '../contracts';

// ---------------------------------------------------------------- tuning
export const DIE = 0.55;             // edge length, metres
const GRAVITY = 25;                  // a bit above 9.8: snappier tumbles at table scale
const H = 1 / 120;                   // fixed physics step
const MAX_SUBSTEPS = 8;              // per update(); slow frames run in slow motion instead of spiralling
const REC_EVERY = 4;                 // 120 / 4 = 30 Hz recording
export const FPS = 30;
const SETTLE_MAX = 2.5;              // force-sleep after this many seconds of simulation
const COCKED = THREE.MathUtils.degToRad(20);
const ROLL_OUT = 0.25;               // expected slide after touchdown, × horizontal speed (s)
const RIM_H = 1.0;                   // invisible rim around the table
const MAX_FRAMES = Math.ceil((SETTLE_MAX + 0.8) * FPS) + 4;
const STRIDE = 7;                    // x y z qx qy qz qw
const POS_Q = 100, ROT_Q = 1000;     // cm, quaternion ×1000
const PACK_VERSION = 1, HEADER = 4;  // [version, fps, nDice, nFrames]

// BoxGeometry material order +X, -X, +Y, -Y, +Z, -Z; opposite faces sum to 7.
export const FACE_VALUES = [3, 4, 1, 6, 2, 5] as const;

export interface Obstacle { x: number; z: number; r: number }
export interface TableDef { w: number; d: number; obstacles: Obstacle[] }
export interface V3 { x: number; y: number; z: number }
export interface Q4 { x: number; y: number; z: number; w: number }

// ---------------------------------------------------------------- face detection
/** Value of the face pointing up for a die with orientation q, and its tilt (radians) from perfectly flat. */
export function upFace(q: Q4): { value: number; tilt: number } {
  const { x, y, z, w } = q;
  // world-Y component of the die's local X / Y / Z axes
  const ax = 2 * (x * y + w * z), ay = 1 - 2 * (x * x + z * z), az = 2 * (y * z - w * x);
  let best = ax, value: number = FACE_VALUES[0];
  if (-ax > best) { best = -ax; value = FACE_VALUES[1]; }
  if (ay > best) { best = ay; value = FACE_VALUES[2]; }
  if (-ay > best) { best = -ay; value = FACE_VALUES[3]; }
  if (az > best) { best = az; value = FACE_VALUES[4]; }
  if (-az > best) { best = -az; value = FACE_VALUES[5]; }
  return { value, tilt: Math.acos(Math.min(1, Math.max(-1, best))) };
}

/** Local normal of a face value. */
export function faceNormal(value: number): [number, number, number] {
  const i = FACE_VALUES.indexOf(value as (typeof FACE_VALUES)[number]);
  const s = i % 2 === 0 ? 1 : -1, axis = i >> 1;
  return [axis === 0 ? s : 0, axis === 1 ? s : 0, axis === 2 ? s : 0];
}

// ---------------------------------------------------------------- frame packing
/**
 * Pack raw poses (nFrames × nDice × [x y z qx qy qz qw], metres / unit quaternion) into integers:
 * header [1, fps, nDice, nFrames], first frame absolute, then per-value deltas of the quantised values.
 * Quaternion signs are kept continuous so the deltas stay small.
 */
export function packFrames(raw: ArrayLike<number>, nFrames: number, nDice = 2, fps = FPS): number[] {
  const n = nDice * STRIDE, out: number[] = [PACK_VERSION, fps, nDice, nFrames];
  const prev = new Int32Array(n), cur = new Int32Array(n), lastQ = new Float64Array(nDice * 4);
  for (let f = 0; f < nFrames; f++) {
    for (let d = 0; d < nDice; d++) {
      const o = (f * nDice + d) * STRIDE, k = d * STRIDE;
      let qx = raw[o + 3]!, qy = raw[o + 4]!, qz = raw[o + 5]!, qw = raw[o + 6]!;
      const len = Math.hypot(qx, qy, qz, qw) || 1;
      qx /= len; qy /= len; qz /= len; qw /= len;
      if (f > 0 && qx * lastQ[d * 4]! + qy * lastQ[d * 4 + 1]! + qz * lastQ[d * 4 + 2]! + qw * lastQ[d * 4 + 3]! < 0) {
        qx = -qx; qy = -qy; qz = -qz; qw = -qw;
      }
      lastQ[d * 4] = qx; lastQ[d * 4 + 1] = qy; lastQ[d * 4 + 2] = qz; lastQ[d * 4 + 3] = qw;
      cur[k] = Math.round(raw[o]! * POS_Q); cur[k + 1] = Math.round(raw[o + 1]! * POS_Q); cur[k + 2] = Math.round(raw[o + 2]! * POS_Q);
      cur[k + 3] = Math.round(qx * ROT_Q); cur[k + 4] = Math.round(qy * ROT_Q); cur[k + 5] = Math.round(qz * ROT_Q); cur[k + 6] = Math.round(qw * ROT_Q);
    }
    for (let i = 0; i < n; i++) { out.push(f === 0 ? cur[i]! : cur[i]! - prev[i]!); prev[i] = cur[i]!; }
  }
  return out;
}

export interface Unpacked { fps: number; nDice: number; nFrames: number; data: Float32Array }
/** Inverse of packFrames (quaternions re-normalised). Throws on malformed input. */
export function unpackFrames(frames: readonly number[]): Unpacked {
  const [ver, fps, nDice, nFrames] = frames as [number, number, number, number];
  const n = (nDice | 0) * STRIDE;
  if (ver !== PACK_VERSION || !(fps > 0) || !(nDice > 0) || !(nFrames > 0) || frames.length !== HEADER + n * nFrames) {
    throw new Error('bad dice frames');
  }
  const data = new Float32Array(n * nFrames), acc = new Int32Array(n);
  for (let f = 0; f < nFrames; f++) {
    for (let i = 0; i < n; i++) acc[i] = acc[i]! + (frames[HEADER + f * n + i]! | 0);
    for (let d = 0; d < nDice; d++) {
      const k = d * STRIDE, o = f * n + k;
      data[o] = acc[k]! / POS_Q; data[o + 1] = acc[k + 1]! / POS_Q; data[o + 2] = acc[k + 2]! / POS_Q;
      const qx = acc[k + 3]!, qy = acc[k + 4]!, qz = acc[k + 5]!, qw = acc[k + 6]!;
      const len = Math.hypot(qx, qy, qz, qw) || 1;
      data[o + 3] = qx / len; data[o + 4] = qy / len; data[o + 5] = qz / len; data[o + 6] = qw / len;
    }
  }
  return { fps, nDice, nFrames, data };
}

// ---------------------------------------------------------------- throw planning
/**
 * One die's throw: a scripted flight (cubic Hermite p0→p1 with end tangents v0/v1 over T seconds, spinning at w) from
 * the hand to just above the table, then cannon-es takes over at p1 with velocity v1 and spin w. The flight keeps the
 * fall from the camera height from slamming the dice, so they land where aimed and settle fast.
 */
export interface DieLaunch { p0: V3; q0: Q4; v0: V3; p1: V3; v1: V3; w: V3; T: number }
export interface FlickInput {
  power: number;   // 0 (weak) .. 1 (hard)
  side: number;    // -1 .. 1, sideways share of the swipe (+ = to the camera's right)
}

/** Where on the table a flick of this power/direction aims (pure). fwd/right are unit ground vectors (x,z). */
export function aimPoint(table: TableDef, from: { x: number; z: number }, fwd: { x: number; z: number },
  right: { x: number; z: number }, f: FlickInput): { x: number; z: number; dir: { x: number; z: number } } {
  const side = Math.max(-0.75, Math.min(0.75, f.side));
  let dx = fwd.x + right.x * side, dz = fwd.z + right.z * side;
  const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  const hw = table.w / 2, hd = table.d / 2, m = DIE * 1.6;
  // ray from the thrower's ground point against the table rectangle (slab test)
  let t0 = 0, t1 = Infinity;
  for (const [o, dd, lo, hi] of [[from.x, dx, -hw, hw], [from.z, dz, -hd, hd]] as const) {
    if (Math.abs(dd) < 1e-6) { if (o < lo || o > hi) { t0 = Infinity; } continue; }
    const a = (lo - o) / dd, b = (hi - o) / dd;
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
  }
  let x: number, z: number;
  if (t0 <= t1 && Number.isFinite(t1)) {
    const reach = (t1 - t0) * 0.62, p = Math.max(0, Math.min(1, f.power));
    const t = t0 + m + p * Math.max(0, reach - m);
    x = from.x + dx * t; z = from.z + dz * t;
  } else { x = from.x + dx * 3; z = from.z + dz * 3; }    // looking off the table: clamp below
  x = Math.max(-hw + m, Math.min(hw - m, x)); z = Math.max(-hd + m, Math.min(hd - m, z));
  for (const o of table.obstacles) {                       // never aim at a prop
    const ox = x - o.x, oz = z - o.z, dd = Math.hypot(ox, oz), need = o.r + DIE * 1.2;
    if (dd < need) {
      const ux = dd > 1e-4 ? ox / dd : -dx, uz = dd > 1e-4 ? oz / dd : -dz;
      x = o.x + ux * need; z = o.z + uz * need;
      x = Math.max(-hw + m, Math.min(hw - m, x)); z = Math.max(-hd + m, Math.min(hd - m, z));
    }
  }
  return { x, z, dir: { x: dx, z: dz } };
}

/** Initial state for both dice: ballistic arc from their start poses to the aim point, plus random tumble. */
export function planThrow(table: TableDef, starts: readonly [V3, V3], quats: readonly [Q4, Q4],
  fwd: { x: number; z: number }, right: { x: number; z: number }, f: FlickInput, rnd: () => number = Math.random): [DieLaunch, DieLaunch] {
  const cx = (starts[0].x + starts[1].x) / 2, cz = (starts[0].z + starts[1].z) / 2;
  const aim = aimPoint(table, { x: cx, z: cz }, fwd, right, f);
  const px = -aim.dir.z, pz = aim.dir.x;                   // perpendicular on the ground
  const p = Math.max(0, Math.min(1, f.power));
  const T = 0.62 - 0.12 * p;                               // flight time
  const vh = 2.2 + 3.0 * p;                                // horizontal speed at touchdown
  // touch down short of the aim so the slide/roll-out ends near it
  const roll = ROLL_OUT * vh;
  const hw = table.w / 2 - DIE * 1.6, hd = table.d / 2 - DIE * 1.6;
  const ax = Math.max(-hw, Math.min(hw, aim.x - aim.dir.x * roll)), az = Math.max(-hd, Math.min(hd, aim.z - aim.dir.z * roll));
  const out = [0, 1].map((i) => {
    const s = starts[i as 0 | 1], sgn = i === 0 ? -1 : 1, q = quats[i as 0 | 1];
    const p1 = {
      x: ax + px * sgn * DIE * 0.75 + (rnd() - 0.5) * DIE * 0.5,
      y: DIE * 1.6 + rnd() * DIE * 0.6,
      z: az + pz * sgn * DIE * 0.75 + (rnd() - 0.5) * DIE * 0.5,
    };
    const lean = (rnd() - 0.5) * 0.5;                      // a little spread between the two dice
    const dx = aim.dir.x + px * lean * 0.3, dz = aim.dir.z + pz * lean * 0.3;
    const v1 = { x: dx * vh, y: -(5 + rnd() * 2), z: dz * vh };
    // leaves the hand forward and slightly upward
    const out0 = 7 + 5 * p;
    const v0 = { x: aim.dir.x * out0 + px * sgn * 0.6, y: 2.5 + 2 * p, z: aim.dir.z * out0 + pz * sgn * 0.6 };
    // tumble forward (axis = up × dir) plus random wobble
    const spin = 13 + rnd() * 9;
    const w = { x: aim.dir.z * spin + (rnd() - 0.5) * 10, y: (rnd() - 0.5) * 12, z: -aim.dir.x * spin + (rnd() - 0.5) * 10 };
    return {
      p0: { x: s.x, y: s.y, z: s.z }, q0: { x: q.x, y: q.y, z: q.z, w: q.w }, v0, p1, v1, w,
      T: T * (1 + (rnd() - 0.5) * 0.1) + i * 0.04,
    };
  });
  return out as [DieLaunch, DieLaunch];
}

// ---------------------------------------------------------------- physics + recording
type Phase = 'idle' | 'sim' | 'nudge' | 'done';

export class DicePhysics {
  readonly world: CANNON.World;
  readonly bodies: [CANNON.Body, CANNON.Body];
  private statics: CANNON.Body[] = [];
  private dieMat = new CANNON.Material('die');
  private tableMat = new CANNON.Material('table');
  private rimMat = new CANNON.Material('rim');
  table: TableDef = { w: 8, d: 8, obstacles: [] };
  phase: Phase = 'idle';
  time = 0;                        // simulated seconds since launch
  private acc = 0; private steps = 0; private still = 0; private landT = -1;
  private rec = new Float32Array(MAX_FRAMES * 2 * STRIDE); private nRec = 0;
  // nudge animation
  private nT = 0; private nDur = 0; private nHop = 0;
  private n0p = [new CANNON.Vec3(), new CANNON.Vec3()]; private n1p = [new CANNON.Vec3(), new CANNON.Vec3()];
  private n0q = [new CANNON.Quaternion(), new CANNON.Quaternion()]; private n1q = [new CANNON.Quaternion(), new CANNON.Quaternion()];
  private tq = new CANNON.Quaternion(); private tv = new CANNON.Vec3(); private tv2 = new CANNON.Vec3(); private up = new CANNON.Vec3(0, 1, 0);
  values: [number, number] = [1, 1];
  settleTime = 0;                  // when physics stopped (before the nudge)

  constructor() {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0), allowSleep: true });
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.dieMat, this.tableMat, { friction: 0.45, restitution: 0.22 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.dieMat, this.rimMat, { friction: 0.1, restitution: 0.45 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.dieMat, this.dieMat, { friction: 0.25, restitution: 0.25 }));
    const ground = new CANNON.Body({ mass: 0, material: this.tableMat, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(ground);
    const shape = new CANNON.Box(new CANNON.Vec3(DIE / 2, DIE / 2, DIE / 2));
    const mk = () => {
      const b = new CANNON.Body({ mass: 1, shape, material: this.dieMat, allowSleep: true, sleepSpeedLimit: 0.12, sleepTimeLimit: 0.2 });
      b.position.set(0, -50, 0); b.type = CANNON.Body.STATIC; this.world.addBody(b);
      return b;
    };
    this.bodies = [mk(), mk()];
    this.setTable({ w: 8, d: 8 }, []);
  }

  setTable(bounds: { w: number; d: number }, obstacles: Obstacle[]): void {
    for (const b of this.statics) this.world.removeBody(b);
    this.statics = [];
    this.table = { w: Math.max(DIE * 4, bounds.w), d: Math.max(DIE * 4, bounds.d), obstacles: obstacles.map((o) => ({ ...o })) };
    const { w, d } = this.table, t = 1.0;
    const wall = (x: number, z: number, hx: number, hz: number) => {
      const b = new CANNON.Body({ mass: 0, material: this.rimMat, shape: new CANNON.Box(new CANNON.Vec3(hx, RIM_H / 2, hz)) });
      b.position.set(x, RIM_H / 2, z); this.world.addBody(b); this.statics.push(b);
    };
    wall(0, -d / 2 - t, w / 2 + 2 * t, t); wall(0, d / 2 + t, w / 2 + 2 * t, t);
    wall(-w / 2 - t, 0, t, d / 2 + 2 * t); wall(w / 2 + t, 0, t, d / 2 + 2 * t);
    for (const o of this.table.obstacles) {
      const b = new CANNON.Body({ mass: 0, material: this.rimMat, shape: new CANNON.Cylinder(o.r, o.r, 1.6, 12) });
      b.position.set(o.x, 0.8, o.z); this.world.addBody(b); this.statics.push(b);
    }
  }

  private plan: DieLaunch[] = [];
  private flying = [false, false];

  launch(l: readonly [DieLaunch, DieLaunch]): void {
    this.plan = l.map((d) => ({ ...d }));
    l.forEach((d, i) => {
      const b = this.bodies[i]!;
      b.type = CANNON.Body.STATIC; b.velocity.setZero(); b.angularVelocity.setZero();
      b.position.set(d.p0.x, d.p0.y, d.p0.z); b.quaternion.set(d.q0.x, d.q0.y, d.q0.z, d.q0.w); b.quaternion.normalize();
      b.linearDamping = 0.1; b.angularDamping = 0.2;
      this.flying[i] = true;
    });
    this.phase = 'sim'; this.time = 0; this.landT = -1; this.acc = 0; this.steps = 0; this.still = 0; this.nRec = 0;
    this.record();
  }

  /** Scripted flight for die i at time t (Hermite position, constant spin); hands over to physics at the end. */
  private fly(i: number): void {
    const d = this.plan[i]!, b = this.bodies[i]!;
    const u = Math.min(1, this.time / d.T), u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    b.position.set(
      h00 * d.p0.x + h10 * d.T * d.v0.x + h01 * d.p1.x + h11 * d.T * d.v1.x,
      h00 * d.p0.y + h10 * d.T * d.v0.y + h01 * d.p1.y + h11 * d.T * d.v1.y,
      h00 * d.p0.z + h10 * d.T * d.v0.z + h01 * d.p1.z + h11 * d.T * d.v1.z);
    // integrate the spin: q += 0.5 * ω q * dt
    b.quaternion.integrate(this.tv.set(d.w.x, d.w.y, d.w.z), H, this.tv2.set(1, 1, 1), b.quaternion);
    b.quaternion.normalize();
    if (u >= 1) {
      this.flying[i] = false;
      b.type = CANNON.Body.DYNAMIC; b.mass = 1; b.updateMassProperties();
      b.velocity.set(d.v1.x, d.v1.y, d.v1.z); b.angularVelocity.set(d.w.x, d.w.y, d.w.z);
      b.force.setZero(); b.torque.setZero(); b.wakeUp();
    }
  }

  /** Park the dice (no simulation). */
  stop(): void {
    for (const b of this.bodies) { b.type = CANNON.Body.STATIC; b.velocity.setZero(); b.angularVelocity.setZero(); b.position.set(0, -50, 0); }
    this.phase = 'idle';
  }

  /** Advance by real dt (fixed sub-steps). Returns true while the throw is still running. */
  advance(dt: number): boolean {
    if (this.phase !== 'sim' && this.phase !== 'nudge') return false;
    this.acc += Math.min(dt, MAX_SUBSTEPS * H);
    let n = 0;
    while (this.acc >= H && n < MAX_SUBSTEPS && (this.phase === 'sim' || this.phase === 'nudge')) {
      this.acc -= H; n++; this.stepOnce();
    }
    return this.phase === 'sim' || this.phase === 'nudge';
  }

  /** Run to completion (tests / headless). */
  runToEnd(maxSeconds = 6): void { let t = 0; while (this.advance(H) && t < maxSeconds) t += H; }

  private stepOnce(): void {
    this.time += H; this.steps++;
    if (this.phase === 'sim') {
      // settle assist: damping ramps up after the first touchdown so the dice stop rolling quickly
      if (this.landT < 0 && (this.bodies[0].position.y < DIE * 0.8 || this.bodies[1].position.y < DIE * 0.8)) this.landT = this.time;
      if (this.landT >= 0) {
        const k = Math.min(1, (this.time - this.landT) / 0.55);
        for (const b of this.bodies) { b.linearDamping = 0.1 + 0.7 * k; b.angularDamping = 0.2 + 0.75 * k; }
      }
      if (this.flying[0]) this.fly(0);
      if (this.flying[1]) this.fly(1);
      this.world.step(H);
      const [a, b] = this.bodies;
      const moving = (x: CANNON.Body) => x.type !== CANNON.Body.DYNAMIC || x.sleepState !== CANNON.Body.SLEEPING && (x.velocity.length() > 0.1 || x.angularVelocity.length() > 0.35);
      this.still = this.time > 0.35 && !moving(a) && !moving(b) ? this.still + H : 0;
      if (this.still >= 0.12 || this.time >= SETTLE_MAX) this.beginNudge();
    } else if (this.phase === 'nudge') {
      this.nT += H;
      const u = Math.min(1, this.nT / this.nDur), e = u * u * (3 - 2 * u);
      for (let i = 0; i < 2; i++) {
        const b = this.bodies[i]!;
        const a = this.n0p[i]!, c = this.n1p[i]!;
        b.position.set(a.x + (c.x - a.x) * e, a.y + (c.y - a.y) * e + Math.sin(Math.PI * u) * this.nHop, a.z + (c.z - a.z) * e);
        this.n0q[i]!.slerp(this.n1q[i]!, e, b.quaternion);
      }
      if (u >= 1) this.finish();
    }
    if (this.steps % REC_EVERY === 0) this.record();
  }

  private beginNudge(): void {
    this.settleTime = this.time;
    const { w, d, obstacles } = this.table;
    let big = false, small = false;
    for (let i = 0; i < 2; i++) {
      const b = this.bodies[i]!;
      b.type = CANNON.Body.STATIC; b.velocity.setZero(); b.angularVelocity.setZero(); b.sleep();
      this.n0p[i]!.copy(b.position); this.n0q[i]!.copy(b.quaternion);
      // flatten onto the nearest face, keep the yaw
      const { value, tilt } = upFace(b.quaternion);
      const [nx, ny, nz] = faceNormal(value);
      b.quaternion.vmult(this.tv.set(nx, ny, nz), this.tv2);
      this.tq.setFromVectors(this.tv2, this.up);
      this.tq.mult(b.quaternion, this.n1q[i]!); this.n1q[i]!.normalize();
      this.n1p[i]!.set(b.position.x, DIE / 2, b.position.z);
      if (tilt > COCKED || b.position.y > DIE / 2 + 0.04) big = true; else if (tilt > 0.02) small = true;
    }
    // keep both on the table, outside props, not inside each other
    const hw = w / 2 - DIE / 2 - 0.01, hd = d / 2 - DIE / 2 - 0.01;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < 2; i++) {
        const p = this.n1p[i]!;
        p.x = Math.max(-hw, Math.min(hw, p.x)); p.z = Math.max(-hd, Math.min(hd, p.z));
        for (const o of obstacles) {
          const ox = p.x - o.x, oz = p.z - o.z, dd = Math.hypot(ox, oz), need = o.r + DIE * 0.55;
          if (dd < need) { const k = dd > 1e-4 ? need / dd : 0; p.x = o.x + (k ? ox * k : need); p.z = o.z + (k ? oz * k : 0); }
        }
        const q = this.n1p[1 - i]!, ox = p.x - q.x, oz = p.z - q.z, dd = Math.hypot(ox, oz), need = DIE * 1.02;
        if (dd < need) { const k = dd > 1e-4 ? (need - dd) / dd / 2 : 0; p.x += k ? ox * k : need / 2; p.z += k ? oz * k : 0; q.x -= k ? ox * k : need / 2; q.z -= k ? oz * k : 0; }
      }
    }
    for (let i = 0; i < 2; i++) {
      const a = this.n0p[i]!, c = this.n1p[i]!;
      if (Math.hypot(a.x - c.x, a.z - c.z) > 0.02) big = true;
    }
    this.nT = 0;
    this.nDur = big ? 0.32 : small ? 0.12 : 0;
    this.nHop = big ? DIE * 0.6 : 0;
    this.values = [upFace(this.n1q[0]!).value, upFace(this.n1q[1]!).value];
    if (this.nDur === 0) this.finish(); else this.phase = 'nudge';
  }

  private finish(): void {
    for (let i = 0; i < 2; i++) { this.bodies[i]!.position.copy(this.n1p[i]!); this.bodies[i]!.quaternion.copy(this.n1q[i]!); }
    this.phase = 'done';
    if (this.steps % REC_EVERY !== 0) this.record();      // last frame = exact resting pose
  }

  private record(): void {
    if (this.nRec >= MAX_FRAMES) return;
    let o = this.nRec * 2 * STRIDE;
    for (const b of this.bodies) {
      const r = this.rec;
      r[o] = b.position.x; r[o + 1] = b.position.y; r[o + 2] = b.position.z;
      r[o + 3] = b.quaternion.x; r[o + 4] = b.quaternion.y; r[o + 5] = b.quaternion.z; r[o + 6] = b.quaternion.w;
      o += STRIDE;
    }
    this.nRec++;
  }

  get land(): { x: number; z: number } {
    const [a, b] = this.bodies;
    return { x: Math.round((a.position.x + b.position.x) * 50) / 100, z: Math.round((a.position.z + b.position.z) * 50) / 100 };
  }

  frames(): number[] { return packFrames(this.rec, this.nRec, 2, FPS); }
  get frameCount(): number { return this.nRec; }

  dispose(): void {
    for (const b of [...this.world.bodies]) this.world.removeBody(b);
    this.statics = [];
  }
}

// ---------------------------------------------------------------- visuals
const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]], 2: [[0.28, 0.28], [0.72, 0.72]], 3: [[0.26, 0.26], [0.5, 0.5], [0.74, 0.74]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.26, 0.26], [0.74, 0.26], [0.5, 0.5], [0.26, 0.74], [0.74, 0.74]],
  6: [[0.28, 0.24], [0.72, 0.24], [0.28, 0.5], [0.72, 0.5], [0.28, 0.76], [0.72, 0.76]],
};
const CREAM = '#f2eadb', INK = '#2a2328';

function faceTexture(v: number, pip: string, seed: number): THREE.CanvasTexture {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = CREAM; g.fillRect(0, 0, S, S);
  // loose watercolour blotches + darker wash at the edges
  let s = seed * 9301 + v * 49297;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 7; i++) {
    g.fillStyle = `rgba(${180 + rnd() * 40 | 0},${160 + rnd() * 30 | 0},${150 + rnd() * 30 | 0},0.07)`;
    g.beginPath(); g.arc(rnd() * S, rnd() * S, 18 + rnd() * 34, 0, Math.PI * 2); g.fill();
  }
  const e = g.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S * 0.75);
  e.addColorStop(0, 'rgba(120,96,96,0)'); e.addColorStop(1, 'rgba(120,96,96,0.22)');
  g.fillStyle = e; g.fillRect(0, 0, S, S);
  const r = v === 1 ? 17 : 12;
  for (const [x, y] of PIPS[v]!) {
    g.fillStyle = INK; g.beginPath(); g.arc(x * S, y * S, r + 3.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = pip; g.beginPath(); g.arc(x * S, y * S, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.arc(x * S - r * 0.3, y * S - r * 0.3, r * 0.35, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function toonGradient(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([105, 105, 105, 255, 185, 185, 185, 255, 255, 255, 255, 255]), 3, 1);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true;
  return t;
}

/** Inverted hull whose width grows a little with distance so the dice stay inked near and far. */
function inkMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0x2a2328, side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float sbDepth = -(modelViewMatrix * vec4(position, 1.0)).z;
      transformed += normalize(normal) * clamp(sbDepth * 0.0026, 0.014, 0.05);`);
  };
  m.customProgramCacheKey = () => 'sb-dice-ink';
  return m;
}

function textSprite(): { sprite: THREE.Sprite; set(text: string): void; dispose(): void } {
  const c = document.createElement('canvas'); c.width = 512; c.height = 112;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
  const sprite = new THREE.Sprite(mat); sprite.renderOrder = 30;
  return {
    sprite,
    set(text: string) {
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, c.width, c.height);
      g.font = 'bold 50px "Trebuchet MS", "Avenir Next", system-ui, sans-serif';
      const tw = Math.min(c.width - 40, g.measureText(text).width + 56), x0 = (c.width - tw) / 2;
      g.fillStyle = CREAM; g.strokeStyle = INK; g.lineWidth = 6;
      g.beginPath(); g.roundRect(x0, 12, tw, 88, 44); g.fill(); g.stroke();
      g.fillStyle = INK; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, c.width / 2, 58, c.width - 80);
      tex.needsUpdate = true;
    },
    dispose() { tex.dispose(); mat.dispose(); },
  };
}

function hintSprite(): { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; dispose(): void } {
  const c = document.createElement('canvas'); c.width = 128; c.height = 192;
  const g = c.getContext('2d')!;
  // chunky up arrow, rose wash with ink contour, plus three motion ticks
  g.lineJoin = 'round'; g.lineWidth = 9; g.strokeStyle = INK; g.fillStyle = '#d8a7a7';
  g.beginPath();
  g.moveTo(64, 10); g.lineTo(116, 72); g.lineTo(84, 72); g.lineTo(84, 150); g.lineTo(44, 150); g.lineTo(44, 72); g.lineTo(12, 72);
  g.closePath(); g.fill(); g.stroke();
  g.lineWidth = 7; g.lineCap = 'round';
  for (const [x, y] of [[40, 170], [64, 182], [88, 170]]) { g.beginPath(); g.moveTo(x!, y!); g.lineTo(x!, y! + 6); g.stroke(); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
  const sprite = new THREE.Sprite(mat); sprite.renderOrder = 31;
  return { sprite, mat, dispose() { tex.dispose(); mat.dispose(); } };
}

const HINT_KEY = 'sb.dice.flicked';
function hintSeen(): boolean { try { return globalThis.localStorage?.getItem(HINT_KEY) === '1'; } catch { return false; } }
function markHintSeen(): void { try { globalThis.localStorage?.setItem(HINT_KEY, '1'); } catch { /* private mode */ } }

type RigState = 'idle' | 'armed' | 'held' | 'sim' | 'shown' | 'replay' | 'hiding';
const SAMPLES = 16, VEL_WINDOW = 80, TAP_PX = 12, TAP_MS = 350;
const SHOW_FOR = 5, HIDE_DUR = 0.3;

export interface DiceRigOptions {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; canvas: HTMLCanvasElement; toon?: (m: THREE.Mesh) => void;
}

// scratch (no per-frame allocations)
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();

export class DiceRig {
  onThrown?: (t: DiceThrow) => void;
  /** Vertical position of the armed dice in NDC (-1 bottom .. 1 top). Raise it if UI covers the bottom edge. */
  armY = -0.6;

  private scene: THREE.Scene; private camera: THREE.PerspectiveCamera; private canvas: HTMLCanvasElement;
  private group = new THREE.Group();
  private geo: RoundedBoxGeometry;
  private mats: THREE.Material[][] = [];
  private ink: THREE.MeshBasicMaterial; private grad: THREE.DataTexture;
  private meshes: THREE.Mesh[] = [];
  private label = textSprite(); private hint = hintSprite();
  private phys = new DicePhysics();
  private state: RigState = 'idle';
  private rollId = ''; private t = 0; private stateT = 0;
  private showHint = !hintSeen();
  // arming layout (world, recomputed every frame from the camera)
  private armPos = [new THREE.Vector3(), new THREE.Vector3()];
  private armQ = [new THREE.Quaternion(), new THREE.Quaternion()];
  private armDepth = 6;
  // gesture
  private ptrId = -1; private n = 0;
  private sx = new Float64Array(SAMPLES); private sy = new Float64Array(SAMPLES); private st = new Float64Array(SAMPLES);
  private downX = 0; private downY = 0; private downT = 0; private maxTravel = 0;
  private hold = new THREE.Vector3(); private holdGoal = new THREE.Vector3(); private liftK = 0;
  // replay
  private rep: Unpacked | null = null; private repT = 0; private repDone: (() => void) | null = null;
  private hideScale = 1;
  private disposed = false;

  constructor(opts: DiceRigOptions) {
    this.scene = opts.scene; this.camera = opts.camera; this.canvas = opts.canvas;
    this.geo = new RoundedBoxGeometry(DIE, DIE, DIE, 3, DIE * 0.16);
    this.grad = toonGradient();
    this.ink = inkMaterial();
    const pips = ['#d8a7a7', '#b4abc6'];
    for (let i = 0; i < 2; i++) {
      const mats = FACE_VALUES.map((v) => new THREE.MeshToonMaterial({ map: faceTexture(v, pips[i]!, i + 1), gradientMap: this.grad }));
      this.mats.push(mats);
      const m = new THREE.Mesh(this.geo, mats); m.castShadow = true; m.receiveShadow = false; m.name = 'die' + i;
      if (opts.toon) opts.toon(m);
      else { const hull = new THREE.Mesh(this.geo, this.ink); hull.raycast = () => {}; hull.userData.sbOutline = true; m.add(hull); }
      m.raycast = () => {};
      this.meshes.push(m); this.group.add(m);
    }
    this.group.add(this.label.sprite, this.hint.sprite);
    this.group.visible = false; this.group.name = 'dice';
    this.scene.add(this.group);
    this.armQ[0]!.setFromEuler(_e.set(0.5, 0.6, 0.15));
    this.armQ[1]!.setFromEuler(_e.set(0.35, -0.5, -0.2));
  }

  setTable(bounds: { w: number; d: number }, obstacles: Obstacle[]): void { this.phys.setTable(bounds, obstacles); }

  get armed(): boolean { return this.state === 'armed' || this.state === 'held'; }

  arm(rollId: string, label: string): void {
    if (this.disposed) return;
    this.cancelReplay(); this.phys.stop();
    this.rollId = rollId; this.label.set(label);
    this.state = 'armed'; this.stateT = 0; this.ptrId = -1; this.hideScale = 1; this.liftK = 0;
    this.hold.set(0, 0, 0); this.holdGoal.set(0, 0, 0);
    this.group.visible = true; this.label.sprite.visible = true; this.hint.sprite.visible = this.showHint;
    for (const m of this.meshes) { m.castShadow = false; m.scale.setScalar(1); }
    this.layoutArmed(0);
  }

  disarm(): void {
    if (this.state === 'idle' || this.state === 'hiding') return;
    this.cancelReplay(); this.phys.stop();
    this.ptrId = -1;
    this.label.sprite.visible = false; this.hint.sprite.visible = false;
    this.state = 'hiding'; this.stateT = 0;
  }

  // ---------------------------------------------------------------- gestures
  pointerDown(e: PointerEvent): boolean {
    if (this.state !== 'armed' || this.ptrId !== -1) return false;
    const rect = this.canvas.getBoundingClientRect();
    const px = this.screenRadius(rect);
    let hit = false;
    for (let i = 0; i < 2; i++) {
      _v.copy(this.armPos[i]!).project(this.camera);
      const x = rect.left + (_v.x + 1) / 2 * rect.width, y = rect.top + (1 - _v.y) / 2 * rect.height;
      if (Math.hypot(e.clientX - x, e.clientY - y) < px * 1.7) hit = true;
    }
    if (!hit) return false;
    this.ptrId = e.pointerId; this.n = 0;
    this.downX = e.clientX; this.downY = e.clientY; this.downT = stamp(e); this.maxTravel = 0;
    this.sample(e);
    this.state = 'held';
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic events */ }
    return true;
  }

  pointerMove(e: PointerEvent): boolean {
    if (this.state !== 'held' || e.pointerId !== this.ptrId) return false;
    this.sample(e);
    this.maxTravel = Math.max(this.maxTravel, Math.hypot(e.clientX - this.downX, e.clientY - this.downY));
    // dice follow the finger a little (screen px → world at the arming depth)
    const rect = this.canvas.getBoundingClientRect();
    const wpp = (2 * this.armDepth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / rect.height;
    const dx = (e.clientX - this.downX) * wpp * 0.45, dy = -(e.clientY - this.downY) * wpp * 0.45;
    const lim = DIE * 1.6, l = Math.hypot(dx, dy), k = l > lim ? lim / l : 1;
    this.holdGoal.set(dx * k, dy * k, 0);
    return true;
  }

  pointerUp(e: PointerEvent): boolean {
    if (this.state !== 'held' || e.pointerId !== this.ptrId) return false;
    this.sample(e);
    this.ptrId = -1;
    try { this.canvas.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (e.type === 'pointercancel') { this.state = 'armed'; this.holdGoal.set(0, 0, 0); return true; }
    const rect = this.canvas.getBoundingClientRect();
    // velocity over the last ~80 ms
    const last = (this.n - 1) % SAMPLES, tl = this.st[last]!;
    let first = last;
    for (let i = 1; i < Math.min(this.n, SAMPLES); i++) {
      const j = (this.n - 1 - i) % SAMPLES;
      first = j;
      if (tl - this.st[j]! >= VEL_WINDOW) break;
    }
    const dt = Math.max(16, tl - this.st[first]!) / 1000;
    const vx = (this.sx[last]! - this.sx[first]!) / dt, vy = (this.sy[last]! - this.sy[first]!) / dt;
    const speed = Math.hypot(vx, vy) / Math.max(1, rect.height);     // screen heights per second
    const tap = this.maxTravel < TAP_PX && tl - this.downT < TAP_MS * 2;
    let input: FlickInput;
    if (tap || speed < 0.35) input = { power: 0.45, side: (Math.random() - 0.5) * 0.3 }; // tap / no flick: medium throw
    else {
      const upward = Math.max(1e-3, -vy);
      input = {
        power: Math.max(0.05, Math.min(1, (speed - 0.5) / 3.2)),
        side: vy < 0 ? vx / upward : Math.sign(vx) * 0.5,             // down-swipes become a weak forward throw
      };
      if (vy >= 0) input.power = Math.min(input.power, 0.2);
    }
    this.throwDice(input);
    return true;
  }

  /** Throw with explicit input (also used by the tap fallback and demos). */
  throwDice(input: FlickInput): void {
    if (!this.armed) return;
    this.camBasis();
    // ground directions away from the camera
    const fx = _f.x, fz = _f.z, fl = Math.hypot(fx, fz) || 1;
    const fwd = { x: fx / fl, z: fz / fl }, right = { x: -fwd.z, z: fwd.x };
    const starts = this.meshes.map((m) => ({ x: m.position.x, y: m.position.y, z: m.position.z })) as [V3, V3];
    const quats = this.meshes.map((m) => ({ x: m.quaternion.x, y: m.quaternion.y, z: m.quaternion.z, w: m.quaternion.w })) as [Q4, Q4];
    this.phys.launch(planThrow(this.phys.table, starts, quats, fwd, right, input));
    this.state = 'sim'; this.stateT = 0;
    this.label.sprite.visible = false; this.hint.sprite.visible = false;
    for (const m of this.meshes) m.castShadow = true;
    if (this.showHint) { this.showHint = false; markHintSeen(); }
  }

  private sample(e: PointerEvent): void {
    const i = this.n % SAMPLES;
    this.sx[i] = e.clientX; this.sy[i] = e.clientY; this.st[i] = stamp(e); this.n++;
  }

  // ---------------------------------------------------------------- frame
  update(dt: number): boolean {
    if (this.disposed) return false;
    this.t += dt; this.stateT += dt;
    switch (this.state) {
      case 'idle': return false;
      case 'armed': case 'held': this.layoutArmed(dt); return true;
      case 'sim': {
        const running = this.phys.advance(dt);
        this.syncFromPhysics();
        if (!running) {
          const t: DiceThrow = { rollId: this.rollId, values: [...this.phys.values] as [number, number], land: this.phys.land, frames: this.phys.frames() };
          this.state = 'shown'; this.stateT = 0;
          this.onThrown?.(t);
        }
        return true;
      }
      case 'replay': {
        const r = this.rep!;
        this.repT += dt;
        const ft = this.repT * r.fps, f0 = Math.min(r.nFrames - 1, Math.floor(ft)), f1 = Math.min(r.nFrames - 1, f0 + 1), u = Math.min(1, ft - f0);
        for (let i = 0; i < Math.min(2, r.nDice); i++) {
          const a = (f0 * r.nDice + i) * STRIDE, b = (f1 * r.nDice + i) * STRIDE, m = this.meshes[i]!, d = r.data;
          m.position.set(d[a]! + (d[b]! - d[a]!) * u, d[a + 1]! + (d[b + 1]! - d[a + 1]!) * u, d[a + 2]! + (d[b + 2]! - d[a + 2]!) * u);
          _q.set(d[a + 3]!, d[a + 4]!, d[a + 5]!, d[a + 6]!); _q2.set(d[b + 3]!, d[b + 4]!, d[b + 5]!, d[b + 6]!);
          m.quaternion.slerpQuaternions(_q, _q2, u);
        }
        if (ft >= r.nFrames - 1) {
          this.state = 'shown'; this.stateT = 0; this.rep = null;
          const done = this.repDone; this.repDone = null; done?.();
        }
        return true;
      }
      case 'shown':
        if (this.stateT > SHOW_FOR) { this.state = 'hiding'; this.stateT = 0; return true; }
        return false;
      case 'hiding': {
        const f = 1 - this.stateT / HIDE_DUR, k = Math.max(0.0001, f * f);
        for (const m of this.meshes) { m.scale.setScalar(k); if (m.position.y < DIE) m.position.y = DIE / 2 * k; }
        if (f <= 0) { this.state = 'idle'; this.group.visible = false; for (const m of this.meshes) m.scale.setScalar(1); this.phys.stop(); }
        return true;
      }
    }
  }

  private syncFromPhysics(): void {
    for (let i = 0; i < 2; i++) {
      const b = this.phys.bodies[i]!, m = this.meshes[i]!;
      m.position.set(b.position.x, b.position.y, b.position.z);
      m.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    }
  }

  private camBasis(): void {
    this.camera.updateMatrixWorld();
    _r.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    _u.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    _f.setFromMatrixColumn(this.camera.matrixWorld, 2).normalize().negate();
  }

  private screenRadius(rect: DOMRect): number {
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return Math.max(44, (DIE / (2 * this.armDepth * tanH)) * rect.height);
  }

  /** Dice float at the bottom of the view, sized to read on a narrow phone, bobbing; follow the finger while held. */
  private layoutArmed(dt: number): void {
    this.camBasis();
    const cam = this.camera, tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2), asp = Math.max(0.3, cam.aspect);
    const dW = (DIE * 2.6) / (tanH * asp);         // pair spans about half the screen width
    const dH = DIE / (0.22 * tanH);                // each die at most ~11% of the screen height
    const D = this.armDepth = Math.max(dW, dH, cam.near * 4);
    const held = this.state === 'held';
    const s = 1 - Math.exp(-dt * 18);
    this.hold.lerp(held ? this.holdGoal : _v.set(0, 0, 0), dt > 0 ? s : 1);
    this.liftK += ((held ? 1 : 0) - this.liftK) * (dt > 0 ? s : 1);
    const bob = Math.sin(this.t * 2.4) * DIE * 0.08 * (1 - this.liftK);
    // centre of the pair
    _v2.copy(cam.position).addScaledVector(_f, D - this.liftK * DIE * 0.9)
      .addScaledVector(_u, this.armY * tanH * D + bob + this.liftK * DIE * 0.35 + this.hold.y)
      .addScaledVector(_r, this.hold.x);
    for (let i = 0; i < 2; i++) {
      const m = this.meshes[i]!, sgn = i === 0 ? -1 : 1;
      this.armPos[i]!.copy(_v2).addScaledVector(_r, sgn * DIE * 0.68).addScaledVector(_u, Math.sin(this.t * 2.4 + i * 1.7) * DIE * 0.04);
      m.position.copy(this.armPos[i]!);
      // face the camera at a jaunty angle, slow wobble; shake a little while held
      const wob = Math.sin(this.t * 1.3 + i * 2) * 0.12 + (held ? Math.sin(this.t * 31 + i) * 0.06 : 0);
      _q.setFromEuler(_e.set(wob, wob * 0.7 + this.t * 0.25 * sgn, 0));
      m.quaternion.copy(cam.quaternion).multiply(this.armQ[i]!).multiply(_q);
    }
    // label just below the dice, hint arrow rising above them
    const lw = DIE * 3.3;
    this.label.sprite.position.copy(_v2).addScaledVector(_u, -DIE * 1.18);
    this.label.sprite.scale.set(lw, lw * (112 / 512), 1);
    if (this.hint.sprite.visible) {
      const ph = (this.t * 0.9) % 1;
      this.hint.sprite.position.copy(_v2).addScaledVector(_u, DIE * (1.05 + ph * 0.7));
      this.hint.sprite.scale.set(DIE * 0.75, DIE * 1.125, 1);
      this.hint.mat.opacity = held ? 0.25 : 0.3 + Math.sin(ph * Math.PI) * 0.65;
    }
  }

  // ---------------------------------------------------------------- replay
  replay(t: DiceThrow): Promise<void> {
    if (this.disposed) return Promise.resolve();
    let r: Unpacked;
    try { r = unpackFrames(t.frames); } catch { return Promise.resolve(); }
    this.cancelReplay(); this.phys.stop();
    this.rollId = t.rollId; this.rep = r; this.repT = 0;
    this.state = 'replay'; this.stateT = 0; this.ptrId = -1;
    this.group.visible = true; this.label.sprite.visible = false; this.hint.sprite.visible = false;
    for (const m of this.meshes) { m.castShadow = true; m.scale.setScalar(1); }
    return new Promise((res) => { this.repDone = res; this.update(0); });
  }

  private cancelReplay(): void {
    this.rep = null;
    const d = this.repDone; this.repDone = null; d?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelReplay();
    this.disposed = true;
    this.scene.remove(this.group);
    this.phys.dispose();
    this.geo.dispose(); this.ink.dispose(); this.grad.dispose();
    for (const mats of this.mats) for (const m of mats) { (m as THREE.MeshToonMaterial).map?.dispose(); m.dispose(); }
    // materials/hulls added by a toon callback belong to the caller's shared caches
    this.label.dispose(); this.hint.dispose();
  }
}

function stamp(e: PointerEvent): number { return e.timeStamp > 0 ? e.timeStamp : performance.now(); }
