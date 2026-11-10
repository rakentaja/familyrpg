// Layout editing: the Guide (the host) places, hides, turns and removes pieces, and in the editor also manages
// scenes. The adventure lives in the state (`s.adv`), so every change reaches all players and saving is a copy.
// Pieces added here go into the scene's layout too; hidden ones are seen only by the Guide.
import type { Adventure, Area, AreaKind, GameState, GuideOp, P, Pack, PackScene, SceneFoe, SceneToken, Token, TokenKind } from './types';
import { clampToScene, isP, nearestFree, rp } from './geom';
import { type Ctx, adventure, fail, foeByUid, foeDef, fx, isGuide, isHost, itemDef, nav, setupScene, spawnFoe, tokenByUid } from './core';

const AREA_KINDS: AreaKind[] = ['floor', 'snow', 'ice', 'crack', 'water', 'gap', 'roof', 'wall'];
export const GROUNDS: AreaKind[] = ['floor', 'snow', 'ice', 'roof'];
const TOKEN_KINDS: TokenKind[] = ['goal', 'item', 'star', 'clue', 'npc', 'exit'];
const SCENE_TYPES: PackScene['type'][] = ['explore', 'challenge', 'showdown', 'boss'];
export const MAX_SCENES = 12;
export const SIZE_MIN = 4, SIZE_MAX = 20;
export const MAX_Y = 3;   // highest a prop can be lifted (m)
const MAX_PROPS = 160, MAX_FOES = 30, MAX_TOKENS = 60;

// ---------------------------------------------------------------- sanitising (shared adventures are untrusted)
const str = (v: unknown, max = 80): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const r2 = (n: number) => Math.round(n * 100) / 100;
const pt = (v: unknown, sc?: { w: number; d: number }): P | null => {
  if (!isP(v)) return null;
  const hw = sc ? sc.w / 2 : 50, hd = sc ? sc.d / 2 : 50;
  return { x: r2(num(v.x, -hw, hw, 0)), z: r2(num(v.z, -hd, hd, 0)) };
};
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const slug = (v: unknown, d: string) => str(v, 40).replace(/[^\w-]/g, '') || d;

