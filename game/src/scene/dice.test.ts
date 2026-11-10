import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { DIE, DicePhysics, FACE_VALUES, faceNormal, packFrames, planThrow, unpackFrames, upFace } from './dice';

const UP = new THREE.Vector3(0, 1, 0);

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

describe('face detection', () => {
  test('each face pointing up reads its value, at any yaw', () => {
    for (const v of FACE_VALUES) {
      const n = new THREE.Vector3(...faceNormal(v));
      for (const yaw of [0, 0.7, 2.1, -2.9]) {
        const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw).multiply(new THREE.Quaternion().setFromUnitVectors(n, UP));
        const r = upFace(q);
        expect(r.value).toBe(v);
        expect(r.tilt).toBeLessThan(1e-3);
      }
    }
  });
  test('opposite faces sum to 7 and tilt is measured', () => {
    for (const v of FACE_VALUES) {
      const n = new THREE.Vector3(...faceNormal(v)).negate();
      const opp = FACE_VALUES.find((u) => new THREE.Vector3(...faceNormal(u)).equals(n))!;
      expect(v + opp).toBe(7);
    }
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(30));
    const r = upFace(q);
    expect(r.value).toBe(1);
    expect(THREE.MathUtils.radToDeg(r.tilt)).toBeCloseTo(30, 3);
  });
});

describe('frame packing', () => {
  test('round trip within quantisation, sign flips stay compact', () => {
    const rnd = seeded(7), n = 40, raw = new Float32Array(n * 2 * 7);
    const q = new THREE.Quaternion();
    for (let f = 0; f < n; f++) for (let d = 0; d < 2; d++) {
      const o = (f * 2 + d) * 7;
      raw[o] = rnd() * 8 - 4; raw[o + 1] = rnd() * 3; raw[o + 2] = rnd() * 8 - 4;
      q.setFromEuler(new THREE.Euler(f * 0.3 + d, f * 0.2, f * 0.1));
      const s = f % 3 === 0 ? -1 : 1;                    // equivalent quaternion with flipped sign
      raw[o + 3] = q.x * s; raw[o + 4] = q.y * s; raw[o + 5] = q.z * s; raw[o + 6] = q.w * s;
    }
    const packed = packFrames(raw, n);
    expect(packed.every(Number.isInteger)).toBe(true);
    const u = unpackFrames(packed);
    expect(u.nFrames).toBe(n); expect(u.nDice).toBe(2); expect(u.fps).toBe(30);
    for (let i = 0; i < n * 2; i++) {
      const o = i * 7;
      for (let k = 0; k < 3; k++) expect(Math.abs(u.data[o + k]! - raw[o + k]!)).toBeLessThanOrEqual(0.0051);
      const a = new THREE.Quaternion(raw[o + 3], raw[o + 4], raw[o + 5], raw[o + 6]);
      const b = new THREE.Quaternion(u.data[o + 3], u.data[o + 4], u.data[o + 5], u.data[o + 6]);
      expect(THREE.MathUtils.radToDeg(a.angleTo(b))).toBeLessThan(0.3);
    }
  });
  test('rejects malformed input', () => {
    expect(() => unpackFrames([2, 30, 2, 1])).toThrow();
    expect(() => unpackFrames([1, 30, 2, 2, 0, 0])).toThrow();
  });
});

describe('physics (headless cannon-es)', () => {
  const table = { w: 8, d: 8 };
  const obstacles = [{ x: -1.5, z: 0.5, r: 0.5 }, { x: 1.8, z: -1.2, r: 0.7 }, { x: 0.3, z: 2.2, r: 0.4 }];
  test('20 random throws settle flat on the table within 3 s with values 1–6 and compact frames', () => {
    const phys = new DicePhysics();
    phys.setTable(table, obstacles);
    const rnd = seeded(42);
    const times: number[] = [], sizes: number[] = [];
    for (let k = 0; k < 20; k++) {
      // thrower in front of the table, high up like the camera's bottom edge
      const cx = (rnd() - 0.5) * 3, y = 9 + rnd() * 5, z = 6 + rnd() * 4;
      const starts = [{ x: cx - DIE * 0.68, y, z }, { x: cx + DIE * 0.68, y, z }] as const;
      const qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6, rnd() * 6, rnd() * 6));
      const qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6, rnd() * 6, rnd() * 6));
      const yaw = (rnd() - 0.5) * 0.6, fwd = { x: Math.sin(yaw), z: -Math.cos(yaw) }, right = { x: -fwd.z, z: fwd.x };
      const input = { power: rnd(), side: (rnd() - 0.5) * 1.6 };
      phys.launch(planThrow({ ...table, obstacles }, starts, [qa, qb], fwd, right, input, rnd));
      phys.runToEnd(4);
      expect(phys.phase).toBe('done');
      expect(phys.time).toBeLessThanOrEqual(3);
      times.push(phys.time);
      for (let i = 0; i < 2; i++) {
        const b = phys.bodies[i]!;
        expect(Math.abs(b.position.x)).toBeLessThanOrEqual(table.w / 2);
        expect(Math.abs(b.position.z)).toBeLessThanOrEqual(table.d / 2);
        expect(b.position.y).toBeCloseTo(DIE / 2, 3);
        const f = upFace(b.quaternion);
        expect(f.value).toBe(phys.values[i]!);
        expect(f.tilt).toBeLessThan(0.01);
        for (const o of obstacles) expect(Math.hypot(b.position.x - o.x, b.position.z - o.z)).toBeGreaterThanOrEqual(o.r + DIE * 0.5 - 1e-3);
      }
      const [a, b] = phys.bodies;
      expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThanOrEqual(DIE * 0.99);
      for (const v of phys.values) { expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(6); }
      const frames = phys.frames(), json = JSON.stringify(frames);
      sizes.push(json.length);
      expect(json.length).toBeLessThan(6000);
      // the replay ends exactly on the settled pose
      const u = unpackFrames(frames), last = (u.nFrames - 1) * 2 * 7;
      expect(u.data[last]!).toBeCloseTo(a.position.x, 1);
      expect(upFace({ x: u.data[last + 3]!, y: u.data[last + 4]!, z: u.data[last + 5]!, w: u.data[last + 6]! }).value).toBe(phys.values[0]);
    }
    console.log(`settle s: max ${Math.max(...times).toFixed(2)} avg ${(times.reduce((a, b) => a + b) / times.length).toFixed(2)}; ` +
      `frames JSON bytes: max ${Math.max(...sizes)} avg ${Math.round(sizes.reduce((a, b) => a + b) / sizes.length)}`);
    phys.dispose();
  });
});
