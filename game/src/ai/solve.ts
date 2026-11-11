// Runs GM commands (the line DSL from ai/src/dsl.ts) on the table: each command becomes ordinary Guide ops,
// dispatched one at a time so later commands can refer to pieces made by earlier ones ("…and make them bigger").
// Placement is worked out here: regions and relations become points on the scene, spaced so pieces don't overlap.
import type { Cmd, Mods, Noun, Place, Ref, Region, Sel } from '../../../ai/src/dsl';
import { parseProgram } from '../../../ai/src/dsl';
import type { AiPack } from '../../../ai/src/lexicon';
import { reduce } from '../rules/reduce';
import type { Envelope, GameState, GuideOp, P, Pack, PackScene } from '../rules/types';

export type Piece = { what: 'prop' | 'foe' | 'token'; id: string };
interface Live extends Piece { at: P; rot: number; scale: number; y: number; hidden: boolean; model?: string; foe?: string; kind?: string; item?: string }

export interface World {
  pack: Pack;
  ai: AiPack;
  state(): GameState;
  dispatch(op: GuideOp): void;     // applied straight away (the host's own store)
  selected(): Piece | null;
  placeHidden: boolean;            // the drawer's "Place hidden" switch
}

export interface Outcome { done: number; notes: string[]; touched: Piece[] }

/** A problem with one line of a plan. block = the line would do nothing. */
export interface Issue { msg: string; block: boolean }

/** What the runner reports while it works (used by check). */
interface Trace {
  line(i: number): void;                                   // a top-level line starts
  say(msg: string): void;                                  // every note, also repeats
  touch(c: Cmd, ps: Piece[]): void;                        // the pieces a top-level line acted on
  end(i: number, did: boolean): void;                      // the line is over; did = it changed the table
}
export interface RunOpts { skip?: ReadonlySet<number>; trace?: Trace }

const M = 0.7;          // keep this far from the scene edge (m)
const GAP = 0.9;        // spacing between pieces placed together
const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const deg = (rad: number) => Math.round((rad * 180) / Math.PI);
const norm360 = (d: number) => ((Math.round(d) % 360) + 360) % 360;

// ---------------------------------------------------------------- reading the table
function scene(s: GameState): PackScene | undefined { return s.adv?.scenes[s.scene.index]; }

export function pieces(s: GameState): Live[] {
  const out: Live[] = [];
  for (const p of scene(s)?.props ?? []) if (p.uid) out.push({ what: 'prop', id: p.uid, at: { x: p.x, z: p.z }, rot: p.rot ?? 0, scale: p.scale ?? 1, y: p.y ?? 0, hidden: !!p.hidden, model: p.model });
  for (const f of s.foes) if (!f.down) out.push({ what: 'foe', id: f.uid, at: f.pos, rot: deg(f.facing), scale: f.scale ?? 1, y: f.y ?? 0, hidden: !!f.hidden, foe: f.foe });
  for (const t of s.tokens) if (t.pos && !t.carriedBy) out.push({ what: 'token', id: t.uid, at: t.pos, rot: t.rot ?? 0, scale: t.scale ?? 1, y: t.y ?? 0, hidden: !!t.hidden, kind: t.kind, item: t.item, model: t.model });
  return out;
}

function matches(w: World, p: Live, n: Noun): boolean {
  switch (n.type) {
    case 'prop': return p.what === 'prop' && p.model === `prop:${n.id}`;
    case 'foe': return p.what === 'foe' && p.foe === n.id;
    case 'token': return p.what === 'token' && p.kind === n.id;
    case 'item': return p.what === 'token' && p.kind === 'item' && p.item === n.id;
    case 'hero': { const r = w.pack.roles.find((x) => x.id === n.id); return p.what === 'token' && p.kind === 'npc' && !!r && p.model === r.model; }
    default: return false;
  }
}

