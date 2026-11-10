// Table geometry: ground areas, blocking shapes, a hidden 0.25 m nav grid and A* path-finding.
// Positions are metres on the table plane {x, z}; the scene is centred on 0,0 with size w×d.
// Rotations (Area.rot, Placement.rot) are degrees about +y, the same sense as three.js rotation.y.
import type { Area, AreaKind, GameState, P, Pack, PackScene } from './types';

export const NAV = 0.25;         // nav cell size (m)
export const AGENT = 0.2;        // mini radius: blocking props are inflated by this much
export const DEFAULT_BLOCK = 0.3; // prop blocking radius when neither the placement nor the model says
export const METER_BLOCK = 0.35;  // in-scene meters (clock, presents pile, jar) block like small props

export const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.z - b.z);
export const r2 = (n: number): number => Math.round(n * 100) / 100;
export const rp = (p: P): P => ({ x: r2(p.x), z: r2(p.z) });
export const isP = (v: unknown): v is P =>
  !!v && typeof (v as P).x === 'number' && typeof (v as P).z === 'number' && Number.isFinite((v as P).x) && Number.isFinite((v as P).z);
/** Facing in radians (0 = +z) for a move from a to b; keeps `fallback` for zero-length moves. */
export function facingOf(a: P, b: P, fallback = 0): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return fallback;
  return r2(Math.atan2(dx, dz));
}
export function clampToScene(sc: PackScene, p: P, margin = 0.15): P {
  const hw = sc.size.w / 2 - margin, hd = sc.size.d / 2 - margin;
  return { x: Math.max(-hw, Math.min(hw, p.x)), z: Math.max(-hd, Math.min(hd, p.z)) };
}
export function inBounds(sc: PackScene, p: P): boolean {
  return Math.abs(p.x) <= sc.size.w / 2 && Math.abs(p.z) <= sc.size.d / 2;
}