function cleanScene(x: unknown, pack: Pack, i: number): PackScene | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, any>;
  const size = { w: Math.round(num(o.size?.w, SIZE_MIN, SIZE_MAX, 9)), d: Math.round(num(o.size?.d, SIZE_MIN, SIZE_MAX, 11)) };
  const uids = new Set<string>();
  const uid = (v: unknown, pre: string) => {
    let u = slug(v, ''), n = uids.size;
    while (!u || uids.has(u)) u = `${pre}${++n}`;
    uids.add(u); return u;
  };
  const props = arr(o.props, MAX_PROPS).flatMap((p: any) => {
    if (!p || typeof p.model !== 'string' || !pack.models[p.model]) return [];
    const at = pt(p, size); if (!at) return [];
    const pl: PackScene['props'][number] = { uid: uid(p.uid, 'p'), model: p.model, ...at };
    if (typeof p.rot === 'number') pl.rot = Math.round(num(p.rot, -360, 360, 0));
    if (typeof p.scale === 'number') pl.scale = r2(num(p.scale, 0.25, 4, 1));
    if (typeof p.y === 'number' && p.y > 0) pl.y = r2(num(p.y, 0, MAX_Y, 0));
    if (typeof p.block === 'number') pl.block = r2(num(p.block, 0, 5, 0));
    if (p.hidden) pl.hidden = true;
    const story = str(p.story, 300); if (story) pl.story = story;
    const search = slug(p.search, ''); if (search) pl.search = search;
    return [pl];
  });
  const tokens = arr(o.tokens, MAX_TOKENS).flatMap((t: any) => {
    if (!t || !TOKEN_KINDS.includes(t.kind)) return [];
    const at = pt(t, size); if (!at) return [];
    const tok: SceneToken = { uid: uid(t.uid, 't'), kind: t.kind, ...at };
    if (typeof t.item === 'string' && itemDef(pack, t.item)) tok.item = t.item;
    if (t.hidden) tok.hidden = true;
    const label = str(t.label, 40); if (label) tok.label = label;
    const text = str(t.text, 300); if (text) tok.text = text;
    if (typeof t.model === 'string' && pack.models[t.model]) tok.model = t.model;
    return [tok];
  });
  const foes = arr(o.foes, MAX_FOES).flatMap((f: any) => {
    if (!f || !foeDef(pack, f.foe)) return [];
    const at = pt(f, size); if (!at) return [];
    const sf: SceneFoe = { uid: uid(f.uid, 'f'), foe: f.foe, ...at };
    if (typeof f.rot === 'number') sf.rot = Math.round(num(f.rot, -360, 360, 0));
    if (f.hidden) sf.hidden = true;
    if (typeof f.carrying === 'string' && tokens.some((t) => t.uid === f.carrying)) sf.carrying = f.carrying;
    return [sf];
  });
  const areas = arr(o.areas, 60).flatMap((a: any): Area[] => {
    if (!a || !AREA_KINDS.includes(a.kind)) return [];
    const at = pt(a, size); if (!at) return [];
    const area: Area = { id: uid(a.id, 'a'), kind: a.kind, shape: a.shape === 'circle' ? 'circle' : 'rect', ...at };
    if (area.shape === 'circle') area.r = r2(num(a.r, 0.1, SIZE_MAX, 1));
    else { area.w = r2(num(a.w, 0.1, SIZE_MAX * 2, 1)); area.d = r2(num(a.d, 0.1, SIZE_MAX * 2, 1)); }
    if (typeof a.rot === 'number') area.rot = Math.round(num(a.rot, -360, 360, 0));
    return [area];
  });
  const pts = (v: unknown, max: number) => arr(v, max).map((p) => pt(p, size)).filter((p): p is P => !!p);
  const g = (o.goal && typeof o.goal === 'object' ? o.goal : {}) as Record<string, any>;
  const goal: PackScene['goal'] = { text: str(g.text, 200) };
  if (typeof g.collectGoal === 'number') goal.collectGoal = Math.round(num(g.collectGoal, 0, 12, 0)) || undefined;
  if (g.reachExit) goal.reachExit = true;
  if (g.beatAll) goal.beatAll = true;
  if (g.beatBoss) goal.beatBoss = true;
  if (g.challenge && typeof g.challenge === 'object') {
    goal.challenge = { need: Math.round(num(g.challenge.need, 1, 10, 3)), maxTrouble: Math.round(num(g.challenge.maxTrouble, 1, 10, 3)), text: str(g.challenge.text, 80) || 'Try it' };
  }
  if (!goal.collectGoal) delete goal.collectGoal;
  const sc: PackScene = {
    id: slug(o.id, `scene-${i + 1}`), name: str(o.name, 60) || `Scene ${i + 1}`,
    type: SCENE_TYPES.includes(o.type) ? o.type : 'explore',
    intro: str(o.intro, 600), size, ground: AREA_KINDS.includes(o.ground) ? o.ground : 'floor',
    areas, props, start: pts(o.start, 8), foes, tokens, goal,
    win: str(o.win, 300) || 'Well done, heroes!',
  };
  const edges = pts(o.edges, 12); if (edges.length) sc.edges = edges;
  if (o.meters && typeof o.meters === 'object') {
    const m: NonNullable<PackScene['meters']> = {};
    for (const k of ['clock', 'presents', 'jar'] as const) { const p = pt(o.meters[k], size); if (p) m[k] = p; }
    if (Object.keys(m).length) sc.meters = m;
  }
  const lose = str(o.lose, 300); if (lose) sc.lose = lose;
  if (typeof o.tableMomentAfter === 'string' && pack.tableMoments.some((t) => t.id === o.tableMomentAfter)) sc.tableMomentAfter = o.tableMomentAfter;
  if (typeof o.troubleClock === 'number') sc.troubleClock = Math.round(num(o.troubleClock, 0, 3, 0)) || undefined;
  if (!sc.troubleClock) delete sc.troubleClock;
  return sc;
}

/** A safe, complete copy of an adventure (from a share code, a file or local storage), or null if it is unusable. */
export function cleanAdventure(x: unknown, pack: Pack): Adventure | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, any>;
  const ids = new Set<string>();
  const scenes = arr(o.scenes, MAX_SCENES).map((sc, i) => cleanScene(sc, pack, i)).filter((sc): sc is PackScene => !!sc);
  for (const sc of scenes) { let id = sc.id, n = 1; while (ids.has(id)) id = `${sc.id}-${++n}`; sc.id = id; ids.add(id); }
  if (!scenes.length) return null;
  const endings = arr(o.endings, 6).flatMap((e: any) => {
    const text = str(e?.text, 600); if (!text) return [];
    return [{ id: slug(e.id, 'end'), when: str(e.when, 60), text }];
  });
  if (!endings.length) endings.push({ id: 'end', when: '', text: 'The night is saved. Well done, heroes!' });
  return {
    id: slug(o.id, 'my-adventure'), name: str(o.name, 60) || 'My adventure', blurb: str(o.blurb, 300),
    goalMax: Math.round(num(o.goalMax, 1, 12, 6)), minutes: Math.round(num(o.minutes, 10, 120, 40)),
    scenes, endings,
  };
}