export function nounName(pack: Pack, n: Noun, plural = false): string {
  let s = '';
  if (n.type === 'prop') s = n.id.replace(/_\d+$/, '').replace(/_/g, ' ');
  else if (n.type === 'foe') s = pack.foes.find((f) => f.id === n.id)?.name ?? n.id;
  else if (n.type === 'item') s = pack.items.find((f) => f.id === n.id)?.name ?? n.id;
  else if (n.type === 'hero') s = pack.roles.find((f) => f.id === n.id)?.name ?? n.id;
  else if (n.type === 'token') s = ({ goal: pack.labels.goal.replace(/s$/, ''), star: 'star token', clue: 'clue', npc: 'friend', exit: 'exit', start: 'hero start' } as Record<string, string>)[n.id] ?? n.id;
  else s = n.id.replace(/[_-]/g, ' ');
  s = s.toLowerCase();
  if (!plural) return s;
  const w = s.split(' '), last = w.pop()!;
  const pl = /(s|x|ch|sh)$/.test(last) ? `${last}es` : /man$/.test(last) ? last.replace(/man$/, 'men') : /[^aeiou]y$/.test(last) ? last.replace(/y$/, 'ies') : /(deer|sheep|fish|stuff|ice|coal|syrup)$/.test(last) ? last : `${last}s`;
  return [...w, pl].join(' ');
}

// ---------------------------------------------------------------- where things go
function inRegion(sc: PackScene, p: P, r: Region): boolean {
  const hw = sc.size.w / 2, hd = sc.size.d / 2, ex = sc.size.w / 4, ez = sc.size.d / 4;
  const n = p.z < -hd + ez, s = p.z > hd - ez, e = p.x > hw - ex, w = p.x < -hw + ex;
  switch (r) {
    case 'center': return Math.abs(p.x) < ex && Math.abs(p.z) < ez;
    case 'spread': return true;
    case 'side': return n || s || e || w;
    case 'corner': return (n || s) && (e || w);
    case 'side:n': return n; case 'side:s': return s; case 'side:e': return e; case 'side:w': return w;
    case 'corner:ne': return n && e; case 'corner:nw': return n && w; case 'corner:se': return s && e; case 'corner:sw': return s && w;
  }
}

class Spots {
  taken: P[];
  constructor(readonly sc: PackScene, live: Live[], private rnd: () => number) { this.taken = live.map((p) => p.at); }
  private inside(p: P): P {
    const hw = this.sc.size.w / 2 - M, hd = this.sc.size.d / 2 - M;
    return { x: r2(clamp(p.x, -hw, hw)), z: r2(clamp(p.z, -hd, hd)) };
  }
  private free(p: P, d = 0.75) { return this.taken.every((q) => (q.x - p.x) ** 2 + (q.z - p.z) ** 2 >= d * d); }
  /** Nudge to the nearest free spot (spiral), keep it on the table, and mark it taken. */
  claim(p: P, exact = false): P {
    let best = this.inside(p);
    if (!exact && !this.free(best)) {
      outer: for (let ring = 1; ring <= 8; ring++) for (let k = 0; k < 8 * ring; k++) {
        const a = (k / (8 * ring)) * Math.PI * 2, q = this.inside({ x: p.x + Math.sin(a) * 0.5 * ring, z: p.z + Math.cos(a) * 0.5 * ring });
        if (this.free(q)) { best = q; break outer; }
      }
    }
    this.taken.push(best);
    return best;
  }
  random(): P { const hw = this.sc.size.w / 2 - M, hd = this.sc.size.d / 2 - M; return { x: (this.rnd() * 2 - 1) * hw, z: (this.rnd() * 2 - 1) * hd }; }

