// Table camera: perspective, angled, framed on the table inside the screen insets. No input of its own — the scene's
// gesture code calls pan / rotate / zoom. Adds glide (focus, called cameras) and a gentle follow.
import * as THREE from 'three';

const PITCH = THREE.MathUtils.degToRad(54), PITCH_MIN = THREE.MathUtils.degToRad(32), PITCH_MAX = THREE.MathUtils.degToRad(84);
const FOLLOW_QUIET_MS = 3000;

interface View { target: THREE.Vector3; yaw: number; pitch: number; dist: number }

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ray = new THREE.Raycaster();

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  private cur: View = { target: new THREE.Vector3(), yaw: 0, pitch: PITCH, dist: 14 };
  private goal: View = { target: new THREE.Vector3(), yaw: 0, pitch: PITCH, dist: 14 };
  private home: View = { target: new THREE.Vector3(), yaw: 0, pitch: PITCH, dist: 14 };
  private tw = 8; private td = 8;
  private inset = { top: 0, bottom: 0 }; private size = { w: 1, h: 1 };
  /** user changed the view since the last reset */
  moved = false;
  /** performance.now() of the last user camera gesture */
  lastUser = -1e9;
  /** how much of the whole-table fit the default view uses (<1 = closer) */
  homeZoom = 1;

  constructor(private el: HTMLCanvasElement) {}

  setTable(w: number, d: number): void { this.tw = w; this.td = d; this.computeHome(); this.reset(true); }

  setInsets(top: number, bottom: number): void {
    if (Math.abs(top - this.inset.top) < 2 && Math.abs(bottom - this.inset.bottom) < 2) return;
    this.inset = { top: Math.max(0, top), bottom: Math.max(0, bottom) };
    this.resize(this.size.w, this.size.h);
  }
  private visibleH(h: number): number { return Math.max(h * 0.3, h - this.inset.top - this.inset.bottom); }

  resize(w: number, h: number): void {
    this.size = { w, h };
    const hv = this.visibleH(h);
    this.camera.aspect = w / Math.max(1, hv);
    this.camera.setViewOffset(w, hv, 0, -this.inset.top, w, h);
    this.camera.updateProjectionMatrix();
    const before = this.home.dist;
    this.computeHome();
    if (!this.moved) this.reset(true);
    else { const k = this.home.dist / before; this.goal.dist *= k; this.cur.dist *= k; this.clamp(); }
  }

  private apply(cam: THREE.PerspectiveCamera, v: View): void {
    const c = Math.cos(v.pitch);
    cam.position.set(v.target.x + Math.sin(v.yaw) * c * v.dist, v.target.y + Math.sin(v.pitch) * v.dist, v.target.z + Math.cos(v.yaw) * c * v.dist);
    cam.lookAt(v.target);
    cam.updateMatrixWorld(true);
  }

  /** Fit the whole table (plus a little rim) into the visible strip. */
  private computeHome(): void {
    const cam = this.camera.clone();
    cam.clearViewOffset(); cam.aspect = this.size.w / Math.max(1, this.visibleH(this.size.h)); cam.updateProjectionMatrix();
    const hw = this.tw / 2 + 0.15, hh = this.td / 2 + 0.15;
    const pts = [[-hw, 0, -hh], [hw, 0, -hh], [-hw, 0, hh], [hw, 0, hh], [-hw, 1.2, -hh], [hw, 1.2, -hh], [-hw, 0.5, hh], [hw, 0.5, hh]];
    const v: View = { target: new THREE.Vector3(0, 0.2, 0), yaw: 0, pitch: PITCH, dist: 10 };
    const fitX = 0.98, fitY = 0.9;
    const fits = (d: number) => {
      v.dist = d; this.apply(cam, v);
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const p of pts) { v1.set(p[0]!, p[1]!, p[2]!).project(cam); x0 = Math.min(x0, v1.x); x1 = Math.max(x1, v1.x); y0 = Math.min(y0, v1.y); y1 = Math.max(y1, v1.y); }
      return { ok: x1 - x0 <= 2 * fitX && y1 - y0 <= 2 * fitY, cy: (y0 + y1) / 2 };
    };
    const search = () => { let lo = 1, hi = 150; for (let i = 0; i < 28; i++) { const m = (lo + hi) / 2; if (fits(m).ok) hi = m; else lo = m; } return hi; };
    for (let pass = 0; pass < 3; pass++) {
      const d = search();
      const { cy } = fits(d);
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
      v.target.z -= cy * d * tanHalf / Math.sin(PITCH);
    }
    v.dist = search();
    this.fitDist = v.dist;
    this.home.target.copy(v.target); this.home.yaw = 0; this.home.pitch = PITCH; this.home.dist = v.dist * this.homeZoom;
    // a closer home view looks at the heroes (or the middle of the table)
    if (this.homeZoom < 1) {
      const f = this.homeFocus ?? { x: 0, z: 0 };
      v.target.set(THREE.MathUtils.clamp(f.x, -this.tw / 2 + 1, this.tw / 2 - 1), 0.2, THREE.MathUtils.clamp(f.z, -this.td / 2 + 1, this.td / 2 - 1));
      v.dist = this.home.dist;
      // don't waste the bottom of the screen on the floor in front of the table: slide back until the front rim
      // reaches the bottom edge
      for (let i = 0; i < 80; i++) {
        this.apply(cam, v);
        const front = v1.set(v.target.x, 0, this.td / 2 + 0.3).project(cam).y;
        if (front <= -0.97) break;
        v.target.z -= 0.1;
      }
      this.home.target.copy(v.target);
    }
  }
  private homeFocus: { x: number; z: number } | null = null;
  /** Where the (zoomed-in) default view looks; reset() goes there. */
  setHomeFocus(p: { x: number; z: number } | null): void { this.homeFocus = p; this.computeHome(); }
  private fitDist = 14;

  reset(instant = false): void {
    this.goal.target.copy(this.home.target); this.goal.yaw = this.home.yaw; this.goal.pitch = this.home.pitch; this.goal.dist = this.home.dist;
    if (instant) { this.cur.target.copy(this.goal.target); this.cur.yaw = this.goal.yaw; this.cur.pitch = this.goal.pitch; this.cur.dist = this.goal.dist; }
    this.moved = false;
  }

  /** Glide to look at a point, zooming in a little if far out. */
  focus(p: { x: number; z: number }, zoom = true): void {
    this.goal.target.set(p.x, 0.2, p.z);
    if (zoom) this.goal.dist = Math.min(this.goal.dist, Math.max(4.5, this.fitDist * 0.55));
    this.moved = true; this.clamp();
  }

  /** Called while the followed mini walks: ease it back into the middle of the view if it drifts out. */
  follow(p: THREE.Vector3, dt: number, now: number): boolean {
    if (now - this.lastUser < FOLLOW_QUIET_MS) return false;
    v1.copy(p).project(this.camera);
    const out = Math.max(Math.abs(v1.x) - 0.45, Math.abs(v1.y) - 0.4, 0);
    if (out <= 0 && !this.following) return false;
    this.following = out > 0 || this.following && Math.max(Math.abs(v1.x), Math.abs(v1.y)) > 0.25;
    if (!this.following) return false;
    v2.set(p.x, this.goal.target.y, p.z);
    this.goal.target.lerp(v2, 1 - Math.exp(-dt * 1.6));
    this.clamp();
    return true;
  }
  private following = false;

  get zoomedIn(): boolean { return this.goal.dist < this.home.dist * 0.85 || this.goal.target.distanceTo(this.home.target) > 1 || Math.abs(this.goal.yaw) > 0.05; }
  get distance(): number { return this.cur.dist; }
  get lookAt(): THREE.Vector3 { return this.cur.target; }

  private clamp(): void {
    for (const v of [this.goal, this.cur]) {
      v.target.x = THREE.MathUtils.clamp(v.target.x, -this.tw / 2, this.tw / 2);
      v.target.z = THREE.MathUtils.clamp(v.target.z, -this.td / 2, this.td / 2);
      v.dist = THREE.MathUtils.clamp(v.dist, 2.6, Math.max(6, this.fitDist * 1.35));
      v.pitch = THREE.MathUtils.clamp(v.pitch, PITCH_MIN, PITCH_MAX);
    }
  }

  /** Damp toward the goal; returns true while still moving. */
  update(dt: number): boolean {
    const k = 1 - Math.exp(-dt * 8);
    const c = this.cur, g = this.goal;
    const moving = c.target.distanceToSquared(g.target) > 1e-6 || Math.abs(c.yaw - g.yaw) > 1e-4 || Math.abs(c.dist - g.dist) > 1e-3 || Math.abs(c.pitch - g.pitch) > 1e-4;
    if (moving) { c.target.lerp(g.target, k); c.yaw += (g.yaw - c.yaw) * k; c.pitch += (g.pitch - c.pitch) * k; c.dist += (g.dist - c.dist) * k; }
    this.apply(this.camera, c);
    return moving;
  }

  // ---------------------------------------------------------------- gestures (client coords)
  ground(x: number, y: number, out: THREE.Vector3): boolean {
    const r = this.el.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, this.camera);
    return !!ray.ray.intersectPlane(plane, out);
  }
  private touched(): void { this.moved = true; this.lastUser = performance.now(); this.following = false; }

  pan(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.ground(x0, y0, v1) || !this.ground(x1, y1, v2)) return;
    v1.sub(v2); v1.y = 0;
    if (v1.lengthSq() > 4) v1.setLength(2); // grazing angles
    this.goal.target.add(v1); this.cur.target.add(v1);
    this.touched(); this.clamp();
  }
  rotate(dyaw: number, dpitch: number): void { this.goal.yaw += dyaw; this.goal.pitch += dpitch; this.touched(); this.clamp(); }
  twist(dyaw: number): void { this.goal.yaw += dyaw; this.cur.yaw = this.goal.yaw; this.touched(); this.clamp(); }
  zoom(k: number, instant = false): void { this.goal.dist *= k; if (instant) this.cur.dist = this.goal.dist; this.touched(); this.clamp(); }
}