/** A playable copy: every prop gets a stable uid (pieces are edited by uid). */
export function withUids(a: Adventure): Adventure {
  const adv = structuredClone(a);
  for (const sc of adv.scenes) {
    const used = new Set(sc.props.map((p) => p.uid).filter(Boolean));
    let n = 0;
    for (const p of sc.props) if (!p.uid) { do n++; while (used.has(`p${n}`)); p.uid = `p${n}`; used.add(p.uid); }
  }
  return adv;
}

/** A new empty scene for the editor. */
export function blankScene(id: string, name: string, ground: AreaKind = 'floor'): PackScene {
  return {
    id, name, type: 'explore', intro: '', size: { w: 9, d: 11 }, ground, areas: [], props: [],
    start: [{ x: -1, z: 4 }, { x: 0, z: 4 }, { x: 1, z: 4 }, { x: -0.5, z: 3 }, { x: 0.5, z: 3 }],
    foes: [], tokens: [], goal: { text: '' }, win: 'Well done, heroes!',
  };
}
export function blankAdventure(id: string): Adventure {
  return { id, name: 'My adventure', blurb: '', goalMax: 6, minutes: 40, scenes: [blankScene('scene-1', 'Scene 1')], endings: [{ id: 'end', when: '', text: 'The night is saved. Well done, heroes!' }] };
}

// ---------------------------------------------------------------- live state helpers
/** The scene definition being played/edited (inside s.adv, so it may be changed). */
function defScene(c: Ctx): PackScene {
  if (!c.s.adv) c.s.adv = withUids(adventure(c.s, c.pack));   // a table saved before adventures travelled in the state
  const sc = c.s.adv.scenes[c.s.scene.index];
  if (!sc) fail('There is no scene right now.');
  return sc!;
}
const editing = (s: GameState) => s.mode === 'edit';
function newUid(c: Ctx, pre: string): string {
  const sc = defScene(c);
  const taken = new Set<string>([...sc.props.map((p) => p.uid ?? ''), ...sc.foes.map((f) => f.uid), ...sc.tokens.map((t) => t.uid),
    ...c.s.foes.map((f) => f.uid), ...c.s.tokens.map((t) => t.uid)]);
  let n = c.s.seq ?? 0, u: string;
  do { n++; u = `${pre}${n}`; } while (taken.has(u));
  c.s.seq = n;
  return u;
}
const deg = (v: unknown) => Math.round((((num(v, -10000, 10000, 0) % 360) + 360) % 360));
/** Hero start spots as tokens, so the editor can show and move them. */
export function startTokens(sc: PackScene): Token[] {
  return sc.start.map((p, i) => ({ uid: `start${i + 1}`, kind: 'start', pos: { ...p }, label: `Hero ${i + 1} starts here` }));
}
function syncStarts(c: Ctx) {
  const sc = defScene(c);
  sc.start = c.s.tokens.filter((t) => t.kind === 'start' && t.pos).map((t) => ({ ...t.pos! }));
}
function syncFoeDef(c: Ctx, uid: string) {
  const sc = defScene(c), f = foeByUid(c.s, uid), d = sc.foes.find((x) => x.uid === uid);
  if (!f || !d) return;
  d.x = f.pos.x; d.z = f.pos.z; d.rot = Math.round((f.facing * 180) / Math.PI);
  if (f.hidden) d.hidden = true; else delete d.hidden;
}
function syncTokenDef(c: Ctx, uid: string) {
  const sc = defScene(c), t = tokenByUid(c.s, uid), d = sc.tokens.find((x) => x.uid === uid);
  if (!t || !d) return;
  if (t.pos) { d.x = t.pos.x; d.z = t.pos.z; }
  for (const k of ['hidden', 'label', 'text'] as const) { if (t[k]) (d as any)[k] = t[k]; else delete d[k]; }
}

