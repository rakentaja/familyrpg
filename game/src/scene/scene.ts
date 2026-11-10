// The v2 main screen: the 3D table IS the game. Builds the diorama from the pack scene, keeps the minis in step with
// the state (walking along fx paths, hops, clips), shows hearts over heroes and foes / bubbles / notes over the scene, the
// in-scene meters, the selection ring + path preview, and turns touches into tap / hold / drag / camera gestures.
import * as THREE from 'three';
import type { CreateScene, DiceThrow, LocalView, SceneCallbacks, SceneView } from '../contracts';
import type { FxEvent, GameState, Hit, P, Pack, PackScene, Token } from '../rules/types';
import { blockers, findPath, navFor } from '../rules/geom';
import { Assets } from './assets';
import { Actor, disposeActorShared, disposeFallbacks, gem, marker, pawn, WALK_SPEED, type Motion } from './actors';
import { CameraRig } from './camera';
import { DiceRig } from './dice';
import { FxLayer, type Anchor, type TextStyle } from './fx';
import { Meters, type MeterKind } from './meters';
import { Overlay } from './overlay';
import { addOutline, hatchUniforms, PALETTE, PaperOverlay, stylize, toonMaterial, toonMaterials } from './style';
import { Table } from './table';

const HOLD_MS = 450, RING_DELAY = 110, DOUBLE_MS = 320, DOUBLE_PX = 40;
const TAP_PX_TOUCH = 10, TAP_PX_MOUSE = 6;
const LOCK_MS = 4000;          // a locally dropped piece stays put this long while the state catches up
const DOT_STEP = 0.3, MAX_DOTS = 90;
const HOME_ZOOM = 0.6;         // default view: this fraction of the whole-table distance, looking at the heroes
const MINI_SCALE = 1.25;       // minis are a little larger than life so they read on a phone

type Key = string; // 'h:<id>' | 'f:<uid>' | 't:<uid>'
interface Ptr { id: number; x: number; y: number; px: number; py: number; sx: number; sy: number; t0: number; mouse: boolean; button: number; mod: boolean }
type Gesture = 'none' | 'press' | 'pan' | 'rotate' | 'pinch' | 'drag' | 'held';

// scratch
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _box = new THREE.Box3(), _ndc = new THREE.Vector2(), _m4 = new THREE.Matrix4();
const _ray = new THREE.Raycaster(), _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _col = new THREE.Color();

const midnightOf = (s: GameState, now: number): number => {
  const c = s.clock;
  if (!c || !c.totalMs) return Math.max(0, Math.min(12, c?.steps ?? 0));
  const ms = c.elapsedMs + (c.runningSince ? Math.max(0, now - c.runningSince) : 0);
  return Math.max(0, Math.min(12, (12 * ms) / c.totalMs + (c.steps ?? 0)));
};

function cardTexture(name: string): THREE.CanvasTexture {
  const W = 300, H = 420, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f6efe1'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#2a2328'; g.lineWidth = 7; g.strokeRect(14, 14, W - 28, H - 28);
  g.strokeStyle = '#8a4a4e'; g.lineWidth = 3; g.strokeRect(28, 28, W - 56, H - 56);
  // star
  g.save(); g.translate(W / 2, 130); g.beginPath();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 22 : 50, a = -Math.PI / 2 + (i * Math.PI) / 5; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath(); g.fillStyle = '#e8c77a'; g.fill(); g.lineWidth = 6; g.lineJoin = 'round'; g.strokeStyle = '#2a2328'; g.stroke(); g.restore();
  g.fillStyle = '#2a2328'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 34px Cinzel, "Trajan Pro", Georgia, serif';
  const words = name.toUpperCase().split(/\s+/); const lines: string[] = []; let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > W - 80 && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line);
  lines.slice(0, 4).forEach((l, i) => g.fillText(l, W / 2, 245 + i * 42, W - 70));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

