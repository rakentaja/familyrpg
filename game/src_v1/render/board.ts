// 3D board renderer: tiles, scene props, minis (heroes, foes, tokens), fx, dice, highlights, picking and camera.
import * as THREE from 'three';
import type { BoardCallbacks, BoardView, CreateBoard } from '../contracts';
import type { FxEvent, GameState, Pack, PackScene, PackTile, Token, Vec } from '../engine/types';
import { Assets, packRot } from './assets';
import { Actor, disposeActorShared, disposeFallbacks, gem, marker, pawn, type Motion } from './actors';
import { CameraRig } from './camera';
import { Dice } from './dice';
import { FxLayer, type Anchor } from './fx';
import { PALETTE, PaperOverlay, hatchUniforms, toonMaterial, toonMaterials, addOutline } from './style';

type HighlightKind = 'move' | 'target' | 'danger' | 'path';
const HL_COLOR: Record<HighlightKind, number> = { move: PALETTE.sage, target: PALETTE.rose, danger: PALETTE.danger, path: PALETTE.cream };

// scratch (no per-frame allocation)
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _m = new THREE.Matrix4(), _box = new THREE.Box3(), _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster(), _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _col = new THREE.Color();

function hlTexture(kind: 'square' | 'dot'): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  if (kind === 'square') {
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 6;
    g.beginPath(); g.roundRect(5, 5, 54, 54, 10); g.fill(); g.stroke();
  } else {
    g.fillStyle = '#ffffff'; g.strokeStyle = '#2a2328'; g.lineWidth = 5;
    g.beginPath(); g.arc(32, 32, 15, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class Board implements BoardView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private rig: CameraRig;
  private sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
  private hemi = new THREE.HemisphereLight(0xf4efe6, 0xb4abc6, 1.1);
  private paper = new PaperOverlay(0.5);
  private assets = new Assets();
  private pack: Pack | null = null;
  private loaded = false;
  private pendingState: { s: GameState; p: GameState | null; fx: FxEvent[] } | null = null;

  private boardGroup = new THREE.Group();
  private tileGroup = new THREE.Group();
  private actorGroup = new THREE.Group();
  private fx = new FxLayer();
  private dice = new Dice();
  private owned: { dispose(): void }[] = [];      // per-scene GPU resources
  private tileOwned: { dispose(): void }[] = [];

  private actors = new Map<string, Actor>();
  private list: Actor[] = [];
  private sceneKey = ''; private tileKey = '';
  private w = 0; private h = 0;
  private state: GameState | null = null;
  private lastFxSeq = -1;
  private hands: THREE.Object3D[] = [];
  private handGoal = 0; private handCur = 0;
  private ring: THREE.Mesh; private ringFor: string | null = null;
  // boss ice wall (scene flag), frozen-foe overlays, thrown things
  private wall: { obj: THREE.Group; boss: string; s: number; goal: number } | null = null;
  private frozen = new Map<string, THREE.Object3D>();
  private shots: { obj: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number }[] = [];

  private hl: Record<'main' | 'path', THREE.InstancedMesh | null> = { main: null, path: null };
  private hlTex = { square: hlTexture('square'), dot: hlTexture('dot') };
  private hlGeo = new THREE.PlaneGeometry(0.92, 0.92).rotateX(-Math.PI / 2);
  private hlDotGeo = new THREE.PlaneGeometry(0.42, 0.42).rotateX(-Math.PI / 2);
  private hlMats: THREE.MeshBasicMaterial[] = [];

  private table: THREE.Mesh; private plinth: THREE.Mesh;
  private quality: 'low' | 'high' = 'high';
  private raf = 0; private last = 0; private lastRender = 0; private dirty = true; private lost = false; private disposed = false;
  private ro: ResizeObserver | null = null;
  private t = 0;
  private off: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, private cb: BoardCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(PALETTE.table);
    this.scene.fog = new THREE.Fog(PALETTE.table, 40, 90);

    this.rig = new CameraRig(canvas, {
      tap: (x, y) => this.tap(x, y, false),
      doubleTap: (x, y) => this.tap(x, y, true),
      interact: () => { this.dirty = true; },
    });

    this.sun.castShadow = true; this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0008; this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    // table + board plinth
    this.table = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), toonMaterial({ color: new THREE.Color(0xe6ddcd) }));
    this.table.position.y = -0.32; this.table.receiveShadow = true;
    this.plinth = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 1), toonMaterial({ color: new THREE.Color(0x8f8296) }));
    this.plinth.receiveShadow = true; this.plinth.castShadow = false; this.plinth.visible = false;
    addOutline(this.plinth, 'thin');
    this.scene.add(this.table, this.plinth);

    // active-hero ring
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.44, 0.56, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: PALETTE.gold, transparent: true, opacity: 0.9, depthWrite: false }));
    this.ring.renderOrder = 3; this.ring.visible = false;

    this.boardGroup.add(this.tileGroup);
    this.scene.add(this.boardGroup, this.actorGroup, this.fx.group, this.dice.group, this.ring);

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
    this.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ================================================================ contract
  async load(pack: Pack, baseUrl: string, onProgress?: (p: number) => void): Promise<void> {
    this.pack = pack;
    await this.assets.load(pack, baseUrl, onProgress);
    if (this.disposed) return;
    this.loaded = true;
    // warm up shaders so the first scene doesn't stutter
    try { this.renderer.compile(this.scene, this.rig.camera); } catch { /* ignore */ }
    if (this.pendingState) { const { s, p, fx } = this.pendingState; this.pendingState = null; this.update(s, p, fx); }
  }

  update(state: GameState, prev: GameState | null, fx: FxEvent[]): void {
    if (this.disposed) return;
    if (!this.loaded || !this.pack) { this.pendingState = { s: state, p: prev, fx }; return; }
    this.dirty = true;
    // fx: play each batch once even if update() is called again with the same state
    let events = fx ?? [];
    if (state.fx && events.length && events.length === state.fx.list.length && state.fx.seq === this.lastFxSeq) events = [];
    if (state.fx && events.length) this.lastFxSeq = state.fx.seq;

    const key = `${state.adventureId}|${state.scene.id}|${state.scene.index}|${state.scene.w}x${state.scene.h}`;
    const fresh = key !== this.sceneKey;
    if (fresh) { this.buildScene(state); this.sceneKey = key; }
    const tk = key + '#' + state.scene.frozenWater.join(';') + '#' + state.scene.tiles.join(',');
    if (tk !== this.tileKey) { this.buildTiles(state); this.tileKey = tk; }
    this.state = state;
    if (!this.w || !this.h) return;

    const paths = new Map<string, { path: Vec[]; slide: boolean }>();
    for (const e of events) if ((e.k === 'move' || e.k === 'push') && e.id && e.path?.length) paths.set(e.id, { path: e.path, slide: e.k === 'push' });

    this.syncHeroes(state, paths, fresh);
    this.syncFoes(state, paths, fresh);
    this.syncTokens(state, fresh);
    this.syncBossWall(state);
    if (!fresh) for (const e of events) this.playFx(e, state);

    const max = Math.max(1, state.meters.clockMax);
    this.handGoal = -(state.meters.clock / max) * Math.PI * 2;
    if (fresh) this.handCur = this.handGoal;

    const active = state.phase === 'play' && state.turn.stage === 'heroes' ? state.turn.active : undefined;
    this.ringFor = active ? 'h:' + active : null;
  }

  highlight(cells: Vec[], kind: HighlightKind): void {
    const layer = kind === 'path' ? 'path' : 'main';
    if (!cells.length) { this.setHl('main', [], kind); if (layer === 'main') this.setHl('path', [], 'path'); else this.setHl('path', [], kind); }
    else this.setHl(layer, cells, kind);
    this.dirty = true;
  }

  focus(target: Vec | { heroId: string }): void {
    if ('heroId' in target) {
      const a = this.actors.get('h:' + target.heroId);
      if (a) this.rig.focus(a.goal);
      else { const h = this.state?.heroes.find((x) => x.id === target.heroId); if (h) this.rig.focus(this.cellToWorld(h.pos, _v)); }
    } else this.rig.focus(this.cellToWorld(target, _v));
  }

  rollDice(values: [number, number]): Promise<void> {
    this.dirty = true;
    return this.dice.roll(values, this.rig.camera, _v2.copy(this.rig.lookAt).setY(0), this.rig.distance);
  }

  setInsets(top: number, bottom: number): void { this.rig.setInsets(top, bottom); this.dirty = true; }
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
    const w = this.canvas.clientWidth || this.canvas.width || 1, h = this.canvas.clientHeight || this.canvas.height || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'low' ? 1.5 : 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    hatchUniforms.uPx.value = dpr;
    this.paper.setSize(w, h);
    this.rig.resize(w, h);
    this.dirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    for (const f of this.off) f();
    this.rig.dispose();
    this.clearScene();
    for (const o of this.tileOwned) o.dispose();
    this.fx.dispose(); this.dice.dispose(); this.paper.dispose();
    for (const k of ['main', 'path'] as const) this.hl[k]?.dispose();
    for (const m of this.hlMats) m.dispose();
    this.hlTex.square.dispose(); this.hlTex.dot.dispose(); this.hlGeo.dispose(); this.hlDotGeo.dispose();
    this.ring.geometry.dispose(); (this.ring.material as THREE.Material).dispose();
    for (const o of [this.table, this.plinth]) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    this.assets.dispose();
    disposeFallbacks(); disposeActorShared();
    for (const m of toonMaterials) m.dispose();
    toonMaterials.clear();
    this.renderer.dispose();
  }

  // ================================================================ scene
  private cellToWorld(c: Vec, out: THREE.Vector3): THREE.Vector3 {
    return out.set(c.x - (this.w - 1) / 2, 0, c.y - (this.h - 1) / 2);
  }

  private sceneDef(state: GameState): PackScene | undefined {
    const p = this.pack!;
    const adv = p.adventures.find((a) => a.id === state.adventureId) ?? p.adventures[0];
    const byIndex = adv?.scenes[state.scene.index];
    if (byIndex && (!state.scene.id || byIndex.id === state.scene.id)) return byIndex;
    return adv?.scenes.find((s) => s.id === state.scene.id) ?? byIndex;
  }

  private clearScene(): void {
    for (const a of this.list) a.dispose();
    this.actors.clear(); this.list.length = 0;
    for (const c of [...this.boardGroup.children]) if (c !== this.tileGroup) this.boardGroup.remove(c);
    for (const o of this.owned) o.dispose();
    this.owned.length = 0; this.hands.length = 0;
    this.frozen.clear();
    if (this.wall) { this.wall.obj.removeFromParent(); this.wall = null; }
    for (const sh of this.shots) sh.obj.removeFromParent();
    this.shots.length = 0;
    this.fx.clear();
  }

  private buildScene(state: GameState): void {
    this.clearScene();
    this.w = state.scene.w; this.h = state.scene.h;
    this.setHl('main', [], 'move'); this.setHl('path', [], 'path');
    this.plinth.visible = this.w > 0 && this.h > 0;
    if (!this.w || !this.h) { this.rig.setBoard(6, 6); return; }
    this.plinth.scale.set(this.w + 0.5, 1, this.h + 0.5); this.plinth.position.set(0, -0.23, 0);

    // grid lines
    const pts: number[] = [];
    const x0 = -this.w / 2, z0 = -this.h / 2;
    for (let i = 0; i <= this.w; i++) pts.push(x0 + i, 0.012, z0, x0 + i, 0.012, -z0);
    for (let j = 0; j <= this.h; j++) pts.push(x0, 0.012, z0 + j, -x0, 0.012, z0 + j);
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const gm = new THREE.LineBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.16, depthWrite: false });
    const grid = new THREE.LineSegments(gg, gm); grid.renderOrder = 1;
    this.boardGroup.add(grid); this.owned.push(gg, gm);

    // props
    const def = this.sceneDef(state);
    for (const pl of def?.props ?? []) {
      const obj = this.assets.instance(pl.model);
      if (!obj) continue;
      const holder = new THREE.Group();
      holder.add(obj);
      this.cellToWorld({ x: pl.x, y: pl.y }, holder.position);
      holder.rotation.y = packRot(pl.rot);
      if (pl.scale) holder.scale.setScalar(pl.scale);
      obj.traverse((o) => { if (o.name === 'hand') this.hands.push(o); });
      this.boardGroup.add(holder);
    }

    // light + shadow frustum fitted to the board
    const r = Math.max(this.w, this.h) / 2 + 2.5;
    this.sun.position.set(-0.45 * r * 2, 2.2 * r, 0.75 * r * 2); this.sun.target.position.set(0, 0, 0);
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: r * 8 });
    this.sun.shadow.camera.updateProjectionMatrix();

    this.rig.setBoard(this.w, this.h);
    this.ringFor = null;
  }

  private tileFor(id: string, frozen: boolean): PackTile | { id: string; color?: string; model?: string; water?: boolean; blocks?: boolean } | null {
    const tiles = this.pack!.tiles;
    if (frozen) return tiles.find((t) => t.slippery && !t.water) ?? { id: '__ice', color: '#cfdde6' };
    return tiles.find((t) => t.id === id) ?? null;
  }

  private buildTiles(state: GameState): void {
    for (const o of this.tileOwned) o.dispose();
    this.tileOwned.length = 0;
    this.tileGroup.clear();
    const w = state.scene.w, h = state.scene.h;
    if (!w || !h) return;
    const frozen = new Set(state.scene.frozenWater);
    const groups = new Map<string, { tile: NonNullable<ReturnType<Board['tileFor']>>; cells: number[] }>();
    for (let i = 0; i < w * h; i++) {
      const id = state.scene.tiles[i] ?? '';
      const x = i % w, y = Math.floor(i / w);
      const tile = this.tileFor(id, frozen.has(`${x},${y}`));
      if (!tile) continue;
      let g = groups.get(tile.id);
      if (!g) { g = { tile, cells: [] }; groups.set(tile.id, g); }
      g.cells.push(i);
    }
    const cellM = new THREE.Matrix4();
    for (const { tile, cells } of groups.values()) {
      const tpl = tile.model ? this.assets.models.get(tile.model) : undefined;
      if (tpl) {
        // instanced copy of every mesh in the tile model (toon + ink hull)
        const wrap = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), tpl.rot), new THREE.Vector3().setScalar(tpl.scale));
        tpl.scene.updateMatrixWorld(true);
        tpl.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const local = new THREE.Matrix4().multiplyMatrices(wrap, mesh.matrixWorld);
          const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, cells.length);
          cells.forEach((ci, k) => {
            this.cellToWorldIdx(ci, w, h, _v);
            cellM.makeTranslation(_v.x, 0, _v.z);
            im.setMatrixAt(k, _m.multiplyMatrices(cellM, local));
          });
          im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
          im.receiveShadow = !mesh.userData.sbOutline; im.castShadow = false;
          im.raycast = () => {};
          this.tileGroup.add(im); this.tileOwned.push({ dispose: () => im.dispose() });
        });
      } else {
        const tall = 'blocks' in tile && tile.blocks;
        const geo = new THREE.BoxGeometry(0.98, tall ? 0.7 : 0.12, 0.98).translate(0, tall ? 0.35 - 0.12 : -0.06, 0);
        const color = tile.color ?? ('water' in tile && tile.water ? '#7d8fa6' : tall ? '#8f8794' : '#f2eadb');
        const mat = toonMaterial({ color: new THREE.Color(color) });
        const im = new THREE.InstancedMesh(geo, mat, cells.length);
        cells.forEach((ci, k) => { this.cellToWorldIdx(ci, w, h, _v); im.setMatrixAt(k, _m.makeTranslation(_v.x, 0, _v.z)); });
        im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
        im.receiveShadow = true; im.castShadow = !!tall; im.raycast = () => {};
        this.tileGroup.add(im);
        this.tileOwned.push(geo, { dispose: () => { mat.dispose(); toonMaterials.delete(mat); } }, { dispose: () => im.dispose() });
      }
    }
  }

  private cellToWorldIdx(i: number, w: number, h: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set((i % w) - (w - 1) / 2, 0, Math.floor(i / w) - (h - 1) / 2);
  }

  // ================================================================ minis
  private add(a: Actor): void { this.actors.set(this.keyOf(a), a); this.list.push(a); this.actorGroup.add(a.root); }
  private keyOf(a: Actor): string { return (a.kind === 'hero' ? 'h:' : a.kind === 'foe' ? 'f:' : 't:') + a.id; }

  private toPoints(path: Vec[], end: Vec, from: THREE.Vector3): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    for (const c of path) {
      const p = this.cellToWorld(c, new THREE.Vector3());
      const prev = pts[pts.length - 1] ?? from;
      if (prev.distanceToSquared(p) > 1e-4) pts.push(p);
    }
    const e = this.cellToWorld(end, new THREE.Vector3());
    if (!pts.length || pts[pts.length - 1]!.distanceToSquared(e) > 1e-4) pts.push(e);
    return pts;
  }

  /** Move an actor to its state cell: along the fx path if there is one, else straight. */
  private moveTo(a: Actor, pos: Vec, paths: Map<string, { path: Vec[]; slide: boolean }>, fresh: boolean): void {
    this.cellToWorld(pos, _v);
    if (fresh) { a.place(_v); return; }
    if (a.goal.distanceToSquared(_v) < 1e-4) return;
    const p = paths.get(a.id);
    if (p) { a.moveAlong(this.toPoints(p.path, pos, a.root.position), p.slide); return; }
    if (a.goal.distanceTo(_v) > 8) { a.place(_v); a.popIn(); return; }
    a.moveAlong([_v.clone()], false);
  }

  private playerColor(state: GameState, owner: string): string {
    return state.players.find((p) => p.id === owner)?.color ?? '#b4abc6';
  }

  private syncHeroes(state: GameState, paths: Map<string, { path: Vec[]; slide: boolean }>, fresh: boolean): void {
    const seen = new Set<string>();
    state.heroes.forEach((hero, i) => {
      seen.add('h:' + hero.id);
      let a = this.actors.get('h:' + hero.id);
      const color = this.playerColor(state, hero.owner);
      if (!a) {
        a = new Actor(hero.id, 'hero');
        const role = this.pack!.roles.find((r) => r.id === hero.roleId);
        const key = this.assets.pick(role?.model, 'char:' + hero.roleId);
        a.setModel(this.assets, key, () => pawn(new THREE.Color(color).getHex(), 0.9));
        a.addBase(color);
        this.cellToWorld(hero.pos, _v); a.place(_v); a.face(0, true);
        a.popIn(fresh ? 0.15 + i * 0.07 : 0);
        this.add(a);
        a.setTuckered(hero.tuckered, false);
      } else {
        a.setBaseColor(color);
        this.moveTo(a, hero.pos, paths, false);
        a.setTuckered(hero.tuckered, true);
      }
    });
    for (const a of this.list) if (a.kind === 'hero' && !seen.has('h:' + a.id) && !a.leaving) a.leave((x) => this.puff(x, PALETTE.cream));
  }

  private syncFoes(state: GameState, paths: Map<string, { path: Vec[]; slide: boolean }>, fresh: boolean): void {
    const seen = new Set<string>();
    state.foes.forEach((foe, i) => {
      const k = 'f:' + foe.uid;
      let a = this.actors.get(k);
      if (!a && foe.calmed) return;              // already calmed before we saw it
      seen.add(k);
      if (!a) {
        a = new Actor(foe.uid, 'foe');
        const def = this.pack!.foes.find((f) => f.id === foe.foe);
        const key = this.assets.pick(def?.model, 'char:' + foe.foe);
        a.setModel(this.assets, key, () => pawn(PALETTE.lavender, 0.8), def?.scale ?? 1);
        a.addBase('#5a4e58');
        this.cellToWorld(foe.pos, _v); a.place(_v); a.face(0, true);
        a.popIn(fresh ? 0.3 + i * 0.07 : 0);
        if (!fresh) this.puff(a, PALETTE.lavender);
        this.add(a);
      } else if (!a.calmed) this.moveTo(a, foe.pos, paths, false);
      a.setPips(Math.max(0, foe.grump), Math.max(1, foe.maxGrump));
      this.setFrozen(a, !!foe.frozen && foe.frozen > 0 && !foe.calmed);
      if (foe.calmed && !a.calmed) a.calm((x) => this.puff(x, PALETTE.cream, 16));
    });
    for (const a of this.list) if (a.kind === 'foe' && !seen.has('f:' + a.id) && !a.leaving) a.leave((x) => this.puff(x, PALETTE.cream, 14));
  }

  private tokenModel(t: Token): { key?: string; fallback: () => THREE.Object3D; motion: Motion } {
    const as = this.assets, p = this.pack!;
    switch (t.kind) {
      case 'goal': return { key: as.pick('token:goal', 'prop:present', 'present'), fallback: () => gem(PALETTE.rose), motion: 'none' };
      case 'star': return { key: as.pick('token:star', 'prop:star', 'star'), fallback: () => gem(PALETTE.gold, 0.35), motion: 'float' };
      case 'item': {
        const item = t.item ? p.items.find((i) => i.id === t.item) : undefined;
        return { key: as.pick(item?.model, t.item && 'prop:' + t.item, 'token:item', 'prop:twinkle_token', 'twinkle_token'), fallback: () => gem(PALETTE.gold, 0.22), motion: 'spin' };
      }
      case 'exit': return { key: as.pick('token:exit'), fallback: () => marker(PALETTE.sage), motion: 'hover' };
      case 'npc': return { key: as.pick('token:npc', 'char:npc'), fallback: () => marker(PALETTE.lavender, '!'), motion: 'hover' };
      default: return { key: as.pick('token:' + t.kind), fallback: () => marker(PALETTE.rose, '?'), motion: 'hover' };
    }
  }

  private syncTokens(state: GameState, fresh: boolean): void {
    const seen = new Set<string>();
    state.tokens.forEach((t, i) => {
      const carrier = t.pos ? null : (t.carriedBy ?? state.foes.find((f) => f.carrying === t.uid)?.uid ?? null);
      const visible = !t.hidden && (!!t.pos || !!carrier);
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
        if (t.pos) { this.cellToWorld(t.pos, _v); a.place(_v); }
        a.popIn(fresh ? 0.1 + i * 0.05 : 0);
        if (!fresh && t.kind !== 'exit') this.puff(a, PALETTE.gold, 8);
        this.add(a);
      } else if (t.pos) {
        this.cellToWorld(t.pos, _v);
        if (a.goal.distanceToSquared(_v) > 1e-4) {
          if (a.carriedBy) a.moveAlong([_v.clone()], true); else a.place(_v);
        }
      }
      a.carriedBy = carrier;
    });
    for (const a of this.list) if (a.kind === 'token' && !seen.has('t:' + a.id) && !a.leaving) a.leave((x) => this.puff(x, PALETTE.gold, 10), 0.15);
  }

  // ================================================================ fx
  private actorFor(id: string | undefined): Actor | undefined {
    if (!id) return undefined;
    return this.actors.get('h:' + id) ?? this.actors.get('f:' + id) ?? this.actors.get('t:' + id);
  }
  private anchor(a: Actor | undefined): THREE.Vector3 | Anchor {
    if (!a) return _v2.set(0, 1.2, 0).clone();
    return (out) => { if (a.dead) return false; a.head(out); return true; };
  }
  private puff(a: Actor, color: number, n = 10): void { this.fx.puff(a.root.position, color, n, 0.6); }

  private playFx(e: FxEvent, state: GameState): void {
    const L = this.pack!.labels;
    const a = this.actorFor(e.id);
    const n = e.n ?? 1, abs = Math.abs(n);
    const plus = (k: string) => `+${abs} ${k}`;
    switch (e.k) {
      case 'anim': {
        const clip = (e.clip ?? '').toLowerCase();
        if (!a || clip === 'tuck' || clip === 'revive' || clip === 'sleep') break;
        a.playOnce(clip === 'hurt' ? 'hit' : clip);
        break;
      }
      case 'say': if (e.text) this.fx.bubble(e.text, this.anchor(a)); break;
      case 'grump': if (a) this.fx.text(`${n < 0 ? '−' : '+'}${abs}`, this.anchor(a), n < 0 ? 'good' : 'bad'); break;
      case 'calm': if (a) this.fx.text(L.calmed || 'Calm!', this.anchor(a), 'good', 0.3); break;
      case 'pickup': {
        const tok = state.tokens.find((t) => t.uid === e.id);
        const hero = tok?.carriedBy ? this.actors.get('h:' + tok.carriedBy) : a?.kind === 'hero' ? a : undefined;
        hero?.playOnce('pick_up');
        break;
      }
      case 'spawn': if (a) this.puff(a, PALETTE.lavender, 12); break;
      case 'heal': if (a) { this.fx.text(plus(L.hearts), this.anchor(a), 'good'); this.puff(a, PALETTE.rose, 6); } break;
      case 'hurt': if (a) { a.playOnce('hit'); this.fx.text(`−${abs} ${L.hearts}`, this.anchor(a), 'bad'); } break;
      case 'tuck': if (a) this.fx.text(L.tuckered, this.anchor(a), 'info', 0.2); break;
      case 'revive': if (a) this.puff(a, PALETTE.gold, 10); break;
      case 'spark': this.fx.text(n < 0 ? `−${abs} ${L.sparks}` : plus(L.sparks), this.anchor(a), 'gold'); break;
      case 'goal': this.fx.text(plus(L.goal), this.anchor(a), 'gold'); if (a) this.puff(a, PALETTE.gold, 12); break;
      case 'event': this.eventFx(e, a); break;
      case 'clock': {
        const hand = this.hands[0];
        if (hand) { hand.getWorldPosition(_v); this.fx.text(`${n < 0 ? '−' : '+'}${abs} ${L.clock}`, _v.clone(), 'bad'); }
        break;
      }
      default: break;
    }
  }

  // ================================================================ scene-effect extras
  private eventFx(e: FxEvent, a: Actor | undefined): void {
    const what = e.text ?? '';
    const cells = e.path ?? [];
    switch (what) {
      case 'freeze':
        if (a) this.puff(a, 0xcfe3ee, 14);
        for (const c of cells) this.fx.puff(this.cellToWorld(c, new THREE.Vector3()), 0xcfe3ee, 10, 0.5);
        break;
      case 'solid': case 'crack':
        for (const c of cells) this.fx.puff(this.cellToWorld(c, new THREE.Vector3()), what === 'crack' ? 0xb4abc6 : 0xe3e8ec, 12, 0.7);
        break;
      case 'throw': {
        a?.playOnce('throw');
        if (cells.length >= 2) this.throwThing(cells[0]!, cells[cells.length - 1]!, a?.kind === 'foe');
        break;
      }
      case 'wallBreak':
        if (this.wall) { this.wall.obj.getWorldPosition(_v); this.fx.puff(_v, 0xe3eef4, 22, 1.1); }
        break;
      default:
        // boss phase names and the like: show over the foe; event cards (no actor) are the UI's job
        if (a && what) this.fx.text(what, this.anchor(a), 'bad', 0.1);
    }
  }

  private throwThing(from: Vec, to: Vec, byFoe: boolean): void {
    const key = byFoe ? this.assets.pick('fx:throw', 'prop:coal_lump', 'prop:snowball') : this.assets.pick('fx:throw', 'prop:snowball', 'prop:coal_lump');
    const obj = (key && this.assets.instance(key)) || gem(PALETTE.ink, 0.12);
    const sh = { obj, from: this.cellToWorld(from, new THREE.Vector3()), to: this.cellToWorld(to, new THREE.Vector3()), t: -0.25, dur: 0 };
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
    const want = state.scene.flags.bossWall === true;
    const boss = state.foes.find((f) => !f.calmed && this.pack!.foes.find((d) => d.id === f.foe)?.boss);
    const key = this.assets.pick('fx:boss_wall', 'prop:boss_ice_wall');
    if (want && boss && key && (!this.wall || this.wall.boss !== boss.uid)) {
      if (this.wall) this.wall.obj.removeFromParent();
      const g = new THREE.Group();
      // in front and to both sides of the boss (heroes come from the near side)
      for (const [x, z, r] of [[0, 0.85, 0], [-0.85, 0.15, Math.PI / 2], [0.85, 0.15, -Math.PI / 2]] as const) {
        const w = this.assets.instance(key)!; w.position.set(x, 0, z); w.rotation.y += r; g.add(w);
      }
      g.scale.setScalar(0.0001);
      this.actorGroup.add(g);
      this.wall = { obj: g, boss: boss.uid, s: 0, goal: 1 };
    } else if (this.wall) this.wall.goal = want && boss ? 1 : 0;
  }

  private updateExtras(dt: number): void {
    const w = this.wall;
    if (w) {
      const boss = this.actors.get('f:' + w.boss);
      if (boss) w.obj.position.copy(boss.root.position);
      w.s += (w.goal - w.s) * (1 - Math.exp(-dt * (w.goal ? 7 : 10)));
      w.obj.scale.set(1, Math.max(0.0001, w.s), 1);
      if (w.goal === 0 && w.s < 0.02) { w.obj.removeFromParent(); this.wall = null; }
    }
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const sh = this.shots[i]!;
      sh.t += dt;
      if (sh.t < 0) continue;
      const u = Math.min(1, sh.t / sh.dur);
      sh.obj.visible = true;
      sh.obj.position.lerpVectors(sh.from, sh.to, u);
      sh.obj.position.y = 0.9 + Math.sin(u * Math.PI) * (0.6 + sh.from.distanceTo(sh.to) * 0.15) - u * 0.5;
      sh.obj.rotation.x += dt * 9; sh.obj.rotation.z += dt * 6;
      if (u >= 1) { this.fx.puff(sh.to, 0x8f8794, 10, 0.5); sh.obj.removeFromParent(); this.shots.splice(i, 1); }
    }
  }

  // ================================================================ highlights
  private setHl(layer: 'main' | 'path', cells: Vec[], kind: HighlightKind): void {
    let im = this.hl[layer];
    if (!cells.length) { if (im) im.count = 0; return; }
    if (!im || im.instanceMatrix.count < cells.length) {
      im?.dispose(); if (im) this.scene.remove(im);
      const cap = Math.max(64, cells.length, this.w * this.h);
      const mat = new THREE.MeshBasicMaterial({ map: layer === 'path' ? this.hlTex.dot : this.hlTex.square, transparent: true, depthWrite: false, opacity: 0.9 });
      this.hlMats.push(mat);
      im = new THREE.InstancedMesh(layer === 'path' ? this.hlDotGeo : this.hlGeo, mat, cap);
      im.renderOrder = layer === 'path' ? 5 : 4; im.raycast = () => {}; im.frustumCulled = false;
      this.hl[layer] = im; this.scene.add(im);
    }
    _col.setHex(HL_COLOR[kind]);
    cells.forEach((c, i) => {
      this.cellToWorld(c, _v);
      im!.setMatrixAt(i, _m.makeTranslation(_v.x, layer === 'path' ? 0.05 : 0.035, _v.z));
      im!.setColorAt(i, _col);
    });
    im.count = cells.length;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  // ================================================================ picking
  private tap(x: number, y: number, double: boolean): void {
    const r = this.canvas.getBoundingClientRect();
    _ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, this.rig.camera);
    let best = Infinity, hit: Actor | null = null;
    for (const a of this.list) {
      if (!a.pickable || a.dead || !a.root.visible) continue;
      const p = a.root.position, rad = Math.max(0.32, Math.min(0.55, a.radius * 0.8));
      const top = a.kind === 'token' ? Math.max(0.6, a.height) : a.tuckered ? Math.max(0.5, a.height * 0.45) : a.height;
      _box.min.set(p.x - rad, p.y, p.z - rad); _box.max.set(p.x + rad, p.y + top, p.z + rad);
      if (_ray.ray.intersectBox(_box, _v)) { const d = _v.distanceToSquared(_ray.ray.origin); if (d < best) { best = d; hit = a; } }
    }
    let cell: Vec | null = null;
    if (_ray.ray.intersectPlane(_plane, _v2) && this.w) {
      const cx = Math.round(_v2.x + (this.w - 1) / 2), cy = Math.round(_v2.z + (this.h - 1) / 2);
      if (cx >= 0 && cy >= 0 && cx < this.w && cy < this.h) cell = { x: cx, y: cy };
    }
    if (double) {
      if (this.rig.zoomedIn) this.rig.reset();
      else if (hit) this.rig.focus(hit.root.position);
      else if (cell) this.rig.focus(this.cellToWorld(cell, _v));
      else this.rig.reset();
      return;
    }
    try {
      if (hit) {
        if (hit.kind === 'hero') this.cb.onHeroTap(hit.id);
        else if (hit.kind === 'foe') this.cb.onFoeTap(hit.id);
        else this.cb.onTokenTap(hit.id);
      } else if (cell) this.cb.onCellTap(cell);
    } catch (err) { console.error('[board] tap handler', err); }
  }

  // ================================================================ loop
  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.lost) return;
    let busy = this.dirty || this.fx.busy || this.dice.busy || this.shots.length > 0 || (!!this.wall && Math.abs(this.wall.s - this.wall.goal) > 0.01) || Math.abs(this.handGoal - this.handCur) > 1e-3;
    for (let i = 0; i < this.list.length && !busy; i++) if (this.list[i]!.busy) busy = true;
    // idle minis only breathe: 30 fps is plenty and saves battery
    if (!busy && now - this.lastRender < 1000 / 30 - 1) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now; this.lastRender = now; this.dirty = false;
    this.t += dt;

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
    // active ring
    const ra = this.ringFor ? this.actors.get(this.ringFor) : undefined;
    this.ring.visible = !!ra && !ra.dead;
    if (ra) { this.ring.position.set(ra.root.position.x, 0.06, ra.root.position.z); const s = 1 + Math.sin(this.t * 3) * 0.05; this.ring.scale.set(s, 1, s); }
    // clock hands
    this.handCur += (this.handGoal - this.handCur) * (1 - Math.exp(-dt * 4));
    for (const h of this.hands) h.rotation.z = this.handCur;
    // highlight pulse
    const pulse = 0.78 + Math.sin(this.t * 3.2) * 0.14;
    if (this.hl.main) (this.hl.main.material as THREE.MeshBasicMaterial).opacity = pulse;
    this.updateExtras(dt);
    this.fx.update(dt);
    this.dice.update(dt);

    this.renderer.render(this.scene, this.rig.camera);
    this.paper.render(this.renderer);
  };
}

export const createBoard: CreateBoard = (canvas, cb) => new Board(canvas, cb);