/** Layout ops (the host only). Returns false if `op` is not a layout op. */
export function layoutOp(c: Ctx, op: GuideOp): boolean {
  const s = c.s, pack = c.pack;
  const isLayout = op.k === 'add' || op.k === 'edit' || op.k === 'hideAll' || op.k === 'scene'
    || ((op.k === 'place' || op.k === 'remove') && op.what === 'prop');
  if (!isLayout) return false;
  if (!isHost(s, c.by) && !isGuide(s, c.by)) fail('Only the host or the Guide can change the layout.');
  if (s.phase === 'lobby' || s.phase === 'ending') fail('Not right now.');
  switch (op.k) {
    case 'add': addPiece(c, op); return true;
    case 'edit': editPiece(c, op); return true;
    case 'hideAll': {
      const sc = defScene(c), h = !!op.hidden;
      for (const p of sc.props) { if (h) p.hidden = true; else delete p.hidden; }
      for (const f of s.foes) if (!f.down) { if (h) f.hidden = true; else delete f.hidden; syncFoeDef(c, f.uid); }
      for (const t of s.tokens) if (t.kind !== 'start') { if (h) t.hidden = true; else delete t.hidden; syncTokenDef(c, t.uid); }
      return true;
    }
    case 'place': {
      if (!isP(op.to)) fail('Pick a spot.');
      const sc = defScene(c);
      const p = sc.props.find((x) => x.uid === op.id);
      if (!p) fail('Nothing to move.');
      const to = snap(clampToScene(sc, op.to, 0.05));
      p!.x = to.x; p!.z = to.z;
      return true;
    }
    case 'remove': {
      const sc = defScene(c);
      const i = sc.props.findIndex((x) => x.uid === op.id);
      if (i < 0) fail('Nothing there.');
      sc.props.splice(i, 1);
      // a roll that searches a prop keeps pointing at the same one
      const pur = s.roll?.purpose;
      if (pur && pur.kind === 'search' && typeof pur.propIndex === 'number') {
        if (pur.propIndex === i) delete pur.propIndex; else if (pur.propIndex > i) pur.propIndex--;
      }
      return true;
    }
    case 'scene': sceneOp(c, op); return true;
  }
  return false;
}
const snap = (p: P): P => ({ x: Math.round(p.x * 4) / 4, z: Math.round(p.z * 4) / 4 });

function addPiece(c: Ctx, op: Extract<GuideOp, { k: 'add' }>) {
  const s = c.s, pack = c.pack;
  if (!isP(op.at)) fail('Pick a spot.');
  const sc = defScene(c);
  const hidden = op.hidden !== false;
  const at = rp(clampToScene(sc, op.at, 0.1));
  const rot = op.rot === undefined ? undefined : deg(op.rot);
  if (op.what === 'prop') {
    if (!op.model || !pack.models[op.model] || !op.model.startsWith('prop:')) fail('Unknown piece.');
    if (sc.props.length >= MAX_PROPS) fail('This scene is full.');
    const p = snap(at);
    const pl: PackScene['props'][number] = { uid: newUid(c, 'p'), model: op.model!, x: p.x, z: p.z };
    if (rot) pl.rot = rot;
    if (hidden) pl.hidden = true;
    sc.props.push(pl);
    fx(c, { k: 'place', id: pl.uid!, at: p });
    return;
  }
  if (op.what === 'foe') {
    if (!op.foe || !foeDef(pack, op.foe)) fail('Unknown foe.');
    if (s.foes.length >= MAX_FOES) fail('That’s a lot of foes already.');
    const uid = newUid(c, 'f');
    const f = spawnFoe(c, op.foe!, at, { uid, facing: rot !== undefined ? (rot * Math.PI) / 180 : 0 });
    if (!f) fail('No room there.');
    if (hidden) f!.hidden = true;
    const d: SceneFoe = { uid: f!.uid, foe: op.foe!, x: f!.pos.x, z: f!.pos.z };
    if (rot) d.rot = rot;
    if (hidden) d.hidden = true;
    sc.foes.push(d);
    return;
  }
  // token
  if (!op.kind || (!TOKEN_KINDS.includes(op.kind) && op.kind !== 'start')) fail('Unknown piece.');
  const kind: TokenKind = op.kind!;
  if (kind === 'start') {
    if (!editing(s)) fail('Hero start spots are set in the editor.');
    if (s.tokens.filter((t) => t.kind === 'start').length >= 8) fail('Eight start spots is the most.');
    const n = s.tokens.filter((t) => t.kind === 'start').length + 1;
    let uid = `start${n}`; let k = n;
    while (tokenByUid(s, uid)) uid = `start${++k}`;
    s.tokens.push({ uid, kind: 'start', pos: at, label: `Hero ${n} starts here` });
    syncStarts(c);
    fx(c, { k: 'place', id: uid, at });
    return;
  }
  if (kind === 'item' && (!op.item || !itemDef(pack, op.item))) fail('Pick an item.');
  if (sc.tokens.length >= MAX_TOKENS) fail('This scene is full.');
  const uid = newUid(c, 't');
  const spot = nearestFree(nav(c), at) ?? at;
  const tok: Token = { uid, kind, pos: spot };
  const d: SceneToken = { uid, kind, x: spot.x, z: spot.z };
  if (kind === 'item') { tok.item = op.item; d.item = op.item; }
  const label = str(op.label, 40), text = str(op.text, 300);
  if (label) { tok.label = label; d.label = label; }
  if (text) { tok.text = text; d.text = text; }
  if (op.model && pack.models[op.model]) { tok.model = op.model; d.model = op.model; }
  if (hidden) { tok.hidden = true; d.hidden = true; }
  s.tokens.push(tok); sc.tokens.push(d);
  fx(c, { k: 'place', id: uid, at: spot });
}

