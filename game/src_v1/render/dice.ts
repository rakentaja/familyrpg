// Two big inked dice that tumble onto the table in front of the camera and settle on the requested faces.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { gradient } from './style';

// BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z  (opposite faces sum to 7)
const FACE_VALUES = [3, 4, 1, 6, 2, 5];
const NORMALS: Record<number, THREE.Vector3> = {
  3: new THREE.Vector3(1, 0, 0), 4: new THREE.Vector3(-1, 0, 0), 1: new THREE.Vector3(0, 1, 0),
  6: new THREE.Vector3(0, -1, 0), 2: new THREE.Vector3(0, 0, 1), 5: new THREE.Vector3(0, 0, -1),
};
const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]], 2: [[0.27, 0.27], [0.73, 0.73]], 3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
  6: [[0.27, 0.24], [0.73, 0.24], [0.27, 0.5], [0.73, 0.5], [0.27, 0.76], [0.73, 0.76]],
};
const UP = new THREE.Vector3(0, 1, 0);
const DUR = 1.15, HOLD = 1.3, FADE = 0.35;

function faceTexture(v: number): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f7f1e4'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = v === 1 ? '#8a4a4e' : '#2a2328';
  for (const [x, y] of PIPS[v]!) { g.beginPath(); g.arc(x * 128, y * 128, v === 1 ? 17 : 12.5, 0, Math.PI * 2); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

interface Die { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; qFinal: THREE.Quaternion; axis: THREE.Vector3; spin: number; delay: number }
const qa = new THREE.Quaternion(), qy = new THREE.Quaternion();

export class Dice {
  readonly group = new THREE.Group();
  private geo: RoundedBoxGeometry | null = null;
  private mats: THREE.MeshToonMaterial[] = [];
  private ink: THREE.MeshBasicMaterial | null = null;
  private dice: Die[] = [];
  private t = -1; private size = 0.6;
  private resolve: (() => void) | null = null;

  private build(): void {
    this.geo = new RoundedBoxGeometry(1, 1, 1, 3, 0.14);
    this.mats = FACE_VALUES.map((v) => {
      return new THREE.MeshToonMaterial({ map: faceTexture(v), gradientMap: gradient });
    });
    this.ink = new THREE.MeshBasicMaterial({ color: 0x2a2328, side: THREE.BackSide });
    this.ink.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n transformed += normalize(normal) * 0.045;');
    };
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mats); mesh.castShadow = true; mesh.renderOrder = 8;
      const line = new THREE.Mesh(this.geo, this.ink); line.renderOrder = 7; line.raycast = () => {};
      mesh.add(line);
      this.group.add(mesh);
      this.dice.push({ mesh, from: new THREE.Vector3(), to: new THREE.Vector3(), qFinal: new THREE.Quaternion(), axis: new THREE.Vector3(), spin: 0, delay: 0 });
    }
    this.group.visible = false;
  }

  /** Throw toward `centre` (ground point), from the camera side. */
  roll(values: [number, number], camera: THREE.Camera, centre: THREE.Vector3, camDist: number): Promise<void> {
    if (!this.geo) this.build();
    this.resolve?.();
    this.size = THREE.MathUtils.clamp(camDist * 0.055, 0.45, 1.3);
    const toCam = new THREE.Vector3().subVectors(camera.position, centre).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(UP, toCam).normalize();
    const c = centre.clone().addScaledVector(toCam, camDist * 0.12);
    values.forEach((raw, i) => {
      const v = THREE.MathUtils.clamp(Math.round(raw) || 1, 1, 6);
      const d = this.dice[i]!;
      d.to.copy(c).addScaledVector(right, (i === 0 ? -0.75 : 0.75) * this.size).addScaledVector(toCam, (Math.random() - 0.5) * 0.4 * this.size);
      d.to.y = this.size / 2;
      d.from.copy(d.to).addScaledVector(toCam, 3.2 * this.size).addScaledVector(right, (i === 0 ? -1 : 1) * 0.8 * this.size);
      d.from.y = this.size * 3.2;
      qa.setFromUnitVectors(NORMALS[v]!, UP);
      qy.setFromAxisAngle(UP, Math.random() * Math.PI * 2);
      d.qFinal.copy(qy).multiply(qa);
      d.axis.set(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5).add(right.clone().multiplyScalar(i ? 1 : -1)).normalize();
      d.spin = Math.PI * (4 + Math.random() * 2);
      d.delay = i * 0.08;
      d.mesh.scale.setScalar(this.size);
    });
    this.t = 0; this.group.visible = true;
    this.update(0);
    return new Promise((r) => { this.resolve = r; });
  }

  get busy(): boolean { return this.t >= 0; }

  update(dt: number): void {
    if (this.t < 0) return;
    this.t += dt;
    for (const d of this.dice) {
      const u = THREE.MathUtils.clamp((this.t - d.delay) / DUR, 0, 1);
      const e = 1 - (1 - u) ** 3;
      d.mesh.position.lerpVectors(d.from, d.to, e);
      const bounce = (1 - u) ** 2 * Math.abs(Math.cos(u * Math.PI * 2.5));
      d.mesh.position.y = d.to.y + (d.from.y - d.to.y) * bounce;
      qa.setFromAxisAngle(d.axis, d.spin * (1 - e));
      d.mesh.quaternion.copy(qa).multiply(d.qFinal);
    }
    const settle = DUR + 0.08;
    if (this.t >= settle && this.resolve) { const r = this.resolve; this.resolve = null; r(); }
    if (this.t > settle + HOLD) {
      // shrink away (a transparent fade would show the inner hull)
      const f = 1 - (this.t - settle - HOLD) / FADE;
      const k = Math.max(0.0001, f * f) * this.size;
      for (const d of this.dice) { d.mesh.scale.setScalar(k); d.mesh.position.y = k / 2; }
      if (f <= 0) { this.t = -1; this.group.visible = false; }
    }
  }

  dispose(): void {
    this.resolve?.(); this.resolve = null;
    this.geo?.dispose(); this.ink?.dispose();
    for (const m of this.mats) { m.map?.dispose(); m.dispose(); }
  }
}