  /** n points for a region. */
  region(r: Region, n: number, cluster: boolean): P[] {
    const hw = this.sc.size.w / 2 - M, hd = this.sc.size.d / 2 - M;
    const line = (a: P, b: P) => Array.from({ length: n }, (_, i) => n === 1 ? { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 } : { x: a.x + ((b.x - a.x) * i) / (n - 1), z: a.z + ((b.z - a.z) * i) / (n - 1) });
    const span = (len: number) => Math.min(len, (n - 1) * 1.6) / 2;
    const corner = (sx: number, sz: number): P => ({ x: sx * hw, z: sz * hd });
    const corners: Record<string, P> = { ne: corner(1, -1), nw: corner(-1, -1), se: corner(1, 1), sw: corner(-1, 1) };
    if (cluster || r === 'center' || r.startsWith('corner')) {
      let c: P = { x: 0, z: 0 };
      if (r === 'corner') c = Object.values(corners)[Math.floor(this.rnd() * 4)]!;
      else if (r.startsWith('corner:')) c = corners[r.slice(7)]!;
      else if (r !== 'center') c = this.region(r, 1, false)[0]!;
      return this.group(c, n, cluster ? 0.75 : GAP);
    }
    switch (r) {
      case 'side:n': { const s = span(2 * hw); return line({ x: -s, z: -hd }, { x: s, z: -hd }); }
      case 'side:s': { const s = span(2 * hw); return line({ x: -s, z: hd }, { x: s, z: hd }); }
      case 'side:e': { const s = span(2 * hd); return line({ x: hw, z: -s }, { x: hw, z: s }); }
      case 'side:w': { const s = span(2 * hd); return line({ x: -hw, z: -s }, { x: -hw, z: s }); }
      case 'side': {
        const sides: Region[] = ['side:n', 'side:e', 'side:s', 'side:w'];
        const start = Math.floor(this.rnd() * 4);
        return Array.from({ length: n }, (_, i) => { const p = this.region(sides[(start + i) % 4]!, 1, false)[0]!; const along = (this.rnd() - 0.5) * 0.6; return p.x === hw || p.x === -hw ? { x: p.x, z: p.z + along * 2 * hd } : { x: p.x + along * 2 * hw, z: p.z }; });
      }
      default: return Array.from({ length: n }, () => this.random());   // spread
    }
  }
  /** n points packed around c. */
  group(c: P, n: number, gap: number): P[] {
    const out: P[] = [{ ...c }];
    for (let ring = 1; out.length < n; ring++) {
      const k = 6 * ring;
      for (let i = 0; i < k && out.length < n; i++) { const a = (i / k) * Math.PI * 2; out.push({ x: c.x + Math.sin(a) * gap * ring, z: c.z + Math.cos(a) * gap * ring }); }
    }
    return out;
  }
  /** n points by a target (north = away from the players' side of the table = -z). */
  rel(rel: string, t: P, n: number): P[] {
    const D = 1.2;
    if (rel === 'around' || (rel === 'near' && n > 1)) {
      const r = rel === 'around' ? Math.max(1.3, (n * GAP) / (Math.PI * 2)) : D;
      const a0 = this.rnd() * Math.PI * 2, step = rel === 'around' ? (Math.PI * 2) / n : Math.min(0.9, (Math.PI * 2) / n);
      return Array.from({ length: n }, (_, i) => ({ x: t.x + Math.sin(a0 + i * step) * r, z: t.z + Math.cos(a0 + i * step) * r }));
    }
    if (rel === 'on') return Array.from({ length: n }, () => ({ ...t }));
    if (rel === 'near') { const a = this.rnd() * Math.PI * 2; return [{ x: t.x + Math.sin(a) * D, z: t.z + Math.cos(a) * D }]; }
    const dir: Record<string, P> = { behind: { x: 0, z: -1 }, front_of: { x: 0, z: 1 }, left_of: { x: -1, z: 0 }, right_of: { x: 1, z: 0 } };
    const d = dir[rel] ?? { x: 0, z: 1 };
    const c = { x: t.x + d.x * D, z: t.z + d.z * D };
    return Array.from({ length: n }, (_, i) => { const o = (i - (n - 1) / 2) * GAP; return { x: c.x + d.z * o, z: c.z + d.x * o }; });
  }
}