function editPiece(c: Ctx, op: Extract<GuideOp, { k: 'edit' }>) {
  const s = c.s, sc = defScene(c);
  if (op.what === 'prop') {
    const p = sc.props.find((x) => x.uid === op.id);
    if (!p) fail('Nothing there.');
    if (op.rot !== undefined) { const r = deg(op.rot); if (r) p!.rot = r; else delete p!.rot; }
    if (op.scale !== undefined) { const k = r2(num(op.scale, 0.25, 4, 1)); if (k !== 1) p!.scale = k; else delete p!.scale; }
    if (op.y !== undefined) { const y = r2(num(op.y, 0, MAX_Y, 0)); if (y > 0) p!.y = y; else delete p!.y; }
    if (op.hidden !== undefined) { if (op.hidden) p!.hidden = true; else delete p!.hidden; }
    if (op.text !== undefined) { const t = str(op.text, 300); if (t) p!.story = t; else delete p!.story; }
    return;
  }
  if (op.what === 'foe') {
    const f = foeByUid(s, op.id);
    if (!f) fail('No such foe.');
    if (op.rot !== undefined) f!.facing = Math.round(((deg(op.rot) * Math.PI) / 180) * 100) / 100;
    if (op.hidden !== undefined) {
      if (op.hidden) f!.hidden = true; else delete f!.hidden;
      if (!op.hidden) fx(c, { k: 'spawn', id: f!.uid, at: f!.pos });
    }
    // a live game keeps the layout's start positions; the editor moves them
    const d = sc.foes.find((x) => x.uid === op.id);
    if (d && editing(s)) syncFoeDef(c, f!.uid);
    else if (d && op.hidden !== undefined) { if (op.hidden) d.hidden = true; else delete d.hidden; }
    return;
  }
  const t = tokenByUid(s, op.id);
  if (!t) fail('Nothing there.');
  if (op.hidden !== undefined && t!.kind !== 'start') {
    if (op.hidden) t!.hidden = true; else delete t!.hidden;
    if (!op.hidden && t!.pos) fx(c, { k: 'reveal', id: t!.uid, at: t!.pos });
  }
  if (op.label !== undefined && t!.kind !== 'start') { const l = str(op.label, 40); if (l) t!.label = l; else delete t!.label; }
  if (op.text !== undefined) { const x = str(op.text, 300); if (x) t!.text = x; else delete t!.text; }
  if (sc.tokens.some((x) => x.uid === op.id)) {
    if (editing(s)) syncTokenDef(c, t!.uid);
    else {
      const d = sc.tokens.find((x) => x.uid === op.id)!;
      for (const k of ['hidden', 'label', 'text'] as const) { if (t![k]) (d as any)[k] = t![k]; else delete d[k]; }
    }
  }
}

