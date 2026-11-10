// Table camera: angled top-down view fitted to the board. Touch: 1-finger pan, pinch zoom, two-finger twist
// rotates around the board centre, double-tap focus/reset. Mouse: drag pan, right/ctrl-drag rotate, wheel zoom.
import * as THREE from 'three';

const TAP_PX = 8, TAP_MS = 300, DOUBLE_MS = 320, DOUBLE_PX = 36;
const PITCH = THREE.MathUtils.degToRad(60), PITCH_MIN = THREE.MathUtils.degToRad(30), PITCH_MAX = THREE.MathUtils.degToRad(82);

interface Ptr { id: number; x: number; y: number; sx: number; sy: number; t0: number; button: number; ctrl: boolean; mouse: boolean }
interface View { target: THREE.Vector3; yaw: number; pitch: number; dist: number }

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ray = new THREE.Raycaster();

export interface CameraHooks {
  tap(x: number, y: number): void;          // client coords
  doubleTap(x: number, y: number): void;
  interact(): void;                         // something moved: render
}

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  private cur: View = { target: new THREE.Vector3(), yaw: 0, pitch: PITCH, dist: 14 };
  private goal: View = { target: new THREE.Vector3(), yaw: 0, pitch: PITCH, dist: 14 };
  private home: View = { target: new THREE.Vector3(), yaw: 0, pitch: PITCH, dist: 14 };
  private bw = 8; private bh = 8;
  private ptrs = new Map<number, Ptr>();
  private gesture: 'none' | 'tap' | 'pan' | 'rotate' | 'pinch' = 'none';
  private pinch = { span: 1, angle: 0, mx: 0, my: 0 };
  private lastTap = { t: 0, x: 0, y: 0 };
  moved = false;            // user changed the view since the last reset
  private listeners: [string, EventListener, AddEventListenerOptions?][] = [];

  constructor(private el: HTMLCanvasElement, private hooks: CameraHooks) {
    el.style.touchAction = 'none';
    (el.style as unknown as Record<string, string>).webkitUserSelect = 'none';
    el.style.userSelect = 'none';
    const on = (n: string, f: (e: never) => void, o?: AddEventListenerOptions) => { el.addEventListener(n, f as EventListener, o); this.listeners.push([n, f as EventListener, o]); };
    on('pointerdown', (e: PointerEvent) => this.down(e));
    on('pointermove', (e: PointerEvent) => this.move(e));
    on('pointerup', (e: PointerEvent) => this.up(e, false));
    on('pointercancel', (e: PointerEvent) => this.up(e, true));
    on('lostpointercapture', (e: PointerEvent) => { if (this.ptrs.has(e.pointerId)) this.up(e, true); });
    on('wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    on('contextmenu', (e: Event) => e.preventDefault());
    on('gesturestart', (e: Event) => e.preventDefault()); // iOS Safari page zoom
  }

  // ---------------------------------------------------------------- fitting
  setBoard(w: number, h: number): void { this.bw = w; this.bh = h; this.computeHome(); this.reset(true); }

  // Screen areas covered by UI (top bar, bottom sheet), in CSS px: the board is framed in what's left.
  private inset = { top: 0, bottom: 0 }; private size = { w: 1, h: 1 };
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
    // virtual frame = the visible strip; the canvas window extends above/below it
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

  private computeHome(): void {
    const cam = this.camera.clone();
    cam.clearViewOffset(); cam.aspect = this.size.w / Math.max(1, this.visibleH(this.size.h)); cam.updateProjectionMatrix();
    const hw = this.bw / 2 + 0.2, hh = this.bh / 2 + 0.2;
    const pts = [[-hw, 0, -hh], [hw, 0, -hh], [-hw, 0, hh], [hw, 0, hh], [-hw, 1.4, -hh], [hw, 1.4, -hh], [-hw, 0.6, hh], [hw, 0.6, hh]];
    const v: View = { target: new THREE.Vector3(0, 0.3, 0), yaw: 0, pitch: PITCH, dist: 10 };
    const fitX = 0.94, fitY = 0.8;
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
    this.home.target.copy(v.target); this.home.yaw = 0; this.home.pitch = PITCH; this.home.dist = v.dist;
  }

  reset(instant = false): void {
    this.goal.target.copy(this.home.target); this.goal.yaw = this.home.yaw; this.goal.pitch = this.home.pitch; this.goal.dist = this.home.dist;
    if (instant) { this.cur.target.copy(this.goal.target); this.cur.yaw = this.goal.yaw; this.cur.pitch = this.goal.pitch; this.cur.dist = this.goal.dist; }
    this.moved = false;
    this.hooks.interact();
  }

  /** Smoothly look at a world point, zooming in a little. */
  focus(p: THREE.Vector3): void {
    this.goal.target.set(p.x, 0.3, p.z);
    this.goal.dist = Math.min(this.goal.dist, Math.max(5, this.home.dist * 0.55));
    this.moved = true; this.clamp(); this.hooks.interact();
  }

  get zoomedIn(): boolean { return this.goal.dist < this.home.dist * 0.85 || this.goal.target.distanceTo(this.home.target) > 1; }

  get distance(): number { return this.cur.dist; }
  /** Current look-at point on the table. */
  get lookAt(): THREE.Vector3 { return this.cur.target; }

  private clamp(): void {
    for (const v of [this.goal, this.cur]) {
      v.target.x = THREE.MathUtils.clamp(v.target.x, -this.bw / 2, this.bw / 2);
      v.target.z = THREE.MathUtils.clamp(v.target.z, -this.bh / 2, this.bh / 2);
      v.dist = THREE.MathUtils.clamp(v.dist, 3, Math.max(8, this.home.dist * 1.6));
      v.pitch = THREE.MathUtils.clamp(v.pitch, PITCH_MIN, PITCH_MAX);
    }
  }

  /** Damp toward the goal; returns true while still moving. */
  update(dt: number): boolean {
    const k = 1 - Math.exp(-dt * 9);
    const c = this.cur, g = this.goal;
    const moving = c.target.distanceToSquared(g.target) > 1e-6 || Math.abs(c.yaw - g.yaw) > 1e-4 || Math.abs(c.dist - g.dist) > 1e-3 || Math.abs(c.pitch - g.pitch) > 1e-4;
    if (moving) {
      c.target.lerp(g.target, k); c.yaw += (g.yaw - c.yaw) * k; c.pitch += (g.pitch - c.pitch) * k; c.dist += (g.dist - c.dist) * k;
    }
    this.apply(this.camera, c);
    return moving || this.ptrs.size > 0;
  }

  // ---------------------------------------------------------------- input
  private ground(x: number, y: number, out: THREE.Vector3): boolean {
    const r = this.el.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, this.camera);
    return !!ray.ray.intersectPlane(plane, out);
  }

  private pan(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.ground(x0, y0, v1) || !this.ground(x1, y1, v2)) return;
    v1.sub(v2); v1.y = 0;
    if (v1.lengthSq() > 4) v1.setLength(2); // grazing angles
    this.goal.target.add(v1); this.cur.target.add(v1);
    this.moved = true; this.clamp();
  }

  private down(e: PointerEvent): void {
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p: Ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now(),
      button: e.button, ctrl: e.ctrlKey || e.metaKey, mouse: e.pointerType === 'mouse' };
    this.ptrs.set(e.pointerId, p);
    if (this.ptrs.size === 1) this.gesture = 'tap';
    else if (this.ptrs.size === 2) { this.gesture = 'pinch'; this.startPinch(); }
    this.hooks.interact();
  }

  private startPinch(): void {
    const [a, b] = [...this.ptrs.values()] as [Ptr, Ptr];
    this.pinch.span = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
    this.pinch.angle = Math.atan2(b.y - a.y, b.x - a.x);
    this.pinch.mx = (a.x + b.x) / 2; this.pinch.my = (a.y + b.y) / 2;
  }

  private move(e: PointerEvent): void {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.gesture === 'tap') {
      if (Math.hypot(p.x - p.sx, p.y - p.sy) >= TAP_PX || performance.now() - p.t0 > TAP_MS) {
        this.gesture = p.mouse && (p.button === 2 || p.ctrl) ? 'rotate' : 'pan';
        if (this.gesture === 'pan') this.pan(p.sx, p.sy, p.x, p.y);
      }
    } else if (this.gesture === 'pan') this.pan(px, py, p.x, p.y);
    else if (this.gesture === 'rotate') {
      this.goal.yaw -= (p.x - px) * 0.008;
      this.goal.pitch += (p.y - py) * 0.005;
      this.moved = true; this.clamp();
    } else if (this.gesture === 'pinch' && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()] as [Ptr, Ptr];
      const span = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.pan(this.pinch.mx, this.pinch.my, mx, my);
      this.goal.dist *= this.pinch.span / span; this.cur.dist = this.goal.dist;
      let d = ang - this.pinch.angle; if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
      this.goal.yaw += d; this.cur.yaw = this.goal.yaw;
      this.pinch.span = span; this.pinch.angle = ang; this.pinch.mx = mx; this.pinch.my = my;
      this.moved = true; this.clamp();
    }
    this.hooks.interact();
  }

  private up(e: PointerEvent, cancel: boolean): void {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.gesture === 'tap' && !cancel && this.ptrs.size === 0 && (p.button === 0 || !p.mouse)
      && performance.now() - p.t0 <= TAP_MS && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < TAP_PX) {
      const now = performance.now();
      if (now - this.lastTap.t < DOUBLE_MS && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < DOUBLE_PX) {
        this.lastTap.t = 0; this.hooks.doubleTap(e.clientX, e.clientY);
      } else {
        this.lastTap = { t: now, x: e.clientX, y: e.clientY }; this.hooks.tap(e.clientX, e.clientY);
      }
    }
    if (this.ptrs.size === 1) {          // pinch → one finger keeps panning, never a tap
      const r = [...this.ptrs.values()][0]!; r.sx = r.x; r.sy = r.y; this.gesture = 'pan';
    } else if (this.ptrs.size === 0) this.gesture = 'none';
    this.hooks.interact();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const k = Math.exp(THREE.MathUtils.clamp(e.deltaY, -200, 200) * (e.ctrlKey ? 0.01 : 0.0015));
    this.goal.dist *= k; this.moved = true; this.clamp(); this.hooks.interact();
  }

  dispose(): void { for (const [n, f, o] of this.listeners) this.el.removeEventListener(n, f, o); this.listeners.length = 0; this.ptrs.clear(); }
}