// ---------------------------------------------------------------- the runner
export function run(w: World, program: Cmd[] | string, seed = Date.now(), opts: RunOpts = {}): Outcome {
  const cmds = typeof program === 'string' ? parseProgram(program) : program;
  const tr = opts.trace;
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const notes: string[] = [];
  let last: Piece[] = [];
  let lastGone = -1;                                  // the line that removed what "it" meant
  const gone = new Map<string, number>();            // noun → the line that removed it
  const touched: Piece[] = [];
  let done = 0, ln = 0, depth = 0;            // ln = the top-level line being run
  const say = (m: string) => { tr?.say(m); if (!notes.includes(m)) notes.push(m); };
  const sc = () => scene(w.state());
  const live = () => pieces(w.state());
  const find = (p: Piece) => live().find((q) => q.what === p.what && q.id === p.id);
  const editing = () => w.state().mode === 'edit';
  const tryOp = (op: GuideOp): boolean => { const before = w.state(); w.dispatch(op); return w.state() !== before; };
  const nkey = (n: Noun) => `${n.type}:${n.id}`;
  const setLast = (ps: Piece[]) => { last = ps; lastGone = -1; };
  const touch = (c: Cmd, ps: Piece[]) => { if (!depth) tr?.touch(c, ps); };

  function resolveRef(r: Ref): Live | null {
    if (r === 'selected') {
      const s = w.selected(); const p = s && find(s);
      if (!p) say(s ? 'The piece you picked is not in this scene.' : 'No piece is selected. Tap one first.');
      return p ?? null;
    }
    if (r === 'last') {
      if (last.length) { const p = find(last[last.length - 1]!); if (!p) say('That piece is no longer on the table.'); return p ?? null; }
      if (lastGone >= 0) { say(`Line ${lastGone + 1} removes it.`); return null; }
      const s = w.selected(); const p = s && find(s);           // nothing earlier in the plan: "it" is the picked piece
      if (!p) say('Nothing earlier to call “it”, and no piece is selected.');
      return p ?? null;
    }
    const all = live().filter((p) => matches(w, p, r));
    if (!all.length) { say(gone.has(nkey(r)) ? `Line ${gone.get(nkey(r))! + 1} removes the ${nounName(w.pack, r)}.` : `There is no ${nounName(w.pack, r)} in this scene.`); return null; }
    const s = w.selected();
    return all.find((p) => s && p.what === s.what && p.id === s.id) ?? all[all.length - 1]!;
  }
  function resolveSel(sel: Sel): Live[] {
    if (sel.kind === 'selected' || sel.kind === 'last') { const p = resolveRef(sel.kind); return p ? [p] : []; }
    if (sel.kind === 'all') return live().filter((p) => p.kind !== 'start');
    let all = live().filter((p) => matches(w, p, sel.noun));
    const s = sc();
    if (sel.where && 'region' in sel.where && s) { const reg = sel.where.region; all = all.filter((p) => inRegion(s, p.at, reg)); }
    if (!all.length) {
      const nm = nounName(w.pack, sel.noun), g = gone.get(nkey(sel.noun));
      say(g !== undefined && !sel.where ? `Line ${g + 1} removes the ${nm}.` : `There is no ${nm} ${sel.where ? 'there' : 'in this scene'}.`);
      return [];
    }
    if (sel.all) return all;
    const cur = w.selected();
    return [all.find((p) => cur && p.what === cur.what && p.id === cur.id) ?? all[all.length - 1]!];
  }
  function points(place: Place | undefined, n: number, cluster: boolean, spots: Spots): { at: P[]; exact: boolean; on?: Live } | null {
    if (!place) return { at: spots.region(cluster ? 'center' : n > 1 ? 'spread' : 'center', n, cluster), exact: false };
    if ('region' in place) return { at: spots.region(place.region, n, cluster), exact: false };
    const t = resolveRef(place.target);
    if (!t) {
      if (place.target === 'selected' || place.target === 'last') return null;
      say('It goes in the middle instead.');                          // the target isn't on the table: still place the piece
      return { at: spots.region('center', n, cluster), exact: false };
    }
    spots.taken = spots.taken.filter((q) => q !== t.at);
    const at = cluster ? spots.group(spots.rel(place.rel, t.at, 1)[0]!, n, 0.75) : spots.rel(place.rel, t.at, n);
    return { at, exact: place.rel === 'on', on: place.rel === 'on' ? t : undefined };
  }
  /** Turn / size / height / show for one piece (relative to how it is now). */
  function looks(p: Live, m: Mods, onTop?: Live): Omit<Extract<GuideOp, { k: 'edit' }>, 'k' | 'what' | 'id'> {
    const e: { rot?: number; scale?: number; y?: number; hidden?: boolean } = {};
    if (m.turn !== undefined) e.rot = norm360(p.rot + m.turn);
    if (m.rot !== undefined) e.rot = norm360(m.rot);
    if (m.face !== undefined) {
      const t = m.face === 'center' ? { at: { x: 0, z: 0 } } : resolveRef(m.face);
      if (t) e.rot = norm360(deg(Math.atan2(t.at.x - p.at.x, t.at.z - p.at.z)));
    }
    if (m.scale) {
      const s = m.scale, k = p.scale;
      const v = s === 'up' ? k * 1.25 : s === 'down' ? k * 0.8 : s === 'reset' ? 1 : s.startsWith('=') ? parseFloat(s.slice(1)) : s.startsWith('x') ? k * parseFloat(s.slice(1))
        : s.endsWith('%') ? k * (1 + parseFloat(s) / 100) : k;
      e.scale = r2(clamp(v, 0.25, 4));
    }
    if (m.y) { const y = m.y, c = p.y; e.y = r2(clamp(y === 'up' ? c + 0.5 : y === 'down' ? c - 0.5 : y === 'max' ? 3 : y === 'floor' ? 0 : parseFloat(y), 0, 3)); }
    else if (onTop) e.y = r2(clamp(onTop.y + 1 * onTop.scale, 0, 3));
    if (m.hidden !== undefined) e.hidden = m.hidden;
    return e;
  }
  function addOp(n: Noun, at: P, hidden: boolean, rot?: number): GuideOp | null {
    const base = { k: 'add' as const, at, hidden, ...(rot ? { rot } : {}) };
    switch (n.type) {
      case 'prop': if (w.pack.models[`prop:${n.id}`]) return { ...base, what: 'prop', model: `prop:${n.id}` }; break;
      case 'foe': return { ...base, what: 'foe', foe: n.id };
      case 'item': return { ...base, what: 'token', kind: 'item', item: n.id };
      case 'hero': { const r = w.pack.roles.find((x) => x.id === n.id); if (r) return { ...base, what: 'token', kind: 'npc', model: r.model, label: r.name }; break; }
      case 'token':
        if (n.id === 'start') { if (!editing()) { say('Hero start spots are set in the editor.'); return null; } return { ...base, what: 'token', kind: 'start', hidden: false }; }
        return { ...base, what: 'token', kind: n.id as 'goal' };
    }
    say(`There is no ${nounName(w.pack, n)} to add.`);
    return null;
  }

  function add(c: Extract<Cmd, { v: 'add' }>, scale = 1) {
    const s = sc(); if (!s) return;
    const n = Math.max(1, Math.min(12, Math.round(c.count * scale)));
    const spots = new Spots(s, live(), rnd);
    const pts = points(c.place, n, !!c.mods.cluster, spots);
    if (!pts) return;
    const made: Piece[] = [];
    const hidden = c.mods.hidden ?? w.placeHidden;
    for (const p of pts.at) {
      const at = spots.claim(p, pts.exact);
      const before = new Set(live().map((q) => `${q.what}:${q.id}`));
      const op = addOp(c.noun, at, hidden);
      if (!op || !tryOp(op)) break;
      const fresh = live().find((q) => !before.has(`${q.what}:${q.id}`));
      if (!fresh) continue;
      made.push(fresh);
      const { hidden: _h, ...e } = looks(fresh, { ...c.mods, hidden: undefined }, pts.on);
      if (Object.keys(e).length) tryOp({ k: 'edit', what: fresh.what, id: fresh.id, ...e });
    }
    if (made.length) { done++; setLast(made); touched.push(...made); touch(c, made); }
  }

  function exec(c: Cmd, scale = 1) {
    switch (c.v) {
      case 'add': add(c, scale); return;
      case 'edit': {
        const ps = resolveSel(c.sel); if (!ps.length) return;
        touch(c, ps);
        let changed = false;
        for (const p of ps) { const e = looks(p, c.mods); if (Object.keys(e).length && tryOp({ k: 'edit', what: p.what, id: p.id, ...e })) changed = true; }
        if (!changed) return;
        done++; setLast(ps); touched.push(...ps); return;
      }
      case 'move': {
        const ps = resolveSel(c.sel), s = sc(); if (!ps.length || !s) return;
        const spots = new Spots(s, live().filter((q) => !ps.some((p) => p.id === q.id && p.what === q.what)), rnd);
        const pts = points(c.place, ps.length, !!c.mods.cluster, spots); if (!pts) return;
        touch(c, ps);
        ps.forEach((p, i) => {
          const to = spots.claim(pts.at[i]!, pts.exact);
          tryOp({ k: 'place', what: p.what, id: p.id, to });
          if (pts.on) tryOp({ k: 'edit', what: p.what, id: p.id, ...looks(p, {}, pts.on) });
        });
        done++; setLast(ps); touched.push(...ps); return;
      }
      case 'remove': {
        const ps = resolveSel(c.sel); if (!ps.length) return;
        touch(c, ps);
        for (const p of ps) tryOp({ k: 'remove', what: p.what, id: p.id });
        if (c.sel.kind === 'noun') gone.set(nkey(c.sel.noun), ln);
        done++; last = []; lastGone = ln; return;
      }
      case 'hide': case 'show': {
        const hidden = c.v === 'hide';
        if (c.sel.kind === 'all') { tryOp({ k: 'hideAll', hidden }); done++; return; }
        const ps = resolveSel(c.sel); if (!ps.length) return;
        touch(c, ps);
        for (const p of ps) tryOp({ k: 'edit', what: p.what, id: p.id, hidden });
        done++; setLast(ps); touched.push(...ps); return;
      }
      case 'scene': {
        if (!editing()) { say('Scenes are changed in the scene editor.'); return; }
        if (c.op === 'copy' || c.op === 'delete') { if (tryOp({ k: 'scene', op: c.op })) done++; return; }
        if (c.op === 'add' && !tryOp({ k: 'scene', op: 'add' })) return;
        const cur = sc()!;
        const patch: NonNullable<Extract<GuideOp, { k: 'scene' }>['patch']> = {};
        if (c.name) patch.name = c.name;
        if (c.ground) patch.ground = c.ground;
        if (c.size === 'up' || c.size === 'down') { const k = c.size === 'up' ? 2 : -2; patch.w = cur.size.w + k; patch.d = cur.size.d + k; }
        else if (c.size) { const [a, b] = c.size.split('x').map(Number); patch.w = a; patch.d = b; }
        if (Object.keys(patch).length) tryOp({ k: 'scene', op: 'set', patch });
        done++; setLast([]); return;
      }
      case 'goto': {
        const s = w.state(), n = s.adv?.scenes.length ?? 1, i = s.scene.index;
        if (!editing()) { say('Switching scenes works in the scene editor.'); return; }
        let j = i;
        if (c.to === 'next') j = i + 1; else if (c.to === 'prev') j = i - 1; else if (c.to === 'first') j = 0; else if (c.to === 'last') j = n - 1;
        else if (typeof c.to === 'number') j = c.to - 1;
        else { const id = c.to.id; j = s.adv?.scenes.findIndex((x) => x.id === id) ?? -1; if (j < 0) { say('There is no scene with that name.'); return; } }
        if (j < 0 || j >= n) { say(n === 1 ? 'This adventure has only one scene.' : `There is no scene ${j + 1}. This adventure has ${n} scenes.`); return; }
        if (j !== i && !tryOp({ k: 'scene', op: 'goto', index: j })) return;
        done++; setLast([]); return;
      }
      case 'recipe': {
        const r = w.ai.recipes[c.recipe.id];
        if (!r) { say('I don’t know that kind of scene.'); return; }
        const k = c.param === 'dense' ? 1.5 : c.param === 'sparse' ? 0.6 : 1;
        let body = parseProgram(r.body.join('\n'));
        if (!editing()) body = body.filter((b) => b.v !== 'scene');      // in a game: build it into this scene
        const was = done;
        depth++;
        try { for (const b of body) exec(b, b.v === 'add' && b.noun.type !== 'token' ? k : 1); } finally { depth--; }
        done = was + 1; setLast([]); return;
      }
    }
  }

  cmds.forEach((c, i) => {
    if (opts.skip?.has(i)) return;
    ln = i; tr?.line(i);
    const was = done;
    try { exec(c); } catch (e) { say(String((e as Error)?.message ?? e)); }
    tr?.end(i, done > was);
  });
  return { done, notes, touched };
}