/** Keep the layout in step when the Guide moves / removes a foe or token (called from the reducer). */
export function mirrorLayout(c: Ctx, op: GuideOp) {
  if (!c.s.adv) return;
  const sc = c.s.adv.scenes[c.s.scene.index];
  if (!sc) return;
  if (op.k === 'remove' && op.what === 'foe') sc.foes = sc.foes.filter((f) => f.uid !== op.id);
  if (op.k === 'remove' && op.what === 'token') {
    sc.tokens = sc.tokens.filter((t) => t.uid !== op.id);
    if (op.id.startsWith('start')) syncStarts(c);
  }
  // only the editor turns a drag into a new start position; in a game it is just a move
  if (op.k === 'place' && editing(c.s)) {
    if (op.what === 'foe') syncFoeDef(c, op.id);
    if (op.what === 'token') { if (tokenByUid(c.s, op.id)?.kind === 'start') syncStarts(c); else syncTokenDef(c, op.id); }
  }
}

function sceneOp(c: Ctx, op: Extract<GuideOp, { k: 'scene' }>) {
  const s = c.s;
  if (!editing(s)) fail('Scenes are changed in the editor.');
  const adv = s.adv ?? (s.adv = withUids(adventure(s, c.pack)));
  const n = adv.scenes.length, cur = s.scene.index;
  const idx = (v: unknown) => { const i = Math.round(num(v, 0, n - 1, cur)); return i; };
  const fresh = (base: string) => { let i = n + 1, id = `${base}-${i}`; while (adv.scenes.some((x) => x.id === id)) id = `${base}-${++i}`; return id; };
  switch (op.op) {
    case 'goto': { const i = idx(op.index); if (i !== cur) openScene(c, i); return; }
    case 'add': {
      if (n >= MAX_SCENES) fail(`${MAX_SCENES} scenes is the most.`);
      adv.scenes.splice(cur + 1, 0, blankScene(fresh('scene'), `Scene ${n + 1}`, adv.scenes[cur]?.ground ?? 'floor'));
      openScene(c, cur + 1); return;
    }
    case 'copy': {
      if (n >= MAX_SCENES) fail(`${MAX_SCENES} scenes is the most.`);
      const cp = structuredClone(adv.scenes[cur]!);
      cp.id = fresh(cp.id.replace(/-\d+$/, '')); cp.name = `${cp.name} (copy)`.slice(0, 60);
      adv.scenes.splice(cur + 1, 0, cp);
      openScene(c, cur + 1); return;
    }
    case 'delete': {
      if (n <= 1) fail('An adventure needs at least one scene.');
      adv.scenes.splice(cur, 1);
      openScene(c, Math.min(cur, adv.scenes.length - 1)); return;
    }
    case 'up': case 'down': {
      const j = op.op === 'up' ? cur - 1 : cur + 1;
      if (j < 0 || j >= n) return;
      const [x] = adv.scenes.splice(cur, 1); adv.scenes.splice(j, 0, x!);
      s.scene.index = j; return;
    }
    case 'set': {
      const p = op.patch ?? {}, sc = adv.scenes[cur]!;
      if (p.name !== undefined) sc.name = str(p.name, 60) || sc.name;
      if (p.intro !== undefined) sc.intro = str(p.intro, 600);
      if (p.advName !== undefined) adv.name = str(p.advName, 60) || adv.name;
      if (p.advBlurb !== undefined) adv.blurb = str(p.advBlurb, 300);
      if (p.ground !== undefined && AREA_KINDS.includes(p.ground)) sc.ground = p.ground;
      if (p.w !== undefined || p.d !== undefined) {
        sc.size = { w: Math.round(num(p.w, SIZE_MIN, SIZE_MAX, sc.size.w)), d: Math.round(num(p.d, SIZE_MIN, SIZE_MAX, sc.size.d)) };
        // keep everything on the table
        const keep = (q: { x: number; z: number }) => { const k = clampToScene(sc, q, 0.2); q.x = r2(k.x); q.z = r2(k.z); };
        sc.props.forEach(keep); sc.foes.forEach(keep); sc.tokens.forEach(keep); sc.start.forEach(keep);
        for (const f of s.foes) keep(f.pos);
        for (const t of s.tokens) if (t.pos) keep(t.pos);
      }
      return;
    }
  }
}

/** Load scene i into the live state for editing (no heroes, nothing moves on its own). */
export function openScene(c: Ctx, i: number) {
  setupScene(c, i);
  enterEdit(c.s);
}
export function enterEdit(s: GameState) {
  s.mode = 'edit';
  s.phase = 'play';
  s.bubbles = [];
  s.clock.runningSince = null;
  const sc = s.adv?.scenes[s.scene.index];
  if (sc) s.tokens = [...s.tokens.filter((t) => t.kind !== 'start'), ...startTokens(sc)];
}