// ---------------------------------------------------------------- areas
function toLocal(a: Area, p: P): { x: number; z: number } {
  const dx = p.x - a.x, dz = p.z - a.z;
  if (!a.rot) return { x: dx, z: dz };
  const t = (a.rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}
export function inArea(a: Area, p: P): boolean {
  if (a.shape === 'circle') return Math.hypot(p.x - a.x, p.z - a.z) <= (a.r ?? 0.5);
  const l = toLocal(a, p);
  return Math.abs(l.x) <= (a.w ?? 1) / 2 && Math.abs(l.z) <= (a.d ?? 1) / 2;
}
/** Distance from p to the area's outline (0 when inside). */
export function areaDist(a: Area, p: P): number {
  if (a.shape === 'circle') return Math.max(0, Math.hypot(p.x - a.x, p.z - a.z) - (a.r ?? 0.5));
  const l = toLocal(a, p);
  const dx = Math.max(0, Math.abs(l.x) - (a.w ?? 1) / 2), dz = Math.max(0, Math.abs(l.z) - (a.d ?? 1) / 2);
  return Math.hypot(dx, dz);
}
/** Topmost area at p (later areas win), or undefined for the scene's default ground. */
export function areaAt(sc: PackScene, p: P): Area | undefined {
  for (let i = sc.areas.length - 1; i >= 0; i--) if (inArea(sc.areas[i], p)) return sc.areas[i];
  return undefined;
}
export interface Ground { kind: AreaKind; area?: Area; solid: boolean }
export function groundOf(sc: PackScene, solid: string[], p: P): Ground {
  if (!inBounds(sc, p)) return { kind: 'wall', solid: false };
  const a = areaAt(sc, p);
  if (!a) return { kind: sc.ground, solid: false };
  return { kind: a.kind, area: a, solid: solid.includes(a.id) };
}
export function groundBlocks(g: Ground, fly: boolean): boolean {
  switch (g.kind) {
    case 'wall': return true;
    case 'water': case 'crack': return !g.solid;
    case 'gap': return !g.solid && !fly;
    default: return false;
  }
}
/** Ice, and cracks/water that were frozen solid, are slippery. */
export const slippery = (g: Ground): boolean => g.kind === 'ice' || (g.solid && (g.kind === 'crack' || g.kind === 'water'));

// ---------------------------------------------------------------- blocking circles (props, meters)
export interface Circle { x: number; z: number; r: number }
export function propRadius(pack: Pack, pl: PackScene['props'][number]): number {
  if (typeof pl.block === 'number') return Math.max(0, pl.block);
  const m = pack.models[pl.model];
  return Math.max(0, (m?.block ?? DEFAULT_BLOCK) * (pl.scale ?? 1));
}
export function blockers(sc: PackScene, pack: Pack): Circle[] {
  const out: Circle[] = [];
  for (const pl of sc.props) { if (pl.hidden) continue; const r = propRadius(pack, pl); if (r > 0) out.push({ x: pl.x, z: pl.z, r }); }
  for (const m of Object.values(sc.meters ?? {})) if (m) out.push({ x: m.x, z: m.z, r: METER_BLOCK });
  return out;
}

// ---------------------------------------------------------------- nav grid
export interface Nav {
  sc: PackScene; cols: number; rows: number; x0: number; z0: number;
  walk: Uint8Array; fly: Uint8Array;        // 1 = blocked
  slip: Uint8Array;                          // 1 = slippery
}
const navCache = new WeakMap<Pack, Map<string, Nav>>();
export function sceneOf(s: GameState, pack: Pack): PackScene | undefined {
  const adv = s.adv ?? pack.adventures.find((a) => a.id === s.adventureId) ?? pack.adventures[0];
  return adv?.scenes[s.scene.index];
}
/** Everything about a scene that changes where minis can walk. */
export function layoutKey(sc: PackScene): string {
  let k = `${sc.size.w}x${sc.size.d}:${sc.ground}`;
  for (const a of sc.areas) k += `|${a.id}${a.kind}${a.shape}${a.x},${a.z},${a.w ?? ''},${a.d ?? ''},${a.r ?? ''},${a.rot ?? ''}`;
  for (const p of sc.props) if (!p.hidden) k += `|${p.model}${p.x},${p.z},${p.scale ?? ''},${p.block ?? ''}`;
  return k;
}
export function navFor(s: GameState, pack: Pack): Nav | undefined {
  const sc = sceneOf(s, pack);
  if (!sc) return undefined;
  return buildNav(sc, pack, s.scene.solid ?? []);
}
export function buildNav(sc: PackScene, pack: Pack, solid: string[]): Nav {
  // the layout can change (the Guide edits it live), so the key covers everything that blocks
  const key = `${sc.id}|${[...solid].sort().join(',')}|${layoutKey(sc)}`;
  let m = navCache.get(pack);
  if (!m) { m = new Map(); navCache.set(pack, m); }
  const hit = m.get(key);
  if (hit) return hit;
  if (m.size > 40) m.clear();
  const cols = Math.max(1, Math.round(sc.size.w / NAV)), rows = Math.max(1, Math.round(sc.size.d / NAV));
  const x0 = -sc.size.w / 2, z0 = -sc.size.d / 2;
  const walk = new Uint8Array(cols * rows), fly = new Uint8Array(cols * rows), slip = new Uint8Array(cols * rows);
  const circles = blockers(sc, pack);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const p = { x: x0 + (i + 0.5) * NAV, z: z0 + (j + 0.5) * NAV };
    const g = groundOf(sc, solid, p);
    const byProp = circles.some((c) => Math.hypot(p.x - c.x, p.z - c.z) < c.r + AGENT);
    const k = j * cols + i;
    walk[k] = byProp || groundBlocks(g, false) ? 1 : 0;
    fly[k] = byProp || groundBlocks(g, true) ? 1 : 0;
    slip[k] = slippery(g) ? 1 : 0;
  }
  const nav: Nav = { sc, cols, rows, x0, z0, walk, fly, slip };
  if (m.size > 64) m.clear();
  m.set(key, nav);
  return nav;
}
export const cellOf = (n: Nav, p: P): [number, number] => [
  Math.max(0, Math.min(n.cols - 1, Math.floor((p.x - n.x0) / NAV))),
  Math.max(0, Math.min(n.rows - 1, Math.floor((p.z - n.z0) / NAV))),
];
export const centre = (n: Nav, i: number, j: number): P => ({ x: n.x0 + (i + 0.5) * NAV, z: n.z0 + (j + 0.5) * NAV });
function inGrid(n: Nav, p: P): boolean {
  return p.x >= n.x0 && p.z >= n.z0 && p.x < n.x0 + n.cols * NAV && p.z < n.z0 + n.rows * NAV;
}
export function blockedAt(n: Nav, p: P, fly = false): boolean {
  if (!inGrid(n, p)) return true;
  const [i, j] = cellOf(n, p);
  return (fly ? n.fly : n.walk)[j * n.cols + i] === 1;
}
export function slipperyAt(n: Nav, p: P): boolean {
  if (!inGrid(n, p)) return false;
  const [i, j] = cellOf(n, p);
  return n.slip[j * n.cols + i] === 1;
}
/** True when a straight walk from a to b crosses no blocked cell (cells under `a` itself are ignored). */
export function lineClear(n: Nav, a: P, b: P, fly = false): boolean {
  const L = dist(a, b);
  const steps = Math.max(1, Math.ceil(L / 0.08));
  const [ai, aj] = cellOf(n, a);
  for (let k = 1; k <= steps; k++) {
    const p = { x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps };
    const [i, j] = cellOf(n, p);
    if (i === ai && j === aj) continue;
    if (blockedAt(n, p, fly)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- A*
class Heap {
  private a: number[] = []; private f: Float64Array;
  constructor(size: number) { this.f = new Float64Array(size); }
  get size() { return this.a.length; }
  push(k: number, f: number) {
    this.f[k] = f; const a = this.a; a.push(k);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.f[a[p]] <= this.f[a[i]]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): number {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this.f[a[l]] < this.f[a[m]]) m = l;
        if (r < a.length && this.f[a[r]] < this.f[a[m]]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}
const NB: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/** Path from → to around obstacles. Always starts with `from`; ends at `to` when reachable, otherwise at the
 *  reachable point closest to `to`. Points are rounded to centimetres. */
export function findPath(n: Nav, from: P, to: P, fly = false): P[] {
  const grid = fly ? n.fly : n.walk;
  const [si, sj] = cellOf(n, from);
  const tgt = inGrid(n, to) ? to : clampToScene(n.sc, to, NAV / 2);
  const [ti, tj] = cellOf(n, tgt);
  const start = sj * n.cols + si, goal = tj * n.cols + ti;
  if (start === goal || lineClear(n, from, tgt, fly) && !blockedAt(n, tgt, fly)) {
    return start === goal && blockedAt(n, tgt, fly) ? [rp(from)] : [rp(from), rp(tgt)];
  }
  const N = n.cols * n.rows;
  const g = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const h = (k: number) => {
    const dx = Math.abs((k % n.cols) - ti), dz = Math.abs(Math.floor(k / n.cols) - tj);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };
  const heap = new Heap(N);
  g[start] = 0; heap.push(start, h(start));
  let best = start, bestH = h(start), found = false;
  while (heap.size) {
    const k = heap.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === goal) { found = true; best = k; break; }
    const hk = h(k);
    if (hk < bestH || (hk === bestH && g[k] < g[best])) { bestH = hk; best = k; }
    const i = k % n.cols, j = Math.floor(k / n.cols);
    for (const [di, dj, cost] of NB) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n.cols || nj >= n.rows) continue;
      const nk = nj * n.cols + ni;
      if (grid[nk] || closed[nk]) continue;
      if (di && dj && (grid[j * n.cols + ni] || grid[nj * n.cols + i])) continue; // no corner cutting
      const ng = g[k] + cost;
      if (ng < g[nk]) { g[nk] = ng; prev[nk] = k; heap.push(nk, ng + h(nk)); }
    }
  }
  const cells: number[] = [];
  for (let k = best; k !== -1; k = prev[k]) cells.push(k);
  cells.reverse();
  const pts: P[] = cells.map((k) => centre(n, k % n.cols, Math.floor(k / n.cols)));
  pts[0] = { ...from };
  if (found && !blockedAt(n, tgt, fly)) pts[pts.length - 1] = { ...tgt };
  // string pulling: keep only the turning points
  const out: P[] = [pts[0]];
  let anchor = 0;
  for (let k = 2; k < pts.length; k++) {
    if (!lineClear(n, pts[anchor], pts[k], fly)) { out.push(pts[k - 1]); anchor = k - 1; }
  }
  if (pts.length > 1) out.push(pts[pts.length - 1]);
  return out.map(rp);
}
export function pathLength(path: P[]): number {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += dist(path[i - 1], path[i]);
  return L;
}
/** Cut a path at the first point within `within` metres of `target` (keeps the whole path if never). */
export function trimPath(path: P[], target: P, within: number): P[] {
  if (!path.length) return path;
  if (dist(path[0], target) <= within) return [path[0]];
  const out: P[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const L = dist(a, b), steps = Math.max(1, Math.ceil(L / 0.05));
    for (let k = 1; k <= steps; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps };
      if (dist(p, target) <= within) { out.push(rp(p)); return out; }
    }
    out.push(b);
  }
  return out;
}
/** Slide on from `from` in direction `dir` while on slippery ground, up to n metres, stopping before anything blocked. */
export function slide(n: Nav, from: P, dir: { x: number; z: number }, len: number, fly = false): P {
  const L = Math.hypot(dir.x, dir.z);
  if (L < 1e-6 || !slipperyAt(n, from)) return from;
  const ux = dir.x / L, uz = dir.z / L;
  let p = from;
  for (let d = 0.05; d <= len + 1e-9; d += 0.05) {
    const q = { x: from.x + ux * d, z: from.z + uz * d };
    if (blockedAt(n, q, fly)) break;
    p = q;
    if (!slipperyAt(n, q)) break;
  }
  return rp(p);
}
/** Straight dash from → toward `to`, at most `len` metres, stopping before anything blocked. */
export function dash(n: Nav, from: P, to: P, len: number, fly = false): P {
  const L = dist(from, to);
  if (L < 1e-6) return from;
  const ux = (to.x - from.x) / L, uz = (to.z - from.z) / L;
  const max = Math.min(len, L);
  let p = from;
  for (let d = 0.05; d <= max + 1e-9; d += 0.05) {
    const q = { x: from.x + ux * d, z: from.z + uz * d };
    if (blockedAt(n, q, fly)) break;
    p = q;
  }
  return rp(p);
}
/** Nearest unblocked point to p, at least `sep` metres from every point in `avoid` (deterministic ring search). */
export function nearestFree(n: Nav, p: P, opts: { fly?: boolean; avoid?: P[]; sep?: number; maxR?: number } = {}): P | null {
  const avoid = opts.avoid ?? [], sep = opts.sep ?? 0;
  const ok = (q: P) => !blockedAt(n, q, opts.fly) && avoid.every((a) => dist(a, q) >= sep);
  if (inGrid(n, p) && ok(p)) return rp(p);
  const [ci, cj] = cellOf(n, p);
  const maxR = Math.ceil((opts.maxR ?? Math.max(n.sc.size.w, n.sc.size.d)) / NAV);
  for (let r = 1; r <= maxR; r++) {
    let best: P | null = null, bd = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= n.cols || j >= n.rows) continue;
      const q = centre(n, i, j);
      if (!ok(q)) continue;
      const d = dist(q, p);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) return rp(best);
  }
  return null;
}