// ---------------------------------------------------------------- dry run
/** What would go wrong with each line, without touching the table: the plan runs on a private copy of the state
 *  through the real rules, so the check and the real run cannot disagree. Pass the seed and skip set the real run
 *  will use. Line numbers in the messages are 1-based positions in cmds. */
export function check(w: World, cmds: Cmd[], opts: { seed?: number; skip?: ReadonlySet<number> } = {}): Issue[][] {
  let s = w.state();
  const by = s.players.find((p) => p.host)?.id ?? '';
  const out: Issue[][] = cmds.map(() => []);
  let cur = -1;
  const note = (msg: string, block = false) => { const l = out[cur]; if (l && !l.some((x) => x.msg === msg)) l.push({ msg, block }); };
  const sim: World = {
    pack: w.pack, ai: w.ai, selected: () => w.selected(), placeHidden: w.placeHidden, state: () => s,
    dispatch(op) {
      const r = reduce(s, { t: 'guide', op, by, at: s.now } as Envelope, w.pack);
      if (r.ok) s = r.state; else note(r.error ?? 'The table would not allow that.');
    },
  };
  // pieces earlier lines made / moved / hid, to spot lines that undo or fight each other
  const hist = new Map<string, { made?: number; moved?: number; hidden?: number }>();
  const trace: Trace = {
    line(i) { cur = i; },
    say(m) { note(m); },
    touch(c, ps) {
      for (const p of ps) {
        const k = `${p.what}:${p.id}`, h = hist.get(k) ?? {};
        const unhide = c.v === 'show' || (c.v === 'edit' && c.mods.hidden === false);
        if (c.v === 'remove' && h.made !== undefined) note(`Line ${h.made + 1} adds this, and this line removes it again.`);
        if ((c.v === 'edit' || c.v === 'move') && !unhide && h.hidden !== undefined) note(`Line ${h.hidden + 1} hides this piece.`);
        if (c.v === 'move' && h.moved !== undefined) note(`Line ${h.moved + 1} already moves this piece.`);
        if (c.v === 'add') h.made = cur;
        if (c.v === 'move') h.moved = cur;
        if (c.v === 'hide' || (c.v === 'edit' && c.mods.hidden === true)) h.hidden = cur;
        if (unhide) delete h.hidden;
        hist.set(k, h);
      }
    },
    end(i, did) {
      if (did) return;
      const l = out[i]!;
      if (!l.length) l.push({ msg: 'This would not change anything.', block: true });
      for (const x of l) x.block = true;
    },
  };
  run(sim, cmds, opts.seed, { skip: opts.skip, trace });
  return out;
}

