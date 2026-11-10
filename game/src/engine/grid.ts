// Grid geometry, terrain and path-finding. Pure helpers over GameState + Pack.
import type { Dir, GameState, Hero, Pack, PackTile, Vec } from './types';

export const DIRS: [Dir, Vec][] = [['n', { x: 0, y: -1 }], ['e', { x: 1, y: 0 }], ['s', { x: 0, y: 1 }], ['w', { x: -1, y: 0 }]];
export const DIR_VEC: Record<Dir, Vec> = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 } };
export const key = (v: Vec): string => `${v.x},${v.y}`;
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const eq = (a: Vec, b: Vec): boolean => a.x === b.x && a.y === b.y;
/** Chebyshev distance: diagonal neighbours count as adjacent (1). Used for every range check. */
export const dist = (a: Vec, b: Vec): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
export const manhattan = (a: Vec, b: Vec): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const isVec = (v: unknown): v is Vec =>
  !!v && typeof (v as Vec).x === 'number' && typeof (v as Vec).y === 'number' && Number.isInteger((v as Vec).x) && Number.isInteger((v as Vec).y);

const cache = new WeakMap<Pack, Map<string, PackTile>>();
export function tileById(pack: Pack, id: string): PackTile | undefined {
  let m = cache.get(pack);
  if (!m) { m = new Map(pack.tiles.map((t) => [t.id, t])); cache.set(pack, m); }
  return m.get(id);
}
export const inBounds = (s: GameState, v: Vec): boolean => v.x >= 0 && v.y >= 0 && v.x < s.scene.w && v.y < s.scene.h;
export function tileAt(s: GameState, pack: Pack, v: Vec): PackTile | undefined {
  if (!inBounds(s, v)) return undefined;
  return tileById(pack, s.scene.tiles[v.y * s.scene.w + v.x]);
}
export const isFrozen = (s: GameState, v: Vec): boolean => s.scene.frozenWater.includes(key(v));
export function walkable(s: GameState, pack: Pack, v: Vec): boolean {
  const t = tileAt(s, pack, v);
  return !!t && (t.walk || (!!t.water && isFrozen(s, v)));
}
export function slippery(s: GameState, pack: Pack, v: Vec): boolean {
  const t = tileAt(s, pack, v);
  return !!t && (!!t.slippery || (!!t.water && isFrozen(s, v)));
}
export const heroAt = (s: GameState, v: Vec, exceptId?: string): Hero | undefined =>
  s.heroes.find((h) => h.id !== exceptId && eq(h.pos, v));
export const foeAt = (s: GameState, v: Vec, exceptUid?: string) =>
  s.foes.find((f) => !f.calmed && f.uid !== exceptUid && eq(f.pos, v));
export const occupied = (s: GameState, v: Vec, except?: string): boolean => !!heroAt(s, v, except) || !!foeAt(s, v, except);
export const freeCell = (s: GameState, pack: Pack, v: Vec, except?: string): boolean => walkable(s, pack, v) && !occupied(s, v, except);

/** Hero movement: 4-neighbour steps, 1 point each; on slippery tiles the hero keeps sliding (free) until blocked.
 *  Allies can be passed through but not stopped on; foes block. Paths include the start cell. */
export function reachable(s: GameState, pack: Pack, hero: Hero, budget = hero.moveLeft): { cell: Vec; path: Vec[]; cost: number }[] {
  if (budget <= 0) return [];
  const pass = (v: Vec) => walkable(s, pack, v) && !foeAt(s, v);
  const best = new Map<string, { cell: Vec; path: Vec[]; cost: number }>();
  best.set(key(hero.pos), { cell: hero.pos, path: [hero.pos], cost: 0 });
  const queue: Vec[] = [hero.pos];
  while (queue.length) {
    const cur = queue.shift()!;
    const node = best.get(key(cur))!;
    if (node.cost >= budget) continue;
    for (const [, d] of DIRS) {
      const nx = add(cur, d);
      if (!pass(nx)) continue;
      const path = [...node.path, nx];
      let end = nx;
      while (slippery(s, pack, end)) {
        const nn = add(end, d);
        if (pass(nn) && !heroAt(s, nn, hero.id)) { end = nn; path.push(nn); } else break;
      }
      const k = key(end);
      if (!best.has(k)) { best.set(k, { cell: end, path, cost: node.cost + 1 }); queue.push(end); }
    }
  }
  const out: { cell: Vec; path: Vec[]; cost: number }[] = [];
  for (const n of best.values()) if (n.cost > 0 && !heroAt(s, n.cell, hero.id)) out.push(n);
  return out;
}

/** Breadth-first search for foes (no sliding, no passing through anyone). Returns cell -> path (start excluded). */
export function foePaths(s: GameState, pack: Pack, from: Vec, uid: string, maxSteps = 99): Map<string, Vec[]> {
  const seen = new Map<string, Vec[]>([[key(from), []]]);
  const queue: Vec[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    const p = seen.get(key(cur))!;
    if (p.length >= maxSteps) continue;
    for (const [, d] of DIRS) {
      const nx = add(cur, d);
      const k = key(nx);
      if (seen.has(k) || !walkable(s, pack, nx) || occupied(s, nx, uid)) continue;
      seen.set(k, [...p, nx]);
      queue.push(nx);
    }
  }
  return seen;
}

/** Nearest free walkable cell to v (v itself first), ring by ring; deterministic order. */
export function findFreeNear(s: GameState, pack: Pack, v: Vec, avoid: Set<string> = new Set(), except?: string): Vec | null {
  const maxR = Math.max(s.scene.w, s.scene.h);
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const c = { x: v.x + dx, y: v.y + dy };
      if (freeCell(s, pack, c, except) && !avoid.has(key(c))) return c;
    }
  }
  return null;
}

/** Cells on a straight-ish line from a to b (inclusive), for flight animations. */
export function line(a: Vec, b: Vec): Vec[] {
  const out: Vec[] = [];
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  for (let i = 0; i <= n; i++) out.push({ x: Math.round(a.x + ((b.x - a.x) * i) / (n || 1)), y: Math.round(a.y + ((b.y - a.y) * i) / (n || 1)) });
  return out;
}

export function cellsWithin(s: GameState, c: Vec, r: number): Vec[] {
  const out: Vec[] = [];
  for (let y = c.y - r; y <= c.y + r; y++) for (let x = c.x - r; x <= c.x + r; x++) if (inBounds(s, { x, y })) out.push({ x, y });
  return out;
}