class Scene3D implements SceneView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private rig: CameraRig;
  private sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
  private hemi = new THREE.HemisphereLight(0xf4efe6, 0xb4abc6, 1.15);
  private paper = new PaperOverlay(0.45);
  private assets = new Assets();
  private table = new Table();
  private meters = new Meters();
  private overlay: Overlay;
  private fx = new FxLayer();
  private dice: DiceRig | null = null;
  private diceBusy = false;
  private pack: Pack | null = null;
  private def: PackScene | null = null;
  private loaded = false;
  private pending: { s: GameState; p: GameState | null; fx: FxEvent[] } | null = null;

  private actorGroup = new THREE.Group();
  private actors = new Map<Key, Actor>();
  private list: Actor[] = [];
  private sceneKey = '';
  private state: GameState | null = null;
  private local: LocalView = { me: '', isGuide: false, selectedHeroId: null, myHeroIds: [] };
  private lastFxSeq = -1;
  private camSeq: number | null = null;
  private eventKey: string | null = null;
  private seenBubbles = new Set<string>();
  private locks = new Map<Key, { x: number; z: number; until: number }>();
  private previewKey: Key | null = null;
  private frozen = new Map<string, THREE.Object3D>();
  private wall: { obj: THREE.Group; boss: string; s: number; goal: number } | null = null;
  private shots: { obj: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number }[] = [];
  private card: { mesh: THREE.Mesh; t: number; from: THREE.Vector3; to: THREE.Vector3; rot: number; life: number } | null = null;
  private cardGeo = new THREE.BoxGeometry(0.72, 0.025, 1.0);
  private cardMats: THREE.Material[] = [];

  // selection ring + path preview
  private ring = new THREE.Group();
  private ringRange: THREE.Mesh; private ringFill: THREE.Mesh; private ringBase: THREE.Mesh;
  private ringR = 4;
  private dots: THREE.InstancedMesh;
  private dotEnd: THREE.Mesh;
  private previewTo: P | null = null; private previewDirty = false;

  // input
  private ptrs = new Map<number, Ptr>();
  private dicePtrs = new Set<number>();
  private gesture: Gesture = 'none';
  private pressHit: Hit | null = null;
  private pressActor: Actor | null = null;
  private holdTimer = 0; private ringTimer = 0;
  private dragActor: Actor | null = null; private dragHit: Hit | null = null; private dragAt: P = { x: 0, z: 0 };
  private dragProp: THREE.Object3D | null = null;   // the Guide moving a prop
  private dialing = new Set<string>();               // pieces being turned with a dial (state facing waits)
  private pinch = { span: 1, angle: 0, mx: 0, my: 0 };
  private lastTap = { t: 0, x: 0, y: 0, ground: false };
  private hover: { x: number; y: number } | null = null;

  private quality: 'low' | 'high' = 'high';
  private raf = 0; private last = 0; private lastRender = 0; private lastSecond = 0; private dirty = true;
  private lost = false; private disposed = false;
  private ro: ResizeObserver | null = null;
  private rect = { left: 0, top: 0, width: 1, height: 1 };
  private t = 0;
  private off: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, private cb: SceneCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(0xe6ddcd);
    this.scene.fog = new THREE.Fog(0xe6ddcd, 45, 95);
    this.rig = new CameraRig(canvas);
    this.rig.homeZoom = HOME_ZOOM;
    this.overlay = new Overlay(canvas);

    this.sun.castShadow = true; this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0008; this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target, this.hemi);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), toonMaterial({ color: new THREE.Color(0xe6ddcd) }));
    floor.position.y = -0.37; floor.receiveShadow = true; floor.name = 'floor';
    this.scene.add(floor, this.table.group, this.meters.group, this.actorGroup, this.fx.group, this.ring);
    this.off.push(() => { floor.geometry.dispose(); (floor.material as THREE.Material).dispose(); });

    // selection ring: dashed range circle + faint fill + a pulsing ring under the mini
    const dash: THREE.BufferGeometry[] = [];
    const N = 56;
    for (let i = 0; i < N; i++) dash.push(new THREE.RingGeometry(0.985, 1, 1, 1, (i / N) * Math.PI * 2, (Math.PI * 2 / N) * 0.6));
    const ringGeo = mergeFlat(dash).rotateX(-Math.PI / 2);
    this.ringRange = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.38, depthWrite: false }));
    this.ringFill = new THREE.Mesh(new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: PALETTE.sage, transparent: true, opacity: 0.12, depthWrite: false }));
    this.ringBase = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.5, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: PALETTE.gold, transparent: true, opacity: 0.95, depthWrite: false }));
    for (const m of [this.ringFill, this.ringRange, this.ringBase]) { m.renderOrder = 3; m.raycast = () => {}; this.ring.add(m); }
    this.ringFill.position.y = 0.012; this.ringRange.position.y = 0.016; this.ringBase.position.y = 0.056;
    this.ring.visible = false;
    this.dots = new THREE.InstancedMesh(new THREE.CircleGeometry(0.055, 12).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }), MAX_DOTS);
    this.dots.count = 0; this.dots.renderOrder = 4; this.dots.frustumCulled = false; this.dots.raycast = () => {};
    this.dotEnd = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.24, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.7, depthWrite: false }));
    this.dotEnd.renderOrder = 4; this.dotEnd.visible = false;
    this.scene.add(this.dots, this.dotEnd);

    try {
      this.dice = new DiceRig({ scene: this.scene, camera: this.rig.camera, canvas, toon: (m) => stylize(m, 'thin', this.quality === 'high') });
      this.dice.onThrown = (t: DiceThrow) => { try { this.cb.onDiceThrown(t); } catch (e) { console.error('[scene] onDiceThrown', e); } };
    } catch (e) { console.warn('[scene] dice unavailable', e); this.dice = null; }

    this.listen();
    const lost = (e: Event) => { e.preventDefault(); this.lost = true; };
    const restored = () => { this.lost = false; for (const m of toonMaterials) m.needsUpdate = true; this.dirty = true; };
    canvas.addEventListener('webglcontextlost', lost); canvas.addEventListener('webglcontextrestored', restored);
    this.off.push(() => { canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored); });
    const vis = () => { this.last = performance.now(); this.dirty = true; };
    document.addEventListener('visibilitychange', vis);
    this.off.push(() => document.removeEventListener('visibilitychange', vis));
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas); }
    else { const r = () => this.resize(); addEventListener('resize', r); this.off.push(() => removeEventListener('resize', r)); }

    this.setQuality('high');
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ================================================================ contract
  async load(pack: Pack, baseUrl: string, onProgress?: (p: number) => void): Promise<void> {
    this.pack = pack;
    this.ringR = pack.ranges?.move ?? 4;
    await this.assets.load(pack, baseUrl, onProgress);
    if (this.disposed) return;
    this.loaded = true;
    this.markReady();
    try { this.renderer.compile(this.scene, this.rig.camera); } catch { /* ignore */ }
    if (this.pending) { const { s, p, fx } = this.pending; this.pending = null; this.update(s, p, fx); }
  }

  update(state: GameState, prev: GameState | null, fx: FxEvent[]): void {
    if (this.disposed) return;
    if (!this.loaded || !this.pack) { this.pending = { s: state, p: prev, fx }; return; }
    this.dirty = true;
    let events = fx ?? [];
    if (state.fx && events.length && state.fx.seq === this.lastFxSeq) events = [];
    if (state.fx && events.length) this.lastFxSeq = state.fx.seq;

    const def = this.sceneDef(state);
    const key = `${state.adventureId}|${state.scene.index}|${state.scene.id}|${def?.size.w}x${def?.size.d}`;
    const fresh = key !== this.sceneKey || !this.def;
    if (fresh && def) {
      this.buildScene(def, state); this.sceneKey = key;
      const hs = state.heroes.length ? state.heroes.map((h) => h.pos) : def.start;
      const c = hs.reduce((a, p) => ({ x: a.x + p.x / hs.length, z: a.z + p.z / hs.length }), { x: 0, z: 0 });
      this.rig.setHomeFocus(hs.length ? c : null); this.rig.reset(true);
    }
    if (!this.def) return;
    if (def) this.def = def;
    this.table.setGround(this.def, state.scene.solid ?? []);
    const first = !this.state;
    this.state = state;
    this.syncProps(fresh);

    const paths = new Map<string, { path: P[]; slide: boolean }>();
    const places = new Set<string>();
    for (const e of events) {
      if ((e.k === 'move' || e.k === 'push') && e.id && e.path?.length) paths.set(e.id, { path: e.path, slide: e.k === 'push' });
      if (e.k === 'place' && e.id) places.add(e.id);
    }
    this.syncHeroes(state, paths, places, fresh);
    this.syncFoes(state, paths, places, fresh);
    this.syncTokens(state, places, fresh);
    this.syncBossWall(state);
    this.syncChips();

    this.meters.setGoal(state.meters.goal, !fresh);
    this.meters.setSparks(state.meters.sparks, !fresh);
    this.meters.setMidnight(midnightOf(state, Date.now()));

    this.syncBubbles(state, first || fresh);
    this.syncEvent(state, first);
    if (state.cameraCall && state.cameraCall.seq !== this.camSeq) {
      if (this.camSeq !== null || (!first && !fresh)) this.glide(state.cameraCall.at);
      this.camSeq = state.cameraCall.seq;
    } else if (!state.cameraCall && this.camSeq === null) this.camSeq = -1;
    if (!fresh) for (const e of events) { try { this.playFx(e, state); } catch (err) { console.error('[scene] fx', e.k, err); } }
  }

  setLocal(v: LocalView): void {
    const prev = this.local;
    this.local = { ...v };
    if (prev.isGuide !== v.isGuide && this.state) { this.syncTokens(this.state, new Set(), false); this.syncFoes(this.state, new Map(), new Set(), false); this.syncProps(); }
    // remote drag preview
    const pk: Key | null = v.preview ? (v.preview.kind === 'hero' ? 'h:' : v.preview.kind === 'foe' ? 'f:' : 't:') + v.preview.id : null;
    if (this.previewKey && this.previewKey !== pk) {
      const a = this.actors.get(this.previewKey);
      const k = this.previewKey; this.previewKey = null;
      if (a) { a.setGhost(this.isHiddenToken(k)); a.lift = 0; this.resyncPos(k, a); }
    }
    if (pk && v.preview) {
      const a = this.actors.get(pk);
      this.previewKey = pk;
      if (a && a !== this.dragActor) { a.setGhost(true); a.lift = 0.12; _v.set(v.preview.at.x, 0, v.preview.at.z); a.place(_v); }
    }
    if (prev.selectedHeroId !== v.selectedHeroId) { this.previewTo = null; this.previewDirty = true; }
    this.syncChips();
    this.dirty = true;
  }

  armDice(rollId: string, trait: string, bonus: number): void {
    const name = (this.pack?.labels.traits as Record<string, string> | undefined)?.[trait] ?? trait;
    this.dice?.arm(rollId, bonus ? `${name} +${bonus}` : name);
    this.dirty = true;
  }
  disarmDice(): void { this.dice?.disarm(); this.dirty = true; }
  replayDice(t: DiceThrow): Promise<void> { this.dirty = true; return this.dice ? this.dice.replay(t) : Promise.resolve(); }

  focus(target: P | { heroId: string }): void {
    if ('heroId' in target) {
      const a = this.actors.get('h:' + target.heroId);
      const h = this.state?.heroes.find((x) => x.id === target.heroId);
      if (a) this.rig.focus({ x: a.goal.x, z: a.goal.z }); else if (h) this.rig.focus(h.pos);
    } else this.rig.focus(target);
    this.rig.lastUser = performance.now();
    this.dirty = true;
  }

  worldToScreen(p: P, y = 0): { x: number; y: number; visible: boolean } {
    _v.set(p.x, y, p.z).project(this.rig.camera);
    const r = this.rect;
    const x = r.left + ((_v.x + 1) / 2) * r.width, sy = r.top + ((1 - _v.y) / 2) * r.height;
    return { x, y: sy, visible: _v.z > -1 && _v.z < 1 && x >= r.left && x <= r.left + r.width && sy >= r.top && sy <= r.top + r.height };
  }

  setInsets(top: number, bottom: number): void {
    this.rig.setInsets(top, bottom); this.overlay.setTop(top);
    if (this.dice) this.dice.armY = -1 + Math.min(0.8, 0.4 + (2 * bottom) / Math.max(1, this.rect.height));
    this.dirty = true;
  }
  /** Put the armed dice's centre this many px above the canvas bottom (null = default from insets). */
  setDiceY(px: number | null): void {
    if (!this.dice) return;
    const H = Math.max(1, this.rect.height);
    if (px == null) this.dice.armY = -0.6;
    else this.dice.armY = Math.max(-0.9, Math.min(0.5, -1 + (2 * px) / H));
    this.dirty = true;
  }
  /** Show a turn / size / height change on a piece while the Guide drags a dial (null = back to the state). */
  previewPiece(what: 'prop' | 'foe', id: string, v: { rot?: number; scale?: number; y?: number } | null): void {
    this.dirty = true;
    if (what === 'prop') {
      const obj = this.table.props.find((p) => p.uid === id)?.obj;
      if (!obj) return;
      if (!v) { this.propsKey = ''; this.syncProps(); return; }
      if (v.rot !== undefined) obj.rotation.y = (v.rot * Math.PI) / 180;
      if (v.scale !== undefined) obj.scale.setScalar(v.scale);
      if (v.y !== undefined) obj.position.y = v.y;
      return;
    }
    const a = this.actors.get('f:' + id);
    const f = this.state?.foes.find((x) => x.uid === id);
    if (!a) return;
    if (!v) { this.dialing.delete('f:' + id); if (f) a.face(f.facing, true); return; }
    this.dialing.add('f:' + id);
    if (v.rot !== undefined) a.face((v.rot * Math.PI) / 180, true);
  }

  /** A small picture of a model for the Guide's library (rendered once, cached as a data URL). */
  private thumbs = new Map<string, Promise<string | null>>();
  private thumbQueue: Promise<unknown> = Promise.resolve();
  private thumbRT: THREE.WebGLRenderTarget | null = null;
  private markReady!: () => void;
  private ready = new Promise<void>((r) => { this.markReady = r; });
  thumbnail(model: string): Promise<string | null> {
    let p = this.thumbs.get(model);
    if (p) return p;
    // wait for the models: a library opened while the game is still loading must not cache an empty picture
    p = this.thumbQueue.then(() => this.ready).then(() => new Promise<string | null>((res) => setTimeout(() => {
      try { res(this.renderThumb(model)); } catch (err) { console.warn('[scene] thumb', model, err); res(null); }
    }, 0)));
    this.thumbQueue = p;
    this.thumbs.set(model, p);
    return p;
  }
  private renderThumb(model: string): string | null {
    if (!this.loaded || this.disposed) return null;
    const obj = this.assets.instance(model);
    if (!obj) return null;
    const S = 160;
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xf4efe6, 0xb4abc6, 1.3));
    const sun = new THREE.DirectionalLight(0xfff4e6, 2.2); sun.position.set(-2, 4, 3); sc.add(sun);
    sc.add(obj);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const c = box.getCenter(new THREE.Vector3()), r = Math.max(0.2, box.getSize(new THREE.Vector3()).length() / 2);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(15)) * 1.02;
    cam.position.copy(c).add(new THREE.Vector3(0.55, 0.62, 1).normalize().multiplyScalar(dist));
    cam.lookAt(c);
    if (!this.thumbRT) { this.thumbRT = new THREE.WebGLRenderTarget(S, S, { samples: 4 }); this.thumbRT.texture.colorSpace = THREE.SRGBColorSpace; }
    const r0 = this.renderer.getRenderTarget(), cc = this.renderer.getClearColor(new THREE.Color()), ca = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.thumbRT);
    this.renderer.setClearColor(0x000000, 0); this.renderer.clear();
    this.renderer.render(sc, cam);
    const px = new Uint8Array(S * S * 4);
    this.renderer.readRenderTargetPixels(this.thumbRT, 0, 0, S, S, px);
    this.renderer.setRenderTarget(r0); this.renderer.setClearColor(cc, ca);
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const ctx = cv.getContext('2d')!; const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) img.data.set(px.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4);
    ctx.putImageData(img, 0, 0);
    this.dirty = true;
    return cv.toDataURL('image/png');
  }

  setQuality(q: 'low' | 'high'): void {
    this.quality = q;
    const shadows = q === 'high';
    if (this.renderer.shadowMap.enabled !== shadows || this.sun.castShadow !== shadows) {
      this.renderer.shadowMap.enabled = shadows; this.sun.castShadow = shadows;
      for (const m of toonMaterials) m.needsUpdate = true;
    }
    this.resize();
  }

  resize(): void {
    if (this.disposed) return;
    const b = this.canvas.getBoundingClientRect();
    const w = this.canvas.clientWidth || b.width || 1, h = this.canvas.clientHeight || b.height || 1;
    this.rect = { left: b.left, top: b.top, width: w, height: h };
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'low' ? 1.5 : 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    hatchUniforms.uPx.value = dpr;
    this.paper.setSize(w, h);
    this.overlay.W = b.left + w; this.overlay.H = b.top + h;
    this.rig.resize(w, h);
    this.dirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.holdTimer); clearTimeout(this.ringTimer);
    this.ro?.disconnect();
    for (const f of this.off) f();
    this.clearScene();
    this.dice?.dispose();
    this.table.dispose(); this.meters.dispose(); this.fx.dispose(); this.paper.dispose(); this.overlay.dispose();
    for (const m of [this.ringRange, this.ringFill, this.ringBase, this.dotEnd]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.dots.geometry.dispose(); (this.dots.material as THREE.Material).dispose(); this.dots.dispose();
    this.cardGeo.dispose(); for (const m of this.cardMats) m.dispose();
    this.assets.dispose();
    disposeFallbacks(); disposeActorShared();
    for (const m of toonMaterials) m.dispose();
    toonMaterials.clear();
    this.renderer.dispose();
  }

  // ================================================================ scene
  private sceneDef(state: GameState): PackScene | undefined {
    const p = this.pack!;
    const adv = state.adv ?? p.adventures.find((a) => a.id === state.adventureId) ?? p.adventures[0];
    const byIndex = adv?.scenes[state.scene.index];
    if (byIndex && (!state.scene.id || byIndex.id === state.scene.id)) return byIndex;
    return adv?.scenes.find((s) => s.id === state.scene.id) ?? byIndex;
  }

  private clearScene(): void {
    for (const a of this.list) a.dispose();
    this.actors.clear(); this.list.length = 0;
    this.frozen.clear(); this.locks.clear(); this.previewKey = null;
    if (this.wall) { this.wall.obj.removeFromParent(); this.wall = null; }
    for (const sh of this.shots) sh.obj.removeFromParent();
    this.shots.length = 0;
    if (this.card) { this.card.mesh.removeFromParent(); this.card = null; }
    this.fx.clear(); this.overlay.clear(); this.seenBubbles.clear();
    this.endDrag(false);
  }

  /** Props follow the layout (the Guide edits it live); hidden ones only show, see-through, to the Guide. */
  private propsKey = '';
  private syncProps(force = false): void {
    const def = this.def; if (!def) return;
    const key = JSON.stringify(def.props) + this.local.isGuide;
    if (!force && key === this.propsKey) return;
    this.propsKey = key;
    this.table.syncProps(def, this.assets, this.local.isGuide, this.dragProp);
    this.updateObstacles();
    this.dirty = true;
  }
  private updateObstacles(): void {
    const def = this.def; if (!def || !this.dice) return;
    let obstacles: { x: number; z: number; r: number }[];
    try { obstacles = blockers(def, this.pack!); } catch { obstacles = [...this.table.obstacles]; }
    for (const g of [this.meters.clock, this.meters.presents, this.meters.jar]) if (g && !obstacles.some((o) => Math.hypot(o.x - g.position.x, o.z - g.position.z) < 0.2)) obstacles.push({ x: g.position.x, z: g.position.z, r: 0.35 });
    this.dice.setTable({ w: this.table.w, d: this.table.d }, obstacles);
  }

  private buildScene(def: PackScene, state: GameState): void {
    this.clearScene();
    this.def = def;
    this.propsKey = '';
    this.table.build(def, this.assets, state.scene.solid ?? []);
    const w = this.table.w, d = this.table.d;
    const m = def.meters ?? {};
    const back = -d / 2 + 0.55;
    this.meters.build(this.assets, {
      clock: new THREE.Vector3(m.clock?.x ?? 0, 0, m.clock?.z ?? back),
      presents: new THREE.Vector3(m.presents?.x ?? -w / 2 + 1.1, 0, m.presents?.z ?? back + 0.1),
      jar: new THREE.Vector3(m.jar?.x ?? w / 2 - 0.9, 0, m.jar?.z ?? back + 0.1),
    });
    const r = Math.max(w, d) / 2 + 1.5;
    this.sun.position.set(-0.45 * r * 2, 2.2 * r, 0.75 * r * 2); this.sun.target.position.set(0, 0, 0);
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: r * 8 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.rig.setTable(w, d);
    this.updateObstacles();
  }

  // ================================================================ minis
  private add(a: Actor): void {
    const k = this.keyOf(a);
    this.actors.set(k, a); this.list.push(a); this.actorGroup.add(a.root);
    const pv = this.local.preview;
    if (k === this.previewKey && pv) { a.setGhost(true); a.lift = 0.12; a.place(_v.set(pv.at.x, 0, pv.at.z)); }
  }
  private keyOf(a: Actor): Key { return (a.kind === 'hero' ? 'h:' : a.kind === 'foe' ? 'f:' : 't:') + a.id; }
  private isHiddenToken(k: Key): boolean {
    if (k.startsWith('f:')) return !!this.state?.foes.find((f) => 'f:' + f.uid === k)?.hidden;
    return k.startsWith('t:') && !!this.state?.tokens.find((t) => 't:' + t.uid === k)?.hidden;
  }

  /** Position of a piece in the current state. */
  private statePos(k: Key): { pos: P | null; facing?: number } | null {
    const s = this.state; if (!s) return null;
    const id = k.slice(2);
    if (k[0] === 'h') { const h = s.heroes.find((x) => x.id === id); return h ? { pos: h.pos, facing: h.facing } : null; }
    if (k[0] === 'f') { const f = s.foes.find((x) => x.uid === id); return f ? { pos: f.pos, facing: f.facing } : null; }
    const t = s.tokens.find((x) => x.uid === id); return t ? { pos: t.pos } : null;
  }
  private resyncPos(k: Key, a: Actor): void { const sp = this.statePos(k); if (sp?.pos) this.moveTo(a, k, sp.pos, sp.facing, new Map(), new Set(), false); }

  private toPoints(path: P[], end: P, from: THREE.Vector3): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    for (const c of path) {
      const p = new THREE.Vector3(c.x, 0, c.z);
      const prev = pts[pts.length - 1] ?? from;
      if (prev.distanceToSquared(p) > 1e-4) pts.push(p);
    }
    const e = new THREE.Vector3(end.x, 0, end.z);
    if (!pts.length || pts[pts.length - 1]!.distanceToSquared(e) > 1e-4) pts.push(e);
    return pts;
  }

  private moveTo(a: Actor, k: Key, pos: P, facing: number | undefined, paths: Map<string, { path: P[]; slide: boolean }>, places: Set<string>, fresh: boolean): void {
    _v.set(pos.x, 0, pos.z);
    if (fresh) { a.place(_v); if (facing !== undefined) a.face(facing, true); return; }
    if (a === this.dragActor || k === this.previewKey) return;
    const lock = this.locks.get(k);
    if (lock) {
      if (Math.hypot(lock.x - pos.x, lock.z - pos.z) < 0.08 || performance.now() > lock.until) this.locks.delete(k);
      else return;
    }
    if (a.goal.distanceToSquared(_v) < 1e-4) { if (!a.moving && facing !== undefined && !places.has(a.id) && !this.dialing.has(k)) a.face(facing); return; }
    const p = paths.get(a.id);
    if (places.has(a.id)) { a.hopTo(_v); return; }
    if (p) { a.moveAlong(this.toPoints(p.path, pos, a.root.position), p.slide); return; }
    if (a.goal.distanceTo(_v) > 6) { a.hopTo(_v); return; }
    a.moveAlong([_v.clone()], false);
  }

  private playerColor(state: GameState, owner: string): string {
    return state.players.find((p) => p.id === owner)?.color ?? '#b4abc6';
  }

  private syncHeroes(state: GameState, paths: Map<string, { path: P[]; slide: boolean }>, places: Set<string>, fresh: boolean): void {
    const seen = new Set<string>();
    state.heroes.forEach((hero, i) => {
      const k = 'h:' + hero.id;
      seen.add(k);
      let a = this.actors.get(k);
      const color = this.playerColor(state, hero.owner);
      if (!a) {
        a = new Actor(hero.id, 'hero');
        a.speed = WALK_SPEED;
        const role = this.pack!.roles.find((r) => r.id === hero.roleId);
        const key = this.assets.pick(role?.model, 'char:' + hero.roleId);
        a.setModel(this.assets, key, () => pawn(new THREE.Color(color).getHex(), 0.9), MINI_SCALE);
        a.addBase(color);
        a.place(_v.set(hero.pos.x, 0, hero.pos.z)); a.face(hero.facing ?? 0, true);
        a.popIn(fresh ? 0.15 + i * 0.07 : 0);
        if (!fresh) this.fx.puff(a.root.position, PALETTE.cream, 10, 0.6);
        this.add(a);
        a.setTuckered(hero.tuckered, false);
      } else {
        a.setBaseColor(color);
        this.moveTo(a, k, hero.pos, hero.facing, paths, places, false);
        a.setTuckered(hero.tuckered, true);
      }
    });
    for (const a of this.list) if (a.kind === 'hero' && !seen.has('h:' + a.id) && !a.leaving) a.leave((x) => this.puff(x, PALETTE.cream));
  }

  private syncFoes(state: GameState, paths: Map<string, { path: P[]; slide: boolean }>, places: Set<string>, fresh: boolean): void {
    const seen = new Set<string>();
    const now = Date.now();
    state.foes.forEach((foe, i) => {
      const k = 'f:' + foe.uid;
      let a = this.actors.get(k);
      if (!a && foe.down) return;
      if (foe.hidden && !this.local.isGuide) return;   // not revealed yet: players don't see it
      seen.add(k);
      const def = this.pack!.foes.find((f) => f.id === foe.foe);
      if (!a) {
        a = new Actor(foe.uid, 'foe');
        a.speed = def?.speed ?? WALK_SPEED * 0.9;
        const key = this.assets.pick(def?.model, 'char:' + foe.foe);
        a.setModel(this.assets, key, () => pawn(PALETTE.lavender, 0.8), (def?.scale ?? 1) * MINI_SCALE);
        a.addBase('#5a4e58');
        a.place(_v.set(foe.pos.x, 0, foe.pos.z)); a.face(foe.facing ?? 0, true);
        a.popIn(fresh ? 0.3 + i * 0.07 : 0);
        if (!fresh) this.puff(a, PALETTE.lavender, 12);
        this.add(a);
      } else if (!a.down) this.moveTo(a, k, foe.pos, foe.facing, paths, places, false);
      const ghost = !!foe.hidden || k === this.previewKey;
      if (a.ghost && !ghost && !fresh) this.puff(a, PALETTE.lavender, 12);
      a.setGhost(ghost);
      this.setFrozen(a, !!foe.frozenUntil && foe.frozenUntil > now && !foe.down);
      if (foe.down && !a.down) a.knockOut((x) => this.puff(x, PALETTE.lavender, 16));
    });
    for (const a of this.list) if (a.kind === 'foe' && !seen.has('f:' + a.id) && !a.leaving) a.leave((x) => this.puff(x, PALETTE.cream, 14));
  }

  private tokenModel(t: Token): { key?: string; fallback: () => THREE.Object3D; motion: Motion } {
    const as = this.assets, p = this.pack!;
    if (t.model && as.has(t.model)) return { key: t.model, fallback: () => gem(PALETTE.gold), motion: t.kind === 'npc' ? 'none' : 'bob' };
    switch (t.kind) {
      case 'goal': return { key: as.pick('token:goal', 'prop:present'), fallback: () => gem(PALETTE.rose), motion: 'none' };
      case 'star': return { key: as.pick('token:star', 'prop:star'), fallback: () => gem(PALETTE.gold, 0.35), motion: 'float' };
      case 'item': {
        const item = t.item ? p.items.find((i) => i.id === t.item) : undefined;
        return { key: as.pick(item?.model, t.item && 'prop:' + t.item, 'token:item', 'prop:twinkle_token'), fallback: () => gem(PALETTE.gold, 0.22), motion: 'spin' };
      }
      case 'exit': return { key: as.pick('token:exit'), fallback: () => marker(PALETTE.sage), motion: 'hover' };
      case 'start': return { fallback: () => marker(PALETTE.sage, String(t.uid.replace(/\D/g, '') || '★')), motion: 'none' };
      case 'npc': return { key: as.pick('token:npc', 'char:npc'), fallback: () => marker(PALETTE.lavender, '!'), motion: 'hover' };
      default: return { key: as.pick('token:' + t.kind), fallback: () => marker(PALETTE.rose, '?'), motion: 'hover' };
    }
  }

  private syncTokens(state: GameState, places: Set<string>, fresh: boolean): void {
    const seen = new Set<string>();
    state.tokens.forEach((t, i) => {
      const carrier = t.pos ? null : (t.carriedBy ?? state.foes.find((f) => f.carrying === t.uid)?.uid ?? null);
      const visible = (!t.hidden || this.local.isGuide) && (!!t.pos || !!carrier);
      if (!visible) return;
      const k = 't:' + t.uid;
      seen.add(k);
      let a = this.actors.get(k);
      if (!a) {
        a = new Actor(t.uid, 'token');
        const m = this.tokenModel(t);
        a.motion = m.motion;
        a.setModel(this.assets, m.key, m.fallback);
        if (t.kind === 'exit' || t.kind === 'clue' || t.kind === 'npc') a.radius = Math.max(a.radius, 0.4);
        if (t.pos) a.place(_v.set(t.pos.x, 0, t.pos.z));
        a.popIn(fresh ? 0.1 + i * 0.05 : 0);
        if (!fresh && t.kind !== 'exit' && !t.hidden) this.puff(a, PALETTE.gold, 8);
        this.add(a);
      } else if (t.pos) {
        if (a.carriedBy) { a.carriedBy = null; a.root.position.y = 0; }
        this.moveTo(a, k, t.pos, undefined, new Map(), places, false);
      }
      const ghost = !!t.hidden || k === this.previewKey;
      if (a.ghost && !ghost) this.puff(a, PALETTE.gold, 10);
      a.setGhost(ghost);
      a.carriedBy = carrier;
    });
    for (const a of this.list) if (a.kind === 'token' && !seen.has('t:' + a.id) && !a.leaving) a.leave((x) => this.puff(x, PALETTE.gold, 10), 0.15);
  }

  /** Hearts over heroes, heart pips over foes (DOM chips, placed every frame). */
  private syncChips(): void {
    const s = this.state; if (!s) return;
    const want = new Set<string>();
    for (const h of s.heroes) {
      const k = 'h:' + h.id; want.add(k);
      this.overlay.chip(k, { kind: 'hero', filled: Math.max(0, h.hearts), max: Math.max(1, h.maxHearts), tuckered: h.tuckered, selected: this.local.selectedHeroId === h.id });
    }
    for (const f of s.foes) {
      if (f.down || (f.hidden && !this.local.isGuide)) continue;
      const k = 'f:' + f.uid; want.add(k);
      this.overlay.chip(k, { kind: 'foe', filled: Math.max(0, f.hearts), max: Math.max(1, f.maxHearts) });
    }
    for (const k of this.overlay.chipKeys()) if (!want.has(k)) this.overlay.dropChip(k);
  }

  // ================================================================ bubbles, notes, event cards
  private actorFor(id: string | undefined): Actor | undefined {
    if (!id) return undefined;
    return this.actors.get('h:' + id) ?? this.actors.get('f:' + id) ?? this.actors.get('t:' + id);
  }

  private syncBubbles(state: GameState, initial: boolean): void {
    const now = Date.now(), pnow = performance.now();
    const live = new Set<string>();
    for (const b of state.bubbles ?? []) {
      live.add(b.id);
      if (this.seenBubbles.has(b.id)) continue;
      this.seenBubbles.add(b.id);
      const end = b.at + b.ttl;
      if (initial && end < now) continue;          // old lines from before we joined
      const ms = Math.max(Math.min(b.ttl, end - now), Math.min(b.ttl, 2500));
      const a = this.actorFor(b.who);
      const narrator = !b.who || b.kind === 'story' || b.kind === 'event' || !a;
      if (narrator) {
        const key = b.kind === 'event' ? 'ev:' + b.text : 'b:' + b.id;
        const title = b.kind === 'event' && state.event && state.event.text === b.text ? state.event.name : undefined;
        this.overlay.note(key, b.text, ms, pnow, title, b.kind);
      } else this.overlay.bubble('b:' + b.id, b.who, b.text, b.kind, ms, pnow);
    }
    for (const id of [...this.seenBubbles]) if (!live.has(id)) {
      this.seenBubbles.delete(id);
      this.overlay.endBubble('b:' + id, pnow); this.overlay.endNote('b:' + id, pnow);
    }
  }

  private syncEvent(state: GameState, first: boolean): void {
    const ev = state.event;
    const key = ev ? ev.id + '@' + ev.at : null;
    if (key === this.eventKey) return;
    const was = this.eventKey;
    this.eventKey = key;
    if (!ev) return;
    if (first && was === null && Date.now() - ev.at > 15000) return; // an old card, not news
    this.dropCard(ev.name);
    this.overlay.note('ev:' + ev.text, ev.text, Math.max(7000, Math.min(16000, ev.text.length * 80)), performance.now(), ev.name, 'event');
  }

  private dropCard(name: string): void {
    if (this.card) { this.card.mesh.removeFromParent(); this.card = null; }
    for (const m of this.cardMats) m.dispose();
    const tex = cardTexture(name);
    const face = toonMaterial({ map: tex }); const edge = toonMaterial({ color: new THREE.Color(0xe9dcc6) });
    this.cardMats = [face, edge, { dispose: () => tex.dispose() } as unknown as THREE.Material];
    const mesh = new THREE.Mesh(this.cardGeo, [edge, edge, face, edge, edge, edge]);
    mesh.castShadow = true; addOutline(mesh, 'thin'); mesh.raycast = () => {};
    // land a little in front of where the camera looks, clear of the minis' heads
    const to = new THREE.Vector3(this.rig.lookAt.x + 0.9, 0.02, this.rig.lookAt.z + 0.4);
    to.x = THREE.MathUtils.clamp(to.x, -this.table.w / 2 + 0.6, this.table.w / 2 - 0.6);
    to.z = THREE.MathUtils.clamp(to.z, -this.table.d / 2 + 0.7, this.table.d / 2 - 0.7);
    this.card = { mesh, t: 0, from: to.clone().add(new THREE.Vector3(-0.6, 4, 1.2)), to, rot: (Math.random() - 0.5) * 0.6, life: 12 };
    mesh.position.copy(this.card.from);
    this.scene.add(mesh);
  }

  private updateCard(dt: number): boolean {
    const c = this.card; if (!c) return false;
    c.t += dt;
    const fall = 0.75, u = Math.min(1, c.t / fall);
    const e = 1 - (1 - u) ** 3;
    c.mesh.position.lerpVectors(c.from, c.to, e);
    if (u >= 1) c.mesh.position.y = c.to.y + Math.abs(Math.sin(Math.min(1, (c.t - fall) / 0.3) * Math.PI)) * 0.06 * Math.max(0, 1 - (c.t - fall) / 0.3);
    c.mesh.rotation.set((1 - e) * 1.2, c.rot + (1 - e) * 3.5, (1 - e) * -0.6);
    if (c.t > c.life) {
      const k = Math.max(0.0001, 1 - (c.t - c.life) / 0.4);
      c.mesh.scale.setScalar(k);
      if (k <= 0.0001) { c.mesh.removeFromParent(); this.card = null; }
    }
    return u < 1 || c.t > c.life || c.t - fall < 0.3;
  }

  private glide(at: P): void { this.rig.focus(at); this.dirty = true; }

  // ================================================================ fx
  private anchor(a: Actor | undefined): THREE.Vector3 | Anchor {
    if (!a) return new THREE.Vector3(this.rig.lookAt.x, 1.2, this.rig.lookAt.z);
    return (out) => { if (a.dead) return false; a.head(out); return true; };
  }
  private meterAnchor(k: MeterKind): THREE.Vector3 {
    const g = k === 'clock' ? this.meters.clock : k === 'goal' ? this.meters.presents : this.meters.jar;
    return g.getWorldPosition(new THREE.Vector3()).setY(k === 'clock' ? 1.6 : 0.9);
  }
  private puff(a: Actor, color: number, n = 10): void { this.fx.puff(a.root.position, color, n, 0.6); }

  private playFx(e: FxEvent, state: GameState): void {
    const L = this.pack!.labels;
    const a = this.actorFor(e.id);
    const n = e.n ?? 1, abs = Math.abs(n);
    const plus = (k: string) => `+${abs} ${k}`;
    const at = (p: P) => new THREE.Vector3(p.x, 0, p.z);
    switch (e.k) {
      case 'anim': {
        const clip = (e.clip ?? '').toLowerCase();
        if (!a || clip === 'tuck' || clip === 'revive' || clip === 'sleep') break;
        a.playOnce(clip === 'hurt' ? 'hit' : clip === 'pickup' ? 'pick_up' : clip);
        break;
      }
      case 'say':
        if (e.text && !(state.bubbles ?? []).some((b) => b.text === e.text)) {
          if (a) this.overlay.bubble(`fx:${state.fx.seq}:${e.text}`, e.id, e.text, 'say', Math.min(7000, 2400 + e.text.length * 50), performance.now());
          else this.overlay.note(`fx:${state.fx.seq}:${e.text}`, e.text, Math.min(9000, 3000 + e.text.length * 60), performance.now());
        }
        break;
      case 'foeHearts': if (a) { this.fx.text(`${n < 0 ? '−' : '+'}${abs}`, this.anchor(a), n < 0 ? 'good' : 'bad'); if (n < 0) a.playOnce('hit'); } break;
      case 'ko': if (a) this.fx.text('K.O.!', this.anchor(a), 'good', 0.3); break;
      case 'pickup': {
        let hero = a?.kind === 'hero' ? a : undefined;
        if (!hero && a) { // nearest hero to the token
          let best = 4;
          for (const x of this.list) if (x.kind === 'hero') { const d = x.root.position.distanceTo(a.root.position); if (d < best) { best = d; hero = x; } }
        }
        hero?.playOnce('pick_up');
        if (a && a.kind === 'token') this.puff(a, PALETTE.gold, 10);
        break;
      }
      case 'reveal': if (a) this.puff(a, PALETTE.gold, 14); else if (e.at) this.fx.puff(at(e.at), PALETTE.gold, 14, 0.6); break;
      case 'spawn': if (a) this.puff(a, PALETTE.lavender, 12); break;
      case 'heal': if (a) { this.fx.text(`+${abs} ${abs === 1 ? L.hearts.replace(/s$/, '') : L.hearts}`, this.anchor(a), 'good'); this.puff(a, PALETTE.rose, 8); } break;
      case 'hurt': if (a) { a.playOnce('hit'); this.fx.text(`−${abs} ${abs === 1 ? L.hearts.replace(/s$/, '') : L.hearts}`, this.anchor(a), 'bad'); } break;
      case 'tuck': if (a) this.fx.text(L.tuckered, this.anchor(a), 'info', 1.0); break;
      case 'revive': if (a) { this.puff(a, PALETTE.gold, 12); a.playOnce('jump'); } break;
      case 'spark': this.meters.poke('sparks'); this.fx.text(n < 0 ? `−${abs} ${L.sparks}` : plus(L.sparks), this.meterAnchor('sparks'), 'gold'); break;
      case 'goal': this.meters.poke('goal'); this.fx.text(plus(L.goal), this.meterAnchor('goal'), 'gold'); if (a) this.puff(a, PALETTE.gold, 12); break;
      case 'clock': this.meters.poke('clock'); this.fx.text(`${n < 0 ? '−' : '+'}${abs} ${L.clock}`, this.meterAnchor('clock'), 'bad'); break;
      case 'outcome': {
        const o = (e.text ?? '').toLowerCase();
        const style: TextStyle = o === 'strong' ? 'gold' : o === 'success' ? 'good' : 'bad';
        const word = o === 'strong' ? 'Strong!' : o === 'success' ? 'Yes!' : o === 'trouble' ? 'Miss!' : e.text ?? '';
        if (word) this.fx.text(word, this.anchor(a), style);
        break;
      }
      case 'camera': if (e.at) this.glide(e.at); break;
      case 'event': this.eventFx(e, a); break;
      default: break;
    }
  }

  private eventFx(e: FxEvent, a: Actor | undefined): void {
    const what = e.text ?? '';
    const pts = e.path ?? (e.at ? [e.at] : []);
    const at = (p: P) => new THREE.Vector3(p.x, 0, p.z);
    switch (what) {
      case 'freeze': if (a) this.puff(a, 0xcfe3ee, 14); for (const p of pts) this.fx.puff(at(p), 0xcfe3ee, 10, 0.5); break;
      case 'solid': case 'crack': for (const p of pts) this.fx.puff(at(p), what === 'crack' ? 0xb4abc6 : 0xe3e8ec, 12, 0.7); break;
      case 'throw': a?.playOnce('throw'); if (pts.length >= 2) this.throwThing(pts[0]!, pts[pts.length - 1]!, a?.kind === 'foe'); break;
      case 'wallBreak': if (this.wall) { this.wall.obj.getWorldPosition(_v); this.fx.puff(_v, 0xe3eef4, 22, 1.1); } break;
      default: if (a && what) this.fx.text(what, this.anchor(a), 'bad', 0.1);
    }
  }

  private throwThing(from: P, to: P, byFoe: boolean): void {
    const key = byFoe ? this.assets.pick('fx:throw', 'prop:coal_lump', 'prop:snowball') : this.assets.pick('fx:throw', 'prop:snowball', 'prop:coal_lump');
    const obj = (key && this.assets.instance(key)) || gem(PALETTE.ink, 0.12);
    const sh = { obj, from: new THREE.Vector3(from.x, 0, from.z), to: new THREE.Vector3(to.x, 0, to.z), t: -0.25, dur: 0 };
    sh.dur = Math.max(0.35, sh.from.distanceTo(sh.to) * 0.12);
    obj.visible = false;
    this.scene.add(obj); this.shots.push(sh);
  }

  private setFrozen(a: Actor, on: boolean): void {
    const cur = this.frozen.get(a.id);
    if (on && !cur) {
      const key = this.assets.pick('fx:frozen', 'prop:freeze_overlay');
      let obj: THREE.Object3D;
      if (key) { obj = this.assets.instance(key)!; const t = this.assets.models.get(key)!; obj.scale.multiplyScalar(Math.max(0.45, Math.min(0.6, a.radius * 1.3)) / t.radius); obj.position.y = 0.02; }
      else obj = gem(0xcfe3ee, a.height * 0.5);
      a.root.add(obj); this.frozen.set(a.id, obj); this.puff(a, 0xcfe3ee, 10);
    } else if (!on && cur) { cur.removeFromParent(); this.frozen.delete(a.id); this.puff(a, 0xcfe3ee, 10); }
  }

  private syncBossWall(state: GameState): void {
    const want = state.scene.flags?.bossWall === true;
    const boss = state.foes.find((f) => !f.down && this.pack!.foes.find((d) => d.id === f.foe)?.boss);
    const key = this.assets.pick('fx:boss_wall', 'prop:boss_ice_wall');
    if (want && boss && key && (!this.wall || this.wall.boss !== boss.uid)) {
      if (this.wall) this.wall.obj.removeFromParent();
      const g = new THREE.Group();
      for (const [x, z, r] of [[0, 0.85, 0], [-0.85, 0.15, Math.PI / 2], [0.85, 0.15, -Math.PI / 2]] as const) {
        const w = this.assets.instance(key)!; w.position.set(x, 0, z); w.rotation.y += r; g.add(w);
      }
      g.scale.setScalar(0.0001);
      this.actorGroup.add(g);
      this.wall = { obj: g, boss: boss.uid, s: 0, goal: 1 };
    } else if (this.wall) this.wall.goal = want && boss ? 1 : 0;
  }

  private updateExtras(dt: number): boolean {
    let busy = false;
    const w = this.wall;
    if (w) {
      const boss = this.actors.get('f:' + w.boss);
      if (boss) w.obj.position.copy(boss.root.position);
      w.s += (w.goal - w.s) * (1 - Math.exp(-dt * (w.goal ? 7 : 10)));
      w.obj.scale.set(1, Math.max(0.0001, w.s), 1);
      if (Math.abs(w.s - w.goal) > 0.01) busy = true;
      if (w.goal === 0 && w.s < 0.02) { w.obj.removeFromParent(); this.wall = null; }
    }
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const sh = this.shots[i]!;
      busy = true;
      sh.t += dt;
      if (sh.t < 0) continue;
      const u = Math.min(1, sh.t / sh.dur);
      sh.obj.visible = true;
      sh.obj.position.lerpVectors(sh.from, sh.to, u);
      sh.obj.position.y = 0.9 + Math.sin(u * Math.PI) * (0.6 + sh.from.distanceTo(sh.to) * 0.15) - u * 0.5;
      sh.obj.rotation.x += dt * 9; sh.obj.rotation.z += dt * 6;
      if (u >= 1) { this.fx.puff(sh.to, 0x8f8794, 10, 0.5); sh.obj.removeFromParent(); this.shots.splice(i, 1); }
    }
    if (this.updateCard(dt)) busy = true;
    return busy;
  }

  // ================================================================ path preview
  private updatePreview(): void {
    this.previewDirty = false;
    const sel = this.local.selectedHeroId ? this.actors.get('h:' + this.local.selectedHeroId) : undefined;
    const to = this.previewTo;
    if (!sel || !to || sel.dead) { this.dots.count = 0; this.dotEnd.visible = false; return; }
    const from: P = { x: sel.goal.x, z: sel.goal.z };
    let path: P[] = [from, to];
    try {
      if (this.state && this.pack) {
        const nav = navFor(this.state, this.pack);
        if (nav) { const p = findPath(nav, from, to); if (p.length) path = [from, ...p]; }
      }
    } catch { /* straight line */ }
    let n = 0, carry = DOT_STEP * 0.6, walked = 0;
    for (let i = 1; i < path.length && n < MAX_DOTS; i++) {
      const a = path[i - 1]!, b = path[i]!;
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      let s = carry;
      while (s < L && n < MAX_DOTS) {
        const u = s / L, x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u;
        this.dots.setMatrixAt(n, _m4.makeTranslation(x, 0.03, z));
        this.dots.setColorAt(n, _col.setHex(walked + s <= this.ringR ? 0xfbf8f2 : PALETTE.rose));
        n++; s += DOT_STEP;
      }
      carry = s - L; walked += L;
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
    const end = path[path.length - 1]!;
    this.dotEnd.position.set(end.x, 0.03, end.z); this.dotEnd.visible = true;
    this.dirty = true;
  }
  private setPreview(p: P | null): void {
    if (!p && !this.previewTo) return;
    this.previewTo = p; this.previewDirty = true;
  }

  // ================================================================ picking
  private ndcAt(x: number, y: number): THREE.Vector2 {
    const r = this.rect;
    return _ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  private groundAt(x: number, y: number, clampIt = true): P | null {
    _ray.setFromCamera(this.ndcAt(x, y), this.rig.camera);
    if (!_ray.ray.intersectPlane(_plane, _v2)) return null;
    if (!clampIt) return { x: _v2.x, z: _v2.z };
    const hw = this.table.w / 2 - 0.15, hd = this.table.d / 2 - 0.15;
    return { x: THREE.MathUtils.clamp(_v2.x, -hw, hw), z: THREE.MathUtils.clamp(_v2.z, -hd, hd) };
  }

  private pickActor(x: number, y: number, touch: boolean): Actor | null {
    _ray.setFromCamera(this.ndcAt(x, y), this.rig.camera);
    let best = Infinity, hit: Actor | null = null;
    const grow = touch ? 1.3 : 1;
    for (const a of this.list) {
      if (!a.pickable || a.dead || !a.root.visible || a === this.dragActor) continue;
      if (a.ghost && !this.local.isGuide && this.keyOf(a) !== this.previewKey) continue;
      const p = a.root.position, rad = Math.max(0.3, Math.min(0.6, a.radius * 0.85)) * grow;
      const top = (a.kind === 'token' ? Math.max(0.6, a.height) : a.tuckered ? Math.max(0.5, a.height * 0.45) : a.height) * (touch ? 1.1 : 1);
      _box.min.set(p.x - rad, p.y, p.z - rad); _box.max.set(p.x + rad, p.y + top, p.z + rad);
      if (_ray.ray.intersectBox(_box, _v)) { const d = _v.distanceToSquared(_ray.ray.origin); if (d < best) { best = d; hit = a; } }
    }
    if (hit || !touch) return hit;
    // fingers are fat: nearest mini whose body is within ~28 px on screen
    let bestPx = 28;
    for (const a of this.list) {
      if (!a.pickable || a.dead || !a.root.visible || a === this.dragActor) continue;
      if (a.ghost && !this.local.isGuide) continue;
      for (const hy of [0.15, a.height * 0.6]) {
        const s = this.worldToScreen({ x: a.root.position.x, z: a.root.position.z }, hy);
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bestPx) { bestPx = d; hit = a; }
      }
    }
    return hit;
  }

  private pick(x: number, y: number, touch: boolean): Hit {
    const a = this.pickActor(x, y, touch);
    if (a) {
      const at = { x: a.goal.x, z: a.goal.z };
      return a.kind === 'hero' ? { kind: 'hero', id: a.id, at } : a.kind === 'foe' ? { kind: 'foe', id: a.id, at } : { kind: 'token', id: a.id, at };
    }
    _ray.setFromCamera(this.ndcAt(x, y), this.rig.camera);
    const hits = _ray.intersectObjects([this.meters.group, this.table.propGroup], true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && o.userData.meter === undefined && o.userData.propIndex === undefined) o = o.parent;
      if (!o) continue;
      const wp = o.getWorldPosition(_v);
      const at = { x: wp.x, z: wp.z };
      if (o.userData.meter !== undefined) return { kind: 'meter', meter: o.userData.meter as MeterKind, at };
      return { kind: 'prop', index: o.userData.propIndex as number, at };
    }
    return { kind: 'ground', at: this.groundAt(x, y) ?? { x: 0, z: 0 } };
  }

  private actorOfHit(h: Hit | null): Actor | null {
    if (!h) return null;
    if (h.kind === 'hero') return this.actors.get('h:' + h.id) ?? null;
    if (h.kind === 'foe') return this.actors.get('f:' + h.id) ?? null;
    if (h.kind === 'token') return this.actors.get('t:' + h.id) ?? null;
    return null;
  }

  // ================================================================ input
  private listen(): void {
    const el = this.canvas;
    el.style.touchAction = 'none';
    (el.style as unknown as Record<string, string>).webkitUserSelect = 'none';
    (el.style as unknown as Record<string, string>).webkitTouchCallout = 'none';
    el.style.userSelect = 'none';
    const on = (n: string, f: (e: never) => void, o?: AddEventListenerOptions) => { el.addEventListener(n, f as EventListener, o); this.off.push(() => el.removeEventListener(n, f as EventListener, o)); };
    on('pointerdown', (e: PointerEvent) => this.down(e));
    on('pointermove', (e: PointerEvent) => this.move(e));
    on('pointerup', (e: PointerEvent) => this.up(e, false));
    on('pointercancel', (e: PointerEvent) => this.up(e, true));
    on('lostpointercapture', (e: PointerEvent) => { if (this.ptrs.has(e.pointerId) || this.dicePtrs.has(e.pointerId)) this.up(e, true); });
    on('pointerleave', (e: PointerEvent) => { if (e.pointerType === 'mouse' && !this.ptrs.size) { this.hover = null; if (this.gesture === 'none') this.setPreview(null); } });
    on('wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    on('contextmenu', (e: Event) => e.preventDefault());
    on('gesturestart', (e: Event) => e.preventDefault());
  }

  private down(e: PointerEvent): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.dice && this.ptrs.size === 0) {
      let used = false;
      try { used = this.dice.pointerDown(e); } catch (err) { console.error('[scene] dice', err); }
      if (used) { this.dicePtrs.add(e.pointerId); try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ } return; }
    }
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const mouse = e.pointerType === 'mouse';
    const p: Ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, sx: e.clientX, sy: e.clientY,
      t0: performance.now(), mouse, button: e.button, mod: e.ctrlKey || e.altKey || e.metaKey };
    this.ptrs.set(e.pointerId, p);
    if (this.ptrs.size === 1) {
      this.gesture = 'press';
      this.pressHit = this.pick(e.clientX, e.clientY, !mouse);
      this.pressActor = this.actorOfHit(this.pressHit);
      if (this.pressHit.kind === 'ground' && this.local.selectedHeroId) this.setPreview(this.pressHit.at);
      if (!(mouse && e.button !== 0)) {
        this.ringTimer = window.setTimeout(() => { if (this.gesture === 'press') this.overlay.holdStart(p.x, p.y, HOLD_MS - RING_DELAY); }, RING_DELAY);
        this.holdTimer = window.setTimeout(() => this.fireHold(p), HOLD_MS);
      }
    } else if (this.ptrs.size === 2) {
      this.cancelHold();
      if (this.gesture === 'drag') this.endDrag(true);
      this.setPreview(null);
      this.gesture = 'pinch'; this.startPinch();
    }
  }

  private cancelHold(): void { clearTimeout(this.holdTimer); clearTimeout(this.ringTimer); this.overlay.holdCancel(); }

  private fireHold(p: Ptr): void {
    if (this.gesture !== 'press' || !this.pressHit) return;
    this.gesture = 'held';
    this.overlay.holdFire();
    this.setPreview(null);
    try { navigator.vibrate?.(12); } catch { /* ignore */ }
    try { this.cb.onHold(this.pressHit, { x: p.x, y: p.y }); } catch (err) { console.error('[scene] onHold', err); }
    this.dirty = true;
  }

  private startPinch(): void {
    const [a, b] = [...this.ptrs.values()] as [Ptr, Ptr];
    this.pinch.span = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
    this.pinch.angle = Math.atan2(b.y - a.y, b.x - a.x);
    this.pinch.mx = (a.x + b.x) / 2; this.pinch.my = (a.y + b.y) / 2;
  }

  private move(e: PointerEvent): void {
    if (this.dicePtrs.has(e.pointerId)) { try { this.dice?.pointerMove(e); } catch { /* ignore */ } this.dirty = true; return; }
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && !e.buttons) {
        if (this.dice?.armed) { try { this.dice.pointerMove(e); } catch { /* ignore */ } }
        this.hover = { x: e.clientX, y: e.clientY }; this.previewDirty = !!this.local.selectedHeroId || !!this.previewTo; this.dirty = true;
      }
      return;
    }
    p.px = p.x; p.py = p.y; p.x = e.clientX; p.y = e.clientY;
    const tapPx = p.mouse ? TAP_PX_MOUSE : TAP_PX_TOUCH;
    switch (this.gesture) {
      case 'press': {
        if (Math.hypot(p.x - p.sx, p.y - p.sy) < tapPx) {
          if (this.pressHit?.kind === 'ground' && this.local.selectedHeroId) { const g = this.groundAt(p.x, p.y); if (g) this.setPreview(g); }
          break;
        }
        this.cancelHold(); this.setPreview(null);
        if (p.mouse && (p.button === 2 || p.mod)) { this.gesture = 'rotate'; break; }
        const h = this.pressHit;
        let canDrag = false;
        if (this.pressActor && h && (h.kind === 'hero' || h.kind === 'foe' || h.kind === 'token')) { try { canDrag = this.cb.canDrag(h); } catch { canDrag = false; } }
        if (!this.pressActor && h?.kind === 'prop') {
          let ok = false; try { ok = this.cb.canDrag(h); } catch { ok = false; }
          const obj = ok ? this.table.propByIndex(h.index) : null;
          if (obj) {
            this.gesture = 'drag'; this.dragProp = obj; this.dragHit = h; this.dragAt = { ...h.at };
            obj.position.y = (obj.userData.baseY ?? 0) + 0.15;
            try { this.cb.onDrag(h, this.dragAt, 'start'); } catch (err) { console.error('[scene] onDrag', err); }
            this.dragMove(p);
            break;
          }
        }
        if (canDrag && h && this.pressActor) {
          this.gesture = 'drag'; this.dragActor = this.pressActor; this.dragHit = h;
          this.dragActor.lift = 0.18;
          this.dragAt = { ...h.at };
          try { this.cb.onDrag(h, this.dragAt, 'start'); } catch (err) { console.error('[scene] onDrag', err); }
          this.dragMove(p);
        } else { this.gesture = 'pan'; this.rig.pan(p.sx, p.sy, p.x, p.y); }
        break;
      }
      case 'pan': this.rig.pan(p.px, p.py, p.x, p.y); break;
      case 'rotate': this.rig.rotate(-(p.x - p.px) * 0.008, (p.y - p.py) * 0.005); break;
      case 'drag': this.dragMove(p); break;
      case 'pinch': {
        if (this.ptrs.size < 2) break;
        const [a, b] = [...this.ptrs.values()] as [Ptr, Ptr];
        const span = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this.rig.pan(this.pinch.mx, this.pinch.my, mx, my);
        this.rig.zoom(this.pinch.span / span, true);
        let d = ang - this.pinch.angle; if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
        this.rig.twist(d);
        this.pinch.span = span; this.pinch.angle = ang; this.pinch.mx = mx; this.pinch.my = my;
        break;
      }
      default: break;
    }
    this.dirty = true;
  }

  private dragMove(p: Ptr): void {
    if (this.dragProp && this.dragHit) {
      const g = this.groundAt(p.x, p.y - (p.mouse ? 0 : 26));
      if (!g) return;
      const q = { x: Math.round(g.x * 4) / 4, z: Math.round(g.z * 4) / 4 };   // props sit on a quarter-metre grid
      this.dragAt = q;
      this.dragProp.position.set(q.x, (this.dragProp.userData.baseY ?? 0) + 0.15, q.z);
      try { this.cb.onDrag(this.dragHit, q, 'move'); } catch (err) { console.error('[scene] onDrag', err); }
      return;
    }
    const a = this.dragActor, h = this.dragHit;
    if (!a || !h) return;
    // offset the piece a little above the finger so it isn't hidden under it (touch)
    const g = this.groundAt(p.x, p.y - (p.mouse ? 0 : 26));
    if (!g) return;
    this.dragAt = g;
    _v.set(g.x, 0, g.z);
    const dx = g.x - a.root.position.x, dz = g.z - a.root.position.z;
    if (dx * dx + dz * dz > 1e-4) a.face(Math.atan2(dx, dz));
    a.place(_v);
    try { this.cb.onDrag(h, g, 'move'); } catch (err) { console.error('[scene] onDrag', err); }
  }

  private endDrag(notify: boolean): void {
    if (this.dragProp) {
      const o = this.dragProp, h = this.dragHit;
      this.dragProp = null; this.dragHit = null;
      o.position.y = o.userData.baseY ?? 0;
      if (notify && h) { try { this.cb.onDrag(h, this.dragAt, 'end'); } catch (err) { console.error('[scene] onDrag', err); } }
      // if the move is refused (or cancelled) the prop goes back to where the layout has it
      setTimeout(() => { if (!this.dragProp) { this.propsKey = ''; this.syncProps(); } }, notify ? 1500 : 0);
      return;
    }
    const a = this.dragActor, h = this.dragHit;
    this.dragActor = null; this.dragHit = null;
    if (!a || !h) return;
    a.lift = 0;
    this.locks.set(this.keyOf(a), { x: this.dragAt.x, z: this.dragAt.z, until: performance.now() + LOCK_MS });
    if (notify) { try { this.cb.onDrag(h, this.dragAt, 'end'); } catch (err) { console.error('[scene] onDrag', err); } }
  }

  private up(e: PointerEvent, cancel: boolean): void {
    if (this.dicePtrs.has(e.pointerId)) {
      this.dicePtrs.delete(e.pointerId);
      try { this.dice?.pointerUp(e); } catch (err) { console.error('[scene] dice', err); }
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.dirty = true; return;
    }
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const g = this.gesture;
    if (g === 'press') this.cancelHold();
    if (g === 'press' && !cancel && this.ptrs.size === 0 && this.pressHit) {
      const hit = this.pressHit;
      if (p.mouse && p.button === 2) {
        try { this.cb.onHold(hit, { x: e.clientX, y: e.clientY }); } catch (err) { console.error('[scene] onHold', err); }
      } else if (!p.mouse || p.button === 0) {
        const now = performance.now();
        const ground = hit.kind === 'ground';
        if (ground && this.lastTap.ground && now - this.lastTap.t < DOUBLE_MS && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < DOUBLE_PX) {
          this.lastTap.t = 0; this.rig.reset();
        } else {
          this.lastTap = { t: now, x: e.clientX, y: e.clientY, ground };
          try { this.cb.onTap(hit); } catch (err) { console.error('[scene] onTap', err); }
        }
      }
    }
    if (g === 'drag') this.endDrag(true);
    if (g !== 'pinch' || this.ptrs.size === 0) this.setPreview(null);
    if (this.ptrs.size === 1) { const r = [...this.ptrs.values()][0]!; r.sx = r.x; r.sy = r.y; this.gesture = 'pan'; }
    else if (this.ptrs.size === 0) { this.gesture = 'none'; this.pressHit = null; this.pressActor = null; }
    this.dirty = true;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    this.rig.zoom(Math.exp(THREE.MathUtils.clamp(e.deltaY, -200, 200) * (e.ctrlKey ? 0.01 : 0.0015)));
    this.dirty = true;
  }

  // ================================================================ loop
  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.lost) return;
    let busy = this.dirty || this.fx.busy || this.diceBusy || !!this.dice?.armed || this.meters.busy || this.ptrs.size > 0 || this.shots.length > 0 || !!this.card;
    for (let i = 0; i < this.list.length && !busy; i++) if (this.list[i]!.busy) busy = true;
    if (!busy && now - this.lastRender < 1000 / 30 - 1) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now; this.lastRender = now; this.dirty = false;
    this.t += dt;

    if (now - this.lastSecond > 1000 && this.state) {
      this.lastSecond = now;
      this.meters.setMidnight(midnightOf(this.state, Date.now()));
      const t = Date.now();
      for (const f of this.state.foes) { const a = this.actors.get('f:' + f.uid); if (a && !a.dead) this.setFrozen(a, !!f.frozenUntil && f.frozenUntil > t && !f.down); }
    }
    if (this.rig.update(dt)) this.dirty = true;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i]!;
      if (a.carriedBy) {
        const c = this.actors.get('h:' + a.carriedBy) ?? this.actors.get('f:' + a.carriedBy);
        if (c && !c.dead) { c.head(a.root.position); a.goal.copy(a.root.position); }
        a.root.scale.setScalar(0.55);
      } else if (a.root.scale.x !== 1) a.root.scale.setScalar(1);
      a.update(dt);
      if (a.dead) { this.actors.delete(this.keyOf(a)); this.list.splice(i, 1); a.dispose(); }
    }
    // selection ring + gentle follow
    const sel = this.local.selectedHeroId ? this.actors.get('h:' + this.local.selectedHeroId) : undefined;
    this.ring.visible = !!sel && !sel.dead;
    if (sel && !sel.dead) {
      this.ring.position.set(sel.root.position.x, 0, sel.root.position.z);
      this.ringRange.scale.set(this.ringR, 1, this.ringR); this.ringFill.scale.set(this.ringR, 1, this.ringR);
      const s = (THREE.MathUtils.clamp(sel.radius * 0.95, 0.3, 0.44) + 0.04) / 0.4 * (1 + Math.sin(this.t * 3) * 0.04);
      this.ringBase.scale.set(s, 1, s);
      if (sel.moving && this.gesture !== 'drag' && this.rig.follow(sel.root.position, dt, now)) this.dirty = true;
      if (sel.moving && this.previewTo) this.previewDirty = true;
    }
    if (this.hover && !this.ptrs.size && this.local.selectedHeroId) {
      const a = this.pickActor(this.hover.x, this.hover.y, false);
      const g = a ? null : this.groundAt(this.hover.x, this.hover.y, false);
      const inside = g && Math.abs(g.x) < this.table.w / 2 && Math.abs(g.z) < this.table.d / 2;
      if (this.previewDirty || inside) this.setPreview(inside ? g : null);
    }
    if (this.previewDirty) this.updatePreview();
    if (this.updateExtras(dt)) this.dirty = true;
    this.table.update(this.t);
    this.meters.update(dt);
    this.fx.update(dt);
    if (this.dice) { try { this.diceBusy = this.dice.update(dt); } catch (err) { this.diceBusy = false; console.error('[scene] dice', err); } }

    this.renderer.render(this.scene, this.rig.camera);
    this.paper.render(this.renderer);
    this.placeOverlay(now);
  };

  /** Move the DOM chips / bubbles to their minis (after the camera moved this frame). */
  private placeOverlay(now: number): void {
    for (const k of this.overlay.chipKeys()) {
      const a = this.actors.get(k);
      if (!a || a.dead || a.leaving || !a.root.visible) { this.overlay.placeChip(k, 0, 0, false); continue; }
      a.head(_v);
      const s = this.worldToScreen({ x: _v.x, z: _v.z }, _v.y + 0.05);
      this.overlay.placeChip(k, s.x, s.y, s.visible);
    }
    for (const b of this.overlay.bubblesNeeding()) {
      const a = this.actorFor(b.who);
      if (!a || a.dead) { this.overlay.endBubble(b.id, now); continue; }
      a.head(_v);
      // above the hearts chip
      const s = this.worldToScreen({ x: _v.x, z: _v.z }, _v.y + 0.05);
      this.overlay.placeBubble(b.id, s.x, s.y - 22, true);
    }
    if (this.overlay.tick(now)) this.dirty = true;
  }
}

/** Merge non-indexed-compatible flat geometries (all from RingGeometry) into one. */
function mergeFlat(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  let base = 0;
  for (const g of geos) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
    base += p.count; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  return out;
}

export const createScene: CreateScene = (canvas, cb) => new Scene3D(canvas, cb);