// ---------------------------------------------------------------- plain-English preview
export function describe(pack: Pack, c: Cmd): string {
  const nm = (n: Noun, pl = false) => nounName(pack, n, pl);
  const ref = (r: Ref | 'center') => r === 'center' ? 'the middle' : r === 'selected' ? 'the piece you picked' : r === 'last' ? 'it' : `the ${nm(r)}`;
  const REG: Record<string, string> = { center: 'in the middle', spread: 'all over', side: 'along the walls', corner: 'in a corner', 'side:n': 'along the back', 'side:s': 'along the front', 'side:e': 'on the right', 'side:w': 'on the left', 'corner:ne': 'in the back-right corner', 'corner:nw': 'in the back-left corner', 'corner:se': 'in the front-right corner', 'corner:sw': 'in the front-left corner' };
  const REL: Record<string, string> = { near: 'near', behind: 'behind', front_of: 'in front of', left_of: 'left of', right_of: 'right of', around: 'around', on: 'on' };
  const place = (p?: Place) => !p ? '' : 'region' in p ? ` ${REG[p.region]}` : ` ${REL[p.rel]} ${ref(p.target)}`;
  const mods = (m: Mods) => {
    const out: string[] = [];
    if (m.cluster) out.push('in a group');
    if (m.scale) out.push(m.scale === 'up' ? 'bigger' : m.scale === 'down' ? 'smaller' : m.scale === 'reset' ? 'normal size' : m.scale.startsWith('=') ? `size ${m.scale.slice(1)}` : m.scale.startsWith('x') ? `${m.scale.slice(1)} × as big` : `${m.scale} size`);
    if (m.turn) out.push(m.turn === 180 ? 'turned around' : `turned ${Math.abs(m.turn)}° ${m.turn > 0 ? 'right' : 'left'}`);
    if (m.rot !== undefined) out.push(`turned to ${m.rot}°`);
    if (m.face) out.push(`facing ${ref(m.face)}`);
    if (m.y) out.push(m.y === 'floor' ? 'on the floor' : m.y === 'max' ? 'up high' : m.y === 'up' ? 'higher' : m.y === 'down' ? 'lower' : `${m.y} m up`);
    if (m.hidden === true) out.push('hidden'); else if (m.hidden === false) out.push('visible');
    return out.length ? `, ${out.join(', ')}` : '';
  };
  const sel = (s: Sel) => s.kind === 'all' ? 'everything' : s.kind === 'selected' ? 'the piece you picked' : s.kind === 'last' ? 'it' : `${s.all ? 'all the ' + nm(s.noun, true) : 'the ' + nm(s.noun)}${s.where ? place(s.where) : ''}`;
  switch (c.v) {
    case 'add': return `Add ${c.count === 1 ? 'a' : c.count} ${nm(c.noun, c.count > 1)}${place(c.place)}${mods(c.mods)}`;
    case 'edit': return `Make ${sel(c.sel)}${mods(c.mods).replace(/^, /, ' ')}`;
    case 'move': return `Move ${sel(c.sel)}${place(c.place)}`;
    case 'remove': return `Remove ${sel(c.sel)}`;
    case 'hide': return `Hide ${sel(c.sel)}`;
    case 'show': return `Show ${sel(c.sel)}`;
    case 'scene': {
      const bits = [c.name && `“${c.name}”`, c.size && (c.size === 'up' ? 'bigger' : c.size === 'down' ? 'smaller' : c.size.replace('x', ' × ') + ' m'), c.ground && `${c.ground} ground`].filter(Boolean).join(', ');
      return c.op === 'add' ? `New scene${bits ? ': ' + bits : ''}` : c.op === 'set' ? `This scene: ${bits}` : c.op === 'copy' ? 'Copy this scene' : 'Delete this scene';
    }
    case 'goto': return `Go to ${typeof c.to === 'number' ? `scene ${c.to}` : typeof c.to === 'string' ? `the ${c.to === 'prev' ? 'previous' : c.to} scene` : `scene “${c.to.id.replace(/-/g, ' ')}”`}`;
    case 'recipe': return `Build a ${c.recipe.id.replace(/_/g, ' ')} scene${c.param ? ` (${c.param})` : ''}`;
  }
}
